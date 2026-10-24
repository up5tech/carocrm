import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Select, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

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
      <ExplainCard />
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

type AclActionName = 'create' | 'read' | 'edit' | 'delete' | 'stream';
const EXPLAIN_ACTIONS: AclActionName[] = ['create', 'read', 'edit', 'delete', 'stream'];

/**
 * "Why can this user do this?" (§4.8).
 *
 * The answer is the server's own evaluation — the same `roleLevel`/`maxLevel` pair the API uses — not
 * a client-side guess from the matrix above, which would drift the moment the composition rules
 * change. Administrator accounts short-circuit to `all`, exactly as they do at request time.
 */
function ExplainCard() {
  const metadata = useMetadata();
  const users = useQuery({
    queryKey: ['identity', 'users', 'explain'],
    queryFn: () => api.users({ maxSize: 500, isActive: 'true' }),
    staleTime: 60_000,
  });
  const entities = useMemo(
    () =>
      Object.values(metadata.data ?? {})
        .map((entity) => ({ value: entity.name, label: entity.label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [metadata.data],
  );
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<AclActionName>('read');
  const explain = useMutation({
    mutationFn: (input: { userId: string; entity: string; action: AclActionName }) => api.explainAcl(input),
  });

  const canRun = userId !== undefined && entity !== undefined;

  return (
    <Card className="carocrm-card" title={t('web.adminPermissions.explainTitle')}>
      <Typography.Paragraph type="secondary">{t('web.adminPermissions.explainHint')}</Typography.Paragraph>
      <Space wrap>
        <Select
          style={{ minWidth: 220 }}
          showSearch
          optionFilterProp="label"
          aria-label={t('web.adminPermissions.explainUser')}
          placeholder={t('web.adminPermissions.explainUser')}
          loading={users.isLoading}
          value={userId}
          options={(users.data?.list ?? []).map((user) => ({ value: user.id, label: user.name || user.userName }))}
          onChange={(next) => setUserId(next)}
        />
        <Select
          style={{ minWidth: 200 }}
          showSearch
          optionFilterProp="label"
          aria-label={t('web.adminPermissions.explainEntity')}
          placeholder={t('web.adminPermissions.explainEntity')}
          loading={metadata.isLoading}
          value={entity}
          options={entities}
          onChange={(next) => setEntity(next)}
        />
        <Select
          style={{ minWidth: 150 }}
          aria-label={t('web.adminPermissions.explainAction')}
          value={action}
          options={EXPLAIN_ACTIONS.map((name) => ({ value: name, label: t(`web.adminRoles.action.${name}`) }))}
          onChange={(next) => setAction(next as AclActionName)}
        />
        <Button
          type="primary"
          disabled={!canRun}
          loading={explain.isPending}
          onClick={() => {
            if (!canRun) return;
            explain.mutate({ userId, entity, action });
          }}
        >
          {t('web.adminPermissions.explainRun')}
        </Button>
      </Space>
      {explain.isError ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message={explain.error instanceof Error ? explain.error.message : t('web.adminPermissions.explainFailed')}
        />
      ) : null}
      {explain.data === undefined ? null : (
        <div style={{ marginTop: 12 }}>
          {explain.data.administrator ? (
            <Alert type="info" showIcon message={t('web.adminPermissions.explainAdmin')} />
          ) : (
            <>
              <Space>
                <Typography.Text>{t('web.adminPermissions.explainLevel')}</Typography.Text>
                <Tag className="carocrm-admin-tag">{explain.data.level}</Tag>
              </Space>
              {explain.data.roles.length === 0 ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {t('web.adminPermissions.explainNoRoles')}
                </Typography.Paragraph>
              ) : (
                <Table
                  size="small"
                  style={{ marginTop: 8 }}
                  rowKey="id"
                  pagination={false}
                  dataSource={explain.data.roles}
                  columns={[
                    { title: t('web.adminPermissions.explainRoles'), dataIndex: 'name' },
                    {
                      title: t('web.adminPermissions.explainLevel'),
                      dataIndex: 'level',
                      width: 160,
                      render: (value: string) => <Tag className="carocrm-admin-tag">{value}</Tag>,
                    },
                  ]}
                />
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
