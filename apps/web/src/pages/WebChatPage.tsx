import { SendOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '../state/i18n.js';
import { errorText } from './omnichannel/refusals.js';

/**
 * Phase 19-OM.9 — the public website-chat widget (`/chat`, contract §7).
 *
 * This page is deliberately outside the CRM session: a visitor has no account. It talks only to
 * `/api/v1/Omnichannel/chat/*` with the same-origin httpOnly session cookie, renders only the
 * messages the server already filtered (`is_internal_note = false`), and shows the operator's consent
 * notice before the first message. There is no CRM data on this screen, no token in storage, and no
 * route through the authenticated API client.
 *
 * A 403 means the operator has not opened the channel (or this origin is not allowed); a 401 means
 * the session expired and a new one is requested. Polling keeps the exchange simple until the shared
 * realtime seam (decision D3) reaches this surface.
 */

interface ChatMessage {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  readonly createdAt: string;
  readonly state?: string;
  readonly clientMessageId?: string | null;
}

interface SessionView {
  readonly status: 'new' | 'resumed';
  readonly expiresAt: string;
  readonly consent: { readonly required: boolean; readonly state: string; readonly version: string; readonly text: string };
  readonly messages: readonly ChatMessage[];
}

async function chatFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/Omnichannel/chat${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; details?: { refusals?: string[] } };
    };
    // The refusal codes travel with the error, so the widget can say *why* in the visitor's language
    // instead of showing the server's English sentence.
    throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), {
      status: response.status,
      body,
    });
  }
  return (await response.json()) as T;
}

export function WebChatPage() {
  const [session, setSession] = useState<SessionView | undefined>(undefined);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [consentGiven, setConsentGiven] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const lastId = useRef<string | undefined>(undefined);
  const started = useRef(false);

  const start = useCallback(async () => {
    try {
      setError(undefined);
      const view = await chatFetch<SessionView>('/session', { method: 'POST', body: '{}' });
      setSession(view);
      setMessages(view.messages);
      setConsentGiven(view.consent.state === 'granted' || !view.consent.required);
      lastId.current = view.messages.at(-1)?.id;
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      setError(status === 403 ? t('omnichannel.chat.closed') : t('omnichannel.chat.unavailable'));
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  useEffect(() => {
    if (session === undefined) return undefined;
    const timer = window.setInterval(() => {
      const query = lastId.current === undefined ? '' : `?after=${encodeURIComponent(lastId.current)}`;
      void chatFetch<{ messages: readonly ChatMessage[] }>(`/messages${query}`)
        .then((page) => {
          if (page.messages.length === 0) return;
          lastId.current = page.messages.at(-1)?.id ?? lastId.current;
          setMessages((current) => {
            const byId = new Map(current.map((message) => [message.id, message] as const));
            for (const message of page.messages) {
              // Reconcile an optimistic bubble with the server row that carries the same client id,
              // so a sent message is never shown twice.
              if (message.clientMessageId !== null && message.clientMessageId !== undefined) {
                for (const existing of current) {
                  if (existing.id.startsWith('pending_') && existing.clientMessageId === message.clientMessageId) {
                    byId.delete(existing.id);
                  }
                }
              }
              byId.set(message.id, message);
            }
            return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
          });
        })
        .catch((cause: unknown) => {
          const status = (cause as { status?: number }).status;
          if (status === 401) {
            void start();
            return;
          }
          // A rate limit or a temporary failure is the visitor's business: say so instead of
          // pretending the conversation is quiet.
          setError(status === 429 ? t('omnichannel.chat.rateLimited') : t('omnichannel.chat.connectionLost'));
        });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [session, start]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (body === '' || sending) return;
    setSending(true);
    setError(undefined);
    const clientMessageId = crypto.randomUUID();
    try {
      await chatFetch('/messages', {
        method: 'POST',
        body: JSON.stringify({ clientMessageId, body, ...(consentGiven ? {} : { consent: true }) }),
      });
      setConsentGiven(true);
      setDraft('');
      setMessages((current) => [...current, { id: `pending_${clientMessageId}`, direction: 'inbound', body, createdAt: new Date().toISOString(), clientMessageId }]);
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status === 429) setError(t('omnichannel.chat.rateLimited'));
      else setError(errorText(cause, 'omnichannel.chat.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
      <Card className="carocrm-card" title={t('omnichannel.chat.title')}>
        {error !== undefined ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        {session === undefined ? (
          <Typography.Text type="secondary">{t('omnichannel.chat.connecting')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {!consentGiven ? (
              <Alert
                type="info"
                showIcon
                message={session.consent.text}
                action={
                  <Button size="small" onClick={() => setConsentGiven(true)}>
                    {t('omnichannel.chat.consentAccept')}
                  </Button>
                }
              />
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflowY: 'auto' }} aria-live="polite">
              {messages.length === 0 ? (
                <Typography.Text type="secondary">{t('omnichannel.chat.empty')}</Typography.Text>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    style={{
                      alignSelf: message.direction === 'inbound' ? 'flex-end' : 'flex-start',
                      background: message.direction === 'inbound' ? 'var(--carocrm-accent-soft)' : 'var(--carocrm-surface-sunken)',
                      borderRadius: 12,
                      padding: '8px 12px',
                      maxWidth: '82%',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    <Typography.Text>{message.body}</Typography.Text>
                  </div>
                ))
              )}
            </div>
            <Space.Compact style={{ width: '100%' }}>
              <Input.TextArea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t('omnichannel.chat.placeholder')}
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={2_000}
                disabled={!consentGiven || sending}
                onPressEnter={(event) => {
                  if (!event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                aria-label={t('omnichannel.chat.placeholder')}
              />
              <Button type="primary" icon={<SendOutlined />} onClick={() => void send()} loading={sending} disabled={!consentGiven || draft.trim() === ''}>
                {t('omnichannel.chat.send')}
              </Button>
            </Space.Compact>
          </Space>
        )}
      </Card>
    </div>
  );
}
