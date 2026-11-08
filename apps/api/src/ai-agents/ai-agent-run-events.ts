import { randomUUID } from 'node:crypto';

import { log } from '@carocrm/core/logger/index.js';

import type { Db } from '../database/database.service.js';

/**
 * Phase 19-AI.24 — the shared run-event append.
 *
 * Extracted from `AIAgentRunService.appendEvent` so the provider gateway can record a
 * `run.ledger_write_failed` marker on the same ledger when its best-effort usage write is
 * dropped — the operator-visible signal that keeps a missing ledger row from silently reading
 * as a known zero cost. The seq allocation retries on the `(run_id, seq)` unique constraint,
 * exactly as the service path always has.
 */
export async function appendRunEvent(
  db: Db,
  input: {
    readonly runId: string;
    readonly category: string;
    readonly type: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly visibility?: 'user' | 'operator' | 'admin';
  },
): Promise<void> {
  const visibility = input.visibility ?? 'operator';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = randomUUID();
    const now = new Date();
    try {
      const last = await db
        .selectFrom('ai_agent_run_events')
        .select((eb) => eb.fn.max('seq').as('seq'))
        .where('run_id', '=', input.runId)
        .executeTakeFirst();
      const seq = Number(last?.seq ?? 0) + 1;
      await db
        .insertInto('ai_agent_run_events')
        .values({
          id,
          run_id: input.runId,
          seq,
          category: input.category,
          event_type: input.type,
          actor_type: 'system',
          actor_id: null,
          correlation_id: null,
          causation_id: null,
          summary: input.summary.slice(0, 500),
          payload: JSON.stringify(boundPayload(input.payload)),
          visibility,
          redaction: 'summary',
          created_at: now,
        })
        .execute();
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) {
        log.warn({ runId: input.runId, error: error instanceof Error ? error.message : 'unknown' }, 'run event could not be written');
        return;
      }
    }
  }
}

function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') out[key] = value.slice(0, 400);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20);
    else if (typeof value === 'object') out[key] = JSON.parse(safeJson(value, 1_200)) as unknown;
  }
  return out;
}

function safeJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = '"[unserializable]"';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function isUniqueViolation(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '23505';
}
