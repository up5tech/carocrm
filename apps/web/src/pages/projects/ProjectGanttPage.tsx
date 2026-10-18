import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Modal, Radio, Segmented, Space, Tag, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectMemberRow, ProjectStageRow, ProjectTaskRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { projectQueryKey, ProjectShell,useErrorReporter, useProjectCapabilities, useProjectPlan, useProjectRefresh  } from './projectShared.js';
import { ProjectTaskModal } from './ProjectTaskModal.js';

/**
 * Gantt view (PLAN_Phase_19_Projects.md §4.12): a hand-drawn SVG timeline — bars for dated tasks, a
 * marker for each milestone, a path for each dependency.
 *
 * Nothing here is an offline model of the project: a drag or a resize is converted into the same day
 * range and sent to the task update command, which re-checks the dates, the role, the project
 * settings and the dependency rules. When the server refuses, the bar is refetched back into place.
 *
 * Dates are calendar days, so the layout is day-granular; the working-time shading the reference
 * describes is deferred with the working-time calendar (see docs/modules/projects/compatibility.md).
 */

const DAY_MS = 86_400_000;
const ROW_HEIGHT = 34;
const LABEL_WIDTH = 220;
const HEAD_HEIGHT = 28;

interface DragState {
  taskId: string;
  edge: 'start' | 'end' | 'move';
  originX: number;
  dateStart: string;
  dateEnd: string;
}

export function ProjectGanttPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(id);
  const plan = useProjectPlan(id);
  const capabilities = useProjectCapabilities(id);
  const [allGroupTypes, setAllGroupTypes] = useState(false);
  const [dayWidth, setDayWidth] = useState(26);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selected, setSelected] = useState<ProjectTaskRow | null>(null);
  const [creating, setCreating] = useState<{ groupId: string | null; predecessorTaskId: string } | null>(null);
  const [dependency, setDependency] = useState<{ id: string; dependencyType: string | null; label: string } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);

  const stages = useQuery({
    queryKey: [...projectQueryKey(id), 'stages'],
    queryFn: async () => (await api.projectStages(id)).list as unknown as ProjectStageRow[],
  });
  const members = useQuery({
    queryKey: [...projectQueryKey(id), 'members'],
    queryFn: async () => {
      const rows = (await api.projectMembers(id)).list as ProjectMemberRow[];
      return rows.map((row) => ({ value: row.userId, label: row.userName ?? row.userId }));
    },
  });

  const gantt = useQuery({
    queryKey: [...projectQueryKey(id), 'gantt', allGroupTypes],
    queryFn: () => api.projectGantt(id, allGroupTypes),
    enabled: capabilities.data?.features['ganttEnabled'] !== false,
  });

  const tasks = gantt.data?.tasks ?? [];
  const edges = gantt.data?.dependencies ?? [];
  const groups = gantt.data?.groups ?? [];

  const { start, days } = useMemo(() => {
    const values: string[] = [];
    for (const task of tasks) {
      if (task.dateStart !== null) values.push(task.dateStart);
      if (task.dateEnd !== null) values.push(task.dateEnd);
    }
    if (values.length === 0) return { start: new Date().toISOString().slice(0, 10), days: 30 };
    values.sort();
    const first = Date.parse(`${values[0]}T00:00:00.000Z`) - 2 * DAY_MS;
    const last = Date.parse(`${values[values.length - 1]}T00:00:00.000Z`) + 2 * DAY_MS;
    return { start: new Date(first).toISOString().slice(0, 10), days: Math.max(14, Math.round((last - first) / DAY_MS)) };
  }, [tasks]);

  const index = (day: string | null): number => {
    if (day === null) return 0;
    return Math.round((Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS);
  };
  const dayAt = (offsetDays: number): string => new Date(Date.parse(`${start}T00:00:00.000Z`) + offsetDays * DAY_MS).toISOString().slice(0, 10);

  const rowOf = new Map(tasks.map((task, position) => [task.id, position]));

  const commit = async (taskId: string, input: Record<string, unknown>): Promise<void> => {
    const task = tasks.find((entry) => entry.id === taskId);
    if (task === undefined) return;
    try {
      await api.updateProjectTask(taskId, { ...input, version: task.version });
      void message.success(t('web.projects.datesUpdated'));
    } catch (error) {
      // A dependency or a role can refuse the new dates; the server's reason is the message.
      report(error);
    }
    refresh();
    void gantt.refetch();
  };

  const shift = (value: string, deltaDays: number): string => dayAt(index(value) + deltaDays);

  const onPointerMove = (event: React.PointerEvent) => {
    if (drag === null) return;
    const delta = Math.round((event.clientX - drag.originX) / dayWidth);
    if (delta === 0) return;
    const apply = document.getElementById(`gantt-bar-${drag.taskId}`);
    if (apply === null) return;
    const baseLeft = index(drag.dateStart) * dayWidth;
    const baseWidth = Math.max(dayWidth, (index(drag.dateEnd) - index(drag.dateStart) + 1) * dayWidth);
    if (drag.edge === 'move') apply.setAttribute('transform', `translate(${String(baseLeft + delta * dayWidth)},0)`);
    if (drag.edge === 'end') apply.setAttribute('width', String(Math.max(dayWidth, baseWidth + delta * dayWidth)));
    if (drag.edge === 'start') {
      apply.setAttribute('x', String(baseLeft + delta * dayWidth));
      apply.setAttribute('width', String(Math.max(dayWidth, baseWidth - delta * dayWidth)));
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (drag === null) return;
    const delta = Math.round((event.clientX - drag.originX) / dayWidth);
    const current = drag;
    setDrag(null);
    if (delta === 0) return;
    if (current.edge === 'move') void commit(current.taskId, { dateStart: shift(current.dateStart, delta), dateEnd: current.dateEnd === '' ? undefined : shift(current.dateEnd, delta) });
    if (current.edge === 'start') void commit(current.taskId, { dateStart: shift(current.dateStart, delta) });
    if (current.edge === 'end') void commit(current.taskId, { dateEnd: shift(current.dateEnd, delta) });
  };

  const width = days * dayWidth;
  const height = Math.max(1, tasks.length) * ROW_HEIGHT + HEAD_HEIGHT;

  return (
    <ProjectShell project={plan.data?.project} capabilities={capabilities.data} active="gantt" loading={gantt.isLoading} error={gantt.error}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Segmented
          value={allGroupTypes ? 'all' : 'work'}
          onChange={(value) => setAllGroupTypes(value === 'all')}
          options={[
            { value: 'work', label: t('web.projects.ganttWorkTypes') },
            { value: 'all', label: t('web.projects.ganttAllGroups') },
          ]}
        />
        <Button size="small" onClick={() => setDayWidth((value) => Math.max(10, value - 6))}>
          −
        </Button>
        <Button size="small" onClick={() => setDayWidth((value) => Math.min(60, value + 6))}>
          +
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.projects.ganttHint')}
        </Typography.Text>
      </Space>

      <div className="carocrm-project-gantt" ref={surface} onPointerMove={onPointerMove} onPointerUp={onPointerUp} style={{ overflowX: 'auto' }}>
        <div style={{ width: LABEL_WIDTH + width }}>
          <svg width={LABEL_WIDTH + width} height={height} role="img" aria-label={t('web.projects.ganttAria')}>
            <g>
              {Array.from({ length: days + 1 }).map((_unused, day) =>
                day % 7 === 0 ? (
                  <g key={`tick-${String(day)}`}>
                    <line x1={LABEL_WIDTH + day * dayWidth} y1={HEAD_HEIGHT - 6} x2={LABEL_WIDTH + day * dayWidth} y2={height} stroke="#eceff3" />
                    <text x={LABEL_WIDTH + day * dayWidth + 3} y={14} fontSize="10" fill="#8c94a0">
                      {dayAt(day).slice(5)}
                    </text>
                  </g>
                ) : null,
              )}
            </g>

            {tasks.map((task, position) => {
              const y = HEAD_HEIGHT + position * ROW_HEIGHT;
              const group = groups.find((entry) => String(entry['id']) === (task.groupId ?? ''));
              const isMilestone = task.taskType === 'Milestone';
              const left = index(task.dateStart) * dayWidth;
              const right = index(task.dateEnd ?? task.dateStart) * dayWidth;
              const barWidth = Math.max(dayWidth, right - left + dayWidth);
              return (
                <g key={task.id}>
                  <text x={6} y={y + 20} fontSize="12" fill="#4a4f57">
                    {`${String(group?.['name'] ?? '—').slice(0, 14)} · ${(task.name ?? '').slice(0, 24)}`}
                  </text>
                  {isMilestone ? (
                    <polygon
                      id={`gantt-bar-${task.id}`}
                      points={`${LABEL_WIDTH + left},${y + 8} ${LABEL_WIDTH + left + 8},${y + 17} ${LABEL_WIDTH + left},${y + 26} ${LABEL_WIDTH + left - 8},${y + 17}`}
                      fill="#722ed1"
                      onClick={() => setSelected(task)}
                    />
                  ) : (
                    <g id={`gantt-bar-${task.id}`} transform={`translate(${String(LABEL_WIDTH + left)},0)`}>
                      <rect
                        width={barWidth}
                        y={y + 8}
                        height={16}
                        rx={4}
                        fill={barColor(task.status)}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          setDrag({ taskId: task.id, edge: 'move', originX: event.clientX, dateStart: task.dateStart ?? dayAt(index(task.dateStart)), dateEnd: task.dateEnd ?? '' });
                        }}
                        onClick={() => setSelected(task)}
                      />
                      <rect
                        x={-3}
                        width={6}
                        y={y + 8}
                        height={16}
                        fill="#c9ced6"
                        onPointerDown={(event) => {
                          setDrag({ taskId: task.id, edge: 'start', originX: event.clientX, dateStart: task.dateStart ?? '', dateEnd: task.dateEnd ?? '' });
                        }}
                      />
                      <rect
                        x={barWidth - 3}
                        width={6}
                        y={y + 8}
                        height={16}
                        fill="#c9ced6"
                        onPointerDown={(event) => {
                          setDrag({ taskId: task.id, edge: 'end', originX: event.clientX, dateStart: task.dateStart ?? '', dateEnd: task.dateEnd ?? task.dateStart ?? '' });
                        }}
                      />
                    </g>
                  )}
                </g>
              );
            })}

            {edges.map((edge) => {
              const from = tasks.find((task) => task.id === edge.predecessorTaskId);
              const to = tasks.find((task) => task.id === edge.taskId);
              if (from === undefined || to === undefined) return null;
              const fromRow = rowOf.get(from.id) ?? 0;
              const toRow = rowOf.get(to.id) ?? 0;
              const x1 = LABEL_WIDTH + (index(from.dateEnd ?? from.dateStart) + 1) * dayWidth;
              const y1 = HEAD_HEIGHT + fromRow * ROW_HEIGHT + 16;
              const x2 = LABEL_WIDTH + index(to.dateStart) * dayWidth;
              const y2 = HEAD_HEIGHT + toRow * ROW_HEIGHT + 16;
              const mid = Math.max(x1, x2) + 6;
              return (
                <polyline
                  key={edge.id}
                  points={`${String(x1)},${String(y1)} ${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2)},${String(y2)}`}
                  fill="none"
                  stroke={edge.dependencyType === null ? '#c9ced6' : '#438eff'}
                  strokeWidth={1.5}
                  strokeDasharray={edge.dependencyType === null ? '4 3' : undefined}
                  onClick={() =>
                    setDependency({
                      id: edge.id,
                      dependencyType: edge.dependencyType,
                      label: `${from.name ?? ''} → ${to.name ?? ''}`,
                    })
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <title>{edge.dependencyType ?? t('web.projects.dependencyInformative')}</title>
                </polyline>
              );
            })}
          </svg>
        </div>
      </div>

      {gantt.data?.truncated === true ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.projects.truncated')}
        </Typography.Text>
      ) : null}

      <DependencyModal dependency={dependency} projectId={id} onClose={() => setDependency(null)} onChanged={() => { setDependency(null); refresh(); }} />

      {selected !== null ? (
        <Modal
          open
          onCancel={() => setSelected(null)}
          title={selected.name}
          footer={[
            // §4.12: with one task selected, offer "create dependent item after selected item". The
            // new task becomes the successor, so the dependency only exists if the project allows it.
            ...(capabilities.data?.features['dependenciesEnabled'] === true && capabilities.data?.capabilities['createTask'] === true
              ? [
                  <Button
                    key="dependent"
                    onClick={() => {
                      const predecessor = selected;
                      setSelected(null);
                      setCreating({ groupId: predecessor.groupId, predecessorTaskId: predecessor.id });
                    }}
                  >
                    {t('web.projects.createDependentItem')}
                  </Button>,
                ]
              : []),
            <Button key="close" onClick={() => setSelected(null)}>
              {t('web.projects.close')}
            </Button>,
          ]}
        >
          <Space direction="vertical">
            <Typography.Text>
              {t('web.projects.fieldStart')}: {selected.dateStart ?? '—'} · {t('web.projects.fieldEnd')}: {selected.dateEnd ?? '—'}
            </Typography.Text>
            <Tag>{selected.status}</Tag>
          </Space>
        </Modal>
      ) : null}

      <ProjectTaskModal
        projectId={id}
        plan={plan.data}
        stages={stages.data ?? []}
        capabilities={capabilities.data}
        task={null}
        defaultGroupId={creating?.groupId ?? undefined}
        predecessorTaskId={creating?.predecessorTaskId}
        open={creating !== null}
        onClose={() => setCreating(null)}
        users={members.data ?? []}
      />
    </ProjectShell>
  );
}

function barColor(status: string | null): string {
  if (status === 'Completed') return '#55c27f';
  if (status === 'Canceled') return '#b6bcc4';
  if (status === 'Started') return '#438eff';
  return '#9aa4b0';
}

function DependencyModal({ dependency, projectId, onClose, onChanged }: { dependency: { id: string; dependencyType: string | null; label: string } | null; projectId: string; onClose: () => void; onChanged: () => void }) {
  const report = useErrorReporter();
  const { message } = AntApp.useApp();
  const [type, setType] = useState<string>(dependency?.dependencyType ?? '');

  const save = async (value: string | null): Promise<void> => {
    if (dependency === null) return;
    // The edge belongs to its successor task, which is what the command route is addressed to.
    const successor = (await api.projectGantt(projectId, true)).dependencies.find((edge) => edge.id === dependency.id)?.taskId;
    if (successor === undefined) return;
    try {
      if (value === null) await api.removeProjectTaskDependency(successor, dependency.id);
      else await api.updateProjectTaskDependency(successor, { dependencyId: dependency.id, dependencyType: value });
      void message.success(t('web.projects.dependencySaved'));
      onChanged();
    } catch (error) {
      report(error);
    }
  };

  return (
    <Modal
      open={dependency !== null}
      onCancel={onClose}
      footer={[
        <Button key="remove" danger onClick={() => void save(null)}>
          {t('web.projects.dependencyRemove')}
        </Button>,
        <Button key="ok" type="primary" onClick={() => void save(type === '' ? null : type)}>
          {t('web.projects.save')}
        </Button>,
      ]}
      title={`${t('web.projects.dependency')}: ${dependency?.label ?? ''}`}
    >
      <Radio.Group
        value={type}
        onChange={(event) => {
          setType(String(event.target.value));
          void save(String(event.target.value) === '' ? null : String(event.target.value));
        }}
      >
        <Space direction="vertical">
          <Radio value="">{t('web.projects.dependencyInformative')}</Radio>
          {['FinishToStart', 'FinishToFinish', 'StartToStart', 'StartToFinish'].map((value) => (
            <Radio key={value} value={value}>
              {value}
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Modal>
  );
}
