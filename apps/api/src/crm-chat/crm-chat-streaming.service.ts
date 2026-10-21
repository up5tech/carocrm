import { Inject, Injectable } from '@nestjs/common';

import type { AIAgentRunEventView } from '../ai-agents/ai-agent-runs.service.js';
import { AIAgentRunService } from '../ai-agents/ai-agent-runs.service.js';
import { AIToolRegistry } from '../ai-agents/ai-agent-tools.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-CHAT.6 — streaming event types (PLAN_Phase_19_CRM_Chat.md §9.1, §17 `19-CHAT.6`;
 * contract §8.1).
 *
 * These are the user-safe events Chat streams to the UI. They never expose internal tool arguments,
 * hidden reasoning traces, provider request bodies or secrets.
 *
 * ## The translation is a real mapping, not a wish list
 *
 * The source of truth is the AIAgents run timeline. Its event types are
 * `run.queued`, `run.started`, `run.completed`, `run.failed`, `run.canceled`, `model.completed`, `tool.proposed`,
 * `tool.succeeded`, `tool.failed`, `tool.denied`, `tool.outcome_unknown`, `approval.requested` and
 * `approval.executed`. Each one is translated into the Chat vocabulary the SPA listens for. An event
 * with no user-safe translation is dropped rather than passed through, because the raw timeline
 * contains audit-level detail.
 *
 * ## Derived events
 *
 * Two Chat events have no direct source event and are derived honestly:
 *
 *  - `assistant.message` — the final answer lives in the conversation message the run wrote, so it is
 *    read back when the run completes and emitted once.
 *  - `usage.summary` — the run's counters are the truth; the model event only reports one call's
 *    tokens, so the summary is read from the run and its provider ledger.
 *
 * Both are emitted with a synthetic id that continues the run's own sequence, so a client that
 * reconnects with `Last-Event-ID` never sees a gap or a duplicate.
 */
export type CrmChatStreamEventType =
  | 'turn.started'
  | 'tool.started'
  | 'tool.completed'
  | 'citation.added'
  | 'action.proposed'
  | 'approval.required'
  | 'assistant.message'
  | 'usage.summary'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'heartbeat';

export interface CrmChatStreamEvent {
  readonly id: string;
  readonly event: CrmChatStreamEventType;
  readonly data: Record<string, unknown>;
  readonly retry?: number | undefined;
}

/**
 * SSE event serializer following the W3C EventSource format.
 * Each event is a block of `event:` and `data:` lines terminated by `\n\n`.
 */
export function serializeSSEEvent(event: CrmChatStreamEvent): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  lines.push(`event: ${event.event}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  lines.push(''); // empty line before final newline
  return lines.join('\n') + '\n';
}

/**
 * Callback for writing SSE chunks to the response stream.
 */
export interface SSEStreamWriter {
  write(chunk: string): void;
  end(): void;
  onclose(callback: () => void): void;
}

@Injectable()
export class CRMChatStreamingService {
  constructor(
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /**
   * Stream turn events to an SSE writer. Polls the AIAgents run events and translates them into
   * user-safe Chat events. Supports resumption via lastEventId.
   *
   * This method runs until a terminal state is reached or the client disconnects.
   */
  async streamToWriter(turnId: string, writer: SSEStreamWriter, lastEventId?: string): Promise<void> {
    let closed = false;
    let lastSeq = 0;

    // Parse lastEventId to determine where to resume from.
    if (lastEventId) {
      const parsed = parseInt(lastEventId, 10);
      if (!isNaN(parsed)) {
        lastSeq = parsed;
      }
    }

    // Register close handler.
    writer.onclose(() => {
      closed = true;
    });

    // The run itself is the turn: read it once so the first event can carry the conversation id.
    const conversationId = await this.conversationIdOf(turnId);

    // Send initial turn.started event.
    const startEvent: CrmChatStreamEvent = {
      id: '0',
      event: 'turn.started',
      data: { turnId, conversationId, state: 'queued', at: new Date().toISOString() },
    };
    writer.write(serializeSSEEvent(startEvent));

    // Heartbeat every 15 seconds to keep connection alive.
    const heartbeatInterval = setInterval(() => {
      if (closed) {
        clearInterval(heartbeatInterval);
        return;
      }
      const heartbeat: CrmChatStreamEvent = {
        id: String(Date.now()),
        event: 'heartbeat',
        data: { at: new Date().toISOString() },
      };
      writer.write(serializeSSEEvent(heartbeat));
    }, 15_000);

    // Poll for run events and translate them to stream events.
    const pollInterval = setInterval(async () => {
      if (closed) {
        clearInterval(pollInterval);
        clearInterval(heartbeatInterval);
        return;
      }

      try {
        const { list: events } = await this.runs.events(turnId);

        for (const event of events) {
          const seq = Number(event.seq);
          if (seq <= lastSeq) continue; // Skip already-sent events.

          lastSeq = seq;
          const streamEvents = await this.translateEvent(event, turnId);
          for (const streamEvent of streamEvents) {
            writer.write(serializeSSEEvent(streamEvent));
          }

          // Stop polling when we hit a terminal state.
          if (this.isTerminalEvent(event.type)) {
            clearInterval(pollInterval);
            clearInterval(heartbeatInterval);
            setTimeout(() => writer.end(), 100);
            return;
          }
        }
      } catch (error) {
        // Log error but don't crash the stream.
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch events.';
        const errorEvent: CrmChatStreamEvent = {
          id: String(Date.now()),
          event: 'turn.failed',
          data: { turnId, state: 'failed', errorCode: 'CHAT_STREAM_INTERRUPTED', message: errorMessage },
        };
        writer.write(serializeSSEEvent(errorEvent));
        clearInterval(pollInterval);
        clearInterval(heartbeatInterval);
        writer.end();
      }
    }, 1000); // Poll every second.
  }

  /**
   * Translate one AIAgents run event into the Chat events it produces. An event with no user-safe
   * translation yields an empty list rather than being passed through.
   */
  private async translateEvent(event: AIAgentRunEventView, turnId: string): Promise<CrmChatStreamEvent[]> {
    const id = String(event.seq);

    switch (event.type) {
      case 'run.queued':
        return [
          {
            id,
            event: 'turn.started',
            data: { turnId, state: 'queued', at: event.createdAt },
          },
        ];

      case 'run.started':
        return [
          {
            id,
            event: 'turn.started',
            data: { turnId, state: 'running', at: event.createdAt },
          },
        ];

      case 'tool.proposed': {
        const toolKey = this.extractString(event.payload, 'toolKey');
        return [
          {
            id,
            event: 'tool.started',
            data: {
              step: this.extractNumber(event.payload, 'step') ?? 0,
              toolKey,
              // The tool's declared label, never its arguments.
              label: toolKey === null ? '' : this.toolLabel(toolKey),
            },
          },
        ];
      }

      case 'tool.succeeded':
      case 'tool.failed':
      case 'tool.denied':
      case 'tool.outcome_unknown':
        return [await this.toolCompleted(event, id, turnId)];

      case 'approval.requested': {
        const approvalId = this.extractString(event.payload, 'approvalId');
        const expiresAt = this.extractString(event.payload, 'expiresAt');
        const toolKey = this.extractString(event.payload, 'toolKey');
        return [
          {
            id,
            event: 'action.proposed',
            data: {
              approvalId,
              riskClass: this.extractString(event.payload, 'actionClass'),
              targetCount: 0,
              summary: event.summary,
            },
          },
          {
            id,
            event: 'approval.required',
            data: { approvalId, expiresAt, toolKey },
          },
        ];
      }

      case 'model.completed':
        // One model call is not a usage summary; the summary is emitted with the terminal event.
        return [];

      case 'run.completed': {
        const events: CrmChatStreamEvent[] = [];
        // The run row is settled before conversation memory receives the assistant message, so the
        // terminal event can be visible here a moment before the answer is queryable. Wait briefly
        // for that write, otherwise the client would refresh history and miss the answer.
        const answer = await this.awaitAssistantMessage(turnId);
        if (answer !== null) {
          events.push({
            id,
            event: 'assistant.message',
            data: { messageId: answer.id, content: answer.content, redaction: answer.redaction },
          });
        }
        const usage = await this.usageOf(turnId);
        if (usage !== null) {
          events.push({ id, event: 'usage.summary', data: usage });
        }
        events.push({
          id,
          event: 'turn.completed',
          data: { turnId, state: 'completed', usage: usage ?? undefined },
        });
        return events;
      }

      case 'run.failed':
        return [
          {
            id,
            event: 'turn.failed',
            data: {
              turnId,
              state: 'failed',
              errorCode: this.extractString(event.payload, 'category') ?? 'CHAT_TURN_FAILED',
              message: event.summary,
            },
          },
        ];

      case 'run.canceled':
        return [{ id, event: 'turn.cancelled', data: { turnId, state: 'cancelled' } }];

      default:
        // Ignore event types with no user-safe translation rather than exposing them.
        return [];
    }
  }

  /** The completion of a tool call, in the tool's own user-safe words. */
  private async toolCompleted(event: AIAgentRunEventView, id: string, turnId: string): Promise<CrmChatStreamEvent> {
    const payload = event.payload;
    const toolKey = this.extractString(payload, 'toolKey');
    const step = this.extractNumber(payload, 'step') ?? 0;
    const durationMs = await this.toolDuration(turnId, step, toolKey);

    return {
      id,
      event: 'tool.completed',
      data: {
        step,
        toolKey,
        status: this.toolStatus(event.type),
        summary: event.summary,
        durationMs,
      },
    };
  }

  private toolStatus(eventType: string): string {
    switch (eventType) {
      case 'tool.succeeded':
        return 'succeeded';
      case 'tool.failed':
        return 'failed';
      case 'tool.denied':
        return 'denied';
      case 'tool.outcome_unknown':
        return 'outcome_unknown';
      default:
        return 'unknown';
    }
  }

  /** The duration the runtime measured for one tool call, when it recorded one. */
  private async toolDuration(runId: string, step: number, toolKey: string | null): Promise<number | null> {
    if (toolKey === null) return null;
    const row = await this.database.db
      .selectFrom('ai_agent_tool_calls')
      .select('duration_ms')
      .where('run_id', '=', runId)
      .where('step', '=', step)
      .where('tool_key', '=', toolKey)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row?.duration_ms ?? null;
  }

  /**
   * Wait for the memory write that follows a settled run. The terminal event is appended by the run
   * engine before conversation memory is persisted, so an immediate read can race the answer.
   */
  private async awaitAssistantMessage(
    turnId: string,
  ): Promise<{ id: string; content: string; redaction: string } | null> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const answer = await this.assistantMessage(turnId);
      if (answer !== null) return answer;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.assistantMessage(turnId);
  }

  /** The assistant's final answer for a run, read back from the conversation message it wrote. */
  private async assistantMessage(
    turnId: string,
  ): Promise<{ id: string; content: string; redaction: string } | null> {
    const row = await this.database.db
      .selectFrom('ai_agent_messages')
      .select(['id', 'content', 'redaction'])
      .where('run_id', '=', turnId)
      .where('role', '=', 'assistant')
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    if (!row) return null;
    return { id: row.id, content: row.content, redaction: row.redaction };
  }

  /** The usage of one run, read from its counters and its provider ledger. */
  private async usageOf(turnId: string): Promise<Record<string, unknown> | null> {
    const run = await this.runs.get(turnId).catch(() => null);
    if (!run) return null;
    const ledger = await this.database.db
      .selectFrom('ai_agent_provider_requests')
      .select('estimated_cost_usd')
      .where('run_id', '=', turnId)
      .execute();
    const priced = ledger.filter((row) => row.estimated_cost_usd !== null).length;
    return {
      steps: run.counters.steps,
      toolCalls: run.counters.toolCalls,
      inputTokens: run.counters.inputTokens,
      outputTokens: run.counters.outputTokens,
      costLabel: priced === 0 ? 'none' : 'estimate',
    };
  }

  /** The conversation a run belongs to, when it has one. */
  private async conversationIdOf(turnId: string): Promise<string | null> {
    const row = await this.database.db
      .selectFrom('ai_agent_runs')
      .select('conversation_id')
      .where('id', '=', turnId)
      .executeTakeFirst();
    return row?.conversation_id ?? null;
  }

  /** The tool's declared label, or its key when the tool is unknown. */
  private toolLabel(toolKey: string): string {
    try {
      return this.tools.get(toolKey).label;
    } catch {
      return toolKey;
    }
  }

  /** Check if an event type represents a terminal state. */
  private isTerminalEvent(eventType: string): boolean {
    return eventType.startsWith('run.') && ['run.completed', 'run.failed', 'run.canceled', 'run.expired'].includes(eventType);
  }

  // Helper extraction functions to safely pull data from event payloads.

  private extractString(payload: unknown, ...keys: string[]): string | null {
    const p = payload as Record<string, unknown>;
    for (const key of keys) {
      if (typeof p[key] === 'string') return p[key] as string;
    }
    return null;
  }

  private extractNumber(payload: unknown, ...keys: string[]): number | null {
    const p = payload as Record<string, unknown>;
    for (const key of keys) {
      if (typeof p[key] === 'number') return p[key] as number;
    }
    return null;
  }
}
