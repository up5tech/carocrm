import {
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig,CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { currentTx, runInTransaction } from "../entity/tx-context.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import {
  type AudienceCriteria,
  clauseToListQuery,
  fieldIsFilterable,
  validateCriteria,
} from "./marketing-audience-criteria.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  type AudienceCategory,
  type AudienceSnapshotMode,
  CAMPAIGN_ENTITY,
  type CampaignPurpose,
  type CampaignStatus,
  categoryForDecision,
  fingerprint,
  isCampaignPurpose,
  isCampaignStatus,
  isSegmentEntityType,
  MARKETING_AUDIENCE_SNAPSHOT_ENTITY,
  normalizeEmailAddress,
  type RecipientEligibilityDecision,
  recipientPrecedence,
  SEGMENT_ENTITY_TYPES,
  type SegmentEntityType,
  TARGET_LIST_ENTITY,
  TARGET_LIST_ENTRY_ENTITY,
} from "./marketing-automation-domain.js";
import { MarketingAutomationRecords, type MarketingRow } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingEligibilityService } from "./marketing-eligibility.service.js";
import { emailIdentity } from "./marketing-identity.js";

/**
 * Phase 19-MA.4 — audience resolution, composition, preview and snapshots
 * (PLAN_Phase_19_Marketing_Automation.md §5.2, §6.1, §7.1 `MarketingAudienceService`).
 *
 * Four rules drive the whole file, and each one is an acceptance criterion of the phase:
 *
 *  1. **no user-provided SQL is executed.** A dynamic audience is stored criteria JSON; it is validated
 *     against metadata field/type/operator allowlists here and then handed to the platform's query engine,
 *     which re-validates and binds every value. Nothing in this file assembles a statement (§5.2).
 *  2. **exclusion always wins over inclusion.** Excluded record keys and excluded address identities are
 *     collected first, and a candidate matching either is reported as excluded before any other reasoning —
 *     so no ordering of lists can put a person back into an audience they were excluded from (§5.2).
 *  3. **ACL does not leak through counts, samples or criteria.** Every candidate is loaded through
 *     `EntityCrudService`, so the record predicate and field masking apply; a record the caller cannot read
 *     never becomes a row, and a criteria field they cannot filter on is refused at the write and again
 *     here (§9.2). The one aggregate that could still disclose — a count of records outside their scope —
 *     is therefore computed from the same ACL-filtered set, and `hidden` says how many entries were dropped.
 *  4. **a snapshot is stable.** Resolution writes an immutable entry set once, with the audience composition
 *     it was taken of; a later change to a list produces a *new* snapshot, never an edit of the old one
 *     (§5.2, §5.5).
 *
 * De-duplication follows the documented rule (§5.2 "using documented rules"): one entry per record, then one
 * per normalised address, preferring a Contact over a Lead and then the oldest record. Records are never
 * merged — that choice belongs to a data-quality process, not to sending (§1.2).
 */

export interface AudienceMember {
  readonly entityType: string;
  readonly entityId: string;
}

export interface MemberView {
  readonly entryId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly name: string | null;
  readonly source: string | null;
  readonly addedAt: string | null;
}

export interface ResolvedCandidate {
  readonly entityType: SegmentEntityType;
  readonly entityId: string;
  readonly emailAddress: string;
  readonly emailHash: string | null;
  readonly name: string | null;
  /** Which audiences named this recipient, for the explainable report (§1.2). */
  readonly sources: readonly string[];
  readonly excluded: boolean;
}

/**
 * One headline category of a resolved audience, with the reason codes that produced it. The reason list is
 * what makes a dry run explainable (§5.5 "preview shows the reasons each recipient category is excluded"):
 * "1,204 opted out" is a number, "1,204 opted out (OPTED_OUT, CONSENT_UNKNOWN)" is an answer.
 */
export interface CategoryCount {
  readonly category: AudienceCategory;
  readonly count: number;
  readonly reasons: readonly string[];
}

export interface AudiencePreview {
  readonly campaignId: string | null;
  readonly targetListId: string | null;
  readonly purpose: CampaignPurpose | null;
  readonly status: CampaignStatus | null;
  readonly resolved: number;
  readonly eligible: number;
  readonly categories: readonly CategoryCount[];
  /**
   * The composition this preview was taken of, hashed exactly as the snapshot header hashes it, so a send
   * definition can compare "what I was validated against" with "what the campaign includes now" (MA.8, §5.5).
   */
  readonly compositionHash: string;
  readonly samples: readonly {
    readonly entityId: string;
    readonly entityType: string;
    readonly name: string | null;
    readonly category: AudienceCategory;
    /** The reason codes behind this recipient's category, so a preview explains itself (§5.5). */
    readonly reasons: readonly string[];
  }[];
  readonly notes: readonly string[];
  readonly truncated: boolean;
  readonly limit: number;
  readonly generatedAt: string;
}

export interface SnapshotResult {
  readonly snapshotId: string;
  readonly compositionHash: string;
  readonly resolved: number;
  readonly eligible: number;
  readonly entryCount: number;
  readonly categories: readonly CategoryCount[];
  readonly truncated: boolean;
  readonly previousSnapshotId: string | null;
  /** The send definition this snapshot was frozen for, when it was taken by a send validation (MA.8). */
  readonly sendId: string | null;
}

@Injectable()
export class MarketingAudienceService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(MarketingEligibilityService) private readonly eligibility: MarketingEligibilityService,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  // -------------------------------------------------------------------------
  // Static membership (§5.2 "explicitly selected CRM record IDs with membership audit")
  // -------------------------------------------------------------------------

  /** Add records to an audience. Membership is an auditable fact, so an existing entry is left alone. */
  async addMembers(
    targetListId: string,
    members: readonly AudienceMember[],
    source = "Manual",
  ): Promise<{ added: number; alreadyPresent: number; rejected: readonly string[] }> {
    const list = await this.loadList(targetListId, "edit");
    if (list.data["membershipMode"] === "dynamic") {
      throw new ValidationError(
        "A dynamic audience is populated by its criteria; add records to a static audience instead, or edit the criteria.",
        { code: "AUDIENCE_MODE_MISMATCH", targetListId },
      );
    }
    if (members.length === 0) {
      throw new ValidationError("No records were named.", { code: "AUDIENCE_MEMBERS_REQUIRED" });
    }
    if (members.length > 500) {
      throw new ValidationError("At most 500 records may be added in one command.", { code: "AUDIENCE_BATCH_TOO_LARGE" });
    }

    const allowed = this.allowedEntityTypes(list.data["entityTypes"]);
    const existing = await this.records.findByAttrs(TARGET_LIST_ENTRY_ENTITY, { targetListId }, { limit: 5_000 });
    const live = new Set(
      existing
        .filter((row) => row.data["removedAt"] === undefined || row.data["removedAt"] === null)
        .map((row) => `${String(row.data["memberType"])}:${String(row.data["memberId"])}`),
    );

    const rejected: string[] = [];
    let added = 0;
    let alreadyPresent = 0;
    const actor = this.scope.principal;
    const now = new Date().toISOString();

    for (const member of members) {
      const key = `${member.entityType}:${member.entityId}`;
      if (!isSegmentEntityType(member.entityType) || !allowed.includes(member.entityType)) {
        rejected.push(`${key}: this audience does not accept ${member.entityType || "that record type"}.`);
        continue;
      }
      if (live.has(key)) {
        alreadyPresent += 1;
        continue;
      }
      // The record has to exist and be readable by the caller: membership of a record nobody can see would
      // be an unverifiable claim about a person (§9.2).
      try {
        await this.entities.get(member.entityType, member.entityId);
      } catch {
        rejected.push(`${key}: no such record, or you may not read it.`);
        continue;
      }
      live.add(key);
      await runAsMarketingSystem(this.scope, "audienceMembership", () =>
        this.entities.create(TARGET_LIST_ENTRY_ENTITY, {
          name: `${member.entityType} ${member.entityId}`,
          targetListId,
          memberType: member.entityType,
          memberId: member.entityId,
          addedById: actor?.userId ?? "system",
          addedAt: now,
          source,
        }),
      );
      added += 1;
    }

    await this.refreshListMetadata(list, added + alreadyPresent, undefined);
    return { added, alreadyPresent, rejected };
  }

  /** Removal is recorded, not deleted, so an audience's history stays explainable (§5.2). */
  async removeMember(
    targetListId: string,
    member: AudienceMember,
    reason?: string,
  ): Promise<{ removed: boolean }> {
    await this.loadList(targetListId, "edit");
    const rows = await this.records.findByAttrs(
      TARGET_LIST_ENTRY_ENTITY,
      { targetListId, memberType: member.entityType, memberId: member.entityId },
      { limit: 5 },
    );
    const live = rows.find((row) => row.data["removedAt"] === undefined || row.data["removedAt"] === null);
    if (live === undefined) return { removed: false };
    const actor = this.scope.principal;
    await runAsMarketingSystem(this.scope, "audienceMembershipRemove", () =>
      this.entities.update(TARGET_LIST_ENTRY_ENTITY, live.id, {
        removedAt: new Date().toISOString(),
        removedById: actor?.userId ?? "system",
        removalReason: reason ?? null,
      }),
    );
    return { removed: true };
  }

  /**
   * Who is in an audience. Entries are evidence rows with no ACL of their own, so each referenced record is
   * loaded through the entity service: what the caller cannot read is dropped and counted, never named.
   */
  async members(
    targetListId: string,
    options: { readonly maxSize?: number; readonly offset?: number } = {},
  ): Promise<{ list: MemberView[]; hidden: number; total: number }> {
    await this.loadList(targetListId, "read");
    const entries = (await this.records.findByAttrs(TARGET_LIST_ENTRY_ENTITY, { targetListId }, { limit: 5_000 }))
      .filter((row) => row.data["removedAt"] === undefined || row.data["removedAt"] === null);

    const readable: { entry: MarketingRow; record: Record<string, unknown> }[] = [];
    let hidden = 0;
    for (const entry of entries) {
      const entityType = String(entry.data["memberType"] ?? "");
      const entityId = String(entry.data["memberId"] ?? "");
      try {
        const record = await this.entities.get(entityType, entityId);
        readable.push({ entry, record });
      } catch {
        hidden += 1;
      }
    }
    const maxSize = options.maxSize ?? 50;
    const offset = options.offset ?? 0;
    const list = readable.slice(offset, offset + maxSize).map(({ entry, record }) => ({
      entryId: entry.id,
      entityType: String(entry.data["memberType"] ?? ""),
      entityId: String(entry.data["memberId"] ?? ""),
      name: typeof record["name"] === "string" ? record["name"] : null,
      source: typeof entry.data["source"] === "string" ? String(entry.data["source"]) : null,
      addedAt: typeof entry.data["addedAt"] === "string" ? String(entry.data["addedAt"]) : null,
    }));
    return { list, hidden, total: readable.length };
  }

  /**
   * Recompute an audience's summary fields. This is an explicit command rather than a side effect of
   * reading, because a preview that quietly rewrote records would be a hidden write (§8, AGENTS.md §8).
   */
  async refresh(targetListId: string): Promise<{ resolvedCount: number; criteriaHash: string | null }> {
    const list = await this.loadList(targetListId, "edit");
    const settings = await this.settings.settings();
    const outcome = await this.resolveList(targetListId, settings.limits.maxResolveRecords);
    const raw = list.data["criteriaJson"];
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    const check = parsed === undefined ? { ok: false, criteria: undefined } : validateCriteria(parsed, await this.fieldLookup());
    const criteriaHash = check.ok && check.criteria !== undefined ? criteriaFingerprintOf(check.criteria) : null;
    await this.refreshListMetadata(list, outcome.candidates.length, criteriaHash ?? undefined);
    return { resolvedCount: outcome.candidates.length, criteriaHash };
  }

  // -------------------------------------------------------------------------
  // Composition, preview and snapshot (§5.2, §5.5)
  // -------------------------------------------------------------------------

  /** Preview a campaign's audience: composition, eligibility categories and readable samples. */
  async previewCampaign(campaignId: string): Promise<AudiencePreview> {
    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "read", {
      id: campaignId,
      assignedUserId: text(row.data["assignedUserId"]),
      createdById: text(row.data["createdById"]),
      teams: Array.isArray(row.data["teams"]) ? (row.data["teams"] as string[]) : [],
      data: row.data,
    });
    const status = isCampaignStatus(row.data["status"]) ? row.data["status"] : "Draft";
    const purpose = isCampaignPurpose(row.data["purpose"]) ? row.data["purpose"] : null;
    const included = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "includedTargetLists");
    const excluded = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "excludedTargetLists");

    const settings = await this.settings.settings();
    const composed = await this.compose(included, excluded, settings.limits.maxResolveRecords);
    const decisions = await this.classify(composed.candidates, {
      purpose,
      campaignStatus: status,
      targetListId: included[0],
    });

    return {
      campaignId,
      targetListId: null,
      purpose,
      status,
      resolved: composed.candidates.length,
      eligible: decisions.filter((item) => item.category === "eligible").length,
      categories: tally(decisions),
      compositionHash: fingerprint({ included: [...included].sort(), excluded: [...excluded].sort() }),
      samples: decisions.slice(0, 10).map((item) => ({
        entityId: item.candidate.entityId,
        entityType: item.candidate.entityType,
        name: item.candidate.name,
        category: item.category,
        reasons: item.reasons,
      })),
      notes: composed.notes,
      truncated: composed.truncated,
      limit: settings.limits.maxResolveRecords,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate an immutable audience snapshot for a campaign (§6.1 "Audience/send snapshot").
   *
   * The header is a metadata record; the per-recipient rows go to their own table because they are bulk
   * derived state, not business records (the `email_deliveries` precedent), and because a recipient address
   * is stored only as a digest. Re-running after an audience changes creates a new snapshot linked to the
   * previous one — it never edits the old rows, which is what makes "stable even if the segment changes"
   * testable rather than aspirational.
   */
  async snapshot(
    campaignId: string,
    options: { readonly mode?: AudienceSnapshotMode; readonly sendId?: string | null } = {},
  ): Promise<SnapshotResult> {
    const mode: AudienceSnapshotMode = options.mode ?? "final";
    const sendId = options.sendId ?? null;
    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "edit", {
      id: campaignId,
      assignedUserId: text(row.data["assignedUserId"]),
      createdById: text(row.data["createdById"]),
      teams: Array.isArray(row.data["teams"]) ? (row.data["teams"] as string[]) : [],
      data: row.data,
    });
    const settings = await this.settings.settings();
    const status = isCampaignStatus(row.data["status"]) ? row.data["status"] : "Draft";
    const purpose = isCampaignPurpose(row.data["purpose"]) ? row.data["purpose"] : null;
    const included = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "includedTargetLists");
    const excluded = await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, "excludedTargetLists");
    if (included.length === 0) {
      throw new ValidationError("A campaign with no audience cannot be snapshotted.", {
        code: "AUDIENCE_REQUIRED",
        campaignId,
      });
    }

    const composed = await this.compose(included, excluded, settings.limits.maxResolveRecords);
    const decisions = await this.classify(composed.candidates, {
      purpose,
      campaignStatus: status,
      targetListId: included[0],
    });
    const eligible = decisions.filter((item) => item.category === "eligible").length;
    const compositionHash = fingerprint({ included: [...included].sort(), excluded: [...excluded].sort() });
    const siblings = await this.records.findByAttrs(MARKETING_AUDIENCE_SNAPSHOT_ENTITY, { campaignId }, { limit: 50, order: "desc" });
    const previous = siblings
      .filter((candidate) => candidate.data["status"] === "Generated")
      .sort((left, right) => String(right.data["generatedAt"] ?? "").localeCompare(String(left.data["generatedAt"] ?? "")))[0];
    const actor = this.scope.principal;
    const generatedAt = new Date().toISOString();

    // A send's own earlier snapshots stop being the audience it is validated against the moment a new one is
    // frozen. They are stamped `Invalidated`, never edited or removed: the old snapshot is still the record of
    // what was intended at the time, which is exactly why an operator must be able to read it (§5.2, §6.1).
    const superseded = sendId === null
      ? []
      : siblings.filter(
          (candidate) => candidate.data["sendId"] === sendId && candidate.data["status"] === "Generated",
        );

    const snapshotId = await runInTransaction(this.database.db, async (tx) => {
      const created = await runAsMarketingSystem(this.scope, "audienceSnapshot", () =>
        this.entities.create(MARKETING_AUDIENCE_SNAPSHOT_ENTITY, {
          name: `${String(row.data["name"] ?? campaignId)} · ${mode} audience`,
          campaignId,
          sendId,
          mode,
          status: "Generated",
          includeTargetListIds: JSON.stringify(included),
          excludeTargetListIds: JSON.stringify(excluded),
          compositionHash,
          resolvedCount: composed.candidates.length,
          eligibleCount: eligible,
          entryCount: decisions.length,
          categories: JSON.stringify(Object.fromEntries(tally(decisions).map((c) => [c.category, c.count]))),
          purpose,
          generatedById: actor?.userId ?? "system",
          generatedAt,
          previousSnapshotId: previous?.id ?? null,
        }),
      );
      const id = String(created["id"]);
      for (const stale of superseded) {
        await runAsMarketingSystem(this.scope, "audienceSnapshotSupersede", () =>
          this.entities.update(MARKETING_AUDIENCE_SNAPSHOT_ENTITY, stale.id, {
            status: "Invalidated",
            invalidatedAt: generatedAt,
          }),
        );
      }
      for (const batch of chunks(decisions, 500)) {
        if (batch.length === 0) continue;
        const values = sql.join(
          batch.map((item) => sql`(${id}, ${item.candidate.entityType}, ${item.candidate.entityId}, ${item.candidate.emailHash}, ${item.category}, ${JSON.stringify(item.reasons)}::jsonb, ${JSON.stringify(item.candidate.sources)}::jsonb)`),
          sql`, `,
        );
        await sql`
          insert into marketing_audience_snapshot_entries
            (snapshot_id, entity_type, entity_id, email_hash, category, reasons, sources)
          values ${values}
          on conflict (snapshot_id, entity_type, entity_id) do nothing
        `.execute(tx);
      }
      return id;
    });

    return {
      snapshotId,
      compositionHash,
      resolved: composed.candidates.length,
      eligible,
      entryCount: decisions.length,
      categories: tally(decisions),
      truncated: composed.truncated,
      previousSnapshotId: previous?.id ?? null,
      sendId,
    };
  }

  /** The entries of a snapshot, category by category. Identities are digests, so nothing leaks by default. */
  async snapshotEntries(
    snapshotId: string,
    options: { readonly category?: AudienceCategory; readonly limit?: number } = {},
  ): Promise<{
    snapshotId: string;
    /** Header counts only: the reason codes live on each entry, which is what a reader of a snapshot needs. */
    categories: { category: AudienceCategory; count: number }[];
    entries: Record<string, unknown>[];
  }> {
    const header = await this.records.byId(MARKETING_AUDIENCE_SNAPSHOT_ENTITY, snapshotId);
    if (header === undefined) throw new NotFoundError(`Audience snapshot "${snapshotId}" does not exist.`);
    await this.acl.assertRecordAccess(MARKETING_AUDIENCE_SNAPSHOT_ENTITY, "read", {
      id: snapshotId,
      data: header.data,
    });
    const categories = await sql<{ category: string; count: string }>`
      select category, count(*)::text as count
      from marketing_audience_snapshot_entries
      where snapshot_id = ${snapshotId}
      group by category
    `.execute(this.db);
    const entries = await sql<Record<string, unknown>>`
      select entity_type, entity_id, email_hash, category, reasons, sources
      from marketing_audience_snapshot_entries
      where snapshot_id = ${snapshotId}
        ${options.category !== undefined ? sql`and category = ${options.category}` : sql``}
      order by category asc, entity_type asc, entity_id asc
      limit ${options.limit ?? 200}
    `.execute(this.db);
    return {
      snapshotId,
      categories: categories.rows.map((row) => ({ category: row.category as AudienceCategory, count: Number(row.count) })),
      entries: entries.rows,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Resolve the included and excluded audiences into one de-duplicated candidate set. */
  private async compose(
    included: readonly string[],
    excluded: readonly string[],
    limit: number,
  ): Promise<{ candidates: ResolvedCandidate[]; notes: string[]; truncated: boolean }> {
    const notes: string[] = [];
    const byKey = new Map<string, ResolvedCandidate>();
    let truncated = false;

    for (const listId of included) {
      const outcome = await this.resolveList(listId, limit);
      truncated = truncated || outcome.truncated;
      if (outcome.truncated) notes.push(`Audience ${listId} hit the ${String(limit)}-record resolution ceiling; the result is partial.`);
      for (const candidate of outcome.candidates) {
        const key = `${candidate.entityType}:${candidate.entityId}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, { ...candidate, sources: [listId] });
          continue;
        }
        // The same record named by two included lists is one recipient; the second mention is recorded as
        // a source, not as a second person (§5.2 "no duplicate sends when one person is in several lists").
        byKey.set(key, { ...existing, sources: [...existing.sources, listId] });
      }
    }

    const excludedKeys = new Set<string>();
    const excludedHashes = new Set<string>();
    for (const listId of excluded) {
      const outcome = await this.resolveList(listId, limit);
      truncated = truncated || outcome.truncated;
      for (const candidate of outcome.candidates) {
        excludedKeys.add(`${candidate.entityType}:${candidate.entityId}`);
        if (candidate.emailHash !== null) excludedHashes.add(candidate.emailHash);
      }
    }

    const candidates = [...byKey.values()].map((candidate) => ({
      ...candidate,
      // Exclusion is applied by record *and* by address identity: a person present as a Contact and a Lead
      // is excluded from both, because the thing being suppressed is the recipient, not the row (§5.2).
      excluded: excludedKeys.has(`${candidate.entityType}:${candidate.entityId}`)
        || (candidate.emailHash !== null && excludedHashes.has(candidate.emailHash)),
    }));

    return {
      candidates: candidates.sort((left, right) => {
        const precedence = recipientPrecedence(left.entityType) - recipientPrecedence(right.entityType);
        if (precedence !== 0) return precedence;
        return `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`);
      }),
      notes,
      truncated,
    };
  }

  /** Resolve one audience: static membership rows, or validated criteria through the query engine. */
  private async resolveList(
    targetListId: string,
    limit: number,
  ): Promise<{ candidates: ResolvedCandidate[]; truncated: boolean }> {
    const list = await this.loadList(targetListId, "read");
    const mode = list.data["membershipMode"] === "dynamic" ? "dynamic" : "static";
    const candidates: ResolvedCandidate[] = [];
    let truncated = false;

    if (mode === "static") {
      const entries = (await this.records.findByAttrs(TARGET_LIST_ENTRY_ENTITY, { targetListId }, { limit }))
        .filter((row) => row.data["removedAt"] === undefined || row.data["removedAt"] === null);
      if (entries.length >= limit) truncated = true;
      for (const entry of entries) {
        const entityType = String(entry.data["memberType"] ?? "");
        const entityId = String(entry.data["memberId"] ?? "");
        if (!isSegmentEntityType(entityType)) continue;
        let record: Record<string, unknown>;
        try {
          record = await this.entities.get(entityType, entityId);
        } catch {
          // Unreadable or deleted: dropped silently from the population, but the count says so upstream.
          continue;
        }
        candidates.push(this.toCandidate(entityType, entityId, record, targetListId));
      }
      return { candidates, truncated };
    }

    const raw = list.data["criteriaJson"];
    if (raw === undefined || raw === null || raw === "") {
      throw new ValidationError(`Audience ${targetListId} is dynamic but has no criteria.`, {
        code: "AUDIENCE_CRITERIA_MISSING",
      });
    }
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    const check = validateCriteria(parsed, await this.fieldLookup());
    if (!check.ok || check.criteria === undefined) {
      throw new ValidationError(`Audience ${targetListId} has invalid criteria: ${check.errors.join(" ")}`, {
        code: "AUDIENCE_CRITERIA_INVALID",
        issues: check.errors,
      });
    }
    for (const clause of check.criteria.clauses) {
      const query = clauseToListQuery(clause, { maxSize: Math.max(1, Math.min(limit - candidates.length, 5_000)) });
      const result = await this.entities.list(clause.entityType, query);
      if (result.list.length >= limit - candidates.length) truncated = true;
      for (const record of result.list) {
        candidates.push(this.toCandidate(clause.entityType, String(record["id"]), record, targetListId));
      }
    }
    return { candidates, truncated };
  }

  private toCandidate(
    entityType: SegmentEntityType,
    entityId: string,
    record: Record<string, unknown>,
    source: string,
  ): ResolvedCandidate {
    const address = normalizeEmailAddress(record["emailAddress"]);
    return {
      entityType,
      entityId,
      emailAddress: address,
      emailHash: address === "" ? null : (emailIdentity(address, this.config.encryptionKey)?.hash ?? null),
      name: typeof record["name"] === "string" ? record["name"] : null,
      sources: [source],
      excluded: false,
    };
  }

  /**
   * Apply the eligibility gate and the de-duplication rule to a composed candidate set.
   *
   * Order matters and is the documented one: exclusion first (it is absolute), then the eligibility matrix,
   * then address de-duplication among those who would otherwise receive a message. A duplicate is therefore
   * never counted as "eligible" twice, and a suppressed person is never counted as a duplicate of somebody
   * else's block.
   *
   * When two records share one address the *tie-break* decides which of them receives the message, so it must
   * not depend on the order the database happened to return rows in — the same data would otherwise produce a
   * different "eligible" record on a later run, and an explainable report cannot flip. The candidate set is
   * therefore walked in `entityType:entityId` order and the loser is reported as `duplicateAddress`.
   */
  private async classify(
    candidates: readonly ResolvedCandidate[],
    context: {
      readonly purpose: CampaignPurpose | null;
      readonly campaignStatus: CampaignStatus;
      readonly targetListId?: string | undefined;
    },
  ): Promise<readonly ClassifiedCandidate[]> {
    if (candidates.length === 0) return [];
    const ordered = [...candidates].sort((a, b) =>
      `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`),
    );
    const purpose = context.purpose ?? "Newsletter";
    const decisions = await this.eligibility.decideMany(
      ordered.map((candidate) => ({
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        emailAddress: candidate.emailAddress,
        ...(candidate.emailHash !== null ? { emailHash: candidate.emailHash } : {}),
        readable: true,
      })),
      {
        channel: "Email",
        purpose,
        campaignStatus: context.campaignStatus,
        ...(context.targetListId !== undefined ? { targetListId: context.targetListId } : {}),
      },
    );

    const seenRecords = new Set<string>();
    const seenAddresses = new Set<string>();
    const out: ClassifiedCandidate[] = [];
    const byEntity = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) byEntity.set(`${decision.entityType}:${decision.entityId}`, decision);

    for (const candidate of ordered) {
      const key = `${candidate.entityType}:${candidate.entityId}`;
      const decision = byEntity.get(key);
      const eligibility = decision?.decision;
      let category: AudienceCategory;
      let reasons: readonly string[];

      if (candidate.excluded) {
        category = "excludedBySegment";
        reasons = ["EXCLUDED_BY_TARGET_LIST"];
      } else if (seenRecords.has(key)) {
        category = "duplicateRecord";
        reasons = [];
      } else if (eligibility === undefined || !eligibility.eligible) {
        const code = eligibility?.code ?? "NO_EMAIL_ADDRESS";
        category = categoryForDecision({ eligible: false, code });
        reasons = eligibility?.reasons ?? [code];
      } else if (candidate.emailHash !== null && seenAddresses.has(candidate.emailHash)) {
        category = "duplicateAddress";
        reasons = ["DUPLICATE_ADDRESS"];
      } else {
        category = "eligible";
        reasons = [];
      }

      seenRecords.add(key);
      if (candidate.emailHash !== null && category === "eligible") seenAddresses.add(candidate.emailHash);
      out.push({ candidate, category, reasons, decision: eligibility });
    }
    return out;
  }

  private async fieldLookup() {
    const readable = new Set<string>();
    for (const entity of SEGMENT_ENTITY_TYPES) {
      if ((await this.acl.canUser(entity, "read")) !== "no") readable.add(entity);
    }
    const registry = this.metadata.registry;
    return {
      fieldType: (entity: string, field: string) => registry.getField(entity, field)?.type,
      filterable: (entity: string, field: string) =>
        readable.has(entity) && fieldIsFilterable(registry.getField(entity, field)),
    };
  }

  private async loadList(
    targetListId: string,
    action: "read" | "edit",
  ): Promise<MarketingRow> {
    const row = await this.records.byId(TARGET_LIST_ENTITY, targetListId);
    if (row === undefined) throw new NotFoundError(`Target list "${targetListId}" does not exist.`);
    await this.acl.assertRecordAccess(TARGET_LIST_ENTITY, action, {
      id: targetListId,
      assignedUserId: text(row.data["assignedUserId"]),
      createdById: text(row.data["createdById"]),
      teams: Array.isArray(row.data["teams"]) ? (row.data["teams"] as string[]) : [],
      data: row.data,
    });
    return row;
  }

  /** Server-owned resolution bookkeeping; the guard refuses a client that writes these fields. */
  private async refreshListMetadata(
    list: MarketingRow,
    resolvedCount: number,
    criteriaHash: string | undefined,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      resolvedCount,
      refreshStatus: "Resolved",
      lastRefreshedAt: new Date().toISOString(),
      lastErrorCode: null,
    };
    if (criteriaHash !== undefined) patch["criteriaHash"] = criteriaHash;
    await runAsMarketingSystem(this.scope, "audienceRefresh", () =>
      this.entities.update(TARGET_LIST_ENTITY, list.id, patch),
    );
  }

  private allowedEntityTypes(value: unknown): string[] {
    const raw = typeof value === "string" && value.trim() !== "" ? value : SEGMENT_ENTITY_TYPES.join(",");
    const names = raw.split(",").map((item) => item.trim()).filter((item) => isSegmentEntityType(item));
    return names.length > 0 ? names : [...SEGMENT_ENTITY_TYPES];
  }
}

interface ClassifiedCandidate {
  readonly candidate: ResolvedCandidate;
  readonly category: AudienceCategory;
  readonly reasons: readonly string[];
  readonly decision: RecipientEligibilityDecision | undefined;
}

function tally(items: readonly { readonly category: AudienceCategory; readonly reasons: readonly string[] }[]): CategoryCount[] {
  const counts = new Map<AudienceCategory, number>();
  const reasons = new Map<AudienceCategory, Set<string>>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    const seen = reasons.get(item.category) ?? new Set<string>();
    for (const reason of item.reasons) seen.add(reason);
    reasons.set(item.category, seen);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({
      category,
      count,
      reasons: [...(reasons.get(category) ?? [])].sort(),
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function criteriaFingerprintOf(criteria: AudienceCriteria): string {
  return fingerprint({ criteria });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
