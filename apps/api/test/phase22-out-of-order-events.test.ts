import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signFakeWebhook } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.7 — the out-of-order event contract
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §12 task 4; required scenario "older status event
 * arrives after a newer event").
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Nothing is reset or truncated; the
 * account this suite creates is `agent_test_p22_*` and every row it leaves is deleted by exact key.
 *
 * A provider delivers events over a network, so the order in which they arrive is not the order in
 * which they happened. The rule the platform keeps is a **terminal state is terminal**: a call that
 * has completed cannot be put back into `ringing` by an event that was produced earlier and
 * delivered later. The domain functions prove that in isolation
 * (`voice-communications-domain.test.ts`); this suite proves it through the real door — the signed
 * callback, the durable receipt, the worker-authorised processing route and the stored session.
 */

const RUN = Date.now().toString(36);
const ACCOUNT_KEY = `agent_test_p22_${RUN}`;
const WEBHOOK_SECRET = `p22-whsec-${RUN}`;
const VOICE = `/api/v1/integrations/voice-communications/fake/${ACCOUNT_KEY}`;
const CALL_ID = `call-${RUN}-1`;

let ctx: ApiContext;

type Body = Record<string, unknown>;

async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Body }> {
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

/** A signed call callback, exactly as a provider would send it. */
function callEvent(eventId: string, status: string, occurredAt: string): Record<string, unknown> {
  return {
    eventId,
    type: `call.${status}`,
    callId: CALL_ID,
    status,
    direction: 'inbound',
    from: '+14155550101',
    to: '+14155550102',
    occurredAt,
  };
}

function signedHeaders(body: Record<string, unknown>): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signFakeWebhook(WEBHOOK_SECRET, timestamp, body),
  };
}

/** Deliver a callback and process the receipt it produced, the way the worker does. */
async function deliver(body: Record<string, unknown>): Promise<{ status: number; body: Body }> {
  const accepted = await call('POST', `${VOICE}/voice-events`, body, signedHeaders(body));
  if (accepted.status !== 202) return accepted;
  return await call(
    'POST',
    '/api/v1/VoiceCommunications/action/webhook-events/process',
    { eventId: accepted.body['eventId'] },
    {
      ...authHeader(ctx.adminToken),
      'content-type': 'application/json',
      'x-worker-secret': process.env.REPORT_WORKER_SECRET ?? '',
    },
  );
}

async function sessionState(): Promise<string | undefined> {
  const rows = await sql<{ state: string }>`
    select state from voice_call_sessions where account_key = ${ACCOUNT_KEY} and provider_call_id = ${CALL_ID}
  `.execute(ctx.database.db);
  return rows.rows[0]?.state;
}

beforeAll(async () => {
  // Provider secrets need the encryption key before boot; the worker secret opens the job door.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.REPORT_WORKER_SECRET = process.env.REPORT_WORKER_SECRET ?? 'agent-test-worker-secret';
  ctx = await bootApi();
  const created = await call('POST', '/api/v1/VoiceCommunications/action/accounts', {
    key: ACCOUNT_KEY,
    providerKey: 'fake',
    label: `AGENT_TEST ${RUN} p22 out-of-order`,
    environment: 'test',
    enabled: true,
    capabilities: ['voice.inboundEvents', 'voice.callStatusCallbacks', 'webhook.signatureValidation', 'provider.healthCheck'],
    config: {},
    webhookSecret: WEBHOOK_SECRET,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  await sql`
    delete from jobs
    where job = 'voiceCommunications.processWebhookEvent'
      and target->>'eventId' in (select id from voice_webhook_events where account_key = ${ACCOUNT_KEY})
  `.execute(db).catch(() => undefined);
  await sql`delete from voice_call_sessions where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_communication_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_webhook_events where account_key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from outbox_events where payload->>'accountKey' = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await sql`delete from voice_provider_accounts where key = ${ACCOUNT_KEY}`.execute(db).catch(() => undefined);
  await shutdownApi();
});

describe('an older status event cannot move a call backwards (22.7)', () => {
  it('keeps a completed call completed when an older event arrives afterwards', async () => {
    const completedAt = new Date(Date.UTC(2026, 0, 1, 9, 0, 0)).toISOString();
    const completed = await deliver(callEvent(`evt_${RUN}_completed`, 'completed', completedAt));
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body['status']).toBe('processed');
    expect(await sessionState()).toBe('completed');

    // The provider re-sends an event it produced *before* the call ended.
    const ringingAt = new Date(Date.UTC(2026, 0, 1, 8, 59, 0)).toISOString();
    const late = await deliver(callEvent(`evt_${RUN}_late_ringing`, 'ringing', ringingAt));
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(late.body['status']).toBe('processed');

    // The call is still finished: a late event does not reopen it.
    expect(await sessionState()).toBe('completed');
  });

  it('records one receipt per delivery and one session for the call', async () => {
    const receipts = await sql<{ count: string }>`
      select count(*)::text as count from voice_webhook_events where account_key = ${ACCOUNT_KEY}
    `.execute(ctx.database.db);
    expect(Number(receipts.rows[0]?.count ?? '0')).toBe(2);

    const sessions = await sql<{ count: string }>`
      select count(*)::text as count from voice_call_sessions
      where account_key = ${ACCOUNT_KEY} and provider_call_id = ${CALL_ID}
    `.execute(ctx.database.db);
    expect(Number(sessions.rows[0]?.count ?? '0')).toBe(1);
  });

  it('answers the same delivery twice with one receipt and one session', async () => {
    const body = callEvent(`evt_${RUN}_repeat`, 'in-progress', new Date().toISOString());
    const first = await call('POST', `${VOICE}/voice-events`, body, signedHeaders(body));
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body['duplicate']).toBe(false);

    const again = await call('POST', `${VOICE}/voice-events`, body, signedHeaders(body));
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body['duplicate']).toBe(true);
    // An identical redelivery is a duplicate and nothing more.
    expect(again.body['bodyMismatch']).toBeUndefined();

    const receipts = await sql<{ count: string }>`
      select count(*)::text as count from voice_webhook_events
      where account_key = ${ACCOUNT_KEY} and vendor_event_id = ${String(body['eventId'])}
    `.execute(ctx.database.db);
    expect(Number(receipts.rows[0]?.count ?? '0')).toBe(1);
  });

  it('stamps a receipt whose event id is reused with a different body (G19)', async () => {
    const eventId = `evt_${RUN}_body_mismatch`;
    const firstBody = callEvent(eventId, 'in-progress', new Date().toISOString());
    const first = await call('POST', `${VOICE}/voice-events`, firstBody, signedHeaders(firstBody));
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body['duplicate']).toBe(false);

    const mutatedBody = callEvent(eventId, 'completed', new Date().toISOString());
    const replay = await call('POST', `${VOICE}/voice-events`, mutatedBody, signedHeaders(mutatedBody));
    expect(replay.status, JSON.stringify(replay.body)).toBe(202);
    expect(replay.body['duplicate']).toBe(true);
    expect(replay.body['bodyMismatch']).toBe(true);

    // The stored receipt and its processing state are the first delivery's; only the mismatch is
    // stamped on it, so an operator can ask why one event id carried two bodies.
    const receipts = await sql<{ count: string; processing_status: string; failure_code: string | null }>`
      select count(*)::text as count,
             min(processing_status) as processing_status,
             min(failure_code) as failure_code
      from voice_webhook_events
      where account_key = ${ACCOUNT_KEY} and vendor_event_id = ${eventId}
    `.execute(ctx.database.db);
    expect(Number(receipts.rows[0]?.count ?? '0')).toBe(1);
    expect(receipts.rows[0]?.processing_status).toBe('received');
    expect(receipts.rows[0]?.failure_code).toBe('DEDUP_BODY_MISMATCH');
  });
});
