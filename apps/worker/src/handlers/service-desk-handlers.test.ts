import type { Logger } from '@carocrm/core/logger/index.js';
import { type JobContext, JobRegistry } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import { registerServiceDeskJobs, SLA_SCAN_JOB, SLA_SCAN_PATH, slaScanJob } from './service-desk-handlers.js';

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

describe('serviceDesk.slaScan', () => {
  it('is registered under a namespaced job name', () => {
    const registry = new JobRegistry();
    registerServiceDeskJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.has(SLA_SCAN_JOB)).toBe(true);
    expect(SLA_SCAN_JOB).toBe('serviceDesk.slaScan');
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn();
    const result = await slaScanJob(deps(fetcher as unknown as typeof fetch, ''))(context());
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ disabled: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the worker-authorized endpoint with the capability and reports the counts', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ checked: 4, breached: 1, warned: 2, notified: 3, escalated: 1, expiredArticles: 2 }), {
        status: 200,
      }),
    );
    const ctx = context();
    const result = await slaScanJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE.replace(/\/$/, '')}${SLA_SCAN_PATH}`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-worker-secret': SECRET }),
      body: JSON.stringify({}),
    }));
    expect(result).toMatchObject({
      status: 'completed',
      result: { checked: 4, breached: 1, warned: 2, notified: 3, escalated: 1, expiredArticles: 2 },
    });
    expect(ctx.progress).toHaveBeenCalledWith(100, '4 clock(s) checked');
  });

  it('fails the attempt when the API refuses, so the queue retries instead of losing the work', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(slaScanJob(deps(fetcher as unknown as typeof fetch))(context())).rejects.toThrow(/HTTP 401/);
  });

  it('cancels without calling the API when the job is stopped', async () => {
    const fetcher = vi.fn();
    const result = await slaScanJob(deps(fetcher as unknown as typeof fetch))(context({ shouldStop: async () => true }));
    expect(result.status).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
