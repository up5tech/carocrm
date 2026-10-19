import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { UserAccountType, UserInput, UserRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { useSession } from '../../state/session.js';
import { errorMessage, errorRule, useRolesQuery, useTeamsQuery } from './identity.js';

const PAGE_SIZE = 20;

/**
 * Users tab (PLAN_Phase_20_Settings_UX.md §4.3 row 9): the account list behind the existing
 * `/User` API — search, role/team/status filters, create, edit, activate/deactivate, password reset
 * and delete. Nothing here decides access: the server re-checks administrator rights on every call
 * and refuses the change that would leave the instance without an active administrator, which the
 * form then explains inline.
 */
export function UsersTab() {
  const { message } = AntApp.useApp();
  const client = useQueryClient();
  const { principal } = useSession();
  const roles = useRolesQuery();
  const teams = useTeamsQuery();

  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [where, setWhere] = useState('');
  const [isActive, setIsActive] = useState<'true' | 'false' | undefined>(undefined);
  const [type, setType] = useState<UserAccountType | undefined>(undefined);
  const [roleId, setRoleId] = useState<string | undefined>(undefined);
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [resetting, setResetting] = useState<UserRow | null>(null);

  const list = useQuery({
    queryKey: ['identity', 'users', { offset, where, isActive, type, roleId, teamId }],
    queryFn: () =>
      api.users({ offset, maxSize: PAGE_SIZE, ...(where === '' ? {} : { where }), ...(isActive === undefined ? {} : { isActive }), ...(type === undefined ? {} : { type }), ...(roleId === undefined ? {} : { roleId }), ...(teamId === undefined ? {} : { teamId }) }),
  });

  const roleNames = new Map((roles.data?.list ?? []).map((role) => [role.id, role.name]));
  const reload = () => void client.invalidateQueries({ queryKey: ['identity', 'users'] });

  const toggleActive = async (row: UserRow, next: boolean) => {
    try {
      await api.updateUser(row.id, { isActive: next });
      void message.success(t(next ? 'web.adminUsers.activated' : 'web.adminUsers.deactivated', { name: row.name }));
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminUsers.updateFailed')));
    }
  };

  const remove = async (row: UserRow) => {
    try {
      await api.deleteUser(row.id);
      void message.success(t('web.adminUsers.deleted', { name: row.name }));
      reload();
    } catch (error) {
      void message.error(errorMessage(error, t('web.adminUsers.deleteFailed')));
    }
  };

  const applyFilters = () => {
    setOffset(0);
    setWhere(search.trim());
  };

  return (
    <div className="carocrm-admin-records">
      <Card
        className="carocrm-card"
        title={t('web.adminUsers.title')}
        extra={
          <Space wrap size={8}>
            <Button icon={<ReloadOutlined />} onClick={reload} loading={list.isFetching}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
              {t('web.adminUsers.new')}
            </Button>
          </Space>
        }
      >
        <Space wrap size={8} className="carocrm-admin-filters">
          <Input
            allowClear
            className="carocrm-admin-search"
            placeholder={t('web.adminUsers.searchPlaceholder')}
            aria-label={t('web.adminUsers.searchAria')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={applyFilters}
          />
          <Select
            allowClear
            className="carocrm-admin-filter"
            placeholder={t('web.adminUsers.filterStatus')}
            aria-label={t('web.adminUsers.filterStatusAria')}
            value={isActive}
            onChange={(value) => {
              setOffset(0);
              setIsActive(value);
            }}
            options={[
              { value: 'true', label: t('web.adminUsers.statusActive') },
              { value: 'false', label: t('web.adminUsers.statusInactive') },
            ]}
          />
          <Select
            allowClear
            className="carocrm-admin-filter"
            placeholder={t('web.adminUsers.filterType')}
            aria-label={t('web.adminUsers.filterTypeAria')}
            value={type}
            onChange={(value) => {
              setOffset(0);
              setType(value);
            }}
            options={(['admin', 'regular', 'portal', 'api', 'system'] as const).map((value) => ({ value, label: t(`web.adminUsers.type.${value}`) }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            className="carocrm-admin-filter"
            placeholder={t('web.adminUsers.filterRole')}
            aria-label={t('web.adminUsers.filterRoleAria')}
            value={roleId}
            onChange={(value) => {
              setOffset(0);
              setRoleId(value);
            }}
            options={(roles.data?.list ?? []).map((role) => ({ value: role.id, label: role.name }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            className="carocrm-admin-filter"
            placeholder={t('web.adminUsers.filterTeam')}
            aria-label={t('web.adminUsers.filterTeamAria')}
            value={teamId}
            onChange={(value) => {
              setOffset(0);
              setTeamId(value);
            }}
            options={(teams.data?.list ?? []).map((team) => ({ value: team.id, label: team.name }))}
          />
          <Button onClick={applyFilters}>{t('web.adminUsers.applyFilters')}</Button>
        </Space>

        <Table<UserRow>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          loading={list.isLoading}
          dataSource={list.data?.list ?? []}
          locale={{ emptyText: t('web.adminUsers.empty') }}
          pagination={{
            current: Math.floor(offset / PAGE_SIZE) + 1,
            pageSize: PAGE_SIZE,
            total: list.data?.total ?? 0,
            showSizeChanger: false,
            onChange: (page) => setOffset((page - 1) * PAGE_SIZE),
          }}
          columns={[
            {
              title: t('web.adminUsers.colName'),
              dataIndex: 'name',
              render: (_: unknown, row) => (
                <div className="carocrm-admin-cell-stack">
                  <Typography.Text strong>{row.name}</Typography.Text>
                  <Typography.Text type="secondary">{row.userName}</Typography.Text>
                </div>
              ),
            },
            { title: t('web.adminUsers.colEmail'), dataIndex: 'emailAddress', responsive: ['md'], render: (value: string | null) => value ?? '---' },
            {
              title: t('web.adminUsers.colType'),
              dataIndex: 'type',
              width: 110,
              render: (value: string) => <Tag className="carocrm-admin-tag">{t(`web.adminUsers.type.${value}`)}</Tag>,
            },
            {
              title: t('web.adminUsers.colRoles'),
              dataIndex: 'roles',
              render: (value: string[]) =>
                value.length === 0 ? (
                  <Typography.Text type="secondary">{t('web.adminUsers.noRoles')}</Typography.Text>
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
              title: t('web.adminUsers.colStatus'),
              dataIndex: 'isActive',
              width: 90,
              render: (value: boolean, row) => (
                <Switch size="small" checked={value} aria-label={t('web.adminUsers.toggleAria', { name: row.name })} onChange={(next) => void toggleActive(row, next)} />
              ),
            },
            {
              title: '',
              key: 'actions',
              width: 260,
              render: (_: unknown, row) => (
                <Space size={4} wrap>
                  <Button size="small" onClick={() => setEditing(row.id)}>
                    {t('web.common.edit')}
                  </Button>
                  <Button size="small" onClick={() => setResetting(row)}>
                    {t('web.adminUsers.resetPassword')}
                  </Button>
                  <Popconfirm
                    title={t('web.adminUsers.deleteConfirm', { name: row.name })}
                    description={t('web.adminUsers.deleteHint')}
                    okText={t('web.common.delete')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(row)}
                  >
                    <Button size="small" danger disabled={row.id === principal?.id}>
                      {t('web.common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {t('web.adminUsers.count', { count: list.data?.total ?? 0 })} · {t('web.adminUsers.teamsNote')}
        </Typography.Text>
      </Card>

      {editing !== undefined ? (
        <UserFormModal
          userId={editing}
          roleNames={roleNames}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      ) : null}
      {resetting !== null ? <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} /> : null}
    </div>
  );
}

/**
 * Create or edit one account. The list row carries no team membership, so the form loads the full
 * record first; a rejected write stays open with the server's reason inline rather than a toast the
 * reader has already missed.
 */
function UserFormModal({
  userId,
  roleNames,
  onClose,
  onSaved,
}: {
  readonly userId: string | null;
  readonly roleNames: Map<string, string>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { message } = AntApp.useApp();
  const roles = useRolesQuery();
  const teams = useTeamsQuery();
  const [form] = Form.useForm<UserFormValues>();
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isPortal, setIsPortal] = useState(false);
  const existing = useQuery({
    queryKey: ['identity', 'users', userId ?? 'new'],
    queryFn: () => api.user(userId ?? ''),
    enabled: userId !== null,
  });

  const account = existing.data;
  const loaded = userId === null || account !== undefined;
  useEffect(() => {
    if (!loaded) return;
    setIsPortal(account?.type === 'portal');
    form.setFieldsValue({
      userName: account?.userName ?? '',
      firstName: account?.firstName ?? '',
      lastName: account?.lastName ?? '',
      emailAddress: account?.emailAddress ?? '',
      title: account?.title ?? '',
      phone: account?.phone ?? '',
      isAdmin: account?.isAdmin ?? false,
      isActive: account?.isActive ?? true,
      assignedRoleIds: account?.roles ?? [],
      teamIds: account?.teams ?? [],
      password: '',
    });
  }, [loaded, account, form]);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    // An empty field is "no value", not "no change": the form owns what the reader sees.
    const optional = (value: string) => (value.trim() === '' ? null : value.trim());
    const shared: UserInput = {
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      emailAddress: optional(values.emailAddress),
      title: optional(values.title),
      phone: optional(values.phone),
      isActive: values.isActive,
    };
    // A portal account draws its authority from portal roles, so the internal role/team fields are
    // neither shown nor sent — the server would reject them and silently keep the old linkage.
    if (!isPortal) {
      shared.isAdmin = values.isAdmin;
      shared.assignedRoleIds = values.assignedRoleIds;
      shared.teamIds = values.teamIds;
    }
    setSaving(true);
    setFailed(null);
    try {
      if (userId === null) {
        await api.createUser({ userName: values.userName.trim(), ...shared, ...(values.password === '' ? {} : { password: values.password }) });
        void message.success(t('web.adminUsers.created', { name: values.userName.trim() }));
      } else {
        await api.updateUser(userId, shared);
        void message.success(t('web.adminUsers.updated', { name: values.userName.trim() }));
      }
      onSaved();
    } catch (error) {
      setFailed(ruleMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={640}
      title={userId === null ? t('web.adminUsers.createTitle') : t('web.adminUsers.editTitle', { name: account?.name ?? '' })}
      okText={t('web.common.save')}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnHidden
    >
      {userId === null ? null : existing.isError ? <Alert type="error" showIcon message={t('web.adminUsers.loadFailed')} /> : null}
      {failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} data-testid="identity-form-error" role="alert" />
      ) : null}
      {isPortal ? <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('web.adminUsers.portalHint')} /> : null}
      <Form form={form} layout="vertical" disabled={!loaded}>
        <div className="carocrm-admin-form--two">
          <Form.Item name="userName" label={t('web.adminUsers.userName')} rules={[{ required: true, min: 2, max: 100 }, { pattern: /^[A-Za-z0-9._@-]+$/, message: t('web.adminUsers.userNameInvalid') }]}>
            <Input autoComplete="off" disabled={!loaded || userId !== null} />
          </Form.Item>
          <Form.Item name="emailAddress" label={t('web.adminUsers.email')}>
            <Input type="email" autoComplete="off" />
          </Form.Item>
          <Form.Item name="firstName" label={t('web.adminUsers.firstName')}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="lastName" label={t('web.adminUsers.lastName')}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="title" label={t('web.adminUsers.jobTitle')}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="phone" label={t('web.adminUsers.phone')}>
            <Input maxLength={64} />
          </Form.Item>
          {userId === null ? (
            <Form.Item name="password" label={t('web.adminUsers.password')} extra={t('web.adminUsers.passwordHint')} rules={[{ min: 8, message: t('web.adminUsers.passwordShort') }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          ) : null}
        </div>
        {isPortal ? null : (
          <>
            <Form.Item name="assignedRoleIds" label={t('web.adminUsers.roles')} extra={t('web.adminUsers.rolesHint')}>
              <Select
                mode="multiple"
                allowClear
                optionFilterProp="label"
                placeholder={t('web.adminUsers.rolesPlaceholder')}
                options={(roles.data?.list ?? []).map((role) => ({ value: role.id, label: role.id === 'sysAdmin' ? `${role.name} (${t('web.adminUsers.builtIn')})` : role.name }))}
              />
            </Form.Item>
            <Form.Item name="teamIds" label={t('web.adminUsers.teams')} extra={t('web.adminUsers.teamsHint')}>
              <Select mode="multiple" allowClear optionFilterProp="label" placeholder={t('web.adminUsers.teamsPlaceholder')} options={(teams.data?.list ?? []).map((team) => ({ value: team.id, label: team.name }))} />
            </Form.Item>
            <div className="carocrm-admin-form--two">
              <Form.Item name="isAdmin" label={t('web.adminUsers.administrator')} valuePropName="checked" extra={t('web.adminUsers.administratorHint')}>
                <Switch />
              </Form.Item>
              <Form.Item name="isActive" label={t('web.adminUsers.active')} valuePropName="checked" extra={t('web.adminUsers.activeHint')}>
                <Switch />
              </Form.Item>
            </div>
            <Typography.Text type="secondary" className="carocrm-admin-note">
              {t('web.adminUsers.effectiveRoles', { names: (account?.roles ?? []).map((id) => roleNames.get(id) ?? id).join(', ') || t('web.adminUsers.none') })}
            </Typography.Text>
          </>
        )}
      </Form>
    </Modal>
  );
}

function ruleMessage(error: unknown): string {
  const rule = errorRule(error);
  if (rule === 'lastAdministrator') return t('web.adminUsers.lastAdmin');
  if (rule === 'roleInUse') return t('web.adminUsers.roleInUse');
  return errorMessage(error, t('web.adminUsers.saveFailed'));
}

interface UserFormValues {
  userName: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  title: string;
  phone: string;
  password: string;
  isAdmin: boolean;
  isActive: boolean;
  assignedRoleIds: string[];
  teamIds: string[];
}

/**
 * Password reset is its own confirmed action because it ends the sessions the previous password
 * opened — the server revokes them, and the UI says so before the button is pressed.
 */
function ResetPasswordModal({ user, onClose }: { readonly user: UserRow; readonly onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ password: string; confirm: string }>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (values === null) return;
    setSaving(true);
    setFailed(null);
    try {
      await api.resetUserPassword(user.id, values.password);
      void message.success(t('web.adminUsers.passwordReset', { name: user.name }));
      onClose();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminUsers.resetFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open width={480} title={t('web.adminUsers.resetTitle', { name: user.name })} okText={t('web.common.save')} confirmLoading={saving} onCancel={onClose} onOk={() => void submit()}>
      {failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failed} role="alert" /> : null}
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('web.adminUsers.resetWarning')} />
      <Form form={form} layout="vertical">
        <Form.Item name="password" label={t('web.adminUsers.newPassword')} rules={[{ required: true, min: 8, message: t('web.adminUsers.passwordShort') }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label={t('web.adminUsers.confirmPassword')}
          dependencies={['password']}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({ validator: (_rule, value: string) => (value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t('web.adminUsers.passwordMismatch')))) }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
