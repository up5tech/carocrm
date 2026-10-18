import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";

/**
 * Phase 19-MA.16 — cross-module integration (§15 `19-MA.16`).
 *
 * Marketing Automation never imports Sales/CustomerSuccess/ServiceDesk/Portal. Optional modules are
 * detected by metadata marker, and every cross-module action goes through this service so that
 * consent, ACL and idempotency rules stay in one place.
 */
export interface AttributionInput {
  readonly campaignId?: string | undefined;
  readonly sendId?: string | undefined;
  readonly journeyId?: string | undefined;
  readonly outcome: string;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface CrossModuleEventInput {
  readonly eventType: string;
  readonly sourceModule: string;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly emailHash?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
  readonly causationDepth?: number | undefined;
  readonly correlationId?: string | undefined;
}

@Injectable()
export class MarketingIntegrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MarketingAutomationModuleHealthService) private readonly health: MarketingAutomationModuleHealthService,
    @Inject(MarketingConsentService) private readonly consent: MarketingConsentService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Record a campaign outcome without duplicating Sales financial data (reference only). */
  async recordAttribution(input: AttributionInput): Promise<{ id: string }> {
    const id = randomUUID();
    await sql`
      insert into marketing_events
        (id, provider, provider_event_id, event_type, normalized_type,
         campaign_id, send_id, recipient_entity_type, recipient_entity_id, properties)
      values
        (${id}, 'internal', ${input.correlationId ?? null}, 'attribution', 'conversion',
         ${input.campaignId ?? null}, ${input.sendId ?? null}, ${input.referenceType ?? null},
         ${input.referenceId ?? null}, ${JSON.stringify({ outcome: input.outcome, journeyId: input.journeyId ?? null })}::jsonb)
    `.execute(this.database.db);
    return { id };
  }

  /** Whether an optional module is available (metadata-marker based). */
  async isModuleAvailable(id: string): Promise<boolean> {
    const h = await this.health.health();
    const view = h.optionalIntegrations.find((i: { id: string; status: string }) => i.id === id);
    return view?.status === "available";
  }

  /**
   * Handle a cross-module event. Only whitelisted events are accepted; service activity never
   * silently enrolls a contact into promotional messaging — enrollment requires a published
   * journey plus an explicit consented opt-in.
   */
  async handleCrossModuleEvent(input: CrossModuleEventInput): Promise<{ accepted: boolean; reason?: string }> {
    const whitelisted = [
      "entity.created",
      "entity.updated",
      "serviceDesk.case.statusChanged",
      "customerSuccess.health.statusChanged",
      "sales.opportunity.stageChanged",
    ];
    if (!whitelisted.includes(input.eventType)) {
      return { accepted: false, reason: "EVENT_NOT_WHITELISTED" };
    }
    const depth = input.causationDepth ?? 0;
    if (depth > 3) {
      return { accepted: false, reason: "CAUSATION_DEPTH_EXCEEDED" };
    }
    // Record the event as a normalized marketing event for audit/trace; no enrollment happens here.
    const id = randomUUID();
    await sql`
      insert into marketing_events
        (id, provider, provider_event_id, event_type, normalized_type, campaign_id, properties)
      values
        (${id}, ${input.sourceModule}, ${input.correlationId ?? null}, ${input.eventType}, 'provider_event',
         null, ${JSON.stringify(input.payload ?? {})}::jsonb)
    `.execute(this.database.db);
    return { accepted: true };
  }

  /** Portal users may only affect their own preferences (contactId from the portal scope). */
  async portalPreferenceUpdate(input: { readonly consent: boolean; readonly purpose?: string }): Promise<{ status: string }> {
    const contactId = this.scope.principal?.contactId;
    if (contactId === undefined) {
      throw new Error("Portal scope required.");
    }
    // Resolve the contact's email from the entity record.
    const row = await sql<{ attrs: Record<string, unknown> }>`
      select attrs from entity_records where id = ${contactId} and entity_type = 'Contact' and deleted_at is null limit 1
    `.execute(this.database.db);
    const attrs = row.rows[0]?.attrs ?? {};
    const email = typeof attrs["emailAddress"] === "string" ? (attrs["emailAddress"] as string) : null;
    if (email === null) throw new Error("Contact has no email.");
    const result = await this.consent.record({
      emailAddress: email,
      channel: "Email" as never,
      purpose: (input.purpose ?? "ProductMarketing") as never,
      to: (input.consent ? "Consented" : "OptedOut") as never,
      basis: "ExplicitOptIn",
      source: "PreferenceCenter" as never,
    });
    return { status: result.consent.status };
  }
}
