import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, InputNumber, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { type ReactNode, useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { LeadScoreHealthView, LeadScoreModelRecord, LeadScoreSettingsView } from '../../api/types.js';
import { formatDateTime, t } from '../../state/i18n.js';
import { named } from './shared.js';

/**
 * Phase 19-LS.8 — the module's control plane
 * (`PLAN_Phase_19_LeadScore.md` §2.2, §9.3, §12, §16 `19-LS.8`).
 *
 * Everything on this screen is the settings document the gate reads, and it is written through the same
 * endpoint the CLI would: there is no second place a switch lives. Two rules shape the form:
 *
 *  - the feature list, its requirements and its pending phase come from `action/health`, so a feature this
 *    build does not implement is *labelled* rather than offered as a switch that would only fail later;
 *  - the active model picker offers published versions, because that is the only kind of row the scorer will
 *    accept — and the server still answers `LEADSCORE_NO_ACTIVE_MODEL` if the row stops being usable, which
 *    is why the health view's own `state` is shown next to the selection.
 *
 * A disabled module is not a broken one: plan §2.2 asks for a kill switch, so the master switch is the first
 * control and its consequence is stated in the same place.
 */

export function SettingsTab({
  settings,
  health,
  models,
  canWrite,
}: {
  settings: LeadScoreSettingsView | undefined;
  health: LeadScoreHealthView | undefined;
  models: readonly LeadScoreModelRecord[];
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [debounce, setDebounce] = useState(60);
  const [sweep, setSweep] = useState({ enabled: false, limit: 200, chunkSize: 25 });

  useEffect(() => {
    if (settings === undefined) return;
    setEnabled(settings.settings.enabled === true);
    setFeatures({ ...settings.settings.features });
    setActiveModelId(settings.settings.scoring.activeModelId);
    setDebounce(settings.settings.scoring.debounceSeconds);
    setSweep(settings.settings.signals?.decaySweep ?? sweep);
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      api.leadScoreSaveSettings({
        enabled,
        // Only what changed: the server deep-merges the patch, so an untouched key keeps its stored value.
        features: changedFeatures(),
        scoring: { activeModelId, debounceSeconds: debounce },
        signals: { decaySweep: sweep },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leadScore'] }),
    onError: () => undefined,
  });

  function changedFeatures(): Record<string, boolean> {
    const current = settings?.settings.features ?? {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(features)) {
      if (current[key] !== value) out[key] = value;
    }
    return out;
  }

  const storedSweep = settings?.settings.signals?.decaySweep;
  const dirty =
    enabled !== (settings?.settings.enabled === true) ||
    Object.keys(changedFeatures()).length > 0 ||
    activeModelId !== (settings?.settings.scoring.activeModelId ?? null) ||
    debounce !== (settings?.settings.scoring.debounceSeconds ?? 60) ||
    sweep.enabled !== (storedSweep?.enabled ?? false) ||
    sweep.limit !== (storedSweep?.limit ?? 200) ||
    sweep.chunkSize !== (storedSweep?.chunkSize ?? 25);

  if (settings === undefined) return <Card title={t('leadscore.admin.settings.title')}><Alert type="warning" showIcon message={t('leadscore.admin.settings.notAvailable')} /></Card>;

  const rows = (health?.features ?? []).map((feature) => ({ ...feature, switchValue: features[feature.key] === true }));

  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: t('leadscore.admin.settings.feature'), dataIndex: 'label', key: 'label', render: (value: string, row) => (
      <Space size={6}>
        <Typography.Text>{value}</Typography.Text>
        {row.pendingPhase !== null ? <Tag>{t('leadscore.admin.settings.pending', { phase: row.pendingPhase })}</Tag> : null}
      </Space>
    ) },
    {
      title: t('leadscore.admin.settings.requires'),
      key: 'requires',
      width: 220,
      render: (_, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.requires.length === 0 ? t('leadscore.admin.none') : row.requires.map((key) => named(`leadscore.feature.${key}`, key)).join(', ')}
        </Typography.Text>
      ),
    },
    {
      title: t('leadscore.admin.settings.state'),
      key: 'state',
      width: 132,
      render: (_, row) => (
        <Tag color={row.effective ? 'green' : row.enabled ? 'orange' : 'default'}>
          {row.effective ? t('leadscore.admin.settings.effective') : row.enabled ? t('leadscore.admin.settings.waiting') : t('leadscore.admin.settings.off')}
        </Tag>
      ),
    },
    {
      title: t('leadscore.admin.settings.switch'),
      key: 'switch',
      width: 88,
      render: (_, row) => (
        <Tooltip title={row.implemented ? undefined : t('leadscore.admin.settings.notImplemented', { phase: String(row.pendingPhase ?? '') })}>
          <Switch
            size="small"
            checked={row.switchValue}
            disabled={!canWrite || !row.implemented}
            aria-label={row.label}
            onChange={(next) => setFeatures({ ...features, [row.key]: next })}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <Card title={t('leadscore.admin.settings.title')} extra={
      <Space size={8}>
        {save.isError ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{t('leadscore.admin.settings.saveFailed')}</Typography.Text> : null}
        <Button type="primary" disabled={!canWrite || !dirty} loading={save.isPending} onClick={() => save.mutate()}>
          {t('leadscore.admin.settings.save')}
        </Button>
      </Space>
    }>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={16} align="center">
          <Space size={8} align="center">
            <Switch size="small" checked={enabled} disabled={!canWrite} aria-label={t('leadscore.admin.settings.module')} onChange={setEnabled} />
            <Typography.Text strong>{t('leadscore.admin.settings.module')}</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('leadscore.admin.settings.moduleHint')}
          </Typography.Text>
        </Space>

        {settings.warnings.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t('leadscore.admin.settings.warnings')}
            description={
              <Space direction="vertical" size={2}>
                {settings.warnings.map((warning) => (
                  <Typography.Text key={warning.code} style={{ fontSize: 12 }}>
                    <Typography.Text code>{warning.code}</Typography.Text> — {warning.message}
                  </Typography.Text>
                ))}
              </Space>
            }
          />
        ) : null}

        <Row2
          label={t('leadscore.admin.settings.activeModel')}
          hint={t('leadscore.admin.settings.activeModelHint')}
          control={
            <Select
              style={{ minWidth: 320 }}
              allowClear
              showSearch
              optionFilterProp="label"
              value={activeModelId ?? undefined}
              placeholder={t('leadscore.admin.settings.noActiveModel')}
              disabled={!canWrite}
              onChange={(next) => setActiveModelId(next === undefined ? null : next)}
              options={models
                .filter((model) => model.status === 'published')
                .map((model) => ({ value: model.id, label: `${model.name} · v${String(model.modelVersion)}` }))}
            />
          }
        />

        <Row2
          label={t('leadscore.admin.settings.debounce')}
          hint={`${t('leadscore.admin.settings.debounceHint')} (${t('leadscore.admin.settings.seconds')})`}
          control={<InputNumber min={0} max={900} value={debounce} disabled={!canWrite} precision={0} style={{ width: 148 }} aria-label={t('leadscore.admin.settings.debounce')} onChange={(next) => setDebounce(Number(next ?? 0))} />}
        />

        <Row2
          label={t('leadscore.admin.settings.sweep')}
          hint={t('leadscore.admin.settings.sweepHint')}
          control={
            <Space wrap size={12} align="center">
              <Space size={6} align="center">
                <Switch size="small" checked={sweep.enabled} disabled={!canWrite} aria-label={t('leadscore.admin.settings.sweep')} onChange={(next) => setSweep({ ...sweep, enabled: next })} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {health === undefined || health.signals.eventTablePresent ? t('leadscore.admin.settings.sweepTablePresent') : t('leadscore.admin.settings.sweepTableAbsent')}
                </Typography.Text>
              </Space>
              <LabeledNumber label={t('leadscore.admin.settings.sweepLimit')} value={sweep.limit} min={1} max={2000} disabled={!canWrite} onChange={(limit) => setSweep({ ...sweep, limit })} />
              <LabeledNumber label={t('leadscore.admin.settings.sweepChunk')} value={sweep.chunkSize} min={1} max={50} disabled={!canWrite} onChange={(chunkSize) => setSweep({ ...sweep, chunkSize })} />
            </Space>
          }
        />

        <div>
          <Typography.Title level={5}>{t('leadscore.admin.settings.features')}</Typography.Title>
          <Table size="small" rowKey="key" dataSource={rows} columns={columns} pagination={false} />
        </div>

        {health === undefined ? null : (
          <Alert
            type={health.ready ? 'success' : 'info'}
            showIcon
            message={health.ready ? t('leadscore.admin.settings.ready') : t('leadscore.admin.settings.notReady')}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text style={{ fontSize: 12 }}>{health.reason}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t('leadscore.admin.settings.lastChanged')}: ${String(settings.updatedBy ?? '—')} · ${settings.updatedAt === null ? t('leadscore.admin.none') : formatDateTime(settings.updatedAt)} · v${String(settings.version)}`}
                </Typography.Text>
              </Space>
            }
          />
        )}

        {canWrite ? null : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('leadscore.admin.settings.needRight')}</Typography.Text>}
      </Space>
    </Card>
  );
}

/** A bounded number with its range named, so an out-of-range value is not a surprise save error. */
function LabeledNumber({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {`${label} (${String(min)}–${String(max)})`}
      </Typography.Text>
      <InputNumber size="small" min={min} max={max} value={value} disabled={disabled} precision={0} style={{ width: 132 }} aria-label={label} onChange={(next) => onChange(Number(next ?? min))} />
    </Space>
  );
}

function Row2({ label, hint, control }: { label: string; hint: string; control: ReactNode }) {
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Space size={8} align="center" wrap>
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      </Space>
      {control}
    </Space>
  );
}
