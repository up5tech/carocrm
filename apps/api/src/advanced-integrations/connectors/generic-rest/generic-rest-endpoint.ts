import { ProviderError } from '../../provider-error.js';
import { assertProviderUrl } from '../../provider-http-client.js';
import { isJsonObject, readBooleanOption, readNumberOption, readStringListOption, readStringOption } from '../kit/connector-kit.js';

/**
 * Phase 19-INT.24 — the generic REST endpoint configuration
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.10; `19-INT.24`).
 *
 * The generic REST connector is **not** an escape hatch. The plan is explicit: *"This is not an
 * arbitrary 'connect to any URL' escape hatch"*, and *"Do not make arbitrary outbound HTTP or raw
 * code execution available to ordinary users."*
 *
 * So an endpoint is a **reviewed configuration object** with these properties:
 *
 *  - **The base URL is validated**, not just stored: it must be `https`, must carry no
 *    credentials, and must not resolve to a private, loopback or cloud-metadata address. The check
 *    happens when the configuration is saved, so an endpoint that would be an SSRF gadget never
 *    becomes a connection.
 *  - **The paths are allowlisted** and may only contain a literal prefix plus one `{id}` segment.
 *    A path that could escape the base URL — `..`, a scheme, an authority — is refused.
 *  - **The methods are allowlisted**, and the connector only performs the ones it implements.
 *  - **The response is read through explicit pointers.** A dotted pointer names where the array,
 *    the id, the timestamp and the cursor are. There is no expression, no template and no script:
 *    a pointer either names a key or it does not exist.
 *  - **The credential comes from the vault** and the *destination* of the credential is the
 *    endpoint's own host. There is no way to point an authentication header at another host.
 *  - **The payload is bounded**: a maximum response size, a maximum request size and a timeout.
 *
 * Every one of these rules is a refusal with a precise message, not a warning.
 */

/** The authentication modes the generic endpoint may use. */
export const GENERIC_REST_AUTH_MODES = ['none', 'bearer', 'header', 'oauth'] as const;
export type GenericRestAuthMode = (typeof GENERIC_REST_AUTH_MODES)[number];

/** The maximum response size a generic endpoint may answer with. */
export const GENERIC_REST_MAX_RESPONSE_BYTES = 1024 * 1024;

/** The maximum request size the generic connector sends. */
export const GENERIC_REST_MAX_REQUEST_BYTES = 64 * 1024;

/** The maximum number of paths one endpoint may allowlist. */
export const GENERIC_REST_MAX_PATHS = 20;

/** The default timeout of a generic endpoint. */
export const GENERIC_REST_DEFAULT_TIMEOUT_MS = 15_000;

/** A validated generic endpoint. */
export interface GenericRestEndpoint {
  /** The validated base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The allowlisted path templates. */
  readonly paths: readonly string[];
  /** The allowlisted HTTP methods. */
  readonly methods: readonly string[];
  readonly authMode: GenericRestAuthMode;
  /** The header the credential is sent in, for the `header` mode. */
  readonly authHeaderName: string | null;
  /** The path template of the collection. */
  readonly listPath: string;
  /** The path template of a single object, when the endpoint has one. */
  readonly itemPath: string | null;
  /** A dotted pointer to the array in the answer. */
  readonly itemsPointer: string;
  /** A dotted pointer to the id of one item. */
  readonly idPointer: string;
  /** A dotted pointer to the item's timestamp. */
  readonly updatedAtPointer: string | null;
  /** A dotted pointer to the item's version token. */
  readonly versionPointer: string | null;
  /** A dotted pointer to the item's deleted flag. */
  readonly deletedPointer: string | null;
  /** A dotted pointer to the next cursor in the answer. */
  readonly nextCursorPointer: string | null;
  /** The query parameter the page size is sent in. */
  readonly pageSizeParam: string | null;
  /** The query parameter the cursor is sent in. */
  readonly cursorParam: string | null;
  readonly pageSize: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

/** A path template: a literal path with at most one `{id}` segment. */
const PATH_TEMPLATE_PATTERN = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*(\{id\})?[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

/** A header name a credential may be sent in. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Parse and validate a generic endpoint configuration.
 *
 * Every failure is a `configuration_invalid` provider error, so the connection that holds it is
 * paused rather than retried: a bad endpoint is not going to fix itself.
 */
export function parseGenericRestEndpoint(
  options: Readonly<Record<string, unknown>>,
  providerKey: string,
): GenericRestEndpoint {
  const baseUrl = requireStringOption(options, 'baseUrl', providerKey);
  const normalizedBase = normalizeBaseUrl(baseUrl, providerKey);
  const paths = readStringListOption(options, 'paths', providerKey);
  if (paths.length === 0) {
    throw invalid(providerKey, 'paths', 'at least one allowlisted path');
  }
  if (paths.length > GENERIC_REST_MAX_PATHS) {
    throw invalid(providerKey, 'paths', `at most ${String(GENERIC_REST_MAX_PATHS)} paths`);
  }
  for (const path of paths) {
    if (!PATH_TEMPLATE_PATTERN.test(path)) {
      throw invalid(providerKey, 'paths', 'paths that contain only literal segments and at most one "{id}" segment');
    }
    if (path.includes('..')) {
      throw invalid(providerKey, 'paths', 'paths without ".." segments');
    }
  }
  const methods = readStringListOption(options, 'methods', providerKey);
  if (methods.length === 0) {
    throw invalid(providerKey, 'methods', 'at least one allowlisted method');
  }
  for (const method of methods) {
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
      throw invalid(providerKey, 'methods', 'methods that are GET, POST, PUT, PATCH or DELETE');
    }
  }
  const authModeRaw = readStringOption(options, 'authMode', providerKey) ?? 'none';
  if (!(GENERIC_REST_AUTH_MODES as readonly string[]).includes(authModeRaw)) {
    throw invalid(providerKey, 'authMode', `one of: ${GENERIC_REST_AUTH_MODES.join(', ')}`);
  }
  const authMode = authModeRaw as GenericRestAuthMode;
  let authHeaderName: string | null = null;
  if (authMode === 'header') {
    const header = readStringOption(options, 'authHeaderName', providerKey);
    if (header === null || !HEADER_NAME_PATTERN.test(header)) {
      throw invalid(providerKey, 'authHeaderName', 'a valid header name');
    }
    authHeaderName = header;
  }
  const listPath = readStringOption(options, 'listPath', providerKey) ?? paths[0] ?? '';
  if (!paths.includes(listPath)) {
    throw invalid(providerKey, 'listPath', 'a path that is in the allowlist');
  }
  const itemPathRaw = readStringOption(options, 'itemPath', providerKey);
  if (itemPathRaw !== null && !paths.includes(itemPathRaw)) {
    throw invalid(providerKey, 'itemPath', 'a path that is in the allowlist');
  }
  return {
    baseUrl: normalizedBase,
    paths,
    methods: methods.map((method) => method.toUpperCase()),
    authMode,
    authHeaderName,
    listPath,
    itemPath: itemPathRaw,
    itemsPointer: readStringOption(options, 'itemsPointer', providerKey) ?? 'items',
    idPointer: readStringOption(options, 'idPointer', providerKey) ?? 'id',
    updatedAtPointer: readStringOption(options, 'updatedAtPointer', providerKey),
    versionPointer: readStringOption(options, 'versionPointer', providerKey),
    deletedPointer: readStringOption(options, 'deletedPointer', providerKey),
    nextCursorPointer: readStringOption(options, 'nextCursorPointer', providerKey),
    pageSizeParam: readStringOption(options, 'pageSizeParam', providerKey),
    cursorParam: readStringOption(options, 'cursorParam', providerKey),
    pageSize: readNumberOption(options, 'pageSize', providerKey, 50, 1, 500),
    maxResponseBytes: readNumberOption(options, 'maxResponseBytes', providerKey, GENERIC_REST_MAX_RESPONSE_BYTES, 1024, GENERIC_REST_MAX_RESPONSE_BYTES),
    timeoutMs: readNumberOption(options, 'timeoutMs', providerKey, GENERIC_REST_DEFAULT_TIMEOUT_MS, 1000, 120_000),
  };
}

/**
 * Check that a base URL is an acceptable destination.
 *
 * The same address check the HTTP client applies is applied here, at configuration time, so a
 * cloud-metadata endpoint or a private address is refused before a connection exists. The check is
 * asynchronous because it resolves the host.
 */
export async function assertGenericRestBaseUrl(baseUrl: string, providerKey: string): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl, providerKey);
  try {
    await assertProviderUrl(normalized, {
      allowLoopback: false,
      resolve: async (host) => {
        const { lookup } = await import('node:dns/promises');
        const results = await lookup(host, { all: true });
        return results.map((entry) => entry.address);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(providerKey, 'baseUrl', `a public https URL (${message})`);
  }
}

/** The URL of one object of the endpoint, or of its collection. */
export function resolveGenericRestUrl(
  endpoint: GenericRestEndpoint,
  input: { readonly externalId: string | null; readonly cursor: string | null; readonly pageSize: number },
): string {
  const template = input.externalId === null ? endpoint.listPath : (endpoint.itemPath ?? endpoint.listPath);
  const path = template.includes('{id}')
    ? template.replace('{id}', encodeURIComponent(input.externalId ?? ''))
    : template;
  const query: Record<string, string> = {};
  if (endpoint.pageSizeParam !== null) query[endpoint.pageSizeParam] = String(input.pageSize);
  if (endpoint.cursorParam !== null && input.cursor !== null) query[endpoint.cursorParam] = input.cursor;
  const search = new URLSearchParams(query).toString();
  return search === '' ? `${endpoint.baseUrl}${path}` : `${endpoint.baseUrl}${path}?${search}`;
}

/**
 * Read a value out of a JSON document through a dotted pointer.
 *
 * A pointer is a sequence of object keys. It is **not** an expression: there is no bracket
 * syntax, no wildcard and no function call, so a pointer can never reach a prototype or run code.
 */
export function readPointer(source: unknown, pointer: string): unknown {
  if (pointer === '') return undefined;
  let current: unknown = source;
  for (const segment of pointer.split('.')) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The base URL, normalized and checked for the obvious refusals. */
function normalizeBaseUrl(baseUrl: string, providerKey: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalid(providerKey, 'baseUrl', 'an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw invalid(providerKey, 'baseUrl', 'an https URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid(providerKey, 'baseUrl', 'a URL without credentials');
  }
  if (url.hash !== '') {
    throw invalid(providerKey, 'baseUrl', 'a URL without a fragment');
  }
  if (url.search !== '') {
    throw invalid(providerKey, 'baseUrl', 'a URL without a query string');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'metadata') {
    throw invalid(providerKey, 'baseUrl', 'a public host');
  }
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}`;
}

function requireStringOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
): string {
  const value = readStringOption(options, key, providerKey);
  if (value === null) {
    throw invalid(providerKey, key, 'a non-empty string');
  }
  return value;
}

function invalid(providerKey: string, key: string, expected: string): ProviderError {
  return new ProviderError(
    'CONFIGURATION_INVALID',
    `The connection option "${key}" of provider "${providerKey}" must be ${expected}.`,
    { category: 'configuration_invalid', retryable: false, detail: `option:${key}` },
  );
}

/** Whether the endpoint configuration asks for a body the connector may send. */
export function endpointSupportsMethod(endpoint: GenericRestEndpoint, method: string): boolean {
  return endpoint.methods.includes(method.toUpperCase());
}

/** Whether the endpoint's configuration is complete enough to be used. */
export function endpointIsUsable(options: Readonly<Record<string, unknown>>, providerKey: string): boolean {
  try {
    parseGenericRestEndpoint(options, providerKey);
    return true;
  } catch {
    return false;
  }
}

/** Read a boolean option without failing. Used by the endpoint's own checks. */
export function endpointFlag(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
): boolean {
  try {
    return readBooleanOption(options, key, providerKey, false);
  } catch {
    return false;
  }
}
