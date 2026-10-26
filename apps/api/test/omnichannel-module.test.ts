import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OmnichannelSettingsService } from '../src/omnichannel/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.2 — `Omnichannel` module registration, permission matrix, settings and navigation.
 *
 * Runs against the configured primary database (AGENTS.md §3.1): no database is created, nothing is
 * reset or truncated. The only shared row this suite writes is the `omnichannel` settings document,
 * restored byte-for-byte in `afterAll`; its roles and users are `AGENT_TEST_OM2_` prefixed and
 * deleted by exact id.
 *
 * The exit criteria are the plan's (§14 `19-OM.2`): the module registers cleanly and can be
 * enabled/disabled through its own switch; ACL defaults are least privilege and nothing of the
 * settings document reaches an ordinary agent; existing modules keep loading — proved by exercising
 * the generic entity API and the Voice inbox inside the same booted application.
 */

const SETTINGS_ROW = 'omnichannel';
const RUN = `AGENT_TEST_OM2_${Date.now().toString(36)}`;
const ROLE_NONE = `r_${RUN}_none`;
const ROLE_INBOX = `r_${RUN}_inbox`;

let ctx: ApiContext;
let previousSettings: string | null = null;
const createdRoleIds: string[] = [];
const createdUserIds: string[] = [];

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<CallResult> {
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

function settingsService(): OmnichannelSettingsService {
  return ctx.app.get(OmnichannelSettingsService, { strict: false });
}

async function navigationKeys(token: string): Promise<Set<string>> {
  const body = (await call('GET', '/api/v1/Navigation', undefined, token)).body as {
    items: readonly { key: string; children?: readonly { key: string }[] }[];
  };
  const out = new Set<string>();
  const walk = (nodes: readonly { key: string; children?: readonly { key: string }[] }[]): void => {
    for (const node of nodes) {
      out.add(node.key);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(body.items ?? []);
  return out;
}

async function setWorkspace(enabled: boolean): Promise<CallResult> {
  return call('POST', '/api/v1/Omnichannel/action/settings', { features: { workspace: enabled } });
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db
    .selectFrom('app_settings')
    .select('data')
    .where('name', '=', SETTINGS_ROW)
    .executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  // The suite starts from a *fresh installation*: no stored row, validated defaults, workspace on.
  // The assertions below only mean something against that precondition, and leaving a stored
  // `workspace=false` behind would poison every later run through its own restore. The row is put
  // back exactly as found in `afterAll` (AGENTS.md §3.3).
  if (row !== undefined) await ctx.database.db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute();
  settingsService().invalidate();
  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM2 none ${RUN}`, permissions: {} });
  await createTestRole(ctx, {
    id: ROLE_INBOX,
    name: `AGENT_TEST OM2 inbox ${RUN}`,
    permissions: { OmnichannelConversation: { read: 'all' } },
  });
  createdRoleIds.push(ROLE_NONE, ROLE_INBOX);
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) {
    await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  } else {
    await db
      .updateTable('app_settings')
      .set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() })
      .where('name', '=', SETTINGS_ROW)
      .execute()
      .catch(() => undefined);
  }
  settingsService().invalidate();
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute().catch(() => undefined);
  if (createdRoleIds.length > 0) await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel module registration (19-OM.2)', () => {
  it('registers the control plane and reports an evidence-based health view', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/health');
    expect(result.status).toBe(200);
    const body = result.body as {
      module: { id: string; implementedPhases: string[]; ownedTables: string[] };
      ok: boolean;
      dependencies: { id: string; present: boolean; required: boolean }[];
      features: { key: string; enabled: boolean }[];
      callerRights: { key: string; granted: boolean }[];
    };
    expect(body.module.id).toBe('Omnichannel');
    expect(body.module.implementedPhases).toContain('19-OM.2');
    // D1: the module owns no *record* store; its only owned table is the web-chat visitor session
    // (OM.9) — reported from the descriptor, not implied.
    expect(body.module.ownedTables).toEqual(['omnichannel_visitor_sessions']);
    expect(body.ok).toBe(true);
    const conversationStore = body.dependencies.find((dependency) => dependency.id === 'conversation-store');
    expect(conversationStore?.present).toBe(true);
    expect(body.features.find((feature) => feature.key === 'workspace')?.enabled).toBe(true);
    // sysAdmin's wildcard covers every synthetic resource.
    expect(body.callerRights.every((right) => right.granted)).toBe(true);
  });

  it('answers a plain role with least privilege: every capability refused, no detail leaked', async () => {
    const user = await createTestUser(ctx, { userName: `${RUN}-none`, roleIds: [ROLE_NONE] });
    createdUserIds.push(user.id);
    const health = await call('GET', '/api/v1/Omnichannel/action/health', undefined, user.token);
    expect(health.status).toBe(403);
    const capabilities = await call('GET', '/api/v1/Omnichannel/action/capabilities', undefined, user.token);
    expect(capabilities.status).toBe(200);
    const entries = (capabilities.body as { capabilities: { granted: boolean }[] }).capabilities;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => !entry.granted)).toBe(true);
    const settings = await call('GET', '/api/v1/Omnichannel/action/settings', undefined, user.token);
    expect(settings.status).toBe(403);
  });

  it('grants an inbox holder the workspace reads but never the settings document', async () => {
    const user = await createTestUser(ctx, { userName: `${RUN}-inbox`, roleIds: [ROLE_INBOX] });
    createdUserIds.push(user.id);
    const health = await call('GET', '/api/v1/Omnichannel/action/health', undefined, user.token);
    expect(health.status).toBe(200);
    const body = health.body as { callerRights: { key: string; granted: boolean }[] };
    expect(body.callerRights.find((right) => right.key === 'inboxView')?.granted).toBe(true);
    expect(body.callerRights.find((right) => right.key === 'settingsManage')?.granted).toBe(false);
    expect(body.callerRights.find((right) => right.key === 'opsReplay')?.granted).toBe(false);
    const settings = await call('GET', '/api/v1/Omnichannel/action/settings', undefined, user.token);
    expect(settings.status).toBe(403);
  });

  it('puts the workspace in the menu for a capable caller and hides it from an incapable one', async () => {
    const adminKeys = await navigationKeys(ctx.adminToken);
    expect(adminKeys.has('omnichannel')).toBe(true);
    const user = await createTestUser(ctx, { userName: `${RUN}-nav-none`, roleIds: [ROLE_NONE] });
    createdUserIds.push(user.id);
    const noneKeys = await navigationKeys(user.token);
    expect(noneKeys.has('omnichannel')).toBe(false);
  });

  it('switches the module off and on through its own settings document', async () => {
    const off = await setWorkspace(false);
    expect(off.status).toBe(200);
    expect((off.body as { settings: { features: { workspace: boolean } } }).settings.features.workspace).toBe(false);
    const keys = await navigationKeys(ctx.adminToken);
    expect(keys.has('omnichannel')).toBe(false);
    // The closed workspace hides its diagnostics from ordinary agents; administrators still get in,
    // because the switch that opens it again is theirs (19-ES/LS precedent).
    const user = await createTestUser(ctx, { userName: `${RUN}-nav-off`, roleIds: [ROLE_INBOX] });
    createdUserIds.push(user.id);
    const health = await call('GET', '/api/v1/Omnichannel/action/health', undefined, user.token);
    expect(health.status).toBe(403);
    const on = await setWorkspace(true);
    expect(on.status).toBe(200);
    const keysAfter = await navigationKeys(ctx.adminToken);
    expect(keysAfter.has('omnichannel')).toBe(true);
  });

  it('refuses an unknown settings key instead of silently accepting it', async () => {
    const result = await call('POST', '/api/v1/Omnichannel/action/settings', { features: { notAFlag: true } });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  it('loads alongside the existing modules: the generic entity API and Voice inbox still answer', async () => {
    const contacts = await call('GET', '/api/v1/Contact?maxSize=1');
    expect(contacts.status).toBe(200);
    const voiceHealth = await call('GET', '/api/v1/VoiceCommunications/action/health');
    expect(voiceHealth.status).toBe(200);
  });
});
