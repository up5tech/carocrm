import { Alert, Col, Form, Input, InputNumber, Modal, Row, Select, Switch, Typography } from 'antd';
import { useEffect } from 'react';

import { api } from '../../api/client.js';
import type { LeadScoreEditorCatalog, LeadScoreRuleRecord } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { ConditionBuilder } from './ConditionBuilder.js';
import { bandLabel, dimensionLabel, effectLabel, errorText, metricFields, named, policyLabel, selectableFields, sourceLabel } from './shared.js';

/**
 * Phase 19-LS.8 — one rule, authored as a form
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §6.2, §6.4, §16 `19-LS.8`).
 *
 * The record itself is written through the generic entity API, because that is the only path the LS.2 write
 * guard watches: a published model's rules are frozen by the guard, not by this modal hiding a button
 * (AGENTS.md §5.3). What the form adds is the *vocabulary* — every choice list comes from the editor catalog,
 * so an option this module does not implement (an engagement signal, a policy) is visible with its name and
 * is refused by the validator with its code, never silently offered as if it worked.
 */

export function RuleEditorModal({
  modelId,
  modelVersion,
  rule,
  catalog,
  open,
  onClose,
  onSaved,
}: {
  modelId: string;
  modelVersion: number;
  rule: LeadScoreRuleRecord | undefined;
  catalog: LeadScoreEditorCatalog | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const editing = rule !== undefined;
  const vocabularies = catalog?.vocabularies;
  const signalSource = Form.useWatch('signalSource', form);
  const effect = Form.useWatch('effect', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      rule === undefined
        ? { enabled: true, priority: 100, dimension: 'fit', effect: 'add', points: 10, missingDataPolicy: 'neutral', signalSource: 'lead', decayPolicy: 'none', condition: '' }
        : {
            name: rule.name,
            description: rule.description ?? '',
            reasonCode: rule.reasonCode,
            dimension: rule.dimension,
            enabled: rule.enabled,
            priority: rule.priority,
            effect: rule.effect,
            points: rule.points,
            condition: rule.condition,
            ...(rule.targetBand === undefined ? {} : { targetBand: rule.targetBand }),
            missingDataPolicy: rule.missingDataPolicy,
            signalSource: rule.signalSource,
            ...(rule.eventType === undefined ? {} : { eventType: rule.eventType }),
            ...(rule.lookbackDays === null || rule.lookbackDays === undefined ? {} : { lookbackDays: rule.lookbackDays }),
            ...(rule.decayPolicy === undefined ? {} : { decayPolicy: rule.decayPolicy }),
            ...(rule.decayHalfLifeDays === null || rule.decayHalfLifeDays === undefined ? {} : { decayHalfLifeDays: rule.decayHalfLifeDays }),
          },
    );
  }, [open, rule, form]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    const payload: Record<string, unknown> = {
      name: values['name'],
      description: values['description'],
      // A rule belongs to one model *version*, and the version comes from the parent, never from the form:
      // an editor that could retarget a rule would be able to move a comparison into a frozen version.
      modelId,
      modelVersion,
      reasonCode: values['reasonCode'],
      dimension: values['dimension'],
      enabled: values['enabled'] === true,
      priority: values['priority'],
      effect: values['effect'],
      points: values['points'],
      condition: values['condition'],
      missingDataPolicy: values['missingDataPolicy'],
      signalSource: values['signalSource'],
      decayPolicy: values['decayPolicy'],
      ...(values['targetBand'] === undefined ? {} : { targetBand: values['targetBand'] }),
      ...(values['eventType'] === undefined ? {} : { eventType: values['eventType'] }),
      ...(values['lookbackDays'] === undefined ? {} : { lookbackDays: values['lookbackDays'] }),
      ...(values['decayHalfLifeDays'] === undefined ? {} : { decayHalfLifeDays: values['decayHalfLifeDays'] }),
    };
    try {
      if (editing && rule !== undefined) await api.update('LeadScoreRule', rule.id, payload);
      else await api.create('LeadScoreRule', payload);
      onSaved();
      onClose();
    } catch (error) {
      Modal.error({ title: t('leadscore.admin.rule.saveFailed'), content: errorText(error) });
    }
  }

  const decayPolicy = Form.useWatch('decayPolicy', form);
  const engagement = signalSource === 'marketingEvents' || signalSource === 'emailLinks';
  const metrics = engagement ? metricFields(catalog, String(signalSource)) : [];
  const lookback = catalog?.signals.lookback;

  return (
    <Modal
      open={open}
      width={860}
      destroyOnHidden
      title={editing ? t('leadscore.admin.rule.editTitle') : t('leadscore.admin.rule.createTitle')}
      okText={t('core.common.save')}
      cancelText={t('core.common.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" size="small" requiredMark={false}>
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true, message: t('leadscore.admin.rule.nameRequired') }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="reasonCode"
              label={t('leadscore.admin.rule.reasonCode')}
              tooltip={t('leadscore.admin.rule.reasonCodeHint')}
              rules={[{ required: true, message: t('leadscore.admin.rule.reasonCodeRequired') }, { pattern: /^[a-z][a-z0-9_]{1,63}$/, message: t('leadscore.admin.rule.reasonCodePattern') }]}
            >
              <Input placeholder="engagement_email_opened" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="description" label={t('leadscore.admin.description')}>
          <Input.TextArea rows={2} />
        </Form.Item>

        <Row gutter={12}>
          <Col xs={12} md={6}>
            <Form.Item name="dimension" label={t('leadscore.admin.rule.dimension')}>
              <Select options={(vocabularies?.dimensions ?? []).map((entry) => ({ value: entry, label: dimensionLabel(entry) }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="effect" label={t('leadscore.admin.rule.effect')}>
              <Select options={(vocabularies?.effects ?? []).map((entry) => ({ value: entry, label: effectLabel(entry) }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="points" label={t('leadscore.admin.rule.points')} tooltip={t('leadscore.admin.rule.pointsHint')}>
              <InputNumber style={{ width: '100%' }} min={-50} max={50} precision={0} disabled={effect === 'setBand'} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="priority" label={t('leadscore.admin.rule.priority')} tooltip={t('leadscore.admin.rule.priorityHint')}>
              <InputNumber style={{ width: '100%' }} min={0} precision={0} />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="enabled" label={t('leadscore.admin.rule.enabled')} valuePropName="checked">
              <Switch checkedChildren={t('leadscore.admin.on')} unCheckedChildren={t('leadscore.admin.off')} />
            </Form.Item>
            {effect === 'setBand' ? (
              <Form.Item name="targetBand" label={t('leadscore.admin.rule.targetBand')} rules={[{ required: true, message: t('leadscore.admin.rule.targetBandRequired') }]}>
                <Select placeholder={t('leadscore.admin.rule.chooseBand')} options={(vocabularies?.bands ?? []).map((entry) => ({ value: entry, label: bandLabel(entry) }))} />
              </Form.Item>
            ) : null}
          </Col>
        </Row>

        <Typography.Title level={5} style={{ margin: '4px 0 8px' }}>
          {t('leadscore.admin.rule.conditionTitle')}
        </Typography.Title>
        {/* The condition is authored here and nowhere else: the JSON the field stores is produced by the
            builder, so the administrator never has to write a tree by hand (plan §16 `19-LS.8`). */}
        <Form.Item name="condition" rules={[{ required: true, message: t('leadscore.admin.rule.conditionRequired') }]}>
          {/* An engagement rule compares a metric of its own source, never a Lead field: the builder is
              handed that source's metric list, and the operator list of each metric comes from the server. */}
          <ConditionBuilder catalog={catalog} {...(engagement ? { fields: metrics } : {})} />
        </Form.Item>

        <Row gutter={12} style={{ marginTop: 8 }}>
          <Col xs={12} md={8}>
            <Form.Item name="missingDataPolicy" label={t('leadscore.admin.rule.missingData')} tooltip={t('leadscore.admin.rule.missingDataHint')}>
              <Select options={(vocabularies?.missingDataPolicies ?? []).map((entry) => ({ value: entry, label: policyLabel(entry) }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="signalSource" label={t('leadscore.admin.rule.signalSource')} tooltip={t('leadscore.admin.rule.signalSourceHint')}>
              <Select options={(vocabularies?.signalSources ?? []).map((entry) => ({ value: entry, label: sourceLabel(entry) }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="decayPolicy" label={t('leadscore.admin.rule.decayPolicy')}>
              <Select options={(vocabularies?.decayPolicies ?? []).map((entry) => ({ value: entry, label: named(`leadscore.admin.decay.${entry}`, entry) }))} />
            </Form.Item>
          </Col>
        </Row>

        {engagement ? (
          <Row gutter={12}>
            <Col xs={12} md={8}>
              {/* The event type is a choice from the vocabulary Marketing Automation writes, not free text:
                  a rule that named a type nothing emits would read as a signal that never arrives. */}
              <Form.Item name="eventType" label={t('leadscore.admin.rule.eventType')} tooltip={t('leadscore.admin.rule.eventTypeHint')}>
                <Select
                  allowClear
                  placeholder={t('leadscore.admin.rule.anyEvent')}
                  options={(catalog?.signals.eventTypes ?? []).map((entry) => ({ value: entry, label: named(`leadscore.admin.event.${entry}`, entry) }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item
                name="lookbackDays"
                label={t('leadscore.admin.rule.lookbackDays')}
                tooltip={t('leadscore.admin.rule.lookbackDaysHint', { min: String(lookback?.min ?? 1), max: String(lookback?.max ?? 365) })}
                rules={[{ required: true, message: t('leadscore.admin.rule.lookbackRequired') }]}
              >
                <InputNumber style={{ width: '100%' }} min={lookback?.min ?? 1} max={lookback?.max ?? 365} precision={0} />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item name="decayHalfLifeDays" label={t('leadscore.admin.rule.halfLifeDays')} tooltip={t('leadscore.admin.rule.halfLifeDaysHint')}>
                <InputNumber style={{ width: '100%' }} min={1} max={3650} precision={0} disabled={decayPolicy !== 'halfLife'} />
              </Form.Item>
            </Col>
          </Row>
        ) : null}

        {engagement ? (
          <Alert type="info" showIcon message={t('leadscore.admin.rule.engagementNote', { count: String(catalog?.signals.maxEventsPerPlan ?? 200) })} />
        ) : null}

        {catalog === undefined ? null : (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            {t('leadscore.admin.rule.grantHint', { entity: catalog.entityLabel, fields: String(selectableFields(catalog).length) })}
          </Typography.Paragraph>
        )}
      </Form>
    </Modal>
  );
}
