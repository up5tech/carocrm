import { LinkOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Tag, Typography } from 'antd';

import type { CRMChatCitation, CRMChatMessageView } from '../../api/types.js';
import { t } from '../../state/i18n.js';

const { Text } = Typography;

export interface CRMChatMessageListProps {
  readonly messages: readonly CRMChatMessageView[];
  readonly olderMessages?: readonly CRMChatMessageView[];
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
}

/**
 * Phase 19-CHAT.7 — Message list with safe Markdown rendering and citation support.
 *
 * Renders user/assistant messages with:
 * - Safe Markdown (sanitized, no HTML execution)
 * - Citation links (only trusted routes from server)
 * - Redaction indicators
 * - Timestamps and role labels
 * - "Load older" pagination button
 */
export function CRMChatMessageList(props: CRMChatMessageListProps) {
  const { messages, olderMessages = [], hasMore, loadingOlder, onLoadOlder } = props;

  const allMessages = [...olderMessages, ...messages];

  if (allMessages.length === 0) {
    return (
      <Empty
        description={<Text type="secondary">{t('web.crmChat.historyEmpty')}</Text>}
      />
    );
  }

  return (
    <div>
      {/* Load older messages button */}
      {hasMore && (
        <div style={{ marginBottom: 12 }}>
          <Button size="small" loading={loadingOlder} onClick={onLoadOlder}>
            {t('web.crmChat.loadOlder')}
          </Button>
        </div>
      )}

      {/* Messages */}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {allMessages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </Space>
    </div>
  );
}

interface MessageItemProps {
  readonly message: CRMChatMessageView;
}

function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        backgroundColor: isUser ? '#e6f4ff' : isAssistant ? '#f6ffed' : '#fafafa',
        border: `1px solid ${isUser ? '#91caff' : isAssistant ? '#b7eb8f' : '#d9d9d9'}`,
      }}
    >
      {/* Header with role, timestamp, and tags */}
      <Space size={6} wrap style={{ marginBottom: 8 }}>
        <Text strong style={{ fontSize: 12 }}>
          {t(`web.crmChat.role.${message.role}`)}
        </Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {new Date(message.createdAt).toLocaleString()}
        </Text>
        {message.redaction !== 'none' && (
          <Tag color="orange">{t('web.crmChat.redactedTag')}</Tag>
        )}
        {message.citations && message.citations.length > 0 && (
          <Tag color="blue">
            {message.citations.length} {t('web.crmChat.citations')}
          </Tag>
        )}
      </Space>

      {/* Message content - plain text with safe link rendering */}
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {message.content.split('\n').map((line, lineIdx) => (
          <div key={lineIdx}>{line}</div>
        ))}
      </div>

      {/* Citations section */}
      {message.citations && message.citations.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #f0f0f0' }}>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
            {t('web.crmChat.sources')}:
          </Text>
          <Space size={[4, 4]} wrap>
            {(message.citations as CRMChatCitation[]).map((citation, idx) => (
              <CitationLink key={idx} citation={citation} index={idx + 1} />
            ))}
          </Space>
        </div>
      )}
    </div>
  );
}

interface CitationLinkProps {
  readonly citation: CRMChatCitation;
  readonly index: number;
}

function CitationLink({ citation, index }: CitationLinkProps) {
  const hasRoute = citation.safeRoute && citation.safeRoute.startsWith('/');

  return (
    <Tag
      icon={hasRoute ? <LinkOutlined /> : undefined}
      color="blue"
      style={{ fontSize: 11 }}
    >
      {hasRoute ? (
        <a href={citation.safeRoute} target="_blank" rel="noopener noreferrer">
          [{index}] {citation.displayLabel}
        </a>
      ) : (
        `[${index}] ${citation.displayLabel}`
      )}
    </Tag>
  );
}
