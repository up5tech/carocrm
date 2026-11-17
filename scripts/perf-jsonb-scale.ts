/* eslint-disable no-console -- the tables this CLI prints are its deliverable. */
/**
 * Phase 24.11.3 — JSONB/EAV scale baseline for the single-tenant store
 * (`plans/PLAN_Phase_24_Product_Completion.md` §17 task 3).
 *
 * CaroCRM stores every metadata-driven record as one `entity_records` row whose `attrs` jsonb
 * column carries the field values (the "EAV" surface: arbitrary per-entity keys inside the blob,
 * plus containment/extraction predicates and per-record ACL attr lookups). This script measures
 * how those access patterns behave at a realistic single-installation size.
 *
 * What it does:
 *  - boots the API in-process (same pattern as `scripts/perf-baseline.ts`) and logs in as admin;
 *  - inserts `PERF_CONTACTS` (default 12 000) uniquely marked synthetic Contact rows directly into
 *    `entity_records`, batched, and times the load itself;
 *  - times representative SQL statements — list page, attrs equality, attrs containment, attrs
 *    ilike, attrs-key sort, deep-offset page (G71 evidence) and a single-row attrs update;
 *  - times the equivalent HTTP list/search endpoints through `app.inject`;
 *  - prints `EXPLAIN` (never ANALYZE) for the load-bearing statements;
 *  - deletes exactly the rows it inserted, identified by `attrs->>'agentPerfRun' = <run marker>`.
 *
 * It never touches rows it did not create, never creates a database, and contacts no provider.
 *
 * Run: `pnpm tsx scripts/perf-jsonb-scale.ts` (optionally `PERF_CONTACTS=20000 PERF_ITERATIONS=15`).
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createApp } from '../apps/api/src/bootstrap.js';
import { buildConfig } from '../apps/api/src/config.js';
import { DatabaseService } from '../apps/api/src/database/database.service.js';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);

const CONTACTS = Math.max(0, Number(process.env.PERF_CONTACTS ?? '12000'));
const ITERATIONS = Math.max(3, Number(process.env.PERF_ITERATIONS ?? '15'));
const WARMUP = 3;
const ADMIN_LOGIN = process.env.PERF_ADMIN_LOGIN ?? 'admin';
const ADMIN_PASSWORD = process.env.PERF_ADMIN_PASSWORD ?? 'admin';
const RUN = `p24scale-${Date.now().toString(36)}`;
const BATCH = 1000;

const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Ivy', 'Owen', 'Nora', 'Caleb', 'Lena', 'Marcus', 'Petra', 'Dmitri', 'Sana', 'Julian', 'Freya', 'Omar', 'Tess', 'Hugo'];
const LAST = ['Novak', 'Silva', 'Chen', 'Novakova', 'Weber', 'Moreau', 'Kim', 'Novak', 'Petrov', 'Lindqvist', 'Costa', 'Berg', 'Ivanov', 'Fontaine', 'Okafor', 'Larsen', 'Duarte', 'Kowalski', 'Nakamura', 'Fischer'];
const SOURCES = ['web', 'referral', 'event', 'partner', 'campaign'];
const INDUSTRIES = ['software', 'logistics', 'retail', 'healthcare', 'finance', 'manufacturing'];

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function attrsFor(index: number): Record<string, unknown> {
  const first = FIRST[index % FIRST.length] ?? 'Test';
  const last = LAST[(index * 7) % LAST.length] ?? 'Record';
  return {
    firstName: first,
    lastName: `${last}${index}`,
    name: `${first} ${last}${index}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${index}@perf.example`,
    phone: `+1555${String(10_000_000 + index).slice(0, 7)}`,
    accountName: `Perf Account ${index % 500}`,
    leadSource: [SOURCES[index % SOURCES.length]],
    industry: INDUSTRIES[index % INDUSTRIES.length],
    description: `Synthetic perf row ${index}. `.repeat(12),
    customFields: { tier: ['gold', 'silver', 'bronze'][index % 3], score: index % 100, tags: ['perf', 'synthetic'] },
    agentPerfRun: RUN,
  };
}

async function timeQuery(db: DatabaseService, label: string, sqlText: string, values: unknown[] = []): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < WARMUP + ITERATIONS; index += 1) {
    const started = performance.now();
    await db.pool.query(sqlText, values);
    const elapsed = performance.now() - started;
    if (index >= WARMUP) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  console.log(
    `| ${label} | ${samples.length} | ${percentile(samples, 0.5).toFixed(1)} | ${percentile(samples, 0.95).toFixed(1)} | ${(samples[samples.length - 1] ?? 0).toFixed(1)} |`,
  );
  return samples;
}

async function explain(db: DatabaseService, name: string, sqlText: string): Promise<void> {
  const result = await db.pool.query(`explain (format json, costs on) ${sqlText}`);
  const payload = result.rows[0]?.['QUERY PLAN'];
  const root = Array.isArray(payload) ? (payload[0] as { Plan?: Record<string, unknown> })?.Plan : undefined;
  const summary = root === undefined
    ? 'unavailable'
    : `node=${String(root['Node Type'])} total=${String(root['Total Cost'])} rows=${String(root['Plan Rows'])}`;
  console.log(`- ${name}: ${summary}`);
}

async function main(): Promise<void> {
  const config = buildConfig();
  const app = await createApp(config, { skipMigrations: true });
  const db = app.get(DatabaseService);

  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/Authentication',
      payload: { userName: ADMIN_LOGIN, password: ADMIN_PASSWORD },
    });
    if (login.statusCode !== 200 && login.statusCode !== 201) {
      throw new Error(`admin login failed with HTTP ${String(login.statusCode)}`);
    }
    const token = (login.json() as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${token}` };
    const me = await app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers });
    const userId = String((me.json() as { id?: string }).id ?? '');

    const before = await db.pool.query<{ n: string }>(
      "select count(*)::text as n from entity_records where entity_type = 'Contact' and deleted_at is null",
    );
    const existing = Number(before.rows[0]?.n ?? 0);
    console.log(`# perf-jsonb-scale run=${RUN} contacts_before=${String(existing)} inserting=${String(CONTACTS)}`);

    // ---- load: batched inserts, timed ----
    const loadStart = performance.now();
    let inserted = 0;
    for (let base = 0; base < CONTACTS; base += BATCH) {
      const size = Math.min(BATCH, CONTACTS - base);
      const values: string[] = [];
      const params: unknown[] = [];
      for (let index = 0; index < size; index += 1) {
        const rowIndex = base + index;
        const attrs = attrsFor(rowIndex);
        const offset = params.length;
        params.push(randomUUID(), 'Contact', attrs.name ?? null, JSON.stringify(attrs), userId || null, userId || null, JSON.stringify([userId || null]));
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, now(), now(), null, 1)`);
      }
      await db.pool.query(
        `insert into entity_records (id, entity_type, name, attrs, assigned_user_id, created_by_id, team_ids, created_at, modified_at, deleted_at, version) values ${values.join(', ')}`,
        params,
      );
      inserted += size;
    }
    const loadMs = performance.now() - loadStart;
    console.log(`# inserted=${String(inserted)} rows in ${loadMs.toFixed(0)} ms (${(loadMs / Math.max(1, inserted)).toFixed(2)} ms/row)`);

    const total = await db.pool.query<{ n: string }>(
      "select count(*)::text as n from entity_records where entity_type = 'Contact' and deleted_at is null",
    );
    console.log(`# contacts_after=${String(total.rows[0]?.n ?? 0)}`);

    // ---- SQL timings ----
    console.log('');
    console.log('| Statement | n | p50 ms | p95 ms | max ms |');
    console.log('|---|---:|---:|---:|---:|');

    await timeQuery(db, 'list page (entity_type + modified_at desc, limit 20)',
      "select id, name, attrs from entity_records where entity_type = 'Contact' and deleted_at is null order by modified_at desc limit 20");
    await timeQuery(db, 'attrs equality (attrs->>email =)',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null and attrs->>'email' = 'ava.novak0@perf.example' limit 20");
    await timeQuery(db, 'attrs containment ((attrs->field) @> jsonb array)',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null and (attrs -> 'leadSource'::text) @> '[\"web\"]'::jsonb limit 20");
    await timeQuery(db, 'attrs ilike (attrs->>lastName ilike)',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null and attrs->>'lastName' ilike 'perf%' limit 20");
    await timeQuery(db, 'sort by attrs key (order by attrs->>lastName)',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null order by attrs->>'lastName' asc limit 20");
    await timeQuery(db, 'deep offset page (offset 5000, limit 20) — G71 evidence',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null order by modified_at desc limit 20 offset 5000");
    await timeQuery(db, 'single-row attrs update',
      "update entity_records set attrs = jsonb_set(attrs, '{customFields,tier}', '\"gold\"'), modified_at = now() where entity_type = 'Contact' and attrs->>'agentPerfRun' = $1 and id = (select id from entity_records where entity_type = 'Contact' and attrs->>'agentPerfRun' = $1 limit 1)",
      [RUN]);

    // ---- HTTP timings (end-to-end handler + query) ----
    const get = async (url: string): Promise<number> => {
      const started = performance.now();
      await app.inject({ method: 'GET', url, headers });
      return performance.now() - started;
    };
    const endpoints: Array<{ name: string; url: string }> = [
      { name: 'GET /Contact list (20)', url: '/api/v1/Contact?maxSize=20&orderBy=-createdAt' },
      {
        name: 'GET /Contact where attrs equals',
        url: `/api/v1/Contact?maxSize=20&orderBy=-createdAt&where=${encodeURIComponent(JSON.stringify([{ field: 'lastName', operator: 'equals', value: 'Novak1' }]))}`,
      },
      {
        name: 'GET /Contact where attrs like',
        url: `/api/v1/Contact?maxSize=20&orderBy=-createdAt&where=${encodeURIComponent(JSON.stringify([{ field: 'lastName', operator: 'like', value: 'perf' }]))}`,
      },
      { name: 'GET /Search q=perf (3 entities)', url: '/api/v1/Search?q=perf&entities=Account,Contact,Lead&limit=20' },
    ];
    console.log('');
    console.log('| Endpoint | HTTP-ish | p50 ms | p95 ms | max ms |');
    console.log('|---|---:|---:|---:|---:|');
    for (const endpoint of endpoints) {
      for (let index = 0; index < WARMUP; index += 1) await get(endpoint.url);
      const samples: number[] = [];
      let status = 0;
      for (let index = 0; index < ITERATIONS; index += 1) {
        const started = performance.now();
        const response = await app.inject({ method: 'GET', url: endpoint.url, headers });
        samples.push(performance.now() - started);
        status = response.statusCode;
      }
      samples.sort((left, right) => left - right);
      console.log(
        `| ${endpoint.name} | ${String(status)} | ${percentile(samples, 0.5).toFixed(1)} | ${percentile(samples, 0.95).toFixed(1)} | ${(samples[samples.length - 1] ?? 0).toFixed(1)} |`,
      );
    }

    // ---- plans ----
    console.log('');
    console.log('## EXPLAIN (no ANALYZE)');
    await explain(db, 'Contact list by modified_at',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null order by modified_at desc limit 20");
    await explain(db, 'attrs equality',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null and attrs->>'email' = 'ava.novak0@perf.example' limit 20");
    await explain(db, 'attrs-key sort',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null order by attrs->>'lastName' asc limit 20");
    await explain(db, 'deep offset 5000',
      "select id from entity_records where entity_type = 'Contact' and deleted_at is null order by modified_at desc limit 20 offset 5000");
  } finally {
    // Remove exactly the rows this run created — the marker lives inside attrs, the predicate is
    // narrow (entity_type + marker equality) and cannot match user data.
    const removed = await db.pool.query(
      "delete from entity_records where entity_type = 'Contact' and attrs->>'agentPerfRun' = $1",
      [RUN],
    );
    console.log(`# cleanup: deleted ${String(removed.rowCount ?? 0)} synthetic rows (marker ${RUN})`);
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
