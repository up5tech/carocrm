import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';

import { AclService } from '../service/index.js';
import type { AclCheckOptions, AclDecision } from '../types/index.js';

export interface GuardRequest {
  entity: string;
  action: AclCheckOptions['action'];
  record?: Record<string, unknown> | undefined;
  field?: string | undefined;
}

export class AclGuard {
  constructor(private readonly acl: AclService) {}

  async authorize(options: AclCheckOptions): Promise<AclDecision> {
    const decision = await this.acl.check(options);
    if (!decision.allowed) {
      throw new AuthorizationDeniedError(decision.reason ?? 'Access denied', {
        entity: options.entity,
        action: options.action,
      });
    }
    return decision;
  }
}

export const ACL_GUARD = Symbol('ACL_GUARD');
