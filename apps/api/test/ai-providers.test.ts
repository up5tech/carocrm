import { afterEach, describe, expect, it, vi } from 'vitest';

import { type BoundedJsonSchema, validateBoundedJsonSchema } from '../src/ai-agents/ai-agent-config.js';
import { AIProviderError, AIProviderRegistry } from '../src/ai-agents/ai-provider.js';
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL, AnthropicProviderAdapter } from '../src/ai-agents/ai-provider-anthropic.js';
import { describePresetCapabilities, describeProviderCapabilities } from '../src/ai-agents/ai-provider-capabilities.js';
import { FakeProviderAdapter } from '../src/ai-agents/ai-provider-fake.js';
import { AIProviderGateway } from '../src/ai-agents/ai-provider-gateway.service.js';
import { OpenAICompatibleProviderAdapter } from '../src/ai-agents/ai-provider-openai-compatible.js';
import { AI_PROVIDER_PRESETS, presetForConnection, providerPresets } from '../src/ai-agents/ai-provider-presets.js';

/**
 * Phase 19-AI.4 — provider contract tests (plans/PLAN_Phase_19_AI_Agents.md §6, §17.3, §18.1).
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

  it('records attachment ids without reading file bytes', async () => {
    const response = await new FakeProviderAdapter().complete(
      {
        ...request,
        attachments: [{ fileId: 'file_1', name: 'brief.png', mimeType: 'image/png', size: 12 }],
      },
      { apiKey: null, baseUrl: 'https://fake.invalid' },
    );
    expect(response.safety['attachmentIds']).toEqual(['file_1']);
    expect(response.text).toContain('[file_1]');
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

  it('serves structured output through a bounded extraction tool', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'msg_struct',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'ignored prose' },
          {
            type: 'tool_use',
            id: 'toolu_struct',
            name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL,
            input: { ok: true },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    };

    const response = await anthropic.complete(
      {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'return the result' }],
        responseFormat: { type: 'json_schema', name: 'result', schema },
      },
      anthropicContext,
    );

    expect(response.structured).toEqual({ ok: true });
    expect(response.text).toBe('{"ok":true}');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
    expect(response.safety['structuredOutputMode']).toBe('extraction_tool');
    expect(validateBoundedJsonSchema(response.structured, schema as BoundedJsonSchema)).toEqual([]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['system']).toContain(ANTHROPIC_STRUCTURED_OUTPUT_TOOL);
    expect(body['tools']).toEqual([
      {
        name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL,
        description: 'Return the final answer as an instance of the declared JSON schema.',
        input_schema: schema,
      },
    ]);
  });

  it('passes a domain tool turn through without inventing a structured answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'x' } }],
          stop_reason: 'tool_use',
        }),
      ),
    );
    const response = await anthropic.complete(
      {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'search then answer' }],
        tools: [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
        responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
      },
      anthropicContext,
    );
    expect(response.structured).toBeNull();
    expect(response.toolCalls.map((call) => call.name)).toEqual(['search']);
    expect(response.finishReason).toBe('tool_calls');
  });

  it('fails closed when the model returns prose instead of the extraction call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }] })));
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
    expect((error as AIProviderError).category).toBe('invalid_response');
  });

  it('refuses a reserved extraction-tool name in the agent tool grant', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await anthropic
      .complete(
        {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hello' }],
          tools: [
            {
              name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL,
              description: 'reserved',
              parameters: { type: 'object' },
            },
          ],
          responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
        },
        anthropicContext,
      )
      .catch((caught: unknown) => caught);
    expect((error as AIProviderError).category).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('provider capability table (25.3)', () => {
  const registry = new AIProviderRegistry();
  registry.register(new OpenAICompatibleProviderAdapter());
  registry.register(new AnthropicProviderAdapter());
  registry.register(new FakeProviderAdapter());

  it('derives adapter rows from the registered contract objects', () => {
    const rows = describeProviderCapabilities(registry);
    expect(rows.map((row) => row.key)).toEqual(['anthropic', 'fake', 'openai-compatible']);
    for (const row of rows) {
      expect(Object.keys(row.capabilities)).toEqual([
        'chat',
        'structuredOutput',
        'structuredOutputMode',
        'toolCalling',
        'streaming',
        'contextWindowTokens',
        'imageInput',
        'nativeWebSearch',
        'reportsUsage',
      ]);
      expect(row.capabilities.chat).toBe(true);
      expect(row.capabilities.structuredOutput).toBe(true);
      expect(row.capabilities.imageInput).toBe(row.key === 'fake');
      expect(row.capabilities.nativeWebSearch).toBe(false);
      expect(row.capabilities.contextWindowTokens).toBeNull();
    }
    expect(rows.find((row) => row.key === 'anthropic')?.capabilities.structuredOutputMode).toBe(
      'extraction_tool',
    );
    expect(rows.find((row) => row.key === 'openai-compatible')?.capabilities.structuredOutputMode).toBe(
      'native',
    );
  });

  it('lets presets inherit only their transport capabilities and labels verification honestly', () => {
    const rows = describePresetCapabilities(registry, true);
    expect(rows.length).toBe(providerPresets(true).length);
    for (const row of rows) {
      if (row.capabilities === null) {
        expect(row.verification).toBe('not-verified');
        continue;
      }
      expect(row.capabilities).toEqual(registry.get(row.kind).capabilities);
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('gemini')?.verification).toBe('local-compatible-seam');
    expect(byKey.get('openai')?.verification).toBe('adapter-contract');
    expect(byKey.get('anthropic')?.verification).toBe('adapter-contract');
    expect(byKey.get('mistral')?.verification).toBe('not-verified');
    expect(byKey.get('ollama')?.verification).toBe('not-verified');
  });

  it('verifies the non-OpenAI Gemini preset through the local-compatible seam', async () => {
    const preset = AI_PROVIDER_PRESETS.find((entry) => entry.key === 'gemini');
    expect(preset?.kind).toBe('openai-compatible');
    expect(preset?.baseUrl).toContain('/openai');

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'gemini_local_1',
        model: 'gemini-2.5-flash',
        choices: [{ finish_reason: 'stop', message: { content: '{"answer":"ok"}' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await new OpenAICompatibleProviderAdapter().complete(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hello' }],
        responseFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
      },
      { apiKey: 'test-key-never-logged', baseUrl: 'https://gemini-local.example/v1beta/openai' },
    );
    expect(response.structured).toEqual({ answer: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gemini-local.example/v1beta/openai/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gemini-2.5-flash');
    expect(body['response_format']).toMatchObject({ type: 'json_schema' });
    expect((init.headers as Record<string, string>).authorization).toContain('test-key-never-logged');
  });

  it('returns an equivalent validated structured answer from every registered adapter', async () => {
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    } as BoundedJsonSchema;
    const candidates = [
      new OpenAICompatibleProviderAdapter(),
      new AnthropicProviderAdapter(),
      new FakeProviderAdapter(),
    ];

    for (const candidate of candidates) {
      if (candidate.key === 'openai-compatible') {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () =>
            jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }),
          ),
        );
      } else if (candidate.key === 'anthropic') {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () =>
            jsonResponse({
              content: [
                { type: 'tool_use', id: 'toolu_struct', name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL, input: { ok: true } },
              ],
              stop_reason: 'tool_use',
            }),
          ),
        );
      } else {
        vi.unstubAllGlobals();
      }

      const response = await candidate.complete(
        {
          model: 'result-model',
          messages: [{ role: 'user', content: 'return the result' }],
          responseFormat: { type: 'json_schema', name: 'result', schema: schema as unknown as Record<string, unknown> },
        },
        candidate.key === 'fake'
          ? { apiKey: null, baseUrl: 'https://fake.invalid' }
          : { apiKey: 'test-key-never-logged', baseUrl: 'https://provider.example/v1' },
      );
      expect(response.structured).toEqual({ ok: true });
      expect(validateBoundedJsonSchema(response.structured, schema)).toEqual([]);
    }
  });
});

describe('provider gateway attachment capability (25.7)', () => {
  it('refuses attachments on an adapter without image input, before any network call', async () => {
    const gateway = new AIProviderGateway(
      {
        resolve: async () => ({
          key: 'openai',
          kind: 'openai-compatible',
          label: 'OpenAI compatible',
          baseUrl: 'https://provider.example/v1',
          models: ['result-model'],
          dataClasses: ['internal'],
          config: {},
        }),
        adapterFor: () => new OpenAICompatibleProviderAdapter(),
      } as never,
      {
        settings: async () => ({
          dataPolicy: { allowedExternalDataClasses: ['internal'] },
          limits: { maxElapsedSeconds: 5 },
        }),
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      gateway.complete({
        connectionKey: 'openai',
        request: {
          model: 'result-model',
          messages: [{ role: 'user', content: 'Summarize the file' }],
          attachments: [{ fileId: 'file_1', name: 'brief.png', mimeType: 'image/png', size: 20 }],
        },
      }),
    ).rejects.toThrow(/does not support attachment input/);
  });
});
