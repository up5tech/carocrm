import type { Provider } from '@nestjs/common';

import { AIAgentsController } from './ai-agents.controller.js';
import { AIAgentsModuleHealthService } from './ai-agents-module-health.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderRegistry } from './ai-provider.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';
import { FakeProviderAdapter } from './ai-provider-fake.js';
import { AIProviderGateway } from './ai-provider-gateway.service.js';
import { OpenAICompatibleProviderAdapter } from './ai-provider-openai-compatible.js';

export { AI_AGENTS_MODULE } from './ai-agents-module.js';
export { AIAgentsSettingsService } from './ai-agents-settings.service.js';
export { AIProviderRegistry } from './ai-provider.js';

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
  AIProviderConnectionService,
  AIProviderGateway,
  OpenAICompatibleProviderAdapter,
  FakeProviderAdapter,
  {
    provide: AIProviderRegistry,
    inject: [OpenAICompatibleProviderAdapter, FakeProviderAdapter],
    useFactory: (
      openai: OpenAICompatibleProviderAdapter,
      fake: FakeProviderAdapter,
    ): AIProviderRegistry => {
      const registry = new AIProviderRegistry();
      registry.register(openai);
      if (process.env.NODE_ENV !== 'production') registry.register(fake);
      return registry;
    },
  },
];
