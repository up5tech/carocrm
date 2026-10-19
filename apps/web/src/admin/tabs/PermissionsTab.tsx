import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Table, Tag, Typography } from 'antd';
import { useMemo } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';

interface DeclaredRow {
  key: string;
  owner: string;
  scope: string;
  levels: Record<string, string>;
}

/**
 * Permissions tab (PLAN_Phase_20_Settings_UX.md §4.3 row 15): a read-only summary of the mandatory
 * layer under the role matrix. Access is composed from roles (additive, strongest level wins) plus the
 * roles linked to the user's teams, and administrator accounts bypass all of it. This page shows what
 * the shipped metadata declares per entity and what each role states, so an administrator can read
 * "who can see what" without opening every role.
 */
export function PermissionsTab() {
  const metadata = useMetadata();
  const roles = useQuery({
    queryKey: ['identity', 'roles', 'summary'],
    queryFn: () => api.roles({ maxSize: 500 }),
    staleTime: 30_000,
  });

  const declared = useMemo(() => {
    const rows: DeclaredRow[] = [];
    for (const entity of Object.values(metadata.data ?? {})) {
      for (const [scope, levels] of Object.entries(entity.acl?.permissions ?? {})) {
        rows.push({ key: `${entity.name}:${scope}`, owner: entity.label, scope, levels });
      }
    }
    return rows.sort((left, right) => left.owner.localeCompare(right.owner) || left.scope.localeCompare(right.scope));
  }, [metadata.data]);
  const roleList = roles.data?.list ?? [];

  return (
    <div className="carocrm-admin-records">
      <Alert type="info" showIcon message={t('web.adminPermissions.composition')} description={t('web.adminPermissions.compositionHint')} />
      <Card className="carocrm-card" title={t('web.adminPermissions.rolesTitle')}>
        <Table<{ id: string; name: string; entities: number; fields: number }>
          rowKey="id"
          size="small"
          loading={roles.isLoading}
          scroll={{ x: 'max-content' }}
          dataSource={roleList.map((role) => ({
            id: role.id,
            name: role.name,
            entities: Object.keys(role.permissions ?? {}).length,
            fields: Object.values(role.fieldPermissions ?? {}).reduce((total, entity) => total + Object.keys(entity ?? {}).length, 0),
          }))}
          locale={{ emptyText: t('web.adminPermissions.empty') }}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            {
              title: t('web.common.name'),
              dataIndex: 'name',
              render: (value: string, row) => (
                <span>
                  <Typography.Text strong>{value}</Typography.Text>
                  {row.id === 'sysAdmin' ? <Tag className="carocrm-admin-tag">{t('web.adminUsers.builtIn')}</Tag> : null}
                </span>
              ),
            },
            { title: t('web.adminRoles.entityRules'), dataIndex: 'entities', width: 140 },
            { title: t('web.adminRoles.fieldRules'), dataIndex: 'fields', width: 140 },
          ]}
        />
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {t('web.adminPermissions.rolesNote')}
        </Typography.Text>
      </Card>
      <Card className="carocrm-card" title={t('web.adminPermissions.declaredTitle')}>
        <Table<DeclaredRow>
          rowKey="key"
          size="small"
          loading={metadata.isLoading}
          scroll={{ x: 'max-content' }}
          dataSource={declared}
          locale={{ emptyText: t('web.adminPermissions.declaredEmpty') }}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            { title: t('web.adminPermissions.declaredOwner'), dataIndex: 'owner' },
            { title: t('web.adminPermissions.declaredScope'), dataIndex: 'scope' },
            ...(['create', 'read', 'edit', 'delete', 'stream'] as const).map((action) => ({
              title: t(`web.adminRoles.action.${action}`),
              key: action,
              width: 96,
              render: (_: unknown, row: DeclaredRow) => {
                const level = row.levels[action];
                return level === undefined ? '---' : <Tag className="carocrm-admin-tag">{level}</Tag>;
              },
            })),
          ]}
        />
        <Typography.Text type="secondary" className="carocrm-admin-note">
          {t('web.adminPermissions.declaredNote')}
        </Typography.Text>
      </Card>
    </div>
  );
}
