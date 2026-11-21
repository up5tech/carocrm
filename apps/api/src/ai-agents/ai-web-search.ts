/**
 * Phase 25.8 — grounded web search (plan §14, decision D6).
 *
 * One bounded, operator-configured search endpoint and one bounded tool on top of it. The rules are
 * the same ones every other outbound path in this module obeys, plus the ones a hostile result set
 * needs:
 *
 *  - **The endpoint is operator data.** The model supplies a query and a result count; it can never
 *    name a URL, a host or a header. `assertSafeProviderBaseUrl` re-checks the configured endpoint on
 *    every call, so a metadata endpoint, a private range or a hostname that now resolves inward is
 *    refused, exactly as it is for a model provider.
 *  - **Everything is bounded.** Query length, result count, title/snippet length, accepted body size,
 *    timeout. A response that breaks a bound is trimmed, not trusted.
 *  - **Every result is untrusted data.** Title and snippet go through `promptSafe` and are labelled
 *    `untrusted`, so text inside a search result cannot gain the authority of an instruction.
 *  - **A citation is recorded, not remembered.** Each hit carries its URL and the instant it was
 *    retrieved; the tool returns a `web_source:` reference that Chat turns into citations without a
 *    second network call (an external page cannot be re-read under an ACL the way a CRM record can).
 *  - **The call is priced.** One `ai_agent_provider_requests` row per call, under the configured
 *    ledger label, with the run id attached — so a search spends out of the same budget, appears in
 *    the same usage view and folds into the run's cost counter (`reconcileRunCost`).
 *
 * Fail-closed: with `search.enabled` false, or no endpoint, nothing leaves the installation and the
 * tool says so. Twitter/X search is out of scope (D6).
 */

import { createHash, randomUUID } from 'node:crypto';

import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { AIAgentProviderRequestsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { promptSafe } from './ai-agent-actor.js';
import type { AIAgentsSettings } from './ai-agents-settings.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { assertSafeProviderBaseUrl } from './ai-provider-url.js';
import { boundRecord } from './tools/helpers.js';

/** The `result_ref` namespace a web source is stored under; see `HELP_DOCUMENT_REF_KIND` for the other. */
export const WEB_SEARCH_REF_KIND = 'web_source';

/** The most a model may ask for in one call, regardless of the installation setting. */
export const MAX_WEB_RESULTS = 5;
export const MAX_WEB_QUERY_CHARS = 200;
export const MAX_WEB_TITLE_CHARS = 200;
export const MAX_WEB_SNIPPET_CHARS = 400;
export const MAX_WEB_URL_CHARS = 1_000;
/** A stored reference is decoded on every citation read, so it needs its own ceiling. */
const MAX_WEB_REF_CHARS = 12_000;
/** The accepted JSON body. A search answer is small; anything larger is a misconfigured endpoint. */
const MAX_WEB_BODY_BYTES = 262_144;

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** ISO instant of the retrieval that produced this hit. */
  readonly retrievedAt: string;
}

export interface WebSearchOutcome {
  /** False when no endpoint is configured; the tool answers honestly instead of failing. */
  readonly configured: boolean;
  readonly retrievedAt: string;
  readonly hits: readonly WebSearchHit[];
  /** True when a configured endpoint was contacted and did not answer usefully. */
  readonly unavailable: boolean;
  readonly reason: string | null;
  /** The price recorded in the ledger for this call; 0 when the operator configured none. */
  readonly costUsd: number;
}

/** Raised by a transport when the endpoint cannot be reached or answers something unusable. */
export class WebSearchUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'WebSearchUnavailableError';
  }
}

export interface WebSearchHttpResponse {
  readonly status: number;
  readonly json: unknown;
}

/**
 * The outbound HTTP the search service needs, behind a port — the same shape the OIDC client uses
 * (Phase 23.3), so a test supplies a fixture instead of contacting a search provider.
 */
export interface WebSearchPort {
  getJson(url: URL, timeoutMs: number): Promise<WebSearchHttpResponse>;
}

export const WEB_SEARCH_PORT = Symbol('WEB_SEARCH_PORT');

/** The default transport: `fetch`, redirects refused, timeout bounded, body size checked. */
export class FetchWebSearchPort implements WebSearchPort {
  async getJson(url: URL, timeoutMs: number): Promise<WebSearchHttpResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'CaroCRM-web-search/1' },
        // An approved host must not bounce the call somewhere the SSRF check never saw.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WebSearchUnavailableError('The web search endpoint could not be reached.');
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new WebSearchUnavailableError('The web search endpoint did not return a readable body.', response.status);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_WEB_BODY_BYTES) {
      throw new WebSearchUnavailableError('The web search endpoint returned more data than a search answer may carry.', response.status);
    }
    let json: unknown = null;
    if (body.trim() !== '') {
      try {
        json = JSON.parse(body);
      } catch {
        throw new WebSearchUnavailableError('The web search endpoint did not return JSON.', response.status);
      }
    }
    return { status: response.status, json };
  }
}

/**
 * Read the hit list out of a search answer.
 *
 * One documented shape is accepted — `{ results: [{ title, url, snippet }] }` — plus the three
 * aliases the common engines already publish (`items`, `web.results`, `webPages.value`) and the
 * field synonyms they use. The aliases exist so an operator does not have to run a translation
 * proxy; they do not change what is accepted into a citation, which is always an http(s) URL.
 */
export function mapWebSearchResults(json: unknown, retrievedAt: string, maxResults: number): WebSearchHit[] {
  const rows = resultRows(json);
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const record = asRecord(row);
    const url = safeHttpUrl(firstString(record, ['url', 'link', 'href']));
    if (url === null) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = promptSafe(firstString(record, ['title', 'name']), MAX_WEB_TITLE_CHARS) || url.hostname;
    const snippet = promptSafe(firstString(record, ['snippet', 'description', 'text']), MAX_WEB_SNIPPET_CHARS);
    hits.push({ title, url: url.href.slice(0, MAX_WEB_URL_CHARS), snippet, retrievedAt });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

/** The self-contained `result_ref` a web hit list is stored under. */
export function encodeWebSourceRef(hits: readonly WebSearchHit[]): string {
  const payload = hits.slice(0, MAX_WEB_RESULTS).map((hit) => ({
    u: hit.url.slice(0, MAX_WEB_URL_CHARS),
    t: hit.title.slice(0, MAX_WEB_TITLE_CHARS),
    r: hit.retrievedAt,
  }));
  return `${WEB_SEARCH_REF_KIND}:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/**
 * Decode a stored reference back into hits.
 *
 * The stored value is produced by this module, but it is still parsed defensively: a reference that
 * does not decode, names a non-http(s) URL, or carries an unparseable instant yields nothing rather
 * than an invented citation.
 */
export function decodeWebSourceRef(id: string): WebSearchHit[] {
  if (id === '' || id.length > MAX_WEB_REF_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hits: WebSearchHit[] = [];
  for (const row of parsed.slice(0, MAX_WEB_RESULTS)) {
    const record = asRecord(row);
    const url = typeof record['u'] === 'string' ? safeHttpUrl(record['u']) : null;
    const retrievedAt = typeof record['r'] === 'string' ? instant(record['r']) : null;
    if (url === null || retrievedAt === null) continue;
    const title = promptSafe(typeof record['t'] === 'string' ? record['t'] : '', MAX_WEB_TITLE_CHARS) || url.hostname;
    hits.push({ title, url: url.href.slice(0, MAX_WEB_URL_CHARS), snippet: '', retrievedAt });
  }
  return hits;
}

export interface WebSearchCallInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
  /** The run that spent the call; absent (or the MCP direct sentinel) for a run-less call. */
  readonly runId?: string | undefined;
  readonly step?: number | undefined;
  readonly agentId?: string | null | undefined;
  readonly agentVersion?: number | null | undefined;
}

/** The usage-ledger row one search call writes. Pure, so its shape is testable without a database. */
export function webSearchLedgerRow(input: {
  readonly providerKey: string;
  readonly query: string;
  readonly maxResults: number;
  readonly runId?: string | undefined;
  readonly step?: number | undefined;
  readonly agentId?: string | null | undefined;
  readonly agentVersion?: number | null | undefined;
  readonly host: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly httpStatus: number | null;
  readonly resultCount: number;
  readonly retrievedAt: string;
  readonly latencyMs: number;
  readonly costUsd: number;
}): AIAgentProviderRequestsTable {
  return {
    id: randomUUID(),
    // An MCP direct call has no `ai_agent_runs` row, so it is recorded without one rather than
    // invented; the ledger is still the record of the spend.
    run_id: input.runId === undefined || input.runId === '' || input.runId === 'mcp-direct' ? null : input.runId,
    step: input.step ?? null,
    agent_id: input.agentId ?? null,
    agent_version: input.agentVersion ?? null,
    provider_key: input.providerKey,
    model: 'web-search',
    // The query is not stored: the module's data policy keeps prompts out of the ledger by default.
    request_hash: createHash('sha256').update(`${String(input.maxResults)}:${input.query}`, 'utf8').digest('hex'),
    request_meta: JSON.stringify({
      kind: 'web_search',
      queryChars: input.query.length,
      maxResults: input.maxResults,
      host: input.host,
    }),
    response_meta: JSON.stringify({
      kind: 'web_search',
      httpStatus: input.httpStatus,
      resultCount: input.resultCount,
      retrievedAt: input.retrievedAt,
      costLabel: input.costUsd > 0 ? 'estimate' : 'none',
    }),
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
    outcome: input.outcome,
    error_category: null,
    estimated_cost_usd: input.costUsd > 0 ? String(input.costUsd) : null,
    provider_request_id: null,
    created_at: new Date(),
  };
}

@Injectable()
export class AIWebSearchService {
  constructor(
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(WEB_SEARCH_PORT) private readonly port?: WebSearchPort,
  ) {}

  /** One bounded search. Never throws for an unconfigured or unreachable endpoint. */
  async search(input: WebSearchCallInput): Promise<WebSearchOutcome> {
    const settings = await this.settings.settings();
    const search = settings.search;
    const retrievedAt = new Date().toISOString();
    const requested = Math.min(input.maxResults ?? search.maxResults, search.maxResults, MAX_WEB_RESULTS);
    const maxResults = Math.max(1, requested);
    if (!search.enabled || search.endpoint === '') {
      return { configured: false, retrievedAt, hits: [], unavailable: false, reason: null, costUsd: 0 };
    }

    // A refused endpoint is answered, not thrown: the model gets a named reason and the turn goes on.
    let endpoint: string;
    try {
      endpoint = (await assertSafeProviderBaseUrl(search.endpoint, { allowLoopback: search.allowLoopback })).url.toString();
    } catch (error) {
      return {
        configured: true,
        retrievedAt,
        hits: [],
        unavailable: true,
        reason: (error instanceof Error ? error.message : 'The search endpoint is not a usable URL.').slice(0, 300),
        costUsd: 0,
      };
    }
    const url = new URL(endpoint);
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(maxResults));

    const started = Date.now();
    const port = this.port ?? new FetchWebSearchPort();
    try {
      const response = await port.getJson(url, search.timeoutMs);
      if (response.status < 200 || response.status > 299) {
        throw new WebSearchUnavailableError(`The web search endpoint answered HTTP ${String(response.status)}.`, response.status);
      }
      // The retrieval instant is when the answer arrived, so a citation can say when it was checked.
      const answeredAt = new Date().toISOString();
      const hits = mapWebSearchResults(response.json, answeredAt, maxResults);
      await this.record(search, input, {
        maxResults,
        host: url.host,
        outcome: 'succeeded',
        httpStatus: response.status,
        resultCount: hits.length,
        retrievedAt: answeredAt,
        latencyMs: Date.now() - started,
      });
      return {
        configured: true,
        retrievedAt: answeredAt,
        hits,
        unavailable: false,
        reason: null,
        costUsd: search.costPerCallUsd,
      };
    } catch (error) {
      const reason =
        error instanceof WebSearchUnavailableError ? error.message : 'The web search endpoint failed for an unknown reason.';
      await this.record(search, input, {
        maxResults,
        host: url.host,
        outcome: 'failed',
        httpStatus: error instanceof WebSearchUnavailableError ? error.status : null,
        resultCount: 0,
        retrievedAt,
        latencyMs: Date.now() - started,
      });
      return {
        configured: true,
        retrievedAt,
        hits: [],
        unavailable: true,
        reason: reason.slice(0, 300),
        costUsd: search.costPerCallUsd,
      };
    }
  }

  /**
   * Write the call to the provider ledger. Best-effort: the search has already happened, and failing
   * the answer because a usage row could not be written would invite a duplicate call. A failure is
   * logged with the run id and never with the query.
   */
  private async record(
    search: AIAgentsSettings['search'],
    input: WebSearchCallInput,
    call: {
      readonly maxResults: number;
      readonly host: string;
      readonly outcome: 'succeeded' | 'failed';
      readonly httpStatus: number | null;
      readonly resultCount: number;
      readonly retrievedAt: string;
      readonly latencyMs: number;
    },
  ): Promise<void> {
    const row = webSearchLedgerRow({
      providerKey: search.providerKey,
      query: input.query,
      maxResults: call.maxResults,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.step === undefined ? {} : { step: input.step }),
      agentId: input.agentId ?? null,
      agentVersion: input.agentVersion ?? null,
      host: call.host,
      outcome: call.outcome,
      httpStatus: call.httpStatus,
      resultCount: call.resultCount,
      retrievedAt: call.retrievedAt,
      latencyMs: call.latencyMs,
      costUsd: search.costPerCallUsd,
    });
    try {
      await this.database.db.insertInto('ai_agent_provider_requests').values(row).execute();
    } catch (error) {
      log.error(
        {
          error: error instanceof Error ? error.message : 'unknown ledger error',
          providerKey: search.providerKey,
          runId: row.run_id,
        },
        'web search call could not be recorded',
      );
    }
  }
}

/** The bound one search result reaches the model under: untrusted data, never instructions. */
export function boundWebHit(hit: WebSearchHit): Record<string, unknown> {
  return boundRecord(
    {
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      retrievedAt: hit.retrievedAt,
    },
    ['title', 'url', 'snippet', 'retrievedAt'],
  );
}

function resultRows(json: unknown): readonly unknown[] {
  if (Array.isArray(json)) return json;
  const root = asRecord(json);
  if (Array.isArray(root['results'])) return root['results'];
  if (Array.isArray(root['items'])) return root['items'];
  const webPages = asRecord(root['webPages']);
  if (Array.isArray(webPages['value'])) return webPages['value'];
  const web = asRecord(root['web']);
  if (Array.isArray(web['results'])) return web['results'];
  return [];
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Only http(s) ever becomes a citation route; `javascript:`/`data:` in a result is dropped. */
function safeHttpUrl(raw: string): URL | null {
  if (raw === '' || raw.length > MAX_WEB_URL_CHARS * 2) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function instant(raw: string): string | null {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
