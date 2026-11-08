import { randomUUID } from 'node:crypto';

import { AppError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-AI.23 — idempotency receipts for `POST action/mcp/call`.
 *
 * The MCP direct-call door executes a tool with **no run** behind it, so the run pipeline's
 * `ai_agent_tool_calls(run_id, idempotency_key)` dedup cannot apply — and that table's `run_id`
 * FK cannot point at a `mcp-direct` sentinel. Without this receipt a replayed `low_write` call
 * duplicates its effect. The receipt is keyed by `(principal_id, idempotency_key)`, holds the
 * tool-call id the caller saw plus the serialized result, and is claimed **before** execution so
 * a concurrent duplicate can distinguish "in flight" from "done".
 *
 * Only write-capable tools take this path; read tools keep a generated key and are never
 * recorded, because there is no effect to duplicate.
 */
export type McpDirectClaim =
  | { readonly kind: 'execute'; readonly callId: string }
  | { readonly kind: 'replay'; readonly callId: string; readonly result: unknown };

const IN_FLIGHT_POLL_MS = 100;
const IN_FLIGHT_ATTEMPTS = 50;

@Injectable()
export class AIAgentMcpDirectService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /**
   * Claims `(principalId, idempotencyKey)` for `toolKey`/`argumentHash`.
   *
   * - Fresh key → `{ kind: 'execute' }`: the caller owns execution and must `complete` or
   *   `release` the claim.
   * - Completed receipt → `{ kind: 'replay' }`: return the stored call id and result without
   *   re-executing.
   * - Same key, different tool or arguments → refused; a key is not a blank cheque.
   * - Receipt still pending → the identical call is in flight elsewhere; refused after a short
   *   poll rather than double-executing.
   */
  async claim(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly toolKey: string;
    readonly argumentHash: string;
  }): Promise<McpDirectClaim> {
    const callId = randomUUID();
    const inserted = await this.database.db
      .insertInto('ai_agent_mcp_direct_calls')
      .values({
        id: randomUUID(),
        principal_id: input.principalId,
        idempotency_key: input.idempotencyKey,
        tool_key: input.toolKey,
        argument_hash: input.argumentHash,
        call_id: callId,
        result: null,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['principal_id', 'idempotency_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return { kind: 'execute', callId };

    for (let attempt = 0; attempt <= IN_FLIGHT_ATTEMPTS; attempt += 1) {
      const existing = await this.database.db
        .selectFrom('ai_agent_mcp_direct_calls')
        .select(['tool_key', 'argument_hash', 'call_id', 'result'])
        .where('principal_id', '=', input.principalId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing === undefined) {
        // The owner released a failed call between our insert and this read; claim again.
        return this.claim(input);
      }
      if (existing.tool_key !== input.toolKey || existing.argument_hash !== input.argumentHash) {
        throw new ValidationError('This idempotency key was already used with different arguments.', {
          code: 'AI_IDEMPOTENCY_CONFLICT',
        });
      }
      if (existing.result !== null && existing.result !== undefined) {
        return {
          kind: 'replay',
          callId: existing.call_id,
          result: typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result,
        };
      }
      if (attempt < IN_FLIGHT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_POLL_MS));
      }
    }
    throw new AppError(
      'AI_CALL_IN_FLIGHT',
      'An identical direct tool call is still in flight; retry shortly.',
      undefined,
      409,
    );
  }

  /** Stores the executed result on a claimed receipt so replays return it verbatim. */
  async complete(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly result: unknown;
  }): Promise<void> {
    await this.database.db
      .updateTable('ai_agent_mcp_direct_calls')
      .set({ result: JSON.stringify(input.result) })
      .where('principal_id', '=', input.principalId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .execute();
  }

  /**
   * Drops a pending claim after a failed execution, so a retry with the same key may proceed —
   * the same rule the run pipeline applies to a tool call that never reported an outcome.
   */
  async release(input: { readonly principalId: string; readonly idempotencyKey: string }): Promise<void> {
    await this.database.db
      .deleteFrom('ai_agent_mcp_direct_calls')
      .where('principal_id', '=', input.principalId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .where('result', 'is', null)
      .execute();
  }
}
