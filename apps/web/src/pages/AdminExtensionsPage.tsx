import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Descriptions, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { ExtensionRow } from '../api/types.js';
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
      void message.error(error instanceof Error ? error.message : 'Could not load extensions.');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (principal?.type !== 'admin') {
    return <Alert type="error" message="Administrator access is required to manage extensions." />;
  }

  const act = async (id: string, action: 'install' | 'uninstall' | 'enable' | 'disable', label: string) => {
    try {
      if (action === 'install') {
        const result = await api.installExtension(id);
        const applied = result.migrations.applied;
        void message.success(
          `${label} installed${applied.length > 0 ? ` (migrations applied: ${applied.join(', ')})` : ''}. Restart the API and the worker to load it.`,
        );
      } else if (action === 'uninstall') {
        await api.uninstallExtension(id);
        void message.success(`${label} uninstalled. Restart the API and the worker.`);
      } else {
        await api.setExtensionEnabled(id, action === 'enable');
        void message.success(`${label} ${action === 'enable' ? 'enabled' : 'disabled'}. Restart the API and the worker.`);
      }
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : `Could not ${action} the extension.`);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="Extensions"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          Packages are read from the configured <code>EXTENSIONS_DIR</code>. A package on disk is <em>available</em>;
          it only runs once it is <em>installed</em> and the API and worker have been restarted — providers, controllers and
          metadata precedence are fixed when the process starts.
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
                <Descriptions.Item label="Package path">{row.path ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="Installed at">{row.installedAt ? row.installedAt.slice(0, 19).replace('T', ' ') : '—'}</Descriptions.Item>
                <Descriptions.Item label="Order (metadata precedence)">{row.order}</Descriptions.Item>
                <Descriptions.Item label="Dependencies">
                  {row.dependencies.length === 0
                    ? '—'
                    : row.dependencies.map((dependency) => `${dependency.id}${dependency.version ? ` >= ${dependency.version}` : ''}`).join(', ')}
                </Descriptions.Item>
                <Descriptions.Item label="Permissions">{row.permissions.length === 0 ? '—' : row.permissions.join(', ')}</Descriptions.Item>
                <Descriptions.Item label="Entities">{row.contributes.entities.length === 0 ? '—' : row.contributes.entities.join(', ')}</Descriptions.Item>
                <Descriptions.Item label="Controllers / hooks">{row.contributes.controllers} / {row.contributes.hooks.length}</Descriptions.Item>
                <Descriptions.Item label="Jobs">{row.contributes.jobs.length === 0 ? '—' : row.contributes.jobs.join(', ')}</Descriptions.Item>
                <Descriptions.Item label="Migrations">{row.contributes.migrations.length === 0 ? '—' : row.contributes.migrations.join(', ')}</Descriptions.Item>
                <Descriptions.Item label="Navigation">{row.contributes.navItems} item(s)</Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: 'Package',
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
              title: 'State',
              render: (_value: unknown, row: ExtensionRow) => (
                <Space size={4} wrap>
                  {row.installed ? <Tag color="blue">installed</Tag> : <Tag>available</Tag>}
                  {row.installed && !row.enabled ? <Tag color="warning">disabled</Tag> : null}
                  {row.running ? <Tag color="green">running</Tag> : null}
                  {row.problem ? <Tag color="error">{row.problem}</Tag> : null}
                  {row.installed && !row.running ? <Tag color="orange">restart required</Tag> : null}
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
                        title={`Uninstall ${row.name}?`}
                        description="Tables it created are kept; uninstall only removes the activation record."
                        onConfirm={() => void act(row.id, 'uninstall', row.name)}
                      >
                        <Button size="small" danger icon={<ApiOutlined />}>
                          Uninstall
                        </Button>
                      </Popconfirm>
                    </>
                  ) : (
                    <Button size="small" type="primary" disabled={row.problem !== null} onClick={() => void act(row.id, 'install', row.name)}>
                      Install
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