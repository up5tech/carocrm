import { CustomerServiceOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';import { Alert, Button, Card, Col, Descriptions, Divider, Empty, Form, Input, Modal, Result, Row, Space, Tag, Tooltip, Typography } from 'antd';import { useEffect, useState } from 'react';

import { api, ApiError } from '../api/client.js';
import type { CRMChatMessageView } from '../api/types.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { formatDateTime, t } from '../state/i18n.js';
import { CRMChatComposer } from './crm-chat/CRMChatComposer.js';
import { CRMChatMessageList } from './crm-chat/CRMChatMessageList.js';

/**
 * The server state is kebab-case (`not-configured`); the catalog forbids hyphens in a key segment
 * (`KEY_RE` in `apps/api/src/i18n/i18n.service.ts`), so the label key uses underscores.
 */
function assistantStateKey(state: string): string {
  return `web.crmChat.assistantState.${state.replace(/-/g, '_')}`;
}

/**
 * Phase 19-CHAT.2 — the CRM Chat workspace shell
 * (PLAN_Phase_19_CRM_Chat.md §6.1, §6.3, §17 `19-CHAT.2`).
 *
 * What this page is: the navigation surface, the state machine of "can this deployment chat at all?",
 * and the evidence for *why not* when it cannot. It issues two reads — capabilities and, on demand,
 * module health — and nothing else. It sends no message, because the conversation and turn APIs do not
 * exist yet (19-CHAT.4/19-CHAT.6) and a composer that silently discards input would be worse than a
 * composer that says so.
 *
 * What this page is not: an authorization boundary. Every endpoint behind it is gated on the server,
 * so a caller who types the URL without the capability gets `AUTHORIZATION_DENIED`, and a caller with
 * the capability but a disabled workspace gets `FEATURE_DISABLED`.
 */
export function CRMChatPage() {
  const [showHealth, setShowHealth] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [older, setOlder] = useState<readonly CRMChatMessageView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [search, setSearch] = useState('');

  const capabilities = useQuery({
    queryKey: ['crmChat', 'capabilities'],
    queryFn: () => api.crmChatCapabilities(),
    staleTime: 30_000,
    retry: false,
  });

  const workspaceEnabled = capabilities.data?.workspace.enabled === true;

  // 19-CHAT.4 — the caller's own threads. Reads only: a conversation is created by the first turn
  // (contract D2), which arrives with 19-CHAT.5, so there is nothing here that can write.
  // 19-CHAT.14 — `search` narrows the list to the caller's own threads; the server scopes the
  // match to the owner, so the term can never reach another user's conversation.
  const conversations = useQuery({
    queryKey: ['crmChat', 'conversations', search],
    queryFn: () => api.crmChatConversations({ maxSize: 50, ...(search === '' ? {} : { q: search }) }),
    enabled: workspaceEnabled,
    staleTime: 15_000,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ['crmChat', 'conversation', selectedId],
    queryFn: () => api.crmChatConversation(selectedId as string),
    enabled: selectedId !== undefined && workspaceEnabled,
    staleTime: 10_000,
    retry: false,
  });

  // A newly opened thread starts at its newest page; "older" is appended in front of it.
  useEffect(() => {
    if (detail.data === undefined) return;
    setOlder([]);
    setCursor(detail.data.messages.nextBefore);
    setHasMore(detail.data.messages.hasMore);
  }, [detail.data]);

  const loadOlder = async (): Promise<void> => {
    if (selectedId === undefined || cursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await api.crmChatConversationMessages(selectedId, { before: cursor });
      setOlder((current) => [...page.list, ...current]);
      setCursor(page.nextBefore);
      setHasMore(page.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  };

  const queryClient = useQueryClient();
  const [showSettings, setShowSettings] = useState(false);
  const [assistantKey, setAssistantKey] = useState('');
  const isAdmin = capabilities.data?.capabilities?.some((c) => c.key === 'admin' && c.granted) === true;

  const settingsQuery = useQuery({
    queryKey: ['crmChat', 'settings'],
    queryFn: () => api.crmChatSettings(),
    enabled: isAdmin,
    staleTime: 15_000,
    retry: false,
  });

  useEffect(() => {
    const key = (settingsQuery.data?.settings as { assistant?: { agentKey?: string } } | undefined)?.assistant?.agentKey;
    if (typeof key === 'string') setAssistantKey(key);
  }, [settingsQuery.data]);

  const saveSettings = useMutation({
    mutationFn: () => api.crmChatUpdateSettings({ assistant: { agentKey: assistantKey.trim() } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crmChat'] });
      setShowSettings(false);
    },
  });

  const health = useQuery({
    queryKey: ['crmChat', 'health'],
    queryFn: () => api.crmChatHealth(),
    enabled: showHealth,
    staleTime: 15_000,
    retry: false,
  });
  if (capabilities.isLoading) return <LoadingSkeleton rows={10} />;
  if (capabilities.isError) {
    if (capabilities.error instanceof ApiError && capabilities.error.status === 403) {
      return <PermissionDenied hint={t('web.crmChat.permissionDeniedHint')} />;
    }
    return (
      <ErrorState
        message={capabilities.error instanceof Error ? capabilities.error.message : undefined}
        onRetry={() => void capabilities.refetch()}
      />
    );
  }
  if (capabilities.data === undefined) return <LoadingSkeleton rows={10} />;

  const data = capabilities.data;

  if (!data.workspace.enabled) {
    return (
      <div>
        <div className="carocrm-page-head">
          <div>
            <h1 className="carocrm-page-title">{t('web.crmChat.title')}</h1>
            <p className="carocrm-page-sub">{t('web.crmChat.subtitle')}</p>
          </div>
        </div>
        <Card className="carocrm-card">
          <Result
            status="warning"
            title={t('web.crmChat.disabledTitle')}
            subTitle={t('web.crmChat.disabledHint')}
            extra={
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary">
                  {t('web.crmChat.disabledAdminHint')} <code>crmChat.features.workspace</code>
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.crmChat.moduleVersion', { version: data.module.version })}
                </Typography.Text>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  const assistantReady = data.assistant.state === 'ready';
  const stateTone = assistantReady ? 'green' : data.assistant.state === 'not-configured' ? 'gold' : 'red';

  // 19-CHAT.14 — the search box only appears when the search feature is actually effective. The
  // server refuses a search with the flag off, so the UI must not offer one.
  const searchEnabled = data.features.some((feature) => feature.key === 'conversationSearch' && feature.effective);
  // The rating buttons need both the feature and the `feedback` capability: the feature says the
  // deployment allows ratings, the capability says this caller may record one.
  const feedbackEnabled =
    data.features.some((feature) => feature.key === 'feedback' && feature.effective) &&
    data.capabilities.some((capability) => capability.key === 'feedback' && capability.granted);
  const promptsGranted = data.capabilities.some((capability) => capability.key === 'prompts' && capability.granted);

  return (
    <div>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.crmChat.title')}</h1>
          <p className="carocrm-page-sub">{t('web.crmChat.subtitle')}</p>
        </div>
        <Space>
          <Tag color={stateTone}>{t(assistantStateKey(data.assistant.state))}</Tag>
          {isAdmin ? (
            <Button onClick={() => setShowSettings(true)}>{t('web.crmChat.settingsButton')}</Button>
          ) : null}
          <Button
            icon={<ReloadOutlined />}
            loading={capabilities.isFetching}
            onClick={() => void capabilities.refetch()}
          >
            {t('core.common.refresh')}
          </Button>
          <Button onClick={() => setShowHealth((current) => !current)}>
            {showHealth ? t('web.crmChat.hideDiagnostics') : t('web.crmChat.showDiagnostics')}
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8} xl={7}>
          <Card
            className="carocrm-card"
            title={t('web.crmChat.conversationsTitle')}
            extra={
              <Tooltip title={t('web.crmChat.newConversationUnavailable')}>
                <Button size="small" disabled>
                  {t('web.crmChat.newConversation')}
                </Button>
              </Tooltip>
            }
          >
            {searchEnabled ? (
              <Input.Search
                allowClear
                size="small"
                value={search}
                maxLength={200}
                placeholder={t('web.crmChat.searchPlaceholder')}
                onChange={(event) => setSearch(event.target.value)}
                style={{ marginBottom: 8 }}
              />
            ) : null}

            {conversations.isLoading ? <LoadingSkeleton rows={4} /> : null}
            {conversations.isError ? (
              <ErrorState
                message={conversations.error instanceof Error ? conversations.error.message : undefined}
                onRetry={() => void conversations.refetch()}
              />
            ) : null}
            {conversations.data !== undefined && conversations.data.list.length === 0 ? (
              <Result
                icon={<CustomerServiceOutlined style={{ color: '#bfc6d3' }} />}
                title={<Typography.Text strong>{t('web.crmChat.noConversations')}</Typography.Text>}
                subTitle={<Typography.Text type="secondary">{t('web.crmChat.noConversationsHint')}</Typography.Text>}
                style={{ padding: '8px 0' }}
              />
            ) : null}
            {conversations.data !== undefined && conversations.data.list.length > 0 ? (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                {conversations.data.list.map((conversation) => (
                  <Button
                    key={conversation.id}
                    type={conversation.id === selectedId ? 'primary' : 'text'}
                    block
                    onClick={() => setSelectedId(conversation.id)}
                    style={{ textAlign: 'left', height: 'auto', padding: '6px 8px' }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, whiteSpace: 'normal' }}>
                      <span>{conversation.title ?? t('web.crmChat.untitled')}</span>
                      <Typography.Text
                        {...(conversation.id === selectedId ? {} : { type: 'secondary' as const })}
                        style={{ fontSize: 11 }}
                      >
                        {formatDateTime(conversation.lastMessageAt, false)} ·{' '}
                        {t('web.crmChat.messageCount', { count: conversation.messageCount })}
                        {conversation.status === 'archived' ? ` · ${t('web.crmChat.archivedTag')}` : ''}
                      </Typography.Text>
                    </div>
                  </Button>
                ))}
              </Space>
            ) : null}
            <Divider style={{ margin: '8px 0' }} />
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.crmChat.limitConversations', { max: data.limits.maxConversationsPerUser })}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.crmChat.privateByDefault')}
              </Typography.Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={16} xl={17}>
          <Card
            className="carocrm-card"
            title={
              selectedId === undefined
                ? t('web.crmChat.threadTitle')
                : (detail.data?.conversation.title ?? t('web.crmChat.untitled'))
            }
          >
            {!data.actions.canStartTurn ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={t('web.crmChat.notReadyTitle')}
                description={data.actions.reason ?? data.assistant.reason}
              />
            ) : null}

            {selectedId === undefined ? (
              <Empty
                image={<CustomerServiceOutlined style={{ color: '#bfc6d3', fontSize: 40 }} />}
                description={<Typography.Text type="secondary">{t('web.crmChat.selectConversation')}</Typography.Text>}
                style={{ padding: '8px 0' }}
              />
            ) : null}

            {selectedId !== undefined && detail.isLoading ? <LoadingSkeleton rows={6} /> : null}
            {selectedId !== undefined && detail.isError ? (
              <ErrorState
                message={detail.error instanceof Error ? detail.error.message : undefined}
                onRetry={() => void detail.refetch()}
              />
            ) : null}

            {detail.data !== undefined ? (
              <div>
                <CRMChatMessageList
                  messages={detail.data.messages.list}
                  olderMessages={older}
                  hasMore={hasMore}
                  loadingOlder={loadingOlder}
                  onLoadOlder={loadOlder}
                  feedbackEnabled={feedbackEnabled}
                />
              </div>
            ) : null}

            {/* Composer - enabled when assistant is ready */}
            <div style={{ marginTop: 16 }}>
              <CRMChatComposer
                conversationId={selectedId}
                enabled={data.actions.canStartTurn && selectedId !== undefined}
                maxMessageChars={data.limits.maxMessageChars}
                turnTimeoutSeconds={data.limits.turnTimeoutSeconds}
                canManagePrompts={promptsGranted}
                onTurnSubmitted={() => {
                  // Refresh conversation detail after turn submission.
                  void detail.refetch();
                }}
              />
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card className="carocrm-card" title={t('web.crmChat.capabilitiesTitle')}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {data.capabilities.map((capability) => (
                <div
                  key={capability.key}
                  style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}
                >
                  <div>
                    <Typography.Text strong>{capability.label}</Typography.Text>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {capability.description}
                      </Typography.Text>
                    </div>
                  </div>
                  <Tag color={capability.granted ? 'blue' : 'default'}>
                    {capability.granted ? t('web.crmChat.granted') : t('web.crmChat.notGranted')}
                  </Tag>
                </div>
              ))}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card className="carocrm-card" title={t('web.crmChat.featuresTitle')}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {data.features.map((feature) => (
                <div
                  key={feature.key}
                  style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}
                >
                  <div>
                    <Typography.Text strong>{feature.label}</Typography.Text>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {feature.description}
                      </Typography.Text>
                    </div>
                    <Typography.Text code style={{ fontSize: 11 }}>
                      {feature.settingsPath}
                    </Typography.Text>
                  </div>
                  <Tag color={feature.effective ? 'green' : feature.enabled ? 'gold' : 'default'}>
                    {feature.effective
                      ? t('web.crmChat.featureOn')
                      : feature.enabled
                        ? t('web.crmChat.featureInactive')
                        : t('web.crmChat.featureOff')}
                  </Tag>
                </div>
              ))}
            </Space>
          </Card>
        </Col>

        <Col xs={24}>
          <Card className="carocrm-card" title={t('web.crmChat.moduleTitle')}>
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label={t('web.crmChat.moduleVersionLabel')}>{data.module.version}</Descriptions.Item>
              <Descriptions.Item label={t('web.crmChat.moduleApiLabel')}>
                <Typography.Text code>{data.module.apiPrefix}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('web.crmChat.moduleRouteLabel')}>
                <Typography.Text code>{data.module.frontendRoute}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('web.crmChat.modulePhasesLabel')}>
                <Space size={4} wrap>
                  {data.module.implementedPhases.map((phase) => (
                    <Tag key={phase}>{phase}</Tag>
                  ))}
                </Space>
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '12px 0' }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.crmChat.roadmapHint')}
            </Typography.Text>
          </Card>
        </Col>

        {showHealth ? (
          <Col xs={24}>
            <Card
              className="carocrm-card"
              title={t('web.crmChat.diagnosticsTitle')}
              extra={
                <Button size="small" loading={health.isFetching} onClick={() => void health.refetch()}>
                  {t('core.common.refresh')}
                </Button>
              }
            >
              {health.isLoading ? <LoadingSkeleton rows={4} /> : null}
              {health.isError ? (
                <ErrorState
                  message={health.error instanceof Error ? health.error.message : undefined}
                  onRetry={() => void health.refetch()}
                />
              ) : null}
              {health.data !== undefined ? (
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {health.data.checks.map((check) => (
                    <div key={check.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <Tag color={check.ok ? 'green' : 'red'}>{check.name}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {check.detail}
                      </Typography.Text>
                    </div>
                  ))}
                  {health.data.settings.warnings.map((warning) => (
                    <Alert key={warning} type="warning" showIcon message={warning} />
                  ))}
                </Space>
              ) : null}
            </Card>
          </Col>
        ) : null}
      </Row>
      <Modal
        open={showSettings}
        title={t('web.crmChat.settingsTitle')}        onCancel={() => setShowSettings(false)}
        onOk={() => void saveSettings.mutate()}
        confirmLoading={saveSettings.isPending}
      >
        <Form layout="vertical">
          <Form.Item label="Assistant agent key">
            <Input value={assistantKey} onChange={(e) => setAssistantKey(e.target.value)} placeholder="my-assistant-agent" />
          </Form.Item>
          {settingsQuery.data?.warnings?.length ? (
            <Alert type="warning" showIcon message={settingsQuery.data.warnings.map((w) => w.message).join('; ')} />
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Enable AI Agents execution & memory in AI Agents settings, and publish an agent with conversation memory.
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}