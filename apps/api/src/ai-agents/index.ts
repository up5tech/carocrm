import type { Provider } from '@nestjs/common';

import { AIAgentApprovalService } from './ai-agent-approvals.service.js';
import { AIAgentDefinitionService } from './ai-agent-definitions.service.js';
import { AIAgentEvaluationService } from './ai-agent-evaluations.service.js';
import { AIAgentMemoryService } from './ai-agent-memory.service.js';
import { AIAgentPricingService } from './ai-agent-pricing.service.js';
import { AIAgentQuotaService } from './ai-agent-quota.service.js';
import { AIAgentRunService } from './ai-agent-runs.service.js';
import { AIToolRegistry } from './ai-agent-tools.js';
import { AIAgentsController } from './ai-agents.controller.js';
import { AIAgentsModuleHealthService } from './ai-agents-module-health.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderRegistry } from './ai-provider.js';
import { AnthropicProviderAdapter } from './ai-provider-anthropic.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';
import { FakeProviderAdapter } from './ai-provider-fake.js';
import { AIProviderGateway } from './ai-provider-gateway.service.js';
import { OpenAICompatibleProviderAdapter } from './ai-provider-openai-compatible.js';

export { AIAgentApprovalService } from './ai-agent-approvals.service.js';
export type { AgentVersionDetail, AgentView } from './ai-agent-definitions.service.js';
export { AIAgentDefinitionService } from './ai-agent-definitions.service.js';
export { AIAgentEvaluationService } from './ai-agent-evaluations.service.js';
export { AI_AGENT_RETENTION_JOB, AI_AGENT_RUN_JOB } from './ai-agent-jobs.js';
export { AIAgentMemoryService } from './ai-agent-memory.service.js';
export { AIAgentPricingService } from './ai-agent-pricing.service.js';
export { AIAgentQuotaService } from './ai-agent-quota.service.js';
export type { AIAgentRunView, RunCreateInput, RunExecutionResult } from './ai-agent-runs.service.js';
export { AIAgentRunService } from './ai-agent-runs.service.js';
export { EFFECT_CLASSES, RUN_STATUSES, RUN_TRIGGERS } from './ai-agents-module.js';
export type { EffectClass, RunStatus, RunTrigger } from './ai-agents-module.js';
export { AIToolRegistry } from './ai-agent-tools.js';
export type { AIToolContext, AIToolDefinition, AIToolProposal, AIToolResult } from './ai-agent-tools.js';
export { AI_AGENTS_MODULE } from './ai-agents-module.js';
export { AIAgentsPermissionService } from './ai-agents-permission.service.js';
export { AIAgentsPolicyService } from './ai-agents-policy.service.js';
export { AIAgentsSettingsService } from './ai-agents-settings.service.js';
export { AIProviderRegistry } from './ai-provider.js';
export { AnthropicProviderAdapter } from './ai-provider-anthropic.js';
export { AI_PROVIDER_PRESETS, providerPresets } from './ai-provider-presets.js';

/**
 * `AIAgents` barrel (AGENTS.md §5.1, docs/module-guide.md).
 *
 * `AI_AGENTS_CONTROLLERS` owns the static `/api/v1/AIAgents` prefix and is spread before
 * `ENTITY_CONTROLLERS` in `AppModule`. The provider list contains only the module's own services;
 * the kernel seams it depends on (`AclApiService`, `METADATA_STORE`, `DatabaseService`,
 * `CONFIG_TOKEN`, `REQUEST_SCOPE_TOKEN`) are already registered by the kernel.
 *
 * The fake adapter is registered **only outside production**, so a live deployment cannot select a
 * provider that fabricates answers. Tests boot with `NODE_ENV=test`.
 */
export const AI_AGENTS_CONTROLLERS = [AIAgentsController];

export const AI_AGENTS_PROVIDERS: Provider[] = [
  AIAgentsSettingsService,
  AIAgentsPermissionService,
  AIAgentsPolicyService,
  AIAgentsModuleHealthService,
  AIToolRegistry,
  AIAgentDefinitionService,
  AIAgentEvaluationService,
  AIAgentMemoryService,
  AIAgentPricingService,
  AIAgentQuotaService,
  AIAgentRunService,
  AIAgentApprovalService,
  AIProviderConnectionService,
  AIProviderGateway,
  AnthropicProviderAdapter,
  OpenAICompatibleProviderAdapter,
  FakeProviderAdapter,
  {
    provide: AIProviderRegistry,
    inject: [OpenAICompatibleProviderAdapter, AnthropicProviderAdapter, FakeProviderAdapter],
    useFactory: (
      openai: OpenAICompatibleProviderAdapter,
      anthropic: AnthropicProviderAdapter,
      fake: FakeProviderAdapter,
    ): AIProviderRegistry => {
      const registry = new AIProviderRegistry();
      registry.register(openai);
      registry.register(anthropic);
      if (process.env.NODE_ENV !== 'production') registry.register(fake);
      return registry;
    },
  },
];
