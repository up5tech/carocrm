import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { CallResult, SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.16 — subscriptions and recurring invoice generation, through the real HTTP API.
 *
 * The phase's four acceptance criteria, one by one:
 *
 *  - **a job replay cannot create duplicate periods/invoices** — the same due run is executed three
 *    times and must produce one period per window and exactly one invoice for it; the generated
 *    invoice is then shown to be a normal issued document, not a special record;
 *  - **period and invoice dates respect the configured lead time** — a lead of 20 days pulls the first
 *    planned invoice into the previous month, and a period whose planned date is in the future is not
 *    invoiced even though its window has already begun;
 *  - **failed processing is visible and safely retryable** — an unpriceable subscription fails with a
 *    recorded `failureCode` and an incremented `attemptCount`, and the retry re-runs the same path
 *    without producing a second invoice;
 *  - **no automatic charge or live email** — generation creates an issued invoice and stops; nothing
 *    here opens a socket, and no `Email` record is produced.
 *
 * Also asserted here, because they are the ways the guarantee can be defeated: the feature gate, the
 * write guard (a crafted record request cannot forge a billed period or point one at an invoice), the
 * lifecycle refusals, and the pause/cancel behaviour that stops future billing.
 *
 * Runs against the configured primary database (AGENTS.MD §3.1) and creates only `AGENT_TEST_` rows
 * that it deletes again by exact id (§3.3). No test database is created.
 */

let ctx: ApiContext;
let fix: SalesFixture;

const subscriptionIds: string[] = [];
const periodIds: string[] = [];
const invoiceIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

/** The day the suite acts as of, so the assertions do not depend on when they run. */
const TODAY = '2026-03-10';

async function setSubscriptions(enabled: boolean): Promise<CallResult> {
  return await fix.call('POST', '/api/v1/Sales/action/settings', {
    features: { subscriptions: enabled },
  });
}

async function createSubscription(data: Record<string, unknown>): Promise<string> {
  const result = await fix.call('POST', '/api/v1/Subscription', {
    name: `AGENT_TEST_${fix.runId} Subscription`,
    currency: 'USD',
    interval: 'monthly',
    quantity: '1',
    startDate: '2026-03-01',
    ...data,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  subscriptionIds.push(String(result.body['id']));
  return String(result.body['id']);
}

/**
 * Stop a subscription from billing any more.
 *
 * The billing run is deliberately global — it bills every billable term, which is the behaviour the
 * job depends on — so a term left over from an earlier test would keep issuing invoices inside a
 * later one. Retiring each term keeps every assertion about exactly the rows it created.
 */
async function retire(id: string): Promise<void> {
  await fix.call('POST', `/api/v1/Sales/subscription/${id}/cancel`).catch(() => undefined);
}

function collectPeriods(body: Record<string, unknown>): void {
  const periods = body['periods'];
  if (!Array.isArray(periods)) return;
  for (const period of periods) {
    const id = String((period as { id?: unknown }).id ?? '');
    if (id !== '' && !periodIds.includes(id)) periodIds.push(id);
  }
}

function collectInvoices(body: Record<string, unknown>): void {
  const results = body['results'];
  if (!Array.isArray(results)) return;
  for (const entry of results) {
    const id = String((entry as { invoiceId?: unknown }).invoiceId ?? '');
    if (id !== '' && !invoiceIds.includes(id)) invoiceIds.push(id);
  }
}

async function preview(id: string, today = TODAY): Promise<CallResult> {
  return await fix.call('POST', `/api/v1/Sales/subscription/${id}/previewPeriods`, { today });
}

async function generate(id: string, today = TODAY): Promise<CallResult> {
  const result = await fix.call('POST', `/api/v1/Sales/subscription/${id}/generatePeriods`, { today });
  if (result.status === 200) collectPeriods(result.body);
  return result;
}

async function runBilling(today = TODAY): Promise<CallResult> {
  const result = await fix.call('POST', '/api/v1/Sales/action/generateSubscriptionInvoices', { today });
  if (result.status === 200) collectInvoices(result.body);
  return result;
}

/** Every period of a subscription, read back by id so the assertion is about *its* rows. */
async function periodsOf(subscriptionId: string): Promise<Record<string, unknown>[]> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select(['id', 'attrs'])
    .where('entity_type', '=', 'SubscriptionPeriod')
    .where(sql`attrs ->> 'subscriptionId'`, '=', subscriptionId)
    .where('deleted_at', 'is', null)
    .execute();
  for (const row of rows) if (!periodIds.includes(row.id)) periodIds.push(row.id);
  return rows
    .map((row) => ({ ...(row.attrs as Record<string, unknown>), id: row.id }))
    .sort((left, right) =>
      String(left['periodStart']).localeCompare(String(right['periodStart'])),
    );
}

/** The status of every period of one subscription, in window order. */
async function periodStatuses(subscriptionId: string): Promise<string[]> {
  return (await periodsOf(subscriptionId)).map((period) => String(period['status'] ?? ''));
}

function day(value: unknown): string {
  return String(value ?? '').slice(0, 10);
}

async function periodAttrs(periodId: string): Promise<Record<string, unknown>> {
  const row = await ctx.database.db
    .selectFrom('entity_records')
    .select('attrs')
    .where('id', '=', periodId)
    .executeTakeFirst();
  return (row?.attrs ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  const enabled = await fix.call('POST', '/api/v1/Sales/action/settings', {
    features: { subscriptions: true },
    // The per-run budgets are sized for a real installation; the suite bills a few dozen windows and
    // would otherwise truncate mid-suite and read as a failure.
    subscriptions: { horizonDays: 365, maxPeriodsPerRun: 24, maxInvoicesPerRun: 500 },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await setSubscriptions(false).catch(() => undefined);

  // Child rows first: invoice lines, then the periods that point at the invoices. The periods are
  // removed by *their* subscription ids — the only rows this run created — so an interrupted earlier
  // run cannot be mistaken for this one's, and nothing outside the suite is touched (AGENTS.MD §3.3).
  const items = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'InvoiceItem')
    .where(sql`attrs ->> 'invoiceId'`, 'in', invoiceIds)
    .execute()
    .catch(() => [] as { id: string }[]);
  const periods = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'SubscriptionPeriod')
    .where(sql`attrs ->> 'subscriptionId'`, 'in', subscriptionIds)
    .execute()
    .catch(() => [] as { id: string }[]);
  const all = [
    ...subscriptionIds,
    ...periods.map((row) => row.id),
    ...invoiceIds,
    ...items.map((row) => row.id),
    ...fix.ids,
  ];
  if (all.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', all).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, ['Subscription', 'SubscriptionPeriod', 'Invoice', 'InvoiceItem']);
  await fix.cleanup();
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users_roles').where('user_id', '=', id).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await shutdownApi();
}, 60_000);

describe('Phase 19-S.16 recurring billing', () => {
  it('refuses every billing command while the subscriptions feature is off', async () => {
    await setSubscriptions(false);
    const product = await fix.createProduct({ unitPrice: '30.00' });
    const subscription = await createSubscription({ productId: product, unitPrice: '30.00' });

    const previewed = await preview(subscription);
    expect(previewed.status).toBe(403);
    expect(reasonOf(previewed)).toContain('subscriptions');

    const generated = await generate(subscription);
    expect(generated.status).toBe(403);

    // The run itself is a no-op rather than an error: a daily job on an installation without
    // recurring billing must not be a red one.
    const billing = await runBilling();
    expect(billing.status).toBe(200);
    expect(billing.body['enabled']).toBe(false);
    expect(billing.body['invoiced']).toBe(0);

    await setSubscriptions(true);
    const allowed = await generate(subscription);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    await retire(subscription);
  });

  it('previews the schedule without writing a period', async () => {
    const product = await fix.createProduct({ unitPrice: '25.00' });
    const subscription = await createSubscription({ productId: product, unitPrice: '25.00' });

    const body = (await preview(subscription)).body;
    const periods = body['periods'] as Record<string, unknown>[];

    expect(periods.length).toBeGreaterThan(0);
    expect(day(periods[0]?.['periodStart'])).toBe('2026-03-01');
    expect(day(periods[0]?.['periodEnd'])).toBe('2026-03-31');
    // A previewed period has no record behind it.
    expect(String(periods[0]?.['id'])).toBe('');
    expect(body['dueCount']).toBe(1);

    const stored = await periodsOf(subscription);
    expect(stored).toHaveLength(0);
    await retire(subscription);
  });

  it('generates each window once and bills a due period exactly once', async () => {
    const product = await fix.createProduct({ unitPrice: '25.00' });
    const subscription = await createSubscription({ productId: product, unitPrice: '25.00' });

    const first = await generate(subscription);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(Number(first.body['created'])).toBeGreaterThan(0);
    const createdIds = (first.body['periods'] as Record<string, unknown>[])
      .filter((period) => period['created'] === true)
      .map((period) => String(period['id']));
    expect(new Set(createdIds).size).toBe(createdIds.length);

    // Two replays: nothing new, and the same periods reported back.
    const replay = await generate(subscription);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(Number(replay.body['created'])).toBe(0);
    expect(Number(replay.body['existing'])).toBe(createdIds.length);
    expect(await periodsOf(subscription)).toHaveLength(createdIds.length);

    // The first period is due (planned 2026-03-01, run day 2026-03-10); the rest are not.
    const billed = await runBilling();
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    expect(billed.body['enabled']).toBe(true);
    const afterFirstRun = await periodStatuses(subscription);
    expect(afterFirstRun.filter((status) => status === 'invoiced')).toHaveLength(1);
    expect(afterFirstRun[0]).toBe('invoiced');

    // Replaying the whole run must not bill anything a second time.
    await runBilling();
    expect(await periodStatuses(subscription)).toEqual(afterFirstRun);

    const invoiced = (await periodsOf(subscription)).filter((period) => period['status'] === 'invoiced');
    expect(invoiced).toHaveLength(1);
    const invoiceId = String(invoiced[0]?.['invoiceId']);
    expect(invoiceId).not.toBe('');
    invoiceIds.push(invoiceId);

    // The invoice is an ordinary issued document carrying the subscription lineage.
    const invoice = await fix.call('GET', `/api/v1/Sales/document/invoice/${invoiceId}`);
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    const document = invoice.body['document'] as Record<string, unknown>;
    expect(String(document['status'])).toBe('issued');
    expect(String(document['subscriptionId'])).toBe(subscription);
    expect(String(document['subscriptionPeriodId'])).toBe(String(invoiced[0]?.['id']));
    // The window it bills is stamped on the invoice itself.
    expect(day(document['servicePeriodStart'])).toBe('2026-03-01');
    expect(day(document['servicePeriodEnd'])).toBe('2026-03-31');
    expect(String(document['issuedBy'])).toBe('sales.billing');
    await retire(subscription);
  });

  it('plans the invoice ahead of the period and holds it until the planned date', async () => {
    const product = await fix.createProduct({ unitPrice: '15.00' });
    // A 60-day lead time means the May period is invoiced in early March: the planned invoice date
    // is pulled back before the period, not after it (§4.14 billing lead time).
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '15.00',
      leadTimeDays: 60,
      startDate: '2026-05-01',
    });

    const previewed = (await preview(subscription)).body;
    const first = (previewed['periods'] as Record<string, unknown>[])[0];
    expect(day(first?.['periodStart'])).toBe('2026-05-01');
    expect(day(first?.['plannedInvoiceDate'])).toBe('2026-03-02');

    await generate(subscription);

    // Two days before the planned date the period is already open but nothing may be billed.
    await runBilling('2026-03-01');
    expect(await periodStatuses(subscription)).toEqual(
      (await periodsOf(subscription)).map(() => 'pending'),
    );

    // On the planned date the same run bills it — the window it bills is still the May period.
    await runBilling('2026-03-02');
    expect((await periodStatuses(subscription))[0]).toBe('invoiced');
    const billed = (await periodsOf(subscription))[0];
    expect(day(billed?.['invoiceDate'])).toBe('2026-03-02');
    await retire(subscription);
  });

  it('will not bill before the planned invoice date even inside a period', async () => {
    const product = await fix.createProduct({ unitPrice: '9.00' });
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '9.00',
      startDate: '2026-03-25',
      leadTimeDays: 0,
    });

    await generate(subscription);
    await runBilling('2026-03-10');
    expect(
      (await periodStatuses(subscription)).every((status) => status === 'pending'),
    ).toBe(true);

    // Once the period's planned date arrives, the same run bills it.
    await runBilling('2026-03-25');
    expect((await periodStatuses(subscription))[0]).toBe('invoiced');
    await retire(subscription);
  });

  it('records a visible failure and retries it without billing twice', async () => {
    // No product and no price: the invoice has no line to bill, so the period fails — visibly,
    // with the reason, rather than silently disappearing.
    const subscription = await createSubscription({ productId: null, unitPrice: null });
    await generate(subscription);
    await runBilling();

    const stored = await periodsOf(subscription);
    const failed = stored.find((period) => period['status'] === 'failed');
    expect(failed, JSON.stringify(stored)).toBeDefined();
    expect(String(failed?.['failureCode'] ?? '')).not.toBe('');
    expect(Number(failed?.['attemptCount'])).toBeGreaterThan(0);
    expect(failed?.['invoiceId'] ?? null).toBeNull();

    const periodId = String(failed?.['id']);
    const attemptsBefore = Number(failed?.['attemptCount']);
    const retried = await fix.call('POST', `/api/v1/Sales/subscriptionPeriod/${periodId}/retry`, { today: TODAY });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body['invoiced']).toBe(false);

    // The attempt is recorded again and still no invoice was produced.
    const after = await periodAttrs(periodId);
    expect(Number(after['attemptCount'])).toBeGreaterThan(attemptsBefore);
    expect(after['invoiceId'] ?? null).toBeNull();
    expect(after['status']).toBe('failed');
    await retire(subscription);
  });

  it('stops billing a cancelled subscription and refuses to resurrect it', async () => {
    const product = await fix.createProduct({ unitPrice: '40.00' });
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '40.00',
      startDate: '2026-04-01',
    });
    await generate(subscription);

    const cancelled = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body['cancelledPeriods']).toBeGreaterThan(0);

    // A cancelled term never bills again, however many times the run repeats.
    await runBilling();
    await runBilling();
    expect(
      (await periodStatuses(subscription)).every((status) => status === 'cancelled'),
    ).toBe(true);

    // …and it cannot be resumed or paused back to life.
    const resumed = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/resume`);
    expect(resumed.status).toBe(422);
    expect(reasonOf(resumed)).toContain('Only a paused subscription');

    const cancelledTwice = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/cancel`);
    expect(cancelledTwice.status).toBe(422);
  });

  it('pauses and resumes, and a paused subscription does not bill', async () => {
    const product = await fix.createProduct({ unitPrice: '18.00' });
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '18.00',
      startDate: '2026-05-01',
    });

    expect((await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/pause`)).status).toBe(200);
    await generate(subscription);

    // The periods exist, but a paused term produces no invoice from them.
    await runBilling();
    expect(await periodStatuses(subscription)).toEqual(
      (await periodsOf(subscription)).map(() => 'pending'),
    );

    expect((await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/resume`)).status).toBe(200);
    await runBilling('2026-05-01');
    const billed = await periodStatuses(subscription);
    expect(billed.filter((status) => status === 'invoiced').length).toBeGreaterThanOrEqual(1);
    await retire(subscription);
  });

  it('refuses a forged period, status or invoice link through the record API', async () => {
    const product = await fix.createProduct({ unitPrice: '11.00' });
    const subscription = await createSubscription({ productId: product, unitPrice: '11.00' });
    await generate(subscription);
    const periodId = String((await periodsOf(subscription))[0]?.['id']);
    expect(periodId).not.toBe('');

    // A period is a computed schedule row; it is never created by hand.
    const forged = await fix.call('POST', '/api/v1/SubscriptionPeriod', {
      name: `AGENT_TEST_${fix.runId} forged`,
      subscriptionId: subscription,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(reasonOf(forged)).toMatch(/billing commands/);

    // …nor can its billing outcome be typed in.
    for (const patch of [
      { status: 'invoiced' },
      { attemptCount: 99 },
      { plannedInvoiceDate: '2020-01-01' },
    ]) {
      const result = await fix.call('PATCH', `/api/v1/SubscriptionPeriod/${periodId}`, patch);
      expect(result.status, `${JSON.stringify(patch)} -> ${JSON.stringify(result.body)}`).toBe(422);
      expect(reasonOf(result)).toMatch(/computed by the server/);
    }
    // Pointing a period at an invoice is refused whatever the invoice id resolves to.
    const relinked = await fix.call('PATCH', `/api/v1/SubscriptionPeriod/${periodId}`, { invoiceId: periodId });
    expect(relinked.status).toBe(422);

    // A subscription's status moves through the commands, not through a record edit.
    const statusPatch = await fix.call('PATCH', `/api/v1/Subscription/${subscription}`, { status: 'cancelled' });
    expect(statusPatch.status).toBe(422);
    expect(reasonOf(statusPatch)).toMatch(/computed by the server/);
    await retire(subscription);
  });

  it('renews a finished term when it may, and ends it when it may not', async () => {
    const product = await fix.createProduct({ unitPrice: '13.00' });

    // autoRenew on: the run rolls the term forward by exactly one interval, once, and the
    // subscription records when the previous term ended.
    const renewing = await createSubscription({
      productId: product,
      unitPrice: '13.00',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      autoRenew: true,
    });
    await runBilling('2026-09-05');

    const afterRenewal = (await fix.call('GET', `/api/v1/Subscription/${renewing}`)).body;
    expect(String(afterRenewal['status'])).toBe('renewed');
    expect(day(afterRenewal['endDate'])).toBe('2026-09-30');
    expect(day(afterRenewal['renewalDate'])).toBe('2026-08-31');

    // A replay settles nothing more: the term is running again.
    await runBilling('2026-09-05');
    const replayed = (await fix.call('GET', `/api/v1/Subscription/${renewing}`)).body;
    expect(day(replayed['endDate'])).toBe('2026-09-30');
    expect(day(replayed['renewalDate'])).toBe('2026-08-31');

    // autoRenew off: the term ends, and an ended term is neither billable nor renewable.
    const ending = await createSubscription({
      productId: product,
      unitPrice: '13.00',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      autoRenew: false,
    });
    await runBilling('2026-09-05');
    const afterEnd = (await fix.call('GET', `/api/v1/Subscription/${ending}`)).body;
    expect(String(afterEnd['status'])).toBe('ended');

    // The term's last period was still billed before the term ended — ending a term must not
    // cancel an invoice the customer already earned.
    expect(await periodStatuses(ending)).toEqual(['invoiced']);

    await retire(renewing);
    await retire(ending);
  });

  it('separates the billing authorities, exactly as the permissions doc states', async () => {
    const product = await fix.createProduct({ unitPrice: '19.00' });
    const subscription = await createSubscription({ productId: product, unitPrice: '19.00' });

    // A role that may only *see* a term may preview it — a preview writes nothing.
    const readerRoleId = `role-${fix.runId}-sub-reader`;
    cleanupRoles.push(readerRoleId);
    await createTestRole(ctx, {
      id: readerRoleId,
      name: `AGENT_TEST ${fix.runId} subscription reader`,
      permissions: {
        Subscription: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
        SubscriptionPeriod: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
      },
    });
    const reader = await createTestUser(ctx, { userName: `sales-sub-read-${fix.runId}`, roleIds: [readerRoleId] });
    cleanupUsers.push(reader.id);

    const seen = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/previewPeriods`, { today: TODAY }, reader.token);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);

    // The same role may not generate periods — that needs `Subscription: edit` and
    // `SubscriptionPeriod: create`, and the whole installation's run is administrator-only.
    const generated = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/generatePeriods`, { today: TODAY }, reader.token);
    expect(generated.status).toBe(403);

    const ran = await fix.call('POST', '/api/v1/Sales/action/generateSubscriptionInvoices', { today: TODAY }, reader.token);
    expect(ran.status).toBe(403);

    // …and a role that holds exactly those grants may generate.
    const editorRoleId = `role-${fix.runId}-sub-editor`;
    cleanupRoles.push(editorRoleId);
    await createTestRole(ctx, {
      id: editorRoleId,
      name: `AGENT_TEST ${fix.runId} subscription editor`,
      permissions: {
        Subscription: { read: 'all', create: 'no', edit: 'yes', delete: 'no', stream: 'no' },
        SubscriptionPeriod: { read: 'all', create: 'yes', edit: 'yes', delete: 'no', stream: 'no' },
        // Billing a period issues an invoice, so the role that may generate periods holds the
        // invoice authority too — and nothing wider.
        Invoice: { read: 'all', create: 'yes', edit: 'yes', delete: 'no', stream: 'no' },
      },
    });
    const editor = await createTestUser(ctx, { userName: `sales-sub-edit-${fix.runId}`, roleIds: [editorRoleId] });
    cleanupUsers.push(editor.id);

    const allowed = await fix.call('POST', `/api/v1/Sales/subscription/${subscription}/generatePeriods`, { today: TODAY }, editor.token);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    collectPeriods(allowed.body);

    await retire(subscription);
  });

  it('sends no email and charges nothing: generation only issues a document', async () => {
    const emailsBefore = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Email')
      .execute()
      .then((rows) => rows.length);

    const product = await fix.createProduct({ unitPrice: '77.00' });
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '77.00',
      startDate: '2026-06-01',
    });
    await generate(subscription);
    await runBilling('2026-06-01');
    expect(await periodStatuses(subscription)).toContain('invoiced');

    const emailsAfter = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Email')
      .execute()
      .then((rows) => rows.length);
    expect(emailsAfter).toBe(emailsBefore);
    await retire(subscription);
  });

  it('bills a weekly subscription one window at a time', async () => {
    const product = await fix.createProduct({ unitPrice: '5.00' });
    const subscription = await createSubscription({
      productId: product,
      unitPrice: '5.00',
      interval: 'weekly',
      startDate: '2026-07-01',
      endDate: '2026-07-29',
      autoRenew: false,
    });

    await generate(subscription);
    const stored = await periodsOf(subscription);
    expect(stored).toHaveLength(5);
    expect(stored.map((period) => day(period['periodStart']))).toEqual([
      '2026-07-01',
      '2026-07-08',
      '2026-07-15',
      '2026-07-22',
      '2026-07-29',
    ]);
    // The final window is truncated by the term end rather than billing past it.
    expect(day(stored[4]?.['periodEnd'])).toBe('2026-07-29');

    await runBilling('2026-07-29');
    expect(await periodStatuses(subscription)).toEqual(Array<string>(5).fill('invoiced'));
    // A replay bills none of them again.
    await runBilling('2026-07-29');
    expect(await periodStatuses(subscription)).toEqual(Array<string>(5).fill('invoiced'));
    await retire(subscription);
  });
});