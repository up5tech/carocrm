import { Injectable } from '@nestjs/common';

import {
  type AIProviderAdapter,
  type AIProviderContext,
  AIProviderError,
  type AIProviderFinishReason,
  type AIProviderRequest,
  type AIProviderResponse,
  type AIProviderToolCall,
  type AIProviderUsage,
  categorizeHttpStatus,
  providerErrorMessage,
} from './ai-provider.js';

/**
 * Phase 19-AI.4 — the OpenAI-compatible chat-completions adapter
 * (PLAN_Phase_19_AI_Agents.md §6.1, §6.4, §20 `19-AI.4`).
 *
 * One adapter serves every provider that exposes the `/chat/completions` contract. It uses Node's
 * `fetch` — no vendor SDK — so provider types never enter the domain:
 *
 *  - the credential is placed in the request header and never copied anywhere else;
 *  - redirects are refused (`redirect: 'error'`) so an approved host cannot bounce the call to an
 *    internal address;
 *  - the response body is read with a hard byte ceiling;
 *  - timeouts and external cancellation are distinguished;
 *  - failures become `AIProviderError` with a safe category, never the provider's raw body.
 *
 * Tool-call arguments are returned as the raw JSON string. Parsing and schema validation belong to
 * the tool-call pipeline (AI.9), so an adapter cannot execute anything.
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;

@Injectable()
export class OpenAICompatibleProviderAdapter implements AIProviderAdapter {
  readonly key = 'openai-compatible';
  readonly label = 'OpenAI-compatible chat completions';
  readonly capabilities = {
    structuredOutput: true,
    toolCalling: true,
    streaming: false,
    reportsUsage: true,
  } as const;

  async complete(request: AIProviderRequest, context: AIProviderContext): Promise<AIProviderResponse> {
    if (isAborted(request.signal)) {
      throw new AIProviderError('canceled', providerErrorMessage('canceled', null));
    }
    const started = Date.now();
    const timeoutMs = clampTimeout(request.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(joinUrl(context.baseUrl, 'chat/completions'), {
        method: 'POST',
        redirect: 'error',
        headers: buildHeaders(context),
        body: JSON.stringify(buildBody(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const category = categorizeHttpStatus(response.status);
        throw new AIProviderError(category, providerErrorMessage(category, response.status), {
          status: response.status,
        });
      }
      const body = await readBodyLimited(response);
      const parsed = parseJson(body);
      return parseCompletion(parsed, request, started);
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (timedOut) throw new AIProviderError('timeout', providerErrorMessage('timeout', null));
      if (isAborted(request.signal)) {
        throw new AIProviderError('canceled', providerErrorMessage('canceled', null));
      }
      throw new AIProviderError('provider_unavailable', providerErrorMessage('provider_unavailable', null));
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** Indirection keeps TypeScript from narrowing `signal.aborted` for the whole function. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

function buildHeaders(context: AIProviderContext): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (context.apiKey !== null && context.apiKey !== '') {
    headers.authorization = `Bearer ${context.apiKey}`;
  }
  if (context.organization !== undefined && context.organization !== '') {
    headers['openai-organization'] = context.organization;
  }
  return headers;
}

function buildBody(request: AIProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.name === undefined ? {} : { name: message.name }),
    })),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.responseFormat?.type === 'json_schema') {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: request.responseFormat.name,
        schema: request.responseFormat.schema,
        strict: true,
      },
    };
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  return body;
}

async function readBodyLimited(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AIProviderError('invalid_response', 'The provider response exceeded the gateway size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AIProviderError('invalid_response', providerErrorMessage('invalid_response', null));
  }
}

function parseCompletion(body: unknown, request: AIProviderRequest, started: number): AIProviderResponse {
  const root = asRecord(body);
  const choices = root?.['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AIProviderError('invalid_response', 'The provider response contained no completion choice.');
  }
  const choice = asRecord(choices[0]);
  const message = choice === undefined ? undefined : asRecord(choice['message']);
  if (message === undefined) {
    throw new AIProviderError('invalid_response', 'The provider response contained no message.');
  }
  const content = typeof message['content'] === 'string' ? message['content'] : '';
  const toolCalls = parseToolCalls(message['tool_calls']);
  const finishReason = toFinishReason(choice?.['finish_reason'], toolCalls.length > 0);

  let structured: unknown | null = null;
  if (request.responseFormat?.type === 'json_schema') {
    if (content.trim() === '') {
      throw new AIProviderError('invalid_response', 'The provider returned no structured content.');
    }
    structured = parseJson(content);
  }

  const requestId = typeof root?.['id'] === 'string' ? root['id'] : null;
  const actualModel = typeof root?.['model'] === 'string' ? root['model'] : request.model;
  const usage = parseUsage(root?.['usage']);
  const systemFingerprint = typeof root?.['system_fingerprint'] === 'string' ? root['system_fingerprint'] : null;

  return {
    providerRequestId: requestId,
    model: actualModel,
    text: content,
    structured,
    toolCalls,
    finishReason,
    usage,
    latencyMs: Date.now() - started,
    safety: {
      finishReason,
      hasToolCalls: toolCalls.length > 0,
      ...(systemFingerprint === null ? {} : { systemFingerprint }),
    },
  };
}

function parseToolCalls(value: unknown): AIProviderToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AIProviderError('invalid_response', 'The provider returned malformed tool calls.');
  }
  const out: AIProviderToolCall[] = [];
  for (const [index, entry] of value.entries()) {
    const call = asRecord(entry);
    const fn = call === undefined ? undefined : asRecord(call['function']);
    if (fn === undefined) {
      throw new AIProviderError('invalid_response', 'The provider returned a tool call without a function.');
    }
    const name = fn['name'];
    if (typeof name !== 'string' || name === '') {
      throw new AIProviderError('invalid_response', 'The provider returned a tool call without a name.');
    }
    const rawArguments = typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}';
    const id = typeof call?.['id'] === 'string' && call['id'] !== '' ? call['id'] : `call_${String(index)}`;
    out.push({ id, name, rawArguments });
  }
  return out;
}

function parseUsage(value: unknown): AIProviderUsage {
  const usage = asRecord(value);
  const prompt = usage?.['prompt_tokens'];
  const completion = usage?.['completion_tokens'];
  const details = usage === undefined ? undefined : asRecord(usage['prompt_tokens_details']);
  const cached = details?.['cached_tokens'];
  return {
    inputTokens: typeof prompt === 'number' && Number.isFinite(prompt) ? prompt : null,
    outputTokens: typeof completion === 'number' && Number.isFinite(completion) ? completion : null,
    cachedInputTokens: typeof cached === 'number' && Number.isFinite(cached) ? cached : null,
  };
}

function toFinishReason(value: unknown, hasToolCalls: boolean): AIProviderFinishReason {
  if (value === 'stop') return 'stop';
  if (value === 'length') return 'length';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_calls';
  if (value === 'content_filter') return 'content_filter';
  return hasToolCalls ? 'tool_calls' : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
