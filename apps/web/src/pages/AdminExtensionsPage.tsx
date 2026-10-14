import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Descriptions, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { ExtensionRow } from '../api/types.js';
import { t } from '../state/i18n.js';
import { useSession } from '../state/session.js';

/**
 * Extension administration (PLAN §38.3, §19.1).
 *
 * The page shows what is on disk, what is installed and what this process is actually running —
 * those are three different facts, and conflating them is how an operator ends up wondering why a
 * new package changed nothing. Installing, enabling and uninstalling all need a restart of the API
 * *and* the worker before they take effect, which the page states after every action.
 */
export function AdminExtensionsPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.extensions();
      setRows(result.list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminExtensions.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (principal?.type !== 'admin') {
    return <Alert type="error" message={t('web.admin.accessRequiredExtensions')} />;
  }

  const act = async (id: string, action: 'install' | 'uninstall' | 'enable' | 'disable', label: string) => {
    try {
      if (action === 'install') {
        const result = await api.installExtension(id);
        const applied = result.migrations.applied;
        void message.success(
          t('web.adminExtensions.installDone', {
            label,
            migrations: applied.length > 0 ? t('web.adminExtensions.migrationsApplied', { list: applied.join(', ') }) : '',
          }),
        );
      } else if (action === 'uninstall') {
        await api.uninstallExtension(id);
        void message.success(t('web.adminExtensions.uninstallDone', { label }));
      } else {
        await api.setExtensionEnabled(id, action === 'enable');
        void message.success(t('web.adminExtensions.stateDone', { label, state: action === 'enable' ? t('web.adminExtensions.enabled') : t('web.adminExtensions.disabled') }));
      }
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminExtensions.actionFailed'));
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={t('web.adminExtensions.title')}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t('core.common.refresh')}
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          {t('web.adminExtensions.hint', { dir: 'EXTENSIONS_DIR' })}
        </Typography.Paragraph>
        <Table<ExtensionRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          expandable={{
            expandedRowRender: (row) => (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label={t('web.adminExtensions.packagePath')}>{row.path ?? '—'}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.installedAt')}>{row.installedAt ? row.installedAt.slice(0, 19).replace('T', ' ') : '—'}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.order')}>{row.order}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.dependencies')}>
                  {row.dependencies.length === 0
                    ? '—'
                    : row.dependencies.map((dependency) => `${dependency.id}${dependency.version ? ` >= ${dependency.version}` : ''}`).join(', ')}
                </Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.permissions')}>{row.permissions.length === 0 ? '—' : row.permissions.join(', ')}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.entities')}>{row.contributes.entities.length === 0 ? '—' : row.contributes.entities.join(', ')}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.controllers')}>{row.contributes.controllers} / {row.contributes.hooks.length}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.jobs')}>{row.contributes.jobs.length === 0 ? '—' : row.contributes.jobs.join(', ')}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.migrations')}>{row.contributes.migrations.length === 0 ? '—' : row.contributes.migrations.join(', ')}</Descriptions.Item>
                <Descriptions.Item label={t('web.adminExtensions.navigation')}>{t('web.adminExtensions.navItems', { items: String(row.contributes.navItems) })}</Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: t('web.adminExtensions.colPackage'),
              dataIndex: 'id',
              render: (id: string, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{row.name}</Typography.Text>
                  <Typography.Text type="secondary">
                    {id}@{row.version}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: t('web.adminExtensions.colState'),
              render: (_value: unknown, row: ExtensionRow) => (
                <Space size={4} wrap>
                  {row.installed ? <Tag color="blue">{t('web.adminExtensions.installed')}</Tag> : <Tag>{t('web.adminExtensions.available')}</Tag>}
                  {row.installed && !row.enabled ? <Tag color="warning">{t('web.adminExtensions.disabled')}</Tag> : null}
                  {row.running ? <Tag color="green">{t('web.adminExtensions.running')}</Tag> : null}
                  {row.problem ? <Tag color="error">{row.problem}</Tag> : null}
                  {row.installed && !row.running ? <Tag color="orange">{t('web.adminExtensions.restartRequired')}</Tag> : null}
                </Space>
              ),
            },
            {
              title: '',
              width: 320,
              render: (_value: unknown, row: ExtensionRow) => (
                <Space>
                  {row.installed ? (
                    <>
                      <Switch
                        size="small"
                        checked={row.enabled}
                        onChange={(enabled) => void act(row.id, enabled ? 'enable' : 'disable', row.name)}
                      />
                      <Popconfirm
                        title={t('web.adminExtensions.uninstallConfirm', { name: row.name })}
                        description={t('web.adminExtensions.uninstallHint')}
                        onConfirm={() => void act(row.id, 'uninstall', row.name)}
                      >
                        <Button size="small" danger icon={<ApiOutlined />}>
                          {t('web.adminExtensions.uninstall')}
                        </Button>
                      </Popconfirm>
                    </>
                  ) : (
                    <Button size="small" type="primary" disabled={row.problem !== null} onClick={() => void act(row.id, 'install', row.name)}>
                      {t('web.adminExtensions.install')}
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}