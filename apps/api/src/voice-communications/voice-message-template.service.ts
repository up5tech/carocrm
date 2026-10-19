import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { VoiceCommunicationsSettingsService } from './voice-communications-settings.service.js';

/**
 * Phase 19-VC.14 — shared service templates (local snippets) and composer validation
 * (`PLAN_Phase_19_Voice_Communications.md` §10.1, §15 `19-VC.14`).
 *
 * Deliberate boundaries:
 *  - **No HTML, ever.** A snippet is plain text. Placeholders are `{{name}}` tokens with a strict
 *    name grammar, and rendering substitutes *caller-provided literal strings only* — the module
 *    never resolves CRM fields on its own, so no unauthorized field can leak into a message and no
 *    markup can reach a channel that renders text.
 *  - **Local snippets are not WhatsApp templates.** They live in `voice_message_templates`; a
 *    provider-approved WhatsApp template lives in `voice_whatsapp_templates` and is the only thing
 *    that satisfies the service-window policy. The two share no id space.
 *  - **No campaign model.** Marketing Automation keeps campaign ownership; this module exposes the
 *    transport-level send and policy gates only (documented in the module docs).
 *  - Segment hints are calculated, not guessed: GSM-7 vs UCS-2 with the standard concatenation
 *    sizes, so an agent sees the real cost before sending.
 */

export type TemplateChannel = 'sms' | 'mms' | 'whatsapp' | 'any';

export interface MessageTemplateRow {
  id: string;
  key: string;
  name: string;
  channel: string;
  body: string;
  placeholders: unknown;
  active: boolean;
  created_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface MessageTemplateView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly channel: TemplateChannel;
  readonly body: string;
  readonly placeholders: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface SegmentInfo {
  readonly encoding: 'GSM-7' | 'UCS-2';
  readonly segments: number;
  readonly characters: number;
  readonly charsPerSegment: number;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
/**
 * The GSM 03.38 basic character set (§10.1). Expressed as a literal character list instead of a
 * regex class, so no escape rule can quietly drop a character from it.
 */
const GSM7_BASIC =
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!\"#¤%&'()*+,-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~]|€ AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789 \r\n";

export function isGsm7(text: string): boolean {
  return [...text].every((character) => GSM7_BASIC.includes(character));
}

@Injectable()
export class VoiceMessageTemplateService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
  ) {}

  async upsert(input: {
    readonly key: string;
    readonly name: string;
    readonly channel: TemplateChannel;
    readonly body: string;
    readonly active?: boolean | undefined;
  }): Promise<MessageTemplateView> {
    const key = input.key.trim().toLowerCase();
    if (!KEY_PATTERN.test(key)) {
      throw new ValidationError('A template key must be 2–64 lowercase letters, digits, "_" or "-".');
    }
    const body = normalizeBody(input.body);
    const placeholders = [...extractPlaceholders(body)];
    const existing = (
      await sql<MessageTemplateRow>`select * from voice_message_templates where key = ${key}`.execute(this.database.db)
    ).rows[0];
    const now = new Date();
    if (existing === undefined) {
      await sql`
        insert into voice_message_templates
          (id, key, name, channel, body, placeholders, active, created_by_id, created_at, modified_at)
        values
          (${randomUUID()}, ${key}, ${input.name.trim()}, ${input.channel}, ${body},
           ${JSON.stringify(placeholders)}::jsonb, ${input.active ?? true}, ${this.scope.userId ?? null}, ${now}, ${now})
      `.execute(this.database.db);
    } else {
      await sql`
        update voice_message_templates
        set name = ${input.name.trim()}, channel = ${input.channel}, body = ${body},
            placeholders = ${JSON.stringify(placeholders)}::jsonb, active = ${input.active ?? existing.active},
            modified_at = ${now}
        where key = ${key}
      `.execute(this.database.db);
    }
    return this.require(key);
  }

  async list(query: { readonly channel?: string | undefined } = {}): Promise<{ readonly list: readonly MessageTemplateView[] }> {
    const channel = query.channel ?? null;
    const rows = await sql<MessageTemplateRow>`
      select * from voice_message_templates
      where (${channel}::text is null or channel = ${channel} or channel = 'any')
        and active = true
      order by key asc
      limit 200
    `.execute(this.database.db);
    return { list: rows.rows.map(toView) };
  }

  async get(key: string): Promise<MessageTemplateView> {
    return this.require(key.trim().toLowerCase());
  }

  async remove(key: string): Promise<void> {
    const deleted = await sql<{ id: string }>`
      delete from voice_message_templates where key = ${key.trim().toLowerCase()} returning id
    `.execute(this.database.db);
    if (deleted.rows.length === 0) {
      throw new NotFoundError(`Template "${key}" does not exist.`);
    }
  }

  /**
   * Render a snippet with caller-provided values. Every declared placeholder must be supplied;
   * nothing is fetched from CRM data, so a template cannot pull a field the caller did not hand over.
   */
  async render(
    key: string,
    variables: Readonly<Record<string, string>>,
  ): Promise<{ readonly body: string; readonly segments: SegmentInfo }> {
    const template = await this.require(key.trim().toLowerCase());
    if (!template.active) throw new ValidationError(`Template "${key}" is not active.`);
    const required = [...extractPlaceholders(template.body)];
    const missing = required.filter((name) => typeof variables[name] !== 'string');
    if (missing.length > 0) {
      throw new ValidationError('The template needs values for every placeholder.', { missing });
    }
    const rendered = template.body.replace(PLACEHOLDER_PATTERN, (_match: string, name: string) => variables[name] ?? '');
    return { body: rendered, segments: segmentInfo(rendered) };
  }

  /**
   * Composer validation (§10.1): length against the module ceiling, segment cost, and the channel
   * gate. The same check the send path applies, offered before the agent commits.
   */
  async validateComposer(input: {
    readonly channel: 'sms' | 'mms' | 'whatsapp';
    readonly body: string;
  }): Promise<{ readonly ok: boolean; readonly segments: SegmentInfo; readonly warnings: readonly string[] }> {
    const settings = await this.settings.settings();
    const body = normalizeBody(input.body);
    const warnings: string[] = [];
    if (body.length > settings.policy.maxMessageLength) {
      warnings.push(`The message is ${body.length} characters; the configured ceiling is ${settings.policy.maxMessageLength}.`);
    }
    const segments = segmentInfo(body);
    if (input.channel === 'sms' && segments.encoding === 'UCS-2') {
      warnings.push('The text uses characters outside GSM-7, so it is sent as UCS-2 with fewer characters per segment.');
    }
    if (segments.segments > 3) {
      warnings.push(`The message spans ${segments.segments} segments.`);
    }
    return { ok: warnings.length === 0, segments, warnings };
  }

  private async require(key: string): Promise<MessageTemplateView> {
    const row = (
      await sql<MessageTemplateRow>`select * from voice_message_templates where key = ${key}`.execute(this.database.db)
    ).rows[0];
    if (row === undefined) throw new NotFoundError(`Template "${key}" does not exist.`);
    return toView(row);
  }
}

// --------------------------------------------------------------------------- helpers

export function extractPlaceholders(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/**
 * SMS segment arithmetic (GSM 03.38 / 3GPP TS 23.040): 160 characters per single GSM-7 SMS, 153 per
 * segment when concatenated; 70 and 67 for UCS-2. A body with any non-GSM character pays the UCS-2
 * price — the conservative reading carriers apply.
 */
export function segmentInfo(body: string): SegmentInfo {
  const encoding: SegmentInfo['encoding'] = isGsm7(body) ? 'GSM-7' : 'UCS-2';
  const characters = [...body].length;
  if (characters === 0) return { encoding, segments: 0, characters, charsPerSegment: encoding === 'GSM-7' ? 160 : 70 };
  const per = encoding === 'GSM-7' ? (characters <= 160 ? 160 : 153) : characters <= 70 ? 70 : 67;
  return { encoding, segments: Math.ceil(characters / per), characters, charsPerSegment: per };
}

function normalizeBody(body: string): string {
  // Control characters (except newline/tab) are stripped: a message body is text, not a terminal escape.
  // eslint-disable-next-line no-control-regex
  return body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function toView(row: MessageTemplateRow): MessageTemplateView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    channel: row.channel as TemplateChannel,
    body: row.body,
    placeholders: Array.isArray(row.placeholders) ? (row.placeholders as string[]) : [],
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}
