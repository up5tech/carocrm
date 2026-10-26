import { closestCorners, DndContext, type DragEndEvent,DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Dropdown, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectMemberRow, ProjectStageRow, ProjectTaskRow } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { t } from '../../state/i18n.js';
import {
  childrenOf,
  formatDay,
  PROJECT_GROUP_TYPES,
  projectQueryKey,
 ProjectShell,  topLevelTasks,
  useErrorReporter,
  useProjectCapabilities,
  useProjectPlan,
  useProjectRefresh } from './projectShared.js';
import { ProjectTaskModal, statusTag } from './ProjectTaskModal.js';

/**
 * Plan view (PLAN_Phase_19_Projects.md §4.12): ordered groups of ordered tasks, dragged to move.
 *
 * A drop is a request, not an edit. The card is placed optimistically and the screen is refetched
 * from the server either way, so a refused move (another project's group, a blocked dependency, a
 * role that does not allow it) snaps back instead of leaving the screen disagreeing with the
 * database. Group order has button equivalents because a drag that needs a mouse is not accessible
 * (§8.3).
 */

export function ProjectPlanPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(id);
  const plan = useProjectPlan(id);
  const capabilities = useProjectCapabilities(id);
  const [editing, setEditing] = useState<ProjectTaskRow | null>(null);
  const [creating, setCreating] = useState<{ groupId: string; milestone: boolean } | null>(null);
  const [renaming, setRenaming] = useState<Record<string, unknown> | null>(null);
  /** The row currently under the pointer, so the overlay can draw it above every group card. */
  const [activeTask, setActiveTask] = useState<ProjectTaskRow | null>(null);

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const groups = plan.data?.groups ?? [];
  const canManageGroups = capabilities.data?.capabilities['manageGroups'] === true;
  const canCreate = capabilities.data?.capabilities['createTask'] === true;

  const taskById = (taskId: string): ProjectTaskRow | undefined =>
    groups.flatMap((entry) => entry.tasks).find((task) => task.id === taskId);

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    const activeId = String(event.active.id);
    const overId = event.over === undefined || event.over === null ? '' : String(event.over.id);
    if (overId === '') return;

    const source = groups.find((entry) => entry.tasks.some((task) => task.id === activeId));
    // Dropping on a group body moves into that group; dropping on a card also names its group.
    const dropGroupId = event.over?.data.current?.['groupId'] ?? event.over?.data.current?.['dropGroupId'];
    const target =
      groups.find((entry) => String(entry.group['id']) === String(dropGroupId ?? '')) ??
      groups.find((entry) => entry.tasks.some((task) => task.id === overId));
    if (source === undefined || target === undefined) return;

    const siblings = topLevelTasks(target.tasks).filter((task) => task.id !== activeId);
    const overIndex = siblings.findIndex((task) => task.id === overId);
    const insertAt = overIndex >= 0 ? overIndex : siblings.length;
    const desired = [...siblings.slice(0, insertAt), activeId, ...siblings.slice(insertAt)];
    const position = desired.indexOf(activeId);
    const after = position > 0 ? String(desired[position - 1]) : undefined;
    const before = position < desired.length - 1 ? String(desired[position + 1]) : undefined;

    try {
      await api.moveProjectTask(activeId, {
        groupId: String(target.group['id']),
        ...(after !== undefined ? { afterTaskId: after } : {}),
        ...(before !== undefined ? { beforeTaskId: before } : {}),
      });
    } catch (error) {
      report(error);
    }
    refresh();
  };

  const moveGroup = async (groupId: string, direction: -1 | 1): Promise<void> => {
    const ordered = groups.map((entry) => String(entry.group['id']));
    const index = ordered.indexOf(groupId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    try {
      await api.reorderProjectGroups(id, arrayMove(ordered, index, target));
      refresh();
    } catch (error) {
      report(error);
    }
  };

  return (
    <ProjectShell project={plan.data?.project} capabilities={capabilities.data} active="plan" loading={plan.isLoading} error={plan.error}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event) => setActiveTask(taskById(String(event.active.id)) ?? null)}
        onDragCancel={() => setActiveTask(null)}
        onDragEnd={(event) => {
          setActiveTask(null);
          void onDragEnd(event);
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {groups.length === 0 ? (
            <Card className="carocrm-card">
              <EmptyState description={t('web.projects.noGroups')}>
                {canManageGroups ? (
                  <CreateGroupButton projectId={id} onChanged={() => { refresh(); void message.success(t('web.projects.groupSaved')); }} />
                ) : null}
              </EmptyState>
            </Card>
          ) : null}

          {groups.map((entry, index) => (
            <GroupSection
              key={String(entry.group['id'])}
              projectId={id}
              group={entry.group}
              tasks={entry.tasks}
              position={index}
              total={groups.length}
              canManageGroups={canManageGroups}
              canCreate={canCreate}
              onRename={() => setRenaming(entry.group)}
              onNewTask={(milestone) => setCreating({ groupId: String(entry.group['id']), milestone })}
              onEdit={setEditing}
              onMove={(groupId, direction) => void moveGroup(groupId, direction)}
              onChanged={refresh}
            />
          ))}
        </Space>

        {/*
          The row is dragged through a portal: inside the list it would be painted under the next
          group's opaque card the moment it crossed that card's edge, so it would look as if the row
          had vanished until the drop. `dropAnimation={null}` because the screen is refetched from the
          server on drop.
        */}
        <DragOverlay dropAnimation={null}>
          {activeTask === null ? null : <TaskRowOverlay task={activeTask} />}
        </DragOverlay>
      </DndContext>

      <ProjectTaskModal
        projectId={id}
        plan={plan.data}
        stages={stages.data ?? []}
        capabilities={capabilities.data}
        task={editing}
        defaultGroupId={creating?.groupId}
        milestone={creating?.milestone ?? false}
        open={editing !== null || creating !== null}
        onClose={() => {
          setEditing(null);
          setCreating(null);
        }}
        users={members.data ?? []}
      />

      <RenameGroupModal
        group={renaming}
        projectId={id}
        onClose={() => setRenaming(null)}
        onSaved={() => {
          setRenaming(null);
          refresh();
          void message.success(t('web.projects.groupSaved'));
        }}
      />

      {plan.data?.truncated === true ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.projects.truncated')}
        </Typography.Text>
      ) : null}
    </ProjectShell>
  );
}

function CreateGroupButton({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const report = useErrorReporter();
  return (
    <Button
      type="primary"
      onClick={async () => {
        try {
          await api.createProjectGroup(projectId, { name: t('web.projects.newGroup'), groupType: 'Work' });
          onChanged();
        } catch (error) {
          report(error);
        }
      }}
    >
      {t('web.projects.newGroup')}
    </Button>
  );
}

interface GroupProps {
  projectId: string;
  group: Record<string, unknown>;
  tasks: ProjectTaskRow[];
  position: number;
  total: number;
  canManageGroups: boolean;
  canCreate: boolean;
  onRename: () => void;
  onNewTask: (milestone: boolean) => void;
  onEdit: (task: ProjectTaskRow) => void;
  onMove: (groupId: string, direction: -1 | 1) => void;
  onChanged: () => void;
}

function GroupSection({ projectId, group, tasks, position, total, canManageGroups, canCreate, onRename, onNewTask, onEdit, onMove, onChanged }: GroupProps) {
  const groupId = String(group['id']);
  const report = useErrorReporter();
  const drop = useDroppable({ id: `body:${groupId}`, data: { dropGroupId: groupId } });
  const roots = topLevelTasks(tasks);

  const removeGroup = async (): Promise<void> => {
    try {
      await api.removeProjectGroup(projectId, { groupId });
      onChanged();
    } catch (error) {
      // The server refuses while the group holds tasks and says what to do about them (§4.5).
      report(error);
    }
  };

  return (
    <Card
      className="carocrm-card carocrm-project-group"
      size="small"
      title={
        <Space>
          <Typography.Text strong>{String(group['name'] ?? '')}</Typography.Text>
          <Tag>{String(group['groupType'] ?? 'Work')}</Tag>
          <Typography.Text type="secondary">{String(tasks.length)}</Typography.Text>
        </Space>
      }
      extra={
        canManageGroups ? (
          <Space>
            <Button size="small" onClick={() => onMove(groupId, -1)} disabled={position === 0} aria-label={t('web.projects.moveGroupUp')}>
              ↑
            </Button>
            <Button size="small" onClick={() => onMove(groupId, 1)} disabled={position >= total - 1} aria-label={t('web.projects.moveGroupDown')}>
              ↓
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'rename', label: t('web.projects.renameGroup') },
                  { key: 'milestone', label: t('web.projects.newMilestone') },
                  { key: 'delete', danger: true, label: t('web.projects.deleteGroup') },
                ],
                onClick: ({ key }) => {
                  if (key === 'rename') onRename();
                  else if (key === 'milestone') onNewTask(true);
                  else if (key === 'delete') void removeGroup();
                },
              }}
            >
              <Button size="small">{t('web.projects.groupMenu')}</Button>
            </Dropdown>
          </Space>
        ) : null
      }
    >
      <SortableContext items={roots.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className={`carocrm-project-group-body${drop.isOver && drop.over === undefined ? ' is-over' : ''}`} ref={drop.setNodeRef}>
          {roots.length === 0 ? <Typography.Text type="secondary">{t('web.projects.groupEmpty')}</Typography.Text> : null}
          {roots.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              subtasks={childrenOf(tasks, task.id)}
              canCreate={canCreate}
              onEdit={onEdit}
              onChanged={onChanged}
            />
          ))}
        </div>
      </SortableContext>
      {canCreate ? (
        <Button size="small" type="text" className="carocrm-project-add-task" onClick={() => onNewTask(false)}>
          + {t('web.projects.newTask')}
        </Button>
      ) : null}
    </Card>
  );
}

interface TaskRowProps {
  task: ProjectTaskRow;
  subtasks: ProjectTaskRow[];
  canCreate: boolean;
  onEdit: (task: ProjectTaskRow) => void;
  onChanged: () => void;
}

function TaskRow({ task, subtasks, onEdit, onChanged }: TaskRowProps) {
  const sortable = useSortable({ id: task.id, data: { groupId: task.groupId } });
  const report = useErrorReporter();

  const transition = async (kind: 'start' | 'complete' | 'cancel'): Promise<void> => {
    try {
      await api.transitionProjectTask(task.id, kind);
    } catch (error) {
      report(error);
    }
    onChanged();
  };

  return (
    <div
      className={`carocrm-project-task${sortable.isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      ref={sortable.setNodeRef}
    >
      <div className="carocrm-project-task-main">
        <button type="button" className="carocrm-project-drag-handle" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} aria-label={t('web.projects.dragTask')}>
          ⠿
        </button>
        <Button type="text" size="small" className="carocrm-project-task-name" onClick={() => onEdit(task)}>
          {task.name}
        </Button>
        {statusTag(task.status)}
        {task.taskType === 'Milestone' ? <Tag color="purple">{t('web.projects.milestone')}</Tag> : null}
      </div>
      <div className="carocrm-project-task-meta">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDay(task.dateStart)}
          {task.dateEnd !== null ? ` → ${formatDay(task.dateEnd)}` : ''}
        </Typography.Text>
        <Button size="small" type="text" onClick={() => void transition('start')} disabled={task.status === 'Started'}>
          {t('web.projects.actionStart')}
        </Button>
        <Button size="small" type="text" onClick={() => void transition('complete')} disabled={task.status === 'Completed'}>
          {t('web.projects.actionComplete')}
        </Button>
        <Button size="small" type="text" onClick={() => void transition('cancel')} disabled={task.status === 'Canceled'}>
          {t('web.projects.actionCancel')}
        </Button>
      </div>
      {subtasks.length > 0 ? (
        <div className="carocrm-project-subtasks">
          {subtasks.map((child) => (
            <div key={child.id} className="carocrm-project-subtask">
              <Button type="text" size="small" onClick={() => onEdit(child)}>
                {child.name}
              </Button>
              {statusTag(child.status)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The row as the drag overlay draws it: the same shape as the row in the list, minus the transition
 * buttons — the overlay is presentational, so controls inside it would be a lie (§8.3).
 */
function TaskRowOverlay({ task }: { task: ProjectTaskRow }) {
  return (
    <div className="carocrm-project-task carocrm-project-task-overlay">
      <div className="carocrm-project-task-main">
        <span className="carocrm-project-drag-handle" aria-hidden="true">
          ⠿
        </span>
        <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
          {task.name}
        </Typography.Text>
        {statusTag(task.status)}
        {task.taskType === 'Milestone' ? <Tag color="purple">{t('web.projects.milestone')}</Tag> : null}
      </div>
      <div className="carocrm-project-task-meta">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDay(task.dateStart)}
          {task.dateEnd !== null ? ` → ${formatDay(task.dateEnd)}` : ''}
        </Typography.Text>
      </div>
    </div>
  );
}

function RenameGroupModal({ group, projectId, onClose, onSaved }: { group: Record<string, unknown> | null; projectId: string; onClose: () => void; onSaved: () => void }) {
  const report = useErrorReporter();
  const [name, setName] = useState('');
  const [type, setType] = useState('Work');

  useEffect(() => {
    if (group === null) return;
    setName(String(group['name'] ?? ''));
    setType(String(group['groupType'] ?? 'Work'));
  }, [group]);

  const save = async (): Promise<void> => {
    try {
      await api.updateProjectGroup(projectId, { groupId: String(group?.['id'] ?? ''), name, groupType: type });
      onSaved();
    } catch (error) {
      report(error);
    }
  };

  return (
    <Modal open={group !== null} onCancel={onClose} onOk={() => void save()} title={t('web.projects.renameGroup')} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={255} aria-label={t('web.projects.fieldGroupName')} />
        <Select value={type} onChange={setType} style={{ width: 160 }} options={PROJECT_GROUP_TYPES.map((value) => ({ value, label: value }))} aria-label={t('web.projects.fieldGroupType')} />
      </Space>
    </Modal>
  );
}
