import type { AclRoleLevel } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { ESIGNATURE_CAPABILITIES, type ESignatureCapabilityDefinition, type ESignatureCapabilityKey } from './esignature-module.js';

/**
 * Phase 19-ES.1 — the module's capability gate
 * (`PLAN_Phase_19_ESignature.md` §12; `19-ES.1`).
 *
 * The platform has one authorization engine. Rather than inventing a parallel "signature
 * permissions" table, each module right is a **synthetic permission resource** evaluated by
 * `AclApiService`, so the same request-scoped role snapshot, the same `sysAdmin`/admin bypass and
 * the same wildcard rule apply (the pattern `AIAgentsPermissionService` established).
 *
 * This service is the *only* place routes ask about an ESignature capability. A route that called
 * `AclApiService` directly for one of these keys would drift from the matrix, and the matrix is
 * what plan §12 requires to be enforced on every API call, download, job and webhook side effect.
 * A denied caller learns the capability it lacks, never the roles that hold it.
 */
@Injectable()
export class ESignaturePermissionService {
  private readonly definitions = new Map<ESignatureCapabilityKey, ESignatureCapabilityDefinition>(
    ESIGNATURE_CAPABILITIES.map((capability) => [capability.key, capability]),
  );

  constructor(@Inject(AclApiService) private readonly acl: AclApiService) {}

  definition(key: ESignatureCapabilityKey): ESignatureCapabilityDefinition {
    const found = this.definitions.get(key);
    if (!found) throw new Error(`Unknown ESignature capability "${String(key)}".`);
    return found;
  }

  async level(key: ESignatureCapabilityKey): Promise<AclRoleLevel> {
    const definition = this.definition(key);
    return this.acl.canUser(definition.resource, definition.action);
  }

  async can(key: ESignatureCapabilityKey): Promise<boolean> {
    return (await this.level(key)) !== 'no';
  }

  /** 403 with a stable, non-revealing denial. The caller learns the capability, not the roles. */
  async assert(key: ESignatureCapabilityKey): Promise<void> {
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
      readonly key: ESignatureCapabilityKey;
      readonly label: string;
      readonly description: string;
      readonly granted: boolean;
    }[]
  > {
    const out: { key: ESignatureCapabilityKey; label: string; description: string; granted: boolean }[] = [];
    for (const capability of ESIGNATURE_CAPABILITIES) {
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
  async capabilities(): Promise<Record<ESignatureCapabilityKey, boolean>> {
    const out = {} as Record<ESignatureCapabilityKey, boolean>;
    for (const capability of ESIGNATURE_CAPABILITIES) {
      out[capability.key] = (await this.level(capability.key)) !== 'no';
    }
    return out;
  }
}
