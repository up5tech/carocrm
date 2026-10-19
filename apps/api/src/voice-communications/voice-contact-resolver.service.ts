import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { DatabaseService } from "../database/database.service.js";
import {
  PHONE_NORMALIZER,
  phoneMatchKeys,
  type PhoneNormalizationResult,
  type PhoneNormalizer,
} from "./phone-number.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";

/**
 * Phase 19-VC.6 — contact resolution and safe identity matching
 * (`PLAN_Phase_19_Voice_Communications.md` §7.2, §15 `19-VC.6`).
 *
 * The resolver answers one question: *which CRM records may this caller be?* — and it answers it
 * without disclosing a record the caller's user cannot read.
 *
 * Three rules, all from the plan:
 *  - **Normalize before matching.** A stored `phoneNumber` is human-formatted text, so both sides are
 *    compared as digits (`regexp_replace`), using the international and national forms of the
 *    incoming number. Formatting never decides a match.
 *  - **Never silently pick one of several.** More than one readable match is `ambiguous`, and the
 *    caller (the future popup) must disambiguate (§7.2). One match is `matched`.
 *  - **Never reveal a restricted record.** A record that matches but fails record-level ACL is
 *    counted as `hiddenMatches` and its name is never returned (§13.3). The count is safe: it says
 *    "something matched that you cannot see", not who.
 *
 * The resolver reads `entity_records` directly because a normalized phone index does not exist yet;
 * this is the documented trade-off in `docs/compatibility/voice-communications.md`. It is bounded and
 * only runs for an authenticated user who holds read access to the entity type.
 */

export interface ResolvedCandidate {
  readonly entityType: string;
  readonly id: string;
  readonly name: string;
}

export interface ContactResolution {
  readonly status: "matched" | "ambiguous" | "unmatched" | "invalid";
  readonly input: string;
  readonly address: string | null;
  readonly candidates: readonly ResolvedCandidate[];
  /** Matches the current user may not read. Their names are never included. */
  readonly hiddenMatches: number;
  /** True when the readable candidate list was capped. */
  readonly truncated: boolean;
  readonly reason?: string | undefined;
}

/** Entity types searched, in the order a popup should present them. */
export const RESOLUTION_ENTITIES = ["Contact", "Lead", "Account"] as const;
export type ResolutionEntity = (typeof RESOLUTION_ENTITIES)[number];

const MAX_CANDIDATES = 10;
const MAX_ROWS = 50;

interface CandidateRow {
  id: string;
  entity_type: string;
  name: string | null;
  attrs: unknown;
  assigned_user_id: string | null;
  created_by_id: string | null;
  team_ids: unknown;
}

@Injectable()
export class VoiceContactResolverService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  async resolve(
    phone: string,
    options: { readonly defaultRegion?: string | undefined; readonly entities?: readonly string[] | undefined } = {},
  ): Promise<ContactResolution> {
    const settings = await this.settings.settings();
    const normalized: PhoneNormalizationResult = this.phones.normalize(
      phone,
      options.defaultRegion ?? settings.policy.defaultRegion,
    );
    if (!normalized.valid || normalized.e164 === null) {
      return {
        status: "invalid",
        input: phone,
        address: null,
        candidates: [],
        hiddenMatches: 0,
        truncated: false,
        reason: normalized.reason ?? "invalid",
      };
    }

    const keys = phoneMatchKeys(normalized);
    const entities = options.entities ?? RESOLUTION_ENTITIES;
    const candidates: ResolvedCandidate[] = [];
    let hiddenMatches = 0;
    let truncated = false;

    for (const entity of entities) {
      // Entity-level access first: a user with no read permission on Contact should not learn that a
      // Contact matched, and the query is pointless.
      if ((await this.acl.canUser(entity, "read")) === "no") continue;

      const rows = await this.findByPhone(entity, keys);
      for (const row of rows) {
        const allowed = await this.canRead(entity, row);
        if (!allowed) {
          hiddenMatches += 1;
          continue;
        }
        if (candidates.length >= MAX_CANDIDATES) {
          truncated = true;
          continue;
        }
        candidates.push({
          entityType: row.entity_type,
          id: row.id,
          name: row.name ?? displayName(row.attrs) ?? row.id,
        });
      }
    }

    const status: ContactResolution["status"] =
      candidates.length === 0 ? "unmatched" : candidates.length === 1 ? "matched" : "ambiguous";

    return {
      status,
      input: phone,
      address: normalized.e164,
      candidates,
      hiddenMatches,
      truncated,
    };
  }

  private async findByPhone(entity: string, keys: readonly string[]): Promise<readonly CandidateRow[]> {
    if (keys.length === 0) return [];
    const keyList = sql.join(keys.map((key) => sql.val(key)));
    const result = await sql<CandidateRow>`
      select id, entity_type, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where entity_type = ${entity}
        and deleted_at is null
        and regexp_replace(coalesce(attrs->>'phoneNumber', ''), '[^0-9]', '', 'g') in (${keyList})
      limit ${MAX_ROWS}
    `.execute(this.database.db);
    return result.rows;
  }

  private async canRead(entity: string, row: CandidateRow): Promise<boolean> {
    const teams = Array.isArray(row.team_ids) ? (row.team_ids as string[]) : undefined;
    const decision = await this.acl.canAccessRecord(entity, "read", {
      id: row.id,
      data: typeof row.attrs === "object" && row.attrs !== null ? (row.attrs as Record<string, unknown>) : {},
      ...(row.assigned_user_id !== null ? { assignedUserId: row.assigned_user_id } : {}),
      ...(row.created_by_id !== null ? { createdById: row.created_by_id } : {}),
      ...(teams !== undefined ? { teams } : {}),
    });
    return decision.allowed;
  }
}

function displayName(attrs: unknown): string | null {
  if (typeof attrs !== "object" || attrs === null) return null;
  const data = attrs as Record<string, unknown>;
  const first = typeof data["firstName"] === "string" ? data["firstName"] : "";
  const last = typeof data["lastName"] === "string" ? data["lastName"] : "";
  const full = `${first} ${last}`.trim();
  if (full !== "") return full;
  return typeof data["name"] === "string" && data["name"].trim() !== "" ? data["name"].trim() : null;
}
