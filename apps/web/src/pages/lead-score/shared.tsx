import { useQuery } from '@tanstack/react-query';
import { Alert, Button, List, Space, Tag, Typography } from 'antd';

import { api, ApiError } from '../../api/client.js';
import type { LeadScoreEditorCatalog, LeadScoreEditorField, LeadScoreValidationIssue, LeadScoreValidationReport } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-LS.8 — the shared vocabulary of the model editor
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §12, §16 `19-LS.8`).
 *
 * One rule runs through this file: **the SPA never decides what a legal rule is.** The field list, the
 * operators a type can answer, the value control and the condition's structural limits all come from
 * `GET /LeadScore/action/editor`, and the verdict on a draft comes from `POST …/model/validate`. What lives
 * here is naming and presentation — a label for a stable code, a pill for a status — plus the two helpers
 * every Phase 19 page needs (an error sentence the operator can act on, and a report list).
 */

/** The editor catalog, fetched once per model (or once, unannotated) and shared by every tab. */
export function useEditorCatalog(modelId?: string) {
  return useQuery({
    queryKey: ['leadScore', 'editor', modelId ?? ''],
    queryFn: () => api.leadScoreEditor(modelId),
    staleTime: 60_000,
    retry: false,
  });
}

/** A label that may legitimately be a code the module has never named (a custom band, a future operator). */
export function named(key: string, fallback: string): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

export function operatorLabel(operator: string): string {
  return named(`leadscore.operator.${operator}`, operator);
}

export function dimensionLabel(dimension: string): string {
  return named(`leadscore.score.dimension.${dimension}`, dimension);
}

export function effectLabel(effect: string): string {
  return named(`leadscore.admin.effect.${effect}`, effect);
}

export function policyLabel(policy: string): string {
  return named(`leadscore.admin.policy.${policy}`, policy);
}

export function sourceLabel(source: string): string {
  return named(`leadscore.admin.source.${source}`, source);
}

export function statusLabel(status: string): string {
  return named(`leadscore.admin.status.${status}`, status);
}

export function bandLabel(band: string): string {
  return named(`leadscore.band.${band.toLowerCase().replace(/\s+/g, '_')}`, band);
}

/**
 * The sentence to show for a failed call.
 *
 * The platform's localized `message` is a category ("Validation failed."), and the explanation travels in
 * `details` — so a refusal without its reason is not actionable. The same reading the marketing lifecycle
 * panel uses, for the same reason.
 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details ?? {};
    for (const key of ['message', 'reason', 'state', 'feature']) {
      const value = details[key];
      if (typeof value === 'string' && value.trim() !== '') return `${error.message}: ${value}`;
    }
    const issues = details['issues'];
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as Record<string, unknown>;
      const message = typeof first['message'] === 'string' ? first['message'] : String(first['code'] ?? '');
      return message === '' ? error.message : `${error.message}: ${message}`;
    }
    return error.code.startsWith('LEADSCORE_') ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The validator's answer, rendered as it arrives.
 *
 * `path` names the model field or the rule (`rules[3].condition`), `code` is the stable identifier, and the
 * message is the server's. Nothing here re-checks the model: an empty error list means the server said the
 * draft is publishable, and that is the only claim the panel makes.
 */
export function ValidationReportPanel({ report, onLocate }: { report: LeadScoreValidationReport | undefined; onLocate?: (ruleId: string) => void }) {
  if (report === undefined) return null;
  const issues = [...report.errors, ...report.warnings];
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type={report.valid ? 'success' : 'error'}
        showIcon
        message={report.valid ? t('leadscore.admin.validationPassed') : t('leadscore.admin.validationFailed')}
        description={
          report.valid
            ? t('leadscore.admin.validationPassedHint')
            : t('leadscore.admin.validationFailedHint', { errors: String(report.errors.length), warnings: String(report.warnings.length) })
        }
      />
      {issues.length === 0 ? null : (
        <List
          size="small"
          dataSource={issues}
          renderItem={(issue: LeadScoreValidationIssue) => (
            <List.Item>
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                <Space wrap size={6}>
                  <Tag color={issue.level === 'error' ? 'red' : 'orange'}>{issue.level === 'error' ? t('leadscore.admin.error') : t('leadscore.admin.warning')}</Tag>
                  <Typography.Text code>{issue.code}</Typography.Text>
                  <Typography.Text type="secondary">{issue.path}</Typography.Text>
                  {issue.ruleId !== undefined && onLocate !== undefined ? (
                    <Button size="small" type="link" onClick={() => onLocate(issue.ruleId as string)}>
                      {t('leadscore.admin.showRule')}
                    </Button>
                  ) : null}
                </Space>
                <Typography.Text>{issue.message}</Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Space>
  );
}

/** The fields a rule may actually read: scorable, and inside the model's grant when it named one. */
export function selectableFields(catalog: LeadScoreEditorCatalog | undefined): LeadScoreEditorField[] {
  if (catalog === undefined) return [];
  return catalog.fields.filter((field) => field.scorable && (catalog.model === undefined || field.inModelAllowlist !== false));
}

/**
 * A stored condition as one readable line.
 *
 * The tree is the module's own (LS.2), and the builder is the only way it is authored; this is what a *list*
 * shows, so an operator can compare two rules without opening either. A condition the reader cannot name is
 * rendered with its raw parts rather than dropped — a silently blank rule column is worse than an ugly one.
 */
export function conditionSummary(raw: string | undefined | null, catalog: LeadScoreEditorCatalog | undefined): string {
  if (raw === undefined || raw === null || raw.trim() === '') return t('leadscore.admin.rule.noCondition');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const text = summarizeNode(parsed, catalog, 0);
  return text === '' ? raw : text;
}

function summarizeNode(value: unknown, catalog: LeadScoreEditorCatalog | undefined, depth: number): string {
  if (typeof value !== 'object' || value === null) return '';
  const node = value as Record<string, unknown>;
  if (typeof node['field'] === 'string' && typeof node['operator'] === 'string') {
    const field = catalog?.fields.find((entry) => entry.name === node['field']);
    const label = field?.label ?? node['field'];
    const operator = operatorLabel(node['operator']);
    if ('value' in node) return `${label} ${operator} ${valueText(node['value'])}`;
    return `${label} ${operator}`;
  }
  for (const key of ['all', 'any'] as const) {
    const children = node[key];
    if (Array.isArray(children)) {
      const joiner = key === 'all' ? t('leadscore.admin.rule.and') : t('leadscore.admin.rule.or');
      const parts = children.map((child) => summarizeNode(child, catalog, depth + 1)).filter((entry) => entry !== '');
      const joined = parts.join(` ${joiner} `);
      return depth > 0 && parts.length > 1 ? `(${joined})` : joined;
    }
  }
  if ('not' in node) {
    const inner = summarizeNode(node.not, catalog, depth + 1);
    return inner === '' ? '' : `${t('leadscore.admin.rule.not')} ${inner}`;
  }
  return '';
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'boolean') return value ? t('leadscore.admin.true') : t('leadscore.admin.false');
  return String(value ?? '');
}

/** The operators of one field, or an empty list when the field is not offered at all. */
export function operatorsOf(catalog: LeadScoreEditorCatalog | undefined, name: string): readonly string[] {
  return catalog?.fields.find((field) => field.name === name)?.operators ?? [];
}

export function fieldOf(catalog: LeadScoreEditorCatalog | undefined, name: string): LeadScoreEditorField | undefined {
  return catalog?.fields.find((field) => field.name === name);
}

/** Parse a stored JSON attribute without ever throwing at a render. */
export function parseJsonArray(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(raw: string | undefined | null, fallback: T): T {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
