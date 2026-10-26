import { CustomerServiceOutlined, PhoneOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, List, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { VoiceCallSessionView } from '../api/types.js';
import { formatDateTime, t } from '../state/i18n.js';
import { EmptyState } from './EmptyState.js';
import { VoiceCallDetail } from './VoiceCallDetail.js';

/**
 * Phase 19-VC.17 — the Communications panel on a CRM record
 * (`PLAN_Phase_19_Voice_Communications.md` §10.4, §15 `19-VC.17`).
 *
 * The panel is **record-ACL aware by construction**: the request carries the record the operator is
 * already looking at, and the server answers only if that record is readable. It renders summaries
 * (conversation subject/status, call state/duration) and loads message bodies, recordings and
 * transcripts lazily — a call is expanded, not prefetched.
 *
 * The panel renders nothing when the record has no communication history, so an untouched record
 * does not gain an empty card.
 */
const PANEL_ENTITIES = new Set(['Account', 'Contact', 'Lead', 'Opportunity', 'Case']);

export function CommunicationsPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const navigate = useNavigate();
  const [openCall, setOpenCall] = useState<string | undefined>(undefined);
  const enabled = PANEL_ENTITIES.has(entityType);
  const panel = useQuery({
    queryKey: ['voice', 'panel', entityType, entityId],
    queryFn: () => api.voiceRecordPanel(entityType, entityId, { limit: 20 }),
    enabled,
    retry: false,
  });

  if (!enabled || panel.isError) return null;
  const view = panel.data;
  if (view === undefined) return null;
  if (view.total.conversations === 0 && view.total.calls === 0) return null;

  const selected: VoiceCallSessionView | undefined = view.calls.find((call) => call.id === openCall);

  return (
    <Card
      className="carocrm-card"
      title={
        <Space>
          <PhoneOutlined />
          <Typography.Text strong>{t('voice.panel.title')}</Typography.Text>
          <Tag>{t('voice.panel.counts', { conversations: view.total.conversations, calls: view.total.calls })}</Tag>
        </Space>
      }
      extra={
        <Button onClick={() => navigate('/voice-inbox')}>
          {t('voice.panel.openInbox')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        {view.conversations.length > 0 ? (
          <List
            size="small"
            dataSource={[...view.conversations]}
            renderItem={(conversation) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    size="small"
                    type="link"
                    onClick={() => navigate('/voice-inbox')}
                    icon={<RightOutlined />}
                  >
                    {t('voice.panel.open')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<CustomerServiceOutlined />}
                  title={
                    <Space wrap>
                      <Typography.Text strong>
                        {conversation.subject ?? conversation.externalThreadId ?? conversation.id}
                      </Typography.Text>
                      <Tag>{t(`voice.channel.${conversation.channel}`)}</Tag>
                      <Tag>{conversation.status}</Tag>
                      <Badge count={conversation.unreadCount} size="small" />
                    </Space>
                  }
                  description={formatDateTime(conversation.lastActivityAt)}
                />
              </List.Item>
            )}
          />
        ) : null}

        {view.calls.length > 0 ? (
          <List
            size="small"
            dataSource={[...view.calls]}
            renderItem={(call) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    size="small"
                    type="link"
                    onClick={() => setOpenCall(openCall === call.id ? undefined : call.id)}
                  >
                    {openCall === call.id ? t('voice.inbox.close') : t('voice.panel.open')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<PhoneOutlined />}
                  title={
                    <Space wrap>
                      <Typography.Text strong>
                        {call.direction === 'inbound' ? call.fromNumber ?? '—' : call.toNumber ?? '—'}
                      </Typography.Text>
                      <Tag>{call.state}</Tag>
                      {call.durationSeconds !== null ? (
                        <Typography.Text type="secondary">{`${call.durationSeconds}s`}</Typography.Text>
                      ) : null}
                    </Space>
                  }
                  description={formatDateTime(call.startedAt ?? call.createdAt)}
                />
              </List.Item>
            )}
          />
        ) : null}

        {selected !== undefined ? <VoiceCallDetail call={selected} /> : null}
        {view.total.conversations === 0 && view.total.calls === 0 ? <EmptyState /> : null}
      </Space>
    </Card>
  );
}
