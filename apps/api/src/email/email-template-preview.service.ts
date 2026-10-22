/**
 * Email template preview (PLAN Phase 11 "Email templates").
 *
 * The designer edits a draft that is not stored yet, so the preview renders the content the caller
 * sends rather than a record. The substitution is the one the send path uses — `{{field}}` tokens over
 * a flat variable map (`@carocrm/mail`) — with two differences that only matter while previewing:
 *
 *  - a value inserted into `bodyHtml` is HTML-escaped first. The markup the author wrote is theirs,
 *    but a CRM field can carry markup of its own, and a preview pane must not turn that into a script
 *    running in the editor's session;
 *  - a token the context has no value for is reported in `unresolved` instead of only disappearing,
 *    because the designer needs to know which placeholder will go out empty.
 *
 * The context is one sample CRM record read through the entity engine, so the actor's record and field
 * ACL decide which values exist: an unreadable sample is a refusal, never a blank field. Entity types
 * are allowlisted — a preview never takes an arbitrary entity name.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';
import { renderTemplate } from '@carocrm/mail';
import { Inject, Injectable } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { EMAIL_TEMPLATE_ENTITY } from './email.constants.js';

/** The record shapes a preview may personalise with: people and accounts, not any metadata entity. */
export const PREVIEW_SAMPLE_ENTITIES = ['Contact', 'Lead', 'Account', 'User'] as const;
export type PreviewSampleEntity = (typeof PREVIEW_SAMPLE_ENTITIES)[number];

const PreviewSchema = z
  .object({
    subject: z.string().max(998).nullish(),
    body: z.string().max(200_000).nullish(),
    bodyHtml: z.string().max(500_000).nullish(),
    sampleEntityType: z.enum(PREVIEW_SAMPLE_ENTITIES).nullish(),
    sampleEntityId: z.string().trim().min(1).max(64).nullish(),
  })
  .refine(
    (input) =>
      (input.sampleEntityType == null) === (input.sampleEntityId == null),
    { message: 'A personalised preview needs both sampleEntityType and sampleEntityId.' },
  );

export interface EmailTemplatePreview {
  subject: string | null;
  body: string | null;
  bodyHtml: string | null;
  /** Every token the draft names, in order of first appearance. */
  placeholders: string[];
  /** The tokens dropped because the sample record carries no readable value for them. */
  unresolved: string[];
  /** The sample the preview was personalised with; null when the draft is shown as written. */
  sample: { type: string; id: string; label: string } | null;
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The tokens a part names, de-duplicated. A global regex is safe here: `matchAll` works on a copy. */
export function templateTokens(source: string): string[] {
  return [...new Set([...source.matchAll(TOKEN)].map((match) => String(match[1])))];
}

/**
 * Substitutes an HTML part. `null` variables means "no sample chosen": the draft is returned as
 * written so the designer can see its tokens, and nothing counts as unresolved.
 */
export function renderHtmlPart(source: string, variables: Record<string, string> | null): { html: string; unresolved: string[] } {
  if (variables === null) return { html: source, unresolved: [] };
  const unresolved = new Set<string>();
  const html = source.replace(TOKEN, (_whole, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      unresolved.add(key);
      return '';
    }
    return escapeHtml(value);
  });
  return { html, unresolved: [...unresolved] };
}

/** Substitutes a text part (subject, plain-text body); the same rule, no markup context to escape. */
export function renderTextPart(source: string, variables: Record<string, string> | null): { text: string; unresolved: string[] } {
  if (variables === null) return { text: source, unresolved: [] };
  return { text: renderTemplate(source, variables), unresolved: templateTokens(source).filter((key) => variables[key] === undefined) };
}

/**
 * Simple values only, for the same reason the send path skips the rest: a template is text, and an
 * object or a list would render as `[object Object]`.
 */
function variablesOf(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function sampleLabel(record: Record<string, unknown>): string {
  if (typeof record['name'] === 'string' && record['name'].trim() !== '') return record['name'];
  return String(record['id'] ?? '');
}

@Injectable()
export class EmailTemplatePreviewService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async preview(payload: unknown): Promise<EmailTemplatePreview> {
    this.scope.requirePrincipal();
    // Previewing is reading a template: someone with no access to the entity gets no rendering,
    // whether the draft came from a record or from their own keyboard.
    await this.acl.assertAccess(EMAIL_TEMPLATE_ENTITY, 'read');

    const input = parseShape(PreviewSchema, payload);
    const type = input.sampleEntityType ?? undefined;
    const id = input.sampleEntityId ?? undefined;
    const sampleRecord = type === undefined || id === undefined ? null : await this.records.get(type, id);
    const variables = sampleRecord === null ? null : variablesOf(sampleRecord);

    const subject = input.subject ?? null;
    const body = input.body ?? null;
    const bodyHtml = input.bodyHtml ?? null;
    const renderedSubject = subject === null ? null : renderTextPart(subject, variables);
    const renderedBody = body === null ? null : renderTextPart(body, variables);
    const renderedHtml = bodyHtml === null ? null : renderHtmlPart(bodyHtml, variables);

    const parts = [subject ?? '', body ?? '', bodyHtml ?? ''];
    const unresolved = new Set([...(renderedSubject?.unresolved ?? []), ...(renderedBody?.unresolved ?? []), ...(renderedHtml?.unresolved ?? [])]);

    return {
      subject: renderedSubject?.text ?? null,
      body: renderedBody?.text ?? null,
      bodyHtml: renderedHtml?.html ?? null,
      placeholders: [...new Set(parts.flatMap(templateTokens))],
      unresolved: [...unresolved],
      sample:
        type === undefined || id === undefined || sampleRecord === null
          ? null
          : { type, id, label: sampleLabel(sampleRecord) },
    };
  }
}

/** Shape parsing: a zod failure is the platform's `ValidationError`, not a raw `ZodError` (which reads as a 500). */
function parseShape<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Invalid request.', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
