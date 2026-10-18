import { DeleteOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Collapse, Form, Input, InputNumber, Row, Select, Space, Switch, Table, Typography, Upload } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { SalesNumberingSeries, SalesSettingsView } from '../api/types.js';
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

  // Phase 19-S.17 — the Sales settings document. One form owns the whole document, because a form
  // per card silently discarded every edit: only the features form had a submit, and it posted a
  // `salesSettings` closure that had not been updated yet. The view keeps the server's version and
  // warnings, which the panel shows rather than dropping.
  const [salesForm] = Form.useForm();
  const [salesView, setSalesView] = useState<SalesSettingsView | undefined>(undefined);
  const [salesSeries, setSalesSeries] = useState<readonly SalesNumberingSeries[]>([]);
  const [salesSaving, setSalesSaving] = useState(false);

  const loadSalesSettings = useCallback(async () => {
    try {
      const view = await api.salesSettings();
      setSalesView(view);
      salesForm.setFieldsValue(view.settings as Parameters<typeof salesForm.setFieldsValue>[0]);
      const numbering = await api.salesNumbering();
      setSalesSeries(numbering.list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('sales.settings.saveFailed'));
    }
  }, [message, salesForm]);

  useEffect(() => {
    void loadSalesSettings();
  }, [loadSalesSettings]);

  const saveSalesSettings = async (values: Record<string, unknown>): Promise<void> => {
    setSalesSaving(true);
    try {
      const view = await api.saveSalesSettings(values);
      setSalesView(view);
      salesForm.setFieldsValue(view.settings as Parameters<typeof salesForm.setFieldsValue>[0]);
      void message.success(t('sales.settings.saved'));
      setSalesSeries((await api.salesNumbering()).list);
    } catch (error) {
      // The server refuses a policy change with the reason attached; that reason is the whole
      // diagnostic, so it is shown rather than a generic failure string.
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


  return (
    <>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.adminSettings.title')}</h1>
          <p className="carocrm-page-sub">{t('web.adminSettings.subtitle')}</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={settings.isFetching} onClick={() => void settings.refetch()}>
          {t('core.common.reload')}
        </Button>
      </div>

      <Form form={form} layout="vertical" onFinish={(values: SettingsForm) => void save(values)}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card className="carocrm-card" title={t('web.adminSettings.brandTitle')}>
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
                    <span className="carocrm-logo-preview">
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
            <Card className="carocrm-card" title={t('web.adminSettings.localeTitle')}>
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

      {/* Phase 19-S.17 — the Sales settings document, in ONE form. It used to be a form per card,
          and only the features card had a submit: every other edit was silently discarded, and that
          one posted a `salesSettings` closure that had not been updated yet. The server's version and
          warnings are now shown instead of dropped. Groups the backend does not have (lock policy,
          payment terms) are not invented here — locking is a per-kind descriptor rule and payment
          terms are `PaymentTermProfile` records, both reachable from their own screens. */}
      <Form
        form={salesForm}
        layout="vertical"
        onFinish={(values: Record<string, unknown>) => void saveSalesSettings(values)}
      >
        <Collapse defaultActiveKey={['sales']} style={{ marginTop: 24 }}>
          <Collapse.Panel header={t('sales.settings.title')} key="sales" extra={t('sales.settings.subtitle')}>
            {salesView && salesView.warnings.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message={t('sales.settings.warnings')}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {salesView.warnings.map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              {t('sales.settings.versionLabel')} {salesView ? salesView.version : '-'}
              {salesView && salesView.updatedAt ? ` · ${new Date(salesView.updatedAt).toLocaleString()}` : ''}
            </Typography.Text>

            <Card className="carocrm-card" title={t('sales.settings.features')} extra={t('sales.settings.featuresHint')} style={{ marginBottom: 16 }}>
              <Row gutter={[16, 4]}>
                {SALES_FEATURE_KEYS.map((key) => (
                  <Col key={key} xs={24} md={12} lg={8}>
                    <Form.Item
                      name={['features', key]}
                      label={t(`sales.settings.featureLabels.${key}`)}
                      valuePropName="checked"
                      style={{ marginBottom: 8 }}
                    >
                      <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            </Card>

            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Card className="carocrm-card" title={t('sales.settings.currency')} extra={t('sales.settings.currencyHint')} style={{ marginBottom: 16 }}>
                  <Form.Item name={['currency', 'defaultCurrency']} label={t('sales.settings.defaultCurrency')} rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}>
                    <Input maxLength={3} placeholder="USD" />
                  </Form.Item>
                  <Form.Item name="quantityPrecision" label={t('sales.settings.quantityPrecision')} extra={t('sales.settings.quantityPrecisionHint')}>
                    <InputNumber min={0} max={6} style={{ width: '100%' }} />
                  </Form.Item>
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card className="carocrm-card" title={t('sales.settings.pricing')} extra={t('sales.settings.pricingHint')} style={{ marginBottom: 16 }}>
                  <Form.Item name={['pricing', 'resolution']} label={t('sales.settings.resolution')}>
                    <Select
                      options={[
                        { label: t('sales.settings.resolutionPriceBookFirst'), value: 'priceBookFirst' },
                        { label: t('sales.settings.resolutionProductFirst'), value: 'productFirst' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name={['pricing', 'missingPricePolicy']} label={t('sales.settings.missingPricePolicy')} extra={t('sales.settings.missingPricePolicyHint')}>
                    <Select
                      options={[
                        { label: t('sales.settings.missingPricePolicyError'), value: 'error' },
                        { label: t('sales.settings.missingPricePolicyAllow'), value: 'allowExplicit' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name={['pricing', 'allowCustomPrice']} label={t('sales.settings.allowCustomPrice')} extra={t('sales.settings.allowCustomPriceHint')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Card>
              </Col>
            </Row>

            <Card className="carocrm-card" title={t('sales.settings.tax')} extra={t('sales.settings.taxHint')} style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col xs={24} md={12} lg={6}>
                  <Form.Item name={['tax', 'missingTaxPolicy']} label={t('sales.settings.missingTaxPolicy')} extra={t('sales.settings.missingTaxPolicyError')}>
                    <Select
                      options={[
                        { label: t('sales.settings.missingTaxPolicyError'), value: 'error' },
                        { label: t('sales.settings.missingTaxPolicyZero'), value: 'zero' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Form.Item name={['tax', 'shippingTaxCode']} label={t('sales.settings.shippingTaxCode')} extra={t('sales.settings.shippingTaxCodeHint')}>
                    <Input maxLength={64} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Form.Item name={['tax', 'roundingStage']} label={t('sales.settings.roundingStage')}>
                    <Select
                      options={[
                        { label: t('sales.settings.roundingStageLine'), value: 'line' },
                        { label: t('sales.settings.roundingStageDocument'), value: 'document' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Form.Item name={['tax', 'roundingMode']} label={t('sales.settings.roundingMode')}>
                    <Select
                      options={[
                        { label: 'Half-up', value: 'half-up' },
                        { label: 'Half-even', value: 'half-even' },
                        { label: 'Floor', value: 'floor' },
                        { label: 'Ceil', value: 'ceil' },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card className="carocrm-card" title={t('sales.settings.numbering')} extra={t('sales.settings.numberingHint')} style={{ marginBottom: 16 }}>
              <Form.Item name={['numbering', 'allocation']} label={t('sales.settings.allocation')}>
                <Select
                  options={[
                    { label: t('sales.settings.allocationIssuance'), value: 'issuance' },
                    { label: t('sales.settings.allocationCreation'), value: 'creation' },
                  ]}
                />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('sales.settings.seriesHint')}
              </Typography.Text>
              <Table<SalesNumberingSeries>
                size="small"
                rowKey="id"
                dataSource={[...salesSeries]}
                pagination={false}
                columns={[
                  { title: t('sales.settings.seriesCode'), dataIndex: 'label' },
                  { title: t('sales.settings.seriesPrefix'), dataIndex: 'prefix' },
                  { title: t('sales.settings.seriesNext'), dataIndex: 'nextNumber' },
                  { title: t('sales.settings.seriesAllocation'), dataIndex: 'allocation' },
                ]}
              />
            </Card>

            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Card className="carocrm-card" title={t('sales.settings.inventory')} extra={t('sales.settings.inventoryHint')} style={{ marginBottom: 16 }}>
                  <Form.Item name={['inventory', 'defaultWarehouseId']} label={t('sales.settings.defaultWarehouseId')} extra={t('sales.settings.defaultWarehouseIdHint')}>
                    <Input maxLength={64} />
                  </Form.Item>
                  <Form.Item name={['inventory', 'stockManagedProductTypes']} label={t('sales.settings.stockManagedProductTypes')}>
                    <Select mode="tags" options={[{ label: 'Goods', value: 'Goods' }, { label: 'Service', value: 'Service' }]} />
                  </Form.Item>
                  <Form.Item name={['inventory', 'reservationPolicy']} label={t('sales.settings.reservationPolicy')}>
                    <Select
                      options={[
                        { label: t('sales.settings.reservationPolicyNone'), value: 'none' },
                        { label: t('sales.settings.reservationPolicySoft'), value: 'soft' },
                        { label: t('sales.settings.reservationPolicyHard'), value: 'hard' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name={['inventory', 'removalPolicy']} label={t('sales.settings.removalPolicy')}>
                    <Select
                      options={[
                        { label: t('sales.settings.removalPolicyFifo'), value: 'fifo' },
                        { label: t('sales.settings.removalPolicyFefo'), value: 'fefo' },
                        { label: t('sales.settings.removalPolicyLifo'), value: 'lifo' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name={['inventory', 'allowNegativeStock']} label={t('sales.settings.allowNegativeStock')} extra={t('sales.settings.allowNegativeStockHint')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                  <Form.Item name={['inventory', 'adjustmentApprovalRequired']} label={t('sales.settings.adjustmentApprovalRequired')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                  <Form.Item name={['inventory', 'excludeExpiredStock']} label={t('sales.settings.excludeExpiredStock')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card className="carocrm-card" title={t('sales.settings.subscriptions')} extra={t('sales.settings.subscriptionsHint')} style={{ marginBottom: 16 }}>
                  <Form.Item name={['subscriptions', 'horizonDays']} label={t('sales.settings.horizonDays')}>
                    <InputNumber min={1} max={1095} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name={['subscriptions', 'maxPeriodsPerRun']} label={t('sales.settings.maxPeriodsPerRun')}>
                    <InputNumber min={1} max={500} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name={['subscriptions', 'maxInvoicesPerRun']} label={t('sales.settings.maxInvoicesPerRun')}>
                    <InputNumber min={1} max={1000} style={{ width: '100%' }} />
                  </Form.Item>
                </Card>
                <Card className="carocrm-card" title={t('sales.settings.variants')} extra={t('sales.settings.variantsHint')}>
                  <Form.Item name={['variants', 'requireAllAttributes']} label={t('sales.settings.requireAllAttributes')} valuePropName="checked">
                    <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
                  </Form.Item>
                  {/* 19-S.17 task 6 — the one settings group that had no screen. A variant attribute is
                      configuration, not code (§4.2 "do not hard-code industry-specific attributes"), so
                      an installation defines its own (size/colour/model) here; the server validates the
                      code pattern and rejects a duplicate, and its refusal is shown rather than dropped. */}
                  <Form.List name={['variants', 'attributes']}>
                    {(fields, { add, remove }) => (
                      <>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('sales.settings.attributesHint')}
                        </Typography.Text>
                        {fields.map((field) => (
                          <Space key={field.key} align="baseline" style={{ display: 'flex', marginTop: 8 }}>
                            <Form.Item
                              name={[field.name, 'code']}
                              rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
                              style={{ marginBottom: 0 }}
                            >
                              <Input placeholder={t('sales.settings.attributeCode')} maxLength={24} style={{ width: 120 }} />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'label']}
                              rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]}
                              style={{ marginBottom: 0 }}
                            >
                              <Input placeholder={t('sales.settings.attributeLabel')} maxLength={64} style={{ width: 180 }} />
                            </Form.Item>
                            <Button
                              type="text"
                              icon={<MinusCircleOutlined />}
                              aria-label={t('sales.settings.attributeRemove')}
                              onClick={() => remove(field.name)}
                            />
                          </Space>
                        ))}
                        <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ code: '', label: '' })} style={{ marginTop: 8 }}>
                          {t('sales.settings.attributeAdd')}
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Card>
              </Col>
            </Row>
          </Collapse.Panel>
        </Collapse>

        <div style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" loading={salesSaving} disabled={!salesView}>
            {t('web.common.save')}
          </Button>
        </div>
      </Form>
    </>
  );
}

/** Feature switches are listed from the settings schema's own keys, so a new flag is not silently
 *  missing from this screen. `GET …/action/settings` is the authority for what is stored. */
const SALES_FEATURE_KEYS = [
  'productPrices',
  'taxInclusivePrices',
  'priceBooks',
  'productVariants',
  'supplierPrices',
  'purchases',
  'inventory',
  'subscriptions',
  'paymentRequests',
  'multiCurrency',
  'issuanceLocking',
] as const;
