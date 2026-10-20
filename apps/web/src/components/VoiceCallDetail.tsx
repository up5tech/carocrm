import { AudioOutlined, FileTextOutlined, PlayCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Empty, List, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

import { api } from '../api/client.js';
import type { VoiceCallSessionView, VoiceMediaView, VoiceTranscriptView } from '../api/types.js';
import { formatDateTime, t } from '../state/i18n.js';

/**
 * Phase 19-VC.15–19-VC.16 — one call's media and transcript
 * (`PLAN_Phase_19_Voice_Communications.md` §7.5–§7.6, §15 `19-VC.15`, `19-VC.16`).
 *
 * Playback goes through the API, which authorizes the parent call and serves the bytes from private
 * storage — the browser never sees a provider URL or token. The transcript is opt-in and the AI
 * summary is **draft-only**: the panel shows the review state and offers approve/dismiss, never an
 * automatic send.
 */

function RecordingPlayer({ media }: { media: VoiceMediaView }) {
  const { message } = AntApp.useApp();
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const urlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (urlRef.current !== undefined) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.voiceMediaPlayback(media.id);
      const bytes = Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
      if (urlRef.current !== undefined) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('voice.inbox.mediaFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Button size="small" icon={<PlayCircleOutlined />} loading={loading} onClick={() => void load()}>
          {t('voice.inbox.loadRecording')}
        </Button>
        <Tag>{media.mimeType ?? 'audio'}</Tag>
        {media.durationSeconds !== null ? <Typography.Text type="secondary">{`${media.durationSeconds}s`}</Typography.Text> : null}
        <Typography.Text type="secondary">
          {t('voice.inbox.retentionUntil', { date: formatDateTime(media.retentionAt, false) })}
        </Typography.Text>
      </Space>
      {src !== undefined ? <audio controls src={src} style={{ width: '100%' }} /> : null}
    </Space>
  );
}

function TranscriptBlock({ callId }: { callId: string }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const transcript = useQuery({
    queryKey: ['voice', 'transcript', callId],
    queryFn: () => api.voiceCallTranscript(callId),
    retry: false,
  });
  const view: VoiceTranscriptView | null = transcript.data?.transcript ?? null;

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['voice', 'transcript', callId] });
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('voice.inbox.transcriptFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <FileTextOutlined />
          <Typography.Text strong>{t('voice.inbox.transcript')}</Typography.Text>
          {view !== null ? <Tag>{view.state}</Tag> : null}
        </Space>
      }
      extra={
        <Space>
          <Button
            size="small"
            loading={busy === 'request'}
            onClick={() => void run('request', () => api.voiceRequestTranscript(callId))}
          >
            {view === null ? t('voice.inbox.requestTranscript') : t('voice.inbox.refreshTranscript')}
          </Button>
          <Button
            size="small"
            icon={<RobotOutlined />}
            disabled={view === null || view.state !== 'ready'}
            loading={busy === 'enrich'}
            onClick={() => void run('enrich', () => api.voiceEnrichTranscript(callId))}
          >
            {t('voice.inbox.enrich')}
          </Button>
        </Space>
      }
    >
      {transcript.isLoading ? (
        <Typography.Text type="secondary">{t('core.common.loading')}</Typography.Text>
      ) : view === null ? (
        <Empty description={t('voice.inbox.noTranscript')} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {view.error !== null ? <Alert type="warning" showIcon message={view.error} /> : null}
          {view.segments.length > 0 ? (
            <List
              size="small"
              dataSource={[...view.segments]}
              renderItem={(segment) => (
                <List.Item>
                  <Space align="start">
                    <Tag>{segment.speaker ?? '—'}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12, minWidth: 48 }}>
                      {`${Math.round(segment.startMs / 1000)}s`}
                    </Typography.Text>
                    <Typography.Text>{segment.text}</Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          ) : null}
          {view.ai.reviewStatus !== 'none' ? (
            <Card size="small" type="inner" title={<Space><RobotOutlined />{t('voice.inbox.aiDraft')}</Space>}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color={view.ai.reviewStatus === 'approved' ? 'green' : view.ai.reviewStatus === 'dismissed' ? 'default' : 'gold'}>
                    {view.ai.reviewStatus}
                  </Tag>
                  {view.ai.model !== null ? <Tag>{view.ai.model}</Tag> : null}
                  {view.ai.generatedAt !== null ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDateTime(view.ai.generatedAt)}
                    </Typography.Text>
                  ) : null}
                </Space>
                {view.ai.summary !== null ? <Typography.Paragraph>{view.ai.summary}</Typography.Paragraph> : null}
                {view.ai.topics.length > 0 ? (
                  <Space wrap>{view.ai.topics.map((topic) => <Tag key={topic}>{topic}</Tag>)}</Space>
                ) : null}
                {view.ai.actions.length > 0 ? (
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {view.ai.actions.map((action) => <li key={action}>{action}</li>)}
                  </ul>
                ) : null}
                {view.ai.suggestedReply !== null ? (
                  <Alert type="info" showIcon message={t('voice.inbox.suggestedReply')} description={view.ai.suggestedReply} />
                ) : null}
                <Space>
                  <Button
                    size="small"
                    disabled={view.ai.suggestedReply === null || view.ai.reviewStatus === 'approved'}
                    loading={busy === 'approve'}
                    onClick={() => void run('approve', () => api.voiceReviewTranscript(callId, 'approved'))}
                  >
                    {t('voice.inbox.approveDraft')}
                  </Button>
                  <Button
                    size="small"
                    loading={busy === 'dismiss'}
                    onClick={() => void run('dismiss', () => api.voiceReviewTranscript(callId, 'dismissed'))}
                  >
                    {t('voice.inbox.dismissDraft')}
                  </Button>
                </Space>
              </Space>
            </Card>
          ) : null}
        </Space>
      )}
    </Card>
  );
}

export function VoiceCallDetail({ call }: { call: VoiceCallSessionView }) {
  const media = useQuery({
    queryKey: ['voice', 'media', call.id],
    queryFn: () => api.voiceCallMedia(call.id),
  });
  const recordings = (media.data?.list ?? []).filter((entry) => entry.kind === 'recording');

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Descriptions
        size="small"
        column={{ xs: 1, md: 2 }}
        items={[
          { key: 'direction', label: t('voice.inbox.direction'), children: call.direction },
          { key: 'state', label: t('voice.inbox.state'), children: <Tag>{call.state}</Tag> },
          { key: 'from', label: t('voice.inbox.from'), children: call.fromNumber ?? '—' },
          { key: 'to', label: t('voice.inbox.to'), children: call.toNumber ?? '—' },
          { key: 'started', label: t('voice.inbox.started'), children: formatDateTime(call.startedAt) },
          { key: 'duration', label: t('voice.inbox.duration'), children: call.durationSeconds === null ? '—' : `${call.durationSeconds}s` },
          { key: 'result', label: t('voice.inbox.result'), children: call.result ?? '—' },
          { key: 'activity', label: t('voice.inbox.activity'), children: call.activityId ?? '—' },
        ]}
      />
      <Card size="small" title={<Space><AudioOutlined />{t('voice.inbox.recordings')}</Space>}>
        {recordings.length === 0 ? (
          <Empty description={t('voice.inbox.noRecordings')} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {recordings.map((media) => <RecordingPlayer key={media.id} media={media} />)}
          </Space>
        )}
      </Card>
      <TranscriptBlock callId={call.id} />
    </Space>
  );
}
