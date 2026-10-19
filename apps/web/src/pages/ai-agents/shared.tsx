import { Tag, Typography } from 'antd';

import type { AIAgentRunStatus, AIAgentView } from '../../api/types.js';

/**
 * Phase 19-AI.5–19-AI.10 — shared presentation helpers.
 *
 * Status colour is never the only signal: every tag carries its label, so the run console remains
 * readable for a colour-blind user and in high-contrast mode (AGENTS.md §8).
 */

const RUN_TONES: Readonly<Record<AIAgentRunStatus, string>> = {
  queued: 'default',
  running: 'processing',
  waiting_for_approval: 'gold',
  waiting_for_input: 'gold',
  retry_wait: 'orange',
  cancel_requested: 'orange',
  succeeded: 'green',
  partially_succeeded: 'lime',
  failed: 'red',
  canceled: 'default',
  expired: 'default',
  blocked_by_policy: 'volcano',
  outcome_unknown: 'magenta',
};

export function RunStatusTag({ status }: { readonly status: AIAgentRunStatus }) {
  return <Tag color={RUN_TONES[status]}>{status.replaceAll('_', ' ')}</Tag>;
}

const AGENT_TONES: Readonly<Record<AIAgentView['status'], string>> = {
  draft: 'default',
  published: 'green',
  paused: 'gold',
  archived: 'default',
};

export function AgentStatusTag({ status }: { readonly status: AIAgentView['status'] }) {
  return <Tag color={AGENT_TONES[status]}>{status}</Tag>;
}

export function RiskTag({ risk }: { readonly risk: string }) {
  const tone = risk === 'high_impact' ? 'red' : risk === 'material_write' ? 'volcano' : risk === 'low_write' ? 'gold' : 'blue';
  return <Tag color={tone}>{risk.replaceAll('_', ' ')}</Tag>;
}

export function EffectTag({ effect }: { readonly effect: string }) {
  const tone = effect === 'read' ? 'blue' : effect === 'low_write' ? 'gold' : 'volcano';
  return <Tag color={tone}>{effect.replaceAll('_', ' ')}</Tag>;
}

/** Timestamps are always rendered through Intl in the viewer's locale (PLAN §41.6). */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function shortChecksum(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function ResultText({ result }: { readonly result: unknown }) {
  if (result === null || result === undefined) return <Typography.Text type="secondary">—</Typography.Text>;
  if (typeof result === 'object' && result !== null && 'format' in result) {
    const view = result as { format?: unknown; text?: unknown; data?: unknown; sources?: unknown };
    if (view.format === 'text' && typeof view.text === 'string') {
      return (
        <div>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{view.text}</Typography.Paragraph>
          {Array.isArray(view.sources) && view.sources.length > 0 ? (
            <Typography.Text type="secondary">Sources: {(view.sources as string[]).join(', ')}</Typography.Text>
          ) : null}
        </div>
      );
    }
    return (
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto' }}>
        {JSON.stringify(view.data ?? result, null, 2)}
      </pre>
    );
  }
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto' }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
