import { Inject, Injectable } from '@nestjs/common';

import { log } from '@carocrm/core/logger/index.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';

/**
 * Phase 19-CHAT.16 — Usage, Limits, and Observability
 * (PLAN_Phase_19_CRM_Chat.md §15.3, §17 `19-CHAT.16`).
 *
 * This service provides observability for CRM Chat operations:
 * - Structured logging with correlation IDs
 * - Usage metrics tracking (reuses AIAgents usage accounting)
 * - Safe error mapping (no secrets or sensitive data in logs)
 * - Operational metrics for monitoring and alerting
 *
 * All logging avoids secrets, full prompts containing sensitive records,
 * bearer tokens, provider credentials, or unredacted personal data.
 */

export interface ChatTurnMetrics {
  readonly turnId: string;
  readonly userId: string;
  readonly agentId?: string | undefined;
  readonly status: 'started' | 'completed' | 'failed' | 'cancelled';
  readonly durationMs: number;
  readonly timeToFirstEventMs?: number | undefined;
  readonly errorMessage?: string | undefined;
  readonly errorCode?: string | undefined;
}

export interface ChatQueryMetrics {
  readonly userId: string;
  readonly entity: string;
  readonly recordCount: number;
  readonly durationMs: number;
  readonly success: boolean;
}

@Injectable()
export class CRMChatObservabilityService {
  constructor(
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Log a turn event with correlation ID and safe metadata.
   * Never logs secrets, prompts, or sensitive user content.
   */
  logTurnEvent(metrics: ChatTurnMetrics): void {
    const principal = this.scope.getPrincipal();
    const userId = principal?.userId || 'unknown';

    // Safe log entry - no sensitive data
    log.info({
      component: 'crm-chat',
      eventType: 'turn',
      turnId: metrics.turnId,
      userId,
      agentId: metrics.agentId,
      status: metrics.status,
      durationMs: metrics.durationMs,
      timeToFirstEventMs: metrics.timeToFirstEventMs,
      ...(metrics.errorCode ? { errorCode: metrics.errorCode } : {}),
      // Never log errorMessage directly - may contain sensitive data
    }, `Chat turn ${metrics.status}: ${metrics.turnId}`);
  }

  /**
   * Log a query event with safe metadata.
   */
  logQueryEvent(metrics: ChatQueryMetrics): void {
    const principal = this.scope.getPrincipal();
    const userId = principal?.userId || 'unknown';

    log.info({
      component: 'crm-chat',
      eventType: 'query',
      userId,
      entity: metrics.entity,
      recordCount: metrics.recordCount,
      durationMs: metrics.durationMs,
      success: metrics.success,
    }, `Chat query on ${metrics.entity}: ${metrics.success ? 'success' : 'failed'}`);
  }

  /**
   * Log a security event (denied access, policy trigger).
   */
  logSecurityEvent(event: string, details: Record<string, unknown>): void {
    const principal = this.scope.getPrincipal();
    const userId = principal?.userId || 'unknown';

    log.warn({
      component: 'crm-chat',
      eventType: 'security',
      event,
      userId,
      ...details,
    }, `Security event: ${event}`);
  }

  /**
   * Log an error with safe mapping - never expose stack traces or credentials.
   */
  logError(error: Error, context: string): void {
    const principal = this.scope.getPrincipal();
    const userId = principal?.userId || 'unknown';

    // Safe error log - no stack trace or sensitive data
    log.error({
      component: 'crm-chat',
      eventType: 'error',
      context,
      userId,
      errorName: error.name,
      errorMessage: this.sanitizeErrorMessage(error.message),
    }, `Chat error in ${context}`);
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
    // Remove potential credentials, tokens, connection strings
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

  /**
   * Track usage metrics for a turn (delegates to AIAgents usage tracking).
   * This is a placeholder - actual implementation would integrate with AIAgents usage service.
   */
  async trackTurnUsage(turnId: string, metrics: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    toolCalls?: number;
  }): Promise<void> {
    // In production, this would call AIAgents usage tracking service
    // For now, just log the metrics safely
    log.info({
      component: 'crm-chat',
      eventType: 'usage',
      turnId,
      ...metrics,
    }, `Usage tracked for turn ${turnId}`);
  }
}
