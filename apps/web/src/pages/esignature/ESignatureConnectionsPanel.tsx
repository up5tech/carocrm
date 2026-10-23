import { MoreOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Badge, Button, Card, Dropdown, Form, Input, Modal, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
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
  /** OAuth providers only. */
  clientSecret?: string;
  /** API-key providers only. */
  apiKey?: string;
}

interface SecretValues {
  kind: 'api_key' | 'client_secret' | 'webhook_secret';
  value: string;
}

export function ESignatureConnectionsPanel(props: { readonly canManage: boolean }) {
  const { message, modal } = AntApp.useApp();
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
  // Which credential the form asks for is the provider's answer, not the screen's assumption: an
  // OAuth provider needs a client secret and a redirect URI, an API-key provider needs only its key.
  const selectedProviderKey = Form.useWatch('providerKey', createForm);
  const selectedProvider = catalog.data?.providers.find((provider) => provider.key === selectedProviderKey);
  const apiKeyProvider = selectedProvider?.authStyle === 'api_key';
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
      title={
        <div>
          <div>{t('esignature.connections.title')}</div>
          <div style={{ marginTop: 2, color: '#737b85', fontSize: 12, fontWeight: 400 }}>{t('esignature.connections.hint')}</div>
        </div>
      }
      extra={
        <Space size={8} wrap>
          {rows.length === 0 ? null : <Tag>{t('esignature.connections.count', { count: rows.length })}</Tag>}
          <Tooltip title={t('core.common.reload')}>
            <Button size="small" icon={<ReloadOutlined />} aria-label={t('core.common.reload')} onClick={() => void connections.refetch()} />
          </Tooltip>
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
        <Space direction="vertical" size={14} style={{ width: '100%', alignItems: 'center' }}>
          <EmptyState title={t('esignature.connections.empty')} description={t('esignature.connections.emptyHint')} />
          {props.canManage ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('esignature.connections.emptyCta')}
            </Button>
          ) : null}
        </Space>
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
            // Disconnecting deletes credentials, so it asks twice: once in the menu, once in a
            // confirmation that names the consequence rather than a bare "are you sure".
            onDisconnect: (row) =>
              modal.confirm({
                title: t('esignature.connections.disconnectConfirm'),
                content: t('esignature.connections.disconnectConfirmHint'),
                okText: t('core.common.confirm'),
                cancelText: t('core.common.cancel'),
                okButtonProps: { danger: true },
                onOk: () => disconnect.mutate(row.id),
              }),
            onSecret: (row) => {
              setSecretTarget(row);
              const kind = row.authStyle === 'api_key' ? 'api_key' : 'client_secret';
              secretForm.setFieldsValue({ kind, value: '' });
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
          {selectedProvider === undefined ? null : (
            <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 16, fontSize: 12 }}>
              {selectedProvider.description}
            </Typography.Paragraph>
          )}
          <Form.Item
            name="environment"
            label={t('esignature.connections.fieldEnvironment')}
            extra={t('esignature.connections.environmentHint')}
            rules={[{ required: true }]}
          >
            {/* Two mutually exclusive environments, never a free choice: a segmented control says so
                at a glance, where a dropdown reads like a preference. */}
            <Segmented
              block
              options={[
                { value: 'demo', label: t('esignature.connections.environments.demo') },
                { value: 'production', label: t('esignature.connections.environments.production') },
              ]}
            />
          </Form.Item>
          {apiKeyProvider ? (
            <Form.Item
              name="apiKey"
              label={t('esignature.connections.fieldApiKey')}
              extra={t('esignature.connections.apiKeyHint')}
              rules={[{ required: true }]}
            >
              <Input.Password maxLength={512} autoComplete="new-password" />
            </Form.Item>
          ) : (
            <>
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
            </>
          )}
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
              options={
                secretTarget?.authStyle === 'api_key'
                  ? [{ value: 'api_key', label: t('esignature.connections.kinds.api_key') }]
                  : [
                      { value: 'client_secret', label: t('esignature.connections.kinds.client_secret') },
                      { value: 'webhook_secret', label: t('esignature.connections.kinds.webhook_secret') },
                    ]
              }
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
    onDisconnect: (row: ESignatureConnectionView) => void;
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
          <Typography.Text type="secondary" style={MONO_CAPTION} title={row.oauthClientId ?? t('esignature.connections.noClientId')}>
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
          <Space size={6} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t(`esignature.connections.authStyles.${row.authStyle ?? 'unknown'}`)}
            </Typography.Text>
            {row.providerStatus === 'declared' ? <Tag color="orange">{t('esignature.connections.providerNotInstalled')}</Tag> : null}
          </Space>
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
        <Space direction="vertical" size={4}>
          <Badge status={statusBadge(status)} text={t(`esignature.connections.statuses.${status}`)} />
          <Space size={[4, 4]} wrap>
            {row.isActive ? <Tag color="green">{t('esignature.connections.active')}</Tag> : <Tag>{t('esignature.connections.inactive')}</Tag>}
            {row.pendingAuthorization ? <Tag color="orange">{t('esignature.connections.pendingAuthorization')}</Tag> : null}
            <Tooltip title={t('esignature.connections.fakeAdapterNote', { mode: row.adapterMode })}>
              <Tag color={row.adapterMode === 'live' ? 'green' : row.adapterMode === 'fake' ? 'orange' : 'default'}>
                {t(`esignature.connections.adapterModes.${row.adapterMode}`)}
              </Tag>
            </Tooltip>
          </Space>
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
            <Typography.Text strong>{row.accountName ?? accountId}</Typography.Text>
            <Typography.Text type="secondary" style={MONO_CAPTION} title={accountId}>
              {row.accountId ?? accountId}
            </Typography.Text>
            {row.baseUri === null ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.baseUri}
              </Typography.Text>
            )}
            {(row.grantedScopes ?? []).length === 0 ? null : (
              <Space size={[4, 4]} wrap>
                {(row.grantedScopes ?? []).map((scope) => (
                  <Tag key={scope}>{scope}</Tag>
                ))}
              </Space>
            )}
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
            {row.credentials.length === 0 ? (
              <Typography.Text type="secondary">—</Typography.Text>
            ) : (
              row.credentials.map((entry) => (
                <Tooltip
                  key={entry.kind}
                  title={entry.expiresAt === null ? t(`esignature.connections.kinds.${entry.kind}`) : `${t(`esignature.connections.kinds.${entry.kind}`)} · ${entry.expiresAt}`}
                >
                  <Tag color={entry.state === 'active' ? 'green' : 'default'}>{t(`esignature.connections.kinds.${entry.kind}`)}</Tag>
                </Tooltip>
              ))
            )}
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
            width: 180,
            // One primary verb and a menu. Five equally weighted buttons made the destructive one
            // look like its neighbours; the verb an operator actually needs stays visible.
            render: (_unknown: unknown, row: ESignatureConnectionView) => (
              <Space size={4} wrap>
                {row.authStyle === 'api_key' ? (
                  // An API key has no consent screen; replacing the key is the only reconnection path, and
                  // the server re-validates it before the connection becomes usable again.
                  <Button size="small" type="primary" onClick={() => actions.onSecret(row)}>
                    {t('esignature.connections.replaceApiKey')}
                  </Button>
                ) : (
                  <Button size="small" type="primary" onClick={() => actions.onAuthorize(row.id)}>
                    {row.status === 'not_connected' ? t('esignature.connections.authorize') : t('esignature.connections.reauthorize')}
                  </Button>
                )}
                <Tooltip title={t('esignature.connections.moreActions')}>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'test', label: t('esignature.connections.test'), disabled: row.status !== 'connected' },
                        { key: 'toggle', label: row.isActive ? t('esignature.connections.disable') : t('esignature.connections.enable') },
                        ...(row.authStyle === 'api_key' ? [] : [{ key: 'secret', label: t('esignature.connections.rotateSecretAction') }]),
                        { type: 'divider' as const },
                        { key: 'disconnect', label: t('esignature.connections.disconnect'), danger: true },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'test') actions.onTest(row.id);
                        else if (key === 'toggle') actions.onToggle(row);
                        else if (key === 'secret') actions.onSecret(row);
                        else if (key === 'disconnect') actions.onDisconnect(row);
                      },
                    }}
                  >
                    <Button size="small" icon={<MoreOutlined />} aria-label={t('esignature.connections.moreActions')} />
                  </Dropdown>
                </Tooltip>
              </Space>
            ),
          },
        ]
      : []),
  ];
}

/**
 * The lifecycle as a status dot: success means "a send can go out through this connection".
 * Red is reserved for the two states that stop sends (`reauthorization_required`, `error`).
 */
function statusBadge(status: ESignatureConnectionView['status']): 'success' | 'error' | 'warning' | 'default' {
  if (status === 'connected') return 'success';
  if (status === 'reauthorization_required' || status === 'error') return 'error';
  if (status === 'not_connected') return 'warning';
  return 'default';
}

/** Identifiers and account ids read best in a fixed-width face at caption size. */
const MONO_CAPTION = {
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
} as const;
