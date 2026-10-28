/**
 * Demo data for the Projects module (PLAN_Phase_19_Projects.md §4–§8).
 *
 * Everything is created through the real HTTP API of the booted application — never with raw SQL —
 * so the Projects guards derive each task status from its stage, check assignee membership, the
 * board boundary, the feature flags and the dependency graph exactly as a user's request would. If
 * this script succeeds, the data is valid by construction.
 *
 *   pnpm demo:projects            purge the previous set, then seed
 *   pnpm demo:projects:purge      only remove the demo set
 *
 * Every record this script owns carries a `demo` id prefix, so a purge can delete precisely this
 * set and nothing else (AGENTS.md §3.3). Tasks, groups, members, dependencies and collaborators get
 * generated ids, and are found by their `projectId`, which is always one of DEMO.projectIds.
 */
import pg from 'pg';

import { createApp, migrateDb } from '../apps/api/src/bootstrap.js';
import { buildConfig } from '../apps/api/src/config.js';
import { seed } from '../database/seed.js';

type Json = Record<string, unknown>;

const DAY_MS = 86_400_000;

/** A demo date as an offset from today, so the Gantt, the calendar and the dashlet always look alive. */
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const ADMIN_LOGIN = 'admin';
const ADMIN_PASSWORD = 'admin';

/** The ids this run owns. Fixed wherever the generic entity API accepts a client id. */
const DEMO = {
  userIds: ['demoUserMai', 'demoUserLinh', 'demoUserMinh', 'demoUserHa', 'demoUserQuan'],
  categoryIds: ['demoCategoryWeb', 'demoCategoryInternal', 'demoCategoryMarketing'],
  boardIds: ['demoBoardSimple'],
  stageIds: ['demoStageBacklog', 'demoStageDoing', 'demoStageDone'],
  projectIds: ['demoProjectWeb', 'demoProjectMobile', 'demoProjectMigration'],
} as const;

const ROLE_OWNER = 'projectRoleOwner';
const ROLE_EDITOR = 'projectRoleEditor';
const ROLE_MEMBER = 'projectRoleMember';

/** Stages of the seeded `Default board`; their ids come from `database/seed.ts`. */
const STD = {
  notStarted: 'projectStageNotStarted',
  inProgress: 'projectStageInProgress',
  blocked: 'projectStageBlocked',
  review: 'projectStageReview',
  done: 'projectStageDone',
  canceled: 'projectStageCanceled',
  deferred: 'projectStageDeferred',
} as const;

const USERS = [
  { id: 'demoUserMai', userName: 'demo.mai', firstName: 'Mai', lastName: 'Vu', title: 'Project Manager' },
  { id: 'demoUserLinh', userName: 'demo.linh', firstName: 'Linh', lastName: 'Tran', title: 'Product Designer' },
  { id: 'demoUserMinh', userName: 'demo.minh', firstName: 'Minh', lastName: 'Pham', title: 'Frontend Developer' },
  { id: 'demoUserHa', userName: 'demo.ha', firstName: 'Ha', lastName: 'Nguyen', title: 'Backend Developer' },
  { id: 'demoUserQuan', userName: 'demo.quan', firstName: 'Quan', lastName: 'Le', title: 'QA Engineer' },
] as const;

const CATEGORIES = [
  { id: 'demoCategoryWeb', name: 'Demo Web', parentId: undefined, sortOrder: 0 },
  { id: 'demoCategoryMarketing', name: 'Demo Web / Marketing site', parentId: 'demoCategoryWeb', sortOrder: 0 },
  { id: 'demoCategoryInternal', name: 'Demo Internal', parentId: undefined, sortOrder: 10 },
] as const;

interface MemberSeed {
  userId: string;
  roleId: string;
}

interface GroupSeed {
  key: string;
  name: string;
  groupType: 'Triage' | 'Backlog' | 'Work' | 'Phase' | 'Sprint';
  color?: string;
  sortOrder: number;
}

interface TaskSeed {
  key: string;
  group: string;
  name: string;
  /** Stage record id; omitted on a milestone, which has no stage column of its own. */
  stage?: string;
  milestone?: boolean;
  parent?: string;
  assignee?: string;
  owner?: string;
  start: number;
  end?: number;
  priority?: 'Low' | 'Normal' | 'High' | 'Urgent';
  points?: number;
  hours?: number;
  description?: string;
}

interface DependencySeed {
  successor: string;
  predecessor: string;
  dependencyType: 'FinishToStart' | 'FinishToFinish' | 'StartToStart' | 'StartToFinish';
}

interface ProjectSeed {
  id: string;
  name: string;
  description: string;
  boardId: string;
  categoryId: string;
  ownerUserId: string;
  start: number;
  end: number;
  settings: Json;
  activeGroup: string;
  members: MemberSeed[];
  groups: GroupSeed[];
  tasks: TaskSeed[];
  dependencies: DependencySeed[];
  collaborators: { task: string; userId: string }[];
}

const PROJECTS: ProjectSeed[] = [
  {
    id: 'demoProjectWeb',
    name: 'Demo Website Redesign',
    description: 'Full redesign of the marketing site: research, design system, build and launch.',
    boardId: 'projectBoardDefault',
    categoryId: 'demoCategoryMarketing',
    ownerUserId: 'demoUserMai',
    start: -24,
    end: 25,
    settings: { dependenciesEnabled: true, collaboratorsEnabled: false, pointsEnabled: true, priorityEnabled: true, ganttEnabled: true },
    activeGroup: 'design',
    members: [
      { userId: 'demoUserMai', roleId: ROLE_EDITOR },
      { userId: 'demoUserMinh', roleId: ROLE_MEMBER },
      { userId: 'demoUserHa', roleId: ROLE_MEMBER },
      { userId: 'demoUserQuan', roleId: ROLE_MEMBER },
    ],
    groups: [
      { key: 'discovery', name: 'Discovery', groupType: 'Phase', sortOrder: 0 },
      { key: 'design', name: 'Design', groupType: 'Phase', sortOrder: 10, color: '#438eff' },
      { key: 'build', name: 'Build', groupType: 'Phase', sortOrder: 20, color: '#55c27f' },
      { key: 'launch', name: 'Launch', groupType: 'Sprint', sortOrder: 30 },
      { key: 'triage', name: 'Nice to have', groupType: 'Backlog', sortOrder: 40 },
    ],
    tasks: [
      { key: 'w-interviews', group: 'discovery', name: 'Stakeholder interviews', stage: STD.done, assignee: 'demoUserMai', start: -24, end: -18, priority: 'High', points: 3 },
      { key: 'w-audit', group: 'discovery', name: 'Current site audit', stage: STD.done, assignee: 'demoUserHa', start: -22, end: -16, points: 5 },
      { key: 'w-analytics', group: 'discovery', name: 'Analytics baseline report', stage: STD.review, assignee: 'demoUserMinh', start: -20, end: -12, points: 2 },
      { key: 'w-scope', group: 'discovery', name: 'Scope agreed', milestone: true, owner: 'demoUserMai', start: -15, description: 'Sign-off recorded on the project stream.' },
      { key: 'w-ia', group: 'design', name: 'Information architecture', stage: STD.done, assignee: 'demoUserLinh', start: -14, end: -9, points: 5 },
      { key: 'w-wireframes', group: 'design', name: 'Wireframes: key templates', stage: STD.review, assignee: 'demoUserLinh', start: -9, end: -2, priority: 'Urgent', points: 8 },
      {
        key: 'w-tokens',
        group: 'design',
        name: 'Design system tokens',
        stage: STD.inProgress,
        assignee: 'demoUserLinh',
        start: -3,
        end: 4,
        priority: 'High',
        points: 5,
      },
      { key: 'w-tokens-color', group: 'design', name: 'Color scale and contrast check', stage: STD.inProgress, parent: 'w-tokens', assignee: 'demoUserMinh', start: -2, end: 2, points: 2 },
      { key: 'w-tokens-inventory', group: 'design', name: 'Component inventory', stage: STD.notStarted, parent: 'w-tokens', assignee: 'demoUserQuan', start: 1, end: 5 },
      { key: 'w-usability', group: 'design', name: 'Usability test round 1', stage: STD.notStarted, assignee: 'demoUserMai', start: 3, end: 7 },
      { key: 'w-cms', group: 'build', name: 'CMS content model', stage: STD.inProgress, assignee: 'demoUserHa', start: -1, end: 6, points: 8 },
      { key: 'w-templates', group: 'build', name: 'Front-end templates', stage: STD.notStarted, assignee: 'demoUserMinh', start: 6, end: 16, priority: 'High', points: 13 },
      { key: 'w-seo', group: 'build', name: 'SEO redirect migration', stage: STD.notStarted, assignee: 'demoUserHa', start: 12, end: 18, priority: 'High', points: 8 },
      { key: 'w-a11y', group: 'build', name: 'Accessibility pass (WCAG AA)', stage: STD.blocked, assignee: 'demoUserQuan', start: 8, end: 15, description: 'Blocked until the template set is stable.' },
      { key: 'w-blog', group: 'build', name: 'Legacy blog import', stage: STD.canceled, assignee: 'demoUserHa', start: 5, end: 6, priority: 'Low' },
      { key: 'w-freeze', group: 'launch', name: 'Content freeze checklist', stage: STD.notStarted, assignee: 'demoUserMai', start: 18, end: 21 },
      { key: 'w-deploy', group: 'launch', name: 'Production deploy', stage: STD.notStarted, assignee: 'demoUserHa', start: 22, end: 23, priority: 'Urgent' },
      { key: 'w-launch', group: 'launch', name: 'Launch day', milestone: true, owner: 'demoUserMai', start: 25 },
      { key: 'w-i18n', group: 'triage', name: 'Multilingual section (vi/en)', stage: STD.notStarted, assignee: 'demoUserLinh', start: 30, end: 40, points: 13 },
      { key: 'w-search', group: 'triage', name: 'Search facets redesign', stage: STD.notStarted, assignee: 'demoUserMinh', start: 34, end: 44 },
    ],
    dependencies: [
      { successor: 'w-cms', predecessor: 'w-audit', dependencyType: 'FinishToStart' },
      { successor: 'w-templates', predecessor: 'w-cms', dependencyType: 'FinishToStart' },
      { successor: 'w-seo', predecessor: 'w-templates', dependencyType: 'FinishToStart' },
      { successor: 'w-a11y', predecessor: 'w-templates', dependencyType: 'StartToStart' },
    ],
    collaborators: [],
  },
  {
    id: 'demoProjectMobile',
    name: 'Demo Mobile App Release 3.4',
    description: 'Release board for the mobile client; collaborators are on, estimates are not.',
    boardId: 'demoBoardSimple',
    categoryId: 'demoCategoryInternal',
    ownerUserId: 'demoUserMinh',
    start: -8,
    end: 12,
    settings: { dependenciesEnabled: false, collaboratorsEnabled: true, pointsEnabled: false, priorityEnabled: true, ganttEnabled: true },
    activeGroup: 'release',
    members: [
      { userId: 'demoUserMai', roleId: ROLE_OWNER },
      { userId: 'demoUserMinh', roleId: ROLE_EDITOR },
      { userId: 'demoUserHa', roleId: ROLE_MEMBER },
      { userId: 'demoUserQuan', roleId: ROLE_MEMBER },
    ],
    groups: [
      { key: 'release', name: 'Release 3.4', groupType: 'Sprint', sortOrder: 0, color: '#f8ac59' },
      { key: 'qa', name: 'QA', groupType: 'Work', sortOrder: 10 },
      { key: 'ideas', name: 'Ideas', groupType: 'Triage', sortOrder: 20 },
    ],
    tasks: [
      { key: 'm-store', group: 'release', name: 'Store listing copy', stage: 'demoStageDone', assignee: 'demoUserLinh', start: -8, end: -3 },
      { key: 'm-push', group: 'release', name: 'Push notification service', stage: 'demoStageDoing', assignee: 'demoUserHa', start: -5, end: 3, priority: 'Urgent' },
      { key: 'm-offline', group: 'release', name: 'Offline mode sync', stage: 'demoStageDoing', assignee: 'demoUserMinh', start: -2, end: 8, priority: 'High' },
      { key: 'm-submit', group: 'release', name: 'App store submission', milestone: true, owner: 'demoUserMai', start: 12 },
      { key: 'm-devices', group: 'qa', name: 'Device lab matrix', stage: 'demoStageBacklog', assignee: 'demoUserQuan', start: 0, end: 6 },
      { key: 'm-crash', group: 'qa', name: 'Crash-free rate dashboard', stage: 'demoStageBacklog', assignee: 'demoUserMai', start: 2, end: 9 },
      { key: 'm-tablet', group: 'ideas', name: 'Tablet layout spike', stage: 'demoStageBacklog', assignee: 'demoUserLinh', start: 4, end: 10 },
    ],
    dependencies: [],
    collaborators: [
      { task: 'm-push', userId: 'demoUserLinh' },
      { task: 'm-offline', userId: 'demoUserQuan' },
    ],
  },
  {
    id: 'demoProjectMigration',
    name: 'Demo Data Migration',
    description: 'Legacy CRM data move with estimates, points and a full dependency chain.',
    boardId: 'projectBoardDefault',
    categoryId: 'demoCategoryInternal',
    ownerUserId: 'demoUserHa',
    start: -12,
    end: 14,
    settings: { dependenciesEnabled: true, collaboratorsEnabled: false, pointsEnabled: true, estimatedHoursEnabled: true, priorityEnabled: true, ganttEnabled: true },
    activeGroup: 'cutover',
    members: [
      { userId: 'demoUserHa', roleId: ROLE_EDITOR },
      { userId: 'demoUserMai', roleId: ROLE_MEMBER },
      { userId: 'demoUserQuan', roleId: ROLE_MEMBER },
    ],
    groups: [
      { key: 'prep', name: 'Preparation', groupType: 'Phase', sortOrder: 0 },
      { key: 'cutover', name: 'Cutover', groupType: 'Phase', sortOrder: 10, color: '#fa626b' },
      { key: 'aftercare', name: 'Aftercare', groupType: 'Work', sortOrder: 20 },
    ],
    tasks: [
      { key: 'd-schema', group: 'prep', name: 'Schema diff report', stage: STD.done, assignee: 'demoUserHa', start: -12, end: -8, hours: 12, points: 5 },
      { key: 'd-mapping', group: 'prep', name: 'Field mapping sign-off', stage: STD.done, assignee: 'demoUserMai', start: -5, end: -4, points: 3 },
      { key: 'd-dryrun', group: 'prep', name: 'Migration dry run on staging', stage: STD.review, assignee: 'demoUserHa', start: -6, end: -1, hours: 20, points: 8 },
      { key: 'd-profile', group: 'prep', name: 'Data profile sampling', stage: STD.inProgress, parent: 'd-dryrun', assignee: 'demoUserQuan', start: -4, end: -1, hours: 6 },
      { key: 'd-idempotency', group: 'prep', name: 'Idempotency test suite', stage: STD.inProgress, assignee: 'demoUserQuan', start: -3, end: 2, hours: 16 },
      { key: 'd-rehearsal', group: 'cutover', name: 'Cutover rehearsal', stage: STD.notStarted, assignee: 'demoUserHa', start: 3, end: 5, hours: 8 },
      { key: 'd-window', group: 'cutover', name: 'Production migration window', stage: STD.notStarted, assignee: 'demoUserHa', start: 8, end: 9, priority: 'Urgent', hours: 6, description: 'Maintenance window announced to the customers.' },
      { key: 'd-complete', group: 'cutover', name: 'Migration complete', milestone: true, owner: 'demoUserMai', start: 12 },
      { key: 'd-reconcile', group: 'aftercare', name: 'Post-migration reconciliation', stage: STD.notStarted, assignee: 'demoUserHa', start: 9, end: 12, hours: 10, points: 5 },
      { key: 'd-retire', group: 'aftercare', name: 'Retire the legacy nightly job', stage: STD.deferred, assignee: 'demoUserMai', start: 20, end: 22, priority: 'Low' },
    ],
    dependencies: [
      { successor: 'd-dryrun', predecessor: 'd-schema', dependencyType: 'FinishToStart' },
      { successor: 'd-mapping', predecessor: 'd-schema', dependencyType: 'FinishToFinish' },
      { successor: 'd-idempotency', predecessor: 'd-dryrun', dependencyType: 'StartToStart' },
      { successor: 'd-rehearsal', predecessor: 'd-dryrun', dependencyType: 'StartToFinish' },
      { successor: 'd-window', predecessor: 'd-dryrun', dependencyType: 'FinishToStart' },
      { successor: 'd-window', predecessor: 'd-rehearsal', dependencyType: 'FinishToStart' },
      { successor: 'd-reconcile', predecessor: 'd-window', dependencyType: 'FinishToStart' },
    ],
    collaborators: [],
  },
];

let app: Awaited<ReturnType<typeof createApp>>;
let token = '';
let pool: pg.Pool;

async function api<T = Json>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const headers = { authorization: `Bearer ${token}` };
  // Two branches, not a conditional spread: the spread would widen `payload` to `{} | null` and the
  // Fastify inject types would reject it.
  const response =
    payload === undefined
      ? await app.inject({ method, url, headers })
      : await app.inject({ method, url, headers, payload: payload as Json });
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body.slice(0, 400)}`);
  }
  return response.json() as T;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Removes the demo set. Child rows are addressed by their `projectId`, which is always one of
 * DEMO.projectIds, so a partially finished earlier run is cleaned as well and nothing else can be
 * matched by these predicates.
 */
async function purge(): Promise<void> {
  const projectIds = [...DEMO.projectIds];
  const childIds = await pool.query(
    `SELECT id FROM entity_records
      WHERE (entity_type IN ('Project','ProjectCategory','ProjectBoard') AND id = ANY($1::text[]))
         OR (entity_type = 'ProjectBoardStage' AND (id = ANY($2::text[]) OR (attrs ->> 'boardId') = ANY($3::text[])))`,
    [
      [...projectIds, ...DEMO.categoryIds, ...DEMO.boardIds],
      [...DEMO.stageIds],
      [...DEMO.boardIds],
    ],
  );
  const workIds = await pool.query(
    `SELECT id FROM entity_records
      WHERE entity_type IN ('ProjectTask','ProjectGroup','ProjectMember','ProjectTaskDependency','ProjectTaskCollaborator')
        AND (attrs ->> 'projectId') = ANY($1::text[])`,
    [projectIds],
  );
  const allIds = [...childIds.rows, ...workIds.rows].map((row: { id: string }) => row.id);

  // One transaction: the demo set is either fully gone or fully present, never half removed.
  await pool.query('BEGIN');
  try {
    await pool.query(
      `DELETE FROM entity_records
        WHERE entity_type IN ('ProjectTaskDependency','ProjectTaskCollaborator','ProjectTask','ProjectGroup','ProjectMember')
          AND (attrs ->> 'projectId') = ANY($1::text[])`,
      [projectIds],
    );
    await pool.query(`DELETE FROM entity_records WHERE entity_type = 'Project' AND id = ANY($1::text[])`, [projectIds]);
    await pool.query(
      `DELETE FROM entity_records WHERE entity_type = 'ProjectBoardStage' AND (id = ANY($1::text[]) OR (attrs ->> 'boardId') = ANY($2::text[]))`,
      [[...DEMO.stageIds], [...DEMO.boardIds]],
    );
    await pool.query(
      `DELETE FROM entity_records WHERE entity_type IN ('ProjectBoard','ProjectCategory') AND (id = ANY($1::text[]) OR id = ANY($2::text[]))`,
      [[...DEMO.boardIds], [...DEMO.categoryIds]],
    );
    await pool.query(
      `DELETE FROM entity_links WHERE record_id_a = ANY($1::text[]) OR record_id_b = ANY($1::text[])`,
      [allIds],
    );
    // The outbox rows of a removed demo set can never be consumed; leaving them would grow a backlog
    // no worker can resolve (they reference records that are gone).
    await pool.query(
      `DELETE FROM outbox_events WHERE payload ->> 'entityId' = ANY($1::text[])
         OR payload ->> 'projectId' = ANY($2::text[]) OR payload ->> 'sourceId' = ANY($2::text[])`,
      [allIds, projectIds],
    );
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[]) AND user_name LIKE 'demo.%'`, [[...DEMO.userIds]]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
  say(`purged: ${allIds.length + projectIds.length} demo records and their links, events and users`);
}

async function createUsers(): Promise<void> {
  for (const user of USERS) {
    const existing = await pool.query('SELECT 1 FROM users WHERE id = $1', [user.id]);
    if ((existing.rowCount ?? 0) > 0) continue;
    await api('POST', '/api/v1/User', { ...user, isActive: true, password: 'demo-pass-123' });
  }
}

async function createProjectRecord(project: ProjectSeed): Promise<void> {
  await api('POST', '/api/v1/Project', {
    id: project.id,
    name: project.name,
    description: project.description,
    boardId: project.boardId,
    categoryId: project.categoryId,
    ownerUserId: project.ownerUserId,
    dateStart: day(project.start),
    dateEnd: day(project.end),
    assignedUserId: project.ownerUserId,
  });
}

async function fillProject(project: ProjectSeed): Promise<void> {
  // Feature flags first: a disabled feature is a write refusal, so tasks must come after.
  await api('POST', `/api/v1/Project/${project.id}/action/settings`, project.settings);

  for (const member of project.members) {
    await api('POST', `/api/v1/Project/${project.id}/action/members`, { userId: member.userId, projectRoleId: member.roleId });
  }

  const groups = new Map<string, string>();
  for (const group of project.groups) {
    const created = await api<{ id: string }>('POST', `/api/v1/Project/${project.id}/action/groupCreate`, {
      name: group.name,
      groupType: group.groupType,
      sortOrder: group.sortOrder,
      ...(group.color === undefined ? {} : { color: group.color }),
    });
    groups.set(group.key, created.id);
  }
  await api('POST', `/api/v1/Project/${project.id}/action/settings`, { activeGroupId: groups.get(project.activeGroup) });

  // Tasks are created in list order, so a parent and its predecessor always exist by the time they
  // are referenced; the seed tables keep that property explicit.
  const tasks = new Map<string, string>();
  for (const task of project.tasks) {
    const groupId = groups.get(task.group) ?? '';
    const payload = {
      projectId: project.id,
      name: task.name,
      groupId,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.milestone === true
        ? { dateStart: day(task.start), ownerUserId: task.owner ?? project.ownerUserId }
        : {
            stageId: task.stage,
            dateStart: day(task.start),
            ...(task.end === undefined ? {} : { dateEnd: day(task.end) }),
            ...(task.assignee === undefined ? {} : { assigneeUserId: task.assignee }),
            ...(task.owner === undefined ? {} : { ownerUserId: task.owner }),
            ...(task.priority === undefined ? {} : { priority: task.priority }),
            ...(task.points === undefined ? {} : { points: task.points }),
            ...(task.hours === undefined ? {} : { estimateHours: task.hours }),
          }),
    };
    const url = task.milestone === true ? `/api/v1/Project/${project.id}/action/milestone` : `/api/v1/Project/${project.id}/action/taskCreate`;
    const created = await api<{ id: string }>('POST', url, payload);
    tasks.set(task.key, created.id);
  }
  for (const task of project.tasks) {
    if (task.parent === undefined) continue;
    const parentTaskId = tasks.get(task.parent);
    const taskId = tasks.get(task.key);
    if (parentTaskId === undefined || taskId === undefined) continue;
    await api('POST', `/api/v1/ProjectTask/${taskId}/action/move`, { parentTaskId });
  }

  for (const edge of project.dependencies) {
    const successor = tasks.get(edge.successor);
    const predecessor = tasks.get(edge.predecessor);
    if (successor === undefined || predecessor === undefined) continue;
    await api('POST', `/api/v1/ProjectTask/${successor}/action/dependencies`, {
      predecessorTaskId: predecessor,
      dependencyType: edge.dependencyType,
    });
  }

  for (const collaboration of project.collaborators) {
    const taskId = tasks.get(collaboration.task);
    if (taskId === undefined) continue;
    await api('POST', `/api/v1/ProjectTask/${taskId}/action/collaboratorAdd`, { userId: collaboration.userId });
  }
}

async function report(): Promise<void> {
  for (const project of PROJECTS) {
    const plan = await api<{ groups: { tasks: Json[] }[] }>('GET', `/api/v1/Project/${project.id}/action/plan`);
    const board = await api<{ columns: { tasks: Json[] }[] }>('GET', `/api/v1/Project/${project.id}/action/board`);
    const gantt = await api<{ tasks: Json[] }>('GET', `/api/v1/Project/${project.id}/action/gantt`);
    const members = await api<{ list: Json[] }>('GET', `/api/v1/Project/${project.id}/action/members`);
    const taskCount = plan.groups.reduce((sum, group) => sum + group.tasks.length, 0);
    say(`${project.name}: ${taskCount} plan tasks, ${plan.groups.length} groups, ${board.columns.length} columns, ${gantt.tasks.length} gantt bars, ${members.list.length} members`);
  }
}

async function main(): Promise<void> {
  const purgeOnly = process.argv.includes('--purge');
  const config = buildConfig();
  pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

  // AGENTS.md §3.1: refuse to purge/seed against a production database unless explicitly forced.
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    throw new Error('projects-demo refused: NODE_ENV=production. Re-run with --force to purge/seed against this database.');
  }

  await purge();
  if (purgeOnly) {
    await pool.end();
    return;
  }

  await migrateDb(config.databaseUrl);
  await seed(config.databaseUrl, { adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });
  app = await createApp(config, { skipMigrations: true });

  const login = await app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName: ADMIN_LOGIN, password: ADMIN_PASSWORD } });
  if (login.statusCode !== 200 && login.statusCode !== 201) throw new Error(`admin login failed: ${login.statusCode} ${login.body}`);
  token = (login.json() as { accessToken: string }).accessToken;

  await createUsers();

  for (const category of CATEGORIES) {
    await api('POST', '/api/v1/ProjectCategory', {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      ...(category.parentId === undefined ? {} : { parentId: category.parentId }),
    });
  }

  await api('POST', '/api/v1/ProjectBoard', { id: DEMO.boardIds[0], name: 'Demo Simple board', description: 'Three-column board used by the demo mobile release.', isDefault: false });
  await api('POST', '/api/v1/ProjectBoardStage', { id: DEMO.stageIds[0], name: 'Backlog', boardId: DEMO.boardIds[0], key: 'backlog', statusValue: 'Not Started', sortOrder: 0 });
  await api('POST', '/api/v1/ProjectBoardStage', { id: DEMO.stageIds[1], name: 'Doing', boardId: DEMO.boardIds[0], key: 'doing', statusValue: 'Started', sortOrder: 10 });
  await api('POST', '/api/v1/ProjectBoardStage', { id: DEMO.stageIds[2], name: 'Done', boardId: DEMO.boardIds[0], key: 'done', statusValue: 'Completed', sortOrder: 20 });

  for (const project of PROJECTS) {
    await createProjectRecord(project);
  }

  // Bulk membership (PLAN §4.17): one request puts a user on every demo project at once. It runs
  // before the tasks, because an assignee has to be a member already.
  await api('POST', `/api/v1/Project/${DEMO.projectIds[0]}/action/memberBulk`, {
    projectIds: PROJECTS.map((project) => project.id),
    userIds: ['demoUserLinh'],
    projectRoleId: ROLE_MEMBER,
    operation: 'add',
  });

  for (const project of PROJECTS) {
    await fillProject(project);
  }

  await report();
  say('open /Project/demoProjectWeb/plan in the web UI');

  await app.close();
  await pool.end();
  // The booted app keeps the queue's Redis connection open, so Node would never leave the event loop
  // on its own; the work is committed and reported, so the script ends here.
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
