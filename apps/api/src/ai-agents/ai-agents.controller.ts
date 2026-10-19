import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { AIAgentsModuleHealthService } from './ai-agents-module-health.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';
import { AIProviderGateway } from './ai-provider-gateway.service.js';
import {
  ProviderCheckSchema,
  ProviderConnectionCreateSchema,
  ProviderConnectionPatchSchema,
} from './dto/ai-agents-shapes.js';

/**
 * Phase 19-AI.2–19-AI.4 — the `AIAgents` foundation API
 * (PLAN_Phase_19_AI_Agents.md §14, §20 `19-AI.2`–`19-AI.4`).
 *
 * Only the foundation routes exist here: diagnostics, capability introspection, module settings and
 * provider connections. Definition, run, approval, usage and evaluation routes arrive with their
 * own sub-phases. Entity CRUD is not involved — agent lifecycle data has dedicated tables.
 *
 * Every route checks a capability server-side. Hiding a control in the SPA is never authorization.
 * Every request shape is strict; the controller parses shape, the services enforce policy.
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `AIAgents` prefix can never be swallowed by
 * the generic `:entity` wildcard.
 */
@ApiTags('ai-agents')
@Controller('api/v1/AIAgents')
export class AIAgentsController {
  constructor(
    @Inject(AIAgentsModuleHealthService) private readonly health: AIAgentsModuleHealthService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIAgentsPolicyService) private readonly policy: AIAgentsPolicyService,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(AIProviderConnectionService) private readonly connections: AIProviderConnectionService,
    @Inject(AIProviderGateway) private readonly gateway: AIProviderGateway,
  ) {}

  /** Module diagnostics. The caller must be allowed to use the module at all. */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('use');
    const revealProviderConfiguration = await this.permissions.can('providerAdmin');
    return this.health.health(revealProviderConfiguration);
  }

  /**
   * What this caller may do. The SPA renders from this answer; a missing capability means the
   * matching endpoint would refuse the call, not that the UI merely hides a button.
   */
  @Get('action/capabilities')
  async capabilities() {
    await this.permissions.assert('use');
    const [capabilities, executionAvailable, settings] = await Promise.all([
      this.permissions.describe(),
      this.policy.isExecutionAvailable(),
      this.settings.settings(),
    ]);
    return {
      capabilities,
      execution: {
        enabled: settings.features.execution,
        paused: settings.safety.globalExecutionPaused,
        available: executionAvailable,
      },
    };
  }

  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('policyAdmin');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('policyAdmin');
    return this.settings.update(body);
  }

  @Get('action/providers')
  async listProviders() {
    await this.permissions.assert('providerAdmin');
    return { list: await this.connections.list() };
  }

  @Get('action/providers/:key')
  async getProvider(@Param('key') key: string) {
    await this.permissions.assert('providerAdmin');
    return this.connections.get(key);
  }

  @Post('action/providers')
  async createProvider(@Body() body: unknown) {
    await this.permissions.assert('providerAdmin');
    const input = parse(ProviderConnectionCreateSchema, body);
    return this.connections.create(input);
  }

  @Patch('action/providers/:key')
  async updateProvider(@Param('key') key: string, @Body() body: unknown) {
    await this.permissions.assert('providerAdmin');
    const input = parse(ProviderConnectionPatchSchema, body);
    return this.connections.update(key, input);
  }

  @Delete('action/providers/:key')
  async removeProvider(@Param('key') key: string) {
    await this.permissions.assert('providerAdmin');
    return this.connections.remove(key);
  }

  /**
   * Controlled connectivity check. It is admin-triggered, uses one tiny turn and returns status,
   * category, latency and usage only — never the model text, the request body or the credential.
   */
  @HttpCode(200)
  @Post('action/providers/:key/check')
  async checkProvider(@Param('key') key: string, @Body() body: unknown) {
    await this.permissions.assert('providerAdmin');
    const input = parse(ProviderCheckSchema, body);
    return this.gateway.check(key, input);
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return parsed.data;
}
