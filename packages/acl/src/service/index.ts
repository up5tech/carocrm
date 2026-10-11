import { getRequestContext } from '@carocrm/core/context/index.js';
import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';

import { AclEvaluator } from '../evaluator/index.js';
import type { AclCheckOptions, AclDecision } from '../types/index.js';

export class AclService {
  constructor(private evaluator: AclEvaluator) {}

  async check(options: AclCheckOptions): Promise<AclDecision> {
    const context = getRequestContext();
    const userId = options.userId ?? context?.userId;
    const roles = options.roles ?? context?.roles ?? [];
    const teams = options.teams ?? [];

    if (!userId) {
      return { allowed: false, reason: 'No user context' };
    }

    const decision = await this.evaluator.evaluate({
      ...options,
      userId,
      roles,
      teams,
    });

    if (!decision.allowed) {
      log.debug({ ...options, decision }, 'ACL check denied');
    }

    return decision;
  }

  async requireAccess(options: AclCheckOptions): Promise<void> {
    const decision = await this.check(options);
    if (!decision.allowed) {
      throw new AuthorizationDeniedError(
        decision.reason ?? 'Access denied',
        { entity: options.entity, action: options.action },
      );
    }
  }

  async canCreate(entity: string): Promise<AclDecision> {
    const context = getRequestContext();
    return this.check({
      entity,
      action: 'create',
      userId: context?.userId,
      roles: context?.roles ?? [],
    });
  }

  async canRead(entity: string, record?: Record<string, unknown>): Promise<AclDecision> {
    const context = getRequestContext();
    return this.check({
      entity,
      action: 'read',
      record,
      userId: context?.userId,
      roles: context?.roles ?? [],
      teams: [],
    });
  }

  async canEdit(entity: string, record: Record<string, unknown>): Promise<AclDecision> {
    const context = getRequestContext();
    return this.check({
      entity,
      action: 'edit',
      record,
      userId: context?.userId,
      roles: context?.roles ?? [],
      teams: [],
    });
  }

  async canDelete(entity: string, record: Record<string, unknown>): Promise<AclDecision> {
    const context = getRequestContext();
    return this.check({
      entity,
      action: 'delete',
      record,
      userId: context?.userId,
      roles: context?.roles ?? [],
      teams: [],
    });
  }

  async canStream(entity: string, record: Record<string, unknown>): Promise<AclDecision> {
    const context = getRequestContext();
    return this.check({
      entity,
      action: 'stream',
      record,
      userId: context?.userId,
      roles: context?.roles ?? [],
      teams: [],
    });
  }

  registerRole(
    roleId: string,
    entityPermissions: Record<string, Record<string, 'yes' | 'all' | 'team' | 'own' | 'no'>>,
    fieldPermissions?: Record<string, Record<string, Record<string, 'yes' | 'all' | 'team' | 'own' | 'no'>>>,
  ): void {
    this.evaluator.registerRole(roleId, entityPermissions, fieldPermissions);
  }

  getFieldAccess(roleId: string, entity: string, field: string, action: 'read' | 'edit'): 'yes' | 'all' | 'team' | 'own' | 'no' {
    return this.evaluator.getFieldAccess(roleId, entity, field, action);
  }

  isFieldVisible(roleId: string, entity: string, field: string): boolean {
    return this.evaluator.isFieldVisible(roleId, entity, field);
  }

  isFieldEditable(roleId: string, entity: string, field: string): boolean {
    return this.evaluator.isFieldEditable(roleId, entity, field);
  }
}

export const ACL_SERVICE = Symbol('ACL_SERVICE');