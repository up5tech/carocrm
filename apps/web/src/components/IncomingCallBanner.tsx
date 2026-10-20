import { CloseOutlined, PhoneFilled, PhoneOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Input, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { VoiceCallControlAction, VoiceCallerMatch, VoiceIncomingCallView } from '../api/types.js';
import { t } from '../state/i18n.js';

/**
 * Phase 19-VC.9 — the incoming-call banner
 * (`PLAN_Phase_19_Voice_Communications.md` §7.1–§7.2, §15 `19-VC.9`).
 *
 * The server decides **who** is notified (the call's assignee or the endpoint team's members) and
 * **which controls** a call accepts, so this component renders the number, the permitted caller
 * matches and exactly the actions `controls` names. A hang-up button never appears for a provider
 * that cannot perform one, and the API re-checks every action anyway — a hidden button is not a
 * permission. Polling is the documented transport because the platform has no realtime gateway.
 */
export function IncomingCallBanner() {
  const incoming = useQuery({
    queryKey: ['voice', 'incoming'],
    queryFn: () => api.voiceIncomingCalls(),
    refetchInterval: 10_000,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const visible = (incoming.data?.list ?? []).filter((call) => !dismissed.includes(call.id));
  if (visible.length === 0) return null;

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 1200, width: 336 }} role="status" aria-live="polite">
      <Space direction="vertical" style={{ width: '100%' }}>
        {visible.map((call) => (
          <IncomingCallCard key={call.id} call={call} onDismiss={() => setDismissed((current) => [...current, call.id])} />
        ))}
      </Space>
    </div>
  );
}

function IncomingCallCard({
  call,
  onDismiss,
}: {
  readonly call: VoiceIncomingCallView;
  readonly onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [note, setNote] = useState('');
  const [associatedId, setAssociatedId] = useState<string | null>(null);
  const inCall = call.state === 'in_progress';
  const accent = inCall ? '#55c27f' : '#438eff';

  const context = useQuery({
    queryKey: ['voice', 'call-context', call.id],
    queryFn: () => api.voiceCallContext(call.id),
    retry: false,
  });

  /** Every action refreshes the popup and the call log, so the card reflects the stored state now. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['voice', 'incoming'] });
    void queryClient.invalidateQueries({ queryKey: ['voice', 'calls'] });
  };

  const control = useMutation({
    mutationFn: (action: VoiceCallControlAction) => api.voiceCallControl(call.id, action),
    onSuccess: refresh,
    onError: (error: unknown) =>
      void message.error(error instanceof Error ? error.message : t('voice.inbox.actionFailed')),
  });

  const saveNote = useMutation({
    mutationFn: () => api.voiceCallNote(call.id, note.trim()),
    onSuccess: () => {
      setNote('');
      void message.success(t('voice.inbox.noteSaved'));
      refresh();
    },
    onError: (error: unknown) =>
      void message.error(error instanceof Error ? error.message : t('voice.inbox.actionFailed')),
  });

  const associate = useMutation({
    mutationFn: (match: VoiceCallerMatch) => api.voiceCallLink(call.id, match.entityType, match.id),
    onSuccess: (_session, match) => {
      setAssociatedId(match.id);
      void message.success(t('voice.inbox.associated'));
      refresh();
    },
    onError: (error: unknown) =>
      void message.error(error instanceof Error ? error.message : t('voice.inbox.actionFailed')),
  });

  const matches = (context.data?.matches ?? []).slice(0, 3);
  const hiddenMatches = context.data?.hiddenMatches ?? 0;
  const elapsed = inCall ? formatElapsed(call.answeredAt) : null;

  return (
    <Card
      size="small"
      style={{ borderColor: accent, boxShadow: '0 6px 20px rgba(0,0,0,0.12)' }}
      title={
        <Space>
          <PhoneOutlined style={{ color: accent }} />
          <Typography.Text strong>{t(inCall ? 'voice.inbox.inCall' : 'voice.inbox.incomingCall')}</Typography.Text>
        </Space>
      }
      extra={
        <Button
          type="text"
          size="small"
          aria-label={t('voice.inbox.dismiss')}
          icon={<CloseOutlined />}
          onClick={onDismiss}
        />
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space align="baseline" wrap size={6}>
          <Typography.Text strong style={{ fontSize: 18 }}>
            {call.fromNumber ?? '—'}
          </Typography.Text>
          {elapsed !== null ? <Typography.Text type="secondary">{elapsed}</Typography.Text> : null}
          {call.toNumber !== null ? <Tag>{call.toNumber}</Tag> : null}
          {call.failureCategory !== null ? <Tag color="red">{call.failureCategory}</Tag> : null}
        </Space>

        {context.isPending ? null : matches.length === 0 ? (
          <Typography.Text type="secondary">{t('voice.inbox.unknownCaller')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {matches.map((match) => (
              <Space key={match.id} size={6} wrap>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => navigate(`/${match.entityType}/${match.id}`)}
                >
                  {match.name}
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {match.entityType}
                </Typography.Text>
                {associatedId === match.id ? (
                  <Tag color="green">{t('voice.inbox.associated')}</Tag>
                ) : (
                  <Button size="small" loading={associate.isPending} onClick={() => associate.mutate(match)}>
                    {t('voice.inbox.associate')}
                  </Button>
                )}
              </Space>
            ))}
            {hiddenMatches > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('voice.inbox.hiddenMatches', { count: hiddenMatches })}
              </Typography.Text>
            ) : null}
          </Space>
        )}

        {call.controls.length > 0 ? (
          <Space wrap size={8}>
            {call.controls.includes('answer') ? (
              <Button
                type="primary"
                icon={<PhoneFilled />}
                loading={control.isPending && control.variables === 'answer'}
                onClick={() => control.mutate('answer')}
              >
                {t('voice.inbox.accept')}
              </Button>
            ) : null}
            {call.controls.includes('hangup') ? (
              <Button
                danger
                loading={control.isPending && control.variables === 'hangup'}
                onClick={() => control.mutate('hangup')}
              >
                {t(inCall ? 'voice.inbox.hangUp' : 'voice.inbox.decline')}
              </Button>
            ) : null}
          </Space>
        ) : null}

        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="small"
            placeholder={t('voice.inbox.notePlaceholder')}
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            onPressEnter={() => {
              if (note.trim() !== '' && !saveNote.isPending) saveNote.mutate();
            }}
          />
          <Button
            size="small"
            disabled={note.trim() === ''}
            loading={saveNote.isPending}
            onClick={() => saveNote.mutate()}
          >
            {t('voice.inbox.saveNote')}
          </Button>
        </Space.Compact>

        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }}
          onClick={() => navigate('/voice-inbox')}
        >
          {t('voice.inbox.openInbox')}
        </Button>
      </Space>
    </Card>
  );
}

/** `m:ss` since the answer, refreshed with each popup poll; null for a call that was never answered. */
function formatElapsed(answeredAt: string | null): string | null {
  if (answeredAt === null) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(answeredAt).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
