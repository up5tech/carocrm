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
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { CRMChatMessageView } from '../api/types.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { usePageTitle } from '../components/PageHeader.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { formatClock, formatDateTime, isSameCalendarDay, t } from '../state/i18n.js';
import { CRMChatComposer } from './crm-chat/CRMChatComposer.js';
import { CRMChatDiagnosticsDrawer } from './crm-chat/CRMChatDiagnosticsDrawer.js';
import { CRMChatMessageList } from './crm-chat/CRMChatMessageList.js';
import { CRMChatSettingsModal } from './crm-chat/CRMChatSettingsModal.js';
import { CRMChatSuggestions } from './crm-chat/CRMChatSuggestions.js';

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
 * (plans/PLAN_Phase_19_CRM_Chat.md §6.1, §6.3, §17 `19-CHAT.2`; decomposed in 19-CHAT.31).
 *
 * What this page is: the navigation surface, the state machine of "can this deployment chat at all?",
 * and the evidence for *why not* when it cannot. It issues two reads — capabilities and, on demand,
 * module health — and nothing else. It sends no message of its own: the composer does that.
 *
 * The layout is a conversation workspace — rail, transcript, docked composer — because that is the
 * shape of the task. The capability, feature-flag and module facts that used to fill four cards
 * below the thread are still one click away in the diagnostics drawer
 * (`CRMChatDiagnosticsDrawer`): they answer "why can't I send?", which is a question asked when
 * something is wrong, not while reading an answer. The administrator settings modal is
 * `CRMChatSettingsModal`.
 *
 * What this page is not: an authorization boundary. Every endpoint behind it is gated on the server,
 * so a caller who types the URL without the capability gets `AUTHORIZATION_DENIED`, and a caller with
 * the capability but a disabled workspace gets `FEATURE_DISABLED`.
 */
export function CRMChatPage() {
  usePageTitle(t('web.crmChat.title'));
  usePageDocs('user/chat-and-voice');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [older, setOlder] = useState<readonly CRMChatMessageView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [search, setSearch] = useState('');
  const [composerReset, setComposerReset] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);

  // P2 inline entry points (record/email/briefing) land here as `?ask=…`: prefill the composer
  // once, then drop the param so a refresh does not re-prefill. Sending still needs one click.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const ask = searchParams.get('ask');
    if (ask === null || ask.trim() === '') return;
    setPrefill({ text: ask, nonce: Date.now() });
    const next = new URLSearchParams(searchParams);
    next.delete('ask');
    setSearchParams(next, { replace: true });
  }, []);

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

  const isAdmin = capabilities.data?.capabilities?.some((c) => c.key === 'admin' && c.granted) === true;

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

  // G38 — a turn is refused for one of two different reasons, and the title has to name the right one:
  // "the assistant is not ready" would blame an agent configuration the administrator never touched
  // when the actual cause is the Grounded-CRM-answers switch.
  const readToolsEffective = data.features.some((feature) => feature.key === 'readTools' && feature.effective);
  const blockedTitle = readToolsEffective ? t('web.crmChat.notReadyTitle') : t('web.crmChat.gatedTitle');

  const startNewConversation = (): void => {
    setSelectedId(undefined);
    setOlder([]);
    setCursor(null);
    setHasMore(false);
    setComposerReset((current) => current + 1);
  };

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
                prefix={<SearchOutlined style={{ color: 'var(--carocrm-ink-faint)' }} />}
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
                message={blockedTitle}
                description={data.actions.reason ?? data.assistant.reason}
              />
            ) : null}

            {selectedId === undefined ? (
              <div className="carocrm-chat-hero">
                <span className="carocrm-chat-hero-mark" aria-hidden="true">
                  <ThunderboltOutlined />
                </span>
                <h2 className="carocrm-chat-hero-title">
                  {data.actions.canStartTurn ? t('web.crmChat.heroTitle') : blockedTitle}
                </h2>
                <p className="carocrm-chat-hero-hint">
                  {data.actions.canStartTurn ? t('web.crmChat.heroHint') : t('web.crmChat.selectConversation')}
                </p>
                {data.actions.canStartTurn ? (
                  <CRMChatSuggestions
                    tools={data.assistant.tools}
                    onSelect={(text) => setPrefill({ text, nonce: Date.now() })}
                  />
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

      <CRMChatDiagnosticsDrawer
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        data={data}
      />
      {isAdmin ? (
        <CRMChatSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      ) : null}
    </div>
  );
}
