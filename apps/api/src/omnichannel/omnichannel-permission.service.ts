import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { OMNICHANNEL_CAPABILITIES, type OmnichannelCapabilityDefinition, type OmnichannelCapabilityKey } from './omnichannel-module.js';

/**
 * Phase 19-OM.2 — the module's capability gate (`PLAN_Phase_19_Omnichannel.md` §8.1, §14 `19-OM.2`;
 * `docs/omnichannel/feature-contract.md` §10).
 *
 * One authorization engine for the whole CRM: every Omnichannel right is a **synthetic permission
 * resource** evaluated by `AclApiService` (the pattern `ESignaturePermissionService` and
 * `AIAgentsPermissionService` established), so the same role snapshot, admin wildcard and denial
 * semantics apply. A denied caller learns the capability it lacks, never the roles that hold it.
 *
 * This service is the *only* place Omnichannel routes ask about a capability; a route that called
 * `AclApiService` directly with one of these resources would drift from the matrix.
 */
@Injectable()
export class OmnichannelPermissionService {
  private readonly definitions = new Map<OmnichannelCapabilityKey, OmnichannelCapabilityDefinition>(
    OMNICHANNEL_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  /** Public so the navigation report can name the resource the menu seed gates on. */
  definition(key: OmnichannelCapabilityKey): OmnichannelCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown Omnichannel capability "${String(key)}".`);
    return found;
  }

  async level(key: OmnichannelCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: OmnichannelCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial. The caller learns the capability, not the roles. */
  async assert(key: OmnichannelCapabilityKey): Promise<void> {
    const definition = this.definition(key);
    if ((await this.level(key)) === 'no') {
      throw new AuthorizationDeniedError(`Permission "${definition.label}" is required for this action.`, {
        capability: definition.key,
        resource: definition.resource,
        action: definition.action,
      });
    }
  }

  /** Every right with its label and the caller's answer — the SPA renders from this. */
  async describe(): Promise<
    readonly {
      readonly key: OmnichannelCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: OmnichannelCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of OMNICHANNEL_CAPABILITIES) {
      out.push({
        key: capability.key,
        label: capability.label,
        description: capability.description,
        granted: (await this.level(capability.key)) !== 'no',
      });
    }
    return out;
  }
}
