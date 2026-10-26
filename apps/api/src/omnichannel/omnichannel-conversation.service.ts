import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  type InboxConversationView,
  type InboxQuery,
  type MessageView,
  VoiceInboxService,
  VoiceMessagingService,
} from '../voice-communications/index.js';
import { OmnichannelCapabilityService } from './omnichannel-capability.service.js';

/**
 * Phase 19-OM.6 — the workspace conversation facade
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.6`; feature contract §2.1; decision D1).
 *
 * Every operation composes the exported Voice services — `VoiceInboxService` for reads, mark-read,
 * status and assignment; `VoiceMessagingService` for reconcile — so there is **no second
 * send/ingest/status implementation** and no second conversation store. What this file adds is the
 * workspace projection: the read model is computed from the canonical rows (the columns migration
 * 077 added: priority, category, language, tags, queue, snooze, version) plus the channel threads,
 * and it is read-only. Nothing here writes `voice_conversations` or `voice_messages`; the owner's
 * services do, under their own ACL and event records.
 */

export interface OmnichannelConversationView extends InboxConversationView {
  /** The customer participant the agent is speaking with (address is the channel identity). */
  readonly customerAddress: string | null;
  readonly customerName: string | null;
  readonly priority: string;
  readonly category: string | null;
  readonly language: string | null;
  readonly tags: readonly string[];
  readonly currentQueueId: string | null;
  readonly assignmentVersion: number;
  readonly snoozedUntil: string | null;
  readonly closedAt: string | null;
  readonly lastMessageAt: string | null;
  readonly version: number;
  /** Channel threads attached to the canonical conversation (contract §4). */
  readonly threads: readonly OmnichannelThreadView[];
}

export interface OmnichannelThreadView {
  readonly id: string;
  readonly channel: string;
  readonly externalThreadId: string | null;
  readonly address: string | null;
  readonly providerIdentity: string | null;
  readonly createdAt: string;
}

interface CustomerRow {
  conversation_id: string;
  address: string;
  display_name: string | null;
}

interface WorkspaceRow {
  id: string;
  priority: string;
  category: string | null;
  language: string | null;
  tags: unknown;
  current_queue_id: string | null;
  assignment_version: number;
  snoozed_until: Date | null;
  closed_at: Date | null;
  last_message_at: Date | null;
  version: number;
}

@Injectable()
export class OmnichannelConversationService {
  constructor(
    @Inject(VoiceInboxService) private readonly inbox: VoiceInboxService,
    @Inject(VoiceMessagingService) private readonly messaging: VoiceMessagingService,
    @Inject(OmnichannelCapabilityService) private readonly capabilities: OmnichannelCapabilityService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** The inbox list: the owner's ACL-filtered page, enriched with the workspace projection. */
  async list(query: InboxQuery): Promise<{ readonly list: readonly OmnichannelConversationView[]; readonly total: number }> {
    const page = await this.inbox.list(query);
    const enriched = await this.enrich(page.list);
    return { list: enriched, total: page.total };
  }

  async timeline(conversationId: string, query: { readonly limit: number; readonly offset: number }) {
    return this.inbox.timeline(conversationId, query);
  }

  /** Threads of one conversation, under the conversation's own read ACL (same as the timeline). */
  async threads(conversationId: string): Promise<{ readonly list: readonly OmnichannelThreadView[] }> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    return { list: await this.threadsFor([conversationId]).then((map) => map.get(conversationId) ?? []) };
  }

  async markRead(conversationId: string): Promise<{ readonly unreadCount: number }> {
    return this.inbox.markRead(conversationId);
  }

  async setStatus(conversationId: string, status: string): Promise<OmnichannelConversationView> {
    const updated = await this.inbox.setStatus(conversationId, status);
    return (await this.enrich([updated]))[0] ?? { ...updated, customerAddress: null, customerName: null, ...emptyWorkspaceFields(), threads: [] };
  }

  async assign(
    conversationId: string,
    input: {
      readonly userId?: string | null | undefined;
      readonly teamId?: string | null | undefined;
      readonly reason?: string | undefined;
      readonly queueId?: string | null | undefined;
      readonly expectedVersion?: number | undefined;
    },
  ): Promise<OmnichannelConversationView> {
    const updated = await this.inbox.assign(conversationId, input);
    return (await this.enrich([updated]))[0] ?? { ...updated, customerAddress: null, customerName: null, ...emptyWorkspaceFields(), threads: [] };
  }

  /**
   * 19-OM.8 — the outbound reply command. The facade verifies what the workspace can know *before* the
   * owner runs its own pipeline (which still re-checks policy/consent/window/idempotency and owns the
   * final state): the conversation exists, the channel is actually sendable right now (per the
   * computed capability catalog), and the payload type is declared. A refusal names its reason codes
   * so the composer can explain it instead of showing a generic failure.
   */
  async send(
    conversationId: string,
    input: {
      readonly body: string;
      readonly idempotencyKey: string;
      readonly templateKey?: string | undefined;
      readonly templateLanguage?: string | undefined;
      readonly templateVariables?: Readonly<Record<string, string>> | undefined;
      readonly mediaAttachmentIds?: readonly string[] | undefined;
      readonly isInternalNote?: boolean | undefined;
    },
  ): Promise<{ readonly message: MessageView; readonly duplicate: boolean }> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const conversation = (await sql<{ id: string; account_key: string; channel: string }>`
      select id, account_key, channel from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    if (conversation === undefined) throw new ValidationError(`Conversation "${conversationId}" does not exist.`);
    // 19-OM.9: `web_chat` is a first-class channel now — its transport is the local adapter the
    // Omnichannel module registers, so the same catalog check and the same owner send path apply.
    const channel = conversation.channel as 'sms' | 'mms' | 'whatsapp' | 'web_chat';

    // An internal note is a conversation artefact, never a channel send: it is allowed even while the
    // channel is unavailable, and it never reaches an adapter (the owner guarantees that structurally).
    if (input.isInternalNote !== true) {
      const catalog = await this.capabilities.catalog();
      const row = catalog.channels.find((entry) => entry.channel === channel);
      if (row === undefined || !row.enabled || !row.configured || !row.outbound) {
        throw new ValidationError('This channel cannot send right now.', {
          refusals: ['channel_unavailable'],
          channel,
        });
      }
      if ((input.mediaAttachmentIds ?? []).length > 0 && !row.media) {
        // Contract §9/E3: an undeclared capability is an explicit refusal, never a silent drop.
        throw new ValidationError('This channel does not support attachments.', {
          refusals: ['unsupported'],
          channel,
        });
      }
    }

    return this.messaging.send({
      channel,
      conversationId: conversation.id,
      accountKey: conversation.account_key,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
      ...(input.templateLanguage === undefined ? {} : { templateLanguage: input.templateLanguage }),
      ...(input.templateVariables === undefined ? {} : { templateVariables: input.templateVariables }),
      ...(input.mediaAttachmentIds === undefined ? {} : { mediaAttachmentIds: input.mediaAttachmentIds }),
      ...(input.isInternalNote === undefined ? {} : { isInternalNote: input.isInternalNote }),
    });
  }

  /** E7 — reconcile via the owner's provider lookup; the facade adds no behaviour of its own. */
  async reconcile(messageId: string): Promise<{ readonly message: MessageView; readonly changed: boolean; readonly providerStatus: string | null }> {
    return this.messaging.reconcileMessage(messageId);
  }

  private async enrich(rows: readonly InboxConversationView[]): Promise<readonly OmnichannelConversationView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const workspace = new Map<string, WorkspaceRow>();
    for (const row of (await sql<WorkspaceRow>`
      select id, priority, category, language, tags, current_queue_id, assignment_version,
             snoozed_until, closed_at, last_message_at, version
      from voice_conversations where id in (${sql.join(ids.map((id) => sql.val(id)))})
    `.execute(this.database.db)).rows) {
      workspace.set(row.id, row);
    }
    const threads = await this.threadsFor(ids);
    const customers = new Map<string, CustomerRow>();
    for (const row of (await sql<CustomerRow>`
      select conversation_id, address, display_name from voice_conversation_participants
      where conversation_id in (${sql.join(ids.map((id) => sql.val(id)))})
        and role = 'customer'
      order by created_at asc
    `.execute(this.database.db)).rows) {
      if (!customers.has(row.conversation_id)) customers.set(row.conversation_id, row);
    }
    return rows.map((row) => {
      const extra = workspace.get(row.id);
      const customer = customers.get(row.id);
      return {
        ...row,
        customerAddress: customer?.address ?? null,
        customerName: customer?.display_name ?? null,
        ...(extra === undefined ? emptyWorkspaceFields() : toWorkspaceFields(extra)),
        threads: threads.get(row.id) ?? [],
      };
    });
  }

  private async threadsFor(ids: readonly string[]): Promise<Map<string, OmnichannelThreadView[]>> {
    const map = new Map<string, OmnichannelThreadView[]>();
    if (ids.length === 0) return map;
    const rows = (await sql<{
      id: string;
      conversation_id: string;
      channel: string;
      external_thread_id: string | null;
      address: string | null;
      provider_identity: string | null;
      created_at: Date;
    }>`
      select id, conversation_id, channel, external_thread_id, address, provider_identity, created_at
      from voice_conversation_threads
      where conversation_id in (${sql.join(ids.map((id) => sql.val(id)))})
      order by created_at asc
    `.execute(this.database.db)).rows;
    for (const row of rows) {
      const list = map.get(row.conversation_id) ?? [];
      list.push({
        id: row.id,
        channel: row.channel,
        externalThreadId: row.external_thread_id,
        address: row.address,
        providerIdentity: row.provider_identity,
        createdAt: new Date(row.created_at).toISOString(),
      });
      map.set(row.conversation_id, list);
    }
    return map;
  }
}

type WorkspaceOnly = Omit<OmnichannelConversationView, keyof InboxConversationView | 'threads' | 'customerAddress' | 'customerName'>;

function toWorkspaceFields(row: WorkspaceRow): WorkspaceOnly {
  return {
    priority: row.priority,
    category: row.category,
    language: row.language,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    currentQueueId: row.current_queue_id,
    assignmentVersion: row.assignment_version,
    snoozedUntil: row.snoozed_until === null ? null : new Date(row.snoozed_until).toISOString(),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
    lastMessageAt: row.last_message_at === null ? null : new Date(row.last_message_at).toISOString(),
    version: row.version,
  };
}

function emptyWorkspaceFields(): WorkspaceOnly {
  return {
    priority: 'normal',
    category: null,
    language: null,
    tags: [],
    currentQueueId: null,
    assignmentVersion: 1,
    snoozedUntil: null,
    closedAt: null,
    lastMessageAt: null,
    version: 1,
  };
}
