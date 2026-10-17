import { FeatureDisabledError, ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../hooks/hook.registry.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import {
  CASE_ENTITY,
  checkRoutingConditions,
  hasRequesterReference,
  isCaseAssignmentStrategy,
  isCaseFallbackBehavior,
} from "./service-desk-domain.js";
import {
  changedKeys,
  isServiceDeskInternalWrite,
  SERVER_OWNED_CASE_FIELDS,
} from "./service-desk-internal.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.3 – 19-SD.5 — the `Case` write guard, number allocator and routing-rule validator
 * (PLAN_Phase_19_ServiceDesk.md §5.1 invariants, §5.3 routing rules, §7.3, §11.1).
 *
 * The generic record API reaches the very same row the domain services write, so these
 * `beforeValidate` handlers enforce the case invariants every write must satisfy:
 *
 *  1. a **client** write may not set a server-owned field (the case number, timeline stamps, SLA and
 *     escalation state, ownership); a Service Desk domain service marked with
 *     `runAsServiceDeskInternal` may;
 *  2. a new case must carry a requester reference (a CRM record or a channel-supplied address);
 *  3. a new case receives its case number from the atomic sequence, at creation, once;
 *  4. a routing rule is validated at save time — declarative conditions only, a known strategy and a
 *     real target — so no stored rule can become executable code (§5.3 "never evaluate arbitrary
 *     JavaScript or SQL stored in a routing rule").
 *
 * `caseManagement`/`queues` off refuses writes for non-internal callers but leaves existing records
 * readable, matching the documented disabled-capability behaviour (§17).
 */
@Injectable()
export class ServiceDeskWriteGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(CaseNumberingService) private readonly numbering: CaseNumberingService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  register(): void {
    this.hooks.register({
      name: "serviceDesk.caseWriteGuard",
      phase: "beforeValidate",
      entity: CASE_ENTITY,
      handler: (context) => this.handle(context),
    });
    for (const entity of ["CaseQueue", "QueueMember", "RoutingRule"]) {
      this.hooks.register({
        name: `serviceDesk.${entity}Guard`,
        phase: "beforeValidate",
        entity,
        handler: (context) => this.handleQueueConfiguration(context),
      });
    }
  }

  private async handle(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    const internal = isServiceDeskInternalWrite();

    if (!internal) {
      const settings = await this.settings.settings();
      if (!settings.features.caseManagement) {
        throw new FeatureDisabledError("caseManagement");
      }
      const changed =
        context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
      const offending = changed.filter((key) => SERVER_OWNED_CASE_FIELDS.includes(key));
      if (offending.length > 0) {
        throw new ValidationError(
          `These fields on Case are set by the Service Desk module and cannot be written through the record API: ${offending.join(", ")}.`,
          { entity: CASE_ENTITY, fields: offending },
        );
      }
    }

    // The requester invariant (§5.1) holds for every create, client or internal: a case that names
    // no customer cannot be worked or reported on.
    if (context.operation === "create" && !hasRequesterReference(data)) {
      throw new ValidationError(
        "A case needs a requester: an Account, Contact, Lead, requester name or requester email.",
        { entity: CASE_ENTITY },
      );
    }

    // Allocate the case number once, at creation, when the caller did not supply one (a domain
    // service may pre-set it; a client never can — the check above rejected that).
    if (context.operation !== "create") return;
    const current = data["caseNumber"];
    if (typeof current === "string" && current.trim() !== "") return;
    const allocation = await this.numbering.allocate();
    data["caseNumber"] = allocation.formatted;
  }

  /**
   * Validate queue configuration at save time (§5.3 "rules should be data-driven and validated at
   * save time"). Routing conditions are parsed here and every value is checked against the field and
   * operator allowlists, so a stored rule can never carry executable content. The write itself is
   * refused while the `queues` capability is off (for non-internal callers) — the same disabled-
   * capability rule the case guard applies.
   */
  private async handleQueueConfiguration(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    if (!isServiceDeskInternalWrite()) {
      const settings = await this.settings.settings();
      if (!settings.features.queues) throw new FeatureDisabledError("queues");
    }

    if (context.entity === "RoutingRule") {
      const raw = data["conditions"];
      if (raw !== undefined && raw !== null && raw !== "") {
        const conditions = parseConditionsInput(raw);
        if (conditions === undefined) {
          throw new ValidationError(
            "Routing rule conditions must be a JSON array of { field, operator, value } objects.",
            { entity: "RoutingRule" },
          );
        }
        const check = checkRoutingConditions(conditions);
        if (!check.ok) {
          throw new ValidationError(check.message ?? "Invalid routing condition.", { entity: "RoutingRule" });
        }
      }
      if (data["strategy"] !== undefined && !isCaseAssignmentStrategy(data["strategy"])) {
        throw new ValidationError('Routing rule strategy must be "manual", "roundRobin" or "leastBusy".', {
          entity: "RoutingRule",
        });
      }
      if (data["fallbackBehavior"] !== undefined && !isCaseFallbackBehavior(data["fallbackBehavior"])) {
        throw new ValidationError('Routing rule fallbackBehavior must be "unassigned" or "fallbackOwner".', {
          entity: "RoutingRule",
        });
      }
    }

    if (context.entity === "CaseQueue") {
      if (data["strategy"] !== undefined && !isCaseAssignmentStrategy(data["strategy"])) {
        throw new ValidationError('Queue strategy must be "manual", "roundRobin" or "leastBusy".', {
          entity: "CaseQueue",
        });
      }
      if (data["fallbackBehavior"] !== undefined && !isCaseFallbackBehavior(data["fallbackBehavior"])) {
        throw new ValidationError('Queue fallbackBehavior must be "unassigned" or "fallbackOwner".', {
          entity: "CaseQueue",
        });
      }
    }
  }
}

/** Accept the JSON string the generic text field stores, or an already-decoded array. */
function parseConditionsInput(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
