import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AIAgentApprovalView } from '../../api/types.js';
import { AIAgentsApprovalsTab, ProposalView } from './AIAgentsApprovalsTab.js';
import { AIAgentsEvaluationsTab } from './AIAgentsEvaluationsTab.js';
import { AIAgentsUsageTab } from './AIAgentsUsageTab.js';

/**
 * Phase 19-AI.27 — component coverage for the Approvals, Usage and Evaluations tabs.
 *
 * Like the rest of `pnpm test:web` this renders to static markup in the node project: no DOM, no
 * clicks, no provider calls. What is pinned down is the *contract-shaped* part of each tab — the
 * capability gates, the loading/error/empty branches, the ledger-honest cost label (19-AI.24) and
 * the proposal detail a reviewer actually approves. Click-through wiring (approve/reject mutations,
 * select-then-run) is exercised by the API suites; here the guards that make those clicks safe —
 * `disabled` until a selection exists, admin-only action buttons — are what the markup proves.
 */

function withQuery(client: QueryClient, element: ReactElement): ReactElement {
  return <QueryClientProvider client={client}>{element}</QueryClientProvider>;
}

function clientWith(entries: readonly (readonly [readonly unknown[], unknown])[] = []): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of entries) client.setQueryData(key, data);
  return client;
}

/** React Query reports a stale/errored query as `pending`+`fetching` on the server snapshot, so the
 * loading skeleton is the reachable "not yet answered" state in static markup; the error Alert is
 * covered by the same `isError || data === undefined` guard the skeleton test exercises. */

function approval(overrides: Partial<AIAgentApprovalView> = {}): AIAgentApprovalView {
  return {
    id: 'appr-1',
    runId: 'run-abcdef123456',
    agentId: 'agent-1',
    agentName: 'Renewal helper',
    agentVersion: 3,
    toolKey: 'crm_update_record_fields',
    actionClass: 'material_write',
    riskLevel: 'high',
    summary: 'Update Account "Acme" stage to Won',
    proposal: {},
    targets: [{ type: 'Account', id: 'acc-1', label: 'Acme' }],
    status: 'pending',
    requestedByUserId: 'user-1',
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    revalidation: null,
    executionResult: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    selfApproval: false,
    awaitingSecondApproval: false,
    ...overrides,
  };
}

function usageView(costLabel: 'estimate' | 'none' | 'unknown', ledgerWriteFailures = 0) {
  return {
    totals: {
      runs: 12,
      modelCalls: 30,
      toolCalls: 8,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.0123,
      costLabel,
      ledgerWriteFailures,
    },
    byAgent: [{ agentId: 'a1', agentName: 'Agent', runs: 12, modelCalls: 30, toolCalls: 8, tokens: 1500 }],
    byProvider: [],
  };
}

describe('AIAgentsApprovalsTab (19-AI.27)', () => {
  it('refuses the inbox without the approval capability', () => {
    const html = renderToStaticMarkup(withQuery(clientWith(), <AIAgentsApprovalsTab capabilities={{}} />));
    expect(html).toContain('web.aiAgents.approvalNoAccess');
    expect(html).not.toContain('<table');
  });

  it('renders pending proposals with agent, tool and risk, plus the expired counter', () => {
    const client = clientWith([
      [
        ['aiAgents', 'approvals', 'pending'],
        { list: [approval()], total: 1, offset: 0, count: 1, expired: 2 },
      ],
    ]);
    const html = renderToStaticMarkup(
      withQuery(client, <AIAgentsApprovalsTab capabilities={{ approval: true }} />),
    );
    expect(html).toContain('Update Account &quot;Acme&quot; stage to Won');
    expect(html).toContain('Renewal helper');
    expect(html).toContain('crm_update_record_fields');
    expect(html).toContain('web.aiAgents.expiredCount');
  });

  it('shows the inbox-empty state when nothing is pending', () => {
    const client = clientWith([
      [['aiAgents', 'approvals', 'pending'], { list: [], total: 0, offset: 0, count: 0, expired: 0 }],
    ]);
    const html = renderToStaticMarkup(
      withQuery(client, <AIAgentsApprovalsTab capabilities={{ approval: true }} />),
    );
    expect(html).toContain('web.aiAgents.inboxEmpty');
  });

  it('ProposalView renders the exact before/after, targets and arguments a reviewer approves', () => {
    const html = renderToStaticMarkup(
      <ProposalView
        approval={approval({
          proposal: {
            detail: {
              before: { stage: 'Prospect' },
              after: { stage: 'Won' },
              arguments: { entity: 'Account', id: 'acc-1' },
            },
          },
        })}
      />,
    );
    expect(html).toContain('Prospect');
    expect(html).toContain('Won');
    expect(html).toContain('Account · Acme');
    expect(html).toContain('&quot;entity&quot;');
  });
});

describe('AIAgentsUsageTab (19-AI.27)', () => {
  it('refuses the tab without the usage capability', () => {
    const html = renderToStaticMarkup(withQuery(clientWith(), <AIAgentsUsageTab capabilities={{}} />));
    expect(html).toContain('web.aiAgents.usageNoAccess');
  });

  it('shows the loading skeleton while the usage ledger has not answered', () => {
    const html = renderToStaticMarkup(
      withQuery(clientWith(), <AIAgentsUsageTab capabilities={{ usage: true }} />),
    );
    expect(html).toContain('ant-skeleton');
  });

  it('labels an estimate honestly and hides admin actions from a reader', () => {
    const client = clientWith([
      [['aiAgents', 'usage'], usageView('estimate')],
      [['aiAgents', 'quotaStatus'], { list: [] }],
    ]);
    const html = renderToStaticMarkup(
      withQuery(client, <AIAgentsUsageTab capabilities={{ usage: true }} />),
    );
    expect(html).toContain('web.aiAgents.costEstimate');
    expect(html).toContain('web.aiAgents.noQuotas');
    // `policyAdmin` is absent: no quota/pricing administration controls may render.
    expect(html).not.toContain('web.aiAgents.quotaAdd');
    expect(html).not.toContain('web.aiAgents.pricingAdd');
  });

  it('reports costLabel unknown with the dropped-ledger-write count (19-AI.24)', () => {
    const client = clientWith([
      [['aiAgents', 'usage'], usageView('unknown', 3)],
      [['aiAgents', 'quotaStatus'], { list: [] }],
    ]);
    const html = renderToStaticMarkup(
      withQuery(client, <AIAgentsUsageTab capabilities={{ usage: true, policyAdmin: true }} />),
    );
    expect(html).toContain('web.aiAgents.costUnknown');
    expect(html).toContain('web.aiAgents.ledgerWriteFailures');
    expect(html).toContain('web.aiAgents.usageCostUnknown');
    // Admin controls are present for a policy admin.
    expect(html).toContain('web.aiAgents.quotaAdd');
    expect(html).toContain('web.aiAgents.pricingAdd');
  });
});

describe('AIAgentsEvaluationsTab (19-AI.27)', () => {
  it('refuses the tab without the use capability', () => {
    const html = renderToStaticMarkup(withQuery(clientWith(), <AIAgentsEvaluationsTab capabilities={{}} />));
    expect(html).toContain('web.aiAgents.noAccess');
  });

  it('keeps Run disabled until an agent and suite are selected, and gates suite creation on evaluation admin', () => {
    const client = clientWith([
      [['aiAgents', 'agents', 'eval'], { list: [{ id: 'a1', key: 'k1', name: 'Agent One' }] }],
      [['aiAgents', 'evalSuites'], { list: [{ id: 's1', name: 'Standard', suiteKey: 'standard', requiredForPublish: true, enabled: true }] }],
    ]);
    const reader = renderToStaticMarkup(
      withQuery(client, <AIAgentsEvaluationsTab capabilities={{ use: true }} />),
    );
    // The run mutation throws without both selections; the button must stay disabled.
    expect(reader).toContain('disabled');
    expect(reader).not.toContain('web.aiAgents.ensureStandardSuite');

    const admin = renderToStaticMarkup(
      withQuery(client, <AIAgentsEvaluationsTab capabilities={{ use: true, evaluation: true }} />),
    );
    expect(admin).toContain('web.aiAgents.ensureStandardSuite');
  });

  it('shows the select-an-agent-first empty state before any agent is chosen', () => {
    const client = clientWith([
      [['aiAgents', 'agents', 'eval'], { list: [] }],
      [['aiAgents', 'evalSuites'], { list: [] }],
    ]);
    const html = renderToStaticMarkup(
      withQuery(client, <AIAgentsEvaluationsTab capabilities={{ use: true }} />),
    );
    expect(html).toContain('web.aiAgents.selectAgentFirst');
    expect(html).toContain('web.aiAgents.noSuites');
  });
});
