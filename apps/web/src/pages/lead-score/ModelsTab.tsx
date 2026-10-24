import { ExperimentOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { LeadScoreEditorCatalog, LeadScoreModelRecord, LeadScoreRuleRecord, LeadScoreValidationReport } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { formatDateTime, t } from '../../state/i18n.js';
import { ModelEditorModal } from './ModelEditorModal.js';
import { RuleEditorModal } from './RuleEditorModal.js';
import {
  bandLabel,
  conditionSummary,
  dimensionLabel,
  effectLabel,
  errorText,
  parseJsonArray,
  parseJsonObject,
  statusLabel,
  ValidationReportPanel,
} from './shared.js';
import { VersionDiffModal } from './VersionDiffModal.js';

/**
 * Phase 19-LS.8 — the model list and the lifecycle of one version
 * (`PLAN_Phase_19_LeadScore.md` §5.1, §6.1, §9.3, §16 `19-LS.8`; audit §11).
 *
 * The split between this screen and the API is the one the module was built on:
 *
 *  - a **draft** is an ordinary administration record, so it is created and edited through the generic entity
 *    API — the same path the LS.2 write guard watches, which is what makes a published version immutable
 *    without this page having to believe anybody;
 *  - a **lifecycle transition** is a command: `validate`, `publish`, `archive`, `new-version`. Publishing is
 *    the only thing that freezes a version, and the command re-validates rather than trusting what the
 *    browser said a minute ago, so this button asks for that answer first and shows it before the confirm.
 *
 * Nothing on the screen decides what a legal model is: the field list, the operators, the band vocabulary and
 * the budgets all come from `GET action/editor`, and the verdict comes from `POST action/model/validate`.
 */

export function ModelsTab({
  granted,
  catalog,
  activeModelId,
  onPreview,
}: {
  granted: ReadonlySet<string>;
  catalog: LeadScoreEditorCatalog | undefined;
  activeModelId: string | null;
  onPreview: (modelId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [modelForm, setModelForm] = useState<{ open: boolean; model: LeadScoreModelRecord | undefined }>({ open: false, model: undefined });
  const [report, setReport] = useState<LeadScoreValidationReport | undefined>();
  const queryClient = useQueryClient();

  const canManage = granted.has('modelManage');
  const canPublish = granted.has('modelPublish');

  const models = useQuery({
    queryKey: ['leadScore', 'models'],
    queryFn: async () => ((await api.list('LeadScoreModel', { maxSize: 200, orderBy: 'name,asc' })).list as unknown) as LeadScoreModelRecord[],
    staleTime: 15_000,
    retry: false,
  });

  function reload(): void {
    setReport(undefined);
    void queryClient.invalidateQueries({ queryKey: ['leadScore'] });
  }

  const validate = useMutation({
    mutationFn: (modelId: string) => api.leadScoreValidateModel(modelId),
    onSuccess: (answer) => setReport(answer),
    onError: (error) => Modal.error({ title: t('leadscore.admin.model.validateFailed'), content: errorText(error) }),
  });

  const publish = useMutation({
    mutationFn: (model: LeadScoreModelRecord) => api.leadScorePublishModel(model.id, revisionOf(model)),
    onSuccess: () => reload(),
    onError: (error) => Modal.error({ title: t('leadscore.admin.publish.failed'), content: errorText(error) }),
  });

  const archive = useMutation({
    mutationFn: (model: LeadScoreModelRecord) => api.leadScoreArchiveModel(model.id, revisionOf(model)),
    onSuccess: () => reload(),
    onError: (error) => Modal.error({ title: t('leadscore.admin.model.archiveFailed'), content: errorText(error) }),
  });

  const newVersion = useMutation({
    mutationFn: (modelId: string) => api.leadScoreNewVersion(modelId),
    onSuccess: () => reload(),
    onError: (error) => Modal.error({ title: t('leadscore.admin.model.newVersionFailed'), content: errorText(error) }),
  });

  /**
   * Publish, but only after the server has said the draft is publishable.
   *
   * The confirmation carries the counts because that is the decision being made: the command re-validates
   * anyway, so this pass exists to show the answer *before* the version is frozen, not to grant permission.
   */
  function askToPublish(model: LeadScoreModelRecord): void {
    void validate.mutateAsync(model.id).then((answer) => {
      if (answer === undefined) return;
      if (!answer.valid) {
        Modal.warning({ title: t('leadscore.admin.publish.blocked'), content: t('leadscore.admin.publish.blockedHint', { count: String(answer.errors.length) }) });
        return;
      }
      Modal.confirm({
        title: t('leadscore.admin.publish.confirm', { name: model.name, version: String(model.modelVersion) }),
        content: (
          <Space direction="vertical" size={6}>
            <Typography.Text>{t('leadscore.admin.publish.immutable')}</Typography.Text>
            {answer.warnings.length === 0 ? null : <Typography.Text type="warning">{t('leadscore.admin.publish.warningCount', { count: String(answer.warnings.length) })}</Typography.Text>}
          </Space>
        ),
        okText: t('leadscore.admin.publish.ok'),
        cancelText: t('core.common.cancel'),
        onOk: () => publish.mutateAsync(model),
      });
    });
  }

  const selected = models.data?.find((entry) => entry.id === selectedId);

  const columns: ColumnsType<LeadScoreModelRecord> = [
    { title: t('web.common.name'), dataIndex: 'name', key: 'name', render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { title: t('leadscore.admin.model.version'), dataIndex: 'modelVersion', key: 'modelVersion', width: 76, render: (value: number) => `v${String(value)}` },
    {
      title: t('leadscore.admin.model.status'),
      dataIndex: 'status',
      key: 'status',
      width: 116,
      render: (value: string) => <span className={`carocrm-pill carocrm-pill--${statusPill(value)}`}>{statusLabel(value)}</span>,
    },
    { title: t('leadscore.admin.model.scale'), key: 'scale', width: 112, render: (_, row) => `${String(row.scaleMin)}–${String(row.scaleMax)}` },
    {
      title: t('leadscore.admin.model.active'),
      key: 'active',
      width: 104,
      render: (_, row) => (activeModelId !== null && row.id === activeModelId ? <Tag color="green">{t('leadscore.admin.model.activeTag')}</Tag> : null),
    },
    { title: t('leadscore.admin.modifiedAt'), dataIndex: 'modifiedAt', key: 'modifiedAt', width: 176, render: (value: unknown) => <Typography.Text type="secondary">{formatDateTime(typeof value === 'string' ? value : undefined)}</Typography.Text> },
  ];

  return (
    <Card
      title={t('leadscore.admin.models.title')}
      extra={
        <Space wrap size={8}>
          {canManage ? (
            <Button type="primary" onClick={() => setModelForm({ open: true, model: undefined })}>
              {t('leadscore.admin.models.newModel')}
            </Button>
          ) : null}
          <Button onClick={reload}>{t('core.common.reload')}</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('leadscore.admin.models.subtitle')}
      </Typography.Paragraph>

      {models.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : models.isError ? (
        <Alert type="error" showIcon message={t('leadscore.admin.models.loadFailed')} description={errorText(models.error)} />
      ) : (models.data?.length ?? 0) === 0 ? (
        <EmptyState description={canManage ? t('leadscore.admin.models.emptyCreate') : t('leadscore.admin.models.empty')} />
      ) : (
        <Table
          size="small"
          rowKey="id"
          dataSource={[...(models.data ?? [])]}
          columns={columns}
          pagination={false}
          onRow={(row) => ({
            onClick: () => {
              setSelectedId(row.id === selectedId ? '' : row.id);
              setReport(undefined);
            },
          })}
          rowClassName={(row) => (row.id === selectedId ? 'carocrm-row-selected' : '')}
        />
      )}

      {selected === undefined ? null : (
        <SelectedModel
          model={selected}
          catalog={catalog}
          granted={granted}
          canManage={canManage}
          canPublish={canPublish}
          busy={validate.isPending || publish.isPending || archive.isPending || newVersion.isPending}
          report={report}
          siblings={(models.data ?? []).filter((entry) => entry.name === selected.name)}
          onChanged={reload}
          onPreview={() => onPreview(selected.id)}
          onEdit={() => setModelForm({ open: true, model: selected })}
          onValidate={() => validate.mutate(selected.id)}
          onPublish={() => askToPublish(selected)}
          onArchive={() => archive.mutate(selected)}
          onNewVersion={() => newVersion.mutate(selected.id)}
        />
      )}

      <ModelEditorModal
        model={modelForm.model}
        catalog={catalog}
        open={modelForm.open}
        onClose={() => setModelForm({ open: false, model: undefined })}
        onSaved={(id) => {
          reload();
          if (id !== undefined && id !== '') setSelectedId(id);
        }}
      />
    </Card>
  );
}

/** The pill tone of a model state, using the design system's four soft tones. */
function statusPill(status: string): string {
  if (status === 'published') return 'green';
  if (status === 'archived') return 'grey';
  return 'amber';
}

/** The record's optimistic-concurrency revision, when the list carried one. */
function revisionOf(model: LeadScoreModelRecord): number | undefined {
  const value = model['version'];
  return typeof value === 'number' ? value : undefined;
}

function SelectedModel({
  model,
  catalog,
  granted,
  canManage,
  canPublish,
  busy,
  report,
  siblings,
  onChanged,
  onPreview,
  onEdit,
  onValidate,
  onPublish,
  onArchive,
  onNewVersion,
}: {
  model: LeadScoreModelRecord;
  catalog: LeadScoreEditorCatalog | undefined;
  granted: ReadonlySet<string>;
  canManage: boolean;
  canPublish: boolean;
  busy: boolean;
  report: LeadScoreValidationReport | undefined;
  siblings: readonly LeadScoreModelRecord[];
  onChanged: () => void;
  onPreview: () => void;
  onEdit: () => void;
  onValidate: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onNewVersion: () => void;
}) {
  const [ruleForm, setRuleForm] = useState<{ open: boolean; rule: LeadScoreRuleRecord | undefined }>({ open: false, rule: undefined });
  const [diff, setDiff] = useState(false);
  const isDraft = model.status === 'draft';
  const editable = canManage && isDraft;

  const rules = useQuery({
    queryKey: ['leadScore', 'rules', model.id],
    queryFn: async () => ((await api.list('LeadScoreRule', { where: [{ field: 'modelId', operator: 'equals', value: model.id }], maxSize: 200, orderBy: 'priority,asc' })).list as unknown) as LeadScoreRuleRecord[],
    staleTime: 10_000,
    retry: false,
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => api.update('LeadScoreRule', input.id, { enabled: input.enabled }),
    onSuccess: onChanged,
    onError: (error) => Modal.error({ title: t('leadscore.admin.rule.toggleFailed'), content: errorText(error) }),
  });

  const removeRule = useMutation({
    mutationFn: (id: string) => api.remove('LeadScoreRule', id),
    onSuccess: onChanged,
    onError: (error) => Modal.error({ title: t('leadscore.admin.rule.deleteFailed'), content: errorText(error) }),
  });

  const ruleColumns: ColumnsType<LeadScoreRuleRecord> = [
    { title: t('leadscore.admin.rule.priority'), dataIndex: 'priority', key: 'priority', width: 72 },
    { title: t('web.common.name'), dataIndex: 'name', key: 'name', render: (value: string, row) => (row.enabled ? value : <Typography.Text type="secondary">{value}</Typography.Text>) },
    { title: t('leadscore.admin.rule.reasonCode'), dataIndex: 'reasonCode', key: 'reasonCode', width: 176, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
    { title: t('leadscore.admin.rule.dimension'), dataIndex: 'dimension', key: 'dimension', width: 124, render: (value: string) => dimensionLabel(value) },
    {
      title: t('leadscore.admin.rule.effect'),
      key: 'effect',
      width: 144,
      render: (_, row) => (row.effect === 'setBand' ? `${effectLabel(row.effect)} · ${bandLabel(String(row.targetBand ?? ''))}` : `${effectLabel(row.effect)} ${String(row.points)}`),
    },
    {
      title: t('leadscore.admin.rule.conditionTitle'),
      dataIndex: 'condition',
      key: 'condition',
      render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{conditionSummary(value, catalog)}</Typography.Text>,
    },
    {
      title: t('leadscore.admin.rule.enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 68,
      render: (value: boolean, row) => <Switch size="small" checked={value} disabled={!editable} loading={toggle.isPending} aria-label={t('leadscore.admin.rule.enabled')} onChange={(next) => toggle.mutate({ id: row.id, enabled: next })} />,
    },
    {
      title: '',
      key: 'actions',
      width: editable ? 144 : 0,
      render: (_, row) =>
        editable ? (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => setRuleForm({ open: true, rule: row })}>
              {t('web.common.edit')}
            </Button>
            <Popconfirm
              title={t('leadscore.admin.rule.deleteConfirm', { name: row.name })}
              okText={t('web.common.delete')}
              cancelText={t('core.common.cancel')}
              onConfirm={() => removeRule.mutate(row.id)}
            >
              <Button size="small" type="link" danger>
                {t('web.common.delete')}
              </Button>
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <Card
      className="carocrm-model-detail"
      style={{ marginTop: 16 }}
      title={`${model.name} · v${String(model.modelVersion)} · ${statusLabel(model.status)}`}
      extra={
        <Space wrap size={8}>
          {editable ? (
            <Button size="small" onClick={onEdit}>
              {t('leadscore.admin.model.edit')}
            </Button>
          ) : null}
          <Button size="small" loading={busy} onClick={onValidate}>
            {t('leadscore.admin.model.validate')}
          </Button>
          {canPublish && isDraft ? (
            <Button size="small" type="primary" loading={busy} onClick={onPublish}>
              {t('leadscore.admin.model.publish')}
            </Button>
          ) : null}
          {!isDraft && canManage ? (
            <Button size="small" loading={busy} onClick={onNewVersion}>
              {t('leadscore.admin.model.newVersion')}
            </Button>
          ) : null}
          {granted.has('modelPublish') && model.status !== 'archived' ? (
            <Popconfirm
              title={t('leadscore.admin.model.archiveConfirm', { name: model.name, version: String(model.modelVersion) })}
              description={t('leadscore.admin.model.archiveHint')}
              okText={t('leadscore.admin.model.archive')}
              cancelText={t('core.common.cancel')}
              onConfirm={onArchive}
            >
              <Button size="small" danger loading={busy}>
                {t('leadscore.admin.model.archive')}
              </Button>
            </Popconfirm>
          ) : null}
          {granted.has('viewScore') ? (
            <Button size="small" icon={<ExperimentOutlined />} onClick={onPreview}>
              {t('leadscore.admin.model.preview')}
            </Button>
          ) : null}
          {siblings.length >= 2 ? (
            <Button size="small" onClick={() => setDiff(true)}>
              {t('leadscore.admin.model.compare')}
            </Button>
          ) : null}
        </Space>
      }
    >
      <Descriptions size="small" column={{ xs: 1, sm: 2, xl: 3 }} style={{ marginBottom: 8 }}>
        <Descriptions.Item label={t('leadscore.admin.model.scale')}>{`${String(model.scaleMin)}–${String(model.scaleMax)}`}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.baseScore')}>{String(model.baseScore)}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.bounds')}>{`${String(model.scoreFloor)}–${String(model.scoreCeiling)}`}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.bands')}>{bandsText(model.qualificationBands)}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.weights')}>{weightsText(model.dimensionWeights)}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.allowed')}>{pathText(model.allowedFieldPaths, catalog, t('leadscore.admin.model.grantAll'))}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.blocked')}>{pathText(model.blockedFieldPaths, catalog, t('leadscore.admin.none'))}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.publishedAt')}>{timeText(model.publishedAt)}</Descriptions.Item>
        <Descriptions.Item label={t('leadscore.admin.model.effectiveFrom')}>{`${timeText(model.effectiveFrom)} → ${timeText(model.effectiveTo)}`}</Descriptions.Item>
      </Descriptions>

      {isDraft ? null : <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('leadscore.admin.model.frozen')} description={t('leadscore.admin.model.frozenHint')} />}

      {report === undefined ? null : <div style={{ marginBottom: 12 }}><ValidationReportPanel report={report} /></div>}

      <Space wrap size={8} style={{ width: '100%', justifyContent: 'space-between', marginTop: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('leadscore.admin.rules.title', { count: String(rules.data?.length ?? 0) })}
        </Typography.Title>
        {editable ? (
          <Button size="small" type="primary" onClick={() => setRuleForm({ open: true, rule: undefined })} disabled={(rules.data?.length ?? 0) >= (catalog?.limits.maxRulesPerModel ?? 200)}>
            {t('leadscore.admin.rules.add')}
          </Button>
        ) : null}
      </Space>

      <Table
        size="small"
        rowKey="id"
        style={{ marginTop: 8 }}
        loading={rules.isLoading}
        dataSource={[...(rules.data ?? [])]}
        columns={ruleColumns}
        pagination={false}
        locale={{ emptyText: t('leadscore.admin.rules.empty') }}
      />

      <RuleEditorModal modelId={model.id} modelVersion={model.modelVersion} rule={ruleForm.rule} catalog={catalog} open={ruleForm.open} onClose={() => setRuleForm({ open: false, rule: undefined })} onSaved={onChanged} />

      {diff ? <VersionDiffModal models={siblings} open={diff} onClose={() => setDiff(false)} /> : null}
    </Card>
  );
}

function bandsText(raw: string | undefined): string {
  const rows = parseJsonObject<{ band?: string; min?: number; max?: number }[]>(raw, []);
  if (!Array.isArray(rows) || rows.length === 0) return t('leadscore.admin.none');
  return rows.map((row) => `${bandLabel(String(row.band ?? ''))} ${String(row.min ?? '')}–${String(row.max ?? '')}`).join(', ');
}

function weightsText(raw: string | undefined): string {
  const entries = Object.entries(parseJsonObject<Record<string, number>>(raw, {}));
  if (entries.length === 0) return t('leadscore.admin.none');
  return entries.map(([dimension, weight]) => `${dimensionLabel(dimension)}: ${String(weight)}`).join(', ');
}

/** A timestamp in the reader's own format, or the word for "not yet". */
function timeText(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? t('leadscore.admin.none') : formatDateTime(value);
}

/** A field grant as field labels, because `companyName` alone means nothing at a glance. */
function pathText(raw: string | undefined, catalog: LeadScoreEditorCatalog | undefined, whenEmpty: string): string {
  const paths = parseJsonArray(raw);
  if (paths.length === 0) return whenEmpty;
  return paths.map((path) => catalog?.fields.find((field) => field.name === path)?.label ?? path).join(', ');
}
