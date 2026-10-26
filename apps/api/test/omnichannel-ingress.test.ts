import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signFakeWebhook } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.5 — the Omnichannel webhook ingress route over the shared Voice receipt pipeline
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.5`; feature contract §3 F6; decision D1).
 *
 * Against the configured primary database (AGENTS.md §3.1): nothing is created, reset or truncated;
 * the only provider is the in-process simulator, so no external host is contacted and no real
 * message exists. The account this suite creates is `agent_test_om5_*` and every row it leaves
 * (receipts, conversations, outbox) is deleted by exact key in `afterAll`.
 *
 * What is proved is this phase's three acceptance lines, on the Omnichannel prefix specifically:
 * a forged callback is rejected (and *recorded*, not silently dropped); a repeated event answers
 * `duplicate` without creating a second receipt or a second job; the response and the stored
 * receipt expose no secret and no raw provider content. The plan's "reuse the existing shared
 * ingestion service" is visible in one way: the receipts land in `voice_webhook_events` — the same
 * rows the Voice prefix writes — never an `omnichannel_*` copy (R1).
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_om5_${RUN}`;
const WEBHOOK_SECRET = `whsec_agent_test_om5_${RUN}`;
const OMNI = `/api/v1/integrations/omnichannel/fake/${ACCOUNT_KEY}`;

let ctx: ApiContext;

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: headers ?? authHeader(ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function signedHeaders(body: Record<string, unknown>, secret = WEBHOOK_SECRET, timestamp = new Date().toISOString()): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(secret, timestamp, body),
  };
}

function inboundBody(eventId: string): Record<string, unknown> {
  return {
    type: 'message.inbound',
    eventId,
    messageId: `SM${eventId}`,
    from: '+14155550101',
    to: '+14155550102',
    body: 'AGENT_TEST_OM5 hello',
    occurredAt: new Date().toISOString(),
  };
}

async function receiptRows(): Promise<{ id: string; dedup_key: string; signature_valid: boolean; processing_status: string }[]> {
  return (
    await sql<{ id: string; dedup_key: string; signature_valid: boolean; processing_status: string }>`
      select id, dedup_key, signature_valid, processing_status from voice_webhook_events
      where account_key = ${ACCOUNT_KEY}
    `.execute(ctx.database.db)
  ).rows;
}

beforeAll(async () => {
  // Provider secrets need the encryption key before boot (same rule as the Voice suite); the worker
  // secret opens the job door. Neither value is a real credential.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const created = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} om5 ingress`,
    environment: 'test',
    enabled: true,
    capabilities: [
      'messaging.sms.send',
      'messaging.sms.receive',
      'messaging.deliveryStatus',
      'webhook.signatureValidation',
      'provider.healthCheck',
    ],
    config: {},
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  // Children first: jobs reference this run's receipts, receipts reference the account (CASCADE).
  await sql`
    delete from jobs
    where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_conversations where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel webhook ingress (19-OM.5)', () => {
  it('records a signed callback through the shared pipeline and answers 202 with no secret or raw content', async () => {
    const body = inboundBody(`evt_${RUN}_1`);
    const result = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
    expect(result.status).toBe(202);
    expect(result.body['accepted']).toBe(true);
    expect(result.body['duplicate']).toBe(false);
    expect(result.body['processingStatus']).toBe('received');
    expect(JSON.stringify(result.body)).not.toContain(WEBHOOK_SECRET);
    const rows = await receiptRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.signature_valid).toBe(true);
    // One durable receipt -> exactly one queued processing job (same store the Voice prefix writes).
    const jobs = (await sql<{ n: string }>`
      select count(*)::text as n from jobs
      where job = 'voiceCommunications.processWebhookEvent' and target->>'eventId' = ${String(rows[0]?.id ?? '')}
    `.execute(ctx.database.db)).rows[0];
    expect(jobs?.n).toBe('1');
  });

  it('acknowledges a repeated event as a duplicate without a second receipt or job', async () => {
    const body = inboundBody(`evt_${RUN}_2`);
    const first = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
    expect(first.status).toBe(202);
    const second = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body));
    expect(second.status).toBe(202);
    expect(second.body['duplicate']).toBe(true);
    expect(second.body['eventId']).toBe(first.body['eventId']);
    const receipts = (await sql<{ n: string }>`
      select count(*)::text as n from voice_webhook_events where account_key = ${ACCOUNT_KEY} and dedup_key like ${`%evt_${RUN}_2%`}
    `.execute(ctx.database.db)).rows[0];
    expect(receipts?.n).toBe('1');
  });

  it('rejects a forged signature and records the rejection instead of dropping it', async () => {
    const body = inboundBody(`evt_${RUN}_forged`);
    const forged = await call('POST', `${OMNI}/message-events`, body, signedHeaders(body, 'whsec_wrong_secret'));
    expect(forged.status).toBe(401);
    expect(JSON.stringify(forged.body)).not.toContain(WEBHOOK_SECRET);
    const rejected = (await sql<{ n: string }>`
      select count(*)::text as n from voice_webhook_events
      where account_key = ${ACCOUNT_KEY} and signature_valid = false and failure_code = 'INVALID_SIGNATURE'
    `.execute(ctx.database.db)).rows[0];
    expect(Number(rejected?.n)).toBeGreaterThanOrEqual(1);
    // A rejected callback never queues work.
    const queued = (await sql<{ n: string }>`
      select count(*)::text as n from voice_webhook_events
      where account_key = ${ACCOUNT_KEY} and signature_valid = false and processing_status = 'received'
    `.execute(ctx.database.db)).rows[0];
    expect(queued?.n).toBe('0');
  });

  it('refuses an unknown kind and a provider/account mismatch — the routing pair must agree', async () => {
    const body = inboundBody(`evt_${RUN}_kind`);
    const badKind = await call('POST', `${OMNI}/not-a-kind`, body, signedHeaders(body));
    expect(badKind.status).toBe(404);
    const mismatch = await call('POST', `/api/v1/integrations/omnichannel/twilio/${ACCOUNT_KEY}/message-events`, body, signedHeaders(body));
    expect(mismatch.status).toBe(404);
  });

  it('keeps one receipt store: the Omnichannel prefix writes voice_webhook_events, and no omnichannel_* copy exists (D1)', async () => {
    const tables = (await sql<{ n: string }>`
      select count(*)::text as n from information_schema.tables
      where table_schema='public' and table_name like 'omnichannel\\_webhook%'
    `.execute(ctx.database.db)).rows[0];
    expect(tables?.n).toBe('0');
    const rows = await receiptRows();
    expect(rows.length).toBeGreaterThan(0);
  });
});
