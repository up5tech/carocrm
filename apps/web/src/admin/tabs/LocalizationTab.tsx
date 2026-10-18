import { Alert, Card, Form, Select } from 'antd';

import { timezoneOptions } from '../../components/timezones.js';
import { t } from '../../state/i18n.js';
import { useSettings } from '../../state/settings.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface I18nDocument {
  defaultLocale: string;
  enabledLocales: string[];
  defaultTimezone: string;
}

/**
 * Localization tab (PLAN_Phase_20_Settings_UX.md §4.3 row 2): the `i18n` document — which languages
 * this instance offers, which one it starts in, and the time zone records are shown in. Dates and
 * numbers follow these two values through the shared formatter, so there is no separate format
 * setting to keep in sync.
 */
export function LocalizationTab() {
  const document = useDocumentForm<I18nDocument>('i18n');
  const settings = useSettings();
  const available = settings.data?.availableLocales ?? [];
  const options = available.map((value) => ({ value, label: t(`web.language.${value}`) }));

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

  const value = document.value;

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={document.failed}
          description={document.conflict ? t('web.adminShell.conflictHint') : undefined}
        />
      ) : null}
      <Card className="carocrm-card" title={t('web.adminSettings.localeTitle')} extra={t('web.adminSettings.localeHint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminSettings.enabledLocalesLabel')} extra={t('web.adminSettings.enabledLocalesHint')}>
            <Select
              mode="multiple"
              value={value?.enabledLocales ?? []}
              options={options}
              placeholder={t('web.adminSettings.enabledLocalesPlaceholder')}
              onChange={(next: string[]) => document.edit({ enabledLocales: next })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminSettings.defaultLocaleLabel')} extra={t('web.adminSettings.defaultLocaleHint')}>
            <Select
              value={value?.defaultLocale ?? null}
              options={options}
              onChange={(next: string) => document.edit({ defaultLocale: next })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminSettings.timezoneLabel')} extra={t('web.adminSettings.timezoneHint')}>
            <Select
              showSearch
              value={value?.defaultTimezone ?? null}
              options={timezoneOptions()}
              onChange={(next: string) => document.edit({ defaultTimezone: next })}
            />
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
