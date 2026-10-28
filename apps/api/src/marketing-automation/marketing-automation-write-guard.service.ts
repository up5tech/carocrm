import { FeatureDisabledError, ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import { fieldIsFilterable, type FieldLookup,validateCriteria } from "./marketing-audience-criteria.js";
import {
  CAMPAIGN_CODE_MAX_LENGTH,
  CAMPAIGN_ENTITY,
  changedKeys,
  isCampaignStatus,
  isSupportedTimeZone,
  MARKETING_AUTOMATION_ENTITY_TYPES,
  MARKETING_CONSENT_ENTITY,
  MARKETING_SUPPRESSION_ENTITY,
  type MarketingAutomationEntityType,
  SEGMENT_ENTITY_TYPES,
  SUPPRESSION_SCOPES,
  TARGET_LIST_ENTITY,
} from "./marketing-automation-domain.js";
import {
  FEATURE_BY_ENTITY,
  INTERNAL_ONLY_ENTITIES,
  isMarketingInternalWrite,
  SERVER_OWNED_FIELDS_BY_ENTITY,
} from "./marketing-automation-internal.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";

/**
 * Phase 19-MA.3 – MA.5 — the Marketing Automation write guard
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §5.2, §5.3, §8.2, §8.4, §15 `19-MA.3`–`19-MA.5`).
 *
 * The generic record API reaches the same rows the domain services write, so these `beforeValidate` handlers
 * are what make the module's promises enforceable rather than advisory:
 *
 *  1. **a client may not write a server-owned field.** `status`, the lifecycle stamps, the validation report
 *     and its hash, consent `confirmedAt`/`withdrawnAt`, suppression provenance and revocation stamps are all
 *     produced by a command that has already validated the transition, the actor and the send-readiness
 *     report. A patch that could set them bypasses all three — which §8.2 forbids by name.
 *  2. **audit and credential rows are module-written only.** `CampaignTransition`, `TargetListEntry`,
 *     `MarketingConsentEvent`, `MarketingPublicToken`, `MarketingAudienceSnapshot` and
 *     `MarketingTemplateRevision` are evidence: a client-authored one is a fabricated history, a forged
 *     opt-in, a minted unsubscribe link, or a forged "what was actually sent" record (§6.2).
 *  3. **a stored audience is data, never executable content.** `criteriaJson` is parsed here against the
 *     entity/field/type/operator allowlist, so no audience can hold SQL, a formula or a field its author
 *     may not read (§5.2, §9.2). It is refused at the write, not at resolution time, when the marketer has
 *     already moved on.
 *  4. **an address identity is a digest, and a suppression scope is coherent.** A `Purpose` block without a
 *     purpose, or a `TargetList` block without a list, would silently widen itself at match time — the one
 *     failure mode a suppression list must not have — so the shape is checked here.
 *
 * A disabled capability refuses writes and leaves existing records readable (§17 of the Service Desk plan,
 * AGENTS.md §5.5). Portal principals are refused everywhere: no Marketing Automation record is portal-facing
 * in any delivered phase, so no payload from that surface should reach these tables at all (§9.2).
 */
@Injectable()
export class MarketingAutomationWriteGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  register(): void {
    for (const entity of MARKETING_AUTOMATION_ENTITY_TYPES) {
      this.hooks.register({
        name: `marketingAutomation.${entity}Guard`,
        phase: "beforeValidate",
        entity,
        handler: (context) => this.handle(entity, context),
      });
    }
    // The acquisition evidence Marketing Automation captures on a Lead (22.12) is written by the intake, not
    // typed into a record: a client that could set `formIntakeKey` could make a later submission look like a
    // duplicate of it, and a hand-written `campaignId` is an attribution claim the server never observed.
    this.hooks.register({
      name: "marketingAutomation.leadIntakeGuard",
      phase: "beforeValidate",
      entity: "Lead",
      handler: (context) => this.checkLeadIntake(context),
    });
  }

  private checkLeadIntake(context: HookContext): void {
    if (isMarketingInternalWrite()) return;
    const data = context.data;
    if (data === undefined) return;
    const changed =
      context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
    const offending = changed.filter((key) => LEAD_INTAKE_FIELDS.includes(key));
    if (offending.length > 0) {
      throw new ValidationError(
        `These fields on Lead are captured by the marketing intake and cannot be written through the record API: ${offending.join(", ")}.`,
        { entity: "Lead", fields: offending, code: "MARKETING_INTAKE_FIELDS_SERVER_OWNED" },
      );
    }
  }

  private async handle(entity: MarketingAutomationEntityType, context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    this.assertNotPortal(entity);
    const internal = isMarketingInternalWrite();

    const feature = FEATURE_BY_ENTITY[entity];
    if (!internal && feature !== undefined) {
      const settings = await this.settings.settings();
      const features = settings.features as unknown as Record<string, boolean>;
      if (features[feature] !== true) throw new FeatureDisabledError(feature);
    }

    if (INTERNAL_ONLY_ENTITIES.includes(entity) && !internal) {
      throw new ValidationError(
        `${entity} rows are written by Marketing Automation commands, never through the record API.`,
        { entity, code: "MARKETING_INTERNAL_WRITE_ONLY" },
      );
    }

    if (!internal) {
      const changed =
        context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
      const owned = SERVER_OWNED_FIELDS_BY_ENTITY[entity] ?? [];
      const offending = changed.filter((key) => owned.includes(key));
      if (offending.length > 0) {
        throw new ValidationError(
          `These fields on ${entity} are set by Marketing Automation commands and cannot be written through the record API: ${offending.join(", ")}.`,
          { entity, fields: offending },
        );
      }
    }

    if (entity === CAMPAIGN_ENTITY) await this.checkCampaign(context, data, internal);
    if (entity === TARGET_LIST_ENTITY) await this.checkTargetList(data, internal);
    if (entity === MARKETING_CONSENT_ENTITY || entity === MARKETING_SUPPRESSION_ENTITY) {
      this.checkAddressIdentity(entity, data);
    }
    if (entity === MARKETING_SUPPRESSION_ENTITY) this.checkSuppressionScope(data);
  }

  private async checkCampaign(
    context: HookContext,
    data: Record<string, unknown>,
    internal: boolean,
  ): Promise<void> {
    if (!internal && context.operation === "create") {
      const requested = data["status"];
      // Absent is fine — the metadata default is Draft. Anything else is a claim the server has not earned.
      if (requested !== undefined && requested !== null && requested !== "Draft") {
        throw new ValidationError(
          "A new campaign is created as a Draft; the schedule and start commands decide when it becomes live (§1.2).",
          { entity: CAMPAIGN_ENTITY, code: "CAMPAIGN_STATUS_COMMAND_ONLY" },
        );
      }
    }
    if (!internal) {
      const status = data["status"];
      if (status !== undefined && status !== null && !isCampaignStatus(status)) {
        throw new ValidationError(`"${String(status)}" is not a campaign status.`, { entity: CAMPAIGN_ENTITY });
      }
    }

    const code = typeof data["code"] === "string" ? data["code"].trim() : "";
    if (code !== "") {
      if (code.length > CAMPAIGN_CODE_MAX_LENGTH) {
        throw new ValidationError(
          `A campaign code is at most ${String(CAMPAIGN_CODE_MAX_LENGTH)} characters.`,
          { entity: CAMPAIGN_ENTITY, field: "code" },
        );
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code)) {
        throw new ValidationError(
          "A campaign code starts with a letter or digit and contains only letters, digits, dot, dash or underscore.",
          { entity: CAMPAIGN_ENTITY, field: "code" },
        );
      }
      const ownId = context.record?.id;
      if (await this.records.campaignCodeTaken(code, context.operation === "update" ? ownId : undefined)) {
        throw new ValidationError(`Campaign code "${code}" is already used by another campaign.`, {
          entity: CAMPAIGN_ENTITY,
          field: "code",
          code: "CAMPAIGN_CODE_TAKEN",
        });
      }
    }

    const timezone = data["timezone"];
    if (typeof timezone === "string" && timezone.trim() !== "" && !isSupportedTimeZone(timezone.trim())) {
      throw new ValidationError(`"${timezone}" is not a time zone this runtime understands.`, {
        entity: CAMPAIGN_ENTITY,
        field: "timezone",
      });
    }
  }

  /** Validate the stored audience criteria at the write, so no saved list can carry executable content. */
  private async checkTargetList(data: Record<string, unknown>, internal: boolean): Promise<void> {
    const mode = data["membershipMode"];
    if (mode !== undefined && mode !== null && mode !== "static" && mode !== "dynamic") {
      throw new ValidationError('Audience membership mode must be "static" or "dynamic".', {
        entity: TARGET_LIST_ENTITY,
        field: "membershipMode",
      });
    }
    const raw = data["criteriaJson"];
    if (raw === undefined || raw === null || raw === "") {
      if (mode === "dynamic" && !internal) {
        throw new ValidationError(
          "A dynamic audience needs criteria; without them it would resolve to nobody and look like a working list.",
          { entity: TARGET_LIST_ENTITY, field: "criteriaJson" },
        );
      }
      return;
    }
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    if (parsed === undefined) {
      throw new ValidationError("Audience criteria must be JSON.", {
        entity: TARGET_LIST_ENTITY,
        field: "criteriaJson",
      });
    }
    const check = validateCriteria(parsed, await this.fieldLookup());
    if (!check.ok) {
      throw new ValidationError(`Audience criteria are not valid: ${check.errors.join(" ")}`, {
        entity: TARGET_LIST_ENTITY,
        field: "criteriaJson",
        issues: check.errors,
      });
    }
  }

  /**
   * The criteria allowlist, resolved from metadata and from **this caller's** read grants.
   *
   * Filtering is a read channel: a criterion on a field the caller may not see, or on an entity they may
   * not read, would answer questions about records they cannot open (§5.2, §9.2). So the entity has to be
   * readable by the caller and the field has to be a filterable one in metadata. Record-level ACL is applied
   * again at resolution, where the query runs under the caller's own predicate.
   */
  private async fieldLookup(): Promise<FieldLookup> {
    const readable = new Set<string>();
    for (const entity of SEGMENT_ENTITY_TYPES) {
      if ((await this.acl.canUser(entity, "read")) !== "no") readable.add(entity);
    }
    const registry = this.metadata.registry;
    return {
      fieldType: (entity, field) => registry.getField(entity, field)?.type,
      filterable: (entity, field) =>
        readable.has(entity) && fieldIsFilterable(registry.getField(entity, field)),
    };
  }

  private checkAddressIdentity(entity: string, data: Record<string, unknown>): void {
    const hash = data["emailHash"];
    if (hash === undefined || hash === null) return;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new ValidationError(
        "An address identity must be the 64-character digest this platform computes from a normalised email address; free text is not accepted, because it would let a record be matched by guessing.",
        { entity, field: "emailHash" },
      );
    }
  }

  private checkSuppressionScope(data: Record<string, unknown>): void {
    const scope = typeof data["scope"] === "string" ? data["scope"] : undefined;
    if (scope === undefined) return;
    if (!(SUPPRESSION_SCOPES as readonly string[]).includes(scope)) {
      throw new ValidationError(`"${scope}" is not a suppression scope.`, {
        entity: MARKETING_SUPPRESSION_ENTITY,
        field: "scope",
      });
    }
    const purpose = typeof data["purpose"] === "string" ? data["purpose"] : undefined;
    const targetListId = typeof data["targetListId"] === "string" ? data["targetListId"] : undefined;
    if (scope === "Purpose" && purpose === undefined) {
      throw new ValidationError("A purpose-scoped suppression must name the purpose it applies to.", {
        entity: MARKETING_SUPPRESSION_ENTITY,
        field: "purpose",
      });
    }
    if (scope === "TargetList" && targetListId === undefined) {
      throw new ValidationError("A list-scoped suppression must name the audience it applies to.", {
        entity: MARKETING_SUPPRESSION_ENTITY,
        field: "targetListId",
      });
    }
    if (scope === "Global" && (purpose !== undefined || targetListId !== undefined)) {
      throw new ValidationError(
        "A global suppression applies to every purpose and list; narrowing it in the same record would let a campaign that does not match the narrowing send anyway.",
        { entity: MARKETING_SUPPRESSION_ENTITY, field: "scope" },
      );
    }
  }

  private assertNotPortal(entity: string): void {
    if (this.scope.userType === "portal") {
      throw new ValidationError(`Portal users may not write ${entity} records.`, {
        entity,
        code: "PORTAL_WRITE_NOT_SUPPORTED",
      });
    }
  }
}

/**
 * The acquisition evidence the public form captures on a `Lead` (22.12). A Lead is not a Marketing Automation
 * record, so this list sits apart from `SERVER_OWNED_FIELDS_BY_ENTITY` and is enforced by its own hook — the
 * intake writes it under the module's service identity, and nobody else may claim it.
 */
const LEAD_INTAKE_FIELDS: readonly string[] = ["campaignId", "utmSource", "utmMedium", "utmCampaign", "formIntakeKey"];

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
