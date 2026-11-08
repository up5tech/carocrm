import { describe, expect, it } from 'vitest';

import type { AIProviderResponse } from '../src/ai-agents/ai-provider.js';
import { AIProviderGateway } from '../src/ai-agents/ai-provider-gateway.service.js';

/**
 * 19-AI.24 — a dropped provider-ledger write must stay operator-visible: the caller still gets the
 * provider response (tokens were already consumed), but a `run.ledger_write_failed` marker lands on
 * the run's event ledger so usage reporting can label cost `unknown` instead of a confident `0`.
 */

const RESPONSE: AIProviderResponse = {
  providerRequestId: 'req_test',
  model: 'fake-1',
  text: 'ok',
  structured: null,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  latencyMs: 1,
  safety: {},
};

interface Captured {
  readonly providerRequests: number;
  readonly runEvents: Record<string, unknown>[];
}

/** Minimal Kysely-shaped stub: `provider_requests` inserts throw when `failLedger`; everything else
 * is captured so the test can inspect what the gateway tried to write. */
function stubDb(failLedger: boolean): { db: never; captured: Captured } {
  const captured: Captured = { providerRequests: 0, runEvents: [] };
  const make = () => {
    const b: Record<string, unknown> = {};
    b['select'] = () => b;
    b['where'] = () => b;
    b['values'] = (row: Record<string, unknown>) => {
      const exec = async () => {
        if (b['__table'] === 'ai_agent_provider_requests') {
          if (failLedger) throw new Error('ledger unavailable');
          captured.providerRequests += 1;
          return {};
        }
        if (b['__table'] === 'ai_agent_run_events') captured.runEvents.push(row);
        return {};
      };
      return { execute: exec };
    };
    b['executeTakeFirst'] = async () => ({ seq: 0 });
    b['execute'] = async () => ({});
    return b;
  };
  const db = {
    selectFrom: (table: string) => {
      const b = make();
      b['__table'] = table;
      return b;
    },
    insertInto: (table: string) => {
      const b = make();
      b['__table'] = table;
      return b;
    },
  };
  return { db: db as never, captured };
}

function gatewayWith(db: never): AIProviderGateway {
  const connections = {
    resolve: async () => ({
      key: 'fake',
      kind: 'fake',
      models: ['fake-1'],
      dataClasses: ['internal', 'restricted'],
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'test',
      config: { allowLoopback: true },
    }),
    adapterFor: () => ({
      key: 'fake',
      capabilities: { structuredOutput: true, toolCalling: true },
      complete: async () => RESPONSE,
    }),
  };
  const settings = {
    settings: async () => ({
      dataPolicy: { allowedExternalDataClasses: ['internal', 'restricted'] },
      limits: { maxElapsedSeconds: 60 },
    }),
  };
  const pricing = { estimate: async () => ({ costUsd: null, source: 'none', snapshotId: null }) };
  return new AIProviderGateway(connections as never, settings as never, { db } as never, pricing as never);
}

const REQUEST = {
  model: 'fake-1',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxOutputTokens: 16,
  timeoutMs: 5_000,
};

describe('provider ledger failure observability (19-AI.24)', () => {
  it('still returns the response and marks the run when the ledger write fails', async () => {
    const { db, captured } = stubDb(true);
    const response = await gatewayWith(db).complete({
      connectionKey: 'fake',
      run: { runId: 'run-1', step: 1, agentId: 'agent-1', agentVersion: 1 },
      request: REQUEST,
    });
    expect(response.text).toBe('ok');
    expect(captured.providerRequests).toBe(0);
    expect(captured.runEvents).toHaveLength(1);
    const marker = captured.runEvents[0] as Record<string, unknown> | undefined;
    expect(marker).toBeDefined();
    if (marker === undefined) return;
    expect(marker['run_id']).toBe('run-1');
    expect(marker['event_type']).toBe('run.ledger_write_failed');
    expect(marker['visibility']).toBe('operator');
    const payload = JSON.parse(String(marker['payload'])) as Record<string, unknown>;
    expect(payload['providerKey']).toBe('fake');
    expect(payload['outcome']).toBe('succeeded');
  });

  it('writes no marker when the ledger write succeeds', async () => {
    const { db, captured } = stubDb(false);
    await gatewayWith(db).complete({
      connectionKey: 'fake',
      run: { runId: 'run-2', step: 1, agentId: 'agent-1', agentVersion: 1 },
      request: REQUEST,
    });
    expect(captured.providerRequests).toBe(1);
    expect(captured.runEvents).toHaveLength(0);
  });

  it('skips the marker for non-run calls (connectivity checks)', async () => {
    const { db, captured } = stubDb(true);
    await gatewayWith(db).complete({ connectionKey: 'fake', request: REQUEST });
    expect(captured.runEvents).toHaveLength(0);
  });
});
