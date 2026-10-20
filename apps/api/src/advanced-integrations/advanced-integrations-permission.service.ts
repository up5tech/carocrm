import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import {
  ADVANCED_INTEGRATIONS_CAPABILITIES,
  type AdvancedIntegrationsCapabilityDefinition,
  type AdvancedIntegrationsCapabilityKey,
} from './advanced-integrations-module.js';

/**
 * Phase 19-INT.2 — the module's capability gate
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.1; `19-INT.2`).
 *
 * The platform has one authorization engine. Rather than inventing a parallel "integration
 * permissions" table, each module right is a **synthetic permission resource** evaluated by
 * `AclApiService`, so the same request-scoped role snapshot, the same `sysAdmin` bypass and the
 * same wildcard rule apply.
 *
 * This service is the *only* place routes ask about a capability. A route that called
 * `AclApiService` directly for one of these keys would drift from the matrix.
 */
@Injectable()
export class AdvancedIntegrationsPermissionService {
  private readonly definitions = new Map<AdvancedIntegrationsCapabilityKey, AdvancedIntegrationsCapabilityDefinition>(
    ADVANCED_INTEGRATIONS_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  definition(key: AdvancedIntegrationsCapabilityKey): AdvancedIntegrationsCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown Advanced Integrations capability "${String(key)}".`);
    return found;
  }

  async level(key: AdvancedIntegrationsCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: AdvancedIntegrationsCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial. The caller learns the capability, not the roles. */
  async assert(key: AdvancedIntegrationsCapabilityKey): Promise<void> {
    const definition = this.definition(key);
    if ((await this.level(key)) === 'no') {
      throw new AuthorizationDeniedError(`Permission "${definition.label}" is required for this action.`, {
        capability: definition.key,
        resource: definition.resource,
        action: definition.action,
      });
    }
  }

  /** Every right with its label — the UI uses this to explain what the caller may do. */
  async describe(): Promise<
    readonly {
      readonly key: AdvancedIntegrationsCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: AdvancedIntegrationsCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of ADVANCED_INTEGRATIONS_CAPABILITIES) {
      out.push({
        key: capability.key,
        label: capability.label,
        description: capability.description,
        granted: (await this.level(capability.key)) !== 'no',
      });
    }
    return out;
  }

  /** Every right for the current principal — the UI uses this to hide what it cannot do. */
  async capabilities(): Promise<Record<AdvancedIntegrationsCapabilityKey, boolean>> {
    const out = {} as Record<AdvancedIntegrationsCapabilityKey, boolean>;
    for (const capability of ADVANCED_INTEGRATIONS_CAPABILITIES) {
      out[capability.key] = (await this.level(capability.key)) !== 'no';
    }
    return out;
  }
}
