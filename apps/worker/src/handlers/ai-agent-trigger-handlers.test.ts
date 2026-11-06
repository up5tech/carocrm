import type { Logger } from '@carocrm/core/logger/index.js';
import type { OutboxEvent } from '@carocrm/jobs';
import { describe, expect, it, vi } from 'vitest';

import { DomainEventBus } from '../events/domain-event-bus.js';
import {
  AI_AGENT_INTEGRATION_PATH,
  AI_AGENT_TRIGGER_PATH,
  AI_AGENT_TRIGGER_SUBSCRIBER,
  registerAIAgentDomainEvents,
} from './ai-agent-trigger-handlers.js';

/**
 * Phase 19-AI.17 — the worker side of the event trigger door (P1).
 *
 * The subscriber decides nothing; these tests hold the transport contract the outbox depends on:
 *
 * - an agent-caused write (`correlation_id = 'aiAgentRun:<run>'`) never reaches the API, so an
 *   agent can never trigger itself or another agent;
 * - an event the agent runtime cannot act on is logged and never reaches the API either;
 * - no worker capability means inert, never a retry storm (AGENTS.md §3.3);
 * - a retry-worthy failure (transport, 5xx, wrong capability) throws so the poller retries, and
 * - a `{ disabled: true }` answer does not throw — a switched-off deployment must not fill the
 *   outbox with dead letters.
 */

const SECRET = 'AGENT_TEST_ai17_capability';
const BASE = 'http://api.local';

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function deps(fetcher: typeof fetch, secret = SECRET) {
  return { apiBaseUrl: BASE, secret, log: logger(), fetcher };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function entityEvent(eventType: string, overrides: Record<string, unknown> = {}): OutboxEvent {
  return {
    id: 'evt-test-ai17',
    eventType,
    payload: { entityType: 'Account', entityId: 'acc-1', changed: ['name'], userId: 'u-1', version: 1, ...overrides },
    correlationId: 'req-1',
  };
}

describe('the AI agent event-trigger subscriber (19-AI.17)', () => {
  it('registers under a stable name', () => {
    const log = logger();
    const bus = new DomainEventBus(log);
    registerAIAgentDomainEvents(bus, deps(vi.fn() as unknown as typeof fetch));
    expect(bus.list().map((entry) => entry.name)).toContain(AI_AGENT_TRIGGER_SUBSCRIBER);
  });

  it('never calls the API for an agent-caused write (the recursion guard)', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish({ ...entityEvent('entity.created'), correlationId: 'aiAgentRun:run-123' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never calls the API for an event the runtime cannot act on', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish(entityEvent('sales.invoice.discounted.v2'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is inert without a capability and does not throw', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const log = logger();
    const bus = new DomainEventBus(log);
    registerAIAgentDomainEvents(bus, { apiBaseUrl: BASE, secret: '', log, fetcher: fetcher as unknown as typeof fetch });
    await expect(bus.publish(entityEvent('entity.created'))).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('posts the event to the worker door with the shared capability', async () => {
    const fetcher = vi.fn(async () => json({ disabled: true, started: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish(entityEvent('entity.created'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${BASE}${AI_AGENT_TRIGGER_PATH}`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers['x-worker-secret']).toBe(SECRET);
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body['eventId']).toBe('evt-test-ai17');
    expect(body['eventType']).toBe('entity.created');
    expect(body['entityType']).toBe('Account');
  });

  it('treats a { disabled: true } answer as done, not as failure', async () => {
    const fetcher = vi.fn(async () => json({ disabled: true, started: 0, matched: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await expect(bus.publish(entityEvent('entity.created'))).resolves.toBeUndefined();
  });

  it('throws on a retry-worthy failure so the outbox poller retries', async () => {
    const fetcher = vi.fn(async () => json({ error: 'boom' }, 500));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await expect(bus.publish(entityEvent('entity.created'))).rejects.toThrow('HTTP 500');
  });
});

describe('the AI agent integration-trigger subscriber (19-AI.17)', () => {
  function integrationEvent(overrides: Record<string, unknown> = {}): OutboxEvent {
    return {
      id: 'int-evt-test-ai17',
      eventType: 'integration.record.imported',
      payload: {
        connectionId: 'conn-1',
        crmEntityType: 'Account',
        crmEntityId: 'acc-1',
      },
      correlationId: 'req-9',
      ...overrides,
    };
  }

  it('forwards an integration.* event to the integration door with its payload', async () => {
    const fetcher = vi.fn(async () => json({ disabled: true, started: 0, matched: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish(integrationEvent());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${BASE}${AI_AGENT_INTEGRATION_PATH}`);
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body['eventId']).toBe('int-evt-test-ai17');
    expect(body['eventType']).toBe('integration.record.imported');
    expect((body['payload'] as Record<string, unknown>)['crmEntityId']).toBe('acc-1');
  });

  it('never calls the API for an agent-caused integration event (the recursion guard)', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish({ ...integrationEvent(), correlationId: 'aiAgentRun:run-9' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ignores event types outside entity.* and integration.*', async () => {
    const fetcher = vi.fn(async () => json({ started: 0 }));
    const bus = new DomainEventBus(logger());
    registerAIAgentDomainEvents(bus, deps(fetcher as unknown as typeof fetch));
    await bus.publish({ ...integrationEvent(), eventType: 'workflow.step.completed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
