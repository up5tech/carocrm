import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeadScoreFeatureGate, LeadScoreSettingsService } from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.1 — `LeadScore` module registration, capability matrix, settings and the feature gate.
 *
 * Runs against the configured primary database (AGENTS.md §3.1): no test database is created, nothing
 * is reset or truncated, and the only row this suite writes outside its own records is the `leadScore`
 * settings document, which `afterAll` restores byte-for-byte. Its CRM records are `AGENT_TEST_LS1_`
 * prefixed and removed by exact id.
 *
 * The point is the plan's LS.1 exit criterion: *the module loads, is discoverable, and does not
 * conflict with existing Lead behavior* (PLAN_Phase_19_LeadScore.md §16). "Does not conflict" is proved
 * by exercising the generic Lead/Contact/Account/Opportunity API inside the same booted application
 * that now carries the module, and by the health view reporting the untouched core lifecycle.
 */

const SETTINGS_ROW = 'leadScore';
const RUN = `AGENT_TEST_LS1_${Date.now().toString(36)}`;

let ctx: ApiContext;
let previousSettings: string | null = null;
/** Exact ids this run created, purged by id in `afterAll` (AGENTS.md §3.3): no broad delete. */
const createdRecordIds: string[] = [];
const createdRoleIds: string[] = [];
const createdUserNames: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
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

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  expect(id).not.toBe('');
  createdRecordIds.push(id);
  return id;
}

async function createRole(id: string, name: string, permissions: Record<string, Record<string, string>>): Promise<string> {
  await createTestRole(ctx, { id, name, permissions });
  createdRoleIds.push(id);
  return id;
}

async function createUser(userName: string, roleIds: string[]): Promise<{ id: string; userName: string; token: string }> {
  createdUserNames.push(userName);
  return createTestUser(ctx, { userName, roleIds });
}

function settings(): LeadScoreSettingsService {
  return ctx.app.get(LeadScoreSettingsService, { strict: false });
}

function gate(): LeadScoreFeatureGate {
  return ctx.app.get(LeadScoreFeatureGate, { strict: false });
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
}, 180_000);

afterAll(async () => {
  // Global policy must not leak out of this suite: restore the row exactly as it was found.
  if (previousSettings === null) {
    await ctx.database.db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  } else {
    await ctx.database.db
      .updateTable('app_settings')
      .set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() })
      .where('name', '=', SETTINGS_ROW)
      .execute()
      .catch(() => undefined);
  }
  settings().invalidate();

  // Remove this run's own rows by exact id. The API soft-deletes, so the rows are purged here rather
  // than left as tombstones in the shared development database.
  const db = ctx.database.db;
  if (createdRecordIds.length > 0) {
    const linked = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', createdRecordIds), eb('record_id_b', 'in', createdRecordIds)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((row) => row.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', createdRecordIds).execute().catch(() => undefined);
  }
  if (createdUserNames.length > 0) {
    const userIds = (await db.selectFrom('users').select('id').where('user_name', 'in', createdUserNames).execute()).map((row) => row.id);
    if (userIds.length > 0) {
      // The membership rows are dropped first: a foreign key would otherwise leave the user, and the
      // role it references, behind.
      await db.deleteFrom('users_teams').where('user_id', 'in', userIds).execute().catch(() => undefined);
      await db.deleteFrom('users_roles').where('user_id', 'in', userIds).execute().catch(() => undefined);
      await db.deleteFrom('users').where('id', 'in', userIds).execute().catch(() => undefined);
    }
  }
  if (createdRoleIds.length > 0) {
    await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute().catch(() => undefined);
  }
  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where('name', 'like', `${RUN}%`)
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score suite left test records behind');
  const leftoverAccounts = await db.selectFrom('users').select('id').where('user_name', 'like', `${RUN}%`).execute().catch(() => [] as { id: string }[]);
  if (leftoverAccounts.length > 0) console.warn({ leftoverUsers: leftoverAccounts.length }, 'lead-score suite left test users behind');

  await shutdownApi();
}, 180_000);

describe('module registration and health (19-LS.1)', () => {
  it('reports the module, its verified dependencies and the state of every feature', async () => {
    const result = await call('GET', '/api/v1/LeadScore/action/health');
    expect(result.status).toBe(200);
    const body = result.body as unknown as {
      module: { id: string; version: string; apiPrefix: string; entityTypes: string[]; implementedPhases: string[] };
      ok: boolean;
      ready: boolean;
      reason: string;
      dependencies: { id: string; present: boolean; missing: string[] }[];
      optionalIntegrations: { id: string; present: boolean; status: string }[];
      features: { key: string; enabled: boolean; implemented: boolean; effective: boolean; pendingPhase: string | null }[];
      operations: { operation: string; admitted: boolean; code: string | null }[];
      checks: { name: string; ok: boolean; detail: string }[];
      settings: { version: number; enabled: boolean };
    };

    expect(body.module.id).toBe('LeadScore');
    expect(body.module.apiPrefix).toBe('/api/v1/LeadScore');
    expect(body.module.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.module.implementedPhases).toEqual(['19-LS.0', '19-LS.1', '19-LS.2']);

    // Every required capability is a fact the view verified against this database, not a claim.
    expect(body.dependencies.every((dependency) => dependency.present)).toBe(true);
    expect(body.dependencies.map((dependency) => dependency.id)).toEqual(
      expect.arrayContaining(['entity-engine', 'crm-core-records', 'acl', 'jobs', 'settings', 'audit-stream-outbox']),
    );

    // 19-LS.2 registered the four records Lead Score owns.
    expect(body.module.entityTypes).toEqual(['LeadScoreModel', 'LeadScoreRule', 'LeadScoreEvaluation', 'LeadConversionOperation']);

    // The whole control plane is switched off at boot: plan §15.2 stage 1.
    expect(body.settings.enabled).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(false);
    expect(body.reason).toContain('module switch is off');
    expect(body.features.every((feature) => feature.enabled === false)).toBe(true);
    expect(body.features.every((feature) => feature.implemented === false)).toBe(true);
    expect(body.features.every((feature) => feature.pendingPhase !== null)).toBe(true);
    expect(body.operations.every((operation) => operation.admitted === false)).toBe(true);
    expect(body.operations.every((operation) => operation.code === 'LEADSCORE_MODULE_DISABLED')).toBe(true);

    for (const name of [
      'core-lead-lifecycle',
      'lead-score-fields',
      'lead-core-fields',
      'entity-registration',
      'schema-indexes',
      'write-guard',
      'platform-foundation',
    ]) {
      expect(body.checks.find((check) => check.name === name)?.ok).toBe(true);
    }
    // The registration invariant holds because the core Lead enum is untouched, `Converted` included.
    expect(body.checks.find((check) => check.name === 'core-lead-lifecycle')?.detail).toContain('Converted');
  });

  it('answers the capability matrix with the synthetic ACL resources it is evaluated against', async () => {
    const result = await call('GET', '/api/v1/LeadScore/action/permissions');
    expect(result.status).toBe(200);
    const capabilities = (result.body['capabilities'] as { key: string; resource: string; action: string }[]).map((entry) => ({
      key: entry.key,
      resource: entry.resource,
      action: entry.action,
    }));
    const byKey = new Map(capabilities.map((entry) => [entry.key, entry]));
    expect(byKey.get('viewScore')).toEqual({ key: 'viewScore', resource: 'LeadScore', action: 'read' });
    expect(byKey.get('convertExecute')).toEqual({ key: 'convertExecute', resource: 'LeadConversion', action: 'edit' });
    // Target-entity rights are the core entities' own ACL and are deliberately absent from this matrix
    // (plan §9.1 against §0.1-16: no second permission system).
    expect(capabilities.some((entry) => entry.resource === 'Contact' || entry.resource === 'Account')).toBe(false);
  });

  it('publishes the control plane in the generated OpenAPI document', async () => {
    // AGENTS.md §5.4: a route that exists but is absent from the spec is undocumented for every client
    // that reads it. The document is generated from the registered routes, so this asserts the real
    // surface, not decorator metadata.
    const result = await call('GET', '/api/v1/OpenApi');
    expect(result.status).toBe(200);
    const paths = (result.body as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/api/v1/LeadScore/action/health'] ?? {})).toContain('get');
    expect(Object.keys(paths['/api/v1/LeadScore/action/capabilities'] ?? {})).toContain('get');
    expect(Object.keys(paths['/api/v1/LeadScore/action/permissions'] ?? {})).toContain('get');
    expect(Object.keys(paths['/api/v1/LeadScore/action/settings'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/api/v1/LeadScore/action/operation-gate'] ?? {})).toContain('post');
  });

  it('serves its routes under a static prefix instead of being read as an entity', async () => {
    // The generic `/api/v1/:entity` wildcard would otherwise answer "entity `LeadScore`".
    const asEntity = await call('GET', '/api/v1/LeadScore');
    expect(asEntity.status).toBeGreaterThanOrEqual(400);
    const controlPlane = await call('GET', '/api/v1/LeadScore/action/capabilities');
    expect(controlPlane.status).toBe(200);
  });
});

describe('capability enforcement (19-LS.1)', () => {
  it('refuses every Lead Score route for a user with no Lead Score permission', async () => {
    const roleId = await createRole(`role_${RUN}_leadonly`, `${RUN} lead-only role`, {
      Lead: { read: 'yes', edit: 'yes', delete: 'yes', create: 'yes' },
    });
    const user = await createUser(`${RUN}_leadonly`, [roleId]);

    expect((await call('GET', '/api/v1/LeadScore/action/health', undefined, user.token)).status).toBe(403);
    expect((await call('GET', '/api/v1/LeadScore/action/capabilities', undefined, user.token)).status).toBe(403);
    expect((await call('GET', '/api/v1/LeadScore/action/permissions', undefined, user.token)).status).toBe(403);
    expect((await call('GET', '/api/v1/LeadScore/action/settings', undefined, user.token)).status).toBe(403);
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true }, user.token)).status).toBe(403);

    // …and the same user still reads and writes Leads exactly as before this module existed.
    const leadId = await createRecord('Lead', { name: `${RUN} untouched lead`, lastName: `${RUN}inger` });
    const readBack = await call('GET', `/api/v1/Lead/${leadId}`, undefined, user.token);
    expect(readBack.status).toBe(200);
    expect(readBack.body['status']).toBe('New');
    // Ordinary Lead work needs no Lead Score permission at all.
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'Analyst' }, user.token)).status).toBe(200);
    expect((await call('DELETE', `/api/v1/Lead/${leadId}`, undefined, user.token)).status).toBeLessThan(300);
  });

  it('grants the control plane through the module’s own capability resources', async () => {
    const roleId = await createRole(`role_${RUN}_scorer`, `${RUN} scorer role`, {
      Lead: { read: 'yes' },
      LeadScore: { read: 'yes' },
      LeadScoreSettings: { edit: 'yes' },
    });
    const user = await createUser(`${RUN}_scorer`, [roleId]);

    expect((await call('GET', '/api/v1/LeadScore/action/health', undefined, user.token)).status).toBe(200);
    const capabilities = await call('GET', '/api/v1/LeadScore/action/capabilities', undefined, user.token);
    expect(capabilities.status).toBe(200);
    const granted = (capabilities.body['capabilities'] as { key: string; granted: boolean }[]).map((entry) => [entry.key, entry.granted]);
    const byKey = new Map(granted);
    expect(byKey.get('viewScore')).toBe(true);
    expect(byKey.get('settingsManage')).toBe(true);
    // A right nobody granted stays denied even for a caller who can see the module.
    expect(byKey.get('convertExecute')).toBe(false);
    expect(byKey.get('modelPublish')).toBe(false);
    // Settings read is `settingsManage`, not `viewScore`.
    expect((await call('GET', '/api/v1/LeadScore/action/settings', undefined, user.token)).status).toBe(200);
  });
});

describe('settings document (19-LS.1)', () => {
  it('serves defaults with the versioned envelope before any row exists', async () => {
    const result = await call('GET', '/api/v1/LeadScore/action/settings');
    expect(result.status).toBe(200);
    const view = result.body as unknown as {
      settings: { enabled: boolean; features: Record<string, boolean> };
      version: number;
      defaults: { enabled: boolean };
      pendingFeatures: { key: string; phase: string }[];
      effective: Record<string, boolean>;
      warnings: { code: string }[];
    };
    expect(view.settings.enabled).toBe(false);
    expect(view.defaults.enabled).toBe(false);
    expect(Object.values(view.settings.features).every((value) => value === false)).toBe(true);
    expect(Object.values(view.effective).every((value) => value === false)).toBe(true);
    expect(view.warnings.map((warning) => warning.code)).toContain('moduleDisabled');
    expect(view.pendingFeatures.map((entry) => entry.key)).toEqual(expect.arrayContaining(['scoring', 'leadConversion', 'aiInsight']));
  });

  it('refuses an unknown switch instead of storing a typo', async () => {
    const result = await call('POST', '/api/v1/LeadScore/action/settings', { features: { scoringg: true } });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain('scoringg');
    // The refusal left nothing behind.
    const after = await call('GET', '/api/v1/LeadScore/action/settings');
    expect((after.body['settings'] as { features: Record<string, boolean> }).features.scoring).toBe(false);
  });

  it('refuses a section nothing reads yet instead of accepting speculative configuration', async () => {
    const result = await call('POST', '/api/v1/LeadScore/action/settings', { scaleMax: 100 });
    expect(result.status).toBe(422);
  });

  it('bumps the version on an accepted change and warns about a switch whose phase has not shipped', async () => {
    const before = await call('GET', '/api/v1/LeadScore/action/settings');
    const beforeVersion = before.body['version'] as number;

    const updated = await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { scoring: true } });
    expect(updated.status).toBe(200);
    const view = updated.body as unknown as {
      version: number;
      settings: { enabled: boolean; features: Record<string, boolean> };
      effective: Record<string, boolean>;
      warnings: { code: string; message: string }[];
      updatedAt: string | null;
      updatedBy: string | null;
    };
    expect(view.version).toBe(beforeVersion + 1);
    expect(view.settings.enabled).toBe(true);
    expect(view.settings.features.scoring).toBe(true);
    // The switch is on, the phase is not delivered, so the effective answer stays false — and the
    // document says so out loud instead of letting an administrator believe scoring is live.
    expect(view.effective.scoring).toBe(false);
    expect(view.warnings.map((warning) => warning.code)).toContain('phasePending');
    expect(view.warnings.map((warning) => warning.message).join(' ')).toContain('19-LS.4');
    expect(view.updatedAt).not.toBeNull();
    expect(view.updatedBy).not.toBeNull();

    // The row is the platform's own store, written through the module's service.
    const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
    expect((row?.data as { version: number }).version).toBe(view.version);
  });
});

describe('feature gate (19-LS.1)', () => {
  it('refuses an operation whose sub-phase has not shipped, naming the phase', async () => {
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true })).status).toBe(200);

    for (const [operation, phase] of [
      ['readScore', '19-LS.4'],
      ['conversionExecute', '19-LS.13'],
      ['publishModel', '19-LS.3'],
      ['aiInsight', '19-LS.17'],
    ] as const) {
      const result = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation });
      expect(result.status).toBe(200);
      const assessment = result.body as unknown as {
        operation: string;
        admitted: boolean;
        feature: string;
        pendingPhase: string | null;
        code: string | null;
        detail: string | null;
        writes: boolean;
      };
      expect(assessment.admitted).toBe(false);
      expect(assessment.code).toBe('LEADSCORE_PHASE_PENDING');
      expect(assessment.pendingPhase).toBe(phase);
      expect(assessment.detail).toBe(phase);
      expect(assessment.writes).toBe(operation !== 'readScore');
    }

    // A caller without the right learns only that it is denied — never the deployment state behind it.
    const roleId = await createRole(`role_${RUN}_none`, `${RUN} empty role`, {});
    const nobody = await createUser(`${RUN}_nobody`, [roleId]);
    const denied = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation: 'readScore' }, nobody.token);
    expect(denied.status).toBe(200);
    expect(denied.body['code']).toBe('AUTHORIZATION_DENIED');
  });

  it('names the module switch as the reason while Lead Score is disabled', async () => {
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: false })).status).toBe(200);
    const result = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation: 'conversionExecute' });
    expect(result.body['code']).toBe('LEADSCORE_MODULE_DISABLED');
    expect(result.body['detail']).toBe('leadScore');
  });

  it('rejects an unknown operation at the shape boundary', async () => {
    const result = await call('POST', '/api/v1/LeadScore/action/operation-gate', { operation: 'deleteEverything' });
    expect(result.status).toBe(400);
  });

  it('denies a caller with no request principal instead of defaulting open', async () => {
    // The gate is the seam every later command calls first. Called outside an authenticated request —
    // a job, a script, a test that reached around the API — the ACL snapshot has no principal, so the
    // capability check must refuse. A gate that fell through to the deployment state here would let an
    // unauthenticated in-process caller learn the configuration (AGENTS.md §5.3).
    await expect(gate().assertOperation('conversionExecute')).rejects.toThrow(/Convert a Lead/);
    await expect(gate().assertOperation('readScore')).rejects.toThrow(/View lead scores/);
  });
});

describe('disabling the module leaves the core CRM alone (19-LS.1)', () => {
  it('keeps Lead, Contact, Account and Opportunity generic CRUD working with the module loaded', async () => {
    expect((await call('POST', '/api/v1/LeadScore/action/settings', { enabled: true, features: { leadConversion: true } })).status).toBe(200);

    const accountId = await createRecord('Account', { name: `${RUN} account` });
    const contactId = await createRecord('Contact', { name: `${RUN} contact`, lastName: `${RUN} contact`, accountId });
    const leadId = await createRecord('Lead', { name: `${RUN} lead`, lastName: `${RUN} lead`, status: 'Converted' });
    const opportunityId = await createRecord('Opportunity', { name: `${RUN} deal`, accountId });

    const lead = await call('GET', `/api/v1/Lead/${leadId}`);
    expect(lead.body['status']).toBe('Converted');
    // Turning the module on must not have scored or converted anything by itself: the projection is
    // written by the engine (19-LS.4) and the references by the conversion command (19-LS.13).
    for (const field of ['scoreValue', 'convertedAt', 'convertedAccountId', 'convertedContactId', 'conversionOperationId']) {
      expect(lead.body[field] ?? null).toBeNull();
    }

    const related = await call('GET', `/api/v1/Account/${accountId}/contacts`);
    expect(related.status).toBe(200);
    expect(JSON.stringify(related.body)).toContain(contactId);

    // Conversion is not a Lead field write, and nothing mutates the Lead behind the module's back.
    const patched = await call('PATCH', `/api/v1/Lead/${leadId}`, { status: 'In Process' });
    expect(patched.status).toBe(200);
    expect(patched.body['status']).toBe('In Process');

    for (const [entity, id] of [
      ['Lead', leadId],
      ['Contact', contactId],
      ['Account', accountId],
      ['Opportunity', opportunityId],
    ] as const) {
      expect((await call('DELETE', `/api/v1/${entity}/${id}`)).status).toBeLessThan(300);
    }
  });
});
