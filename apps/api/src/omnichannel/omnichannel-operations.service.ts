import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import {
  type ProviderAccountView,
  type ReceiptSummary,
  VoiceProviderAccountsService,
  VoiceWebhookIngressService,
} from '../voice-communications/index.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';

/**
 * Phase 19-OM.21 — cross-channel operations, diagnostics and recovery
 * (plan §14 `19-OM.21`; runbook `docs/omnichannel/runbook.md`).
 *
 * Everything here is a **read or a documented command over the owner's records** — the same
 * `voice_webhook_events`, `voice_messages` state machine and provider-account health Voice already
 * owns (acceptance: diagnostics read the reused records, no parallel operational store):
 *  - connection health, credential/webhook-secret presence (booleans only — never a secret or hint),
 *    last event time, receipt backlog and failure categories per window;
 *  - safe recovery tools: an adapter health probe, an authorized webhook replay with its idempotency
 *    statement, the reconcile-unknown path (delivered in OM.6/E7), and a connection kill switch whose
 *    impact is reported, not guessed.
 *  - Elevated capabilities: inspection/overview ask `opsRead`, replay asks `opsReplay`, probing asks
 *    `connectionManage`, and the kill switch asks `settingsManage`. Payload inspection returns the
 *    receipt's **redacted** payload exactly as the ingress stored it.
 */

export interface OperationsAccountView {
  readonly key: string;
  readonly label: string;
  readonly providerKey: string;
  readonly enabled: boolean;
  readonly hasCredential: boolean;
  readonly hasWebhookSecret: boolean;
  readonly health: { readonly status: string | null; readonly detail: string | null; readonly at: string | null };
  readonly capabilities: number;
  readonly lastEventAt: string | null;
  /** Outbound messages awaiting provider confirmation (kill-switch impact). */
  readonly awaitingConfirmation: number;
}

export interface OperationsOverview {
  readonly window: { readonly days: number };
  readonly accounts: readonly OperationsAccountView[];
  readonly receipts: readonly { readonly status: string; readonly count: number }[];
  readonly failures: readonly { readonly code: string; readonly count: number }[];
}

@Injectable()
export class OmnichannelOperationsService {
  constructor(
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceWebhookIngressService) private readonly ingress: VoiceWebhookIngressService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async overview(days: number): Promise<OperationsOverview> {
    await this.permissions.assert('opsRead');
    const windowDays = Math.min(Math.max(Math.trunc(days), 1), 90);
    // The owner's table, read with a narrow projection: presence is a boolean, never a secret or hint.
    // Reading it here (rather than the owner's admin-gated list) lets an operations reader see health
    // without holding the credential-administration right.
    const views = (await sql<{
      key: string;
      label: string;
      provider_key: string;
      enabled: boolean;
      capabilities: unknown;
      has_credential: boolean;
      has_webhook_secret: boolean;
      last_health_status: string | null;
      last_health_detail: string | null;
      last_health_at: Date | null;
    }>`
      select key, label, provider_key, enabled, capabilities,
             (credential_encrypted is not null) as has_credential,
             (webhook_secret_encrypted is not null) as has_webhook_secret,
             last_health_status, last_health_detail, last_health_at
      from voice_provider_accounts order by label
    `.execute(this.database.db)).rows;
    const accounts: OperationsAccountView[] = [];
    for (const view of views) {
      accounts.push({
        key: view.key,
        label: view.label,
        providerKey: view.provider_key,
        enabled: view.enabled,
        hasCredential: view.has_credential,
        hasWebhookSecret: view.has_webhook_secret,
        health: {
          status: view.last_health_status,
          detail: view.last_health_detail,
          at: view.last_health_at === null ? null : new Date(view.last_health_at).toISOString(),
        },
        capabilities: Array.isArray(view.capabilities) ? view.capabilities.length : 0,
        lastEventAt: await this.lastEventAt(view.key),
        awaitingConfirmation: await this.awaitingConfirmation(view.key),
      });
    }
    const receipts = (await sql<{ status: string; count: number }>`
      select processing_status as status, count(*)::int as count from voice_webhook_events
      where received_at >= now() - (${windowDays} || ' days')::interval
      group by processing_status order by processing_status
    `.execute(this.database.db)).rows;
    const failures = (await sql<{ code: string; count: number }>`
      select coalesce(failure_code, 'unspecified') as code, count(*)::int as count from voice_webhook_events
      where received_at >= now() - (${windowDays} || ' days')::interval and failure_code is not null
      group by code order by count desc limit 10
    `.execute(this.database.db)).rows;
    return { window: { days: windowDays }, accounts, receipts, failures };
  }

  /** Adapter health probe (the owner persists the result); no credential is returned. */
  async testAccount(key: string): Promise<{ readonly ok: boolean; readonly checkedAt: string; readonly detail: string }> {
    await this.permissions.assert('connectionManage');
    const result = await this.accounts.healthCheck(key);
    return { ok: result.ok, checkedAt: result.checkedAt, detail: result.detail };
  }

  async listEvents(query: {
    readonly status?: string | undefined;
    readonly limit: number;
    readonly offset?: number | undefined;
  }): Promise<{ readonly list: readonly ReceiptSummary[]; readonly total: number }> {
    await this.permissions.assert('opsRead');
    const offset = query.offset === undefined ? 0 : Math.max(Math.trunc(query.offset), 0);
    return this.ingress.list({ limit: Math.min(Math.max(query.limit, 1), 100), offset, ...(query.status === undefined ? {} : { status: query.status }) });
  }

  /** Receipt inspection: the ingress already stores a redacted payload; it is returned verbatim. */
  async inspectEvent(eventId: string): Promise<ReceiptSummary & { readonly payload: unknown }> {
    await this.permissions.assert('opsRead');
    return this.ingress.get(eventId);
  }

  /** Authorized replay, with the effects that will and will not reoccur stated up front. */
  async replayEvent(eventId: string): Promise<{
    readonly eventId: string;
    readonly queued: boolean;
    readonly effects: { readonly idempotent: readonly string[]; readonly refused: readonly string[] };
  }> {
    await this.permissions.assert('opsReplay');
    const result = await this.ingress.replay(eventId);
    return {
      eventId: result.eventId,
      queued: result.queued,
      effects: {
        idempotent: [
          'one normalized communication event per receipt (unique receipt index)',
          'one message per provider message id (unique idempotency index)',
        ],
        refused: ['a callback that failed signature validation cannot be replayed'],
      },
    };
  }

  /**
   * Connection kill switch. Disabling stops new outbound traffic (the policy refuses with
   * `account_disabled`) and leaves history untouched; inbound callbacks may still be recorded but are
   * not applied while the account is disabled. The in-flight count is reported so an operator knows
   * what remains awaiting a provider confirmation.
   */
  async setAccountEnabled(key: string, enabled: boolean): Promise<{
    readonly account: { readonly key: string; readonly enabled: boolean };
    readonly impact: { readonly outbound: string; readonly inbound: string; readonly history: string; readonly awaitingConfirmation: number };
  }> {
    await this.permissions.assert('settingsManage');
    const view: ProviderAccountView = await this.accounts.setEnabled(key, enabled);
    const awaiting = await this.awaitingConfirmation(key);
    return {
      account: { key: view.key, enabled: view.enabled },
      impact: {
        outbound: enabled ? 'New outbound traffic resumes through the policy pipeline.' : 'New outbound sends are refused with account_disabled; nothing is deleted.',
        inbound: enabled ? 'Callbacks are applied again.' : 'Callbacks are still received and stored, but are not applied while disabled.',
        history: 'Conversation, message and receipt history is unchanged.',
        awaitingConfirmation: awaiting,
      },
    };
  }

  private async lastEventAt(accountKey: string): Promise<string | null> {
    const row = (await sql<{ at: Date | null }>`
      select max(received_at) as at from voice_webhook_events where account_key = ${accountKey}
    `.execute(this.database.db)).rows[0];
    return row?.at === null || row?.at === undefined ? null : new Date(row.at).toISOString();
  }

  private async awaitingConfirmation(accountKey: string): Promise<number> {
    const row = (await sql<{ n: number }>`
      select count(*)::int as n from voice_messages
      where account_key = ${accountKey} and direction = 'outbound' and is_internal_note = false
        and state in ('queued', 'submitted', 'unknown')
    `.execute(this.database.db)).rows[0];
    return Number(row?.n ?? 0);
  }
}
