import { Inject, Injectable } from '@nestjs/common';

import type { AgentView } from '../ai-agents/ai-agent-definitions.service.js';
import { AIAgentDefinitionService } from '../ai-agents/ai-agent-definitions.service.js';
import { AIAgentsSettingsService } from '../ai-agents/ai-agents-settings.service.js';
import type { AssistantStateKey } from './crm-chat-module.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';

/**
 * Phase 19-CHAT.2 — assistant readiness
 * (PLAN_Phase_19_CRM_Chat.md §4.4, §14.1, §17 `19-CHAT.2`).
 *
 * Chat never selects an agent implicitly. The administrator stores the **key** of the published
 * profile that answers, and this service answers one question: is that profile able to serve a turn
 * right now? The answer is read from the owners' own services (`AIAgentDefinitionService`,
 * `AIAgentsSettingsService`), never from their tables.
 *
 * The states are ordered so the first unmet requirement is the one reported — an administrator fixes
 * them top-down. `ready` is the only state in which a turn may be submitted (19-CHAT.5).
 *
 * The audit found two preconditions that are *not* Chat's to flip: `aiAgents.features.execution`
 * (default off) and `aiAgents.features.memory` (default off, and `conversationForRun` refuses a
 * conversation id without it). Both are reported, not overridden.
 */
export interface AssistantReadiness {
  readonly state: AssistantStateKey;
  /** A short, user-safe explanation; never contains provider details or credentials. */
  readonly reason: string;
  readonly configuredKey: string;
  readonly agentId: string | null;
  readonly name: string | null;
  readonly version: number | null;
  /** Tool keys the published version captured, for the diagnostics panel. */
  readonly tools: readonly string[];
  /** How many turns of history the agent puts in its prompt; 0 when memory is off. */
  readonly memoryMessages: number;
}

const UNAVAILABLE: Omit<AssistantReadiness, 'configuredKey' | 'reason'> = {
  state: 'unresolvable',
  agentId: null,
  name: null,
  version: null,
  tools: [],
  memoryMessages: 0,
};

@Injectable()
export class CRMChatAssistantService {
  constructor(
    @Inject(CRMChatSettingsService) private readonly settings: CRMChatSettingsService,
    @Inject(AIAgentDefinitionService) private readonly agents: AIAgentDefinitionService,
    @Inject(AIAgentsSettingsService) private readonly aiSettings: AIAgentsSettingsService,
  ) {}

  async readiness(): Promise<AssistantReadiness> {
    const configuredKey = (await this.settings.settings()).assistant.agentKey;
    if (configuredKey === '') {
      return {
        ...UNAVAILABLE,
        state: 'not-configured',
        configuredKey,
        reason: 'No assistant agent is configured. An administrator selects a published agent profile.',
      };
    }

    let agent: AgentView | undefined;
    try {
      agent = await this.resolveByKey(configuredKey);
    } catch (error) {
      // A caller without the AI Agent read capability, or a module whose definitions are paused, must
      // still open the workspace and see why it cannot answer. Reporting beats propagating a 403.
      return {
        ...UNAVAILABLE,
        configuredKey,
        reason: error instanceof Error ? error.message : `Agent "${configuredKey}" could not be resolved.`,
      };
    }
    if (agent === undefined) {
      return {
        ...UNAVAILABLE,
        state: 'not-found',
        configuredKey,
        reason: `No agent with the key "${configuredKey}" exists.`,
      };
    }
    const base = {
      configuredKey,
      agentId: agent.id,
      name: agent.name,
      version: agent.currentVersion,
    };
    if (agent.status !== 'published' || agent.currentVersion === null) {
      return {
        ...base,
        tools: [],
        memoryMessages: 0,
        state: 'not-published',
        reason: `The agent "${agent.name}" is ${agent.status}; only a published version can answer.`,
      };
    }

    const aiSettings = await this.aiSettings.settings();
    if (!aiSettings.features.execution) {
      return {
        ...base,
        tools: [],
        memoryMessages: 0,
        state: 'execution-disabled',
        reason: 'AI Agent execution is disabled. An administrator enables features.execution in AI Agents.',
      };
    }
    if (aiSettings.safety.globalExecutionPaused) {
      return {
        ...base,
        tools: [],
        memoryMessages: 0,
        state: 'execution-paused',
        reason: aiSettings.safety.reason ?? 'AI Agent execution is globally paused by the operator kill switch.',
      };
    }
    if (!aiSettings.features.memory) {
      return {
        ...base,
        tools: [],
        memoryMessages: 0,
        state: 'memory-disabled',
        reason: 'AI Agent conversation memory is disabled, so a multi-turn Chat cannot be stored.',
      };
    }

    const version = await this.agents.version(agent.id, agent.currentVersion);
    const tools = version.tools.filter((tool) => tool.enabled).map((tool) => tool.key);
    if (version.config.memory.mode !== 'conversation') {
      return {
        ...base,
        tools,
        memoryMessages: 0,
        state: 'agent-memory-off',
        reason: `The published version of "${agent.name}" uses memory.mode "${version.config.memory.mode}"; Chat needs "conversation".`,
      };
    }
    return {
      ...base,
      tools,
      memoryMessages: version.config.memory.maxMessages,
      state: 'ready',
      reason: `Answered by "${agent.name}" version ${String(agent.currentVersion)}.`,
    };
  }

  /**
   * `AIAgentDefinitionService` has no key lookup because keys are unique per installation and the
   * service is id-based; the UI search endpoint already filters on the key, so one bounded search
   * plus an exact match is enough and keeps the contract narrow.
   */
  private async resolveByKey(key: string): Promise<AgentView | undefined> {
    const result = await this.agents.list({ q: key, maxSize: 50 });
    return result.list.find((candidate) => candidate.key === key);
  }
}
