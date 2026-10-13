import { DeleteOutlined, DisconnectOutlined, EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Popconfirm, Select, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { FieldValue, useLinkOptions } from '../components/fields.js';
import { StreamPanel } from '../components/StreamPanel.js';
import { t } from '../state/i18n.js';
import { evaluateEntityLogic } from '../state/logic.js';
import {
  detailEntries,
  type FieldEntry,
  fieldLabel,
  layoutFieldNames,
  layoutPanelsFor,
  orderByLayout,
  panelFieldNames,
  recordLabel,
  useEntity,
  useMetadata,
} from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
import { useSession } from '../state/session.js';

interface PanelProps {
  parent: string;
  parentId: string;
  name: string;
  targetDefinition: EntityDefinition | undefined;
  /** Route base of the current app: `/portal` for portal users (PLAN §37). */
  base: string;
}

/** One relationship panel (PLAN §20 relationship panels) with link/unlink actions. */
function RelationPanel({ parent, parentId, name, targetDefinition, base }: PanelProps) {
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
            placeholder={t('web.detail.linkExisting')}
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
                void message.success(t('web.detail.linked'));
                await load();
              } catch (error) {
                void message.error(error instanceof Error ? error.message : t('web.detail.linkFailed'));
              }
            }}
          >
            {t('web.detail.link')}
          </Button>
          {targetName ? (
            <Button size="small" icon={<PlusOutlined />} onClick={() => navigate(`${base}/${targetName}/create`)}>
              {t('web.detail.new')}
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
              <Link to={`${base}/${targetName ?? ''}/${String(row['id'])}`}>{recordLabel(row, targetDefinition)}</Link>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 60,          render: (_: unknown, row: Record<string, unknown>) => (
            <Popconfirm
              title={t('web.detail.unlink')}
              onConfirm={async () => {
                  try {
                    await api.unlink(parent, parentId, name, String(row['id']));
                    await load();
                  } catch (error) {
                    void message.error(error instanceof Error ? error.message : t('web.detail.unlinkFailed'));
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
  const { principal } = useSession();
  const base = portalBase(principal?.type);
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
      void message.error(error instanceof Error ? error.message : t('web.detail.notFound'));
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
  // PLAN §8: an entity without a 'detail' layout keeps the single field-ordered Descriptions.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'detail'), [definition.data]);
  const ordered = useMemo(() => orderByLayout(entries, panels), [entries, panels]);
  const covered = useMemo(() => layoutFieldNames(panels), [panels]);
  const others = useMemo(() => ordered.filter((entry) => !covered.has(entry.name)), [ordered, covered]);
  const relations = useMemo(() => Object.keys(definition.data?.relations ?? {}), [definition.data]);

  const labelStyle = { width: 200, color: '#737b85', fontWeight: 400, paddingBlock: 10 };
  const contentStyle = { paddingBlock: 10, paddingInlineEnd: 24 };
  const describe = (list: FieldEntry[]) =>
    list.map((entry) => ({
      key: entry.name,
      label: fieldLabel(entry.name, entry.field, metadata.data),
      children: <FieldValue field={entry.field} value={record?.[entry.name]} />,
    }));

  if (!entity || !id) return <Card>{t('web.detail.missingParams')}</Card>;

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
              <Button icon={<EditOutlined />} type="primary" onClick={() => navigate(`${base}/${entity}/${id}/edit`)}>
                {t('web.detail.edit')}
              </Button>
              <Popconfirm
                title={t('web.detail.deleteThisRecord')}
                onConfirm={async () => {
                  try {
                    await api.remove(entity, id);
                    void message.success(t('web.detail.deleted'));
                    navigate(`${base}/${entity}`);
                  } catch (error) {
                    void message.error(error instanceof Error ? error.message : t('web.detail.deleteFailed'));
                  }
                }}
              >
                <Button danger icon={<DeleteOutlined />}>
                  {t('web.detail.delete')}
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          {panels.length === 0 ? (
            <Descriptions
              column={2}
              colon={false}
              labelStyle={labelStyle}
              contentStyle={contentStyle}
              items={describe(ordered)}
            />
          ) : null}
        </Card>

        {panels.map((panel) => (
          <Card
            key={panel.name}
            className="lizant-card"
            size="small"
            title={<Typography.Text strong>{panel.label ?? panel.name}</Typography.Text>}
          >
            <Descriptions
              column={2}
              colon={false}
              labelStyle={labelStyle}
              contentStyle={contentStyle}
              items={describe(ordered.filter((entry) => panelFieldNames(panel).has(entry.name)))}
            />
          </Card>
        ))}

        {others.length > 0 ? (
          <Card className="lizant-card" size="small" title={<Typography.Text strong>{t('core.common.other')}</Typography.Text>}>
            <Descriptions column={2} colon={false} labelStyle={labelStyle} contentStyle={contentStyle} items={describe(others)} />
          </Card>
        ) : null}

        {relations.map((relation) => (
          <RelationPanel
            key={relation}
            parent={entity}
            parentId={id}
            name={relation}
            base={base}
            targetDefinition={metadata.data?.[definition.data?.relations[relation]?.target ?? ''] ?? undefined}
          />
        ))}

        <StreamPanel entity={entity} id={id} definition={definition.data} canPost />
      </Space>
    </Spin>
  );
}
