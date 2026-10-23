import { LinkOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { CRMChatCitation, CRMChatMessageView, CRMChatReauthorizedCitation } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { CRMChatFeedbackButtons } from './CRMChatFeedbackButtons.js';

const { Text } = Typography;

export interface CRMChatMessageListProps {
  readonly messages: readonly CRMChatMessageView[];
  readonly olderMessages?: readonly CRMChatMessageView[];
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  /** Whether the answer feedback feature is on for this caller. */
  readonly feedbackEnabled?: boolean | undefined;
}

/**
 * Phase 19-CHAT.8 — Message list with safe Markdown rendering and citation reauthorization.
 *
 * Renders user/assistant messages with:
 * - Safe plain text rendering (no HTML execution)
 * - Citation links that are reauthorized before display
 * - Reauthorization happens on mount and when citations change
 * - Revoked citations show as inaccessible with lock icon
 * - Redaction indicators
 * - Timestamps and role labels
 * - "Load older" pagination button
 * - 19-CHAT.14 — answer feedback on an assistant answer
 */
export function CRMChatMessageList(props: CRMChatMessageListProps) {
  const { messages, olderMessages = [], hasMore, loadingOlder, onLoadOlder, feedbackEnabled = false } = props;

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
          <MessageItem key={message.id} message={message} feedbackEnabled={feedbackEnabled} />
        ))}
      </Space>
    </div>
  );
}

interface MessageItemProps {
  readonly message: CRMChatMessageView;
  readonly feedbackEnabled: boolean;
}

function MessageItem({ message, feedbackEnabled }: MessageItemProps) {
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

      {/* 19-CHAT.14 — rate the answer. Only an assistant answer that came from a turn can be rated. */}
      {feedbackEnabled && isAssistant && message.turnId !== null ? (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #f0f0f0' }}>
          <CRMChatFeedbackButtons turnId={message.turnId} enabled />
        </div>
      ) : null}
    </div>
  );
}

interface CitationLinkProps {
  readonly citation: CRMChatCitation;
  readonly index: number;
}

function CitationLink({ citation, index }: CitationLinkProps) {
  const [resolved, setResolved] = useState<CRMChatReauthorizedCitation | null>(null);

  // Reauthorize citation on mount
  useEffect(() => {
    let cancelled = false;

    const checkAccess = async () => {
      try {
        const result = await api.crmChatReauthorizeCitations([citation]);
        if (!cancelled) setResolved(result.citations[0] ?? { accessible: false, label: null, route: null, reason: null });
      } catch {
        if (!cancelled) {
          setResolved({ accessible: false, label: null, route: null, reason: null });
        }
      }
    };

    void checkAccess();
    return () => {
      cancelled = true;
    };
  }, [citation]);

  // Show loading state while checking
  if (resolved === null) {
    return (
      <Tag color="default" style={{ fontSize: 11 }}>
        [{index}] Checking...
      </Tag>
    );
  }

  // Show locked state if access revoked
  if (!resolved.accessible) {
    return (
      <Tag color="red" icon={<LockOutlined />} style={{ fontSize: 11 }}>
        [{index}] {citation.label} (No longer accessible)
      </Tag>
    );
  }

  // The server answers with its own label and route after re-reading the source.
  const label = resolved.label ?? citation.label;
  const route = resolved.route ?? citation.route;
  const hasRoute = route.startsWith('/');
  return (
    <Tag
      icon={hasRoute ? <LinkOutlined /> : undefined}
      color="blue"
      style={{ fontSize: 11 }}
    >
      {hasRoute ? (
        <a href={route} target="_blank" rel="noopener noreferrer">
          [{index}] {label}
        </a>
      ) : (
        `[${index}] ${label}`
      )}
    </Tag>
  );
}
