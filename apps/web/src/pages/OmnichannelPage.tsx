import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Row, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { api } from '../api/client.js';
import type { OmnichannelCapabilityCatalog, OmnichannelHealthView } from '../api/types.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PageHeader } from '../components/PageHeader.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { t } from '../state/i18n.js';
import { InboxPanel } from './omnichannel/InboxPanel.js';

/**
 * Phase 19-OM.2 — the Omnichannel workspace shell
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`; `docs/omnichannel/feature-contract.md` §3 F1).
 *
 * What OM.2 delivers is the module, not the inbox, so this page answers the operator's real first
 * questions: is the module switched on, which platform pieces are in place, which rights do I hold,
 * and what does the workspace still wait for. Everything on screen is the server's answer from
 * `action/health` and `action/capabilities` — rendering is never the enforcement (AGENTS.md §5.3),
 * and the "still waiting for" list names the sub-phases that deliver those surfaces rather than
 * faking any of them.
 *
 * When the workspace switch is off the health endpoint keeps its diagnostics for administrators
 * only (the control plane asserts `settingsManage` then); a plain inbox holder sees the honest
 * closed state instead of a 403 stack trace.
 */

type DependencyRow = OmnichannelHealthView['dependencies'][number];
type RightRow = OmnichannelHealthView['callerRights'][number];

function DiagnosticsPanel() {
  const queryClient = useQueryClient();

  const capabilities = useQuery({
    queryKey: ['omnichannel', 'capabilities'],
    queryFn: () => api.omnichannelCapabilities(),
    staleTime: 30_000,
    retry: false,
  });
  const health = useQuery({
    queryKey: ['omnichannel', 'health'],
    queryFn: () => api.omnichannelHealth(),
    staleTime: 30_000,
    retry: false,
  });
  // The channel capability catalog (OM.4): the composer will enable or refuse from this answer.
  const channels = useQuery({
    queryKey: ['omnichannel', 'channels'],
    queryFn: () => api.omnichannelChannels(),
    staleTime: 30_000,
    retry: false,
  });

  const setWorkspace = useMutation({
    mutationFn: (enabled: boolean) => api.omnichannelSaveSettings({ features: { workspace: enabled } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['omnichannel'] });
    },
  });

  if (capabilities.isLoading) return <LoadingSkeleton rows={8} />;

  const granted = new Set(
    (capabilities.data?.capabilities ?? []).filter((entry) => entry.granted).map((entry) => entry.key),
  );
  const canAdmin = granted.has('settingsManage');

  if (!granted.has('inboxView')) {
    return <PermissionDenied hint={t('omnichannel.page.denied')} />;
  }

  // A closed workspace hides its diagnostics from non-administrators; the switch itself is an
  // administrator's endpoint, so an administrator still gets the page (and the way back in).
  if (health.isError && !canAdmin) {
    return (
      <>
        <PageHeader title={t('omnichannel.page.title')} />
        <Alert type="warning" showIcon message={t('omnichannel.page.disabled')} description={t('omnichannel.page.disabledHint')} />
      </>
    );
  }
  if (health.isLoading) return <LoadingSkeleton rows={8} />;
  if (health.data === undefined) {
    return <ErrorState message={t('omnichannel.page.loadFailed')} onRetry={() => void health.refetch()} />;
  }

  const view: OmnichannelHealthView = health.data;
  const workspace = view.features.find((feature) => feature.key === 'workspace')?.enabled === true;
  const missingRequired = view.dependencies.filter((dependency) => dependency.required && !dependency.present);

  const dependencyColumns: ColumnsType<DependencyRow> = [
    { title: t('omnichannel.page.col.dependency'), dataIndex: 'label' },
    { title: t('omnichannel.page.col.evidence'), dataIndex: 'evidence' },
    {
      title: t('omnichannel.page.col.status'),
      key: 'status',
      render: (_, row) => (
        <Space size={4}>
          <Tag color={row.present ? 'success' : row.required ? 'error' : 'warning'}>
            {row.present ? t('omnichannel.page.present') : t('omnichannel.page.missing')}
          </Tag>
          {!row.required ? <Tag>{t('omnichannel.page.optional')}</Tag> : null}
        </Space>
      ),
    },
  ];

  const rightColumns: ColumnsType<RightRow> = [
    { title: t('omnichannel.page.col.right'), dataIndex: 'label' },
    {
      title: t('omnichannel.page.col.status'),
      key: 'granted',
      render: (_, row) => (
        <Tag color={row.granted ? 'success' : 'default'}>
          {row.granted ? t('omnichannel.page.granted') : t('omnichannel.page.notGranted')}
        </Tag>
      ),
    },
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag color={view.workspaceReady ? 'success' : 'warning'}>
          {view.workspaceReady ? t('omnichannel.page.ready') : t('omnichannel.page.notReady')}
        </Tag>
        {canAdmin ? (
          <Space size={6}>
            <Typography.Text type="secondary">{t('omnichannel.page.workspaceSwitch')}</Typography.Text>
            <Switch
              checked={workspace}
              loading={setWorkspace.isPending}
              onChange={(enabled) => setWorkspace.mutate(enabled)}
              aria-label={t('omnichannel.page.workspaceSwitch')}
            />
          </Space>
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={() => void health.refetch()}>
          {t('omnichannel.page.reload')}
        </Button>
      </Space>

      {!workspace ? (
        <Alert type="warning" showIcon message={t('omnichannel.page.disabled')} description={t('omnichannel.page.disabledHint')} style={{ marginBottom: 16 }} />
      ) : null}
      {missingRequired.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={t('omnichannel.page.missingDependencies')}
          description={missingRequired.map((dependency) => dependency.label).join(', ')}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {view.settings.warnings.length > 0 ? (
        <Alert type="info" showIcon message={t('omnichannel.page.warnings')} description={view.settings.warnings.join(' ')} style={{ marginBottom: 16 }} />
      ) : null}

      <Alert
        type="info"
        showIcon
        message={t('omnichannel.page.comingSoon')}
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('omnichannel.page.pendingQueues')}</li>
            <li>{t('omnichannel.page.pendingRealtime')}</li>
            <li>{t('omnichannel.page.pendingHandoff')}</li>
          </ul>
        }
        style={{ marginBottom: 16 }}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title={t('omnichannel.page.dependencies')} size="small">
            <Table rowKey="id" size="small" pagination={false} columns={dependencyColumns} dataSource={[...view.dependencies]} />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card title={t('omnichannel.page.integrations')} size="small">
              <Space direction="vertical" size={4}>
                {view.optionalIntegrations.map((integration) => (
                  <Typography.Text key={integration.id}>
                    <Tag color={integration.present ? 'success' : 'default'}>
                      {integration.present ? t('omnichannel.page.present') : t('omnichannel.page.missing')}
                    </Tag>{' '}
                    {integration.label}
                  </Typography.Text>
                ))}
              </Space>
            </Card>
            <Card title={t('omnichannel.page.channels')} size="small">
              {channels.data === undefined ? (
                <Typography.Text type="secondary">{t('omnichannel.page.channelsPending')}</Typography.Text>
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {(channels.data as OmnichannelCapabilityCatalog).channels.map((channel) => (
                    <div key={channel.channel}>
                      <Space size={4} wrap>
                        <Typography.Text strong>{channel.channel}</Typography.Text>
                        <Tag color={channel.outbound ? 'success' : 'default'}>{t('omnichannel.page.channelOutbound')}</Tag>
                        <Tag color={channel.inbound ? 'success' : 'default'}>{t('omnichannel.page.channelInbound')}</Tag>
                        <Tag color={channel.templates ? 'success' : 'default'}>{t('omnichannel.page.channelTemplates')}</Tag>
                        <Tag color={channel.media ? 'success' : 'default'}>{t('omnichannel.page.channelMedia')}</Tag>
                      </Space>
                      {channel.notes.length > 0 ? (
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                          {channel.notes.join(' ')}
                        </Typography.Paragraph>
                      ) : null}
                    </div>
                  ))}
                </Space>
              )}
            </Card>
            <Card title={t('omnichannel.page.myRights')} size="small">
              <Table rowKey="key" size="small" pagination={false} columns={rightColumns} dataSource={[...view.callerRights]} />
            </Card>
            <Card title={t('omnichannel.page.module')} size="small">
              <Typography.Text type="secondary">
                {view.module.id} {view.module.version} · {t('omnichannel.page.phases')}: {view.module.implementedPhases.join(', ')}
              </Typography.Text>
            </Card>
          </Space>
        </Col>
      </Row>
    </>
  );
}

/**
 * Phase 19-OM.10 — the module page: the inbox is the daily surface, diagnostics stay one tab away
 * (an administrator can still see readiness, the channel catalog, dependencies and the settings).
 */
export function OmnichannelPage() {
  return (
    <>
      <PageHeader title={t('omnichannel.page.title')} subtitle={t('omnichannel.page.subtitle')} />
      <Tabs
        defaultActiveKey="inbox"
        items={[
          { key: 'inbox', label: t('omnichannel.page.tabInbox'), children: <InboxPanel /> },
          { key: 'diagnostics', label: t('omnichannel.page.tabDiagnostics'), children: <DiagnosticsPanel /> },
        ]}
      />
    </>
  );
}
