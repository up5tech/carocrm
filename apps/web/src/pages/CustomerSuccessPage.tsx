import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Descriptions, Drawer, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { Link, useSearchParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PageHeader } from '../components/PageHeader.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { formatDateTime, formatNumber, t } from '../state/i18n.js';

/**
 * Phase 19-CS.12 — the Customer Success portfolio (plans/PLAN_Phase_19_Customer_Success.md §5.2, §5.12,
 * §12 `19-CS.12`).
 *
 * The generic entity views can already list a `CustomerSuccessProfile`, but they cannot express what a CSM
 * actually works from — "whose health is falling and has no next action", "who renews inside 90 days",
 * "why is this account amber". Those questions are answered by the module's portfolio queues, its portfolio
 * aggregate and its health explanation, all of which decide visibility from the reader's own record scope.
 * This page renders those answers and adds nothing of its own: it never filters, counts or explains a
 * profile the reader could not open, and every mutation it offers is validated server-side.
 */

const QUEUES = [
  'myPortfolio',
  'teamPortfolio',
  'unassigned',
  'unknownHealth',
  'monitorHealth',
  'atRiskHealth',
  'criticalHealth',
  'onboardingNow',
  'onboardingOverdue',
  'upcomingRenewals',
  'missingPlan',
  'missingNextReview',
] as const;

type PortfolioQueue = (typeof QUEUES)[number];

interface PortfolioRow {
  id: string;
  name: string | null;
  accountId: string | null;
  lifecycleStage: string | null;
  healthStatus: string | null;
  effectiveHealthStatus: string | null;
  healthScore: number | null;
  scoreTrend: string | null;
  daysToRenewal: number | null;
  openRiskCount: number | null;
  nextSuccessReviewAt: string | null;
}

interface HealthComponent {
  key: string;
  label: string;
  weight: number;
  score: number | null;
  contribution: number | null;
  explanationCode: string;
  available: boolean;
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: 'green',
  monitor: 'gold',
  atRisk: 'orange',
  critical: 'red',
  unknown: 'default',
};

const TREND_COLORS: Record<string, string> = {
  falling: 'red',
  rising: 'green',
  stable: 'blue',
  unknown: 'default',
};

function healthTag(value: string | null): React.ReactNode {
  const status = value ?? 'unknown';
  return <Tag color={HEALTH_COLORS[status] ?? 'default'}>{t(`web.customerSuccess.health.${status}`)}</Tag>;
}

function trendTag(value: string | null): React.ReactNode {
  const trend = value ?? 'unknown';
  return <Tag color={TREND_COLORS[trend] ?? 'default'}>{t(`web.customerSuccess.trend.${trend}`)}</Tag>;
}

export function CustomerSuccessPage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queue = (QUEUES as readonly string[]).includes(String(searchParams.get('queue')))
    ? (String(searchParams.get('queue')) as PortfolioQueue)
    : 'myPortfolio';
  const openProfileId = searchParams.get('profile');

  const summary = useQuery({ queryKey: ['customerSuccess', 'summary'], queryFn: () => api.customerSuccessPortfolioSummary(), staleTime: 20_000, retry: false });
  const rows = useQuery({
    queryKey: ['customerSuccess', 'queue', queue],
    queryFn: () => api.customerSuccessPortfolioQueue(queue, 50),
    staleTime: 15_000,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['customerSuccess', 'profile', openProfileId],
    queryFn: () => api.customerSuccessProfileSummary(String(openProfileId)),
    enabled: openProfileId !== null,
    staleTime: 15_000,
    retry: false,
  });
  const explanation = useQuery({
    queryKey: ['customerSuccess', 'explanation', openProfileId],
    queryFn: () => api.customerSuccessHealthExplanation(String(openProfileId)),
    enabled: openProfileId !== null,
    staleTime: 15_000,
    retry: false,
  });

  const recalculate = useMutation({
    mutationFn: (profileId: string) => api.customerSuccessRecalculateHealth(profileId),
    onSuccess: () => {
      void message.success(t('web.customerSuccess.recalculated'));
      void queryClient.invalidateQueries({ queryKey: ['customerSuccess', 'profile', openProfileId] });
      void queryClient.invalidateQueries({ queryKey: ['customerSuccess', 'explanation', openProfileId] });
      void queryClient.invalidateQueries({ queryKey: ['customerSuccess', 'queue', queue] });
      void queryClient.invalidateQueries({ queryKey: ['customerSuccess', 'summary'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (summary.isLoading || rows.isLoading) return <LoadingSkeleton rows={8} />;
  if (summary.isError || rows.isError) {
    // A caller who may not read the entity is refused by the server, and the page says so as a denial
    // rather than an error (AGENTS.md §5.3: the frontend never decides what is visible).
    const forbidden = [summary.error, rows.error].some((error) => error instanceof ApiError && error.status === 403);
    if (forbidden) return <PermissionDenied hint={t('web.customerSuccess.denied')} />;
    return <ErrorState message={t('web.customerSuccess.loadFailed')} onRetry={() => void Promise.all([summary.refetch(), rows.refetch()])} />;
  }

  const aggregate = summary.data as Record<string, unknown>;
  const byHealth = (aggregate['byHealth'] ?? {}) as Record<string, number>;
  const renewals = (aggregate['renewalsByWindow'] ?? {}) as Record<string, number>;
  const onboarding = (aggregate['onboarding'] ?? {}) as Record<string, number>;
  const queueResult = rows.data ?? {};
  const queueRows = ((queueResult['list'] ?? []) as PortfolioRow[]) ?? [];
  const profile = (detail.data ?? {}) as Record<string, unknown>;
  const profileHealth = (profile['health'] ?? {}) as Record<string, unknown>;
  const profilePlan = profile['plan'] === null || profile['plan'] === undefined ? null : (profile['plan'] as Record<string, unknown>);
  const profileRisks = (profile['risks'] ?? {}) as Record<string, unknown>;
  const components = (((explanation.data as Record<string, unknown>)?.['components'] ?? []) as HealthComponent[]) ?? [];
  // `coverage` is `measured weight / total weight`, a fraction of the score the signals could explain.
  const rawCoverage = (explanation.data as Record<string, unknown> | undefined)?.['coverage'];
  const coveragePercent = typeof rawCoverage === 'number' ? Math.round(rawCoverage * 100) : null;

  const setParam = (key: string, value: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  return (
    <div>
      <PageHeader
        title={t('web.customerSuccess.title')}
        subtitle={t('web.customerSuccess.subtitle')}
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['customerSuccess'] });
            }}
          >
            {t('web.customerSuccess.refresh')}
          </Button>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Typography.Text type="secondary">{t('web.customerSuccess.total')}</Typography.Text>
            <div className="carocrm-stat-value">{formatNumber(Number(aggregate['total'] ?? 0))}</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Typography.Text type="secondary">{t('web.customerSuccess.healthDistribution')}</Typography.Text>
            <Space size={4} wrap style={{ marginTop: 8 }}>
              {Object.entries(byHealth).map(([status, count]) => (
                <Tag key={status} color={HEALTH_COLORS[status] ?? 'default'}>
                  {t(`web.customerSuccess.health.${status}`)} {formatNumber(count)}
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Typography.Text type="secondary">{t('web.customerSuccess.onboardingOverdue')}</Typography.Text>
            <div className="carocrm-stat-value">{formatNumber(Number(onboarding['overdue'] ?? 0))}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.customerSuccess.unassignedCount', { count: formatNumber(Number(aggregate['unassigned'] ?? 0)) })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Typography.Text type="secondary">{t('web.customerSuccess.upcomingRenewals')}</Typography.Text>
            {Object.entries(renewals).map(([window, count]) => (
              <div key={window} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <Typography.Text type="secondary">{t('web.customerSuccess.inDays', { days: window })}</Typography.Text>
                <Typography.Text strong>{formatNumber(count)}</Typography.Text>
              </div>
            ))}
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={t('web.customerSuccess.queue')}
        extra={
          <Select
            size="small"
            style={{ width: 260 }}
            value={queue}
            onChange={(value: PortfolioQueue) => setParam('queue', value)}
            options={QUEUES.map((value) => ({ value, label: t(`web.customerSuccess.queues.${value}`) }))}
          />
        }
      >
        <Table<PortfolioRow>
          size="small"
          rowKey={(row) => row.id}
          dataSource={queueRows}
          pagination={false}
          locale={{ emptyText: <EmptyState description={t('web.customerSuccess.queueEmpty')} /> }}
          columns={[
            {
              title: t('web.customerSuccess.profile'),
              dataIndex: 'name',
              render: (_: unknown, row) => (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setParam('profile', row.id)}>
                  {row.name ?? row.id}
                </Button>
              ),
            },
            { title: t('web.customerSuccess.healthColumn'), dataIndex: 'effectiveHealthStatus', width: 130, render: (value: string | null) => healthTag(value) },
            {
              title: t('web.customerSuccess.score'),
              dataIndex: 'healthScore',
              width: 90,
              render: (value: number | null, row) => (
                <Space size={4}>
                  <span>{value === null ? '—' : String(value)}</span>
                  {trendTag(row.scoreTrend)}
                </Space>
              ),
            },
            {
              title: t('web.customerSuccess.renewal'),
              dataIndex: 'daysToRenewal',
              width: 110,
              render: (value: number | null) => (value === null ? '—' : t('web.customerSuccess.inDays', { days: String(value) })),
            },
            {
              title: t('web.customerSuccess.risks'),
              dataIndex: 'openRiskCount',
              width: 80,
              render: (value: number | null) => (value === null || value === 0 ? '—' : formatNumber(value)),
            },
            {
              title: t('web.customerSuccess.nextReview'),
              dataIndex: 'nextSuccessReviewAt',
              width: 140,
              render: (value: string | null) => (value === null ? '—' : formatDateTime(value, false)),
            },
          ]}
        />
        {queueResult['truncated'] === true ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.customerSuccess.truncated', { count: String(queueResult['count'] ?? '0') })}
          </Typography.Text>
        ) : null}
      </Card>

      <Drawer
        title={t('web.customerSuccess.profileTitle')}
        width={640}
        open={openProfileId !== null}
        onClose={() => setParam('profile', null)}
        extra={
          <Button size="small" loading={recalculate.isPending} onClick={() => recalculate.mutate(String(openProfileId))}>
            {t('web.customerSuccess.recalculate')}
          </Button>
        }
      >
        {detail.isLoading ? <LoadingSkeleton rows={6} /> : null}
        {detail.isError ? <ErrorState message={t('web.customerSuccess.detailFailed')} onRetry={() => void detail.refetch()} /> : null}
        {openProfileId !== null && !detail.isLoading && !detail.isError ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('web.customerSuccess.account')}>
                {profile['accountId'] === null || profile['accountId'] === undefined ? '—' : <Link to={`/Account/${String(profile['accountId'])}`}>{String(profile['accountName'] ?? profile['accountId'])}</Link>}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.lifecycle')}>{String(profile['lifecycleStage'] ?? '—')}</Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.segment')}>{String(profile['segment'] ?? '—')}</Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.healthColumn')}>
                <Space size={4}>
                  {healthTag(typeof profileHealth['status'] === 'string' ? profileHealth['status'] : 'unknown')}
                  {coveragePercent === null ? null : (
                    <Typography.Text type="secondary">
                      {t('web.customerSuccess.coverage', { percent: String(coveragePercent) })}
                    </Typography.Text>
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.plan')}>
                {profilePlan === null ? (
                  <Typography.Text type="secondary">{t('web.customerSuccess.noPlan')}</Typography.Text>
                ) : (
                  <Space direction="vertical" size={2}>
                    <span>{String(profilePlan['name'] ?? '—')}</span>
                    <Typography.Text type="secondary">
                      {t('web.customerSuccess.planProgress', {
                        progress: String(profilePlan['progress'] ?? 0),
                        goals: String(profilePlan['goals'] ?? 0),
                        overdue: String(profilePlan['overdueGoals'] ?? 0),
                      })}
                    </Typography.Text>
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.risks')}>
                {t('web.customerSuccess.riskCounts', {
                  open: String(profileRisks['open'] ?? 0),
                  high: String(profileRisks['highOrCritical'] ?? 0),
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.nextReview')}>
                {typeof profile['nextSuccessReviewAt'] === 'string' ? formatDateTime(profile['nextSuccessReviewAt'], false) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.customerSuccess.lastTouch')}>
                {typeof profile['lastMeaningfulTouchAt'] === 'string' ? formatDateTime(profile['lastMeaningfulTouchAt'], false) : '—'}
              </Descriptions.Item>
            </Descriptions>

            <Card size="small" title={t('web.customerSuccess.why')}>
              {components.length === 0 ? (
                <EmptyState description={t('web.customerSuccess.noComponents')} />
              ) : (
                <Table<HealthComponent>
                  size="small"
                  rowKey={(row) => row.key}
                  pagination={false}
                  dataSource={components}
                  columns={[
                    { title: t('web.customerSuccess.component'), dataIndex: 'label' },
                    { title: t('web.customerSuccess.weight'), dataIndex: 'weight', width: 70 },
                    {
                      title: t('web.customerSuccess.measured'),
                      dataIndex: 'score',
                      width: 90,
                      render: (value: number | null, row) => (row.available ? (value === null ? '—' : String(value)) : t('web.customerSuccess.unavailable')),
                    },
                    {
                      title: t('web.customerSuccess.contribution'),
                      dataIndex: 'contribution',
                      width: 100,
                      render: (value: number | null) => (value === null ? '—' : String(value)),
                    },
                  ]}
                />
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.customerSuccess.explanationNote')}
              </Typography.Text>
            </Card>

            <Alert
              type="info"
              showIcon
              message={
                <Link to={`/CustomerSuccessProfile/${String(openProfileId)}`}>{t('web.customerSuccess.openRecord')}</Link>
              }
              description={t('web.customerSuccess.openRecordHint')}
            />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
