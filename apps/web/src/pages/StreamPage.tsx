import { ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Avatar, Button, Card, Segmented, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type StreamItem } from '../api/client.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { EmptyState } from '../components/EmptyState.js';
import { updateSummary } from '../components/StreamPanel.js';
import { formatDateTime,t } from '../state/i18n.js';
import { useEntity, useMetadata } from '../state/metadata.js';

type View = 'followed' | 'own' | 'all';

const PAGE = 30;

function authorLabel(item: StreamItem): string {
  const name = item.createdBy;
  if (!name) return t('web.stream.unknownUser');
  const full = `${name.firstName ?? ''} ${name.lastName ?? ''}`.trim();
  return full !== '' ? full : name.userName;
}

/** Global activity stream (PLAN §26): followed records, own posts, or both. */
export function StreamPage() {
  usePageDocs('user/stream-and-notifications');
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const [view, setView] = useState<View>('followed');
  const [items, setItems] = useState<StreamItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(
    async (nextOffset: number, replace: boolean) => {
      setLoading(true);
      try {
        const result = await api.activityStream({ view, maxSize: PAGE, offset: nextOffset });
        setItems((current) => (replace ? result.list : [...current, ...result.list]));
        setOffset(nextOffset + result.list.length);
        setExhausted(result.list.length < PAGE);
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.stream.loadFailed'));
        if (replace) setItems([]);
        setExhausted(true);
      } finally {
        setLoading(false);
      }
    },
    [view, message],
  );

  useEffect(() => {
    void load(0, true);
  }, [load]);

  return (
    <Card
      className="carocrm-card"
      title={(
          <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{t('web.stream.title')}</Typography.Title>
        )}
      extra={
        <Space>
          <Segmented
            value={view}
            onChange={(value) => setView(value as View)}
            options={[
              { value: 'followed', label: t('web.stream.following') },
              { value: 'own', label: t('web.stream.myPosts') },
              { value: 'all', label: t('web.stream.all') },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(0, true)}>
            {t('core.common.refresh')}
          </Button>
        </Space>
      }
    >
      {loading && items.length === 0 ? (
        <Spin />
      ) : items.length === 0 ? (
        <EmptyState size="compact" description={t('web.stream.empty')} />
      ) : (
        <div className="carocrm-stream-list">
          {items.map((item) => (
            <StreamRow key={item.id} item={item} label={metadata.data?.[item.entityType]?.label ?? item.entityType} />
          ))}
        </div>
      )}
      {items.length > 0 ? (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button disabled={exhausted} loading={loading} onClick={() => void load(offset, false)}>
            {t('web.stream.loadMore')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function StreamRow({ item, label }: { item: StreamItem; label: string }) {
  const definition = useEntity(item.entityType);
  const body = item.type === 'Update' ? updateSummary(item, definition.data) : item.post ?? String(item.data['notes'] ?? '');
  return (
    <div className="carocrm-stream-item">
      <Avatar size={32} style={{ flex: '0 0 auto', background: item.type === 'Update' ? 'var(--carocrm-c-f8ac59)' : 'var(--carocrm-c-438eff)' }}>
        {item.type === 'Update' ? '∆' : authorLabel(item).slice(0, 2).toUpperCase()}
      </Avatar>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space size={8} wrap>
          <Typography.Text strong>{authorLabel(item)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.stream.on')}
          </Typography.Text>
          <Link to={`/${item.entityType}/${item.entityId}`}>{label}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(item.createdAt)}
          </Typography.Text>
        </Space>
        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{body}</Typography.Paragraph>
      </div>
    </div>
  );
}
