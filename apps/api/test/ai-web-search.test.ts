import { describe, expect, it } from 'vitest';

import {
  AIWebSearchService,
  boundWebHit,
  decodeWebSourceRef,
  encodeWebSourceRef,
  mapWebSearchResults,
  MAX_WEB_RESULTS,
  type WebSearchHit,
  type WebSearchHttpResponse,
  type WebSearchPort,
  webSearchLedgerRow,
} from '../src/ai-agents/ai-web-search.js';
import type { AIAgentsSettings } from '../src/ai-agents/ai-agents-settings.service.js';

/**
 * Phase 25.8 — the bounded web-search tool, DB-free and network-free.
 *
 * The transport is a port (the same shape the OIDC client uses), so every case here runs against a
 * fixture: no live search provider, no database. Only literal IPs are used in the URL cases so the
 * SSRF check never needs DNS.
 */

const RETRIEVED_AT = '2026-11-20T05:00:00.000Z';

function settings(overrides: Partial<AIAgentsSettings['search']> = {}): AIAgentsSettings {
  return {
    search: {
      enabled: true,
      // A literal public address, so the SSRF check needs no DNS resolver.
      endpoint: 'http://93.184.216.34/search',
      allowLoopback: false,
      providerKey: 'web_search',
      maxResults: 3,
      timeoutMs: 8_000,
      costPerCallUsd: 0.002,
      ...overrides,
    },
  } as unknown as AIAgentsSettings;
}

interface Recorded {
  readonly urls: string[];
}

function harness(port: WebSearchPort, configured = settings()) {
  const recorded: Recorded = { urls: [] };
  const rows: Record<string, unknown>[] = [];
  const database = {
    db: {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            rows.push(row);
          },
        }),
      }),
    },
  };
  const service = new AIWebSearchService(
    { settings: async () => configured } as never,
    database as never,
    port,
  );
  return { service, rows, recorded };
}

/** A port that records the request URL and answers one fixture. */
function fixturePort(answer: WebSearchHttpResponse, recorded: Recorded): WebSearchPort {
  return {
    getJson: async (url) => {
      recorded.urls.push(url.toString());
      return answer;
    },
  };
}

const HITS_FIXTURE = {
  results: [
    { title: 'Quarterly pricing update', url: 'https://example.com/pricing', snippet: 'Prices changed in November.' },
    { title: 'Analyst note', url: 'https://example.org/note', snippet: 'A short note.' },
    { title: 'Duplicate', url: 'https://example.com/pricing', snippet: 'Same page again.' },
    { title: 'Third', url: 'https://example.net/third', snippet: 'Third source.' },
    { title: 'Fourth', url: 'https://example.net/fourth', snippet: 'Fourth source.' },
  ],
};

describe('AIWebSearchService (25.8)', () => {
  it('is fail-closed: disabled or endpoint-less means nothing leaves the installation', async () => {
    const recorded: Recorded = { urls: [] };
    const port = fixturePort({ status: 200, json: HITS_FIXTURE }, recorded);

    const disabled = harness(port, settings({ enabled: false }));
    const disabledOutcome = await disabled.service.search({ query: 'pricing', runId: 'run-1' });
    expect(disabledOutcome).toMatchObject({ configured: false, hits: [] });
    expect(recorded.urls).toEqual([]);
    expect(disabled.rows).toEqual([]);

    const noEndpoint = harness(port, settings({ endpoint: '' }));
    expect(await noEndpoint.service.search({ query: 'pricing', runId: 'run-1' })).toMatchObject({ configured: false });
    expect(recorded.urls).toEqual([]);
  });

  it('refuses a cloud metadata endpoint without calling it', async () => {
    const recorded: Recorded = { urls: [] };
    const { service, rows } = harness(
      fixturePort({ status: 200, json: HITS_FIXTURE }, recorded),
      settings({ endpoint: 'http://169.254.169.254/latest/meta-data' }),
    );
    const outcome = await service.search({ query: 'pricing' });
    expect(outcome.unavailable).toBe(true);
    expect(outcome.reason).toContain('metadata');
    expect(recorded.urls).toEqual([]);
    // No call went out, so nothing is charged.
    expect(rows).toEqual([]);
    expect(outcome.costUsd).toBe(0);
  });

  it('refuses a private range and a loopback host unless the connection opts in', async () => {
    const recorded: Recorded = { urls: [] };
    const port = fixturePort({ status: 200, json: HITS_FIXTURE }, recorded);

    const privateRange = harness(port, settings({ endpoint: 'http://10.1.2.3/search' }));
    expect((await privateRange.service.search({ query: 'pricing' })).unavailable).toBe(true);

    const loopback = harness(port, settings({ endpoint: 'http://127.0.0.1:8080/search' }));
    expect((await loopback.service.search({ query: 'pricing' })).unavailable).toBe(true);

    const optedIn = harness(port, settings({ endpoint: 'http://127.0.0.1:8080/search', allowLoopback: true }));
    const outcome = await optedIn.service.search({ query: 'pricing' });
    expect(outcome.unavailable).toBe(false);
    expect(recorded.urls[0]).toBe('http://127.0.0.1:8080/search?q=pricing&count=3');
  });

  it('bounds the call, marks every hit untrusted and records the spend on the run', async () => {
    const recorded: Recorded = { urls: [] };
    const { service, rows } = harness(fixturePort({ status: 200, json: HITS_FIXTURE }, recorded));

    const outcome = await service.search({ query: 'pricing', maxResults: 5, runId: 'run-7', step: 2 });

    // The installation cap (3) wins over the larger request.
    expect(recorded.urls[0]).toBe('http://93.184.216.34/search?q=pricing&count=3');
    expect(outcome.hits).toHaveLength(3);
    expect(outcome.hits.map((hit) => hit.url)).toEqual([
      'https://example.com/pricing',
      'https://example.org/note',
      'https://example.net/third',
    ]);
    expect(outcome.hits.every((hit) => hit.retrievedAt === outcome.retrievedAt)).toBe(true);
    expect(boundWebHit(outcome.hits[0] as WebSearchHit)['untrusted']).toBe(true);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: 'run-7',
      step: 2,
      provider_key: 'web_search',
      model: 'web-search',
      outcome: 'succeeded',
      estimated_cost_usd: '0.002',
    });
    expect(JSON.parse(String(rows[0]?.['response_meta']))).toMatchObject({ kind: 'web_search', resultCount: 3 });
    expect(outcome.costUsd).toBe(0.002);
  });

  it('accepts the common provider shapes and drops what is not an http(s) URL', () => {
    const hits = mapWebSearchResults(
      {
        webPages: {
          value: [
            { name: 'A', link: 'https://a.example/x', description: 'first' },
            { name: 'Script', link: 'javascript:alert(1)' },
            { name: 'Bare', link: 'not a url' },
            { name: 'C', link: 'https://c.example/y', description: 'third' },
          ],
        },
      },
      RETRIEVED_AT,
      MAX_WEB_RESULTS,
    );
    expect(hits.map((hit) => hit.url)).toEqual(['https://a.example/x', 'https://c.example/y']);
    expect(hits[0]?.title).toBe('A');
    expect(hits[0]?.snippet).toBe('first');
  });

  it('truncates an oversized title and snippet instead of trusting them', () => {
    const hits = mapWebSearchResults(
      { results: [{ title: 'x'.repeat(900), url: 'https://long.example/z', snippet: 'y'.repeat(2_000) }] },
      RETRIEVED_AT,
      3,
    );
    expect(hits[0]?.title.length).toBe(200);
    expect(hits[0]?.snippet.length).toBe(400);
  });

  it('falls back to the hostname when a result has no title', () => {
    const hits = mapWebSearchResults({ items: [{ url: 'https://untitled.example/page', snippet: 's' }] }, RETRIEVED_AT, 3);
    expect(hits[0]?.title).toBe('untitled.example');
  });

  it('reports an HTTP failure and still records the attempt', async () => {
    const recorded: Recorded = { urls: [] };
    const { service, rows } = harness(fixturePort({ status: 503, json: null }, recorded));

    const outcome = await service.search({ query: 'pricing', runId: 'run-9' });
    expect(outcome.unavailable).toBe(true);
    expect(outcome.reason).toContain('503');
    expect(outcome.hits).toEqual([]);
    expect(rows[0]).toMatchObject({ run_id: 'run-9', outcome: 'failed', estimated_cost_usd: '0.002' });
  });

  it('reports an unreachable endpoint without throwing', async () => {
    const { service } = harness({
      getJson: async () => {
        throw new Error('socket hang up');
      },
    });
    const outcome = await service.search({ query: 'pricing' });
    expect(outcome.unavailable).toBe(true);
    expect(outcome.reason).toContain('unknown reason');
  });

  it('records a run-less (MCP direct) call without inventing a run id', () => {
    const row = webSearchLedgerRow({
      providerKey: 'web_search',
      query: 'pricing',
      maxResults: 3,
      runId: 'mcp-direct',
      host: '93.184.216.34',
      outcome: 'succeeded',
      httpStatus: 200,
      resultCount: 1,
      retrievedAt: RETRIEVED_AT,
      latencyMs: 12.7,
      costUsd: 0,
    });
    expect(row.run_id).toBeNull();
    expect(row.latency_ms).toBe(12);
    // Without a configured price the row stays NULL rather than claiming a known 0.
    expect(row.estimated_cost_usd).toBeNull();
    expect(JSON.parse(String(row.response_meta))).toMatchObject({ costLabel: 'none' });
  });
});

describe('web source references (25.8)', () => {
  const hits: WebSearchHit[] = [
    { title: 'Pricing', url: 'https://example.com/p', snippet: 's', retrievedAt: RETRIEVED_AT },
    { title: 'Note', url: 'https://example.org/n', snippet: 's', retrievedAt: RETRIEVED_AT },
  ];

  it('round-trips every hit with its URL and retrieval instant', () => {
    const decoded = decodeWebSourceRef(encodeWebSourceRef(hits).slice('web_source:'.length));
    expect(decoded.map((hit) => [hit.title, hit.url, hit.retrievedAt])).toEqual([
      ['Pricing', 'https://example.com/p', RETRIEVED_AT],
      ['Note', 'https://example.org/n', RETRIEVED_AT],
    ]);
  });

  it('drops a reference that is not decodable, too long, or not http(s)', () => {
    expect(decodeWebSourceRef('')).toEqual([]);
    expect(decodeWebSourceRef('not-base64-$$$')).toEqual([]);
    expect(decodeWebSourceRef('x'.repeat(12_001))).toEqual([]);

    const smuggled = Buffer.from(
      JSON.stringify([
        { u: 'javascript:alert(1)', t: 'Script', r: RETRIEVED_AT },
        { u: 'https://ok.example/a', t: 'Ok', r: 'not-a-date' },
        { u: 'https://ok.example/b', t: '', r: RETRIEVED_AT },
      ]),
      'utf8',
    ).toString('base64url');
    const decoded = decodeWebSourceRef(smuggled);
    expect(decoded.map((hit) => hit.url)).toEqual(['https://ok.example/b']);
    // A result with no title cites its host, never an empty label (the column needs one).
    expect(decoded[0]?.title).toBe('ok.example');
  });
});
