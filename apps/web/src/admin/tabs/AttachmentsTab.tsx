import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Descriptions, Form, InputNumber, Select, Typography } from 'antd';

import { api } from '../../api/client.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface FileStorageDocument {
  maxUploadSizeMb: number;
  allowedExtensions: string[];
}

/** Human-readable size, so an administrator reads "12.4 MB" instead of a byte count. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0 && bytes < 1024) return `${bytes} B`;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Attachments tab (PLAN_Phase_20_Settings_UX.md §4.3 row 5): the `fileStorage` document — upload
 * limits and the extension allowlist — plus what is actually stored.
 *
 * The storage figures come from `GET /StorageUsage`, which counts attachment rows instead of
 * walking the provider: the driver is configuration, and asking a bucket for its usage is neither
 * portable nor safe to do on every tab visit. The numbers are administrator-only on the server.
 */
export function AttachmentsTab() {
  const document = useDocumentForm<FileStorageDocument>('fileStorage');
  const value = document.value;
  const usage = useQuery({
    queryKey: ['storage-usage'],
    queryFn: () => api.storageUsage(),
    staleTime: 60_000,
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

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={document.conflict ? t('web.adminShell.conflictHint') : undefined} />
      ) : null}
      <Card className="carocrm-card" title={t('web.adminAttachments.usageTitle')} extra={t('web.adminAttachments.usageHint')}>
        {usage.isPending ? (
          <LoadingSkeleton rows={2} />
        ) : usage.isError || usage.data === undefined ? (
          <Alert type="warning" showIcon message={t('web.adminAttachments.usageFailed')} />
        ) : (
          <Descriptions
            column={{ xs: 1, md: 3 }}
            items={[
              { key: 'files', label: t('web.adminAttachments.usageFiles'), children: String(usage.data.attachments) },
              { key: 'bytes', label: t('web.adminAttachments.usageBytes'), children: formatBytes(usage.data.bytes) },
              {
                key: 'largest',
                label: t('web.adminAttachments.usageLargest'),
                children: usage.data.largest === null
                  ? t('web.adminAttachments.usageEmpty')
                  : `${usage.data.largest.name} · ${formatBytes(usage.data.largest.bytes)}`,
              },
            ]}
          />
        )}
      </Card>
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
