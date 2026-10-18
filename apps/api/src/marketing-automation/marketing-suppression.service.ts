import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig,CONFIG_TOKEN } from "../config.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  type CampaignPurpose,
  type ConsentChannel,
  MARKETING_SUPPRESSION_ENTITY,
  normalizeEmailAddress,
  SUPPRESSION_OVERRIDABLE,
  SUPPRESSION_REASONS,
  SUPPRESSION_SCOPES,
  type SuppressionReason,
  type SuppressionScope,
} from "./marketing-automation-domain.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { emailIdentity } from "./marketing-identity.js";

/**
 * Phase 19-MA.5 — suppression and the global block list (§5.3, §6.3, §7.1).
 *
 * "Suppression wins" (§1.2) needs one place that knows what a block means, or every send path would
 * re-decide it. The rules held here:
 *
 *  - a block is scoped: `Global` outranks everything, then `Channel`, then `Purpose`, then one audience;
 *  - **a block is never deleted.** Revoking stamps `revokedAt`/`revokedById`/`revokedReason` and leaves the
 *    row, because §6.8 is explicit that deleting suppression evidence can cause a previously opted-out
 *    person to be emailed again;
 *  - only some reasons can be lifted at all (`SUPPRESSION_OVERRIDABLE`): a complaint, a hard bounce, a
 *    global opt-out, an operator block or a legal restriction are facts about the address, not preferences
 *    an marketer may overwrite;
 *  - provenance is server-set: `effectiveAt`, `lastSeenAt` and the provider identifiers come from the
 *    event that created the block, so a later provider report refreshes the evidence rather than a person
 *    typing it.
 */

export interface SuppressionInput {
  readonly emailAddress?: string | undefined;
  readonly emailHash?: string | undefined;
  readonly channel?: ConsentChannel | undefined;
  readonly scope: SuppressionScope;
  readonly purpose?: CampaignPurpose | undefined;
  readonly targetListId?: string | undefined;
  readonly reason: SuppressionReason;
  readonly source?: string | undefined;
  readonly note?: string | undefined;
  readonly provider?: string | undefined;
  readonly providerEventId?: string | undefined;
}

export interface SuppressionView {
  readonly id: string;
  readonly emailHash: string;
  readonly channel: string;
  readonly scope: string;
  readonly purpose: string | null;
  readonly targetListId: string | null;
  readonly reason: string;
  readonly source: string | null;
  readonly effectiveAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly overridable: boolean;
}

/** One block that applies to a decision, in the order the eligibility matrix reports them. */
export interface AppliedSuppression {
  readonly reason: SuppressionReason;
  readonly scope: SuppressionScope;
}

@Injectable()
export class MarketingSuppressionService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Add or refresh a block. A repeat of the same identity+scope updates the evidence, not a second row. */
  async add(input: SuppressionInput): Promise<SuppressionView> {
    if (!(SUPPRESSION_SCOPES as readonly string[]).includes(input.scope)) {
      throw new ValidationError(`"${input.scope}" is not a suppression scope.`, { field: "scope" });
    }
    if (!(SUPPRESSION_REASONS as readonly string[]).includes(input.reason)) {
      throw new ValidationError(`"${input.reason}" is not a suppression reason.`, { field: "reason" });
    }
    this.checkShape(input);
    const emailHash = this.identity(input);
    await this.acl.assertAccess(MARKETING_SUPPRESSION_ENTITY, "create");

    const now = new Date().toISOString();
    const existing = await this.findLive({
      emailHash,
      channel: input.channel ?? "Email",
      scope: input.scope,
      purpose: input.scope === "Purpose" ? (input.purpose ?? "") : "",
      targetListId: input.scope === "TargetList" ? (input.targetListId ?? "") : "",
    });

    const data: Record<string, unknown> = {
      name: `${input.reason} · ${input.scope}`,
      emailHash,
      channel: input.channel ?? "Email",
      scope: input.scope,
      purpose: input.scope === "Purpose" ? (input.purpose ?? null) : null,
      targetListId: input.scope === "TargetList" ? (input.targetListId ?? null) : null,
      reason: input.reason,
      source: input.source ?? "ManualRecord",
      note: input.note ?? null,
      provider: input.provider ?? null,
      providerEventId: input.providerEventId ?? null,
      effectiveAt: existing?.data["effectiveAt"] ?? now,
      lastSeenAt: now,
    };

    const saved = existing === undefined
      ? await runAsMarketingSystem(this.scope, "suppressionAdd", () => this.entities.create(MARKETING_SUPPRESSION_ENTITY, data))
      : await runAsMarketingSystem(this.scope, "suppressionRefresh", () => this.entities.update(MARKETING_SUPPRESSION_ENTITY, existing.id, data));
    const row = await this.records.byId(MARKETING_SUPPRESSION_ENTITY, String(saved["id"]));
    if (row === undefined) throw new NotFoundError("Suppression could not be read back after writing.");
    return toView(row.id, row.data);
  }

  /**
   * Lift a block by recorded decision. A non-overridable reason refuses: an operator can clear a manual
   * block they made, not a provider's complaint or a hard bounce (§5.3 invariant 8).
   */
  async revoke(id: string, reason: string): Promise<SuppressionView> {
    const row = await this.records.byId(MARKETING_SUPPRESSION_ENTITY, id);
    if (row === undefined) throw new NotFoundError(`Suppression "${id}" does not exist.`);
    const reasonValue = row.data["reason"];
    if (typeof reasonValue === "string" && SUPPRESSION_OVERRIDABLE[reasonValue as SuppressionReason] === false) {
      throw new ValidationError(
        `A suppression raised as "${reasonValue}" cannot be lifted from the record API; it is a provider or legal fact and needs the reviewed path (§5.3).`,
        { code: "SUPPRESSION_NOT_OVERRIDABLE", id },
      );
    }
    await this.acl.assertAccess(MARKETING_SUPPRESSION_ENTITY, "edit");
    const actor = this.scope.principal;
    const saved = await runAsMarketingSystem(this.scope, "suppressionRevoke", () =>
      this.entities.update(MARKETING_SUPPRESSION_ENTITY, id, {
        revokedAt: new Date().toISOString(),
        revokedById: actor?.userId ?? "system",
        revokedReason: reason,
      }),
    );
    const after = await this.records.byId(MARKETING_SUPPRESSION_ENTITY, String(saved["id"]));
    if (after === undefined) throw new NotFoundError("Suppression could not be read back after revoking.");
    return toView(after.id, after.data);
  }

  /** Every live block that applies to this address for this purpose and audience. */
  async appliedFor(
    emailHash: string,
    options: { readonly channel?: ConsentChannel; readonly purpose?: CampaignPurpose; readonly targetListId?: string } = {},
  ): Promise<AppliedSuppression[]> {
    const rows = await this.records.findByAttrs(MARKETING_SUPPRESSION_ENTITY, { emailHash }, { limit: 50 });
    return rows.filter((row) => applies(row.data, options)).map((row) => toApplied(row.data));
  }

  /**
   * Bulk form of `appliedFor`: one read for the whole identity set, so resolving a large audience costs a
   * handful of queries instead of one per recipient (§5.2 "enforce query cost/time limits").
   */
  async appliedForMany(
    emailHashes: readonly string[],
    options: { readonly channel?: ConsentChannel; readonly purpose?: CampaignPurpose; readonly targetListId?: string } = {},
  ): Promise<Map<string, AppliedSuppression[]>> {
    const out = new Map<string, AppliedSuppression[]>();
    if (emailHashes.length === 0) return out;
    const rows = await this.records.findByAttrIn(MARKETING_SUPPRESSION_ENTITY, "emailHash", emailHashes, {
      limit: emailHashes.length * 8,
    });
    for (const row of rows) {
      if (!applies(row.data, options)) continue;
      const hash = typeof row.data["emailHash"] === "string" ? row.data["emailHash"] : "";
      const existing = out.get(hash) ?? [];
      existing.push(toApplied(row.data));
      out.set(hash, existing);
    }
    return out;
  }

  async list(options: { readonly emailHash?: string; readonly limit?: number } = {}): Promise<SuppressionView[]> {
    await this.acl.assertAccess(MARKETING_SUPPRESSION_ENTITY, "read");
    const filters: Record<string, string> = {};
    if (options.emailHash !== undefined) filters["emailHash"] = options.emailHash;
    const rows = await this.records.findByAttrs(MARKETING_SUPPRESSION_ENTITY, filters, {
      limit: options.limit ?? 200,
    });
    return rows
      .filter((row) => row.data["revokedAt"] === undefined || row.data["revokedAt"] === null)
      .map((row) => toView(row.id, row.data));
  }

  private checkShape(input: SuppressionInput): void {
    if (input.scope === "Purpose" && input.purpose === undefined) {
      throw new ValidationError("A purpose-scoped suppression must name the purpose.", { field: "purpose" });
    }
    if (input.scope === "TargetList" && input.targetListId === undefined) {
      throw new ValidationError("A list-scoped suppression must name the audience.", { field: "targetListId" });
    }
    if (input.scope === "Global" && (input.purpose !== undefined || input.targetListId !== undefined)) {
      throw new ValidationError(
        "A global suppression applies to every purpose and list; narrowing it in the same record would let a campaign that misses the narrowing send anyway.",
        { field: "scope" },
      );
    }
  }

  private identity(input: SuppressionInput): string {
    const direct = input.emailHash?.trim() ?? "";
    if (direct !== "") {
      if (!/^[0-9a-f]{64}$/.test(direct)) {
        throw new ValidationError("An address identity must be the 64-character digest this platform computes.", {
          field: "emailHash",
        });
      }
      return direct;
    }
    const identity = emailIdentity(normalizeEmailAddress(input.emailAddress), this.config.encryptionKey);
    if (identity === null) {
      throw new ValidationError("A suppression needs an email address or its identity.", {
        code: "SUPPRESSION_ADDRESS_REQUIRED",
      });
    }
    return identity.hash;
  }

  /** The live block for exactly this identity+scope, if one exists. */
  private async findLive(filters: Record<string, string>) {
    const rows = await this.records.findByAttrs(MARKETING_SUPPRESSION_ENTITY, {
      emailHash: filters["emailHash"] ?? "",
      channel: filters["channel"] ?? "Email",
      scope: filters["scope"] ?? "Global",
    }, { limit: 25 });
    // `purpose`/`targetListId` are stored null outside their own scope, and a null attribute is not
    // returned by an equality lookup, so the narrowing comparison happens here.
    return rows.find((row) => {
      if (row.data["revokedAt"] !== undefined && row.data["revokedAt"] !== null) return false;
      const purpose = row.data["purpose"];
      const list = row.data["targetListId"];
      const wantPurpose = filters["purpose"] ?? "";
      const wantList = filters["targetListId"] ?? "";
      return (purpose === null || purpose === undefined ? "" : String(purpose)) === wantPurpose
        && (list === null || list === undefined ? "" : String(list)) === wantList;
    });
  }
}

function applies(
  data: Record<string, unknown>,
  options: { readonly channel?: ConsentChannel; readonly purpose?: CampaignPurpose; readonly targetListId?: string },
): boolean {
  if (data["revokedAt"] !== undefined && data["revokedAt"] !== null) return false;
  const channel = data["channel"] ?? "Email";
  if (options.channel !== undefined && channel !== options.channel) return false;
  const scope = data["scope"];
  if (scope === "Global") return true;
  if (scope === "Channel") return true;
  if (scope === "Purpose") return options.purpose !== undefined && data["purpose"] === options.purpose;
  if (scope === "TargetList") {
    return options.targetListId !== undefined && data["targetListId"] === options.targetListId;
  }
  return false;
}

function toApplied(data: Record<string, unknown>): AppliedSuppression {
  return {
    reason: (typeof data["reason"] === "string" ? data["reason"] : "ManualBlock") as SuppressionReason,
    scope: (typeof data["scope"] === "string" ? data["scope"] : "Global") as SuppressionScope,
  };
}

function toView(id: string, data: Record<string, unknown>): SuppressionView {
  const reason = typeof data["reason"] === "string" ? data["reason"] : "";
  return {
    id,
    emailHash: typeof data["emailHash"] === "string" ? data["emailHash"] : "",
    channel: typeof data["channel"] === "string" ? data["channel"] : "Email",
    scope: typeof data["scope"] === "string" ? data["scope"] : "Global",
    purpose: typeof data["purpose"] === "string" ? data["purpose"] : null,
    targetListId: typeof data["targetListId"] === "string" ? data["targetListId"] : null,
    reason,
    source: typeof data["source"] === "string" ? data["source"] : null,
    effectiveAt: typeof data["effectiveAt"] === "string" ? data["effectiveAt"] : null,
    lastSeenAt: typeof data["lastSeenAt"] === "string" ? data["lastSeenAt"] : null,
    revokedAt: typeof data["revokedAt"] === "string" ? data["revokedAt"] : null,
    overridable: SUPPRESSION_OVERRIDABLE[reason as SuppressionReason] ?? true,
  };
}
