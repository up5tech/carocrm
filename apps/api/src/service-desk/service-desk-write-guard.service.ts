import { FeatureDisabledError, ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../hooks/hook.registry.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import { CASE_ENTITY, hasRequesterReference } from "./service-desk-domain.js";
import {
  changedKeys,
  isServiceDeskInternalWrite,
  SERVER_OWNED_CASE_FIELDS,
} from "./service-desk-internal.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.3 — the `Case` write guard and number allocator
 * (PLAN_Phase_19_ServiceDesk.md §5.1 invariants, §7.3, §11.1).
 *
 * The generic record API reaches the very same row the domain services write, so this single
 * `beforeValidate` handler — one handler, so its two jobs run in a fixed order regardless of provider
 * registration order — enforces the case invariants every write must satisfy:
 *
 *  1. a **client** write may not set a server-owned field (the case number, timeline stamps, SLA and
 *     escalation state); a Service Desk domain service marked with `runAsServiceDeskInternal` may;
 *  2. a new case must carry a requester reference (a CRM record or a channel-supplied address);
 *  3. a new case receives its case number from the atomic sequence, at creation, once.
 *
 * `caseManagement` off refuses create/edit for non-internal callers but leaves existing cases
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
}
