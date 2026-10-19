import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { Role, TeamRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { ACL_ACTIONS, type AclLevel,aclLevel, errorMessage, maxAclLevel, useRolesQuery, useTeamsQuery, useUsersQuery } from './identity.js';

/**
 * Teams tab (PLAN_Phase_20_Settings_UX.md §4.3 row 10): team CRUD, membership and an overview of
 * what the team's roles grant.
 *
 * Membership is written through the team here and through the user in the users tab; both end in the
 * same `users_teams` table, which is what the ACL reads, so the two screens cannot disagree.
 */
export function TeamsTab() {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const teams = useTeamsQuery();
  const roles = useRolesQuery();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [filter, setFilter] = useState('');

  const roleNames = useMemo(() => new Map((roles.data?.list ?? []).map((role) => [role.id, role.name])), [roles.data]);
  const rows = (teams.data?.list ?? []).filter((team) => filter.trim() === '' || team.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const reload = () => void client.invalidateQueries({ queryKey: ['identity', 'teams'] });

  const remove = async (row: TeamRow) => {
    try {
      await api.deleteTeam(row.id);
      void message.success(t('web.adminTeams.deleted', { name: row.name }));
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminTeams.deleteFailed')));
    }
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminTeams.title')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} loading={teams.isFetching} onClick={reload}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
              {t('web.adminTeams.new')}
            </Button>
          </Space>
        }
      >
        <Space wrap size={8} className="carocrm-admin-filters">
          <Input
            allowClear
            className="carocrm-admin-search"
            placeholder={t('web.adminTeams.searchPlaceholder')}
            aria-label={t('web.adminTeams.searchAria')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </Space>
        <Table<TeamRow>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          loading={teams.isLoading}
          dataSource={rows}
          locale={{ emptyText: t('web.adminTeams.empty') }}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            { title: t('web.common.name'), dataIndex: 'name' },
            {
              title: t('web.adminTeams.members'),
              dataIndex: 'userIds',
              width: 110,
              render: (value: string[]) => String(value.length),
            },
            {
              title: t('web.adminTeams.roles'),
              dataIndex: 'roleIds',
              render: (value: string[]) =>
                value.length === 0 ? (
                  <Typography.Text type="secondary">{t('web.adminTeams.noRoles')}</Typography.Text>
                ) : (
                  <Space size={4} wrap>
                    {value.map((id) => (
                      <Tag key={id} className="carocrm-admin-tag">
                        {roleNames.get(id) ?? id}
                      </Tag>
                    ))}
                  </Space>
                ),
            },
            {
              title: t('web.adminTeams.privateColumn'),
              dataIndex: 'isPrivate',
              width: 110,
              render: (value: boolean) => (value ? <Tag className="carocrm-admin-tag">{t('web.adminTeams.privateYes')}</Tag> : '---'),
            },
            {
              title: '',
              key: 'actions',
              width: 180,
              render: (_: unknown, row) => (
                <Space size={4}>
                  <Button size="small" onClick={() => setEditing(row.id)}>
                    {t('web.common.edit')}
                  </Button>
                  <Popconfirm
                    title={t('web.adminTeams.deleteConfirm', { name: row.name })}
                    description={t('web.adminTeams.deleteHint')}
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
          {t('web.adminTeams.overviewNote')}
        </Typography.Text>
      </Card>

      {editing !== undefined ? <TeamFormModal teamId={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); reload(); }} /> : null}
    </div>
  );
}

function TeamFormModal({ teamId, onClose, onSaved }: { readonly teamId: string | null; readonly onClose: () => void; readonly onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const roles = useRolesQuery();
  const users = useUsersQuery();
  const [form] = Form.useForm<{ name: string; isPrivate: boolean; userIds: string[]; roleIds: string[] }>();
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const existing = useQuery({
    queryKey: ['identity', 'teams', teamId ?? 'new'],
    queryFn: () => api.getTeam(teamId ?? ''),
    enabled: teamId !== null,
  });
  const loaded = teamId === null || existing.data !== undefined;

  useEffect(() => {
    if (!loaded) return;
    form.setFieldsValue({
      name: existing.data?.name ?? '',
      isPrivate: existing.data?.isPrivate ?? false,
      userIds: existing.data?.userIds ?? [],
      roleIds: existing.data?.roleIds ?? [],
    });
  }, [loaded, existing.data, form]);

  const selectedRoleIds = Form.useWatch('roleIds', form) ?? [];
  const roleList = roles.data?.list ?? [];
  const selectedRoles = selectedRoleIds.map((id) => roleList.find((role) => role.id === id)).filter((role) => role !== undefined);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    setSaving(true);
    setFailed(null);
    try {
      const input = { name: values.name.trim(), isPrivate: values.isPrivate, userIds: values.userIds, roleIds: values.roleIds };
      if (teamId === null) await api.createTeam(input);
      else await api.updateTeam(teamId, input);
      void message.success(t(teamId === null ? 'web.adminTeams.created' : 'web.adminTeams.updated', { name: values.name.trim() }));
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminTeams.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={720}
      title={teamId === null ? t('web.adminTeams.createTitle') : t('web.adminTeams.editTitle', { name: existing.data?.name ?? '' })}
      okText={t('web.common.save')}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnHidden
    >
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Form form={form} layout="vertical" disabled={!loaded}>
        <div className="carocrm-admin-form--two">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, max: 150 }]}>
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item name="isPrivate" label={t('web.adminTeams.private')} valuePropName="checked" extra={t('web.adminTeams.privateHint')}>
            <Switch />
          </Form.Item>
        </div>
        <Form.Item name="userIds" label={t('web.adminTeams.membersTitle')} extra={t('web.adminTeams.membersHint')}>
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            placeholder={t('web.adminTeams.membersPlaceholder')}
            options={(users.data?.list ?? []).map((user) => ({ value: user.id, label: `${user.name} (${user.userName})` }))}
          />
        </Form.Item>
        <Form.Item name="roleIds" label={t('web.adminTeams.rolesTitle')} extra={t('web.adminTeams.rolesHint')}>
          <Select mode="multiple" allowClear optionFilterProp="label" placeholder={t('web.adminTeams.membersPlaceholder')} options={roleList.map((role) => ({ value: role.id, label: role.name }))} />
        </Form.Item>
      </Form>
      <TeamAccessOverview roles={selectedRoles} />
    </Modal>
  );
}

/**
 * The "team ACL overview" (PLAN_Phase_20 §4.3 row 10): what the selected roles grant, strongest level
 * wins. It is a read-only projection of the same additive rule `AclApiService` applies.
 */
function TeamAccessOverview({ roles }: { readonly roles: readonly Role[] }) {
  const entities = useMemo(() => {
    const out = new Map<string, Record<string, AclLevel>>();
    for (const role of roles) {
      for (const entity of Object.keys(role.permissions)) {
        const row = out.get(entity) ?? {};
        for (const action of ACL_ACTIONS) {
          const level = aclLevel(role, entity, action);
          if (level === 'no') continue;
          const previous = row[action];
          row[action] = previous === undefined ? level : maxAclLevel([previous, level]);
        }
        out.set(entity, row);
      }
    }
    return [...out.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [roles]);

  if (roles.length === 0) return null;
  return (
    <div className="carocrm-admin-overview">
      <Typography.Text strong>{t('web.adminTeams.accessOverview')}</Typography.Text>
      <Typography.Text type="secondary" className="carocrm-admin-note">
        {t('web.adminTeams.accessOverviewNote')}
      </Typography.Text>
      {entities.length === 0 ? (
        <Typography.Text type="secondary">{t('web.adminTeams.accessOverviewEmpty')}</Typography.Text>
      ) : (
        <Table<{ entity: string; levels: Record<string, AclLevel | undefined> }>
          size="small"
          rowKey="entity"
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 5, hideOnSinglePage: true, showSizeChanger: false }}
          dataSource={entities.map(([entity, levels]) => ({ entity, levels }))}
          columns={[
            { title: t('web.adminTeams.entity'), dataIndex: 'entity' },
            ...ACL_ACTIONS.map((action) => ({
              title: t(`web.adminRoles.action.${action}`),
              key: action,
              width: 92,
              render: (_: unknown, row: { levels: Record<string, AclLevel | undefined> }) =>
                row.levels[action] === undefined ? '---' : <Tag className="carocrm-admin-tag">{t(`web.adminRoles.level.${row.levels[action]}`)}</Tag>,
            })),
          ]}
        />
      )}
    </div>
  );
}
