import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
import {
  type EntityRelationTabs,
  normalizeArrangement,
  OTHER_TAB_ID,
  type RelationTabMode,
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
import { Alert, Button, Card, Checkbox, Input, Modal, Popconfirm, Segmented, Select, Space, Spin, Tabs, Typography } from 'antd';
import { type ReactNode,useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { detailTabMutations, type DetailTabsController } from '../state/detail-tabs.js';
import { t } from '../state/i18n.js';

/**
 * The record page's relation area (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * A record page stacks one card per relationship. For an entity with eight relations that buries
 * the record itself, and nothing on the page can be reordered by the person who works the record.
 * This component offers the alternative: the user creates, renames, reorders and deletes tabs and
 * places relations in them, by drag or by keyboard.
 *
 * What it deliberately does not do:
 *
 * - **It does not change the relation model.** Every panel is the same `/Related` call as today's
 *   stacked panel; tabs are presentation over them.
 * - **It does not change ACL.** A relation the caller cannot read renders nothing, and a tab whose
 *   relations are all unreadable is hidden — but the stored arrangement is left intact, because
 *   permissions can come back.
 * - **It does not lose a relation.** A relation placed in no tab lives in the implicit *Other* tab,
 *   which is computed on read and never stored. Deleting a tab returns its relations there.
 */

/** How a relation panel reports that the caller may not read it. */
export type RelationAccess = 'granted' | 'denied';

export interface RelationTabsProps {
  /** The entity whose relations are arranged; a change resets what the page learned. */
  entity: string;
  /** The stored arrangement, the mode and the writes. */
  controller: DetailTabsController;
  /** The entity's own relations — the yardstick the stored arrangement is reconciled against. */
  relationNames: readonly string[];
  /** The display name of a relation. */
  labelOf: (relation: string) => string;
  /** Renders the panel of one relation; the callback reports whether the relation is readable. */
  renderPanel: (relation: string, report: (access: RelationAccess) => void) => ReactNode;
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
 * The groups of an arrangement: the user's tabs plus the implicit *Other* pool.
 *
 * The view is reconciled against the entity's own relations: a relation the entity no longer has
 * disappears from the screen but stays in the stored preference, because it may come back (a
 * renamed relation, a temporarily missing panel). The stored value stays the source of truth for
 * writes; only the view is reconciled.
 *
 * `includeEmpty` is the manage mode: a tab may be created before it has relations, so it is shown
 * even when it is empty. In read mode an empty tab is hidden — there would be nothing to show.
 */
function groupsOf(arrangement: EntityRelationTabs, relationNames: readonly string[], includeEmpty: boolean): TabGroup[] {
  const reconciled = normalizeArrangement(arrangement, relationNames);
  const tabs = tabsOf(reconciled);
  const assigned = new Set(tabs.flatMap((tab) => tab.relations));
  const groups: TabGroup[] = tabs
    .filter((tab) => includeEmpty || tab.relations.length > 0)
    .map((tab) => ({ id: tab.id, label: tab.label, relations: [...tab.relations], implicit: false }));
  const unassigned = relationNames.filter((relation) => !assigned.has(relation));
  if (unassigned.length > 0 || includeEmpty) {
    groups.push({ id: OTHER_TAB_ID, label: t('web.detail.tabs.unassigned'), relations: unassigned, implicit: true });
  }
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

/**
 * The relation area of a record page: today's stacked panels, or the tabs the user arranged.
 *
 * The component owns the mode switch, the tab strip, the manage mode and the `?tab=` link. The
 * arrangement itself lives in the user's `detailTabs` preference.
 */
export function RelationTabs({ entity, controller, relationNames, labelOf, renderPanel }: RelationTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<EntityRelationTabs | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);
  const [labelDialog, setLabelDialog] = useState<{ tabId: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // A different entity is a different arrangement; what the page learned about the old one is stale.
  useEffect(() => {
    setDenied(new Set());
    setActiveTab(undefined);
    setManaging(false);
    setDraft(null);
    setDirty(false);
  }, [entity]);

  const stacked = controller.mode === 'stacked';

  /**
   * The arrangement the screen shows: the editor's draft while editing, the effective one
   * otherwise. The effective arrangement is the stored one, reconciled, or — for an entity the
   * user has never arranged — the computed default of one tab per relation.
   */
  const arrangement = useMemo(
    () => (managing && draft !== null ? draft : controller.effective),
    [managing, draft, controller.effective],
  );

  /** The groups of the arrangement, minus the tabs whose relations the caller cannot read. */
  const groups = useMemo(() => {
    const all = groupsOf(arrangement, relationNames, managing);
    if (managing) return all;
    return all.filter((group) => !group.relations.every((relation) => denied.has(relation)));
  }, [arrangement, relationNames, managing, denied]);

  /** Applies a mutation to the editor's draft. The draft is written when the editor closes. */
  const mutate = useCallback((change: (arrangement: EntityRelationTabs) => EntityRelationTabs) => {
    setDraft((current) => (current === null ? current : change(current)));
    setDirty(true);
  }, []);

  const moveRelation = useCallback(
    (relation: string, groupId: string) => {
      mutate((current) => detailTabMutations.move(current, relation, groupId === OTHER_TAB_ID ? null : groupId));
    },
    [mutate],
  );

  /** Moves a tab one place up or down — the keyboard path next to the drag handle. */
  const shiftTab = useCallback(
    (tabId: string, delta: number) => {
      mutate((current) => {
        const ids = tabsOf(current).map((tab) => tab.id);
        const from = ids.indexOf(tabId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length) return current;
        return detailTabMutations.reorder(current, arrayMove(ids, from, to));
      });
    },
    [mutate],
  );

  /** The tabs the strip shows: never the empty ones, and never a tab the caller may not read. */
  const readGroups = useMemo(
    () => (stacked ? [] : groups.filter((group) => !group.implicit || group.relations.length > 0)),
    [groups, stacked],
  );

  /** The tab that is on screen. A stale id falls back to the first tab. */
  const activeKey = useMemo(() => {
    if (activeTab !== undefined && readGroups.some((group) => group.id === activeTab)) return activeTab;
    return readGroups[0]?.id ?? '';
  }, [activeTab, readGroups]);

  // The `?tab=` link is the tab's address: a refresh and a pasted link land on the same tab. An
  // unknown id falls back to the first tab and the URL is corrected. Only tab mode carries the
  // parameter — a stacked page keeps today's clean URL.
  useEffect(() => {
    if (managing || stacked) return;
    const requested = searchParams.get('tab');
    if (requested === activeKey) return;
    const params = new URLSearchParams(searchParams);
    if (activeKey === '') params.delete('tab');
    else params.set('tab', activeKey);
    setSearchParams(params, { replace: true });
  }, [activeKey, managing, stacked, searchParams, setSearchParams]);

  const selectTab = useCallback(
    (key: string) => {
      setActiveTab(key);
      const params = new URLSearchParams(searchParams);
      params.set('tab', key);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Leaving the page with an unsaved draft: the same guard the record form uses (§20.13).
  useEffect(() => {
    if (!managing || !dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [managing, dirty]);

  const changeMode = useCallback(
    (value: RelationTabMode) => {
      if (value === controller.mode) return;
      controller.setMode(value);
    },
    [controller],
  );

  const openEditor = useCallback(() => {
    // The editor starts from what the user sees, so the default tabs are the tabs they arrange.
    setDraft(controller.effective);
    setDirty(false);
    setManaging(true);
  }, [controller.effective]);

  const closeEditor = useCallback(async () => {
    if (!dirty || draft === null) {
      setManaging(false);
      setDraft(null);
      return;
    }
    try {
      // One write for the whole arrangement.
      await controller.save(draft);
      setManaging(false);
      setDraft(null);
      setDirty(false);
    } catch {
      // The controller reported the error; the draft stays open so nothing is silently dropped.
    }
  }, [controller, dirty, draft]);

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
        moveRelation(relation, groupId);
        return;
      }
      if (!activeId.startsWith(TAB_ID_PREFIX) || !overId.startsWith(TAB_ID_PREFIX)) return;
      const tabId = activeId.slice(TAB_ID_PREFIX.length);
      const overTabId = overId.slice(TAB_ID_PREFIX.length);
      if (tabId === overTabId) return;
      mutate((current) => {
        const ids = tabsOf(current).map((tab) => tab.id);
        const from = ids.indexOf(tabId);
        const to = ids.indexOf(overTabId);
        if (from < 0 || to < 0) return current;
        return detailTabMutations.reorder(current, arrayMove(ids, from, to));
      });
    },
    [moveRelation, mutate],
  );

  const moveOptions = useMemo(
    () => [
      ...tabsOf(arrangement).map((tab) => ({ value: tab.id, label: tab.label })),
      { value: OTHER_TAB_ID, label: t('web.detail.tabs.unassigned') },
    ],
    [arrangement],
  );

  const reportAccess = useCallback(
    (relation: string) => (access: RelationAccess) => {
      if (access !== 'denied') return;
      setDenied((current) => {
        if (current.has(relation)) return current;
        const next = new Set(current);
        next.add(relation);
        return next;
      });
    },
    [],
  );

  const items = readGroups.map((group) => ({
    key: group.id,
    label: (
      <span className="carocrm-relation-tab-label">
        {group.label}
        <span className="carocrm-relation-tab-count">{group.relations.length}</span>
      </span>
    ),
    children: (
      <div className="carocrm-relation-panels">
        {group.relations.map((relation) => renderPanel(relation, reportAccess(relation)))}
      </div>
    ),
  }));

  // Until the preference is known, the mode is unknown too. Rendering the panels right away would
  // fetch every relation and then fetch them again when the stored mode turns out to be `tabs`, so
  // the area waits for the (small) preference instead.
  if (controller.loading && relationNames.length >= 2) {
    return (
      <div className="carocrm-relation-area carocrm-relation-loading">
        <Spin />
      </div>
    );
  }

  return (
    <div className="carocrm-relation-area">
      {relationNames.length >= 2 ? (
        <div className="carocrm-relation-toolbar">
          <Space wrap>
            {controller.mode === 'tabs' ? (
              <Button onClick={() => (managing ? void closeEditor() : openEditor())}>
                {managing ? t('web.detail.tabs.done') : t('web.detail.tabs.edit')}
              </Button>
            ) : null}
            <Segmented
              size="small"
              value={controller.mode}
              disabled={controller.loading}
              onChange={(value) => changeMode(value as RelationTabMode)}
              options={[
                { value: 'stacked', label: t('web.detail.panels') },
                { value: 'tabs', label: t('web.detail.tabs.mode') },
              ]}
            />
          </Space>
        </div>
      ) : null}

      {controller.error !== null ? (
        <Alert
          type="error"
          showIcon
          closable
          message={t('web.detail.tabs.saveFailed')}
          description={controller.error}
          onClose={controller.dismissError}
        />
      ) : null}

      {stacked ? (
        <div className="carocrm-relation-panels">
          {relationNames.map((relation) => renderPanel(relation, () => undefined))}
        </div>
      ) : null}

      {!stacked && !managing ? (
        <Tabs
          className="carocrm-relation-tabs"
          activeKey={activeKey}
          onChange={selectTab}
          items={items}
          destroyOnHidden
          tabBarGutter={16}
        />
      ) : null}

      {!stacked && managing ? (
        <Card
          className="carocrm-card"
          title={t('web.detail.tabs.manageTitle')}
          extra={
            <Space wrap>
              <Checkbox
                checked={controller.defaultMode === 'tabs'}
                onChange={(event) => controller.setDefaultMode(event.target.checked ? 'tabs' : 'stacked')}
              >
                {t('web.detail.tabs.useForAll')}
              </Checkbox>
              <Button
                icon={<PlusOutlined />}
                onClick={() => {
                  setLabelDraft('');
                  setLabelDialog({ tabId: '', label: '' });
                }}
              >
                {t('web.detail.tabs.add')}
              </Button>
              <Button type="primary" onClick={() => void closeEditor()}>
                {t('web.detail.tabs.done')}
              </Button>
            </Space>
          }
        >
          {dirty ? <Typography.Paragraph type="warning">{t('web.detail.tabs.unsaved')}</Typography.Paragraph> : null}
          <DndContext sensors={sensors} collisionDetection={relationCollision} onDragEnd={handleDragEnd}>
            <SortableContext items={tabsOf(arrangement).map((tab) => `${TAB_ID_PREFIX}${tab.id}`)} strategy={verticalListSortingStrategy}>
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
                    onRemove={(tabId) => mutate((current) => detailTabMutations.remove(current, tabId))}
                    onShift={shiftTab}
                    onMoveRelation={moveRelation}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay />
          </DndContext>
        </Card>
      ) : null}

      <Modal
        open={labelDialog !== null}
        title={labelDialog?.tabId === '' ? t('web.detail.tabs.add') : t('web.detail.tabs.rename')}
        okText={t('web.common.save')}
        cancelText={t('core.common.cancel')}
        onCancel={() => setLabelDialog(null)}
        onOk={() => {
          const label = labelDraft.trim();
          if (labelDialog === null || label === '') return;
          if (labelDialog.tabId === '') {
            mutate((current) => detailTabMutations.add(current, label));
          } else {
            mutate((current) => detailTabMutations.rename(current, labelDialog.tabId, label));
          }
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
    </div>
  );
}
