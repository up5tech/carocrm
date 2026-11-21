import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError, ValidationError } from '@carocrm/core/errors/index.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

import { Public } from '../auth/auth.guard.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import type { ApprovalStatusFilter } from './ai-agent-approvals.service.js';
import { AIAgentApprovalService } from './ai-agent-approvals.service.js';
import { AIAgentCostReportService, type CostReportQuery } from './ai-agent-cost-report.service.js';
import { AIAgentDefinitionService } from './ai-agent-definitions.service.js';
import { AIAgentEvaluationService } from './ai-agent-evaluations.service.js';
import { AIAgentMcpDirectService } from './ai-agent-mcp-direct.service.js';
import { AIAgentMemoryService } from './ai-agent-memory.service.js';
import { isPeriodToken, PERIOD_TOKENS } from './ai-agent-periods.js';
import { AIAgentPricingService } from './ai-agent-pricing.service.js';
import { AIAgentQuotaService } from './ai-agent-quota.service.js';
import { AIAgentRunService, hashArguments } from './ai-agent-runs.service.js';
import { AIAgentSkillService, SKILL_STATUS_SET } from './ai-agent-skills.service.js';
import { AIToolRegistry } from './ai-agent-tools.js';
import { AGENT_STATUSES, type AgentStatus, RUN_TRIGGERS, type RunStatus } from './ai-agents-module.js';
import { AIAgentsModuleHealthService } from './ai-agents-module-health.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';
import { AIProviderGateway } from './ai-provider-gateway.service.js';
import {
  AgentCreateSchema,
  AgentPublishSchema,
  AgentUpdateSchema,
  ApprovalDecisionSchema,
  BudgetPolicyCreateSchema,
  DecisionEvaluationSchema,
  EmptyBodySchema,
  EvaluationCaseCreateSchema,
  PricingSnapshotCreateSchema,
  PricingSnapshotReplaceSchema,
  ProviderCheckSchema,
  ProviderConnectionCreateSchema,
  ProviderConnectionPatchSchema,
  RunCreateSchema,
  RunEvaluationSchema,
  RunInputSchema,
  RunRetrySchema,
  RunTriggerSchema,
  SkillCreateSchema,
  SkillPublishSchema,
  SkillUpdateSchema,
} from './dto/ai-agents-shapes.js';
import { mapWorkflowOutput } from './runs/workflow-output.js';

/**
 * Phase 19-AI.2–19-AI.4 — the `AIAgents` foundation API
 * (plans/PLAN_Phase_19_AI_Agents.md §14, §20 `19-AI.2`–`19-AI.4`).
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
    @Inject(AIAgentDefinitionService) private readonly agents: AIAgentDefinitionService,
    @Inject(AIAgentSkillService) private readonly skills: AIAgentSkillService,
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
    @Inject(AIAgentApprovalService) private readonly approvals: AIAgentApprovalService,
    @Inject(AIAgentMemoryService) private readonly memory: AIAgentMemoryService,
    @Inject(AIAgentPricingService) private readonly pricing: AIAgentPricingService,
    @Inject(AIAgentQuotaService) private readonly quotas: AIAgentQuotaService,
    @Inject(AIAgentCostReportService) private readonly costs: AIAgentCostReportService,
    @Inject(AIAgentEvaluationService) private readonly evaluations: AIAgentEvaluationService,
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(AIAgentMcpDirectService) private readonly mcpDirect: AIAgentMcpDirectService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
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
      memory: { enabled: settings.features.memory },
      evaluations: { enabled: settings.features.evaluations },
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

  // -------------------------------------------------------------------------
  // 19-AI.5 — agent definitions, versions and lifecycle
  // -------------------------------------------------------------------------

  /** The registered tool catalogue, with its effect class and global enabled state. */
  @Get('action/tools')
  async listTools() {
    return this.agents.permissionSummary();
  }

  /** Reviewed read-only starters for the first end-to-end agent (19-AI.8). */
  @Get('action/templates')
  async listTemplates() {
    return this.agents.templates();
  }

  @Get('action/agents')
  async listAgents(@Query() query: unknown) {
    const q = asRecord(query);
    const status = typeof q['status'] === 'string' ? q['status'] : undefined;
    if (status !== undefined && !(AGENT_STATUSES as readonly string[]).includes(status)) {
      throw new InvalidQueryError('Unknown agent status.');
    }
    return this.agents.list({
      offset: numberOrUndefined(q['offset']),
      maxSize: numberOrUndefined(q['maxSize']),
      ...(status === undefined ? {} : { status: status as AgentStatus }),
      ...(typeof q['q'] === 'string' ? { q: q['q'] } : {}),
      ...(q['scope'] === 'mine' ? { scope: 'mine' } : {}),
    });
  }

  @Get('action/agents/:id')
  async getAgent(@Param('id') id: string) {
    return this.agents.get(id);
  }

  @Post('action/agents')
  async createAgent(@Body() body: unknown) {
    const input = parse(AgentCreateSchema, body);
    return this.agents.create(input);
  }

  @Patch('action/agents/:id')
  async updateAgent(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(AgentUpdateSchema, body);
    return this.agents.update(id, input);
  }

  @Delete('action/agents/:id')
  async removeAgent(@Param('id') id: string) {
    return this.agents.remove(id);
  }

  @Get('action/agents/:id/versions')
  async agentVersions(@Param('id') id: string) {
    return this.agents.versions(id);
  }

  @Get('action/agents/:id/versions/:version')
  async agentVersion(@Param('id') id: string, @Param('version') version: string) {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidQueryError('Invalid version number.');
    return this.agents.version(id, parsed);
  }

  /** The blocking findings and warnings publication would act on. Safe to call while drafting. */
  @Get('action/agents/:id/validate')
  async validateAgent(@Param('id') id: string) {
    return this.agents.validate(id);
  }

  @HttpCode(200)
  @Post('action/agents/:id/validate')
  async validateAgentPost(@Param('id') id: string) {
    return this.agents.validate(id);
  }

  @HttpCode(200)
  @Post('action/agents/:id/publish')
  async publishAgent(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(AgentPublishSchema, body);
    return this.agents.publish(id, input.note);
  }

  @HttpCode(200)
  @Post('action/agents/:id/pause')
  async pauseAgent(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.agents.pause(id);
  }

  @HttpCode(200)
  @Post('action/agents/:id/resume')
  async resumeAgent(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.agents.resume(id);
  }

  @HttpCode(200)
  @Post('action/agents/:id/archive')
  async archiveAgent(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.agents.archive(id);
  }

  /** Archived -> draft. Copies the published config into the draft; no version row is mutated. */
  @HttpCode(200)
  @Post('action/agents/:id/restore')
  async restoreAgent(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.agents.restore(id);
  }

  // -------------------------------------------------------------------------
  // 25.4 — reusable versioned skills (text, never code)
  // -------------------------------------------------------------------------

  @Get('action/skills')
  async listSkills(@Query() query: unknown) {
    const q = asRecord(query);
    const status = typeof q['status'] === 'string' ? q['status'] : undefined;
    if (status !== undefined && !SKILL_STATUS_SET.has(status)) {
      throw new InvalidQueryError('Unknown skill status.');
    }
    return this.skills.list({
      offset: numberOrUndefined(q['offset']),
      maxSize: numberOrUndefined(q['maxSize']),
      ...(status === undefined ? {} : { status }),
      ...(typeof q['key'] === 'string' ? { key: q['key'] } : {}),
      ...(typeof q['q'] === 'string' ? { q: q['q'] } : {}),
      ...(q['scope'] === 'mine' ? { scope: 'mine' as const } : {}),
    });
  }

  /** Latest version of a stable skill key; the versioned routes are the authoritative ones. */
  @Get('action/skills/:key')
  async latestSkill(@Param('key') key: string) {
    return this.skills.latest(key);
  }

  @Get('action/skills/:key/versions/:version')
  async getSkill(@Param('key') key: string, @Param('version') version: string) {
    return this.skills.get(key, skillVersion(version));
  }

  /** Create the next draft of a key. Publishing freezes it; edits always produce a new version. */
  @Post('action/skills')
  async createSkill(@Body() body: unknown) {
    const input = parse(SkillCreateSchema, body);
    return this.skills.create(input);
  }

  @Patch('action/skills/:key/versions/:version')
  async updateSkill(@Param('key') key: string, @Param('version') version: string, @Body() body: unknown) {
    const input = parse(SkillUpdateSchema, body);
    return this.skills.update(key, skillVersion(version), input);
  }

  @HttpCode(200)
  @Post('action/skills/:key/versions/:version/publish')
  async publishSkill(
    @Param('key') key: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    const input = parse(SkillPublishSchema, body);
    return this.skills.publish(key, skillVersion(version), input.note);
  }

  @HttpCode(200)
  @Post('action/skills/:key/versions/:version/archive')
  async archiveSkill(@Param('key') key: string, @Param('version') version: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.skills.archive(key, skillVersion(version));
  }

  @Delete('action/skills/:key/versions/:version')
  async removeSkill(@Param('key') key: string, @Param('version') version: string) {
    return this.skills.remove(key, skillVersion(version));
  }

  // -------------------------------------------------------------------------
  // 19-AI.7/19-AI.8 — runs, timelines and execution
  // -------------------------------------------------------------------------

  @Get('action/runs')
  async listRuns(@Query() query: unknown) {
    const q = asRecord(query);
    const status = typeof q['status'] === 'string' ? q['status'] : undefined;
    if (status !== undefined && !(RUN_STATUS_SET as ReadonlySet<string>).has(status)) {
      throw new InvalidQueryError('Unknown run status.');
    }
    return this.runs.list({
      offset: numberOrUndefined(q['offset']),
      maxSize: numberOrUndefined(q['maxSize']),
      ...(status === undefined ? {} : { status: status as RunStatus }),
      ...(typeof q['agentId'] === 'string' ? { agentId: q['agentId'] } : {}),
      ...(q['scope'] === 'all' ? { scope: 'all' as const } : {}),
    });
  }

  @Post('action/agents/:id/runs')
  async createRun(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(RunCreateSchema, body);
    return this.runs.create(id, input);
  }

  @Get('action/runs/:id')
  async getRun(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Get('action/runs/:id/events')
  async runEvents(@Param('id') id: string) {
    return this.runs.events(id);
  }

  @Get('action/runs/:id/toolCalls')
  async runToolCalls(@Param('id') id: string) {
    return this.runs.toolCalls(id);
  }

  /** A new run that repeats a finished one whose outcome is fully known (19-AI.11). */
  @Post('action/runs/:id/retry')
  async retryRun(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(RunRetrySchema, body);
    return this.runs.retry(id, input.idempotencyKey);
  }

  @HttpCode(200)
  @Post('action/runs/:id/cancel')
  async cancelRun(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.runs.cancel(id);
  }

  @HttpCode(200)
  @Post('action/runs/:id/input')
  async inputRun(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(RunInputSchema, body);
    return this.runs.provideInput(id, input.text);
  }

  @HttpCode(200)
  @Post('action/runs/:id/resume')
  async resumeRun(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.runs.resume(id);
  }

  /** An administrator (or the user who owns the run) can re-attempt a queued run by hand. */
  @HttpCode(200)
  @Post('action/runs/:id/execute')
  async executeRun(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    // Visibility is the authorization: get() refuses a run this caller may not see.
    await this.runs.get(id);
    return this.runs.execute(id);
  }

  @HttpCode(200)
  @Post('action/triggers/run')
  async triggerRun(@Body() body: unknown) {
    await this.permissions.assert('policyAdmin');
    const input = parse(RunTriggerSchema, body);
    return this.runs.triggerRun({
      agentId: input.agentId,
      trigger: input.trigger,
      ...(input.input === undefined ? {} : { runInput: input.input }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.depth === undefined ? {} : { depth: input.depth }),
    });
  }

  // -------------------------------------------------------------------------
  // 19-AI.18 — MCP-compatible tool protocol adapter (authenticated, allowlisted)
  // -------------------------------------------------------------------------
  @Get('action/mcp/tools')
  async mcpListTools() {
    await this.permissions.assert('use');
    const defs = this.tools.list();
    return {
      tools: defs.map((d) => ({
        name: d.key,
        description: d.description,
        inputSchema: d.inputJsonSchema,
      })),
    };
  }

  @HttpCode(200)
  @Post('action/mcp/call')
  async mcpCallTool(@Body() body: unknown) {
    await this.permissions.assert('use');
    const schema = z
      .object({
        name: z.string().trim().min(1).max(120),
        arguments: z.record(z.string(), z.unknown()).optional(),
        /**
         * 19-AI.23 — required for write-capable tools so a retry cannot duplicate the effect;
         * optional for read tools, which keep a generated key and are never receipted.
         */
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
      })
      .strict();
    const input = parse(schema, body);
    const def = this.tools.get(input.name);
    if (!(await this.tools.isEnabled(input.name))) {
      throw new ValidationError('Tool is not enabled.', { tool: input.name });
    }
    // This door has no run, so it has nothing for an approval to attach to: no proposal a person read,
    // no `ai_agent_approvals` row, no tool-call ledger entry. A tool whose effect class demands a human
    // decision therefore cannot be honoured here, and honouring it would let one caller both propose and
    // commit a material write with no trace (§9.1, §9.3). The run pipeline is the path for it.
    const policy = await this.settings.settings();
    if (def.requiresApproval || policy.approval.requireFor.includes(def.effectClass)) {
      throw new ValidationError(
        `Tool "${input.name}" writes at an effect class that requires a human decision, and a direct tool call carries no run to attach that decision to. Start an agent run and approve its proposal.`,
        { tool: input.name, effectClass: def.effectClass, code: 'AI_TOOL_APPROVAL_REQUIRED' },
      );
    }
    const validated = def.inputSchema.parse(input.arguments ?? {});
    const principal = this.scope.requirePrincipal();

    // 19-AI.23 — a write-capable call must carry a client key; without one a retry duplicates the
    // effect. Read tools keep the generated key: they have no effect to deduplicate.
    const writeCapable = def.effectClass !== 'read';
    if (writeCapable && input.idempotencyKey === undefined) {
      throw new ValidationError(
        `Tool "${input.name}" changes data; supply idempotencyKey so a retry cannot duplicate the effect.`,
        { tool: input.name, code: 'AI_IDEMPOTENCY_KEY_REQUIRED' },
      );
    }

    if (!writeCapable) {
      const context = {
        runId: 'mcp-direct',
        step: 0,
        actorUserId: principal.userId,
        idempotencyKey: `mcp-${Date.now()}`,
      };
      const result = await def.execute(validated, context as never);
      return { content: [{ type: 'text', text: JSON.stringify(result.result) }], isError: false };
    }

    const idempotencyKey = input.idempotencyKey as string;
    const claim = await this.mcpDirect.claim({
      principalId: principal.userId,
      idempotencyKey,
      toolKey: input.name,
      argumentHash: hashArguments(validated),
    });
    if (claim.kind === 'replay') {
      return {
        content: [{ type: 'text', text: JSON.stringify(claim.result) }],
        isError: false,
        toolCallId: claim.callId,
      };
    }
    try {
      const context = {
        runId: 'mcp-direct',
        step: 0,
        actorUserId: principal.userId,
        idempotencyKey,
      };
      const result = await def.execute(validated, context as never);
      await this.mcpDirect.complete({
        principalId: principal.userId,
        idempotencyKey,
        result: result.result,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result) }],
        isError: false,
        toolCallId: claim.callId,
      };
    } catch (error) {
      await this.mcpDirect.release({ principalId: principal.userId, idempotencyKey });
      throw error;
    }
  }

  /**
   * The worker's door (19-AI.7). The worker has no session, so `@Public()` skips session
   * authentication and the shared worker capability is the authorization — constant-time compared and
   * refused when the deployment has not configured it. The run engine re-checks every claim, so a
   * duplicated dispatch is a no-op.
   */
  @Public()
  @HttpCode(200)
  @Post('action/worker/runs/:id/execute')
  async executeRunForWorker(@Param('id') id: string, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    return this.runs.execute(id);
  }

  /**
   * Phase 25.5 — the worker's workflow-step door. This is not the run engine: the API re-checks the
   * published agent, its workflow opt-in, skill bindings, approval policy and 25.2 principal rule,
   * then starts one idempotent run. A settled result is mapped only if it passed the captured
   * version's bounded output schema. A still-running run is reported as `pending`; the engine queues
   * `workflow.resume` when it settles.
   */
  @Public()
  @HttpCode(200)
  @Post('action/worker/workflow/run')
  async workflowRunForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = parse(WORKFLOW_AGENT_RUN_SCHEMA, body);
    const started = await this.runs.startFromWorkflow({
      agentId: input.agentId,
      task: input.task,
      ...(input.record === undefined ? {} : { record: input.record }),
      ...(input.skillKeys === undefined ? {} : { skillKeys: input.skillKeys }),
      approvalExpectation: input.approvalExpectation,
      idempotencyKey: input.idempotencyKey,
      metadata: input.workflow,
    });
    let mapped;
    try {
      mapped = mapWorkflowOutput(started, input.workflow.outputMapping);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'The agent output could not be mapped.');
    }
    return {
      runId: started.run.id,
      status: started.run.status,
      trigger: started.run.trigger,
      agentVersion: started.run.agentVersion,
      ...(mapped.kind === 'pending' ? { pending: true } : {}),
      ...(mapped.kind === 'mapped' ? { fields: mapped.fields } : {}),
      ...(mapped.kind === 'unmapped' ? { fields: {} } : {}),
      ...(mapped.kind === 'failed'
        ? { failure: { category: mapped.failureCategory, message: mapped.failureMessage } }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 19-AI.12 — conversations, memory and retention
  // -------------------------------------------------------------------------

  @Get('action/conversations')
  async listConversations(@Query() query: unknown) {
    const q = asRecord(query);
    return this.memory.listConversations({
      ...(typeof q['agentId'] === 'string' ? { agentId: q['agentId'] } : {}),
      maxSize: numberOrUndefined(q['maxSize']),
    });
  }

  @Get('action/conversations/:id')
  async getConversation(@Param('id') id: string) {
    return this.memory.getConversation(id);
  }

  @HttpCode(200)
  @Post('action/conversations/:id/archive')
  async archiveConversation(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.memory.archiveConversation(id);
  }

  @Delete('action/conversations/:id')
  async deleteConversation(@Param('id') id: string) {
    return this.memory.deleteConversation(id);
  }

  @Get('action/memory')
  async listMemory(@Query() query: unknown) {
    const q = asRecord(query);
    return this.memory.listMemory({
      ...(typeof q['agentId'] === 'string' ? { agentId: q['agentId'] } : {}),
      maxSize: numberOrUndefined(q['maxSize']),
    });
  }

  @Delete('action/memory/:id')
  async deleteMemory(@Param('id') id: string) {
    return this.memory.deleteMemoryItem(id);
  }

  @Get('action/retention/dryRun')
  async retentionDryRun() {
    return this.memory.retentionDryRun();
  }

  @HttpCode(200)
  @Post('action/retention/run')
  async retentionRun(@Body() body: unknown) {
    parse(EmptyBodySchema, body);
    return this.memory.retentionSweep();
  }

  /** The worker's door for scheduled retention; the shared capability is the authorization. */
  @Public()
  @HttpCode(200)
  @Post('action/worker/retention')
  async retentionForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    parse(EmptyBodySchema, body);
    this.assertWorkerSecret(secret);
    return this.memory.sweep();
  }

  /**
   * The worker's door for committed domain events (P1, 19-AI.17).
   *
   * The worker has no session and the ACL of the person who caused the record change is not
   * knowable from here, so this door starts nothing by itself: it names the event, and the
   * service starts a run for each agent that (a) is currently published, (b) opts in with
   * `triggers.eventTypes`/`eventEntities` allowlists, (c) is a record-context agent for exactly
   * this entity, and (d) passes the 25.6 watched-field/condition filters against the bounded
   * changed-value snapshot. Each run executes as the **publishing user**, never wider; recursion is
   * stopped because events produced inside a run carry `correlation_id = 'aiAgentRun:<id>'` and
   * never re-enter this door.
   *
   * `features.eventTriggers` off is a quiet `{ disabled: true }`, never a retry storm.
   */
  @Public()
  @HttpCode(200)
  @Post('action/worker/trigger-event')
  async triggerEventForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const parsed = WORKER_EVENT_TRIGGER_SCHEMA.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('The trigger payload is invalid.', {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    const { eventId, eventType, entityType, entityId, changed, values } = parsed.data;
    return this.runs.triggerEvent({
      eventId,
      eventType,
      entityType,
      entityId,
      changed,
      values,
    });
  }

  /**
   * The worker's door for one cron firing of an agent's schedule (19-AI.17).
   *
   * The kernel scheduler owns the firing and its dedup; this door only names the agent and the
   * boundary it fired for. `features.scheduledTriggers` off is a quiet `{ disabled: true }`.
   */
  @Public()
  @HttpCode(200)
  @Post('action/worker/trigger-schedule')
  async triggerScheduleForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const raw = asRecord(body);
    const agentId = typeof raw['agentId'] === 'string' ? raw['agentId'].trim() : '';
    const scheduledForMs =
      typeof raw['scheduledForMs'] === 'number' && Number.isFinite(raw['scheduledForMs'])
        ? Math.trunc(raw['scheduledForMs'])
        : undefined;
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(agentId)) {
      throw new ValidationError('The schedule payload is invalid.');
    }
    return this.runs.triggerSchedule({
      agentId,
      ...(scheduledForMs === undefined ? {} : { scheduledForMs }),
    });
  }

  /**
   * The worker's door for committed `integration.*` events (19-AI.17).
   *
   * AdvancedIntegrations publishes inbound-webhook and sync outcomes through the outbox; the
   * worker subscriber ferries them here. The door refuses anything that is not an `integration.*`
   * type, and the service only starts record-context runs for agents that opted in — the payload
   * is untrusted external data and never becomes prompt text. Shares the `features.eventTriggers`
   * flag with entity events.
   */
  @Public()
  @HttpCode(200)
  @Post('action/worker/trigger-integration')
  async triggerIntegrationForWorker(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const raw = asRecord(body);
    const eventId = typeof raw['eventId'] === 'string' ? raw['eventId'].trim() : '';
    const eventType = typeof raw['eventType'] === 'string' ? raw['eventType'].trim() : '';
    if (
      eventId.length === 0 ||
      eventId.length > 120 ||
      !/^integration\.[a-z0-9_]+(\.[a-z0-9_]+){0,6}$/.test(eventType)
    ) {
      throw new ValidationError('The integration trigger payload is invalid.');
    }
    return this.runs.triggerIntegrationEvent({
      eventId,
      eventType,
      payload: asRecord(raw['payload']),
    });
  }

  /**
   * Phase 25.10 — the installation-level cost and usage report.
   *
   * One windowed read-out over the run counters and the provider ledger: cost and tokens by agent,
   * by trigger type, by provider/model, and the installation total. The optional `period` token
   * (`this_month`, `rolling:30d`, `all`) is resolved by the module's own period grammar, so "this
   * month" means the same thing here and in an answer.
   */
  @Get('action/usage')
  async usage(@Query() query: unknown) {
    return this.costs.report(costReportQuery(query));
  }

  /**
   * The same report as a CSV file (plan §16 acceptance: "from an exported view"). The file carries
   * the same numbers as the screen — one implementation, two renderings.
   */
  @Get('action/usage/export')
  async usageExport(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.costs.exportCsv(costReportQuery(query));
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${result.filename}"`);
    return result.csv;
  }

  // -------------------------------------------------------------------------
  // 19-AI.14 — evaluation suites, cases, runs and publication gates
  // -------------------------------------------------------------------------

  @Get('action/evaluations')
  async listEvaluationSuites() {
    await this.permissions.assert('use');
    return this.evaluations.listSuites();
  }

  @Post('action/evaluations')
  async ensureStandardSuite() {
    await this.permissions.assert('evaluation');
    return this.evaluations.ensureStandardSuite();
  }

  /** Retire a suite that has never produced a run; the service refuses to erase evidence. */
  @Delete('action/evaluations/:suiteKey')
  @HttpCode(204)
  async deleteEvaluationSuite(@Param('suiteKey') suiteKey: string) {
    await this.permissions.assert('evaluation');
    await this.evaluations.deleteSuite(suiteKey);
  }

  @Post('action/evaluations/:suiteKey')
  async createEvaluationCase(@Param('suiteKey') suiteKey: string, @Body() body: unknown) {
    await this.permissions.assert('evaluation');
    const input = parse(EvaluationCaseCreateSchema, body);
    return this.evaluations.createCase(suiteKey, { caseKey: input.caseKey, title: input.title, grader: input.grader, graderConfig: input.graderConfig ?? {} });
  }

  @Post('action/agents/:agentId/evaluations/run')
  async runEvaluation(@Param('agentId') agentId: string, @Body() body: unknown) {
    const input = parse(RunEvaluationSchema, body);
    return this.evaluations.runSuite(agentId, input.suiteId);
  }

  @Get('action/agents/:agentId/evaluations')
  async listEvaluationRuns(@Param('agentId') agentId: string, @Query() query: unknown) {
    await this.permissions.assert('use');
    const q = asRecord(query);
    const limit = numberOrUndefined(q['maxSize']);
    // TypeScript sees agentId as read through the service call
    return this.evaluations.listRuns(agentId, limit ?? 25);
  }

  @Post('action/agents/:agentId/evaluations/:runId/decide')
async decideEvaluationCase(@Param('runId') runId: string, @Body() body: unknown) {
    const input = parse(DecisionEvaluationSchema, body);
    return this.evaluations.decide(runId, input.caseKey, input.decision, input.note);
  }

  @Get('action/agents/:agentId/evaluations/compare')
  async compareEvaluation(@Param('agentId') agentId: string) {
    await this.permissions.assert('use');
    return this.evaluations.compare(agentId);
  }

  // -------------------------------------------------------------------------
  // 19-AI.13 — pricing snapshots, quotas and admin reporting
  // -------------------------------------------------------------------------

  @Get('action/pricing')
  async listPricing(@Query() query: unknown) {
    const q = asRecord(query);
    return this.pricing.list(typeof q['providerKey'] === 'string' ? q['providerKey'] : undefined);
  }

  @HttpCode(201)
  @Post('action/pricing')
  async createPricing(@Body() body: unknown) {
    const input = parse(PricingSnapshotCreateSchema, body);
    return this.pricing.create({
      providerKey: input.providerKey,
      model: input.model,
      currency: input.currency,
      inputPricePerMillion: input.inputPricePerMillion,
      outputPricePerMillion: input.outputPricePerMillion,
      cachedInputPricePerMillion: input.cachedInputPricePerMillion,
    });
  }

  @HttpCode(200)
  @Post('action/pricing/:id/replace')
  async replacePricing(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PricingSnapshotReplaceSchema, body);
    return this.pricing.replace(id, {
      inputPricePerMillion: input.inputPricePerMillion,
      outputPricePerMillion: input.outputPricePerMillion,
      cachedInputPricePerMillion: input.cachedInputPricePerMillion,
    });
  }

  @Delete('action/pricing/:id')
  async deletePricing(@Param('id') id: string) {
    await this.pricing.remove(id);
    return { deleted: true };
  }

  @Get('action/quotas')
  async listQuotas() {
    return this.quotas.list();
  }

  /** Current consumption per policy: the §12.4 admin read-out with soft-limit warnings. */
  @Get('action/quotas/status')
  async quotaStatus() {
    return this.quotas.status();
  }

  @HttpCode(201)
  @Post('action/quotas')
  async createQuota(@Body() body: unknown) {
    const input = parse(BudgetPolicyCreateSchema, body);
    return this.quotas.create({
      scope: input.scope,
      period: input.period,
      enabled: input.enabled,
      ...(input.scopeRef === undefined ? {} : { scopeRef: input.scopeRef }),
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.maxRequests === undefined ? {} : { maxRequests: input.maxRequests }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
      ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
      ...(input.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: input.maxConcurrentRuns }),
      ...(input.warnPercent === undefined ? {} : { warnPercent: input.warnPercent }),
    });
  }

  @Delete('action/quotas/:id')
  async deleteQuota(@Param('id') id: string) {
    await this.quotas.remove(id);
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // 19-AI.10 — approvals
  // -------------------------------------------------------------------------

  @Get('action/approvals')
  async listApprovals(@Query() query: unknown) {
    const q = asRecord(query);
    const status = typeof q['status'] === 'string' ? q['status'] : 'pending';
    const allowed: readonly string[] = [
      'pending',
      'approved',
      'rejected',
      'changes_requested',
      'expired',
      'invalidated',
      'executed',
      'all',
    ];
    if (!allowed.includes(status)) throw new InvalidQueryError('Unknown approval status.');
    return this.approvals.list({
      status: status as ApprovalStatusFilter,
      offset: numberOrUndefined(q['offset']),
      maxSize: numberOrUndefined(q['maxSize']),
      ...(typeof q['runId'] === 'string' ? { runId: q['runId'] } : {}),
      ...(typeof q['agentId'] === 'string' ? { agentId: q['agentId'] } : {}),
    });
  }

  @Get('action/runs/:id/approvals')
  async runApprovals(@Param('id') id: string) {
    return this.approvals.forRun(id);
  }

  @Get('action/approvals/:id')
  async getApproval(@Param('id') id: string) {
    return this.approvals.get(id);
  }

  @HttpCode(200)
  @Post('action/approvals/:id/approve')
  async approve(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ApprovalDecisionSchema, body);
    return this.approvals.approve(id, input.note);
  }

  @HttpCode(200)
  @Post('action/approvals/:id/reject')
  async reject(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ApprovalDecisionSchema, body);
    return this.approvals.reject(id, input.note);
  }

  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
  }
}

const RUN_STATUS_SET: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'retry_wait',
  'cancel_requested',
  'succeeded',
  'partially_succeeded',
  'failed',
  'canceled',
  'expired',
  'blocked_by_policy',
  'outcome_unknown',
]);

const WORKFLOW_OUTPUT_MAPPING_SCHEMA = z
  .object({
    entity: z.string().regex(/^[A-Z][A-Za-z0-9]{1,49}$/).optional(),
    recordId: z.string().min(1).max(120).optional(),
    fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,49}$/), z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}$/).max(200))
      .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 12, {
        message: 'An output map needs between 1 and 12 fields.',
      }),
  })
  .strict();

const WORKFLOW_AGENT_RUN_SCHEMA = z
  .object({
    agentId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
    task: z.string().min(1).max(4_000),
    record: z.object({ entity: z.string().regex(/^[A-Z][A-Za-z0-9]{1,49}$/), id: z.string().min(1).max(120) }).strict().optional(),
    skillKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(8).optional(),
    approvalExpectation: z.enum(['policy', 'must_require']).default('policy'),
    idempotencyKey: z.string().min(1).max(120),
    workflow: z
      .object({
        workflowId: z.string().min(1).max(120),
        workflowRunId: z.string().min(1).max(120),
        nodeId: z.string().min(1).max(120),
        entityType: z.string().regex(/^[A-Z][A-Za-z0-9]{1,49}$/),
        entityId: z.string().min(1).max(120),
        userId: z.string().min(1).max(120).optional(),
        outputMapping: WORKFLOW_OUTPUT_MAPPING_SCHEMA.optional(),
      })
      .strict(),
  })
  .strict();

const EVENT_FIELD_SCHEMA = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const EVENT_VALUE_SCALAR_SCHEMA = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const EVENT_VALUE_SCHEMA = z.union([EVENT_VALUE_SCALAR_SCHEMA, z.array(EVENT_VALUE_SCALAR_SCHEMA).max(10)]);
const EVENT_VALUES_SCHEMA = z
  .object({
    before: z.record(EVENT_FIELD_SCHEMA, EVENT_VALUE_SCHEMA).default({}),
    after: z.record(EVENT_FIELD_SCHEMA, EVENT_VALUE_SCHEMA).default({}),
  })
  .strict()
  .refine((values) => Object.keys(values.before).length + Object.keys(values.after).length <= 20, {
    message: 'An event value snapshot may contain at most 20 entries.',
  });

const WORKER_EVENT_TRIGGER_SCHEMA = z
  .object({
    eventId: z.string().trim().min(1).max(120),
    eventType: z.enum(['entity.created', 'entity.updated', 'entity.deleted', 'entity.restored']),
    entityType: z.string().trim().regex(/^[A-Z][A-Za-z0-9]{1,49}$/),
    entityId: z.string().trim().min(1).max(120),
    changed: z.array(EVENT_FIELD_SCHEMA).max(20).default([]),
    values: EVENT_VALUES_SCHEMA.default({ before: {}, after: {} }),
    correlationId: z.string().max(200).nullable().optional(),
  })
  .strict();

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function skillVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidQueryError('Invalid skill version.');
  return parsed;
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

/**
 * Phase 25.10 — the report's query shape.
 *
 * `period` and `timezone` are validated by the period grammar itself (an unknown token or zone is
 * refused with a stable error before any query runs). `trigger` is checked here, because it is a
 * closed enumeration of the module's own run triggers.
 */
function costReportQuery(query: unknown): CostReportQuery {
  const q = asRecord(query);
  const trigger = typeof q['trigger'] === 'string' ? q['trigger'].trim() : '';
  if (trigger !== '' && !(RUN_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new InvalidQueryError('Unknown trigger type.', { allowed: [...RUN_TRIGGERS] });
  }
  const agentId = typeof q['agentId'] === 'string' ? q['agentId'].trim() : '';
  if (agentId.length > 120) throw new InvalidQueryError('The agent id is too long.');
  const period = typeof q['period'] === 'string' ? q['period'].trim() : '';
  // `all` is this report's own unbounded window; every other token comes from the module's own
  // period grammar, so "this month" means here what it means in an answer.
  if (period !== '' && period !== 'all' && !isPeriodToken(period)) {
    throw new InvalidQueryError('Unknown period.', { period, allowed: [...PERIOD_TOKENS, 'all'] });
  }
  const timezone = typeof q['timezone'] === 'string' ? q['timezone'].trim() : '';
  return {
    ...(period === '' ? {} : { period }),
    ...(timezone === '' ? {} : { timezone }),
    ...(agentId === '' ? {} : { agentId }),
    ...(trigger === '' ? {} : { trigger }),
  };
}
