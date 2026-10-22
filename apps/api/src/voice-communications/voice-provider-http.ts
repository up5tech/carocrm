import { categorizeHttpStatus, VoiceProviderError } from "./voice-provider.js";

/**
 * The outbound HTTP boundary for the production adapters.
 *
 * A provider request must never hold a worker slot forever, must not follow a redirect to an
 * unexpected destination, and must surface a categorized failure instead of a raw `fetch` error
 * (`PLAN_Phase_19_Voice_Communications.md` §11.2, §13.2). Credentials and request bodies are never
 * logged here.
 */
export const VOICE_PROVIDER_TIMEOUT_MS = 15_000;
export const VOICE_PROVIDER_MAX_RESPONSE_BYTES = 1_000_000;

export interface VoiceProviderRequestInput {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly service: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** A self-hosted PBX commonly exposes ARI over plain HTTP; a public SaaS endpoint must use TLS. */
  readonly allowHttp?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface VoiceProviderResponse {
  readonly status: number;
  readonly data: Record<string, unknown> | null;
}

export async function requestVoiceProviderJson(input: VoiceProviderRequestInput): Promise<VoiceProviderResponse> {
  let url: URL;
  try {
    url = assertHttpUrl(input.url, { allowHttp: input.allowHttp === true });
  } catch (error) {
    throw error instanceof VoiceProviderError
      ? error
      : new VoiceProviderError("invalid_request", `The ${input.service} endpoint URL is not valid.`);
  }

  const timeoutMs = boundedTimeout(input.timeoutMs);
  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      method: input.method,
      headers: input.headers ?? { accept: "application/json" },
      ...(input.body === undefined ? {} : { body: input.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw new VoiceProviderError(
        "timeout",
        `The ${input.service} request timed out after ${String(timeoutMs)} ms; the outcome is uncertain.`,
      );
    }
    throw new VoiceProviderError("provider_unavailable", `The ${input.service} endpoint could not be reached.`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new VoiceProviderError(
      "invalid_response",
      `The ${input.service} endpoint returned a redirect (HTTP ${String(response.status)}); redirects are not followed.`,
      { status: response.status },
    );
  }

  let text: string;
  try {
    text = await readBounded(response);
  } catch (error) {
    if (isAbort(error)) {
      throw new VoiceProviderError(
        "timeout",
        `The ${input.service} response timed out after ${String(timeoutMs)} ms; the outcome is uncertain.`,
      );
    }
    throw error instanceof VoiceProviderError
      ? error
      : new VoiceProviderError("invalid_response", `The ${input.service} response could not be read.`);
  }
  const data = parseJsonObject(text);
  if (response.status >= 400) {
    const category = categorizeHttpStatus(response.status);
    throw new VoiceProviderError(category, messageForRejection(input.service, response.status, data), {
      status: response.status,
    });
  }
  if (text.trim() !== "" && data === null) {
    throw new VoiceProviderError(
      "invalid_response",
      `The ${input.service} response was not a JSON object.`,
      { status: response.status },
    );
  }
  return { status: response.status, data };
}

/**
 * Validate an absolute provider URL. Credentials in the URL are refused so a copied endpoint cannot
 * leak them into a log line; `http` is permitted only where an adapter has an explicit self-hosted
 * opt-in.
 */
export function assertHttpUrl(raw: string, options: { readonly allowHttp: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VoiceProviderError("invalid_request", "The provider endpoint must be an absolute URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new VoiceProviderError("invalid_request", "The provider endpoint must not include credentials.");
  }
  if (url.protocol === "http:") {
    if (!options.allowHttp) {
      throw new VoiceProviderError("invalid_request", "The provider endpoint must use https unless http is explicitly enabled.");
    }
  } else if (url.protocol !== "https:") {
    throw new VoiceProviderError("invalid_request", "The provider endpoint must use http or https.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "metadata" || host === "metadata.google.internal" || isLinkLocalMetadata(host)) {
    throw new VoiceProviderError("invalid_request", "The provider endpoint must not target the cloud metadata service.");
  }
  return url;
}

function isLinkLocalMetadata(host: string): boolean {
  return host === "169.254.169.254" || host === "100.100.100.200";
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return VOICE_PROVIDER_TIMEOUT_MS;
  return Math.min(Math.round(value), 60_000);
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > VOICE_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new VoiceProviderError("invalid_response", "The provider response is too large.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > VOICE_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new VoiceProviderError("invalid_response", "The provider response is too large.");
  }
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The vendor's numeric/string error code is safe to name; its raw message and request are not. */
function messageForRejection(
  service: string,
  status: number,
  data: Record<string, unknown> | null,
): string {
  const code = data?.["code"];
  const safeCode = typeof code === "string" || typeof code === "number" ? String(code) : null;
  return safeCode === null
    ? `${service} rejected the request (HTTP ${String(status)}).`
    : `${service} rejected the request (HTTP ${String(status)}, code ${safeCode}).`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

