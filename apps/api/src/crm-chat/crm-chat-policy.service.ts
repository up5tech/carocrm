import { FeatureDisabledError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { CRM_CHAT_FEATURES, type CRMChatFeatureKey } from './crm-chat-module.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';

/**
 * Phase 19-CHAT.2 — module policy gate
 * (PLAN_Phase_19_CRM_Chat.md §11.1, §13, §17 `19-CHAT.2`).
 *
 * Two independent decisions, always in this order and never merged:
 *
 *  1. **Permission** — does this caller hold the right at all? (`CRMChatPermissionService`)
 *  2. **Deployment flag** — has an administrator enabled the capability in this installation?
 *
 * A deployment switch never grants a right, and a role never overrides a switch. The only endpoint
 * that answers while the workspace is off is `GET action/capabilities` (so the shell can explain the
 * state) and the administrative settings endpoints (so an administrator can turn it back on).
 */
@Injectable()
export class CRMChatPolicyService {
  constructor(
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatSettingsService) private readonly settings: CRMChatSettingsService,
  ) {}

  /** Gate for every workspace read: permission first, then the deployment flag. */
  async assertWorkspace(): Promise<void> {
    await this.permissions.assert('use');
    const settings = await this.settings.settings();
    if (!settings.features.workspace) throw new FeatureDisabledError('CRM Chat workspace');
  }

  /** Gate for one capability behind its own flag and the flag's prerequisite chain. */
  async assertFeature(key: CRMChatFeatureKey): Promise<void> {
    await this.assertWorkspace();
    const feature = CRM_CHAT_FEATURES.find((candidate) => candidate.key === key);
    if (feature === undefined) throw new Error(`Unknown CRM Chat feature "${String(key)}".`);
    if (!(await this.settings.isFeatureEffective(key))) {
      throw new FeatureDisabledError(`CRM Chat ${feature.label.toLowerCase()}`);
    }
  }

  /**
   * Gate for any mutation. `features.actionProposals` is the product switch and
   * `safety.allowWrites` is the independent operator switch; both must be on (§13).
   */
  async assertWrites(): Promise<void> {
    await this.assertFeature('actionProposals');
    const settings = await this.settings.settings();
    if (!settings.safety.allowWrites) throw new FeatureDisabledError('CRM Chat write actions');
  }

  /** Whether a turn could be submitted right now, without throwing. */
  async isWorkspaceAvailable(): Promise<boolean> {
    if (!(await this.permissions.can('use'))) return false;
    const settings = await this.settings.settings();
    return settings.features.workspace;
  }
}
