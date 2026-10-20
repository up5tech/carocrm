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
 * The Anthropic Messages API adapter.
 *
 * Anthropic does not speak `/chat/completions`: it exposes `/messages`, takes the credential in
 * the `x-api-key` header and expects a pinned `anthropic-version`. The system prompt is a
 * top-level field rather than a message, a tool schema is `input_schema` and a tool result is a
 * `tool_result` block inside a user turn. Every one of those differences is handled here so no
 * vendor shape crosses the adapter boundary.
 *
 * The rules of the platform apply unchanged: the credential is placed in one header and never
 * copied, redirects are refused, the response body has a hard byte ceiling, a timeout is
 * distinguished from an external cancellation, and a failure becomes a normalized `AIProviderError`
 * instead of the provider's raw body.
 *
 * Structured output is **not** supported: the Messages API has no `response_format`, so a run that
 * asks for a JSON schema is refused by the gateway rather than answered with prose.
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = '2023-06-01';
/** The API requires `max_tokens`; the agent's own ceiling is applied on top of it. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

@Injectable()
export class AnthropicProviderAdapter implements AIProviderAdapter {
  readonly key = 'anthropic';
  readonly label = 'Anthropic Claude messages';
  readonly capabilities = {
    structuredOutput: false,
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
      const response = await fetch(joinUrl(context.baseUrl, 'messages'), {
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
      return parseMessages(parseJson(body), request, started);
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

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Indirection keeps TypeScript from narrowing `signal.aborted` for the whole function. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

function buildHeaders(context: AIProviderContext): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (context.apiKey !== null && context.apiKey !== '') {
    headers['x-api-key'] = context.apiKey;
  }
  return headers;
}

function buildBody(request: AIProviderRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
    .trim();

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages: buildMessages(request),
  };
  if (system !== '') body['system'] = system;
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  return body;
}

/**
 * The turns the API accepts. A tool result is a `tool_result` block in a user turn; every other
 * role maps to its own content blocks.
 */
function buildMessages(request: AIProviderRequest): { role: 'user' | 'assistant'; content: unknown[] }[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? '',
            content: message.content,
          },
        ],
      });
      continue;
    }
    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: message.content }],
    });
  }
  return out;
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

function parseMessages(body: unknown, request: AIProviderRequest, started: number): AIProviderResponse {
  const root = asRecord(body);
  const blocks = root?.['content'];
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new AIProviderError('invalid_response', 'The provider response contained no content block.');
  }

  let text = '';
  const toolCalls: AIProviderToolCall[] = [];
  for (const entry of blocks) {
    const block = asRecord(entry);
    const type = block?.['type'];
    if (type === 'text') {
      const value = block?.['text'];
      if (typeof value === 'string') text += value;
      continue;
    }
    if (type === 'tool_use') {
      const name = block?.['name'];
      if (typeof name !== 'string' || name === '') {
        throw new AIProviderError('invalid_response', 'The provider returned a tool call without a name.');
      }
      const id = typeof block?.['id'] === 'string' ? block['id'] : `call_${String(toolCalls.length)}`;
      // The arguments arrive as an object here, not as a raw JSON string. They are re-serialised so
      // the tool-call validator owns the parsing and the schema check, exactly as with any adapter.
      const rawArguments = JSON.stringify(block?.['input'] ?? {});
      toolCalls.push({ id, name, rawArguments });
    }
  }

  const finishReason = toFinishReason(root?.['stop_reason'], toolCalls.length > 0);
  if (request.responseFormat?.type === 'json_schema') {
    throw new AIProviderError(
      'invalid_request',
      'The Anthropic adapter cannot serve a structured-output request; the Messages API has no response format.',
    );
  }

  const requestId = typeof root?.['id'] === 'string' ? root['id'] : null;
  const actualModel = typeof root?.['model'] === 'string' ? root['model'] : request.model;
  const usage = parseUsage(root?.['usage']);

  return {
    providerRequestId: requestId,
    model: actualModel,
    text,
    structured: null,
    toolCalls,
    finishReason,
    usage,
    latencyMs: Date.now() - started,
    safety: {
      finishReason,
      hasToolCalls: toolCalls.length > 0,
      stopReason: typeof root?.['stop_reason'] === 'string' ? root['stop_reason'] : null,
    },
  };
}

function parseUsage(value: unknown): AIProviderUsage {
  const usage = asRecord(value);
  const input = usage?.['input_tokens'];
  const output = usage?.['output_tokens'];
  const cached = usage?.['cache_read_input_tokens'];
  return {
    inputTokens: typeof input === 'number' && Number.isFinite(input) ? input : null,
    outputTokens: typeof output === 'number' && Number.isFinite(output) ? output : null,
    cachedInputTokens: typeof cached === 'number' && Number.isFinite(cached) ? cached : null,
  };
}

function toFinishReason(value: unknown, hasToolCalls: boolean): AIProviderFinishReason {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'refusal') return 'content_filter';
  return hasToolCalls ? 'tool_calls' : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
