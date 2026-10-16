import type { Logger } from '@carocrm/core/logger/index.js';
import { type JobContext,JobRegistry } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import {
  EXPIRE_QUOTES_JOB,
  EXPIRE_QUOTES_PATH,
  expireQuotesJob,
  GENERATE_SUBSCRIPTION_INVOICES_JOB,
  GENERATE_SUBSCRIPTION_INVOICES_PATH,
  generateSubscriptionInvoicesJob,
  registerSalesJobs,
} from './sales-handlers.js';

/**
 * Phase 19-S.7 — the quote-expiry job.
 *
 * The job's whole contract is four things, and each is checked here: it is inert when no capability is
 * configured, it calls the worker-authorized endpoint with that capability, it reports what the API
 * did, and it fails (rather than silently succeeding) when the API refuses. `fetcher` is injected, so
 * no test opens a socket.
 *
 * Phase 19-S.16 adds the recurring billing job below, which follows the same shape and additionally
 * reports two facts instead of hiding them: a run on an installation with the `subscriptions` feature
 * off (`enabled: false`), and a run that hit its per-run budget (`truncated`).
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

describe('sales.expireQuotes', () => {
  it('is registered under a namespaced job name', () => {
    const registry = new JobRegistry();
    registerSalesJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.has(EXPIRE_QUOTES_JOB)).toBe(true);
    expect(EXPIRE_QUOTES_JOB).toBe('sales.expireQuotes');
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn();
    const result = await expireQuotesJob(deps(fetcher as unknown as typeof fetch, ''))(context());
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ disabled: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts to the worker-authorized endpoint with the capability and reports the counts', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ expired: ['q1', 'q2'], skipped: 3 }), { status: 200 }),
    );
    const ctx = context();
    const result = await expireQuotesJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE.replace(/\/$/, '')}${EXPIRE_QUOTES_PATH}`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-worker-secret': SECRET }),
      body: JSON.stringify({}),
    }));
    expect(result).toMatchObject({ status: 'completed', result: { expired: 2, skipped: 3 } });
    expect(ctx.progress).toHaveBeenCalledWith(100, '2 quote(s) expired');
  });

  it('fails the attempt when the API refuses, so the queue retries instead of losing the work', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(expireQuotesJob(deps(fetcher as unknown as typeof fetch))(context())).rejects.toThrow(/HTTP 401/);
  });

  it('stops cooperatively without calling the API when the run was cancelled', async () => {
    const fetcher = vi.fn();
    const result = await expireQuotesJob(deps(fetcher as unknown as typeof fetch))(context({ shouldStop: async () => true }));
    expect(result.status).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('sales.generateSubscriptionInvoices', () => {
  it('is registered under a namespaced job name', () => {
    const registry = new JobRegistry();
    registerSalesJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.has(GENERATE_SUBSCRIPTION_INVOICES_JOB)).toBe(true);
    expect(GENERATE_SUBSCRIPTION_INVOICES_JOB).toBe('sales.generateSubscriptionInvoices');
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn();
    const result = await generateSubscriptionInvoicesJob(deps(fetcher as unknown as typeof fetch, ''))(context());
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ disabled: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts to the worker-authorized endpoint and reports the invoices it generated', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, subscriptions: 3, periodsCreated: 2, invoiced: 4, failed: 0, truncated: false, results: [] }), { status: 200 }),
    );
    const ctx = context();
    const result = await generateSubscriptionInvoicesJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE.replace(/\/$/, '')}${GENERATE_SUBSCRIPTION_INVOICES_PATH}`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-worker-secret': SECRET }),
      body: JSON.stringify({}),
    }));
    expect(result).toMatchObject({ status: 'completed', result: { invoiced: 4 } });
    expect(ctx.progress).toHaveBeenCalledWith(100, 'generated 4 invoice(s)');
  });

  it('reports a disabled feature as a completed no-op rather than a failure', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ enabled: false, invoiced: 0 }), { status: 200 }));
    const result = await generateSubscriptionInvoicesJob(deps(fetcher as unknown as typeof fetch))(context());
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ enabled: false });
  });

  it('says so when the run hit its budget and work remains', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ enabled: true, invoiced: 50, truncated: true }), { status: 200 }));
    const result = await generateSubscriptionInvoicesJob(deps(fetcher as unknown as typeof fetch))(context());
    expect(result.status).toBe('completed');
    expect(String(result.message)).toContain('still waiting');
  });

  it('fails the attempt when the API refuses, so the queue retries instead of losing the work', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(generateSubscriptionInvoicesJob(deps(fetcher as unknown as typeof fetch))(context())).rejects.toThrow(/HTTP 403/);
  });
});
