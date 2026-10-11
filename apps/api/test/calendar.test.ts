import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `cal${Date.now().toString(36)}`;

let ctx: ApiContext;
let adminToken = '';

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
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
  return { status: res.statusCode, body };
}

function eventsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body['list']) ? (body['list'] as Array<Record<string, unknown>>) : [];
}

async function createActivity(entity: string, data: Record<string, unknown>): Promise<string> {
  const created = await call('POST', `/api/v1/${entity}`, adminToken, data);
  expect(created.status).toBe(201);
  return String(created.body['id']);
}

let meeting = '';
let adminId = '';
let recurringTask = '';

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
  adminId = String((await call('GET', '/api/v1/AppUser/me', adminToken)).body['id']);
  // 2026-03 is a fixed window so the expected occurrence dates stay deterministic
  meeting = await createActivity('Meeting', {
    name: `Cal Meeting ${runId}`,
    status: 'Planned',
    dateStart: '2026-03-11T09:00:00.000Z',
    dateEnd: '2026-03-11T10:00:00.000Z',
    assignedUserId: adminId,
  });
  recurringTask = await createActivity('Task', {
    name: `Cal Recurring Task ${runId}`,
    status: 'Not Started',
    dateStart: '2026-03-02T08:00:00.000Z',
    repeatType: 'Weekly',
    repeatEvery: 1,
    repeatDayOfWeek: ['mon', 'fri'],
    repeatEndDate: '2026-03-31',
  });
});

afterAll(async () => {
  await shutdownApi();
});

describe('calendar api', () => {
  it('rejects malformed windows', async () => {
    const bad = await call('GET', '/api/v1/Calendar?from=2026-03-10&to=2026-03-01', adminToken);
    expect(bad.status).toBe(400);
    const missing = await call('GET', '/api/v1/Calendar', adminToken);
    expect(missing.status).toBe(400);
    const zone = await call('GET', '/api/v1/Calendar?from=2026-03-01&to=2026-03-31&timeZone=Not/AZone', adminToken);
    expect(zone.status).toBe(400);
  });

  it('returns activities that fall inside the window', async () => {
    const res = await call('GET', '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z', adminToken);
    expect(res.status).toBe(200);
    const mine = eventsOf(res.body).filter((event) => event['activityId'] === meeting);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      activityType: 'Meeting',
      status: 'Planned',
      start: '2026-03-11T09:00:00.000Z',
      end: '2026-03-11T10:00:00.000Z',
      recurring: false,
      base: true,
      duration: 3600,
    });
  });

  it('expands recurring activities into one event per occurrence', async () => {
    const res = await call('GET', '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z', adminToken);
    const occurrences = eventsOf(res.body).filter((event) => event['activityId'] === recurringTask);
    expect(occurrences.map((event) => String(event['day']).slice(0, 10))).toEqual([
      '2026-03-02',
      '2026-03-06',
      '2026-03-09',
      '2026-03-13',
      '2026-03-16',
      '2026-03-20',
      '2026-03-23',
      '2026-03-27',
      '2026-03-30',
    ]);
    expect(occurrences.every((event) => event['recurring'] === true)).toBe(true);
    expect(occurrences.filter((event) => event['base'] === true)).toHaveLength(1);
  });

  it('buckets days in the requested time zone', async () => {
    const late = await createActivity('Call', {
      name: `Cal Late Call ${runId}`,
      status: 'Planned',
      dateStart: '2026-03-14T23:30:00.000Z',
      direction: 'Outbound',
    });
    const utc = await call('GET', '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&entities=Call', adminToken);
    const utcEvent = eventsOf(utc.body).find((event) => event['activityId'] === late);
    expect(utcEvent?.['day']).toBe('2026-03-14');

    const bangkok = await call(
      'GET',
      '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&entities=Call&timeZone=Asia/Bangkok',
      adminToken,
    );
    const localEvent = eventsOf(bangkok.body).find((event) => event['activityId'] === late);
    // UTC+7 pushes 23:30Z into the next local day
    expect(localEvent?.['day']).toBe('2026-03-15');
  });

  it('filters by assigned user', async () => {
    const res = await call(
      'GET',
      `/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&userId=${adminId}`,
      adminToken,
    );
    expect(eventsOf(res.body).some((event) => event['activityId'] === meeting)).toBe(true);
    const nobody = await call(
      'GET',
      '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&userId=does-not-exist',
      adminToken,
    );
    expect(eventsOf(nobody.body)).toHaveLength(0);
  });

  it('applies record-level ACL to calendar results', async () => {
    await createTestRole(ctx, {
      id: `calendarOwn${runId}`,
      name: `Calendar own ${runId}`,
      permissions: {
        Task: { read: 'own', create: 'yes', edit: 'yes' },
        Meeting: { read: 'own', create: 'yes', edit: 'yes' },
        Call: { read: 'own', create: 'yes', edit: 'yes' },
      },
    });
    const other: TestUser = await createTestUser(ctx, { userName: `cal_own_${runId}`, roleIds: [`calendarOwn${runId}`] });
    const res = await call('GET', '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z', other.token);
    expect(res.status).toBe(200);
    expect(eventsOf(res.body)).toHaveLength(0);

    await call('POST', '/api/v1/Meeting', other.token, {
      name: `Cal Own Meeting ${runId}`,
      status: 'Planned',
      dateStart: '2026-03-18T09:00:00.000Z',
      assignedUserId: other.id,
    });
    const mine = await call('GET', '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z', other.token);
    const names = eventsOf(mine.body).map((event) => event['name']);
    expect(names).toContain(`Cal Own Meeting ${runId}`);
    expect(names).not.toContain(`Cal Meeting ${runId}`);
  });

  it('requires anonymous callers to authenticate', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/Calendar?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(401);
  });
});
