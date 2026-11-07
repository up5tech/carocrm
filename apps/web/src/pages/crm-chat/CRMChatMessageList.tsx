import { LinkOutlined, LockOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { parseMarkdown } from '@carocrm/docs/parser.js';
import { Button, Tag, Tooltip } from 'antd';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import type { CRMChatCitation, CRMChatMessageView, CRMChatReauthorizedCitation } from '../../api/types.js';
import { DocBlocks } from '../../components/docs/DocBlocks.js';
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

  // 19-CHAT.28 — one `citations/reauthorize` call per rendered page instead of one per link. The
  // answer is positional, so each citation keeps the server's verdict under its own id.
  const pageCitations = useMemo(
    () =>
      allMessages.flatMap((message) =>
        ((message.citations ?? []) as readonly CRMChatCitation[]).map((citation) => ({
          key: `${message.id}:${citation.id}`,
          citation,
        })),
      ),
    [allMessages],
  );
  const citationSignature = pageCitations.map((entry) => entry.key).join('|');
  const [reauth, setReauth] = useState<{ status: 'loading' | 'ready' | 'error'; byKey: ReadonlyMap<string, CRMChatReauthorizedCitation> }>({
    status: 'ready',
    byKey: new Map(),
  });
  useEffect(() => {
    if (pageCitations.length === 0) {
      setReauth({ status: 'ready', byKey: new Map() });
      return;
    }
    let cancelled = false;
    setReauth({ status: 'loading', byKey: new Map() });
    void api
      .crmChatReauthorizeCitations(pageCitations.map((entry) => entry.citation))
      .then((result) => {
        if (cancelled) return;
        const byKey = new Map<string, CRMChatReauthorizedCitation>();
        result.citations.forEach((resolved, index) => {
          const key = pageCitations[index]?.key;
          if (key !== undefined) byKey.set(key, resolved);
        });
        setReauth({ status: 'ready', byKey });
      })
      .catch(() => {
        if (!cancelled) setReauth({ status: 'error', byKey: new Map() });
      });
    return () => {
      cancelled = true;
    };
    // citationSignature captures the citation set; pageCitations is derived from it, so depending
    // on the signature avoids re-firing on every render (allMessages is a fresh array each time).
  }, [citationSignature]);
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
      <div className="carocrm-workspace-empty" ref={scrollRef}>
        {t('web.crmChat.historyEmpty')}
      </div>
    );
  }

  return (
    <div className="carocrm-workspace-scroll" ref={scrollRef} onScroll={handleScroll}>
      {hasMore ? (
        <div className="carocrm-chat-load-older">
          <Button size="small" loading={loadingOlder} onClick={onLoadOlder}>
            {t('web.crmChat.loadOlder')}
          </Button>
        </div>
      ) : null}

      <CitationReauthContext.Provider value={reauth}>
        {allMessages.map((message) => (
          <MessageItem key={message.id} message={message} feedbackEnabled={feedbackEnabled} />
        ))}
      </CitationReauthContext.Provider>
    </div>
  );
}

interface CitationReauthState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly byKey: ReadonlyMap<string, CRMChatReauthorizedCitation>;
}

/** Exported so component tests can supply a resolved-verdict map without a network (19-CHAT.30). */
export const CitationReauthContext = createContext<CitationReauthState>({ status: 'ready', byKey: new Map() });

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
    <div className={`carocrm-convo-msg carocrm-convo-msg--${tone}`}>
      <span className={`carocrm-convo-avatar carocrm-convo-avatar--${tone}`} aria-hidden="true">
        {isUser ? <UserOutlined /> : <RobotOutlined />}
      </span>

      <div className="carocrm-convo-body">
        <div className="carocrm-convo-meta">
          <span className="carocrm-convo-role">{t(`web.crmChat.role.${message.role}`)}</span>
          <span>{stamp}</span>
          {message.redaction !== 'none' ? (
            <Tag color="orange" bordered={false} style={{ margin: 0 }}>
              {t('web.crmChat.redactedTag')}
            </Tag>
          ) : null}
        </div>

        {/* Message content - Markdown rendered as safe React elements (no HTML injection). */}
        <div className="carocrm-convo-bubble carocrm-chat-markdown">
          <DocBlocks
            blocks={parseMarkdown(message.content).blocks}
            context={{ pageKeys: new Set<string>(), section: '', onAnchor: () => {} }}
          />
        </div>

        {message.citations && message.citations.length > 0 ? (
          <div className="carocrm-chat-cites">
            <span className="carocrm-chat-cites-label">{t('web.crmChat.sources')}</span>
            {(message.citations as CRMChatCitation[]).map((citation, idx) => (
              <CitationLink key={citation.id} citation={citation} index={idx + 1} messageId={message.id} />
            ))}
          </div>
        ) : null}

        {/* 19-CHAT.14 — rate the answer. Only an assistant answer that came from a turn can be rated. */}
        {feedbackEnabled && isAssistant && message.turnId !== null ? (
          <div className="carocrm-convo-tools">
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
  readonly messageId: string;
}

/** Exported so a component test can render one citation verdict without a page (19-CHAT.30). */
export function CitationLink({ citation, index, messageId }: CitationLinkProps) {
  const reauth = useContext(CitationReauthContext);
  const resolved = reauth.byKey.get(`${messageId}:${citation.id}`) ?? null;

  // The page-level call is still in flight.
  if (reauth.status === 'loading') {
    return (
      <Tag bordered={false} style={{ fontSize: 11 }}>
        [{index}] …
      </Tag>
    );
  }

  // A failed call or a citation the answer did not return is shown locked, never as accessible.
  const verdict: CRMChatReauthorizedCitation = resolved ?? {
    accessible: false,
    label: null,
    route: null,
    reason: null,
  };

  // Show locked state if access revoked. The label stays visible so the reader knows which source
  // the answer cited; the reason, when the server gives one, explains why it is no longer readable.
  if (!verdict.accessible) {
    const locked = (
      <Tag color="red" bordered={false} icon={<LockOutlined />} style={{ fontSize: 11 }}>
        [{index}] {citation.label}
      </Tag>
    );
    return verdict.reason === null ? locked : <Tooltip title={verdict.reason}>{locked}</Tooltip>;
  }

  // The server answers with its own label and route after re-reading the source.
  const label = verdict.label ?? citation.label;
  const route = verdict.route ?? citation.route;
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
