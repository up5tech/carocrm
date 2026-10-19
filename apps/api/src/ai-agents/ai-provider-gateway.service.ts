import { createHash, randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import type { DataClass } from './ai-agents-module.js';
import { AIAgentPricingService } from './ai-agent-pricing.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import {
  AIProviderError,
  type AIProviderErrorCategory,
  type AIProviderRequest,
  type AIProviderResponse,
  type AIProviderUsage,
} from './ai-provider.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';
import { assertSafeProviderBaseUrl } from './ai-provider-url.js';
import type { ProviderCheckInput } from './dto/ai-agents-shapes.js';

/**
 * Phase 19-AI.4 — the provider gateway
 * (PLAN_Phase_19_AI_Agents.md §6, §12.1, §16, §20 `19-AI.4`).
 *
 * This is the only place a model call is made. It does not know an agent's business rules; it
 * enforces the transport-level policy that must hold for every call:
 *
 *  - the connection exists, is enabled and names a registered adapter;
 *  - the requested model is on the connection's allowlist;
 *  - the request's data class is allowed both by the connection and by the module's global policy;
 *  - the endpoint passes the SSRF check **again** immediately before the call;
 *  - timeouts and cancellation are passed through;
 *  - every attempt is written to `ai_agent_provider_requests` with usage, latency and a normalized
 *    outcome — never the prompt or the completion.
 *
 * The ledger write is deliberately best-effort: the provider call has already consumed tokens, and
 * failing the caller after a successful call would invite a duplicate retry. A ledger failure is
 * logged with a correlation id so an operator can investigate; it never exposes request content.
 */

export interface GatewayRunContext {
  readonly runId: string;
  readonly step: number;
  readonly agentId: string;
  readonly agentVersion: number;
}

export interface GatewayCompleteInput {
  readonly connectionKey: string;
  readonly request: AIProviderRequest;
  /** Defaults to `internal`; a caller handling restricted data must say so explicitly. */
  readonly dataClass?: DataClass | undefined;
  /** Present for an agent run; absent for an administrator's connectivity check. */
  readonly run?: GatewayRunContext | undefined;
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly connectionKey: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly category: AIProviderErrorCategory | null;
  readonly message: string;
  readonly providerRequestId: string | null;
  readonly usage: AIProviderUsage | null;
}

@Injectable()
export class AIProviderGateway {
  constructor(
    @Inject(AIProviderConnectionService) private readonly connections: AIProviderConnectionService,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentPricingService) private readonly pricing: AIAgentPricingService,
  ) {}

  async complete(input: GatewayCompleteInput): Promise<AIProviderResponse> {
    const settings = await this.settings.settings();
    const dataClass = input.dataClass ?? 'internal';
    if (!settings.dataPolicy.allowedExternalDataClasses.includes(dataClass)) {
      throw new ValidationError(`Data class "${dataClass}" is not allowed for an external provider.`);
    }

    const connection = await this.connections.resolve(input.connectionKey);
    if (connection.models.length === 0) {
      throw new ValidationError(`Provider connection "${connection.key}" allows no models.`);
    }
    if (!connection.models.includes(input.request.model)) {
      throw new ValidationError(`Model "${input.request.model}" is not on the allowlist of "${connection.key}".`, {
        allowedModels: connection.models,
      });
    }
    if (!connection.dataClasses.includes(dataClass)) {
      throw new ValidationError(
        `Provider connection "${connection.key}" is not approved for the "${dataClass}" data class.`,
        { allowedDataClasses: connection.dataClasses },
      );
    }

    const safe = await assertSafeProviderBaseUrl(connection.baseUrl, {
      allowLoopback: connection.config.allowLoopback,
    });
    const adapter = this.connections.adapterFor(connection.kind);
    if (input.request.responseFormat?.type === 'json_schema' && !adapter.capabilities.structuredOutput) {
      throw new ValidationError(`Provider adapter "${adapter.key}" does not support structured output.`);
    }
    if ((input.request.tools?.length ?? 0) > 0 && !adapter.capabilities.toolCalling) {
      throw new ValidationError(`Provider adapter "${adapter.key}" does not support tool calling.`);
    }
    const timeoutMs = Math.min(
      input.request.timeoutMs ?? settings.limits.maxElapsedSeconds * 1_000,
      settings.limits.maxElapsedSeconds * 1_000,
    );
    const started = Date.now();
    try {
      const response = await adapter.complete(
        { ...input.request, timeoutMs },
        {
          apiKey: connection.apiKey,
          baseUrl: safe.url.toString().replace(/\/+$/, ''),
          ...(connection.config.organization === undefined
            ? {}
            : { organization: connection.config.organization }),
          allowLoopback: connection.config.allowLoopback,
        },
      );
      await this.record(input, connection.key, 'succeeded', response, Date.now() - started);
      return response;
    } catch (error) {
      const normalized =
        error instanceof AIProviderError
          ? error
          : new AIProviderError('unknown', 'The provider request failed for an unknown reason.');
      await this.recordFailure(input, connection.key, normalized, Date.now() - started);
      throw normalized;
    }
  }

  /**
   * Controlled connectivity check. An administrator explicitly triggers it, the request is one tiny
   * turn, and the answer contains counts/status only — never the model's text or the credential.
   */
  async check(connectionKey: string, input: ProviderCheckInput): Promise<ProviderCheckResult> {
    const connection = await this.connections.resolve(connectionKey);
    const model = input.model ?? connection.models[0];
    if (model === undefined) throw new ValidationError(`Provider connection "${connectionKey}" allows no models.`);
    if (!connection.models.includes(model)) {
      throw new ValidationError(`Model "${model}" is not on the allowlist of "${connectionKey}".`, {
        allowedModels: connection.models,
      });
    }
    const started = Date.now();
    try {
      const response = await this.complete({
        connectionKey,
        dataClass: 'internal',
        request: {
          model,
          messages: [
            { role: 'system', content: 'You are a connectivity probe. Do not call tools.' },
            { role: 'user', content: input.prompt ?? 'Reply with the single word OK.' },
          ],
          maxOutputTokens: 16,
          timeoutMs: 15_000,
        },
      });
      return {
        ok: true,
        connectionKey,
        model,
        latencyMs: Date.now() - started,
        category: null,
        message: 'The provider answered successfully.',
        providerRequestId: response.providerRequestId,
        usage: response.usage,
      };
    } catch (error) {
      const normalized =
        error instanceof AIProviderError
          ? error
          : new AIProviderError('unknown', 'The provider check failed for an unknown reason.');
      return {
        ok: false,
        connectionKey,
        model,
        latencyMs: Date.now() - started,
        category: normalized.category,
        message: normalized.message,
        providerRequestId: null,
        usage: null,
      };
    }
  }

  private async record(
    input: GatewayCompleteInput,
    providerKey: string,
    outcome: 'succeeded' | 'failed',
    response: AIProviderResponse,
    latencyMs: number,
  ): Promise<void> {
    // Cost is estimated from the admin-maintained pricing snapshot, never from a hard-coded rate
    // (§12.1). No snapshot means an exact NULL, not an invented number.
    const estimate = await this.pricing.estimate(providerKey, response.model, response.usage);
    await this.insertLedger({
      input,
      providerKey,
      outcome,
      request: input.request,
      latencyMs,
      providerRequestId: response.providerRequestId,
      providerModel: response.model,
      usage: response.usage,
      finishReason: response.finishReason,
      toolCallCount: response.toolCalls.length,
      structured: response.structured !== null,
      errorCategory: null,
      costUsd: estimate.costUsd,
      costSource: estimate.source,
      costSnapshotId: estimate.snapshotId,
    });
  }

  private async recordFailure(
    input: GatewayCompleteInput,
    providerKey: string,
    error: AIProviderError,
    latencyMs: number,
  ): Promise<void> {
    await this.insertLedger({
      input,
      providerKey,
      outcome: 'failed',
      request: input.request,
      latencyMs,
      providerRequestId: null,
      providerModel: input.request.model,
      usage: null,
      finishReason: null,
      toolCallCount: 0,
      structured: false,
      errorCategory: error.category,
      costUsd: null,
      costSource: 'none',
      costSnapshotId: null,
    });
  }

  private async insertLedger(entry: {
    readonly input: GatewayCompleteInput;
    readonly providerKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly request: AIProviderRequest;
    readonly latencyMs: number;
    readonly providerRequestId: string | null;
    readonly providerModel: string;
    readonly usage: AIProviderUsage | null;
    readonly finishReason: string | null;
    readonly toolCallCount: number;
    readonly structured: boolean;
    readonly errorCategory: AIProviderErrorCategory | null;
    readonly costUsd: number | null;
    readonly costSource: 'snapshot' | 'none';
    readonly costSnapshotId: string | null;
  }): Promise<void> {
    try {
      await this.database.db
        .insertInto('ai_agent_provider_requests')
        .values({
          id: randomUUID(),
          run_id: entry.input.run?.runId ?? null,
          step: entry.input.run?.step ?? null,
          agent_id: entry.input.run?.agentId ?? null,
          agent_version: entry.input.run?.agentVersion ?? null,
          provider_key: entry.providerKey,
          model: entry.providerModel,
          request_hash: hashRequest(entry.request),
          request_meta: JSON.stringify({
            messageCount: entry.request.messages.length,
            toolCount: entry.request.tools?.length ?? 0,
            responseFormat: entry.request.responseFormat?.type ?? 'text',
            maxOutputTokens: entry.request.maxOutputTokens ?? null,
            temperature: entry.request.temperature ?? null,
            dataClass: entry.input.dataClass ?? 'internal',
          }),
          response_meta: JSON.stringify({
            finishReason: entry.finishReason,
            toolCallCount: entry.toolCallCount,
            structured: entry.structured,
            // Reports must distinguish an estimate from a provider-confirmed billing value (§12.1).
            // No registered adapter returns a billed amount in this release, so the label is
            // always 'estimate' or 'none' — never an unlabelled number.
            costLabel: entry.costSource === 'snapshot' ? 'estimate' : 'none',
            costSnapshotId: entry.costSnapshotId,
          }),
          input_tokens: entry.usage?.inputTokens ?? null,
          output_tokens: entry.usage?.outputTokens ?? null,
          cached_input_tokens: entry.usage?.cachedInputTokens ?? null,
          latency_ms: entry.latencyMs,
          outcome: entry.outcome,
          error_category: entry.errorCategory,
          estimated_cost_usd: entry.costUsd === null ? null : String(entry.costUsd),
          provider_request_id: entry.providerRequestId,
          created_at: new Date(),
        })
        .execute();
    } catch (error) {
      // Never include the request or the credential in the log. The run id is the correlation key.
      log.error(
        {
          error: error instanceof Error ? error.message : 'unknown ledger error',
          providerKey: entry.providerKey,
          runId: entry.input.run?.runId ?? null,
        },
        'ai provider request could not be recorded',
      );
    }
  }
}

function hashRequest(request: AIProviderRequest): string {
  const material = JSON.stringify({
    model: request.model,
    messages: request.messages,
    tools: request.tools ?? [],
    responseFormat: request.responseFormat ?? { type: 'text' },
    maxOutputTokens: request.maxOutputTokens ?? null,
    temperature: request.temperature ?? null,
  });
  return createHash('sha256').update(material).digest('hex');
}
