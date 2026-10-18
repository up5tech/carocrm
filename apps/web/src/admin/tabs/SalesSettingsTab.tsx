import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Collapse, Form, Input, InputNumber, Row, Select, Space, Switch, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { SalesNumberingSeries, SalesSettingsView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { useModuleDocument } from '../module-document.js';
import { usePublishTabActions } from '../shell.js';

/**
 * Sales settings, hosted as a tab of the administration shell (PLAN_Phase_20_Settings_UX.md §4.3 row
 * 20, §9.1). It was moved out of `AdminSettingsPage` unchanged in substance: one form owns the whole
 * document, the server's version and warnings are shown rather than dropped, and groups the backend
 * does not have are not invented here.
 */
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

export function SalesSettingsTab() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [dirty, setDirty] = useState(false);
  const [series, setSeries] = useState<readonly SalesNumberingSeries[]>([]);

  const document = useModuleDocument<SalesSettingsView['settings']>({
    queryKey: ['sales', 'settings'],
    load: async () => {
      const view = await api.salesSettings();
      setSeries((await api.salesNumbering()).list);
      return view;
    },
    persist: (patch) => api.saveSalesSettings(patch),
    savedMessage: t('sales.settings.saved'),
    failedMessage: t('sales.settings.saveFailed'),
    onSaved: () => void message.success(t('sales.settings.saved')),
  });

  useEffect(() => {
    if (document.value !== undefined) {
      form.setFieldsValue(document.value as Parameters<typeof form.setFieldsValue>[0]);
      setDirty(false);
    }
  }, [document.value, form]);

  usePublishTabActions({
    dirty,
    saving: document.saving,
    canSave: !document.loading,
    modifiedAt: document.modifiedAt,
    modifiedBy: document.modifiedBy,
    onSave: () => form.submit(),
    onDiscard: () => {
      if (document.value !== undefined) form.setFieldsValue(document.value as Parameters<typeof form.setFieldsValue>[0]);
      setDirty(false);
      document.discard();
    },
    onReload: () => {
      setDirty(false);
      void document.reload();
    },
  });

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={t('sales.settings.failedHint')} />
      ) : null}
      {document.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('sales.settings.warnings')}
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
        {t('web.adminShell.versionLabel')} {document.version}
      </Typography.Text>

      <Form
        form={form}
        layout="vertical"
        disabled={document.value === undefined}
        onValuesChange={() => setDirty(true)}
        onFinish={(values: Record<string, unknown>) => void document.save(values as SalesSettingsView['settings'])}
      >
        <Collapse
          defaultActiveKey={['sales']}
          items={[
            {
              key: 'sales',
              label: t('sales.settings.title'),
              extra: t('sales.settings.subtitle'),
              children: (<>
            <Card className="carocrm-card" title={t('sales.settings.features')} extra={t('sales.settings.featuresHint')} style={{ marginBottom: 16 }}>
              <Row gutter={[16, 4]}>
                {SALES_FEATURE_KEYS.map((key) => (
                  <Col key={key} xs={24} md={12} lg={8}>
                    <Form.Item name={['features', key]} label={t(`sales.settings.featureLabels.${key}`)} valuePropName="checked" style={{ marginBottom: 8 }}>
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
                dataSource={[...series]}
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
                  {/* 19-S.17 task 6 — a variant attribute is configuration, not code, so an installation
                      defines its own here; the server validates the code and rejects a duplicate. */}
                  <Form.List name={['variants', 'attributes']}>
                    {(fields, { add, remove }) => (
                      <>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('sales.settings.attributesHint')}
                        </Typography.Text>
                        {fields.map((field) => (
                          <Space key={field.key} align="baseline" style={{ display: 'flex', marginTop: 8 }}>
                            <Form.Item name={[field.name, 'code']} rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]} style={{ marginBottom: 0 }}>
                              <Input placeholder={t('sales.settings.attributeCode')} maxLength={24} style={{ width: 120 }} />
                            </Form.Item>
                            <Form.Item name={[field.name, 'label']} rules={[{ required: true, message: t('web.adminSettings.fieldRequired') }]} style={{ marginBottom: 0 }}>
                              <Input placeholder={t('sales.settings.attributeLabel')} maxLength={64} style={{ width: 180 }} />
                            </Form.Item>
                            <Button type="text" icon={<MinusCircleOutlined />} aria-label={t('sales.settings.attributeRemove')} onClick={() => remove(field.name)} />
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
          </>),
            },
          ]}
        />
      </Form>
    </div>
  );
}
