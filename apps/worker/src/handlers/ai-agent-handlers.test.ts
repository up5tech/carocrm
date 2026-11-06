import type { Logger } from '@carocrm/core/logger/index.js';
import { type JobContext, JobRegistry } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import {
  AI_AGENT_RETENTION_JOB,
  AI_AGENT_RUN_JOB,
  AI_AGENT_SCHEDULE_JOB,
  registerAIAgentJobs,
} from './ai-agent-handlers.js';

/**
 * 19-AI.17 — the schedule firing job.
 *
 * The contract under test: the job is registered under the kernel's `aiAgents.triggerSchedule`
 * name, it is inert (not failed) without a worker capability, it forwards the agent id and the
 * scheduler's `scheduledForMs` to the API's worker-authorised door, and a `{ disabled: true }`
 * answer completes quietly instead of retrying. `fetcher` is injected — no test opens a socket.
 */

const SECRET = 'test-capability';
const BASE = 'http://api.local';
const AGENT_ID = '123e4567-e89b-42d3-a456-426614174000';

function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    progress: vi.fn(),
    log: vi.fn(),
    shouldStop: async () => false,
    ...overrides,
  };
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function deps(fetcher: typeof fetch, secret = SECRET) {
  return { apiBaseUrl: BASE, secret, log: logger(), fetcher };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function handler(fetcher: typeof fetch, secret = SECRET) {
  const registry = new JobRegistry();
  registerAIAgentJobs(registry, deps(fetcher, secret));
  const found = registry.get(AI_AGENT_SCHEDULE_JOB);
  if (found === undefined) throw new Error('aiAgents.triggerSchedule is not registered.');
  return found;
}

describe('the AI agent schedule job (19-AI.17)', () => {
  it('registers under the kernel job name alongside the other agent jobs', () => {
    const registry = new JobRegistry();
    registerAIAgentJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.has(AI_AGENT_SCHEDULE_JOB)).toBe(true);
    expect(registry.has(AI_AGENT_RUN_JOB)).toBe(true);
    expect(registry.has(AI_AGENT_RETENTION_JOB)).toBe(true);
  });

  it('fails fast when the payload names no agent', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const result = await handler(fetcher as unknown as typeof fetch)(context({ data: {} }));
    expect(result.status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const result = await handler(fetcher as unknown as typeof fetch, '')(
      context({ data: { agentId: AGENT_ID } }),
    );
    expect(result.status).toBe('completed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts the agent id and scheduledForMs to the worker door', async () => {
    const fetcher = vi.fn(async () => json({ started: 1, runId: 'run-1' }));
    const result = await handler(fetcher as unknown as typeof fetch)(
      context({ data: { agentId: AGENT_ID }, scheduledForMs: 1_700_000_000_000, scheduleId: 'aiAgentSchedule-x' }),
    );
    expect(result.status).toBe('completed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${BASE}/api/v1/AIAgents/action/worker/trigger-schedule`);
    expect((init as { headers: Record<string, string> }).headers['x-worker-secret']).toBe(SECRET);
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body['agentId']).toBe(AGENT_ID);
    expect(body['scheduledForMs']).toBe(1_700_000_000_000);
  });

  it('completes quietly on a disabled answer and on a quiet no-start', async () => {
    const disabled = vi.fn(async () => json({ disabled: true, started: 0 }));
    const first = await handler(disabled as unknown as typeof fetch)(
      context({ data: { agentId: AGENT_ID } }),
    );
    expect(first.status).toBe('completed');

    const quiet = vi.fn(async () => json({ started: 0, reason: 'agent-not-published' }));
    const second = await handler(quiet as unknown as typeof fetch)(
      context({ data: { agentId: AGENT_ID } }),
    );
    expect(second.status).toBe('completed');
    expect(second.message).toContain('agent-not-published');
  });

  it('throws on a retry-worthy failure so the scheduler retry can fire again', async () => {
    const fetcher = vi.fn(async () => json({ error: 'boom' }, 500));
    await expect(
      handler(fetcher as unknown as typeof fetch)(context({ data: { agentId: AGENT_ID } })),
    ).rejects.toThrow('HTTP 500');
  });
});
