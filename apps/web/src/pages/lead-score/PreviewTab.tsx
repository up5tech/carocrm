import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, InputNumber, Progress, Radio, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../api/client.js';
import type { LeadScoreEditorCatalog, LeadScoreModelRecord, LeadScorePreviewResult, LeadScorePreviewView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { bandLabel, errorText, named, sourceLabel, statusLabel } from './shared.js';

/**
 * Phase 19-LS.8 — preview a model against a sample and change nothing
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §9.4, §15.2 stage 3, §16 `19-LS.8`; audit §5, §11).
 *
 * This is the step between drafting a model and freezing a version, and the screen exists to make it
 * routine. Two properties are worth stating on the page, because they are the reason it is safe to press:
 *
 *  - **the sample is the caller's own** — Leads come from the core list path, so record and field ACL are the
 *    real ones. A Lead this caller may not read is not scored and not named; a *field* they may not read
 *    becomes an `unknown` signal, which is the honest answer rather than a score the reader could not derive;
 *  - **nothing is written** — `writes: false` is the server's own answer, and the module asserts it in its
 *    suite: no projection, no evaluation row, no audit entry, no event. A preview that moved a stored score
 *    would be a bulk recalculation wearing a debugger's clothes.
 *
 * The sample is bounded by the server (`limits.maxPreviewSample`) and this form can only lower it.
 */

type SampleMode = 'auto' | 'picked';

export function PreviewTab({
  models,
  catalog,
  initialModelId,
}: {
  models: readonly LeadScoreModelRecord[];
  catalog: LeadScoreEditorCatalog | undefined;
  initialModelId: string | undefined;
}) {
  const bound = catalog?.limits.maxPreviewSample ?? 25;
  const [modelId, setModelId] = useState(initialModelId ?? models[0]?.id ?? '');
  const [mode, setMode] = useState<SampleMode>('auto');
  const [size, setSize] = useState(Math.min(10, bound));
  const [picked, setPicked] = useState<string[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (initialModelId !== undefined) setModelId(initialModelId);
  }, [initialModelId]);

  const leads = useLeads(mode === 'picked');
  const preview = useMutation({ mutationFn: run });

  function run(): Promise<LeadScorePreviewView> {
    // `maxSize` can only lower the server's bound, and a picked list cannot widen it either (plan §9.4).
    return api.leadScorePreview(mode === 'picked' && picked.length > 0 ? { modelId, leadIds: picked } : { modelId, maxSize: size });
  }

  const view = preview.data;

  return (
    <Card title={t('leadscore.admin.preview.title')}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
          {t('leadscore.admin.preview.subtitle', { bound: String(bound) })}
        </Typography.Paragraph>

        <Row gutter={12}>
          <Col xs={24} md={10}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('leadscore.admin.preview.model')}
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={modelId === '' ? null : modelId}
              placeholder={t('leadscore.admin.preview.chooseModel')}
              onChange={(value: string) => setModelId(value)}
              optionFilterProp="label"
              showSearch
              options={models.map((model) => ({ value: model.id, label: `${model.name} · v${String(model.modelVersion)} · ${statusLabel(model.status)}` }))}
            />
          </Col>
          <Col xs={24} md={14}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('leadscore.admin.preview.sample')}
            </Typography.Text>
            <Space wrap size={8} align="end">
              <Radio.Group
                value={mode}
                onChange={(event) => setMode(event.target.value as SampleMode)}
                optionType="button"
                size="small"
                options={[
                  { value: 'auto', label: t('leadscore.admin.preview.modeAuto') },
                  { value: 'picked', label: t('leadscore.admin.preview.modePicked') },
                ]}
              />
              {mode === 'auto' ? (
                <>
                  <InputNumber
                    size="small"
                    min={1}
                    max={bound}
                    value={size}
                    onChange={(next) => setSize(Number(next ?? 1))}
                    aria-label={t('leadscore.admin.preview.leads')}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('leadscore.admin.preview.leads')}
                  </Typography.Text>
                </>
              ) : (
                <Select
                  size="small"
                  mode="multiple"
                  style={{ minWidth: 320, maxWidth: 520 }}
                  value={picked}
                  maxTagCount="responsive"
                  placeholder={t('leadscore.admin.preview.pickLeads')}
                  filterOption={false}
                  loading={leads.isLoading}
                  onChange={(next) => setPicked(next.slice(0, bound))}
                  options={(leads.data ?? []).map((lead) => ({ value: String(lead['id']), label: String(lead['name'] ?? lead['id']) }))}
                />
              )}
            </Space>
          </Col>
        </Row>

        <Space wrap size={8}>
          <Button type="primary" loading={preview.isPending} disabled={modelId === ''} onClick={() => preview.mutate()}>
            {t('leadscore.admin.preview.run')}
          </Button>
          {view === undefined ? null : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('leadscore.admin.preview.modelVersion', { name: view.model.name, version: String(view.model.modelVersion) })}
            </Typography.Text>
          )}
        </Space>

        {preview.isError ? <Alert type="error" showIcon message={t('leadscore.admin.preview.failed')} description={errorText(preview.error)} /> : null}

        {view === undefined ? null : (
          <>
            <Alert
              type="success"
              showIcon
              message={t('leadscore.admin.preview.noWrites')}
              description={t('leadscore.admin.preview.noWritesHint')}
            />

            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}>
                <Statistic label={t('leadscore.admin.preview.scored')} value={`${String(view.sample.scored)}/${String(view.sample.selected === 0 ? view.sample.bound : view.sample.selected)}`} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic label={t('leadscore.admin.preview.average')} value={view.distribution.average === null ? '—' : String(Math.round(view.distribution.average * 10) / 10)} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic label={t('leadscore.admin.preview.range')} value={view.distribution.min === null || view.distribution.max === null ? '—' : `${String(view.distribution.min)}–${String(view.distribution.max)}`} />
              </Col>
            </Row>

            {view.signals !== undefined && view.signals.plans.length > 0 ? (
              <Alert
                type={view.signals.state === 'available' ? 'info' : 'warning'}
                showIcon
                message={named(`leadscore.admin.preview.signalState.${view.signals.state}`, t('leadscore.admin.preview.signals', { state: view.signals.state, plans: String(view.signals.plans.length) }))}
                description={view.signals.plans.map((plan) => `${sourceLabel(plan.source)} · ${plan.eventTypes.map((eventType) => named(`leadscore.admin.event.${eventType}`, eventType)).join(', ')} · ${t('leadscore.admin.preview.planWindow', { days: String(plan.lookbackDays) })}`).join('  |  ')}
              />
            ) : null}

            {view.sample.notReadable > 0 ? (
              <Alert type="warning" showIcon message={t('leadscore.admin.preview.notReadable', { count: String(view.sample.notReadable) })} description={t('leadscore.admin.preview.notReadableHint')} />
            ) : null}

            <Typography.Title level={5}>{t('leadscore.admin.preview.distribution')}</Typography.Title>
            <Space direction="vertical" size={4} style={{ width: '100%', maxWidth: 520 }}>
              {Object.entries(view.distribution.bands).map(([band, count]) => (
                <Space key={band} wrap size={8} align="center" style={{ width: '100%' }}>
                  <span className="carocrm-pill" style={{ minWidth: 96 }}>
                    {bandLabel(band)}
                  </span>
                  <Progress
                    percent={view.sample.scored === 0 ? 0 : Math.round((count / view.sample.scored) * 100)}
                    size="small"
                    style={{ flex: 1, minWidth: 160 }}
                    format={() => t('leadscore.admin.preview.bandCount', { count: String(count) })}
                  />
                </Space>
              ))}
            </Space>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('leadscore.admin.preview.results')}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('leadscore.admin.preview.noValuesHint', { fields: view.inputFields.join(', ') })}
            </Typography.Text>
            <Table<LeadScorePreviewResult>
              size="small"
              rowKey="leadId"
              style={{ marginTop: 8 }}
              dataSource={[...view.results]}
              pagination={false}
              columns={columns(navigate)}
            />

            <Space wrap size={8}>
              <Tag color="green">{t('leadscore.admin.preview.writesFalse')}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('leadscore.admin.preview.signatureNote')}
              </Typography.Text>
            </Space>
          </>
        )}
      </Space>
    </Card>
  );
}

function Statistic({ label, value }: { label: string; value: string }) {
  return (
    <div className="carocrm-score-stat">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <div>
        <Typography.Text strong style={{ fontSize: 20 }}>
          {value}
        </Typography.Text>
      </div>
    </div>
  );
}

function columns(navigate: (path: string) => void): ColumnsType<LeadScorePreviewResult> {
  return [
    {
      title: t('leadscore.admin.preview.lead'),
      dataIndex: 'leadId',
      key: 'leadId',
      render: (value: string) => (
        <Typography.Link onClick={() => navigate(`/Lead/${encodeURIComponent(value)}`)}>
          {value.slice(0, 8)}
        </Typography.Link>
      ),
    },
    {
      title: t('leadscore.admin.preview.score'),
      dataIndex: 'scoreValue',
      key: 'scoreValue',
      width: 88,
      render: (value: number | null) => (value === null ? '—' : <Typography.Text strong>{String(value)}</Typography.Text>),
    },
    { title: t('leadscore.admin.preview.band'), dataIndex: 'band', key: 'band', width: 128, render: (value: string) => bandLabel(value) },
    { title: t('leadscore.admin.preview.state'), dataIndex: 'resultState', key: 'resultState', width: 104 },
    {
      title: t('leadscore.admin.preview.coverage'),
      dataIndex: 'coverage',
      key: 'coverage',
      width: 96,
      render: (value: number) => `${String(Math.round(value * 100))}%`,
    },
    {
      title: t('leadscore.admin.preview.reasons'),
      key: 'reasons',
      render: (_, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${row.positiveReasonCodes.length} + / ${row.negativeReasonCodes.length} − / ${row.unknownReasonCodes.length} ?`}
          {row.errorCodes.length === 0 ? '' : ` · ${row.errorCodes.join(', ')}`}
        </Typography.Text>
      ),
    },
    {
      title: t('leadscore.admin.preview.signature'),
      dataIndex: 'signature',
      key: 'signature',
      width: 112,
      render: (value: string) => <Typography.Text code style={{ fontSize: 12 }}>{value.slice(0, 8)}</Typography.Text>,
    },
  ];
}

/** The Leads this caller may read, for a hand-picked sample. A failed lookup leaves the picker empty. */
function useLeads(enabled: boolean) {
  return useQuery({
    queryKey: ['leadScore', 'previewLeads'],
    queryFn: async () => (await api.list('Lead', { maxSize: 50, orderBy: 'createdAt,desc' })).list,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}
