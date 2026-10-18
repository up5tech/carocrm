import { Alert, App as AntApp, Card, Input, InputNumber, Select, Switch, Typography } from 'antd';

import { api } from '../../api/client.js';
import type { ModuleSettingsView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { useModuleDocument } from '../module-document.js';
import { usePublishTabActions } from '../shell.js';

/**
 * A module settings document hosted by the administration shell (PLAN_Phase_20_Settings_UX.md §4.3
 * rows 21-22, §9.1). Service Desk and Customer Success never had a settings screen: their documents
 * are validated, versioned and warnings-bearing on the server, so this renders the leaf policies as
 * real controls and lets the module's own endpoint refuse an invalid value with its reason.
 */
type ModuleKey = 'serviceDesk' | 'customerSuccess';

const MODULES: Record<ModuleKey, {
  titleKey: string;
  load: () => Promise<ModuleSettingsView<Record<string, unknown>>>;
  persist: (patch: Record<string, unknown>) => Promise<unknown>;
  queryKey: readonly unknown[];
}> = {
  serviceDesk: {
    titleKey: 'web.adminPanel.tabs.serviceDesk',
    load: () => api.serviceDeskSettings(),
    persist: (patch) => api.saveServiceDeskSettings(patch),
    queryKey: ['serviceDesk', 'settings'],
  },
  customerSuccess: {
    titleKey: 'web.adminPanel.tabs.customerSuccess',
    load: () => api.customerSuccessSettings(),
    persist: (patch) => api.saveCustomerSuccessSettings(patch),
    queryKey: ['customerSuccess', 'settings'],
  },
};

interface Leaf {
  path: string[];
  value: boolean | number | string | null;
}

export function ModuleSettingsTab({ module }: { module: ModuleKey }) {
  const config = MODULES[module];
  const { message } = AntApp.useApp();
  const document = useModuleDocument<Record<string, unknown>>({
    queryKey: config.queryKey,
    load: config.load,
    persist: config.persist,
    savedMessage: t('web.adminShell.saved'),
    failedMessage: t('web.adminShell.saveFailed'),
    onSaved: () => void message.success(t('web.adminShell.saved')),
  });

  usePublishTabActions({
    dirty: document.dirty,
    saving: document.saving,
    canSave: !document.loading,
    modifiedAt: document.modifiedAt,
    modifiedBy: document.modifiedBy,
    onSave: () => void document.save(),
    onDiscard: document.discard,
    onReload: () => void document.reload(),
  });

  if (document.loading || document.value === undefined) {
    return <Alert type="info" showIcon message={t('web.adminShell.loading')} />;
  }

  const leaves = flattenLeaves(document.value);

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} /> : null}
      {document.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('web.adminSettings.warnings')}
          description={
            <ul className="carocrm-admin-warnings">
              {document.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      <Typography.Text type="secondary" className="carocrm-admin-document-meta">
        {t('web.adminShell.documentName', { name: module })} · {t('web.adminShell.versionLabel')} {document.version}
      </Typography.Text>

      <Card className="carocrm-card" title={t(config.titleKey)} extra={t('web.adminShell.moduleDocumentHint')}>
        <ul className="carocrm-policy-rows" role="list">
          {leaves.map((leaf) => (
            <li className="carocrm-policy-row" key={leaf.path.join('.')}>
              <span className="carocrm-policy-name">{labelPath(leaf.path)}</span>
              <PolicyValue
                value={leaf.value}
                onChange={(next) => document.edit(setPath(leaf.path, next) as Record<string, unknown>)}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function PolicyValue({ value, onChange }: { value: boolean | number | string | null; onChange: (next: boolean | number | string | null) => void }) {
  if (typeof value === 'boolean') {
    return <Switch size="small" checked={value} onChange={onChange} aria-label={t('web.adminShell.policyValue')} />;
  }
  if (typeof value === 'number') {
    return <InputNumber size="small" value={value} onChange={(next) => onChange(next ?? 0)} />;
  }
  if (value === null) {
    return <Input size="small" allowClear placeholder="-" value={undefined} onChange={(event) => onChange(event.target.value.trim() === '' ? null : event.target.value)} />;
  }
  // An enumerated string (a policy name) stays a text field rather than a guessed option list: the
  // module's schema is the authority and its refusal is shown, so the tab never invents values.
  return <Select size="small" value={value} options={[{ value, label: value }]} onChange={(next: string) => onChange(next)} />;
}

function flattenLeaves(value: Record<string, unknown>, prefix: string[] = []): Leaf[] {
  const out: Leaf[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      out.push(...flattenLeaves(child as Record<string, unknown>, path));
    } else if (typeof child === 'boolean' || typeof child === 'number' || typeof child === 'string' || child === null) {
      out.push({ path, value: child });
    } else {
      out.push({ path, value: JSON.stringify(child) });
    }
  }
  return out;
}

function setPath(path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return { value };
  if (rest.length === 0) return { [head]: value };
  return { [head]: setPath(rest, value) };
}

function labelPath(path: readonly string[]): string {
  return path.map((segment) => segment.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)).join(' ›');
}
