import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Card, Spin, Tabs, Typography } from 'antd';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectCapabilities, ProjectPlanView, ProjectTaskRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Shared scaffolding for the Phase 19 Projects views (PLAN_Phase_19_Projects.md §8).
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

export function useErrorReporter() {
  const { message } = AntApp.useApp();
  return (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
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

  const items = [
    { key: 'overview', label: <Link to={`/Project/${encodeURIComponent(projectId)}`}>{t('web.projects.tabOverview')}</Link> },
    { key: 'plan', label: <Link to={projectViewPath(projectId, 'plan')}>{t('web.projects.tabPlan')}</Link> },
    { key: 'board', label: <Link to={projectViewPath(projectId, 'board')}>{t('web.projects.tabBoard')}</Link> },
    ...(ganttEnabled ? [{ key: 'gantt', label: <Link to={projectViewPath(projectId, 'gantt')}>{t('web.projects.tabGantt')}</Link> }] : []),
    { key: 'members', label: <Link to={projectViewPath(projectId, 'members')}>{t('web.projects.tabMembers')}</Link> },
    { key: 'settings', label: <Link to={projectViewPath(projectId, 'settings')}>{t('web.projects.tabSettings')}</Link> },
  ];

  return (
    <div className="lizant-project">
      <Card
        className="lizant-card"
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
          <div className="lizant-project-dates">
            <Typography.Text type="secondary">
              {formatDay(project?.['dateStart'])} → {formatDay(project?.['dateEnd'])}
            </Typography.Text>
          </div>
        }
      >
        <Tabs activeKey={active} items={items} onChange={(key) => { if (key !== active) navigate(`/Project/${encodeURIComponent(projectId)}/${key}`); }} />
      </Card>

      {error !== undefined && error !== null ? (
        <Alert type="error" showIcon style={{ marginBlock: 12 }} message={t('web.projects.loadFailed')} description={String(error)} />
      ) : null}

      <Spin spinning={loading}>{children}</Spin>
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

/** Rows directly inside a group; subtasks hang below their parent instead. */
export function topLevelTasks(tasks: ProjectTaskRow[]): ProjectTaskRow[] {
  return tasks.filter((task) => task.parentTaskId === null || task.parentTaskId === '');
}

export function childrenOf(tasks: ProjectTaskRow[], parentId: string): ProjectTaskRow[] {
  return tasks.filter((task) => task.parentTaskId === parentId);
}
