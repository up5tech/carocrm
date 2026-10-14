import { DeleteOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Form, Input, Row, Select, Space, Typography, Upload } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import { timezoneOptions } from '../components/timezones.js';
import { t } from '../state/i18n.js';
import { useSession } from '../state/session.js';
import { useSettings } from '../state/settings.js';

interface SettingsForm {
  pageTitle?: string;
  footerText?: string;
  logoAttachmentId?: string | null;
  defaultLocale: string;
  enabledLocales: string[];
  defaultTimezone: string;
}

/** Administrator page for the instance settings: brand text, logo, footer and language defaults. */
export function AdminSettingsPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const settings = useSettings();
  const [form] = Form.useForm<SettingsForm>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const view = settings.data;
  const logoId = Form.useWatch('logoAttachmentId', form);

  // The settings arrive asynchronously, so the form is filled when they land rather than by
  // `initialValues` on first paint.
  useEffect(() => {
    if (!view) return;
    form.setFieldsValue({
      pageTitle: view.pageTitle ?? '',
      footerText: view.footerText ?? '',
      logoAttachmentId: view.logoAttachmentId,
      defaultLocale: view.defaultLocale,
      enabledLocales: view.enabledLocales,
      defaultTimezone: view.defaultTimezone,
    });
  }, [form, view]);

  const uploadLogo = async (file: File): Promise<false> => {
    if (!file.type.startsWith('image/')) {
      void message.error(t('web.adminSettings.logoNotImage'));
      return false;
    }
    setUploading(true);
    try {
      const stored = await api.uploadAttachment(file, { field: 'logo', role: 'logo' });
      form.setFieldValue('logoAttachmentId', stored.id);
      void message.success(t('web.adminSettings.logoUploaded'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminSettings.logoUploadFailed'));
    } finally {
      setUploading(false);
    }
    // The upload is saved with the rest of the form, so antd must not post it on its own.
    return false;
  };

  const save = async (values: SettingsForm): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({
        pageTitle: values.pageTitle?.trim() || null,
        footerText: values.footerText?.trim() || null,
        logoAttachmentId: values.logoAttachmentId ?? null,
        defaultLocale: values.defaultLocale,
        enabledLocales: values.enabledLocales,
        defaultTimezone: values.defaultTimezone,
      });
      await settings.refetch();
      void message.success(t('web.adminSettings.saved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (principal?.type !== 'admin') {
    return <Alert type="error" showIcon message={t('web.adminSettings.notAdmin')} />;
  }

  const localeOptions = (view?.availableLocales ?? []).map((value) => ({ value, label: t(`web.language.${value}`) }));

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">{t('web.adminSettings.title')}</h1>
          <p className="lizant-page-sub">{t('web.adminSettings.subtitle')}</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={settings.isFetching} onClick={() => void settings.refetch()}>
          {t('core.common.reload')}
        </Button>
      </div>

      <Form form={form} layout="vertical" onFinish={(values: SettingsForm) => void save(values)}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card className="lizant-card" title={t('web.adminSettings.brandTitle')}>
              <Form.Item name="pageTitle" label={t('web.adminSettings.pageTitleLabel')} extra={t('web.adminSettings.pageTitleHint')}>
                <Input maxLength={80} placeholder={t('web.adminSettings.pageTitlePlaceholder')} />
              </Form.Item>
              <Form.Item name="footerText" label={t('web.adminSettings.footerLabel')} extra={t('web.adminSettings.footerHint')}>
                <Input maxLength={200} placeholder={t('web.adminSettings.footerPlaceholder')} />
              </Form.Item>
              <Form.Item name="logoAttachmentId" hidden>
                <Input />
              </Form.Item>
              <Form.Item label={t('web.adminSettings.logoLabel')} extra={t('web.adminSettings.logoHint')}>
                <Space align="center" size={12} wrap>
                  {logoId ? (
                    <span className="lizant-logo-preview">
                      <img src={`/api/v1/Attachment/${logoId}/file`} alt="" />
                    </span>
                  ) : null}
                  <Upload accept="image/*" showUploadList={false} beforeUpload={(file) => void uploadLogo(file as unknown as File)}>
                    <Button icon={<UploadOutlined />} loading={uploading}>
                      {t('web.adminSettings.logoUpload')}
                    </Button>
                  </Upload>
                  {logoId ? (
                    <Button type="text" icon={<DeleteOutlined />} onClick={() => form.setFieldValue('logoAttachmentId', null)}>
                      {t('web.adminSettings.logoRemove')}
                    </Button>
                  ) : null}
                </Space>
              </Form.Item>
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card className="lizant-card" title={t('web.adminSettings.localeTitle')}>
              <Form.Item name="enabledLocales" label={t('web.adminSettings.enabledLocalesLabel')} rules={[{ required: true, message: t('web.adminSettings.enabledLocalesRequired') }]}>
                <Select mode="multiple" options={localeOptions} placeholder={t('web.adminSettings.enabledLocalesPlaceholder')} />
              </Form.Item>
              <Form.Item name="defaultLocale" label={t('web.adminSettings.defaultLocaleLabel')} rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}>
                <Select options={localeOptions} />
              </Form.Item>
              <Form.Item name="defaultTimezone" label={t('web.adminSettings.timezoneLabel')} rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}>
                <Select showSearch options={timezoneOptions()} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.adminSettings.localeHint')}
              </Typography.Text>
            </Card>
          </Col>
        </Row>

        <div style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t('web.common.save')}
          </Button>
        </div>
      </Form>
    </>
  );
}
