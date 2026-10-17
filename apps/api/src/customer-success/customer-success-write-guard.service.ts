import { ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { HookRegistry } from "../hooks/hook.registry.js";
import {
  changedKeys,
  CUSTOMER_SUCCESS_ENTITY_TYPES,
  isCustomerSuccessInternalWrite,
  SERVER_OWNED_GOAL_FIELDS,
  SERVER_OWNED_PLAN_FIELDS,
  SERVER_OWNED_PLAYBOOK_RUN_FIELDS,
  SERVER_OWNED_PLAYBOOK_STEP_RUN_FIELDS,
  SERVER_OWNED_PLAYBOOK_TEMPLATE_FIELDS,
  SERVER_OWNED_PROFILE_FIELDS,
  SERVER_OWNED_RISK_FIELDS,
} from "./customer-success-internal.js";

/**
 * Phase 19-CS.14 — the write guard for Customer Success records.
 *
 * The domain commands are not the only way into a profile or a goal: `/api/v1/CustomerSuccessProfile/:id`
 * reaches the very same row. So this guard runs on `beforeValidate` — the phase every write passes
 * through — and refuses a **client** write that sets a field the server computes (a health score, an
 * override actor, a plan roll-up, a goal status, a playbook status or template steps). Writes
 * performed by a Customer Success domain service are marked (`runAsCustomerSuccessInternal`) and pass.
 *
 * It also makes the health snapshot append-only: a normal record request can neither create, edit nor
 * delete one (§5.4.4, §13.4).
 */

const SERVER_OWNED_BY_ENTITY: Readonly<Record<string, readonly string[]>> = {
  CustomerSuccessProfile: SERVER_OWNED_PROFILE_FIELDS,
  CustomerSuccessPlan: SERVER_OWNED_PLAN_FIELDS,
  CustomerSuccessGoal: SERVER_OWNED_GOAL_FIELDS,
  CustomerSuccessRisk: SERVER_OWNED_RISK_FIELDS,
  CustomerSuccessPlaybookTemplate: SERVER_OWNED_PLAYBOOK_TEMPLATE_FIELDS,
  CustomerSuccessPlaybookRun: SERVER_OWNED_PLAYBOOK_RUN_FIELDS,
  CustomerSuccessPlaybookStepRun: SERVER_OWNED_PLAYBOOK_STEP_RUN_FIELDS,
};

const GUARDED: ReadonlySet<string> = new Set(CUSTOMER_SUCCESS_ENTITY_TYPES);

@Injectable()
export class CustomerSuccessWriteGuardService implements OnApplicationBootstrap {
  constructor(@Inject(HookRegistry) private readonly hooks: HookRegistry) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  register(): void {
    this.hooks.register({
      name: "customerSuccess.writeGuard",
      phase: "beforeValidate",
      handler: (context) => this.validate(context),
    });
  }

  private validate(context: HookContext): void {
    if (!GUARDED.has(context.entity)) return;
    if (isCustomerSuccessInternalWrite()) return;
    const data = context.data;
    if (data === undefined) return;

    if (context.entity === "CustomerSuccessHealthSnapshot") {
      throw new ValidationError(
        "A health snapshot is written only by the health engine; it is append-only and cannot be created or edited through the record API.",
        { entity: context.entity },
      );
    }

    const owned = SERVER_OWNED_BY_ENTITY[context.entity] ?? [];
    const changed =
      context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
    const offending = changed.filter((key) => owned.includes(key));
    if (offending.length > 0) {
      throw new ValidationError(
        `These fields on ${context.entity} are computed by the Customer Success module and cannot be set through the record API: ${offending.join(", ")}.`,
        { entity: context.entity, fields: offending },
      );
    }
  }
}
