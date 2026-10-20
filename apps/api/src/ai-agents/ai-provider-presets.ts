/**
 * Provider presets — the popular endpoints an administrator picks from
 * (PLAN_Phase_19_AI_Agents.md §6.2, §6.3, §14.4; docs/modules/ai-agents/provider-configuration.md).
 *
 * The **kind** of a connection is a transport protocol, not a vendor name: the `openai-compatible`
 * adapter serves every provider that exposes `/chat/completions`, so OpenAI, Groq, DeepSeek,
 * Mistral, xAI, OpenRouter, Together, Fireworks, Perplexity, NVIDIA NIM and the self-hosted runtimes
 * all share one adapter and differ only by base URL.
 *
 * A preset is therefore *configuration*, not code: it carries the vendor's base URL, the models to
 * suggest and the credential header to use. Picking one fills the form; the administrator may
 * change any of it. The catalog is a curated list, not a registry — a preset never grants access,
 * and a connection is refused unless its `kind` is a registered adapter.
 *
 * Two protocols need their own adapter and therefore their own kind:
 *
 *  - `anthropic` — the Messages API (`/messages`, `x-api-key`), not `/chat/completions`;
 *  - `fake` — the deterministic non-production adapter used by tests.
 *
 * Gemini is reachable through Google's OpenAI-compatible surface, so it is a preset of the
 * `openai-compatible` adapter rather than a second transport.
 */

/** The credential header a vendor expects. */
export type AIProviderAuthHeader = 'bearer' | 'api-key';

export type AIProviderPresetGroup = 'hosted' | 'self-hosted' | 'other';

export interface AIProviderPreset {
  /** Stable identifier of the preset. Not a connection key; the administrator chooses that. */
  readonly key: string;
  /** Vendor name as the administrator knows it. */
  readonly label: string;
  /** The registered transport adapter this preset uses. */
  readonly kind: string;
  /** The vendor's API root. Empty for a preset that needs a host the administrator supplies. */
  readonly baseUrl: string;
  /** Models to suggest. The allowlist itself is always the administrator's decision. */
  readonly models: readonly string[];
  readonly group: AIProviderPresetGroup;
  /** The header the credential travels in. */
  readonly authHeader: AIProviderAuthHeader;
  /** Whether the endpoint needs a credential at all. */
  readonly requiresApiKey: boolean;
  /** A short operational note: a required query parameter, a TLS requirement, a quota caveat. */
  readonly note?: string;
}

export const AI_PROVIDER_PRESETS: readonly AIProviderPreset[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
    note: 'Uses the Messages API (/messages) with the x-api-key header.',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
    note: 'Reached through Google\'s OpenAI-compatible surface.',
  },
  {
    key: 'azure-openai',
    label: 'Azure OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT',
    models: ['gpt-4o-mini'],
    group: 'hosted',
    authHeader: 'api-key',
    requiresApiKey: true,
    note: 'Replace the resource and deployment in the base URL and append ?api-version=2024-10-21. The credential travels in the api-key header.',
  },
  {
    key: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3-mini'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
    note: 'One endpoint in front of many vendors; the model name carries the vendor prefix.',
  },
  {
    key: 'together',
    label: 'Together AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    kind: 'openai-compatible',
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
    note: 'A search-augmented endpoint: it answers with sources rather than a plain completion.',
  },
  {
    key: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'nebius',
    label: 'Nebius AI Studio',
    kind: 'openai-compatible',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'chutes',
    label: 'Chutes AI',
    kind: 'openai-compatible',
    baseUrl: 'https://llm.chutes.ai/v1',
    models: ['chutesai/mixtral-8x7b-instruct'],
    group: 'hosted',
    authHeader: 'bearer',
    requiresApiKey: true,
  },
  {
    key: 'litellm',
    label: 'LiteLLM proxy',
    kind: 'openai-compatible',
    baseUrl: 'https://YOUR-LITELLM-HOST/v1',
    models: ['gpt-4o-mini'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A gateway in front of several upstreams. The model name is whatever the upstream expects.',
  },
  {
    key: 'ollama',
    label: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'https://127.0.0.1:11434/v1',
    models: ['llama3.2', 'qwen2.5'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A local runtime. It must be reachable over https (behind a TLS terminator) and the connection must allow loopback.',
  },
  {
    key: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai-compatible',
    baseUrl: 'https://127.0.0.1:1234/v1',
    models: ['local-model'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A local runtime. https and the loopback option are required.',
  },
  {
    key: 'vllm',
    label: 'vLLM',
    kind: 'openai-compatible',
    baseUrl: 'https://127.0.0.1:8000/v1',
    models: ['local-model'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A local runtime. https and the loopback option are required.',
  },
  {
    key: 'llamacpp',
    label: 'llama.cpp server',
    kind: 'openai-compatible',
    baseUrl: 'https://127.0.0.1:8080/v1',
    models: ['local-model'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A local runtime. https and the loopback option are required.',
  },
  {
    key: 'localai',
    label: 'LocalAI',
    kind: 'openai-compatible',
    baseUrl: 'https://127.0.0.1:8080/v1',
    models: ['gpt-4'],
    group: 'self-hosted',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'A local runtime. https and the loopback option are required.',
  },
  {
    key: 'custom',
    label: 'Custom / OpenAI-compatible endpoint',
    kind: 'openai-compatible',
    baseUrl: '',
    models: [],
    group: 'other',
    authHeader: 'bearer',
    requiresApiKey: false,
    note: 'Any endpoint that speaks /chat/completions. The base URL is required.',
  },
];

/** The deterministic adapter used by tests. Registered outside production only. */
export const AI_PROVIDER_FAKE_PRESET: AIProviderPreset = {
  key: 'fake',
  label: 'Deterministic fake provider (test only)',
  kind: 'fake',
  baseUrl: 'https://fake.invalid/v1',
  models: ['fake-model'],
  group: 'other',
  authHeader: 'bearer',
  requiresApiKey: false,
  note: 'Never available in production; it fabricates answers.',
};

export function providerPresets(includeFake: boolean): readonly AIProviderPreset[] {
  return includeFake ? [...AI_PROVIDER_PRESETS, AI_PROVIDER_FAKE_PRESET] : AI_PROVIDER_PRESETS;
}

/** The preset that best matches an existing connection, so the form can show what it is. */
export function presetForConnection(kind: string, baseUrl: string): AIProviderPreset | undefined {
  const candidates = providerPresets(true);
  const normalized = baseUrl.replace(/\/+$/, '').toLowerCase();
  const exact = candidates.find(
    (preset) => preset.baseUrl !== '' && preset.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized,
  );
  if (exact !== undefined) return exact;
  // A protocol with an adapter of its own is identified by that adapter, not by its base URL.
  const byKind = candidates.find((preset) => preset.kind === kind && preset.kind !== 'openai-compatible');
  if (byKind !== undefined) return byKind;
  // Any other OpenAI-compatible endpoint is a custom one, whatever the administrator typed.
  return candidates.find((preset) => preset.key === 'custom');
}
