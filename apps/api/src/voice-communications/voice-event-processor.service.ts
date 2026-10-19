import { randomUUID } from "node:crypto";

import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EventBus } from "../events/event-bus.js";
import { VoiceCallService } from "./voice-call.service.js";
import { runAsVoiceSystem } from "./voice-communications-authority.js";
import {
  callEventFor,
  type MessageChannel,
  messageEventFor,
  type ProviderEventKind,
  type VoiceDomainEvent,
} from "./voice-communications-domain.js";
import { WEBHOOK_MAX_ATTEMPTS } from "./voice-communications-jobs.js";
import { VoiceMediaService } from "./voice-media.service.js";
import { VoiceMessagingService } from "./voice-messaging.service.js";
import {
  type NormalizedProviderEvent,
  type ValidatedProviderEvent,
  VoiceProviderRegistry,
} from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";

/**
 * Phase 19-VC.5 — durable provider-event processing
 * (`PLAN_Phase_19_Voice_Communications.md` §4.3, §11.4, §15 `19-VC.5`).
 *
 * The receipt is the durable fact; this service turns it into a **normalized communication event**
 * exactly once. Two constraints make that structural rather than hopeful:
 *
 *  - `voice_communication_events.webhook_event_id` is unique, so a replayed job cannot create a
 *    second normalized event.
 *  - the domain event is emitted inside the same database transaction as that insert, through the
 *    platform outbox (`EventBus`), so "recorded" and "announced" cannot diverge.
 *
 * A provider event for a **disabled** account is recorded and marked processed with an explanation,
 * but emits no domain event: nothing downstream may act on a provider an operator switched off
 * (§15 `19-VC.4` acceptance). Call/message record materialization is 19-VC.7/19-VC.10; this phase
 * owns the normalized event and its announcement.
 */

export interface ProcessResult {
  readonly eventId: string;
  readonly status: "processed" | "duplicate" | "skipped" | "failed";
  readonly kind: ProviderEventKind;
  readonly normalizedEventId?: string | undefined;
  readonly reason?: string | undefined;
}

interface ReceiptRow {
  id: string;
  account_key: string;
  provider_key: string;
  vendor_event_id: string | null;
  event_type: string;
  signature_valid: boolean;
  processing_status: string;
  attempts: number;
  payload_redacted: unknown;
}

@Injectable()
export class VoiceEventProcessorService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(VoiceCallService) private readonly calls: VoiceCallService,
    @Inject(VoiceMessagingService) private readonly messaging: VoiceMessagingService,
    @Inject(VoiceMediaService) private readonly media: VoiceMediaService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async process(eventId: string): Promise<ProcessResult> {
    const row = (await sql<ReceiptRow>`select * from voice_webhook_events where id = ${eventId}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Webhook event "${eventId}" does not exist.`);
    if (row.processing_status === "processed") {
      return { eventId, status: "duplicate", kind: "unknown", reason: "already processed" };
    }
    if (!row.signature_valid) {
      await this.markRejected(eventId, "SIGNATURE_INVALID", "The callback failed signature validation.");
      return { eventId, status: "skipped", kind: "unknown", reason: "signature invalid" };
    }

    try {
      // The webhook has no logged-in principal, so the whole processing step runs under the module's
      // documented service identity (§9.2) — the same door Marketing Automation's provider webhook uses.
      return await runAsVoiceSystem<ProcessResult>(this.scope, eventId, async () => {
        const account = await this.accounts.resolveForProcessing(row.account_key);
        const adapter = this.registry.resolve(account.providerKey);
        const payload = parseObject(row.payload_redacted);
        const validated: ValidatedProviderEvent = {
          providerEventId: row.vendor_event_id,
          eventType: row.event_type,
          kind: kindOf(row.event_type),
          occurredAt: stringOf(payload["occurredAt"]),
          externalId: stringOf(payload["callId"]) ?? stringOf(payload["messageId"]),
          vendorStatus: stringOf(payload["status"]),
          payload,
        };
        const normalized = adapter.normalizeEvent(validated, account);

        const normalizedEventId = await this.persistNormalized(row, normalized);
        if (normalizedEventId === null) {
          // Another attempt won the unique constraint: the event exists, so this one is a duplicate.
          await this.markProcessed(eventId);
          return { eventId, status: "duplicate", kind: normalized.kind };
        }

        // VC.7: a call event reconciles the logical session and its Call Activity before the domain
        // event is announced, so a consumer that reloads the call always sees the stored state.
        if (normalized.kind === "call" && account.enabled) {
          await this.calls.applyCallEvent({
            accountKey: account.key,
            providerCallId: normalized.providerCallId,
            event: {
              state: normalized.state,
              direction: normalized.direction,
              from: normalized.from,
              to: normalized.to,
              occurredAt: normalized.occurredAt,
              durationSeconds: normalized.durationSeconds,
              failureCategory: normalized.failureCategory,
              vendorStatus: normalized.vendorStatus,
            },
          });
        }

        // VC.10: an inbound message creates one conversation row and one message row; a status
        // callback advances an existing message without ever inventing delivery.
        if (normalized.kind === "message" && account.enabled) {
          if (normalized.direction === "inbound") {
            await this.messaging.ingestInbound({ accountKey: account.key, event: normalized });
          } else if (normalized.providerMessageId !== null) {
            await this.messaging.applyStatus({
              accountKey: account.key,
              providerMessageId: normalized.providerMessageId,
              state: normalized.state,
              occurredAt: normalized.occurredAt,
              failureCategory: normalized.failureCategory,
            });
          }
        }
        if (normalized.kind === "status" && account.enabled && normalized.externalId !== null) {
          // A status event may belong to a message; `applyStatus` ignores an unknown id.
          await this.messaging.applyStatus({
            accountKey: account.key,
            providerMessageId: normalized.externalId,
            state: normalized.state as never,
            occurredAt: normalized.occurredAt,
            failureCategory: normalized.failureCategory,
          });
        }

        // VC.15: a recording callback registers the media reference. Nothing is fetched here; the
        // media service decides whether the configured policy allows a private-storage copy.
        if (normalized.kind === "recording" && account.enabled) {
          await this.media.ingestRecording({ accountKey: account.key, event: normalized });
        }

        if (account.enabled) {
          const domainEvent = domainEventFor(normalized);
          if (domainEvent !== null) {
            await this.events.dispatch(this.database.db, {
              type: domainEvent,
              payload: {
                webhookEventId: eventId,
                normalizedEventId,
                accountKey: account.key,
                providerKey: account.providerKey,
                kind: normalized.kind,
                ...(normalized.kind === "call"
                  ? {
                      providerCallId: normalized.providerCallId,
                      state: normalized.state,
                      direction: normalized.direction,
                      from: normalized.from,
                      to: normalized.to,
                    }
                  : {}),
                ...(normalized.kind === "message"
                  ? {
                      providerMessageId: normalized.providerMessageId,
                      state: normalized.state,
                      direction: normalized.direction,
                      channel: normalized.channel,
                    }
                  : {}),
                ...(normalized.kind === "status"
                  ? { externalId: normalized.externalId, state: normalized.state }
                  : {}),
              },
            });
          }
        }

        await this.markProcessed(eventId);
        return { eventId, status: "processed", kind: normalized.kind, normalizedEventId };
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= WEBHOOK_MAX_ATTEMPTS;
      await sql`
        update voice_webhook_events
        set processing_status = ${dead ? "failed" : "received"},
            attempts = ${attempts},
            failure_code = 'PROCESSING_FAILED',
            failure_detail = ${error instanceof Error ? error.message : "Processing failed."}
        where id = ${eventId}
      `.execute(this.database.db);
      return {
        eventId,
        status: "failed",
        kind: "unknown",
        reason: dead ? "processing failed and the receipt is a dead letter" : "processing failed; retryable",
      };
    }
  }

  /** Returns `null` when the unique constraint says this receipt already produced an event. */
  private async persistNormalized(row: ReceiptRow, normalized: NormalizedProviderEvent): Promise<string | null> {
    const id = randomUUID();
    const inserted = (await sql<{ id: string }>`
      insert into voice_communication_events
        (id, webhook_event_id, account_key, provider_key, kind, state, external_id, direction,
         channel, from_address, to_address, body, occurred_at, payload, created_at)
      values
        (${id}, ${row.id}, ${row.account_key}, ${row.provider_key}, ${normalized.kind},
         ${stateOf(normalized)}, ${externalIdOf(normalized)}, ${directionOf(normalized)},
         ${channelOf(normalized)}, ${fromOf(normalized)}, ${toOf(normalized)}, ${bodyOf(normalized)},
         ${occurredAtOf(normalized)}, ${JSON.stringify(normalized)}::jsonb, now())
      on conflict (webhook_event_id) do nothing
      returning id
    `.execute(this.database.db)).rows[0];
    return inserted?.id ?? null;
  }

  private async markProcessed(eventId: string): Promise<void> {
    await sql`
      update voice_webhook_events
      set processing_status = 'processed', processed_at = now(), failure_code = null, failure_detail = null
      where id = ${eventId}
    `.execute(this.database.db);
  }

  private async markRejected(eventId: string, code: string, detail: string): Promise<void> {
    await sql`
      update voice_webhook_events
      set processing_status = 'rejected', failure_code = ${code}, failure_detail = ${detail}, processed_at = now()
      where id = ${eventId}
    `.execute(this.database.db);
  }
}

function kindOf(eventType: string): ProviderEventKind {
  if (eventType === "call.recording") return "recording";
  if (eventType.startsWith("call.")) return "call";
  if (eventType.startsWith("message.")) return "message";
  if (eventType.includes("status")) return "status";
  return "unknown";
}

function domainEventFor(normalized: NormalizedProviderEvent): VoiceDomainEvent | null {
  if (normalized.kind === "call") return callEventFor(normalized.state);
  if (normalized.kind === "message") {
    if (normalized.direction === "inbound") return "voiceCommunications.message.received";
    return messageEventFor(normalized.state);
  }
  return null;
}

function stateOf(event: NormalizedProviderEvent): string | null {
  return event.kind === "unknown" || event.kind === "recording" ? null : event.state;
}

function externalIdOf(event: NormalizedProviderEvent): string | null {
  switch (event.kind) {
    case "call":
      return event.providerCallId;
    case "message":
      return event.providerMessageId;
    case "status":
      return event.externalId;
    case "recording":
      return event.providerCallId;
    case "unknown":
      return null;
  }
}

function directionOf(event: NormalizedProviderEvent): string | null {
  return event.kind === "call" || event.kind === "message" ? event.direction : null;
}

function channelOf(event: NormalizedProviderEvent): MessageChannel | null {
  return event.kind === "message" ? event.channel : null;
}

function fromOf(event: NormalizedProviderEvent): string | null {
  return event.kind === "call" || event.kind === "message" ? event.from : null;
}

function toOf(event: NormalizedProviderEvent): string | null {
  return event.kind === "call" || event.kind === "message" ? event.to : null;
}

function bodyOf(event: NormalizedProviderEvent): string | null {
  return event.kind === "message" ? event.body : null;
}

function occurredAtOf(event: NormalizedProviderEvent): string | null {
  return event.occurredAt;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
