import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { ADMIN_PERMISSION_ENTITY } from "./voice-communications-domain.js";

/**
 * Phase 19-VC.2 — the module-visibility signal the navigation asked for
 * (`PLAN_Phase_19_Voice_Communications.md` §12.4, §15 `19-VC.2` task 2).
 *
 * The SPA builds a nav group from the metadata every record entity contributes. Voice &
 * Communications owns no metadata entity yet (its records are dedicated tables, audit §6), so the
 * group would either be invisible or answer 403 on every link. This answers one question from the
 * platform's own ACL: *does this caller hold the module's administrative read capability?*
 *
 * It is a report, not a gate. Hiding a menu item is not a security control, and every route it hides
 * is already refused server-side (AGENTS.md §5.3). When the record surfaces land (19-VC.7/19-VC.12),
 * the entity list extends and this method reports them too.
 */
@Injectable()
export class VoiceCommunicationsNavigationService {
  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  async visibility(): Promise<{
    readonly visible: boolean;
    readonly readableEntities: number;
    readonly entities: readonly string[];
    readonly admin: boolean;
  }> {
    const admin = (await this.acl.canUser(ADMIN_PERMISSION_ENTITY, "read")) !== "no";
    const entities = admin ? [ADMIN_PERMISSION_ENTITY] : [];
    return {
      visible: admin,
      readableEntities: entities.length,
      entities,
      admin,
    };
  }
}
