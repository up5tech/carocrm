import { createHash, randomBytes } from "node:crypto";

import { FeatureDisabledError,ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

const CSAT_ENTITY = "CsatSurvey";

export interface CsatInvitation {
  readonly surveyId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CsatResult {
  readonly caseId: string;
  readonly count: number;
  readonly average: number | null;
  readonly ratings: number[];
}

@Injectable()
export class CsatService {
  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async createInvitation(caseId: string): Promise<CsatInvitation> {
    const settings = await this.settings.settings();
    if (!settings.features.csat) throw new FeatureDisabledError("csat");
    const raw = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(raw).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const id = `csat_${caseId}_${Date.now().toString(36)}`;
    await sql`INSERT INTO entity_records (id, entity_type, attrs, version, created_at, modified_at)
      VALUES (${id}, ${CSAT_ENTITY}, ${JSON.stringify({
        name: `CSAT for ${caseId}`,
        caseId,
        cycle: 1,
        tokenHash: hash,
        expiresAt: expiresAt.toISOString(),
        used: false,
        status: "Pending",
      })}::jsonb, 1, now(), now())`.execute(this.database.db);
    return { surveyId: id, token: raw, expiresAt: expiresAt.toISOString() };
  }

  async submit(token: string, rating: number, feedback?: string): Promise<{ submitted: boolean }> {
    if (rating < 1 || rating > 5) throw new ValidationError("Rating must be between 1 and 5.");
    const hash = createHash("sha256").update(token).digest("hex");
    const row = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", CSAT_ENTITY)
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'tokenHash'`, "=", hash)
      .executeTakeFirst();
    if (row === undefined) throw new ValidationError("Invalid or expired survey token.");
    const a = (row.attrs ?? {}) as Record<string, unknown>;
    if (a["used"] === true) throw new ValidationError("This survey has already been submitted.");
    const expires = a["expiresAt"] ? new Date(String(a["expiresAt"])) : null;
    if (expires && expires.getTime() < Date.now()) {
      await sql`UPDATE entity_records SET attrs = attrs || '{"status":"Expired"}'::jsonb, modified_at = now() WHERE id = ${String(row.id)}`.execute(this.database.db);
      throw new ValidationError("This survey has expired.");
    }
    await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ used: true, rating, feedback: feedback ?? null, submittedAt: new Date().toISOString(), status: "Submitted" })}::jsonb, modified_at = now() WHERE id = ${String(row.id)}`.execute(this.database.db);
    return { submitted: true };
  }

  async results(caseId: string): Promise<CsatResult> {
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", CSAT_ENTITY)
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .execute();
    const ratings: number[] = [];
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      if (a["status"] === "Submitted" && typeof a["rating"] === "number") ratings.push(a["rating"] as number);
    }
    const avg = ratings.length > 0 ? ratings.reduce((x, y) => x + y, 0) / ratings.length : null;
    return { caseId, count: ratings.length, average: avg, ratings };
  }
}