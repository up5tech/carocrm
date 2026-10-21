import { AppstoreOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Dropdown, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, type SavedFilterRow, type WhereClause } from '../api/client.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { FieldValue } from '../components/fields.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { t } from '../state/i18n.js';
import { boardGroupFields, fieldLabel, filterEntries, layoutPanelsFor, listEntries, orderByLayout, useEntity, useMetadata } from '../state/metadata.js';
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

export function EntityListPage() {
  const { entity: entityName } = useParams<{ entity: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
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
  // §20.12: undo stack for reversible bulk actions
  const [undoStack, setUndoStack] = useState<Array<{ action: string; ids: string[]; before: Record<string, unknown>[] }>>([]);
  const [showUndo, setShowUndo] = useState(false);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [textQuery, setTextQuery] = useState(urlTextQuery);
  const [savedFilters, setSavedFilters] = useState<SavedFilterRow[]>([]);
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [filterNameOpen, setFilterNameOpen] = useState(false);
  const [filterNameDraft, setFilterNameDraft] = useState('');
  // §20.12: inline editing — which cell is currently being edited { entityId, fieldName }
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [editError, setEditError] = useState<string | null>(null);

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
  const visibleColumns = useMemo(() => {
    if (!entityName) return columns;
    const saved = columnPref.value?.[entityName];
    if (!saved || saved.length === 0) return columns;
    const savedSet = new Set(saved);
    return columns.filter((entry) => savedSet.has(entry.name));
  }, [columns, columnPref.value, entityName]);

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

  const load = useCallback(async () => {
    if (!entityName) return;
    setLoading(true);
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
      setRows(result.list);
      setTotal(result.total ?? result.list.length);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('web.edit.notFound'));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [entityName, drafts, textQuery, orderBy, offset, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

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

  // §20.12: bulk delete with undo
  const bulkDelete = useCallback(async () => {
    if (!entityName || selected.length === 0) return;
    const before = rows.filter((r) => selected.includes(String(r['id'])));
    try {
      await api.massDelete(entityName, selected);
      setUndoStack((prev) => [...prev.slice(-4), { action: 'delete', ids: [...selected], before }]);
      setShowUndo(true);
      setSelected([]);
      void load();
      setTimeout(() => setShowUndo(false), 8000);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.deleteFailed'));
    }
  }, [entityName, selected, rows, load, message]);

  const undoLastAction = useCallback(async () => {
    if (undoStack.length === 0 || !entityName) return;
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    if (last.action === 'delete') {
      try {
        for (const record of last.before) {
          await api.create(entityName, record as Record<string, unknown>);
        }
        setUndoStack((prev) => prev.slice(0, -1));
        setShowUndo(false);
        void load();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.list.undoFailed'));
      }
    }
  }, [undoStack, entityName, load, message]);

  // §20.12: inline edit save — uses massUpdate for a single record
  const saveInlineEdit = useCallback(async () => {
    if (!editingCell || !entityName) return;
    const field = definition.data?.fields[editingCell.field];
    if (!field) return;
    // Basic type validation before sending
    let value: unknown = editValue;
    if (field.type === 'int' || field.type === 'float') {
      const num = Number(editValue);
      if (isNaN(num)) { setEditError(t('web.list.invalidNumber')); return; }
      value = num;
    }
    try {
      await api.massUpdate(entityName, { ids: [editingCell.id], values: { [editingCell.field]: value } });
      setEditingCell(null);
      setEditError(null);
      void load();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : t('web.list.saveFailed'));
    }
  }, [editingCell, editValue, entityName, definition.data, load, message]);

  const cancelInlineEdit = useCallback(() => {
    setEditingCell(null);
    setEditValue('');
    setEditError(null);
  }, []);

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
        <DocsLink docKey="user/lists-and-views" compact />
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
          <Dropdown
            menu={{
              items: columns.map((entry) => ({
                key: entry.name,
                label: fieldLabel(entry.name, entry.field, metadata.data),
              })),
              selectable: true,
              selectedKeys: visibleColumns.map((c) => c.name),
              onClick: ({ key }: { key: string }) => {
                const added = columns.find((c) => c.name === key);
                if (added === undefined) return;
                const next = visibleColumns.some((c) => c.name === key)
                  ? visibleColumns.filter((c) => c.name !== key)
                  : [...visibleColumns, added];
                if (entityName === undefined) return;
                columnPref.save({ ...(columnPref.value ?? {}), [entityName]: next.map((c) => c.name) });
              },
            }}
            trigger={['click']}
          >
            <Button icon={<AppstoreOutlined />}>{t('web.list.columns')}</Button>
          </Dropdown>
          <Popconfirm
            title={t('web.list.deleteConfirm', { count: selected.length })}
            disabled={selected.length === 0}
            onConfirm={async () => {
              if (!entityName) return;
              try {
                await api.massDelete(entityName, selected);
                void message.success(t('web.list.deleted'));
                setSelected([]);
                await load();
              } catch (error) {
                void message.error(error instanceof Error ? error.message : t('web.list.deleteFailed'));
              }
            }}
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

      {loadError !== null ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorState message={loadError} onRetry={() => void load()} />
        </div>
      ) : null}

      {rows.length === 0 && !loading ? (
        <div style={{ marginBottom: 16 }}>
          <EmptyState title={t('web.list.emptyTitle')} description={t('web.list.emptyHint')} />
        </div>
      ) : null}

      {rows.length > 0 || loading ? (
        <Table
        rowKey={(row) => String(row['id'])}
        loading={loading}
        dataSource={rows}
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
            title: fieldLabel(entry.name, entry.field, metadata.data),
            dataIndex: entry.name,
            sorter: entry.field.sortable !== false,
            render: (_: unknown, row: Record<string, unknown>) => {
              const isEditing = editingCell?.id === String(row['id']) && editingCell?.field === entry.name;
              if (isEditing) {
                return (
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      size="small"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onPressEnter={() => void saveInlineEdit()}
                      {...(editError ? { status: 'error' as const } : {})}
                      autoFocus
                    />
                    <Button size="small" type="primary" onClick={() => void saveInlineEdit()}>{t('web.common.save')}</Button>
                    <Button size="small" onClick={cancelInlineEdit}>{t('core.common.cancel')}</Button>
                  </Space.Compact>
                );
              }
              const canEdit = ['varchar', 'text', 'int', 'float', 'decimal'].includes(entry.field.type);
              return (
                <div
                  role={canEdit ? 'button' : undefined}
                  tabIndex={canEdit ? 0 : undefined}
                  onClick={() => { if (canEdit) { setEditingCell({ id: String(row['id']), field: entry.name }); setEditValue(String(row[entry.name] ?? '')); setEditError(null); }}}
                  onKeyDown={(e) => { if (canEdit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditingCell({ id: String(row['id']), field: entry.name }); setEditValue(String(row[entry.name] ?? '')); setEditError(null); }}}
                  style={canEdit ? { cursor: 'pointer' } : undefined}
                >
                  {entry.name === displayField ? (
                    <Link className="carocrm-row-link" to={`${base}/${entityName}/${String(row['id'])}`}>
                      {String(row[entry.name] ?? '')}
                    </Link>
                  ) : (
                    <FieldValue field={entry.field} value={row[entry.name]} />
                  )}
                  {editError && isEditing ? <Typography.Text type="danger" style={{ fontSize: 11 }}>{editError}</Typography.Text> : null}
                </div>
              );
            },
          })),
          {
            title: t('core.common.action'),
            key: 'actions',
            width: 100,
            render: (_: unknown, row: Record<string, unknown>) => (
              <Space size={4}>
                <Button
                  size="small"
                  type="text"
                  aria-label={t('web.list.editRecord')}
                  icon={<EditOutlined />}
                  onClick={() => navigate(`${base}/${entityName}/${String(row['id'])}/edit`)}
                />
                <Popconfirm
                  title={t('web.list.deleteThisRecord')}
                  okText={t('web.list.confirmDelete')}
                  onConfirm={async () => {
                    if (!entityName) return;
                    try {
                      await api.remove(entityName, String(row['id']));
                      void message.success(t('web.list.deleted'));
                      await load();
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : t('web.list.deleteFailed'));
                    }
                  }}
                >
                  <Button size="small" type="text" danger aria-label={t('web.list.deleteRecord')} icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
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

      {/* §20.12: floating bulk action bar */}
      {selected.length > 0 ? (
        <div className="carocrm-bulk-bar" role="toolbar" aria-label={t('web.list.bulkActionsAria')} style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: '#fff', border: '1px solid #e6e9ef', borderRadius: 8, padding: '10px 20px', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Typography.Text strong aria-live="polite">{selected.length} selected</Typography.Text>
          <Popconfirm title={t('web.list.deleteConfirm', { count: selected.length })} okText={t('web.common.delete')} okButtonProps={{ danger: true }} onConfirm={() => void bulkDelete()}>
            <Button danger size="small">{t('web.list.deleteSelected')}</Button>
          </Popconfirm>
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
