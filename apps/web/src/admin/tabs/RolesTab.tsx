import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { Role } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';
import { ACL_ACTIONS, ACL_LEVELS, type AclAction, type AclLevel,errorMessage, errorRule } from './identity.js';

type EntityPermissions = Record<string, Partial<Record<AclAction, AclLevel>>>;
type FieldPermissions = Record<string, Record<string, Partial<Record<'read' | 'edit', AclLevel>>>>;

const ROLE_PAGE_SIZE = 20;

/**
 * Roles tab (PLAN_Phase_20_Settings_UX.md §4.3 row 11): role CRUD plus the entity and field permission
 * matrix, written straight to `/Role` — the same document `AclApiService` evaluates, so there is no
 * second copy of the truth.
 *
 * The list pages on the server because `GET /Role` has no name filter: fetching a fixed window and
 * hoping it covers the instance would hide roles the administrator can see no other way.
 *
 * A cell left on "not stated" is removed from the JSON rather than stored as `no`: an absent permission
 * is what the platform means by "this role says nothing about that entity", and it keeps the role
 * document readable.
 */
export function RolesTab() {
  const { message } = AntApp.useApp();
  const [offset, setOffset] = useState(0);
  const roles = useQuery({
    queryKey: ['identity', 'roles', { offset }],
    queryFn: () => api.roles({ offset, maxSize: ROLE_PAGE_SIZE }),
    staleTime: 30_000,
  });
  /** `undefined` closes the editor, `null` opens it to create, a row opens it to edit. */
  const [editing, setEditing] = useState<Role | null | undefined>(undefined);

  const reload = () => void roles.refetch();

  const remove = async (role: Role) => {
    try {
      await api.deleteRole(role.id);
      void message.success(t('web.adminRoles.deleted', { name: role.name }));
      reload();
    } catch (error) {
      void message.error(errorRule(error) === 'roleInUse' ? t('web.adminRoles.inUse') : errorMessage(error, t('web.adminRoles.deleteFailed')));
    }
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminRoles.title')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={roles.isFetching} onClick={reload}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
              {t('web.adminRoles.new')}
            </Button>
          </Space>
        }
      >
        <Table<Role>
          rowKey="id"
          size="small"
          loading={roles.isLoading}
          dataSource={roles.data?.list ?? []}
          locale={{ emptyText: t('web.adminRoles.empty') }}
          pagination={{
            current: Math.floor(offset / ROLE_PAGE_SIZE) + 1,
            pageSize: ROLE_PAGE_SIZE,
            total: roles.data?.total ?? 0,
            showSizeChanger: false,
            onChange: (page) => setOffset((page - 1) * ROLE_PAGE_SIZE),
          }}
          columns={[
            {
              title: t('web.common.name'),
              dataIndex: 'name',
              render: (value: string, row) => (
                <Space size={6}>
                  <Typography.Text strong>{value}</Typography.Text>
                  {row.id === 'sysAdmin' ? <Tag className="carocrm-admin-tag">{t('web.adminUsers.builtIn')}</Tag> : null}
                </Space>
              ),
            },
            {
              title: t('web.adminRoles.entityRules'),
              key: 'entities',
              width: 130,
              render: (_: unknown, row) => String(Object.keys(row.permissions ?? {}).length),
            },
            {
              title: t('web.adminRoles.fieldRules'),
              key: 'fields',
              width: 130,
              render: (_: unknown, row) => String(Object.values(row.fieldPermissions ?? {}).reduce((total, entity) => total + Object.keys(entity ?? {}).length, 0)),
            },
            {
              title: '',
              key: 'actions',
              width: 180,
              render: (_: unknown, row) => (
                <Space size={4}>
                  <Button size="small" onClick={() => setEditing(row)}>
                    {t('web.common.edit')}
                  </Button>
                  <Popconfirm
                    title={t('web.adminRoles.deleteConfirm', { name: row.name })}
                    description={t('web.adminRoles.deleteHint')}
                    okText={t('web.common.delete')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(row)}
                  >
                    <Button size="small" danger>
                      {t('web.common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {t('web.adminRoles.additiveNote')} · {t('web.adminRoles.portalNote')}
        </Typography.Text>
      </Card>
      {editing !== undefined ? <RoleEditorModal role={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); reload(); }} /> : null}
    </div>
  );
}

function RoleEditorModal({ role, onClose, onSaved }: { readonly role: Role | null; readonly onClose: () => void; readonly onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const roleId = role?.id ?? null;

  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<EntityPermissions>(() => cloneEntity(role?.permissions));
  const [fieldPermissions, setFieldPermissions] = useState<FieldPermissions>(() => cloneField(role?.fieldPermissions));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const entities = useMemo(
    () =>
      Object.values(metadata.data ?? {})
        .filter((entity) => entity.isEntity && entity.client?.web !== false)
        .sort((left, right) => left.label.localeCompare(right.label)),
    [metadata.data],
  );

  const setEntity = (entity: string, action: AclAction, level: AclLevel) =>
    setPermissions((previous) => {
      const row = { ...(previous[entity] ?? {}), [action]: level };
      const kept: Partial<Record<AclAction, AclLevel>> = {};
      for (const candidate of ACL_ACTIONS) if (row[candidate] !== undefined && row[candidate] !== 'no') kept[candidate] = row[candidate];
      const next = { ...previous };
      if (Object.keys(kept).length === 0) delete next[entity];
      else next[entity] = kept;
      return next;
    });

  const setField = (entity: string, field: string, action: 'read' | 'edit', level: AclLevel) =>
    setFieldPermissions((previous) => {
      const fields = { ...(previous[entity] ?? {}) };
      const row = { ...(fields[field] ?? {}), [action]: level };
      const kept: Partial<Record<'read' | 'edit', AclLevel>> = {};
      if (row.read !== undefined && row.read !== 'no') kept.read = row.read;
      if (row.edit !== undefined && row.edit !== 'no') kept.edit = row.edit;
      if (Object.keys(kept).length === 0) delete fields[field];
      else fields[field] = kept;
      const next = { ...previous };
      if (Object.keys(fields).length === 0) delete next[entity];
      else next[entity] = fields;
      return next;
    });

  const submit = async () => {
    if (name.trim() === '') {
      setFailed(t('web.adminRoles.nameRequired'));
      return;
    }
    setSaving(true);
    setFailed(null);
    try {
      const input = { name: name.trim(), permissions: toWire(permissions), fieldPermissions: toWireFields(fieldPermissions) };
      if (roleId === null) await api.createRole(input);
      else await api.patchRole(roleId, input);
      void message.success(t(roleId === null ? 'web.adminRoles.created' : 'web.adminRoles.updated', { name: name.trim() }));
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminRoles.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={900}
      className="carocrm-admin-role-modal"
      title={roleId === null ? t('web.adminRoles.createTitle') : t('web.adminRoles.editTitle', { name: role?.name ?? '' })}
      okText={t('web.common.save')}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnHidden
    >
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('web.adminRoles.matrixHint')} />
      <Form layout="vertical">
        <Form.Item label={t('web.common.name')} required>
          <Input maxLength={150} value={name} onChange={(event) => setName(event.target.value)} />
        </Form.Item>
      </Form>
      <Table
        size="small"
        rowKey="name"
        scroll={{ x: 'max-content' }}
        loading={metadata.isLoading}
        dataSource={entities}
        pagination={{ pageSize: 8, showSizeChanger: false }}
        expandable={{
          expandedRowRender: (entity) => (
            <div className="carocrm-admin-field-matrix">
              <div className="carocrm-admin-field-row">
                <Typography.Text className="carocrm-admin-field-name" type="secondary">
                  {t('web.adminRoles.fieldColumn')}
                </Typography.Text>
                <Space size={6}>
                  <Typography.Text type="secondary" className="carocrm-admin-level-select">
                    {t('web.adminRoles.action.read')}
                  </Typography.Text>
                  <Typography.Text type="secondary" className="carocrm-admin-level-select">
                    {t('web.adminRoles.action.edit')}
                  </Typography.Text>
                </Space>
              </div>
              {Object.entries(entity.fields)
                .filter(([, field]) => field.type !== 'disabled')
                .map(([fieldName, field]) => (
                  <div className="carocrm-admin-field-row" key={fieldName}>
                    <Typography.Text className="carocrm-admin-field-name">{field.label ?? fieldName}</Typography.Text>
                    <Space size={6}>
                      <Select
                        size="small"
                        className="carocrm-admin-level-select"
                        aria-label={t('web.adminRoles.fieldReadAria', { entity: entity.label, field: fieldName })}
                        value={fieldPermissions[entity.name]?.[fieldName]?.read ?? 'no'}
                        onChange={(value: AclLevel) => setField(entity.name, fieldName, 'read', value)}
                        options={levelOptions()}
                      />
                      <Select
                        size="small"
                        className="carocrm-admin-level-select"
                        aria-label={t('web.adminRoles.fieldEditAria', { entity: entity.label, field: fieldName })}
                        value={fieldPermissions[entity.name]?.[fieldName]?.edit ?? 'no'}
                        onChange={(value: AclLevel) => setField(entity.name, fieldName, 'edit', value)}
                        options={levelOptions()}
                      />
                    </Space>
                  </div>
                ))}
            </div>
          ),
          rowExpandable: (entity) => Object.keys(entity.fields).length > 0,
        }}
        columns={[
          { title: t('web.adminTeams.entity'), dataIndex: 'label' },
          ...ACL_ACTIONS.map((action) => ({
            title: t(`web.adminRoles.action.${action}`),
            key: action,
            width: 108,
            render: (_: unknown, entity: { name: string; label: string }) => (
              <Select
                size="small"
                className="carocrm-admin-level-select"
                aria-label={t('web.adminRoles.cellAria', { entity: entity.label, action })}
                value={permissions[entity.name]?.[action] ?? 'no'}
                onChange={(value: AclLevel) => setEntity(entity.name, action, value)}
                options={levelOptions()}
              />
            ),
          })),
        ]}
      />
    </Modal>
  );
}

/** Built per render: the catalog is loaded after this lazy chunk is first imported. */
function levelOptions(): { value: AclLevel; label: string }[] {
  return ACL_LEVELS.map((level) => ({ value: level, label: t(`web.adminRoles.level.${level}`) }));
}

/** Only stated levels go on the wire — a `no` in the JSON would say something the matrix does not mean. */
function toWire(permissions: EntityPermissions): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [entity, actions] of Object.entries(permissions)) {
    const row: Record<string, string> = {};
    for (const [action, level] of Object.entries(actions)) if (level !== undefined && level !== 'no') row[action] = level;
    if (Object.keys(row).length > 0) out[entity] = row;
  }
  return out;
}

function toWireFields(fieldPermissions: FieldPermissions): Record<string, Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, Record<string, string>>> = {};
  for (const [entity, fields] of Object.entries(fieldPermissions)) {
    const entityOut: Record<string, Record<string, string>> = {};
    for (const [field, actions] of Object.entries(fields)) {
      const row: Record<string, string> = {};
      for (const [action, level] of Object.entries(actions)) if (level !== undefined && level !== 'no') row[action] = level;
      if (Object.keys(row).length > 0) entityOut[field] = row;
    }
    if (Object.keys(entityOut).length > 0) out[entity] = entityOut;
  }
  return out;
}

function cloneEntity(source: Record<string, Record<string, string>> | undefined): EntityPermissions {
  const out: EntityPermissions = {};
  for (const [entity, actions] of Object.entries(source ?? {})) {
    const row: Partial<Record<AclAction, AclLevel>> = {};
    for (const [action, level] of Object.entries(actions)) if (isLevel(level)) row[action as AclAction] = level;
    out[entity] = row;
  }
  return out;
}

function cloneField(source: Record<string, Record<string, Record<string, string>>> | undefined): FieldPermissions {
  const out: FieldPermissions = {};
  for (const [entity, fields] of Object.entries(source ?? {})) {
    const entityOut: Record<string, Partial<Record<'read' | 'edit', AclLevel>>> = {};
    for (const [field, actions] of Object.entries(fields)) {
      const row: Partial<Record<'read' | 'edit', AclLevel>> = {};
      for (const [action, level] of Object.entries(actions)) if (isLevel(level)) row[action as 'read' | 'edit'] = level;
      entityOut[field] = row;
    }
    out[entity] = entityOut;
  }
  return out;
}

function isLevel(value: unknown): value is AclLevel {
  return value === 'no' || value === 'own' || value === 'team' || value === 'all' || value === 'yes';
}
