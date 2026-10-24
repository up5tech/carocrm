import { LinkOutlined, LockOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Tag, Tooltip } from 'antd';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import type { CRMChatCitation, CRMChatMessageView, CRMChatReauthorizedCitation } from '../../api/types.js';
import { formatClock, formatDateTime, isSameCalendarDay, t } from '../../state/i18n.js';
import { CRMChatFeedbackButtons } from './CRMChatFeedbackButtons.js';

export interface CRMChatMessageListProps {
  readonly messages: readonly CRMChatMessageView[];
  readonly olderMessages?: readonly CRMChatMessageView[];
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  /** Whether the answer feedback feature is on for this caller. */
  readonly feedbackEnabled?: boolean | undefined;
  /**
   * Identifies the thread being shown. A change means the user opened another conversation, so the
   * transcript jumps to the newest message instead of keeping the previous scroll position.
   */
  readonly conversationKey?: string | undefined;
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
 *
 * The transcript owns its scroll container: the composer below it must stay put while the
 * conversation moves, so the page cannot scroll the whole pane.
 */
export function CRMChatMessageList(props: CRMChatMessageListProps) {
  const {
    messages,
    olderMessages = [],
    hasMore,
    loadingOlder,
    onLoadOlder,
    feedbackEnabled = false,
    conversationKey,
  } = props;

  const allMessages = [...olderMessages, ...messages];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is parked at the newest message. A new answer only auto-scrolls when they
  // are; scrolling someone away from the history they were reading would be hostile.
  const stickToBottom = useRef(true);
  const lastMessageId = allMessages[allMessages.length - 1]?.id ?? null;
  const previousKey = useRef(conversationKey);
  const previousLastId = useRef<string | null>(null);

  const handleScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const threadChanged = previousKey.current !== conversationKey;
    const appended = previousLastId.current !== lastMessageId;
    previousKey.current = conversationKey;
    previousLastId.current = lastMessageId;
    if (!threadChanged && !appended) return;
    if (threadChanged || stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
      stickToBottom.current = true;
    }
  }, [conversationKey, lastMessageId]);

  if (allMessages.length === 0) {
    return (
      <div className="carocrm-chat-thread-empty" ref={scrollRef}>
        {t('web.crmChat.historyEmpty')}
      </div>
    );
  }

  return (
    <div className="carocrm-chat-thread" ref={scrollRef} onScroll={handleScroll}>
      {hasMore ? (
        <div className="carocrm-chat-load-older">
          <Button size="small" loading={loadingOlder} onClick={onLoadOlder}>
            {t('web.crmChat.loadOlder')}
          </Button>
        </div>
      ) : null}

      {allMessages.map((message) => (
        <MessageItem key={message.id} message={message} feedbackEnabled={feedbackEnabled} />
      ))}
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

  const tone = isUser ? 'user' : isAssistant ? 'assistant' : 'system';
  const stamp =
    isSameCalendarDay(message.createdAt, new Date().toISOString())
      ? formatClock(message.createdAt)
      : formatDateTime(message.createdAt, true);

  return (
    <div className={`carocrm-chat-msg carocrm-chat-msg--${tone}`}>
      <span className={`carocrm-chat-avatar carocrm-chat-avatar--${tone}`} aria-hidden="true">
        {isUser ? <UserOutlined /> : <RobotOutlined />}
      </span>

      <div className="carocrm-chat-msg-body">
        <div className="carocrm-chat-msg-meta">
          <span className="carocrm-chat-msg-role">{t(`web.crmChat.role.${message.role}`)}</span>
          <span>{stamp}</span>
          {message.redaction !== 'none' ? (
            <Tag color="orange" bordered={false} style={{ margin: 0 }}>
              {t('web.crmChat.redactedTag')}
            </Tag>
          ) : null}
        </div>

        {/* Message content - plain text, never interpreted as markup. */}
        <div className="carocrm-chat-bubble">{message.content}</div>

        {message.citations && message.citations.length > 0 ? (
          <div className="carocrm-chat-cites">
            <span className="carocrm-chat-cites-label">{t('web.crmChat.sources')}</span>
            {(message.citations as CRMChatCitation[]).map((citation, idx) => (
              <CitationLink key={idx} citation={citation} index={idx + 1} />
            ))}
          </div>
        ) : null}

        {/* 19-CHAT.14 — rate the answer. Only an assistant answer that came from a turn can be rated. */}
        {feedbackEnabled && isAssistant && message.turnId !== null ? (
          <div className="carocrm-chat-msg-tools">
            <CRMChatFeedbackButtons turnId={message.turnId} enabled />
          </div>
        ) : null}
      </div>
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
      <Tag bordered={false} style={{ fontSize: 11 }}>
        [{index}] …
      </Tag>
    );
  }

  // Show locked state if access revoked. The label stays visible so the reader knows which source
  // the answer cited; the reason, when the server gives one, explains why it is no longer readable.
  if (!resolved.accessible) {
    const locked = (
      <Tag color="red" bordered={false} icon={<LockOutlined />} style={{ fontSize: 11 }}>
        [{index}] {citation.label}
      </Tag>
    );
    return resolved.reason === null ? locked : <Tooltip title={resolved.reason}>{locked}</Tooltip>;
  }

  // The server answers with its own label and route after re-reading the source.
  const label = resolved.label ?? citation.label;
  const route = resolved.route ?? citation.route;
  const hasRoute = route.startsWith('/');
  return (
    <Tag icon={hasRoute ? <LinkOutlined /> : undefined} color="blue" bordered={false} style={{ fontSize: 11 }}>
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
