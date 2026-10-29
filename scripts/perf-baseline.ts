/* eslint-disable no-console -- the table this CLI prints is its deliverable. */
/**
 * Phase 22.20 — read-only performance and capacity baseline
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §19).
 *
 * What this does, and what it deliberately does not:
 *
 *  - boots the API **in-process** (no listener, no seed, `skipMigrations`) and drives only GET
 *    endpoints with the configured admin account, so the numbers are server-side handler + query
 *    time and exclude the network and the browser;
 *  - reads dataset and queue counters from the configured database;
 *  - runs `EXPLAIN` (never `EXPLAIN ANALYZE`) on representative list/search statements, so a plan is
 *    visible without executing a second copy of the work;
 *  - writes nothing. It does not create records, reset data, enqueue work or contact a provider.
 *
 * Run it with the same `.env` the API uses:
 *
 *     pnpm tsx scripts/perf-baseline.ts
 *
 * Optional: `PERF_ITERATIONS=40 PERF_WARMUP=5 pnpm tsx scripts/perf-baseline.ts`.
 * The output is a table intended to be pasted into `docs/quality/phase-22-performance-baselines.md`.
 */
import { performance } from 'node:perf_hooks';

import { createApp } from '../apps/api/src/bootstrap.js';
import { buildConfig } from '../apps/api/src/config.js';
import { DatabaseService } from '../apps/api/src/database/database.service.js';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
// Some modules initialise a vault at boot; the value is never printed and no secret is read.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);

const ITERATIONS = Math.max(1, Number(process.env.PERF_ITERATIONS ?? '20'));
const WARMUP = Math.max(0, Number(process.env.PERF_WARMUP ?? '3'));
const ADMIN_LOGIN = process.env.PERF_ADMIN_LOGIN ?? 'admin';
const ADMIN_PASSWORD = process.env.PERF_ADMIN_PASSWORD ?? 'admin';

interface Measurement {
  readonly name: string;
  readonly status: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
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

    const get = async (url: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      // A baseline must not hang on one slow endpoint: a request that does not answer in 20 s is
      // reported as a timeout (HTTP 0) and the remaining profile continues.
      try {
        const response = await Promise.race([
          app.inject({ method: 'GET', url, headers }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout after 20s: ${url}`)), 20_000);
            timer.unref?.();
          }),
        ]);
        let body: Record<string, unknown> = {};
        try {
          body = response.json() as Record<string, unknown>;
        } catch {
          body = {};
        }
        return { status: response.statusCode, body };
      } catch {
        return { status: 0, body: {} };
      }
    };

    const accounts = await get('/api/v1/Account?maxSize=5&orderBy=-createdAt');
    const accountId = firstId(accounts.body);
    const leads = await get('/api/v1/Lead?maxSize=5&orderBy=-createdAt');
    const leadId = firstId(leads.body);
    const conversations = await get('/api/v1/Omnichannel/action/conversations?limit=5');
    const conversationId = firstId(conversations.body, 'list');

    const endpoints: Array<{ name: string; url: string }> = [
      { name: 'list Account (20)', url: '/api/v1/Account?maxSize=20&orderBy=-createdAt' },
      ...(accountId === '' ? [] : [
        { name: 'detail Account', url: `/api/v1/Account/${accountId}` },
        { name: 'relation Account.contacts (20)', url: `/api/v1/Account/${accountId}/contacts?maxSize=20` },
      ]),
      { name: 'list Lead (20)', url: '/api/v1/Lead?maxSize=20&orderBy=-createdAt' },
      { name: 'global search (3 entities)', url: '/api/v1/Search?q=a&entities=Account,Contact,Lead&limit=20' },
      ...(leadId === '' ? [] : [{ name: 'LeadScore read', url: `/api/v1/LeadScore/action/score/${leadId}` }]),
      { name: 'conversation inbox (20)', url: '/api/v1/Omnichannel/action/conversations?limit=20' },
      ...(conversationId === '' ? [] : [
        { name: 'conversation timeline', url: `/api/v1/Omnichannel/action/conversations/${conversationId}/timeline?limit=20` },
      ]),
      { name: 'outbox failed list (20)', url: '/api/v1/DomainEvent?status=failed&limit=20' },
    ];

    console.log('# Performance baseline');
    console.log(`# iterations=${String(ITERATIONS)} warmup=${String(WARMUP)} in-process inject, GET only`);
    console.log('');
    console.log('| Endpoint | HTTP | p50 ms | p95 ms | max ms |');
    console.log('|---|---:|---:|---:|---:|');

    const measurements: Measurement[] = [];
    for (const endpoint of endpoints) {
      let status = 0;
      for (let index = 0; index < WARMUP; index += 1) {
        const warm = await get(endpoint.url);
        status = warm.status;
      }
      const samples: number[] = [];
      for (let index = 0; index < ITERATIONS; index += 1) {
        const started = performance.now();
        const response = await get(endpoint.url);
        samples.push(performance.now() - started);
        status = response.status;
      }
      samples.sort((left, right) => left - right);
      const measurement: Measurement = {
        name: endpoint.name,
        status,
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        max: samples[samples.length - 1] ?? 0,
      };
      measurements.push(measurement);
      console.log(
        `| ${endpoint.name} | ${String(status)} | ${measurement.p50.toFixed(1)} | ${measurement.p95.toFixed(1)} | ${measurement.max.toFixed(1)} |`,
      );
    }

    console.log('');
    console.log('## Dataset and queue counters');
    console.log('');
    const counters = await db.pool.query(`
      select 'database_bytes' as name, pg_database_size(current_database())::text as value
      union all select 'entity_records', count(*)::text from entity_records where deleted_at is null
      union all select 'outbox_pending', count(*)::text from outbox_events where status = 'pending'
      union all select 'outbox_running', count(*)::text from outbox_events where status = 'running'
      union all select 'outbox_failed', count(*)::text from outbox_events where status = 'failed'
      union all select 'jobs_pending', count(*)::text from jobs where status = 'pending'
      union all select 'jobs_running', count(*)::text from jobs where status = 'running'
      union all select 'jobs_failed', count(*)::text from jobs where status = 'failed'
      union all select 'outbox_oldest_pending_age_s', coalesce(extract(epoch from now() - min(available_at))::bigint::text, '0') from outbox_events where status = 'pending'
      union all select 'jobs_oldest_pending_age_s', coalesce(extract(epoch from now() - min(created_at))::bigint::text, '0') from jobs where status = 'pending'
      union all select 'voice_conversations', count(*)::text from voice_conversations
      union all select 'voice_messages', count(*)::text from voice_messages
      union all select 'integration_dead_letters_open', count(*)::text from integration_dead_letters where status = 'open'
    `);
    for (const row of counters.rows as Array<{ name: string; value: string }>) {
      console.log(`- ${row.name}: ${row.value}`);
    }

    const topTypes = await db.pool.query(`
      select entity_type, count(*)::int as n
        from entity_records
       where deleted_at is null
       group by entity_type
       order by n desc
       limit 10
    `);
    console.log('');
    console.log('Top entity types: ' + (topTypes.rows as Array<{ entity_type: string; n: number }>)
      .map((row) => `${row.entity_type}=${String(row.n)}`).join(', '));

    console.log('');
    console.log('## EXPLAIN (no ANALYZE)');
    const plans: Array<{ name: string; sql: string }> = [
      {
        name: 'Account list by modified_at',
        sql: "explain (format json, costs on) select id from entity_records where entity_type = 'Account' and deleted_at is null order by modified_at desc limit 20",
      },
      {
        name: 'Lead name contains',
        sql: "explain (format json, costs on) select id from entity_records where entity_type = 'Lead' and deleted_at is null and attrs ->> 'name' ilike '%a%' limit 20",
      },
      {
        name: 'outbox due batch',
        sql: "explain (format json, costs on) select id from outbox_events where status in ('pending','running') and available_at <= now() order by available_at, created_at limit 10",
      },
    ];
    for (const plan of plans) {
      const result = await db.pool.query(plan.sql);
      const payload = result.rows[0]?.['QUERY PLAN'];
      const root = Array.isArray(payload) ? (payload[0] as { Plan?: Record<string, unknown> })?.Plan : undefined;
      const summary = root === undefined
        ? 'unavailable'
        : `node=${String(root['Node Type'])} startup=${String(root['Startup Cost'])} total=${String(root['Total Cost'])} rows=${String(root['Plan Rows'])}`;
      console.log(`- ${plan.name}: ${summary}`);
    }
  } finally {
    // A CLI baseline must terminate: BullMQ/Scheduler handles can keep the event loop alive after
    // the HTTP side is closed, and a hung close is not a measurement. Close, wait briefly, exit.
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
  }
}

function firstId(body: Record<string, unknown>, key = 'list'): string {
  const list = body[key];
  if (!Array.isArray(list) || list.length === 0) return '';
  const first = list[0];
  if (first === null || typeof first !== 'object') return '';
  const id = (first as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : '';
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
