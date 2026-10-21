import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIProviderError, AIProviderRegistry } from '../src/ai-agents/ai-provider.js';
import { AnthropicProviderAdapter } from '../src/ai-agents/ai-provider-anthropic.js';
import { FakeProviderAdapter } from '../src/ai-agents/ai-provider-fake.js';
import { OpenAICompatibleProviderAdapter } from '../src/ai-agents/ai-provider-openai-compatible.js';
import { AI_PROVIDER_PRESETS, presetForConnection, providerPresets } from '../src/ai-agents/ai-provider-presets.js';
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
  it('allows http and https and rejects credentials and cloud metadata', async () => {
    await expect(assertSafeProviderBaseUrl('http://example.com', { allowLoopback: false })).resolves.toBeDefined();
    await expect(assertSafeProviderBaseUrl('https://example.com', { allowLoopback: false })).resolves.toBeDefined();
    await expect(assertSafeProviderBaseUrl('https://user:pass@example.com', { allowLoopback: false })).rejects.toThrow(
      /credentials/,
    );    await expect(
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

describe('Anthropic adapter', () => {
  const anthropic = new AnthropicProviderAdapter();
  const anthropicContext = { apiKey: 'test-key-never-logged', baseUrl: 'https://api.anthropic.com/v1' };

  it('sends the Messages API shape and normalizes text, usage and a tool call', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await anthropic.complete(
      {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
        tools: [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
      },
      anthropicContext,
    );

    expect(response.text).toBe('working');
    expect(response.model).toBe('claude-sonnet-4-5');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls).toEqual([{ id: 'toolu_1', name: 'search', rawArguments: '{"query":"x"}' }]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 3 });

    // The credential travels in the Anthropic header and the system prompt is a top-level field.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key-never-logged');
    expect(headers.authorization).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['system']).toBe('be brief');
    expect(body['max_tokens']).toBe(4096);
    expect(body['tools']).toEqual([
      { name: 'search', description: 'search', input_schema: { type: 'object' } },
    ]);
  });

  it('refuses a structured-output request instead of answering with prose', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: '{}' }] })));
    const error = await anthropic
      .complete(
        {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hello' }],
          responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
        },
        anthropicContext,
      )
      .catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('invalid_request');
  });

  it('maps HTTP 401 to a non-retryable auth error without reading the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, 401)));
    const error = await anthropic
      .complete(request, anthropicContext)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).category).toBe('auth');
    expect((error as AIProviderError).retryable).toBe(false);
    expect((error as AIProviderError).message).not.toContain('test-key-never-logged');
  });
});

describe('OpenAI-compatible credential header and query string', () => {
  it('sends the credential in the api-key header when the connection asks for it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await adapter.complete(request, {
      apiKey: 'azure-secret-never-logged',
      baseUrl: 'https://resource.openai.azure.com/openai/deployments/dep?api-version=2024-10-21',
      authHeader: 'api-key',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The path segment is appended before the query, which belongs to the endpoint.
    expect(url).toBe(
      'https://resource.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('azure-secret-never-logged');
    expect(headers.authorization).toBeUndefined();
  });
});

describe('provider presets', () => {
  it('offers the popular hosted providers and the local runtimes', () => {
    const keys = AI_PROVIDER_PRESETS.map((preset) => preset.key);
    for (const expected of ['openai', 'anthropic', 'gemini', 'azure-openai', 'groq', 'deepseek', 'ollama', 'custom']) {
      expect(keys).toContain(expected);
    }
    // The fake adapter is offered outside production only.
    expect(providerPresets(true).map((preset) => preset.key)).toContain('fake');
    expect(providerPresets(false).map((preset) => preset.key)).not.toContain('fake');
  });

  it('names a transport that is actually registered', () => {
    const registered = new Set(['openai-compatible', 'anthropic', 'fake']);
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(registered.has(preset.kind)).toBe(true);
    }
  });

  it('matches an existing connection back to the preset it came from', () => {
    expect(presetForConnection('openai-compatible', 'https://api.openai.com/v1')?.key).toBe('openai');
    expect(presetForConnection('anthropic', 'https://api.anthropic.com/v1')?.key).toBe('anthropic');
    // An unknown endpoint falls back to the custom entry rather than guessing.
    expect(presetForConnection('openai-compatible', 'https://internal.example/v1')?.key).toBe('custom');
  });
});
