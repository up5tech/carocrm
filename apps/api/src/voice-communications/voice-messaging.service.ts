import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { PHONE_NORMALIZER, type PhoneNormalizer } from './phone-number.js';
import {
  advanceMessageState,
  type MessageChannel,
  type MessageState,
  sendCapabilityFor,
} from './voice-communications-domain.js';
import { VoiceCommunicationsSettingsService } from './voice-communications-settings.service.js';
import { VoicePolicyService } from './voice-policy.service.js';
import {
  effectiveCapabilities,
  type NormalizedMessageEvent,
  VoiceProviderError,
  VoiceProviderRegistry,
} from './voice-provider.js';
import { VoiceProviderAccountsService } from './voice-provider-accounts.service.js';

/** 19-OM.6 (E7) — states a provider lookup can no longer advance; only non-terminal ones are polled. */
const TERMINAL_MESSAGE_STATES: ReadonlySet<string> = new Set(['read', 'failed', 'undelivered']);

/**
 * Phase 19-VC.10 — SMS/MMS (and WhatsApp through the same gateway)
 * (`PLAN_Phase_19_Voice_Communications.md` §8.1–§8.3, §15 `19-VC.10`).
 *
 * The durable send path is: policy → message row (`queued`, with an idempotency key) → a second
 * policy check at dispatch time → adapter → `sent`/`failed`. The message row exists before the
 * provider is called, so a worker restart or a provider timeout leaves an inspectable attempt
 * instead of a lost message (§8.1).
 *
 * Two invariants are structural:
 *  - **No inferred delivery.** An accepted send becomes `sent`, never `delivered`; only a callback
 *    moves it further, and `advanceMessageState` refuses to regress it (§8.1, §15 acceptance).
 *  - **Internal notes never leave.** They are written with `is_internal_note = true` and the table's
 *    check constraint forbids them from carrying a provider message id.
 *
 * Media: an attachment id is validated and recorded as a `voice_media` reference. Fetching provider
 * media into private storage and scanning it is 19-VC.15; nothing here downloads a URL.
 */

/** The synthetic permission the message surface checks until the inbox registers an entity (VC.12). */
export const MESSAGE_PERMISSION_ENTITY = 'CommunicationMessage';

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly channel: MessageChannel;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string | null;
  readonly state: MessageState;
  readonly providerMessageId: string | null;
  readonly isInternalNote: boolean;
  readonly templateKey: string | null;
  readonly failureCategory: string | null;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface ConversationView {
  readonly id: string;
  readonly accountKey: string;
  readonly channel: MessageChannel;
  readonly status: string;
  readonly subject: string | null;
  readonly unreadCount: number;
  readonly lastActivityAt: string | null;
  readonly lastInboundAt: string | null;
  readonly assignedUserId: string | null;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly caseId: string | null;
  readonly createdAt: string;
}

export interface SendMessageInput {
  readonly channel: MessageChannel;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly accountKey?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly to?: string | undefined;
  readonly purpose?: string | undefined;
  readonly mediaAttachmentIds?: readonly string[] | undefined;
  readonly templateKey?: string | undefined;
  readonly templateLanguage?: string | undefined;
  readonly templateVariables?: Readonly<Record<string, string>> | undefined;
  readonly isInternalNote?: boolean | undefined;
}

interface ConversationRow {
  id: string;
  account_key: string;
  channel: string;
  external_thread_id: string | null;
  status: string;
  subject: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  unread_count: number;
  last_activity_at: Date | null;
  last_inbound_at: Date | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  case_id: string | null;
  created_at: Date;
  modified_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  account_key: string;
  channel: string;
  direction: string;
  body: string | null;
  provider_message_id: string | null;
  state: string;
  is_internal_note: boolean;
  template_key: string | null;
  failure_category: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

@Injectable()
export class VoiceMessagingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(VoicePolicyService) private readonly policy: VoicePolicyService,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  /**
   * Send one message (§8.1). The policy is evaluated twice on purpose: once to decide whether the
   * attempt may be recorded, and once immediately before the adapter call, because consent can be
   * revoked between those two moments (§8.4 "recheck eligibility immediately before dispatch").
   */
  async send(input: SendMessageInput): Promise<{ readonly message: MessageView; readonly duplicate: boolean }> {
    await this.acl.assertAccess(MESSAGE_PERMISSION_ENTITY, 'create');
    const settings = await this.settings.settings();
    const accountKey = (input.accountKey ?? settings.provider.defaultAccountKey).trim();
    if (accountKey === '') throw new ValidationError('No provider account is configured for messaging.');

    const conversation = await this.resolveConversation(input, accountKey);
    const to = conversation.external_thread_id ?? '';
    if (to === '') throw new ValidationError('The conversation has no destination address.');
    // E6: an outbound customer message belongs to the thread its destination address identifies.
    const threadId = await this.attachThread(conversation.id, accountKey, input.channel, to);

    const body = input.body.trim();
    if (body === '' && (input.templateKey ?? '').trim() === '' && (input.mediaAttachmentIds ?? []).length === 0) {
      throw new ValidationError('A message needs text, a template or media.');
    }

    // Duplicate key: return the message it created, never a second send.
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) return { message: toMessageView(existing), duplicate: true };

    if (input.isInternalNote === true) {
      // An internal note is a conversation artefact: it is stored and never handed to an adapter.
      const note = await this.insertMessage({
        conversationId: conversation.id,
        accountKey,
        channel: input.channel,
        direction: 'outbound',
        body,
        state: 'draft',
        providerMessageId: null,
        idempotencyKey: input.idempotencyKey,
        isInternalNote: true,
        templateKey: null,
        threadId: null,
      });
      return { message: toMessageView(note), duplicate: false };
    }

    const evaluation = await this.policy.evaluate({
      channel: input.channel,
      address: to,
      accountKey,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      messageLength: body.length,
      ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
      ...(input.templateLanguage !== undefined ? { templateLanguage: input.templateLanguage } : {}),
      ...(input.templateVariables !== undefined ? { templateVariables: input.templateVariables } : {}),
    });
    if (!evaluation.allowed) {
      throw new ValidationError('This message is not permitted.', { refusals: evaluation.refusals.map((r) => r.code) });
    }

    const account = await this.accounts.resolve(accountKey);
    const adapter = this.registry.resolve(account.providerKey);
    const capability = sendCapabilityFor(input.channel);
    if (capability === null || !effectiveCapabilities(adapter.info, account.capabilities).includes(capability)) {
      throw new ValidationError(`Provider "${account.providerKey}" does not declare ${capability ?? 'this channel'}.`);
    }
    if (adapter.sendMessage === undefined) throw new ValidationError('This provider adapter cannot send messages.');
    // The account's active endpoint is the sender. A provider that needs a From address (Twilio)
    // receives the registered number; a provider that does not (the simulator) can ignore it.
    const fromAddress = await this.findSender(accountKey, input.channel);

    const message = await this.insertMessage({
      conversationId: conversation.id,
      accountKey,
      channel: input.channel,
      direction: 'outbound',
      body,
      state: 'queued',
      providerMessageId: null,
      idempotencyKey: input.idempotencyKey,
      isInternalNote: false,
      templateKey: input.templateKey ?? null,
      threadId,
    });
    const media = await this.recordMedia(message.id, input.mediaAttachmentIds ?? []);

    // Recheck immediately before dispatch; a revoked consent must cancel a queued message.
    const dispatchCheck = await this.policy.evaluate({
      channel: input.channel,
      address: to,
      accountKey,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      messageLength: body.length,
      ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
      ...(input.templateLanguage !== undefined ? { templateLanguage: input.templateLanguage } : {}),
      ...(input.templateVariables !== undefined ? { templateVariables: input.templateVariables } : {}),
    });
    if (!dispatchCheck.allowed) {
      const failed = await this.patchMessage(message.id, {
        state: 'failed',
        failureCategory: 'consent_required',
        failedAt: new Date(),
      });
      return { message: toMessageView(failed), duplicate: false };
    }

    try {
      const result = await adapter.sendMessage({
        account,
        conversationId: conversation.id,
        messageId: message.id,
        to,
        body,
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        ...(fromAddress !== null ? { fromAddress } : {}),
        ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
        ...(input.templateLanguage !== undefined ? { templateLanguage: input.templateLanguage } : {}),
        ...(input.templateVariables !== undefined ? { templateVariables: input.templateVariables } : {}),
        ...(media.length > 0 ? { media } : {}),
      });
      const stored = await this.patchMessage(message.id, {
        state: result.accepted ? result.state : 'failed',
        providerMessageId: result.providerMessageId,
        sentAt: result.accepted ? new Date() : null,
        failureCategory: result.accepted ? null : (result.errorCategory ?? 'unknown'),
        failedAt: result.accepted ? null : new Date(),
      });
      await this.touchConversation(conversation.id);
      return { message: toMessageView(stored), duplicate: false };
    } catch (error) {
      const category = error instanceof VoiceProviderError ? error.category : 'unknown';
      const failed = await this.patchMessage(message.id, {
        state: 'failed',
        failureCategory: category,
        failedAt: new Date(),
      });
      return { message: toMessageView(failed), duplicate: false };
    }
  }

  /**
   * Inbound message (§8.1). One provider message id yields one row: the unique index on
   * `(account_key, provider_message_id)` is what refuses a replayed callback, not a check-then-insert.
   *
   * 19-OM.6 (E6): the message is attached to its **channel thread** (contract §4), and the
   * conversation is found through the thread or the continuity rule — never by merging everything a
   * Contact ever said.
   */
  async ingestInbound(input: { readonly accountKey: string; readonly event: NormalizedMessageEvent }): Promise<{ readonly messageId: string; readonly duplicate: boolean }> {
    const event = input.event;
    const from = event.from ?? '';
    if (from === '') throw new ValidationError('An inbound message has no sender address.');
    const occurredAt = event.occurredAt === null ? new Date() : new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new ValidationError('The inbound message has an invalid timestamp.');
    const conversation = await this.findOrCreateConversation(input.accountKey, event.channel, from);
    const threadId = await this.attachThread(conversation.id, input.accountKey, event.channel, from);
    const now = new Date();
    const id = randomUUID();

    const inserted = (await sql<{ id: string }>`
      insert into voice_messages
        (id, conversation_id, thread_id, account_key, channel, direction, body, provider_message_id, state,
         is_internal_note, occurred_at, created_at, modified_at)
      values
        (${id}, ${conversation.id}, ${threadId}, ${input.accountKey}, ${event.channel}, 'inbound', ${event.body},
         ${event.providerMessageId}, 'delivered', false, ${occurredAt}, ${now}, ${now})
      on conflict (account_key, provider_message_id) where provider_message_id is not null do nothing
      returning id
    `.execute(this.database.db)).rows[0];
    if (inserted === undefined) {
      const existing = (await sql<{ id: string }>`
        select id from voice_messages
        where account_key = ${input.accountKey} and provider_message_id = ${event.providerMessageId}
      `.execute(this.database.db)).rows[0];
      return { messageId: existing?.id ?? '', duplicate: true };
    }

    await this.upsertParticipant(conversation.id, from, 'customer', input.accountKey, event.channel);
    await sql`
      update voice_conversations
      set unread_count = unread_count + 1,
          last_activity_at = ${occurredAt},
          last_message_at = ${occurredAt},
          last_inbound_at = ${occurredAt},
          status = case when status = 'resolved' then 'open' else status end,
          modified_at = now()
      where id = ${conversation.id}
    `.execute(this.database.db);
    return { messageId: id, duplicate: false };
  }

  /** Delivery status for an outbound message (§8.1). Unknown provider ids are ignored, not invented. */
  async applyStatus(input: {
    readonly accountKey: string;
    readonly providerMessageId: string;
    readonly state: MessageState;
    readonly occurredAt: string | null;
    readonly failureCategory: string | null;
  }): Promise<{ readonly changed: boolean; readonly messageId: string | null }> {
    const row = (await sql<MessageRow>`
      select * from voice_messages
      where account_key = ${input.accountKey} and provider_message_id = ${input.providerMessageId}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) return { changed: false, messageId: null };

    const current = row.state as MessageState;
    const next = advanceMessageState(current, input.state);
    if (next === current) return { changed: false, messageId: row.id };
    const at = input.occurredAt === null ? new Date() : new Date(input.occurredAt);
    await sql`
      update voice_messages
      set state = ${next},
          delivered_at = ${next === 'delivered' || next === 'read' ? at : row.delivered_at},
          failed_at = ${next === 'failed' || next === 'undelivered' ? at : null},
          failure_category = ${input.failureCategory},
          modified_at = now()
      where id = ${row.id}
    `.execute(this.database.db);
    return { changed: true, messageId: row.id };
  }

  /**
   * 19-OM.6 (extension E7) — reconcile a message whose delivery outcome is unknown, by asking the
   * provider for the message resource instead of repeating the send (§3.5).
   *
   * Only a message the provider actually accepted can be reconciled; an adapter without a status
   * lookup is an explicit `unsupported` refusal (never a guess), and the state advances through the
   * same rank guard as a webhook, so reconciliation cannot move a message backwards.
   */
  async reconcileMessage(messageId: string): Promise<{
    readonly message: MessageView;
    readonly changed: boolean;
    readonly providerStatus: string | null;
  }> {
    await this.acl.assertAccess(MESSAGE_PERMISSION_ENTITY, 'edit');
    const row = (await sql<MessageRow>`select * from voice_messages where id = ${messageId}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Message "${messageId}" does not exist.`);
    if (row.direction !== 'outbound' || row.is_internal_note) {
      throw new ValidationError('Only an outbound customer message can be reconciled.');
    }
    if (row.provider_message_id === null) {
      throw new ValidationError('The message has no provider id; the provider never accepted it.');
    }
    if (TERMINAL_MESSAGE_STATES.has(row.state)) {
      return { message: toMessageView(row), changed: false, providerStatus: null };
    }
    const account = await this.accounts.resolve(row.account_key);
    const adapter = this.registry.resolve(account.providerKey);
    if (
      adapter.getMessageStatus === undefined ||
      !effectiveCapabilities(adapter.info, account.capabilities).includes('messaging.deliveryStatus')
    ) {
      throw new VoiceProviderError(
        'unsupported',
        `Provider "${account.providerKey}" offers no message-status lookup, so this outcome cannot be reconciled.`,
      );
    }
    const lookup = await adapter.getMessageStatus({ account, providerMessageId: row.provider_message_id });
    if (lookup.state === null) {
      return { message: toMessageView(row), changed: false, providerStatus: lookup.vendorStatus };
    }
    const applied = await this.applyStatus({
      accountKey: row.account_key,
      providerMessageId: row.provider_message_id,
      state: lookup.state,
      occurredAt: new Date().toISOString(),
      failureCategory: null,
    });
    const fresh = (await sql<MessageRow>`select * from voice_messages where id = ${messageId}`.execute(this.database.db)).rows[0];
    return { message: toMessageView(fresh ?? row), changed: applied.changed, providerStatus: lookup.vendorStatus };
  }

  async listConversations(query: { readonly limit: number; readonly offset: number }): Promise<readonly ConversationView[]> {
    await this.acl.assertAccess(MESSAGE_PERMISSION_ENTITY, 'read');
    const rows = await sql<ConversationRow>`
      select * from voice_conversations order by last_activity_at desc nulls last, created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    return rows.rows.map(toConversationView);
  }

  async getConversation(id: string): Promise<{ readonly conversation: ConversationView; readonly messages: readonly MessageView[] }> {
    await this.acl.assertAccess(MESSAGE_PERMISSION_ENTITY, 'read');
    const conversation = (await sql<ConversationRow>`select * from voice_conversations where id = ${id}`.execute(this.database.db)).rows[0];
    if (conversation === undefined) throw new NotFoundError(`Conversation "${id}" does not exist.`);
    const messages = await sql<MessageRow>`
      select * from voice_messages where conversation_id = ${id} order by created_at asc limit 200
    `.execute(this.database.db);
    return { conversation: toConversationView(conversation), messages: messages.rows.map(toMessageView) };
  }

  // ------------------------------------------------------------------------- internals

  private async findSender(accountKey: string, channel: MessageChannel): Promise<string | null> {
    const row = (await sql<{ address: string }>`
      select address from voice_endpoints
      where account_key = ${accountKey} and channel = ${channel} and active = true
      order by created_at asc limit 1
    `.execute(this.database.db)).rows[0];
    return row?.address ?? null;
  }

  private async resolveConversation(input: SendMessageInput, accountKey: string): Promise<ConversationRow> {
    if (input.conversationId !== undefined) {
      const row = (await sql<ConversationRow>`
        select * from voice_conversations where id = ${input.conversationId}
      `.execute(this.database.db)).rows[0];
      if (row === undefined) throw new NotFoundError(`Conversation "${input.conversationId}" does not exist.`);
      if (row.account_key !== accountKey) throw new ValidationError('The conversation belongs to another provider account.');
      if (row.channel !== input.channel) throw new ValidationError('The conversation belongs to another channel.');
      return row;
    }
    if (input.to === undefined || input.to.trim() === '') {
      throw new ValidationError('A message needs a conversation or a destination address.');
    }
    const settings = await this.settings.settings();
    const normalized = this.phones.normalize(input.to, settings.policy.defaultRegion);
    if (!normalized.valid || normalized.e164 === null) throw new ValidationError('The destination address is not valid.');
    return this.findOrCreateConversation(accountKey, input.channel, normalized.e164);
  }

  private async findOrCreateConversation(accountKey: string, channel: MessageChannel, address: string): Promise<ConversationRow> {
    // E6: a channel thread is resolved first — the thread knows its canonical conversation, so a
    // provider thread can never spawn a second conversation once attached.
    const thread = await this.findThread(accountKey, channel, address);
    if (thread !== null) {
      const byThread = (await sql<ConversationRow>`
        select * from voice_conversations where id = ${thread.conversation_id} limit 1
      `.execute(this.database.db)).rows[0];
      if (byThread !== undefined) return byThread;
    }

    const existing = (await sql<ConversationRow>`
      select * from voice_conversations
      where account_key = ${accountKey} and channel = ${channel} and external_thread_id = ${address}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (existing !== undefined) {
      await this.attachThread(existing.id, accountKey, channel, address);
      return existing;
    }

    // Contract §4 continuity — the same normalized customer address on another channel attaches a
    // new thread to the open conversation instead of opening a second one. Closed/spam conversations
    // are not reopened implicitly, and nothing is merged by Contact — the rule is address equality.
    const continuous = (await sql<ConversationRow>`
      select c.* from voice_conversations c
      join voice_conversation_participants p on p.conversation_id = c.id
      where c.account_key = ${accountKey}
        and c.channel <> ${channel}
        and c.status not in ('closed', 'spam')
        and p.role = 'customer'
        and p.address = ${address}
      order by c.last_activity_at desc nulls last
      limit 1
    `.execute(this.database.db)).rows[0];
    if (continuous !== undefined) {
      await this.attachThread(continuous.id, accountKey, channel, address);
      return continuous;
    }

    const id = randomUUID();
    const now = new Date();
    await sql`
      insert into voice_conversations
        (id, account_key, channel, external_thread_id, status, unread_count, last_activity_at, created_at, modified_at)
      values (${id}, ${accountKey}, ${channel}, ${address}, 'open', 0, ${now}, ${now}, ${now})
      on conflict (account_key, channel, external_thread_id) where external_thread_id is not null do nothing
    `.execute(this.database.db);
    const row = (await sql<ConversationRow>`
      select * from voice_conversations
      where account_key = ${accountKey} and channel = ${channel} and external_thread_id = ${address}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError('The conversation could not be created.');
    await this.upsertParticipant(row.id, address, 'customer', accountKey, channel);
    await this.attachThread(row.id, accountKey, channel, address);
    return row;
  }

  /** The thread for this address on this channel, if one was already attached (E6). */
  private async findThread(accountKey: string, channel: MessageChannel, address: string): Promise<{ readonly id: string; readonly conversation_id: string } | null> {
    const row = (await sql<{ id: string; conversation_id: string }>`
      select id, conversation_id from voice_conversation_threads
      where account_key = ${accountKey} and channel = ${channel} and address = ${address}
      limit 1
    `.execute(this.database.db)).rows[0];
    return row ?? null;
  }

  /**
   * Attach a provider thread to a conversation (E6/contract §4). The partial unique indexes are the
   * concurrency guard: a racing callback selects the row the other transaction inserted instead of
   * creating a second thread.
   */
  private async attachThread(conversationId: string, accountKey: string, channel: MessageChannel, address: string): Promise<string> {
    const inserted = (await sql<{ id: string }>`
      insert into voice_conversation_threads (id, conversation_id, account_key, channel, address, created_at, modified_at)
      values (${`vct_${randomUUID()}`}, ${conversationId}, ${accountKey}, ${channel}, ${address}, now(), now())
      on conflict do nothing
      returning id
    `.execute(this.database.db)).rows[0];
    if (inserted !== undefined) return inserted.id;
    const existing = (await sql<{ id: string }>`
      select id from voice_conversation_threads
      where conversation_id = ${conversationId} and account_key = ${accountKey}
        and channel = ${channel} and address = ${address}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (existing === undefined) throw new NotFoundError('The channel thread could not be attached.');
    return existing.id;
  }

  private async upsertParticipant(
    conversationId: string,
    address: string,
    role: 'customer' | 'agent',
    accountKey: string,
    channel: MessageChannel,
  ): Promise<void> {
    await sql`
      insert into voice_conversation_participants (id, conversation_id, address, role, account_key, channel, created_at)
      values (${randomUUID()}, ${conversationId}, ${address}, ${role}, ${accountKey}, ${channel}, now())
      on conflict (conversation_id, address, role) do nothing
    `.execute(this.database.db);
  }

  private async insertMessage(input: {
    readonly conversationId: string;
    readonly accountKey: string;
    readonly channel: MessageChannel;
    readonly direction: 'inbound' | 'outbound';
    readonly body: string;
    readonly state: MessageState;
    readonly providerMessageId: string | null;
    readonly idempotencyKey: string;
    readonly isInternalNote: boolean;
    readonly templateKey: string | null;
    readonly threadId: string | null;
  }): Promise<MessageRow> {
    const id = randomUUID();
    const now = new Date();
    const inserted = (await sql<{ id: string }>`
      insert into voice_messages
        (id, conversation_id, thread_id, account_key, channel, direction, body, provider_message_id, state,
         is_internal_note, template_key, author_user_id, idempotency_key, occurred_at, created_at, modified_at)
      values
        (${id}, ${input.conversationId}, ${input.threadId}, ${input.accountKey}, ${input.channel}, ${input.direction},
         ${input.body}, ${input.providerMessageId}, ${input.state}, ${input.isInternalNote},
         ${input.templateKey}, ${this.scope.userId ?? null}, ${input.idempotencyKey}, ${now}, ${now}, ${now})
      on conflict (idempotency_key) where idempotency_key is not null do nothing
      returning id
    `.execute(this.database.db)).rows[0];
    if (inserted === undefined) {
      // The key exists: return that message rather than creating a second one.
      const existing = (await sql<MessageRow>`
        select * from voice_messages where idempotency_key = ${input.idempotencyKey} limit 1
      `.execute(this.database.db)).rows[0];
      if (existing !== undefined) return existing;
      throw new NotFoundError('The message could not be recorded.');
    }
    const row = (await sql<MessageRow>`select * from voice_messages where id = ${id}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError('The message could not be read back.');
    return row;
  }

  /** Media references are recorded, never fetched: the attachment id is the storage reference. */
  private async recordMedia(messageId: string, attachmentIds: readonly string[]): Promise<
    readonly { storageRef: string; contentType: string; filename: string; sizeBytes: number | undefined }[]
  > {
    const out: { storageRef: string; contentType: string; filename: string; sizeBytes: number | undefined }[] = [];
    for (const attachmentId of attachmentIds.slice(0, 10)) {
      const row = (await sql<{ id: string; mime_type: string | null; file_name: string | null; size_bytes: number | null }>`
        select id, mime_type, file_name, size_bytes from attachments where id = ${attachmentId}
      `.execute(this.database.db)).rows[0];
      if (row === undefined) throw new ValidationError(`Attachment "${attachmentId}" does not exist.`);
      await sql`
        insert into voice_media (id, message_id, kind, storage_ref, mime_type, size_bytes, scan_status, created_at)
        values (${randomUUID()}, ${messageId}, 'attachment', ${row.id}, ${row.mime_type}, ${row.size_bytes}, 'pending', now())
      `.execute(this.database.db);
      out.push({
        storageRef: row.id,
        contentType: row.mime_type ?? 'application/octet-stream',
        filename: row.file_name ?? row.id,
        sizeBytes: row.size_bytes ?? undefined,
      });
    }
    return out;
  }

  private async findByIdempotencyKey(key: string): Promise<MessageRow | undefined> {
    const trimmed = key.trim();
    if (trimmed === '') return undefined;
    return (await sql<MessageRow>`select * from voice_messages where idempotency_key = ${trimmed} limit 1`.execute(this.database.db)).rows[0];
  }

  private async touchConversation(id: string): Promise<void> {
    await sql`update voice_conversations set last_activity_at = now(), modified_at = now() where id = ${id}`.execute(this.database.db);
  }

  private async patchMessage(
    id: string,
    patch: {
      readonly state?: MessageState | undefined;
      readonly providerMessageId?: string | null | undefined;
      readonly sentAt?: Date | null | undefined;
      readonly deliveredAt?: Date | null | undefined;
      readonly failedAt?: Date | null | undefined;
      readonly failureCategory?: string | null | undefined;
    },
  ): Promise<MessageRow> {
    const assignments = [sql`modified_at = now()`];
    if (patch.state !== undefined) assignments.push(sql`state = ${patch.state}`);
    if (patch.providerMessageId !== undefined) assignments.push(sql`provider_message_id = ${patch.providerMessageId}`);
    if (patch.sentAt !== undefined) assignments.push(sql`sent_at = ${patch.sentAt}`);
    if (patch.deliveredAt !== undefined) assignments.push(sql`delivered_at = ${patch.deliveredAt}`);
    if (patch.failedAt !== undefined) assignments.push(sql`failed_at = ${patch.failedAt}`);
    if (patch.failureCategory !== undefined) assignments.push(sql`failure_category = ${patch.failureCategory}`);
    const combined = assignments.reduce((left, right) => sql`${left}, ${right}`);
    await sql`update voice_messages set ${combined} where id = ${id}`.execute(this.database.db);
    const row = (await sql<MessageRow>`select * from voice_messages where id = ${id}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Message "${id}" does not exist.`);
    return row;
  }
}

function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel as MessageChannel,
    direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
    body: row.body,
    state: row.state as MessageState,
    providerMessageId: row.provider_message_id,
    isInternalNote: row.is_internal_note,
    templateKey: row.template_key,
    failureCategory: row.failure_category,
    sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
    deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    accountKey: row.account_key,
    channel: row.channel as MessageChannel,
    status: row.status,
    subject: row.subject,
    unreadCount: row.unread_count,
    lastActivityAt: row.last_activity_at === null ? null : new Date(row.last_activity_at).toISOString(),
    lastInboundAt: row.last_inbound_at === null ? null : new Date(row.last_inbound_at).toISOString(),
    assignedUserId: row.assigned_user_id,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    caseId: row.case_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
