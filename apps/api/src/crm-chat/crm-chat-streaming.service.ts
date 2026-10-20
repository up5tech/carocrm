import { Inject, Injectable } from '@nestjs/common';

import type { AIAgentRunEventView } from '../ai-agents/ai-agent-runs.service.js';
import { AIAgentRunService } from '../ai-agents/ai-agent-runs.service.js';

/**
 * Phase 19-CHAT.6 — streaming event types
 * (PLAN_Phase_19_CRM_Chat.md §9.1, contract §8.3).
 *
 * These are the user-safe events Chat streams to the UI. They never expose internal tool arguments,
 * hidden reasoning traces, provider request bodies or secrets.
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

    // Send initial turn.started event.
    const startEvent: CrmChatStreamEvent = {
      id: '0',
      event: 'turn.started',
      data: { turnId },
    };
    writer.write(serializeSSEEvent(startEvent));

    // Poll for run events and translate them to stream events.
    const pollInterval = setInterval(async () => {
      if (closed) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const { list: events } = await this.runs.events(turnId);

        for (const event of events) {
          const seq = Number(event.seq);
          if (seq <= lastSeq) continue; // Skip already-sent events.

          lastSeq = seq;
          const streamEvent = this.translateEvent(event, turnId);
          if (streamEvent) {
            writer.write(serializeSSEEvent(streamEvent));
          }

          // Stop polling when we hit a terminal state.
          if (this.isTerminalEvent(event.type)) {
            clearInterval(pollInterval);
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
          data: { turnId, error: errorMessage },
        };
        writer.write(serializeSSEEvent(errorEvent));
        clearInterval(pollInterval);
        writer.end();
      }
    }, 1000); // Poll every second.

    // Heartbeat every 15 seconds to keep connection alive.
    const heartbeatInterval = setInterval(() => {
      if (closed) {
        clearInterval(heartbeatInterval);
        return;
      }
      const heartbeat: CrmChatStreamEvent = {
        id: String(Date.now()),
        event: 'heartbeat',
        data: {},
      };
      writer.write(serializeSSEEvent(heartbeat));
    }, 15_000);
  }

  /**
   * Translate an AIAgents run event into a user-safe Chat stream event.
   * Filters out sensitive information like tool arguments and hidden reasoning.
   */
  private translateEvent(event: AIAgentRunEventView, turnId: string): CrmChatStreamEvent | null {
    const eventType = event.type;

    // Map AIAgents event types to Chat stream event types.
    let chatEventType: CrmChatStreamEventType;
    let data: Record<string, unknown>;

    switch (eventType) {
      case 'run.started':
        chatEventType = 'turn.started';
        data = { turnId, summary: event.summary };
        break;

      case 'tool.call_started':
        chatEventType = 'tool.started';
        data = {
          toolKey: this.extractToolKey(event.payload),
          summary: event.summary,
        };
        break;

      case 'tool.call_completed':
        chatEventType = 'tool.completed';
        data = {
          toolKey: this.extractToolKey(event.payload),
          summary: event.summary,
          durationMs: this.extractDuration(event.payload),
        };
        break;

      case 'citation.added':
        chatEventType = 'citation.added';
        data = {
          sourceType: this.extractSourceType(event.payload),
          displayLabel: this.extractDisplayLabel(event.payload),
        };
        break;

      case 'action.proposed':
        chatEventType = 'action.proposed';
        data = {
          proposalId: this.extractProposalId(event.payload),
          actionType: this.extractActionType(event.payload),
          targetCount: this.extractTargetCount(event.payload),
        };
        break;

      case 'approval.required':
        chatEventType = 'approval.required';
        data = {
          approvalId: this.extractApprovalId(event.payload),
          riskClass: this.extractRiskClass(event.payload),
        };
        break;

      case 'assistant.response':
        chatEventType = 'assistant.message';
        data = {
          content: this.extractContent(event.payload),
        };
        break;

      case 'usage.summary':
        chatEventType = 'usage.summary';
        data = {
          inputTokens: this.extractInputTokens(event.payload),
          outputTokens: this.extractOutputTokens(event.payload),
          estimatedCostUsd: this.extractCost(event.payload),
        };
        break;

      case 'run.succeeded':
        chatEventType = 'turn.completed';
        data = { turnId, summary: event.summary };
        break;

      case 'run.failed':
        chatEventType = 'turn.failed';
        data = {
          turnId,
          error: event.summary,
          failureCategory: this.extractFailureCategory(event.payload),
        };
        break;

      case 'run.canceled':
        chatEventType = 'turn.cancelled';
        data = { turnId };
        break;

      default:
        // Ignore unknown event types rather than exposing them.
        return null;
    }

    return {
      id: String(event.seq),
      event: chatEventType,
      data,
    };
  }

  /** Check if an event type represents a terminal state. */
  private isTerminalEvent(eventType: string): boolean {
    return ['run.succeeded', 'run.failed', 'run.canceled', 'run.expired'].includes(eventType);
  }

  // Helper extraction functions to safely pull data from event payloads.

  private extractString(payload: unknown, ...keys: string[]): string | null {
    const p = payload as Record<string, unknown>;
    for (const key of keys) {
      if (typeof p[key] === 'string') return p[key];
    }
    return null;
  }

  private extractNumber(payload: unknown, ...keys: string[]): number | null {
    const p = payload as Record<string, unknown>;
    for (const key of keys) {
      if (typeof p[key] === 'number') return p[key];
    }
    return null;
  }

  private extractToolKey(payload: unknown): string | null {
    return this.extractString(payload, 'tool_key', 'toolKey');
  }

  private extractDuration(payload: unknown): number | null {
    return this.extractNumber(payload, 'duration_ms', 'durationMs');
  }

  private extractSourceType(payload: unknown): string | null {
    return this.extractString(payload, 'source_type', 'sourceType');
  }

  private extractDisplayLabel(payload: unknown): string | null {
    return this.extractString(payload, 'display_label', 'displayLabel');
  }

  private extractProposalId(payload: unknown): string | null {
    return this.extractString(payload, 'proposal_id', 'proposalId');
  }

  private extractActionType(payload: unknown): string | null {
    return this.extractString(payload, 'action_type', 'actionType');
  }

  private extractTargetCount(payload: unknown): number | null {
    return this.extractNumber(payload, 'target_count', 'targetCount');
  }

  private extractApprovalId(payload: unknown): string | null {
    return this.extractString(payload, 'approval_id', 'approvalId');
  }

  private extractRiskClass(payload: unknown): string | null {
    return this.extractString(payload, 'risk_class', 'riskClass');
  }

  private extractContent(payload: unknown): string | null {
    return this.extractString(payload, 'content');
  }

  private extractInputTokens(payload: unknown): number | null {
    return this.extractNumber(payload, 'input_tokens', 'inputTokens');
  }

  private extractOutputTokens(payload: unknown): number | null {
    return this.extractNumber(payload, 'output_tokens', 'outputTokens');
  }

  private extractCost(payload: unknown): number | null {
    return this.extractNumber(payload, 'estimated_cost_usd', 'estimatedCostUsd');
  }

  private extractFailureCategory(payload: unknown): string | null {
    return this.extractString(payload, 'failure_category', 'failureCategory');
  }
}
