import { AppstoreOutlined, DeleteOutlined, DownloadOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Dropdown, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Typography } from 'antd';
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, type SavedFilterRow, type WhereClause } from '../api/client.js';
import type { RowActions } from '../api/types.js';
import { BulkEditModal } from '../components/BulkEditModal.js';
import { ColumnManager } from '../components/ColumnManager.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { FieldValue, linkLabelsOf } from '../components/fields.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { t } from '../state/i18n.js';
import { boardGroupFields, type FieldEntry, fieldLabel, filterEntries, layoutPanelsFor, listEntries, massUpdateEntries, orderByLayout, useEntity, useMetadata } from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
import { usePreference } from '../state/preferences.js';
import { useSession } from '../state/session.js';
import type { FilterDraft } from '../types/views.js';

function operatorOptions(): { value: string; label: string }[] {
  return [
    { value: 'contains', label: t('web.list.contains') },
    { value: 'equals', label: t('web.list.equals') },
    { value: 'notEquals', label: t('web.list.notEquals') },
    { value: 'greaterThan', label: t('web.list.greaterThan') },
    { value: 'lessThan', label: t('web.list.lessThan') },
    { value: 'isNull', label: t('web.list.isNull') },
    { value: 'isNotNull', label: t('web.list.isNotNull') },
  ];
}

/** One reversible bulk write. `rows` are the records as they were before it, id included. */
interface BulkUndo {
  kind: 'delete' | 'update';
  ids: string[];
  rows: Record<string, unknown>[];
  keys: string[];
}

/** The previous values an undo has to write back, in the shape `/massUpdate` takes. */
function pickValues(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of keys) values[key] = row[key] ?? null;
  return values;
}

export function EntityListPage() {
  usePageDocs('user/lists-and-views');
  const { entity: entityName } = useParams<{ entity: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message, modal } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entityName);

  // §20.12: URL-encoded list state — filter/sort/page survive reload and share via link.
  const urlOffset = Number(searchParams.get('offset') ?? '0');
  const urlOrderBy = searchParams.get('orderBy') ?? undefined;
  const urlPageSize = Number(searchParams.get('pageSize') ?? '20');
  const urlWhereRaw = searchParams.get('where');
  const urlTextQuery = searchParams.get('q') ?? '';

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(urlOffset);
  const [inboxView, setInboxView] = useState<string>('all');
  const [pageSize, setPageSize] = useState(urlPageSize || 20);
  // §20.10: row density and page size are the user's, kept server-side — they follow the account to
  // the next device instead of living in this browser's localStorage.
  const density = usePreference<'comfortable' | 'compact'>('density');
  const pageSizePreference = usePreference<number>('listPageSize');
  useEffect(() => {
    if (typeof pageSizePreference.value === 'number') setPageSize(pageSizePreference.value);
  }, [pageSizePreference.value]);
  const [orderBy, setOrderBy] = useState<string | undefined>(urlOrderBy);
  const [selected, setSelected] = useState<string[]>([]);
  // §20.12/§5.3: one undo entry per bulk write. `rows` is the page's copy of the records *before*
  // the write, which is all an undo needs because a selection is page-scoped.
  const [undoStack, setUndoStack] = useState<BulkUndo[]>([]);
  const [showUndo, setShowUndo] = useState(false);
  // The bulk editor: `update` writes one field, `assign` sets the owner. Both take the ids they act on,
  // so the floating bar and a row's kebab menu open the same editor.
  const [bulk, setBulk] = useState<{ mode: 'update' | 'assign'; ids: string[] } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actions, setActions] = useState<RowActions | null>(null);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // §20.11: a 403 from the list endpoint is a wall, not an error to retry — the page then renders
  // the permission card instead of an empty grid with a red line under it.
  const [denied, setDenied] = useState(false);
  // §5.3: live per-column pixel widths while a header drag is in flight.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selectingAll, setSelectingAll] = useState(false);
  const [textQuery, setTextQuery] = useState(urlTextQuery);
  const [savedFilters, setSavedFilters] = useState<SavedFilterRow[]>([]);
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [filterNameOpen, setFilterNameOpen] = useState(false);
  const [filterNameDraft, setFilterNameDraft] = useState('');

  // Parse where from URL on mount
  useEffect(() => {
    if (urlWhereRaw) {
      try {
        const parsed = JSON.parse(urlWhereRaw) as FilterDraft[];
        if (Array.isArray(parsed) && parsed.every((d) => typeof d.field === 'string' && typeof d.operator === 'string')) {
          setDrafts(parsed);
        }
      } catch {
        // ignore malformed where
      }
    }
  }, [urlWhereRaw]);

  // Sync URL when list state changes (debounced to avoid thrashing)
  useEffect(() => {
    if (!entityName) return;
    const params = new URLSearchParams(searchParams);
    if (offset > 0) params.set('offset', String(offset)); else params.delete('offset');
    if (orderBy) params.set('orderBy', orderBy); else params.delete('orderBy');
    if (pageSize !== 20) params.set('pageSize', String(pageSize)); else params.delete('pageSize');
    if (textQuery.trim()) params.set('q', textQuery.trim()); else params.delete('q');
    if (drafts.length > 0) params.set('where', JSON.stringify(drafts)); else params.delete('where');
    setSearchParams(params, { replace: true });
  }, [offset, orderBy, pageSize, textQuery, drafts, entityName, searchParams, setSearchParams]);

  // PLAN §8: a 'list' layout only reorders the columns; without one the field order is unchanged.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'list'), [definition.data]);
  const columns = useMemo(() => orderByLayout(listEntries(definition.data), panels), [definition.data, panels]);
  const filterable = useMemo(() => filterEntries(definition.data), [definition.data]);
  // §20.12: user-chosen columns per entity, persisted server-side via /Preferences/columns.
  // This hook must stay above the loading/error early returns below — a hook that only runs once
  // the metadata has arrived changes the hook order between renders and React tears the page down.
  const columnPref = usePreference<Record<string, string[]>>('columns');
  // §5.3: the dragged widths are persisted per user per entity, so the layout follows the account.
  const widthPref = usePreference<Record<string, Record<string, number>>>('columnWidths');
  useEffect(() => {
    setWidths(entityName ? (widthPref.value?.[entityName] ?? {}) : {});
  }, [widthPref.value, entityName]);
  // §5.3: the stored list is both the visible set and its order — the column manager writes it.
  const visibleColumns = useMemo(() => {
    if (!entityName) return columns;
    const saved = columnPref.value?.[entityName];
    if (!saved || saved.length === 0) return columns;
    const byName = new Map(columns.map((entry) => [entry.name, entry]));
    return saved
      .map((name) => byName.get(name))
      .filter((entry): entry is FieldEntry => entry !== undefined);
  }, [columns, columnPref.value, entityName]);

  // §5.3: which row actions this caller may see. The server decides, because a role's ACL never
  // travels to the browser. While it answers (or if it fails) only Open is offered — a menu entry
  // that can only end in a 403 is worse than one that appears a moment later.
  useEffect(() => {
    if (!entityName) return;
    let active = true;
    setActions(null);
    api
      .rowActions(entityName)
      .then((next) => {
        if (active) setActions(next);
      })
      .catch(() => {
        if (active) setActions(null);
      });
    return () => {
      active = false;
    };
  }, [entityName]);

  const bulkFields = useMemo(() => massUpdateEntries(definition.data), [definition.data]);
  // Assign writes the entity's own owner field; an entity without one (`assignedUserId`) has no
  // assignment to offer, and the server says so too.
  const assignFields = useMemo(() => {
    const owner = definition.data?.fields['assignedUserId'];
    return owner === undefined ? [] : [{ name: 'assignedUserId', field: owner }];
  }, [definition.data]);

  const caseInboxViews = useMemo(() => ([
    { key: 'all', label: t('web.serviceDesk.inbox.all'), drafts: [] as FilterDraft[] },
    { key: 'unassigned', label: t('web.serviceDesk.inbox.unassigned'), drafts: [{ field: 'assignedUserId', operator: 'isNull' }] },
    { key: 'mine', label: t('web.serviceDesk.inbox.mine'), drafts: principal?.id ? [{ field: 'assignedUserId', operator: 'equals', value: principal.id }] : [] },
    { key: 'waitingCustomer', label: t('web.serviceDesk.inbox.waitingCustomer'), drafts: [{ field: 'status', operator: 'equals', value: 'Pending Customer' }] },
    { key: 'breached', label: t('web.serviceDesk.inbox.breached'), drafts: [{ field: 'slaState', operator: 'equals', value: 'Breached' }] },
    { key: 'escalated', label: t('web.serviceDesk.inbox.escalated'), drafts: [{ field: 'isEscalated', operator: 'equals', value: true }] },
  ]), [principal?.id]);

  useEffect(() => {
    if (entityName !== 'Case') return;
    const view = caseInboxViews.find((v) => v.key === inboxView);
    if (!view) return;
    setDrafts(view.drafts);
    setOffset(0);
  }, [inboxView, entityName, caseInboxViews]);

  const emailInboxViews = useMemo(() => ([
    { key: 'all', label: t('web.email.inbox.all'), drafts: [] as FilterDraft[] },
    { key: 'inbox', label: t('web.email.inbox.inbox'), drafts: [{ field: 'direction', operator: 'equals', value: 'Inbound' }] },
    { key: 'outbound', label: t('web.email.inbox.outbound'), drafts: [{ field: 'direction', operator: 'equals', value: 'Outbound' }] },
    { key: 'drafts', label: t('web.email.inbox.drafts'), drafts: [{ field: 'status', operator: 'equals', value: 'Draft' }] },
    { key: 'sent', label: t('web.email.inbox.sent'), drafts: [{ field: 'status', operator: 'equals', value: 'Sent' }] },
    { key: 'queued', label: t('web.email.inbox.queued'), drafts: [{ field: 'status', operator: 'equals', value: 'Queued' }] },
    { key: 'failed', label: t('web.email.inbox.failed'), drafts: [{ field: 'status', operator: 'equals', value: 'Failed' }] },
  ]), []);

  useEffect(() => {
    if (entityName !== 'Email') return;
    const view = emailInboxViews.find((v) => v.key === inboxView);
    if (!view) return;
    setDrafts(view.drafts);
    setOffset(0);
  }, [inboxView, entityName, emailInboxViews]);

  useEffect(() => {
    const views =
      entityName === 'Case' ? caseInboxViews
      : entityName === 'Email' ? emailInboxViews
      : [{ key: 'all' }];
    if (!views.some((view) => view.key === inboxView)) {
      setInboxView('all');
    }
  }, [entityName, inboxView, caseInboxViews, emailInboxViews]);

  // Clicking through pages faster than the network answers means several list requests are in
  // flight at once and they do not necessarily come back in order. Only the newest one may write
  // to the grid, otherwise page 3 lands after page 5 and the table shows the wrong rows.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!entityName) return;      const seq = ++loadSeq.current;
      setLoading(true);
      setDenied(false);
    try {
      const where: WhereClause = drafts
        .filter((draft) => draft.field && draft.operator && (draft.operator === 'isNull' || draft.operator === 'isNotNull' || String(draft.value ?? '') !== ''))
        .map((draft) => ({
          field: draft.field,
          operator: draft.operator,
          ...(draft.operator === 'isNull' || draft.operator === 'isNotNull' ? {} : { value: draft.value }),
        }));
      // Phase 12: free-text `q` rides the /Search/:entity path so pg_trgm accelerates it.
      const trimmed = textQuery.trim();
      const result =
        trimmed !== ''
          ? await api.entitySearch(entityName, { q: trimmed, where, orderBy, offset, maxSize: pageSize })
          : await api.list(entityName, { where, orderBy, offset, maxSize: pageSize });
      if (seq !== loadSeq.current) return;
      setRows(result.list);
      setTotal(result.total ?? result.list.length);
      setLoadError(null);
    } catch (error) {
      if (seq !== loadSeq.current) return;
      // A throttled page is transient — it is not a reason to empty a grid the user is reading.
      if (error instanceof ApiError && error.status === 403) {
        // §20.11: the caller may not read this list at all — show the permission card, not a retry.
        setDenied(true);
        setRows([]);
        setTotal(0);
        setLoadError(null);
      } else if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        void message.warning(error.message);
      } else {
        setLoadError(error instanceof Error ? error.message : t('web.edit.notFound'));
        setRows([]);
        setTotal(0);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [entityName, drafts, textQuery, orderBy, offset, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * §5.3: "select all N matching" — the header checkbox can only see one page, so covering the
   * whole filtered result means walking the pages and collecting ids. The walk is bounded at 1 000
   * so a mis-filtered ten-thousand-row list cannot lock the tab, and the cap is reported rather
   * than silently applied.
   */
  const selectAllMatching = useCallback(async () => {
    if (!entityName) return;
    setSelectingAll(true);
    try {
      const where: WhereClause = drafts
        .filter((draft) => draft.field && draft.operator && (draft.operator === 'isNull' || draft.operator === 'isNotNull' || String(draft.value ?? '') !== ''))
        .map((draft) => ({
          field: draft.field,
          operator: draft.operator,
          ...(draft.operator === 'isNull' || draft.operator === 'isNotNull' ? {} : { value: draft.value }),
        }));
      const trimmed = textQuery.trim();
      const cap = Math.min(total, 1000);
      const ids: string[] = [];
      for (let next = 0; next < cap; next += 100) {
        const page =
          trimmed !== ''
            ? await api.entitySearch(entityName, { q: trimmed, where, orderBy, offset: next, maxSize: 100 })
            : await api.list(entityName, { where, orderBy, offset: next, maxSize: 100 });
        for (const row of page.list) ids.push(String(row['id']));
        if (page.list.length < 100) break;
      }
      setSelected(ids);
      if (total > 1000) void message.warning(t('web.list.selectAllCapped', { count: 1000 }));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.selectAllFailed'));
    } finally {
      setSelectingAll(false);
    }
  }, [entityName, drafts, textQuery, orderBy, total, message]);

  /**
   * §5.3: drag a header's right edge to resize its column. The live width stays in state while the
   * pointer moves; on release it is written to the per-entity `columnWidths` preference.
   */
  const beginResize = useCallback(
    (name: string, event: ReactMouseEvent) => {
      const th = (event.currentTarget as HTMLElement).closest('th');
      if (!th || !entityName) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = Math.round(th.getBoundingClientRect().width);
      let latest = startWidth;
      const onMove = (moveEvent: MouseEvent): void => {
        latest = Math.max(48, Math.min(960, Math.round(startWidth + moveEvent.clientX - startX)));
        setWidths((prev) => ({ ...prev, [name]: latest }));
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const current = { ...(widthPref.value ?? {}) };
        current[entityName] = { ...(current[entityName] ?? {}), [name]: latest };
        widthPref.save(current);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [entityName, widthPref],
  );

  useEffect(() => {
    if (!entityName) return;
    setDrafts([]);
    setTextQuery('');
    setActiveFilterId(null);
    setOffset(0);
    void api
      .savedFilters(entityName)
      .then(setSavedFilters)
      .catch(() => setSavedFilters([]));
  }, [entityName]);

  const applySavedFilter = useCallback(
    async (filter: SavedFilterRow | null) => {
      setActiveFilterId(filter?.id ?? null);
      if (!filter) {
        setDrafts([]);
        setOffset(0);
        return;
      }
      // Translate stored criteria back into editable drafts where possible.
      const next: FilterDraft[] = [];
      for (const clause of filter.criteria) {
        if (typeof clause !== 'object' || clause === null || Array.isArray(clause)) continue;
        const record = clause as Record<string, unknown>;
        if (typeof record['field'] === 'string' && typeof record['operator'] === 'string') {
          next.push({ field: record['field'], operator: record['operator'], value: record['value'] });
        }
      }
      setDrafts(next);
      setOffset(0);
    },
    [],
  );

  const saveCurrentFilter = useCallback(async () => {
    if (!entityName) return;
    const name = filterNameDraft.trim();
    if (name === '') return;
    const where: WhereClause = drafts
      .filter((draft) => draft.field && draft.operator)
      .map((draft) => ({ field: draft.field, operator: draft.operator, value: draft.value }));
    try {
      const created = await api.createSavedFilter({ name, entityType: entityName, criteria: where, visibility: 'private' });
      setSavedFilters((prev) => [...prev, created]);
      setActiveFilterId(created.id);
      setFilterNameOpen(false);
      setFilterNameDraft('');
      void message.success(t('web.list.saved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.saveFailed'));
    }
  }, [drafts, entityName, filterNameDraft, message]);

  const runImport = useCallback(async () => {
    if (!entityName || importText.trim() === '') return;
    setImportBusy(true);
    try {
      const result = await api.importCsv(entityName, importText);
      void message.success(t('web.list.imported', { created: result.created, updated: result.updated, skipped: result.skipped }));
      if (result.errors.length > 0) {
        void message.warning(t('web.list.importFirstError', { row: result.errors[0]?.row ?? '', message: result.errors[0]?.message ?? '' }));
      }
      setImportOpen(false);
      setImportText('');
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.importFailed'));
    } finally {
      setImportBusy(false);
    }
  }, [entityName, importText, load, message]);

  const runExport = useCallback(async () => {
    if (!entityName) return;
    const where: WhereClause = drafts
      .filter((draft) => draft.field && draft.operator && String(draft.value ?? '') !== '')
      .map((draft) => ({ field: draft.field, operator: draft.operator, value: draft.value }));
    try {
      const token = window.localStorage.getItem('carocrm.accessToken');
      const params = new URLSearchParams();
      if (where.length > 0) params.set('where', JSON.stringify(where));
      const response = await fetch(`/api/v1/${encodeURIComponent(entityName)}/action/export?${params.toString()}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(t('web.list.exportFailed'));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${entityName}-export.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      void message.success(t('web.list.exportDownloaded'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.exportFailed'));
    }
  }, [drafts, entityName, message]);

  /**
   * §5.3: a bulk write reports **outcomes**, not an intention — how many records changed and how many
   * were left alone because the caller may not touch them (`massUpdate`/`massDelete` skip those and
   * still return what they did write).
   */
  const reportOutcome = useCallback(
    (changed: number, requested: number) => {
      const skipped = Math.max(0, requested - changed);
      const text = t('web.list.bulkOutcome', { changed, skipped });
      if (skipped > 0) void message.warning(text);
      else void message.success(text);
    },
    [message],
  );

  // §20.12/§5.3: bulk delete with undo. The rows themselves are kept because deleting can only be
  // undone by recreating them.
  const bulkDelete = useCallback(async (ids: string[]) => {
    if (!entityName || ids.length === 0) return;
    const before = rows.filter((row) => ids.includes(String(row['id'])));
    try {
      const result = await api.massDelete(entityName, ids);
      setUndoStack((prev) => [...prev.slice(-4), { kind: 'delete', ids: result.ids, rows: before, keys: [] }]);
      setShowUndo(true);
      setSelected((prev) => prev.filter((id) => !result.ids.includes(id)));
      reportOutcome(result.count, ids.length);
      void load();
      setTimeout(() => setShowUndo(false), 8000);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.deleteFailed'));
    }
  }, [entityName, rows, load, message, reportOutcome]);

  /** Bulk field update / assign (§5.3). The previous values are snapshotted for the undo. */
  const bulkWrite = useCallback(async (values: Record<string, unknown>) => {
    if (!entityName || bulk === null) return;
    const ids = bulk.ids;
    const keys = Object.keys(values);
    const before = rows.filter((row) => ids.includes(String(row['id'])));
    setBulkBusy(true);
    try {
      const result = await api.massUpdate(entityName, ids, values);
      setUndoStack((prev) => [...prev.slice(-4), { kind: 'update', ids: result.ids, rows: before, keys }]);
      setShowUndo(true);
      setBulk(null);
      setSelected((prev) => prev.filter((id) => !result.ids.includes(id)));
      reportOutcome(result.count, ids.length);
      await load();
      setTimeout(() => setShowUndo(false), 8000);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.bulkFailed'));
    } finally {
      setBulkBusy(false);
    }
  }, [bulk, entityName, rows, load, message, reportOutcome]);

  const undoLastAction = useCallback(async () => {
    if (undoStack.length === 0 || !entityName) return;
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    try {
      if (last.kind === 'delete') {
        for (const record of last.rows) {
          await api.create(entityName, record);
        }
      } else {
        // Group the records that shared a previous value, so undoing a fifty-record write is a few
        // requests rather than fifty — and it goes back through the same audited `/massUpdate`.
        const groups = new Map<string, { values: Record<string, unknown>; ids: string[] }>();
        for (const row of last.rows) {
          const id = String(row['id']);
          if (!last.ids.includes(id)) continue;
          const values = pickValues(row, last.keys);
          const key = JSON.stringify(values);
          const group = groups.get(key) ?? { values, ids: [] };
          group.ids.push(id);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          await api.massUpdate(entityName, group.ids, group.values);
        }
      }
      setUndoStack((prev) => prev.slice(0, -1));
      setShowUndo(false);
      void load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.undoFailed'));
    }
  }, [undoStack, entityName, load, message]);

  /** §5.3: the column manager writes the ordered visible set for this entity, or clears it. */
  const saveColumns = useCallback((next: string[] | null) => {
    if (!entityName) return;
    const current = { ...(columnPref.value ?? {}) };
    if (next === null || next.length === 0) delete current[entityName];
    else current[entityName] = next;
    columnPref.save(current);
  }, [columnPref, entityName]);

  /** §5.3 row action: follow a record from the list without opening it. */
  const followRecord = useCallback(async (id: string) => {
    if (!entityName) return;
    try {
      await api.follow(entityName, id);
      void message.success(t('web.list.followed'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.followFailed'));
    }
  }, [entityName, message]);

  /** §5.3 row action: delete through the same bulk path, so one record is just as undoable. */
  const confirmDeleteRecord = useCallback((id: string) => {
    if (!entityName) return;
    modal.confirm({
      title: t('web.list.deleteThisRecord'),
      okText: t('web.list.confirmDelete'),
      okButtonProps: { danger: true },
      onOk: () => bulkDelete([id]),
    });
  }, [entityName, modal, bulkDelete]);

  if (metadata.isError || definition.isError) {
    return <ErrorState message={t('web.list.notAvailable', { entity: entityName ?? '' })} />;
  }

  if (metadata.isLoading || definition.isLoading) {
    return <LoadingSkeleton rows={8} />;
  }

  const displayField = definition.data?.record?.displayField ?? 'name';
  // The board groups by an enum field, so an entity without one has no board to switch to.
  const canBoard = boardGroupFields(definition.data).length > 0;

  return (
    <Card className="carocrm-card carocrm-list-card">
      <div className="carocrm-list-head">
        <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>
          {definition.data?.label ?? entityName}
        </Typography.Title>
        <Space wrap>
          {canBoard ? (
            <Button icon={<AppstoreOutlined />} onClick={() => navigate(`${base}/${entityName}/board`)}>
              {t('web.board.viewBoard')}
            </Button>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t('web.list.refresh')}
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => void runExport()}>
            {t('web.list.exportCsv')}
          </Button>
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
            {t('web.list.importCsv')}
          </Button>
          <Button icon={<AppstoreOutlined />} onClick={() => setColumnsOpen(true)}>
            {t('web.list.columns')}
          </Button>
          <Popconfirm
            title={t('web.list.deleteConfirm', { count: selected.length })}
            disabled={selected.length === 0}
            onConfirm={() => void bulkDelete(selected)}
          >
            <Button danger icon={<DeleteOutlined />} disabled={selected.length === 0} aria-label={t('web.list.deleteSelected')}>
              {t('web.list.deleteSelected')}
            </Button>
          </Popconfirm>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`${base}/${entityName}/create`)}
          >
            {t('web.list.create')}
          </Button>
        </Space>
      </div>

      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input prefix={<SearchOutlined />} placeholder={t('web.list.textSearch')} value={textQuery} onChange={(event) => setTextQuery(event.target.value)} onPressEnter={() => { setOffset(0); void load(); }} allowClear />
        <Button type="primary" onClick={() => { setOffset(0); void load(); }}>
          {t('web.list.search')}
        </Button>
      </Space.Compact>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ minWidth: 220 }}
          placeholder={t('web.list.savedFilters')}
          allowClear
          value={activeFilterId}
          options={savedFilters.map((filter) => ({ value: filter.id, label: `${filter.name}${filter.isShared ? ` ${t('web.list.shared')}` : ''}` }))}
          onChange={(value) => void applySavedFilter(savedFilters.find((filter) => filter.id === value) ?? null)}
        />
        <Button onClick={() => setFilterNameOpen(true)}>{t('web.list.saveCurrentFilters')}</Button>
        <Select
          style={{ minWidth: 150 }}
          aria-label={t('web.list.densityAria')}
          value={density.value ?? 'comfortable'}
          options={[
            { value: 'comfortable', label: t('web.list.densityComfortable') },
            { value: 'compact', label: t('web.list.densityCompact') },
          ]}
          onChange={(next) => density.save(next)}
        />
      </Space>

      {filterable.length > 0 ? (
        <div className="carocrm-filter" aria-label={t('web.list.filtersAria')}>
          <Row gutter={[12, 12]}>
            {filterable.slice(0, 5).map((entry) => (
              <Col key={entry.name} xs={24} sm={12} lg={8} xl={6}>
                <Typography.Text className="carocrm-filter-label">
                  {fieldLabel(entry.name, entry.field, metadata.data)}
                </Typography.Text>
                <Space.Compact block>
                  <Select
                    style={{ width: '46%' }}
                    placeholder={t('web.list.operator')}
                    value={drafts.find((d) => d.field === entry.name)?.operator}
                    options={operatorOptions()}
                    onChange={(operator) => {
                      setDrafts((current) => {
                        const rest = current.filter((d) => d.field !== entry.name);
                        return operator ? [...rest, { field: entry.name, operator, value: undefined }] : rest;
                      });
                    }}
                  />
                  <Input
                    style={{ width: '54%' }}
                    placeholder={t('web.list.value')}
                    value={String(drafts.find((d) => d.field === entry.name)?.value ?? '')}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((current) =>
                        current.some((d) => d.field === entry.name)
                          ? current.map((d) => (d.field === entry.name ? { ...d, value } : d))
                          : [...current, { field: entry.name, operator: 'contains', value }],
                      );
                    }}
                  />
                </Space.Compact>
              </Col>
            ))}
          </Row>
          <div className="carocrm-filter-actions">
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setOffset(0); void load(); }}>
              {t('web.list.apply')}
            </Button>
            <Button onClick={() => { setDrafts([]); setOffset(0); }}>{t('web.list.clear')}</Button>
          </div>
        </div>
      ) : null}

      {entityName === 'Case' ? (
        <Tabs activeKey={inboxView} onChange={setInboxView} items={caseInboxViews.map((v) => ({ key: v.key, label: v.label }))} style={{ marginBottom: 12 }} />
      ) : null}

      {entityName === 'Email' ? (
        <Tabs activeKey={inboxView} onChange={setInboxView} items={emailInboxViews.map((v) => ({ key: v.key, label: v.label }))} style={{ marginBottom: 12 }} />
      ) : null}

      {denied ? (
        <div style={{ marginBottom: 16 }}>
          <PermissionDenied />
        </div>
      ) : loadError !== null ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorState message={loadError} onRetry={() => void load()} />
        </div>
      ) : null}

      {rows.length === 0 && !loading && !denied ? (
        <div style={{ marginBottom: 16 }}>
          <EmptyState title={t('web.list.emptyTitle')} description={t('web.list.emptyHint')} />
        </div>
      ) : null}

      {(rows.length > 0 || loading) && !denied ? (
        <Table
        rowKey={(row) => String(row['id'])}
        loading={loading}
        dataSource={rows}
        // §5.3: the header stays put while the page scrolls; the identifier column stays put while the
        // table scrolls sideways. Rows themselves are server-paginated, so there is nothing to
        // virtualize below.
        sticky
        scroll={{ x: 'max-content' }}
        {...(density.value === 'compact' ? { size: 'small' as const } : {})}
        pagination={{
          current: Math.floor(offset / pageSize) + 1,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (page, size) => {
            setPageSize(size);
            setOffset((page - 1) * size);
            if (size !== pageSize) pageSizePreference.save(size);
          },
        }}
        columns={[
          ...visibleColumns.map((entry) => ({
            title: (
              <span className="carocrm-col-title">
                {fieldLabel(entry.name, entry.field, metadata.data)}
                <span
                  className="carocrm-col-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('web.list.columnResizeAria', { column: fieldLabel(entry.name, entry.field, metadata.data) })}
                  onMouseDown={(event) => beginResize(entry.name, event)}
                />
              </span>
            ),
            dataIndex: entry.name,
            sorter: entry.field.sortable !== false,
            width: widths[entry.name] ?? (entry.name === displayField ? 220 : undefined),
            ...(entry.name === displayField ? { fixed: 'left' as const } : {}),
            render: (_: unknown, row: Record<string, unknown>) =>
              entry.name === displayField ? (
                <Link className="carocrm-row-link" to={`${base}/${entityName}/${String(row['id'])}`}>
                  {String(row[entry.name] ?? '')}
                </Link>
              ) : (
                <FieldValue
                  field={entry.field}
                  value={row[entry.name]}
                  variant="inline"
                  fieldName={entry.name}
                  linkLabels={linkLabelsOf(row)}
                />
              ),
          })),          {
            title: t('core.common.action'),
            key: 'actions',
            width: 64,
            render: (_: unknown, row: Record<string, unknown>) => {
              const id = String(row['id']);
              // While the catalog is in flight (or if it failed) only Open is offered.
              const can = actions ?? { open: true, edit: false, assign: false, follow: false, delete: false };
              const items: { key: string; label: string; danger?: boolean }[] = [
                { key: 'open', label: t('web.list.rowOpen') },
              ];
              if (can.edit) items.push({ key: 'edit', label: t('web.list.editRecord') });
              if (can.assign) items.push({ key: 'assign', label: t('web.list.rowAssign') });
              if (can.follow) items.push({ key: 'follow', label: t('web.list.rowFollow') });
              if (can.delete) items.push({ key: 'delete', label: t('web.list.deleteRecord'), danger: true });
              const route = `${base}/${entityName}/${id}`;
              return (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items,
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation();
                      if (key === 'open') navigate(route);
                      else if (key === 'edit') navigate(`${route}/edit`);
                      else if (key === 'assign') setBulk({ mode: 'assign', ids: [id] });
                      else if (key === 'follow') void followRecord(id);
                      else if (key === 'delete') confirmDeleteRecord(id);
                    },
                  }}
                >
                  <Button
                    size="small"
                    type="text"
                    icon={<MoreOutlined />}
                    aria-label={t('web.list.rowActionsAria', { name: String(row[displayField] ?? id) })}
                  />
                </Dropdown>
              );
            },
          },
        ]}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
        }}
        locale={loadError ? { emptyText: <Typography.Text type="danger">{loadError}</Typography.Text> } : {}}
        onChange={(_pagination, _filters, sorter) => {
          const single = Array.isArray(sorter) ? sorter[0] : sorter;
          const field = single?.field;
          if (!field || !single?.order) {
            setOrderBy(undefined);
            return;
          }
          setOrderBy(`${String(field)},${single.order === 'ascend' ? 'asc' : 'desc'}`);
        }}
      />
      ) : null}

      {/* §20.12/§5.3: floating bulk action bar. Each action is shown only when the server says the
          caller may perform it, so the bar never offers a write that can only be refused. */}
      {selected.length > 0 ? (
        <div className="carocrm-bulk-bar" role="toolbar" aria-label={t('web.list.bulkActionsAria')} style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: '#fff', border: '1px solid #e6e9ef', borderRadius: 8, padding: '10px 20px', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Typography.Text strong aria-live="polite">{t('web.list.selectedCount', { count: selected.length })}</Typography.Text>
          {rows.length > 0 && total > rows.length && selected.length === rows.length ? (
            <Button size="small" loading={selectingAll} onClick={() => void selectAllMatching()}>
              {t('web.list.selectAllMatching', { count: total })}
            </Button>
          ) : null}
          {actions?.edit === true ? (
            <Button size="small" onClick={() => setBulk({ mode: 'update', ids: [...selected] })}>{t('web.list.bulkEdit')}</Button>
          ) : null}
          {actions?.assign === true ? (
            <Button size="small" onClick={() => setBulk({ mode: 'assign', ids: [...selected] })}>{t('web.list.bulkAssign')}</Button>
          ) : null}
          {actions?.delete === true ? (
            <Popconfirm title={t('web.list.deleteConfirm', { count: selected.length })} okText={t('web.common.delete')} okButtonProps={{ danger: true }} onConfirm={() => void bulkDelete(selected)}>
              <Button danger size="small">{t('web.list.deleteSelected')}</Button>
            </Popconfirm>
          ) : null}
          <Button size="small" onClick={() => setSelected([])}>{t('core.common.cancel')}</Button>
        </div>
      ) : null}

      {/* §20.12: undo toast */}
      {showUndo && undoStack.length > 0 ? (
        <div style={{ position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 101, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8, padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Typography.Text>{t('web.list.undoAvailable')}</Typography.Text>
          <Button size="small" onClick={() => void undoLastAction()}>{t('web.list.undo')}</Button>
        </div>
      ) : null}

      <Modal title={t('web.list.importTitle', { entity: entityName ?? '' })} open={importOpen} onOk={() => void runImport()} onCancel={() => setImportOpen(false)} okText={t('web.list.import')} confirmLoading={importBusy}>
        <Typography.Paragraph type="secondary">{t('web.list.importHint')}</Typography.Paragraph>
        <Input.TextArea rows={8} placeholder={'name,website\nAcme,https://acme.example'} value={importText} onChange={(event) => setImportText(event.target.value)} />
      </Modal>
      <ColumnManager
        open={columnsOpen}
        columns={columns}
        visible={visibleColumns.map((entry) => entry.name)}
        onClose={() => setColumnsOpen(false)}
        onChange={saveColumns}
      />
      <BulkEditModal
        open={bulk !== null}
        mode={bulk?.mode ?? 'update'}
        fields={bulk?.mode === 'assign' ? assignFields : bulkFields}
        busy={bulkBusy}
        onClose={() => setBulk(null)}
        onSubmit={(values) => void bulkWrite(values)}
      />
      <Modal
        title={t('web.list.saveFiltersTitle')}
        open={filterNameOpen}
        onOk={() => void saveCurrentFilter()}
        onCancel={() => setFilterNameOpen(false)}
        okText={t('web.edit.save')}
        okButtonProps={{ disabled: filterNameDraft.trim() === '' }}
      >
        <Typography.Paragraph type="secondary">
          {t('web.list.saveFiltersHint', { count: drafts.length })}
        </Typography.Paragraph>
        <Input
          autoFocus
          placeholder={t('web.list.filterName')}
          value={filterNameDraft}
          onChange={(event) => setFilterNameDraft(event.target.value)}
          onPressEnter={() => void saveCurrentFilter()}
        />
      </Modal>
    </Card>
  );
}
