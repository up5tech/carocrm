import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import {
  CRM_CHAT_CAPABILITIES,
  type CRMChatCapabilityDefinition,
  type CRMChatCapabilityKey,
} from './crm-chat-module.js';

/**
 * Phase 19-CHAT.2 — the module's capability gate
 * (PLAN_Phase_19_CRM_Chat.md §7, §12.1, §17 `19-CHAT.2`).
 *
 * One authorization engine, one evaluator. Each Chat right is a **synthetic permission resource**
 * checked by `AclApiService`, so the same request-scoped role snapshot, the same `sysAdmin`/admin
 * bypass and the same wildcard rule apply. No parallel "chat permissions" table exists, and no route
 * may call `AclApiService` directly for one of these keys — that would drift from the matrix.
 *
 * Record-level and field-level access are *not* covered here: they belong to the CRM tools a turn
 * invokes, which run inside the caller's own scope through the Entity Engine.
 */
@Injectable()
export class CRMChatPermissionService {
  private readonly definitions = new Map<CRMChatCapabilityKey, CRMChatCapabilityDefinition>(
    CRM_CHAT_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  definition(key: CRMChatCapabilityKey): CRMChatCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown CRM Chat capability "${String(key)}".`);
    return found;
  }

  async level(key: CRMChatCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: CRMChatCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial: the caller learns the capability, not the roles. */
  async assert(key: CRMChatCapabilityKey): Promise<void> {
    const definition = this.definition(key);
    if ((await this.level(key)) === 'no') {
      throw new AuthorizationDeniedError(`Permission "${definition.label}" is required for this action.`, {
        capability: definition.key,
        resource: definition.resource,
        action: definition.action,
      });
    }
  }

  /** Every right with its label — the workspace explains what the caller may do. */
  async describe(): Promise<
    readonly {
      readonly key: CRMChatCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: CRMChatCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of CRM_CHAT_CAPABILITIES) {
      out.push({
        key: capability.key,
        label: capability.label,
        description: capability.description,
        granted: (await this.level(capability.key)) !== 'no',
      });
    }
    return out;
  }

  /** Every right for the current principal — the UI hides what it cannot do. */
  async capabilities(): Promise<Record<CRMChatCapabilityKey, boolean>> {
    const out = {} as Record<CRMChatCapabilityKey, boolean>;
    for (const capability of CRM_CHAT_CAPABILITIES) {
      out[capability.key] = (await this.level(capability.key)) !== 'no';
    }
    return out;
  }
}
