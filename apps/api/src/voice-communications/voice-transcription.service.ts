import { randomUUID as cryptoRandomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { AIProviderGateway } from '../ai-agents/ai-provider-gateway.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CALL_ACTIVITY_ENTITY } from './voice-call.service.js';
import { VoiceCommunicationsSettingsService } from './voice-communications-settings.service.js';
import { VoiceProviderRegistry } from './voice-provider.js';
import { VoiceProviderAccountsService } from './voice-provider-accounts.service.js';

/**
 * Phase 19-VC.16 — transcription and AI enrichment
 * (`PLAN_Phase_19_Voice_Communications.md` §7.6, §15 `19-VC.16`).
 *
 * The boundaries this file enforces:
 *  - **Opt-in twice.** `features.transcripts` gates transcript retrieval, `features.aiEnrichment`
 *    gates every model call; both default off. A disabled flag is "does not run", not "runs quietly".
 *  - **The AI gateway is the only model door.** The module never talks to a provider directly, so the
 *    platform's data-class policy, allowlists and ledger apply unchanged.
 *  - **Content minimization.** Only the transcript text — redacted (phone numbers, emails, card
 *    patterns) and truncated to `ai.maxTranscriptChars` — is sent. No record fields, no bodies of
 *    other conversations.
 *  - **Draft-only.** A summary or suggested reply is stored with `ai_review_status = 'pending'`.
 *    Approval is an explicit authorized action; nothing is sent or written anywhere else by the AI.
 *  - **No mutation.** The service writes only its own transcript rows. It has no tools, so an AI
 *    response cannot send messages or touch records (§15 acceptance).
 */

export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number | null;
  readonly speaker: string | null;
  readonly text: string;
}

export interface TranscriptRow {
  id: string;
  call_session_id: string;
  state: string;
  language: string | null;
  provider_ref: string | null;
  segments: unknown;
  text: string | null;
  ai_summary: string | null;
  ai_topics: unknown;
  ai_actions: unknown;
  ai_suggested_reply: string | null;
  ai_review_status: string;
  ai_connection_key: string | null;
  ai_model: string | null;
  ai_generated_at: Date | null;
  error: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface TranscriptView {
  readonly id: string;
  readonly callSessionId: string;
  readonly state: string;
  readonly language: string | null;
  readonly segments: readonly TranscriptSegment[];
  readonly text: string | null;
  readonly ai: {
    readonly summary: string | null;
    readonly topics: readonly string[];
    readonly actions: readonly string[];
    readonly suggestedReply: string | null;
    readonly reviewStatus: string;
    readonly connectionKey: string | null;
    readonly model: string | null;
    readonly generatedAt: string | null;
  };
  readonly error: string | null;
}

@Injectable()
export class VoiceTranscriptionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(AIProviderGateway) private readonly ai: AIProviderGateway,
  ) {}

  /**
   * Retrieve the transcript for a call (§7.6). Idempotent: an existing transcript is returned, and a
   * retrieval failure is recorded on the row instead of being retried forever.
   */
  async requestTranscript(callSessionId: string): Promise<TranscriptView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'read');
    const settings = await this.settings.settings();
    if (settings.features.transcripts !== true) {
      throw new ValidationError('Transcription is disabled by policy; enable the "transcripts" feature first.');
    }
    const session = (
      await sql<{ id: string; account_key: string; provider_call_id: string | null; recording_ref: string | null }>`
        select id, account_key, provider_call_id, recording_ref from voice_call_sessions where id = ${callSessionId}
      `.execute(this.database.db)
    ).rows[0];
    if (session === undefined) throw new NotFoundError(`Call session "${callSessionId}" does not exist.`);

    const existing = await this.findRow(callSessionId);
    if (existing !== undefined && existing.state === 'ready') return toView(existing);

    const account = await this.accounts.resolve(session.account_key);
    const adapter = this.registry.resolve(account.providerKey);
    if (adapter.fetchTranscript === undefined) {
      throw new ValidationError(`Provider "${account.providerKey}" does not offer transcript retrieval.`);
    }
    const providerRef = session.recording_ref ?? session.provider_call_id;
    const result = await adapter.fetchTranscript({ account, providerRef });

    const text = result.ok ? result.segments.map((segment) => segment.text).join('\n') : null;
    const now = new Date();
    if (existing === undefined) {
      await sql`
        insert into voice_transcripts
          (id, call_session_id, state, language, provider_ref, segments, text, error, created_at, modified_at)
        values
          (${cryptoRandomUUID()}, ${callSessionId}, ${result.ok ? 'ready' : 'failed'}, ${result.language},
           ${providerRef}, ${JSON.stringify(result.segments)}::jsonb, ${text},
           ${result.ok ? null : (result.error ?? 'The provider returned no transcript.')}, ${now}, ${now})
      `.execute(this.database.db);
    } else {
      await sql`
        update voice_transcripts
        set state = ${result.ok ? 'ready' : 'failed'}, language = ${result.language},
            segments = ${JSON.stringify(result.segments)}::jsonb, text = ${text},
            error = ${result.ok ? null : (result.error ?? 'The provider returned no transcript.')}, modified_at = ${now}
        where id = ${existing.id}
      `.execute(this.database.db);
    }
    return toView((await this.findRow(callSessionId)) as TranscriptRow);
  }

  /**
   * AI enrichment (§7.6): a summary, topics, actions and a *suggested* reply — all draft-only, all
   * provenance-stamped. The prompt carries the redacted transcript only.
   */
  async enrich(callSessionId: string): Promise<TranscriptView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'read');
    const settings = await this.settings.settings();
    if (settings.features.transcripts !== true) {
      throw new ValidationError('Transcription is disabled; there is nothing to enrich.');
    }
    if (settings.features.aiEnrichment !== true) {
      throw new ValidationError('AI enrichment is disabled by policy; enable the "aiEnrichment" feature first.');
    }
    const connectionKey = settings.ai.connectionKey.trim();
    const model = settings.ai.model.trim();
    if (connectionKey === '' || model === '') {
      throw new ValidationError('AI enrichment needs ai.connectionKey and ai.model to be configured.');
    }
    const row = await this.findRow(callSessionId);
    if (row === undefined || row.state !== 'ready' || row.text === null) {
      throw new ValidationError('The call has no ready transcript to enrich; request the transcript first.');
    }

    const redacted = redactForAI(row.text).slice(0, settings.ai.maxTranscriptChars);
    const now = new Date();
    try {
      const response = await this.ai.complete({
        connectionKey,
        dataClass: 'internal',
        request: {
          model,
          temperature: 0.2,
          responseFormat: {
            type: 'json_schema',
            name: 'call_enrichment',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'topics', 'actions', 'suggestedReply'],
              properties: {
                summary: { type: 'string', maxLength: 2_000 },
                topics: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                actions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                suggestedReply: { type: 'string', maxLength: 2_000 },
              },
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'You summarize a customer phone call for a CRM agent. Be factual, terse, and never invent commitments. Reply through the JSON schema only.',
            },
            {
              role: 'user',
              content: `Transcript (redacted):\n${redacted}\n\nProduce: summary, topics, follow-up actions, and one suggested reply message to the customer.`,
            },
          ],
        },
      });
      const parsed = (response.structured ?? {}) as Record<string, unknown>;
      await sql`
        update voice_transcripts
        set ai_summary = ${textOf(parsed['summary'])}, ai_topics = ${jsonOf(parsed['topics'])}::jsonb,
            ai_actions = ${jsonOf(parsed['actions'])}::jsonb, ai_suggested_reply = ${textOf(parsed['suggestedReply'])},
            ai_review_status = 'pending', ai_connection_key = ${connectionKey}, ai_model = ${model},
            ai_generated_at = ${now}, error = null, modified_at = ${now}
        where id = ${row.id}
      `.execute(this.database.db);
    } catch (error) {
      // Enrichment failure never damages the transcript; the operator sees the reason.
      await sql`
        update voice_transcripts
        set error = ${error instanceof Error ? error.message : 'The AI call failed.'}, modified_at = ${now}
        where id = ${row.id}
      `.execute(this.database.db);
    }
    return toView((await this.findRow(callSessionId)) as TranscriptRow);
  }

  /**
   * Approval. The suggested reply is an agent artefact: approving exposes it in the transcript view
   * for the agent to send or discard through the normal message path. The AI itself sends nothing.
   */
  async setReviewStatus(callSessionId: string, status: 'approved' | 'dismissed'): Promise<TranscriptView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'edit');
    const row = await this.findRow(callSessionId);
    if (row === undefined) throw new NotFoundError('The call has no transcript.');
    if (row.ai_suggested_reply === null && status === 'approved') {
      throw new ValidationError('There is no AI suggestion to approve.');
    }
    await sql`
      update voice_transcripts set ai_review_status = ${status}, modified_at = now() where id = ${row.id}
    `.execute(this.database.db);
    return toView((await this.findRow(callSessionId)) as TranscriptRow);
  }

  async get(callSessionId: string): Promise<TranscriptView | null> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'read');
    const row = await this.findRow(callSessionId);
    return row === null || row === undefined ? null : toView(row);
  }

  // ------------------------------------------------------------------------- internals

  private async findRow(callSessionId: string): Promise<TranscriptRow | undefined> {
    return (
      await sql<TranscriptRow>`select * from voice_transcripts where call_session_id = ${callSessionId}`.execute(
        this.database.db,
      )
    ).rows[0];
  }
}

/**
 * Content minimization before a model call: the only PII classes the transcript is likely to carry
 * (phone numbers, emails, card-like digit runs) are masked. Numbers a customer *says* stay — a
 * transcript that redacted its own subject would be useless — but raw digit blocks do not travel.
 */
export function redactForAI(text: string): string {
  return text
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => (/\d{9,}/.test(match.replace(/\D/g, '')) ? '[number]' : match))
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[card]');
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function jsonOf(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.filter((item): item is string => typeof item === 'string'));
}

function toSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const start = typeof record['startMs'] === 'number' ? record['startMs'] : null;
    const text = typeof record['text'] === 'string' ? record['text'] : null;
    if (start === null || text === null) return [];
    return [
      {
        startMs: start,
        endMs: typeof record['endMs'] === 'number' ? record['endMs'] : null,
        speaker: typeof record['speaker'] === 'string' ? record['speaker'] : null,
        text,
      },
    ];
  });
}

function toView(row: TranscriptRow): TranscriptView {
  return {
    id: row.id,
    callSessionId: row.call_session_id,
    state: row.state,
    language: row.language,
    segments: toSegments(row.segments),
    text: row.text,
    ai: {
      summary: row.ai_summary,
      topics: Array.isArray(row.ai_topics) ? (row.ai_topics as string[]) : [],
      actions: Array.isArray(row.ai_actions) ? (row.ai_actions as string[]) : [],
      suggestedReply: row.ai_suggested_reply,
      reviewStatus: row.ai_review_status,
      connectionKey: row.ai_connection_key,
      model: row.ai_model,
      generatedAt: row.ai_generated_at === null ? null : new Date(row.ai_generated_at).toISOString(),
    },
    error: row.error,
  };
}
