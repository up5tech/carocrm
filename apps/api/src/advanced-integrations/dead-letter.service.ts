import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { redactProviderError } from './provider-error.js';

/**
 * Phase 19-INT.11 — dead letters
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.2; `19-INT.11`).
 *
 * A dead letter is a terminal failure that a human has to look at. The platform's worker already
 * logs `'bullmq job permanently failed (dead letter)'`, but a log line is not a store: nothing can
 * be listed, inspected or replayed from it. This service is that store.
 *
 * Two rules:
 *
 *  - **A dead letter never contains a credential.** Only the error code, the category and a
 *    redacted detail are stored, plus the payload the operation produced — which is itself
 *    redacted before it is written.
 *  - **A replay is explicit and recorded.** Replaying marks the letter `replayed` and stamps who
 *    replayed it. The letter is never silently removed.
 */

export const DEAD_LETTER_STATUSES = ['open', 'replayed', 'discarded'] as const;
export type DeadLetterStatus = (typeof DEAD_LETTER_STATUSES)[number];

export interface DeadLetterView {
  readonly id: string;
  readonly connectionId: string;
  readonly providerKey: string;
  readonly operationId: string | null;
  readonly errorCode: string;
  readonly errorCategory: string;
  readonly errorDetail: string | null;
  readonly attempts: number;
  readonly status: DeadLetterStatus;
  readonly replayedAt: string | null;
  readonly replayedBy: string | null;
  readonly createdAt: string;
}

export interface DeadLetterInput {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly operationId?: string | null | undefined;
  readonly error: unknown;
  readonly attempts: number;
  /** The redacted payload that failed. Never a credential. */
  readonly payload?: Record<string, unknown> | null | undefined;
}

interface DeadLetterRow {
  id: string;
  connection_id: string;
  provider_key: string;
  operation_id: string | null;
  error_code: string;
  error_category: string;
  error_detail: string | null;
  attempts: number;
  status: string;
  replayed_at: Date | null;
  replayed_by: string | null;
  created_at: Date;
}

@Injectable()
export class DeadLetterService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Record a terminal failure. */
  async record(input: DeadLetterInput): Promise<DeadLetterView> {
    const error = redactProviderError(input.error);
    const id = randomUUID();
    const rows = await sql<DeadLetterRow>`
      insert into integration_dead_letters
        (id, connection_id, provider_key, operation_id, error_code, error_category, error_detail,
         attempts, payload, status, created_at)
      values
        (${id}, ${input.connectionId}, ${input.providerKey}, ${input.operationId ?? null},
         ${error.code}, ${error.category}, ${error.detail}, ${input.attempts},
         ${input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload)}::jsonb,
         'open', ${new Date()})
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new ValidationError('The dead letter could not be stored.');
    return toView(row);
  }

  /** The open dead letters of a connection, newest first. */
  async listOpen(connectionId: string, limit = 100): Promise<readonly DeadLetterView[]> {
    const rows = await sql<DeadLetterRow>`
      select * from integration_dead_letters
      where connection_id = ${connectionId} and status = 'open'
      order by created_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toView(row));
  }

  /** One dead letter. */
  async get(id: string): Promise<DeadLetterView> {
    const rows = await sql<DeadLetterRow>`
      select * from integration_dead_letters where id = ${id} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError(`Dead letter "${id}" does not exist.`);
    return toView(row);
  }

  /**
   * Mark a dead letter as replayed.
   *
   * The letter stays. The platform keeps the history of what failed and what was done about it,
   * which is what an operator reviewing a provider outage needs.
   */
  async markReplayed(id: string): Promise<DeadLetterView> {
    const rows = await sql<DeadLetterRow>`
      update integration_dead_letters
      set status = 'replayed', replayed_at = ${new Date()}, replayed_by = ${this.scope.userId ?? 'system'}
      where id = ${id} and status = 'open'
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) {
      throw new ValidationError('The dead letter is not open, so it cannot be replayed.');
    }
    return toView(row);
  }

  /** Mark a dead letter as discarded. An operator decided it will not be retried. */
  async markDiscarded(id: string): Promise<DeadLetterView> {
    const rows = await sql<DeadLetterRow>`
      update integration_dead_letters
      set status = 'discarded', replayed_at = ${new Date()}, replayed_by = ${this.scope.userId ?? 'system'}
      where id = ${id} and status = 'open'
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) {
      throw new ValidationError('The dead letter is not open, so it cannot be discarded.');
    }
    return toView(row);
  }
}

function toView(row: DeadLetterRow): DeadLetterView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    providerKey: row.provider_key,
    operationId: row.operation_id,
    errorCode: row.error_code,
    errorCategory: row.error_category,
    errorDetail: row.error_detail,
    attempts: row.attempts,
    status: row.status as DeadLetterStatus,
    replayedAt: row.replayed_at ? row.replayed_at.toISOString() : null,
    replayedBy: row.replayed_by,
    createdAt: row.created_at.toISOString(),
  };
}
