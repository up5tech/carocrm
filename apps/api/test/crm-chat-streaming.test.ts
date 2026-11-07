import { describe, expect, it } from 'vitest';

import type { AIAgentRunEventView } from '../src/ai-agents/ai-agent-runs.service.js';
import { AIAgentRunService } from '../src/ai-agents/ai-agent-runs.service.js';
import { AIToolRegistry } from '../src/ai-agents/ai-agent-tools.js';
import { CRMChatSettingsService } from '../src/crm-chat/crm-chat-settings.service.js';
import { CRMChatStreamingService, type SSEStreamWriter } from '../src/crm-chat/crm-chat-streaming.service.js';
import { DatabaseService } from '../src/database/database.service.js';

/**
 * Phase 19-CHAT.29 — stream id hygiene, tested without a database or a real run.
 *
 * The resume contract is `Last-Event-ID` → `parseInt` → skip every run event with `seq <= cursor`.
 * Heartbeats and wall-clock errors must therefore never carry a bare number, every emitted id must
 * be unique within a turn, and ids derived from one run event must still resume at that event's seq.
 *
 * `streamToWriter` arms a 1s poll and returns; the tests wait on the writer's `end()` instead.
 */

const TURN_ID = 'turn-under-test';

function runEvent(seq: number, type: string, payload: unknown = {}, summary = ''): AIAgentRunEventView {
  return {
    id: `evt-${String(seq)}`,
    seq,
    category: 'run',
    type,
    actorType: 'system',
    actorId: null,
    summary,
    payload,
    visibility: 'user',
    createdAt: new Date().toISOString(),
  };
}

/** A Kysely-shaped stub: every builder method returns the chain; terminals drain FIFO queues. */
function dbStub(takeFirst: readonly unknown[], execute: readonly unknown[]) {
  let ti = 0;
  let ei = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'where', 'whereRef', 'orderBy', 'offset', 'limit']) {
    chain[method] = () => chain;
  }
  chain['executeTakeFirst'] = async () => takeFirst[ti++] ?? null;
  chain['execute'] = async () => execute[ei++] ?? [];
  return { db: { selectFrom: () => chain } };
}

interface Harness {
  readonly service: CRMChatStreamingService;
  readonly writer: SSEStreamWriter;
  readonly chunks: string[];
  readonly ended: () => boolean;
}

function harness(options: {
  events: readonly AIAgentRunEventView[];
  takeFirst?: readonly unknown[];
  heartbeatMs?: number;
  timeoutMs?: number;
  acceptedAt?: Date;
}): Harness {
  const chunks: string[] = [];
  let ended = false;
  const writer: SSEStreamWriter = {
    write: (chunk) => {
      chunks.push(chunk);
    },
    end: () => {
      ended = true;
    },
    onclose: () => undefined,
  };

  const runs = {
    events: async () => ({ list: options.events }),
    get: async () => ({ counters: { steps: 1, toolCalls: 1, inputTokens: 10, outputTokens: 5 } }),
    cancel: async () => ({}),
  } as unknown as AIAgentRunService;

  const tools = {
    get: (key: string) => ({ label: `Label for ${key}` }),
  } as unknown as AIToolRegistry;

  // turnContext is the first executeTakeFirst; a tool.succeeded adds one for its duration; the
  // terminal run.completed adds one for the assistant message. The ledger read uses execute().
  const takeFirst = options.takeFirst ?? [
    { conversation_id: 'conv-1', created_at: options.acceptedAt ?? new Date() },
    { duration_ms: 7 },
    { id: 'msg-1', content: 'the answer', redaction: 'none' },
  ];
  const database = dbStub(takeFirst, [[]]) as unknown as DatabaseService;

  const settings = {
    settings: async () => ({
      limits: {
        heartbeatSeconds: (options.heartbeatMs ?? 60_000) / 1_000,
        turnTimeoutSeconds: (options.timeoutMs ?? 600_000) / 1_000,
      },
    }),
  } as unknown as CRMChatSettingsService;

  const service = new CRMChatStreamingService(runs, tools, database, settings);
  return { service, writer, chunks, ended: () => ended };
}

/** Poll until `predicate` holds or the deadline passes; returns whether it held. */
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Emitted `id:` values in order, parsed out of the serialized SSE frames. */
function emittedIds(chunks: readonly string[]): string[] {
  return chunks.flatMap((chunk) => {
    const match = /^id: (.*)$/m.exec(chunk);
    return match === null ? [] : [match[1] as string];
  });
}

function emittedEvents(chunks: readonly string[]): string[] {
  return chunks.flatMap((chunk) => {
    const match = /^event: (.*)$/m.exec(chunk);
    return match === null ? [] : [match[1] as string];
  });
}

const FULL_TURN = [
  runEvent(1, 'run.queued'),
  runEvent(2, 'tool.proposed', { toolKey: 'crm.search', step: 1 }),
  runEvent(3, 'tool.succeeded', { toolKey: 'crm.search', step: 1 }, 'searched'),
  runEvent(4, 'approval.requested', { approvalId: 'ap-1', expiresAt: '2030-01-01T00:00:00Z', toolKey: 'crm.update', actionClass: 'write' }, 'approval'),
  runEvent(5, 'run.completed'),
];

describe('CRMChat stream id hygiene (19-CHAT.29)', () => {
  it('gives every emitted event a unique id and keeps seq-derived resume working', async () => {
    const h = harness({ events: FULL_TURN });
    void h.service.streamToWriter(TURN_ID, h.writer);
    expect(await waitFor(h.ended)).toBe(true);

    const ids = emittedIds(h.chunks);
    // turn.started bootstrap + one frame per translated event (approval.requested yields two,
    // run.completed yields assistant.message + usage.summary + turn.completed).
    expect(ids).toEqual(['0', '1', '2', '3', '4-a', '4-r', '5-m', '5-u', '5-t']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of ['action.proposed', 'approval.required', 'assistant.message', 'usage.summary', 'turn.completed']) {
      expect(emittedEvents(h.chunks)).toContain(event);
    }
  }, 15_000);

  it('resumes from a suffixed id at the right seq and ignores non-numeric cursors', async () => {
    // `4-r` parses to 4: everything at seq <= 4 is skipped, the terminal seq-5 frames still arrive.
    const resumed = harness({ events: FULL_TURN });
    void resumed.service.streamToWriter(TURN_ID, resumed.writer, '4-r');
    expect(await waitFor(resumed.ended)).toBe(true);
    expect(emittedIds(resumed.chunks)).toEqual(['0', '5-m', '5-u', '5-t']);

    // A heartbeat id must never become a cursor: parseInt yields NaN, so the replay starts at seq 0
    // and delivers the whole turn again rather than skipping it.
    const afterHeartbeat = harness({ events: FULL_TURN });
    void afterHeartbeat.service.streamToWriter(TURN_ID, afterHeartbeat.writer, 'hb-1730000000000');
    expect(await waitFor(afterHeartbeat.ended)).toBe(true);
    expect(emittedIds(afterHeartbeat.chunks)).toEqual(['0', '1', '2', '3', '4-a', '4-r', '5-m', '5-u', '5-t']);
  }, 30_000);

  it('emits heartbeats with non-resumable ids and still delivers later events', async () => {
    const h = harness({ events: FULL_TURN, heartbeatMs: 50, timeoutMs: 5_000 });
    void h.service.streamToWriter(TURN_ID, h.writer);
    expect(await waitFor(h.ended)).toBe(true);

    const heartbeats = h.chunks.filter((chunk) => chunk.includes('event: heartbeat'));
    expect(heartbeats.length).toBeGreaterThan(0);
    for (const chunk of heartbeats) {
      const id = /^id: (.*)$/m.exec(chunk)?.[1] ?? '';
      expect(id).toMatch(/^hb-/);
      expect(Number.isNaN(parseInt(id, 10))).toBe(true);
    }
    // Events emitted after the heartbeats were still delivered with their sequence ids.
    const ids = emittedIds(h.chunks);
    expect(ids).toContain('5-t');
    expect(ids.filter((id) => id.startsWith('hb-')).length).toBe(heartbeats.length);
  }, 15_000);

  it('maps run.failed and run.canceled to the failed and cancelled Chat events', async () => {
    for (const [runType, chatEvent] of [
      ['run.failed', 'turn.failed'],
      ['run.canceled', 'turn.cancelled'],
    ] as const) {
      const h = harness({ events: [runEvent(1, runType, { category: 'provider' }, 'it broke')] });
      void h.service.streamToWriter(TURN_ID, h.writer);
      expect(await waitFor(h.ended)).toBe(true);
      expect(emittedEvents(h.chunks)).toContain(chatEvent);
    }
  }, 30_000);

  it('reports the configured turn timeout as turn.failed and cancels the run', async () => {
    const h = harness({
      events: [runEvent(1, 'run.queued')],
      heartbeatMs: 60_000,
      timeoutMs: 200,
      acceptedAt: new Date(Date.now() - 1_000),
    });
    void h.service.streamToWriter(TURN_ID, h.writer);
    expect(await waitFor(h.ended)).toBe(true);

    expect(emittedEvents(h.chunks)).toContain('turn.failed');
    const timeoutChunk = h.chunks.find((chunk) => chunk.includes('CHAT_TURN_TIMEOUT'));
    expect(timeoutChunk).toBeDefined();
    const id = /^id: (.*)$/m.exec(timeoutChunk ?? '')?.[1] ?? '';
    expect(id).toMatch(/^timeout-/);
    expect(Number.isNaN(parseInt(id, 10))).toBe(true);
  }, 15_000);
});
