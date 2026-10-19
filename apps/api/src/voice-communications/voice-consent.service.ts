import { randomUUID } from "node:crypto";

import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { PHONE_NORMALIZER, type PhoneNormalizer } from "./phone-number.js";
import type { VoiceChannel } from "./voice-communications-domain.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";

/**
 * Phase 19-VC.6 — channel consent and suppression
 * (`PLAN_Phase_19_Voice_Communications.md` §5.2, §8.4, §13.4, §15 `19-VC.6`).
 *
 * MarketingAutomation's consent is **email-only** (`MarketingConsent.channel = ['Email']`, identity =
 * email hash), so it stays authoritative for email and this module owns the non-email channels. The
 * split is documented in `docs/compatibility/voice-communications.md` §2.5: one authoritative source
 * per channel, never two.
 *
 * Two invariants:
 *  - Consent is **append-only evidence**. `record()` never updates a row; the current state is the
 *    latest event for `(channel, address, purpose)`. That is what makes "who opted in, when, on what
 *    basis" answerable (§13.4).
 *  - Suppression is a tombstone with a revocation timestamp, not a delete. A revoked suppression
 *    stops blocking but the history remains, and a partial unique index keeps at most one active
 *    suppression per `(channel, address)`.
 */

export const CONSENT_STATUSES = ["granted", "denied", "revoked", "unknown"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const CONSENT_BASES = [
  "explicit_opt_in",
  "double_opt_in",
  "contractual",
  "provider_confirmed",
  "manual_record",
  "import",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const CONSENT_SOURCES = [
  "web_form",
  "preference_center",
  "provider_webhook",
  "manual_record",
  "import",
  "api",
  "sales_rep",
  "system",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SUPPRESSION_REASONS = [
  "opt_out",
  "stop_keyword",
  "complaint",
  "hard_failure",
  "administrative_stop",
  "provider_block",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface ConsentState {
  readonly channel: VoiceChannel;
  readonly address: string;
  readonly purpose: string;
  readonly status: ConsentStatus;
  readonly basis: ConsentBasis | null;
  readonly source: ConsentSource | null;
  readonly occurredAt: string | null;
  readonly evidence: string | null;
}

export interface SuppressionView {
  readonly id: string;
  readonly channel: VoiceChannel;
  readonly address: string;
  readonly reason: SuppressionReason;
  readonly source: ConsentSource;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

interface ConsentRow {
  channel: string;
  address: string;
  purpose: string;
  status: string;
  basis: string | null;
  source: string | null;
  occurred_at: Date;
  evidence: string | null;
}

interface SuppressionRow {
  id: string;
  channel: string;
  address: string;
  reason: string;
  source: string;
  created_at: Date;
  revoked_at: Date | null;
}

@Injectable()
export class VoiceConsentService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  /** Normalize an address once, so consent and suppression rows can never be keyed by formatting. */
  async normalizeAddress(channel: VoiceChannel, address: string): Promise<string> {
    const settings = await this.settings.settings();
    const normalized = this.phones.normalize(address, settings.policy.defaultRegion);
    if (!normalized.valid || normalized.e164 === null) {
      throw new ValidationError(`"${address}" is not a valid number for channel "${channel}".`, {
        reason: normalized.reason ?? "invalid",
      });
    }
    return normalized.e164;
  }

  async record(input: {
    readonly channel: VoiceChannel;
    readonly address: string;
    readonly purpose: string;
    readonly status: ConsentStatus;
    readonly basis?: ConsentBasis | null | undefined;
    readonly source: ConsentSource;
    readonly evidence?: string | null | undefined;
    readonly occurredAt?: string | undefined;
  }): Promise<ConsentState> {
    const address = await this.normalizeAddress(input.channel, input.address);
    const purpose = input.purpose.trim();
    if (purpose === "") throw new ValidationError("A consent record needs a purpose.");
    const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new ValidationError("occurredAt must be an ISO timestamp.");
    await sql`
      insert into voice_consent_events
        (id, channel, address, purpose, status, basis, source, evidence, occurred_at, actor_user_id, created_at)
      values
        (${randomUUID()}, ${input.channel}, ${address}, ${purpose}, ${input.status},
         ${input.basis ?? null}, ${input.source}, ${input.evidence ?? null}, ${occurredAt},
         ${this.scope.userId ?? null}, now())
    `.execute(this.database.db);
    return this.state(input.channel, address, purpose);
  }

  /**
   * Current consent state: the latest event for `(channel, address, purpose)`. A channel that has
   * never been decided is `unknown`, never an implied grant (§8.4).
   */
  async state(channel: VoiceChannel, address: string, purpose: string): Promise<ConsentState> {
    const normalized = await this.normalizeAddress(channel, address);
    const row = (await sql<ConsentRow>`
      select channel, address, purpose, status, basis, source, occurred_at, evidence
      from voice_consent_events
      where channel = ${channel} and address = ${normalized} and purpose = ${purpose.trim()}
      order by occurred_at desc, created_at desc
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) {
      return {
        channel,
        address: normalized,
        purpose: purpose.trim(),
        status: "unknown",
        basis: null,
        source: null,
        occurredAt: null,
        evidence: null,
      };
    }
    return {
      channel: row.channel as VoiceChannel,
      address: row.address,
      purpose: row.purpose,
      status: row.status as ConsentStatus,
      basis: row.basis as ConsentBasis | null,
      source: row.source as ConsentSource | null,
      occurredAt: new Date(row.occurred_at).toISOString(),
      evidence: row.evidence,
    };
  }

  /** Every purpose's latest state for one address, so a preference screen can render it in one call. */
  async statesFor(channel: VoiceChannel, address: string): Promise<readonly ConsentState[]> {
    const normalized = await this.normalizeAddress(channel, address);
    const rows = await sql<ConsentRow>`
      select distinct on (purpose) channel, address, purpose, status, basis, source, occurred_at, evidence
      from voice_consent_events
      where channel = ${channel} and address = ${normalized}
      order by purpose, occurred_at desc, created_at desc
    `.execute(this.database.db);
    return rows.rows.map((row) => ({
      channel: row.channel as VoiceChannel,
      address: row.address,
      purpose: row.purpose,
      status: row.status as ConsentStatus,
      basis: row.basis as ConsentBasis | null,
      source: row.source as ConsentSource | null,
      occurredAt: new Date(row.occurred_at).toISOString(),
      evidence: row.evidence,
    }));
  }

  async suppress(input: {
    readonly channel: VoiceChannel;
    readonly address: string;
    readonly reason: SuppressionReason;
    readonly source: ConsentSource;
  }): Promise<SuppressionView> {
    const address = await this.normalizeAddress(input.channel, input.address);
    const existing = await this.activeSuppression(input.channel, address);
    if (existing !== null) return existing;
    const id = randomUUID();
    await sql`
      insert into voice_suppressions (id, channel, address, reason, source, created_at, revoked_at)
      values (${id}, ${input.channel}, ${address}, ${input.reason}, ${input.source}, now(), null)
      on conflict (channel, address) where revoked_at is null do nothing
    `.execute(this.database.db);
    const row = (await sql<SuppressionRow>`
      select * from voice_suppressions where channel = ${input.channel} and address = ${address} and revoked_at is null
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError("The suppression could not be recorded.");
    return toSuppression(row);
  }

  async revokeSuppression(channel: VoiceChannel, address: string): Promise<{ readonly revoked: boolean }> {
    const normalized = await this.normalizeAddress(channel, address);
    const result = await sql`
      update voice_suppressions set revoked_at = now()
      where channel = ${channel} and address = ${normalized} and revoked_at is null
      returning id
    `.execute(this.database.db);
    return { revoked: result.rows.length > 0 };
  }

  async isSuppressed(channel: VoiceChannel, address: string): Promise<SuppressionView | null> {
    const normalized = await this.normalizeAddress(channel, address);
    return this.activeSuppression(channel, normalized);
  }

  async listSuppressions(query: {
    readonly channel?: VoiceChannel | undefined;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly SuppressionView[]> {
    const rows = await sql<SuppressionRow>`
      select * from voice_suppressions
      where revoked_at is null
        and (${query.channel ?? null}::text is null or channel = ${query.channel ?? null})
      order by created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    return rows.rows.map(toSuppression);
  }

  /**
   * The last inbound customer message for an address, derived from the normalized event stream
   * (19-VC.5). This is the WhatsApp service-window input (§8.3) and it deliberately reads real
   * inbound traffic, never a phone number's existence.
   */
  async lastInboundAt(channel: VoiceChannel, address: string): Promise<string | null> {
    const normalized = await this.normalizeAddress(channel, address);
    const row = (await sql<{ occurred_at: Date | null }>`
      select occurred_at from voice_communication_events
      where kind = 'message' and direction = 'inbound' and from_address = ${normalized}
        and (${channel}::text = 'voice' or channel = ${channel})
      order by coalesce(occurred_at, created_at) desc
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row?.occurred_at === null || row?.occurred_at === undefined) return null;
    return new Date(row.occurred_at).toISOString();
  }

  private async activeSuppression(channel: VoiceChannel, address: string): Promise<SuppressionView | null> {
    const row = (await sql<SuppressionRow>`
      select * from voice_suppressions
      where channel = ${channel} and address = ${address} and revoked_at is null
      limit 1
    `.execute(this.database.db)).rows[0];
    return row === undefined ? null : toSuppression(row);
  }
}

function toSuppression(row: SuppressionRow): SuppressionView {
  return {
    id: row.id,
    channel: row.channel as VoiceChannel,
    address: row.address,
    reason: row.reason as SuppressionReason,
    source: row.source as ConsentSource,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  };
}
