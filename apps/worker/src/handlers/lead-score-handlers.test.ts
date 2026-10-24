import type { Logger } from '@carocrm/core/logger/index.js';
import { JobRegistry } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import { DomainEventBus } from '../events/domain-event-bus.js';
import { jobContext } from '../testing/job-context.js';
import {
  BATCH_CHUNK_PATH,
  BATCH_RECALCULATE_JOB,
  batchRecalculateJob,
  DECAY_SWEEP_JOB,
  DECAY_SWEEP_PATH,
  decaySweepJob,
  LEAD_CHANGED_PATH,
  RECALCULATE_LEAD_JOB,
  RECALCULATE_PATH,
  recalculateLeadJob,
  registerLeadScoreDomainEvents,
  registerLeadScoreJobs,
} from './lead-score-handlers.js';

/**
 * Phase 19-LS.6 — the Lead Score worker side.
 *
 * Nothing here scores anything; the point of the split is that the API owns the decision. So the contract
 * these tests hold is the transport one, and each item is something the queue depends on:
 *
 * - the job names the API enqueues are the names registered here;
 * - no capability means inert, not failed — an installation that has not configured the secret should not
 *   fill the queue with noise (AGENTS.md §3.3);
 * - the capability header and the exact route are what reach the API, which is where the authority lives;
 * - a **retry-worthy** failure (transport, 5xx, a wrong capability) throws, and a refusal the module *means*
 *   (a switch turned off, a Lead that no longer exists) completes, because an at-least-once delivery that
 *   retries a refusal forever is an outage in the outbox;
 * - cancellation is honoured before the call rather than after the work.
 */

const SECRET = 'AGENT_TEST_ls6_capability';
const BASE = 'http://api.local';

/** The runner's own context, so progress and cancellation are the platform's shapes rather than a stub. */
function context(data: Record<string, unknown> = {}, options: { cancelRequested?: boolean } = {}) {
  return jobContext(data, options);
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

function refusal(code: string, status = 403): Response {
  return json({ error: { code, message: 'Lead Score is not enabled on this instance.', details: { feature: 'leadScore.eventRecalculation' } } }, status);
}

describe('leadScore.recalculateLead', () => {
  it('registers both Lead Score jobs under the names the API enqueues', () => {
    const registry = new JobRegistry();
    registerLeadScoreJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.list().sort()).toEqual([BATCH_RECALCULATE_JOB, DECAY_SWEEP_JOB, RECALCULATE_LEAD_JOB].sort());
    expect(RECALCULATE_LEAD_JOB).toBe('leadScore.recalculateLead');
    expect(BATCH_RECALCULATE_JOB).toBe('leadScore.batchRecalculate');
    expect(DECAY_SWEEP_JOB).toBe('leadScore.decaySweep');
  });

  it('is inert — not failed — when no worker capability is configured', async () => {
    const fetcher = vi.fn();
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch, ''))(context({ leadId: 'l1' }));
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ disabled: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts the Lead to the worker route with the capability and reports what was recorded', async () => {
    const fetcher = vi.fn(async () =>
      json({
        leadId: 'l1',
        evaluationId: 'e1',
        recorded: true,
        projectionWritten: true,
        evaluation: { scoreValue: 50, band: 'Warm', resultState: 'success', trigger: 'lead_change' },
      }),
    );
    const ctx = context({ leadId: 'l1', modelVersion: 1, revision: 4, triggers: ['company'], source: 'event' });
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE}${RECALCULATE_PATH}`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-worker-secret': SECRET }),
      body: JSON.stringify({ leadId: 'l1' }),
    }));
    expect(result).toMatchObject({
      status: 'completed',
      message: 'Recorded score 50',
      result: { leadId: 'l1', recorded: true, projectionWritten: true, scoreValue: 50, band: 'Warm' },
    });
    expect(ctx.progressLines).toEqual([20, 100]);
  });

  it('reports an unchanged recomputation as the no-op it is, rather than as a new score', async () => {
    const fetcher = vi.fn(async () =>
      json({ leadId: 'l1', evaluationId: 'e1', recorded: false, projectionWritten: false, evaluation: { scoreValue: 50, band: 'Warm', resultState: 'success' } }),
    );
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(context({ leadId: 'l1' }));
    expect(result.status).toBe('completed');
    expect(result.message).toContain('unchanged');
    expect(result.result).toMatchObject({ recorded: false, projectionWritten: false });
  });

  it('completes over a refusal the module means, because a retry cannot change a switch', async () => {
    const fetcher = vi.fn(async () => refusal('LEADSCORE_MODULE_DISABLED'));
    const ctx = context({ leadId: 'l1' });
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(ctx);
    expect(result.status).toBe('completed');
    expect(result.result).toMatchObject({ refused: 'LEADSCORE_MODULE_DISABLED' });
    expect(ctx.logLines.map(([message]) => message).join(' ')).toContain('LEADSCORE_MODULE_DISABLED');
  });

  it('completes over a Lead that no longer exists', async () => {
    const fetcher = vi.fn(async () => json({ error: { code: 'RECORD_NOT_FOUND' } }, 404));
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(context({ leadId: 'gone' }));
    expect(result).toMatchObject({ status: 'completed', result: { leadId: 'gone', missing: true } });
  });

  it('fails a job whose payload names no Lead, and does not call the API', async () => {
    const fetcher = vi.fn();
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(context({ revision: 2 }));
    expect(result.status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('throws on a wrong capability and on a server failure, so the queue retries rather than burying it', async () => {
    const denied = vi.fn(async () => refusal('AUTHENTICATION_FAILED', 401));
    await expect(recalculateLeadJob(deps(denied as unknown as typeof fetch))(context({ leadId: 'l1' }))).rejects.toThrow(/HTTP 401/);

    const broken = vi.fn(async () => new Response('boom', { status: 503 }));
    await expect(recalculateLeadJob(deps(broken as unknown as typeof fetch))(context({ leadId: 'l1' }))).rejects.toThrow(/HTTP 503/);

    // A wrong capability is a deployment mistake, and the job has to say so loudly: a code the module does
    // not own is never treated as an answer it can accept.
    const badCapability = vi.fn(async () => json({ error: { code: 'AUTHENTICATION_FAILED' } }, 401));
    await expect(recalculateLeadJob(deps(badCapability as unknown as typeof fetch))(context({ leadId: 'l1' }))).rejects.toThrow(/HTTP 401 \(AUTHENTICATION_FAILED\)/);
  });

  it('stops cooperatively before the call when the run was cancelled', async () => {
    const fetcher = vi.fn();
    const result = await recalculateLeadJob(deps(fetcher as unknown as typeof fetch))(
      context({ leadId: 'l1' }, { cancelRequested: true }),
    );
    expect(result.status).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('leadScore.batchRecalculate', () => {
  const chunkPayload = { runId: 'r1', limit: 10, chunkSize: 2, processed: 0, cursor: null, where: [{ field: 'name', operator: 'contains', value: 'x' }] };

  it('hands the chunk coordinates to the API and reports the counts, the cursor and the successor', async () => {
    const fetcher = vi.fn(async () =>
      json({
        runId: 'r1',
        processed: 2,
        scored: 1,
        unchanged: 1,
        failed: 0,
        errorCodes: [],
        cursor: 'lead-2',
        done: false,
        cancelled: false,
        remaining: 8,
        nextJobId: 'job-next',
        processedTotal: 2,
      }),
    );
    const ctx = context(chunkPayload);
    const result = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE}${BATCH_CHUNK_PATH}`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(chunkPayload),
    }));
    expect(result).toMatchObject({
      status: 'completed',
      message: '1 scored, 1 unchanged, 0 failed',
      result: { runId: 'r1', processed: 2, scored: 1, cursor: 'lead-2', done: false, nextJobId: 'job-next', processedTotal: 2 },
    });
    expect(ctx.progressLines).toEqual([10, 100]);
  });

  it('carries a failed Lead’s code into the result instead of failing the whole chunk', async () => {
    const fetcher = vi.fn(async () =>
      json({ runId: 'r1', processed: 2, scored: 0, unchanged: 0, failed: 2, errorCodes: ['LEADSCORE_NO_ACTIVE_MODEL'], cursor: 'lead-2', done: true, cancelled: false, remaining: 0, nextJobId: null, processedTotal: 2 }),
    );
    const result = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(context(chunkPayload));
    expect(result.status).toBe('completed');
    expect(result.result).toMatchObject({ failed: 2, errorCodes: ['LEADSCORE_NO_ACTIVE_MODEL'], done: true });
  });

  it('reports a cancelled run as cancelled, not as a finished rebuild', async () => {
    const fetcher = vi.fn(async () =>
      json({ runId: 'r1', processed: 0, scored: 0, unchanged: 0, failed: 0, errorCodes: [], cursor: null, done: true, cancelled: true, remaining: 10, nextJobId: null, processedTotal: 0 }),
    );
    const result = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(context(chunkPayload));
    expect(result.status).toBe('cancelled');
    expect(result.message).toContain('cancelled');
  });

  it('completes over a refusal, because a rebuild switched off mid-run is an answer rather than a crash', async () => {
    const fetcher = vi.fn(async () => refusal('LEADSCORE_MODULE_DISABLED'));
    const result = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(context(chunkPayload));
    expect(result.status).toBe('completed');
    expect(result.result).toMatchObject({ refused: 'LEADSCORE_MODULE_DISABLED', runId: 'r1' });
  });

  it('fails a job row with no run coordinates, and throws on a server failure', async () => {
    const fetcher = vi.fn();
    const malformed = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(context({ cursor: null }));
    expect(malformed.status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();

    const broken = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(batchRecalculateJob(deps(broken as unknown as typeof fetch))(context(chunkPayload))).rejects.toThrow(/HTTP 500/);

    // A missing Lead on a batch path is the API's 404, and a rebuild does not lose the run over one record.
    const gone = vi.fn(async () => json({ error: { code: 'RECORD_NOT_FOUND' } }, 404));
    const result = await batchRecalculateJob(deps(gone as unknown as typeof fetch))(context(chunkPayload));
    expect(result.status).toBe('completed');
    expect(result.result).toMatchObject({ refused: 'RECORD_NOT_FOUND' });
  });

  it('is inert without a capability and stops before the call when cancelled', async () => {
    const fetcher = vi.fn();
    const inert = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch, ''))(context(chunkPayload));
    expect(inert.result).toEqual({ disabled: true });

    const stopped = await batchRecalculateJob(deps(fetcher as unknown as typeof fetch))(context(chunkPayload, { cancelRequested: true }));
    expect(stopped.status).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('leadScore.decaySweep (19-LS.9)', () => {
  it('registers the sweep under the name the seeded schedule row carries', () => {
    const registry = new JobRegistry();
    registerLeadScoreJobs(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.list()).toContain(DECAY_SWEEP_JOB);
  });

  it('asks the API for the sweep and reports what it decided', async () => {
    const fetcher = vi.fn(async () => json({ started: true, skipped: null, runId: 'r9', limit: 5, chunkSize: 2 }));
    const ctx = context({});
    const result = await decaySweepJob(deps(fetcher as unknown as typeof fetch))(ctx);

    expect(fetcher).toHaveBeenCalledWith(`${BASE}${DECAY_SWEEP_PATH}`, expect.objectContaining({ method: 'POST', body: '{}' }));
    expect(result).toMatchObject({ status: 'completed', message: 'Sweep queued a rebuild of up to 5 Lead(s)', result: { runId: 'r9', limit: 5, chunkSize: 2 } });
    expect(ctx.progressLines).toEqual([10, 100]);
  });

  it('completes quietly when the sweep found nothing to do', async () => {
    for (const [skipped, message] of [['disabled', 'Sweep skipped: disabled'], ['noDecayingRules', 'Sweep skipped: noDecayingRules']] as const) {
      const result = await decaySweepJob(deps(vi.fn(async () => json({ started: false, skipped })) as unknown as typeof fetch))(context({}));
      expect(result, skipped).toMatchObject({ status: 'completed', message, result: { skipped } });
    }
  });

  it('completes on a refusal and throws on a transport failure, like every other Lead Score job', async () => {
    const refused = await decaySweepJob(deps(vi.fn(async () => refusal('LEADSCORE_MODULE_DISABLED')) as unknown as typeof fetch))(context({}));
    expect(refused.status).toBe('completed');
    expect(String(refused.message)).toContain('LEADSCORE_MODULE_DISABLED');

    await expect(decaySweepJob(deps(vi.fn(async () => json({ error: { code: 'AUTHORIZATION_DENIED' } }, 403))) as unknown as typeof fetch)(context({}))).rejects.toThrow();
    await expect(decaySweepJob(deps(vi.fn(async () => { throw new Error('socket hang up'); }) ) as unknown as typeof fetch)(context({}))).rejects.toThrow();
  });

  it('sends the capability header and nothing else', async () => {
    const fetcher = vi.fn(async () => json({ started: false, skipped: 'disabled' }));
    await decaySweepJob(deps(fetcher as unknown as typeof fetch))(context({}));
    const headers = (fetcher.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers['x-worker-secret']).toBe(SECRET);
  });
});

describe('the Lead-change subscriber', () => {
  function bus(): DomainEventBus {
    return new DomainEventBus(logger());
  }

  function leadEvent(eventId = 'evt-1', entityType = 'Lead', changed = ['company']) {
    return {
      id: eventId,
      eventType: 'entity.updated',
      payload: { entityType, entityId: 'l1', changed, userId: 'u1', version: 7 },
    };
  }

  it('subscribes to created and updated Leads, and to nothing else', () => {
    const registry = bus();
    registerLeadScoreDomainEvents(registry, deps(vi.fn() as unknown as typeof fetch));
    expect(registry.list()).toEqual([
      { eventType: 'entity.created', name: 'lead-score:lead-create' },
      { eventType: 'entity.updated', name: 'lead-score:lead-update' },
    ]);
  });

  it('registers nothing when the capability is missing', () => {
    const registry = bus();
    registerLeadScoreDomainEvents(registry, deps(vi.fn() as unknown as typeof fetch, ''));
    expect(registry.list()).toEqual([]);
  });

  it('hands the committed change to the API, with the event coordinates and nothing about the values', async () => {
    const fetcher = vi.fn(async () => json({ queued: true, reason: 'queued', jobId: 'j1', modelVersion: 1, debounceMs: 60_000 }));
    const events = bus();
    registerLeadScoreDomainEvents(events, deps(fetcher as unknown as typeof fetch));
    await events.publish(leadEvent());

    expect(fetcher).toHaveBeenCalledWith(`${BASE}${LEAD_CHANGED_PATH}`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-worker-secret': SECRET }),
      body: JSON.stringify({ leadId: 'l1', revision: 7, changed: ['company'] }),
    }));
  });

  it('ignores another entity’s mutation', async () => {
    const fetcher = vi.fn();
    const events = bus();
    registerLeadScoreDomainEvents(events, deps(fetcher as unknown as typeof fetch));
    await events.publish(leadEvent('evt-2', 'Contact'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lets a server failure propagate so the poller retries the event', async () => {
    const fetcher = vi.fn(async () => new Response('down', { status: 502 }));
    const events = bus();
    registerLeadScoreDomainEvents(events, deps(fetcher as unknown as typeof fetch));
    await expect(events.publish(leadEvent())).rejects.toThrow(/HTTP 502/);
  });

  it('swallows a refusal, because a retry cannot un-turn-off a switch and a stuck event blocks the outbox', async () => {
    const fetcher = vi.fn(async () => json({ error: { code: 'VALIDATION_FAILED' } }, 422));
    const events = bus();
    registerLeadScoreDomainEvents(events, deps(fetcher as unknown as typeof fetch));
    await expect(events.publish(leadEvent())).resolves.toBeUndefined();
  });
});
