import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  HolderOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ProjectOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { App as AntApp, Button, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Tooltip } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api, type DashboardRow } from '../api/client.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { EmptyState } from '../components/EmptyState.js';
import { pickDefaultDashboard } from '../state/dashboard-default.js';
import { t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { usePreference } from '../state/preferences.js';
import { useSession } from '../state/session.js';
import { DashletResult } from './DashletResult.js';

/** The mark and the label a dashlet header shows for its kind. */
const DASHLET_ICONS: Record<string, React.ReactNode> = {
  list: <TableOutlined />,
  chart: <BarChartOutlined />,
  kpi: <DashboardOutlined />,
  projectTasks: <ProjectOutlined />,
  esignature: <FileDoneOutlined />,
};

const DASH_GAP = 16;
const DASH_MIN_COLUMN = 420;
/** Height used until the card has been measured; the observer corrects it before the next paint. */
const DASH_FALLBACK_HEIGHT = 240;

function dashColumnCount(width: number): number {
  return Math.max(1, Math.floor((Math.max(width, DASH_MIN_COLUMN) + DASH_GAP) / (DASH_MIN_COLUMN + DASH_GAP)));
}

interface DashPlacement {
  column: number;
  top: number;
}

/**
 * Masonry placement: each tile goes to the shortest column, then cards are traded between columns
 * until the board cannot get shorter, so a short card never leaves a row-high hole under itself.
 * Rendering and drag simulation both call this, so the previewed slot is the slot the tile lands in.
 */
function layoutDashlets(
  order: string[],
  heights: Record<string, number>,
  columnCount: number,
  dragged: { id: string; height: number } | null,
): { placements: Map<string, DashPlacement>; height: number } {
  const heightOf = (id: string): number =>
    (dragged?.id === id ? dragged.height : (heights[id] ?? DASH_FALLBACK_HEIGHT)) + DASH_GAP;
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  const used = new Array<number>(columnCount).fill(0);
  for (const id of order) {
    let column = 0;
    for (let candidate = 1; candidate < columnCount; candidate += 1) {
      if ((used[candidate] ?? 0) < (used[column] ?? 0)) column = candidate;
    }
    columns[column]?.push(id);
    used[column] = (used[column] ?? 0) + heightOf(id);
  }
  // Greedy placement can leave one column much taller; moving its cheapest card to the shortest
  // column lowers the board height. Each move strictly reduces the maximum, so the loop ends.
  for (let attempt = 0; attempt < order.length * columnCount; attempt += 1) {
    let tallest = 0;
    let shortest = 0;
    for (let column = 1; column < columnCount; column += 1) {
      if ((used[column] ?? 0) > (used[tallest] ?? 0)) tallest = column;
      if ((used[column] ?? 0) < (used[shortest] ?? 0)) shortest = column;
    }
    if (tallest === shortest) break;
    let moveId: string | null = null;
    let nextTallest = used[tallest] ?? 0;
    for (const id of columns[tallest] ?? []) {
      const height = heightOf(id);
      const max = Math.max((used[tallest] ?? 0) - height, (used[shortest] ?? 0) + height);
      if (max < nextTallest - 0.5) {
        nextTallest = max;
        moveId = id;
      }
    }
    if (moveId === null) break;
    const height = heightOf(moveId);
    columns[tallest] = (columns[tallest] ?? []).filter((id) => id !== moveId);
    columns[shortest]?.push(moveId);
    used[tallest] = (used[tallest] ?? 0) - height;
    used[shortest] = (used[shortest] ?? 0) + height;
  }

  const placements = new Map<string, DashPlacement>();
  let height = 0;
  columns.forEach((column, index) => {
    let top = 0;
    for (const id of column) {
      placements.set(id, { column: index, top });
      top += heightOf(id);
    }
    height = Math.max(height, top - DASH_GAP);
  });
  return { placements, height: Math.max(0, height) };
}

/** Tries every insertion point and keeps the one whose landing slot sits closest to the pointer. */
function chooseInsertionOrder(
  order: string[],
  draggedId: string,
  draggedHeight: number,
  point: { x: number; y: number },
  grid: { left: number; top: number; width: number },
  heights: Record<string, number>,
  columnCount: number,
): string[] {
  const others = order.filter((id) => id !== draggedId);
  const columnWidth = Math.max(0, (grid.width - DASH_GAP * (columnCount - 1)) / columnCount);
  let bestOrder = order;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= others.length; index += 1) {
    const candidate = [...others.slice(0, index), draggedId, ...others.slice(index)];
    const placement = layoutDashlets(candidate, heights, columnCount, { id: draggedId, height: draggedHeight }).placements.get(
      draggedId,
    );
    if (!placement) continue;
    const left = grid.left + placement.column * (columnWidth + DASH_GAP);
    const top = grid.top + placement.top;
    const x = Math.min(Math.max(point.x, left), left + columnWidth);
    const y = Math.min(Math.max(point.y, top), top + draggedHeight);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOrder = candidate;
    }
  }
  return bestOrder;
}

interface DashletDrag {
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  height: number;
  ghost: HTMLElement | null;
  started: boolean;
}

function dashletKindLabel(kind: string): string {
  switch (kind) {
    case 'list':
      return t('web.reports.kindList');
    case 'chart':
      return t('web.reports.kindChart');
    case 'kpi':
      return t('web.reports.kindKpi');
    case 'projectTasks':
      return t('web.dashboards.kindProjectTasks');
    case 'esignature':
      return t('web.dashboards.kindESignature');
    default:
      return kind;
  }
}

export function DashboardsPage() {
  usePageDocs('user/dashboards-and-reports');
  const metadata = useMetadata();
  const { principal } = useSession();
  const { message } = AntApp.useApp();
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [dashletOpen, setDashletOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; height: number } | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const previewRef = useRef<string[] | null>(null);
  const finishDragRef = useRef<(() => void) | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const heightsRef = useRef<Record<string, number>>({});
  const [form] = Form.useForm();
  const [renameForm] = Form.useForm();
  const [dashletForm] = Form.useForm();
  const dashletKind = Form.useWatch('kind', dashletForm);

  const entities = navEntities(metadata.data, principal?.type).map((entity) => ({ value: entity.name, label: entity.label }));
  const active = dashboards.find((item) => item.id === activeId) ?? null;
  // Only the owner (or an administrator) may change a board; the API enforces the same rule, this
  // just keeps the controls from offering an action that would end in 403.
  const canEdit = active !== null && (principal?.type === 'admin' || (active.userId !== null && active.userId === principal?.id));
  // While a drag is in flight the grid renders the pending order, with the dragged card's slot
  // turned into the empty drop zone rather than the card itself.
  const shownDashlets = previewOrder
    ? previewOrder.flatMap((id) => {
        const dashlet = active?.dashlets.find((item) => item.id === id);
        return dashlet ? [dashlet] : [];
      })
    : (active?.dashlets ?? []);
  const columnCount = dashColumnCount(gridWidth);
  const activeCardIds = active?.dashlets.map((dashlet) => dashlet.id).join('|') ?? '';
  const orderIndex = new Map(shownDashlets.map((dashlet, index) => [dashlet.id, index]));
  const layout = layoutDashlets(
    shownDashlets.map((dashlet) => dashlet.id),
    cardHeights,
    columnCount,
    drag,
  );
  const dashletStyle = (placement: DashPlacement): React.CSSProperties => ({
    left: `calc(${placement.column} * (100% + ${DASH_GAP}px) / ${columnCount})`,
    position: 'absolute',
    top: placement.top,
    width: `calc((100% - ${(columnCount - 1) * DASH_GAP}px) / ${columnCount})`,
  });
  // §20.10: the dashboard the user starred opens first, on every device — until they pick another one
  // themselves, which this ref records so the preference never fights an explicit choice.
  const defaultDashboard = usePreference<string | null>('defaultDashboard');
  const chosenManually = useRef(false);
  useEffect(() => {
    if (chosenManually.current) return;
    // §20.19: the priority is shared with the home page (user-starred > role-scoped > first), so the
    // two screens cannot land on different boards.
    const picked = pickDefaultDashboard(dashboards, defaultDashboard.value, principal?.roles ?? []);
    if (!picked) return;
    // The fallback picks the first board for a fresh screen; it never replaces the one already open.
    if (picked.source === 'first' && activeId !== null) return;
    setActiveId(picked.id);
  }, [defaultDashboard.value, dashboards, principal, activeId]);

  const load = useCallback(async (): Promise<DashboardRow[]> => {
    setLoading(true);
    try {
      const list = await api.dashboards();
      setDashboards(list);
      setActiveId((prev) => (list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? null)));
      return list;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.dashboards.loadFailed'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // A drag in flight leaves a cloned card on <body>; drop it when the page goes away.
  useEffect(() => () => finishDragRef.current?.(), []);

  // Card height drives the masonry placement and the grid width drives the column count. Measuring
  // synchronously in a layout effect (not only in ResizeObserver, which can be deferred in a hidden
  // tab) means the first frame already uses real positions instead of the fallback.
  const measureGrid = useCallback((grid: HTMLElement) => {
    setGridWidth(grid.clientWidth);
    let changed = false;
    grid.querySelectorAll<HTMLElement>('[data-dashlet-id]').forEach((element) => {
      const id = element.dataset['dashletId'];
      if (!id) return;
      const height = element.getBoundingClientRect().height;
      if (Math.abs((heightsRef.current[id] ?? 0) - height) > 1) {
        heightsRef.current[id] = height;
        changed = true;
      }
    });
    if (changed) setCardHeights({ ...heightsRef.current });
  }, []);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid) measureGrid(grid);
  });

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(() => measureGrid(grid));
    observer.observe(grid);
    grid.querySelectorAll<HTMLElement>('[data-dashlet-id]').forEach((element) => observer.observe(element));
    const onResize = (): void => measureGrid(grid);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [activeCardIds, measureGrid]);

  // Takes the dashboard row to run: a caller that just reloaded the list must not run the stale
  // dashlet set captured in an earlier render.
  const runAll = useCallback(
    async (dash: DashboardRow) => {
      try {
        const entries = await Promise.all(dash.dashlets.map(async (dashlet) => [dashlet.id, await api.runDashlet(dash.id, dashlet.id)] as const));
        setResults(Object.fromEntries(entries));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.dashboards.runFailed'));
      }
    },
    [message],
  );

  const refresh = useCallback(async () => {
    const list = await load();
    const current = list.find((item) => item.id === activeId) ?? list[0];
    if (current && current.dashlets.length > 0) await runAll(current);
  }, [activeId, load, runAll]);

  useEffect(() => {
    setResults({});
    if (active && active.dashlets.length > 0) void runAll(active);
  }, [active?.id]);

  const runOne = useCallback(
    async (dashletId: string) => {
      if (!active) return;
      try {
        const ran = await api.runDashlet(active.id, dashletId);
        setResults((prev) => ({ ...prev, [dashletId]: ran }));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.dashboards.runOneFailed'));
      }
    },
    [active, message],
  );

  const submitDashboard = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const created = await api.createDashboard({ name: String(values.name) });
      setDashboards((prev) => [...prev, created]);
      setActiveId(created.id);
      setCreateOpen(false);
      form.resetFields();
    } catch (error) {
      // A rejected validation never reaches the form when called from a modal footer.
      if (error instanceof Error) void message.error(error.message);
    }
  }, [form, message]);

  const openRename = useCallback(() => {
    if (!active) return;
    renameForm.setFieldsValue({ name: active.name });
    setRenameOpen(true);
  }, [active, renameForm]);

  const submitRename = useCallback(async () => {
    if (!active) return;
    try {
      const values = await renameForm.validateFields();
      const updated = await api.updateDashboard(active.id, { name: String(values.name) });
      setDashboards((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setRenameOpen(false);
    } catch (error) {
      if (error instanceof Error) void message.error(error.message);
    }
  }, [active, message, renameForm]);

  // The cards are ordered by `position`; a move rewrites the whole sequence with contiguous indexes
  // so boards whose dashlets all share position 0 (created before positions were sent) settle into
  // a stable order after the first drag or arrow click.
  const persistOrder = useCallback(
    async (ordered: DashboardRow['dashlets']) => {
      if (!active) return;
      const before = new Map(active.dashlets.map((dashlet) => [dashlet.id, dashlet.position]));
      const positioned = ordered.map((dashlet, index) => ({ ...dashlet, position: index }));
      setDashboards((prev) => prev.map((item) => (item.id === active.id ? { ...item, dashlets: positioned } : item)));
      const changed = positioned.filter((dashlet) => before.get(dashlet.id) !== dashlet.position);
      if (changed.length === 0) return;
      try {
        await Promise.all(changed.map((dashlet) => api.updateDashlet(active.id, dashlet.id, { position: dashlet.position })));
      } catch (error) {
        await load();
        void message.error(error instanceof Error ? error.message : t('web.dashboards.reorderFailed'));
      }
    },
    [active, load, message],
  );

  const moveDashlet = useCallback(
    (dashletId: string, delta: number) => {
      if (!active) return;
      const order = [...active.dashlets];
      const from = order.findIndex((dashlet) => dashlet.id === dashletId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= order.length) return;
      const [moved] = order.splice(from, 1);
      if (!moved) return;
      order.splice(to, 0, moved);
      void persistOrder(order);
    },
    [active, persistOrder],
  );

  /**
   * Pointer-driven drag: a clone of the card follows the cursor while its original slot is shown
   * as an empty drop zone in the order the tile would land in. HTML5 drag is not used because the
   * browser would drag only the small grip and give no control over the drop area.
   */
  const beginDashletDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, dashletId: string) => {
      if (!active || !canEdit || event.button !== 0) return;
      const card = event.currentTarget.closest<HTMLElement>('.carocrm-dashlet');
      if (!card) return;
      const sourceCard = card;
      const boardDashlets = active.dashlets;
      const rect = sourceCard.getBoundingClientRect();
      const baseOrder = boardDashlets.map((dashlet) => dashlet.id);
      const heightsAtStart = { ...heightsRef.current };
      const columnsAtStart = columnCount;
      const session: DashletDrag = {
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        height: rect.height,
        ghost: null,
        started: false,
      };
      event.preventDefault();

      const placeGhost = (x: number, y: number): void => {
        if (!session.ghost) return;
        session.ghost.style.transform = `translate3d(${x - session.offsetX}px, ${y - session.offsetY}px, 0)`;
      };

      function finish(commit: boolean): void {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        document.body.classList.remove('carocrm-reordering');
        session.ghost?.remove();
        const order = previewRef.current;
        previewRef.current = null;
        finishDragRef.current = null;
        setDrag(null);
        setPreviewOrder(null);
        if (!commit || !order) return;
        const byId = new Map(boardDashlets.map((dashlet) => [dashlet.id, dashlet]));
        const ordered = order.flatMap((id) => {
          const dashlet = byId.get(id);
          return dashlet ? [dashlet] : [];
        });
        void persistOrder(ordered);
      }

      function onMove(moveEvent: PointerEvent): void {
        if (!session.started) {
          if (Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY) < 4) return;
          session.started = true;
          document.body.classList.add('carocrm-reordering');
          const ghost = sourceCard.cloneNode(true) as HTMLElement;
          ghost.classList.add('carocrm-dash-drag-ghost');
          ghost.removeAttribute('data-dashlet-id');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.style.pointerEvents = 'none';
          ghost.style.position = 'fixed';
          ghost.style.left = '0';
          ghost.style.top = '0';
          ghost.style.width = `${rect.width}px`;
          ghost.style.height = `${session.height}px`;
          document.body.appendChild(ghost);
          session.ghost = ghost;
          previewRef.current = baseOrder;
          setPreviewOrder(baseOrder);
          setDrag({ id: dashletId, height: session.height });
        }
        moveEvent.preventDefault();
        placeGhost(moveEvent.clientX, moveEvent.clientY);
        const grid = gridRef.current?.getBoundingClientRect();
        if (!grid) return;
        const current = previewRef.current ?? baseOrder;
        const next = chooseInsertionOrder(
          baseOrder,
          dashletId,
          session.height,
          { x: moveEvent.clientX, y: moveEvent.clientY },
          { left: grid.left, top: grid.top, width: grid.width },
          heightsAtStart,
          columnsAtStart,
        );
        if (next.join('\u0000') !== current.join('\u0000')) {
          previewRef.current = next;
          setPreviewOrder(next);
        }
      }

      function onUp(): void {
        finish(session.started);
      }

      function onCancel(): void {
        finish(false);
      }

      function onKey(keyEvent: KeyboardEvent): void {
        if (keyEvent.key === 'Escape') finish(false);
      }

      finishDragRef.current = () => finish(false);
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
    },
    [active, canEdit, columnCount, persistOrder],
  );

  const submitDashlet = useCallback(async () => {
    if (!active) return;
    try {
      const values = await dashletForm.validateFields();
      const kind = String(values.kind);
      // The Project Task dashlet is configured by its own options, not by an entity + filter pair
      // (PLAN_Phase_19_Projects.md §4.16).
      const config =
        kind === 'projectTasks'
          ? {
              entity: 'ProjectTask',
              nextDays: Number(values.nextDays ?? 14),
              includeOwned: values.includeOwned === true,
              includeCollaboration: values.includeCollaboration === true,
              excludeAssigned: values.excludeAssigned === true,
              includeCompleted: values.includeCompleted === true,
              groupTypes: Array.isArray(values.groupTypes) ? values.groupTypes : [],
              maxSize: Number(values.maxSize ?? 20),
            }
          : kind === 'esignature'
            ? { view: String(values.esignatureView ?? 'status'), days: Number(values.reportDays ?? 30) }
            : {
                entity: String(values.entity),
                maxSize: 25,
                ...(typeof values.groupBy === 'string' && values.groupBy !== '' ? { groupBy: values.groupBy } : {}),
                ...(typeof values.measure === 'string' && values.measure !== '' ? { measure: values.measure } : {}),
              };
      const created = await api.createDashlet(active.id, { name: String(values.name), kind, position: active.dashlets.length, config });
      await load();
      setDashletOpen(false);
      dashletForm.resetFields();
      const ran = await api.runDashlet(active.id, created.id);
      setResults((prev) => ({ ...prev, [created.id]: ran }));
    } catch (error) {
      if (error instanceof Error) void message.error(error.message);
    }
  }, [active, dashletForm, load, message]);

  const removeDashboard = useCallback(async () => {
    if (!active) return;
    try {
      await api.deleteDashboard(active.id);
      // A default that points at a deleted dashboard would be dead weight on every device.
      if (defaultDashboard.value === active.id) defaultDashboard.save(null);
      setResults({});
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.dashboards.deleteFailed'));
    }
  }, [active, defaultDashboard, load, message]);

  const removeDashlet = useCallback(
    async (dashletId: string) => {
      if (!active) return;
      try {
        await api.deleteDashlet(active.id, dashletId);
        await load();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.dashboards.deleteDashletFailed'));
      }
    },
    [active, load, message],
  );

  return (
    <div className="carocrm-page">
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.dashboards.title')}</h1>
          <p className="carocrm-page-sub">{t('web.dashboards.subtitle')}</p>
        </div>
        <Space size={8} wrap>
          {dashboards.length > 0 ? (
            <Select
              className="carocrm-dash-select"
              value={activeId ?? null}
              onChange={(value: string) => {
                chosenManually.current = true;
                setActiveId(value);
              }}
              options={dashboards.map((item) => ({ value: item.id, label: `${item.name} (${item.dashlets.length})` }))}
              placeholder={t('web.dashboards.pick')}
              aria-label={t('web.dashboards.pick')}
              showSearch
              optionFilterProp="label"
              suffixIcon={<AppstoreOutlined />}
            />
          ) : null}
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
            {t('core.common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('web.dashboards.new')}
          </Button>
        </Space>
      </div>

      {active ? (
        <div className="carocrm-dash-actions">
          <Button size="small" icon={<PlusOutlined />} onClick={() => setDashletOpen(true)}>
            {t('web.dashboards.addDashlet')}
          </Button>
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={openRename}>
              {t('web.dashboards.rename')}
            </Button>
          ) : null}
          <Tooltip title={defaultDashboard.value === active.id ? t('web.dashboards.isDefault') : t('web.dashboards.makeDefault')}>
            <Button
              size="small"
              type={defaultDashboard.value === active.id ? 'primary' : 'default'}
              icon={defaultDashboard.value === active.id ? <StarFilled /> : <StarOutlined />}
              aria-label={t('web.dashboards.defaultAria', { name: active.name })}
              aria-pressed={defaultDashboard.value === active.id}
              onClick={() => defaultDashboard.save(defaultDashboard.value === active.id ? null : active.id)}
            >
              {defaultDashboard.value === active.id ? t('web.dashboards.isDefault') : t('web.dashboards.makeDefault')}
            </Button>
          </Tooltip>
          <Popconfirm
            title={t('web.dashboards.deleteConfirm', { name: active.name })}
            onConfirm={() => void removeDashboard()}
            okText={t('web.common.delete')}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              {t('web.dashboards.deleteDashboard')}
            </Button>
          </Popconfirm>
        </div>
      ) : null}

      {active ? (
        active.dashlets.length === 0 ? (
          <div className="carocrm-dash-empty">
            <DashboardOutlined />
            <strong>{t('web.dashboards.noDashlets')}</strong>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDashletOpen(true)}>
              {t('web.dashboards.addDashlet')}
            </Button>
          </div>
        ) : (
          <>
            {drag ? (
              <div className="carocrm-dash-drag-hint" role="status">
                <HolderOutlined />
                <span>{t('web.dashboards.dragging', { name: active.dashlets.find((dashlet) => dashlet.id === drag.id)?.name ?? '' })}</span>
              </div>
            ) : null}
            <div className="carocrm-dash-grid" ref={gridRef} style={{ height: layout.height }}>
              {shownDashlets.map((dashlet) => {
                const placement = layout.placements.get(dashlet.id);
                if (!placement) return null;
                const index = orderIndex.get(dashlet.id) ?? 0;
                const style = dashletStyle(placement);
                return drag?.id === dashlet.id ? (
                  <div
                    key={dashlet.id}
                    className="carocrm-dashlet-placeholder"
                    style={{ ...style, height: drag.height }}
                    aria-hidden="true"
                  >
                    <HolderOutlined />
                    <span>{t('web.dashboards.dropHere')}</span>
                  </div>
                ) : (
                  <section
                    key={dashlet.id}
                    className="carocrm-dashlet"
                    style={style}
                    aria-label={dashlet.name}
                    data-dashlet-id={dashlet.id}
                  >
                    <header className="carocrm-dashlet-head">
                      {canEdit ? (
                        <span
                          className="carocrm-dashlet-grip"
                          title={t('web.dashboards.dragHint')}
                          aria-hidden="true"
                          onPointerDown={(event) => beginDashletDrag(event, dashlet.id)}
                        >
                          <HolderOutlined />
                        </span>
                      ) : null}
                      <span className="carocrm-dashlet-icon" aria-hidden="true">
                        {DASHLET_ICONS[dashlet.kind] ?? <DashboardOutlined />}
                      </span>
                      <div className="carocrm-dashlet-heading">
                        <span className="carocrm-dashlet-title">{dashlet.name}</span>
                        <span className="carocrm-dashlet-kind">{dashletKindLabel(dashlet.kind)}</span>
                      </div>
                      <div className="carocrm-dashlet-actions">
                        {canEdit ? (
                          <>
                            <Tooltip title={t('web.dashboards.moveEarlier')}>
                              <Button
                                size="small"
                                type="text"
                                icon={<ArrowLeftOutlined />}
                                aria-label={t('web.dashboards.moveEarlier')}
                                disabled={index === 0}
                                onClick={() => moveDashlet(dashlet.id, -1)}
                              />
                            </Tooltip>
                            <Tooltip title={t('web.dashboards.moveLater')}>
                              <Button
                                size="small"
                                type="text"
                                icon={<ArrowRightOutlined />}
                                aria-label={t('web.dashboards.moveLater')}
                                disabled={index === shownDashlets.length - 1}
                                onClick={() => moveDashlet(dashlet.id, 1)}
                              />
                            </Tooltip>
                          </>
                        ) : null}
                        <Tooltip title={t('web.common.run')}>
                          <Button size="small" type="text" icon={<PlayCircleOutlined />} aria-label={t('web.common.run')} onClick={() => void runOne(dashlet.id)} />
                        </Tooltip>
                        <Popconfirm title={t('web.dashboards.deleteDashletConfirm')} onConfirm={() => void removeDashlet(dashlet.id)} okText={t('web.common.delete')}>
                          <Button size="small" danger type="text" icon={<DeleteOutlined />} aria-label={t('web.dashboards.deleteDashlet')} />
                        </Popconfirm>
                      </div>
                    </header>
                    <div className="carocrm-dashlet-body">
                      <DashletResult dashlet={dashlet} result={results[dashlet.id]} />
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )
      ) : (
        <EmptyState title={t('web.dashboards.empty')} />
      )}

      <Modal
        title={t('web.dashboards.new')}
        open={createOpen}
        onOk={() => void submitDashboard()}
        onCancel={() => setCreateOpen(false)}
        okText={t('web.common.create')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input placeholder={t('web.dashboards.namePlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('web.dashboards.renameTitle')}
        open={renameOpen}
        onOk={() => void submitRename()}
        onCancel={() => setRenameOpen(false)}
        okText={t('web.common.save')}
        forceRender
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input placeholder={t('web.dashboards.namePlaceholder')} autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('web.dashboards.addDashlet')}
        open={dashletOpen}
        onOk={() => void submitDashlet()}
        onCancel={() => setDashletOpen(false)}
        okText={t('web.common.add')}
      >
        <Form form={dashletForm} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label={t('web.dashboards.kindLabel')} rules={[{ required: true }]} initialValue="list">
            <Select
              options={[
                { value: 'list', label: t('web.reports.kindList') },
                { value: 'chart', label: t('web.reports.kindChart') },
                { value: 'kpi', label: t('web.reports.kindKpi') },
                { value: 'projectTasks', label: t('web.dashboards.kindProjectTasks') },
                { value: 'esignature', label: t('web.dashboards.kindESignature') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="entity"
            label={t('web.reports.entityLabel')}
            rules={[{ required: dashletKind !== 'projectTasks' && dashletKind !== 'esignature' }]}
          >
            <Select
              options={entities}
              showSearch
              optionFilterProp="label"
              disabled={dashletKind === 'projectTasks' || dashletKind === 'esignature'}
            />
          </Form.Item>
          {dashletKind === 'projectTasks' ? (
            <>
              <Form.Item name="nextDays" label={t('web.dashboards.dueWithin')} initialValue={14}>
                <InputNumber min={1} max={365} />
              </Form.Item>
              <Form.Item name="maxSize" label={t('web.dashboards.rows')} initialValue={20}>
                <InputNumber min={1} max={100} />
              </Form.Item>
              <Form.Item name="groupTypes" label={t('web.dashboards.groupTypes')}>
                <Select mode="multiple" options={['Triage', 'Backlog', 'Work', 'Phase', 'Sprint'].map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Space wrap>
                <Form.Item name="includeOwned" valuePropName="checked" initialValue={true}>
                  <Checkbox>{t('web.dashboards.ownedByMe')}</Checkbox>
                </Form.Item>
                <Form.Item name="includeCollaboration" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.sharedWithMe')}</Checkbox>
                </Form.Item>
                <Form.Item name="excludeAssigned" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.excludeAssigned')}</Checkbox>
                </Form.Item>
                <Form.Item name="includeCompleted" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.includeCompleted')}</Checkbox>
                </Form.Item>
              </Space>
            </>
          ) : null}
          {dashletKind === 'esignature' ? (
            <>
              <Form.Item name="esignatureView" label={t('web.dashboards.reportView')} initialValue="status">
                <Select
                  options={['status', 'rates', 'approvals', 'waiting', 'completionTime', 'exceptions', 'volume'].map((value) => ({
                    value,
                    label: t(`esignature.reportViews.${value}`),
                  }))}
                />
              </Form.Item>
              <Form.Item name="reportDays" label={t('web.dashboards.reportWindow')} initialValue={30}>
                <Select
                  options={[
                    { value: 30, label: t('web.dashboards.windowDays', { days: 30 }) },
                    { value: 90, label: t('web.dashboards.windowDays', { days: 90 }) },
                    { value: 365, label: t('web.dashboards.windowDays', { days: 365 }) },
                    { value: 0, label: t('web.dashboards.windowAll') },
                  ]}
                />
              </Form.Item>
            </>
          ) : null}
          {dashletKind === 'esignature' ? null : (
            <>
              <Form.Item name="groupBy" label={t('web.dashboards.groupByLabel')}>
                <Input placeholder={t('web.dashboards.groupByPlaceholder')} />
              </Form.Item>
              <Form.Item name="measure" label={t('web.dashboards.measureLabel')}>
                <Input placeholder={t('web.dashboards.measurePlaceholder')} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
