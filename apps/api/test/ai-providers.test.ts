import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIProviderError, AIProviderRegistry } from '../src/ai-agents/ai-provider.js';
import { FakeProviderAdapter } from '../src/ai-agents/ai-provider-fake.js';
import { OpenAICompatibleProviderAdapter } from '../src/ai-agents/ai-provider-openai-compatible.js';
import { assertSafeProviderBaseUrl, isPrivateAddress } from '../src/ai-agents/ai-provider-url.js';

/**
 * Phase 19-AI.4 — provider contract tests (PLAN_Phase_19_AI_Agents.md §6, §17.3, §18.1).
 *
 * These are pure: no database, no network, no billable call. `fetch` is stubbed for the adapter
 * tests, and the fake adapter covers the deterministic orchestration path used by later sub-phases.
 */

const adapter = new OpenAICompatibleProviderAdapter();
const context = { apiKey: 'test-key-never-logged', baseUrl: 'https://provider.example/v1' };

const request = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hello' }],
  maxOutputTokens: 64,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI-compatible adapter', () => {
  it('normalizes text, usage, finish reason and raw tool-call arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'req_1',
          model: 'test-model-2026',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'working',
                tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"query":"x"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
          system_fingerprint: 'fp_1',
        }),
      ),
    );

    const response = await adapter.complete(request, context);
    expect(response.text).toBe('working');
    expect(response.model).toBe('test-model-2026');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'search', rawArguments: '{"query":"x"}' }]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 3 });
    expect(response.safety['hasToolCalls']).toBe(true);
  });

  it('returns parsed structured output when a JSON schema is requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })),
    );
    const response = await adapter.complete(
      { ...request, responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } } },
      context,
    );
    expect(response.structured).toEqual({ ok: true });
  });

  it('maps HTTP 401 to a non-retryable auth error without reading the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, 401)));
    const error = await adapter.complete(request, context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).category).toBe('auth');
    expect((error as AIProviderError).retryable).toBe(false);
    expect((error as AIProviderError).message).not.toContain('test-key-never-logged');
  });

  it('maps HTTP 429 to a retryable rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 429)));
    const error = await adapter.complete(request, context).catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('rate_limit');
    expect((error as AIProviderError).retryable).toBe(true);
  });

  it('rejects a response that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })));
    const error = await adapter.complete(request, context).catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('invalid_response');
  });

  it('distinguishes a timeout from external cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: unknown, init: unknown) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit).signal;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const error = await adapter
      .complete({ ...request, timeoutMs: 1_000 }, context)
      .catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('timeout');
  });

  it('honours an already-aborted external signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await adapter
      .complete({ ...request, signal: controller.signal }, context)
      .catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('canceled');
  });
});

describe('fake adapter', () => {
  it('returns deterministic structured output', async () => {
    const response = await new FakeProviderAdapter().complete(
      {
        ...request,
        responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
      },
      { apiKey: null, baseUrl: 'https://fake.invalid' },
    );
    expect(response.structured).toEqual({ ok: true });
    expect(response.finishReason).toBe('stop');
  });

  it('simulates a normalized provider error from the prompt', async () => {
    const error = await new FakeProviderAdapter()
      .complete({ ...request, messages: [{ role: 'user', content: '__FAKE_ERROR__:rate_limit' }] }, { apiKey: null, baseUrl: 'https://fake.invalid' })
      .catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('rate_limit');
  });

  it('proposes a tool call only when the prompt asks for one', async () => {
    const response = await new FakeProviderAdapter().complete(
      { ...request, messages: [{ role: 'user', content: '__FAKE_TOOL__:search' }] },
      { apiKey: null, baseUrl: 'https://fake.invalid' },
    );
    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls[0]?.name).toBe('search');
  });
});

describe('provider URL safety', () => {
  it('rejects plain http, credentials and cloud metadata', async () => {
    await expect(assertSafeProviderBaseUrl('http://example.com', { allowLoopback: false })).rejects.toThrow(/https/);
    await expect(assertSafeProviderBaseUrl('https://user:pass@example.com', { allowLoopback: false })).rejects.toThrow(
      /credentials/,
    );
    await expect(
      assertSafeProviderBaseUrl('https://169.254.169.254/latest', { allowLoopback: false }),
    ).rejects.toThrow(/metadata/);
  });

  it('rejects loopback unless the connection explicitly allows it', async () => {
    await expect(assertSafeProviderBaseUrl('https://127.0.0.1', { allowLoopback: false })).rejects.toThrow(/loopback/);
    const allowed = await assertSafeProviderBaseUrl('https://127.0.0.1:11434', { allowLoopback: true });
    expect(allowed.loopback).toBe(true);
  });

  it('classifies private and public addresses', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('provider registry', () => {
  it('rejects duplicate adapters and unknown keys', () => {
    const registry = new AIProviderRegistry();
    registry.register(new FakeProviderAdapter());
    expect(() => registry.register(new FakeProviderAdapter())).toThrow(/already registered/);
    const error = (() => {
      try {
        registry.get('missing');
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as AIProviderError).category).toBe('unknown_provider');
  });
});
