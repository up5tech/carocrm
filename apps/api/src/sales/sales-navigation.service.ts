import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { SALES_ENTITY_TYPES } from "./sales-records.js";

/**
 * Phase 19-S.17 task 5 — the module-visibility signal the navigation asked for.
 *
 * The Sales submenu in the SPA is built from the metadata every record entity contributes, so until
 * now it appeared for **every** signed-in user: the metadata ACL decides what a *record* shows, but
 * nothing decided whether the whole domain was worth showing. A user with no access to any Sales
 * entity got six categories of links that all answered `403`.
 *
 * This service answers one question from the platform's own ACL — *does this caller have read access
 * to at least one Sales entity?* — so the shell can hide the group instead of advertising it. It is a
 * report, not a gate: hiding a menu item is not a security control, and every route it hides is
 * already refused server-side.
 */
@Injectable()
export class SalesNavigationService {
  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  /**
   * The entities this caller may read, in the module's own order — one `canUser` per entity over the
   * principal's already-loaded role snapshot, so a navigation render costs one request and no extra
   * database work.
   */
  async visibility(): Promise<{
    visible: boolean;
    readableEntities: number;
    entities: readonly string[];
  }> {
    const entities: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      if ((await this.acl.canUser(entity, "read")) !== "no") entities.push(entity);
    }
    return {
      visible: entities.length > 0,
      readableEntities: entities.length,
      entities,
    };
  }
}
