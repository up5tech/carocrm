import { FeatureDisabledError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { AIAgentsCapabilityKey } from './ai-agents-module.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';

/**
 * Phase 19-AI.2 — module policy gate
 * (PLAN_Phase_19_AI_Agents.md §8.5, §19.2, §20 `19-AI.2`).
 *
 * Every future path that creates a run or executes a high-impact tool calls this service first. The
 * two switches are deliberately separate:
 *
 *  - `features.execution` is the deployment-level rollout gate and defaults to **false**;
 *  - `safety.globalExecutionPaused` is the operator kill switch and can be toggled at runtime.
 *
 * Neither deletes configuration, runs, audit rows or published versions. Neither is a client input:
 * both are read from the `aiAgents` settings row on the server.
 */
@Injectable()
export class AIAgentsPolicyService {
  constructor(
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
  ) {}

  /** Definitions may be prepared while execution is off; this is the gate for draft/version writes. */
  async assertDefinitionsEnabled(): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.definitions) throw new FeatureDisabledError('AI agent definitions');
  }

  /**
   * The single gate a run-creation path must call. Permission and policy are both required: a
   * deployment switch never grants a right, and a role never overrides a deployment switch.
   */
  async assertCanStartRun(): Promise<void> {
    await this.permissions.assert('use');
    await this.assertExecutionEnabled();
  }

  async assertExecutionEnabled(): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.execution) throw new FeatureDisabledError('AI agent execution');
    if (settings.safety.globalExecutionPaused) throw new FeatureDisabledError('AI agent execution (global pause)');
  }

  async isExecutionAvailable(): Promise<boolean> {
    const settings = await this.settings.settings();
    return settings.features.execution && !settings.safety.globalExecutionPaused;
  }

  /** Future write tools call this in addition to their own effect-class approval rule. */
  async assertHighImpactAllowed(capability: AIAgentsCapabilityKey = 'use'): Promise<void> {
    await this.permissions.assert(capability);
    await this.assertExecutionEnabled();
  }
}
