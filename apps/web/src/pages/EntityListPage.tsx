import { AppstoreOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type SavedFilterRow, type WhereClause } from '../api/client.js';
import { FieldValue } from '../components/fields.js';
import { t } from '../state/i18n.js';
import { boardGroupFields, fieldLabel, filterEntries, layoutPanelsFor, listEntries, orderByLayout, useEntity, useMetadata } from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
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
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entityName);

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [inboxView, setInboxView] = useState<string>('all');
  const [pageSize, setPageSize] = useState(20);
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [textQuery, setTextQuery] = useState('');
  const [savedFilters, setSavedFilters] = useState<SavedFilterRow[]>([]);
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [filterNameOpen, setFilterNameOpen] = useState(false);
  const [filterNameDraft, setFilterNameDraft] = useState('');

  // PLAN §8: a 'list' layout only reorders the columns; without one the field order is unchanged.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'list'), [definition.data]);
  const columns = useMemo(() => orderByLayout(listEntries(definition.data), panels), [definition.data, panels]);
  const filterable = useMemo(() => filterEntries(definition.data), [definition.data]);

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

  if (metadata.isError || definition.isError) {
    return <Card>{t('web.list.notAvailable', { entity: entityName ?? '' })}</Card>;
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

      <Table
        rowKey={(row) => String(row['id'])}
        loading={loading}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: Math.floor(offset / pageSize) + 1,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (page, size) => {
            setPageSize(size);
            setOffset((page - 1) * size);
          },
        }}
        columns={[
          ...columns.map((entry) => ({
            title: fieldLabel(entry.name, entry.field, metadata.data),
            dataIndex: entry.name,
            sorter: entry.field.sortable !== false,
            render: (_: unknown, row: Record<string, unknown>) =>
              entry.name === displayField ? (
                <Link className="carocrm-row-link" to={`${base}/${entityName}/${String(row['id'])}`}>
                  {String(row[entry.name] ?? '')}
                </Link>
              ) : (
                <FieldValue field={entry.field} value={row[entry.name]} />
              ),
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
