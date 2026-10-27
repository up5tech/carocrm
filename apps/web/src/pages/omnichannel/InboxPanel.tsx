import { PartitionOutlined, ReloadOutlined, RobotOutlined, SendOutlined, UserAddOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Col, Collapse, Input, List, message, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import type { OmnichannelCaseContext, OmnichannelConversationView, OmnichannelIdentityParticipant, OmnichannelThreadView, OmnichannelTimelineEntry } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';
import { useSession } from '../../state/session.js';

/**
 * Phase 19-OM.10 — the agent inbox workspace (plan §9.1–§9.2, §14 `19-OM.10`).
 *
 * Built on the Omnichannel facade (OM.6/OM.8): every filter is a server-side, ACL-scoped query
 * parameter — the client never filters a globally fetched set. The timeline is rendered as plain
 * text (React escapes it; no HTML injection path) and internal notes are marked and visually
 * distinct, while the customer widget has no way to read them (OM.9). Realtime is the documented
 * polling interim until the shared publish seam (D3/E11) lands; selection, unread state and
 * assignment survive reconnects because every mutation re-reads the server's answer.
 */

const STATUS_VIEWS = ['all', 'mine', 'unassigned', 'waiting_customer', 'waiting_agent', 'snoozed', 'closed'] as const;
type StatusView = (typeof STATUS_VIEWS)[number];

const STATUS_OPTIONS = ['open', 'pending_customer', 'pending_internal', 'resolved', 'closed', 'spam'] as const;

function viewQuery(view: StatusView): { status?: string; assignee?: string; snoozed?: 'only' } {
  switch (view) {
    case 'mine':
      return { assignee: 'me' };
    case 'unassigned':
      return { assignee: 'unassigned' };
    case 'waiting_customer':
      return { status: 'pending_customer' };
    case 'waiting_agent':
      return { status: 'pending_internal' };
    case 'snoozed':
      return { snoozed: 'only' };
    case 'closed':
      return { status: 'closed' };
    case 'all':
    default:
      return {};
  }
}

export function InboxPanel() {
  const principal = useSession((state) => state.principal);
  const queryClient = useQueryClient();
  const [view, setView] = useState<StatusView>('all');
  const [channel, setChannel] = useState<string | undefined>(undefined);
  const [priority, setPriority] = useState<string | undefined>(undefined);
  const [tag, setTag] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [internalNote, setInternalNote] = useState(false);
  const [aiPending, setAiPending] = useState(false);
  const loadedDraftFor = useRef<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const filters = useMemo(
    () => ({
      ...viewQuery(view),
      ...(channel === undefined ? {} : { channel }),
      ...(priority === undefined ? {} : { priority }),
      ...(tag.trim() === '' ? {} : { tag: tag.trim() }),
      ...(unreadOnly ? { unreadOnly: true } : {}),
    }),
    [view, channel, priority, tag, unreadOnly],
  );

  const capabilities = useQuery({ queryKey: ['omnichannel', 'capabilities'], queryFn: () => api.omnichannelCapabilities(), staleTime: 60_000 });
  const granted = useMemo(
    () => new Set((capabilities.data?.capabilities ?? []).filter((entry) => entry.granted).map((entry) => entry.key)),
    [capabilities.data],
  );

  const conversations = useQuery({
    queryKey: ['omnichannel', 'conversations', filters],
    queryFn: () => api.omnichannelConversations({ limit: 50, ...filters }),
    refetchInterval: 10_000,
  });

  // Keep the selection valid after a filter change or a server-side assignment change.
  const selected: OmnichannelConversationView | undefined = useMemo(
    () => (conversations.data?.list ?? []).find((row) => row.id === selectedId),
    [conversations.data, selectedId],
  );
  useEffect(() => {
    const first = conversations.data?.list[0]?.id;
    if (selectedId === undefined && first !== undefined) setSelectedId(first);
    if (selectedId !== undefined && conversations.data !== undefined && selected === undefined && first !== undefined) setSelectedId(first);
  }, [conversations.data, selectedId, selected]);

  const timeline = useQuery({
    queryKey: ['omnichannel', 'timeline', selectedId],
    queryFn: () => (selectedId === undefined ? Promise.resolve({ entries: [] }) : api.omnichannelTimeline(selectedId, { limit: 200 })),
    enabled: selectedId !== undefined,
    refetchInterval: 8_000,
  });
  const threads = useQuery({
    queryKey: ['omnichannel', 'threads', selectedId],
    queryFn: () => (selectedId === undefined ? Promise.resolve({ list: [] }) : api.omnichannelThreads(selectedId)),
    enabled: selectedId !== undefined,
  });
  // 19-OM.12 — snippets for this conversation's channel; the body is plain text.
  const snippets = useQuery({
    queryKey: ['omnichannel', 'snippets', selected?.channel],
    queryFn: () => api.omnichannelSnippets(selected?.channel),
    enabled: selectedId !== undefined,
    staleTime: 60_000,
  });
  // 19-OM.13 — recent calls as context (never converted into messages), with an explicit open action.
  const calls = useQuery({ queryKey: ['omnichannel', 'calls'], queryFn: () => api.omnichannelCalls(10), refetchInterval: 20_000 });
  // 19-OM.17 — the Case linked to this conversation (created by the ServiceDesk command only).
  const caseContext = useQuery({
    queryKey: ['omnichannel', 'case', selectedId],
    queryFn: () => (selectedId === undefined ? Promise.resolve({ case: null }) : api.omnichannelConversationCase(selectedId)),
    enabled: selectedId !== undefined,
    staleTime: 15_000,
  });
  const handoff = useMutation({
    mutationFn: (input: { id: string; linkCaseId?: string }) => api.omnichannelHandoff(input.id, input.linkCaseId === undefined ? {} : { linkCaseId: input.linkCaseId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'case', selectedId] });
      refresh();
    },
    onError: (error: unknown) => setActionError(errorText(error)),
  });
  const identity = useQuery({
    queryKey: ['omnichannel', 'identity', selectedId],
    queryFn: () => (selectedId === undefined ? Promise.resolve(undefined) : api.omnichannelIdentity(selectedId)),
    enabled: selectedId !== undefined && granted.has('identityLink'),
    staleTime: 30_000,
  });

  // Restore this agent's own draft when the conversation changes, and autosave while typing.
  useEffect(() => {
    if (selectedId === undefined) return;
    if (loadedDraftFor.current === selectedId) return;
    loadedDraftFor.current = selectedId;
    setDraft('');
    setInternalNote(false);
    void api
      .omnichannelDraft(selectedId)
      .then(({ draft: stored }) => {
        if (stored === null || loadedDraftFor.current !== selectedId) return;
        setDraft(stored.body);
        setInternalNote(stored.isInternalNote);
      })
      .catch(() => undefined);
  }, [selectedId]);
  useEffect(() => {
    if (selectedId === undefined || draft.trim() === '') return undefined;
    const timer = window.setTimeout(() => {
      void api.omnichannelSaveDraft(selectedId, { body: draft, isInternalNote: internalNote }).catch(() => undefined);
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [draft, internalNote, selectedId]);

  // 19-OM.19 — AI assistance produces an editable draft only; nothing is sent by the suggestion.
  async function suggestWithAi(): Promise<void> {
    if (selectedId === undefined || aiPending) return;
    setAiPending(true);
    setActionError(undefined);
    try {
      const queued = await api.omnichannelAiSuggest('suggest_reply', selectedId);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const run = await api.omnichannelAiRun(queued.runId, selectedId);
        if (run.status === 'succeeded' || run.status === 'partially_succeeded') {
          if (run.result !== null) setDraft((current) => (current.trim() === '' ? run.result ?? '' : `${current}\n${run.result ?? ''}`));
          return;
        }
        if (!['queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'retry_wait'].includes(run.status)) {
          throw new Error(run.failureMessage ?? t('omnichannel.inbox.aiFailed'));
        }
      }
      throw new Error(t('omnichannel.inbox.aiTimeout'));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('omnichannel.inbox.aiFailed'));
    } finally {
      setAiPending(false);
    }
  }

  const markRead = useMutation({
    mutationFn: (id: string) => api.omnichannelMarkRead(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'conversations'] }),
  });

  function selectConversation(row: OmnichannelConversationView): void {
    setSelectedId(row.id);
    setActionError(undefined);
    if (row.unreadCount > 0) markRead.mutate(row.id);
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'conversations'] });
    if (selectedId !== undefined) void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'timeline', selectedId] });
  };

  const send = useMutation({
    mutationFn: (input: { id: string; body: string; isInternalNote: boolean }) =>
      api.omnichannelSendMessage(input.id, { body: input.body, idempotencyKey: crypto.randomUUID(), isInternalNote: input.isInternalNote }),
    onSuccess: (_result, variables) => {
      // The draft's purpose is fulfilled by the send: remove it so nothing stale is restored later.
      void api.omnichannelDeleteDraft(variables.id).catch(() => undefined);
      loadedDraftFor.current = variables.id;
      setDraft('');
      refresh();
    },
    onError: (error: unknown) => setActionError(errorText(error)),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) => api.omnichannelSetStatus(input.id, input.status),
    onSuccess: () => refresh(),
    onError: (error: unknown) => setActionError(errorText(error)),
  });

  const assign = useMutation({
    mutationFn: (input: { id: string; userId: string | null; expectedVersion?: number }) =>
      api.omnichannelAssign(input.id, {
        userId: input.userId,
        reason: input.userId === null ? t('omnichannel.inbox.unassignReason') : t('omnichannel.inbox.assignReason'),
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      }),
    onSuccess: () => refresh(),
    onError: (error: unknown) => setActionError(errorText(error)),
  });

  // Deterministic routing through the ServiceDesk engine (D2); the decision is shown on success.
  const route = useMutation({
    mutationFn: (input: { id: string; expectedVersion?: number }) => api.omnichannelRoute(input.id, { ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) }),
    onSuccess: (result) => {
      setActionError(undefined);
      void message.info(
        result.decision.routingRuleName === null
          ? t('omnichannel.inbox.routedFallback').replace('{reason}', result.decision.fallbackReason ?? '—')
          : t('omnichannel.inbox.routedBy').replace('{rule}', result.decision.routingRuleName),
      );
      refresh();
    },
    onError: (error: unknown) => setActionError(errorText(error)),
  });

  const linkIdentity = useMutation({
    mutationFn: (input: { id: string; entityType: 'Contact' | 'Lead'; entityId: string; participantId: string }) =>
      api.omnichannelLinkIdentity(input.id, { entityType: input.entityType, entityId: input.entityId, participantId: input.participantId, reason: t('omnichannel.inbox.linkReason') }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['omnichannel', 'identity', selectedId] });
      refresh();
    },
    onError: (error: unknown) => setActionError(errorText(error)),
  });

  if (conversations.isLoading) return <LoadingSkeleton rows={10} />;
  if (conversations.isError) {
    return <ErrorState message={t('omnichannel.inbox.loadFailed')} onRetry={() => void conversations.refetch()} />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {actionError !== undefined ? <Alert type="error" showIcon closable message={actionError} onClose={() => setActionError(undefined)} /> : null}
      <Space wrap size={8}>
        <Select
          value={view}
          style={{ minWidth: 190 }}
          onChange={(value: StatusView) => setView(value)}
          aria-label={t('omnichannel.inbox.view')}
          options={STATUS_VIEWS.map((key) => ({ value: key, label: t(`omnichannel.inbox.views.${key}`) }))}
        />
        <Select
          allowClear
          value={channel}
          placeholder={t('omnichannel.inbox.channel')}
          style={{ minWidth: 140 }}
          onChange={(value: string | undefined) => setChannel(value)}
          aria-label={t('omnichannel.inbox.channel')}
          options={['sms', 'whatsapp', 'web_chat'].map((key) => ({ value: key, label: key }))}
        />
        <Select
          allowClear
          value={priority}
          placeholder={t('omnichannel.inbox.priority')}
          style={{ minWidth: 130 }}
          onChange={(value: string | undefined) => setPriority(value)}
          aria-label={t('omnichannel.inbox.priority')}
          options={['low', 'normal', 'high', 'urgent'].map((key) => ({ value: key, label: t(`omnichannel.inbox.priorities.${key}`) }))}
        />
        <Input
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder={t('omnichannel.inbox.tag')}
          style={{ width: 160 }}
          aria-label={t('omnichannel.inbox.tag')}
        />
        <Space size={6}>
          <Typography.Text type="secondary">{t('omnichannel.inbox.unreadOnly')}</Typography.Text>
          <Switch checked={unreadOnly} onChange={setUnreadOnly} aria-label={t('omnichannel.inbox.unreadOnly')} />
        </Space>
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t('omnichannel.inbox.refresh')}
        </Button>
      </Space>

      {(calls.data?.list ?? []).length > 0 ? (
        <Collapse
          size="small"
          items={[
            {
              key: 'calls',
              label: `${t('omnichannel.inbox.calls')} (${calls.data?.list.length ?? 0})`,
              children: (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {(calls.data?.list ?? []).map((call) => (
                    <Space key={call.id} size={8} wrap>
                      <Tag color={call.direction === 'inbound' ? 'blue' : 'default'}>
                        {call.direction === 'inbound' ? t('omnichannel.inbox.received') : t('omnichannel.inbox.sent')}
                      </Tag>
                      <Typography.Text>{call.fromNumber ?? call.toNumber ?? call.id.slice(0, 8)}</Typography.Text>
                      <Tag>{call.state}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {call.startedAt === null ? '—' : new Date(call.startedAt).toLocaleString()}
                        {call.durationSeconds === null ? '' : ` · ${String(call.durationSeconds)}s`}
                      </Typography.Text>
                      <Button
                        size="small"
                        disabled={call.conversationId === null}
                        onClick={() => {
                          if (call.conversationId !== null) setSelectedId(call.conversationId);
                          else void message.info(t('omnichannel.inbox.noConversation'));
                        }}
                      >
                        {t('omnichannel.inbox.openConversation')}
                      </Button>
                    </Space>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Card className="carocrm-card" size="small" title={`${t('omnichannel.inbox.listTitle')} (${conversations.data?.total ?? 0})`}>
            {(conversations.data?.list ?? []).length === 0 ? (
              <EmptyState variant="no-results" title={t('omnichannel.inbox.empty')} />
            ) : (
              <List
                dataSource={[...(conversations.data?.list ?? [])]}
                renderItem={(row) => (
                  <List.Item
                    onClick={() => selectConversation(row)}
                    style={{
                      cursor: 'pointer',
                      paddingInline: 8,
                      borderRadius: 8,
                      background: row.id === selectedId ? 'var(--carocrm-surface-sunken)' : undefined,
                    }}
                  >
                    <List.Item.Meta
                      title={
                        <Space size={6} wrap>
                          <Badge count={row.unreadCount} size="small" />
                          <Typography.Text strong>{row.customerName ?? row.customerAddress ?? row.subject ?? row.id.slice(0, 8)}</Typography.Text>
                          <Tag>{row.channel}</Tag>
                          {row.priority !== 'normal' ? <Tag color={row.priority === 'urgent' ? 'red' : 'orange'}>{row.priority}</Tag> : null}
                          {row.snoozedUntil !== null ? <Tag color="purple">{t('omnichannel.inbox.snoozed')}</Tag> : null}
                        </Space>
                      }
                      description={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t(`omnichannel.inbox.statuses.${row.status}`)} · {row.lastActivityAt === null ? '—' : new Date(row.lastActivityAt).toLocaleString()}
                          {row.tags.length > 0 ? ` · ${row.tags.join(', ')}` : ''}
                        </Typography.Text>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <ConversationPane
            conversation={selected}
            entries={timeline.data?.entries ?? []}
            threads={threads.data?.list ?? []}
            identity={identity.data?.participants ?? []}
            caseView={caseContext.data?.case ?? null}
            handoffPending={handoff.isPending}
            onHandoff={(linkCaseId) => selected !== undefined && handoff.mutate({ id: selected.id, ...(linkCaseId === undefined ? {} : { linkCaseId }) })}
            onAiSuggest={() => void suggestWithAi()}
            aiPending={aiPending}
            canLink={granted.has('identityLink')}
            canAssign={granted.has('assign')}
            canReply={granted.has('reply')}
            draft={draft}
            snippets={snippets.data?.list ?? []}
            onInsertSnippet={(key) => {
              void api
                .omnichannelPreviewSnippet(key, { ...(selectedId === undefined ? {} : { conversationId: selectedId }) })
                .then((preview) => setDraft((current) => (current.trim() === '' ? preview.body : `${current} ${preview.body}`)))
                .catch((error: unknown) => setActionError(errorText(error)));
              void api.omnichannelUseSnippet(key).catch(() => undefined);
            }}
            internalNote={internalNote}
            onDraft={setDraft}
            onInternalNote={setInternalNote}
            onSend={() => {
              if (selected === undefined || draft.trim() === '') return;
              send.mutate({ id: selected.id, body: draft.trim(), isInternalNote: internalNote });
            }}
            sending={send.isPending}
            onStatus={(status) => selected !== undefined && setStatus.mutate({ id: selected.id, status })}
            onAssign={() => selected !== undefined && principal !== null && principal !== undefined && assign.mutate({ id: selected.id, userId: principal.id, expectedVersion: selected.version })}
            onUnassign={() => selected !== undefined && assign.mutate({ id: selected.id, userId: null, expectedVersion: selected.version })}
            onRoute={() => selected !== undefined && route.mutate({ id: selected.id, expectedVersion: selected.version })}
            routing={route.isPending}
            onLink={(participant: OmnichannelIdentityParticipant, entityType: 'Contact' | 'Lead', entityId: string) =>
              selected !== undefined && linkIdentity.mutate({ id: selected.id, participantId: participant.participantId, entityType, entityId })
            }
          />
        </Col>
      </Row>
    </Space>
  );
}

interface ConversationPaneProps {
  readonly conversation: OmnichannelConversationView | undefined;
  readonly entries: readonly OmnichannelTimelineEntry[];
  readonly threads: readonly OmnichannelThreadView[];
  readonly identity: readonly OmnichannelIdentityParticipant[];
  readonly caseView: OmnichannelCaseContext | null;
  readonly handoffPending: boolean;
  readonly onHandoff: (linkCaseId?: string) => void;
  readonly onAiSuggest: () => void;
  readonly aiPending: boolean;
  readonly canLink: boolean;
  readonly canAssign: boolean;
  readonly canReply: boolean;
  readonly draft: string;
  readonly snippets: readonly { readonly key: string; readonly name: string; readonly channel: string }[];
  readonly onInsertSnippet: (key: string) => void;
  readonly internalNote: boolean;
  readonly sending: boolean;
  readonly onDraft: (value: string) => void;
  readonly onInternalNote: (value: boolean) => void;
  readonly onSend: () => void;
  readonly onStatus: (status: string) => void;
  readonly onAssign: () => void;
  readonly onUnassign: () => void;
  readonly onRoute: () => void;
  readonly routing: boolean;
  readonly onLink: (participant: OmnichannelIdentityParticipant, entityType: 'Contact' | 'Lead', entityId: string) => void;
}

function ConversationPane(props: ConversationPaneProps) {
  const { conversation } = props;
  const [linkCaseId, setLinkCaseId] = useState('');
  if (conversation === undefined) {
    return (
      <Card className="carocrm-card">
        <EmptyState variant="no-records" title={t('omnichannel.inbox.selectPrompt')} />
      </Card>
    );
  }
  return (
    <Card
      className="carocrm-card"
      size="small"
      title={
        <Space size={8} wrap>
          <Typography.Text strong>{conversation.customerName ?? conversation.customerAddress ?? conversation.id.slice(0, 8)}</Typography.Text>
          <Tag>{conversation.channel}</Tag>
          {conversation.priority !== 'normal' ? <Tag color={conversation.priority === 'urgent' ? 'red' : 'orange'}>{conversation.priority}</Tag> : null}
          {conversation.assignedUserId === null ? <Tag color="gold">{t('omnichannel.inbox.unassignedTag')}</Tag> : <Tag color="blue">{t('omnichannel.inbox.assignedTag')}</Tag>}
        </Space>
      }
    >
      {/* The head carries the identity, the actions get their own row under it. Sharing one line
          left the last tag orphaned below the name, and the status appeared twice — once as a tag
          and once as the control that changes it. */}
      <div className="carocrm-inbox-toolbar">
        <Space size={6} wrap>
          <Select
            size="small"
            value={conversation.status}
            style={{ minWidth: 150 }}
            onChange={props.onStatus}
            disabled={!props.canAssign}
            aria-label={t('omnichannel.inbox.status')}
            options={STATUS_OPTIONS.map((status) => ({ value: status, label: t(`omnichannel.inbox.statuses.${status}`) }))}
          />
          <Button size="small" icon={<UserAddOutlined />} onClick={props.onAssign} disabled={!props.canAssign}>
            {t('omnichannel.inbox.assignToMe')}
          </Button>
          <Button size="small" icon={<PartitionOutlined />} onClick={props.onRoute} disabled={!props.canAssign} loading={props.routing}>
            {t('omnichannel.inbox.route')}
          </Button>
          <Button size="small" onClick={props.onUnassign} disabled={!props.canAssign}>
            {t('omnichannel.inbox.unassign')}
          </Button>
        </Space>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }} aria-live="polite">
        {props.entries.length === 0 ? <Typography.Text type="secondary">{t('omnichannel.inbox.noMessages')}</Typography.Text> : null}
        {props.entries.map((entry) =>
          entry.kind === 'event' ? (
            <Typography.Text key={entry.id} type="secondary" style={{ textAlign: 'center', fontSize: 12 }}>
              {entry.event?.kind} {entry.event?.toValue === null ? '' : `→ ${entry.event?.toValue}`} · {new Date(entry.at).toLocaleString()}
            </Typography.Text>
          ) : (
            <div
              key={entry.id}
              style={{
                alignSelf: entry.message?.direction === 'outbound' ? 'flex-end' : 'flex-start',
                maxWidth: '78%',
                padding: '8px 12px',
                borderRadius: 10,
                background:
                  entry.message?.isInternalNote === true
                    ? 'var(--carocrm-c-fffbe6)'
                    : entry.message?.direction === 'outbound'
                      ? 'var(--carocrm-accent-soft)'
                      : 'var(--carocrm-surface-sunken)',
                border: entry.message?.isInternalNote === true ? '1px dashed var(--carocrm-state-warning)' : undefined,
              }}
            >
              {entry.message?.isInternalNote === true ? <Tag color="orange">{t('omnichannel.inbox.internalNote')}</Tag> : null}
              <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{entry.message?.body ?? ''}</Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {entry.message?.direction === 'outbound' ? `${t('omnichannel.inbox.sent')} · ${entry.message?.state}` : t('omnichannel.inbox.received')} · {new Date(entry.at).toLocaleTimeString()}
                </Typography.Text>
              </div>
            </div>
          ),
        )}
      </div>
      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 12 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input.TextArea
            value={props.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            placeholder={t('omnichannel.inbox.placeholder')}
            autoSize={{ minRows: 1, maxRows: 4 }}
            maxLength={20_000}
            disabled={!props.canReply || props.sending}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                props.onSend();
              }
            }}
            aria-label={t('omnichannel.inbox.placeholder')}
          />
          <Button type="primary" icon={<SendOutlined />} onClick={props.onSend} loading={props.sending} disabled={!props.canReply || props.draft.trim() === ''}>
            {props.internalNote ? t('omnichannel.inbox.addNote') : t('omnichannel.inbox.send')}
          </Button>
        </Space.Compact>
        <Space size={10} wrap>
          <Space size={6}>
            <Switch size="small" checked={props.internalNote} onChange={props.onInternalNote} aria-label={t('omnichannel.inbox.internalNote')} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('omnichannel.inbox.internalNote')}
            </Typography.Text>
          </Space>
          <Button size="small" icon={<RobotOutlined />} onClick={props.onAiSuggest} loading={props.aiPending} disabled={!props.canReply}>
            {t('omnichannel.inbox.aiSuggest')}
          </Button>
          <Select
            size="small"
            showSearch
            optionFilterProp="label"
            value={null}
            placeholder={t('omnichannel.inbox.snippet')}
            style={{ minWidth: 220 }}
            onChange={(key: string) => props.onInsertSnippet(key)}
            aria-label={t('omnichannel.inbox.snippet')}
            options={props.snippets.map((snippet) => ({ value: snippet.key, label: `${snippet.name} (${snippet.channel})` }))}
          />
        </Space>
      </Space>
      <Collapse
        size="small"
        style={{ marginTop: 12 }}
        items={[
          {
            key: 'case',
            label: t('omnichannel.inbox.case'),
            children: props.caseView === null ? (
              <Space size={6} wrap>
                <Typography.Text type="secondary">{t('omnichannel.inbox.noCase')}</Typography.Text>
                <Button size="small" onClick={() => props.onHandoff()} loading={props.handoffPending} disabled={!props.canAssign}>
                  {t('omnichannel.inbox.createCase')}
                </Button>
                <Input
                  size="small"
                  style={{ width: 260 }}
                  placeholder={t('omnichannel.inbox.caseIdPlaceholder')}
                  value={linkCaseId}
                  onChange={(event) => setLinkCaseId(event.target.value)}
                  aria-label={t('omnichannel.inbox.caseIdPlaceholder')}
                />
                <Button size="small" disabled={!props.canAssign || linkCaseId.trim() === ''} onClick={() => props.onHandoff(linkCaseId.trim())} loading={props.handoffPending}>
                  {t('omnichannel.inbox.linkCase')}
                </Button>
              </Space>
            ) : (
              <Space size={6} wrap>
                <Tag color="geekblue">{props.caseView.caseNumber ?? props.caseView.id.slice(0, 8)}</Tag>
                <Tag>{props.caseView.status}</Tag>
                {props.caseView.priority !== null ? <Tag>{props.caseView.priority}</Tag> : null}
                <Typography.Link href={`/Case/${encodeURIComponent(props.caseView.id)}`}>{t('omnichannel.inbox.openCase')}</Typography.Link>
              </Space>
            ),
          },
          {
            key: 'threads',
            label: t('omnichannel.inbox.threads'),
            children: (
              <Space direction="vertical" size={4}>
                {props.threads.map((thread) => (
                  <Typography.Text key={thread.id}>
                    <Tag>{thread.channel}</Tag>
                    {thread.address ?? thread.externalThreadId ?? thread.id.slice(0, 8)}
                  </Typography.Text>
                ))}
              </Space>
            ),
          },
          {
            key: 'identity',
            label: t('omnichannel.inbox.identity'),
            children: (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {props.identity.length === 0 ? <Typography.Text type="secondary">{t('omnichannel.inbox.identityUnavailable')}</Typography.Text> : null}
                {props.identity.map((participant) => (
                  <div key={participant.participantId}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{participant.address}</Typography.Text>
                      <Tag color={participant.linkConfidence === 'manual' ? 'blue' : participant.linkConfidence === 'exact' ? 'green' : participant.verificationState === 'disputed' ? 'orange' : 'default'}>
                        {participant.verificationState}/{participant.linkConfidence}
                      </Tag>
                      {participant.entityType !== null ? <Tag color="cyan">{participant.entityType}: {participant.displayName ?? participant.entityId?.slice(0, 8)}</Tag> : null}
                      {participant.hiddenMatches > 0 ? <Tag>{t('omnichannel.inbox.hiddenMatches')}: {participant.hiddenMatches}</Tag> : null}
                    </Space>
                    {props.canLink && participant.candidates.length > 0 && participant.linkConfidence !== 'manual' ? (
                      <Space size={6} wrap style={{ marginTop: 4 }}>
                        {participant.candidates.map((candidate) => (
                          <Button key={candidate.id} size="small" onClick={() => props.onLink(participant, candidate.entityType as 'Contact' | 'Lead', candidate.id)}>
                            {t('omnichannel.inbox.linkTo')} {candidate.name}
                          </Button>
                        ))}
                      </Space>
                    ) : null}
                  </div>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

function errorText(error: unknown): string {
  const body = (error as { body?: { error?: { message?: string; details?: { refusals?: string[] } } } }).body;
  const message = body?.error?.message ?? (error instanceof Error ? error.message : t('omnichannel.inbox.actionFailed'));
  const refusals = body?.error?.details?.refusals;
  if (refusals === undefined || refusals.length === 0) return message;
  // 19-OM.14 — an agent needs the *reason*, not the code: each refusal has an actionable sentence
  // (window closed vs opted out vs unsupported lead to different next steps).
  const reasons = refusals.map((code) => {
    const translated = t(`omnichannel.refusal.${code}`);
    return translated.startsWith('omnichannel.refusal.') ? code : translated;
  });
  return `${message} — ${reasons.join(' ')}`;
}
