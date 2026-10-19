import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  List,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentConversationView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp } from './shared.js';

/**
 * Phase 19-AI.12 — conversation memory and retention
 * (PLAN_Phase_19_AI_Agents.md §10, §15, §20 `19-AI.12`).
 *
 * Only the caller's own threads are returned by the server; the UI never assembles a conversation
 * list from ids. Deleting a thread is the user's explicit privacy control, while the retention card
 * (policy administrators only) previews exactly how many rows a sweep would remove before it runs.
 */
export function AIAgentsConversationsTab({ capabilities }: { readonly capabilities: Record<string, boolean> }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  const conversations = useQuery({
    queryKey: ['aiAgents', 'conversations'],
    queryFn: () => api.aiAgentsConversations({ maxSize: 50 }),
    staleTime: 15_000,
  });
  const detail = useQuery({
    queryKey: ['aiAgents', 'conversation', openId],
    queryFn: () => api.aiAgentsConversation(openId ?? ''),
    enabled: openId !== undefined,
  });
  const memory = useQuery({
    queryKey: ['aiAgents', 'memory'],
    queryFn: () => api.aiAgentsMemory(),
    staleTime: 30_000,
  });
  const dryRun = useQuery({
    queryKey: ['aiAgents', 'retention', 'dryRun'],
    queryFn: () => api.aiAgentsRetentionDryRun(),
    enabled: capabilities['policyAdmin'] === true,
    staleTime: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'conversation'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'memory'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'retention'] });
  };

  const removeConversation = useMutation({
    mutationFn: (id: string) => api.aiAgentsDeleteConversation(id),
    onSuccess: () => {
      void message.success(t('web.aiAgents.conversationDeleted'));
      setOpenId(undefined);
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const archiveConversation = useMutation({
    mutationFn: (id: string) => api.aiAgentsArchiveConversation(id),
    onSuccess: () => {
      void message.success(t('web.aiAgents.conversationArchived'));
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const removeMemory = useMutation({
    mutationFn: (id: string) => api.aiAgentsDeleteMemory(id),
    onSuccess: () => {
      void message.success(t('web.aiAgents.memoryDeleted'));
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const sweep = useMutation({
    mutationFn: () => api.aiAgentsRetentionRun(),
    onSuccess: (result) => {
      void message.success(
        t('web.aiAgents.retentionDone', {
          conversations: String(result.conversations),
          memory: String(result.memoryItems),
        }),
      );
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('web.aiAgents.memoryIntroTitle')}
        description={t('web.aiAgents.memoryIntroHint')}
      />

      <Table<AIAgentConversationView>
        rowKey="id"
        size="middle"
        loading={conversations.isLoading}
        dataSource={[...(conversations.data?.list ?? [])]}
        scroll={{ x: 780 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={t('web.aiAgents.noConversations')} /> }}
        onRow={(conversation) => ({ onClick: () => setOpenId(conversation.id), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: t('web.aiAgents.conversation'),
            key: 'title',
            render: (_value, conversation) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{conversation.title ?? t('web.aiAgents.untitledConversation')}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {conversation.agentName} · {conversation.id.slice(0, 8)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.status'),
            dataIndex: 'status',
            key: 'status',
            width: 110,
            render: (status: string) => <Tag color={status === 'active' ? 'blue' : 'default'}>{status}</Tag>,
          },
          { title: t('web.aiAgents.messages'), dataIndex: 'messageCount', key: 'messageCount', width: 110 },
          {
            title: t('web.aiAgents.lastActivity'),
            dataIndex: 'lastActivityAt',
            key: 'lastActivityAt',
            width: 180,
            render: (value: string) => formatTimestamp(value),
          },
          {
            title: t('web.aiAgents.expires'),
            dataIndex: 'expiresAt',
            key: 'expiresAt',
            width: 180,
            render: (value: string | null) => formatTimestamp(value),
          },
          {
            title: t('web.aiAgents.actions'),
            key: 'actions',
            width: 200,
            render: (_value, conversation) => (
              <Space size={4} onClick={(event) => event.stopPropagation()}>
                {conversation.status === 'active' ? (
                  <Button
                    size="small"
                    loading={archiveConversation.isPending}
                    onClick={() => archiveConversation.mutate(conversation.id)}
                  >
                    {t('web.aiAgents.archive')}
                  </Button>
                ) : null}
                <Popconfirm
                  title={t('web.aiAgents.deleteConversationConfirm')}
                  onConfirm={() => removeConversation.mutate(conversation.id)}
                  okText={t('core.common.confirm')}
                  cancelText={t('core.common.cancel')}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} loading={removeConversation.isPending}>
                    {t('web.aiAgents.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Card className="carocrm-card" size="small" title={t('web.aiAgents.memorySummaries')}>
        {memory.data === undefined || memory.data.list.length === 0 ? (
          <Empty description={t('web.aiAgents.noMemory')} />
        ) : (
          <List
            size="small"
            dataSource={[...memory.data.list]}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title={t('web.aiAgents.deleteMemoryConfirm')}
                    onConfirm={() => removeMemory.mutate(item.id)}
                    okText={t('core.common.confirm')}
                    cancelText={t('core.common.cancel')}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} loading={removeMemory.isPending}>
                      {t('web.aiAgents.delete')}
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space wrap>
                    <Tag color="blue">{item.kind.replaceAll('_', ' ')}</Tag>
                    <Tag>{item.scope}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatTimestamp(item.createdAt)} · {t('web.aiAgents.expires')} {formatTimestamp(item.expiresAt)}
                    </Typography.Text>
                  </Space>
                  <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 3, expandable: true }}>
                    {item.content}
                  </Typography.Paragraph>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {capabilities['policyAdmin'] ? (
        <Card
          className="carocrm-card"
          size="small"
          title={t('web.aiAgents.retentionTitle')}
          extra={
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void dryRun.refetch()}>
                {t('web.aiAgents.retentionPreview')}
              </Button>
              <Popconfirm
                title={t('web.aiAgents.retentionConfirm')}
                onConfirm={() => sweep.mutate()}
                okText={t('core.common.confirm')}
                cancelText={t('core.common.cancel')}
              >
                <Button size="small" danger loading={sweep.isPending} disabled={dryRun.data === undefined}>
                  {t('web.aiAgents.retentionRun')}
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {t('web.aiAgents.retentionHint')}
          </Typography.Paragraph>
          {dryRun.data === undefined ? (
            <Typography.Text type="secondary">{t('web.aiAgents.retentionUnknown')}</Typography.Text>
          ) : (
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label={t('web.aiAgents.retentionConversations')}>{dryRun.data.conversations}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.retentionMemory')}>{dryRun.data.memoryItems}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.retentionRequests')}>{dryRun.data.providerRequests}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.retentionEvents')}>{dryRun.data.runEvents}</Descriptions.Item>
            </Descriptions>
          )}
        </Card>
      ) : null}

      <Drawer
        open={openId !== undefined}
        onClose={() => setOpenId(undefined)}
        width={Math.min(720, typeof window === 'undefined' ? 720 : window.innerWidth - 32)}
        title={detail.data?.conversation.title ?? t('web.aiAgents.conversation')}
        extra={
          openId === undefined ? null : (
            <Popconfirm
              title={t('web.aiAgents.deleteConversationConfirm')}
              onConfirm={() => removeConversation.mutate(openId)}
              okText={t('core.common.confirm')}
              cancelText={t('core.common.cancel')}
            >
              <Button size="small" danger icon={<DeleteOutlined />} loading={removeConversation.isPending}>
                {t('web.aiAgents.delete')}
              </Button>
            </Popconfirm>
          )
        }
      >
        {detail.data === undefined ? (
          <Empty description={t('web.aiAgents.loadingConversation')} />
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('web.aiAgents.agent')}>{detail.data.conversation.agentName}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.lastActivity')}>
                {formatTimestamp(detail.data.conversation.lastActivityAt)}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.expires')}>
                {formatTimestamp(detail.data.conversation.expiresAt)}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.messages')}>{detail.data.conversation.messageCount}</Descriptions.Item>
            </Descriptions>
            {detail.data.conversation.summary === null ? null : (
              <Alert type="warning" showIcon message={t('web.aiAgents.memorySummary')} description={detail.data.conversation.summary} />
            )}
            {detail.data.messages.length === 0 ? (
              <Empty description={t('web.aiAgents.noMessages')} />
            ) : (
              <List
                size="small"
                dataSource={[...detail.data.messages]}
                renderItem={(entry) => (
                  <List.Item>
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space wrap>
                        <Tag color={entry.role === 'user' ? 'blue' : entry.role === 'assistant' ? 'green' : 'default'}>
                          {entry.role}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatTimestamp(entry.createdAt)}
                        </Typography.Text>
                        {entry.redaction === 'none' ? null : <Tag color="orange">{entry.redaction}</Tag>}
                      </Space>
                      <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.content}</Typography.Paragraph>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
