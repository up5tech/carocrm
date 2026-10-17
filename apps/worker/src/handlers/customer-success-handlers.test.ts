import type { Logger } from '@carocrm/core/logger/index.js';
import { type JobContext, JobRegistry } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import {
  CS_JOB_NAMES,
  evaluateRenewalWindowsJob,
  evaluateReviewRemindersJob,
  evaluateRiskEscalationsJob,
  expireHealthOverridesJob,
  processPlaybookWaitStepsJob,
  recalculateHealthBatchJob,
  registerCustomerSuccessJobs,
  repairStalePlaybookRunsJob,
  updateGoalOverdueStateJob,
} from './customer-success-handlers.js';

/**
 * Phase 19-CS.11 — the Customer Success scheduled jobs.
 *
 * The job's contract is four things, and each is checked here: it is registered under a namespaced
 * name, it is inert (not failed) with no capability, it calls the worker-authorised endpoint with the
 * capability, and it fails rather than silently succeeding when the API refuses. `fetcher` is
 * injected, so no test opens a socket (§15.1 "tests must never trigger real external effects").
 */

const SECRET = 'test-capability';
const BASE = 'http://api.local/';

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

describe('customer success jobs', () => {
  it('registers every §11.1 job under a namespaced name', () => {
    const registry = new JobRegistry();
    registerCustomerSuccessJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    for (const name of Object.values(CS_JOB_NAMES)) {
      expect(registry.has(name)).toBe(true);
      expect(name.startsWith('customerSuccess.')).toBe(true);
    }
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn();
    const result = await recalculateHealthBatchJob(deps(fetcher as unknown as typeof fetch, ''))(context());
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ disabled: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the worker-authorized endpoint with the capability', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ processed: 3, failed: 0 }), { status: 200 }));
    const result = await recalculateHealthBatchJob(deps(fetcher as unknown as typeof fetch))(context());
    expect(result.status).toBe('completed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}api/v1/CustomerSuccess/action/recalculate-batch`);
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe(SECRET);
  });

  it('fails, rather than silently succeeding, when the API refuses', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(expireHealthOverridesJob(deps(fetcher as unknown as typeof fetch))(context())).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it('sends the run day for the override-expiry scan', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ expired: 0 }), { status: 200 }));
    await expireHealthOverridesJob(deps(fetcher as unknown as typeof fetch))(context());
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { today?: string };
    expect(typeof body.today).toBe('string');
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('calls its own endpoint, not a shared one, so its counts are its own (§11.1)', async () => {
    const cases: [typeof updateGoalOverdueStateJob, string][] = [
      [recalculateHealthBatchJob, '/api/v1/CustomerSuccess/action/recalculate-batch'],
      [expireHealthOverridesJob, '/api/v1/CustomerSuccess/action/expire-overrides'],
      [updateGoalOverdueStateJob, '/api/v1/CustomerSuccess/action/update-goal-overdue-state'],
      [evaluateRenewalWindowsJob, '/api/v1/CustomerSuccess/action/evaluate-renewal-windows'],
      [evaluateRiskEscalationsJob, '/api/v1/CustomerSuccess/action/evaluate-risk-escalations'],
      [evaluateReviewRemindersJob, '/api/v1/CustomerSuccess/action/evaluate-review-reminders'],
      [processPlaybookWaitStepsJob, '/api/v1/CustomerSuccess/action/process-playbook-wait-steps'],
      [repairStalePlaybookRunsJob, '/api/v1/CustomerSuccess/action/repair-stale-playbook-runs'],
    ];
    for (const [factory, path] of cases) {
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify({ processed: 0, skipped: 0, errors: 0, durationMs: 1 }), { status: 200 }),
      );
      const result = await factory(deps(fetcher as unknown as typeof fetch))(context());
      expect(result.status, path).toBe('completed');
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${BASE}${path.slice(1)}`);
      const body = JSON.parse(String(init.body)) as { today?: string };
      if (path.endsWith('recalculate-batch')) continue; // that batch takes a limit, not a day
      expect(body.today, path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
