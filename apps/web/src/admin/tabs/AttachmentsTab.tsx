import { Alert, Card, Form, InputNumber, Select, Typography } from 'antd';

import { t } from '../../state/i18n.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface FileStorageDocument {
  maxUploadSizeMb: number;
  allowedExtensions: string[];
}

/**
 * Attachments tab (PLAN_Phase_20_Settings_UX.md §4.3 row 5): the `fileStorage` document — upload
 * limits and the extension allowlist. The storage driver itself is chosen by configuration, so the
 * tab reports where that lives instead of pretending to edit it.
 */
export function AttachmentsTab() {
  const document = useDocumentForm<FileStorageDocument>('fileStorage');
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
      <Card className="carocrm-card" title={t('web.adminAttachments.title')} extra={t('web.adminAttachments.hint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminAttachments.maxSize')} extra={t('web.adminAttachments.maxSizeHint')}>
            <InputNumber
              min={1}
              max={2048}
              style={{ width: 200 }}
              value={value?.maxUploadSizeMb ?? 25}
              disabled={value === undefined}
              onChange={(next) => document.edit({ maxUploadSizeMb: typeof next === 'number' ? next : 25 })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminAttachments.extensions')} extra={t('web.adminAttachments.extensionsHint')}>
            <Select
              mode="tags"
              style={{ maxWidth: 480 }}
              tokenSeparators={[',', ' ']}
              value={value?.allowedExtensions ?? []}
              disabled={value === undefined}
              open={false}
              onChange={(next) => document.edit({ allowedExtensions: next.map((item) => item.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((item) => item !== '') })}
              placeholder={t('web.adminAttachments.extensionsPlaceholder')}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.adminAttachments.driverNote')} · {t('web.adminShell.documentName', { name: 'fileStorage' })} · {t('web.adminShell.versionLabel')} {document.version}
          </Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
