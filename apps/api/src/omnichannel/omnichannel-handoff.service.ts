import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { type CaseContextView,CaseHandoffService } from '../service-desk/index.js';
import { VoiceInboxService } from '../voice-communications/index.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';

/**
 * Phase 19-OM.17 — conversation → Case hand-off (plan §14 `19-OM.17`; feature contract §8).
 *
 * Composed exactly along ownership lines:
 *  - the **Case** is created or found by ServiceDesk's `CaseHandoffService` (idempotent on
 *    `externalId = omnichannel:<conversationId>`, with the `CaseTransition` trail);
 *  - the **link** (`voice_conversations.case_id`) is written by Voice's own `linkCase` command;
 *  - this facade only builds the safe hand-off payload and orders the two calls. A temporary failure
 *    between them is recoverable: the Case exists with its external id, and a retry finds it and
 *    completes the link.
 *
 * Privacy: the description carries the customer's display name/address, the channel and the last
 * **customer-visible inbound** message excerpt — never an internal note and never an unrelated
 * message. Conversation status stays independent: this command never changes Case status, and Case
 * status is only read for display context.
 */

export interface OmnichannelHandoffResult {
  readonly case: CaseContextView;
  readonly created: boolean;
  readonly linked: boolean;
}

const CASE_PRIORITY: Readonly<Record<string, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

@Injectable()
export class OmnichannelHandoffService {
  constructor(
    @Inject(CaseHandoffService) private readonly handoff: CaseHandoffService,
    @Inject(VoiceInboxService) private readonly inbox: VoiceInboxService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
  ) {}

  /** The Case context shown beside the conversation (read-only; Case read ACL is enforced). */
  async context(conversationId: string): Promise<{ readonly case: CaseContextView | null }> {
    await this.permissions.assert('inboxView');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const caseId = await this.caseIdOf(conversationId);
    return { case: caseId === null ? null : await this.handoff.context(caseId) };
  }

  /** Create a Case for the conversation, or link an existing one; safe to retry. */
  async createOrLink(
    conversationId: string,
    input: { readonly linkCaseId?: string | undefined } = {},
  ): Promise<OmnichannelHandoffResult> {
    await this.permissions.assert('assign');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const conversation = await this.requireConversation(conversationId);
    const alreadyLinked = conversation.case_id;
    if (alreadyLinked !== null) {
      return { case: await this.handoff.context(alreadyLinked), created: false, linked: true };
    }

    if (input.linkCaseId !== undefined && input.linkCaseId.trim() !== '') {
      const caseId = input.linkCaseId.trim();
      // Reading the Case first is the authorization: a Case this caller cannot read cannot be linked.
      const context = await this.handoff.context(caseId);
      await this.handoff.recordLink(caseId, conversationId, conversation.channel);
      await this.inbox.linkCase(conversationId, caseId);
      return { case: context, created: false, linked: true };
    }

    const customer = await this.customerOf(conversationId);
    const excerpt = await this.lastCustomerMessage(conversationId);
    const label = customer?.displayName ?? customer?.address ?? conversationId.slice(0, 8);
    const created = await this.handoff.createOrGet({
      externalId: `omnichannel:${conversationId}`,
      externalSource: 'omnichannel',
      name: `${label} — ${conversation.channel}`,
      description: [
        `Customer: ${customer?.displayName ?? customer?.address ?? 'unknown'}`,
        `Channel: ${conversation.channel}`,
        ...(excerpt === null ? [] : [`Last customer message: ${excerpt}`]),
      ].join('\n'),
      source: 'Omnichannel',
      priority: CASE_PRIORITY[conversation.priority] ?? 'Normal',
      requesterName: customer?.displayName ?? customer?.address ?? 'Website chat visitor',
      ...(customer?.entityType === 'Contact' && customer.entityId !== null ? { contactId: customer.entityId } : {}),
    });
    await this.inbox.linkCase(conversationId, created.caseId);
    return { case: await this.handoff.context(created.caseId), created: created.created, linked: true };
  }

  /** Conversations linked to one Case (safe fields only; the Case read ACL is the gate). */
  async conversationsForCase(caseId: string): Promise<{
    readonly list: readonly { id: string; channel: string; status: string; lastActivityAt: string | null }[];
  }> {
    await this.permissions.assert('inboxView');
    await this.handoff.context(caseId);
    const rows = (await sql<{ id: string; channel: string; status: string; last_activity_at: Date | null }>`
      select id, channel, status, last_activity_at from voice_conversations
      where case_id = ${caseId} order by last_activity_at desc nulls last
      limit 50
    `.execute(this.database.db)).rows;
    return {
      list: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        lastActivityAt: row.last_activity_at === null ? null : new Date(row.last_activity_at).toISOString(),
      })),
    };
  }

  private async requireConversation(conversationId: string): Promise<{ id: string; channel: string; case_id: string | null; priority: string }> {
    const row = (await sql<{ id: string; channel: string; case_id: string | null; priority: string }>`
      select id, channel, case_id, priority from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new Error(`Conversation "${conversationId}" does not exist.`);
    return row;
  }

  private async caseIdOf(conversationId: string): Promise<string | null> {
    const row = (await sql<{ case_id: string | null }>`
      select case_id from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    return row?.case_id ?? null;
  }

  private async customerOf(conversationId: string): Promise<{ address: string; displayName: string | null; entityType: string | null; entityId: string | null } | null> {
    const row = (await sql<{ address: string; display_name: string | null; entity_type: string | null; entity_id: string | null }>`
      select address, display_name, entity_type, entity_id from voice_conversation_participants
      where conversation_id = ${conversationId} and role = 'customer'
      order by created_at asc limit 1
    `.execute(this.database.db)).rows[0];
    return row === undefined
      ? null
      : { address: row.address, displayName: row.display_name, entityType: row.entity_type, entityId: row.entity_id };
  }

  /** The last customer-visible inbound message — internal notes are excluded in SQL, not by the caller. */
  private async lastCustomerMessage(conversationId: string): Promise<string | null> {
    const row = (await sql<{ body: string | null }>`
      select body from voice_messages
      where conversation_id = ${conversationId} and direction = 'inbound' and is_internal_note = false
      order by created_at desc limit 1
    `.execute(this.database.db)).rows[0];
    const body = row?.body?.trim() ?? '';
    if (body === '') return null;
    return body.length > 400 ? `${body.slice(0, 400)}…` : body;
  }
}
