import { ClockCircleOutlined, FieldTimeOutlined, TrophyOutlined } from '@ant-design/icons';
import { closestCorners, DndContext, type DragEndEvent,DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Select, Space } from 'antd';
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
import { ProjectTaskModal } from './ProjectTaskModal.js';

/**
 * Kanban board (PLAN_Phase_19_Projects.md §4.12): one column per stage of the project's board, one
 * group at a time.
 *
 * A column drop is a stage change, which the server turns into the mapped status and guards with the
 * dependency, subtask and role rules. Dropping is therefore never the authority to move — the column
 * simply shows where the server agreed to put the card.
 *
 * The card being dragged is rendered through `DragOverlay`, not inside its own column. Without the
 * overlay the card stays a child of its source column, so the following columns — each with an
 * opaque `#f7f9fb` background — paint over it the moment it crosses their edge, and the card looks
 * like it vanished until the drop puts it in the target column.
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
  /** The card currently under the pointer, so the overlay can draw it above every column. */
  const [activeTask, setActiveTask] = useState<ProjectTaskRow | null>(null);

  const activeGroup = groupId ?? String(plan.data?.project['activeGroupId'] ?? groups[0]?.group['id'] ?? '');
  const canCreate = capabilities.data?.capabilities['createTask'] === true;
  // `moveTask` is the project-wide flag (global `all`/`yes`, or a role whose `stageMoveScope` is
  // `all`). A plain member holds a task-scoped scope (`assigned`), which the project-level flag
  // cannot express — so membership also enables the handle, exactly as the Plan view does. The drop
  // stays a request: the server refuses a card the role does not cover and the board refetches.
  const canMove = capabilities.data?.capabilities['moveTask'] === true || capabilities.data?.isMember === true;

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
  /** The board card shows the assignee's initials, so the id has to resolve to a name here. */
  const memberNames = new Map<string, string>(
    (members.data ?? []).map((member): [string, string] => [member.value, member.label]),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = board.data?.columns ?? [];

  const taskById = (taskId: string): ProjectTaskRow | undefined =>
    columns.flatMap((column) => column.tasks).find((task) => task.id === taskId);

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
        <div className="carocrm-project-board">
          {columns.map((column) => (
            <StageColumn
              key={String(column.stage['id'])}
              stage={column.stage}
              tasks={column.tasks}
              canEdit={canMove}
              memberNames={memberNames}
              onEdit={setEditing}
            />
          ))}
        </div>

        {/*
          A portal at the document root, so the card stays visible over every column instead of being
          painted under the next column's opaque background. `dropAnimation={null}` because the board
          refetches from the server on drop — the card must not fly anywhere on its own.
        */}
        <DragOverlay dropAnimation={null}>
          {activeTask === null ? null : (
            <div className="carocrm-project-card carocrm-project-card-overlay">
              <BoardCardContent
                task={activeTask}
                assigneeName={activeTask.assigneeUserId === null ? undefined : memberNames.get(activeTask.assigneeUserId)}
              />
            </div>
          )}
        </DragOverlay>
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
  memberNames: Map<string, string>;
  onEdit: (task: ProjectTaskRow) => void;
}

function StageColumn({ stage, tasks, canEdit, memberNames, onEdit }: ColumnProps) {
  const stageId = String(stage['id']);
  const drop = useDroppable({ id: `column:${stageId}`, data: { stageId } });
  const statusValue = String(stage['statusValue'] ?? '');

  return (
    <div className={`carocrm-project-column${drop.isOver ? ' is-over' : ''}`} ref={drop.setNodeRef}>
      <div className="carocrm-project-column-head">
        <span className="carocrm-project-column-title">{String(stage['name'] ?? '')}</span>
        <span className={`carocrm-project-pill ${PILL_TONE[statusValue] ?? 'is-gray'}`}>{statusValue}</span>
        <span className="carocrm-project-column-count">{String(tasks.length)}</span>
      </div>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <BoardCard
            key={task.id}
            task={task}
            disabled={!canEdit}
            assigneeName={task.assigneeUserId === null ? undefined : memberNames.get(task.assigneeUserId)}
            onEdit={onEdit}
          />
        ))}
      </SortableContext>
    </div>
  );
}

/**
 * Soft pill tones, keyed by the value the API returns. The Carocrm board colours its card tags with a
 * pale tint plus a saturated label rather than a bordered tag, so status and priority share one
 * palette and the tone is the only difference between them.
 */
const PILL_TONE: Readonly<Record<string, string>> = {
  'Not Started': 'is-gray',
  Started: 'is-blue',
  Completed: 'is-green',
  Canceled: 'is-gray',
  Deferred: 'is-amber',
  Low: 'is-gray',
  Normal: 'is-blue',
  High: 'is-amber',
  Urgent: 'is-red',
};

/** `Ada Lovelace` → `AL`; the board has no avatar image, so the initials stand in for it. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== '');
  const first = parts[0];
  if (first === undefined) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return `${first.slice(0, 1)}${last === undefined ? '' : last.slice(0, 1)}`.toUpperCase();
}

/**
 * The card body, shared by the sortable card and its drag overlay so both look identical. The shape
 * follows the Carocrm board card: a bold title with a `⋯` affordance, a row of soft pills with the
 * assignee pushed to the right, then a divider and an icon meta footer.
 *
 * The reference card also carries a description and a progress bar; a `ProjectTask` row has neither,
 * so the footer shows the fields the record actually has (dates, points, estimate) instead of
 * inventing a completion percentage.
 */
function BoardCardContent({
  task,
  dragHandle,
  assigneeName,
  onOpen,
}: {
  task: ProjectTaskRow;
  dragHandle?: React.ReactNode;
  assigneeName?: string | null | undefined;
  onOpen?: (() => void) | undefined;
}) {
  return (
    <>
      <div className="carocrm-project-card-head">
        {dragHandle ?? null}
        <span className="carocrm-project-card-title">{task.name}</span>
        {onOpen === undefined ? (
          <span className="carocrm-project-card-menu" aria-hidden="true">
            ⋯
          </span>
        ) : (
          <button
            type="button"
            className="carocrm-project-card-menu"
            aria-label={t('web.projects.editTask')}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            ⋯
          </button>
        )}
      </div>

      <div className="carocrm-project-card-tags">
        {task.status === null ? null : (
          <span className={`carocrm-project-pill ${PILL_TONE[task.status] ?? 'is-gray'}`}>{task.status}</span>
        )}
        {task.priority === null ? null : (
          <span className={`carocrm-project-pill ${PILL_TONE[task.priority] ?? 'is-gray'}`}>{task.priority}</span>
        )}
        {task.taskType === 'Milestone' ? <span className="carocrm-project-pill is-purple">{t('web.projects.milestone')}</span> : null}
        {assigneeName === null || assigneeName === undefined || assigneeName === '' ? null : (
          // The tint is inline: antd injects its Avatar styles after carocrm.css, so a class of equal
          // specificity would lose the background/colour.
          <Avatar size={24} className="carocrm-project-card-avatar" style={{ background: '#e8f1ff', color: '#2f7ff0', fontSize: 11, fontWeight: 600 }} alt={assigneeName}>
            {initials(assigneeName)}
          </Avatar>
        )}
      </div>

      <div className="carocrm-project-card-footer">
        <span className="carocrm-project-card-meta">
          <ClockCircleOutlined />
          {formatDay(task.dateStart)}
          {task.dateEnd === null ? '' : ` → ${formatDay(task.dateEnd)}`}
        </span>
        {task.points === null ? null : (
          <span className="carocrm-project-card-meta">
            <TrophyOutlined />
            {String(task.points)}
          </span>
        )}
        {task.estimateHours === null ? null : (
          <span className="carocrm-project-card-meta">
            <FieldTimeOutlined />
            {`${String(task.estimateHours)}h`}
          </span>
        )}
      </div>
    </>
  );
}

function BoardCard({
  task,
  disabled,
  assigneeName,
  onEdit,
}: {
  task: ProjectTaskRow;
  disabled: boolean;
  assigneeName?: string | undefined;
  onEdit: (task: ProjectTaskRow) => void;
}) {
  const sortable = useSortable({ id: task.id, data: { stageId: task.stageId }, disabled });
  return (
    <div
      className={`carocrm-project-card${sortable.isDragging ? ' is-dragging' : ''}`}
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      onClick={() => onEdit(task)}
    >
      <BoardCardContent
        task={task}
        assigneeName={assigneeName}
        onOpen={() => onEdit(task)}
        dragHandle={
          /*
            dnd-kit starts a drag only from the element that carries `listeners` — `attributes` alone
            is ARIA only. The handle is that element, so a click on the card still opens the task and
            never turns into an accidental move. `stopPropagation` keeps the handle out of that click.
          */
          <button
            type="button"
            className="carocrm-project-drag-handle"
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...(sortable.listeners ?? {})}
            aria-label={t('web.projects.dragTask')}
            disabled={disabled}
            onClick={(event) => event.stopPropagation()}
          >
            ⠿
          </button>
        }
      />
    </div>
  );
}
