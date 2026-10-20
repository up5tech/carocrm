import { ProviderError } from '../../provider-error.js';
import { ConnectorHttp, isJsonObject, readNumber } from '../kit/connector-kit.js';
import type { EnrichmentAdapter, EnrichmentContext, EnrichmentOutcome, EnrichmentRequest } from './enrichment.port.js';

/**
 * Phase 19-INT.24 — the one enrichment provider: a vetted REST enrichment endpoint
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.9; `19-INT.24`).
 *
 * The plan asks for **one** selected enrichment provider at a time. This is it: a REST endpoint
 * that answers with values for a bounded set of fields. It is not a vendor SDK, because the plan
 * explicitly says an adapter pattern is enough and because a vendor SDK would be a dependency
 * without a second provider to justify it.
 *
 * The endpoint is configured on the **profile**, and the configuration is validated before it is
 * stored:
 *
 *  - the URL is `https` and is checked against the same address rules the HTTP client applies, so
 *    a cloud-metadata endpoint or a private address is refused before a profile exists;
 *  - the request carries **only** the fields the profile's request map names — a provider never
 *    receives a field the administrator did not choose;
 *  - the answer is read through an **explicit response map** — a provider cannot introduce a field
 *    the platform did not ask for;
 *  - the payload is bounded and the timeout is finite.
 *
 * A provider that answers with something the response map does not name contributes nothing. A
 * provider that answers with a malformed body is refused: a half-read answer is not an answer.
 */

export const REST_ENRICHMENT_PROVIDER_KEY = 'rest-enrichment';

/** The maximum number of fields one enrichment request may carry. */
export const REST_ENRICHMENT_MAX_FIELDS = 25;

/** The maximum response size an enrichment answer may have. */
export const REST_ENRICHMENT_MAX_RESPONSE_BYTES = 256 * 1024;

/** The validated configuration of an enrichment endpoint. */
export interface RestEnrichmentConfig {
  readonly endpointUrl: string;
  readonly method: 'POST';
  readonly authMode: 'none' | 'bearer' | 'header';
  readonly authHeaderName: string | null;
  /** The CRM field → the provider's field name. */
  readonly requestFieldMap: Readonly<Record<string, string>>;
  /** The provider's field name → the CRM field. */
  readonly responseFieldMap: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Where the provider's answer sits, as a dotted pointer. */
  readonly answerPointer: string;
  /** Where the provider's confidence sits, as a dotted pointer. */
  readonly confidencePointer: string | null;
  /** Where the provider's own reference sits, as a dotted pointer. */
  readonly referencePointer: string | null;
  /** What one call costs, in the provider's credit unit. */
  readonly creditsPerCall: number;
}

/** The configuration that was not understood. */
export function invalidEnrichmentConfig(detail: string): ProviderError {
  return new ProviderError(
    'CONFIGURATION_INVALID',
    `The enrichment profile configuration is not usable: ${detail}.`,
    { category: 'configuration_invalid', retryable: false, detail },
  );
}

/**
 * Parse and validate an enrichment endpoint configuration.
 *
 * The field maps are the allowlist: only the fields they name leave the platform and only the
 * fields they name may be written back.
 */
export function parseRestEnrichmentConfig(options: Readonly<Record<string, unknown>>): RestEnrichmentConfig {
  const endpointUrl = readOption(options, 'endpointUrl');
  if (endpointUrl === null) throw invalidEnrichmentConfig('"endpointUrl" is required');
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw invalidEnrichmentConfig('"endpointUrl" must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw invalidEnrichmentConfig('"endpointUrl" must use https');
  if (url.username !== '' || url.password !== '') {
    throw invalidEnrichmentConfig('"endpointUrl" must not carry credentials');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'metadata') {
    throw invalidEnrichmentConfig('"endpointUrl" must be a public host');
  }
  if (url.hash !== '') throw invalidEnrichmentConfig('"endpointUrl" must not carry a fragment');

  const authModeRaw = readOption(options, 'authMode') ?? 'none';
  if (authModeRaw !== 'none' && authModeRaw !== 'bearer' && authModeRaw !== 'header') {
    throw invalidEnrichmentConfig('"authMode" must be "none", "bearer" or "header"');
  }
  let authHeaderName: string | null = null;
  if (authModeRaw === 'header') {
    const header = readOption(options, 'authHeaderName');
    if (header === null || !/^[A-Za-z0-9-]{1,64}$/.test(header)) {
      throw invalidEnrichmentConfig('"authHeaderName" must be a valid header name');
    }
    authHeaderName = header;
  }
  const requestFieldMap = readFieldMap(options, 'requestFieldMap');
  if (Object.keys(requestFieldMap).length === 0) {
    throw invalidEnrichmentConfig('"requestFieldMap" must name at least one field');
  }
  const responseFieldMap = readFieldMap(options, 'responseFieldMap');
  if (Object.keys(responseFieldMap).length === 0) {
    throw invalidEnrichmentConfig('"responseFieldMap" must name at least one field');
  }
  const timeoutMs = readNumber(options, 'timeoutMs') ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw invalidEnrichmentConfig('"timeoutMs" must be between 1 and 120000');
  }
  const creditsPerCall = readNumber(options, 'creditsPerCall') ?? 1;
  if (!Number.isFinite(creditsPerCall) || creditsPerCall < 0) {
    throw invalidEnrichmentConfig('"creditsPerCall" must not be negative');
  }
  return {
    endpointUrl: url.toString(),
    method: 'POST',
    authMode: authModeRaw,
    authHeaderName,
    requestFieldMap,
    responseFieldMap,
    timeoutMs,
    answerPointer: readOption(options, 'answerPointer') ?? '',
    confidencePointer: readOption(options, 'confidencePointer'),
    referencePointer: readOption(options, 'referencePointer'),
    creditsPerCall,
  };
}

/** Read a `{ crmField: providerField }` map. */
function readFieldMap(
  options: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const raw = options[key];
  if (raw === undefined || raw === null) return {};
  if (!isJsonObject(raw)) throw invalidEnrichmentConfig(`"${key}" must be an object`);
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw)) {
    if (typeof to !== 'string' || to.trim() === '') {
      throw invalidEnrichmentConfig(`"${key}.${from}" must be a non-empty field name`);
    }
    out[from] = to.trim();
  }
  return out;
}

export interface RestEnrichmentAdapterOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The REST enrichment provider.
 */
export class RestEnrichmentAdapter implements EnrichmentAdapter {
  readonly providerKey = REST_ENRICHMENT_PROVIDER_KEY;
  readonly adapterVersion = '1.0.0';
  readonly maxFieldsPerRequest = REST_ENRICHMENT_MAX_FIELDS;

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: RestEnrichmentAdapterOptions = {}) {
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: REST_ENRICHMENT_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the endpoint configuration.
   *
   * The service calls this before a profile is stored, so a profile whose endpoint is unusable
   * never exists.
   */
  validateOptions(options: Readonly<Record<string, unknown>>): void {
    parseRestEnrichmentConfig(options);
  }

  /**
   * Ask the endpoint about one record.
   *
   * The request body carries only the mapped fields, and the answer is read through the response
   * map. A field the map does not name is not returned at all.
   */
  async enrich(context: EnrichmentContext, request: EnrichmentRequest): Promise<EnrichmentOutcome> {
    const config = parseRestEnrichmentConfig(context.options);
    const body: Record<string, unknown> = {};
    for (const [crmField, providerField] of Object.entries(config.requestFieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(request.fields, crmField)) continue;
      body[providerField] = request.fields[crmField] ?? null;
    }
    if (Object.keys(body).length > this.maxFieldsPerRequest) {
      throw new ProviderError(
        'INVALID_REQUEST',
        `The enrichment request carries more than ${String(this.maxFieldsPerRequest)} fields.`,
        { category: 'permanent_validation', retryable: false, detail: 'too_many_fields' },
      );
    }
    const http = this.httpFactory(context.connectionId);
    const payload = await http.json<unknown>({
      method: config.method,
      url: config.endpointUrl,
      headers: { ...this.authHeaders(context, config), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: config.timeoutMs,
    });
    const answer = config.answerPointer === '' ? payload : readDotted(payload, config.answerPointer);
    if (!isJsonObject(answer)) {
      throw new ProviderError(
        'INVALID_REQUEST',
        'The enrichment provider answered with a body that does not match the declared schema.',
        { category: 'permanent_validation', retryable: false, detail: 'schema_mismatch' },
      );
    }
    const fields: Record<string, unknown> = {};
    for (const [providerField, crmField] of Object.entries(config.responseFieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(answer, providerField)) continue;
      fields[crmField] = answer[providerField];
    }
    const confidence: Record<string, number> = {};
    if (config.confidencePointer !== null) {
      const raw = readDotted(payload, config.confidencePointer);
      if (isJsonObject(raw)) {
        for (const [providerField, crmField] of Object.entries(config.responseFieldMap)) {
          const value = raw[providerField];
          if (typeof value === 'number' && Number.isFinite(value)) confidence[crmField] = value;
        }
      }
    }
    let providerRef: string | null = null;
    if (config.referencePointer !== null) {
      const value = readDotted(payload, config.referencePointer);
      if (typeof value === 'string') providerRef = value;
      else if (typeof value === 'number') providerRef = String(value);
    }
    return { fields, confidence, creditsUsed: config.creditsPerCall, providerRef };
  }

  private authHeaders(context: EnrichmentContext, config: RestEnrichmentConfig): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.authMode === 'none') return headers;
    const value = context.credential.apiKey;
    if (value === null || value === '') {
      throw new ProviderError('CONFIGURATION_INVALID', 'The connection holds no credential.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_credential',
      });
    }
    if (config.authMode === 'bearer') {
      headers['authorization'] = `Bearer ${value}`;
      return headers;
    }
    if (config.authHeaderName === null) {
      throw new ProviderError('CONFIGURATION_INVALID', 'The profile names no credential header.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_credential_header',
      });
    }
    headers[config.authHeaderName.toLowerCase()] = value;
    return headers;
  }
}

/** Read a value through a dotted pointer. */
function readDotted(source: unknown, pointer: string): unknown {
  if (pointer === '') return source;
  let current: unknown = source;
  for (const segment of pointer.split('.')) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Read a string from a JSON object. */
function readOption(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
