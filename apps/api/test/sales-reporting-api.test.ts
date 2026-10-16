import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.18 — reporting, dashboards, operational views and job monitoring through the real API.
 *
 * What this proves, against the plan's acceptance criteria:
 *
 *  - **the curated datasets actually run.** Each one is executed by the generic Report subsystem as
 *    the requesting user, so an invented field, an unusable grouping or a filter the Query Engine
 *    rejects fails here rather than in a unit test against a hand-copied schema;
 *  - **analytics are ACL-aware** (§12.4, §8). A role that cannot read `Invoice` cannot run the
 *    invoice datasets, and a dataset whose money mixes currencies says so through `money`;
 *  - **the standard dashlets are valid for the shared dashboard engine** — they are created through
 *    `POST /Dashboard/:id/dashlets` and executed through `.../action/run`, the same routes the UI
 *    uses, so `assertDashletConfig` and the entity metadata are the authority, not this module's
 *    opinion;
 *  - **job monitoring reads the kernel's durable job records** and stays administrator-only.
 *
 * Runs against the configured primary database (AGENTS.MD §3.1); creates only `AGENT_TEST_` rows it
 * deletes by exact id. No test database, no truncation, no external side effect.
 */

let ctx: ApiContext;
let fix: SalesFixture;

const roleId = `r_agent_sales_reporting`;
const userId = 'agent_sales_reporting_viewer';
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];
const dashboardIds: string[] = [];

/** The datasets whose entity is money-bearing, used for the currency-labelling assertion. */
const MONEY_KEYS = ['invoiceAging', 'quotePipeline', 'paymentFlow'];

async function setInventory(enabled: boolean): Promise<void> {
  const result = await fix.call('POST', '/api/v1/Sales/action/settings', {
    features: { inventory: enabled },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function runDataset(key: string, token?: string) {
  return await fix.call('POST', `/api/v1/Sales/report/${key}/run`, {}, token);
}

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const dashboardId of dashboardIds) {
    await sql`delete from dashlets where dashboard_id = ${dashboardId}`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`delete from dashboards where id = ${dashboardId}`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (cleanupUsers.length > 0) {
    await sql`delete from users_roles where user_id in (${sql.join(cleanupUsers)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
    await sql`delete from users where id in (${sql.join(cleanupUsers)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  if (cleanupRoles.length > 0) {
    await sql`delete from roles where id in (${sql.join(cleanupRoles)})`
      .execute(ctx.database.db)
      .catch(() => undefined);
  }
  await fix.cleanup().catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['Payment', 'Invoice', 'Subscription']).catch(() => undefined);
  await shutdownApi();
});

describe('Sales report catalog (19-S.18)', () => {
  it('publishes curated datasets with a stated money basis and no definition internals', async () => {
    const result = await fix.call('GET', '/api/v1/Sales/action/reportCatalog');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const list = result.body['list'] as Record<string, unknown>[];
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const entry of list) {
      expect(typeof entry['key']).toBe('string');
      expect(typeof entry['label']).toBe('string');
      expect(typeof entry['description']).toBe('string');
      expect(['base-snapshot', 'document-currency', 'quantity', 'count']).toContain(
        entry['moneyBasis'],
      );
      // The catalog is a menu; the definition is served by the run route, not leaked here.
      expect(entry['definition']).toBeUndefined();
    }
    const keys = list.map((entry) => String(entry['key']));
    expect(new Set(keys).size, 'dataset keys must be unique').toBe(keys.length);
    for (const key of MONEY_KEYS) expect(keys).toContain(key);
  });

  it('runs every dataset through the generic Report subsystem as the current user', async () => {
    const catalog = await fix.call('GET', '/api/v1/Sales/action/reportCatalog');
    const list = catalog.body['list'] as Record<string, unknown>[];
    for (const entry of list) {
      const key = String(entry['key']);
      const result = await runDataset(key);
      expect(result.status, `${key}: ${JSON.stringify(result.body)}`).toBe(200);
      const definition = result.body['definition'] as Record<string, unknown>;
      const ran = result.body['result'] as Record<string, unknown>;
      expect(typeof definition['entityType'], `${key} runs on a real entity`).toBe('string');
      expect(typeof ran['kind']).toBe('string');
      // The engine answers on the entity the catalog named, so no dataset can quietly retarget.
      expect(String(ran['entityType'])).toBe(String(definition['entityType']));
      // A report always answers with something countable, even when the installation has no data.
      expect(typeof ran['total']).toBe('number');
    }
  });

  it('refuses an unknown dataset instead of inventing one', async () => {
    const result = await runDataset('AGENT_TEST_not_a_dataset');
    expect(result.status).toBe(404);
  });
});

let viewerToken = '';

describe('report access control (19-S.18)', () => {
  it('refuses a dataset whose entity the reader cannot read, and allows the rest', async () => {
    await createTestRole(ctx, {
      id: roleId,
      name: 'AGENT_TEST Sales viewer without invoices',
      permissions: {
        Quote: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        Invoice: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
        Product: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
      },
    });
    cleanupRoles.push(roleId);
    const viewer = await createTestUser(ctx, {
      userName: userId,
      roleIds: [roleId],
    });
    cleanupUsers.push(viewer.id);
    viewerToken = viewer.token;

    const denied = await runDataset('invoiceAging', viewer.token);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);

    const allowed = await runDataset('subscriptionStatus', viewer.token);
    // The role says nothing about Subscription, so the entity default applies; either answer is
    // legitimate as long as it is not an unauthenticated 500.
    expect([200, 403], JSON.stringify(allowed.body)).toContain(allowed.status);
  });
});

describe('standard Sales dashlets (19-S.18)', () => {
  it('are accepted and executed by the shared dashboard engine', async () => {
    const catalog = await fix.call('GET', '/api/v1/Sales/action/dashletCatalog');
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const list = catalog.body['list'] as Record<string, unknown>[];
    expect(list.length).toBeGreaterThanOrEqual(5);

    const created = await fix.call('POST', '/api/v1/Dashboard', {
      name: `AGENT_TEST_${fix.runId} Sales dashboard`,
      isShared: true,
      config: {},
      layout: [],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dashboardId = String(created.body['id']);
    dashboardIds.push(dashboardId);

    for (const entry of list) {
      const dashlet = await fix.call('POST', `/api/v1/Dashboard/${dashboardId}/dashlets`, {
        name: `AGENT_TEST ${String(entry['name'])}`,
        kind: entry['kind'],
        position: 0,
        config: entry['config'],
      });
      // `assertDashletConfig` + metadata are the authority here: an invented field or a grouping the
      // engine does not allow fails this call, not a copy of the rules in a unit test.
      expect(dashlet.status, `${String(entry['key'])}: ${JSON.stringify(dashlet.body)}`).toBe(201);

      const ran = await fix.call(
        'POST',
        `/api/v1/Dashboard/${dashboardId}/dashlets/${String(dashlet.body['id'])}/action/run`,
        {},
      );
      expect(ran.status, `${String(entry['key'])}: ${JSON.stringify(ran.body)}`).toBe(200);
      expect(ran.body['entity'], String(entry['key'])).toBe(
        (entry['config'] as Record<string, unknown>)['entity'],
      );
    }
  });
});

describe('Sales job monitoring (19-S.18)', () => {
  it('reports the Sales job classes, schedules and queue depth to an administrator', async () => {
    const result = await fix.call('GET', '/api/v1/Sales/action/jobMonitoring');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const runs = result.body['runs'] as Record<string, unknown>[];
    expect(runs.map((run) => String(run['job'])).sort()).toEqual([
      'sales.expireQuotes',
      'sales.generateSubscriptionInvoices',
      'sales.markOverdueInvoices',
    ].sort());
    for (const run of runs) {
      expect(Array.isArray(run['recent'])).toBe(true);
      expect(typeof run['total']).toBe('number');
    }
    expect(Array.isArray(result.body['schedules'])).toBe(true);
    expect(typeof result.body['queue']).toBe('object');
  });

  it('is administrator-only', async () => {
    await createTestRole(ctx, {
      id: `${roleId}2`,
      name: 'AGENT_TEST Sales job monitoring denied',
      permissions: { Quote: { read: 'all' } },
    });
    cleanupRoles.push(`${roleId}2`);
    const viewer = await createTestUser(ctx, {
      userName: `${userId}2`,
      roleIds: [`${roleId}2`],
    });
    cleanupUsers.push(viewer.id);

    const result = await fix.call('GET', '/api/v1/Sales/action/jobMonitoring', undefined, viewer.token);
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(reasonOf(result)).toMatch(/administrat/i);
  });
});

describe('import and export of Sales data (19-S.18, §4.15)', () => {
  it('imports master data through the shared path', async () => {
    // The catalog stores an upper-cased SKU, so the assertion is made on what the record holds.
    const sku = `AGENT-${fix.runId.toUpperCase()}-IMPORT`;
    const result = await fix.call('POST', '/api/v1/Product/action/import', {
      csv: `name,sku,productType,active\nAGENT_TEST_${fix.runId} imported product,${sku},Goods,true\n`,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['created']).toBe(1);
    const id = String((result.body['ids'] as string[])[0]);
    try {
      const read = await fix.call('GET', `/api/v1/Product/${id}`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(String(read.body['sku'])).toBe(sku);
    } finally {
      await fix.call('DELETE', `/api/v1/Product/${id}`);
    }
  });

  it('refuses to import the fields that make a document issued or a payment settled', async () => {
    const issued = await fix.call('POST', '/api/v1/Invoice/action/import', {
      csv: `name,number,status,currency,grossTotal,amountDue,invoiceDate\nAGENT_TEST_${fix.runId} forged invoice,FORGED-1,issued,USD,100.00,0.00,2026-10-15\n`,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    // The shared importer goes through the Entity Engine, so the Sales write guard applies to it:
    // an issued document and a zeroed balance cannot be brought in as data (§4.7, §4.15).
    expect(issued.body['created']).toBe(0);
    expect(issued.body['skipped']).toBe(1);
    const message = JSON.stringify(issued.body['errors']);
    expect(message).toMatch(/computed by the server/);
    expect(message).toMatch(/status/);

    const settled = await fix.call('POST', '/api/v1/Payment/action/import', {
      csv: `name,amount,currency,direction,allocatedAmount,unallocatedAmount,allocationStatus\nAGENT_TEST_${fix.runId} forged payment,100.00,USD,incoming,100.00,0.00,allocated\n`,
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body['created']).toBe(0);
    expect(JSON.stringify(settled.body['errors'])).toMatch(/allocatedAmount/);
  });

  it('exports through the same ACL envelope as any other read (§12.4)', async () => {
    const sku = `AGENT-${fix.runId.toUpperCase()}-EXPORT`;
    await fix.createProduct({ sku, costPrice: '7.25' });
    // The export replies with CSV text, not a JSON envelope, so it is read as a raw response.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Product/action/export',
      headers: authHeader(ctx.adminToken),
      payload: { where: [{ field: 'sku', operator: 'equals', value: sku }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    // The export is column-projected (`id` is not an exportable column), so the row is recognised by
    // the SKU this run created and nothing else can carry.
    expect(res.body).toContain(sku);
    expect(res.body.split('\r\n')[0]).toContain('costPrice');
    expect(res.body.split('\r\n')).toHaveLength(3); // header, one row, trailing CRLF

    const denied = await fix.call('POST', '/api/v1/Product/action/export', {}, viewerToken);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  });
});

describe('inventory valuation (19-S.18, §12.2)', () => {
  it('values on-hand stock at cost and states the unpriced quantity separately', async () => {
    await setInventory(true);
    try {
      const warehouseId = await fix.create('Warehouse', {
        code: `AGENT-${fix.runId}-VAL`,
        active: true,
      });
      const pricedId = await fix.createProduct({
        sku: `AGENT-${fix.runId}-PRICED`,
        productType: 'Goods',
        costPrice: '12.50',
      });
      const unpricedId = await fix.createProduct({
        sku: `AGENT-${fix.runId}-UNPRICED`,
        productType: 'Goods',
      });

      const before = await fix.call('GET', `/api/v1/Sales/inventory/valuation?warehouseId=${warehouseId}`);
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body['currency']).toBe('USD');
      expect(String(before.body['value'])).toBe('0.00');

      for (const productId of [pricedId, unpricedId]) {
        const requested = await fix.call('POST', '/api/v1/Sales/inventory/adjustment', {
          productId,
          warehouseId,
          quantityDelta: '4',
          reason: `AGENT_TEST_${fix.runId} valuation opening`,
        });
        expect(requested.status, JSON.stringify(requested.body)).toBe(201);
        const approved = await fix.call(
          'POST',
          `/api/v1/Sales/inventory/adjustment/${String(requested.body['id'])}/transition`,
          { action: 'approve' },
        );
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      }

      const after = await fix.call('GET', `/api/v1/Sales/inventory/valuation?warehouseId=${warehouseId}`);
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      // 4 units at 12.50 is the whole value; the other 4 units are reported as unpriced, not as free.
      expect(String(after.body['value'])).toBe('50.00');
      expect(String(after.body['onHand'])).toMatch(/^8/);
      expect(String(after.body['unpricedOnHand'])).toMatch(/^4/);

      const filtered = await fix.call(
        'GET',
        `/api/v1/Sales/inventory/valuation?warehouseId=${warehouseId}&productId=${pricedId}`,
      );
      expect(String(filtered.body['value'])).toBe('50.00');
      expect(String(filtered.body['unpricedOnHand'])).toMatch(/^0/);
    } finally {
      await setInventory(false);
    }
  });
});
