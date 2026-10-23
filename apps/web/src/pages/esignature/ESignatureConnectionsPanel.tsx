import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { ESignatureConnectionTest, ESignatureConnectionView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.4 — the provider connections panel
 * (`PLAN_Phase_19_ESignature.md` §8.1, §13.4).
 *
 * The screen an administrator stands on to make the module's acceptance testable: create a connection,
 * authorize it, test it, switch it, disconnect it. Two rules it exists to keep visible:
 *
 *  - **A secret is entered, never shown.** The client secret field exists only in the create dialog and
 *    the rotate dialog; the table renders a credential *inventory* — kind, state, expiry — because that
 *    is what an operator acts on, and plan §8.1 forbids a read path that returns a value.
 *  - **A connection is not a toggle.** The status column is the server's lifecycle answer
 *    (`reauthorization_required` means sends are stopped), and the adapter tag says whether a fake or a
 *    live integration answered — a green tick from a fake must never read as DocuSign.
 *
 * Nothing here enforces anything: every verb is checked against `connectionManage` on the server.
 */

interface CreateValues {
  providerKey: string;
  name: string;
  environment: 'demo' | 'production';
  oauthClientId?: string;
  redirectUri?: string;
  clientSecret: string;
}

interface SecretValues {
  kind: 'client_secret' | 'webhook_secret';
  value: string;
}

export function ESignatureConnectionsPanel(props: { readonly canManage: boolean }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [createForm] = Form.useForm<CreateValues>();
  const [secretForm] = Form.useForm<SecretValues>();
  const [creating, setCreating] = useState(false);
  const [secretTarget, setSecretTarget] = useState<ESignatureConnectionView | null>(null);
  const [lastTest, setLastTest] = useState<ESignatureConnectionTest | null>(null);

  const connections = useQuery({
    queryKey: ['eSignature', 'connections'],
    queryFn: () => api.eSignatureConnections(),
    staleTime: 15_000,
  });

  // The provider picker is data, not a hard-coded list: a cataloged provider whose integration is
  // not installed appears greyed out with the reason, instead of failing after the admin fills a form.
  const catalog = useQuery({
    queryKey: ['eSignature', 'providerCatalog'],
    queryFn: () => api.eSignatureProviderCatalog(),
    staleTime: 300_000,
  });
  const providerOptions = (catalog.data?.providers ?? []).map((provider) => ({
    value: provider.key,
    disabled: provider.integrationStatus !== 'available',
    label:
      provider.integrationStatus === 'available'
        ? provider.label
        : `${provider.label} · ${t('esignature.connections.providerNotInstalled')}`,
  }));

  const reload = () => void queryClient.invalidateQueries({ queryKey: ['eSignature', 'connections'] });

  const create = useMutation({
    mutationFn: (values: CreateValues) => api.createESignatureConnection({ ...values }),
    onSuccess: () => {
      setCreating(false);
      createForm.resetFields();
      message.success(t('esignature.connections.created'));
      reload();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const authorize = useMutation({
    mutationFn: (id: string) => api.authorizeESignatureConnection(id),
    onSuccess: (started) => {
      // The provider's consent screen is a top-level navigation, not a popup: DocuSign redirects the
      // browser back to this platform, and a blocked popup would strand the flow.
      window.location.assign(started.authorizationUrl);
    },
    onError: (error: Error) => message.error(error.message),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testESignatureConnection(id),
    onSuccess: (result) => {
      setLastTest(result);
      reload();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const setActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) => api.setESignatureConnectionActive(input.id, input.active),
    onSuccess: () => {
      message.success(t('esignature.connections.updated'));
      reload();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnectESignatureConnection(id),
    onSuccess: (result) => {
      message.success(
        result.hadRequests
          ? t('esignature.connections.disconnectedWithHistory', { credentials: result.credentialsRemoved })
          : t('esignature.connections.disconnected', { credentials: result.credentialsRemoved }),
      );
      reload();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const saveSecret = useMutation({
    mutationFn: (values: SecretValues) => api.storeESignatureConnectionSecret(secretTarget?.id ?? '', values.kind, values.value),
    onSuccess: () => {
      setSecretTarget(null);
      secretForm.resetFields();
      message.success(t('esignature.connections.secretStored'));
      reload();
    },
    onError: (error: Error) => message.error(error.message),
  });

  if (connections.isLoading) return <LoadingSkeleton rows={4} />;
  if (connections.isError || connections.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.connections.loadFailed')} ${connections.error instanceof Error ? connections.error.message : ''}`}
        onRetry={() => void connections.refetch()}
      />
    );
  }
  const rows = [...connections.data];

  return (
    <Card
      className="carocrm-card"
      title={t('esignature.connections.title')}
      extra={
        <Space size={8}>
          <Button size="small" onClick={() => void connections.refetch()}>
            {t('core.common.reload')}
          </Button>
          {props.canManage ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('esignature.connections.create')}
            </Button>
          ) : null}
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {rows.length === 0 ? (
        <EmptyState title={t('esignature.connections.empty')} description={t('esignature.connections.emptyHint')} />
      ) : (
        <Table<ESignatureConnectionView>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={rows}
          columns={columns(props.canManage, {
            onAuthorize: (id) => authorize.mutate(id),
            onTest: (id) => test.mutate(id),
            onToggle: (row) => setActive.mutate({ id: row.id, active: !row.isActive }),
            onDisconnect: (id) => disconnect.mutate(id),
            onSecret: (row) => {
              setSecretTarget(row);
              secretForm.setFieldsValue({ kind: 'client_secret', value: '' });
            },
          })}
        />
      )}

      {lastTest === null ? null : (
        <Alert
          type={lastTest.reachable ? 'success' : 'error'}
          showIcon
          style={{ marginTop: 12 }}
          message={lastTest.reachable ? t('esignature.connections.testOk') : t('esignature.connections.testFailed', { code: lastTest.detailCode })}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t(`esignature.connections.environments.${lastTest.environment}`)} · {lastTest.checkedAt}
              </Typography.Text>
              {lastTest.adapterMode === 'live' ? null : (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  {t('esignature.connections.fakeAdapterNote', { mode: lastTest.adapterMode })}
                </Typography.Text>
              )}
            </Space>
          }
          onClose={() => setLastTest(null)}
          closable
        />
      )}

      <Modal
        open={creating}
        title={t('esignature.connections.create')}
        okText={t('core.common.save')}
        cancelText={t('core.common.cancel')}
        confirmLoading={create.isPending}
        onCancel={() => setCreating(false)}
        onOk={() => void createForm.submit()}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ environment: 'demo', providerKey: 'docusign' }}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item
            name="providerKey"
            label={t('esignature.connections.fieldProvider')}
            extra={t('esignature.connections.providerHint')}
            rules={[{ required: true }]}
          >
            <Select options={providerOptions} loading={catalog.isLoading} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="name" label={t('esignature.connections.fieldName')} rules={[{ required: true }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item
            name="environment"
            label={t('esignature.connections.fieldEnvironment')}
            extra={t('esignature.connections.environmentHint')}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'demo', label: t('esignature.connections.environments.demo') },
                { value: 'production', label: t('esignature.connections.environments.production') },
              ]}
            />
          </Form.Item>
          <Form.Item name="oauthClientId" label={t('esignature.connections.fieldClientId')} extra={t('esignature.connections.clientIdHint')}>
            <Input maxLength={128} placeholder="b8f0…" autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item name="redirectUri" label={t('esignature.connections.fieldRedirectUri')} extra={t('esignature.connections.redirectUriHint')}>
            <Input maxLength={500} placeholder="https://crm.example.com/api/v1/ESignature/oauth/callback" autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item
            name="clientSecret"
            label={t('esignature.connections.fieldClientSecret')}
            extra={t('esignature.connections.secretHint')}
            rules={[{ required: true }]}
          >
            <Input.Password maxLength={512} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={secretTarget !== null}
        title={t('esignature.connections.rotateSecret', { name: secretTarget?.name ?? '' })}
        okText={t('core.common.save')}
        cancelText={t('core.common.cancel')}
        confirmLoading={saveSecret.isPending}
        onCancel={() => setSecretTarget(null)}
        onOk={() => void secretForm.submit()}
        destroyOnHidden
      >
        <Form form={secretForm} layout="vertical" onFinish={(values) => saveSecret.mutate(values)}>
          <Form.Item name="kind" label={t('esignature.connections.credentialKind')}>
            <Select
              options={[
                { value: 'client_secret', label: t('esignature.connections.kinds.client_secret') },
                { value: 'webhook_secret', label: t('esignature.connections.kinds.webhook_secret') },
              ]}
            />
          </Form.Item>
          <Form.Item name="value" label={t('esignature.connections.fieldSecretValue')} rules={[{ required: true }]}>
            <Input.Password maxLength={512} autoComplete="new-password" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('esignature.connections.secretWriteOnly')}
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}

function columns(
  canManage: boolean,
  actions: {
    onAuthorize: (id: string) => void;
    onTest: (id: string) => void;
    onToggle: (row: ESignatureConnectionView) => void;
    onDisconnect: (id: string) => void;
    onSecret: (row: ESignatureConnectionView) => void;
  },
): ColumnsType<ESignatureConnectionView> {
  return [
    {
      title: t('esignature.connections.columnConnection'),
      dataIndex: 'name',
      render: (name: string, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.oauthClientId ?? t('esignature.connections.noClientId')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('esignature.connections.columnProvider'),
      dataIndex: 'providerKey',
      width: 160,
      render: (_key: string, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text>{row.providerLabel}</Typography.Text>
          {row.providerStatus === 'declared' ? <Tag color="orange">{t('esignature.connections.providerNotInstalled')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('esignature.connections.columnEnvironment'),
      dataIndex: 'environment',
      width: 120,
      render: (environment: string) => <Tag color={environment === 'production' ? 'red' : 'blue'}>{t(`esignature.connections.environments.${environment}`)}</Tag>,
    },
    {
      title: t('esignature.connections.columnState'),
      dataIndex: 'status',
      width: 200,
      render: (status: ESignatureConnectionView['status'], row) => (
        <Space size={[4, 4]} wrap>
          <Tag color={statusColor(status)}>{t(`esignature.connections.statuses.${status}`)}</Tag>
          {row.isActive ? <Tag color="green">{t('esignature.connections.active')}</Tag> : <Tag>{t('esignature.connections.inactive')}</Tag>}
          {row.pendingAuthorization ? <Tag color="orange">{t('esignature.connections.pendingAuthorization')}</Tag> : null}
          {row.adapterMode === 'live' ? null : <Tag title={t('esignature.connections.fakeAdapterNote', { mode: row.adapterMode })}>{row.adapterMode}</Tag>}
        </Space>
      ),
    },
    {
      title: t('esignature.connections.columnAccount'),
      dataIndex: 'accountId',
      render: (accountId: string | null, row) =>
        accountId === null ? (
          <Typography.Text type="secondary">{t('esignature.connections.notAuthorized')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={2}>
            <Typography.Text>{row.accountName ?? accountId}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.baseUri ?? ''}
            </Typography.Text>
            <Space size={[4, 4]} wrap>
              {(row.grantedScopes ?? []).map((scope) => (
                <Tag key={scope}>{scope}</Tag>
              ))}
            </Space>
          </Space>
        ),
    },
    {
      title: t('esignature.connections.columnCredentials'),
      dataIndex: 'credentials',
      width: 200,
      render: (_credentials: ESignatureConnectionView['credentials'], row) => (
        <Space direction="vertical" size={2}>
          <Space size={[4, 4]} wrap>
            {row.credentials.map((entry) => (
              <Tag key={entry.kind} color={entry.state === 'active' ? 'green' : 'default'} title={entry.expiresAt ?? undefined}>
                {t(`esignature.connections.kinds.${entry.kind}`)}
              </Tag>
            ))}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.lastSuccessfulApiAt === null
              ? t('esignature.connections.neverTested')
              : `${t('esignature.connections.lastTest')} ${row.lastSuccessfulApiAt}`}
          </Typography.Text>
        </Space>
      ),
    },
    ...(canManage
      ? [
          {
            title: t('esignature.connections.columnActions'),
            key: 'actions',
            width: 320,
            render: (_unknown: unknown, row: ESignatureConnectionView) => (
              <Space size={4} wrap>
                <Button size="small" type="primary" onClick={() => actions.onAuthorize(row.id)}>
                  {row.status === 'not_connected' ? t('esignature.connections.authorize') : t('esignature.connections.reauthorize')}
                </Button>
                <Button size="small" disabled={row.status !== 'connected'} onClick={() => actions.onTest(row.id)}>
                  {t('esignature.connections.test')}
                </Button>
                <Button size="small" onClick={() => actions.onToggle(row)}>
                  {row.isActive ? t('esignature.connections.disable') : t('esignature.connections.enable')}
                </Button>
                <Button size="small" onClick={() => actions.onSecret(row)}>
                  {t('esignature.connections.rotateSecretAction')}
                </Button>
                <Popconfirm
                  title={t('esignature.connections.disconnectConfirm')}
                  description={t('esignature.connections.disconnectConfirmHint')}
                  okText={t('core.common.confirm')}
                  cancelText={t('core.common.cancel')}
                  onConfirm={() => actions.onDisconnect(row.id)}
                >
                  <Button size="small" danger>
                    {t('esignature.connections.disconnect')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ];
}

function statusColor(status: ESignatureConnectionView['status']): string {
  if (status === 'connected') return 'green';
  if (status === 'reauthorization_required' || status === 'error') return 'red';
  if (status === 'disabled') return 'orange';
  return 'default';
}
