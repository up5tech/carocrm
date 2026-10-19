import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { Public } from '../auth/auth.guard.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import type { ApprovalStatusFilter } from './ai-agent-approvals.service.js';
import { AIAgentApprovalService } from './ai-agent-approvals.service.js';
import { AIAgentDefinitionService } from './ai-agent-definitions.service.js';
import { AIAgentEvaluationService } from './ai-agent-evaluations.service.js';
import { AIAgentMemoryService } from './ai-agent-memory.service.js';
import { AIAgentPricingService } from './ai-agent-pricing.service.js';
import { AIAgentQuotaService } from './ai-agent-quota.service.js';
import { AIAgentRunService } from './ai-agent-runs.service.js';
import { AGENT_STATUSES, type AgentStatus, type RunStatus } from './ai-agents-module.js';
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
  RunRetrySchema,
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
    @Inject(AIAgentDefinitionService) private readonly agents: AIAgentDefinitionService,
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
    @Inject(AIAgentApprovalService) private readonly approvals: AIAgentApprovalService,
    @Inject(AIAgentMemoryService) private readonly memory: AIAgentMemoryService,
    @Inject(AIAgentPricingService) private readonly pricing: AIAgentPricingService,
    @Inject(AIAgentQuotaService) private readonly quotas: AIAgentQuotaService,
    @Inject(AIAgentEvaluationService) private readonly evaluations: AIAgentEvaluationService,
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

  /** An administrator (or the user who owns the run) can re-attempt a queued run by hand. */
  @HttpCode(200)
  @Post('action/runs/:id/execute')
  async executeRun(@Param('id') id: string, @Body() body: unknown) {
    parse(EmptyBodySchema, body);
    // Visibility is the authorization: get() refuses a run this caller may not see.
    await this.runs.get(id);
    return this.runs.execute(id);
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

  @Get('action/usage')
  async usage() {
    return this.runs.usage();
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

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return parsed.data;
}
