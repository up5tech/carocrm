import { AppError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RunCreateInput } from '../ai-agents/ai-agent-runs.service.js';
import { AIAgentRunService } from '../ai-agents/ai-agent-runs.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { CRMChatCitationService } from './crm-chat-citations.service.js';
import { type CRMChatSettings,CRMChatSettingsService } from './crm-chat-settings.service.js';

/**
 * Phase 19-CHAT.5 — narrow AIAgents integration adapter
 * (plans/PLAN_Phase_19_CRM_Chat.md §4.1, §14.1, §17 `19-CHAT.5`).
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
    @Inject(CRMChatSettingsService) private readonly settings: CRMChatSettingsService,
    @Inject(CRMChatCitationService) private readonly citations: CRMChatCitationService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Submit a turn to the AIAgents runtime. The caller (CRMChatAssistantService) has already verified
   * that the configured assistant agent is published and ready. This method creates the run under the
   * current authenticated user's security context.
   */
  async submitTurn(input: CrmChatTurnSubmission): Promise<CrmChatTurnResult> {
    // 19-CHAT.26 / 19-AI.28 — every validated context reference is forwarded. `record` stays the
    // first ref so single-reference consumers (conversation binding, run view) keep working;
    // `records` carries the full list into the run input and the prompt. AIAgents re-checks each
    // ref under the starter's ACL at creation, so nothing unreadable reaches the model.
    const refs = input.contextRefs ?? [];
    const runInput: RunCreateInput = {
      input: {
        text: input.prompt,
        ...(refs.length > 0 ? { record: refs[0] } : {}),
        ...(refs.length > 0 ? { records: [...refs] } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      conversationId: input.conversationId,
    };

    const settings = await this.settings.settings();
    const executionMode = settings.execution.mode;
    await this.assertTurnBudgets(settings.limits, input.conversationId !== undefined);
    const run = await this.runs.create(input.agentId, runInput);

    // `queue` is the durable default: BullMQ hands the run to a worker. `inline` starts the exact
    // same run in this process, which makes a single-process install usable without a worker. The
    // run is still enqueued by `create`, so a crash mid-run has the same recovery path as any other
    // queued run; the lease in `execute` makes the two dispatches idempotent.
    if (executionMode === 'inline') {
      void this.runs.execute(run.id).catch((error: unknown) => {
        log.error(
          { runId: run.id, error: error instanceof Error ? error.message : 'unknown inline execution error' },
          'crm chat inline run failed to start',
        );
      });
    }

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
   *
   * `result.sources` is re-authorized on the way out (G39). The runtime recorded those references at
   * answer time, under whoever could read then; returning them as stored would mean the citations obeyed
   * the caller's current rights while this field obeyed the past ones.
   */
  async getTurnStatus(turnId: string): Promise<CrmChatTurnStatus> {
    const run = await this.runs.get(turnId);

    return {
      turnId: run.id,
      runId: run.id,
      status: run.status,
      conversationId: run.conversationId,
      result: await this.citations.reauthorizedResult(run.result),
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

  /**
   * 19-CHAT.25 — the per-user bounds the settings screen advertises, checked before a run exists.
   * The counts are read-then-create, the same best-effort shape `aiAgents.limits.maxConcurrency`
   * uses: two simultaneous submissions can both pass, which is why the hard ceilings live in
   * AIAgents' own quota service. These bounds stop a runaway client, they do not meter.
   */
  private async assertTurnBudgets(
    limits: CRMChatSettings['limits'],
    continuingConversation: boolean,
  ): Promise<void> {
    const userId = this.scope.userId;
    if (userId === undefined) return; // Without a principal the run service refuses anyway.
    const db = this.database.db;

    const active = await db
      .selectFrom('ai_agent_runs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('initiated_by_user_id', '=', userId)
      .where('status', 'in', [
        'queued',
        'running',
        'retry_wait',
        'cancel_requested',
        'waiting_for_approval',
        'waiting_for_input',
      ])
      .executeTakeFirst();
    if (Number(active?.count ?? 0) >= limits.maxActiveTurnsPerUser) {
      throw new AppError(
        'CHAT_TURN_LIMITED',
        `You already have the maximum of ${String(limits.maxActiveTurnsPerUser)} active Chat turns.`,
        { maxActiveTurnsPerUser: limits.maxActiveTurnsPerUser },
        429,
      );
    }

    const recent = await db
      .selectFrom('ai_agent_runs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('initiated_by_user_id', '=', userId)
      .where('created_at', '>', new Date(Date.now() - 60_000))
      .executeTakeFirst();
    if (Number(recent?.count ?? 0) >= limits.maxTurnsPerMinute) {
      throw new AppError(
        'RATE_LIMITED',
        `You may start at most ${String(limits.maxTurnsPerMinute)} Chat turns per minute.`,
        { maxTurnsPerMinute: limits.maxTurnsPerMinute },
        429,
      );
    }

    // A new conversation is only created when the turn does not continue one; continuing an
    // existing thread never consumes a slot.
    if (!continuingConversation) {
      const conversations = await db
        .selectFrom('ai_agent_conversations')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('owner_user_id', '=', userId)
        .where('status', '<>', 'deleted')
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
        .executeTakeFirst();
      if (Number(conversations?.count ?? 0) >= limits.maxConversationsPerUser) {
        throw new AppError(
          'CHAT_CONVERSATION_LIMIT',
          `You already have the maximum of ${String(limits.maxConversationsPerUser)} conversations.`,
          { maxConversationsPerUser: limits.maxConversationsPerUser },
          429,
        );
      }
    }
  }
}
