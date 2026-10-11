import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string | string[] | undefined>;
}

const runId = `e${Date.now().toString(36)}`;

let ctx: ApiContext;
let token = '';

async function call(method: Method, url: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
}

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

beforeAll(async () => {
  ctx = await bootApi();
  token = ctx.adminToken;
});

afterAll(async () => {
  await shutdownApi();
});

describe('generic entity API — metadata driven fields', () => {
  const tierField = `customerTier${runId.replace(/^\w/, (c) => c.toUpperCase())}`;

  it('registers a dynamic field through POST /Metadata/Account', async () => {
    const res = await call('POST', '/api/v1/Metadata/Account', { fields: { [tierField]: { type: 'varchar' } } });
    expect(res.status).toBe(200);

    const meta = await call('GET', '/api/v1/Metadata/Account');
    const fields = meta.body['fields'] as Record<string, { type: string }>;
    expect(fields[tierField]?.type).toBe('varchar');
  });

  it('creates, reads and updates a record carrying the dynamic field', async () => {
    const created = await call('POST', '/api/v1/Account', {
      name: `Acme ${runId}`,
      [tierField]: 'Gold',
      website: 'https://acme.example',
    });
    expect(created.status).toBe(201);
    const body = created.body;
    const id = String(body['id']);
    expect(id).toBeTruthy();
    expect(body['name']).toBe(`Acme ${runId}`);
    expect(body[tierField]).toBe('Gold');
    expect(body['version']).toBe(1);
    expect(Array.isArray(body['teams'])).toBe(true);
    expect(typeof body['createdAt']).toBe('string');

    const read = await call('GET', `/api/v1/Account/${id}`);
    expect(read.status).toBe(200);
    expect(read.body[tierField]).toBe('Gold');

    const updated = await call('PATCH', `/api/v1/Account/${id}`, { [tierField]: 'Silver', version: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body[tierField]).toBe('Silver');
    expect(updated.body['version']).toBe(2);
  });

  it('rejects a stale version with 409 CONCURRENCY_CONFLICT', async () => {
    const created = await call('POST', '/api/v1/Account', { name: `Stale ${runId}` });
    const id = String(created.body['id']);

    const first = await call('PUT', `/api/v1/Account/${id}`, { name: `Stale ${runId} v2`, version: 1 });
    expect(first.status).toBe(200);

    const stale = await call('PUT', `/api/v1/Account/${id}`, { name: 'Stale again', version: 1 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale.body)).toBe('CONCURRENCY_CONFLICT');
  });

  it('writes outbox events for record mutations', async () => {
    const created = await call('POST', '/api/v1/Account', { name: `Outbox ${runId}` });
    const id = String(created.body['id']);
    await call('DELETE', `/api/v1/Account/${id}`);

    const rows = await ctx.database.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('status', '=', 'pending')
      .execute();
    // Entity events identify the record by `entityId` inside the payload (PLAN §23.2).
    const forRecord = rows.filter((row) => (row.payload as { entityId?: string }).entityId === id);
    expect(forRecord.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(['entity.created', 'entity.deleted']),
    );
    expect(forRecord[0]?.payload).toMatchObject({ entityType: 'Account' });
  });
});

describe('generic entity API — query grammar', () => {
  let accountId = '';

  beforeAll(async () => {
    const created = await call('POST', '/api/v1/Account', {
      name: `Query ${runId}`,
      type: 'Customer',
      industry: 'Software',
    });
    accountId = String(created.body['id']);
  });

  it('filters with equals and case-insensitive like', async () => {
    const where = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]));
    const res = await call('GET', `/api/v1/Account?where=${where}`);
    expect(res.status).toBe(200);
    const list = res.body['list'] as Record<string, unknown>[];
    expect(list.some((item) => item['id'] === accountId)).toBe(true);

    // ANDed with this record's id so shared-database rows cannot page it out (§3.3)
    const exact = encodeURIComponent(JSON.stringify([
      { field: 'id', operator: 'equals', value: accountId },
      { field: 'industry', operator: 'equals', value: 'Software' },
    ]));
    const exactRes = await call('GET', `/api/v1/Account?where=${exact}`);
    const exactList = exactRes.body['list'] as Record<string, unknown>[];
    expect(exactList.every((item) => item['industry'] === 'Software')).toBe(true);
    expect(exactList.some((item) => item['id'] === accountId)).toBe(true);
  });

  it('accepts a single where object and honours select/orderBy/maxSize/offset', async () => {
    const single = encodeURIComponent(JSON.stringify({ name: `Query ${runId}` }));
    const res = await call('GET', `/api/v1/Account?where=${single}&select=id,name&orderBy=-name&maxSize=1&offset=0`);
    expect(res.status).toBe(200);
    const list = res.body['list'] as Record<string, unknown>[];
    expect(list.length).toBeLessThanOrEqual(1);
    expect(Object.keys(list[0] ?? {})).toEqual(expect.arrayContaining(['id', 'name']));
    expect(res.body['total']).toBeGreaterThanOrEqual(1);

    const page = await call('GET', `/api/v1/Account?orderBy=createdAt,desc&maxSize=1&offset=1`);
    expect(page.status).toBe(200);
    expect((page.body['list'] as unknown[]).length).toBeLessThanOrEqual(1);
  });

  it('supports in / isNull / between operators', async () => {
    const inWhere = encodeURIComponent(JSON.stringify([{ field: 'id', operator: 'in', value: [accountId] }]));
    const inRes = await call('GET', `/api/v1/Account?where=${inWhere}`);
    expect((inRes.body['list'] as unknown[]).length).toBe(1);

    // Scoped to this test's own record so shared-database data cannot page it out (AGENTS.md §3.3).
    const nullWhere = encodeURIComponent(
      JSON.stringify([
        { field: 'id', operator: 'equals', value: accountId },
        { field: 'billingAddressCity', operator: 'isNull' },
      ]),
    );
    const nullRes = await call('GET', `/api/v1/Account?where=${nullWhere}`);
    expect((nullRes.body['list'] as unknown[]).length).toBe(1);

    const stamp = new Date().toISOString();
    const between = encodeURIComponent(
      JSON.stringify([{ field: 'createdAt', operator: 'between', value: ['2000-01-01T00:00:00.000Z', stamp] }]),
    );
    const betweenRes = await call('GET', `/api/v1/Account?where=${between}`);
    expect(betweenRes.status).toBe(200);
    expect((betweenRes.body['list'] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('supports notEquals / isNotNull / notIn on attrs', async () => {
    // Each criterion is ANDed with this record's id so shared-database rows cannot page it out (§3.3).
    const notEquals = encodeURIComponent(
      JSON.stringify([
        { field: 'id', operator: 'equals', value: accountId },
        { field: 'industry', operator: 'notEquals', value: 'Software' },
      ]),
    );
    const res = await call('GET', `/api/v1/Account?where=${notEquals}`);
    expect(res.status).toBe(200);
    expect((res.body['list'] as unknown[]).length).toBe(0);

    const notNull = encodeURIComponent(
      JSON.stringify([
        { field: 'id', operator: 'equals', value: accountId },
        { field: 'type', operator: 'isNotNull' },
      ]),
    );
    const notNullRes = await call('GET', `/api/v1/Account?where=${notNull}`);
    expect((notNullRes.body['list'] as unknown[]).length).toBe(1);

    const notIn = encodeURIComponent(JSON.stringify([{ field: 'id', operator: 'notIn', value: [accountId] }]));
    const notInRes = await call('GET', `/api/v1/Account?where=${notIn}`);
    expect((notInRes.body['list'] as Record<string, unknown>[]).some((item) => item['id'] === accountId)).toBe(false);
  });

  it('compares and orders numeric attrs with a typed cast', async () => {
    const low = await call('POST', '/api/v1/Opportunity', { name: `Low ${runId}`, probability: 25 });
    const high = await call('POST', '/api/v1/Opportunity', { name: `High ${runId}`, probability: 80 });
    expect(low.status).toBe(201);
    expect(high.status).toBe(201);

    // restricted to this test's two records so shared-database rows cannot page them out (§3.3)
    const where = encodeURIComponent(
      JSON.stringify([
        {
          or: [
            { field: 'id', operator: 'equals', value: String(low.body['id']) },
            { field: 'id', operator: 'equals', value: String(high.body['id']) },
          ],
        },
        { field: 'probability', operator: 'greaterThanOrEqual', value: 50 },
      ]),
    );
    const res = await call('GET', `/api/v1/Opportunity?where=${where}&orderBy=-probability`);
    expect(res.status).toBe(200);
    const list = res.body['list'] as Record<string, unknown>[];
    expect(list.map((item) => String(item['id']))).toEqual([String(high.body['id'])]);
    expect(Number(list[0]?.['probability'])).toBeGreaterThanOrEqual(50);
  });

  it('supports or-groups in a where array', async () => {
    const where = encodeURIComponent(
      JSON.stringify([
        { field: 'id', operator: 'equals', value: accountId },
        { or: [{ field: 'industry', operator: 'equals', value: 'Software' }, { field: 'industry', operator: 'equals', value: 'Mining' }] },
      ]),
    );
    const res = await call('GET', `/api/v1/Account?where=${where}`);
    expect(res.status).toBe(200);
    expect((res.body['list'] as Record<string, unknown>[]).some((item) => item['id'] === accountId)).toBe(true);
  });

  it('rejects an unknown operator', async () => {
    const where = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'ILIKE%0', value: 'x' }]));
    const res = await call('GET', `/api/v1/Account?where=${where}`);
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toBe('INVALID_QUERY');
  });

  it('rejects unknown fields and unknown entities', async () => {
    const bad = encodeURIComponent(JSON.stringify([{ field: 'nopeNoSuchField', operator: 'equals', value: 'x' }]));
    const res = await call('GET', `/api/v1/Account?where=${bad}`);
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toBe('INVALID_QUERY');

    const unknownEntity = await call('GET', '/api/v1/NopeUnknown');
    expect(unknownEntity.status).toBe(404);

    const injection = encodeURIComponent(JSON.stringify([{ field: 'name"; drop table entity_records --', operator: 'equals', value: 'x' }]));
    const safe = await call('GET', `/api/v1/Account?where=${injection}`);
    expect(safe.status).toBe(400);
  });
});

describe('generic entity API — soft delete and restore', () => {
  it('hides deleted records from lists and restores them', async () => {
    const created = await call('POST', '/api/v1/Account', { name: `Deleted ${runId}` });
    const id = String(created.body['id']);

    const removed = await call('DELETE', `/api/v1/Account/${id}`);
    expect(removed.status).toBe(200);
    expect(removed.body['status']).toBe(true);

    const gone = await call('GET', `/api/v1/Account/${id}`);
    expect(gone.status).toBe(404);
    expect(errorOf(gone.body)).toBe('RECORD_NOT_FOUND');

    const where = encodeURIComponent(JSON.stringify([{ field: 'id', operator: 'equals', value: id }]));
    const listed = await call('GET', `/api/v1/Account?where=${where}`);
    expect((listed.body['list'] as unknown[]).length).toBe(0);

    const row = await ctx.database.db
      .selectFrom('entity_records')
      .select(['deleted_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row?.deleted_at).toBeInstanceOf(Date);

    const restored = await call('POST', `/api/v1/Account/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body['id']).toBe(id);

    const visible = await call('GET', `/api/v1/Account/${id}`);
    expect(visible.status).toBe(200);
  });
});

describe('generic entity API — relations', () => {
  let accountId = '';
  let contactId = '';

  it('creates a child record linked by an attr and lists it through the relation endpoint', async () => {
    const account = await call('POST', '/api/v1/Account', { name: `Rel ${runId}` });
    accountId = String(account.body['id']);

    const contact = await call('POST', '/api/v1/Contact', {
      firstName: 'Nora',
      lastName: `Roe ${runId}`,
      accountId,
      status: 'Active',
    });
    expect(contact.status).toBe(201);
    contactId = String(contact.body['id']);
    expect(contact.body['accountId']).toBe(accountId);
    // displayField mirroring: Contact.name mirrors lastName
    expect(contact.body['name']).toBe(`Roe ${runId}`);

    const related = await call('GET', `/api/v1/Account/${accountId}/contacts`);
    expect(related.status).toBe(200);
    const list = related.body['list'] as Record<string, unknown>[];
    expect(list.some((item) => item['id'] === contactId)).toBe(true);
  });

  it('links and unlinks explicitly through entity_links', async () => {
    const other = await call('POST', '/api/v1/Contact', { firstName: 'Edgar', lastName: `Poe ${runId}` });
    const otherId = String(other.body['id']);

    const linked = await call('PUT', `/api/v1/Account/${accountId}/contacts/${otherId}`);
    expect(linked.status).toBe(200);

    const afterLink = await call('GET', `/api/v1/Account/${accountId}/contacts`);
    const list = afterLink.body['list'] as Record<string, unknown>[];
    expect(list.some((item) => item['id'] === otherId)).toBe(true);

    const linkRow = await ctx.database.db
      .selectFrom('entity_links')
      .select(['record_id_b'])
      .where('entity_type_a', '=', 'Account')
      .where('record_id_a', '=', accountId)
      .where('relation_name', '=', 'contacts')
      .execute();
    expect(linkRow.some((row) => row.record_id_b === otherId)).toBe(true);

    const unlinked = await call('DELETE', `/api/v1/Account/${accountId}/contacts/${otherId}`);
    expect(unlinked.status).toBe(200);
    const afterUnlink = await call('GET', `/api/v1/Account/${accountId}/contacts`);
    const rest = afterUnlink.body['list'] as Record<string, unknown>[];
    expect(rest.some((item) => item['id'] === otherId)).toBe(false);
  });

  it('rejects a link to a missing record', async () => {
    const res = await call('POST', '/api/v1/Contact', { firstName: 'Bad', lastName: `Link ${runId}`, accountId: 'does-not-exist' });
    expect(res.status).toBe(422);
    expect(errorOf(res.body)).toBe('VALIDATION_FAILED');
  });

  it('returns 404 for an unknown parent record on relation reads', async () => {
    const res = await call('GET', '/api/v1/Account/no-such-account/contacts');
    expect(res.status).toBe(404);
  });
});

describe('generic entity API — removable records', () => {
  it('refuses to delete records of an entity marked non-removable', async () => {
    const patched = await call('POST', '/api/v1/Metadata/Task', { record: { removable: false } });
    expect(patched.status).toBe(200);

    const created = await call('POST', '/api/v1/Task', { name: `Locked ${runId}` });
    expect(created.status).toBe(201);

    const removed = await call('DELETE', `/api/v1/Task/${String(created.body['id'])}`);
    expect(removed.status).toBe(422);
    expect(errorOf(removed.body)).toBe('VALIDATION_FAILED');

    await call('POST', '/api/v1/Metadata/Task', { record: { removable: true } });
  });
});

describe('generic entity API — mass operations', () => {
  it('mass updates and mass deletes selected ids', async () => {
    const first = await call('POST', '/api/v1/Account', { name: `Mass 1 ${runId}` });
    const second = await call('POST', '/api/v1/Account', { name: `Mass 2 ${runId}` });
    const ids = [String(first.body['id']), String(second.body['id'])];

    const updated = await call('POST', '/api/v1/Account/action/massUpdate', { ids, data: { type: 'Analyst' } });
    expect(updated.status).toBe(200);
    expect(updated.body['count']).toBe(2);

    for (const id of ids) {
      const record = await call('GET', `/api/v1/Account/${id}`);
      expect(record.body['type']).toBe('Analyst');
    }

    const removed = await call('POST', '/api/v1/Account/action/massDelete', { ids });
    expect(removed.status).toBe(200);
    expect(removed.body['count']).toBe(2);
    const gone = await call('GET', `/api/v1/Account/${ids[0] as string}`);
    expect(gone.status).toBe(404);
  });
});
