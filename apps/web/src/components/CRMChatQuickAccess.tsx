import { CustomerServiceOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Popover, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import { useCrmChatStream } from '../pages/crm-chat/useCrmChatStream.js';
import { t } from '../state/i18n.js';

const { TextArea } = Input;

/** One line of the quick thread. An empty assistant line is the pending answer. */
interface QuickMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** User-safe progress phases. The server never streams hidden reasoning, only lifecycle state. */
type TurnPhase = 'idle' | 'queued' | 'thinking' | 'tool' | 'finishing';

const CHAT_ROUTE = '/crm-chat';

/**
 * Header quick access to CRM Chat.
 *
 * The full workspace is a page; this is the shortcut people actually want — one click in the
 * header, ask a question, read the answer without leaving the screen they were on. It runs the
 * same turn API and the same SSE stream as the workspace, so the assistant, the permissions and
 * the conversation memory are identical: only the presentation is smaller.
 *
 * The panel deliberately does **not** decide what a write proposal means. A turn that asks for a
 * confirmation is announced and the user is sent to the full workspace, which owns the decision.
 */
export function CRMChatQuickAccess({ compact = false }: { readonly compact?: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<QuickMessage[]>([]);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [phase, setPhase] = useState<TurnPhase>('idle');
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // The live conversation id, so the answer can be read back before the first turn resolves.
  const conversationRef = useRef<string | null>(null);
  // Whether the answer of the running turn already arrived; then no read-back is needed.
  const answeredRef = useRef(false);

  // A visible clock is the honest "thinking" signal while the provider is still generating: the
  // transport streams lifecycle/tool events, not hidden reasoning tokens.
  useEffect(() => {
    if (turnId === null) {
      setElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [turnId]);

  // Keep the newest line in view.
  useEffect(() => {
    const node = threadRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages, phase]);

  /** Fills the pending answer line, or appends one when the answer arrived without a placeholder. */
  const applyAnswer = useCallback((content: string) => {
    if (content === '') return;
    answeredRef.current = true;
    setMessages((previous) => {
      const index = previous.findIndex((message) => message.role === 'assistant' && message.content === '');
      if (index === -1) return [...previous, { id: `a-${String(Date.now())}`, role: 'assistant', content }];
      const next = [...previous];
      const pending = next[index];
      if (pending === undefined) return [...previous, { id: `a-${String(Date.now())}`, role: 'assistant', content }];
      next[index] = { ...pending, content };
      return next;
    });
  }, []);

  /**
   * Reads the saved thread back when the stream closed before the answer arrived — the run writes
   * the assistant message just after the terminal event, so the conversation is the authority.
   */
  const syncAnswer = useCallback(() => {
    const id = conversationRef.current;
    if (id === null || answeredRef.current) return;
    void api
      .crmChatConversation(id)
      .then((detail) => {
        const last = [...detail.messages.list].reverse().find((message) => message.role === 'assistant');
        if (last !== undefined) applyAnswer(last.content);
      })
      .catch(() => undefined);
  }, [applyAnswer]);

  const stream = useCrmChatStream({
    turnId,
    enabled: turnId !== null,
    onEvent: (event) => {
      switch (event.event) {
        case 'turn.started':
          setPhase(event.data['state'] === 'running' ? 'thinking' : 'queued');
          break;
        case 'tool.started': {
          const label = event.data['label'];
          setToolLabel(typeof label === 'string' && label !== '' ? label : null);
          setPhase('tool');
          break;
        }
        case 'tool.completed':
          setToolLabel(null);
          setPhase('thinking');
          break;
        case 'assistant.message': {
          const content = event.data['content'];
          if (typeof content === 'string') applyAnswer(content);
          setPhase('finishing');
          break;
        }
        case 'action.proposed':
        case 'approval.required':
          // The decision belongs to the full workspace, which owns the proposal card.
          setNotice(t('web.crmChat.quickActionPending'));
          break;
        case 'turn.failed': {
          const message = event.data['message'];
          if (typeof message === 'string' && message !== '') setError(message);
          setPhase('idle');
          setToolLabel(null);
          setTurnId(null);
          break;
        }
        case 'turn.completed':
        case 'turn.cancelled':
          setPhase('idle');
          setToolLabel(null);
          setTurnId(null);
          syncAnswer();
          break;
        default:
          break;
      }
    },
    onError: (streamError) => {
      setPhase('idle');
      setToolLabel(null);
      const failedTurnId = turnId;
      setTurnId(null);
      if (failedTurnId === null) {
        setError(streamError.message);
        return;
      }
      // A transport close can race the final event; the run is authoritative.
      void api
        .crmChatGetTurn(failedTurnId)
        .then((status) => {
          if (status.status === 'succeeded' || status.status === 'partially_succeeded') {
            syncAnswer();
            return;
          }
          setError(
            status.status === 'queued' || status.status === 'running'
              ? t('web.crmChat.streamDisconnected')
              : (status.failureMessage ?? streamError.message),
          );
        })
        .catch(() => setError(streamError.message));
    },
    onComplete: () => {
      setPhase('idle');
      setToolLabel(null);
      setTurnId(null);
      syncAnswer();
    },
  });

  const busy = turnId !== null || submitting || stream.isConnected;
  const canSend = prompt.trim() !== '' && !busy;

  const send = () => {
    const text = prompt.trim();
    if (text === '' || busy) return;
    setError(null);
    setNotice(null);
    setPrompt('');
    setSubmitting(true);
    answeredRef.current = false;
    const stamp = String(Date.now());
    setMessages((previous) => [
      ...previous,
      { id: `u-${stamp}`, role: 'user', content: text },
      { id: `a-${stamp}`, role: 'assistant', content: '' },
    ]);
    void api
      .crmChatSubmitTurn({
        prompt: text,
        conversationId: conversationRef.current ?? undefined,
        idempotencyKey: `quick-${stamp}-${Math.random().toString(36).slice(2, 10)}`,
      })
      .then((result) => {
        if (result.conversationId !== null) {
          conversationRef.current = result.conversationId;
        }
        setTurnId(result.turnId);
        setPhase('queued');
      })
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : t('web.crmChat.errorTitle'));
        // Drop the placeholder for the answer that never arrived.
        setMessages((previous) => previous.filter((message) => !(message.role === 'assistant' && message.content === '')));
      })
      .finally(() => setSubmitting(false));
  };

  const startNew = () => {
    setMessages([]);
    conversationRef.current = null;
    setTurnId(null);
    setError(null);
    setNotice(null);
    setPhase('idle');
    setToolLabel(null);
    answeredRef.current = false;
  };

  const progressText = useMemo(() => {
    if (phase === 'tool' && toolLabel !== null) return t('web.crmChat.thinkingTool', { tool: toolLabel, seconds: elapsedSeconds });
    if (phase === 'queued') return t('web.crmChat.thinkingQueued', { seconds: elapsedSeconds });
    if (phase === 'finishing') return t('web.crmChat.thinkingFinishing', { seconds: elapsedSeconds });
    return t('web.crmChat.thinkingRunning', { seconds: elapsedSeconds });
  }, [phase, toolLabel, elapsedSeconds]);

  const panel = (
    <div className="carocrm-quick-chat">
      <div className="carocrm-quick-chat-head">
        <Typography.Text strong>{t('web.crmChat.quickTitle')}</Typography.Text>
        <Space size={4}>
          <Button size="small" type="text" onClick={startNew} disabled={messages.length === 0 && turnId === null}>
            {t('web.crmChat.newConversation')}
          </Button>
          <Button size="small" type="text" onClick={() => navigate(CHAT_ROUTE)}>
            {t('web.crmChat.quickOpenFull')}
          </Button>
        </Space>
      </div>

      <div className="carocrm-quick-chat-thread" ref={threadRef} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <Typography.Text type="secondary" className="carocrm-quick-chat-empty">
            {t('web.crmChat.quickEmpty')}
          </Typography.Text>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`carocrm-quick-chat-line carocrm-quick-chat-line--${message.role}`}>
              <span className="carocrm-quick-chat-role">{t(`web.crmChat.role.${message.role}`)}</span>
              <span className="carocrm-quick-chat-text">
                {message.content === '' ? <Spin size="small" /> : message.content}
              </span>
            </div>
          ))
        )}
      </div>

      {busy ? (
        <div className="carocrm-quick-chat-progress">
          <Spin size="small" />
          <Typography.Text type="secondary">{progressText}</Typography.Text>
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            onClick={() => {
              if (turnId !== null) void api.crmChatCancelTurn(turnId);
            }}
          >
            {t('web.crmChat.stopGeneration')}
          </Button>
        </div>
      ) : null}

      {error !== null ? (
        <Alert
          type="error"
          showIcon
          closable
          message={t('web.crmChat.errorTitle')}
          description={error}
          onClose={() => setError(null)}
        />
      ) : null}

      {notice !== null ? (
        <Alert type="info" showIcon closable message={notice} onClose={() => setNotice(null)} />
      ) : null}

      <div className="carocrm-quick-chat-compose">
        <TextArea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={2}
          disabled={busy}
          placeholder={t('web.crmChat.quickPlaceholder')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && canSend) {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          disabled={!canSend}
          loading={submitting}
          onClick={send}
          aria-label={t('web.crmChat.send')}
        />
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      title={null}
      content={panel}
      overlayClassName="carocrm-quick-chat-popover"
    >
      <Button
        type="text"
        className="carocrm-quick-chat-trigger"
        icon={<CustomerServiceOutlined />}
        aria-label={t('web.crmChat.quickAccess')}
        title={t('web.crmChat.quickAccess')}
      >
        {compact ? null : t('web.crmChat.quickAccess')}
      </Button>
    </Popover>
  );
}
