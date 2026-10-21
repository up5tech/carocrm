import { Alert, Card, Form, Input, Switch, Table, Tag, Typography } from 'antd';

import type { DocsSettingsView } from '../../api/types.js';
import { useDocsTree } from '../../state/docs.js';
import { t } from '../../state/i18n.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

/**
 * The `Docs` settings tab (PLAN_Phase_21_Documentation.md §12, §17 21.7).
 *
 * Two jobs in one screen. The switches decide whether the handbook exists for this instance and where it
 * lives — including `externalUrl`, which is the answer for an organisation that already has a wiki and
 * does not want a second one. The panel below is the coverage report: an administrator should be able to
 * see "17 pages, 0 of them translated, 3 index warnings" without a shell, because the person who notices
 * a shipped screen has no page is usually the one who can write it.
 */
export function DocsTab() {
  const document = useDocumentForm<DocsSettingsView>('docs');
  const value = document.value;
  const tree = useDocsTree();
  const diagnostics = tree.data?.diagnostics;

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

  const warnings = (diagnostics?.locales ?? []).flatMap((locale) =>
    locale.warnings.map((warning, index) => ({
      rowKey: `${locale.locale}-${String(index)}`,
      locale: locale.locale,
      code: warning.code,
      message: warning.message,
    })),
  );

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={document.conflict ? t('web.adminShell.conflictHint') : undefined} />
      ) : null}

      <Card className="carocrm-card" title={t('web.adminDocs.title')} extra={t('web.adminDocs.hint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminDocs.enabled')} extra={t('web.adminDocs.enabledHint')}>
            <Switch checked={value?.enabled ?? true} disabled={value === undefined} onChange={(next) => document.edit({ enabled: next })} />
          </Form.Item>
          <Form.Item label={t('web.adminDocs.sidebar')} extra={t('web.adminDocs.sidebarHint')}>
            <Switch checked={value?.showInSidebar ?? true} disabled={value === undefined} onChange={(next) => document.edit({ showInSidebar: next })} />
          </Form.Item>
          <Form.Item label={t('web.adminDocs.helpMenu')} extra={t('web.adminDocs.helpMenuHint')}>
            <Switch checked={value?.showHelpMenu ?? true} disabled={value === undefined} onChange={(next) => document.edit({ showHelpMenu: next })} />
          </Form.Item>
          <Form.Item label={t('web.adminDocs.external')} extra={t('web.adminDocs.externalHint')}>
            <Input
              style={{ maxWidth: 420 }}
              placeholder="https://wiki.example.com/crm"
              value={value?.externalUrl ?? ''}
              onChange={(event) => document.edit({ externalUrl: event.target.value === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminDocs.landing')} extra={t('web.adminDocs.landingHint')}>
            <Input
              style={{ maxWidth: 260 }}
              placeholder="admin/settings-overview"
              value={value?.landingPage ?? ''}
              onChange={(event) => document.edit({ landingPage: event.target.value === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminDocs.support')} extra={t('web.adminDocs.supportHint')}>
            <Input
              style={{ maxWidth: 320 }}
              value={value?.supportEmail ?? ''}
              onChange={(event) => document.edit({ supportEmail: event.target.value === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.adminShell.documentName', { name: 'docs' })} · {t('web.adminShell.versionLabel')} {document.version}
          </Typography.Text>
        </Form>
      </Card>

      <Card className="carocrm-card" title={t('web.adminDocs.coverageTitle')} style={{ marginTop: 16 }}>
        {diagnostics === undefined ? (
          <Typography.Text type="secondary">{t('web.adminDocs.coveragePending')}</Typography.Text>
        ) : (
          <>
            <Typography.Paragraph>
              {t('web.adminDocs.coverageSummary', {
                pages: diagnostics.locales.find((locale) => locale.locale === 'en')?.pages ?? 0,
                percent: Math.round(diagnostics.coverage * 100),
              })}
            </Typography.Paragraph>
            <Table
              size="small"
              pagination={false}
              dataSource={[...diagnostics.locales]}
              rowKey={(row) => row.locale}

              columns={[
                { title: t('web.adminDocs.localeColumn'), dataIndex: 'locale', width: 90 },
                { title: t('web.adminDocs.pagesColumn'), dataIndex: 'pages', width: 90 },
                {
                  title: t('web.adminDocs.translatedColumn'),
                  dataIndex: 'translated',
                  width: 110,
                  render: (translated: number, row) => `${String(translated)} / ${String(row.pages)}`,
                },
                {
                  title: t('web.adminDocs.hashColumn'),
                  dataIndex: 'hash',
                  render: (hash: string) => <Typography.Text copyable={{ text: hash }} className="carocrm-admin-docs-hash">{hash.slice(0, 12)}</Typography.Text>,
                },
              ]}
            />
            {warnings.length > 0 ? (
              <>
                <Typography.Title level={5} style={{ marginTop: 16 }}>
                  {t('web.adminDocs.warningsTitle')}
                </Typography.Title>
                <ul className="carocrm-admin-docs-warnings">
                  {warnings.map((warning) => (
                    <li key={warning.rowKey}>
                      <Tag>{warning.locale}</Tag>
                      <Typography.Text code>{warning.code}</Typography.Text>{' '}
                      <Typography.Text type="secondary">{warning.message}</Typography.Text>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
                {t('web.adminDocs.warningsNone')}
              </Typography.Text>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
