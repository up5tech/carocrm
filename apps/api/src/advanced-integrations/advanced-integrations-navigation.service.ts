import { Inject, Injectable } from '@nestjs/common';

import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';

/**
 * Phase 19-INT.2 — the module-visibility signal the navigation asked for
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4; `19-INT.2`).
 *
 * `AdvancedIntegrations` owns no metadata entity: its connections are control-plane state in a
 * dedicated table, so the navigation would either be invisible or answer 403 on every link. This
 * answers one question from the platform's own ACL: *does this caller hold the module's read
 * capability?*
 *
 * It is a report, not a gate. Hiding a menu item is not a security control, and every route it
 * hides is already refused server-side (AGENTS.md §5.3).
 */
@Injectable()
export class AdvancedIntegrationsNavigationService {
  constructor(
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
  ) {}

  async visibility(): Promise<{
    readonly visible: boolean;
    readonly admin: boolean;
    readonly providers: number;
  }> {
    const admin = await this.permissions.can('providerAdmin');
    return {
      visible: await this.permissions.can('use'),
      admin,
      // The catalog is only meaningful to an administrator; a non-administrator is told nothing
      // about how many connectors exist.
      providers: admin ? this.registry.all().length : 0,
    };
  }
}
