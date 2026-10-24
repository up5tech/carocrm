import { DeleteOutlined,PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Input, InputNumber, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type JobRow } from '../../api/client.js';
import type { LeadScoreBatchStartView, LeadScoreEditorCatalog, LeadScoreModelRecord } from '../../api/types.js';
import { formatDateTime, t } from '../../state/i18n.js';
import { enumValues, fieldLabel, filterEntries, useEntity } from '../../state/metadata.js';
import { errorText } from './shared.js';

/**
 * Phase 19-LS.8 — the rebuild and its queue
 * (`PLAN_Phase_19_LeadScore.md` §8.2, §9.4, §10.2, §11.1, §16 `19-LS.8`; audit §11).
 *
 * A rebuild is a *job*, so this screen has two halves that answer two different questions: what am I asking
 * for, and what is the queue doing about it. Both stay the server's business:
 *
 *  - the bounds (`limits.maxBatchTotal`, `limits.maxBatchChunk`) come from the editor catalog, which imports
 *    them from the service that enforces them — a request can lower them and cannot raise them;
 *  - the job list is `/api/v1/Job`, the platform's own queue view, filtered to the module's two job names, so
 *    progress, attempt count and cancellation mean the same thing here as they do on `/admin/jobs`.
 *
 * The filter uses the Lead's *metadata* filter fields — the same list the Lead page builds its filter panel
 * from — because a rebuild selection is a query, not a scoring condition, and the query engine is what
 * validates it when the chunk runs.
 */

/** The rebuild's two job names, exactly as the module enqueues them. */
const BATCH_JOB = 'leadScore.batchRecalculate';
const LEAD_JOB = 'leadScore.recalculateLead';

interface FilterDraft {
  field: string;
  operator: string;
  value: string;
}

export function OperationsTab({
  granted,
  catalog,
  models,
  activeModelId,
}: {
  granted: ReadonlySet<string>;
  catalog: LeadScoreEditorCatalog | undefined;
  models: readonly LeadScoreModelRecord[];
  activeModelId: string | null;
}) {
  const queryClient = useQueryClient();
  const maxTotal = catalog?.limits.maxBatchTotal ?? 2000;
  const maxChunk = catalog?.limits.maxBatchChunk ?? 50;
  const [limit, setLimit] = useState(200);
  const [chunkSize, setChunkSize] = useState(Math.min(25, maxChunk));
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [started, setStarted] = useState<LeadScoreBatchStartView | undefined>();

  const lead = useEntity('Lead');
  const filterable = filterEntries(lead.data);

  const start = useMutation({
    mutationFn: () => api.leadScoreRecalculateBatch({ limit, chunkSize, where: drafts.filter((draft) => draft.field !== '' && draft.operator !== '').map(toCondition) }),
    onSuccess: (view) => {
      setStarted(view);
      void queryClient.invalidateQueries({ queryKey: ['leadScore', 'jobs'] });
    },
    onError: () => setStarted(undefined),
  });

  const jobs = useQuery({
    queryKey: ['leadScore', 'jobs'],
    queryFn: async () => {
      const [batch, single] = await Promise.all([api.jobs({ job: BATCH_JOB, limit: 10 }), api.jobs({ job: LEAD_JOB, limit: 10 })]);
      return [...batch.list, ...single.list];
    },
    refetchInterval: 10_000,
    retry: false,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leadScore', 'jobs'] }),
  });

  const canStart = granted.has('batchRecalculate');
  const activeModel = models.find((model) => model.id === activeModelId);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={t('leadscore.admin.operations.rebuild')}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            {t('leadscore.admin.operations.rebuildHint', { total: String(maxTotal), chunk: String(maxChunk) })}
          </Typography.Paragraph>

          {activeModel === undefined ? (
            <Alert type="warning" showIcon message={t('leadscore.admin.operations.noActiveModel')} description={t('leadscore.admin.operations.noActiveModelHint')} />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('leadscore.admin.operations.activeModel', { name: activeModel.name, version: String(activeModel.modelVersion) })}
            </Typography.Text>
          )}

          <Space wrap size={16} align="end">
            <LabeledNumber label={t('leadscore.admin.operations.limit')} value={limit} min={1} max={maxTotal} onChange={setLimit} disabled={!canStart} />
            <LabeledNumber label={t('leadscore.admin.operations.chunk')} value={chunkSize} min={1} max={maxChunk} onChange={setChunkSize} disabled={!canStart} />
          </Space>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('leadscore.admin.operations.filter')}
          </Typography.Text>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {drafts.map((draft, index) => (
              <Space key={`${String(index)}-${draft.field}`} wrap size={8} align="end">
                <Select
                  size="small"
                  style={{ minWidth: 200 }}
                  value={draft.field === '' ? null : draft.field}
                  placeholder={t('leadscore.admin.operations.field')}
                  showSearch
                  optionFilterProp="label"
                  disabled={!canStart}
                  onChange={(field: string) => setDrafts(drafts.map((entry, position) => (position === index ? { ...entry, field } : entry)))}
                  options={filterable.map((entry) => ({ value: entry.name, label: fieldLabel(entry.name, entry.field, undefined) }))}
                />
                <Select
                  size="small"
                  style={{ minWidth: 148 }}
                  value={draft.operator}
                  disabled={!canStart}
                  onChange={(operator) => setDrafts(drafts.map((entry, position) => (position === index ? { ...entry, operator } : entry)))}
                  options={operatorOptions()}
                />
                <FilterValue
                  draft={draft}
                  entries={filterable}
                  disabled={!canStart}
                  onChange={(value) => setDrafts(drafts.map((entry, position) => (position === index ? { ...entry, value } : entry)))}
                />
                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('web.common.remove')} disabled={!canStart} onClick={() => setDrafts(drafts.filter((_, position) => position !== index))} />
              </Space>
            ))}
            {drafts.length < 8 ? (
              <Button size="small" icon={<PlusOutlined />} disabled={!canStart} onClick={() => setDrafts([...drafts, { field: '', operator: 'equals', value: '' }])}>
                {t('leadscore.admin.operations.addFilter')}
              </Button>
            ) : null}
          </Space>

          <Space wrap size={8}>
            <Popconfirm
              title={t('leadscore.admin.operations.confirm', { limit: String(limit) })}
              description={t('leadscore.admin.operations.confirmHint')}
              okText={t('leadscore.admin.operations.start')}
              cancelText={t('core.common.cancel')}
              onConfirm={() => start.mutate()}
              disabled={!canStart}
            >
              <Button type="primary" loading={start.isPending} disabled={!canStart}>
                {t('leadscore.admin.operations.start')}
              </Button>
            </Popconfirm>
            {!canStart ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('leadscore.admin.operations.needRight')}</Typography.Text> : null}
          </Space>

          {start.isError ? <Alert type="error" showIcon message={t('leadscore.admin.operations.startFailed')} description={errorText(start.error)} /> : null}
          {started === undefined ? null : (
            <Alert
              type="success"
              showIcon
              message={t('leadscore.admin.operations.queued', { limit: String(started.limit), chunk: String(started.chunkSize) })}
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text code>{started.runId}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('leadscore.admin.operations.queuedHint')}
                  </Typography.Text>
                </Space>
              }
            />
          )}
        </Space>
      </Card>

      <Card
        title={t('leadscore.admin.operations.jobs')}
        extra={
          <Space size={8}>
            <Button size="small" onClick={() => void jobs.refetch()}>
              {t('core.common.reload')}
            </Button>
            <Link to="/admin/jobs">{t('leadscore.admin.operations.allJobs')}</Link>
          </Space>
        }
      >
        <Table<JobRow>
          size="small"
          rowKey="id"
          loading={jobs.isLoading}
          dataSource={[...(jobs.data ?? [])]}
          pagination={false}
          locale={{ emptyText: t('leadscore.admin.operations.noJobs') }}
          columns={[
            { title: t('leadscore.admin.operations.job'), dataIndex: 'job', key: 'job', render: (value: string) => <Typography.Text code style={{ fontSize: 12 }}>{value}</Typography.Text> },
            {
              title: t('leadscore.admin.operations.status'),
              dataIndex: 'status',
              key: 'status',
              width: 116,
              render: (value: string, row) => (
                <Space size={6}>
                  <Tag color={statusColor(value)}>{value}</Tag>
                  {row.cancelRequested ? <Tag color="orange">{t('leadscore.admin.operations.cancelRequested')}</Tag> : null}
                </Space>
              ),
            },
            { title: t('leadscore.admin.operations.attempts'), key: 'attempts', width: 96, render: (_, row) => `${String(row.attempt)}/${String(row.maxAttempts)}` },
            { title: t('leadscore.admin.operations.progress'), dataIndex: 'progress', key: 'progress', width: 96, render: (value: number) => `${String(value)}%` },
            {
              title: t('leadscore.admin.operations.message'),
              key: 'message',
              render: (_, row) => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.lastError ?? row.message ?? ''}
                </Typography.Text>
              ),
            },
            { title: t('leadscore.admin.operations.createdAt'), dataIndex: 'createdAt', key: 'createdAt', width: 176, render: (value: string) => <Typography.Text type="secondary">{formatDateTime(value)}</Typography.Text> },
            {
              title: '',
              key: 'actions',
              width: 108,
              render: (_, row) =>
                // The platform's own cancellable states: a job the queue still holds. `AdminJobsPage` uses
                // the same pair, and a rebuild that already finished cannot be taken back.
                row.status === 'pending' || row.status === 'running' ? (
                  <Button size="small" type="link" danger loading={cancel.isPending} disabled={!canStart} onClick={() => cancel.mutate(row.id)}>
                    {t('leadscore.admin.operations.cancel')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}

/** The list page's own operator set — a rebuild selection is a query, and it uses the query engine's words. */
function operatorOptions(): { value: string; label: string }[] {
  return [
    { value: 'contains', label: t('web.list.contains') },
    { value: 'equals', label: t('web.list.equals') },
    { value: 'notEquals', label: t('web.list.notEquals') },
    { value: 'greaterThan', label: t('web.list.greaterThan') },
    { value: 'lessThan', label: t('web.list.lessThan') },
    { value: 'isNull', label: t('web.list.isNull') },
    { value: 'isNotNull', label: t('web.list.isNotNull') },
  ];
}

const NO_VALUE: ReadonlySet<string> = new Set(['isNull', 'isNotNull']);

function toCondition(draft: FilterDraft): Record<string, unknown> {
  return { field: draft.field, operator: draft.operator, ...(NO_VALUE.has(draft.operator) ? {} : { value: draft.value }) };
}

function statusColor(status: string): string {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'running') return 'blue';
  if (status === 'cancelled') return 'default';
  return 'orange';
}

function LabeledNumber({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {`${label} (${String(min)}–${String(max)})`}
      </Typography.Text>
      <InputNumber size="small" min={min} max={max} value={value} disabled={disabled} precision={0} style={{ width: 148 }} onChange={(next) => onChange(Number(next ?? min))} />
    </Space>
  );
}

/** The value control for one filter, from the same field metadata the Lead list uses. */
function FilterValue({
  draft,
  entries,
  disabled,
  onChange,
}: {
  draft: FilterDraft;
  entries: ReturnType<typeof filterEntries>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  if (NO_VALUE.has(draft.operator)) return null;
  const entry = entries.find((candidate) => candidate.name === draft.field);
  const options = entry === undefined ? [] : enumValues(entry.field);
  if (options.length === 0) {
    return <Input size="small" style={{ width: 220 }} value={draft.value} disabled={disabled} placeholder={t('leadscore.admin.operations.value')} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <Select
      size="small"
      style={{ minWidth: 220 }}
      value={draft.value === '' ? null : draft.value}
      disabled={disabled}
      placeholder={t('leadscore.admin.operations.value')}
      onChange={onChange}
      options={options.map((option) => ({ value: option, label: option }))}
    />
  );
}
