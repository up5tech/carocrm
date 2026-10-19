import { Injectable } from '@nestjs/common';

import {
  type AIProviderAdapter,
  type AIProviderContext,
  AIProviderError,
  type AIProviderErrorCategory,
  type AIProviderRequest,
  type AIProviderResponse,
  providerErrorMessage,
} from './ai-provider.js';

/**
 * Phase 19-AI.4 — deterministic fake adapter
 * (PLAN_Phase_19_AI_Agents.md §17.3 "fake provider adapters", §18.2 "use fake providers").
 *
 * Routine tests must never call a billable API. This adapter produces deterministic responses and
 * can simulate failures from the prompt itself, so orchestration, retry and redaction tests stay
 * offline:
 *
 *  - `__FAKE_ERROR__:<category>` throws that normalized error;
 *  - `__FAKE_DELAY__:<ms>` waits (respecting cancellation and the timeout);
 *  - with a JSON-schema response format it returns `{"ok":true}`;
 *  - with tools it returns no tool call unless the prompt names `__FAKE_TOOL__:<tool>`, in which
 *    case it proposes that tool. Arguments default to `{"query":"fake"}` and can be supplied after
 *    `__FAKE_TOOL_ARGS__:` on the same line as JSON, which lets a test exercise a real registry tool
 *    without inventing a second provider.
 *
 * The registry registers this adapter **only outside production** (`AIAgentsModule` factory), so an
 * administrator cannot configure a fake provider on a live deployment.
 */

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'auth',
  'rate_limit',
  'timeout',
  'canceled',
  'invalid_request',
  'provider_unavailable',
  'invalid_response',
  'content_filter',
  'unknown',
]);

@Injectable()
export class FakeProviderAdapter implements AIProviderAdapter {
  readonly key = 'fake';
  readonly label = 'Deterministic fake provider (non-production)';
  readonly capabilities = {
    structuredOutput: true,
    toolCalling: true,
    streaming: false,
    reportsUsage: true,
  } as const;

  async complete(request: AIProviderRequest, _context: AIProviderContext): Promise<AIProviderResponse> {
    const started = Date.now();
    const prompt = lastUserContent(request);
    const error = extract(prompt, '__FAKE_ERROR__:');
    if (error !== null) {
      const category = ERROR_CATEGORIES.has(error) ? (error as AIProviderErrorCategory) : 'unknown';
      throw new AIProviderError(category, providerErrorMessage(category, null));
    }

    const delay = Number(extract(prompt, '__FAKE_DELAY__:') ?? '0');
    if (Number.isFinite(delay) && delay > 0) {
      await sleep(Math.min(delay, 10_000), request.signal);
    }
    if (request.signal?.aborted === true) {
      throw new AIProviderError('canceled', providerErrorMessage('canceled', null));
    }

    const toolName = extract(prompt, '__FAKE_TOOL__:');
    const toolCalls =
      toolName === null
        ? []
        : [
            {
              id: 'fake_call_1',
              name: toolName,
              rawArguments: extractJsonAfter(prompt, '__FAKE_TOOL_ARGS__:') ?? '{"query":"fake"}',
            },
          ];

    let structured: unknown | null = null;
    if (request.responseFormat?.type === 'json_schema') structured = { ok: true };

    const text =
      request.responseFormat?.type === 'json_schema'
        ? JSON.stringify(structured)
        : `Fake response to: ${prompt.slice(0, 200)}`;

    return {
      providerRequestId: `fake-${String(Date.now())}`,
      model: request.model,
      text,
      structured,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
        outputTokens: Math.max(1, Math.ceil(text.length / 4)),
        cachedInputTokens: 0,
      },
      latencyMs: Date.now() - started,
      safety: { fake: true },
    };
  }
}

function extract(prompt: string, marker: string): string | null {
  const index = prompt.indexOf(marker);
  if (index < 0) return null;
  const rest = prompt.slice(index + marker.length);
  const match = rest.match(/^[A-Za-z0-9_.-]+/);
  return match?.[0] ?? null;
}

/** Test-only convenience: `__FAKE_TOOL_ARGS__:{"entity":"Account"}` becomes the raw arguments. */
function extractJsonAfter(prompt: string, marker: string): string | null {
  const index = prompt.indexOf(marker);
  if (index < 0) return null;
  const rest = prompt.slice(index + marker.length).trimStart();
  if (!rest.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let position = 0; position < rest.length; position += 1) {
    const char = rest[position];
    if (char === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return rest.slice(0, position + 1);
    }
  }
  return null;
}

function lastUserContent(request: AIProviderRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AIProviderError('canceled', providerErrorMessage('canceled', null)));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted === true) {
      clearTimeout(timer);
      reject(new AIProviderError('canceled', providerErrorMessage('canceled', null)));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
