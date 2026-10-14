import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, Modal, Space, Switch, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { t } from '../state/i18n.js';
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
      void message.success(t('web.entityManager.updated'));
      await metadata.refetch();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.entityManager.changeFailed'));
    }
  };

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">{t('web.entityManager.title')}</h1>
          <p className="lizant-page-sub">{t('web.entityManager.subtitle')}</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={metadata.isFetching} onClick={() => void metadata.refetch()}>
            {t('core.common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('web.entityManager.new')}
          </Button>
        </Space>
      </div>

      <Card className="lizant-card" title={t('web.entityManager.cardTitle')} extra={<Typography.Text type="secondary">{t('web.entityManager.count', { shown: String(rows.length), total: String(entities.length) })}</Typography.Text>}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          style={{ marginBottom: 12, maxWidth: 320 }}
          placeholder={t('web.entityManager.filterPlaceholder')}
          aria-label={t('web.entityManager.filterAria')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Table
          rowKey="name"
          size="small"
          loading={metadata.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: filter.trim() === '' ? t('web.entityManager.empty') : t('web.entityManager.noMatch') }}
          onRow={(record) => ({ onClick: () => navigate(`/admin/entity-manager/${record.name}`), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('web.entityManager.entity'),
              dataIndex: 'name',
              render: (name: string) => (
                <Link className="lizant-row-link" to={`/admin/entity-manager/${name}`} onClick={(event) => event.stopPropagation()}>
                  {name}
                </Link>
              ),
            },
            { title: t('web.entityManager.label'), dataIndex: 'label' },
            { title: t('web.entityManager.fields'), key: 'fields', width: 90, render: (_: unknown, row: EntityDefinition) => String(Object.keys(row.fields).length) },
            { title: t('web.entityManager.relations'), key: 'relations', width: 100, render: (_: unknown, row: EntityDefinition) => String(Object.keys(row.relations).length) },
            {
              title: t('web.entityManager.enabled'),
              key: 'enabled',
              width: 100,
              render: (_: unknown, row: EntityDefinition) => (
                <Switch
                  size="small"
                  checked={row.isEntity}
                  aria-label={t('web.entityManager.toggleAria', { action: row.isEntity ? t('web.entityManager.disable') : t('web.entityManager.enable'), name: row.name })}
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
        title={t('web.entityManager.createTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const values = await entityForm.validateFields();
          try {
            await api.patchEntity(values.name, { label: values.label, fields: { code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true } } });
            void message.success(t('web.entityManager.created'));
            setCreateOpen(false);
            await metadata.refetch();
            navigate(`/admin/entity-manager/${values.name}`);
          } catch (error) {
            void message.error(error instanceof Error ? error.message : t('web.entityManager.createFailed'));
          }
        }}
      >
        <Form form={entityForm} layout="vertical">
          <Form.Item name="name" label={t('web.entityManager.nameLabel')} rules={[{ required: true, pattern: /^[A-Z][A-Za-z0-9]{1,49}$/, message: t('web.entityManager.namePattern') }]}>
            <Input placeholder={t('web.entityManager.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="label" label={t('web.entityManager.label')} rules={[{ required: true }]}>
            <Input placeholder={t('web.entityManager.labelPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
