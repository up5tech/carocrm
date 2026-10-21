import { DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { type EntityRelationTabs, normalizeArrangement } from '@carocrm/metadata/relation-tabs.js';
import { closestCorners,type CollisionDetection, DndContext, type DragEndEvent, type DragOverEvent, DragOverlay, type DragStartEvent, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { App as AntApp, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import type { EntityDefinition, LayoutDefinition, LayoutPanel, LayoutViewType } from '../api/types.js';
import { t } from '../state/i18n.js';
import { detailEntries, editEntries, fieldLabel, useMetadata } from '../state/metadata.js';
import { RelationTabsEditor } from './RelationTabsEditor.js';

/** Views an admin can lay out by hand (PLAN §8). */
const LAYOUT_VIEWS: LayoutViewType[] = ['list', 'detail', 'edit'];

/** Prefix that keeps panel ids distinguishable from field ids inside one DndContext. */
const PANEL_ID_PREFIX = 'panel:';
/** The pool of member fields no panel of the view places. */
const LAYOUT_POOL_ID = 'disabled';
/** The dashed zone under the groups — dropping here appends the field to the last group. */
const LAYOUT_APPEND_ID = 'append';

export interface LayoutDraft {
  panels: LayoutPanel[];
  disabled: string[];
}

interface PanelDraft {
  name: string;
  label?: string | undefined;
}

export interface LayoutEditorProps {
  entity: EntityDefinition;
  /** Writes one `layouts` section through `POST /Metadata/:entity`; rejects surface to the caller. */
  save: (body: Record<string, unknown>, okText: string) => Promise<void> | void;
  /** Shell mode: the host renders the actions, so the editor draws no button row of its own. */
  showInlineActions?: boolean | undefined;
  /** Reports the draft every render, so a host can drive a shared save bar and its dirty guard. */
  onState?: (state: LayoutEditorState) => void;
}

export interface LayoutEditorState {
  readonly dirty: boolean;
  readonly panels: readonly LayoutPanel[];
  readonly pool: readonly string[];
  readonly view: LayoutViewType;
  persist: () => void;
  reset: () => void;
}

/** Fields an admin may place on a panel or index — a disabled field is retired, not merely hidden. */
export function memberFieldNames(entity: EntityDefinition): string[] {
  return Object.entries(entity.fields)
    .filter(([, field]) => field.type !== 'disabled')
    .map(([name]) => name);
}

/**
 * The fields the editor's pool holds.
 *
 * For the detail and edit views the pool is **not** a place fields disappear to: the record page
 * renders every field it does not place in a group under a computed **Other** card, after the
 * groups. The pool is that group, so it is computed from the fields the view can actually render —
 * bookkeeping columns and fields the view hides are absent from the pool, exactly as they are
 * absent from the page. The list view has no such fallback, so its pool stays the full member list.
 */
function poolFieldNames(entity: EntityDefinition, view: LayoutViewType): string[] {
  if (view === 'detail') return detailEntries(entity).map((entry) => entry.name);
  if (view === 'edit') return editEntries(entity).map((entry) => entry.name);
  return memberFieldNames(entity);
}

function panelsOf(entity: EntityDefinition, view: LayoutViewType): LayoutPanel[] {
  return (entity.layouts?.[view] ?? []).flatMap((definition) => definition.panels ?? []);
}

/** A layout section is always a list of definitions, so a panel edit rewrites the first one and leaves the rest untouched. */
function layoutSection(entity: EntityDefinition, view: LayoutViewType, panels: LayoutPanel[]): Record<string, unknown> {
  const existing = entity.layouts?.[view] ?? [];
  const definitions: LayoutDefinition[] =
    existing.length === 0 ? [{ entity: entity.name, type: view, panels }] : existing.map((definition, index) => (index === 0 ? { ...definition, panels } : definition));
  return { layouts: { ...entity.layouts, [view]: definitions } };
}

/** Editor draft for a view: panels in position order plus every renderable field not yet placed. */
function layoutDraftOf(entity: EntityDefinition, view: LayoutViewType): LayoutDraft {
  const panels = [...panelsOf(entity, view)].sort((a, b) => a.position - b.position);
  const assigned = new Set(panels.flatMap((panel) => panel.fields ?? []));
  return { panels, disabled: poolFieldNames(entity, view).filter((name) => !assigned.has(name)) };
}

/**
 * The relation-tab arrangement of an entity as the editor shows it; absent means today's stacked
 * panels.
 *
 * It is reconciled against the entity's own relations on the way in: a stored tab that still names a
 * relation the entity no longer has would otherwise be sent back on the next save and refused, and
 * the record page already hides it. Reconciling here keeps the two views of the section identical.
 */
function relationTabsOf(entity: EntityDefinition): EntityRelationTabs {
  return normalizeArrangement(entity.detailTabs, Object.keys(entity.relations ?? {}));
}

/** Which draft container currently holds a drag id — panel body, pool, or the chip's owner. */
function layoutContainerOf(state: LayoutDraft, id: string): string | undefined {
  if (id === LAYOUT_POOL_ID) return LAYOUT_POOL_ID;
  if (id.startsWith(PANEL_ID_PREFIX)) {
    const name = id.slice(PANEL_ID_PREFIX.length);
    return state.panels.some((panel) => panel.name === name) ? name : undefined;
  }
  if (state.disabled.includes(id)) return LAYOUT_POOL_ID;
  return state.panels.find((panel) => (panel.fields ?? []).includes(id))?.name;
}

/**
 * Pointer-first collision: the editor's panels shift while a panel is dragged, so a purely
 * geometric fallback (closestCorners) can resolve to a far-away chip once layouts move.
 */
const layoutCollisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  if (byPointer.length > 0) return byPointer;
  const byIntersection = rectIntersection(args);
  if (byIntersection.length > 0) return byIntersection;
  return closestCorners(args);
};

function LayoutFieldRow({ name, label, overlay }: { name: string; label: string; overlay?: boolean }) {
  return (
    <div className="carocrm-layout-row" title={name} style={overlay ? { boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)', cursor: 'grabbing' } : undefined}>
      <HolderOutlined />
      <span>{label}</span>
    </div>
  );
}

function SortableLayoutRow({ name, label }: { name: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: name });
  return (
    <div ref={setNodeRef} className="carocrm-layout-row-wrap" {...attributes} {...listeners} style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}>
      <LayoutFieldRow name={name} label={label} />
    </div>
  );
}

/** A layout panel rendered as a named block of field rows with rename/remove actions. */
function LayoutGroup({ panel, labelOf, onEdit, onRemove }: { panel: LayoutPanel; labelOf: (name: string) => string; onEdit: (name: string) => void; onRemove: (name: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `${PANEL_ID_PREFIX}${panel.name}` });
  const fields = panel.fields ?? [];
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}>
      <div className="carocrm-layout-group">
        <div className="carocrm-layout-group-head">
          <span className="carocrm-board-drag-handle" {...attributes} {...listeners}>
            <HolderOutlined />
          </span>
          <span className="carocrm-layout-group-name">{panel.label ?? panel.name}</span>
          <span className="carocrm-layout-group-count">({fields.length})</span>
          <span style={{ display: 'inline-flex', gap: 2, marginLeft: 'auto' }}>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={t('web.entityAdmin.layoutEditGroupAria', { name: panel.name })} onClick={() => onEdit(panel.name)} />
            <Popconfirm title={t('web.entityAdmin.removePanelConfirm', { name: panel.name })} okText={t('web.entityAdmin.remove')} onConfirm={() => onRemove(panel.name)}>
              <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.removePanelAria', { name: panel.name })} />
            </Popconfirm>
          </span>
        </div>
        <div className="carocrm-layout-group-body">
          {fields.length === 0 ? (
            <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 10px' }}>
              {t('web.entityAdmin.layoutPanelEmpty')}
            </Typography.Text>
          ) : (
            <SortableContext items={fields} strategy={verticalListSortingStrategy}>
              <div className="carocrm-layout-rows">
                {fields.map((field) => (
                  <SortableLayoutRow key={field} name={field} label={labelOf(field)} />
                ))}
              </div>
            </SortableContext>
          )}
        </div>
      </div>
    </div>
  );
}

/** The dashed zone under the groups: dropping a field here appends it to the last group. */
function AppendZone({ empty }: { empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: LAYOUT_APPEND_ID });
  return (
    <div ref={setNodeRef} className="carocrm-layout-append" style={{ background: isOver ? '#f0f7ff' : undefined }}>
      {empty ? t('web.entityAdmin.noPanels') : t('web.entityAdmin.layoutDropToEnd')}
    </div>
  );
}

/**
 * The pool of fields no group places. On the list view it means "not a column"; on the detail and
 * edit views it is the computed **Other** group the page renders after the panels, so the heading
 * and the note say so instead of claiming the fields are hidden.
 */
function LayoutPool({ draft, view, labelOf }: { draft: LayoutDraft; view: LayoutViewType; labelOf: (name: string) => string }) {
  const { setNodeRef, isOver } = useDroppable({ id: LAYOUT_POOL_ID });
  // The list view has no fallback for a field no panel places; the detail and edit pages do. With
  // groups, those fields land in the computed **Other** card; without any group the page shows one
  // plain field list, which the pool names accordingly.
  const computedOther = view !== 'list';
  const hasGroups = draft.panels.length > 0;
  const title = !computedOther
    ? t('web.entityAdmin.layoutDisabled')
    : hasGroups
      ? t('web.entityAdmin.layoutOtherTitle')
      : t('web.entityAdmin.layoutFieldsTitle');
  return (
    <Card size="small" className="carocrm-card" title={title}>
      <div ref={setNodeRef} className="carocrm-layout-pool" style={{ background: isOver ? '#f0f7ff' : '#fafafa' }}>
        {draft.disabled.length === 0 ? (
          <Typography.Text type="secondary">{t('web.entityAdmin.layoutPoolEmpty')}</Typography.Text>
        ) : (
          <SortableContext items={draft.disabled} strategy={verticalListSortingStrategy}>
            <div className="carocrm-layout-rows">
              {draft.disabled.map((field) => (
                <SortableLayoutRow key={field} name={field} label={labelOf(field)} />
              ))}
            </div>
          </SortableContext>
        )}
      </div>
      {computedOther ? (
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {hasGroups ? t('web.entityAdmin.layoutOtherHint') : t('web.entityAdmin.layoutFieldsHint')}
        </Typography.Text>
      ) : null}
    </Card>
  );
}

/**
 * What the saved layout will look like when it renders, built from the draft rather than the stored
 * definition: a list layout orders the table columns, a detail or edit layout stacks its panels.
 */
function LayoutPreview({ view, draft, labelOf }: { view: LayoutViewType; draft: LayoutDraft; labelOf: (name: string) => string }) {
  if (view === 'list') {
    const columns = draft.panels.flatMap((panel) => panel.fields ?? []);
    return (
      <Card size="small" className="carocrm-card" title={t('web.entityAdmin.layoutPreview')}>
        <div className="carocrm-layout-preview-table" role="img" aria-label={t('web.entityAdmin.layoutPreview')}>
          {columns.length === 0 ? <Typography.Text type="secondary">{t('web.entityAdmin.layoutPreviewEmpty')}</Typography.Text> : columns.map((field) => <span key={field} className="carocrm-layout-preview-col">{labelOf(field)}</span>)}
        </div>
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {t('web.entityAdmin.layoutPreviewListHint')}
        </Typography.Text>
      </Card>
    );
  }
  return (
    <Card size="small" className="carocrm-card" title={t('web.entityAdmin.layoutPreview')}>
      {draft.panels.map((panel) => (
        <div className="carocrm-layout-preview-panel" key={panel.name}>
          <p className="carocrm-layout-preview-panel-name">{panel.label ?? panel.name}</p>
          {(panel.fields ?? []).length === 0 ? (
            <Typography.Text type="secondary">{t('web.entityAdmin.layoutPanelEmpty')}</Typography.Text>
          ) : (
            (panel.fields ?? []).map((field) => (
              <div className="carocrm-layout-preview-row" key={field}>
                <span>{labelOf(field)}</span>
              </div>
            ))
          )}
        </div>
      ))}
      {/* The detail and edit pages render the pool after the groups: in an **Other** card when
          groups exist, or as the page's single field list when none does. The preview names the
          block the same way, so the saved page can not surprise the administrator. */}
      {draft.disabled.length > 0 ? (
        <div className="carocrm-layout-preview-panel" key="__other">
          <p className="carocrm-layout-preview-panel-name">
            {draft.panels.length > 0 ? t('core.common.other') : t('web.entityAdmin.layoutFieldsTitle')}
          </p>
          {draft.disabled.map((field) => (
            <div className="carocrm-layout-preview-row" key={field}>
              <span>{labelOf(field)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <Typography.Text type="secondary" className="carocrm-admin-note">
        {t('web.entityAdmin.layoutPreviewHint')}
      </Typography.Text>
    </Card>
  );
}

/**
 * Per-view layouts assembled from panels of fields, edited by drag and drop (PLAN §8).
 *
 * The keyboard alternative is dnd-kit's `KeyboardSensor`: focus a row, press Space, move with the
 * arrows, press Space again — no pointer needed. The same component serves the Entity Manager tab and
 * the settings shell, so both hosts get identical editing behavior; the host decides where Save lives.
 */
export function LayoutEditor({ entity, save, showInlineActions = true, onState }: LayoutEditorProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PanelDraft>();
  const [view, setView] = useState<LayoutViewType>('detail');
  const [draft, setDraft] = useState<LayoutDraft>(() => layoutDraftOf(entity, view));
  // The relation tabs belong to the detail view but are not panels: they are their own section of
  // the definition and keep their identity while the admin switches between views.
  const [tabs, setTabs] = useState<EntityRelationTabs>(() => relationTabsOf(entity));
  const [dirty, setDirty] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [groupModal, setGroupModal] = useState<{ mode: 'add' } | { mode: 'edit'; original: string } | null>(null);
  const metadata = useMetadata();
  const labelOf = (name: string) => fieldLabel(name, entity.fields?.[name], metadata.data);

  useEffect(() => {
    setDraft(layoutDraftOf(entity, view));
    setDirty(false);
  }, [entity, view]);

  // A refetched definition (a save elsewhere) or another entity: the stored arrangement wins. The
  // tab section does not depend on the view, so switching views must not discard it.
  useEffect(() => {
    setTabs(relationTabsOf(entity));
  }, [entity]);

  const resetDraft = () => {
    setDraft(layoutDraftOf(entity, view));
    setTabs(relationTabsOf(entity));
    setDirty(false);
  };

  const persistDraft = () => {
    const panels = draft.panels.map((panel, index) => ({ ...panel, position: index }));
    // The tab section is written only when it changed, so a panels-only save never rewrites it.
    const next = { ...layoutSection(entity, view, panels) };
    if (JSON.stringify(tabs) !== JSON.stringify(relationTabsOf(entity))) next['detailTabs'] = tabs;
    void save(next, t('web.entityAdmin.layoutSaved'));
  };

  // Published every render, like the settings shell's own contract: the host reads `dirty` for its bar
  // and calls persist/reset from it, so the two can never disagree about what is unsaved. The effect
  // (not the render body) does the reporting — the host stores the state, which would be a render-phase
  // update otherwise.
  useEffect(() => {
    onState?.({ dirty, view, panels: draft.panels, pool: draft.disabled, persist: persistDraft, reset: resetDraft });
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  /** Moves a field row across containers mid-drag so the drop lands where the pointer is. */
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const fieldId = String(active.id);
    if (fieldId.startsWith(PANEL_ID_PREFIX)) return;
    setDraft((current) => {
      const overId = String(over.id);
      const source = layoutContainerOf(current, fieldId);
      // The append zone targets the last group; everything else resolves to its own container.
      const target = overId === LAYOUT_APPEND_ID ? current.panels[current.panels.length - 1]?.name : layoutContainerOf(current, overId);
      if (!source || !target || source === target) return current;
      let panels = current.panels;
      let disabled = current.disabled;
      if (source === LAYOUT_POOL_ID) disabled = disabled.filter((field) => field !== fieldId);
      else panels = panels.map((panel) => (panel.name === source ? { ...panel, fields: (panel.fields ?? []).filter((field) => field !== fieldId) } : panel));
      if (target === LAYOUT_POOL_ID) {
        const next = [...disabled];
        const overIndex = overId === LAYOUT_POOL_ID ? next.length : next.indexOf(overId);
        next.splice(overIndex < 0 ? next.length : overIndex, 0, fieldId);
        disabled = next;
      } else {
        const targetPanel = panels.find((panel) => panel.name === target);
        if (!targetPanel) return current;
        const fields = [...(targetPanel.fields ?? [])];
        const overIndex = fields.indexOf(overId);
        fields.splice(overIndex < 0 ? fields.length : overIndex, 0, fieldId);
        panels = panels.map((panel) => (panel.name === target ? { ...panel, fields } : panel));
      }
      return { panels, disabled };
    });
    setDirty(true);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const activeIdText = String(active.id);
    const overId = String(over.id);
    if (activeIdText.startsWith(PANEL_ID_PREFIX)) {
      setDraft((current) => {
        let overPanelId = overId;
        if (!overPanelId.startsWith(PANEL_ID_PREFIX)) {
          // Collision usually resolves to a field row inside the target group — map it back.
          if (overPanelId === LAYOUT_POOL_ID || overPanelId === LAYOUT_APPEND_ID) return current;
          const owner = current.panels.find((panel) => (panel.fields ?? []).includes(overPanelId));
          if (!owner) return current;
          overPanelId = `${PANEL_ID_PREFIX}${owner.name}`;
        }
        if (activeIdText === overPanelId) return current;
        const from = current.panels.findIndex((panel) => `${PANEL_ID_PREFIX}${panel.name}` === activeIdText);
        const to = current.panels.findIndex((panel) => `${PANEL_ID_PREFIX}${panel.name}` === overPanelId);
        return from < 0 || to < 0 ? current : { ...current, panels: arrayMove(current.panels, from, to) };
      });
      setDirty(true);
      return;
    }
    setDraft((current) => {
      const source = layoutContainerOf(current, activeIdText);
      if (!source || layoutContainerOf(current, overId) !== source || activeIdText === overId) return current;
      if (source === LAYOUT_POOL_ID) {
        const from = current.disabled.indexOf(activeIdText);
        const to = current.disabled.indexOf(overId);
        return from < 0 || to < 0 ? current : { ...current, disabled: arrayMove(current.disabled, from, to) };
      }
      return {
        ...current,
        panels: current.panels.map((panel) => {
          if (panel.name !== source) return panel;
          const fields = panel.fields ?? [];
          const from = fields.indexOf(activeIdText);
          const to = fields.indexOf(overId);
          return from < 0 || to < 0 ? panel : { ...panel, fields: arrayMove(fields, from, to) };
        }),
      };
    });
    setDirty(true);
  };

  const openGroupModal = (mode: 'add' | 'edit', original?: string) => {
    if (mode === 'edit' && original) form.setFieldsValue({ name: original, label: draft.panels.find((panel) => panel.name === original)?.label ?? '' });
    else form.resetFields();
    setGroupModal(mode === 'edit' && original ? { mode, original } : { mode: 'add' });
  };

  const submitGroupModal = (values: PanelDraft) => {
    const name = (values.name ?? '').trim();
    if (name === '') {
      void message.error(t('web.entityAdmin.panelNameRequired'));
      return;
    }
    const label = values.label?.trim() ?? '';
    setDraft((current) => {
      const taken = current.panels.some((panel) => panel.name === name && panel.name !== (groupModal?.mode === 'edit' ? groupModal.original : ''));
      if (taken) {
        void message.error(t('web.entityAdmin.panelNameRequired'));
        return current;
      }
      if (groupModal?.mode === 'edit') {
        return { ...current, panels: current.panels.map((panel) => (panel.name === groupModal.original ? { ...panel, name, ...(label === '' ? {} : { label }) } : panel)) };
      }
      return { ...current, panels: [...current.panels, { name, position: current.panels.length, fields: [], ...(label === '' ? {} : { label }) }] };
    });
    setDirty(true);
    setGroupModal(null);
  };

  const removePanel = (name: string) => {
    setDraft((current) => {
      const panel = current.panels.find((candidate) => candidate.name === name);
      if (!panel) return current;
      return {
        panels: current.panels.filter((candidate) => candidate.name !== name),
        disabled: [...current.disabled, ...(panel.fields ?? [])],
      };
    });
    setDirty(true);
  };

  /** A tab edit is a draft edit: it joins the same dirty state and the same Save. */
  const changeTabs = (next: EntityRelationTabs) => {
    setTabs(next);
    setDirty(true);
  };

  const relationNames = Object.keys(entity.relations ?? {});
  const relationLabelOf = (relation: string) => entity.relations[relation]?.label ?? fieldLabel(relation);

  const activeField = activeId !== null && !activeId.startsWith(PANEL_ID_PREFIX) ? activeId : null;
  const activePanel = activeId !== null && activeId.startsWith(PANEL_ID_PREFIX) ? draft.panels.find((panel) => `${PANEL_ID_PREFIX}${panel.name}` === activeId) : undefined;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]} align="middle">
        <Col xs={24} sm={8} md={6}>
          <label htmlFor="layout-view">{t('web.entityAdmin.view')}</label>
          <Select id="layout-view" style={{ width: '100%' }} value={view} options={LAYOUT_VIEWS.map((value) => ({ value, label: value }))} onChange={(value: LayoutViewType) => setView(value)} />
        </Col>
        <Col xs={24} sm={16} md={18}>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Text type="secondary">{t('web.entityAdmin.panelCount', { panels: String(draft.panels.length), view })}</Typography.Text>
            {showInlineActions && dirty ? (
              <Space>
                <Typography.Text type="warning">{t('web.entityAdmin.layoutUnsaved')}</Typography.Text>
                <Button icon={<UndoOutlined />} onClick={resetDraft}>
                  {t('web.entityAdmin.layoutReset')}
                </Button>
                <Button type="primary" icon={<SaveOutlined />} onClick={persistDraft}>
                  {t('web.common.save')}
                </Button>
              </Space>
            ) : null}
          </Space>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('web.entityAdmin.layoutEditorHint')}
      </Typography.Paragraph>

      <DndContext sensors={sensors} collisionDetection={layoutCollisionDetection} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12} xl={8}>
            <Card
              size="small"
              className="carocrm-card"
              title={t('web.entityAdmin.layoutVisible')}
              extra={
                <Button size="small" icon={<PlusOutlined />} onClick={() => openGroupModal('add')}>
                  {t('web.entityAdmin.layoutAddGroup')}
                </Button>
              }
            >
              <SortableContext items={draft.panels.map((panel) => `${PANEL_ID_PREFIX}${panel.name}`)} strategy={verticalListSortingStrategy}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {draft.panels.map((panel) => (
                    <LayoutGroup key={panel.name} panel={panel} labelOf={labelOf} onEdit={(name) => openGroupModal('edit', name)} onRemove={removePanel} />
                  ))}
                </Space>
              </SortableContext>
              <AppendZone empty={draft.panels.length === 0} />
            </Card>
          </Col>
          <Col xs={24} lg={12} xl={8}>
            <LayoutPool draft={draft} view={view} labelOf={labelOf} />
          </Col>
          <Col xs={24} xl={8}>
            <LayoutPreview view={view} draft={draft} labelOf={labelOf} />
          </Col>
        </Row>
        {view === 'detail' && relationNames.length >= 2 ? (
          <Row gutter={[16, 16]}>
            <Col span={24}>
              {/* The relation area is part of the detail layout: it is arranged here, next to the
                  panels, and the record page only renders what this section says (§5.11). */}
              <RelationTabsEditor
                entity={entity.name}
                value={tabs}
                onChange={changeTabs}
                labelOf={relationLabelOf}
                relationNames={relationNames}
              />
            </Col>
          </Row>
        ) : null}

        <DragOverlay dropAnimation={null}>
          {activeField !== null ? <LayoutFieldRow name={activeField} label={labelOf(activeField)} overlay /> : null}
          {activePanel ? (
            <div className="carocrm-layout-group" style={{ width: 340, boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)' }}>
              <div className="carocrm-layout-group-head">
                <HolderOutlined />
                <span className="carocrm-layout-group-name">{activePanel.label ?? activePanel.name}</span>
                <span className="carocrm-layout-group-count">({(activePanel.fields ?? []).length})</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <Modal
        title={groupModal?.mode === 'edit' ? t('web.entityAdmin.layoutEditGroupTitle', { name: groupModal.original }) : t('web.entityAdmin.layoutAddGroup')}
        open={groupModal !== null}
        forceRender
        onCancel={() => setGroupModal(null)}
        onOk={() => form.submit()}
        okText={groupModal?.mode === 'edit' ? t('web.common.save') : t('web.common.add')}
      >
        <Form form={form} layout="vertical" onFinish={submitGroupModal}>
          <Form.Item name="name" label={t('web.entityAdmin.panelName')} rules={[{ required: true, message: t('web.entityAdmin.panelNameRequired') }]}>
            <Input placeholder="panelName" />
          </Form.Item>
          <Form.Item name="label" label={t('web.entityAdmin.label')}>
            <Input placeholder={t('web.entityAdmin.displayLabelPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
