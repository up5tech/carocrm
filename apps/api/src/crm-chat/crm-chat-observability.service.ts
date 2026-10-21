import { NotFoundError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AIAgentRunService } from '../ai-agents/ai-agent-runs.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Phase 19-CHAT.16/19-CHAT.17 — usage, limits and observability
 * (PLAN_Phase_19_CRM_Chat.md §15.3, §17 `19-CHAT.16`/`19-CHAT.17`; contract §6.8, §11).
 *
 * ## Chat does not invent usage
 *
 * The authoritative counters live on the AIAgents run (`ai_agent_runs`) and the provider ledger
 * (`ai_agent_provider_requests`). Chat reads them and presents them; it never maintains a parallel
 * counter, estimates a cost, or writes a usage row. `costLabel` is carried through with the same
 * meaning AIAgents gives it: `estimate` when at least one request was priced from an
 * administrator-maintained snapshot, `none` when the deployment has no price data — in which case
 * the total is an exact `0`, never a guess.
 *
 * ## Correlation
 *
 * Every log line carries the turn id, and the turn id *is* the AIAgents run id, so a report, a log
 * line and a run row can be joined without a mapping table. The metrics here are deliberately
 * countable and free of user content: ids, counts, durations and statuses only.
 *
 * ## What is never logged
 *
 * No prompt text, no record body, no tool argument, no provider request or response, no credential
 * and no connection string. The sanitizer below is the last line of defence for the error message,
 * which is the only free-text field that reaches the log.
 */
export interface ChatTurnMetrics {
  readonly turnId: string;
  readonly userId: string;
  readonly agentId?: string | undefined;
  readonly status: 'started' | 'completed' | 'failed' | 'cancelled';
  readonly durationMs: number;
  readonly timeToFirstEventMs?: number | undefined;
  readonly errorCode?: string | undefined;
}

export interface ChatQueryMetrics {
  readonly userId: string;
  readonly entity: string;
  readonly recordCount: number;
  readonly durationMs: number;
  readonly success: boolean;
}

/** The usage of one turn, read from the AIAgents run and its provider ledger. */
export interface CRMChatUsageSummary {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly steps: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** `estimate` when the cost came from a pricing snapshot, `none` when there is no price data. */
  readonly costLabel: 'estimate' | 'none';
}

@Injectable()
export class CRMChatObservabilityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * The usage of one turn. The run is read through `AIAgentRunService`, which enforces the caller's
   * visibility, so a turn that is not the caller's is reported as absent.
   */
  async usageForTurn(turnId: string): Promise<CRMChatUsageSummary> {
    if (typeof turnId !== 'string' || turnId.trim() === '') {
      throw new NotFoundError('Turn not found.');
    }
    const run = await this.runs.get(turnId);

    const ledger = await this.database.db
      .selectFrom('ai_agent_provider_requests')
      .select(['estimated_cost_usd'])
      .where('run_id', '=', run.id)
      .execute();
    const priced = ledger.filter((row) => row.estimated_cost_usd !== null).length;

    return {
      turnId: run.id,
      runId: run.id,
      status: run.status,
      steps: run.counters.steps,
      modelCalls: run.counters.modelCalls,
      toolCalls: run.counters.toolCalls,
      inputTokens: run.counters.inputTokens,
      outputTokens: run.counters.outputTokens,
      estimatedCostUsd: ledger.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0),
      costLabel: priced === 0 ? 'none' : 'estimate',
    };
  }

  /**
   * Log a turn event with correlation ID and safe metadata.
   * Never logs secrets, prompts, or sensitive user content.
   */
  logTurnEvent(metrics: ChatTurnMetrics): void {
    log.info(
      {
        component: 'crm-chat',
        eventType: 'turn',
        turnId: metrics.turnId,
        userId: metrics.userId,
        agentId: metrics.agentId,
        status: metrics.status,
        durationMs: metrics.durationMs,
        timeToFirstEventMs: metrics.timeToFirstEventMs,
        ...(metrics.errorCode ? { errorCode: metrics.errorCode } : {}),
        // Never log errorMessage directly - may contain sensitive data
      },
      `Chat turn ${metrics.status}: ${metrics.turnId}`,
    );
  }

  /**
   * Log a query event with safe metadata.
   */
  logQueryEvent(metrics: ChatQueryMetrics): void {
    log.info(
      {
        component: 'crm-chat',
        eventType: 'query',
        userId: metrics.userId,
        entity: metrics.entity,
        recordCount: metrics.recordCount,
        durationMs: metrics.durationMs,
        success: metrics.success,
      },
      `Chat query on ${metrics.entity}: ${metrics.success ? 'success' : 'failed'}`,
    );
  }

  /**
   * Log a security event (denied access, policy trigger).
   */
  logSecurityEvent(event: string, details: Record<string, unknown>): void {
    log.warn(
      {
        component: 'crm-chat',
        eventType: 'security',
        event,
        userId: this.currentUserId(),
        ...details,
      },
      `Security event: ${event}`,
    );
  }

  /**
   * Log an error with safe mapping - never expose stack traces or credentials.
   */
  logError(error: Error, context: string): void {
    log.error(
      {
        component: 'crm-chat',
        eventType: 'error',
        context,
        userId: this.currentUserId(),
        errorName: error.name,
        errorMessage: this.sanitizeErrorMessage(error.message),
      },
      `Chat error in ${context}`,
    );
  }

  /**
   * Generate a correlation ID for tracking requests across services.
   */
  generateCorrelationId(): string {
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Sanitize error message to remove sensitive data.
   */
  private sanitizeErrorMessage(message: string): string {
    let sanitized = message;

    // Remove common credential patterns
    sanitized = sanitized.replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
    sanitized = sanitized.replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]');
    sanitized = sanitized.replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[REDACTED]');
    sanitized = sanitized.replace(/secret[=:]\s*\S+/gi, 'secret=[REDACTED]');

    // Remove database connection strings
    sanitized = sanitized.replace(/postgresql:\/\/\S+/gi, 'postgresql://[REDACTED]');
    sanitized = sanitized.replace(/mysql:\/\/\S+/gi, 'mysql://[REDACTED]');

    // Limit length to prevent log flooding
    if (sanitized.length > 500) {
      sanitized = sanitized.slice(0, 500) + '...[truncated]';
    }

    return sanitized;
  }

  private currentUserId(): string {
    return this.scope.userId ?? 'unknown';
  }
}
