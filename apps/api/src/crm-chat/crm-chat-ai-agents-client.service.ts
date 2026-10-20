import { Inject, Injectable } from '@nestjs/common';

import type { RunCreateInput } from '../ai-agents/ai-agent-runs.service.js';
import { AIAgentRunService } from '../ai-agents/ai-agent-runs.service.js';

/**
 * Phase 19-CHAT.5 — narrow AIAgents integration adapter
 * (PLAN_Phase_19_CRM_Chat.md §4.1, §14.1, §17 `19-CHAT.5`).
 *
 * This adapter is the **only** place where CRMChat calls into the AIAgents runtime. It does not
 * implement a second planning loop, tool executor, provider gateway or approval engine. Every call
 * delegates to `AIAgentRunService` and translates the result into a Chat-specific shape.
 *
 * The adapter passes the authenticated principal context through the request scope that AIAgents
 * already consumes; it never fabricates a user ID, role or team membership.
 */

export interface CrmChatTurnSubmission {
  /** The agent key configured as the assistant (resolved by CRMChatAssistantService before calling). */
  readonly agentId: string;
  /** User-visible prompt text. */
  readonly prompt: string;
  /** Optional conversation thread to continue; refused if the agent has memory off. */
  readonly conversationId?: string | undefined;
  /** Client-generated idempotency key to prevent duplicate turns on retry. */
  readonly idempotencyKey: string;
  /** Optional safe context references (record IDs the user is viewing). */
  readonly contextRefs?: readonly { readonly entity: string; readonly id: string }[] | undefined;
}

export interface CrmChatTurnResult {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly conversationId: string | null;
}

export interface CrmChatTurnStatus {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly conversationId: string | null;
  readonly result: unknown;
  readonly failureMessage: string | null;
  readonly cancelRequested: boolean;
}

@Injectable()
export class CRMChatAIAgentsClientService {
  constructor(
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
  ) {}

  /**
   * Submit a turn to the AIAgents runtime. The caller (CRMChatAssistantService) has already verified
   * that the configured assistant agent is published and ready. This method creates the run under the
   * current authenticated user's security context.
   */
  async submitTurn(input: CrmChatTurnSubmission): Promise<CrmChatTurnResult> {
    const runInput: RunCreateInput = {
      input: {
        text: input.prompt,
        ...(input.contextRefs && input.contextRefs.length > 0
          ? { record: input.contextRefs[0] }
          : {}),
      },
      idempotencyKey: input.idempotencyKey,
      conversationId: input.conversationId,
    };

    const run = await this.runs.create(input.agentId, runInput);

    return {
      turnId: run.id,
      runId: run.id,
      status: run.status,
      conversationId: run.conversationId,
    };
  }

  /**
   * Retrieve the current status of a turn. The turn ID is the same as the AIAgents run ID because
   * Chat reuses the run as its turn identifier (no duplication).
   */
  async getTurnStatus(turnId: string): Promise<CrmChatTurnStatus> {
    const run = await this.runs.get(turnId);

    return {
      turnId: run.id,
      runId: run.id,
      status: run.status,
      conversationId: run.conversationId,
      result: run.result,
      failureMessage: run.failureMessage,
      cancelRequested: run.cancelRequested,
    };
  }

  /**
   * Cancel a running turn. Delegates to AIAgents' cancellation mechanism; the run may complete a
   * step before stopping, so the returned status reflects what actually happened.
   */
  async cancelTurn(turnId: string): Promise<CrmChatTurnStatus> {
    await this.runs.cancel(turnId);
    // Re-read to capture the state after cancellation request.
    return this.getTurnStatus(turnId);
  }

  /**
   * Retrieve the event timeline for a turn. These are AIAgents run events, which Chat renders as
   * progress updates in the UI without exposing internal tool arguments or hidden reasoning.
   */
  async getTurnEvents(turnId: string) {
    return this.runs.events(turnId);
  }
}
