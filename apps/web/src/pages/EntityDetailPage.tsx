import { DeleteOutlined, DisconnectOutlined,EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Popconfirm, Select, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { FieldValue, useLinkOptions } from '../components/fields.js';
import { StreamPanel } from '../components/StreamPanel.js';
import { evaluateEntityLogic } from '../state/logic.js';
import { detailEntries, fieldLabel, recordLabel, useEntity, useMetadata } from '../state/metadata.js';

interface PanelProps {
  parent: string;
  parentId: string;
  name: string;
  targetDefinition: EntityDefinition | undefined;
}

/** One relationship panel (PLAN §20 relationship panels) with link/unlink actions. */
function RelationPanel({ parent, parentId, name, targetDefinition }: PanelProps) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const targetName = targetDefinition?.name;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const linkOptions = useLinkOptions(targetName, term);

  const load = useCallback(async () => {
    if (!targetName) return;
    setLoading(true);
    try {
      const related = await api.related(parent, parentId, name, { maxSize: 50, total: false });
      setRows(related.list);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [parent, parentId, name, targetName]);

  const linkedIds = useMemo(() => new Set(rows.map((row) => String(row['id']))), [rows]);
  const candidates = linkOptions.filter((option) => !linkedIds.has(option.value));

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      className="lizant-card"
      size="small"
      title={<Typography.Text strong>{fieldLabel(name)}</Typography.Text>}
      extra={
        <Space.Compact>
          <Select
            size="small"
            style={{ width: 220 }}
            placeholder="link existing"
            showSearch
            filterOption={false}
            onSearch={setTerm}
            value={selected}
            onChange={(value) => { setSelected(value); setTerm(''); }}
            options={candidates}
          />
          <Button
            size="small"
            icon={<LinkOutlined />}
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              try {
                await api.link(parent, parentId, name, selected);
                setSelected(undefined);
                void message.success('Linked.');
                await load();
              } catch (error) {
                void message.error(error instanceof Error ? error.message : 'Link failed.');
              }
            }}
          >
            Link
          </Button>
          {targetName ? (
            <Button size="small" icon={<PlusOutlined />} onClick={() => navigate(`/${targetName}/create`)}>
              New
            </Button>
          ) : null}
        </Space.Compact>
      }
    >
      <Table
        rowKey={(row) => String(row['id'])}
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: targetDefinition?.label ?? name,
            dataIndex: 'name',
            render: (_: unknown, row: Record<string, unknown>) => (
              <Link to={`/${targetName ?? ''}/${String(row['id'])}`}>{recordLabel(row, targetDefinition)}</Link>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 60,
            render: (_: unknown, row: Record<string, unknown>) => (
              <Popconfirm
                title="Unlink this record?"
                onConfirm={async () => {
                  try {
                    await api.unlink(parent, parentId, name, String(row['id']));
                    await load();
                  } catch (error) {
                    void message.error(error instanceof Error ? error.message : 'Unlink failed.');
                  }
                }}
              >
                <Button size="small" type="text" icon={<DisconnectOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  );
}

export function EntityDetailPage() {
  const { entity, id } = useParams<{ entity: string; id: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entity);
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!entity || !id) return;
    setLoading(true);
    try {
      setRecord(await api.get(entity, id));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Record not found.');
      setRecord(undefined);
    } finally {
      setLoading(false);
    }
  }, [entity, id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const logic = useMemo(
    () => evaluateEntityLogic(definition.data, record ?? {}),
    [definition.data, record],
  );
  const entries = useMemo(
    () => detailEntries(definition.data).filter((entry) => logic.fields[entry.name]?.visible !== false),
    [definition.data, logic],
  );
  const relations = useMemo(() => Object.keys(definition.data?.relations ?? {}), [definition.data]);

  if (!entity || !id) return <Card>Missing route parameters.</Card>;

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Card
          className="lizant-card"
          title={
            <Space>
              <Typography.Text strong>{definition.data?.label ?? entity}</Typography.Text>
              <Typography.Text type="secondary">{recordLabel(record, definition.data)}</Typography.Text>
            </Space>
          }
          extra={
            <Space>
              <Button icon={<EditOutlined />} type="primary" onClick={() => navigate(`/${entity}/${id}/edit`)}>
                Edit
              </Button>
              <Popconfirm
                title="Delete this record?"
                onConfirm={async () => {
                  try {
                    await api.remove(entity, id);
                    void message.success('Deleted.');
                    navigate(`/${entity}`);
                  } catch (error) {
                    void message.error(error instanceof Error ? error.message : 'Delete failed.');
                  }
                }}
              >
                <Button danger icon={<DeleteOutlined />}>
                  Delete
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          <Descriptions
            column={2}
            colon={false}
            labelStyle={{ width: 200, color: '#737b85', fontWeight: 400, paddingBlock: 10 }}
            contentStyle={{ paddingBlock: 10, paddingInlineEnd: 24 }}
            items={entries.map((entry) => ({
              key: entry.name,
              label: fieldLabel(entry.name, entry.field, metadata.data),
              children: <FieldValue field={entry.field} value={record?.[entry.name]} />,
            }))}
          />
        </Card>

        {relations.map((relation) => (
          <RelationPanel
            key={relation}
            parent={entity}
            parentId={id}
            name={relation}
            targetDefinition={metadata.data?.[definition.data?.relations[relation]?.target ?? ''] ?? undefined}
          />
        ))}

        <StreamPanel entity={entity} id={id} definition={definition.data} canPost />
      </Space>
    </Spin>
  );
}
