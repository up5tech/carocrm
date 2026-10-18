import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { currentTx } from "../entity/tx-context.js";
import {
  type AudienceCategory,
  DELIVERY_STATE_FOR_CATEGORY,
  OPEN_DELIVERY_STATES,
  type RecipientDeliveryStatus,
} from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.8 — the per-recipient marketing delivery ledger
 * (PLAN_Phase_19_Marketing_Automation.md §5.5, §6.5; audit §3 `MarketingRecipientDelivery`).
 *
 * This is the one marketing structure that is a table rather than a metadata record, for the same reason
 * `marketing_audience_snapshot_entries` (migration 038) and `email_deliveries` (006) are: one row per resolved
 * recipient, written in bulk from a frozen snapshot, read in pages, and never edited by a person. Putting
 * 50,000 recipients into `entity_records` would put 50,000 CRM records into a store built for business
 * objects — with search, stream, audit and the record API attached to each of them (§1.2 "reuse the platform,
 * do not duplicate it").
 *
 * What it stores is deliberately narrow (§6.1 "minimized recipient-address snapshot fields", §9.3): the
 * recipient as `(entity_type, entity_id)`, a keyed `email_hash`, the state, the forecast category and the
 * reason codes that decided it. No plaintext address, no rendered body, no name — a delivery record answers
 * "who was this meant for and what happened", not "what did we say to them".
 *
 * Every statement is parameterised and every identifier is fixed (AGENTS.md §5.2); the one enumeration that
 * reaches SQL as a list is the state machine's own closed vocabulary, built from the domain constants so a
 * new state cannot be forgotten here.
 */

export interface DeliveryRecord {
  readonly sendId: string;
  readonly slot: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly emailHash: string | null;
  readonly state: RecipientDeliveryStatus;
  readonly category: AudienceCategory | null;
  readonly reasons: readonly string[];
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly sentAt: string | null;
  readonly createdAt: string | null;
}

export interface DeliverySummary {
  readonly total: number;
  readonly eligible: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly sent: number;
  readonly failed: number;
  readonly byState: readonly { readonly state: string; readonly count: number }[];
}

/** What materialising a forecast produced, so the send's own counters are the ledger's, never arithmetic. */
export interface MaterialisedForecast {
  readonly recipientCount: number;
  readonly eligibleCount: number;
  readonly blockedCount: number;
  readonly skippedCount: number;
}

const EMPTY_SUMMARY: DeliverySummary = {
  total: 0,
  eligible: 0,
  blocked: 0,
  skipped: 0,
  sent: 0,
  failed: 0,
  byState: [],
};

@Injectable()
export class MarketingDeliveryLedger {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads and writes the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  /**
   * Drop the forecast rows of one slot before re-materialising it. Only the states a forecast itself writes
   * are touched: a row MA.9 has already queued or sent is delivery evidence and is never rewritten, which is
   * exactly why a re-validation cannot re-send a recipient who was already messaged (§5.6).
   */
  async clearForecast(sendId: string, slot: number): Promise<number> {
    const states = [...FORECAST_DELIVERY_STATES];
    const result = await sql`
      delete from marketing_recipient_deliveries
      where send_id = ${sendId}
        and slot = ${slot}
        and state in (${sql.join(states.map((state) => sql`${state}`))})
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Freeze one send slot's forecast from the snapshot it was validated against: one row per resolved
   * recipient, in the state §5.5's category mapping gives it. `on conflict do nothing` is the second half of
   * the §5.6 rule — a recipient who already has a row for this slot (for instance because MA.9 has claimed
   * them) keeps it.
   */
  async materialise(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly snapshotId: string;
  }): Promise<number> {
    const cases = Object.entries(DELIVERY_STATE_FOR_CATEGORY).map(
      ([category, state]) => sql`when ${category} then ${state}`,
    );
    const result = await sql`
      insert into marketing_recipient_deliveries
        (send_id, slot, entity_type, entity_id, email_hash, state, category, reasons)
      select
        ${input.sendId},
        ${input.slot},
        entry.entity_type,
        entry.entity_id,
        entry.email_hash,
        case entry.category ${sql.join(cases, sql` `)} else ${"Skipped"} end,
        entry.category,
        entry.reasons
      from marketing_audience_snapshot_entries entry
      where entry.snapshot_id = ${input.snapshotId}
      on conflict (send_id, slot, entity_type, entity_id) do nothing
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  // -------------------------------------------------------------------------
  // MA.9 — the delivery worker's primitives
  //
  // Every statement below is guarded by the `RECIPIENT_DELIVERY_TRANSITIONS` edge it implements
  // (`where state = …`), so a cancel or a second worker racing the same row changes nothing rather
  // than overwriting delivery evidence (§5.7 "two workers must not advance … concurrently"). All of
  // them are one row or one bounded chunk — never a full-table write — because the worker runs beside
  // live traffic (§11.2).
  // -------------------------------------------------------------------------

  /**
   * Atomically claim a bounded chunk of open rows for delivery (MA.9 task 3, §11.2).
   *
   * `FOR UPDATE SKIP LOCKED` is the claim: two workers running the same send receive disjoint row
   * sets, and a claim bumps `attempts` and stamps `claimed_at` in the same statement — the two facts
   * recovery needs to tell "died mid-flight" from "never started".
   *
   * `Eligible` **and** `Queued` are claimable: `Queued` is where `retryOrFail`/`releaseClaim` send a row
   * back (the machine's own `Queued → Sending` edge), so a claim that only read `Eligible` would strand
   * every retried recipient unclaimed forever.
   */
  async claim(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly limit: number;
    readonly now: string;
  }): Promise<DeliveryRecord[]> {
    const rows = await sql<DeliveryRowWithClaim>`
      update marketing_recipient_deliveries
      set state = 'Sending',
          claimed_at = ${input.now},
          attempts = attempts + 1,
          updated_at = ${input.now}
      where (send_id, slot, entity_type, entity_id) in (
        select send_id, slot, entity_type, entity_id
        from marketing_recipient_deliveries
        where send_id = ${input.sendId}
          and slot = ${input.slot}
          and state in ('Eligible', 'Queued')
        order by created_at asc, entity_type asc, entity_id asc
        limit ${input.limit}
        for update skip locked
      )
      returning send_id, slot, entity_type, entity_id, email_hash, state, category, reasons,
                provider_message_id, error_code, attempts, sent_at, created_at
    `.execute(this.db);
    return rows.rows.map(toRecord);
  }

  /** The open and outcome state counts of one send slot — what "is this send finished" is answered from. */
  async openCounts(sendId: string, slot: number): Promise<Record<RecipientDeliveryStatus | string, number>> {
    const rows = await sql<StateCountRow>`
      select state, count(*)::int as count
      from marketing_recipient_deliveries
      where send_id = ${sendId} and slot = ${slot}
      group by state
    `.execute(this.db);
    const counts: Record<string, number> = {};
    for (const row of rows.rows) counts[row.state] = row.count;
    return counts;
  }

  /** A claimed row the provider accepted: the delivery fact, stamped with what proves it (§6.5). */
  async markSent(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly providerKey: string;
    readonly providerMessageId: string | null;
    readonly contentHash: string | null;
    readonly at: string;
  }): Promise<number> {
    const result = await sql`
      update marketing_recipient_deliveries
      set state = 'Sent',
          provider_key = ${input.providerKey},
          provider_message_id = ${input.providerMessageId},
          content_hash = ${input.contentHash},
          error_code = null,
          sent_at = ${input.at},
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** The final gate refused a claimed row (§5.8 "re-check consent, suppression … immediately before"). */
  async blockClaimed(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly reasons: readonly string[];
    readonly errorCode: string;
    readonly at: string;
  }): Promise<number> {
    const result = await sql`
      update marketing_recipient_deliveries
      set state = 'Blocked',
          error_code = ${input.errorCode},
          reasons = reasons || ${JSON.stringify([...input.reasons])}::jsonb,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * A classified failure (§5.8, §7.4): the row lands in `Failed` and either stays there — the retry
   * budget is spent, and it is now a dead letter an operator can read — or returns to `Queued` for one
   * more attempt. Both steps use the machine's own edges (`Sending → Failed → Queued`).
   */
  async retryOrFail(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly reasonCode: string;
    readonly maxAttempts: number;
    readonly at: string;
  }): Promise<"Queued" | "Failed"> {
    const failed = await sql`
      update marketing_recipient_deliveries
      set state = 'Failed',
          error_code = ${input.reasonCode},
          failed_at = ${input.at},
          reasons = reasons || ${JSON.stringify([input.reasonCode])}::jsonb,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    if (Number(failed.numAffectedRows ?? 0n) === 0) return "Failed";
    const requeued = await sql`
      update marketing_recipient_deliveries
      set state = 'Queued',
          reasons = reasons || ${JSON.stringify(["RETRY_SCHEDULED"])}::jsonb,
          failed_at = null,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Failed'
        and attempts < ${input.maxAttempts}
    `.execute(this.db);
    return Number(requeued.numAffectedRows ?? 0n) > 0 ? "Queued" : "Failed";
  }

  /** A permanent failure: retrying would fail identically, so the row becomes a dead letter now (§5.8). */
  async failPermanent(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly reasonCode: string;
    readonly at: string;
  }): Promise<number> {
    const result = await sql`
      update marketing_recipient_deliveries
      set state = 'Failed',
          error_code = ${input.reasonCode},
          failed_at = ${input.at},
          reasons = reasons || ${JSON.stringify([input.reasonCode])}::jsonb,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * The submission may have reached the provider (`unknown_submission`, §5.8): the row stays `Sending`
   * with the reason recorded and is deliberately **not** retried — a blind resubmit is how a recipient
   * is mailed twice. MA.10's provider events reconcile it; until then it is visible, not lost.
   */
  async markSubmissionUnknown(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly at: string;
  }): Promise<number> {
    const result = await sql`
      update marketing_recipient_deliveries
      set error_code = 'SUBMISSION_UNKNOWN',
          reasons = reasons || ${JSON.stringify(["SUBMISSION_UNKNOWN"])}::jsonb,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Release a claim that never reached the provider (a throttle refusal mid-chunk, §5.8). The attempt
   * consumed at claim time is given back — a rate ceiling must not eat a recipient's retry budget — and
   * the row walks the machine's own edge back to `Queued`.
   */
  async releaseClaim(input: {
    readonly sendId: string;
    readonly slot: number;
    readonly entityType: string;
    readonly entityId: string;
    readonly reasonCode: string;
    readonly at: string;
  }): Promise<number> {
    const released = await sql`
      update marketing_recipient_deliveries
      set state = 'Failed',
          error_code = ${input.reasonCode},
          attempts = greatest(attempts - 1, 0),
          reasons = reasons || ${JSON.stringify([input.reasonCode])}::jsonb,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Sending'
    `.execute(this.db);
    if (Number(released.numAffectedRows ?? 0n) === 0) return 0;
    await sql`
      update marketing_recipient_deliveries
      set state = 'Queued',
          error_code = null,
          failed_at = null,
          updated_at = ${input.at}
      where send_id = ${input.sendId}
        and slot = ${input.slot}
        and entity_type = ${input.entityType}
        and entity_id = ${input.entityId}
        and state = 'Failed'
    `.execute(this.db);
    return 1;
  }

  /**
   * Restart recovery (§11.2 "on deploy/restart … resumed/recovered without duplicate send", MA.9 task
   * 6). A claim older than the threshold whose worker never reported back is expired; under the retry
   * budget it returns to `Queued` and will be resubmitted **under the same idempotency key**, so a
   * provider that honours idempotency cannot deliver twice. Rows carrying `SUBMISSION_UNKNOWN` are
   * deliberately left alone — they may already be on the wire (§5.8).
   */
  async recoverStaleClaims(input: {
    readonly sendId: string | null;
    readonly olderThan: string;
    readonly maxAttempts: number;
    readonly limit: number;
    readonly at: string;
  }): Promise<{ expired: number; requeued: number; exhausted: number }> {
    const expired = await sql<ExpiredClaimRow>`
      with to_expire as (
        select send_id, slot, entity_type, entity_id
        from marketing_recipient_deliveries
        where state = 'Sending'
          and error_code is null
          and claimed_at is not null
          and claimed_at < ${input.olderThan}
          ${input.sendId === null ? sql`` : sql`and send_id = ${input.sendId}`}
        order by claimed_at asc
        limit ${input.limit}
      )
      update marketing_recipient_deliveries
      set state = 'Failed',
          error_code = 'CLAIM_EXPIRED',
          failed_at = ${input.at},
          reasons = reasons || ${JSON.stringify(["CLAIM_EXPIRED"])}::jsonb,
          updated_at = ${input.at}
      where (send_id, slot, entity_type, entity_id) in (
        select send_id, slot, entity_type, entity_id from to_expire
      )
      returning send_id, slot, entity_type, entity_id, attempts
    `.execute(this.db);
    const rows = expired.rows;
    if (rows.length === 0) return { expired: 0, requeued: 0, exhausted: 0 };
    const keys = sql.join(
      rows.map((row) => sql`(${row.send_id}, ${row.slot}, ${row.entity_type}, ${row.entity_id})`),
    );
    const requeued = await sql`
      update marketing_recipient_deliveries
      set state = 'Queued',
          reasons = reasons || ${JSON.stringify(["CLAIM_REQUEUED"])}::jsonb,
          failed_at = null,
          updated_at = ${input.at}
      where (send_id, slot, entity_type, entity_id) in (${keys})
        and state = 'Failed'
        and error_code = 'CLAIM_EXPIRED'
        and attempts < ${input.maxAttempts}
    `.execute(this.db);
    const requeuedCount = Number(requeued.numAffectedRows ?? 0n);
    await sql`
      update marketing_recipient_deliveries
      set error_code = 'RETRY_BUDGET_EXHAUSTED',
          reasons = reasons || ${JSON.stringify(["RETRY_BUDGET_EXHAUSTED"])}::jsonb,
          updated_at = ${input.at}
      where (send_id, slot, entity_type, entity_id) in (${keys})
        and state = 'Failed'
        and error_code = 'CLAIM_EXPIRED'
    `.execute(this.db);
    return { expired: rows.length, requeued: requeuedCount, exhausted: rows.length - requeuedCount };
  }

  /**
   * How many marketing messages each identity already received inside the frequency-cap window
   * (§5.5, MA.9 task 3). Counted across **all** sends, because a per-recipient cap that only looks at
   * the current send would cap nothing.
   */
  async countMessagesSince(hashes: readonly string[], since: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (hashes.length === 0) return out;
    const list = sql.join(hashes.map((hash) => sql`${hash}`));
    const rows = await sql<{ email_hash: string; count: number }>`
      select email_hash, count(*)::int as count
      from marketing_recipient_deliveries
      where email_hash in (${list})
        and state in ('Sent', 'Delivered')
        and sent_at >= ${since}
      group by email_hash
    `.execute(this.db);
    for (const row of rows.rows) out.set(row.email_hash, row.count);
    return out;
  }

  /** Global ledger counts by state — the health endpoint's delivery signal (MA.9 task 7). */
  async globalStateCounts(): Promise<Map<string, number>> {
    const rows = await sql<StateCountRow>`
      select state, count(*)::int as count
      from marketing_recipient_deliveries
      group by state
    `.execute(this.db);
    return new Map(rows.rows.map((row) => [row.state, row.count]));
  }

  /** The state breakdown of one send (all its slots). */
  async summary(sendId: string): Promise<DeliverySummary> {
    return this.summarise(await this.byState([sendId]));
  }

  /** The same breakdown for several sends in one query — a campaign's send list must not fan out. */
  async summaries(sendIds: readonly string[]): Promise<Map<string, DeliverySummary>> {
    const rows = await this.byState(sendIds);
    const grouped = new Map<string, { state: string; count: number }[]>();
    for (const row of rows) {
      const list = grouped.get(row.send_id) ?? [];
      list.push({ state: row.state, count: row.count });
      grouped.set(row.send_id, list);
    }
    return new Map([...grouped.entries()].map(([sendId, byState]) => [sendId, this.summarise(byState)]));
  }

  /** One page of a send's recipient rows, optionally by state or forecast category. */
  async list(
    sendId: string,
    options: {
      readonly state?: RecipientDeliveryStatus | undefined;
      readonly category?: AudienceCategory | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    } = {},
  ): Promise<{ records: DeliveryRecord[]; total: number }> {
    const filters = [sql`send_id = ${sendId}`];
    if (options.state !== undefined) filters.push(sql`state = ${options.state}`);
    if (options.category !== undefined) filters.push(sql`category = ${options.category}`);
    const where = sql.join(filters, sql` and `);

    const counted = await sql<{ count: string }>`
      select count(*)::text as count from marketing_recipient_deliveries where ${where}
    `.execute(this.db);
    const rows = await sql<DeliveryRow>`
      select send_id, slot, entity_type, entity_id, email_hash, state, category, reasons,
             provider_message_id, error_code, attempts, sent_at, created_at
      from marketing_recipient_deliveries
      where ${where}
      order by state asc, entity_type asc, entity_id asc
      limit ${options.limit ?? 100}
      offset ${options.offset ?? 0}
    `.execute(this.db);

    return {
      records: rows.rows.map(toRecord),
      total: Number(counted.rows[0]?.count ?? "0"),
    };
  }

  /**
   * Stop a send's not-yet-sent recipients (§5.5 `cancel`). They land in `Skipped` — the delivery machine's
   * terminal "no message will be sent" state — with the reason recorded, because an operator stop is not an
   * execution failure and must not be reported as one. Rows a worker is already sending are left alone: MA.9
   * reconciles those, and a marketing field cannot un-send a message that is on the wire.
   */
  async cancelOpen(sendId: string, slot: number, reasonCode: string, at: string): Promise<number> {
    const states = [...OPEN_DELIVERY_STATES];
    const result = await sql`
      update marketing_recipient_deliveries
      set state = ${"Skipped"},
          error_code = ${reasonCode},
          reasons = reasons || ${JSON.stringify([reasonCode])}::jsonb,
          updated_at = ${at}
      where send_id = ${sendId}
        and slot = ${slot}
        and state in (${sql.join(states.map((state) => sql`${state}`))})
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  private async byState(sendIds: readonly string[]): Promise<StateCountRow[]> {
    if (sendIds.length === 0) return [];
    const list = sql.join(sendIds.map((id) => sql`${id}`));
    const rows = await sql<StateCountRow>`
      select send_id, state, count(*)::int as count
      from marketing_recipient_deliveries
      where send_id in (${list})
      group by send_id, state
      order by send_id asc, state asc
    `.execute(this.db);
    return rows.rows;
  }

  private summarise(byState: readonly { readonly state: string; readonly count: number }[]): DeliverySummary {
    if (byState.length === 0) return EMPTY_SUMMARY;
    const of = (...states: string[]) =>
      byState.filter((row) => states.includes(row.state)).reduce((total, row) => total + row.count, 0);
    return {
      total: byState.reduce((total, row) => total + row.count, 0),
      eligible: of("Eligible"),
      blocked: of("Blocked"),
      skipped: of("Skipped"),
      sent: of("Sent", "Delivered", "Bounced", "Complained", "Unsubscribed"),
      failed: of("Failed"),
      byState: byState.map((row) => ({ state: row.state, count: row.count })),
    };
  }
}

/** The states a forecast writes, derived from the category mapping so the two cannot drift apart. */
const FORECAST_DELIVERY_STATES: readonly RecipientDeliveryStatus[] = [
  ...new Set(Object.values(DELIVERY_STATE_FOR_CATEGORY)),
];

interface StateCountRow {
  send_id: string;
  state: string;
  count: number;
}

/** A claim-expiry probe row: the identity of the row plus the attempt count recovery reasons about. */
interface ExpiredClaimRow {
  send_id: string;
  slot: number;
  entity_type: string;
  entity_id: string;
  attempts: number;
}

/** The claim RETURNING shape: the ledger row as the worker will act on it. */
type DeliveryRowWithClaim = DeliveryRow;

interface DeliveryRow {
  send_id: string;
  slot: number;
  entity_type: string;
  entity_id: string;
  email_hash: string | null;
  state: string;
  category: string | null;
  reasons: unknown;
  provider_message_id: string | null;
  error_code: string | null;
  attempts: number;
  sent_at: Date | string | null;
  created_at: Date | string | null;
}

function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    sendId: row.send_id,
    slot: row.slot,
    entityType: row.entity_type,
    entityId: row.entity_id,
    emailHash: row.email_hash,
    state: row.state as RecipientDeliveryStatus,
    category: (row.category as AudienceCategory | null) ?? null,
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    providerMessageId: row.provider_message_id,
    errorCode: row.error_code,
    attempts: row.attempts,
    sentAt: iso(row.sent_at),
    createdAt: iso(row.created_at),
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}
