import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { redactSecrets } from './advanced-integrations-domain.js';

/**
 * Phase 19-INT.26 — the module's audit trail
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.4, §16.2; `19-INT.26`).
 *
 * The kernel audit hook records changes to **entities**. The plan §14.4 asks for an audit event
 * for every privileged module action as well: a connection paused, a mapping published, a sync
 * replayed, a conflict resolved, a dead letter replayed, a signature failure.
 *
 * Those actions touch no CRM record, so the kernel hook never sees them. This service is the
 * module's own trail, in the module's own table.
 *
 * Three rules make the trail worth reading:
 *
 *  1. **The action name is an allowlist.** A stable vocabulary, so a consumer can ask "every
 *     action of kind `connection.paused`" without knowing the implementation. An unknown action is
 *     refused, so a typo cannot create a second spelling of the same fact.
 *  2. **The detail is redacted.** The detail is passed through `redactSecrets`, so a credential
 *     that a caller carelessly put in a reason string never reaches the trail. The trail is read by
 *     administrators, so it is exactly the place where a secret must not appear.
 *  3. **The actor is explicit.** `system` means the module's own service identity — a job, a
 *     webhook, a scheduled sweep. A user id means a person. The plan requires the distinction:
 *     *"Explicitly distinguish system automation identity from human attribution."*
 */

/** The audit actions this module records. */
export const INTEGRATION_AUDIT_ACTIONS = [
  // Connections (plan §14.4).
  'connection.created',
  'connection.updated',
  'connection.enabled',
  'connection.disabled',
  'connection.paused',
  'connection.resumed',
  'connection.reauthorized',
  'connection.revoked',
  'connection.deleted',
  'connection.tested',
  'connection.changed',
  // Credentials. The value is never recorded — only the fact that one changed.
  'credential.stored',
  'credential.rotated',
  'credential.revoked',
  'oauth.scopesChanged',
  // Mappings.
  'mapping.created',
  'mapping.updated',
  'mapping.published',
  'mapping.retired',
  'mapping.previewed',
  // Sync runs.
  'sync.started',
  'sync.cancelled',
  'sync.reconciled',
  // Conflicts and dead letters.
  'conflict.opened',
  'conflict.resolved',
  'deadLetter.replayed',
  // Webhooks.
  'webhook.rejected',
  'webhook.duplicate',
  // Enrichment.
  'enrichment.profileCreated',
  'enrichment.profileUpdated',
  'enrichment.previewed',
  'enrichment.accepted',
  'enrichment.rejected',
  // Operations.
  'subscription.renewed',
  'retention.purged',
] as const;

export type IntegrationAuditAction = (typeof INTEGRATION_AUDIT_ACTIONS)[number];

/** The outcome of an audited action. */
export type IntegrationAuditOutcome = 'ok' | 'refused';

export interface IntegrationAuditEntry {
  readonly id: string;
  readonly connectionId: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly actorType: 'system' | 'user';
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly outcome: IntegrationAuditOutcome;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

interface AuditRow {
  id: string;
  connection_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  reason: string | null;
  outcome: string;
  detail: unknown;
  correlation_id: string | null;
  created_at: Date;
}

@Injectable()
export class IntegrationAuditService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Record one audited action.
   *
   * The write never throws: a failure to write the trail must not fail the action it describes.
   * A refused action is recorded too — a denial is a fact an operator needs.
   */
  async record(input: {
    readonly action: IntegrationAuditAction;
    readonly connectionId?: string | null | undefined;
    readonly entityType?: string | null | undefined;
    readonly entityId?: string | null | undefined;
    readonly reason?: string | null | undefined;
    readonly outcome?: IntegrationAuditOutcome | undefined;
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
    readonly correlationId?: string | null | undefined;
  }): Promise<void> {
    if (!(INTEGRATION_AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
      throw new ValidationError(`"${input.action}" is not an audited integration action.`, {
        action: input.action,
      });
    }
    const userId = this.scope.userId ?? null;
    const principal = this.scope.principal;
    // The distinction the plan asks for: *"Explicitly distinguish system automation identity from
    // human attribution."* A service identity has a user id too — it is `system` — so the actor
    // type is decided by the principal's **type**, not by the presence of an id.
    const actorType: 'system' | 'user' =
      principal === undefined || principal.userType === 'system' ? 'system' : 'user';
    try {
      await sql`
        insert into integration_audit_log
          (id, connection_id, action, entity_type, entity_id, actor_type, actor_id, actor_name,
           reason, outcome, detail, correlation_id, created_at)
        values
          (${randomUUID()}, ${input.connectionId ?? null}, ${input.action},
           ${input.entityType ?? null}, ${input.entityId ?? null},
           ${actorType}, ${userId},
           ${principal?.userName ?? null}, ${input.reason ?? null},
           ${input.outcome ?? 'ok'},
           ${JSON.stringify(redactSecrets({ ...(input.detail ?? {}) }))}::jsonb,
           ${input.correlationId ?? null}, ${new Date()})
      `.execute(this.database.db);
    } catch {
      // The trail is evidence, not a gate. A failure to write it must not undo the action, and it
      // must not crash a worker either.
    }
  }

  /**
   * Record a **refused** action.
   *
   * A denial is a fact: somebody tried something the module would not do. It is the first thing
   * an operator wants to see.
   */
  async recordRefusal(
    action: IntegrationAuditAction,
    reason: string,
    detail?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.record({ action, reason, outcome: 'refused', ...(detail === undefined ? {} : { detail }) });
  }

  /** The trail, newest first. */
  async list(options: {
    readonly connectionId?: string | undefined;
    readonly action?: string | undefined;
    readonly limit?: number | undefined;
  } = {}): Promise<readonly IntegrationAuditEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = await sql<AuditRow>`
      select * from integration_audit_log
      where (${options.connectionId ?? null}::text is null or connection_id = ${options.connectionId ?? null})
        and (${options.action ?? null}::text is null or action = ${options.action ?? null})
      order by created_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toEntry(row));
  }

  /** How many rows the trail holds. Used by the metrics. */
  async count(): Promise<number> {
    const rows = await sql<{ c: string }>`select count(*)::text as c from integration_audit_log`.execute(
      this.database.db,
    );
    return Number(rows.rows[0]?.c ?? '0');
  }
}

function toEntry(row: AuditRow): IntegrationAuditEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorType: row.actor_type === 'user' ? 'user' : 'system',
    actorId: row.actor_id,
    actorName: row.actor_name,
    reason: row.reason,
    outcome: row.outcome === 'refused' ? 'refused' : 'ok',
    detail:
      typeof row.detail === 'object' && row.detail !== null && !Array.isArray(row.detail)
        ? (row.detail as Record<string, unknown>)
        : {},
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}
