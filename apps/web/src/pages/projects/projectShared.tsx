import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Card, Spin, Tabs, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectBoardView, ProjectCapabilities, ProjectPlanView, ProjectTaskRow } from '../../api/types.js';
import { errorMessage } from '../../lib/errors.js';
import { t } from '../../state/i18n.js';
/**
 * Shared scaffolding for the Phase 19 Projects views (plans/PLAN_Phase_19_Projects.md §8).
 *
 * One query key per project so a move in the Plan view and a rename in the Board view invalidate
 * the same cache, and one shell that draws the view tabs. The capability document is fetched with
 * the data: the server decides what the caller may do, the UI only reflects it.
 */

export const PROJECT_STATUS_COLORS: Record<string, string> = {
  'Not Started': 'default',
  Started: 'processing',
  Completed: 'success',
  Canceled: 'warning',
  Deferred: 'orange',
};

export const PROJECT_PRIORITY_COLORS: Record<string, string> = {
  Low: 'default',
  Normal: 'blue',
  High: 'orange',
  Urgent: 'red',
};

export const PROJECT_GROUP_TYPES = ['Triage', 'Backlog', 'Work', 'Phase', 'Sprint'];

export function projectQueryKey(projectId: string): readonly string[] {
  return ['project', projectId];
}

export function useProjectPlan(projectId: string, enabled = true) {
  return useQuery({
    queryKey: [...projectQueryKey(projectId), 'plan'],
    queryFn: () => api.projectPlan(projectId),
    enabled,
  });
}

export function useProjectCapabilities(projectId: string) {
  return useQuery({
    queryKey: [...projectQueryKey(projectId), 'capabilities'],
    queryFn: () => api.projectCapabilities(projectId),
  });
}

/** EveryProjects view calls this after any mutation; `refresh` also re-reads the capabilities. */
export function useProjectRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
  };
}

/**
 * 24.10.2 — the optimistic-write shape every Projects mutation shares: cancel the in-flight read,
 * write the predicted result into the cache so the card moves (or the status flips) without waiting
 * for the round trip, put the snapshot back when the server refuses, and re-read either way so the
 * screen never keeps a value the server did not agree to. Authorization stays server-side: the
 * optimistic value is only a prediction, and a 403/409 restores the snapshot and reports the refusal.
 */
export function useOptimisticProjectMutation<TVars, TData>(
  queryKey: readonly unknown[],
  mutationFn: (vars: TVars) => Promise<unknown>,
  optimistic: (data: TData | undefined, vars: TVars) => TData | undefined,
  options?: { onError?: (error: unknown) => void; onSettled?: () => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData<TData>(queryKey);
      const next = optimistic(snapshot, vars);
      if (next !== undefined) queryClient.setQueryData(queryKey, next);
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      const snapshot = (context as { snapshot?: TData } | undefined)?.snapshot;
      if (snapshot !== undefined) queryClient.setQueryData(queryKey, snapshot);
      options?.onError?.(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      options?.onSettled?.();
    },
  });
}

export function useErrorReporter() {
  const { message } = AntApp.useApp();
  return (error: unknown) => {
    const text = errorMessage(error, String(error));
    void message.error(text === '' ? t('web.projects.errorGeneric') : text);
  };
}

export function projectViewPath(projectId: string, view: 'plan' | 'board' | 'gantt' | 'members' | 'settings'): string {
  return `/Project/${encodeURIComponent(projectId)}/${view}`;
}

export interface ShellProps {
  project: Record<string, unknown> | undefined;
  capabilities: ProjectCapabilities | undefined;
  active: 'plan' | 'board' | 'gantt' | 'members' | 'settings';
  loading?: boolean;
  error?: unknown;
  children: React.ReactNode;
}

/**
 * The project header and its view tabs. Gantt appears only when the project has it enabled — a
 * disabled view is hidden here and refused by the server (PLAN §4.11), never merely hidden.
 */
export function ProjectShell({ project, capabilities, active, loading = false, error, children }: ShellProps) {
  const navigate = useNavigate();
  const projectId = String(project?.['id'] ?? '');
  const ganttEnabled = capabilities?.features['ganttEnabled'] === true;

  // One navigation per tab: a `Link` inside a tab label and the `Tabs` onChange would both fire on a
  // click, and the second one sent Overview to `/Project/<id>/overview`, which no route matches.
  const items = [
    { key: 'overview', label: t('web.projects.tabOverview') },
    { key: 'plan', label: t('web.projects.tabPlan') },
    { key: 'board', label: t('web.projects.tabBoard') },
    ...(ganttEnabled ? [{ key: 'gantt', label: t('web.projects.tabGantt') }] : []),
    { key: 'members', label: t('web.projects.tabMembers') },
    { key: 'settings', label: t('web.projects.tabSettings') },
  ];

  return (
    <div className="carocrm-project">
      <Card
        className="carocrm-card"
        styles={{ body: { paddingBlock: 12 } }}
        title={
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.projects.breadcrumb')}
            </Typography.Text>
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {String(project?.['name'] ?? t('web.projects.loading'))}
              </Typography.Title>
            </div>
          </div>
        }
        extra={
          <div className="carocrm-project-dates">
            <Typography.Text type="secondary">
              {formatDay(project?.['dateStart'])} → {formatDay(project?.['dateEnd'])}
            </Typography.Text>
          </div>
        }
      >
        <Tabs
          activeKey={active}
          items={items}
          onChange={(key) => {
            if (key === active) return;
            navigate(
              key === 'overview'
                ? `/Project/${encodeURIComponent(projectId)}`
                : projectViewPath(projectId, key as 'plan' | 'board' | 'gantt' | 'members' | 'settings'),
            );
          }}
        />
      </Card>

      {error !== undefined && error !== null ? (
        <Alert type="error" showIcon style={{ marginBlock: 12 }} message={t('web.projects.loadFailed')} description={errorMessage(error)} />
      ) : null}

      <Spin spinning={loading} wrapperClassName="carocrm-project-body">{children}</Spin>
    </div>
  );
}

/** A `date` attribute arrives as an instant; the view shows the calendar day. */
export function formatDay(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value).slice(0, 10);
}

export function taskById(plan: ProjectPlanView | undefined, taskId: string): ProjectTaskRow | undefined {
  for (const group of plan?.groups ?? []) {
    const found = group.tasks.find((task) => task.id === taskId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRootTask(task: ProjectTaskRow): boolean {
  return task.parentTaskId === null || task.parentTaskId === '';
}

/** The dragged card plus every descendant — a subtask cannot be left behind in the old group. */
function taskAndDescendants(tasks: ProjectTaskRow[], taskId: string): ProjectTaskRow[] {
  const moving = new Set<string>([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (!moving.has(task.id) && task.parentTaskId !== null && moving.has(task.parentTaskId)) {
        moving.add(task.id);
        grew = true;
      }
    }
  }
  return tasks.filter((task) => moving.has(task.id));
}

/**
 * The plan cache after a drop: the card and its descendants leave the source group, land in the
 * target group in the dropped order, and every moved row carries the target `groupId` so the card
 * does not render under the old group's heading while the refetch is in flight.
 */
export function planWithTaskMove(
  plan: ProjectPlanView | undefined,
  taskId: string,
  targetGroupId: string,
  order: string[],
): ProjectPlanView | undefined {
  if (plan === undefined) return undefined;
  const all = plan.groups.flatMap((entry) => entry.tasks);
  const moving = taskAndDescendants(all, taskId);
  if (moving.length === 0) return plan;
  const movingIds = new Set(moving.map((task) => task.id));
  const moved = new Map(moving.map((task) => [task.id, { ...task, groupId: targetGroupId }]));
  const byId = new Map(all.map((task) => [task.id, task]));

  return {
    ...plan,
    groups: plan.groups.map((entry) => {
      const gid = String(entry.group['id']);
      if (gid !== targetGroupId) {
        return { ...entry, tasks: entry.tasks.filter((task) => !movingIds.has(task.id)) };
      }
      const roots = order
        .map((id) => moved.get(id) ?? byId.get(id))
        .filter((task): task is ProjectTaskRow => task !== undefined);
      const subtasks = [
        ...entry.tasks.filter((task) => !movingIds.has(task.id) && !isRootTask(task)),
        ...[...moved.values()].filter((task) => !isRootTask(task)),
      ];
      return { ...entry, tasks: [...roots, ...subtasks] };
    }),
  };
}

/** The plan cache after a lifecycle transition: only the status pill changes until the refetch lands. */
export function planWithTaskStatus(
  plan: ProjectPlanView | undefined,
  taskId: string,
  status: string,
): ProjectPlanView | undefined {
  if (plan === undefined) return undefined;
  return {
    ...plan,
    groups: plan.groups.map((entry) => ({
      ...entry,
      tasks: entry.tasks.map((task) => (task.id === taskId ? { ...task, status } : task)),
    })),
  };
}

/** The status a transition button predicts; the server stays the authority on the real outcome. */
export const TRANSITION_STATUS: Record<'start' | 'complete' | 'cancel', string> = {
  start: 'Started',
  complete: 'Completed',
  cancel: 'Canceled',
};

/**
 * The board cache after a drop: the card leaves its column, lands in the target column in the
 * dropped order, and carries the target `stageId` until the refetch confirms where the server put it.
 */
export function boardWithTaskMove(
  board: ProjectBoardView | undefined,
  taskId: string,
  stageId: string,
  order: string[],
): ProjectBoardView | undefined {
  if (board === undefined) return undefined;
  const movedTask = board.columns.flatMap((column) => column.tasks).find((task) => task.id === taskId);
  if (movedTask === undefined) return board;
  const moved = { ...movedTask, stageId };
  return {
    ...board,
    columns: board.columns.map((column) => {
      const kept = column.tasks.filter((task) => task.id !== taskId);
      if (String(column.stage['id']) !== stageId) return { ...column, tasks: kept };
      const byId = new Map(kept.map((task) => [task.id, task]));
      const ordered = order
        .map((id) => (id === taskId ? moved : byId.get(id)))
        .filter((task): task is ProjectTaskRow => task !== undefined);
      const orderedIds = new Set(order);
      return { ...column, tasks: [...ordered, ...kept.filter((task) => !orderedIds.has(task.id))] };
    }),
  };
}

/** Rows directly inside a group; subtasks hang below their parent instead. */
export function topLevelTasks(tasks: ProjectTaskRow[]): ProjectTaskRow[] {
  return tasks.filter((task) => task.parentTaskId === null || task.parentTaskId === '');
}

export function childrenOf(tasks: ProjectTaskRow[], parentId: string): ProjectTaskRow[] {
  return tasks.filter((task) => task.parentTaskId === parentId);
}
