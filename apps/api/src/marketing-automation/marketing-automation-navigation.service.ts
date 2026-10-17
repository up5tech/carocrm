import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { MARKETING_AUTOMATION_NAVIGABLE_ENTITIES } from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.1 — the module-visibility signal the navigation asked for (§15 `19-MA.1` task 5).
 *
 * The SPA builds a nav group from the metadata every record entity contributes, so without this the
 * Marketing group would appear for **every** signed-in user and answer `403` on every link — the exact
 * problem `SalesNavigationService` records. This answers one question from the platform's own ACL: *does
 * this caller have read access to at least one Marketing Automation entity?*
 *
 * It is a report, not a gate. Hiding a menu item is not a security control, and every route it hides is
 * already refused server-side (AGENTS.md §5.3).
 */
@Injectable()
export class MarketingAutomationNavigationService {
  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  /** The entities this caller may read, in the module's own order — one `canUser` each, no extra queries. */
  async visibility(): Promise<{
    visible: boolean;
    readableEntities: number;
    entities: readonly string[];
  }> {
    const entities: string[] = [];
    for (const entity of MARKETING_AUTOMATION_NAVIGABLE_ENTITIES) {
      if ((await this.acl.canUser(entity, "read")) !== "no") entities.push(entity);
    }
    return {
      visible: entities.length > 0,
      readableEntities: entities.length,
      entities,
    };
  }
}
