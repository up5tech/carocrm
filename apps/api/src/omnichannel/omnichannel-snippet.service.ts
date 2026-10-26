import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { type MessageTemplateView, type SegmentInfo,VoiceMessageTemplateService } from '../voice-communications/index.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';

/**
 * Phase 19-OM.12 — canned replies in the workspace (plan §14 `19-OM.12`).
 *
 * The snippets themselves stay in `VoiceCommunications` (`voice_message_templates`, VC.14): plain
 * text, validated placeholders, GSM-7 segment hints, team/language visibility — the owner's model,
 * consumed here through the exported service (D1). This facade adds only the workspace rules:
 *
 *  - **channel-appropriate**: SMS/WhatsApp snippets for those conversations, every text snippet for
 *    website chat (`web_chat` has no WhatsApp-style template concept);
 *  - **approved variables only**: preview substitutes `customerName`, `agentName`, `companyName`
 *    from literal values — never a CRM field lookup, so no unauthorized field can leak, and unknown
 *    variable keys are ignored;
 *  - **safe text**: the rendered body is plain text (the owner refuses markup at save time); the
 *    SPA inserts it into the composer and renders it as text, never as HTML;
 *  - **no campaign engine**: this endpoint serves service snippets only. WhatsApp's provider-approved
 *    templates remain `voice_whatsapp_templates`, and Marketing Automation's campaign templates are
 *    never reachable from an ordinary agent reply.
 */

export const SNIPPET_VARIABLES = ['customerName', 'agentName', 'companyName'] as const;
export type SnippetVariableKey = (typeof SNIPPET_VARIABLES)[number];

@Injectable()
export class OmnichannelSnippetService {
  constructor(
    @Inject(VoiceMessageTemplateService) private readonly templates: VoiceMessageTemplateService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async list(channel: string | undefined): Promise<{ readonly list: readonly MessageTemplateView[] }> {
    await this.permissions.assert('inboxView');
    // Website chat has no provider template concept; every text snippet applies.
    const mapped = channel === undefined || channel === 'web_chat' ? undefined : channel;
    return this.templates.list({ ...(mapped === undefined ? {} : { channel: mapped }) });
  }

  /** Preview with approved variables only; the customer's display name comes from the record. */
  async preview(
    key: string,
    input: { readonly conversationId?: string | undefined; readonly variables?: Readonly<Record<string, string>> | undefined },
  ): Promise<{ readonly body: string; readonly segments: SegmentInfo }> {
    await this.permissions.assert('reply');
    const variables: Record<string, string> = {};
    for (const name of SNIPPET_VARIABLES) {
      const value = input.variables?.[name];
      if (typeof value === 'string' && value.trim() !== '') variables[name] = value.trim().slice(0, 200);
    }
    if (variables['agentName'] === undefined) variables['agentName'] = this.scope.principal?.userName ?? '';
    if (variables['customerName'] === undefined && input.conversationId !== undefined) {
      const row = (await sql<{ address: string; display_name: string | null }>`
        select address, display_name from voice_conversation_participants
        where conversation_id = ${input.conversationId} and role = 'customer'
        order by created_at asc limit 1
      `.execute(this.database.db)).rows[0];
      if (row !== undefined) variables['customerName'] = row.display_name ?? row.address;
    }
    return this.templates.render(key, variables);
  }

  /** Operational use count only — never the composed message (19-OM.12 "track use, not content"). */
  async recordUse(key: string): Promise<MessageTemplateView> {
    await this.permissions.assert('reply');
    return this.templates.recordUse(key);
  }
}

/** The draft body ceiling mirrors the composer's; a draft is text like any message. */
export const DRAFT_MAX_CHARS = 20_000;

export function assertDraftBody(body: string): string {
  const text = body.trim();
  if (text.length > DRAFT_MAX_CHARS) {
    throw new ValidationError('The draft is too long.', { maxChars: DRAFT_MAX_CHARS });
  }
  return text;
}
