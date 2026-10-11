import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Input, Popconfirm, Row, Select, Space, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type WhereClause } from '../api/client.js';
import { FieldValue } from '../components/fields.js';
import { fieldLabel, filterEntries, layoutPanelsFor, listEntries, orderByLayout, useEntity, useMetadata } from '../state/metadata.js';
import type { FilterDraft } from '../types/views.js';

const OPERATORS: { value: string; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'not equals' },
  { value: 'greaterThan', label: 'greater than' },
  { value: 'lessThan', label: 'less than' },
  { value: 'isNull', label: 'is empty' },
  { value: 'isNotNull', label: 'is not empty' },
];

export function EntityListPage() {
  const { entity: entityName } = useParams<{ entity: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entityName);

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // PLAN §8: a 'list' layout only reorders the columns; without one the field order is unchanged.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'list'), [definition.data]);
  const columns = useMemo(() => orderByLayout(listEntries(definition.data), panels), [definition.data, panels]);
  const filterable = useMemo(() => filterEntries(definition.data), [definition.data]);

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
      const result = await api.list(entityName, { where, orderBy, offset, maxSize: pageSize });
      setRows(result.list);
      setTotal(result.total ?? result.list.length);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load records.');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [entityName, drafts, orderBy, offset, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  if (metadata.isError || definition.isError) {
    return <Card>Entity "{entityName}" is not available.</Card>;
  }

  const displayField = definition.data?.record?.displayField ?? 'name';

  return (
    <Card className="lizant-card lizant-list-card">
      <div className="lizant-list-head">
        <Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>
          {definition.data?.label ?? entityName}
        </Typography.Title>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            Refresh
          </Button>
          <Popconfirm
            title={`Delete ${selected.length} selected records?`}
            disabled={selected.length === 0}
            onConfirm={async () => {
              if (!entityName) return;
              try {
                await api.massDelete(entityName, selected);
                void message.success('Deleted.');
                setSelected([]);
                await load();
              } catch (error) {
                void message.error(error instanceof Error ? error.message : 'Delete failed.');
              }
            }}
          >
            <Button danger icon={<DeleteOutlined />} disabled={selected.length === 0} aria-label="Delete selected">
              Delete selected
            </Button>
          </Popconfirm>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`/${entityName}/create`)}
          >
            Create
          </Button>
        </Space>
      </div>

      {filterable.length > 0 ? (
        <div className="lizant-filter" aria-label="Record filters">
          <Row gutter={[12, 12]}>
            {filterable.slice(0, 5).map((entry) => (
              <Col key={entry.name} xs={24} sm={12} lg={8} xl={6}>
                <Typography.Text className="lizant-filter-label">
                  {fieldLabel(entry.name, entry.field, metadata.data)}
                </Typography.Text>
                <Space.Compact block>
                  <Select
                    style={{ width: '46%' }}
                    placeholder="operator"
                    value={drafts.find((d) => d.field === entry.name)?.operator}
                    options={OPERATORS}
                    onChange={(operator) => {
                      setDrafts((current) => {
                        const rest = current.filter((d) => d.field !== entry.name);
                        return operator ? [...rest, { field: entry.name, operator, value: undefined }] : rest;
                      });
                    }}
                  />
                  <Input
                    style={{ width: '54%' }}
                    placeholder="value"
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
          <div className="lizant-filter-actions">
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setOffset(0); void load(); }}>
              Apply
            </Button>
            <Button onClick={() => { setDrafts([]); setOffset(0); }}>Clear</Button>
          </div>
        </div>
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
                <Link className="lizant-row-link" to={`/${entityName}/${String(row['id'])}`}>
                  {String(row[entry.name] ?? '')}
                </Link>
              ) : (
                <FieldValue field={entry.field} value={row[entry.name]} />
              ),
          })),
          {
            title: 'Action',
            key: 'actions',
            width: 100,
            render: (_: unknown, row: Record<string, unknown>) => (
              <Space size={4}>
                <Button
                  size="small"
                  type="text"
                  aria-label="Edit record"
                  icon={<EditOutlined />}
                  onClick={() => navigate(`/${entityName}/${String(row['id'])}/edit`)}
                />
                <Popconfirm
                  title="Delete this record?"
                  okText="Confirm delete"
                  onConfirm={async () => {
                    if (!entityName) return;
                    try {
                      await api.remove(entityName, String(row['id']));
                      void message.success('Deleted.');
                      await load();
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : 'Delete failed.');
                    }
                  }}
                >
                  <Button size="small" type="text" danger aria-label="Delete record" icon={<DeleteOutlined />} />
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
    </Card>
  );
}
