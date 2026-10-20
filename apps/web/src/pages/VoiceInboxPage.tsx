import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CustomerServiceOutlined,
  PhoneOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type {
  VoiceCallSessionView,
  VoiceComposerValidation,
  VoiceConversationView,
  VoiceSnippetView,
  VoiceTimelineEntry,
} from '../api/types.js';
import { VoiceCallDetail } from '../components/VoiceCallDetail.js';
import { formatDateTime, t } from '../state/i18n.js';

/**
 * Phase 19-VC.12–19-VC.14 — the agent workspace
 * (`PLAN_Phase_19_Voice_Communications.md` §9–§10, §15 `19-VC.12` … `19-VC.14`).
 *
 * One screen with two surfaces: the conversation inbox (list + timeline + composer) and the call log
 * (session detail, recordings, transcript). The server decides visibility, policy and idempotency:
 * every mutation here is one documented action, and a refusal is rendered with the server's own
 * reason. Internal notes are badged and never styled as customer text.
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

/** One message bubble. An internal note is visibly not a customer message (§9.1). */
function TimelineMessage({ entry }: { entry: VoiceTimelineEntry }) {
  const message = entry.message;
  if (message === undefined) return null;
  const outbound = message.direction === 'outbound';
  return (
    <div style={{ display: 'flex', justifyContent: outbound ? 'flex-end' : 'flex-start', marginBlock: 6 }}>
      <div
        style={{
          maxWidth: '78%',
          padding: '8px 12px',
          borderRadius: 12,
          background: message.isInternalNote ? '#fffbe6' : outbound ? '#e6f4ff' : '#f5f5f5',
          border: message.isInternalNote ? '1px dashed #d4b106' : '1px solid #eee',
        }}
      >
        <Space size={6} wrap style={{ marginBottom: 4 }}>
          <Tag color={message.isInternalNote ? 'gold' : outbound ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
            {message.isInternalNote ? t('voice.inbox.internalNote') : outbound ? t('voice.inbox.outbound') : t('voice.inbox.inbound')}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(entry.at)}
          </Typography.Text>
          {outbound && !message.isInternalNote ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {message.state}
            </Typography.Text>
          ) : null}
        </Space>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message.body ?? ''}</div>
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
    <div style={{ textAlign: 'center', marginBlock: 8 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {detail} · {formatDateTime(entry.at)}
        {event.detail !== null && event.detail !== '' ? ` · ${event.detail}` : ''}
      </Typography.Text>
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
        style={{ minWidth: 180 }}
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
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input.TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        autoSize={{ minRows: 2, maxRows: 6 }}
        maxLength={4000}
        placeholder={internal ? t('voice.inbox.notePlaceholder') : t('voice.inbox.messagePlaceholder')}
      />
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space wrap>
          <SnippetPicker
            snippets={snippets.data?.list ?? []}
            channel={channel}
            onInsert={(text) => setBody((current) => (current.trim() === '' ? text : `${current}\n${text}`))}
          />
          <Tooltip title={t('voice.inbox.internalNoteHint')}>
            <Space size={4}>
              <Switch size="small" checked={internal} onChange={setInternal} />
              <Typography.Text type="secondary">{t('voice.inbox.internalNote')}</Typography.Text>
            </Space>
          </Tooltip>
        </Space>
        <Space>
          {validation !== undefined ? (
            <Typography.Text type={validation.ok ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
              {t('voice.inbox.segments', {
                count: validation.segments.segments,
                encoding: validation.segments.encoding,
                chars: validation.segments.characters,
              })}
              {validation.warnings.length > 0 ? ` · ${validation.warnings[0] ?? ''}` : ''}
            </Typography.Text>
          ) : null}
          <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void send()}>
            {internal ? t('voice.inbox.saveNote') : t('voice.inbox.send')}
          </Button>
        </Space>
      </Space>
    </Space>
  );
}

function ConversationDetail({ conversation, onChanged }: { conversation: VoiceConversationView; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffForm] = Form.useForm<{ subject: string; description: string; reason?: string }>();
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

  const entries = timeline.data?.entries ?? [];
  const userOptions = (users.data?.list ?? []).map((user) => ({ value: user.id, label: user.name || user.userName }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space wrap>
          <Typography.Text strong style={{ fontSize: 16 }}>
            {conversation.subject ?? conversation.externalThreadId ?? conversation.id}
          </Typography.Text>
          <Tag color={channelColor(conversation.channel)}>{t(`voice.channel.${conversation.channel}`)}</Tag>
          <Tag color={statusColor(conversation.status)}>{statusLabel(conversation.status)}</Tag>
          {conversation.caseId !== null ? <Tag color="magenta">{t('voice.inbox.linkedCase', { id: conversation.caseId })}</Tag> : null}
        </Space>
        <Space wrap>
          <Select
            size="small"
            style={{ width: 170 }}
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
            style={{ width: 150 }}
            value={conversation.status}
            options={STATUSES.map((status) => ({ value: status, label: statusLabel(status) }))}
            onChange={(status) => mutate.mutate({ kind: 'status', status })}
          />
          <Button size="small" onClick={() => mutate.mutate({ kind: 'read' })} disabled={conversation.unreadCount === 0}>
            {t('voice.inbox.markRead')}
          </Button>
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
        </Space>
      </Space>

      <div style={{ maxHeight: 420, overflowY: 'auto', paddingInlineEnd: 4 }}>
        {timeline.isLoading ? (
          <Spin />
        ) : entries.length === 0 ? (
          <Empty description={t('voice.inbox.noMessages')} />
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

      <Composer conversation={conversation} onSent={refresh} />

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
    </Space>
  );
}

/** The call log: session state and the detail panel (recordings + transcript). */
function CallsPanel() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [destination, setDestination] = useState('');
  const [placing, setPlacing] = useState(false);
  const calls = useQuery({
    queryKey: ['voice', 'calls'],
    queryFn: () => api.voiceCalls({ limit: 50 }),
    refetchInterval: 30_000,
  });

  /** Click-to-call (§7.1): the key is client-generated, so a double click is one call, not two. */
  const place = async () => {
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
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const selected: VoiceCallSessionView | undefined = (calls.data?.list ?? []).find((call) => call.id === openId);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input
          placeholder={t('voice.inbox.callPlaceholder')}
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          onPressEnter={() => void place()}
          maxLength={64}
        />
        <Button type="primary" icon={<PhoneOutlined />} loading={placing} onClick={() => void place()}>
          {t('voice.inbox.call')}
        </Button>
      </Space.Compact>
      <List
        loading={calls.isLoading}
        dataSource={[...(calls.data?.list ?? [])]}
        locale={{ emptyText: <Empty description={t('voice.inbox.noCalls')} /> }}
        renderItem={(call) => (
          <List.Item
            actions={[
              <Button key="open" size="small" onClick={() => setOpenId(openId === call.id ? undefined : call.id)}>
                {openId === call.id ? t('voice.inbox.close') : t('voice.inbox.open')}
              </Button>,
            ]}
          >
            <List.Item.Meta
              avatar={call.direction === 'inbound' ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
              title={
                <Space wrap>
                  <Typography.Text strong>
                    {call.direction === 'inbound' ? call.fromNumber ?? '—' : call.toNumber ?? '—'}
                  </Typography.Text>
                  <Tag>{call.state}</Tag>
                  {call.durationSeconds !== null ? (
                    <Typography.Text type="secondary">{`${call.durationSeconds}s`}</Typography.Text>
                  ) : null}
                  {call.failureCategory !== null ? <Tag color="red">{call.failureCategory}</Tag> : null}
                </Space>
              }
              description={formatDateTime(call.startedAt ?? call.createdAt)}
            />
          </List.Item>
        )}
      />
      {selected !== undefined ? <VoiceCallDetail call={selected} /> : null}
    </Space>
  );
}

export function VoiceInboxPage() {
  const [surface, setSurface] = useState<'inbox' | 'calls'>('inbox');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [channel, setChannel] = useState<string | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

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

  const conversations = useMemo(() => inbox.data?.list ?? [], [inbox.data]);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) 1fr', gap: 16, alignItems: 'start' }}>
      <Card
        className="carocrm-card"
        size="small"
        title={
          <Space>
            <PhoneOutlined />
            <Typography.Text strong>{t('voice.inbox.title')}</Typography.Text>
            <Badge count={conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0)} size="small" />
          </Space>
        }
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void inbox.refetch()} aria-label={t('voice.page.reload')} />
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Segmented
            block
            size="small"
            value={surface}
            onChange={(value) => setSurface(value as 'inbox' | 'calls')}
            options={[
              { value: 'inbox', label: t('voice.inbox.tabInbox') },
              { value: 'calls', label: t('voice.inbox.tabCalls') },
            ]}
          />
          {surface === 'inbox' ? (
            <>
              <Space wrap size={6}>
                <Select
                  size="small"
                  allowClear
                  placeholder={t('voice.inbox.filterStatus')}
                  style={{ width: 140 }}
                  value={status}
                  onChange={setStatus}
                  options={STATUSES.map((value) => ({ value, label: statusLabel(value) }))}
                />
                <Select
                  size="small"
                  allowClear
                  placeholder={t('voice.inbox.filterChannel')}
                  style={{ width: 120 }}
                  value={channel}
                  onChange={setChannel}
                  options={['sms', 'mms', 'whatsapp'].map((value) => ({ value, label: t(`voice.channel.${value}`) }))}
                />
                <Tooltip title={t('voice.inbox.onlyMineHint')}>
                  <Space size={4}>
                    <Switch size="small" checked={mine} onChange={setMine} />
                    <TeamOutlined />
                  </Space>
                </Tooltip>
              </Space>
              <List
                loading={inbox.isLoading}
                dataSource={[...conversations]}
                locale={{ emptyText: <Empty description={t('voice.inbox.empty')} /> }}
                renderItem={(conversation) => (
                  <List.Item
                    onClick={() => setSelectedId(conversation.id)}
                    style={{
                      cursor: 'pointer',
                      paddingInline: 8,
                      borderRadius: 8,
                      background: selected?.id === conversation.id ? '#f0f5ff' : undefined,
                    }}
                  >
                    <List.Item.Meta
                      title={
                        <Space wrap size={4}>
                          <Typography.Text strong ellipsis style={{ maxWidth: 150 }}>
                            {conversation.subject ?? conversation.externalThreadId ?? conversation.id}
                          </Typography.Text>
                          <Badge count={conversation.unreadCount} size="small" />
                        </Space>
                      }
                      description={
                        <Space wrap size={4}>
                          <Tag color={channelColor(conversation.channel)} style={{ marginInlineEnd: 0 }}>
                            {t(`voice.channel.${conversation.channel}`)}
                          </Tag>
                          <Tag color={statusColor(conversation.status)} style={{ marginInlineEnd: 0 }}>
                            {statusLabel(conversation.status)}
                          </Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {formatDateTime(conversation.lastActivityAt)}
                          </Typography.Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('voice.inbox.callsHint')}
            </Typography.Text>
          )}
        </Space>
      </Card>

      <Card className="carocrm-card" size="small">
        {surface === 'calls' ? (
          <CallsPanel />
        ) : selected === undefined ? (
          <Empty description={t('voice.inbox.selectConversation')} />
        ) : (
          <ConversationDetail key={selected.id} conversation={selected} onChanged={() => void inbox.refetch()} />
        )}
      </Card>
    </div>
  );
}
