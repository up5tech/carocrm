import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Form, Input, Select, Space, Typography, Upload } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';
import { accentTone, NAV_ACCENT_NAMES } from '../../theme.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface BrandDocument {
  pageTitle: string | null;
  footerText: string | null;
  logoAttachmentId: string | null;
  /** Brand accent name from `NAV_ACCENT_NAMES`, or null for the shipped blue default (§20.20). */
  primaryColor: string | null;
}

/**
 * General tab (PLAN_Phase_20_Settings_UX.md §4.3 row 1): the `brand` document — page title, footer
 * line and the logo attachment. It is the brand half of what used to be `AdminSettingsPage`, now
 * saved through the settings document registry so it carries a version and a last-modified footer.
 */
export function GeneralTab() {
  const document = useDocumentForm<BrandDocument>('brand');
  const { message } = AntApp.useApp();
  const [uploading, setUploading] = useState(false);

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

  const uploadLogo = async (file: File): Promise<false> => {
    if (!file.type.startsWith('image/')) {
      void message.error(t('web.adminSettings.logoNotImage'));
      return false;
    }
    setUploading(true);
    try {
      const stored = await api.uploadAttachment(file, { field: 'logo', role: 'logo' });
      document.edit({ logoAttachmentId: stored.id });
      void message.success(t('web.adminSettings.logoUploaded'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminSettings.logoUploadFailed'));
    } finally {
      setUploading(false);
    }
    // The upload is saved with the rest of the form, so antd must not post it on its own.
    return false;
  };

  const value = document.value;

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={document.conflict ? t('web.adminShell.conflictHint') : undefined} />
      ) : null}
      <Card className="carocrm-card" title={t('web.adminSettings.brandTitle')} extra={t('web.adminSettings.brandHint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminSettings.pageTitleLabel')} extra={t('web.adminSettings.pageTitleHint')}>
            <Input
              maxLength={80}
              value={value?.pageTitle ?? ''}
              placeholder={t('web.adminSettings.pageTitlePlaceholder')}
              onChange={(event) => document.edit({ pageTitle: event.target.value.trim() === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminSettings.footerLabel')} extra={t('web.adminSettings.footerHint')}>
            <Input
              maxLength={200}
              value={value?.footerText ?? ''}
              placeholder={t('web.adminSettings.footerPlaceholder')}
              onChange={(event) => document.edit({ footerText: event.target.value.trim() === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('web.adminSettings.logoLabel')} extra={t('web.adminSettings.logoHint')}>
            <Space align="center" size={12} wrap>
              {value?.logoAttachmentId ? (
                <span className="carocrm-logo-preview">
                  <img src={`/api/v1/Attachment/${value.logoAttachmentId}/file`} alt="" />
                </span>
              ) : null}
              <Upload accept="image/*" showUploadList={false} beforeUpload={(file) => void uploadLogo(file as unknown as File)}>
                <Button icon={<UploadOutlined />} loading={uploading}>
                  {t('web.adminSettings.logoUpload')}
                </Button>
              </Upload>
              {value?.logoAttachmentId ? (
                <Button type="text" icon={<DeleteOutlined />} onClick={() => document.edit({ logoAttachmentId: null })}>
                  {t('web.adminSettings.logoRemove')}
                </Button>
              ) : null}
            </Space>
          </Form.Item>
          <Form.Item label={t('web.adminSettings.brandColorLabel')} extra={t('web.adminSettings.brandColorHint')}>
            <Select
              value={value?.primaryColor ?? ''}
              onChange={(next) => document.edit({ primaryColor: next === '' ? null : next })}
              // The settings form drives its own document model, so antd's Form.Item never hands the
              // field an id and the label cannot point at the control. The name is spelled out here
              // so the combobox is not announced as an unlabelled input.
              aria-label={t('web.adminSettings.brandColorLabel')}
              options={[
                { value: '', label: t('web.adminSettings.brandColorDefault') },
                ...NAV_ACCENT_NAMES.map((name) => ({
                  value: name,
                  label: (
                    <span className="carocrm-menu-select-option">
                      <span className="carocrm-menu-select-swatch" style={{ background: accentTone(name).fg }} />
                      {name}
                    </span>
                  ),
                })),
              ]}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.adminShell.documentName', { name: 'brand' })} · {t('web.adminShell.versionLabel')} {document.version}
          </Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
