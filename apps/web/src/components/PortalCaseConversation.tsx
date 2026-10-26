/**
 * Phase 19-SD.11 — the customer's case conversation (PLAN §5.4, §9.6).
 *
 * Portal users never call the staff `reply`/`note` commands. They read the record stream, which the
 * server already filters to `public` entries, and post through the generic Note endpoint; the Stream
 * service forces portal-created entries to `public`. No internal note, system entry or attachment
 * tied to an internal message can reach this component.
 */

import { SendOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Input, List, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api, type StreamItem } from '../api/client.js';
import { t } from '../state/i18n.js';
import { EmptyState } from './EmptyState.js';

const { TextArea } = Input;

function authorName(item: StreamItem): string {
  const user = item.createdBy;
  if (!user) return t('web.stream.unknownUser');
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return full !== '' ? full : user.userName;
}

export function PortalCaseConversation({ caseId }: { readonly caseId: string }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<StreamItem[]>([]);
  const [articles, setArticles] = useState<{ id: string; title: string; summary: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const timeline = await api.streamFor('Case', caseId, { order: 'asc', maxSize: 100 });
      setItems(timeline.list.filter((item) => item.visibility === 'public'));
      setDenied(false);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 404) setDenied(true);
      else void message.error(error instanceof Error ? error.message : t('web.portalCase.loadFailed'));
      setItems([]);
    } finally {
      setLoading(false);
    }
    try {
      setArticles(await api.serviceDeskKnowledgeSuggestions(caseId));
    } catch {
      setArticles([]);
    }
  }, [caseId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '') return;
    setPosting(true);
    try {
      await api.postNote('Case', caseId, text);
      setDraft('');
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.portalCase.postFailed'));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card className="carocrm-card" title={t('web.portalCase.conversation')}>
        {loading && items.length === 0 ? (
          <Spin />
        ) : denied ? (
          <EmptyState description={t('web.portalCase.denied')} />
        ) : items.length === 0 ? (
          <EmptyState description={t('web.portalCase.empty')} />
        ) : (
          <List
            dataSource={items}
            rowKey={(item) => item.id}
            renderItem={(item) => (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{authorName(item)}</Typography.Text>
                    <Tag color="green">{t('web.portalCase.publicBadge')}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(item.createdAt).toLocaleString()}
                    </Typography.Text>
                  </Space>
                  <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                    {item.post ?? ''}
                  </Typography.Paragraph>
                </Space>
              </List.Item>
            )}
          />
        )}
        {!denied ? (
          <div style={{ marginTop: 12 }}>
            <TextArea
              rows={3}
              value={draft}
              placeholder={t('web.portalCase.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={(event) => {
                if (event.metaKey || event.ctrlKey) void submit();
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={posting}
              disabled={draft.trim() === ''}
              style={{ marginTop: 8 }}
              onClick={() => void submit()}
            >
              {t('web.portalCase.send')}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="carocrm-card" title={t('web.portalCase.suggestions')}>
        {articles.length === 0 ? (
          <Alert type="info" showIcon message={t('web.portalCase.noSuggestions')} />
        ) : (
          <List
            dataSource={articles.slice(0, 5)}
            rowKey={(article) => article.id}
            renderItem={(article) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{article.title}</Typography.Text>
                  {article.summary ? <Typography.Text type="secondary">{article.summary}</Typography.Text> : null}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}
