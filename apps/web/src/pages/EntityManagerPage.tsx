import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, Modal, Space, Switch, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { useMetadata } from '../state/metadata.js';

/**
 * Entity Manager index (PLAN §8): the list of every entity definition in the workspace.
 *
 * Picking an entity opens its own editor page rather than expanding an inline form here, so one
 * screen always answers one question — "which entity?" here, "what is it made of?" there.
 */
export function EntityManagerPage() {
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [entityForm] = Form.useForm<{ name: string; label: string }>();

  const entities = useMemo(() => Object.values(metadata.data ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [metadata.data]);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return entities;
    return entities.filter((entity) => `${entity.name} ${entity.label}`.toLowerCase().includes(needle));
  }, [entities, filter]);

  const setEnabled = async (entity: EntityDefinition, enabled: boolean) => {
    try {
      await api.patchEntity(entity.name, { isEntity: enabled });
      void message.success('Entity updated.');
      await metadata.refetch();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Metadata change failed.');
    }
  };

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">Entity Manager</h1>
          <p className="lizant-page-sub">Every entity definition in this workspace. Pick one to edit its fields, logic, relations, layout and access.</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={metadata.isFetching} onClick={() => void metadata.refetch()}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            New entity
          </Button>
        </Space>
      </div>

      <Card className="lizant-card" title="Entities" extra={<Typography.Text type="secondary">{`${String(rows.length)} of ${String(entities.length)} entity definition(s)`}</Typography.Text>}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          style={{ marginBottom: 12, maxWidth: 320 }}
          placeholder="Filter by name or label"
          aria-label="Filter entities"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Table
          rowKey="name"
          size="small"
          loading={metadata.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: filter.trim() === '' ? 'No entity definitions yet — create one to get started.' : 'No entity matches this filter.' }}
          onRow={(record) => ({ onClick: () => navigate(`/admin/entity-manager/${record.name}`), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: 'Entity',
              dataIndex: 'name',
              render: (name: string) => (
                <Link className="lizant-row-link" to={`/admin/entity-manager/${name}`} onClick={(event) => event.stopPropagation()}>
                  {name}
                </Link>
              ),
            },
            { title: 'Label', dataIndex: 'label' },
            { title: 'Fields', key: 'fields', width: 90, render: (_: unknown, row: EntityDefinition) => String(Object.keys(row.fields).length) },
            { title: 'Relations', key: 'relations', width: 100, render: (_: unknown, row: EntityDefinition) => String(Object.keys(row.relations).length) },
            {
              title: 'Enabled',
              key: 'enabled',
              width: 100,
              render: (_: unknown, row: EntityDefinition) => (
                <Switch
                  size="small"
                  checked={row.isEntity}
                  aria-label={`${row.isEntity ? 'Disable' : 'Enable'} ${row.name}`}
                  onClick={(_, event) => {
                    event.stopPropagation();
                    void setEnabled(row, !row.isEntity);
                  }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="Create entity"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const values = await entityForm.validateFields();
          try {
            await api.patchEntity(values.name, { label: values.label, fields: { code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true } } });
            void message.success('Entity created.');
            setCreateOpen(false);
            await metadata.refetch();
            navigate(`/admin/entity-manager/${values.name}`);
          } catch (error) {
            void message.error(error instanceof Error ? error.message : 'Create failed.');
          }
        }}
      >
        <Form form={entityForm} layout="vertical">
          <Form.Item name="name" label="Name (PascalCase)" rules={[{ required: true, pattern: /^[A-Z][A-Za-z0-9]{1,49}$/, message: 'Use PascalCase, letters and digits only.' }]}>
            <Input placeholder="Warehouse" />
          </Form.Item>
          <Form.Item name="label" label="Label" rules={[{ required: true }]}>
            <Input placeholder="Warehouse" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
