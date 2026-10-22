import { ReloadOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { App as AntApp, Button, Card, Input, Select, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type WhereClause } from '../api/client.js';
import type { FieldDefinition } from '../api/types.js';
import { FieldValue, linkLabelsOf } from '../components/fields.js';
import { t } from '../state/i18n.js';
import {
  boardGroupFields,
  defaultBoardGroupField,
  enumValues,
  type FieldEntry,
  fieldLabel,
  listEntries,
  useEntity,
  useMetadata,
} from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
import { useSession } from '../state/session.js';

/**
 * Board (Kanban) view of a record list — one column per value of an enum field, one card per
 * record, dragging a card between columns writes the field.
 *
 * The view is metadata-driven on purpose: the columns are the `values` of an enum field the
 * caller picks from the entity's own definition, and a card shows that entity's scalar list
 * fields. Nothing here knows about Opportunities, so any entity with an enum field — including
 * one contributed by an extension package — gets a board without a code change (AGENTS §8).
 *
 * A drop is a *request*: the move is an ordinary `PATCH /:entity/:id` through the Entity Engine,
 * so field validation, dynamic logic, record ACL and audit all apply, and a role that may not
 * edit the record is refused server-side. The board then reloads, so a card is never left
 * sitting in a column the server did not agree to move it to.
 */

/** Records per column before the reader has to ask for more. */
const COLUMN_PAGE_SIZE = 25;

/**
 * Field types a card body never shows: relations render as a bare id here (the label costs one
 * request per card) and a text field would make one card taller than the column.
 */
const CARD_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'link',
  'linkOne',
  'foreign',
  'linkMultiple',
  'attachmentMultiple',
  'text',
  'password',
]);

/** Fields shown per card at most, so a wide entity keeps the board readable. */
const CARD_FIELD_LIMIT = 3;

/** One column: an enum value, or the records that carry no value at all. */
interface BoardColumn {
  key: string;
  value: string | null;
}

interface ColumnData {
  rows: Record<string, unknown>[];
  total: number;
}

export function EntityBoardPage() {
  const { entity: entityName } = useParams<{ entity: string }>();
  const navigate = useNavigate();
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entityName);

  const [groupBy, setGroupBy] = useState<string | undefined>(undefined);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [textQuery, setTextQuery] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<Record<string, ColumnData>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const groupFields = useMemo(() => boardGroupFields(definition.data), [definition.data]);

  // The group field is chosen once the definition arrives, and kept while it still exists on the
  // entity — a metadata edit that removes it must not leave the board pointing at a dead field.
  useEffect(() => {
    if (groupFields.length === 0) return;
    setGroupBy((current) =>
      current !== undefined && groupFields.some((entry) => entry.name === current)
        ? current
        : defaultBoardGroupField(definition.data),
    );
  }, [definition.data, groupFields]);

  const groupField: FieldDefinition | undefined = groupBy === undefined ? undefined : definition.data?.fields[groupBy];

  const columns = useMemo<BoardColumn[]>(() => {
    if (groupBy === undefined || groupField === undefined) return [];
    const built: BoardColumn[] = enumValues(groupField).map((value) => ({ key: `v:${value}`, value }));
    // A record without a value would otherwise be invisible on the board. The column hides itself
    // when it is empty, so an entity that always sets the field is not shown a stray column.
    if (groupField.required !== true) built.push({ key: 'none', value: null });
    return built;
  }, [groupBy, groupField]);

  // A different entity or group field is a different board: paging and search do not carry over.
  useEffect(() => {
    setLimits({});
    setTextQuery('');
    setQuery('');
    setData({});
  }, [entityName, groupBy]);

  const load = useCallback(async () => {
    if (!entityName || groupBy === undefined || columns.length === 0) return;
    setLoading(true);
    try {
      const results = await Promise.all(
        columns.map(async (column) => {
          // The same query grammar and the same ACL path as the list view: one request per column,
          // because the engine's list endpoint filters by a `where` clause rather than by group.
          const where: WhereClause = [
            column.value === null
              ? { field: groupBy, operator: 'isNull' }
              : { field: groupBy, operator: 'equals', value: column.value },
          ];
          const params = { where, orderBy: '-createdAt', offset: 0, maxSize: limits[column.key] ?? COLUMN_PAGE_SIZE };
          const result =
            query === ''
              ? await api.list(entityName, params)
              : await api.entitySearch(entityName, { ...params, q: query });
          return [column.key, { rows: result.list, total: result.total ?? result.list.length }] as const;
        }),
      );
      setData(Object.fromEntries(results));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('web.board.loadFailed'));
      setData({});
    } finally {
      setLoading(false);
    }
  }, [columns, entityName, groupBy, limits, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const displayField = definition.data?.record?.displayField ?? 'name';

  const cardEntries = useMemo(
    () =>
      listEntries(definition.data)
        .filter(
          (entry) => entry.name !== displayField && entry.name !== groupBy && !CARD_EXCLUDED_TYPES.has(entry.field.type),
        )
        .slice(0, CARD_FIELD_LIMIT),
    [definition.data, displayField, groupBy],
  );

  const recordById = useCallback(
    (id: string): Record<string, unknown> | undefined =>
      Object.values(data)
        .flatMap((column) => column.rows)
        .find((row) => String(row['id']) === id),
    [data],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    setActiveId(null);
    if (entityName === undefined || groupBy === undefined) return;
    const recordId = String(event.active.id);
    const targetKey = String(event.over?.data.current?.['columnKey'] ?? '');
    const target = columns.find((column) => column.key === targetKey);
    const record = recordById(recordId);
    if (target === undefined || record === undefined) return;

    const current = record[groupBy];
    const currentValue = current === null || current === undefined ? '' : String(current);
    if (currentValue === (target.value ?? '')) return;

    try {
      await api.update(entityName, recordId, { [groupBy]: target.value, version: record['version'] });
      void message.success(t('web.board.moved', { value: target.value ?? t('web.board.noValue') }));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.board.moveFailed'));
    } finally {
      await load();
    }
  };

  if (metadata.isError || definition.isError) {
    return <Card>{t('web.list.notAvailable', { entity: entityName ?? '' })}</Card>;
  }

  if (definition.data !== undefined && groupFields.length === 0) {
    return <Card>{t('web.board.noGroupField', { entity: definition.data.label })}</Card>;
  }

  const activeRow = activeId === null ? undefined : recordById(activeId);
  const loadingFirstPage = loading && Object.keys(data).length === 0;

  return (
    <Card className="carocrm-card carocrm-list-card">
      <div className="carocrm-list-head">
        <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>
          {definition.data?.label ?? entityName}
        </Typography.Title>
        <Space wrap>
          <Select
            style={{ minWidth: 180 }}
            value={groupBy ?? null}
            placeholder={t('web.board.groupBy')}
            aria-label={t('web.board.groupBy')}
            options={groupFields.map((entry) => ({ value: entry.name, label: fieldLabel(entry.name, entry.field) }))}
            onChange={(value: unknown) => setGroupBy(typeof value === 'string' ? value : undefined)}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t('web.list.refresh')}
          </Button>
          <Button icon={<UnorderedListOutlined />} onClick={() => navigate(`${base}/${entityName ?? ''}`)}>
            {t('web.board.viewList')}
          </Button>
        </Space>
      </div>

      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('web.list.textSearch')}
          value={textQuery}
          onChange={(event) => setTextQuery(event.target.value)}
          onPressEnter={() => setQuery(textQuery.trim())}
          allowClear
        />
        <Button type="primary" onClick={() => setQuery(textQuery.trim())}>
          {t('web.list.search')}
        </Button>
      </Space.Compact>

      {loadError !== null ? <Typography.Text type="danger">{loadError}</Typography.Text> : null}

      <Spin spinning={loadingFirstPage}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={(event) => setActiveId(String(event.active.id))}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={(event) => void onDragEnd(event)}
        >
          <div className="carocrm-board">
            {columns.map((column) => (
              <BoardColumnView
                key={column.key}
                column={column}
                label={column.value ?? t('web.board.noValue')}
                rows={data[column.key]?.rows ?? []}
                total={data[column.key]?.total ?? 0}
                loading={loading}
                cardEntries={cardEntries}
                displayField={displayField}
                entityName={entityName ?? ''}
                base={base}
                onLoadMore={() =>
                  setLimits((current) => ({ ...current, [column.key]: (current[column.key] ?? COLUMN_PAGE_SIZE) + COLUMN_PAGE_SIZE }))
                }
              />
            ))}
          </div>

          {/*
            The card being dragged is drawn through the overlay, not inside its own column: a column
            has an opaque background, so the following ones would paint over the card the moment it
            crossed their edge. `dropAnimation={null}` because the drop refetches from the server.
          */}
          <DragOverlay dropAnimation={null}>
            {activeRow === undefined ? null : (
              <div className="carocrm-board-card carocrm-board-card-overlay">
                <BoardCardContent
                  row={activeRow}
                  cardEntries={cardEntries}
                  displayField={displayField}
                  entityName={entityName ?? ''}
                  base={base}
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </Spin>
    </Card>
  );
}

interface ColumnProps {
  column: BoardColumn;
  label: string;
  rows: Record<string, unknown>[];
  total: number;
  loading: boolean;
  cardEntries: FieldEntry[];
  displayField: string;
  entityName: string;
  base: string;
  onLoadMore: () => void;
}

function BoardColumnView({
  column,
  label,
  rows,
  total,
  loading,
  cardEntries,
  displayField,
  entityName,
  base,
  onLoadMore,
}: ColumnProps) {
  const drop = useDroppable({ id: `column:${column.key}`, data: { columnKey: column.key } });

  return (
    <div className={`carocrm-board-column${drop.isOver ? ' is-over' : ''}`} ref={drop.setNodeRef}>
      <div className="carocrm-board-column-head">
        <span className="carocrm-board-column-title">{label}</span>
        <span className="carocrm-board-column-count">{total}</span>
      </div>
      <SortableContext items={rows.map((row) => String(row['id']))} strategy={verticalListSortingStrategy}>
        <div className="carocrm-board-column-body">
          {rows.map((row) => (
            <BoardCard
              key={String(row['id'])}
              row={row}
              columnKey={column.key}
              cardEntries={cardEntries}
              displayField={displayField}
              entityName={entityName}
              base={base}
            />
          ))}
        </div>
      </SortableContext>
      {rows.length === 0 && !loading ? (
        <span className="carocrm-board-column-empty">{t('web.board.emptyColumn')}</span>
      ) : null}
      {rows.length < total ? (
        <Button size="small" type="text" className="carocrm-board-more" onClick={onLoadMore}>
          {t('web.board.loadMore', { remaining: total - rows.length })}
        </Button>
      ) : null}
    </div>
  );
}

function BoardCard({
  row,
  columnKey,
  cardEntries,
  displayField,
  entityName,
  base,
}: {
  row: Record<string, unknown>;
  columnKey: string;
  cardEntries: FieldEntry[];
  displayField: string;
  entityName: string;
  base: string;
}) {
  const sortable = useSortable({ id: String(row['id']), data: { columnKey } });

  return (
    <div
      className={`carocrm-board-card${sortable.isDragging ? ' is-dragging' : ''}`}
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    >
      <BoardCardContent
        row={row}
        cardEntries={cardEntries}
        displayField={displayField}
        entityName={entityName}
        base={base}
        dragHandle={
          /*
            dnd-kit starts a drag only from the element that carries `listeners`; `attributes` alone
            is ARIA. The handle is that element, so the card's own link keeps working as a link and
            never turns into an accidental move.
          */
          <button
            type="button"
            className="carocrm-board-drag-handle"
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...(sortable.listeners ?? {})}
            aria-label={t('web.board.dragCard')}
          >
            ⠿
          </button>
        }
      />
    </div>
  );
}

function BoardCardContent({
  row,
  cardEntries,
  displayField,
  entityName,
  base,
  dragHandle,
}: {
  row: Record<string, unknown>;
  cardEntries: FieldEntry[];
  displayField: string;
  entityName: string;
  base: string;
  dragHandle?: React.ReactNode;
}) {
  const id = String(row['id']);

  return (
    <>
      <div className="carocrm-board-card-head">
        {dragHandle ?? null}
        <Link className="carocrm-board-card-title" to={`${base}/${entityName}/${encodeURIComponent(id)}`}>
          {String(row[displayField] ?? row['name'] ?? id)}
        </Link>
      </div>
      {cardEntries.length === 0 ? null : (
        <div className="carocrm-board-card-fields">
          {cardEntries.map((entry) => (
            <span key={entry.name} className="carocrm-board-card-field">
              <span className="carocrm-board-card-field-label">{fieldLabel(entry.name, entry.field)}</span>
              <FieldValue
                field={entry.field}
                value={row[entry.name]}
                variant="inline"
                fieldName={entry.name}
                linkLabels={linkLabelsOf(row)}
              />
            </span>
          ))}
        </div>
      )}
    </>
  );
}
