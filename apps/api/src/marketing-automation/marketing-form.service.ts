import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { MARKETING_SYSTEM_PRINCIPAL , runAsMarketingSystem } from "./marketing-automation-authority.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingJourneyRuntimeService } from "./marketing-journey-runtime.service.js";

export interface MarketingFormSubmissionInput {
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly email: string;
  readonly company?: string | undefined;
  readonly consent: boolean;
  readonly campaignId?: string | undefined;
  readonly journeyId?: string | undefined;
  readonly journeyVersionId?: string | undefined;
  readonly source?: string | undefined;
  readonly utmSource?: string | undefined;
  readonly utmMedium?: string | undefined;
  readonly utmCampaign?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly honeypot?: string | undefined;
  readonly clientIp?: string | undefined;
}

export interface MarketingFormSubmissionResult {
  readonly created: boolean;
  readonly duplicate: boolean;
  readonly leadId: string | null;
  readonly consentStatus: string;
  readonly enrolled: boolean;
}

@Injectable()
export class MarketingFormService {
  private readonly ipHits = new Map<string, number[]>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(MarketingConsentService) private readonly consent: MarketingConsentService,
    @Inject(MarketingJourneyRuntimeService) private readonly runtime: MarketingJourneyRuntimeService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async submit(input: MarketingFormSubmissionInput): Promise<MarketingFormSubmissionResult> {
    // Honeypot.
    if (typeof input.honeypot === "string" && input.honeypot.trim() !== "") {
      return { created: false, duplicate: false, leadId: null, consentStatus: "Unknown", enrolled: false };
    }

    const email = input.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ValidationError("Invalid email address.", { field: "email" });
    }
    const firstName = (input.firstName ?? "").trim().slice(0, 100);
    const lastName = (input.lastName ?? "").trim().slice(0, 100);
    if (firstName === "" && lastName === "") {
      throw new ValidationError("A name is required.", { field: "name" });
    }

    // Rate limit per IP (10 per minute).
    const ip = input.clientIp ?? "unknown";
    const now = Date.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) {
      throw new ValidationError("Too many requests. Please try again later.");
    }
    hits.push(now);
    this.ipHits.set(ip, hits);

    // Idempotency.
    const key = input.idempotencyKey?.trim();
    if (key !== undefined && key !== "") {
      const existing = await this.database.db
        .selectFrom("entity_records")
        .select("attrs")
        .where("entity_type", "=", "Lead")
        .where("deleted_at", "is", null)
        .where(sql`attrs ->> 'formIntakeKey'`, "=", key)
        .executeTakeFirst();
      if (existing !== undefined) {
        const a = (existing.attrs ?? {}) as Record<string, unknown>;
        return {
          created: false,
          duplicate: true,
          leadId: typeof a["id"] === "string" ? (a["id"] as string) : null,
          consentStatus: "Unknown",
          enrolled: false,
        };
      }
    }

    // Dedup by email (best-effort: reuse an existing Lead with the same email).
    const existingLead = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "Lead")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'emailAddress'`, "=", email)
      .executeTakeFirst();
    const reused = existingLead !== undefined;
    const leadId = reused ? String(existingLead.id) : await this.createLead({
      firstName,
      lastName,
      email,
      company: input.company,
      source: input.source ?? "Web Form",
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      campaignId: input.campaignId,
      key,
    });

    // Consent capture (versioned, only when the person opted in).
    let consentStatus = "Unknown";
    if (input.consent) {
      try {
        const result = await this.consent.record({
          emailAddress: email,
          channel: "Email" as never,
          purpose: "ProductMarketing" as never,
          to: "Consented" as never,
          basis: "ExplicitOptIn",
          source: "WebForm" as never,
          policyVersion: "1",
          captureContext: `form:${input.source ?? "web"}`,
          ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
          ...(leadId !== null ? { leadId, subjectType: "Lead", subjectId: leadId } : {}),
          ...(key !== undefined && key !== "" ? { idempotencyKey: key } : {}),
        });
        consentStatus = result.consent.status;
      } catch {
        consentStatus = "Unknown";
      }
    }

    // Optional journey enrollment — only under consent.
    let enrolled = false;
    if (input.consent && input.journeyId !== undefined && input.journeyVersionId !== undefined) {
      try {
        const graph = await this.runtime.versionGraph(input.journeyVersionId);
        if (graph !== undefined) {
          const dedupeKey = `form:${email}`;
          const result = await this.runtime.enroll({
            journeyId: input.journeyId,
            versionId: input.journeyVersionId,
            version: 1,
            graph,
            personType: "Lead",
            personId: leadId ?? undefined,
            source: "Form",
            dedupeKey,
          });
          enrolled = !result.duplicate;
        }
      } catch {
        enrolled = false;
      }
    }

    return {
      created: !reused,
      duplicate: reused,
      leadId,
      consentStatus,
      enrolled,
    };
  }

  private async createLead(input: {
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly company?: string | undefined;
    readonly source: string;
    readonly utmSource?: string | undefined;
    readonly utmMedium?: string | undefined;
    readonly utmCampaign?: string | undefined;
    readonly campaignId?: string | undefined;
    readonly key?: string | undefined;
  }): Promise<string> {
    const created = await this.scope.runAs(MARKETING_SYSTEM_PRINCIPAL, async () =>
      runAsMarketingSystem(this.scope, "formLeadCreate", async () =>
        this.entities.create("Lead", {
          name: `${input.firstName} ${input.lastName}`.trim(),
          firstName: input.firstName,
          lastName: input.lastName,
          emailAddress: input.email,
          ...(input.company !== undefined ? { companyName: input.company } : {}),
          status: "New",
          source: input.source,
          ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
          ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium } : {}),
          ...(input.utmCampaign !== undefined ? { utmCampaign: input.utmCampaign } : {}),
          ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
          ...(input.key !== undefined ? { formIntakeKey: input.key } : {}),
        }),
      ),
    );
    const id = (created as { id?: string })?.id;
    if (typeof id !== "string") throw new Error("Lead creation did not return an id.");
    return id;
  }
}
