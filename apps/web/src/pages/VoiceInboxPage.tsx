import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CustomerServiceOutlined,
  MessageOutlined,
  PhoneOutlined,
  PictureOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined,
  WhatsAppOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Form, Input, Modal, Segmented, Select, Skeleton, Space, Switch, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api/client.js';
import type {
  VoiceCallSessionView,
  VoiceComposerValidation,
  VoiceConversationView,
  VoiceSnippetView,
  VoiceTimelineEntry,
} from '../api/types.js';
import { usePageTitle } from '../components/PageHeader.js';
import { VoiceCallDetail } from '../components/VoiceCallDetail.js';
import { formatClock, formatDateTime, isSameCalendarDay, t } from '../state/i18n.js';

/**
 * Phase 19-VC.12–19-VC.14 — the agent workspace
 * (`PLAN_Phase_19_Voice_Communications.md` §9–§10, §15 `19-VC.12` … `19-VC.14`).
 *
 * One screen with two surfaces: the conversation inbox (list + timeline + composer) and the call log
 * (session detail, recordings, transcript). The server decides visibility, policy and idempotency:
 * every mutation here is one documented action, and a refusal is rendered with the server's own
 * reason. Internal notes are badged and never styled as customer text.
 *
 * The layout is the shared conversation workspace (`carocrm-workspace*`): the rail is the inbox, the
 * main pane is the thread, and the composer is docked so it never scrolls away. The same frame
 * carries CRM Chat, because both screens answer the same question — "which thread, and what was
 * said" — and a second layout would only teach the operator a second set of habits.
 */

const STATUSES = ['open', 'pending_customer', 'pending_internal', 'resolved', 'closed', 'spam'] as const;

function statusColor(status: string): string {
  switch (status) {
    case 'open':
      return 'blue';
    case 'pending_customer':
      return 'gold';
    case 'pending_internal':
      return 'purple';
    case 'resolved':
      return 'green';
    case 'closed':
      return 'default';
    case 'spam':
      return 'red';
    default:
      return 'default';
  }
}

function channelColor(channel: string): string {
  return channel === 'whatsapp' ? 'green' : channel === 'sms' ? 'geekblue' : 'cyan';
}

function statusLabel(status: string): string {
  return t(`voice.inbox.status.${status}`);
}

/** The rail avatar's tint, keyed by channel. */
function channelTone(channel: string): 'sms' | 'whatsapp' | 'mms' | 'voice' {
  if (channel === 'whatsapp') return 'whatsapp';
  if (channel === 'mms') return 'mms';
  return channel === 'sms' ? 'sms' : 'voice';
}

function channelIcon(channel: string): React.ReactNode {
  if (channel === 'whatsapp') return <WhatsAppOutlined />;
  if (channel === 'mms') return <PictureOutlined />;
  return channel === 'sms' ? <MessageOutlined /> : <PhoneOutlined />;
}

/** A rail stamp: the clock for today, the date for anything older. */
function railStamp(value: string | null): string {
  if (value === null) return '';
  return isSameCalendarDay(value, new Date().toISOString()) ? formatClock(value) : formatDateTime(value, false);
}

/** One message bubble. An internal note is visibly not a customer message (§9.1). */
function TimelineMessage({ entry }: { entry: VoiceTimelineEntry }) {
  const message = entry.message;
  if (message === undefined) return null;
  const tone = message.isInternalNote ? 'note' : message.direction === 'outbound' ? 'outbound' : 'inbound';
  const label = message.isInternalNote
    ? t('voice.inbox.internalNote')
    : message.direction === 'outbound'
      ? t('voice.inbox.outbound')
      : t('voice.inbox.inbound');

  return (
    <div className={`carocrm-convo-msg carocrm-convo-msg--${tone}`}>
      <span className={`carocrm-convo-avatar carocrm-convo-avatar--${tone}`} aria-hidden="true">
        {message.isInternalNote ? <CustomerServiceOutlined /> : message.direction === 'outbound' ? <SendOutlined /> : <MessageOutlined />}
      </span>
      <div className="carocrm-convo-body">
        <div className="carocrm-convo-meta">
          <span className="carocrm-convo-role">{label}</span>
          <span>{formatDateTime(entry.at)}</span>
          {message.direction === 'outbound' && !message.isInternalNote ? (
            <span className="carocrm-convo-channel">{message.state}</span>
          ) : null}
        </div>
        <div className="carocrm-convo-bubble">{message.body ?? ''}</div>
      </div>
    </div>
  );
}

function TimelineEvent({ entry }: { entry: VoiceTimelineEntry }) {
  const event = entry.event;
  if (event === undefined) return null;
  const detail =
    event.kind === 'status_changed'
      ? t('voice.inbox.event.status', { from: event.fromValue ?? '—', to: event.toValue ?? '—' })
      : event.kind === 'assigned'
        ? t('voice.inbox.event.assigned', { to: event.toValue ?? '—' })
        : event.kind === 'unassigned'
          ? t('voice.inbox.event.unassigned')
          : event.kind === 'case_linked'
            ? t('voice.inbox.event.caseLinked', { to: event.toValue ?? '—' })
            : event.kind;
  return (
    <div className="carocrm-inbox-event">
      <span>
        {detail} · {formatDateTime(entry.at)}
        {event.detail !== null && event.detail !== '' ? ` · ${event.detail}` : ''}
      </span>
    </div>
  );
}

/** Snippet picker: a local snippet's placeholders are filled by the agent, never resolved from CRM. */
function SnippetPicker({
  snippets,
  channel,
  onInsert,
}: {
  snippets: readonly VoiceSnippetView[];
  channel: string;
  onInsert: (body: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [pending, setPending] = useState<VoiceSnippetView | undefined>(undefined);
  const [values, setValues] = useState<Record<string, string>>({});

  const applicable = snippets.filter((snippet) => snippet.channel === 'any' || snippet.channel === channel);
  return (
    <>
      <Select
        size="small"
        style={{ minWidth: 170 }}
        placeholder={t('voice.inbox.snippetPlaceholder')}
        value={undefined}
        options={applicable.map((snippet) => ({ value: snippet.key, label: snippet.name }))}
        onChange={(key) => {
          const snippet = applicable.find((entry) => entry.key === key);
          if (snippet === undefined) return;
          if (snippet.placeholders.length === 0) {
            onInsert(snippet.body);
            return;
          }
          setValues({});
          setPending(snippet);
        }}
      />
      <Modal
        open={pending !== undefined}
        title={pending?.name}
        okText={t('voice.inbox.insert')}
        cancelText={t('voice.inbox.cancel')}
        onCancel={() => setPending(undefined)}
        onOk={() => {
          if (pending === undefined) return;
          void (async () => {
            try {
              const rendered = await api.voiceRenderSnippet(pending.key, values);
              onInsert(rendered.body);
              setPending(undefined);
            } catch (error) {
              void message.error(error instanceof Error ? error.message : t('voice.inbox.renderFailed'));
            }
          })();
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {pending?.placeholders.map((name) => (
            <Input
              key={name}
              addonBefore={`{{${name}}}`}
              value={values[name] ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
            />
          ))}
        </Space>
      </Modal>
    </>
  );
}

/** The composer: snippet insertion, segment/limit hints from the server, internal-note switch. */
function Composer({ conversation, onSent }: { conversation: VoiceConversationView; onSent: () => void }) {
  const { message } = AntApp.useApp();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [validation, setValidation] = useState<VoiceComposerValidation | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const snippets = useQuery({ queryKey: ['voice', 'snippets'], queryFn: () => api.voiceSnippets(), staleTime: 60_000 });

  const channel = conversation.channel === 'mms' ? 'mms' : conversation.channel === 'whatsapp' ? 'whatsapp' : 'sms';

  useEffect(() => {
    if (body.trim() === '' || internal) {
      setValidation(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .voiceValidateComposer(channel, body)
        .then(setValidation)
        .catch(() => setValidation(undefined));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [body, channel, internal]);

  const send = async () => {
    if (body.trim() === '' && !internal) {
      void message.warning(t('voice.inbox.emptyMessage'));
      return;
    }
    setSending(true);
    try {
      const result = await api.voiceSendMessage({
        channel,
        conversationId: conversation.id,
        body,
        // Client-generated so a double click or a retry is one message, not two (§8.1).
        idempotencyKey: `composer-${conversation.id}-${crypto.randomUUID()}`,
        ...(internal ? { isInternalNote: true } : {}),
      });
      setBody('');
      if (result.message.state === 'failed') {
        void message.warning(t('voice.inbox.sendFailed', { reason: result.message.failureCategory ?? 'unknown' }));
      }
      onSent();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('voice.inbox.sendFailedGeneric'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`carocrm-workspace-dock-frame${internal ? ' carocrm-workspace-dock-frame--note' : ''}`}>
      <div className="carocrm-workspace-dock-tools">
        <SnippetPicker
          snippets={snippets.data?.list ?? []}
          channel={channel}
          onInsert={(text) => setBody((current) => (current.trim() === '' ? text : `${current}\n${text}`))}
        />
        <Tooltip title={t('voice.inbox.internalNoteHint')}>
          <span className="carocrm-inbox-note-toggle">
            <Switch size="small" checked={internal} onChange={setInternal} />
            <span className={`carocrm-inbox-note-flag${internal ? ' is-on' : ''}`}>{t('voice.inbox.internalNote')}</span>
          </span>
        </Tooltip>
      </div>

      <Input.TextArea
        variant="borderless"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        autoSize={{ minRows: 1, maxRows: 6 }}
        maxLength={4000}
        placeholder={internal ? t('voice.inbox.notePlaceholder') : t('voice.inbox.messagePlaceholder')}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — the same rule as the Chat workspace.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />

      <div className="carocrm-workspace-dock-foot">
        <span className={`carocrm-workspace-dock-hint${validation !== undefined && !validation.ok ? ' is-over' : ''}`}>
          {validation === undefined
            ? t('voice.inbox.composerHint', { max: 4000 })
            : `${t('voice.inbox.segments', {
                count: validation.segments.segments,
                encoding: validation.segments.encoding,
                chars: validation.segments.characters,
              })}${validation.warnings.length > 0 ? ` · ${validation.warnings[0] ?? ''}` : ''}`}
        </span>
        <Space size={8}>
          <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void send()}>
            {internal ? t('voice.inbox.saveNote') : t('voice.inbox.send')}
          </Button>
        </Space>
      </div>
    </div>
  );
}

/** The inbox rail: filters above, one row per conversation, unread count on the row. */
function InboxRail(props: {
  conversations: readonly VoiceConversationView[];
  loading: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  status: string | undefined;
  onStatus: (value: string | undefined) => void;
  channel: string | undefined;
  onChannel: (value: string | undefined) => void;
  mine: boolean;
  onMine: (value: boolean) => void;
}) {
  const { conversations, loading, selectedId, onSelect } = props;

  return (
    <aside className="carocrm-workspace-rail" aria-label={t('voice.inbox.tabInbox')}>
      <div className="carocrm-workspace-rail-head">
        <Space size={6} wrap>
          <Select
            allowClear
            size="small"
            placeholder={t('voice.inbox.filterStatus')}
            style={{ flex: '1 1 110px', minWidth: 110 }}
            value={props.status}
            onChange={props.onStatus}
            options={STATUSES.map((value) => ({ value, label: statusLabel(value) }))}
          />
          <Select
            allowClear
            size="small"
            placeholder={t('voice.inbox.filterChannel')}
            style={{ flex: '1 1 96px', minWidth: 96 }}
            value={props.channel}
            onChange={props.onChannel}
            options={['sms', 'mms', 'whatsapp'].map((value) => ({ value, label: t(`voice.channel.${value}`) }))}
          />
          <Tooltip title={t('voice.inbox.onlyMineHint')}>
            <Button
              size="small"
              icon={<TeamOutlined />}
              type={props.mine ? 'primary' : 'default'}
              aria-label={t('voice.inbox.onlyMineHint')}
              aria-pressed={props.mine}
              onClick={() => props.onMine(!props.mine)}
            />
          </Tooltip>
        </Space>
      </div>

      <div className="carocrm-workspace-rail-list">
        {loading ? (
          <div style={{ padding: '10px 6px' }}>
            <Skeleton active title={false} paragraph={{ rows: 5 }} />
          </div>
        ) : null}

        {!loading && conversations.length === 0 ? (
          <div className="carocrm-workspace-rail-empty">
            <MessageOutlined />
            <strong>{t('voice.inbox.empty')}</strong>
          </div>
        ) : null}

        {conversations.map((conversation) => {
          const active = conversation.id === selectedId;
          const title = conversation.subject ?? conversation.externalThreadId ?? conversation.id;
          return (
            <button
              key={conversation.id}
              type="button"
              className={`carocrm-rail-item${active ? ' is-active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(conversation.id)}
            >
              <span className={`carocrm-rail-avatar carocrm-rail-avatar--${channelTone(conversation.channel)}`} aria-hidden="true">
                {channelIcon(conversation.channel)}
              </span>
              <span className="carocrm-rail-text">
                <span className="carocrm-rail-name">{title}</span>
                <span className="carocrm-rail-tags">
                  <Tag color={channelColor(conversation.channel)} bordered={false}>
                    {t(`voice.channel.${conversation.channel}`)}
                  </Tag>
                  <Tag color={statusColor(conversation.status)} bordered={false}>
                    {statusLabel(conversation.status)}
                  </Tag>
                  {conversation.unreadCount > 0 ? (
                    <span className="carocrm-rail-badge">{conversation.unreadCount}</span>
                  ) : null}
                </span>
              </span>
              <span className="carocrm-rail-time">{railStamp(conversation.lastActivityAt)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** The call rail: click-to-call above, one row per session. */
function CallsRail(props: {
  calls: readonly VoiceCallSessionView[];
  loading: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  destination: string;
  onDestination: (value: string) => void;
  placing: boolean;
  onPlace: () => void;
}) {
  return (
    <aside className="carocrm-workspace-rail" aria-label={t('voice.inbox.tabCalls')}>
      <div className="carocrm-workspace-rail-head">
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="small"
            placeholder={t('voice.inbox.callPlaceholder')}
            value={props.destination}
            onChange={(event) => props.onDestination(event.target.value)}
            onPressEnter={props.onPlace}
            maxLength={64}
          />
          <Button size="small" type="primary" icon={<PhoneOutlined />} loading={props.placing} onClick={props.onPlace}>
            {t('voice.inbox.call')}
          </Button>
        </Space.Compact>
      </div>

      <div className="carocrm-workspace-rail-list">
        {props.loading ? (
          <div style={{ padding: '10px 6px' }}>
            <Skeleton active title={false} paragraph={{ rows: 4 }} />
          </div>
        ) : null}

        {!props.loading && props.calls.length === 0 ? (
          <div className="carocrm-workspace-rail-empty">
            <PhoneOutlined />
            <strong>{t('voice.inbox.noCalls')}</strong>
          </div>
        ) : null}

        {props.calls.map((call) => {
          const active = call.id === props.selectedId;
          const inbound = call.direction === 'inbound';
          return (
            <button
              key={call.id}
              type="button"
              className={`carocrm-rail-item${active ? ' is-active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => props.onSelect(call.id)}
            >
              <span className="carocrm-rail-avatar carocrm-rail-avatar--voice" aria-hidden="true">
                {inbound ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
              </span>
              <span className="carocrm-rail-text">
                <span className="carocrm-rail-name">{(inbound ? call.fromNumber : call.toNumber) ?? '—'}</span>
                <span className="carocrm-rail-tags">
                  <Tag bordered={false}>{call.state}</Tag>
                  {call.durationSeconds !== null ? (
                    <Tag bordered={false}>{`${call.durationSeconds}s`}</Tag>
                  ) : null}
                  {call.failureCategory !== null ? (
                    <Tag color="red" bordered={false}>
                      {call.failureCategory}
                    </Tag>
                  ) : null}
                </span>
              </span>
              <span className="carocrm-rail-time">{railStamp(call.startedAt ?? call.createdAt)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** One conversation: toolbar actions, the timeline, the composer, and the handoff dialog. */
function ConversationPane({ conversation, onChanged }: { conversation: VoiceConversationView; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffForm] = Form.useForm<{ subject: string; description: string; reason?: string }>();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const users = useQuery({
    queryKey: ['voice', 'users'],
    queryFn: () => api.users({ maxSize: 100, isActive: 'true' }),
    staleTime: 300_000,
  });
  const timeline = useQuery({
    queryKey: ['voice', 'timeline', conversation.id],
    queryFn: () => api.voiceConversationTimeline(conversation.id, { limit: 200 }),
    refetchInterval: 15_000,
  });

  const entries = timeline.data?.entries ?? [];

  // A conversation reads from the newest message up, like the Chat workspace.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [entries.length, conversation.id]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['voice', 'inbox'] });
    void queryClient.invalidateQueries({ queryKey: ['voice', 'timeline', conversation.id] });
    onChanged();
  };

  const mutate = useMutation({
    mutationFn: async (
      input: { kind: 'status'; status: string } | { kind: 'assign'; userId: string | null } | { kind: 'read' },
    ) => {
      if (input.kind === 'status') return api.voiceSetConversationStatus(conversation.id, input.status);
      if (input.kind === 'assign') return api.voiceAssignConversation(conversation.id, { userId: input.userId });
      return api.voiceMarkConversationRead(conversation.id);
    },
    onSuccess: () => refresh(),
    onError: (error) => void message.error(error instanceof Error ? error.message : t('voice.inbox.actionFailed')),
  });

  const userOptions = (users.data?.list ?? []).map((user) => ({ value: user.id, label: user.name || user.userName }));

  return (
    <section className="carocrm-workspace-main" aria-label={conversation.subject ?? conversation.id}>
      <div className="carocrm-workspace-toolbar carocrm-workspace-toolbar--stacked">
        <div className="carocrm-workspace-toolbar-lead">
          <span className="carocrm-workspace-toolbar-title">
            {conversation.subject ?? conversation.externalThreadId ?? conversation.id}
          </span>
          <div className="carocrm-workspace-toolbar-tags">
            <Tag color={channelColor(conversation.channel)} bordered={false}>
              {t(`voice.channel.${conversation.channel}`)}
            </Tag>
            <Tag color={statusColor(conversation.status)} bordered={false}>
              {statusLabel(conversation.status)}
            </Tag>
            {conversation.caseId !== null ? (
              <Tag color="magenta" bordered={false} title={conversation.caseId}>
                {t('voice.inbox.linkedCase', { id: conversation.caseId })}
              </Tag>
            ) : null}
          </div>
        </div>

        <div className="carocrm-workspace-toolbar-actions">
          <Select
            size="small"
            style={{ width: 150 }}
            placeholder={t('voice.inbox.assignPlaceholder')}
            value={conversation.assignedUserId ?? undefined}
            options={userOptions}
            onChange={(userId) => mutate.mutate({ kind: 'assign', userId: userId ?? null })}
            allowClear
            showSearch
            optionFilterProp="label"
          />
          <Select
            size="small"
            style={{ width: 130 }}
            value={conversation.status}
            options={STATUSES.map((status) => ({ value: status, label: statusLabel(status) }))}
            onChange={(status) => mutate.mutate({ kind: 'status', status })}
          />
          <Tooltip title={t('voice.inbox.markRead')}>
            <Button
              size="small"
              icon={<CheckOutlined />}
              aria-label={t('voice.inbox.markRead')}
              onClick={() => mutate.mutate({ kind: 'read' })}
              disabled={conversation.unreadCount === 0}
            />
          </Tooltip>
          <Button
            size="small"
            icon={<CustomerServiceOutlined />}
            onClick={() => {
              handoffForm.setFieldsValue({
                subject: conversation.subject ?? conversation.externalThreadId ?? t('voice.inbox.handoffDefaultSubject'),
                description: '',
              });
              setHandoffOpen(true);
            }}
          >
            {conversation.caseId === null ? t('voice.inbox.handoff') : t('voice.inbox.handoffAgain')}
          </Button>
        </div>
      </div>

      <div className="carocrm-workspace-body">
        <div className="carocrm-workspace-scroll carocrm-workspace-scroll--tight" ref={scrollRef}>
          {timeline.isLoading ? (
            <Skeleton active title={false} paragraph={{ rows: 5 }} />
          ) : entries.length === 0 ? (
            <div className="carocrm-workspace-empty">{t('voice.inbox.noMessages')}</div>
          ) : (
            entries.map((entry) =>
              entry.kind === 'message' ? (
                <TimelineMessage key={entry.id} entry={entry} />
              ) : (
                <TimelineEvent key={entry.id} entry={entry} />
              ),
            )
          )}
        </div>
      </div>

      <div className="carocrm-workspace-dock">
        <Composer conversation={conversation} onSent={refresh} />
      </div>

      <Modal
        open={handoffOpen}
        title={t('voice.inbox.handoffTitle')}
        okText={t('voice.inbox.handoffConfirm')}
        cancelText={t('voice.inbox.cancel')}
        onCancel={() => setHandoffOpen(false)}
        onOk={() => {
          void handoffForm.validateFields().then(async (values) => {
            try {
              const result = await api.voiceHandoffConversation(conversation.id, {
                subject: values.subject,
                description: values.description,
                ...(values.reason !== undefined && values.reason !== '' ? { reason: values.reason } : {}),
              });
              void message.success(
                result.duplicate
                  ? t('voice.inbox.handoffExisting', { id: result.caseId })
                  : t('voice.inbox.handoffCreated', { id: result.caseId }),
              );
              setHandoffOpen(false);
              refresh();
            } catch (error) {
              void message.error(error instanceof Error ? error.message : t('voice.inbox.handoffFailed'));
            }
          });
        }}
      >
        <Form form={handoffForm} layout="vertical">
          <Form.Item name="subject" label={t('voice.inbox.handoffSubject')} rules={[{ required: true, max: 256 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('voice.inbox.handoffDescription')} rules={[{ required: true, max: 10_000 }]}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          <Form.Item name="reason" label={t('voice.inbox.handoffReason')}>
            <Input maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

/** One call: the session facts, its recordings and its transcript. */
function CallPane({ call }: { call: VoiceCallSessionView | undefined }) {
  const inbound = call?.direction === 'inbound';
  return (
    <section className="carocrm-workspace-main" aria-label={t('voice.inbox.tabCalls')}>
      <div className="carocrm-workspace-toolbar">
        <div className="carocrm-workspace-toolbar-tags">
          <span className="carocrm-workspace-toolbar-title">
            {call === undefined ? t('voice.inbox.tabCalls') : ((inbound ? call.fromNumber : call.toNumber) ?? '—')}
          </span>
          {call === undefined ? null : (
            <>
              <Tag bordered={false}>{inbound ? t('voice.inbox.inbound') : t('voice.inbox.outbound')}</Tag>
              <Tag bordered={false}>{call.state}</Tag>
              {call.durationSeconds === null ? null : <Tag bordered={false}>{`${call.durationSeconds}s`}</Tag>}
            </>
          )}
        </div>
      </div>

      <div className="carocrm-workspace-body">
        <div className="carocrm-workspace-scroll carocrm-workspace-scroll--top">
          {call === undefined ? (
            <div className="carocrm-workspace-empty">{t('voice.inbox.callsHint')}</div>
          ) : (
            <VoiceCallDetail call={call} />
          )}
        </div>
      </div>
    </section>
  );
}

export function VoiceInboxPage() {
  usePageTitle(t('voice.inbox.title'));
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [surface, setSurface] = useState<'inbox' | 'calls'>('inbox');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [channel, setChannel] = useState<string | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [openCallId, setOpenCallId] = useState<string | undefined>(undefined);
  const [destination, setDestination] = useState('');
  const [placing, setPlacing] = useState(false);

  const inbox = useQuery({
    queryKey: ['voice', 'inbox', status ?? '', channel ?? '', mine],
    queryFn: () =>
      api.voiceInbox({
        limit: 50,
        ...(status !== undefined ? { status } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...(mine ? { assignee: 'me' } : {}),
      }),
    refetchInterval: 20_000,
  });

  // The call log only polls while its surface is on screen.
  const calls = useQuery({
    queryKey: ['voice', 'calls'],
    queryFn: () => api.voiceCalls({ limit: 50 }),
    refetchInterval: 30_000,
    enabled: surface === 'calls',
  });

  const conversations = useMemo(() => inbox.data?.list ?? [], [inbox.data]);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0];
  const unread = conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
  const callList = useMemo(() => calls.data?.list ?? [], [calls.data]);
  const selectedCall = callList.find((call) => call.id === openCallId) ?? callList[0];

  /** Click-to-call (§7.1): the key is client-generated, so a double click is one call, not two. */
  const place = async (): Promise<void> => {
    if (destination.trim() === '') return;
    setPlacing(true);
    try {
      const result = await api.voiceInitiateCall({ to: destination.trim(), idempotencyKey: `click-${crypto.randomUUID()}` });
      setDestination('');
      void message.success(
        result.session.state === 'failed'
          ? t('voice.inbox.callFailed', { reason: result.session.failureCategory ?? 'unknown' })
          : t('voice.inbox.callPlaced'),
      );
      await queryClient.invalidateQueries({ queryKey: ['voice', 'calls'] });
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('voice.inbox.callFailedGeneric'));
    } finally {
      setPlacing(false);
    }
  };

  const reload = (): void => {
    void inbox.refetch();
    if (surface === 'calls') void calls.refetch();
  };

  return (
    <div className="carocrm-workspace-page">
      <div className="carocrm-workspace-page-head">
        <div className="carocrm-workspace-page-head-main">
          <span className="carocrm-workspace-mark" aria-hidden="true">
            <PhoneOutlined />
          </span>
          <div>
            <h1 className="carocrm-workspace-title">{t('voice.inbox.title')}</h1>
            <p className="carocrm-workspace-sub">{t('voice.inbox.subtitle')}</p>
          </div>
          {unread > 0 ? (
            <span className="carocrm-workspace-pill carocrm-workspace-pill--warn">
              {t('voice.inbox.unread', { count: unread })}
            </span>
          ) : null}
        </div>
        <Space size={8}>
          <Segmented
            value={surface}
            onChange={(value) => setSurface(value as 'inbox' | 'calls')}
            options={[
              { value: 'inbox', label: t('voice.inbox.tabInbox') },
              { value: 'calls', label: t('voice.inbox.tabCalls') },
            ]}
          />
          <Tooltip title={t('voice.page.reload')}>
            <Button
              icon={<ReloadOutlined />}
              loading={inbox.isFetching || calls.isFetching}
              aria-label={t('voice.page.reload')}
              onClick={reload}
            />
          </Tooltip>
        </Space>
      </div>

      <div className="carocrm-workspace">
        {surface === 'inbox' ? (
          <InboxRail
            conversations={conversations}
            loading={inbox.isLoading}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            status={status}
            onStatus={setStatus}
            channel={channel}
            onChannel={setChannel}
            mine={mine}
            onMine={setMine}
          />
        ) : (
          <CallsRail
            calls={callList}
            loading={calls.isLoading}
            selectedId={selectedCall?.id}
            onSelect={setOpenCallId}
            destination={destination}
            onDestination={setDestination}
            placing={placing}
            onPlace={() => void place()}
          />
        )}

        {surface === 'inbox' ? (
          selected === undefined ? (
            <section className="carocrm-workspace-main">
              <div className="carocrm-workspace-body">
                <div className="carocrm-workspace-empty">{t('voice.inbox.selectConversation')}</div>
              </div>
            </section>
          ) : (
            <ConversationPane key={selected.id} conversation={selected} onChanged={() => void inbox.refetch()} />
          )
        ) : (
          <CallPane call={selectedCall} />
        )}
      </div>
    </div>
  );
}
