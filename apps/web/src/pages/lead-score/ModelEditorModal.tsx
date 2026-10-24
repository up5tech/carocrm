import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { LeadScoreEditorCatalog, LeadScoreModelRecord } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { dimensionLabel, errorText, parseJsonArray, parseJsonObject, selectableFields } from './shared.js';

/**
 * Phase 19-LS.8 — the model's own configuration
 * (`PLAN_Phase_19_LeadScore.md` §3.3, §5.1, §6.3, §16 `19-LS.8`).
 *
 * Three of these attributes are stored as JSON in text fields (LS.2), and each gets a real control instead of
 * a textarea: the qualification bands are rows of band + range, the dimension weights are one number per
 * dimension the module declares, and the field grant is a picker over the catalog's scorable fields. The
 * shape the validator expects is produced here, so the administrator never types a brace — and the ranges
 * still come back from `validate` when they are wrong, because this form is a convenience, not a second copy
 * of the rules.
 */

interface BandRow {
  band: string;
  min: number;
  max: number;
}

export function ModelEditorModal({
  model,
  catalog,
  open,
  onClose,
  onSaved,
}: {
  model: LeadScoreModelRecord | undefined;
  catalog: LeadScoreEditorCatalog | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [bands, setBands] = useState<BandRow[]>([]);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [granted, setGranted] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const editing = model !== undefined;
  const scaleMin = Form.useWatch('scaleMin', form);
  const scaleMax = Form.useWatch('scaleMax', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setBands(parseJsonObject<BandRow[]>(model?.qualificationBands, []));
    setWeights(parseJsonObject<Record<string, number>>(model?.dimensionWeights, {}));
    setGranted(parseJsonArray(model?.allowedFieldPaths));
    setBlocked(parseJsonArray(model?.blockedFieldPaths));
    form.setFieldsValue({
      name: model?.name ?? '',
      description: model?.description ?? '',
      scaleMin: model?.scaleMin ?? 0,
      scaleMax: model?.scaleMax ?? 100,
      baseScore: model?.baseScore ?? 0,
      scoreFloor: model?.scoreFloor ?? 0,
      scoreCeiling: model?.scoreCeiling ?? 100,
      effectiveFrom: dateStringOf(model?.effectiveFrom) === '' ? undefined : dayjs(dateStringOf(model?.effectiveFrom)),
      effectiveTo: dateStringOf(model?.effectiveTo) === '' ? undefined : dayjs(dateStringOf(model?.effectiveTo)),
    });
  }, [open, model, form]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    const timing: Record<string, unknown> = {};
    for (const key of ['effectiveFrom', 'effectiveTo'] as const) {
      const value = values[key];
      if (value === undefined || value === null) {
        // An absent window is cleared with null: the record API omits an undefined key, so a date the
        // administrator removed would otherwise stay in force.
        if (editing && model?.[key] !== undefined && model?.[key] !== null) timing[key] = null;
        continue;
      }
      timing[key] = (value as Dayjs).format('YYYY-MM-DDTHH:mm:ss');
    }
    const payload: Record<string, unknown> = {
      name: values['name'],
      description: values['description'],
      scaleMin: values['scaleMin'],
      scaleMax: values['scaleMax'],
      baseScore: values['baseScore'],
      scoreFloor: values['scoreFloor'],
      scoreCeiling: values['scoreCeiling'],
      // The three JSON attributes, produced from the controls above.
      qualificationBands: bands.length === 0 ? '' : JSON.stringify(bands.filter((row) => row.band !== '')),
      dimensionWeights: Object.keys(weights).length === 0 ? '' : JSON.stringify(weights),
      allowedFieldPaths: granted.length === 0 ? '' : JSON.stringify(granted),
      blockedFieldPaths: blocked.length === 0 ? '' : JSON.stringify(blocked),
      ...timing,
    };
    try {
      if (editing && model !== undefined) {
        await api.update('LeadScoreModel', model.id, payload);
        onSaved(model.id);
      } else {
        // A model is always created as a draft; `status` is the publish command's to decide (LS.2 guard).
        const created = await api.create('LeadScoreModel', payload);
        onSaved(String(created['id'] ?? ''));
      }
      onClose();
    } catch (error) {
      Modal.error({ title: t('leadscore.admin.model.saveFailed'), content: errorText(error) });
    }
  }

  const fields = selectableFields(catalog);
  const low = typeof scaleMin === 'number' ? scaleMin : 0;
  const high = typeof scaleMax === 'number' ? scaleMax : 100;

  return (
    <Modal
      open={open}
      width={880}
      destroyOnHidden
      title={editing ? t('leadscore.admin.model.editTitle') : t('leadscore.admin.model.createTitle')}
      okText={t('core.common.save')}
      cancelText={t('core.common.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" size="small" requiredMark={false}>
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, message: t('leadscore.admin.model.nameRequired') }]}>
              <Input placeholder="Default lead score" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="description" label={t('leadscore.admin.description')}>
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Typography.Title level={5} style={{ margin: '4px 0 8px' }}>
          {t('leadscore.admin.model.scale')}
        </Typography.Title>
        <Row gutter={12}>
          {(
            [
              ['scaleMin', 'scaleMin'],
              ['scaleMax', 'scaleMax'],
              ['baseScore', 'baseScore'],
              ['scoreFloor', 'scoreFloor'],
              ['scoreCeiling', 'scoreCeiling'],
            ] as const
          ).map(([key, labelKey]) => (
            <Col xs={12} md={5} key={key}>
              <Form.Item name={key} label={t(`leadscore.admin.model.${labelKey}`)} tooltip={t(`leadscore.admin.model.${labelKey}Hint`)} rules={[{ required: true, message: t('leadscore.admin.model.valueRequired') }]}>
                <InputNumber style={{ width: '100%' }} precision={0} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        {low >= high ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('leadscore.admin.model.scaleOrder')} /> : null}

        <Typography.Title level={5} style={{ margin: '4px 0 8px' }}>
          {t('leadscore.admin.model.bands')}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('leadscore.admin.model.bandsHint')}
        </Typography.Paragraph>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {bands.map((row, index) => (
            <Space wrap size={8} key={`${String(index)}-${row.band}`} align="baseline" className="carocrm-band-row">
              <Select
                size="small"
                style={{ minWidth: 168 }}
                aria-label={t('leadscore.admin.model.band')}
                value={row.band === '' ? null : row.band}
                placeholder={t('leadscore.admin.model.band')}
                status={row.band === '' ? 'error' : ''}
                onChange={(band: string) => setBands(bands.map((entry, position) => (position === index ? { ...entry, band } : entry)))}
                options={(catalog?.vocabularies.bands ?? []).map((band) => ({ value: band, label: band }))}
              />
              <InputNumber size="small" style={{ width: 96 }} min={low} max={high} precision={0} value={row.min} aria-label={t('leadscore.admin.model.bandMin')} onChange={(min) => setBands(bands.map((entry, position) => (position === index ? { ...entry, min: Number(min ?? low) } : entry)))} />
              <Typography.Text type="secondary">–</Typography.Text>
              <InputNumber size="small" style={{ width: 96 }} min={low} max={high} precision={0} value={row.max} aria-label={t('leadscore.admin.model.bandMax')} onChange={(max) => setBands(bands.map((entry, position) => (position === index ? { ...entry, max: Number(max ?? high) } : entry)))} />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('web.common.remove')} onClick={() => setBands(bands.filter((_, position) => position !== index))} />
            </Space>
          ))}
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setBands([...bands, { band: '', min: low, max: high }])}
          >
            {t('leadscore.admin.model.addBand')}
          </Button>
        </Space>

        <Typography.Title level={5} style={{ margin: '16px 0 8px' }}>
          {t('leadscore.admin.model.weights')}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('leadscore.admin.model.weightsHint')}
        </Typography.Paragraph>
        <Row gutter={12}>
          {(catalog?.vocabularies.dimensions ?? []).map((dimension) => (
            <Col xs={12} md={8} key={dimension}>
              <Form.Item label={dimensionLabel(dimension)}>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={0}
                  max={1000}
                  placeholder="0"
                  value={weights[dimension] ?? null}
                  onChange={(value) => {
                    const next = { ...weights };
                    if (value === null || value === undefined) delete next[dimension];
                    else next[dimension] = Number(value);
                    setWeights(next);
                  }}
                />
              </Form.Item>
            </Col>
          ))}
        </Row>

        <Typography.Title level={5} style={{ margin: '4px 0 8px' }}>
          {t('leadscore.admin.model.grant')}
        </Typography.Title>
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item label={t('leadscore.admin.model.allowed')} tooltip={t('leadscore.admin.model.allowedHint')}>
              <Select
                size="small"
                mode="multiple"
                allowClear
                value={granted}
                optionFilterProp="label"
                maxTagCount="responsive"
                placeholder={t('leadscore.admin.model.allowedPlaceholder')}
                onChange={setGranted}
                options={fields.map((field) => ({ value: field.name, label: `${field.label} · ${field.type}` }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label={t('leadscore.admin.model.blocked')} tooltip={t('leadscore.admin.model.blockedHint')}>
              <Select
                size="small"
                mode="multiple"
                allowClear
                value={blocked}
                optionFilterProp="label"
                maxTagCount="responsive"
                placeholder={t('leadscore.admin.model.blockedPlaceholder')}
                onChange={setBlocked}
                options={(catalog?.fields ?? []).map((field) => ({ value: field.name, label: `${field.label} · ${field.type}` }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          {(
            [
              ['effectiveFrom', t('leadscore.admin.model.effectiveFrom')],
              ['effectiveTo', t('leadscore.admin.model.effectiveTo')],
            ] as const
          ).map(([key, label]) => (
            <Col xs={24} md={8} key={key}>
              <Form.Item name={key} label={label}>
                <DatePickerInput />
              </Form.Item>
            </Col>
          ))}
        </Row>
      </Form>
    </Modal>
  );
}

/** A stored date attribute, read without trusting its declared type. */
function dateStringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The window of a model, in the same ISO form the record API stores. */
function DatePickerInput({ value, onChange }: { value?: Dayjs | undefined; onChange?: (value: Dayjs | undefined) => void }) {
  return (
    <DatePicker
      size="small"
      showTime
      style={{ width: '100%' }}
      format="YYYY-MM-DD HH:mm"
      value={value}
      onChange={(next) => onChange?.(next === null ? undefined : (next as Dayjs))}
      allowClear
    />
  );
}
