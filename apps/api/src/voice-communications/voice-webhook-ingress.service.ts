import { randomUUID } from "node:crypto";

import { AuthenticationFailedError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import {
  payloadDigest,
  redactPayload,
  WEBHOOK_MAX_BODY_BYTES,
  webhookDedupKey,
} from "./voice-communications-domain.js";
import { VOICE_JOB_PROCESS_WEBHOOK } from "./voice-communications-jobs.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { VoiceProviderError, VoiceProviderRegistry } from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";

/**
 * Phase 19-VC.5 — secure webhook ingress
 * (`PLAN_Phase_19_Voice_Communications.md` §11.4, §13.2, §15 `19-VC.5`).
 *
 * The order is deliberate and is the security contract:
 *
 *  1. Resolve the configured account from the routing key. The key is **not** a secret.
 *  2. Enforce the body ceiling before anything is parsed or stored.
 *  3. Enforce the timestamp replay window.
 *  4. Ask the adapter to authenticate the callback with its own vendor scheme — the ingress never
 *     invents a signature algorithm (§11.4).
 *  5. Persist a durable receipt, deduplicated by `(account_id, dedup_key)`.
 *  6. Answer quickly; processing happens in a job (§11.4 "respond within the provider's timeout").
 *
 * A rejected callback is **recorded**, not silently dropped, so an operator can see a
 * misconfigured secret instead of wondering why no events arrive. It is never enqueued.
 */

export interface WebhookIngestInput {
  readonly providerKey: string;
  readonly accountKey: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Record<string, unknown>;
  /** Absolute callback URL reconstructed by the controller, needed by URL-signing providers. */
  readonly url?: string | undefined;
  readonly rawBody?: string | undefined;
}

export interface WebhookIngestResult {
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly accepted: boolean;
  readonly processingStatus: string;
  readonly reason?: string | undefined;
  /**
   * G19 — the delivery reused a known dedup key with a different body. The stored receipt and its
   * processing state are kept; the mismatch is stamped on it (`DEDUP_BODY_MISMATCH`) so the
   * operator queue can ask why one event id carried two bodies.
   */
  readonly bodyMismatch?: boolean | undefined;
}

interface ReceiptRow {
  id: string;
  account_id: string;
  account_key: string;
  provider_key: string;
  vendor_event_id: string | null;
  dedup_key: string;
  event_type: string;
  signature_valid: boolean;
  processing_status: string;
  attempts: number;
  failure_code: string | null;
  failure_detail: string | null;
  payload_digest: string | null;
  received_at: Date;
  processed_at: Date | null;
}

@Injectable()
export class VoiceWebhookIngressService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
  ) {}

  async ingest(input: WebhookIngestInput): Promise<WebhookIngestResult> {
    // A disabled account still records its callbacks: the processor is what refuses to apply them,
    // so an operator can see the traffic that arrives while the connection is switched off
    // (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.21` kill-switch impact).
    const account = await this.accounts.resolveForProcessing(input.accountKey);
    if (account.providerKey !== input.providerKey) {
      // The routing pair must agree; a mismatched pair is a configuration error, not a provider event.
      throw new NotFoundError(`No provider "${input.providerKey}" is configured for account "${input.accountKey}".`);
    }

    const serialized = input.rawBody ?? JSON.stringify(input.body);
    if (Buffer.byteLength(serialized, "utf8") > WEBHOOK_MAX_BODY_BYTES) {
      throw new ValidationError("The provider callback body is too large.");
    }

    const adapter = this.registry.resolve(account.providerKey);
    if (!adapter.hasCapability("webhook.signatureValidation")) {
      throw new ValidationError(`Provider "${account.providerKey}" does not declare webhook signature validation.`);
    }

    const settings = await this.settings.settings();
    const eventType = stringOf(input.body["type"]) ?? "unknown";
    const providerEventId = stringOf(input.body["eventId"]);

    // Replay window (§13.2). A provider that does not send a timestamp is refused by its adapter, not
    // here; a timestamp that is present but stale is refused before any signature work.
    const timestamp = headerOf(input.headers, ["x-webhook-timestamp", "x-voice-timestamp"]);
    if (timestamp !== undefined) {
      const parsed = Date.parse(timestamp);
      if (Number.isNaN(parsed) || Math.abs(Date.now() - parsed) > settings.webhook.replayWindowSeconds * 1000) {
        const receiptId = await this.persistReceipt({
          accountKey: account.key,
          providerKey: account.providerKey,
          providerEventId,
          // A rejected callback must never occupy the dedup key a later genuine callback needs:
          // otherwise a forged `eventId` would turn the real event into a "duplicate" that is never
          // applied (`19-OM.22` receipt-poisoning fix).
          dedupKey: rejectedDedupKey(input.body),
          eventType,
          signatureValid: false,
          status: "rejected",
          failureCode: "REPLAY_WINDOW",
          failureDetail: "The callback timestamp is outside the configured replay window.",
          body: input.body,
        });
        throw new AuthenticationFailedError(`Provider callback rejected: ${receiptId}.`);
      }
    }

    let validated;
    try {
      validated = await adapter.validateWebhook(
        {
          headers: input.headers,
          body: input.body,
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.rawBody !== undefined ? { rawBody: input.rawBody } : {}),
        },
        account,
      );
    } catch (error) {
      const category = error instanceof VoiceProviderError ? error.category : "unknown";
      const detail = error instanceof Error ? error.message : "Signature validation failed.";
      await this.persistReceipt({
        accountKey: account.key,
        providerKey: account.providerKey,
        providerEventId,
        dedupKey: rejectedDedupKey(input.body),
        eventType,
        signatureValid: false,
        status: "rejected",
        failureCode: category === "auth" ? "INVALID_SIGNATURE" : "VALIDATION_FAILED",
        failureDetail: detail,
        body: input.body,
      });
      throw new AuthenticationFailedError("Provider callback signature is not valid for this account.");
    }

    // The adapter may have read a vendor-specific body (Twilio sends form parameters, not the
    // generic `type`/`eventId` shape), so the idempotency key is derived from what it authenticated.
    // Recomputing it only after validation also prevents two different Twilio callbacks from sharing
    // the pre-validation "unknown" digest.
    const validatedDedupKey = webhookDedupKey({
      providerEventId: validated.providerEventId,
      eventType: validated.eventType,
      externalId: validated.externalId,
      occurredAt: validated.occurredAt,
    });
    const eventId = await this.persistReceipt({
      accountKey: account.key,
      providerKey: account.providerKey,
      providerEventId: validated.providerEventId,
      dedupKey: validatedDedupKey,
      eventType: validated.eventType,
      signatureValid: true,
      status: "received",
      failureCode: null,
      failureDetail: null,
      body: validated.payload,
      internalPayload: validated.payload,
    });
    if (eventId === null) {
      // The unique constraint answered: this callback was already recorded. No second job, no second
      // communication event (§15 `19-VC.5` acceptance "duplicate callbacks do not duplicate records").
      const existing = (await sql<{ id: string; processing_status: string; payload_digest: string | null }>`
        select id, processing_status, payload_digest from voice_webhook_events
        where account_key = ${account.key} and dedup_key = ${validatedDedupKey}
      `.execute(this.database.db)).rows[0];
      // G19 — a redelivery under a known key with a *different* body is a duplicate to the provider
      // (the stored delivery is kept, no second effect), but it is not a silent duplicate: the
      // mismatch is stamped on the receipt so an operator can question why one event id carries two
      // bodies. The genuine receipt and its processing state are never touched.
      if (existing === undefined) {
        // The unique index that refused the insert guarantees a row; a missing one is a broken
        // invariant, not a duplicate to acknowledge.
        throw new Error("The duplicate voice receipt could not be read.");
      }
      const receivedDigest = payloadDigest(validated.payload);
      // A receipt written before digests were mandatory has nothing to compare; null is unknown,
      // not a mismatch.
      const bodyMismatch = existing.payload_digest !== null && existing.payload_digest !== receivedDigest;
      if (bodyMismatch) {
        await sql`
          update voice_webhook_events
          set failure_code = 'DEDUP_BODY_MISMATCH',
              failure_detail = ${"A redelivery under this key carried a different body; the stored delivery was kept."}
          where id = ${existing.id}
        `.execute(this.database.db);
      }
      return {
        eventId: existing.id,
        duplicate: true,
        accepted: true,
        processingStatus: existing.processing_status,
        ...(bodyMismatch ? { bodyMismatch: true } : {}),
      };
    }

    try {
      await this.jobs.enqueue({ job: VOICE_JOB_PROCESS_WEBHOOK, data: { eventId } });
    } catch (error) {
      // The receipt is durable, so the event is not lost; it is visible as work that needs a replay.
      await sql`
        update voice_webhook_events
        set processing_status = 'enqueue_failed',
            failure_code = 'ENQUEUE_FAILED',
            failure_detail = ${error instanceof Error ? error.message : "Could not enqueue processing."}
        where id = ${eventId}
      `.execute(this.database.db);
      return {
        eventId,
        duplicate: false,
        accepted: true,
        processingStatus: "enqueue_failed",
        reason: "The event was recorded but could not be queued; an operator can replay it.",
      };
    }

    return { eventId, duplicate: false, accepted: true, processingStatus: "received" };
  }

  async list(query: {
    readonly status?: string | undefined;
    readonly accountKey?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly list: readonly ReceiptSummary[]; readonly total: number }> {
    const rows = await sql<ReceiptRow>`
      select * from voice_webhook_events
      where (${query.status ?? null}::text is null or processing_status = ${query.status ?? null})
        and (${query.accountKey ?? null}::text is null or account_key = ${query.accountKey ?? null})
      order by received_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    const counted = (await sql<{ total: number }>`
      select count(*)::int as total from voice_webhook_events
      where (${query.status ?? null}::text is null or processing_status = ${query.status ?? null})
        and (${query.accountKey ?? null}::text is null or account_key = ${query.accountKey ?? null})
    `.execute(this.database.db)).rows[0];
    return { list: rows.rows.map(toReceiptSummary), total: Number(counted?.total ?? 0) };
  }

  async get(eventId: string): Promise<ReceiptSummary & { readonly payload: unknown }> {
    const row = (await sql<ReceiptRow & { payload_redacted: unknown }>`
      select * from voice_webhook_events where id = ${eventId}
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Webhook event "${eventId}" does not exist.`);
    return { ...toReceiptSummary(row), payload: row.payload_redacted };
  }

  /**
   * Requeue a failed or rejected receipt for processing. The communication-event unique constraint is
   * what makes a replay safe: processing twice cannot create a second normalized event.
   */
  async replay(eventId: string): Promise<{ readonly eventId: string; readonly queued: boolean }> {
    const row = (await sql<ReceiptRow>`select * from voice_webhook_events where id = ${eventId}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Webhook event "${eventId}" does not exist.`);
    if (!row.signature_valid) {
      throw new ValidationError("A callback that failed signature validation cannot be replayed.");
    }
    await sql`
      update voice_webhook_events
      set processing_status = 'received', failure_code = null, failure_detail = null, processed_at = null
      where id = ${eventId}
    `.execute(this.database.db);
    try {
      await this.jobs.enqueue({ job: VOICE_JOB_PROCESS_WEBHOOK, data: { eventId } });
      return { eventId, queued: true };
    } catch {
      await sql`
        update voice_webhook_events set processing_status = 'enqueue_failed', failure_code = 'ENQUEUE_FAILED'
        where id = ${eventId}
      `.execute(this.database.db);
      return { eventId, queued: false };
    }
  }

  /** `null` means the receipt already existed (the unique constraint refused the insert). */
  private async persistReceipt(input: {
    readonly accountKey: string;
    readonly providerKey: string;
    readonly providerEventId: string | null;
    readonly dedupKey: string;
    readonly eventType: string;
    readonly signatureValid: boolean;
    readonly status: string;
    readonly failureCode: string | null;
    readonly failureDetail: string | null;
    readonly body: Record<string, unknown>;
    /** The authenticated payload the worker normalizes; never stored for a rejected callback. */
    readonly internalPayload?: Record<string, unknown> | undefined;
  }): Promise<string | null> {
    const id = randomUUID();
    const inserted = (await sql<{ id: string }>`
      insert into voice_webhook_events
        (id, account_key, provider_key, vendor_event_id, dedup_key, event_type,
         signature_valid, processing_status, failure_code, failure_detail, payload_digest,
         payload_redacted, payload_internal, received_at)
      values
        (${id}, ${input.accountKey}, ${input.providerKey}, ${input.providerEventId},
         ${input.dedupKey}, ${input.eventType}, ${input.signatureValid}, ${input.status},
         ${input.failureCode}, ${input.failureDetail}, ${payloadDigest(input.body)},
         ${JSON.stringify(redactPayload(input.body))}::jsonb,
         ${input.internalPayload === undefined ? null : JSON.stringify(input.internalPayload)}::jsonb, now())
      on conflict (account_key, dedup_key) do nothing
      returning id
    `.execute(this.database.db)).rows[0];
    return inserted?.id ?? null;
  }
}

/**
 * A rejected callback's key is derived from its own body and namespaced: it can deduplicate retries
 * of the same forged request, but it can never collide with a genuine event's key.
 */
function rejectedDedupKey(body: Record<string, unknown>): string {
  return `rejected:${payloadDigest(body)}`;
}

export interface ReceiptSummary {
  readonly id: string;
  readonly accountKey: string;
  readonly providerKey: string;
  readonly vendorEventId: string | null;
  readonly eventType: string;
  readonly signatureValid: boolean;
  readonly processingStatus: string;
  readonly attempts: number;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

function toReceiptSummary(row: ReceiptRow): ReceiptSummary {
  return {
    id: row.id,
    accountKey: row.account_key,
    providerKey: row.provider_key,
    vendorEventId: row.vendor_event_id,
    eventType: row.event_type,
    signatureValid: row.signature_valid,
    processingStatus: row.processing_status,
    attempts: row.attempts,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    receivedAt: new Date(row.received_at).toISOString(),
    processedAt: row.processed_at === null ? null : new Date(row.processed_at).toISOString(),
  };
}

function headerOf(headers: Readonly<Record<string, string | undefined>>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
