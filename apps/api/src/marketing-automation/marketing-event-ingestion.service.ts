import { createHash, randomUUID , timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import { type SuppressionReason } from "./marketing-automation-domain.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";

export type NormalizedMarketingEventType =
  | "delivered"
  | "soft_bounce"
  | "hard_bounce"
  | "complaint"
  | "unsubscribed"
  | "opened"
  | "clicked"
  | "rejected"
  | "deferred"
  | "provider_error";

const EVENT_TYPE_MAP: Record<string, NormalizedMarketingEventType> = {
  delivered: "delivered",
  delivery: "delivered",
  bounce: "hard_bounce",
  hard_bounce: "hard_bounce",
  hardbounce: "hard_bounce",
  soft_bounce: "soft_bounce",
  softbounce: "soft_bounce",
  complaint: "complaint",
  spam_complaint: "complaint",
  unsubscribe: "unsubscribed",
  unsubscribed: "unsubscribed",
  open: "opened",
  opened: "opened",
  click: "clicked",
  clicked: "clicked",
  rejected: "rejected",
  deferred: "deferred",
  error: "provider_error",
};

function normalizeEventType(raw: string): NormalizedMarketingEventType {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return EVENT_TYPE_MAP[key] ?? "provider_error";
}

export interface WebhookIngestInput {
  readonly provider: string;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly secret: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface WebhookIngestResult {
  readonly inboxId: string;
  readonly duplicate: boolean;
  readonly normalizedType: NormalizedMarketingEventType;
  readonly processingStatus: string;
}

@Injectable()
export class MarketingEventIngestionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MarketingSuppressionService) private readonly suppression: MarketingSuppressionService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  verifySignature(provided: string | undefined, expected: string | undefined): boolean {
    if (provided === undefined || expected === undefined) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async ingest(input: WebhookIngestInput): Promise<WebhookIngestResult> {
    const payload = input.payload ?? {};
    const providerEventId = stringField(payload, "eventId") ?? stringField(payload, "id") ?? null;
    const eventTypeRaw = stringField(payload, "type") ?? stringField(payload, "eventType") ?? "provider_error";
    const normalized = normalizeEventType(eventTypeRaw);
    const providerMessageId =
      stringField(payload, "providerMessageId") ??
      stringField(payload, "messageId") ??
      null;
    const campaignId = stringField(payload, "campaignId") ?? null;
    const sendId = stringField(payload, "sendId") ?? null;
    const slot = numberField(payload, "slot");
    const recipientEntityType = stringField(payload, "recipientEntityType") ?? stringField(payload, "entityType") ?? null;
    const recipientEntityId = stringField(payload, "recipientEntityId") ?? stringField(payload, "entityId") ?? null;
    const emailHash = stringField(payload, "emailHash") ?? null;
    const occurredAt = stringField(payload, "occurredAt") ?? null;
    const url = stringField(payload, "url") ?? null;

    const dedupKey =
      providerEventId !== null
        ? providerEventId
        : `${eventTypeRaw}:${providerMessageId ?? ""}:${recipientEntityId ?? ""}:${occurredAt ?? ""}`;

    const now = new Date();
    if (input.timestamp !== undefined) {
      const ts = Date.parse(input.timestamp);
      if (!Number.isNaN(ts) && Math.abs(now.getTime() - ts) > 5 * 60 * 1000) {
        throw new Error("Webhook timestamp outside replay window.");
      }
    }

    // Verification precedes trust (§9.4, §15 `19-MA.10`): with no configured secret there is nothing
    // to verify against, and a shared default would be a public constant anyone could sign with.
    //
    // It also precedes the dedup lookup. A delivery is only a *replay* once it has proved it is the
    // delivery that was seen before; a forged delivery that reuses a known key must be refused, not
    // answered "already have it" — otherwise anybody could probe the inbox with a key they guessed.
    const configured = typeof input.secret === "string" && input.secret.trim() !== "";
    const signatureValid = configured && this.verifySignature(input.signature, input.secret);

    if (!signatureValid) {
      // A rejected delivery is evidence, so it is recorded — under a key of its own. A rejection must
      // never occupy the key of the genuine delivery it pretended to be, or the genuine delivery
      // would be dropped as a duplicate afterwards.
      const rejectionId = randomUUID();
      const recorded = await sql<{ id: string }>`
        insert into marketing_provider_webhook_inbox
          (id, provider, provider_event_id, dedup_key, event_type, signature_valid,
           processing_status, failure_reason, normalized_event_type)
        values
          (${rejectionId}, ${input.provider}, ${providerEventId}, ${rejectedKey(input.provider, dedupKey, payload)},
           ${eventTypeRaw}, false, 'rejected',
           ${configured ? "INVALID_SIGNATURE" : "SECRET_NOT_CONFIGURED"}, ${normalized})
        on conflict (provider, dedup_key) do nothing
        returning id
      `.execute(this.database.db);
      // The same forged body twice records one row: the second refusal reuses it.
      let rejection = recorded.rows[0]?.id ?? rejectionId;
      if (recorded.rows.length === 0) {
        const existing = await sql<{ id: string }>`
          select id from marketing_provider_webhook_inbox
          where provider = ${input.provider} and dedup_key = ${rejectedKey(input.provider, dedupKey, payload)}
          limit 1
        `.execute(this.database.db);
        rejection = existing.rows[0]?.id ?? rejection;
      }
      return {
        inboxId: rejection,
        duplicate: false,
        normalizedType: normalized,
        processingStatus: "rejected",
      };
    }

    // The claim is atomic. A SELECT followed by an INSERT lets two concurrent deliveries of the same
    // event both decide they are the first, and the loser takes a unique violation (a 500 to the
    // provider). `on conflict do nothing` makes the insert itself the decision, and the row that
    // survives is the one everybody agrees on.
    const inboxId = randomUUID();
    const claimed = await sql<{ id: string }>`
      insert into marketing_provider_webhook_inbox
        (id, provider, provider_event_id, dedup_key, event_type, signature_valid,
         processing_status, normalized_event_type, campaign_id, send_id,
         provider_message_id, recipient_entity_type, recipient_entity_id, raw_summary)
      values
        (${inboxId}, ${input.provider}, ${providerEventId}, ${dedupKey}, ${eventTypeRaw},
         true, 'processing', ${normalized}, ${campaignId}, ${sendId},
         ${providerMessageId}, ${recipientEntityType}, ${recipientEntityId},
         ${JSON.stringify(redactPayload(payload))}::jsonb)
      on conflict (provider, dedup_key) do nothing
      returning id
    `.execute(this.database.db);

    if (claimed.rows.length === 0) {
      // Somebody already has this event. The answer is a safe acknowledgement, not a second effect.
      const existing = await sql<{ id: string; processing_status: string; normalized_event_type: string | null }>`
        select id, processing_status, normalized_event_type
        from marketing_provider_webhook_inbox
        where provider = ${input.provider} and dedup_key = ${dedupKey}
        limit 1
      `.execute(this.database.db);
      const found = existing.rows[0];
      return {
        inboxId: found?.id ?? inboxId,
        duplicate: true,
        normalizedType: (found?.normalized_event_type as NormalizedMarketingEventType) ?? normalized,
        processingStatus: found?.processing_status ?? "processing",
      };
    }

    const eventId = randomUUID();
    // `uq_marketing_events_inbox` (migration 042) is a *partial* index, and PostgreSQL only infers a
    // partial index when the conflict target repeats its predicate — without the `where`, this insert
    // fails with 42P10 and no provider event is ever recorded.
    await sql`
      insert into marketing_events
        (id, inbox_id, provider, provider_event_id, event_type, normalized_type,
         occurred_at, campaign_id, send_id, slot, provider_message_id,
         recipient_entity_type, recipient_entity_id, email_hash, url, properties)
      values
        (${eventId}, ${inboxId}, ${input.provider}, ${providerEventId}, ${eventTypeRaw}, ${normalized},
         ${occurredAt}, ${campaignId}, ${sendId}, ${slot}, ${providerMessageId},
         ${recipientEntityType}, ${recipientEntityId}, ${emailHash}, ${url},
         ${JSON.stringify({})}::jsonb)
      on conflict (inbox_id) where inbox_id is not null do nothing
    `.execute(this.database.db);

    // The webhook has no logged-in principal, so the suppression feedback runs under the module's
    // documented service identity (§9.2) — the same door the public unsubscribe uses. Without it a hard
    // bounce or complaint would be *recorded* and never *applied*, which is the one thing MA.10 must not
    // do (§15 acceptance: "hard bounce and complaint policy blocks subsequent marketing sends").
    let sideEffectFailure: string | null = null;
    try {
      await runAsMarketingSystem(this.scope, "providerWebhookSideEffects", () =>
        this.applySideEffects(normalized, {
          provider: input.provider,
          providerMessageId,
          recipientEntityType,
          recipientEntityId,
          emailHash,
          sendId,
          slot: slot ?? 1,
        }),
      );
    } catch (error) {
      // Recorded on the inbox row rather than thrown: the provider would retry, hit the dedupe key and
      // never reprocess, so the durable answer is "processed with errors" plus the reason.
      sideEffectFailure = error instanceof Error ? error.message : "Side effect failed.";
    }

    await sql`
      update marketing_provider_webhook_inbox
      set processing_status = ${sideEffectFailure === null ? "processed" : "processed_with_errors"},
          failure_reason = ${sideEffectFailure},
          processed_at = now()
      where id = ${inboxId}
    `.execute(this.database.db);

    return {
      inboxId,
      duplicate: false,
      normalizedType: normalized,
      processingStatus: sideEffectFailure === null ? "processed" : "processed_with_errors",
    };
  }

  private async applySideEffects(
    normalized: NormalizedMarketingEventType,
    ctx: {
      provider: string;
      providerMessageId: string | null;
      recipientEntityType: string | null;
      recipientEntityId: string | null;
      emailHash: string | null;
      sendId: string | null;
      slot: number;
    },
  ): Promise<void> {
    if (ctx.sendId !== null && ctx.recipientEntityType !== null && ctx.recipientEntityId !== null) {
      const stateMap: Partial<Record<NormalizedMarketingEventType, string>> = {
        delivered: "Delivered",
        hard_bounce: "Bounced",
        complaint: "Complained",
        unsubscribed: "Unsubscribed",
      };
      const target = stateMap[normalized];
      if (target !== undefined) {
        await sql`
          update marketing_recipient_deliveries
          set state = ${target},
              updated_at = now()
          where send_id = ${ctx.sendId}
            and slot = ${ctx.slot}
            and entity_type = ${ctx.recipientEntityType}
            and entity_id = ${ctx.recipientEntityId}
            and state in ('Sent', 'Sending', 'Delivered', 'Bounced', 'Complained')
            and not (state = 'Bounced' and ${target} = 'Delivered')
        `.execute(this.database.db);
      }
    }

    if (normalized === "hard_bounce" || normalized === "complaint" || normalized === "unsubscribed") {
      const reason =
        normalized === "hard_bounce"
          ? "HardBounce"
          : normalized === "complaint"
            ? "Complaint"
            : "GlobalOptOut";
      const emailHash = ctx.emailHash;
      if (emailHash !== null) {
        // Not swallowed: the caller records the failure on the inbox row, so a block that could not be
        // applied is visible to an operator instead of looking like a delivered event.
        await this.suppression.add({
          emailHash,
          scope: "Global",
          reason: reason as SuppressionReason,
          source: "ProviderWebhook",
          provider: ctx.provider,
        });
      }
    }
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (/secret|token|password|signature/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The key a **rejected** delivery is recorded under.
 *
 * A rejection must never occupy the key of the delivery it pretended to be: if it did, the genuine
 * delivery would arrive afterwards, find its key taken and be dropped as a duplicate. So the
 * rejection lives in its own namespace, keyed by the payload it carried — the same anti-poisoning
 * rule the voice ingress uses (`voice-communications-domain.ts`).
 */
function rejectedKey(
  provider: string,
  dedupKey: string,
  payload: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(`${provider}|${dedupKey}|${JSON.stringify(redactPayload(payload))}`)
    .digest("hex");
  return `rejected:${digest}`;
}
