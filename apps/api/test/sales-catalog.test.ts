import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocumentSnapshot, readDocumentSnapshot } from '../src/sales/document/snapshot.js';
import type { ApiContext, TestUser } from './support/boot-api.js';
import { bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { reasonOf, salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.3 — Product catalog and categories.
 *
 * Acceptance criteria exercised here: authorized create/list/view/update/deactivate, the explicit
 * SKU uniqueness rule, server-side inactive/non-sellable gating, a restricted role not seeing the
 * cost price, and the guarantee that changing a catalog record cannot mutate an existing snapshot.
 */

let ctx: ApiContext;
let fix: SalesFixture;
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
}, 120_000);

afterAll(async () => {
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('product catalog (19-S.3)', () => {
  it('creates, lists, reads, updates and deactivates a product', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-MAIN`, unitPrice: '12.50', costPrice: '7.25', unit: 'pcs' });
    const created = await fix.call('GET', `/api/v1/Product/${productId}`);
    expect(created.status).toBe(200);
    // SKUs are stored in the documented normalized form: trimmed and upper-cased.
    expect(created.body['sku']).toBe(`AGENT-${fix.runId}-MAIN`.toUpperCase());
    expect(created.body['unitPrice']).toBe('12.50');
    expect(created.body['productType']).toBe('Goods');
    expect(created.body['active']).toBe(true);
    expect(created.body['isSellable']).toBe(true);

    const listed = await fix.call('GET', `/api/v1/Product?where=${encodeURIComponent(JSON.stringify([{ field: 'sku', operator: 'equals', value: `AGENT-${fix.runId}-MAIN`.toUpperCase() }]))}`);
    expect(listed.status).toBe(200);
    expect((listed.body['list'] as { id: string }[]).some((row) => row.id === productId)).toBe(true);

    const updated = await fix.call('PUT', `/api/v1/Product/${productId}`, { unitPrice: '13.75', unit: 'box' });
    expect(updated.status).toBe(200);
    expect(updated.body['unitPrice']).toBe('13.75');

    const deactivated = await fix.call('PUT', `/api/v1/Product/${productId}`, { active: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body['active']).toBe(false);
  });

  it('enforces SKU uniqueness case-insensitively across the installation', async () => {
    const sku = `AGENT-${fix.runId}-UNIQUE`;
    await fix.createProduct({ sku });
    const duplicate = await fix.call('POST', '/api/v1/Product', { name: `AGENT_TEST_${fix.runId} Duplicate`, sku: sku.toLowerCase() });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body['error'] as { code: string }).code).toBe('DUPLICATE_RECORD');
  });

  it('normalizes and validates the SKU format', async () => {
    const created = await fix.call('POST', '/api/v1/Product', { name: `AGENT_TEST_${fix.runId} Lower`, sku: `  agent-${fix.runId}-lower  ` });
    expect(created.status).toBe(201);
    // Trimmed and upper-cased: the same normalization the uniqueness check compares with.
    expect(created.body['sku']).toBe(`AGENT-${fix.runId}-LOWER`.toUpperCase());
    const invalid = await fix.call('POST', '/api/v1/Product', { name: `AGENT_TEST_${fix.runId} Bad`, sku: 'bad sku!' });
    expect(invalid.status).toBe(422);
  });

  it('refuses a non-canonical money value and a negative price', async () => {
    const notDecimal = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Money`,
      sku: `AGENT-${fix.runId}-MONEY`,
      unitPrice: '1e3',
    });
    expect(notDecimal.status).toBe(422);
    const negative = await fix.call('POST', '/api/v1/Product', {
      name: `AGENT_TEST_${fix.runId} Negative`,
      sku: `AGENT-${fix.runId}-NEG`,
      unitPrice: '-5.00',
    });
    expect(negative.status).toBe(422);
  });
});

describe('product categories (19-S.3)', () => {
  it('prevents self-parenting and cycles', async () => {
    const parent = await fix.createCategory();
    const child = await fix.createCategory({ parentId: parent });
    const selfParent = await fix.call('PUT', `/api/v1/ProductCategory/${parent}`, { parentId: parent });
    expect(selfParent.status).toBe(422);
    const cycle = await fix.call('PUT', `/api/v1/ProductCategory/${parent}`, { parentId: child });
    expect(cycle.status).toBe(422);
    expect(reasonOf(cycle)).toMatch(/sub-categories/);
  });

  it('accepts a deep hierarchy but refuses a four-level loop back to the root', async () => {
    const root = await fix.createCategory();
    const middle = await fix.createCategory({ parentId: root });
    const leaf = await fix.createCategory({ parentId: middle });
    const loop = await fix.call('PUT', `/api/v1/ProductCategory/${root}`, { parentId: leaf });
    expect(loop.status).toBe(422);
  });
});

describe('sellable gating (19-S.3)', () => {
  it('refuses to price an inactive or non-sellable product with the reason', async () => {
    const inactive = await fix.createProduct({ sku: `AGENT-${fix.runId}-INACTIVE`, unitPrice: '10.00', active: false });
    const inactiveResult = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId: inactive });
    expect(inactiveResult.status).toBe(422);
    expect(reasonOf(inactiveResult)).toMatch(/inactive/);

    const notSellable = await fix.createProduct({ sku: `AGENT-${fix.runId}-NOSALE`, unitPrice: '10.00', isSellable: false });
    const notSellableResult = await fix.call('POST', '/api/v1/Sales/action/resolvePrice', { productId: notSellable });
    expect(notSellableResult.status).toBe(422);
    expect(reasonOf(notSellableResult)).toMatch(/not sellable/);
  });
});

describe('field-level access (19-S.3)', () => {
  it('hides the cost price from a role that may not read it, while an administrator sees it', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-COST`, costPrice: '3.10', unitPrice: '9.99' });

    const roleId = `role-${fix.runId}-cost`;
    cleanupRoles.push(roleId);
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST ${fix.runId} cost-restricted`,
      permissions: { Product: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
      fieldPermissions: { Product: { costPrice: { read: 'no', edit: 'no' } } },
    });
    const user: TestUser = await createTestUser(ctx, { userName: `sales-cost-${fix.runId}`, roleIds: [roleId] });
    cleanupUsers.push(user.id);

    const restricted = await fix.call('GET', `/api/v1/Product/${productId}`, undefined, user.token);
    expect(restricted.status).toBe(200);
    expect(restricted.body['costPrice']).toBeUndefined();
    expect(restricted.body['unitPrice']).toBe('9.99');

    const admin = await fix.call('GET', `/api/v1/Product/${productId}`);
    expect(admin.body['costPrice']).toBe('3.10');

    // A field the role may not create is refused for that role; the admin path still works.
    const writeAttempt = await fix.call('PUT', `/api/v1/Product/${productId}`, { costPrice: '1.00' }, user.token);
    expect(writeAttempt.status).toBe(403);
  });

  it('refuses catalog reads to a role with no access at all', async () => {
    const user = await createTestUser(ctx, { userName: `sales-noaccess-${fix.runId}`, roleIds: ['noAccess'] });
    cleanupUsers.push(user.id);
    const listed = await fix.call('GET', '/api/v1/Product', undefined, user.token);
    expect(listed.status).toBe(403);
  });
});

describe('snapshot immutability (19-S.3)', () => {
  it('does not change a captured snapshot when the product is later edited or deactivated', async () => {
    const productId = await fix.createProduct({ sku: `AGENT-${fix.runId}-SNAP`, unitPrice: '20.00', name: `AGENT_TEST_${fix.runId} Snapshot Product` });
    const before = await fix.call('GET', `/api/v1/Product/${productId}`);
    const snapshot = buildDocumentSnapshot(`Product:${productId}`, {
      name: before.body['name'],
      sku: before.body['sku'],
      unitPrice: before.body['unitPrice'],
    });

    const updated = await fix.call('PUT', `/api/v1/Product/${productId}`, { name: `AGENT_TEST_${fix.runId} Renamed`, unitPrice: '99.00', active: false });
    expect(updated.status).toBe(200);

    const read = readDocumentSnapshot(snapshot);
    expect(read.name).toBe(`AGENT_TEST_${fix.runId} Snapshot Product`);
    expect(read.unitPrice).toBe('20.00');
    expect(read.sku).toBe(`AGENT-${fix.runId}-SNAP`.toUpperCase());
  });
});
