import { DeleteOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Collapse, Form, Input, Row, Select, Space, Switch, Typography, Upload } from 'antd';
import { useCallback, useEffect, useState } from 'react';

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

  // Sales settings state
  const [salesSettings, setSalesSettings] = useState<Record<string, unknown> | undefined>(undefined);
  const [salesSaving, setSalesSaving] = useState(false);

  const loadSalesSettings = useCallback(async () => {
    try {
      const data = await api.salesSettings();
      setSalesSettings(data.settings);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('sales.settings.saveFailed'));
    }
  }, [message]);

  useEffect(() => {
    void loadSalesSettings();
  }, [loadSalesSettings]);

  const saveSalesSettings = async () => {
    if (!salesSettings) return;
    setSalesSaving(true);
    try {
      await api.saveSalesSettings(salesSettings);
      void message.success(t('sales.settings.saved'));
      await loadSalesSettings();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('sales.settings.saveFailed'));
    } finally {
      setSalesSaving(false);
    }
  };

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

  const salesFeatureOptions = [
    { key: 'productPrices', label: t('sales.settings.features') + ' / Product prices' },
    { key: 'priceBooks', label: t('sales.settings.features') + ' / Price books' },
    { key: 'productVariants', label: t('sales.settings.features') + ' / Product variants' },
    { key: 'supplierPrices', label: t('sales.settings.features') + ' / Supplier prices' },
    { key: 'purchases', label: t('sales.settings.features') + ' / Purchases' },
    { key: 'inventory', label: t('sales.settings.features') + ' / Inventory' },
    { key: 'subscriptions', label: t('sales.settings.features') + ' / Subscriptions' },
    { key: 'paymentRequests', label: t('sales.settings.features') + ' / Payment requests' },
    { key: 'multiCurrency', label: t('sales.settings.features') + ' / Multi-currency' },
    { key: 'issuanceLocking', label: t('sales.settings.features') + ' / Issuance locking' },
  ];

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

      {/* Phase 19-S.17 — Sales settings panel. */}
      <Collapse
        defaultActiveKey={['sales']}
        style={{ marginTop: 24 }}
      >
        <Collapse.Panel header={t('sales.settings.title')} key="sales" extra={t('sales.settings.subtitle')}>
          <Card className="lizant-card" title={t('sales.settings.features')} extra={t('sales.settings.featuresHint')} style={{ marginBottom: 16 }}>
            <Form
              layout="vertical"
              initialValues={salesSettings ? (salesSettings.features as Record<string, boolean>) : {}}
              onFinish={async (values: Record<string, boolean>) => {
                const patch = salesSettings ? { ...salesSettings, features: values } : { features: values };
                setSalesSettings(patch);
                await saveSalesSettings();
              }}
            >
              <Space wrap>
                {salesFeatureOptions.map((opt) => (
                  <Form.Item key={opt.key} name={opt.key} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                ))}
              </Space>
            </Form>
          </Card>

          <Card className="lizant-card" title={t('sales.settings.pricing')} extra={t('sales.settings.pricingHint')} style={{ marginBottom: 16 }}>
            <Form layout="vertical" initialValues={salesSettings ? (salesSettings.pricing as Record<string, unknown>) : {}}>
              <Form.Item
                name="resolution"
                label={t('sales.settings.resolution')}
                extra={t('sales.settings.missingPricePolicyHint')}
              >
                <Select
                  options={[
                    { label: t('sales.settings.resolutionPriceBookFirst'), value: 'priceBookFirst' },
                    { label: t('sales.settings.resolutionProductFirst'), value: 'productFirst' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="allowCustomPrice" label={t('sales.settings.allowCustomPrice')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
              <Form.Item
                name="missingPricePolicy"
                label={t('sales.settings.missingPricePolicy')}
                extra={t('sales.settings.missingPricePolicyError')}
              >
                <Select
                  options={[
                    { label: t('sales.settings.missingPricePolicyError'), value: 'error' },
                    { label: t('sales.settings.missingPricePolicyAllow'), value: 'allowExplicit' },
                  ]}
                />
              </Form.Item>
            </Form>
          </Card>

          <Card className="lizant-card" title={t('sales.settings.tax')} extra={t('sales.settings.taxHint')} style={{ marginBottom: 16 }}>
            <Form layout="vertical" initialValues={salesSettings ? (salesSettings.tax as Record<string, unknown>) : {}}>
              <Form.Item
                name="missingTaxPolicy"
                label={t('sales.settings.missingTaxPolicy')}
                extra={t('sales.settings.missingTaxPolicyError')}
              >
                <Select
                  options={[
                    { label: t('sales.settings.missingTaxPolicyError'), value: 'error' },
                    { label: t('sales.settings.missingTaxPolicyZero'), value: 'zero' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="shippingTaxCode" label={t('sales.settings.shippingTaxCode')} extra={t('sales.settings.shippingTaxCodeHint')}>
                <Input />
              </Form.Item>
              <Form.Item name="roundingStage" label={t('sales.settings.roundingStage')}>
                <Select
                  options={[
                    { label: t('sales.settings.roundingStageLine'), value: 'line' },
                    { label: t('sales.settings.roundingStageDocument'), value: 'document' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="roundingMode" label={t('sales.settings.roundingMode')}>
                <Select options={[{ label: 'Half-up', value: 'half-up' }, { label: 'Half-even', value: 'half-even' }]} />
              </Form.Item>
            </Form>
          </Card>

          <Card className="lizant-card" title={t('sales.settings.numbering')} extra={t('sales.settings.numberingHint')} style={{ marginBottom: 16 }}>
            <Form layout="vertical" initialValues={salesSettings ? (salesSettings.numbering as Record<string, unknown>) : {}}>
              <Form.Item name="allocation" label={t('sales.settings.allocation')}>
                <Select
                  options={[
                    { label: t('sales.settings.allocationIssuance'), value: 'issuance' },
                    { label: t('sales.settings.allocationCreation'), value: 'creation' },
                  ]}
                />
              </Form.Item>
            </Form>
          </Card>

          <Card className="lizant-card" title={t('sales.settings.inventory')} extra={t('sales.settings.inventoryHint')} style={{ marginBottom: 16 }}>
            <Form layout="vertical" initialValues={salesSettings ? (salesSettings.inventory as Record<string, unknown>) : {}}>
              <Form.Item name="allowNegativeStock" label={t('sales.settings.allowNegativeStock')} extra={t('sales.settings.allowNegativeStockHint')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
              <Form.Item name="reservationPolicy" label={t('sales.settings.reservationPolicy')}>
                <Select
                  options={[
                    { label: t('sales.settings.reservationPolicyNone'), value: 'none' },
                    { label: t('sales.settings.reservationPolicySoft'), value: 'soft' },
                    { label: t('sales.settings.reservationPolicyHard'), value: 'hard' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="adjustmentApprovalRequired" label={t('sales.settings.adjustmentApprovalRequired')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
              <Form.Item name="removalPolicy" label={t('sales.settings.removalPolicy')}>
                <Select
                  options={[
                    { label: t('sales.settings.removalPolicyFifo'), value: 'fifo' },
                    { label: t('sales.settings.removalPolicyFefo'), value: 'fefo' },
                    { label: t('sales.settings.removalPolicyLifo'), value: 'lifo' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="excludeExpiredStock" label={t('sales.settings.excludeExpiredStock')} valuePropName="checked">
                <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
              </Form.Item>
            </Form>
          </Card>

          <Card className="lizant-card" title={t('sales.settings.subscriptions')} extra={t('sales.settings.subscriptionsHint')}>
            <Form layout="vertical" initialValues={salesSettings ? (salesSettings.subscriptions as Record<string, unknown>) : {}}>
              <Form.Item name="horizonDays" label={t('sales.settings.horizonDays')} rules={[{ min: 1, max: 1095, message: '1 to 1095 days' }]}>
                <Input type="number" />
              </Form.Item>
              <Form.Item name="maxPeriodsPerRun" label={t('sales.settings.maxPeriodsPerRun')} rules={[{ min: 1, max: 500, message: '1 to 500' }]}>
                <Input type="number" />
              </Form.Item>
              <Form.Item name="maxInvoicesPerRun" label={t('sales.settings.maxInvoicesPerRun')} rules={[{ min: 1, max: 1000, message: '1 to 1000' }]}>
                <Input type="number" />
              </Form.Item>
            </Form>
          </Card>
        </Collapse.Panel>
      </Collapse>

      <div style={{ marginTop: 16 }}>
        <Button type="primary" loading={salesSaving} onClick={saveSalesSettings} disabled={!salesSettings}>
          {t('sales.settings.saved')}
        </Button>
      </div>
    </>
  );
}
