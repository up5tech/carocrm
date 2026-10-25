import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { LeadScoreSettingsService } from '../src/lead-score/index.js';
import { runAsLeadScoreInternal } from '../src/lead-score/lead-score-internal.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.13 — the convert command, its operation record and its recovery
 * (`PLAN_Phase_19_LeadScore.md` §3.4, §4.3, §7.6, §7.8, §8.3, §16 `19-LS.13`; audit §11 `LS.13`; contract §3,
 * §4, §10, §11).
 *
 * The exit criterion is two-sided, and the suite drives both sides through the real routes:
 *
 * 1. **a retried operation cannot create duplicate targets** — the same key replays the stored result (no new
 *    Contact, no new Account, no new event), a second key against a converted Lead is refused, and two
 *    concurrent attempts with two keys produce exactly one conversion.
 * 2. **a failed atomic operation leaves no inconsistent state** — the work is one transaction, so the loser of
 *    the race and the already-converted refusal leave zero targets behind, and the operation row records why.
 *
 * Recovery is asserted as a decision: a stuck `processing` row is settled by the scan only after the accounting
 * proves nothing was written, a retry re-derives the plan from the stored decisions and refuses when the plan is
 * stale, and a human can close a reviewable row. The convert command also proves the 19-LS.13 permission change:
 * a non-admin role with the operation's `create` grant really can convert (the row is written under the caller's
 * right), and a role without it is refused before anything exists.
 *
 * `afterEach` restores the whole `leadScore` settings row; `afterAll` removes only what the run created — the
 * targets, the Lead, the operation rows, the link rows, and the roles/users the ACL tests made.
 */

const RUN = `AGENT_TEST_LS13_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const PREVIEW_PATH = '/api/v1/LeadScore/action/conversion/preview';
const CONVERT_PATH = '/api/v1/LeadScore/action/conversion/convert';
const OPERATIONS_PATH = '/api/v1/LeadScore/action/conversion/operations';
const RECOVER_PATH = '/api/v1/LeadScore/action/work/recover-conversion-operations';
const AFFORDANCE_PATH = '/api/v1/LeadScore/action/conversion/affordance';

const WORKER_SECRET = `${RUN}_worker`;
process.env.REPORT_WORKER_SECRET = WORKER_SECRET;

let ctx: ApiContext;
let previousSettings: string | null = null;
let settingsAfterSetup = '';
let adminPrincipal: { userId: string; userName: string; userType: 'admin'; roles: string[]; teams: string[] } | undefined;
let operationSequence = 0;
const created = { records: [] as string[], operations: [] as string[], roles: [] as string[], users: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface PreviewBody {
  leadRevision: number;
  previewHash: string;
  confirmationTypes: string[];
  permission: { canExecute: boolean; reasons: string[] };
  targets: { type: string; action: string; existingId: string | null; proposed: { field: string; value: unknown; origin: string }[] }[];
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string, headers: Record<string, string> = {}): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token ?? ctx.adminToken), ...headers },
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

function errorOf(result: CallResult): { code: string; details: Body } {
  return (result.body['error'] ?? {}) as { code: string; details: Body };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function storedSettings(): Promise<Body> {
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  return (row?.data ?? {}) as Body;
}

function lead(suffix: string, data: Record<string, unknown> = {}): Promise<string> {
  const name = `${RUN} ${suffix}`;
  return createRecord('Lead', {
    name,
    firstName: `${RUN}first`,
    lastName: name,
    company: `${RUN} Acme`,
    emailAddress: `${RUN.toLowerCase()}.${String(++operationSequence)}@example.com`,
    status: 'New',
    ...data,
  });
}

interface TargetChoice {
  type: 'Contact' | 'Account' | 'Opportunity';
  action: 'create' | 'link';
  existingId?: string;
}

async function preview(leadId: string, targets: TargetChoice[], extra: Body = {}, token?: string): Promise<CallResult> {
  return call('POST', PREVIEW_PATH, { leadId, targets, ...extra }, token);
}

/**
 * Preview, then convert with the preview's own fingerprint and acknowledgements.
 *
 * A test that wants a *different* answer (a stale hash, a missing acknowledgement) builds the body itself —
 * this helper is the happy path, so the happy path is what its assertions mean.
 */
async function convert(leadId: string, targets: TargetChoice[], extra: Body = {}, token?: string): Promise<CallResult> {
  const prepared = await preview(leadId, targets, extra, token);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const body = prepared.body as unknown as PreviewBody;
  const response = await call(
    'POST',
    CONVERT_PATH,
    {
      leadId,
      operationKey: `${RUN}_op_${String((operationSequence += 1))}`,
      targets,
      previewHash: body.previewHash,
      acknowledged: body.confirmationTypes,
      ...extra,
    },
    token,
  );
  const operationId = String((response.body['operationId'] ?? '') as string);
  if (operationId !== '') created.operations.push(operationId);
  return response;
}

/** A row the module wrote, for states a test cannot reach through the command. */
async function craftOperation(input: { sourceLeadId: string; status: string; requestedAt?: Date; plan?: unknown; failureCode?: string | null }): Promise<string> {
  const scope = ctx.app.get(REQUEST_SCOPE_TOKEN, { strict: false }) as RequestScope;
  if (adminPrincipal === undefined) throw new Error('the admin principal was not resolved');
  const crud = ctx.app.get(EntityCrudService, { strict: false });
  const record = await scope.runAs(adminPrincipal, () =>
    runAsLeadScoreInternal(() =>
      crud.create('LeadConversionOperation', {
        name: `${RUN} crafted ${String((operationSequence += 1))}`,
        operationKey: `${RUN}_crafted_${String(operationSequence)}`,
        sourceLeadId: input.sourceLeadId,
        status: input.status,
        requestedAt: input.requestedAt ?? new Date(),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        ...(input.plan === undefined ? {} : { resultSummary: JSON.stringify({ plan: input.plan }) }),
      }),
    ),
  );
  const id = String(record['id'] ?? '');
  created.operations.push(id);
  return id;
}

async function operationRow(id: string): Promise<Record<string, unknown>> {
  const rows = await sql<{ attrs: Record<string, unknown> }>`select attrs from entity_records where id = ${id}`.execute(ctx.database.db);
  return rows.rows[0]?.attrs ?? {};
}

function planOf(previewBody: PreviewBody, targets: TargetChoice[]): Body {
  return {
    previewHash: previewBody.previewHash,
    targets: targets.map((entry) => ({ type: entry.type, action: entry.action, existingId: entry.existingId ?? null })),
    fieldMerge: [],
    acknowledged: previewBody.confirmationTypes,
    overrideDuplicateFor: [],
    allowReparent: false,
  };
}

async function countRows(entity: string): Promise<number> {
  const rows = await sql<{ count: number }>`select count(*)::int as count from entity_records where entity_type = ${entity} and deleted_at is null`.execute(ctx.database.db);
  return Number(rows.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const admin = await ctx.database.db.selectFrom('users').select(['id', 'user_name']).where('is_admin', '=', true).where('is_deleted', '=', false).limit(1).executeTakeFirst();
  if (admin !== undefined) adminPrincipal = { userId: admin.id, userName: admin.user_name, userType: 'admin', roles: [], teams: [] };

  await setSettings({
    enabled: true,
    features: { fieldMapping: true, conversionPreview: true, leadConversion: true, conversionRecovery: true, duplicateDetection: false },
  });
  settingsAfterSetup = JSON.stringify(await storedSettings());
}, 240_000);

afterEach(async () => {
  await ctx.database.db
    .updateTable('app_settings')
    .set({ data: JSON.parse(settingsAfterSetup) as Body, modified_at: new Date() })
    .where('name', '=', SETTINGS_ROW)
    .execute();
  ctx.app.get(LeadScoreSettingsService, { strict: false }).invalidate();
});

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);

  const ids = [...created.records, ...created.operations];
  if (ids.length > 0) {
    const linked = await db.selectFrom('entity_links').select('id').where((eb) => eb.or([eb('record_id_a', 'in', ids), eb('record_id_b', 'in', ids)])).execute().catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
  }
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);

  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`), eb(sql`attrs->>'name'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score conversion suite left records behind');

  await shutdownApi();
}, 240_000);

describe('one conversion, one transaction (exit criterion 2)', () => {
  it('creates the Contact and the Account, links them, converts the Lead and records why', async () => {
    const leadId = await lead('happy');
    const outboxBefore = Number((await ctx.database.db.selectFrom('outbox_events').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst())?.count ?? 0);

    const result = await convert(leadId, [
      { type: 'Contact', action: 'create' },
      { type: 'Account', action: 'create' },
    ]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = result.body as unknown as { operationId: string; status: string; createdContactId: string; createdAccountId: string; leadStatus: string };
    expect(body.status).toBe('succeeded');
    expect(body.leadStatus).toBe('Converted');

    // The Lead carries the converted lifecycle and the references, written by the command and nobody else.
    const converted = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    expect(converted['status']).toBe('Converted');
    expect(converted['convertedContactId']).toBe(body.createdContactId);
    expect(converted['convertedAccountId']).toBe(body.createdAccountId);
    expect(converted['conversionOperationId']).toBe(body.operationId);
    expect(typeof converted['convertedAt']).toBe('string');

    // The Contact was created through the canonical path — mapped values, the Account link, and the kernel's
    // own derived name.
    const contact = (await call('GET', `/api/v1/Contact/${body.createdContactId}`)).body;
    expect(contact['accountId']).toBe(body.createdAccountId);
    expect(contact['company']).toBeUndefined();
    const account = (await call('GET', `/api/v1/Account/${body.createdAccountId}`)).body;
    expect(account['name']).toBe(`${RUN} Acme`);

    // The row is the audit trail: succeeded, with the ids, and only after the work committed.
    const row = await operationRow(body.operationId);
    expect(row['status']).toBe('succeeded');
    expect(row['createdContactId']).toBe(body.createdContactId);
    expect(row['completedAt']).toBeDefined();

    // One event, and it carries ids and the verdict — never the record.
    const outboxAfter = await ctx.database.db.selectFrom('outbox_events').select(['event_type', 'payload']).where('event_type', '=', 'lead.conversionSucceeded.v1').execute();
    const mine = outboxAfter.find((entry) => (entry.payload as Body)['leadId'] === leadId);
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine?.payload)).not.toContain(`${RUN} Acme`);
    const outboxGlobalAfter = Number((await ctx.database.db.selectFrom('outbox_events').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst())?.count ?? 0);
    expect(outboxGlobalAfter).toBeGreaterThan(outboxBefore);
  });

  it('replays the same key with the stored result and creates nothing', async () => {
    const leadId = await lead('replay');
    const targets: TargetChoice[] = [{ type: 'Contact', action: 'create' }];
    const prepared = (await preview(leadId, targets)).body as unknown as PreviewBody;
    const first = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_replay_key`,
      targets,
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const operationId = String((first.body as unknown as { operationId: string }).operationId);
    created.operations.push(operationId);
    const contactsBefore = await countRows('Contact');
    const eventsBefore = await ctx.database.db.selectFrom('outbox_events').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();

    // The retrying client sends the same key and the same fingerprint — it does not know the Lead is converted
    // now, and it must not have to.
    const again = await call('POST', CONVERT_PATH, { leadId, operationKey: `${RUN}_replay_key`, targets, previewHash: prepared.previewHash, acknowledged: prepared.confirmationTypes });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body as unknown as { operationId: string }).operationId).toBe(operationId);
    expect(await countRows('Contact')).toBe(contactsBefore);
    const eventsAfter = await ctx.database.db.selectFrom('outbox_events').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    expect(eventsAfter?.count).toBe(eventsBefore?.count);
  });

  it('answers a second key on a converted Lead without creating a second pair', async () => {
    const leadId = await lead('twice');
    expect((await convert(leadId, [{ type: 'Contact', action: 'create' }])).status).toBe(200);
    const contacts = await countRows('Contact');
    const accounts = await countRows('Account');

    const prepared = await preview(leadId, [{ type: 'Contact', action: 'create' }]);
    const second = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_second_key`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: (prepared.body as unknown as PreviewBody).previewHash,
      acknowledged: (prepared.body as unknown as PreviewBody).confirmationTypes,
    });
    const attemptId = String(errorOf(second).details['operationId'] ?? '');
    created.operations.push(attemptId);
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe('LEADSCORE_ALREADY_CONVERTED');
    expect(await countRows('Contact')).toBe(contacts);
    expect(await countRows('Account')).toBe(accounts);
    // The refused attempt is recorded as finally failed, with a code, and it wrote nothing.
    const row = await operationRow(attemptId);
    expect(row['status']).toBe('failed_final');
    expect(row['failureCode']).toBe('already_converted');
  });

  it('converts once when two keys race for one Lead', async () => {
    const leadId = await lead('race');
    const prepared = await preview(leadId, [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }]);
    const body = prepared.body as unknown as PreviewBody;
    const contactsBefore = await countRows('Contact');

    const [left, right] = await Promise.all([
      call('POST', CONVERT_PATH, { leadId, operationKey: `${RUN}_race_a`, targets: [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }], previewHash: body.previewHash, acknowledged: body.confirmationTypes }),
      call('POST', CONVERT_PATH, { leadId, operationKey: `${RUN}_race_b`, targets: [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }], previewHash: body.previewHash, acknowledged: body.confirmationTypes }),
    ]);
    for (const attempt of [left, right]) created.operations.push(String(attempt.body['operationId'] ?? ''));
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    // Exactly one Contact exists for this Lead, and exactly one Attempt succeeded.
    expect(await countRows('Contact')).toBe(contactsBefore + 1);
    const converted = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    expect(converted['status']).toBe('Converted');
  });
});

describe('what a caller must prove before anything is claimed', () => {
  it('refuses a stale fingerprint by name and writes nothing', async () => {
    const leadId = await lead('stale');
    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'changed after preview' })).status).toBe(200);
    const operationsBefore = await countRows('LeadConversionOperation');

    const result = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_stale_key`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('LEADSCORE_PREVIEW_STALE');
    expect(errorOf(result).details['component']).toBe('hash');
    expect(await countRows('LeadConversionOperation')).toBe(operationsBefore);
  });

  it('refuses a confirmation set that is not the one the preview asked for', async () => {
    const leadId = await lead('ack');
    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const missing = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_ack_missing`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: [],
    });
    expect(missing.status).toBe(409);
    expect(errorOf(missing).details['component']).toBe('confirmation');

    const extra = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_ack_extra`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: [...prepared.confirmationTypes, 'field_merge'],
    });
    expect(extra.status).toBe(409);
    expect(errorOf(extra).details['component']).toBe('confirmation');
  });

  it('refuses a duplicate create unless the caller records the override', async () => {
    await setSettings({ features: { duplicateDetection: true } });
    const email = `${RUN.toLowerCase()}.dup@example.com`;
    const leadId = await lead('dup', { emailAddress: email });
    const existingContact = await createRecord('Contact', { name: `${RUN} existing dup`, lastName: `${RUN} existing dup`, emailAddress: email });

    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const undecided = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_dup_undecided`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(undecided.status).toBe(409);
    expect(errorOf(undecided).code).toBe('LEADSCORE_DUPLICATE_REVIEW_REQUIRED');

    // The explicit override is a capability, and the admin holds it.
    const overridden = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_dup_override`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
      overrideDuplicateFor: ['Contact'],
    });
    created.operations.push(String(overridden.body['operationId'] ?? ''));
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);
    expect((overridden.body as unknown as { createdContactId: string }).createdContactId).not.toBe(existingContact);
  });

  it('links an existing Contact and Account instead of creating them', async () => {
    const leadId = await lead('link');
    const accountId = await createRecord('Account', { name: `${RUN} linked account` });
    const contactId = await createRecord('Contact', { name: `${RUN} linked contact`, lastName: `${RUN} linked contact` });

    const result = await convert(leadId, [
      { type: 'Account', action: 'link', existingId: accountId },
      { type: 'Contact', action: 'link', existingId: contactId },
    ]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = result.body as unknown as { linkedAccountId: string; linkedContactId: string; createdContactId: string | null };
    expect(body.linkedAccountId).toBe(accountId);
    expect(body.linkedContactId).toBe(contactId);
    expect(body.createdContactId).toBeNull();
    // The relationship is the one write a link carries: the Contact now belongs to that Account.
    expect((await call('GET', `/api/v1/Contact/${contactId}`)).body['accountId']).toBe(accountId);
    const converted = (await call('GET', `/api/v1/Lead/${leadId}`)).body;
    expect(converted['convertedAccountId']).toBe(accountId);
    expect(converted['convertedContactId']).toBe(contactId);
  });
});

describe('recovery: settle, retry, close, scan (contract §10, §11)', () => {
  it('retries a retryable attempt with the plan it stored, and converts', async () => {
    const leadId = await lead('retry');
    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const operationId = await craftOperation({ sourceLeadId: leadId, status: 'failed_retryable', requestedAt: new Date(Date.now() - 5 * 60_000), plan: planOf(prepared, [{ type: 'Contact', action: 'create' }]), failureCode: 'transient' });

    const retried = await call('POST', `${OPERATIONS_PATH}/${operationId}/retry`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((retried.body as unknown as { status: string }).status).toBe('succeeded');
    expect((await call('GET', `/api/v1/Lead/${leadId}`)).body['status']).toBe('Converted');
    expect((await operationRow(operationId))['status']).toBe('succeeded');
  });

  it('refuses a retry whose plan no longer describes the Lead, and asks for review', async () => {
    const leadId = await lead('retry stale');
    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const operationId = await craftOperation({ sourceLeadId: leadId, status: 'failed_retryable', requestedAt: new Date(Date.now() - 5 * 60_000), plan: planOf(prepared, [{ type: 'Contact', action: 'create' }]), failureCode: 'transient' });
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'moved on' })).status).toBe(200);

    const retried = await call('POST', `${OPERATIONS_PATH}/${operationId}/retry`);
    expect(retried.status).toBe(409);
    expect(errorOf(retried).code).toBe('LEADSCORE_CONVERSION_NEEDS_RECOVERY');
    expect(errorOf(retried).details['failureCode']).toBe('stale');
    expect((await operationRow(operationId))['status']).toBe('needs_review');
    expect((await call('GET', `/api/v1/Lead/${leadId}`)).body['status']).toBe('New');
  });

  it('settles a stuck row by the scan only when nothing was written, and says when it is off', async () => {
    const leadId = await lead('scan');
    const operationId = await craftOperation({ sourceLeadId: leadId, status: 'processing', requestedAt: new Date(Date.now() - 2 * 60 * 60_000) });

    const off = await call('POST', RECOVER_PATH, undefined, undefined, { 'x-worker-secret': WORKER_SECRET });
    expect(off.status).toBe(200);
    expect((off.body as unknown as { skipped: string }).skipped).toBe('disabled');

    await setSettings({ conversion: { recovery: { enabled: true, staleAfterMinutes: 5, limit: 50, chunkSize: 10 } } });
    const run = await call('POST', RECOVER_PATH, undefined, undefined, { 'x-worker-secret': WORKER_SECRET });
    expect(run.status).toBe(200);
    const body = run.body as unknown as { retryable: string[]; review: string[]; scanned: number };
    expect(body.retryable).toContain(operationId);
    expect(body.scanned).toBeGreaterThanOrEqual(1);
    expect((await operationRow(operationId))['status']).toBe('failed_retryable');
    expect((await operationRow(operationId))['failureCode']).toBe('interrupted');
    // The scan never touched the Lead.
    expect((await call('GET', `/api/v1/Lead/${leadId}`)).body['status']).toBe('New');
  });

  it('closes a reviewable row once, and refuses a second close', async () => {
    const leadId = await lead('close');
    const operationId = await craftOperation({ sourceLeadId: leadId, status: 'needs_review', requestedAt: new Date(Date.now() - 60 * 60_000), failureCode: 'inconsistent' });

    const closed = await call('POST', `${OPERATIONS_PATH}/${operationId}/close`, { reason: 'checked by hand' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((closed.body as unknown as { status: string; canClose: boolean }).status).toBe('failed_final');
    expect((closed.body as unknown as { canClose: boolean }).canClose).toBe(false);

    const again = await call('POST', `${OPERATIONS_PATH}/${operationId}/close`, {});
    expect(again.status).toBe(422);
  });

  it('lists operations under the audit right, with the Lead label only when the Lead is readable', async () => {
    const leadId = await lead('list');
    expect((await convert(leadId, [{ type: 'Contact', action: 'create' }])).status).toBe(200);

    const listed = await call('GET', `${OPERATIONS_PATH}?limit=50`);
    expect(listed.status).toBe(200);
    const items = (listed.body as unknown as { items: { leadId: string; leadLabel: string | null; status: string }[] }).items;
    expect(items.some((entry) => entry.leadId === leadId && entry.leadLabel === `${RUN} list`)).toBe(true);

    const single = await call('GET', `${OPERATIONS_PATH}/${created.operations[created.operations.length - 1] ?? 'x'}`);
    expect(single.status).toBe(200);
    expect((single.body as unknown as { operationKey: string }).operationKey).toContain(RUN);

    const roleId = `${RUN}_audit_only`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} audit only`, permissions: { LeadConversionAudit: { read: 'yes' } } });
    created.roles.push(roleId);
    const auditor = await createTestUser(ctx, { userName: `${RUN}_auditor`, roleIds: [roleId] });
    created.users.push(auditor.id);
    const scoped = await call('GET', `${OPERATIONS_PATH}?limit=50`, undefined, auditor.token);
    expect(scoped.status).toBe(200);
    const scopedItems = (scoped.body as unknown as { items: { leadId: string; leadLabel: string | null }[] }).items;
    // The row is the audit subject; the Lead's name is not, because this caller cannot read the Lead.
    expect(scopedItems.some((entry) => entry.leadId === leadId && entry.leadLabel === null)).toBe(true);

    const roleNone = `${RUN}_no_audit`;
    await createTestRole(ctx, { id: roleNone, name: `${RUN} no audit`, permissions: {} });
    created.roles.push(roleNone);
    const nobody = await createTestUser(ctx, { userName: `${RUN}_noaudit`, roleIds: [roleNone] });
    created.users.push(nobody.id);
    const denied = await call('GET', `${OPERATIONS_PATH}?limit=5`, undefined, nobody.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('conversionAuditRead');
  });

  it('answers a key that belongs to another Lead as a conflict, without naming it', async () => {
    const mine = await lead('conflict a');
    const other = await lead('conflict b');
    const first = await convert(mine, [{ type: 'Contact', action: 'create' }]);
    expect(first.status).toBe(200);
    const key = String((await operationRow(String((first.body as unknown as { operationId: string }).operationId)))['operationKey']);

    const prepared = (await preview(other, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const result = await call('POST', CONVERT_PATH, {
      leadId: other,
      operationKey: key,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('LEADSCORE_CONVERSION_CONFLICT');
    expect(JSON.stringify(result.body)).not.toContain(mine);
  });
});

describe('the command runs as the caller (plan §9.2, contract §13.2)', () => {
  it('lets a role with the grants convert, including writing its own operation row', async () => {
    const leadId = await lead('role');
    const roleId = `${RUN}_converter`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} converter`,
      permissions: {
        Lead: { read: 'all', edit: 'yes' },
        Contact: { create: 'yes', read: 'all' },
        Account: { create: 'yes', read: 'all' },
        LeadConversionPreview: { read: 'yes' },
        LeadConversion: { edit: 'yes' },
        // The row is created *and* moved through its states, so the role needs both grants (LS.5's rule:
        // writing history is a grant, not a bypass).
        LeadConversionOperation: { create: 'yes', edit: 'yes' },
      },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_converter`, roleIds: [roleId] });
    created.users.push(caller.id);

    const result = await convert(leadId, [{ type: 'Contact', action: 'create' }, { type: 'Account', action: 'create' }], {}, caller.token);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await call('GET', `/api/v1/Lead/${leadId}`, undefined, caller.token)).body['status']).toBe('Converted');
    // The row names the caller as the requester, and the Lead as converted by them.
    const operationId = String((result.body as unknown as { operationId: string }).operationId);
    expect((await operationRow(operationId))['requestedById']).toBe(caller.id);
    expect((await call('GET', `/api/v1/Lead/${leadId}`)).body['convertedById']).toBe(caller.id);
  });

  it('refuses a caller whose role may not create the operation row, and writes nothing', async () => {
    const leadId = await lead('no operation grant');
    const roleId = `${RUN}_no_row`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} no operation row`,
      permissions: {
        Lead: { read: 'all', edit: 'yes' },
        Contact: { create: 'yes', read: 'all' },
        LeadConversionPreview: { read: 'yes' },
        LeadConversion: { edit: 'yes' },
        LeadConversionOperation: { create: 'no' },
      },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_norow`, roleIds: [roleId] });
    created.users.push(caller.id);
    const contactsBefore = await countRows('Contact');

    const result = await convert(leadId, [{ type: 'Contact', action: 'create' }], {}, caller.token);
    expect(result.status).toBe(403);
    expect((await call('GET', `/api/v1/Lead/${leadId}`)).body['status']).toBe('New');
    expect(await countRows('Contact')).toBe(contactsBefore);
  });

  it('refuses while the conversion switch is off, and names it', async () => {
    const leadId = await lead('switched');
    await setSettings({ features: { leadConversion: false } });
    const prepared = (await preview(leadId, [{ type: 'Contact', action: 'create' }])).body as unknown as PreviewBody;
    const result = await call('POST', CONVERT_PATH, {
      leadId,
      operationKey: `${RUN}_off_key`,
      targets: [{ type: 'Contact', action: 'create' }],
      previewHash: prepared.previewHash,
      acknowledged: prepared.confirmationTypes,
    });
    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(JSON.stringify(result.body)).toContain('leadConversion');
  });
});

describe('the affordance a screen asks before showing a button (19-LS.14, contract §12.2)', () => {
  it('answers yes for a convertible Lead, and names the references once it is converted', async () => {
    const leadId = await lead('affordance');
    const before = await call('GET', `${AFFORDANCE_PATH}?leadId=${encodeURIComponent(leadId)}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject({ canPreview: true, canConvert: true, canOverride: true, alreadyConverted: false, reasons: [] });

    const converted = await convert(leadId, [{ type: 'Contact', action: 'create' }]);
    expect(converted.status).toBe(200);

    const after = await call('GET', `${AFFORDANCE_PATH}?leadId=${encodeURIComponent(leadId)}`);
    expect(after.body).toMatchObject({
      canConvert: false,
      alreadyConverted: true,
      status: 'Converted',
      operationId: (converted.body as unknown as { operationId: string }).operationId,
      convertedContactId: (converted.body as unknown as { createdContactId: string }).createdContactId,
    });
    expect((after.body['reasons'] as string[])).toContain('already_converted');
  });

  it('answers no with reasons instead of an error when the caller holds no conversion right', async () => {
    const leadId = await lead('affordance no rights');
    const roleId = `${RUN}_no_conversion`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} no conversion`, permissions: { Lead: { read: 'all' } } });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_noconv`, roleIds: [roleId] });
    created.users.push(caller.id);

    const answer = await call('GET', `${AFFORDANCE_PATH}?leadId=${encodeURIComponent(leadId)}`, undefined, caller.token);
    expect(answer.status).toBe(200);
    expect(answer.body['canConvert']).toBe(false);
    expect((answer.body['reasons'] as string[])).toEqual(expect.arrayContaining(['cannot_preview', 'cannot_execute']));
  });

  it('refuses when the module is off, and answers a Lead it may not read as missing', async () => {
    const leadId = await lead('affordance doors');
    await setSettings({ enabled: false });
    const off = await call('GET', `${AFFORDANCE_PATH}?leadId=${encodeURIComponent(leadId)}`);
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('LEADSCORE_MODULE_DISABLED');
    await setSettings({ enabled: true });

    const roleId = `${RUN}_own_affordance`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} own affordance`, permissions: { Lead: { read: 'own' } } });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_ownaff`, roleIds: [roleId] });
    created.users.push(caller.id);
    const missing = await call('GET', `${AFFORDANCE_PATH}?leadId=${encodeURIComponent(leadId)}`, undefined, caller.token);
    expect(missing.status).toBe(404);
  });
});
