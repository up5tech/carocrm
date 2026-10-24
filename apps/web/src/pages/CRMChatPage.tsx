import {
  BugOutlined,
  CustomerServiceOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Divider, Drawer, Form, Input, Modal, Radio, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api, ApiError } from '../api/client.js';
import type { CRMChatMessageView } from '../api/types.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { formatClock, formatDateTime, isSameCalendarDay, t } from '../state/i18n.js';
import { CRMChatComposer } from './crm-chat/CRMChatComposer.js';
import { CRMChatMessageList } from './crm-chat/CRMChatMessageList.js';

/**
 * The server state is kebab-case (`not-configured`); the catalog forbids hyphens in a key segment
 * (`KEY_RE` in `apps/api/src/i18n/i18n.service.ts`), so the label key uses underscores.
 */
function assistantStateKey(state: string): string {
  return `web.crmChat.assistantState.${state.replace(/-/g, '_')}`;
}

/** The state pill's tone. The label always says what the state is; the colour only reinforces it. */
function assistantStateTone(state: string): 'ready' | 'warn' | 'bad' {
  if (state === 'ready') return 'ready';
  return state === 'not-configured' ? 'warn' : 'bad';
}

/** The rail's stamp: the clock for today, the date for anything older. */
function railStamp(value: string): string {
  return isSameCalendarDay(value, new Date().toISOString())
    ? formatClock(value)
    : formatDateTime(value, false);
}

/** One letter for the conversation avatar; a thread without a title still gets a mark. */
function threadInitial(title: string | null): string {
  const first = (title ?? '').trim().charAt(0);
  return first === '' ? '#' : first;
}

/**
 * Phase 19-CHAT.2 — the CRM Chat workspace shell
 * (PLAN_Phase_19_CRM_Chat.md §6.1, §6.3, §17 `19-CHAT.2`).
 *
 * What this page is: the navigation surface, the state machine of "can this deployment chat at all?",
 * and the evidence for *why not* when it cannot. It issues two reads — capabilities and, on demand,
 * module health — and nothing else. It sends no message of its own: the composer does that.
 *
 * The layout is a conversation workspace — rail, transcript, docked composer — because that is the
 * shape of the task. The capability, feature-flag and module facts that used to fill four cards
 * below the thread are still one click away in the diagnostics drawer: they answer "why can't I
 * send?", which is a question asked when something is wrong, not while reading an answer.
 *
 * What this page is not: an authorization boundary. Every endpoint behind it is gated on the server,
 * so a caller who types the URL without the capability gets `AUTHORIZATION_DENIED`, and a caller with
 * the capability but a disabled workspace gets `FEATURE_DISABLED`.
 */
export function CRMChatPage() {
  usePageDocs('user/chat-and-voice');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [older, setOlder] = useState<readonly CRMChatMessageView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [search, setSearch] = useState('');
  const [composerReset, setComposerReset] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);

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
  const [executionMode, setExecutionMode] = useState<'queue' | 'inline'>('queue');
  const isAdmin = capabilities.data?.capabilities?.some((c) => c.key === 'admin' && c.granted) === true;

  const settingsQuery = useQuery({
    queryKey: ['crmChat', 'settings'],
    queryFn: () => api.crmChatSettings(),
    enabled: isAdmin,
    staleTime: 15_000,
    retry: false,
  });

  useEffect(() => {
    const settings = settingsQuery.data?.settings as
      | { assistant?: { agentKey?: string }; execution?: { mode?: string } }
      | undefined;
    const key = settings?.assistant?.agentKey;
    if (typeof key === 'string') setAssistantKey(key);
    if (settings?.execution?.mode === 'inline' || settings?.execution?.mode === 'queue') {
      setExecutionMode(settings.execution.mode);
    }
  }, [settingsQuery.data]);

  // The assistant is an AI Agent profile key, not a credential: list the published profiles so an
  // administrator picks one instead of typing a key from memory. The stored value stays the key.
  const assistantAgents = useQuery({
    queryKey: ['crmChat', 'assistantAgents'],
    queryFn: () => api.aiAgentsAgents({ status: 'published', maxSize: 50 }),
    enabled: showSettings && isAdmin,
    staleTime: 30_000,
    retry: false,
  });

  const agentOptions = (assistantAgents.data?.list ?? []).map((agent) => ({
    value: agent.key,
    label: `${agent.name} (${agent.key})`,
  }));
  // A configured key may no longer be published (or readable); keep it selectable so saving another
  // field never silently clears the current assistant.
  if (assistantKey !== '' && !agentOptions.some((option) => option.value === assistantKey)) {
    agentOptions.unshift({ value: assistantKey, label: assistantKey });
  }

  const saveSettings = useMutation({
    mutationFn: () =>
      api.crmChatUpdateSettings({
        assistant: { agentKey: assistantKey.trim() },
        execution: { mode: executionMode },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crmChat'] });
      setShowSettings(false);
    },
  });

  const health = useQuery({
    queryKey: ['crmChat', 'health'],
    queryFn: () => api.crmChatHealth(),
    enabled: detailsOpen,
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
      <div className="carocrm-workspace-page">
        <div className="carocrm-workspace-page-head">
          <div className="carocrm-workspace-page-head-main">
            <span className="carocrm-workspace-mark" aria-hidden="true">
              <CustomerServiceOutlined />
            </span>
            <div>
              <h1 className="carocrm-workspace-title">{t('web.crmChat.title')}</h1>
              <p className="carocrm-workspace-sub">{t('web.crmChat.subtitle')}</p>
            </div>
          </div>
        </div>
        <div className="carocrm-workspace carocrm-workspace--plain">
          <div className="carocrm-chat-hero">
            <span className="carocrm-chat-hero-mark" aria-hidden="true">
              <CustomerServiceOutlined />
            </span>
            <h2 className="carocrm-chat-hero-title">{t('web.crmChat.disabledTitle')}</h2>
            <p className="carocrm-chat-hero-hint">{t('web.crmChat.disabledHint')}</p>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.crmChat.disabledAdminHint')} <code>crmChat.features.workspace</code>
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {t('web.crmChat.moduleVersion', { version: data.module.version })}
            </Typography.Text>
          </div>
        </div>
      </div>
    );
  }

  // 19-CHAT.14 — the search box only appears when the search feature is actually effective. The
  // server refuses a search with the flag off, so the UI must not offer one.
  const searchEnabled = data.features.some((feature) => feature.key === 'conversationSearch' && feature.effective);
  // The rating buttons need both the feature and the `feedback` capability: the feature says the
  // deployment allows ratings, the capability says this caller may record one.
  const feedbackEnabled =
    data.features.some((feature) => feature.key === 'feedback' && feature.effective) &&
    data.capabilities.some((capability) => capability.key === 'feedback' && capability.granted);
  const promptsGranted = data.capabilities.some((capability) => capability.key === 'prompts' && capability.granted);

  const startNewConversation = (): void => {
    setSelectedId(undefined);
    setOlder([]);
    setCursor(null);
    setHasMore(false);
    setComposerReset((current) => current + 1);
  };

  const suggestions: readonly { key: string; label: string }[] = [
    { key: 'opportunities', label: t('web.crmChat.suggestion.opportunities') },
    { key: 'staleAccounts', label: t('web.crmChat.suggestion.staleAccounts') },
    { key: 'closingQuarter', label: t('web.crmChat.suggestion.closingQuarter') },
    { key: 'followUpEmail', label: t('web.crmChat.suggestion.followUpEmail') },
  ];

  const threadTitle =
    selectedId === undefined ? t('web.crmChat.threadTitle') : (detail.data?.conversation.title ?? t('web.crmChat.untitled'));
  const threadMeta =
    detail.data === undefined
      ? null
      : [
          detail.data.conversation.agentName,
          t('web.crmChat.messageCount', { count: detail.data.conversation.messageCount }),
          formatDateTime(detail.data.conversation.lastMessageAt, true),
        ]
          .filter((part) => part !== '')
          .join(' · ');

  return (
    <div className="carocrm-workspace-page">
      <div className="carocrm-workspace-page-head">
        <div className="carocrm-workspace-page-head-main">
          <span className="carocrm-workspace-mark" aria-hidden="true">
            <CustomerServiceOutlined />
          </span>
          <div>
            <h1 className="carocrm-workspace-title">{t('web.crmChat.title')}</h1>
            <p className="carocrm-workspace-sub">{t('web.crmChat.subtitle')}</p>
          </div>
          <span className={`carocrm-workspace-pill carocrm-workspace-pill--${assistantStateTone(data.assistant.state)}`}>
            {t(assistantStateKey(data.assistant.state))}
          </span>
        </div>
        <Space size={8}>
          {isAdmin ? (
            <Tooltip title={t('web.crmChat.settingsButton')}>
              <Button icon={<SettingOutlined />} aria-label={t('web.crmChat.settingsButton')} onClick={() => setShowSettings(true)} />
            </Tooltip>
          ) : null}
          <Tooltip title={t('web.crmChat.showDiagnostics')}>
            <Button
              icon={<BugOutlined />}
              aria-label={t('web.crmChat.showDiagnostics')}
              onClick={() => setDetailsOpen(true)}
            />
          </Tooltip>
          <Button
            icon={<ReloadOutlined />}
            loading={capabilities.isFetching}
            onClick={() => void capabilities.refetch()}
          >
            {t('core.common.refresh')}
          </Button>
        </Space>
      </div>

      <div className="carocrm-workspace">
        <aside className="carocrm-workspace-rail" aria-label={t('web.crmChat.conversationsTitle')}>
          <div className="carocrm-workspace-rail-head">
            {searchEnabled ? (
              <Input
                allowClear
                prefix={<SearchOutlined style={{ color: '#a1a8b3' }} />}
                variant="filled"
                value={search}
                maxLength={200}
                placeholder={t('web.crmChat.searchPlaceholder')}
                onChange={(event) => setSearch(event.target.value)}
              />
            ) : null}
            <Tooltip title={t('web.crmChat.newConversationHint')}>
              <Button type="primary" icon={<PlusOutlined />} block onClick={startNewConversation}>
                {t('web.crmChat.newConversation')}
              </Button>
            </Tooltip>
          </div>

          <div className="carocrm-workspace-rail-list">
            {conversations.isLoading ? (
              <div style={{ padding: '10px 6px' }}>
                <Skeleton active title={false} paragraph={{ rows: 4 }} />
              </div>
            ) : null}
            {conversations.isError ? (
              <ErrorState
                message={conversations.error instanceof Error ? conversations.error.message : undefined}
                onRetry={() => void conversations.refetch()}
              />
            ) : null}
            {conversations.data !== undefined && conversations.data.list.length === 0 ? (
              <div className="carocrm-workspace-rail-empty">
                <CustomerServiceOutlined />
                <strong>{t('web.crmChat.noConversations')}</strong>
                <span>{t('web.crmChat.noConversationsHint')}</span>
              </div>
            ) : null}
            {conversations.data?.list.map((conversation) => {
              const active = conversation.id === selectedId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={`carocrm-rail-item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <span className="carocrm-rail-avatar" aria-hidden="true">
                    {threadInitial(conversation.title)}
                  </span>
                  <span className="carocrm-rail-text">
                    <span className="carocrm-rail-name">
                      {conversation.title ?? t('web.crmChat.untitled')}
                    </span>
                    <span className="carocrm-rail-meta">
                      {t('web.crmChat.messageCount', { count: conversation.messageCount })}
                      {conversation.status === 'archived' ? ` · ${t('web.crmChat.archivedTag')}` : ''}
                    </span>
                  </span>
                  <span className="carocrm-rail-time">{railStamp(conversation.lastMessageAt)}</span>
                </button>
              );
            })}
          </div>

          <div className="carocrm-workspace-rail-foot">
            <span>{t('web.crmChat.limitConversations', { max: data.limits.maxConversationsPerUser })}</span>
            <span>{t('web.crmChat.privateByDefault')}</span>
          </div>
        </aside>

        <section className="carocrm-workspace-main">
          <div className="carocrm-workspace-toolbar">
            <span className="carocrm-convo-avatar carocrm-convo-avatar--assistant" aria-hidden="true">
              <RobotOutlined />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="carocrm-workspace-toolbar-title">{threadTitle}</div>
              {threadMeta === null ? null : <div className="carocrm-workspace-toolbar-sub">{threadMeta}</div>}
            </div>
          </div>

          <div className="carocrm-workspace-body">
            {!data.actions.canStartTurn ? (
              <Alert
                type="info"
                showIcon
                message={t('web.crmChat.notReadyTitle')}
                description={data.actions.reason ?? data.assistant.reason}
              />
            ) : null}

            {selectedId === undefined ? (
              <div className="carocrm-chat-hero">
                <span className="carocrm-chat-hero-mark" aria-hidden="true">
                  <ThunderboltOutlined />
                </span>
                <h2 className="carocrm-chat-hero-title">
                  {data.actions.canStartTurn ? t('web.crmChat.heroTitle') : t('web.crmChat.notReadyTitle')}
                </h2>
                <p className="carocrm-chat-hero-hint">
                  {data.actions.canStartTurn ? t('web.crmChat.heroHint') : t('web.crmChat.selectConversation')}
                </p>
                {data.actions.canStartTurn ? (
                  <div className="carocrm-chat-suggestions" aria-label={t('web.crmChat.suggestionsTitle')}>
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion.key}
                        type="button"
                        className="carocrm-chat-suggestion"
                        onClick={() => setPrefill({ text: suggestion.label, nonce: Date.now() })}
                      >
                        <ThunderboltOutlined aria-hidden="true" />
                        <span>{suggestion.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedId !== undefined && detail.isLoading ? (
              <div className="carocrm-workspace-scroll" aria-busy="true">
                <Skeleton active title={false} paragraph={{ rows: 6 }} />
              </div>
            ) : null}
            {selectedId !== undefined && detail.isError ? (
              <ErrorState
                message={detail.error instanceof Error ? detail.error.message : undefined}
                onRetry={() => void detail.refetch()}
              />
            ) : null}

            {selectedId !== undefined && detail.data !== undefined ? (
              <CRMChatMessageList
                conversationKey={selectedId}
                messages={detail.data.messages.list}
                olderMessages={older}
                hasMore={hasMore}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
                feedbackEnabled={feedbackEnabled}
              />
            ) : null}
          </div>

          <div className="carocrm-workspace-dock">
            <CRMChatComposer
              conversationId={selectedId}
              enabled={data.actions.canStartTurn}
              maxMessageChars={data.limits.maxMessageChars}
              turnTimeoutSeconds={data.limits.turnTimeoutSeconds}
              canManagePrompts={promptsGranted}
              resetSignal={composerReset}
              prefill={prefill}
              onTurnSubmitted={(result) => {
                // The first turn creates the conversation (contract D2); select it so the streamed
                // answer and the history render instead of leaving the thread empty.
                if (result.conversationId !== null) {
                  setSelectedId(result.conversationId);
                  setOlder([]);
                  setCursor(null);
                  setHasMore(false);
                }
              }}
            />
          </div>
        </section>
      </div>

      {/* Diagnostics: the capability, flag and module facts, plus the health checks. They explain
          *why* the assistant cannot answer, so they live behind one button instead of under the
          thread. */}
      <Drawer
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        width={440}
        title={t('web.crmChat.diagnosticsTitle')}
        extra={
          <Button size="small" loading={health.isFetching} onClick={() => void health.refetch()}>
            {t('core.common.refresh')}
          </Button>
        }
      >
        <div className="carocrm-chat-panel">
          {health.isLoading ? <LoadingSkeleton rows={4} /> : null}
          {health.isError ? (
            <ErrorState
              message={health.error instanceof Error ? health.error.message : undefined}
              onRetry={() => void health.refetch()}
            />
          ) : null}
          {health.data !== undefined ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {health.data.checks.map((check) => (
                <div key={check.name} className="carocrm-chat-fact">
                  <div>
                    <div className="carocrm-chat-fact-title">{check.name}</div>
                    <div className="carocrm-chat-fact-desc">{check.detail}</div>
                  </div>
                  <Tag color={check.ok ? 'green' : 'red'}>{check.ok ? t('web.crmChat.featureOn') : t('web.crmChat.featureOff')}</Tag>
                </div>
              ))}
              {health.data.settings.warnings.map((warning) => (
                <Alert key={warning} type="warning" showIcon message={warning} />
              ))}
            </Space>
          ) : null}
        </div>

        <div className="carocrm-chat-panel">
          <h3 className="carocrm-chat-panel-title">{t('web.crmChat.capabilitiesTitle')}</h3>
          {data.capabilities.map((capability) => (
            <div key={capability.key} className="carocrm-chat-fact">
              <div>
                <div className="carocrm-chat-fact-title">{capability.label}</div>
                <div className="carocrm-chat-fact-desc">{capability.description}</div>
              </div>
              <Tag color={capability.granted ? 'blue' : 'default'}>
                {capability.granted ? t('web.crmChat.granted') : t('web.crmChat.notGranted')}
              </Tag>
            </div>
          ))}
        </div>

        <div className="carocrm-chat-panel">
          <h3 className="carocrm-chat-panel-title">{t('web.crmChat.featuresTitle')}</h3>
          {data.features.map((feature) => (
            <div key={feature.key} className="carocrm-chat-fact">
              <div>
                <div className="carocrm-chat-fact-title">{feature.label}</div>
                <div className="carocrm-chat-fact-desc">{feature.description}</div>
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
        </div>

        <div className="carocrm-chat-panel">
          <h3 className="carocrm-chat-panel-title">{t('web.crmChat.moduleTitle')}</h3>
          <Descriptions size="small" column={1}>
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
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {t('web.crmChat.roadmapHint')}
          </Typography.Text>
        </div>
      </Drawer>

      <Modal
        open={showSettings}
        title={t('web.crmChat.settingsTitle')}
        onCancel={() => setShowSettings(false)}
        onOk={() => void saveSettings.mutate()}
        confirmLoading={saveSettings.isPending}
      >
        <Form layout="vertical">
          {assistantAgents.isError ? (
            <Alert
              type="error"
              showIcon
              message={t('web.crmChat.agentListFailed')}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Form.Item label={t('web.crmChat.agentFieldLabel')}>
            {assistantAgents.isError ? (
              // A Chat administrator without AI Agents read access can still set the key by hand;
              // the picker stays the default path whenever the list is readable.
              <Input
                value={assistantKey}
                onChange={(event) => setAssistantKey(event.target.value)}
                placeholder={t('web.crmChat.agentKeyInputPlaceholder')}
              />
            ) : (
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                loading={assistantAgents.isLoading}
                placeholder={t('web.crmChat.agentFieldPlaceholder')}
                value={assistantKey === '' ? undefined : assistantKey}
                options={agentOptions}
                onChange={(value?: string) => setAssistantKey(value ?? '')}
                notFoundContent={
                  assistantAgents.isLoading ? undefined : t('web.crmChat.agentFieldEmpty')
                }
              />
            )}
          </Form.Item>
          {settingsQuery.data?.warnings?.length ? (
            <Alert type="warning" showIcon message={settingsQuery.data.warnings.map((w) => w.message).join('; ')} />
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.crmChat.agentFieldHint')}
          </Typography.Text>
          <Divider style={{ margin: '16px 0' }} />
          <Form.Item label={t('web.crmChat.executionFieldLabel')}>
            <Radio.Group
              value={executionMode}
              onChange={(event) => setExecutionMode(event.target.value as 'queue' | 'inline')}
            >
              <Space direction="vertical" size={4}>
                <Radio value="queue">{t('web.crmChat.executionQueue')}</Radio>
                <Radio value="inline">{t('web.crmChat.executionInline')}</Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.crmChat.executionHint')}
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
