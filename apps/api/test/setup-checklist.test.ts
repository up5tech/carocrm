import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, authHeader, bootApi, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20 §4.10 / §20.15 — the setup checklist (PLAN_Phase_20_Settings_UX.md).
 *
 * The checklist is guidance for a fresh instance, so its *content* depends on the database it runs
 * against. What this suite pins is what must hold on any instance: the eight checks the plan names
 * are all present exactly once and in order, `progress` agrees with the items, and the endpoint is
 * administrator-only.
 */
interface ChecklistItem {
  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly route: string;
  readonly completed: boolean;
  readonly order: number;
}

const runId = Date.now().toString(36);
const PLAN_ITEMS = ['users', 'roles', 'teams', 'email', 'logo', 'fields', 'workflow', 'menu'];

let ctx: ApiContext;
let adminToken = '';

async function call(url: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = await loginAs(ctx, ADMIN_LOGIN, ADMIN_PASSWORD);
});

afterAll(async () => {
  await shutdownApi();
});

describe('GET /SetupChecklist', () => {
  it('returns the plan\'s eight checks, ordered, each with a deep link', async () => {
    const result = await call('/api/v1/SetupChecklist', adminToken);
    expect(result.status).toBe(200);
    const items = result.body['items'] as ChecklistItem[];

    expect(items).toHaveLength(8);
    expect(items.map((item) => item.id)).toEqual(PLAN_ITEMS);
    expect(items.map((item) => item.order).slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const item of items) {
      expect(item.route.startsWith('/')).toBe(true);
      expect(item.labelKey.startsWith('web.setup.')).toBe(true);
      expect(item.descriptionKey.startsWith('web.setup.')).toBe(true);
    }
  });

  it('reports progress that agrees with the items', async () => {
    const result = await call('/api/v1/SetupChecklist', adminToken);
    const items = result.body['items'] as ChecklistItem[];
    const progress = result.body['progress'] as { done: number; total: number };
    expect(progress.total).toBe(items.length);
    expect(progress.done).toBe(items.filter((item) => item.completed).length);
  });

  it('is administrator-only', async () => {
    const rep = await createTestUser(ctx, { userName: `AGENT_TEST-p20-checklist-${runId}` });
    const result = await call('/api/v1/SetupChecklist', rep.token);
    expect(result.status).toBe(403);
  });

  it('answers 401 without a session', async () => {
    const result = await call('/api/v1/SetupChecklist');
    expect(result.status).toBe(401);
  });
});
