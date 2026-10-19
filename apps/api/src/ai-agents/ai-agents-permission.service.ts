import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import {
  AI_AGENTS_CAPABILITIES,
  type AIAgentsCapabilityDefinition,
  type AIAgentsCapabilityKey,
} from './ai-agents-module.js';

/**
 * Phase 19-AI.2 — the module's capability gate
 * (PLAN_Phase_19_AI_Agents.md §11, §14.5, §20 `19-AI.2`).
 *
 * The platform has one authorization engine. Rather than inventing a parallel "agent permissions"
 * table, each module right is a **synthetic permission resource** evaluated by `AclApiService`, so
 * the same request-scoped role snapshot, the same `sysAdmin`/admin bypass and the same wildcard rule
 * apply. The consequences are documented in `docs/modules/ai-agents/repository-audit.md` §4.
 *
 * This service is the *only* place routes ask about agent capabilities. A route that calls
 * `AclApiService` directly for one of these keys would drift from the matrix.
 */
@Injectable()
export class AIAgentsPermissionService {
  private readonly definitions = new Map<AIAgentsCapabilityKey, AIAgentsCapabilityDefinition>(
    AI_AGENTS_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  definition(key: AIAgentsCapabilityKey): AIAgentsCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown AI Agents capability "${String(key)}".`);
    return found;
  }

  async level(key: AIAgentsCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: AIAgentsCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial. The caller learns the capability, not the roles. */
  async assert(key: AIAgentsCapabilityKey): Promise<void> {
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
      readonly key: AIAgentsCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: AIAgentsCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of AI_AGENTS_CAPABILITIES) {
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
  async capabilities(): Promise<Record<AIAgentsCapabilityKey, boolean>> {
    const out = {} as Record<AIAgentsCapabilityKey, boolean>;
    for (const capability of AI_AGENTS_CAPABILITIES) {
      out[capability.key] = (await this.level(capability.key)) !== 'no';
    }
    return out;
  }
}
