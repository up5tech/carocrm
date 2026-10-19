import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

/**
 * Phase 19-AI.7 — the durable run worker
 * (PLAN_Phase_19_AI_Agents.md §8.1, §8.5, §20 `19-AI.7`).
 *
 * The handler owns **no** agent logic. It calls the API's worker-authorised endpoint, exactly like the
 * marketing, sales, customer-success and service-desk jobs. That keeps one run engine and one
 * authorization path: the API still enforces the kill switch, the lease, budgets and approvals.
 *
 * The payload is only a run id. A retried job re-enters `execute`, which claims a time-boxed lease
 * and is a no-op when the run is already terminal or another worker holds the lease — so a duplicate
 * dispatch cannot duplicate a model call or a tool effect.
 *
 * A missing worker capability makes the handler inert rather than failed: an installation that has not
 * configured it simply does not run agent jobs, and must not accumulate retries.
 */

export const AI_AGENT_RUN_JOB = 'aiAgents.executeRun';
export const AI_AGENT_RETENTION_JOB = 'aiAgents.retentionSweep';
export const AI_AGENT_RUN_EXECUTE_PREFIX = '/api/v1/AIAgents/action/worker/runs';
export const AI_AGENT_RETENTION_PATH = '/api/v1/AIAgents/action/worker/retention';

export interface AIAgentJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

function runJob(deps: AIAgentJobDeps): JobHandler {
  return async (context: JobContext) => {
    const data = (context.data ?? {}) as Record<string, unknown>;
    const runId = typeof data['runId'] === 'string' ? data['runId'] : '';
    if (runId === '') {
      return { status: 'failed', message: 'The AI agent run job has no run id.' };
    }
    if (deps.secret.trim() === '') {
      return {
        status: 'completed',
        message: 'AI agent execution is disabled: no worker capability is configured.',
        result: { disabled: true },
      };
    }
    if (await context.shouldStop()) {
      return { status: 'completed', message: 'Stopped before executing the run.', result: { stopped: true } };
    }
    context.progress(10, 'claiming agent run');
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher(
      `${deps.apiBaseUrl.replace(/\/$/, '')}${AI_AGENT_RUN_EXECUTE_PREFIX}/${encodeURIComponent(runId)}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(180_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Agent run execution failed with HTTP ${String(response.status)}.`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const run = typeof payload['run'] === 'object' && payload['run'] !== null ? (payload['run'] as Record<string, unknown>) : {};
    const status = typeof run['status'] === 'string' ? run['status'] : 'unknown';
    const claimed = payload['claimed'] === true;
    context.progress(100, `run ${status}`);
    deps.log.info({ runId, status, claimed }, 'ai agent run job finished');
    return {
      status: 'completed',
      message: claimed ? `Agent run ended as "${status}".` : `Agent run was not claimed (status "${status}").`,
      result: { runId, status, claimed },
    };
  };
}

/**
 * Phase 19-AI.12 — scheduled retention. The worker only asks the API to sweep; the API decides what
 * falls outside its configured windows, so a cron misconfiguration cannot become a broad delete.
 */
function retentionJob(deps: AIAgentJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return {
        status: 'completed',
        message: 'AI agent retention is disabled: no worker capability is configured.',
        result: { disabled: true },
      };
    }
    if (await context.shouldStop()) {
      return { status: 'completed', message: 'Stopped before the retention sweep.', result: { stopped: true } };
    }
    context.progress(20, 'running retention sweep');
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${AI_AGENT_RETENTION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Agent retention sweep failed with HTTP ${String(response.status)}.`);
    const result = (await response.json()) as Record<string, number>;
    context.progress(100, 'retention sweep finished');
    deps.log.info({ result }, 'ai agent retention sweep finished');
    return { status: 'completed', message: 'Agent retention sweep finished.', result };
  };
}

export function registerAIAgentJobs(registry: JobRegistry, deps: AIAgentJobDeps): void {
  registry.register(AI_AGENT_RUN_JOB, runJob(deps));
  registry.register(AI_AGENT_RETENTION_JOB, retentionJob(deps));
}
