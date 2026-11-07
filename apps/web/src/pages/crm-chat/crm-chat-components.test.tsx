import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CRMChatActionView, CRMChatCitation, CRMChatMessageView } from '../../api/types.js';
import { CRMChatActionCardView } from './CRMChatActionCard.js';
import { CRMChatComposer } from './CRMChatComposer.js';
import { CRMChatFeedbackButtons } from './CRMChatFeedbackButtons.js';
import { CitationLink, CitationReauthContext, CRMChatMessageList } from './CRMChatMessageList.js';
import { CRM_CHAT_LISTENED_STREAM_EVENTS } from './useCrmChatStream.js';

/**
 * Phase 19-CHAT.30 — component coverage for the CRM Chat surface.
 *
 * These suites render to static markup in the node project, like the rest of `pnpm test:web`: no
 * DOM, no EventSource, no provider calls. What they pin down is the *contract-shaped* part of each
 * component — the advertised character bound, the server-driven `actionable` flag, the locked
 * citation state, the feedback controls and the stream listener set. Interactive flows (send,
 * cancel, SSE resume) are covered by `e2e/crm-chat.spec.ts`.
 */

function withQuery(element: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{element}</QueryClientProvider>;
}

function message(overrides: Partial<CRMChatMessageView> = {}): CRMChatMessageView {
  return {
    id: 'msg-1',
    sequence: 1,
    role: 'assistant',
    content: 'The answer.',
    contentFormat: 'plain',
    redaction: 'none',
    turnId: 'turn-1',
    citations: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function citation(overrides: Partial<CRMChatCitation> = {}): CRMChatCitation {
  return {
    id: 'msg-1:0',
    messageId: 'msg-1',
    sourceType: 'crm_record',
    entity: 'Account',
    recordId: 'acc-1',
    label: 'Acme Corp',
    route: '/entity/Account/acc-1',
    ordinal: 0,
    recheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

function actionView(overrides: Partial<CRMChatActionView> = {}): CRMChatActionView {
  return {
    id: 'ap-1',
    runId: 'run-1',
    agentName: 'Assistant',
    agentVersion: 3,
    toolKey: 'crm.update',
    actionClass: 'record.update',
    riskLevel: 'medium',
    summary: 'Update the account name',
    proposal: { name: 'New name' },
    targets: [],
    status: 'pending',
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    actionable: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('CRMChatComposer (19-CHAT.30, bound from 19-CHAT.25)', () => {
  it('caps the input at exactly the advertised maxMessageChars', () => {
    const html = renderToStaticMarkup(
      withQuery(<CRMChatComposer enabled maxMessageChars={8000} turnTimeoutSeconds={180} />),
    );
    expect(html).toContain('maxLength="8000"');
    expect(html).toContain('0/8000');
    // Nothing is typed yet, so the send button is disabled.
    expect(html).toContain('disabled');
  });

  it('reflects a smaller configured bound rather than a hardcoded one', () => {
    const html = renderToStaticMarkup(
      withQuery(<CRMChatComposer enabled maxMessageChars={120} turnTimeoutSeconds={60} />),
    );
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('0/120');
    expect(html).not.toContain('8000');
  });

  it('disables the composer when the caller may not start a turn', () => {
    const html = renderToStaticMarkup(
      withQuery(<CRMChatComposer enabled={false} maxMessageChars={8000} turnTimeoutSeconds={180} />),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('web.crmChat.composerUnavailable');
  });
});

describe('CRMChatActionCardView (19-CHAT.30)', () => {
  it('offers confirm and reject only while the server says the proposal is actionable', () => {
    const actionable = renderToStaticMarkup(
      <CRMChatActionCardView view={actionView()} deciding={null} decideError={null} onDecide={() => undefined} />,
    );
    expect(actionable).toContain('web.crmChat.action.confirm');
    expect(actionable).toContain('web.crmChat.action.reject');

    const decided = renderToStaticMarkup(
      <CRMChatActionCardView
        view={actionView({ actionable: false, status: 'approved', decidedAt: new Date().toISOString() })}
        deciding={null}
        decideError={null}
        onDecide={() => undefined}
      />,
    );
    expect(decided).not.toContain('web.crmChat.action.confirm');
    expect(decided).not.toContain('web.crmChat.action.reject');
    expect(decided).toContain('web.crmChat.action.decided');
  });

  it('renders the proposal preview as escaped text, never markup', () => {
    const html = renderToStaticMarkup(
      <CRMChatActionCardView
        view={actionView({ proposal: { html: '<img src=x onerror=alert(1)>' } })}
        deciding={null}
        decideError={null}
        onDecide={() => undefined}
      />,
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('CRMChatFeedbackButtons (19-CHAT.30)', () => {
  it('renders both rating controls when enabled and nothing when disabled', () => {
    const enabled = renderToStaticMarkup(withQuery(<CRMChatFeedbackButtons turnId="turn-1" enabled />));
    expect(enabled).toContain('web.crmChat.feedback.up');
    expect(enabled).toContain('web.crmChat.feedback.down');
    expect(enabled).toContain('aria-pressed="false"');

    expect(renderToStaticMarkup(withQuery(<CRMChatFeedbackButtons turnId="turn-1" enabled={false} />))).toBe('');
  });
});

describe('CRMChatMessageList citations (19-CHAT.30)', () => {
  it('shows a citation as locked while the page-level reauthorization is unresolved', () => {
    const html = renderToStaticMarkup(
      withQuery(
        <CRMChatMessageList
          messages={[message({ citations: [citation()] })]}
          hasMore={false}
          loadingOlder={false}
          onLoadOlder={() => undefined}
        />,
      ),
    );
    expect(html).toContain('carocrm-chat-cites');
    // The default context is "ready with no verdicts", so the citation renders locked.
    expect(html).toContain('Acme Corp');
  });

  it('renders the server label and route for an accessible citation', () => {
    const cite = citation();
    const html = renderToStaticMarkup(
      <CitationReauthContext.Provider
        value={{
          status: 'ready',
          byKey: new Map([['msg-1:msg-1:0', { accessible: true, label: 'Acme (server)', route: '/entity/Account/acc-1', reason: null }]]),
        }}
      >
        <CitationLink citation={cite} index={1} messageId="msg-1" />
      </CitationReauthContext.Provider>,
    );
    expect(html).toContain('Acme (server)');
    expect(html).toContain('/entity/Account/acc-1');
  });

  it('renders a revoked citation locked with its label still visible', () => {
    const cite = citation();
    const html = renderToStaticMarkup(
      <CitationReauthContext.Provider
        value={{
          status: 'ready',
          byKey: new Map([['msg-1:msg-1:0', { accessible: false, label: null, route: null, reason: 'revoked' }]]),
        }}
      >
        <CitationLink citation={cite} index={1} messageId="msg-1" />
      </CitationReauthContext.Provider>,
    );
    expect(html).toContain('Acme Corp');
    expect(html).not.toContain('/entity/Account/acc-1');
  });
});

describe('useCrmChatStream listener coverage (19-CHAT.29/19-CHAT.30)', () => {
  it('listens for every event the contract may emit, and nothing the contract removed', () => {
    // The contract vocabulary (docs/architecture/crm-chat-contract.md §8.1). `citation.added` was
    // removed in 19-CHAT.29 and `assistant.delta` is a recorded non-decision (19-CHAT.31): neither
    // may ever be listened for again.
    expect([...CRM_CHAT_LISTENED_STREAM_EVENTS].sort()).toEqual(
      [
        'action.proposed',
        'approval.required',
        'assistant.message',
        'heartbeat',
        'tool.completed',
        'tool.started',
        'turn.cancelled',
        'turn.completed',
        'turn.failed',
        'turn.started',
        'usage.summary',
      ].sort(),
    );
  });
});
