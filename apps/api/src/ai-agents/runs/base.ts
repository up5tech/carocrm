/**
 * Run reads and shared row helpers — the base of the split run service (19-AI.25).
 */

import { NotFoundError } from '@carocrm/core/errors/index.js';

import type { AuthService } from '../../auth/auth.service.js';
import type { RequestScope } from '../../common/request-scope.js';
import type { AIAgentRunsTable, DatabaseService } from '../../database/database.service.js';
import type { EntityCrudService } from '../../entity/entity.service.js';
import type { JobsService } from '../../jobs/jobs.service.js';
import type { MetadataStoreService } from '../../metadata/metadata-store.service.js';
import type { AIAgentDefinitionService } from '../ai-agent-definitions.service.js';
import type { AIAgentActorDirectoryService } from '../ai-agent-directory.service.js';
import type { AIAgentMemoryService } from '../ai-agent-memory.service.js';
import type { AIAgentQuotaService } from '../ai-agent-quota.service.js';
import { appendRunEvent } from '../ai-agent-run-events.js';
import type { AIToolRegistry } from '../ai-agent-tools.js';
import type { AgentStatus, RunStatus, RunTrigger } from '../ai-agents-module.js';
import type { AIAgentsPermissionService } from '../ai-agents-permission.service.js';
import type { AIAgentsPolicyService } from '../ai-agents-policy.service.js';
import type { AIAgentsSettingsService } from '../ai-agents-settings.service.js';
import type { AIProviderGateway } from '../ai-provider-gateway.service.js';
import { type AIAgentRunEventView, type AIAgentRunView, asRecord,type RunListQuery } from './shared.js';

export abstract class AIAgentRunCore {
  constructor(
    protected readonly database: DatabaseService,
    protected readonly scope: RequestScope,
    protected readonly auth: AuthService,
    protected readonly permissions: AIAgentsPermissionService,
    protected readonly policy: AIAgentsPolicyService,
    protected readonly settings: AIAgentsSettingsService,
    protected readonly definitions: AIAgentDefinitionService,
    protected readonly tools: AIToolRegistry,
    protected readonly gateway: AIProviderGateway,
    protected readonly entities: EntityCrudService,
    protected readonly metadata: MetadataStoreService,
    protected readonly jobs: JobsService,
    protected readonly memory: AIAgentMemoryService,
    protected readonly quotas: AIAgentQuotaService,
    protected readonly actors: AIAgentActorDirectoryService,
  ) {}

  async list(query: RunListQuery = {}): Promise<{ list: AIAgentRunView[]; total: number; offset: number; count: number }> {
    await this.permissions.assert('use');
    const viewer = await this.viewer();
    const offset = Math.max(0, query.offset ?? 0);
    const maxSize = Math.min(100, Math.max(1, query.maxSize ?? 25));

    let builder = this.database.db.selectFrom('ai_agent_runs');
    if (query.status !== undefined) builder = builder.where('status', '=', query.status);
    if (query.agentId !== undefined) builder = builder.where('agent_id', '=', query.agentId);
    if (query.scope === 'mine' || !viewer.audit) {
      builder = builder.where('initiated_by_user_id', '=', viewer.userId);
    }
    const totalRow = await builder.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    const rows = await builder.selectAll().orderBy('created_at', 'desc').offset(offset).limit(maxSize).execute();
    const { agents } = await this.agentNames(rows.map((row) => row.agent_id));
    return {
      list: rows.map((row) => this.toView(row, agents.get(row.agent_id))),
      total: Number(totalRow?.count ?? 0),
      offset,
      count: rows.length,
    };
  }

  async get(id: string): Promise<AIAgentRunView> {
    const row = await this.visibleRun(id);
    const { agents } = await this.agentNames([row.agent_id]);
    return this.toView(row, agents.get(row.agent_id));
  }

  async events(id: string): Promise<{ list: AIAgentRunEventView[] }> {
    const row = await this.visibleRun(id);
    const viewer = await this.viewer();
    const hidden = viewer.audit ? undefined : 'user';
    const builder = this.database.db.selectFrom('ai_agent_run_events').selectAll().where('run_id', '=', row.id);
    const events = await (hidden === undefined ? builder : builder.where('visibility', '=', hidden))
      .orderBy('seq', 'asc')
      .execute();
    return {
      list: events.map((event) => ({
        id: event.id,
        seq: Number(event.seq),
        category: event.category,
        type: event.event_type,
        actorType: event.actor_type,
        actorId: event.actor_id,
        summary: event.summary,
        payload: event.payload,
        visibility: event.visibility,
        createdAt: event.created_at.toISOString(),
      })),
    };
  }

  /** Tool calls of a run, with their attributes; arguments are visible to an audit holder only. */
  async toolCalls(id: string): Promise<{
    list: {
      id: string;
      step: number;
      toolKey: string;
      policyResult: string;
      status: string;
      summary: string | null;
      errorCategory: string | null;
      durationMs: number | null;
      resultRef: string | null;
      createdAt: string;
    }[];
  }> {
    const row = await this.visibleRun(id);
    const calls = await this.database.db
      .selectFrom('ai_agent_tool_calls')
      .selectAll()
      .where('run_id', '=', row.id)
      .orderBy('created_at', 'asc')
      .execute();
    return {
      list: calls.map((call) => {
        const outcome = asRecord(call.outcome);
        return {
          id: call.id,
          step: call.step,
          toolKey: call.tool_key,
          policyResult: call.policy_result,
          status: call.status,
          summary: typeof outcome['summary'] === 'string' ? outcome['summary'] : null,
          errorCategory: call.error_category,
          durationMs: call.duration_ms,
          resultRef: call.result_ref,
          createdAt: call.created_at.toISOString(),
        };
      }),
    };
  }

  /**
   * Phase 19-AI.10/19-AI.13 usage read-out: run counters plus the provider ledger. Cost totals
   * come from the ledger's `estimated_cost_usd`, which the gateway prices from admin-maintained
   * pricing snapshots (§12.1). `costLabel` says what those numbers are: `estimate` when at least
   * one row was priced from a snapshot, `none` when the deployment has no price data — in that case
   * the total is an exact 0, never an invented figure. No registered adapter returns a
   * provider-confirmed billing value in this release, so `confirmedCostUsd` is always absent
   * rather than silently equal to the estimate.
   */
  async usage(): Promise<{
    totals: {
      runs: number;
      modelCalls: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      costLabel: 'estimate' | 'none' | 'unknown';
      /** 19-AI.24 — provider ledger writes the gateway had to drop; each one may understate cost. */
      ledgerWriteFailures: number;
    };
    byAgent: { agentId: string; agentName: string; runs: number; modelCalls: number; toolCalls: number; tokens: number }[];
    byProvider: {
      providerKey: string;
      model: string;
      requests: number;
      failures: number;
      inputTokens: number;
      outputTokens: number;
      averageLatencyMs: number;
    }[];
  }> {
    await this.permissions.assert('usage');
    const runs = await this.database.db.selectFrom('ai_agent_runs').selectAll().execute();
    const names = await this.agentNames(runs.map((run) => run.agent_id));
    const byAgent = new Map<
      string,
      { agentId: string; agentName: string; runs: number; modelCalls: number; toolCalls: number; tokens: number }
    >();
    for (const run of runs) {
      const current = byAgent.get(run.agent_id) ?? {
        agentId: run.agent_id,
        agentName: names.agents.get(run.agent_id)?.name ?? '',
        runs: 0,
        modelCalls: 0,
        toolCalls: 0,
        tokens: 0,
      };
      current.runs += 1;
      current.modelCalls += run.model_call_count;
      current.toolCalls += run.tool_call_count;
      current.tokens += run.input_tokens + run.output_tokens;
      byAgent.set(run.agent_id, current);
    }
    const providerRows = await this.database.db
      .selectFrom('ai_agent_provider_requests')
      .select(['provider_key', 'model', 'outcome', 'input_tokens', 'output_tokens', 'latency_ms', 'estimated_cost_usd'])
      .execute();
    const pricedRequests = providerRows.filter((row) => row.estimated_cost_usd !== null).length;
    // 19-AI.24 — every dropped ledger write left a `run.ledger_write_failed` marker on its run;
    // while any exist the totals can understate spend, so the label says `unknown`, never a
    // confident `estimate` or a misleading `none`.
    const ledgerFailures = await this.database.db
      .selectFrom('ai_agent_run_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('event_type', '=', 'run.ledger_write_failed')
      .executeTakeFirst();
    const ledgerWriteFailures = Number(ledgerFailures?.count ?? 0);
    const byProvider = new Map<
      string,
      {
        providerKey: string;
        model: string;
        requests: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        latencyTotal: number;
      }
    >();
    for (const row of providerRows) {
      const key = `${row.provider_key}\u0000${row.model}`;
      const current = byProvider.get(key) ?? {
        providerKey: row.provider_key,
        model: row.model,
        requests: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyTotal: 0,
      };
      current.requests += 1;
      if (row.outcome === 'failed') current.failures += 1;
      current.inputTokens += row.input_tokens ?? 0;
      current.outputTokens += row.output_tokens ?? 0;
      current.latencyTotal += row.latency_ms;
      byProvider.set(key, current);
    }
    return {
      totals: {
        runs: runs.length,
        modelCalls: runs.reduce((sum, run) => sum + run.model_call_count, 0),
        toolCalls: runs.reduce((sum, run) => sum + run.tool_call_count, 0),
        inputTokens: runs.reduce((sum, run) => sum + run.input_tokens, 0),
        outputTokens: runs.reduce((sum, run) => sum + run.output_tokens, 0),
        estimatedCostUsd: providerRows.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0),
        costLabel: ledgerWriteFailures > 0 ? 'unknown' : pricedRequests === 0 ? 'none' : 'estimate',
        ledgerWriteFailures,
      },
      byAgent: [...byAgent.values()].sort((left, right) => right.runs - left.runs),
      byProvider: [...byProvider.values()]
        .map((entry) => ({
          providerKey: entry.providerKey,
          model: entry.model,
          requests: entry.requests,
          failures: entry.failures,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          averageLatencyMs: entry.requests === 0 ? 0 : Math.round(entry.latencyTotal / entry.requests),
        }))
        .sort((left, right) => right.requests - left.requests),
    };
  }

  protected async invalidatePendingApprovals(runId: string, reason: string): Promise<void> {
    await this.database.db
      .updateTable('ai_agent_approvals')
      .set({ status: 'invalidated', decision_note: reason.slice(0, 500), modified_at: new Date() })
      .where('run_id', '=', runId)
      .where('status', 'in', ['pending', 'approved'])
      .execute();
  }

  protected async appendEvent(
    runId: string,
    category: string,
    type: string,
    summary: string,
    payload: Record<string, unknown>,
    visibility: 'user' | 'operator' | 'admin' = 'operator',
  ): Promise<void> {
    // 19-AI.24: the shared helper also serves the provider gateway's ledger-failure marker.
    await appendRunEvent(this.database.db, { runId, category, type, summary, payload, visibility });
  }

  protected async visibleRun(id: string): Promise<AIAgentRunsTable> {
    await this.permissions.assert('use');
    const viewer = await this.viewer();
    const row = await this.database.db.selectFrom('ai_agent_runs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError(`Run "${id}" does not exist.`);
    if (!viewer.audit && row.initiated_by_user_id !== viewer.userId) {
      throw new NotFoundError(`Run "${id}" does not exist.`);
    }
    return row;
  }

  protected async viewer(): Promise<{ userId: string; audit: boolean }> {
    return { userId: this.scope.userId ?? '', audit: await this.permissions.can('audit') };
  }

  protected async agentNames(ids: readonly string[]): Promise<{
    agents: Map<string, { key: string; name: string; status: AgentStatus }>;
  }> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { agents: new Map() };
    const rows = await this.database.db
      .selectFrom('ai_agents')
      .select(['id', 'agent_key', 'name', 'status'])
      .where('id', 'in', unique)
      .execute();
    return {
      agents: new Map(
        rows.map((row) => [row.id, { key: row.agent_key, name: row.name, status: row.status as AgentStatus }]),
      ),
    };
  }

  protected toView(row: AIAgentRunsTable, agent: { key: string; name: string } | undefined): AIAgentRunView {
    const input = asRecord(row.input);
    const record = asRecord(input['record']);
    return {
      id: row.id,
      agentId: row.agent_id,
      agentKey: agent?.key ?? '',
      agentName: agent?.name ?? '',
      agentVersion: row.agent_version,
      agentVersionId: row.agent_version_id,
      status: row.status as RunStatus,
      trigger: row.trigger as RunTrigger,
      initiatedByUserId: row.initiated_by_user_id,
      input: {
        text: typeof input['text'] === 'string' ? input['text'].slice(0, 4_000) : null,
        recordEntity: typeof record['entity'] === 'string' ? record['entity'] : null,
        recordId: typeof record['id'] === 'string' ? record['id'] : null,
      },
      result: row.result,
      failureCategory: row.failure_category,
      failureMessage: row.failure_message,
      cancelRequested: row.cancel_requested,
      conversationId: row.conversation_id,
      counters: {
        steps: row.step_count,
        modelCalls: row.model_call_count,
        toolCalls: row.tool_call_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        estimatedCostUsd: Number(row.estimated_cost_usd),
      },
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }
}
