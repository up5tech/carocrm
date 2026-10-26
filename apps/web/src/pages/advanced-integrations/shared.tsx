import { ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Space, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

import type { IntegrationConnectionStatus, IntegrationWarning } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';

/**
 * Phase 19-INT.14 / 19-INT.15 — the module's presentation vocabulary.
 *
 * The page is a **patch bay**: a connection is a wire between an external system and the CRM, and
 * the operator's job is to see at a glance which wires are live, which are degraded and which
 * need attention. The one expressive element is the **status rail** — a thin bar on the left of a
 * row that encodes the health of that wire. Everything around it stays quiet.
 *
 * Two rules hold everywhere in this module (AGENTS.md §8, plan §15.6):
 *
 *  - **Colour is never the only signal.** Every rail is paired with a text label.
 *  - **A secret is never shown.** A credential appears as "stored" plus a non-secret hint.
 */

/** The tone of a connection, used by both the rail and the pill. */
export type ConnectionTone = 'ok' | 'warn' | 'error' | 'idle';

const CONNECTION_TONES: Readonly<Record<IntegrationConnectionStatus, ConnectionTone>> = {
  connected: 'ok',
  degraded: 'warn',
  reauthorization_required: 'warn',
  pending_authorization: 'warn',
  error: 'error',
  paused: 'idle',
  revoked: 'idle',
  draft: 'idle',
};

export function connectionTone(status: IntegrationConnectionStatus): ConnectionTone {
  return CONNECTION_TONES[status] ?? 'idle';
}

const PILL_CLASSES: Readonly<Record<ConnectionTone, string>> = {
  ok: 'carocrm-pill carocrm-pill--green',
  warn: 'carocrm-pill carocrm-pill--amber',
  error: 'carocrm-pill carocrm-pill--red',
  idle: 'carocrm-pill carocrm-pill--grey',
};

/**
 * The status rail.
 *
 * It is deliberately the module's only expressive device: a 3px bar whose colour encodes the
 * health of one wire. It always sits next to a text label, so it is never the only signal.
 */
export function StatusRail({ tone, title }: { readonly tone: ConnectionTone; readonly title: string }) {
  return <span className={`carocrm-rail carocrm-rail--${tone}`} role="presentation" title={title} />;
}

/** A rail plus its text label, for a row that leads with its status. */
export function RailAndLabel({
  tone,
  label,
  title,
}: {
  readonly tone: ConnectionTone;
  readonly label: string;
  readonly title: string;
}) {
  return (
    <span className="carocrm-rail-label">
      <StatusRail tone={tone} title={title} />
      <span className={PILL_CLASSES[tone]}>{label}</span>
    </span>
  );
}

/** A connection's state, as a labelled pill. Never a bare colour. */
export function ConnectionStatusPill({ status }: { readonly status: IntegrationConnectionStatus }) {
  const tone = connectionTone(status);
  return <span className={PILL_CLASSES[tone]}>{status.replaceAll('_', ' ')}</span>;
}

/** A generic labelled pill, for a tier or a category. */
export function TonePill({ tone, label, title }: { readonly tone: ConnectionTone; readonly label: string; readonly title?: string }) {
  const pill = <span className={PILL_CLASSES[tone]}>{label}</span>;
  return title === undefined ? pill : <Tooltip title={title}>{pill}</Tooltip>;
}

/**
 * The warnings an operator has to act on.
 *
 * They are the visual anchor of the connection detail: the panel is quiet until something is
 * wrong, and then it says what is wrong in one line.
 */
export function WarningList({
  warnings,
  emptyText,
}: {
  readonly warnings: readonly IntegrationWarning[];
  readonly emptyText: string;
}) {
  if (warnings.length === 0) {
    return (
      <Typography.Text type="secondary" className="carocrm-quiet">
        {emptyText}
      </Typography.Text>
    );
  }
  return (
    <div className="carocrm-warnings">
      {warnings.map((warning) => (
        <WarningRow key={`${warning.code}:${warning.message}`} warning={warning} />
      ))}
    </div>
  );
}

function WarningRow({ warning }: { readonly warning: IntegrationWarning }) {
  const icon =
    warning.severity === 'info' ? (
      <InfoCircleOutlined style={{ color: 'var(--carocrm-c-438eff)' }} />
    ) : (
      <ExclamationCircleOutlined style={{ color: warning.severity === 'error' ? 'var(--carocrm-c-fa626b)' : 'var(--carocrm-c-e8a33d)' }} />
    );
  return (
    <div className={`carocrm-warning carocrm-warning--${warning.severity}`}>
      <Space size={8} align="start">
        <span aria-hidden>{icon}</span>
        <span>
          <span className="carocrm-warning-code">{warning.code.replaceAll('_', ' ')}</span>
          <Typography.Text>{warning.message}</Typography.Text>
        </span>
      </Space>
    </div>
  );
}

/**
 * The scopes a connection holds, and the ones it does not.
 *
 * A missing scope is the single most common reason a connection cannot work, so it is stated
 * plainly rather than buried in a list.
 */
export function ScopeChips({
  granted,
  missing,
  grantedLabel,
  missingLabel,
}: {
  readonly granted: readonly string[];
  readonly missing: readonly string[];
  readonly grantedLabel: string;
  readonly missingLabel: string;
}) {
  if (granted.length === 0 && missing.length === 0) {
    return (
      <Typography.Text type="secondary" className="carocrm-quiet">
        —
      </Typography.Text>
    );
  }
  return (
    <Space size={[4, 4]} wrap>
      {granted.map((scope) => (
        <Tag key={scope} color="green" title={grantedLabel}>
          {scope}
        </Tag>
      ))}
      {missing.map((scope) => (
        <Tag key={scope} color="red" title={missingLabel}>
          {scope}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * A stored credential.
 *
 * The value is never shown. The hint the server returns is a non-secret label, and the wording
 * makes it clear that a credential *is* stored without implying anything about its content.
 */
export function MaskedCredential({
  hasCredential,
  hint,
  storedLabel,
  noneLabel,
}: {
  readonly hasCredential: boolean;
  readonly hint: string | null;
  readonly storedLabel: string;
  readonly noneLabel: string;
}) {
  if (!hasCredential) {
    return (
      <Typography.Text type="secondary" className="carocrm-quiet">
        {noneLabel}
      </Typography.Text>
    );
  }
  return (
    <Space size={6}>
      <span className="carocrm-pill carocrm-pill--green">{storedLabel}</span>
      {hint === null ? null : <Typography.Text type="secondary">{hint}</Typography.Text>}
    </Space>
  );
}

/** Timestamps are rendered through Intl in the viewer's locale (plan §41.6). */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** A coarse "how long ago", for the sync lag. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${String(Math.round(seconds))}s`;
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))}h`;
  return `${String(Math.round(seconds / 86_400))}d`;
}

/**
 * The compact section header every tab shares.
 *
 * The page itself owns the only page-level title; a tab states what its surface contains at
 * 16px/600 so the hierarchy stays flat and the catalog rows remain the content, not the chrome.
 */
export function SectionToolbar({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="carocrm-int-section-head">
      <div className="carocrm-int-section-heading">
        <h5 className="carocrm-int-section-title">{title}</h5>
        <p className="carocrm-int-section-sub">{subtitle}</p>
      </div>
      {actions === undefined ? null : <div className="carocrm-int-section-actions">{actions}</div>}
    </div>
  );
}

/** The empty state of a panel: an invitation to act, not an apology. */
export function PanelEmpty({ text, action }: { readonly text: string; readonly action?: ReactNode }) {
  return (
    <div className="carocrm-panel-empty">
      <EmptyState size="compact" description={text} />
      {action === undefined ? null : <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/** The refusal state of a panel the caller may not open. */
export function PermissionNotice({ text }: { readonly text: string }) {
  return <Alert type="warning" showIcon message={text} />;
}
