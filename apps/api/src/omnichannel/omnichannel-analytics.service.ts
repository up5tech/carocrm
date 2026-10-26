import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';

/**
 * Phase 19-OM.20 — conversation analytics over the reused records
 * (plan §14 `19-OM.20`; `docs/omnichannel/analytics.md` defines every metric literally).
 *
 * The generic report/search engine cannot see dedicated tables (D1), so this is the documented
 * **dedicated analytics path**: aggregate SQL over `voice_conversations`, `voice_messages`,
 * `voice_conversation_events`, `voice_webhook_events` and `voice_provider_accounts`.
 *
 * Rules that make a metric defensible:
 *  - **Internal notes never count** as customer messages (`is_internal_note = false` in SQL); drafts
 *    are notes by construction, so they never enter volume or timing metrics.
 *  - **Timestamps are the recorded facts**: message `created_at`, conversation `created_at`,
 *    event `created_at`, receipt `received_at` — never a local submission time standing in for
 *    delivery. `unknown` delivery outcomes are reported separately, never as failures or successes.
 *  - **Honest availability**: a metric with no denominator reports `null` plus `sample: 0` and an
 *    `unavailable` reason (e.g. no provider account ⇒ provider health unavailable), instead of a
 *    misleading zero.
 *  - **No content**: every field is a count, a duration or an identifier grouping; bodies, addresses
 *    and payloads are never returned.
 *  - ACL: `inboxView` + the conversation read ACL gate the call — the same visibility the inbox has
 *    for dedicated tables (entity-level; per-record ACL does not exist for them, recorded in audit G7).
 *    Case SLA metrics stay in ServiceDesk; the timing metrics here describe conversation handling.
 */

export interface OmnichannelAnalytics {
  readonly window: { readonly days: number; readonly from: string; readonly to: string };
  readonly volume: {
    readonly byChannel: readonly { readonly channel: string; readonly inbound: number; readonly outbound: number }[];
    readonly totalInbound: number;
    readonly totalOutbound: number;
  };
  readonly backlog: {
    readonly byStatus: readonly { readonly status: string; readonly count: number }[];
    readonly unassigned: number;
    readonly snoozed: number;
  };
  readonly assignment: readonly { readonly assignee: string; readonly count: number }[];
  readonly firstResponse: { readonly averageMinutes: number | null; readonly sample: number; readonly unavailable?: string | undefined };
  readonly replyDelay: { readonly averageMinutes: number | null; readonly sample: number; readonly unavailable?: string | undefined };
  readonly handoffs: { readonly conversationsWithCase: number };
  readonly reopenRate: { readonly reopened: number; readonly closedInWindow: number; readonly rate: number | null };
  readonly delivery: {
    readonly failed: number;
    readonly undelivered: number;
    readonly unknown: number;
    readonly byCategory: readonly { readonly category: string; readonly count: number }[];
  };
  readonly providerHealth: {
    readonly available: boolean;
    readonly reason?: string | undefined;
    readonly accounts: readonly { readonly key: string; readonly status: string; readonly at: string | null }[];
    readonly webhookBacklog: readonly { readonly status: string; readonly count: number }[];
  };
}

@Injectable()
export class OmnichannelAnalyticsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
  ) {}

  async overview(days: number): Promise<OmnichannelAnalytics> {
    await this.permissions.assert('inboxView');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const windowDays = Math.min(Math.max(Math.trunc(days), 1), 365);
    const from = sql<Date>`now() - (${windowDays} || ' days')::interval`;
    const to = new Date();

    const volume = (await sql<{ channel: string; inbound: number; outbound: number }>`
      select channel,
             count(*) filter (where direction = 'inbound')::int as inbound,
             count(*) filter (where direction = 'outbound')::int as outbound
      from voice_messages
      where is_internal_note = false and created_at >= ${from}
      group by channel order by channel
    `.execute(this.database.db)).rows;

    const backlog = (await sql<{ status: string; count: number }>`
      select status, count(*)::int as count from voice_conversations
      where archived = false and status in ('open', 'pending_customer', 'pending_internal')
      group by status order by status
    `.execute(this.database.db)).rows;

    const backlogExtra = (await sql<{ unassigned: number; snoozed: number }>`
      select
        count(*) filter (where assigned_user_id is null and assigned_team_id is null and status <> 'closed')::int as unassigned,
        count(*) filter (where snoozed_until is not null and snoozed_until > now())::int as snoozed
      from voice_conversations where archived = false
    `.execute(this.database.db)).rows[0];

    const assignment = (await sql<{ assignee: string; count: number }>`
      select coalesce(assigned_user_id, assigned_team_id, 'unassigned') as assignee, count(*)::int as count
      from voice_conversations where archived = false and status <> 'closed'
      group by assignee order by count desc limit 20
    `.execute(this.database.db)).rows;

    // First response: conversation created_at → first customer-visible outbound message.
    const firstResponse = (await sql<{ avg_minutes: number | null; sample: number }>`
      select round(avg(extract(epoch from (first_out.created_at - c.created_at)) / 60)::numeric, 1)::float as avg_minutes,
             count(*)::int as sample
      from voice_conversations c
      join lateral (
        select min(created_at) as created_at from voice_messages m
        where m.conversation_id = c.id and m.direction = 'outbound' and m.is_internal_note = false
      ) first_out on first_out.created_at is not null
      where c.created_at >= ${from}
    `.execute(this.database.db)).rows[0];

    // Reply delay: each inbound customer message → the next outbound visible message in the conversation.
    const replyDelay = (await sql<{ avg_minutes: number | null; sample: number }>`
      select round(avg(extract(epoch from (next_out.created_at - m.created_at)) / 60)::numeric, 1)::float as avg_minutes,
             count(*)::int as sample
      from voice_messages m
      join lateral (
        select min(o.created_at) as created_at from voice_messages o
        where o.conversation_id = m.conversation_id and o.direction = 'outbound'
          and o.is_internal_note = false and o.created_at > m.created_at
      ) next_out on next_out.created_at is not null
      where m.direction = 'inbound' and m.is_internal_note = false and m.created_at >= ${from}
    `.execute(this.database.db)).rows[0];

    const handoffs = (await sql<{ conversations_with_case: number }>`
      select count(*)::int as conversations_with_case from voice_conversations
      where case_id is not null and created_at >= ${from}
    `.execute(this.database.db)).rows[0];

    const reopen = (await sql<{ reopened: number; closed: number }>`
      select
        (select count(*)::int from voice_conversation_events
          where kind = 'status_changed' and from_value in ('closed', 'resolved') and to_value = 'open'
            and created_at >= ${from}) as reopened,
        (select count(*)::int from voice_conversation_events
          where kind = 'status_changed' and to_value in ('closed', 'resolved') and created_at >= ${from}) as closed
    `.execute(this.database.db)).rows[0];

    const delivery = (await sql<{ state: string; failure_category: string | null; count: number }>`
      select state, failure_category, count(*)::int as count from voice_messages
      where direction = 'outbound' and is_internal_note = false and created_at >= ${from}
        and state in ('failed', 'undelivered', 'unknown')
      group by state, failure_category
    `.execute(this.database.db)).rows;
    const deliveryCount = (state: string): number => delivery.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0);
    const categories = new Map<string, number>();
    for (const row of delivery) {
      categories.set(row.failure_category ?? 'unspecified', (categories.get(row.failure_category ?? 'unspecified') ?? 0) + row.count);
    }

    const accounts = (await sql<{ key: string; status: string | null; at: Date | null }>`
      select key, last_health_status as status, last_health_at as at from voice_provider_accounts
      where enabled = true order by key limit 30
    `.execute(this.database.db)).rows;
    const webhookBacklog = (await sql<{ status: string; count: number }>`
      select processing_status as status, count(*)::int as count from voice_webhook_events
      where received_at >= ${from} group by processing_status order by processing_status
    `.execute(this.database.db)).rows;

    return {
      window: { days: windowDays, from: new Date(to.getTime() - windowDays * 86_400_000).toISOString(), to: to.toISOString() },
      volume: {
        byChannel: volume,
        totalInbound: volume.reduce((sum, row) => sum + row.inbound, 0),
        totalOutbound: volume.reduce((sum, row) => sum + row.outbound, 0),
      },
      backlog: {
        byStatus: backlog,
        unassigned: Number(backlogExtra?.unassigned ?? 0),
        snoozed: Number(backlogExtra?.snoozed ?? 0),
      },
      assignment,
      firstResponse: {
        averageMinutes: firstResponse?.avg_minutes ?? null,
        sample: Number(firstResponse?.sample ?? 0),
        ...(Number(firstResponse?.sample ?? 0) === 0 ? { unavailable: 'No conversation in the window has a customer-visible agent reply yet.' } : {}),
      },
      replyDelay: {
        averageMinutes: replyDelay?.avg_minutes ?? null,
        sample: Number(replyDelay?.sample ?? 0),
        ...(Number(replyDelay?.sample ?? 0) === 0 ? { unavailable: 'No inbound message in the window has a following agent reply yet.' } : {}),
      },
      handoffs: { conversationsWithCase: Number(handoffs?.conversations_with_case ?? 0) },
      reopenRate: {
        reopened: Number(reopen?.reopened ?? 0),
        closedInWindow: Number(reopen?.closed ?? 0),
        rate: Number(reopen?.closed ?? 0) === 0 ? null : Math.round((Number(reopen?.reopened ?? 0) / Number(reopen?.closed ?? 1)) * 1000) / 10,
      },
      delivery: {
        failed: deliveryCount('failed'),
        undelivered: deliveryCount('undelivered'),
        unknown: deliveryCount('unknown'),
        byCategory: [...categories.entries()].map(([category, count]) => ({ category, count })).sort((left, right) => right.count - left.count),
      },
      providerHealth:
        accounts.length === 0
          ? { available: false, reason: 'No enabled provider account is configured.', accounts: [], webhookBacklog }
          : { available: true, accounts: accounts.map((row) => ({ key: row.key, status: row.status ?? 'unknown', at: row.at === null ? null : new Date(row.at).toISOString() })), webhookBacklog },
    };
  }
}
