import { BarChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { api } from '../../api/client.js';
import type { ESignatureReportSection } from '../../api/types.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.19 — the operational reporting screen (PLAN_Phase_19_ESignature.md §14).
 *
 * Every figure is the server's answer under the caller's own record scope. The panel never derives a
 * rate locally, so a shared dashboard and this screen cannot disagree about what "completed" means.
 * The only fields on screen are aggregate counters, durations and opaque owner/source ids — no
 * recipient, document or message detail is fetched at all.
 */
const WINDOWS = [30, 90, 365, 0] as const;

interface StatusCountRow {
  status: string;
  count: number;
}

interface RateData {
  cohort: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
  inFlight: number;
  completionRate: number | null;
  declineRate: number | null;
  voidRate: number | null;
  expiryRate: number | null;
}

interface ApprovalData {
  pending: number;
  olderThan24Hours: number;
  olderThan3Days: number;
  oldestAgeHours: number | null;
}

interface WaitingData {
  requestsWaiting: number;
  recipientsWaiting: number;
  byRecipientStatus: StatusCountRow[];
  oldestAgeHours: number | null;
}

interface CompletionData {
  completed: number;
  averageHours: number | null;
  medianHours: number | null;
  p90Hours: number | null;
}

interface ExceptionData {
  total: number;
  byStatus: StatusCountRow[];
  byFailureCategory: { category: string; count: number }[];
  oldestAgeHours: number | null;
}

interface VolumeData {
  total: number;
  bySource: { sourceEntityType: string | null; count: number }[];
  byOwner: { ownerUserId: string | null; count: number }[];
}

export function ESignatureReportsPanel({ days, onDaysChange }: { readonly days: number; readonly onDaysChange: (days: number) => void }) {
  const report = useQuery({
    queryKey: ['eSignature', 'reports', days],
    queryFn: () => api.eSignatureReports(days),
    staleTime: 30_000,
  });

  if (report.isLoading) return <LoadingSkeleton rows={6} />;
  if (report.isError || report.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.reports.loadFailed')} ${report.error instanceof Error ? report.error.message : ''}`}
        onRetry={() => void report.refetch()}
      />
    );
  }

  const section = (key: string): ESignatureReportSection | undefined => report.data.sections.find((entry) => entry.key === key);
  const status = section('status')?.data as { total: number; byStatus: StatusCountRow[] } | undefined;
  const rates = section('rates')?.data as RateData | undefined;
  const approvals = section('approvals')?.data as ApprovalData | undefined;
  const waiting = section('waiting')?.data as WaitingData | undefined;
  const completion = section('completionTime')?.data as CompletionData | undefined;
  const exceptions = section('exceptions')?.data as ExceptionData | undefined;
  const volume = section('volume')?.data as VolumeData | undefined;

  return (
    <Card
      className="carocrm-card"
      title={
        <Space size={8}>
          <BarChartOutlined />
          {t('esignature.reports.title')}
        </Space>
      }
      extra={
        <Space size={8} wrap>
          <Select
            size="small"
            style={{ minWidth: 160 }}
            value={days}
            onChange={onDaysChange}
            options={WINDOWS.map((value) => ({
              value,
              label: value === 0 ? t('esignature.reports.windowAll') : t('esignature.reports.windowDays', { days: value }),
            }))}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void report.refetch()}>
            {t('core.common.reload')}
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
        {t('esignature.reports.windowHint')}
      </Typography.Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={8} lg={4}>
          <Statistic title={t('esignature.reports.requestsCreated')} value={status?.total ?? 0} />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title={t('esignature.reports.completionRate')}
            value={rates?.completionRate === null || rates?.completionRate === undefined ? '—' : Math.round(rates.completionRate * 1000) / 10}
            suffix={rates?.completionRate === null || rates?.completionRate === undefined ? '' : '%'}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title={t('esignature.reports.medianCompletion')}
            value={completion?.medianHours ?? '—'}
            suffix={completion?.medianHours === null || completion?.medianHours === undefined ? '' : 'h'}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic title={t('esignature.reports.pendingApprovals')} value={approvals?.pending ?? 0} />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic title={t('esignature.reports.waitingRecipients')} value={waiting?.recipientsWaiting ?? 0} />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title={t('esignature.reports.exceptions')}
            value={exceptions?.total ?? 0}
            {...(exceptions !== undefined && exceptions.total > 0 ? { valueStyle: { color: 'var(--carocrm-c-cf1322)' } } : {})}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.byStatus')}>
            <Table<StatusCountRow>
              size="small"
              rowKey="status"
              pagination={false}
              dataSource={[...(status?.byStatus ?? [])]}
              columns={[
                { title: t('esignature.reports.columnStatus'), dataIndex: 'status', render: (value: string) => t(`esignature.requests.statuses.${value}`) },
                { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.rates')}>
            <Table<{ key: string; count: number; rate: number | null }>
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={[
                { key: 'completed', count: rates?.completed ?? 0, rate: rates?.completionRate ?? null },
                { key: 'declined', count: rates?.declined ?? 0, rate: rates?.declineRate ?? null },
                { key: 'voided', count: rates?.voided ?? 0, rate: rates?.voidRate ?? null },
                { key: 'expired', count: rates?.expired ?? 0, rate: rates?.expiryRate ?? null },
                { key: 'inFlight', count: rates?.inFlight ?? 0, rate: null },
              ]}
              columns={rateColumns()}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('esignature.reports.cohortHint', { cohort: String(rates?.cohort ?? 0) })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.approvalsTitle')}>
            <Space direction="vertical" size={4}>
              <Typography.Text>{t('esignature.reports.olderThan24', { count: String(approvals?.olderThan24Hours ?? 0) })}</Typography.Text>
              <Typography.Text>{t('esignature.reports.olderThan3Days', { count: String(approvals?.olderThan3Days ?? 0) })}</Typography.Text>
              <Typography.Text type="secondary">
                {t('esignature.reports.oldest', { hours: formatHours(approvals?.oldestAgeHours ?? null) })}
              </Typography.Text>
            </Space>
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong>{t('esignature.reports.waitingTitle')}</Typography.Text>
              <Table<StatusCountRow>
                size="small"
                rowKey="status"
                pagination={false}
                dataSource={[...(waiting?.byRecipientStatus ?? [])]}
                columns={[
                  { title: t('esignature.reports.columnRecipientStatus'), dataIndex: 'status', render: (value: string) => t(`esignature.requests.recipientStatuses.${value}`) },
                  { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('esignature.reports.waitingHint', {
                  requests: String(waiting?.requestsWaiting ?? 0),
                  oldest: formatHours(waiting?.oldestAgeHours ?? null),
                })}
              </Typography.Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.completionTitle')}>
            <Row gutter={12}>
              <Col span={8}>
                <Statistic title={t('esignature.reports.average')} value={completion?.averageHours ?? '—'} suffix={completion?.averageHours === null || completion?.averageHours === undefined ? '' : 'h'} />
              </Col>
              <Col span={8}>
                <Statistic title={t('esignature.reports.median')} value={completion?.medianHours ?? '—'} suffix={completion?.medianHours === null || completion?.medianHours === undefined ? '' : 'h'} />
              </Col>
              <Col span={8}>
                <Statistic title={t('esignature.reports.p90')} value={completion?.p90Hours ?? '—'} suffix={completion?.p90Hours === null || completion?.p90Hours === undefined ? '' : 'h'} />
              </Col>
            </Row>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('esignature.reports.completionHint', { completed: String(completion?.completed ?? 0) })}
            </Typography.Text>
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong>{t('esignature.reports.exceptionsTitle')}</Typography.Text>
              <Table<StatusCountRow>
                size="small"
                rowKey="status"
                pagination={false}
                dataSource={[...(exceptions?.byStatus ?? [])]}
                columns={[
                  { title: t('esignature.reports.columnStatus'), dataIndex: 'status', render: (value: string) => t(`esignature.requests.statuses.${value}`) },
                  { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
                ]}
              />
              <Space size={[4, 4]} wrap>
                {(exceptions?.byFailureCategory ?? []).map((row) => (
                  <Tag key={row.category}>
                    {row.category} · {row.count}
                  </Tag>
                ))}
              </Space>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.volumeBySource')}>
            <Table<{ id: string; label: string; count: number }>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={(volume?.bySource ?? []).map((row) => ({
                id: row.sourceEntityType ?? 'none',
                label: row.sourceEntityType ?? t('esignature.reports.noSource'),
                count: row.count,
              }))}
              columns={[
                { title: t('esignature.reports.columnSource'), dataIndex: 'label' },
                { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('esignature.reports.volumeByOwner')}>
            <Table<{ id: string; label: string; count: number }>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={(volume?.byOwner ?? []).map((row) => ({
                id: row.ownerUserId ?? 'unassigned',
                label: row.ownerUserId ?? t('esignature.reports.unassigned'),
                count: row.count,
              }))}
              columns={[
                { title: t('esignature.reports.columnOwner'), dataIndex: 'label' },
                { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Card>
  );
}

function rateColumns(): ColumnsType<{ key: string; count: number; rate: number | null }> {
  return [
    { title: t('esignature.reports.columnOutcome'), dataIndex: 'key', render: (value: string) => t(`esignature.reports.outcomes.${value}`) },
    { title: t('esignature.reports.columnCount'), dataIndex: 'count', width: 100 },
    {
      title: t('esignature.reports.columnRate'),
      dataIndex: 'rate',
      width: 100,
      render: (value: number | null) => (value === null ? '—' : `${Math.round(value * 1000) / 10}%`),
    },
  ];
}

function formatHours(value: number | null): string {
  return value === null ? '—' : `${value}h`;
}
