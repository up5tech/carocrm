import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import {
  authHeader,
  bootApi,
  createTestRole,
  createTestTeam,
  createTestUser,
  shutdownApi,
} from './support/boot-api.js';

/**
 * Phase 19-SD.4 – 19-SD.5 — case state machine, assignment, queues and routing
 * (PLAN_Phase_19_ServiceDesk.md §5.2, §5.3, §7.1, §7.2, §7.4).
 *
 * These run against the already-configured primary database through the real HTTP API (AGENTS.md §3.1):
 * no database, schema or container is created. Every record this suite makes carries the `runId`
 * marker and is removed by exact id in `afterAll` (§3.3): the entities through the generic API, the
 * module-written history/notification/outbox rows by the exact `caseId` this run used. The settings
 * this suite switches on (queues, notifications) are restored to their prior value, so the shared
 * instance is left as it was found.
 */
let ctx: ApiContext;
let runId: string;
let priorSettings: Record<string, unknown>;
const created: { entity: string; id: string }[] = [];
const caseIds: string[] = [];
const teamIds: string[] = [];

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

async function createCase(extra: Record<string, unknown> = {}): Promise<string> {
  const id = await create('Case', { name: marker('subject'), requesterName: marker('Requester'), ...extra });
  caseIds.push(id);
  return id;
}

async function readCase(id: string): Promise<Record<string, unknown>> {
  const res = await call('GET', `/api/v1/Case/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const transition = (id: string, body: Record<string, unknown>, token = ctx.adminToken) =>
  call('POST', `/api/v1/ServiceDesk/action/case/${id}/transition`, body, token);

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdw${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorSettings = settings.body['settings'] as Record<string, unknown>;
  // The optional capabilities this suite exercises default off; switch them on for the run.
  const enabled = await call('POST', '/api/v1/ServiceDesk/action/settings', {
    features: { queues: true, notifications: true },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
});

afterAll(async () => {
  // Restore the shared instance's configuration first, then remove only this run's rows.
  await call('POST', '/api/v1/ServiceDesk/action/settings', {
    features: priorSettings['features'],
    resolution: priorSettings['resolution'],
    assignment: priorSettings['assignment'],
  });

  // Module-written rows keyed by this run's case ids (exact predicate, §3.3).
  if (caseIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', 'in', ['CaseTransition', 'CaseAssignment']).where(sql`attrs ->> 'caseId'`, 'in', caseIds).execute();
    await ctx.database.db.deleteFrom('notifications').where(sql`data ->> 'caseId'`, 'in', caseIds).execute();
    await ctx.database.db.deleteFrom('outbox_events').where(sql`payload ->> 'caseId'`, 'in', caseIds).execute();
  }
  // Generic records, children before parents.
  for (const entry of [...created].reverse()) {
    await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`);
  }
  // Team membership and the teams themselves.
  for (const teamId of teamIds) {
    await ctx.database.db.deleteFrom('users_teams').where('team_id', '=', teamId).execute();
    await ctx.database.db.deleteFrom('teams').where('id', '=', teamId).execute();
  }
  await shutdownApi();
});

describe('case state machine and resolution workflow (§5.2, 19-SD.4)', () => {
  it('walks the documented lifecycle and keeps an ordered transition history', async () => {
    const id = await createCase();
    expect((await readCase(id))['status']).toBe('New');

    const start = await transition(id, { command: 'start', reason: 'triage done' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect((await readCase(id))['status']).toBe('Open');

    expect((await transition(id, { command: 'setPendingCustomer' })).status).toBe(200);
    expect((await readCase(id))['status']).toBe('Pending Customer');
    expect((await transition(id, { command: 'start' })).status).toBe(200);

    const resolve = await transition(id, { command: 'resolve', resolutionCode: 'Solved' });
    expect(resolve.status, JSON.stringify(resolve.body)).toBe(200);
    const resolved = await readCase(id);
    expect(resolved['status']).toBe('Resolved');
    expect(typeof resolved['resolvedAt']).toBe('string');
    expect(resolved['resolvedById']).toBeTruthy();

    const close = await transition(id, { command: 'close' });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect((await readCase(id))['status']).toBe('Closed');

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/history`);
    expect(history.status).toBe(200);
    const commands = (history.body['list'] as { command: string; toStatus: string }[]).map((entry) => entry.command);
    expect(commands).toEqual(['start', 'setPendingCustomer', 'start', 'resolve', 'close']);
  });

  it('refuses an invalid transition and changes nothing', async () => {
    const id = await createCase();
    const refused = await transition(id, { command: 'close' });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('CASE_TRANSITION_NOT_ALLOWED');

    const refusedDirect = await transition(id, { to: 'Closed' });
    expect(refusedDirect.status).toBe(422);

    const after = await readCase(id);
    expect(after['status']).toBe('New');
    expect(after['resolvedAt'] ?? null).toBeNull();
    expect(after['closedAt'] ?? null).toBeNull();

    // No partial history row was written for the refused command.
    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/history`);
    expect((history.body['list'] as unknown[]).length).toBe(0);
  });

  it('requires a resolution code by default', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    const withoutCode = await transition(id, { command: 'resolve' });
    expect(withoutCode.status).toBe(422);
    expect(JSON.stringify(withoutCode.body)).toContain('CASE_RESOLUTION_REQUIRED');
    expect((await readCase(id))['status']).toBe('Open');

    const withCode = await transition(id, { command: 'resolve', resolutionCode: 'Solved', resolutionSummary: 'Fixed.' });
    expect(withCode.status, JSON.stringify(withCode.body)).toBe(200);
    expect((await readCase(id))['status']).toBe('Resolved');
  });

  it('requires a prior resolution before closing', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    expect((await transition(id, { command: 'close' })).status).toBe(422);
    await transition(id, { command: 'resolve', resolutionCode: 'Solved' });
    expect((await transition(id, { command: 'close' })).status).toBe(200);
    expect((await readCase(id))['status']).toBe('Closed');
  });

  it('preserves the prior resolution across a reopen', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    await transition(id, { command: 'resolve', resolutionCode: 'Workaround' });
    const resolvedAt = (await readCase(id))['resolvedAt'];

    const reopen = await transition(id, { command: 'reopen', reason: 'recurred' });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
    const reopened = await readCase(id);
    expect(reopened['status']).toBe('Open');
    expect(reopened['reopenedAt']).toBeTruthy();
    // The plan is explicit: reopening never erases the prior resolution timestamp.
    expect(reopened['resolvedAt']).toBe(resolvedAt);

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/history`);
    const list = history.body['list'] as { command: string; toStatus: string; reason: string | null }[];
    expect(list.map((entry) => entry.command)).toContain('reopen');
    expect(list.find((entry) => entry.command === 'reopen')?.reason).toBe('recurred');
  });

  it('runs a transition idempotently for the same key', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    const first = await transition(id, { command: 'resolve', resolutionCode: 'Solved', idempotencyKey: 'once' });
    expect(first.status).toBe(200);
    expect(first.body['changed']).toBe(true);

    const second = await transition(id, { command: 'resolve', resolutionCode: 'Solved', idempotencyKey: 'once' });
    expect(second.status).toBe(200);
    expect(second.body['idempotent']).toBe(true);
    expect(second.body['changed']).toBe(false);

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/history`);
    const resolves = (history.body['list'] as { command: string }[]).filter((entry) => entry.command === 'resolve');
    expect(resolves).toHaveLength(1);
  });

  it('escalates and de-escalates a case', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    const escalated = await transition(id, { command: 'escalate' });
    expect(escalated.status, JSON.stringify(escalated.body)).toBe(200);
    const afterEscalate = await readCase(id);
    expect(afterEscalate['status']).toBe('Escalated');
    expect(afterEscalate['isEscalated']).toBe(true);

    expect((await transition(id, { command: 'deEscalate' })).status).toBe(200);
    const afterDeescalate = await readCase(id);
    expect(afterDeescalate['status']).toBe('Open');
    expect(afterDeescalate['isEscalated']).toBe(false);
  });

  it('reports the commands the current status allows', async () => {
    const id = await createCase();
    const caps = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/capabilities`);
    expect(caps.status, JSON.stringify(caps.body)).toBe(200);
    const allowed = caps.body['allowedCommands'] as string[];
    expect(allowed).toContain('start');
    expect(allowed).toContain('resolve');
    expect(allowed).not.toContain('close');

    await transition(id, { command: 'resolve', resolutionCode: 'Solved' });
    const resolvedCaps = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/capabilities`);
    expect((resolvedCaps.body['allowedCommands'] as string[])).toContain('close');
    expect((resolvedCaps.body['allowedCommands'] as string[])).toContain('reopen');
  });

  it('lets a case-owning agent transition their own case and refuses a read-only user', async () => {
    const roleId = `role_sd_own_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `SD owner ${runId}`,
      permissions: { Case: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } },
    });
    const agent = await createTestUser(ctx, { userName: `sd_owner_${runId}`, roleIds: [roleId] });
    const own = await create('Case', { name: marker('agent subject'), requesterName: marker('R') }, agent.token);
    caseIds.push(own);

    expect((await transition(own, { command: 'start' }, agent.token)).status).toBe(200);
    expect((await transition(own, { command: 'resolve', resolutionCode: 'Solved' }, agent.token)).status).toBe(200);
    expect((await readCase(own))['status']).toBe('Resolved');

    const readerRoleId = `role_sd_read_${runId}`;
    await createTestRole(ctx, {
      id: readerRoleId,
      name: `SD reader ${runId}`,
      permissions: { Case: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } },
    });
    const reader = await createTestUser(ctx, { userName: `sd_reader_${runId}`, roleIds: [readerRoleId] });
    const denied = await transition(own, { command: 'reopen' }, reader.token);
    expect(denied.status).toBe(403);
  });

  it('refuses a stale version instead of overwriting it', async () => {
    const id = await createCase();
    await transition(id, { command: 'start' });
    const conflict = await transition(id, { command: 'resolve', resolutionCode: 'Solved', version: 999_999 });
    expect(conflict.status).toBe(409);
    expect((await readCase(id))['status']).toBe('Open');
  });
});

describe('assignment, queues and routing (§5.3, 19-SD.5)', () => {
  let teamA: string;
  let teamB: string;
  let agentA: { id: string; token: string };
  let agentB: { id: string; token: string };
  let agentC: { id: string; token: string };

  beforeAll(async () => {
    teamA = `team_sd_a_${runId}`;
    teamB = `team_sd_b_${runId}`;
    await createTestTeam(ctx, teamA, `SD Team A ${runId}`);
    await createTestTeam(ctx, teamB, `SD Team B ${runId}`);
    teamIds.push(teamA, teamB);
    agentA = await createTestUser(ctx, { userName: `sd_a_${runId}`, teamIds: [teamA] });
    agentB = await createTestUser(ctx, { userName: `sd_b_${runId}`, teamIds: [teamA] });
    agentC = await createTestUser(ctx, { userName: `sd_c_${runId}`, teamIds: [teamB] });
  });

  async function makeQueue(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
    return create('CaseQueue', { name: marker(`queue ${suffix}`), code: `q_${suffix}_${runId}`, ...extra });
  }

  async function makeRule(suffix: string, extra: Record<string, unknown>): Promise<string> {
    return create('RoutingRule', {
      name: marker(`rule ${suffix}`),
      conditions: JSON.stringify([{ field: 'priority', operator: 'equals', value: 'High' }]),
      ...extra,
    });
  }

  it('manually assigns a case to an active agent and records history', async () => {
    const id = await createCase();
    const res = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { assignedUserId: agentA.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['assignedUserId']).toBe(agentA.id);
    expect((await readCase(id))['assignedUserId']).toBe(agentA.id);

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/assignments`);
    expect(history.status).toBe(200);
    const list = history.body['list'] as { assignedUserId: string; previousAssignedUserId: string | null }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.assignedUserId).toBe(agentA.id);
    expect(list[0]?.previousAssignedUserId).toBeNull();
  });

  it('assigns a case to a team', async () => {
    const id = await createCase();
    const res = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { teamId: teamA });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readCase(id);
    expect(after['teamId']).toBe(teamA);
    expect(after['assignedUserId'] ?? null).toBeNull();
  });

  it('round-robins across queue members without repeats', async () => {
    const queueId = await makeQueue('rr', { strategy: 'roundRobin', defaultTeamId: teamA });
    const ids = [await createCase(), await createCase(), await createCase()];
    const picked: unknown[] = [];
    for (const id of ids) {
      const res = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, {
        queueId,
        strategy: 'roundRobin',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      picked.push(res.body['assignedUserId']);
    }
    // Two members, three turns: the ring cycles a → b → a, never the same member twice in a row.
    expect(new Set(picked.slice(0, 2)).size).toBe(2);
    expect(picked[0]).toBe(picked[2]);
  });

  it('keeps the round-robin cursor consistent under concurrent assignment', async () => {
    const queueId = await makeQueue('rrc', { strategy: 'roundRobin', defaultTeamId: teamA });
    const ids = await Promise.all([createCase(), createCase(), createCase(), createCase()]);

    // Four simultaneous claims on one queue. The cursor row is locked (`SELECT … FOR UPDATE`), so the
    // claims serialise and the ring deals each of the two members exactly two cases; without the lock
    // every claim would read the same "next" and stack on one member.
    const responses = await Promise.all(
      ids.map((id) =>
        call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { queueId, strategy: 'roundRobin' }),
      ),
    );
    const picked = responses.map((res) => {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return String(res.body['assignedUserId']);
    });
    const counts = picked.reduce<Record<string, number>>((acc, userId) => {
      acc[userId] = (acc[userId] ?? 0) + 1;
      return acc;
    }, {});
    expect(Object.values(counts).sort()).toEqual([2, 2]);
  });

  it('picks the least-busy member', async () => {
    const queueId = await makeQueue('lb', { strategy: 'leastBusy', defaultTeamId: teamB });
    // Give agentC a busy backlog; agentD (teamA? no — teamB) is the only other member.
    const agentD = await createTestUser(ctx, { userName: `sd_d_${runId}`, teamIds: [teamB] });
    await createCase({ assignedUserId: agentC.id });
    await createCase({ assignedUserId: agentC.id });
    const id = await createCase();
    const res = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { queueId, strategy: 'leastBusy' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['assignedUserId']).toBe(agentD.id);
  });

  it('never drops a case whose queue has no eligible member', async () => {
    const emptyTeam = `team_sd_empty_${runId}`;
    await createTestTeam(ctx, emptyTeam, `SD Empty ${runId}`);
    teamIds.push(emptyTeam);
    const queueId = await makeQueue('empty', {
      strategy: 'roundRobin',
      defaultTeamId: emptyTeam,
      fallbackBehavior: 'unassigned',
    });
    // A rule (matched by `type`) sends incidents to the queue; the empty team has no member to pick.
    await makeRule('incident', {
      sortOrder: 0,
      queueId,
      conditions: JSON.stringify([{ field: 'type', operator: 'equals', value: 'Incident' }]),
    });
    const id = await createCase({ type: 'Incident' });

    const routed = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    expect(routed.body['queueId']).toBe(queueId);
    expect(routed.body['assignedUserId'] ?? null).toBeNull();
    expect(routed.body['warnings']).toContain('QUEUE_HAS_NO_ELIGIBLE_AGENT');

    // The case still exists, retained in its queue rather than dropped.
    const after = await readCase(id);
    expect(after['queueId']).toBe(queueId);
    expect(after['assignedUserId'] ?? null).toBeNull();
  });

  it('applies the first matching routing rule deterministically', async () => {
    const first = await makeQueue('r1', { strategy: 'manual' });
    const second = await makeQueue('r2', { strategy: 'manual' });
    const ruleFirst = await makeRule('first', { sortOrder: 1, queueId: first });
    await makeRule('second', { sortOrder: 2, queueId: second });

    const id = await createCase({ priority: 'High' });
    const routed = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/route`, {});
    expect(routed.status, JSON.stringify(routed.body)).toBe(200);
    expect(routed.body['queueId']).toBe(first);
    expect((routed.body['decision'] as Record<string, unknown>)['routingRuleId']).toBe(ruleFirst);

    // A case that matches no rule keeps its existing ownership and records the fallback reason.
    const other = await createCase({ priority: 'Low' });
    const miss = await call('POST', `/api/v1/ServiceDesk/action/case/${other}/route`, {});
    expect(miss.status, JSON.stringify(miss.body)).toBe(200);
    expect((miss.body['decision'] as Record<string, unknown>)['fallbackReason']).toBe('no-rule-matched');
  });

  it('validates a routing rule at save time', async () => {
    const badField = await call('POST', '/api/v1/RoutingRule', {
      name: marker('rule bad field'),
      conditions: JSON.stringify([{ field: 'categoryId', operator: 'equals', value: 'x' }]),
    });
    expect(badField.status).toBe(422);

    const notJson = await call('POST', '/api/v1/RoutingRule', {
      name: marker('rule not json'),
      conditions: 'priority = High',
    });
    expect(notJson.status).toBe(422);
  });

  it('refuses assignment to an ineligible or inactive user', async () => {
    const queueId = await makeQueue('elig', { strategy: 'manual', defaultTeamId: teamA });
    const id = await createCase();
    // agentC is not a member of teamA, so is not eligible for this queue.
    const ineligible = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, {
      queueId,
      assignedUserId: agentC.id,
    });
    expect(ineligible.status).toBe(422);

    const inactive = await createTestUser(ctx, { userName: `sd_off_${runId}` });
    await ctx.database.db.updateTable('users').set({ is_active: false }).where('id', '=', inactive.id).execute();
    const disabled = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, {
      assignedUserId: inactive.id,
    });
    expect(disabled.status).toBe(422);
  });

  it('reports per-agent workload for a queue', async () => {
    const queueId = await makeQueue('work', { strategy: 'manual', defaultTeamId: teamA });
    const assigned = await createCase();
    await call('POST', `/api/v1/ServiceDesk/action/case/${assigned}/assign`, { queueId, assignedUserId: agentA.id });
    const unassigned = await createCase();
    await call('POST', `/api/v1/ServiceDesk/action/case/${unassigned}/assign`, { queueId });

    const res = await call('GET', `/api/v1/ServiceDesk/action/queues/${queueId}/workload`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const members = res.body['members'] as { userId: string; activeCases: number }[];
    const memberA = members.find((member) => member.userId === agentA.id);
    expect(memberA?.activeCases).toBeGreaterThanOrEqual(1);
    expect(res.body['unassigned']).toBeGreaterThanOrEqual(1);
  });

  it('records assignment idempotently for the same key', async () => {
    const id = await createCase();
    const first = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, {
      assignedUserId: agentA.id,
      idempotencyKey: 'assign-once',
    });
    expect(first.status).toBe(200);
    expect(first.body['changed']).toBe(true);

    const second = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, {
      assignedUserId: agentB.id,
      idempotencyKey: 'assign-once',
    });
    expect(second.status).toBe(200);
    expect(second.body['idempotent']).toBe(true);

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/assignments`);
    expect((history.body['list'] as unknown[]).length).toBe(1);
  });

  it('enforces the assignment scope for a non-privileged agent', async () => {
    const roleId = `role_sd_assign_${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `SD assigner ${runId}`,
      permissions: { Case: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } },
    });
    const agent = await createTestUser(ctx, { userName: `sd_scoped_${runId}`, roleIds: [roleId] });
    const own = await create('Case', { name: marker('scoped case'), requesterName: marker('R') }, agent.token);
    caseIds.push(own);

    // Claiming a case the agent may edit is allowed.
    const claim = await call('POST', `/api/v1/ServiceDesk/action/case/${own}/assign`, { assignedUserId: agent.id }, agent.token);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    // Assigning to a user outside the agent's queues/teams is refused.
    const outside = await call(
      'POST',
      `/api/v1/ServiceDesk/action/case/${own}/assign`,
      { assignedUserId: agentC.id },
      agent.token,
    );
    expect(outside.status).toBe(403);
    expect(JSON.stringify(outside.body)).toContain('CASE_ASSIGNMENT_FORBIDDEN');
  });

  it('creates a notification for the new assignee when notifications are enabled', async () => {
    const id = await createCase();
    const res = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { assignedUserId: agentB.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await ctx.database.db
      .selectFrom('notifications')
      .select(['id', 'user_id'])
      .where('type', '=', 'ServiceDeskCaseAssigned')
      .where(sql`data ->> 'caseId'`, '=', id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(agentB.id);
  });
});
