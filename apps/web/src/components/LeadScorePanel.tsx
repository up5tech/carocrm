import { HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Divider, Drawer, Empty, List, Space, Table, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';

import { api } from '../api/client.js';
import type { LeadScoreBreakdownEntry, LeadScoreHistoryItem, LeadScoreInsight, LeadScoreRead } from '../api/types.js';
import { named } from '../pages/lead-score/shared.js';
import { formatDateTime, formatNumber, t } from '../state/i18n.js';

/**
 * The words the card prints for an engagement signal (19-LS.9). The names come from the module's own
 * vocabulary — a source, an event type, a metric — so they are looked up the same way the administration
 * screen looks them up, and an identifier the catalogs have never named is shown as itself rather than as a
 * blank.
 */
function signalSourceLabel(source: string): string {
  return named(`leadscore.admin.source.${source}`, source);
}

function signalMetricLabel(metric: string): string {
  return named(`leadscore.admin.metric.${metric}`, metric);
}

function eventLabel(eventType: string): string {
  return named(`leadscore.admin.event.${eventType}`, eventType);
}

/**
 * A metric value as a person reads it: a count is a number, a `lastEventAt` is a moment in their own timezone,
 * and a signal with nothing behind it is a dash rather than a blank.
 */
function signalValueText(value: number | string | null): string {
  if (value === null) return '—';
  if (typeof value === 'number') return formatNumber(value);
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? value : formatDateTime(value);
}

/**
 * Phase 19-LS.7 — the score of one Lead, explained (PLAN_Phase_19_LeadScore.md §11.1, §12, §16 `19-LS.7`;
 * audit §5.3–§5.4; contract `docs/compatibility/lead-score.md` §3).
 *
 * The plan's exit criterion for this phase is one sentence: *the UI uses API data and never bypasses
 * field/record ACL.* Everything on this card therefore comes from `GET /LeadScore/action/score/:leadId`, and
 * nothing here re-derives a rule:
 *
 * - **the number, the band, the coverage and the movement** are the projection LS.5 stored — the panel does
 *   not evaluate a model, and it never asks the engine to score during a read (plan §4.2);
 * - **why** is the stored breakdown: rule name, dimension, outcome and points, each label already translated
 *   by the server into the reader's own language. There is no Lead value in any of it, because a reason that
 *   quoted `industry = Software` would be a way to read a field the caller may not see (§6.5, §9.2);
 * - **whether it is still true** is `freshness`, derived on the server from the evaluation's input watermark
 *   and the active model — with one case the panel must respect: a reader whose field ACL hides one of the
 *   model's inputs is told *nothing* about currency, and this card must not guess around that silence;
 * - **what the caller may do** is `actions`, answered by the same gate the command would meet, so a
 *   Recalculate button appears exactly when the server would accept one — including the part plan §9.1
 *   insists on, that writing a score is also a write onto a Lead.
 *
 * It renders nothing when the read refuses (the module switched off, no right, a Lead outside scope): an
 * empty card that only exists to fail is worse than no card, and the record's own Score panel from the
 * metadata layout still carries the projection fields. The portal gets no panel either — it is mounted only
 * for the internal surface.
 *
 * 19-LS.17 adds the optional AI explanation at the bottom, visually and structurally apart from the score:
 * its own heading, an **AI-generated** label, its agent/model and the moment it was produced, and a button
 * that only appears when the server's `actions.insight` says this caller may spend one run. Nothing here
 * requests an answer on mount (a cost, not a read), and an answer grounded on a field the reader may no
 * longer see is shown as withheld rather than quoted.
 */

/** How many history rows one page shows; the server caps a page at 50 (`MAX_HISTORY_PAGE`). */
const HISTORY_PAGE = 10;

/** Band → pill tone. A colour only ever *adds* to the label, never replaces it (WCAG 1.4.1). */
const BAND_TONES: Readonly<Record<string, string>> = {
  Cold: 'blue',
  Warm: 'amber',
  Hot: 'orange',
  'Sales Ready': 'green',
  Disqualified: 'red',
};

/**
 * A band is model configuration, not a fixed vocabulary: LS.3 lets a model name its own bands. So the label is
 * looked up under the built-in vocabulary's key and falls back to the value the model declared — which is
 * also what a filter and an export show, so a custom band never renders as a translation key.
 *
 * The key is lowercased with underscores because the platform validates every catalog segment as
 * `[a-z][a-z0-9_]*`: a key like `band.Sales Ready` fails the load and disables translation for the whole
 * instance, which is a louder failure than a missing label and a much worse one.
 */
function bandLabel(band: string): string {
  const key = `leadscore.band.${band.toLowerCase().replace(/\s+/g, '_')}`;
  const translated = t(key);
  return translated === key ? band : translated;
}

function bandPill(band: string): string {
  return `carocrm-pill${BAND_TONES[band] === undefined ? '' : ` carocrm-pill--${BAND_TONES[band]}`}`;
}

/** Signed, so a movement reads as a direction and not as a colour. */
function signedPoints(points: number): string {
  return `${points > 0 ? '+' : ''}${String(formatNumber(points))}`;
}

/** An unknown trigger code shows its stable code rather than a translation key (plan §41.4, §13). */
function triggerLabel(trigger: string): string {
  const key = `leadscore.panel.trigger.${trigger}`;
  const translated = t(key);
  return translated === key ? trigger : translated;
}

function ExplanationList({ entries, signalState }: { entries: readonly LeadScoreBreakdownEntry[]; signalState: string | null }) {
  if (entries.length === 0) {
    return <Typography.Text type="secondary">{t('leadscore.panel.noRules')}</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {/* The two states where an engagement rule wanted a signal and this build did not read one. A skip code
          says *that* a rule was not answered; only the stored state says whether the switch was off or
          Marketing Automation is not installed here — two different fixes for the same-looking score. */}
      {signalState !== 'disabled' && signalState !== 'absent' ? null : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`leadscore.panel.signalState.${signalState}`)}
        </Typography.Text>
      )}
      <List
        size="small"
        split={false}
        dataSource={[...entries]}
        renderItem={(entry) => (
          // `reasonCode` is unique per model version (LS.2's index), so it is the row's own identity.
          <List.Item key={entry.reasonCode} className="carocrm-score-rule">
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Space wrap size={8} style={{ justifyContent: 'space-between', width: '100%' }}>
                <Typography.Text>{entry.ruleName}</Typography.Text>
                <Typography.Text strong={entry.outcome === 'matched'}>{signedPoints(entry.points)}</Typography.Text>
              </Space>
              {entry.signal === undefined ? null : (
                // Plan §6.5 asks an explanation to name the window and the source of an engagement signal: a
                // rule that says "you scored for engagement" without saying over what window is not explainable.
                // Every word of it is the reader's own language — a raw `marketingEvents` in a sentence a
                // salesperson reads is a developer's log line wearing a label.
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('leadscore.panel.signal', {
                    source: signalSourceLabel(entry.signal.source),
                    events: entry.signal.eventTypes.map(eventLabel).join(', '),
                    days: String(entry.signal.windowDays),
                    metric: signalMetricLabel(entry.signal.metric),
                    value: signalValueText(entry.signal.value),
                  })}
                </Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {entry.dimensionLabel} · {entry.outcomeLabel}
                {entry.assignedBand !== undefined && entry.assignedBand !== '' ? ` · ${t('leadscore.panel.assignedBand', { band: entry.assignedBand })}` : ''}
              </Typography.Text>
              {/* A rule that could not be evaluated names its stable code: that is the diagnostic, and the
                  field it would have read stays out of the response. */}
              {entry.code !== undefined && entry.code !== '' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('leadscore.panel.code', { code: entry.code })}
                </Typography.Text>
              ) : null}
            </Space>
          </List.Item>
        )}
      />
    </Space>
  );
}

/**
 * The optional AI explanation (19-LS.17), rendered apart from the deterministic score on purpose.
 *
 * It shows only what the server stored: the answer, the agent/version and provider/model that wrote it, when
 * it was produced, its self-reported confidence when one exists, and how many fields grounded it. A text
 * grounded on a field this reader may not see arrives as `withheld` and is never echoed. The button appears
 * only when `actions.insight` allows it — the same gate the command meets — and nothing is requested on mount.
 */
function InsightSection({ view, busy, onAsk }: { view: LeadScoreRead; busy: boolean; onAsk: () => void }) {
  const action = view.actions.insight;
  const answer: LeadScoreInsight | null = view.insight;
  // A caller without the module right sees nothing; a configuration problem is shown only to somebody who
  // could otherwise ask, so a regular score reader is not told about a deployment they cannot change.
  const explains = action.reason === 'NOT_CONFIGURED' || action.reason === 'AI_UNAVAILABLE' || action.reason === 'AI_AGENTS_UNAUTHORIZED';
  if (!action.allowed && answer === null && !explains) return null;

  const stale =
    answer !== null &&
    (answer.score.calculatedAt !== view.score.calculatedAt || answer.score.modelVersion !== view.score.modelVersion);
  const hint =
    answer === null && !action.allowed
      ? action.reason === 'NOT_CONFIGURED'
        ? t('leadscore.panel.insightNotConfigured')
        : action.reason === 'AI_UNAVAILABLE'
          ? t('leadscore.panel.insightUnavailable')
          : t('leadscore.panel.insightNoAccess')
      : null;
  const provenance = [
    answer === null || answer.agent.providerKey === null || answer.agent.model === null
      ? null
      : `${t('leadscore.panel.insightModel')}: ${answer.agent.providerKey} · ${answer.agent.model}`,
    answer?.confidence === null || answer === null
      ? null
      : `${t('leadscore.panel.insightConfidence')}: ${String(Math.round(answer.confidence * 100))}%`,
    answer === null ? null : t('leadscore.panel.insightGroundedOn', { count: String(answer.input.fields.length) }),
  ].filter((entry): entry is string => entry !== null);

  return (
    <div>
      <Divider style={{ margin: '16px 0 12px' }} />
      <Space wrap size={8} align="center" style={{ marginBottom: 8 }}>
        <Typography.Text strong>{t('leadscore.panel.insightTitle')}</Typography.Text>
        <Tag color="purple">{t('leadscore.panel.insightLabel')}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('leadscore.panel.insightOptional')}
        </Typography.Text>
        {action.allowed ? (
          <Button size="small" loading={busy} onClick={onAsk}>
            {busy ? t('leadscore.panel.insightAsking') : t('leadscore.panel.insightAsk')}
          </Button>
        ) : null}
      </Space>

      {hint === null ? null : (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {hint}
        </Typography.Paragraph>
      )}

      {answer === null ? (
        action.allowed ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('leadscore.panel.insightEmpty')}
          </Typography.Text>
        ) : null
      ) : (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {answer.withheld === null ? (
            <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{answer.text ?? ''}</Typography.Paragraph>
          ) : (
            <Alert type="info" showIcon message={t('leadscore.panel.insightWithheld')} />
          )}
          {stale ? <Alert type="warning" showIcon message={t('leadscore.panel.insightStale')} /> : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${t('leadscore.panel.insightGeneratedAt')}: ${formatDateTime(answer.generatedAt)} · ${t('leadscore.panel.insightAgent')}: ${answer.agent.name}${answer.agent.version === null ? '' : ` v${String(answer.agent.version)}`}`}
          </Typography.Text>
          {provenance.length === 0 ? null : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {provenance.join(' · ')}
            </Typography.Text>
          )}
        </Space>
      )}
    </div>
  );
}

function newInsightKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `li_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function LeadScorePanel({ leadId, onChanged }: { leadId: string; onChanged?: () => void }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  // Kept across a failure: a retry re-sends the same request key, so a response lost after the provider ran
  // returns the stored answer instead of paying for a second run.
  const insightKey = useRef<string | undefined>(undefined);

  const read = useQuery({
    queryKey: ['leadScore', 'score', leadId],
    queryFn: () => api.leadScoreRead(leadId),
    staleTime: 15_000,
    retry: false,
  });
  const view: LeadScoreRead | undefined = read.data;

  const history = useQuery({
    queryKey: ['leadScore', 'history', leadId, historyOffset],
    queryFn: () => api.leadScoreHistory(leadId, { limit: HISTORY_PAGE, offset: historyOffset }),
    // Asked for only when the drawer is open *and* the server said this caller holds the wider right.
    enabled: historyOpen && view?.actions.history.allowed === true,
    retry: false,
  });

  const recalculate = useMutation({
    mutationFn: () => api.leadScoreRecalculate(leadId),
    onSuccess: async (write) => {
      // LS.5's no-op is the honest common case: an unchanged Lead records nothing and the row does not move.
      void message.success(write.recorded ? t('leadscore.panel.recordsWritten') : t('leadscore.panel.unchanged'));
      queryClient.invalidateQueries({ queryKey: ['leadScore'] });
      onChanged?.();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const insight = useMutation({
    mutationFn: () => {
      insightKey.current = insightKey.current ?? newInsightKey();
      return api.leadScoreInsight(leadId, insightKey.current);
    },
    onSuccess: () => {
      insightKey.current = undefined;
      void queryClient.invalidateQueries({ queryKey: ['leadScore'] });
      onChanged?.();
    },
    onError: (error: Error) => void message.error(`${t('leadscore.panel.insightFailed')} ${error.message}`),
  });

  if (read.isError || view === undefined) return null;

  const { score, freshness, explanation } = view;
  const coverage = score.coverage === null ? null : Math.round(score.coverage * 100);
  const movement = score.value !== null && score.previousValue !== null ? score.value - score.previousValue : null;

  return (
    <Card
      className="carocrm-card"
      title={
        <Space>
          <Typography.Text strong>{t('leadscore.panel.title')}</Typography.Text>
          <span className={bandPill(score.band)}>{bandLabel(score.band)}</span>
          {freshness.status !== 'current' ? <span className="carocrm-pill">{freshness.label}</span> : null}
        </Space>
      }
      extra={
        <Space>
          {view.actions.history.allowed ? (
            <Button
              icon={<HistoryOutlined />}
              onClick={() => {
                setHistoryOffset(0);
                setHistoryOpen(true);
              }}
            >
              {t('leadscore.panel.history')}
            </Button>
          ) : null}
          {view.actions.recalculate.allowed ? (
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={recalculate.isPending}
              onClick={() => void recalculate.mutateAsync()}
            >
              {t('leadscore.panel.recalculate')}
            </Button>
          ) : null}
        </Space>
      }
    >
      {!view.scored ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>{t('leadscore.panel.notScored')}</Typography.Text>
              {freshness.reasonLabels.length > 0 ? (
                <Typography.Text type="secondary">{freshness.reasonLabels.join(' ')}</Typography.Text>
              ) : null}
            </Space>
          }
        />
      ) : (
        <>
          <div className="carocrm-score-headline">
            <span className="carocrm-score-value">{score.value === null ? '—' : formatNumber(score.value)}</span>
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">{t('leadscore.panel.band')}</Typography.Text>
              <span className={bandPill(score.band)}>{bandLabel(score.band)}</span>
            </Space>
            {movement !== null && movement !== 0 ? (
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary">{t('leadscore.panel.movement')}</Typography.Text>
                <Typography.Text strong aria-label={t('leadscore.panel.movementAria', { from: String(score.previousValue), to: String(score.value) })}>
                  {signedPoints(movement)}
                </Typography.Text>
              </Space>
            ) : null}
            {coverage !== null ? (
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary">{t('leadscore.panel.coverage')}</Typography.Text>
                <Typography.Text strong>{`${String(formatNumber(coverage))}%`}</Typography.Text>
              </Space>
            ) : null}
          </div>

          {freshness.reasonLabels.length > 0 ? (
            <Alert type={freshness.status === 'failed' ? 'error' : 'warning'} showIcon message={freshness.reasonLabels.join(' ')} style={{ margin: '4px 0 12px' }} />
          ) : null}

          {/* One column on a phone: two squeezed the timestamps into a strip five characters wide. */}
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ marginBottom: 8 }} items={[
            {
              key: 'model',
              label: t('leadscore.panel.model'),
              children: score.modelVersion === null ? '—' : t('leadscore.panel.modelVersion', { version: String(score.modelVersion) }),
            },
            { key: 'calculated', label: t('leadscore.panel.calculatedAt'), children: formatDateTime(score.calculatedAt) },
            { key: 'inputs', label: t('leadscore.panel.inputsAsOf'), children: formatDateTime(score.inputsAsOf) },
            { key: 'status', label: t('leadscore.panel.status'), children: freshness.label },
          ]} />

          <Typography.Text strong>{t('leadscore.panel.rules')}</Typography.Text>
          <ExplanationList entries={explanation.breakdown} signalState={explanation.signalState} />

          {explanation.errorCodes.length > 0 ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {t('leadscore.panel.errorCodes', { codes: explanation.errorCodes.join(', ') })}
            </Typography.Text>
          ) : null}
          {explanation.reasonCodes.skipped.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('leadscore.panel.skipped', { codes: explanation.reasonCodes.skipped.join(', ') })}
            </Typography.Text>
          ) : null}

          <InsightSection view={view} busy={insight.isPending} onAsk={() => insight.mutate()} />
        </>
      )}

      <Drawer
        title={t('leadscore.panel.historyTitle')}
        width={Math.min(720, Math.round((typeof window === 'undefined' ? 1024 : window.innerWidth) * 0.9))}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      >
        {history.isError ? <Alert type="warning" showIcon message={t('leadscore.panel.historyFailed')} /> : null}
        <Table<LeadScoreHistoryItem>
          size="small"
          rowKey="evaluationId"
          loading={history.isPending}
          dataSource={[...(history.data?.items ?? [])]}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: t('leadscore.panel.scoreColumn'), dataIndex: 'scoreValue', render: (value: number | null) => (value === null ? '—' : formatNumber(value)) },
            { title: t('leadscore.panel.band'), dataIndex: 'band', render: (band: string) => <span className={bandPill(band)}>{bandLabel(band)}</span> },
            { title: t('leadscore.panel.status'), dataIndex: 'evaluationStatusLabel' },
            { title: t('leadscore.panel.model'), dataIndex: 'modelVersion', render: (version: number) => t('leadscore.panel.modelVersion', { version: String(version) }) },
            // `triggerHeader`, not `trigger`: the latter is the parent of the value keys, and i18next
            // answers a parent lookup with an error string rather than a label.
            { title: t('leadscore.panel.triggerHeader'), dataIndex: 'trigger', render: (trigger: string) => triggerLabel(trigger) },
            { title: t('leadscore.panel.calculatedAt'), dataIndex: 'calculatedAt', render: (value: string | null) => formatDateTime(value) },
          ]}
          expandable={{
            // A past evaluation's own breakdown: what the score was made of *then*, which is the reason the
            // rows are immutable (plan §5.4).
            expandedRowRender: (row) => <ExplanationList entries={row.breakdown} signalState={row.signalState} />,
            rowExpandable: (row) => row.breakdown.length > 0,
          }}
        />
        <Space style={{ marginTop: 12 }}>
          <Button
            disabled={(history.data?.items.length ?? 0) === 0 || (history.data?.offset ?? 0) + (history.data?.items.length ?? 0) >= (history.data?.total ?? 0)}
            onClick={() => setHistoryOffset((offset) => offset + HISTORY_PAGE)}
          >
            {t('leadscore.panel.loadMore')}
          </Button>
          <Typography.Text type="secondary">
            {t('leadscore.panel.showing', { shown: String((history.data?.offset ?? 0) + (history.data?.items.length ?? 0)), total: String(history.data?.total ?? 0) })}
          </Typography.Text>
        </Space>
      </Drawer>
    </Card>
  );
}
