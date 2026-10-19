import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { ProjectMemberRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { projectQueryKey, ProjectShell,useErrorReporter, useProjectCapabilities, useProjectPlan, useProjectRefresh  } from './projectShared.js';

/**
 * Members and their project roles (PLAN_Phase_19_Projects.md §4.4).
 *
 * The list is the project's membership, not the CRM team: adding someone here says what they may do
 * inside this project, and the server answers the same question when it authorises any call. The
 * bulk panel applies a role across several projects at once, with a per-project verdict rather than
 * an all-or-nothing answer (§4.17).
 */

export function ProjectMembersPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(id);
  const queryClient = useQueryClient();
  const plan = useProjectPlan(id);
  const capabilities = useProjectCapabilities(id);

  const [userId, setUserId] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Record<string, string>>({});
  const [bulkProjects, setBulkProjects] = useState<string[]>([]);
  const [bulkUsers, setBulkUsers] = useState<string[]>([]);
  const [bulkOperation, setBulkOperation] = useState<'add' | 'remove' | 'role'>('add');
  const [bulkRoleId, setBulkRoleId] = useState<string | null>(null);

  const members = useQuery({
    queryKey: [...projectQueryKey(id), 'members'],
    queryFn: async () => (await api.projectMembers(id)).list as ProjectMemberRow[],
  });
  const roles = useQuery({
    queryKey: ['projectRoles'],
    queryFn: async () => {
      const result = await api.list('ProjectRole', { maxSize: 50, total: false });
      return result.list.map((row) => ({ value: String(row['id']), label: String(row['name'] ?? '') }));
    },
  });
  const users = useQuery({
    queryKey: ['allUsers'],
    queryFn: async () => {
      const result = await api.users({ maxSize: 200 });
      return result.list.map((row) => ({ value: row.id, label: row.name }));
    },
  });
  const projects = useQuery({
    queryKey: ['allProjects'],
    queryFn: async () => {
      const result = await api.list('Project', { maxSize: 200, total: false });
      return result.list.map((row) => ({ value: String(row['id']), label: String(row['name'] ?? '') }));
    },
  });

  const canManage = capabilities.data?.capabilities['manageMembers'] === true;

  const add = async (): Promise<void> => {
    if (userId === null || roleId === null) return;
    try {
      await api.addProjectMember(id, { userId, projectRoleId: roleId });
      void message.success(t('web.projects.memberAdded'));
      setUserId(null);
      refresh();
    } catch (error) {
      report(error);
    }
  };

  const changeRole = async (memberId: string, nextRole: string): Promise<void> => {
    try {
      await api.updateProjectMember(id, { memberId, projectRoleId: nextRole });
      refresh();
      void message.success(t('web.projects.roleUpdated'));
    } catch (error) {
      report(error);
    }
  };

  const remove = async (member: ProjectMemberRow): Promise<void> => {
    try {
      const result = await api.removeProjectMember(id, {
        memberId: member.id,
        ...(transfer[member.id] !== undefined ? { transferToMemberId: transfer[member.id] } : {}),
      });
      void message.success(t('web.projects.memberRemoved'));
      void result;
      refresh();
    } catch (error) {
      // "Transfer the project ownership before removing the last owner" arrives here (§4.4).
      report(error);
      refresh();
    }
  };

  const runBulk = async (): Promise<void> => {
    if (bulkRoleId === null || bulkUsers.length === 0) return;
    try {
      const result = await api.bulkProjectMembers(id, { projectIds: bulkProjects, userIds: bulkUsers, projectRoleId: bulkRoleId, operation: bulkOperation });
      void message.success(`${t('web.projects.bulkDone')}: ${String(result.succeeded.length)} / ${String(result.succeeded.length + result.failed.length)}`);
      for (const failure of result.failed) void message.warning(`${failure.projectId}: ${failure.message}`);
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(id) });
      refresh();
    } catch (error) {
      report(error);
    }
  };

  return (
    <ProjectShell project={plan.data?.project} capabilities={capabilities.data} active="members" loading={members.isLoading} error={members.error}>
      <Table
        className="carocrm-card"
        size="small"
        rowKey={(row) => row.id}
        dataSource={members.data ?? []}
        pagination={false}
        columns={[
          { title: t('web.projects.fieldUser'), dataIndex: 'userName', render: (_: unknown, row) => row.userName ?? row.userId },
          {
            title: t('web.projects.fieldRole'),
            dataIndex: 'roleName',
            render: (_value: unknown, row: ProjectMemberRow) =>
              canManage ? (
                <Select
                  size="small"
                  value={row.projectRoleId ?? null}
                  style={{ width: 160 }}
                  options={roles.data ?? []}
                  onChange={(value: string) => void changeRole(row.id, value)}
                />
              ) : (
                <Tag>{row.roleName ?? '—'}</Tag>
              ),
          },
          {
            title: '',
            key: 'actions',
            width: 260,
            render: (_: unknown, row) =>
              canManage ? (
                <Space>
                  <Select
                    size="small"
                    style={{ width: 150 }}
                    placeholder={t('web.projects.transferOwnership')}
                    allowClear
                    value={transfer[row.id] ?? null}
                    onChange={(value: string | undefined) => setTransfer({ ...transfer, [row.id]: value ?? '' })}
                    options={(members.data ?? []).filter((other) => other.id !== row.id).map((other) => ({ value: other.id, label: other.userName ?? other.userId }))}
                  />
                  <Popconfirm title={t('web.projects.removeMember')} onConfirm={() => void remove(row)}>
                    <Button size="small" danger>
                      {t('web.projects.remove')}
                    </Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />

      {canManage ? (
        <Space style={{ marginTop: 12 }} wrap>
          <Select showSearch optionFilterProp="label" style={{ width: 220 }} value={userId ?? null} onChange={setUserId} options={users.data ?? []} placeholder={t('web.projects.fieldUser')} />
          <Select style={{ width: 180 }} value={roleId ?? null} onChange={setRoleId} options={roles.data ?? []} placeholder={t('web.projects.fieldRole')} />
          <Button type="primary" onClick={() => void add()}>
            {t('web.projects.addMember')}
          </Button>
        </Space>
      ) : (
        <Typography.Text type="secondary">{t('web.projects.membersReadOnly')}</Typography.Text>
      )}

      {canManage ? (
        <div className="carocrm-project-bulk-members">
          <Typography.Text strong>{t('web.projects.bulkTitle')}</Typography.Text>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Space wrap>
              <Select mode="multiple" allowClear style={{ minWidth: 240 }} value={bulkUsers} onChange={setBulkUsers} options={users.data ?? []} placeholder={t('web.projects.fieldUser')} />
              <Select style={{ width: 160 }} value={bulkOperation} onChange={(value) => setBulkOperation(value)} options={[
                { value: 'add', label: t('web.projects.bulkAdd') },
                { value: 'role', label: t('web.projects.bulkRole') },
                { value: 'remove', label: t('web.projects.bulkRemove') },
              ]} />
              <Select style={{ width: 180 }} value={bulkRoleId ?? null} onChange={setBulkRoleId} options={roles.data ?? []} placeholder={t('web.projects.fieldRole')} />
            </Space>
            <Space wrap>
              <Select mode="multiple" allowClear style={{ minWidth: 320 }} value={bulkProjects} onChange={setBulkProjects} options={projects.data ?? []} placeholder={t('web.projects.fieldProjects')} />
              <Button onClick={() => void runBulk()}>{t('web.projects.bulkApply')}</Button>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.projects.bulkNote')}
            </Typography.Text>
          </Space>
        </div>
      ) : null}
    </ProjectShell>
  );
}
