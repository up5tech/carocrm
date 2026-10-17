import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import {
  authHeader,
  bootApi,
  createTestRole,
  createTestUser,
  purgeEntityEvents,
  shutdownApi,
} from './support/boot-api.js';

/**
 * Phase 19-SD.1 – 19-SD.3 — Service Desk module, persistence and Case CRUD
 * (PLAN_Phase_19_ServiceDesk.md §7.1, §7.2, §7.3, §11.1).
 *
 * These run against the already-configured primary database through the real HTTP API (AGENTS.md §3.1):
 * no database, schema or container is created. Every record this suite makes carries the `runId`
 * marker and is removed by exact id in `afterAll` (§3.3). The number sequence is intentionally not
 * rolled back — gaps are normal for a ticket sequence and are not this run's data to reclaim.
 */
let ctx: ApiContext;
let runId: string;
const created: { entity: string; id: string }[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  token = ctx.adminToken,
) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload !== undefined ? { payload } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function create(entity: string, payload: Record<string, unknown>, token = ctx.adminToken): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, payload, token);
  expect(res.status, `create ${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const id = String(res.body['id']);
  created.push({ entity, id });
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sd${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
});

afterAll(async () => {
  // Reverse order so children go before parents; exact ids only (§3.3).
  for (const entry of [...created].reverse()) {
    await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`);
  }
  await purgeEntityEvents(ctx.database, ['Case']);
  await shutdownApi();
});

describe('module scaffold and diagnostics (§7.1)', () => {
  it('reports the module descriptor, its dependencies and the factory defaults', async () => {
    const res = await call('GET', '/api/v1/ServiceDesk/action/health');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['module']).toMatchObject({
      id: 'ServiceDesk',
      name: 'Service Desk',
      apiPrefix: '/api/v1/ServiceDesk',
    });
    // The module id carries no `Ua`/`Sd` prefix (plan §0.1).
    expect(JSON.stringify(res.body['module'])).not.toContain('Ua');

    const checks = res.body['checks'] as { name: string; ok: boolean }[];
    for (const name of ['entity-metadata', 'case-number-sequence', 'write-guard', 'settings-row']) {
      expect(checks.find((check) => check.name === name)?.ok, `check "${name}"`).toBe(true);
    }
  });

  it('reports optional integrations as available/unavailable from real metadata, never fatally', async () => {
    const res = await call('GET', '/api/v1/ServiceDesk/action/health');
    expect(res.status).toBe(200);
    const integrations = res.body['optionalIntegrations'] as { id: string; status: string }[];
    // `Email` is a registered kernel entity, so the email-to-case integration is available.
    expect(integrations.find((entry) => entry.id === 'email')?.status).toBe('available');
    // No Knowledge Base entity exists, so this is honestly unavailable rather than a fake capability.
    expect(integrations.find((entry) => entry.id === 'knowledge-base')?.status).toBe('unavailable');
    expect(res.body['ok']).toBe(true);
  });

  it('refuses module diagnostics to a user who is not an administrator', async () => {
    const user = await createTestUser(ctx, { userName: `sd_noAdmin_${runId}` });
    const res = await call('GET', '/api/v1/ServiceDesk/action/health', undefined, user.token);
    expect(res.status).toBe(403);
  });
});

describe('settings and numbering configuration (§14.1, 19-SD.2)', () => {
  it('reads validated defaults when no settings row exists yet', async () => {
    const res = await call('GET', '/api/v1/ServiceDesk/action/settings');
    expect(res.status).toBe(200);
    const settings = res.body['settings'] as Record<string, unknown>;
    const features = settings['features'] as Record<string, boolean>;
    expect(features['caseManagement']).toBe(true);
    // Every optional capability whose infrastructure lands in a later sub-phase is off by default.
    for (const key of ['queues', 'sla', 'emailToCase', 'portal', 'knowledgeBase', 'csat']) {
      expect(features[key], `feature "${key}"`).toBe(false);
    }
  });

  it('accepts a valid numbering change and rejects an unknown key', async () => {
    const before = await call('GET', '/api/v1/ServiceDesk/action/settings');
    const beforeNumbering = (before.body['settings'] as Record<string, unknown>)['numbering'];
    try {
      const updated = await call('POST', '/api/v1/ServiceDesk/action/settings', {
        numbering: { prefix: 'SD', padding: 4 },
      });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect((updated.body['settings'] as Record<string, unknown>)['numbering']).toMatchObject({
        prefix: 'SD',
        padding: 4,
      });

      // An unknown key is refused, not stored and quietly ignored.
      const bogus = await call('POST', '/api/v1/ServiceDesk/action/settings', { bogus: true });
      expect(bogus.status).toBe(422);
    } finally {
      await call('POST', '/api/v1/ServiceDesk/action/settings', { numbering: beforeNumbering });
    }
  });

  it('activates idempotently: one settings row and one Case metadata row, never duplicates', async () => {
    // Re-applying the same patch must not create a second settings row (SD.2 "re-running module
    // activation does not duplicate configuration"). This suite's process already seeded once and
    // the module registered once; the persisted invariants are what an activation would repeat.
    await call('POST', '/api/v1/ServiceDesk/action/settings', { numbering: { prefix: 'C', padding: 6 } });

    const settingsRows = await ctx.database.db
      .selectFrom('app_settings')
      .select('name')
      .where('name', '=', 'serviceDesk')
      .execute();
    expect(settingsRows).toHaveLength(1);

    const caseMetadataRows = await ctx.database.db
      .selectFrom('metadata_entries')
      .select('name')
      .where('scope', '=', 'entity')
      .where('name', '=', 'Case')
      .execute();
    expect(caseMetadataRows).toHaveLength(1);
  });

  it('previews the next case number without consuming it', async () => {
    const first = await call('GET', '/api/v1/ServiceDesk/action/caseNumberPreview');
    expect(first.status).toBe(200);
    const format = String(first.body['format']);
    expect(format).toMatch(/^[A-Za-z][A-Za-z0-9-]*\d+$/);

    const second = await call('GET', '/api/v1/ServiceDesk/action/caseNumberPreview');
    // Reading the preview never moves the sequence, so two reads agree.
    expect(second.body['format']).toBe(format);
  });
});

describe('case CRUD, numbering and domain validation (§5.1, §7.3, 19-SD.3)', () => {
  async function makeContact(): Promise<string> {
    return create('Contact', {
      name: marker('requester contact'),
      lastName: marker('Requester'),
      emailAddress: `sd_${runId}@example.com`,
    });
  }

  it('creates a case with a requester and allocates a unique case number', async () => {
    const contactId = await makeContact();
    const id = await create('Case', { name: marker('subject one'), contactId, priority: 'High' });
    const read = await call('GET', `/api/v1/Case/${id}`);
    expect(read.status).toBe(200);
    expect(read.body['caseNumber']).toMatch(/^C\d{6}$/);
    expect(read.body['status']).toBe('New');
    expect(read.body['contactId']).toBe(contactId);
  });

  it('accepts a channel-supplied requester when no CRM record is linked', async () => {
    const id = await create('Case', {
      name: marker('subject web form'),
      requesterEmail: `sd_walkin_${runId}@example.com`,
      requesterName: marker('Walk-in'),
    });
    const read = await call('GET', `/api/v1/Case/${id}`);
    expect(read.status).toBe(200);
    expect(read.body['caseNumber']).toMatch(/^C\d{6}$/);
  });

  it('refuses a new case with no requester at all', async () => {
    const res = await call('POST', '/api/v1/Case', { name: marker('subject no requester') });
    expect(res.status).toBe(422);
  });

  it('never lets the record API set a server-owned field', async () => {
    const contactId = await makeContact();
    const forged = await call('POST', '/api/v1/Case', {
      name: marker('subject forged number'),
      contactId,
      caseNumber: 'FORGED-1',
    });
    expect(forged.status).toBe(422);

    const id = await create('Case', { name: marker('subject guard'), contactId });
    const forgedEdit = await call('PUT', `/api/v1/Case/${id}`, { slaState: 'Breached', isEscalated: true });
    expect(forgedEdit.status).toBe(422);
    // The refused write changed nothing.
    const read = await call('GET', `/api/v1/Case/${id}`);
    expect(read.body['slaState']).toBe('NotApplicable');
    expect(read.body['isEscalated']).toBe(false);
  });

  it('lists and filters cases by case number and status', async () => {
    const contactId = await makeContact();
    const id = await create('Case', { name: marker('subject filter'), contactId, status: 'Pending Customer' });
    const read = await call('GET', `/api/v1/Case/${id}`);
    const caseNumber = String(read.body['caseNumber']);

    const byNumber = encodeURIComponent(JSON.stringify([{ field: 'caseNumber', operator: 'equals', value: caseNumber }]));
    const numberRes = await call('GET', `/api/v1/Case?where=${byNumber}&maxSize=10`);
    expect(numberRes.status).toBe(200);
    const numberList = numberRes.body['list'] as Record<string, unknown>[];
    expect(numberList.map((item) => item['id'])).toContain(id);

    const byStatus = encodeURIComponent(
      JSON.stringify([
        { field: 'status', operator: 'equals', value: 'Pending Customer' },
        { field: 'id', operator: 'in', value: [id] },
      ]),
    );
    const statusRes = await call('GET', `/api/v1/Case?where=${byStatus}&maxSize=10`);
    expect((statusRes.body['list'] as unknown[]).length).toBe(1);
  });

  it('prevents number collisions under concurrent creation', async () => {
    const contactId = await makeContact();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        call('POST', '/api/v1/Case', { name: marker(`subject concurrent ${String(index)}`), contactId }),
      ),
    );
    const numbers = results.map((res, index) => {
      expect(res.status, `concurrent create ${String(index)}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      created.push({ entity: 'Case', id: String(res.body['id']) });
      return String(res.body['caseNumber']);
    });
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const number of numbers) expect(number).toMatch(/^C\d{6}$/);
  });

  it('enforces record ACL: a user without a Case role is refused, a granted user succeeds', async () => {
    const deniedUser = await createTestUser(ctx, { userName: `sd_denied_${runId}` });
    const denied = await call('POST', '/api/v1/Case', { name: marker('denied'), requesterName: marker('N') }, deniedUser.token);
    expect(denied.status).toBe(403);

    const roleId = `role_sd_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `SD agent ${runId}`,
      permissions: { Case: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } },
    });
    const agent = await createTestUser(ctx, { userName: `sd_agent_${runId}`, roleIds: [roleId] });
    const created1 = await call(
      'POST',
      '/api/v1/Case',
      { name: marker('agent subject'), requesterName: marker('Agent Requester') },
      agent.token,
    );
    expect(created1.status, JSON.stringify(created1.body)).toBeLessThan(300);
    created.push({ entity: 'Case', id: String(created1.body['id']) });

    // The agent still cannot write a server-owned field.
    const forged = await call('PUT', `/api/v1/Case/${String(created1.body['id'])}`, { caseNumber: 'X' }, agent.token);
    expect(forged.status).toBe(422);
  });
});
