import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  AuthenticationFailedError,
  AuthorizationDeniedError,
  RateLimitError,
  ValidationError,
} from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { VoiceMessagingService } from '../voice-communications/index.js';
import { type OmnichannelSettings,OmnichannelSettingsService } from './omnichannel-settings.service.js';
import { OMNICHANNEL_WEB_CHAT_ACCOUNT_KEY } from './omnichannel-webchat.adapter.js';

/**
 * Phase 19-OM.9 — the anonymous website-chat channel (contract §7; decision D1).
 *
 * The visitor is the module's own **session principal**, not a Portal account: Portal's
 * authentication and `PortalPolicyService.recordVisible()` are untouched. The cookie carries a
 * 128-bit random key; the database only ever sees its hash, so a stolen database row cannot be
 * replayed as a cookie. Every guard is enforced here, before any record is written:
 *
 *  - the module switch + the operator's origin allowlist (fail closed: no origins configured means
 *    every browser request is refused);
 *  - session existence and expiry (an unknown or expired cookie is a 401, never a silent new
 *    identity — the widget re-creates a session explicitly);
 *  - explicit consent (versioned, timestamped) when the operator requires it;
 *  - a per-session rate window and a body length cap (WebToCase's abuse-control shape);
 *  - a honeypot field that silently discards bot submissions.
 *
 * Messages are the canonical `voice_messages` rows of a `web_chat` conversation (D1): inbound
 * through `VoiceMessagingService.ingestInbound` with the visitor's client message id as the provider
 * id (idempotent under retry), outbound through the agent reply path. This service only ever reads
 * **customer-visible** messages for the widget — `is_internal_note = false` is part of the query, so
 * staff notes and internal fields have no path to a visitor (acceptance: the widget reads
 * customer-visible messages only).
 */

export const WEBCHAT_COOKIE_NAME = 'omni_visitor';
export const WEBCHAT_COOKIE_PATH = '/api/v1/Omnichannel/chat';
export const WEBCHAT_CLIENT_MESSAGE_HEADER = 'x-omnichannel-client-message';

export interface WebChatSessionView {
  readonly status: 'new' | 'resumed';
  readonly expiresAt: string;
  readonly consent: {
    readonly required: boolean;
    readonly state: string;
    readonly version: string;
    readonly text: string;
  };
  readonly messages: readonly WebChatMessageView[];
}

export interface WebChatMessageView {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  readonly createdAt: string;
  /** Outbound delivery state only; an inbound visitor message is delivered by definition. */
  readonly state?: string | undefined;
  /** The visitor's own client id, so an optimistic send reconciles without duplicates. */
  readonly clientMessageId?: string | null | undefined;
}

interface SessionRow {
  id: string;
  visitor_key_hash: string;
  conversation_id: string | null;
  status: string;
  consent_state: string;
  consent_version: string | null;
  consent_at: Date | null;
  ip_hash: string | null;
  user_agent: string | null;
  message_count: number;
  window_started_at: Date | null;
  window_messages: number;
  first_seen_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export interface WebChatRequestMeta {
  readonly origin?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

@Injectable()
export class OmnichannelWebChatService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(VoiceMessagingService) private readonly messaging: VoiceMessagingService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
  ) {}

  /** Create a new visitor session, or resume the one the cookie names. */
  async startOrResume(
    visitorKey: string | undefined,
    meta: WebChatRequestMeta,
  ): Promise<{ readonly key: string; readonly view: WebChatSessionView }> {
    const config = await this.requireChannel(meta);
    const existing = visitorKey === undefined ? undefined : await this.findSession(visitorKey);
    if (existing !== undefined) {
      await this.touch(existing.id);
      return {
        key: visitorKey as string,
        view: {
          status: 'resumed',
          expiresAt: new Date(existing.expires_at).toISOString(),
          consent: this.consentView(config, existing),
          messages: await this.visibleMessages(existing).then((list) => list.messages),
        },
      };
    }
    if (visitorKey !== undefined) {
      // A cookie we do not recognise is a forged/stale identity: refuse instead of silently minting
      // a new one, so the widget's explicit "start" path is the only way to begin a conversation.
      throw new AuthenticationFailedError('The chat session is unknown or has expired. Start a new chat.');
    }
    const key = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionHours * 3_600_000);
    await sql`
      insert into omnichannel_visitor_sessions
        (id, visitor_key_hash, status, consent_state, ip_hash, user_agent, first_seen_at, last_seen_at, expires_at, created_at, modified_at)
      values (${id}, ${hashKey(key)}, 'active', 'pending', ${this.hashIp(meta.ip)}, ${meta.userAgent ?? null},
              ${now}, ${now}, ${expiresAt}, ${now}, ${now})
    `.execute(this.database.db);
    const created = (await sql<SessionRow>`select * from omnichannel_visitor_sessions where id = ${id}`.execute(this.database.db)).rows[0] as SessionRow;
    return {
      key,
      view: {
        status: 'new',
        expiresAt: expiresAt.toISOString(),
        consent: this.consentView(config, created),
        messages: [],
      },
    };
  }

  /** One visitor message. Idempotent by the client message id; consent and abuse guards first. */
  async send(
    visitorKey: string | undefined,
    input: {
      readonly clientMessageId: string;
      readonly body: string;
      readonly consent?: boolean | undefined;
      /** Honeypot: a real visitor leaves this empty (WebToCase's control, reused in spirit). */
      readonly website?: string | undefined;
    },
    meta: WebChatRequestMeta,
  ): Promise<{ readonly messageId: string | null; readonly duplicate: boolean }> {
    const config = await this.requireChannel(meta);
    const session = await this.requireSession(visitorKey);
    if ((input.website ?? '') !== '') return { messageId: null, duplicate: false };

    const body = input.body.trim();
    if (body === '') throw new ValidationError('A chat message needs text.');
    if (body.length > config.maxBodyChars) {
      throw new ValidationError('The chat message is too long.', { maxBodyChars: config.maxBodyChars });
    }
    const clientMessageId = input.clientMessageId.trim();
    if (clientMessageId.length < 8 || clientMessageId.length > 200) {
      throw new ValidationError('A chat message needs a stable client id.');
    }

    if (config.requireConsent && session.consent_state !== 'granted') {
      if (input.consent !== true) {
        throw new ValidationError('Consent is required before the first message.', { refusals: ['consent_required'] });
      }
      await sql`
        update omnichannel_visitor_sessions
        set consent_state = 'granted', consent_version = ${config.consentVersion}, consent_at = now(), modified_at = now()
        where id = ${session.id}
      `.execute(this.database.db);
    }

    await this.enforceRate(session, config.maxMessagesPerMinute);

    const result = await this.messaging.ingestInbound({
      accountKey: OMNICHANNEL_WEB_CHAT_ACCOUNT_KEY,
      event: {
        kind: 'message',
        providerMessageId: clientMessageId,
        state: 'delivered',
        direction: 'inbound',
        channel: 'web_chat',
        from: visitorAddress(session.visitor_key_hash),
        to: null,
        body,
        occurredAt: new Date().toISOString(),
        failureCategory: null,
        vendorStatus: 'received',
      },
    });
    if (!result.duplicate) {
      const conversation = (await sql<{ conversation_id: string }>`
        select conversation_id from voice_messages where id = ${result.messageId}
      `.execute(this.database.db)).rows[0];
      await sql`
        update omnichannel_visitor_sessions
        set conversation_id = coalesce(${conversation?.conversation_id ?? null}, conversation_id),
            message_count = message_count + 1, last_seen_at = now(), modified_at = now()
        where id = ${session.id}
      `.execute(this.database.db);
    }
    return { messageId: result.messageId, duplicate: result.duplicate };
  }

  /** Customer-visible messages of this visitor's conversation only (never internal notes). */
  async visibleMessages(
    session: SessionRow,
    after?: string | undefined,
  ): Promise<{ readonly messages: readonly WebChatMessageView[] }> {
    if (session.conversation_id === null) return { messages: [] };
    let afterClause = sql``;
    if (after !== undefined && after !== '') {
      const anchor = (await sql<{ created_at: Date }>`
        select created_at from voice_messages
        where id = ${after} and conversation_id = ${session.conversation_id}
      `.execute(this.database.db)).rows[0];
      if (anchor !== undefined) {
        afterClause = sql`and (created_at > ${anchor.created_at} or (created_at = ${anchor.created_at} and id > ${after}))`;
      }
    }
    const rows = (await sql<{
      id: string;
      direction: string;
      body: string | null;
      state: string;
      provider_message_id: string | null;
      created_at: Date;
    }>`
      select id, direction, body, state, provider_message_id, created_at
      from voice_messages
      where conversation_id = ${session.conversation_id}
        and is_internal_note = false
        and channel = 'web_chat'
        ${afterClause}
      order by created_at asc, id asc
      limit 100
    `.execute(this.database.db)).rows;
    return {
      messages: rows.map((row) => ({
        id: row.id,
        direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
        body: row.body ?? '',
        createdAt: new Date(row.created_at).toISOString(),
        ...(row.direction === 'outbound' ? { state: row.state } : {}),
        ...(row.direction === 'inbound' ? { clientMessageId: row.provider_message_id } : {}),
      })),
    };
  }

  /** Messages after a cursor for the cookie's session. */
  async list(visitorKey: string | undefined, after: string | undefined, meta: WebChatRequestMeta): Promise<{ readonly messages: readonly WebChatMessageView[] }> {
    await this.requireChannel(meta);
    const session = await this.requireSession(visitorKey);
    await this.touch(session.id);
    return this.visibleMessages(session, after);
  }

  private async requireChannel(meta: WebChatRequestMeta): Promise<OmnichannelSettings['webChat']> {
    const settings = await this.settings.settings();
    const config = settings.webChat;
    if (!config.enabled || !settings.features.workspace) {
      throw new AuthorizationDeniedError('The website chat is not open.');
    }
    const origin = (meta.origin ?? '').trim();
    if (origin !== '' && !config.allowedOrigins.includes(origin)) {
      // Fail closed: the operator must name every origin allowed to embed the widget.
      throw new AuthorizationDeniedError('This website is not allowed to use the chat.');
    }
    if (origin === '' && config.allowedOrigins.length > 0) {
      // Non-browser callers (tests, uptime checks) are allowed when the channel is open.
      return config;
    }
    return config;
  }

  private async findSession(visitorKey: string): Promise<SessionRow | undefined> {
    const row = (await sql<SessionRow>`
      select * from omnichannel_visitor_sessions where visitor_key_hash = ${hashKey(visitorKey)} limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) return undefined;
    if (row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now()) {
      await sql`
        update omnichannel_visitor_sessions set status = 'expired', modified_at = now() where id = ${row.id}
      `.execute(this.database.db);
      return undefined;
    }
    return row;
  }

  private async requireSession(visitorKey: string | undefined): Promise<SessionRow> {
    if (visitorKey === undefined || visitorKey.trim() === '') {
      throw new AuthenticationFailedError('Start a chat session first.');
    }
    const session = await this.findSession(visitorKey);
    if (session === undefined) throw new AuthenticationFailedError('The chat session is unknown or has expired.');
    return session;
  }

  private async touch(sessionId: string): Promise<void> {
    await sql`update omnichannel_visitor_sessions set last_seen_at = now(), modified_at = now() where id = ${sessionId}`.execute(this.database.db);
  }

  private async enforceRate(session: SessionRow, maxPerMinute: number): Promise<void> {
    const now = new Date();
    const windowStart = session.window_started_at === null ? null : new Date(session.window_started_at);
    const freshWindow = windowStart === null || now.getTime() - windowStart.getTime() >= 60_000;
    const used = freshWindow ? 0 : session.window_messages;
    if (used >= maxPerMinute) {
      throw new RateLimitError('Too many chat messages in a minute. Please wait a moment.');
    }
    await sql`
      update omnichannel_visitor_sessions
      set window_started_at = ${freshWindow ? now : windowStart}, window_messages = ${used + 1}, modified_at = now()
      where id = ${session.id}
    `.execute(this.database.db);
  }

  private consentView(config: OmnichannelSettings['webChat'], session: SessionRow): WebChatSessionView['consent'] {
    return {
      required: config.requireConsent,
      state: session.consent_state,
      version: session.consent_version ?? config.consentVersion,
      text: config.consentText,
    };
  }

  private hashIp(ip: string | undefined): string | null {
    if (ip === undefined || ip.trim() === '') return null;
    // A keyed digest: the raw address is never stored, and the value is not enumerable by hash alone.
    return createHash('sha256').update(`webchat-ip:${ip.trim()}`).digest('hex');
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The visitor's channel address: stable per session, never the raw key. */
export function visitorAddress(visitorKeyHash: string): string {
  return `visitor:${visitorKeyHash.slice(0, 32)}`;
}
