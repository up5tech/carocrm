import { CloseOutlined, PhoneOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

/**
 * Phase 19-VC.9 — the incoming-call banner
 * (`PLAN_Phase_19_Voice_Communications.md` §7.2, §15 `19-VC.9`).
 *
 * The server decides **who** is notified (the call's assignee or the endpoint team's members), so
 * this component only renders what the API returns for the signed-in user. It carries the number,
 * never a record name: a caller whose Contact the user may not read stays a number. Polling is the
 * documented transport because the platform has no realtime gateway (see the audit).
 */
export function IncomingCallBanner() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const incoming = useQuery({
    queryKey: ['voice', 'incoming'],
    queryFn: () => api.voiceIncomingCalls(),
    refetchInterval: 10_000,
    retry: false,
  });

  const visible = (incoming.data?.list ?? []).filter((call) => !dismissed.includes(call.id));
  if (visible.length === 0) return null;

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 1200, width: 320 }} role="status" aria-live="polite">
      <Space direction="vertical" style={{ width: '100%' }}>
        {visible.map((call) => (
          <Card
            key={call.id}
            size="small"
            style={{ borderColor: '#1677ff', boxShadow: '0 6px 20px rgba(0,0,0,0.12)' }}
            title={
              <Space>
                <PhoneOutlined style={{ color: '#1677ff' }} />
                <Typography.Text strong>{t('voice.inbox.incomingCall')}</Typography.Text>
              </Space>
            }
            extra={
              <Button
                type="text"
                size="small"
                aria-label={t('voice.inbox.dismiss')}
                icon={<CloseOutlined />}
                onClick={() => setDismissed((current) => [...current, call.id])}
              />
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              <Typography.Text strong style={{ fontSize: 18 }}>
                {call.fromNumber ?? '—'}
              </Typography.Text>
              <Space wrap size={4}>
                <Tag>{call.state}</Tag>
                {call.toNumber !== null ? <Tag>{call.toNumber}</Tag> : null}
              </Space>
              <Button type="primary" size="small" onClick={() => navigate('/voice-inbox')}>
                {t('voice.inbox.openInbox')}
              </Button>
            </Space>
          </Card>
        ))}
      </Space>
    </div>
  );
}
