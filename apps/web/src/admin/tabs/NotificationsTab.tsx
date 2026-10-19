import { Alert, Card, Form, Select, Switch, Typography } from 'antd';

import { t } from '../../state/i18n.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface NotificationsDocument {
  digest: 'off' | 'daily' | 'weekly';
  emailOnAssignment: boolean;
  emailOnStreamUpdate: boolean;
}

/**
 * Notifications tab (PLAN_Phase_20_Settings_UX.md §4.3 row 17): the instance defaults new
 * notification preferences start from. Per-user choices (20.10) override these, so the tab says what
 * it is: the default, not a mandate.
 */
export function NotificationsTab() {
  const document = useDocumentForm<NotificationsDocument>('notifications');
  const value = document.value;

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

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={document.conflict ? t('web.adminShell.conflictHint') : undefined} />
      ) : null}
      <Card className="carocrm-card" title={t('web.adminNotifications.title')} extra={t('web.adminNotifications.hint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminNotifications.digest')} extra={t('web.adminNotifications.digestHint')}>
            <Select
              style={{ maxWidth: 240 }}
              value={value?.digest ?? 'daily'}
              disabled={value === undefined}
              onChange={(next) => document.edit({ digest: next })}
              options={['off', 'daily', 'weekly'].map((digest) => ({ value: digest, label: t(`web.adminNotifications.digest_${digest}`) }))}
            />
          </Form.Item>
          <Form.Item label={t('web.adminNotifications.assignment')} extra={t('web.adminNotifications.assignmentHint')}>
            <Switch checked={value?.emailOnAssignment ?? true} disabled={value === undefined} onChange={(next) => document.edit({ emailOnAssignment: next })} />
          </Form.Item>
          <Form.Item label={t('web.adminNotifications.stream')} extra={t('web.adminNotifications.streamHint')}>
            <Switch checked={value?.emailOnStreamUpdate ?? false} disabled={value === undefined} onChange={(next) => document.edit({ emailOnStreamUpdate: next })} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.adminShell.documentName', { name: 'notifications' })} · {t('web.adminShell.versionLabel')} {document.version}
          </Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
