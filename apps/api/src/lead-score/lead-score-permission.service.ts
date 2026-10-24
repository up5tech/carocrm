import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { LEADSCORE_CAPABILITIES, type LeadScoreCapabilityDefinition, type LeadScoreCapabilityKey } from './lead-score-module.js';

/**
 * Phase 19-LS.1 — the module's capability gate
 * (`PLAN_Phase_19_LeadScore.md` §9.1, §9.2; audit §2, §9).
 *
 * The platform has one authorization engine. Rather than inventing a parallel "lead score
 * permissions" table, each module right is a **synthetic permission resource** evaluated by
 * `AclApiService`, so the same request-scoped role snapshot, the same admin bypass and the same
 * wildcard rule apply — the pattern `AIAgentsPermissionService` and `ESignaturePermissionService`
 * established.
 *
 * This service is the *only* place a route asks about a Lead Score capability. A route that called
 * `AclApiService` directly with one of these keys would drift from the matrix, and the matrix is what
 * plan §9.2 requires to be enforced server-side on every read, calculation, preview and conversion.
 * Hiding a badge in the SPA is not authorization (AGENTS.md §5.3).
 *
 * A denied caller learns the capability it lacks, never which roles hold it.
 */
@Injectable()
export class LeadScorePermissionService {
  private readonly definitions = new Map<LeadScoreCapabilityKey, LeadScoreCapabilityDefinition>(
    LEADSCORE_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  definition(key: LeadScoreCapabilityKey): LeadScoreCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown LeadScore capability "${String(key)}".`);
    return found;
  }

  async level(key: LeadScoreCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: LeadScoreCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial. The caller learns the capability, not the roles. */
  async assert(key: LeadScoreCapabilityKey): Promise<void> {
    const definition = this.definition(key);
    if ((await this.level(key)) === 'no') {
      throw new AuthorizationDeniedError(`Permission "${definition.label}" is required for this action.`, {
        capability: definition.key,
        resource: definition.resource,
        action: definition.action,
      });
    }
  }

  /** Every right with its label and whether this caller holds it — what the UI explains itself with. */
  async describe(): Promise<
    readonly {
      readonly key: LeadScoreCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: LeadScoreCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of LEADSCORE_CAPABILITIES) {
      out.push({
        key: capability.key,
        label: capability.label,
        description: capability.description,
        granted: (await this.level(capability.key)) !== 'no',
      });
    }
    return out;
  }

  /** Every right for the current principal, as a flat map the SPA can read a switch off. */
  async capabilities(): Promise<Record<LeadScoreCapabilityKey, boolean>> {
    const out = {} as Record<LeadScoreCapabilityKey, boolean>;
    for (const capability of LEADSCORE_CAPABILITIES) {
      out[capability.key] = (await this.level(capability.key)) !== 'no';
    }
    return out;
  }
}
