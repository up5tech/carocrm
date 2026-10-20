/**
 * Phase 19-AI.4 — vendor-neutral provider contract
 * (PLAN_Phase_19_AI_Agents.md §6.1, §20 `19-AI.4`).
 *
 * Domain code depends on this file only. No vendor SDK type, HTTP response shape or provider error
 * crosses this boundary: an adapter normalizes text, structured output, tool calls, usage, finish
 * metadata and failures. That is what lets the run engine be tested with a fake adapter and lets a
 * deployment change providers without touching business logic.
 */

export type AIProviderRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIProviderMessage {
  readonly role: AIProviderRole;
  readonly content: string;
  /** Present on a `tool` message; identifies the call whose result this is. */
  readonly toolCallId?: string | undefined;
  readonly name?: string | undefined;
}

export interface AIProviderToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object for the arguments. The tool registry owns the authoritative schema. */
  readonly parameters: Record<string, unknown>;
}

export type AIProviderResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_schema'; readonly name: string; readonly schema: Record<string, unknown> };

export interface AIProviderRequest {
  readonly model: string;
  readonly messages: readonly AIProviderMessage[];
  readonly tools?: readonly AIProviderToolSpec[] | undefined;
  readonly responseFormat?: AIProviderResponseFormat | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  /** Adapter-enforced timeout. The gateway also applies its own ceiling. */
  readonly timeoutMs?: number | undefined;
  /** External cancellation (run cancel, HTTP disconnect, worker stop). */
  readonly signal?: AbortSignal | undefined;
  /** Non-sensitive labels only; never a prompt, a record value or a credential. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface AIProviderContext {
  /** Decrypted in memory only for this call. Never logged, never persisted, never returned. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly organization?: string | undefined;
  /** Administrator-approved self-hosted endpoint. Only meaningful in non-production. */
  readonly allowLoopback?: boolean | undefined;
  /**
   * The header the credential travels in. `bearer` is the default (`Authorization: Bearer …`);
   * `api-key` is the header Azure OpenAI expects. The adapter decides, not the connection row.
   */
  readonly authHeader?: AIProviderAuthHeader | undefined;
}

/** How a provider expects its credential. */
export type AIProviderAuthHeader = 'bearer' | 'api-key';

export interface AIProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export type AIProviderFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'unknown';

export interface AIProviderToolCall {
  readonly id: string;
  readonly name: string;
  /**
   * The raw JSON string the model produced. It is **not** parsed here: the tool-call validator owns
   * schema validation and bounded repair, so an adapter can never execute an argument by accident.
   */
  readonly rawArguments: string;
}

export interface AIProviderResponse {
  readonly providerRequestId: string | null;
  readonly model: string;
  readonly text: string;
  /** Parsed JSON when a `json_schema` format was requested and the content parsed; otherwise null. */
  readonly structured: unknown | null;
  readonly toolCalls: readonly AIProviderToolCall[];
  readonly finishReason: AIProviderFinishReason;
  readonly usage: AIProviderUsage;
  readonly latencyMs: number;
  /** Redacted provider safety/finish metadata; never raw headers or the request body. */
  readonly safety: Readonly<Record<string, unknown>>;
}

export interface AIProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly reportsUsage: boolean;
}

export interface AIProviderAdapter {
  readonly key: string;
  readonly label: string;
  readonly capabilities: AIProviderCapabilities;
  complete(request: AIProviderRequest, context: AIProviderContext): Promise<AIProviderResponse>;
}

export type AIProviderErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'canceled'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'content_filter'
  | 'unknown_provider'
  | 'unknown';

const RETRYABLE_CATEGORIES: ReadonlySet<AIProviderErrorCategory> = new Set([
  'rate_limit',
  'timeout',
  'provider_unavailable',
]);

/**
 * The only error type crossing the adapter boundary. The message is safe to return to an
 * administrator: it names the category and the provider status, never the credential, the request
 * body or the raw provider response.
 */
export class AIProviderError extends Error {
  readonly category: AIProviderErrorCategory;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    category: AIProviderErrorCategory,
    message: string,
    options: { readonly retryable?: boolean | undefined; readonly status?: number | null | undefined } = {},
  ) {
    super(message);
    this.name = 'AIProviderError';
    this.category = category;
    this.retryable = options.retryable ?? RETRYABLE_CATEGORIES.has(category);
    this.status = options.status ?? null;
  }
}

/** Map a provider HTTP status to a category without reading the body. */
export function categorizeHttpStatus(status: number): AIProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

export function providerErrorMessage(category: AIProviderErrorCategory, status: number | null): string {
  const suffix = status === null ? '' : ` (HTTP ${String(status)})`;
  switch (category) {
    case 'auth':
      return `The provider rejected the credential${suffix}. Rotate the connection's API key.`;
    case 'rate_limit':
      return `The provider rate-limited the request${suffix}. Retry with backoff.`;
    case 'timeout':
      return `The provider request timed out${suffix}.`;
    case 'canceled':
      return 'The provider request was canceled.';
    case 'invalid_request':
      return `The provider rejected the request${suffix}. Check the model name and request shape.`;
    case 'provider_unavailable':
      return `The provider is unavailable${suffix}. Retry later.`;
    case 'invalid_response':
      return 'The provider returned a response this gateway could not interpret.';
    case 'content_filter':
      return 'The provider blocked the response under its content policy.';
    case 'unknown_provider':
      return 'No provider adapter is registered for this connection kind.';
    case 'unknown':
      return `The provider request failed${suffix}.`;
  }
}

/**
 * Adapter registry. Registration is code-only: no table, API or model output can add an adapter at
 * runtime. The key is the connection `kind`, not the vendor name, so one OpenAI-compatible adapter
 * serves several approved providers without duplicating transport code.
 */
export class AIProviderRegistry {
  private readonly adapters = new Map<string, AIProviderAdapter>();

  register(adapter: AIProviderAdapter): void {
    if (this.adapters.has(adapter.key)) {
      throw new Error(`AI provider adapter "${adapter.key}" is already registered.`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  has(key: string): boolean {
    return this.adapters.has(key);
  }

  get(key: string): AIProviderAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new AIProviderError('unknown_provider', providerErrorMessage('unknown_provider', null));
    }
    return adapter;
  }

  keys(): string[] {
    return [...this.adapters.keys()].sort();
  }

  list(): readonly AIProviderAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.key.localeCompare(right.key));
  }
}
