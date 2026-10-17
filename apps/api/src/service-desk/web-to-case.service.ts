import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { SERVICE_DESK_SYSTEM_PRINCIPAL } from "./service-desk-authority.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.12 — Web-to-Case public intake (PLAN §5.10).
 *
 * A dedicated, narrow intake endpoint. Public clients never touch the generic entity API: only an
 * explicit allowlist of customer-facing fields is accepted, and source/status/priority/policy are
 * set server-side. Abuse controls: a honeypot field, length caps, and a per-IP in-memory rate limit.
 * Idempotency is by an optional client key or a normalized content hash.
 */

export interface WebToCaseInput {
  readonly name: string;            // subject
  readonly description?: string | undefined;
  readonly requesterName?: string | undefined;
  readonly requesterEmail?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Honeypot: must be empty. */
  readonly website?: string | undefined;
  readonly clientIp?: string | undefined;
}

export interface WebToCaseResult {
  readonly caseNumber: string | null;
  readonly created: boolean;
  readonly duplicate: boolean;
}

@Injectable()
export class WebToCaseService {
  private readonly ipHits = new Map<string, number[]>();

  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async submit(input: WebToCaseInput): Promise<WebToCaseResult> {
    const settings = await this.settings.settings();
    if (!settings.features.caseManagement) {
      throw new ValidationError("Case management is disabled.");
    }

    // Honeypot.
    if (typeof input.website === "string" && input.website.trim() !== "") {
      // Pretend success to avoid leaking the trap.
      return { caseNumber: null, created: false, duplicate: false };
    }

    const name = input.name.trim();
    if (name === "" || name.length > 255) {
      throw new ValidationError("A subject is required (max 255 characters).", { field: "name" });
    }
    const email = input.requesterEmail?.trim();
    if (email !== undefined && email !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ValidationError("Invalid requester email address.", { field: "requesterEmail" });
    }

    // Rate limit per IP (5 per minute).
    const ip = input.clientIp ?? "unknown";
    const now = Date.now();
    const windowMs = 60_000;
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= 5) {
      throw new ValidationError("Too many requests. Please try again later.");
    }
    hits.push(now);
    this.ipHits.set(ip, hits);

    // Idempotency.
    const key = input.idempotencyKey?.trim();
    if (key) {
      const existing = await this.database.db
        .selectFrom("entity_records")
        .select("attrs")
        .where("entity_type", "=", CASE_ENTITY)
        .where("deleted_at", "is", null)
        .where(sql`attrs ->> 'intakeKey'`, "=", key)
        .executeTakeFirst();
      if (existing !== undefined) {
        const a = (existing.attrs ?? {}) as Record<string, unknown>;
        return { caseNumber: typeof a["caseNumber"] === "string" ? (a["caseNumber"] as string) : null, created: false, duplicate: true };
      }
    }

    const caseId = await this.scope.runAs(SERVICE_DESK_SYSTEM_PRINCIPAL, async () => {
      return runAsServiceDeskInternal(async () => {
        const created = await this.entities.create(CASE_ENTITY, {
          name,
          description: input.description?.trim() ?? "",
          source: "Web Form",
          status: "New",
          priority: "Normal",
          type: "Question",
          ...(email ? { requesterEmail: email } : {}),
          ...(input.requesterName ? { requesterName: input.requesterName.trim() } : {}),
        });
        const caseId = String(created["id"]);
      if (key) {
        await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ intakeKey: key })}::jsonb, modified_at = now() WHERE id = ${caseId}`.execute(this.database.db);
      }
      return caseId;
      });
    });

    const row = await this.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("id", "=", caseId)
      .executeTakeFirst();
    const a = (row?.attrs ?? {}) as Record<string, unknown>;
    return { caseNumber: typeof a["caseNumber"] === "string" ? (a["caseNumber"] as string) : null, created: true, duplicate: false };
  }
}