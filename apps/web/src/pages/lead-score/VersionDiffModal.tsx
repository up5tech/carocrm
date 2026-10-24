import { useQuery } from '@tanstack/react-query';
import { Alert, Modal, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { LeadScoreModelRecord, LeadScoreRuleRecord } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { bandLabel, dimensionLabel, effectLabel, statusLabel } from './shared.js';

/**
 * Phase 19-LS.8 — two versions of one model, side by side
 * (`PLAN_Phase_19_LeadScore.md` §5.1, §6.1, §16 `19-LS.8`).
 *
 * Plan §6.1 asks an administrator to be able to answer "what changed between the version every stored score
 * names and the draft I am about to publish". A published version is immutable (LS.2 guard), so a comparison
 * is the only review that can be done *after* the fact, and it is what a rollback decision rests on.
 *
 * Nothing is recomputed here. The rows come from the record API — the same read the list uses, so the record
 * ACL decides what is comparable — and the only judgement made in the browser is string equality per field.
 */

/** The configuration a version actually carries, in the order an operator reads it. */
const CONFIG_FIELDS: readonly { key: keyof LeadScoreModelRecord; labelKey: string; render?: (value: unknown) => string }[] = [
  { key: 'status', labelKey: 'leadscore.admin.model.status', render: (value) => statusLabel(String(value ?? '')) },
  { key: 'scaleMin', labelKey: 'leadscore.admin.model.scaleMin' },
  { key: 'scaleMax', labelKey: 'leadscore.admin.model.scaleMax' },
  { key: 'baseScore', labelKey: 'leadscore.admin.model.baseScore' },
  { key: 'scoreFloor', labelKey: 'leadscore.admin.model.scoreFloor' },
  { key: 'scoreCeiling', labelKey: 'leadscore.admin.model.scoreCeiling' },
  { key: 'qualificationBands', labelKey: 'leadscore.admin.model.bands', render: (value) => bandsText(String(value ?? '')) },
  { key: 'dimensionWeights', labelKey: 'leadscore.admin.model.weights', render: (value) => weightsText(String(value ?? '')) },
  { key: 'allowedFieldPaths', labelKey: 'leadscore.admin.model.allowed' },
  { key: 'blockedFieldPaths', labelKey: 'leadscore.admin.model.blocked' },
  { key: 'effectiveFrom', labelKey: 'leadscore.admin.model.effectiveFrom' },
  { key: 'effectiveTo', labelKey: 'leadscore.admin.model.effectiveTo' },
];

export function VersionDiffModal({
  models,
  open,
  onClose,
}: {
  models: readonly LeadScoreModelRecord[];
  open: boolean;
  onClose: () => void;
}) {
  const sorted = [...models].sort((left, right) => left.modelVersion - right.modelVersion);
  const [leftId, setLeftId] = useState<string>('');
  const [rightId, setRightId] = useState<string>('');

  // The default comparison is the newest version against the one before it: that is the question an
  // administrator opens this to ask, and picking two rows by hand every time would be the answer to it.
  useEffect(() => {
    if (!open) return;
    const byVersion = [...models].sort((left, right) => left.modelVersion - right.modelVersion);
    setRightId(byVersion[byVersion.length - 1]?.id ?? '');
    setLeftId(byVersion.length >= 2 ? (byVersion[byVersion.length - 2]?.id ?? '') : '');
  }, [open, models]);

  const left = sorted.find((entry) => entry.id === leftId);
  const right = sorted.find((entry) => entry.id === rightId);

  const differences = useMemo(() => {
    if (left === undefined || right === undefined) return [];
    return CONFIG_FIELDS.filter((field) => String(left[field.key] ?? '') !== String(right[field.key] ?? '')).map((field) => field.key);
  }, [left, right]);

  const rules = useQuery({
    queryKey: ['leadScore', 'rules', left?.id ?? '', right?.id ?? ''],
    queryFn: async () => {
      if (left === undefined || right === undefined) return {} as Record<string, readonly LeadScoreRuleRecord[]>;
      const entries = await Promise.all(
        [left, right].map(async (model) => {
          const found = await api.list('LeadScoreRule', { where: [{ field: 'modelId', operator: 'equals', value: model.id }], maxSize: 200 });
          return [model.id, ((found.list as unknown) as LeadScoreRuleRecord[])] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, readonly LeadScoreRuleRecord[]>;
    },
    enabled: open && left !== undefined && right !== undefined,
    retry: false,
  });

  const ruleChanges = useMemo(() => {
    if (left === undefined || right === undefined) return [];
    const before = new Map((rules.data?.[left.id] ?? []).map((rule) => [rule.reasonCode, rule]));
    const after = new Map((rules.data?.[right.id] ?? []).map((rule) => [rule.reasonCode, rule]));
    const out: { code: string; kind: 'added' | 'removed' | 'changed'; rule: LeadScoreRuleRecord | undefined }[] = [];
    for (const [code, rule] of after) {
      const previous = before.get(code);
      if (previous === undefined) out.push({ code, kind: 'added', rule });
      else if (ruleSignature(previous) !== ruleSignature(rule)) out.push({ code, kind: 'changed', rule });
    }
    for (const [code, rule] of before) {
      if (!after.has(code)) out.push({ code, kind: 'removed', rule });
    }
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }, [left, right, rules.data]);

  const options = sorted.map((entry) => ({ value: entry.id, label: `v${String(entry.modelVersion)} · ${statusLabel(entry.status)}` }));

  return (
    <Modal open={open} width={860} destroyOnHidden footer={null} title={t('leadscore.admin.diff.title')} onCancel={onClose}>
      {sorted.length < 2 ? (
        <Alert type="info" showIcon message={t('leadscore.admin.diff.needsTwo')} description={t('leadscore.admin.diff.needsTwoHint')} />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space wrap size={12} align="end">
            <LabeledSelect label={t('leadscore.admin.diff.from')} value={left?.id ?? ''} options={options} onChange={setLeftId} exclude={right?.id} />
            <LabeledSelect label={t('leadscore.admin.diff.to')} value={right?.id ?? ''} options={options} onChange={setRightId} exclude={left?.id} />
          </Space>

          {left === undefined || right === undefined ? null : (
            <div className="carocrm-diff">
              <div className="carocrm-diff-side carocrm-diff-side--local">
                <Typography.Text strong>{`${left.name} · v${String(left.modelVersion)}`}</Typography.Text>
                {CONFIG_FIELDS.map((field) => (
                  <div key={String(field.key)} className={`carocrm-diff-field${differences.includes(field.key) ? ' carocrm-diff-field--changed' : ''}`}>
                    <span>{t(field.labelKey)}</span>
                    <span className="carocrm-diff-value">{textOf(left, field)}</span>
                  </div>
                ))}
              </div>
              <div className="carocrm-diff-side carocrm-diff-side--remote">
                <Typography.Text strong>{`${right.name} · v${String(right.modelVersion)}`}</Typography.Text>
                {CONFIG_FIELDS.map((field) => (
                  <div key={String(field.key)} className={`carocrm-diff-field${differences.includes(field.key) ? ' carocrm-diff-field--changed' : ''}`}>
                    <span>{t(field.labelKey)}</span>
                    <span className="carocrm-diff-value">{textOf(right, field)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <Typography.Title level={5}>{t('leadscore.admin.diff.rules')}</Typography.Title>
            {left === undefined || right === undefined ? null : rules.isLoading ? (
              <Typography.Text type="secondary">{t('leadscore.admin.diff.rulesLoading')}</Typography.Text>
            ) : ruleChanges.length === 0 ? (
              <Typography.Text type="secondary">{t('leadscore.admin.diff.rulesSame')}</Typography.Text>
            ) : (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {ruleChanges.map((change) => (
                  <Space key={`${change.kind}-${change.code}`} wrap size={8} align="baseline">
                    <Tag color={change.kind === 'added' ? 'green' : change.kind === 'removed' ? 'red' : 'orange'}>
                      {t(`leadscore.admin.diff.${change.kind}`)}
                    </Tag>
                    <Typography.Text code>{change.code}</Typography.Text>
                    <Typography.Text>{change.rule?.name}</Typography.Text>
                    {change.rule === undefined ? null : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {`${dimensionLabel(change.rule.dimension)} · ${effectLabel(change.rule.effect)} ${String(change.rule.points)} · P${String(change.rule.priority)}`}
                      </Typography.Text>
                    )}
                  </Space>
                ))}
              </Space>
            )}
          </div>
        </Space>
      )}
    </Modal>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  exclude,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  exclude: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <Select
        size="small"
        style={{ minWidth: 180 }}
        value={value === '' ? null : value}
        onChange={onChange}
        options={options.map((option) => ({ ...option, disabled: option.value === exclude }))}
      />
    </Space>
  );
}

function textOf(model: LeadScoreModelRecord, field: (typeof CONFIG_FIELDS)[number]): string {
  const value = model[field.key];
  if (field.render !== undefined) return field.render(value);
  if (value === undefined || value === null || value === '') return t('leadscore.admin.none');
  return String(value);
}

/** A band list the way an operator wrote it, so a changed threshold is readable without opening JSON. */
function bandsText(raw: string): string {
  if (raw === '') return t('leadscore.admin.none');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    return parsed
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        return `${bandLabel(String(record['band'] ?? ''))} ${String(record['min'] ?? '')}–${String(record['max'] ?? '')}`;
      })
      .join(', ');
  } catch {
    return raw;
  }
}

function weightsText(raw: string): string {
  if (raw === '') return t('leadscore.admin.none');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return raw;
    const entries = Object.entries(parsed as Record<string, unknown>);
    return entries.length === 0 ? t('leadscore.admin.none') : entries.map(([dimension, weight]) => `${dimensionLabel(dimension)}: ${String(weight)}`).join(', ');
  } catch {
    return raw;
  }
}

/** What makes two rules of one reason code different: everything the score reads, and nothing else. */
function ruleSignature(rule: LeadScoreRuleRecord): string {
  return [rule.name, rule.enabled ? '1' : '0', rule.dimension, rule.effect, String(rule.points), String(rule.priority), rule.missingDataPolicy, rule.signalSource, rule.condition, rule.targetBand ?? '', rule.decayPolicy ?? '', String(rule.decayHalfLifeDays ?? ''), String(rule.lookbackDays ?? '')].join('|');
}
