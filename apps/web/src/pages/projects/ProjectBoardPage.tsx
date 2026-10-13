import { closestCorners, DndContext, type DragEndEvent,KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectMemberRow, ProjectStageRow, ProjectTaskRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import {
  formatDay,
  projectQueryKey,
 ProjectShell,  useErrorReporter,
  useProjectCapabilities,
  useProjectPlan,
  useProjectRefresh } from './projectShared.js';
import { ProjectTaskModal, statusTag } from './ProjectTaskModal.js';

/**
 * Kanban board (PLAN_Phase_19_Projects.md §4.12): one column per stage of the project's board, one
 * group at a time.
 *
 * A column drop is a stage change, which the server turns into the mapped status and guards with the
 * dependency, subtask and role rules. Dropping is therefore never the authority to move — the column
 * simply shows where the server agreed to put the card.
 */

export function ProjectBoardPage() {
  const { id = '' } = useParams<{ id: string }>();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(id);
  const plan = useProjectPlan(id);
  const capabilities = useProjectCapabilities(id);
  const groups = plan.data?.groups ?? [];
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<ProjectTaskRow | null>(null);

  const activeGroup = groupId ?? String(plan.data?.project['activeGroupId'] ?? groups[0]?.group['id'] ?? '');
  const canCreate = capabilities.data?.capabilities['createTask'] === true;

  const board = useQuery({
    queryKey: [...projectQueryKey(id), 'board', activeGroup],
    queryFn: () => api.projectBoard(id, activeGroup),
    enabled: activeGroup !== '',
  });
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

  const columns = board.data?.columns ?? [];

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    const activeId = String(event.active.id);
    const overId = event.over === undefined || event.over === null ? '' : String(event.over.id);
    if (overId === '') return;
    const targetStageId = event.over?.data.current?.['stageId'];
    const target = columns.find((column) => String(column.stage['id']) === String(targetStageId ?? ''));
    if (target === undefined) return;

    const siblings = target.tasks.filter((task) => task.id !== activeId);
    const overIndex = siblings.findIndex((task) => task.id === overId);
    const insertAt = overIndex >= 0 ? overIndex : siblings.length;
    const desired = [...siblings.slice(0, insertAt).map((task) => task.id), activeId, ...siblings.slice(insertAt).map((task) => task.id)];
    const position = desired.indexOf(activeId);
    const after = position > 0 ? String(desired[position - 1]) : undefined;
    const before = position < desired.length - 1 ? String(desired[position + 1]) : undefined;

    try {
      await api.moveProjectTask(activeId, {
        stageId: String(target.stage['id']),
        ...(after !== undefined ? { afterTaskId: after } : {}),
        ...(before !== undefined ? { beforeTaskId: before } : {}),
      });
    } catch (error) {
      report(error);
    }
    refresh();
    void board.refetch();
  };

  return (
    <ProjectShell project={plan.data?.project} capabilities={capabilities.data} active="board" loading={plan.isLoading || board.isLoading} error={board.error ?? plan.error}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          value={activeGroup === '' ? null : activeGroup}
          onChange={setGroupId}
          style={{ width: 220 }}
          placeholder={t('web.projects.chooseGroup')}
          options={groups.map((entry) => ({ value: String(entry.group['id']), label: String(entry.group['name'] ?? '') }))}
        />
        {canCreate && activeGroup !== '' ? (
          <Button type="primary" onClick={() => setEditing(null)}>
            + {t('web.projects.newTask')}
          </Button>
        ) : null}
      </Space>

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={(event) => void onDragEnd(event)}>
        <div className="lizant-project-board">
          {columns.map((column) => (
            <StageColumn
              key={String(column.stage['id'])}
              stage={column.stage}
              tasks={column.tasks}
              canEdit={capabilities.data?.capabilities['moveTask'] === true}
              onEdit={setEditing}
            />
          ))}
        </div>
      </DndContext>

      <ProjectTaskModal
        projectId={id}
        plan={plan.data}
        stages={stages.data ?? []}
        capabilities={capabilities.data}
        task={editing}
        defaultGroupId={activeGroup}
        open={editing !== null}
        onClose={() => setEditing(null)}
        users={members.data ?? []}
      />
    </ProjectShell>
  );
}

interface ColumnProps {
  stage: Record<string, unknown>;
  tasks: ProjectTaskRow[];
  canEdit: boolean;
  onEdit: (task: ProjectTaskRow) => void;
}

function StageColumn({ stage, tasks, canEdit, onEdit }: ColumnProps) {
  const stageId = String(stage['id']);
  const drop = useDroppable({ id: `column:${stageId}`, data: { stageId } });

  return (
    <div className={`lizant-project-column${drop.isOver ? ' is-over' : ''}`} ref={drop.setNodeRef}>
      <div className="lizant-project-column-head">
        <Typography.Text strong>{String(stage['name'] ?? '')}</Typography.Text>
        <Tag>{String(stage['statusValue'] ?? '')}</Tag>
        <Typography.Text type="secondary">{String(tasks.length)}</Typography.Text>
      </div>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <BoardCard key={task.id} task={task} disabled={!canEdit} onEdit={onEdit} />
        ))}
      </SortableContext>
    </div>
  );
}

function BoardCard({ task, disabled, onEdit }: { task: ProjectTaskRow; disabled: boolean; onEdit: (task: ProjectTaskRow) => void }) {
  const sortable = useSortable({ id: task.id, data: { stageId: task.stageId }, disabled });
  return (
    <Card
      className={`lizant-project-card${sortable.isDragging ? ' is-dragging' : ''}`}
      size="small"
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      onClick={() => onEdit(task)}
    >
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Typography.Text strong ellipsis>
          {task.name}
        </Typography.Text>
        <Space size={4} wrap>
          {statusTag(task.status)}
          {task.priority !== null ? <Tag>{task.priority}</Tag> : null}
          {task.taskType === 'Milestone' ? <Tag color="purple">{t('web.projects.milestone')}</Tag> : null}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDay(task.dateStart)}
          {task.dateEnd !== null ? ` → ${formatDay(task.dateEnd)}` : ''}
        </Typography.Text>
      </Space>
    </Card>
  );
}
