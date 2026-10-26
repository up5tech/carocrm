import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runAsServiceDeskSystem } from './service-desk-authority.js';
import { CASE_ENTITY } from './service-desk-domain.js';
import { runAsServiceDeskInternal } from './service-desk-internal.js';

/**
 * Phase 19-OM.17 — the Case hand-off contract (extension E9; feature contract §8; plan §14 OM.17).
 *
 * A conversation becomes a Case through **this domain command**, never through the generic entity
 * API from another module:
 *  - `createOrGet` is idempotent on `externalId`, enforced by the partial unique index (migration
 *    081) — a retried hand-off returns the same Case (`created:false`), and a race resolves to one
 *    row because the database refuses the second insert.
 *  - The Case records its origin (`source: 'Omnichannel'`, `externalId`/`externalSource`) and a
 *    `CaseTransition` row (`command: 'handoff'`), so the trail is complete — the generic entity
 *    create could not express command or reason.
 *  - `recordLink` appends a `CaseTransition` (`command: 'link_conversation'`) when an existing Case
 *    is linked; the authoritative pointer stays on the conversation (`voice_conversations.case_id`,
 *    written by the Voice owner), and linking is idempotent per conversation.
 *  - Permissions: the human actor must hold `Case:create` (or `Case:edit` to link); server-owned
 *    fields are written under the documented internal authority with the actor attributed.
 *  - A Case's status is never changed by a conversation or by this command; conversation state stays
 *    independent (`context` only reads it for display).
 */

export interface CaseHandoffInput {
  readonly externalId: string;
  readonly externalSource: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly priority?: string | undefined;
  readonly type?: string | undefined;
  readonly contactId?: string | undefined;
  readonly accountId?: string | undefined;
  /** The conversation's customer label, so the Case satisfies the requester rule. */
  readonly requesterName?: string | undefined;
  readonly requesterEmail?: string | undefined;
}

export interface CaseHandoffResult {
  readonly caseId: string;
  readonly caseNumber: string | null;
  readonly status: string;
  readonly created: boolean;
}

export interface CaseContextView {
  readonly id: string;
  readonly caseNumber: string | null;
  readonly status: string;
  readonly priority: string | null;
  readonly type: string | null;
  readonly source: string | null;
  readonly externalId: string | null;
}

@Injectable()
export class CaseHandoffService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Create-or-link: one Case per external reference, with the hand-off trail recorded once. */
  async createOrGet(input: CaseHandoffInput): Promise<CaseHandoffResult> {
    await this.acl.assertAccess(CASE_ENTITY, 'create');
    const existing = await this.findByExternalId(input.externalId);
    if (existing !== undefined) return { ...existing, created: false };

    try {
      const record = await runAsServiceDeskInternal(() =>
        this.entities.create(CASE_ENTITY, {
          name: input.name,
          description: input.description,
          source: input.source,
          externalId: input.externalId,
          externalSource: input.externalSource,
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.requesterName === undefined ? {} : { requesterName: input.requesterName }),
          ...(input.requesterEmail === undefined ? {} : { requesterEmail: input.requesterEmail }),
        }),
      );
      const recordId = String(record['id'] ?? '');
      if (recordId === '') throw new Error('The case record has no id.');
      const created = await this.context(recordId);
      await this.transition(recordId, created.caseNumber, null, created.status, 'handoff', `Created from ${input.externalSource} (${input.externalId})`, `handoff:${input.externalId}`);
      return { caseId: recordId, caseNumber: created.caseNumber, status: created.status, created: true };
    } catch (error) {
      // The unique index answered a concurrent create: return the winner instead of failing the
      // retry. Any other failure is the real validation error and is surfaced unchanged.
      const winner = await this.findByExternalId(input.externalId);
      if (winner !== undefined) return { ...winner, created: false };
      throw error;
    }
  }

  /** Append the link trail for an existing Case (idempotent per conversation). */
  async recordLink(caseId: string, conversationId: string, channel: string): Promise<{ readonly recorded: boolean }> {
    await this.acl.assertAccess(CASE_ENTITY, 'edit');
    const context = await this.context(caseId);
    try {
      await this.transition(
        caseId,
        context.caseNumber,
        context.status,
        context.status,
        'link_conversation',
        `Linked to ${channel} conversation ${conversationId}`,
        `link:${conversationId}`,
      );
      return { recorded: true };
    } catch {
      // The unique (caseId, idempotencyKey) index: this conversation was already linked here.
      return { recorded: false };
    }
  }

  /** Read-only context (the ACL-aware entity read is the gate). */
  async context(caseId: string): Promise<CaseContextView> {
    const record = await this.entities.get(CASE_ENTITY, caseId);
    // `entities.get` returns the serialized record (flat attributes, `id` included), not `{ data }`.
    const data = (record['data'] as Record<string, unknown> | undefined) ?? record;
    return {
      id: caseId,
      caseNumber: text(data['caseNumber']),
      status: text(data['status']) ?? 'New',
      priority: text(data['priority']),
      type: text(data['type']),
      source: text(data['source']),
      externalId: text(data['externalId']),
    };
  }

  private async findByExternalId(externalId: string): Promise<{ caseId: string; caseNumber: string | null; status: string } | undefined> {
    const row = (await sql<{ id: string; attrs: Record<string, unknown> | null }>`
      select id, attrs from entity_records
      where entity_type = 'Case' and deleted_at is null and attrs->>'externalId' = ${externalId}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) return undefined;
    return {
      caseId: row.id,
      caseNumber: text(row.attrs?.['caseNumber']),
      status: text(row.attrs?.['status']) ?? 'New',
    };
  }

  private async transition(
    caseId: string,
    caseNumber: string | null,
    fromStatus: string | null,
    toStatus: string,
    command: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<void> {
    await runAsServiceDeskSystem(this.scope, `caseHandoff:${command}`, () =>
      this.entities.create('CaseTransition', {
        caseId,
        caseNumber,
        ...(fromStatus === null ? {} : { fromStatus }),
        toStatus,
        command,
        reason,
        actorUserId: this.scope.userId ?? null,
        actorType: 'user',
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      }),
    );
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
