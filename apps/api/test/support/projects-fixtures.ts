import { sql } from 'kysely';

import type { ApiContext } from './boot-api.js';
import { authHeader } from './boot-api.js';

/**
 * Fixtures for the Phase 19 suites.
 *
 * Every record is created through the public API with an `AGENT_TEST_` marker and is deleted by its
 * own id in `cleanup()` (AGENTS.MD §3.3): nothing is shared between runs, nothing broad is deleted,
 * and the configured primary database is the only target.
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ProjectFixture {
  readonly runId: string;
  readonly ids: string[];
  call: (method: Method, url: string, payload?: unknown, token?: string) => Promise<CallResult>;
  create: (entity: string, data?: Record<string, unknown>) => Promise<string>;
  createProject: (data?: Record<string, unknown>) => Promise<string>;
  createGroup: (projectId: string, data?: Record<string, unknown>) => Promise<string>;
  createTask: (projectId: string, groupId: string, data?: Record<string, unknown>) => Promise<string>;
  createMember: (projectId: string, userId: string, roleId?: string) => Promise<string>;
  stageId: (key: string) => Promise<string>;
  /** Register a project id created outside the fixture (a clone) so its rows are cleaned too. */
  trackProject: (projectId: string) => void;
  cleanup: () => Promise<void>;
}

/**
 * The specific reason behind a rejected request. The HTTP message is the localized face of the
 * error code, so the useful text rides along as `error.details.reason` (see the global exception
 * filter) — that is what "The task cannot be completed: FinishToStart …" tests read.
 */
export function reasonOf(result: CallResult): string {
  const error = result.body['error'] as { message?: string; details?: Record<string, unknown> } | undefined;
  return String(error?.details?.['reason'] ?? error?.message ?? '');
}

export async function projectFixture(ctx: ApiContext, token?: string): Promise<ProjectFixture> {
  const runId = `pj${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`;
  const adminToken = token ?? ctx.adminToken;
  const ids: string[] = [];
  const projectIds: string[] = [];
  const stages = new Map<string, string>();

  const call = async (method: Method, url: string, payload?: unknown, asToken = adminToken): Promise<CallResult> => {
    const res = await ctx.app.inject({
      method,
      url,
      headers: authHeader(asToken),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
  };

  const createdId = (result: CallResult, what: string): string => {
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`${what} failed: ${String(result.status)} ${JSON.stringify(result.body)}`);
    }
    const id = String(result.body['id'] ?? '');
    if (id === '') throw new Error(`${what} returned no id: ${JSON.stringify(result.body)}`);
    ids.push(id);
    return id;
  };

  const fixture: ProjectFixture = {
    runId,
    ids,
    call,
    async create(entity, data = {}) {
      return createdId(await call('POST', `/api/v1/${entity}`, { name: `AGENT_TEST_${runId} ${entity}`, ...data }), `create ${entity}`);
    },
    async createProject(data = {}) {
      const id = createdId(
        await call('POST', '/api/v1/Project', { name: `AGENT_TEST Project ${runId}`, boardId: 'projectBoardDefault', ...data }),
        'create project',
      );
      projectIds.push(id);
      return id;
    },
    trackProject(projectId) {
      if (projectId === '') return;
      projectIds.push(projectId);
      // The clone's own project row too: its child rows are removed by project id, the record
      // itself by id (AGENTS.MD §3.3: this run cleans up everything this run created).
      ids.push(projectId);
    },
    async createGroup(projectId, data = {}) {
      return createdId(
        await call('POST', `/api/v1/Project/${projectId}/action/groupCreate`, { name: `AGENT_TEST Group ${runId}`, groupType: 'Work', ...data }),
        'create group',
      );
    },
    async createTask(projectId, groupId, data = {}) {
      return createdId(
        await call('POST', `/api/v1/Project/${projectId}/action/taskCreate`, {
          projectId,
          groupId,
          name: `AGENT_TEST Task ${runId}`,
          stageId: await fixture.stageId('notStarted'),
          ...data,
        }),
        'create task',
      );
    },
    async createMember(projectId, userId, roleId = 'projectRoleMember') {
      return createdId(await call('POST', `/api/v1/Project/${projectId}/action/members`, { userId, projectRoleId: roleId }), 'add member');
    },
    async stageId(key) {
      const known = stages.get(key);
      if (known !== undefined) return known;
      const where = encodeURIComponent(JSON.stringify([{ field: 'key', operator: 'equals', value: key }]));
      const result = await call('GET', `/api/v1/ProjectBoardStage?where=${where}&maxSize=1`);
      const list = (result.body['list'] ?? []) as Record<string, unknown>[];
      const id = String(list[0]?.['id'] ?? '');
      if (id === '') throw new Error(`seeded stage "${key}" is missing from the default board`);
      stages.set(key, id);
      return id;
    },
    async cleanup() {
      // A clone writes rows the fixture never saw (tasks, groups, memberships, dependencies, edges),
      // so every record pointing at a project this run created is removed by that project id —
      // still a narrow predicate naming only this run's own projects (AGENTS.MD §3.3).
      if (projectIds.length > 0) {
        await sql`
          delete from entity_records
          where entity_type in ('ProjectTask', 'ProjectGroup', 'ProjectMember', 'ProjectTaskCollaborator', 'ProjectTaskDependency')
            and (attrs ->> 'projectId') = any(array[${sql.join(projectIds)}]::text[])
        `.execute(ctx.database.db).catch(() => undefined);
      }
      if (ids.length === 0) return;
      await ctx.database.db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
      const { purgeEntityEvents } = await import('./boot-api.js');
      await purgeEntityEvents(ctx.database, [
        'Project',
        'ProjectTask',
        'ProjectGroup',
        'ProjectMember',
        'ProjectCategory',
        'ProjectTaskDependency',
        'ProjectTaskCollaborator',
      ]);
    },
  };

  return fixture;
}
