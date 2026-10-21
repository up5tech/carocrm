import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
import {
  addTab,
  type EntityRelationTabs,
  moveRelation,
  orderTabs,
  OTHER_TAB_ID,
  removeTab,
  renameTab,
  tabsOf,
} from '@carocrm/metadata/relation-tabs.js';
import {
  closestCorners,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Card, Input, Modal, Popconfirm, Segmented, Select, Space, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { t } from '../state/i18n.js';

/**
 * The relation-tab editor of the entity's detail layout settings
 * (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * The arrangement is **entity metadata**: it belongs to the layout of the detail view, next to the
 * field panels, and is edited by an administrator here — not on the record page, which only renders
 * what the layout says.
 *
 * Two rules shape the editor:
 *
 * - **No relation can be lost.** A relation that is in no tab lives in the implicit *Other* pool,
 *   which is computed and never stored. Deleting a tab returns its relations there.
 * - **A relation belongs to one tab.** Moving a relation is a move, never a copy, so the same link
 *   list can never appear twice on a record page.
 *
 * Every action has a pointer-free path: a relation moves through its "Move to…" select, a tab is
 * reordered with its up/down buttons, and dnd-kit's keyboard sensor drags both.
 */

export interface RelationTabsEditorProps {
  /** The entity whose relations are arranged. */
  entity: string;
  /** The arrangement the editor shows. */
  value: EntityRelationTabs;
  /** Reports every change to the host, which owns the draft and the save. */
  onChange: (arrangement: EntityRelationTabs) => void;
  /** The display name of a relation. */
  labelOf: (relation: string) => string;
  /** The entity's own relations — the yardstick the arrangement is reconciled against. */
  relationNames: readonly string[];
}

interface TabGroup {
  /** The tab id, or `other` for the implicit pool. */
  id: string;
  label: string;
  relations: string[];
  /** The implicit pool is computed, never stored, and cannot be renamed or deleted. */
  implicit: boolean;
}

const RELATION_ID_PREFIX = 'relation:';
const TAB_ID_PREFIX = 'tab:';
const GROUP_ID_PREFIX = 'group:';

/**
 * The groups of an arrangement: the stored tabs plus the implicit *Other* pool.
 *
 * The view is reconciled against the entity's own relations: a relation the entity no longer has
 * disappears from the editor but stays in the stored metadata, because a renamed relation must not
 * start failing validation. Empty tabs are shown here — a tab may be created before it has
 * relations — and hidden in read mode, where there would be nothing to show.
 */
function groupsOf(arrangement: EntityRelationTabs, relationNames: readonly string[]): TabGroup[] {
  const assigned = new Set(arrangement.tabs.flatMap((tab) => tab.relations));
  const groups: TabGroup[] = tabsOf(arrangement).map((tab) => ({
    id: tab.id,
    label: tab.label,
    relations: [...tab.relations],
    implicit: false,
  }));
  const unassigned = relationNames.filter((relation) => !assigned.has(relation));
  groups.push({ id: OTHER_TAB_ID, label: t('web.detail.tabs.unassigned'), relations: unassigned, implicit: true });
  return groups;
}

/**
 * Pointer-first collision, narrowed to the kind of target the dragged thing may land on: a chip
 * lands in a group, a tab header lands on another tab header.
 */
const relationCollision: CollisionDetection = (args) => {
  const wanted = String(args.active.id).startsWith(RELATION_ID_PREFIX) ? GROUP_ID_PREFIX : TAB_ID_PREFIX;
  const matching = args.droppableContainers.filter((entry) => String(entry.id).startsWith(wanted));
  if (matching.length === 0) return [];
  const narrowed = { ...args, droppableContainers: matching };
  const byPointer = pointerWithin(narrowed);
  if (byPointer.length > 0) return byPointer;
  const byIntersection = rectIntersection(narrowed);
  if (byIntersection.length > 0) return byIntersection;
  return closestCorners(narrowed);
};

/** One relation in the editor: draggable, and movable through a select for the keyboard path. */
function RelationChip({
  relation,
  label,
  groupId,
  options,
  onMove,
}: {
  relation: string;
  label: string;
  groupId: string;
  options: { value: string; label: string }[];
  onMove: (relation: string, groupId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `${RELATION_ID_PREFIX}${relation}` });
  return (
    <div
      ref={setNodeRef}
      className="carocrm-relation-chip"
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
    >
      <span
        className="carocrm-board-drag-handle"
        {...attributes}
        {...listeners}
        aria-label={t('web.detail.tabs.dragRelationAria', { name: label })}
      >
        <HolderOutlined />
      </span>
      <span className="carocrm-relation-chip-name">{label}</span>
      <Select
        size="small"
        className="carocrm-relation-chip-move"
        value={groupId}
        options={options}
        aria-label={t('web.detail.tabs.moveRelationAria', { name: label })}
        onChange={(value) => onMove(relation, value)}
      />
    </div>
  );
}

/**
 * One group in the editor: a tab header that can be renamed, deleted and reordered, and the chips
 * of the relations it holds.
 */
function RelationGroup({
  group,
  labelOf,
  options,
  first,
  last,
  onRename,
  onRemove,
  onShift,
  onMoveRelation,
}: {
  group: TabGroup;
  labelOf: (relation: string) => string;
  options: { value: string; label: string }[];
  /** Whether the group is the first or the last one, so the reorder buttons can be disabled. */
  first: boolean;
  last: boolean;
  onRename: (tabId: string, label: string) => void;
  onRemove: (tabId: string) => void;
  /** Moves the group one place up or down — the keyboard path next to the drag handle. */
  onShift: (tabId: string, delta: number) => void;
  onMoveRelation: (relation: string, groupId: string) => void;
}) {
  const sortable = useSortable({ id: `${TAB_ID_PREFIX}${group.id}`, disabled: group.implicit });
  const droppable = useDroppable({ id: `${GROUP_ID_PREFIX}${group.id}` });
  return (
    <div
      ref={sortable.setNodeRef}
      className="carocrm-relation-group"
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.4 : 1,
      }}
    >
      <div className="carocrm-relation-group-head">
        {group.implicit ? null : (
          <span className="carocrm-board-drag-handle" {...sortable.attributes} {...sortable.listeners}>
            <HolderOutlined />
          </span>
        )}
        <span className="carocrm-relation-group-name">{group.label}</span>
        <span className="carocrm-relation-group-count">({group.relations.length})</span>
        <span className="carocrm-relation-group-actions">
          {group.implicit ? null : (
            <>
              {/* The keyboard equivalent of dragging a tab: the strip can be reordered without a
                  pointer at all (§5.8 — no drag-only interaction anywhere). */}
              <Button
                type="text"
                size="small"
                icon={<ArrowUpOutlined />}
                disabled={first}
                aria-label={t('web.detail.tabs.moveUpAria', { name: group.label })}
                onClick={() => onShift(group.id, -1)}
              />
              <Button
                type="text"
                size="small"
                icon={<ArrowDownOutlined />}
                disabled={last}
                aria-label={t('web.detail.tabs.moveDownAria', { name: group.label })}
                onClick={() => onShift(group.id, 1)}
              />
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={t('web.detail.tabs.renameAria', { name: group.label })}
                onClick={() => onRename(group.id, group.label)}
              />
              <Popconfirm
                title={t('web.detail.tabs.removeConfirm')}
                okText={t('web.detail.tabs.remove')}
                onConfirm={() => onRemove(group.id)}
              >
                <Button
                  danger
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  aria-label={t('web.detail.tabs.removeAria', { name: group.label })}
                />
              </Popconfirm>
            </>
          )}
        </span>
      </div>
      <div
        ref={droppable.setNodeRef}
        className="carocrm-relation-group-body"
        style={{ background: droppable.isOver ? '#f0f7ff' : undefined }}
      >
        {group.relations.length === 0 ? (
          <Typography.Text type="secondary">{t('web.detail.tabs.emptyGroup')}</Typography.Text>
        ) : (
          group.relations.map((relation) => (
            <RelationChip
              key={relation}
              relation={relation}
              label={labelOf(relation)}
              groupId={group.id}
              options={options}
              onMove={onMoveRelation}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** The editor of one entity's relation tabs. */
export function RelationTabsEditor({ entity, value, onChange, labelOf, relationNames }: RelationTabsEditorProps) {
  const [labelDialog, setLabelDialog] = useState<{ tabId: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const groups = useMemo(() => groupsOf(value, relationNames), [value, relationNames]);

  const moveOptions = useMemo(
    () => [
      ...tabsOf(value).map((tab) => ({ value: tab.id, label: tab.label })),
      { value: OTHER_TAB_ID, label: t('web.detail.tabs.unassigned') },
    ],
    [value],
  );

  const moveRelationTo = useCallback(
    (relation: string, groupId: string) => {
      onChange(moveRelation(value, relation, groupId === OTHER_TAB_ID ? null : groupId));
    },
    [onChange, value],
  );

  /** Moves a tab one place up or down — the keyboard path next to the drag handle. */
  const shiftTab = useCallback(
    (tabId: string, delta: number) => {
      const ids = tabsOf(value).map((tab) => tab.id);
      const from = ids.indexOf(tabId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return;
      onChange(orderTabs(value, arrayMove(ids, from, to)));
    },
    [onChange, value],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId.startsWith(RELATION_ID_PREFIX)) {
        if (!overId.startsWith(GROUP_ID_PREFIX)) return;
        const relation = activeId.slice(RELATION_ID_PREFIX.length);
        const groupId = overId.slice(GROUP_ID_PREFIX.length);
        moveRelationTo(relation, groupId);
        return;
      }
      if (!activeId.startsWith(TAB_ID_PREFIX) || !overId.startsWith(TAB_ID_PREFIX)) return;
      const tabId = activeId.slice(TAB_ID_PREFIX.length);
      const overTabId = overId.slice(TAB_ID_PREFIX.length);
      if (tabId === overTabId) return;
      const ids = tabsOf(value).map((tab) => tab.id);
      const from = ids.indexOf(tabId);
      const to = ids.indexOf(overTabId);
      if (from < 0 || to < 0) return;
      onChange(orderTabs(value, arrayMove(ids, from, to)));
    },
    [moveRelationTo, onChange, value],
  );

  if (relationNames.length === 0) {
    return <Typography.Text type="secondary">{t('web.detail.tabs.noRelations')}</Typography.Text>;
  }

  return (
    <>
      <Card
        size="small"
        className="carocrm-card"
        title={t('web.detail.tabs.title')}
        extra={
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setLabelDraft('');
              setLabelDialog({ tabId: '', label: '' });
            }}
          >
            {t('web.detail.tabs.add')}
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={12} align="center">
            <Typography.Text strong>{t('web.detail.tabs.modeLabel')}</Typography.Text>
            <Segmented
              value={value.mode}
              onChange={(next) => onChange({ ...value, mode: next as EntityRelationTabs['mode'] })}
              options={[
                { value: 'stacked', label: t('web.detail.panels') },
                { value: 'tabs', label: t('web.detail.tabs.mode') },
              ]}
            />
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('web.detail.tabs.hint', { entity })}
          </Typography.Paragraph>

          <DndContext sensors={sensors} collisionDetection={relationCollision} onDragEnd={handleDragEnd}>
            <SortableContext items={tabsOf(value).map((tab) => `${TAB_ID_PREFIX}${tab.id}`)} strategy={verticalListSortingStrategy}>
              <div className="carocrm-relation-editor">
                {groups.map((group, index) => (
                  <RelationGroup
                    key={group.id}
                    group={group}
                    labelOf={labelOf}
                    options={moveOptions}
                    first={index === 0}
                    last={index === groups.length - 1}
                    onRename={(tabId, label) => {
                      setLabelDraft(label);
                      setLabelDialog({ tabId, label });
                    }}
                    onRemove={(tabId) => onChange(removeTab(value, tabId))}
                    onShift={shiftTab}
                    onMoveRelation={moveRelationTo}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay />
          </DndContext>
        </Space>
      </Card>

      <Modal
        open={labelDialog !== null}
        title={labelDialog?.tabId === '' ? t('web.detail.tabs.add') : t('web.detail.tabs.rename')}
        okText={t('web.common.save')}
        cancelText={t('core.common.cancel')}
        onCancel={() => setLabelDialog(null)}
        onOk={() => {
          const label = labelDraft.trim();
          if (labelDialog === null || label === '') return;
          // Creating a tab means wanting tabs: the mode follows, and the `Segmented` shows it, so
          // an administrator never arranges tabs and then finds the record page unchanged.
          onChange(
            labelDialog.tabId === ''
              ? { ...addTab(value, label), mode: 'tabs' }
              : renameTab(value, labelDialog.tabId, label),
          );
          setLabelDialog(null);
        }}
      >
        <label htmlFor="relation-tab-label">{t('web.detail.tabs.label')}</label>
        <Input
          id="relation-tab-label"
          value={labelDraft}
          maxLength={40}
          showCount
          onChange={(event) => setLabelDraft(event.target.value)}
        />
      </Modal>
    </>
  );
}
