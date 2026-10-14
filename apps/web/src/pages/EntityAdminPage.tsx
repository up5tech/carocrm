import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition, FieldDefinition, IndexDefinition, LayoutDefinition, LayoutPanel, LayoutViewType, Role } from '../api/types.js';
import { t } from '../state/i18n.js';
import { fieldLabel, useMetadata } from '../state/metadata.js';

const FIELD_TYPES = ['varchar', 'text', 'int', 'float', 'decimal', 'bool', 'date', 'datetime', 'enum', 'multiEnum', 'currency', 'url', 'email', 'phone', 'link', 'linkMultiple', 'formula'];
const RELATION_TYPES = ['oneToMany', 'manyToOne', 'manyToMany'];

/** Views an admin can lay out by hand (PLAN §8). */
const LAYOUT_VIEWS: LayoutViewType[] = ['list', 'detail', 'edit'];

/** Record actions a role can be granted on an entity (PLAN §8). */
const ACL_ACTIONS = ['create', 'read', 'edit', 'delete', 'stream'] as const;
/** Record access levels, from "everything" down to "nothing" (PLAN §8). */
const ACL_LEVELS = ['yes', 'all', 'team', 'own', 'no'] as const;
const FIELD_ACL_ACTIONS = ['read', 'edit'] as const;

function levelOptions(): { value: string; label: string }[] {
  return [{ value: '', label: t('web.entityAdmin.inherit') }, ...ACL_LEVELS.map((level) => ({ value: level, label: level }))];
}

/** Bookkeeping columns the engine owns — they are never a layout member or an index key (PLAN §8). */
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'modifiedAt', 'createdById', 'modifiedById', 'deletedAt', 'version']);

type AclAction = (typeof ACL_ACTIONS)[number];
type FieldAclAction = (typeof FIELD_ACL_ACTIONS)[number];
type Permissions = Record<string, Record<string, string>>;
type FieldPermissions = Record<string, Record<string, Record<string, string>>>;

/** Criteria operators offered by the rule builder — the same list the engine accepts (PLAN §21). */
const CRITERIA_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
  'isTrue',
  'isFalse',
];
const VALUELESS_OPERATORS = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

function ruleActions(): { value: string; label: string }[] {
  return [
    { value: 'setRequired', label: t('web.entityAdmin.ruleMakeRequired') },
    { value: 'hide', label: t('web.entityAdmin.ruleHide') },
    { value: 'show', label: t('web.entityAdmin.ruleShow') },
    { value: 'setReadOnly', label: t('web.entityAdmin.ruleReadOnly') },
    { value: 'error', label: t('web.entityAdmin.ruleBlock') },
  ];
}

interface FieldDraft {
  name: string;
  label?: string | undefined;
  type: string;
  entityKey?: string | undefined;
  required?: boolean | undefined;
  maxLength?: number | undefined;
  values?: string | undefined;
  formula?: string | undefined;
  inList?: boolean | undefined;
  inDetail?: boolean | undefined;
  inEdit?: boolean | undefined;
}

interface RuleDraft {
  name?: string | undefined;
  whenField: string;
  whenOperator: string;
  whenValue?: string | undefined;
  action: string;
  targets?: string[] | undefined;
  message?: string | undefined;
}

type LogicRule = Record<string, unknown>;

interface PanelDraft {
  name: string;
  label?: string | undefined;
  position: number;
  fields?: string[] | undefined;
}

interface IndexDraft {
  name: string;
  fields?: string[] | undefined;
  unique?: boolean | undefined;
}

function buildFieldDefinition(draft: FieldDraft): FieldDefinition {
  const field: FieldDefinition = { type: draft.type };
  if (draft.label && draft.label.trim() !== '') field.label = draft.label.trim();
  if (draft.required) field.required = true;
  if (draft.maxLength) field.maxLength = draft.maxLength;
  if (draft.entityKey) field.entityKey = draft.entityKey;
  if (draft.values && draft.values.trim() !== '') field.values = draft.values.split(',').map((value) => value.trim()).filter(Boolean);
  if (draft.type === 'formula' && draft.formula && draft.formula.trim() !== '') field.formula = draft.formula.trim();
  field.inList = draft.inList !== false;
  field.inDetail = draft.inDetail !== false;
  // A computed field is filled in by the server, so it never belongs in an edit form.
  field.inEdit = draft.type === 'formula' ? false : draft.inEdit !== false;
  return field;
}

function currentRules(definition: EntityDefinition | undefined): LogicRule[] {
  const rules = definition?.dynamicLogic?.rules;
  return Array.isArray(rules) ? (rules as LogicRule[]) : [];
}

function buildRule(draft: RuleDraft): LogicRule {
  const criteria: Record<string, unknown> = { field: draft.whenField, operator: draft.whenOperator };
  if (!VALUELESS_OPERATORS.has(draft.whenOperator)) {
    const raw = draft.whenValue ?? '';
    criteria.value = draft.whenOperator === 'in' || draft.whenOperator === 'notIn' ? raw.split(',').map((part) => part.trim()).filter(Boolean) : raw;
  }
  const targets = (draft.targets ?? []).filter((name) => name !== '');
  const then: Record<string, unknown> = {};
  if (draft.action === 'error') then.error = { message: draft.message ?? t('web.entityAdmin.defaultRuleError'), ...(targets.length > 0 ? { fields: targets } : {}) };
  else then[draft.action] = targets;
  const rule: LogicRule = { when: criteria, then };
  if (draft.name && draft.name.trim() !== '') rule.name = draft.name.trim();
  return rule;
}

function describeWhen(when: unknown): string {
  if (typeof when === 'string') return when;
  if (when && typeof when === 'object') {
    const node = when as Record<string, unknown>;
    if (typeof node.field === 'string') {
      const value = VALUELESS_OPERATORS.has(String(node.operator)) ? '' : ` ${JSON.stringify(node.value ?? '')}`;
      return `${node.field} ${String(node.operator ?? '')}${value}`;
    }
    if (Array.isArray(node.all)) return `all (${node.all.length})`;
    if (Array.isArray(node.any)) return `any (${node.any.length})`;
  }
  return JSON.stringify(when ?? '');
}

function describeThen(then: unknown): string {
  if (!then || typeof then !== 'object') return '';
  const actions = then as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['setRequired', 'hide', 'show', 'setReadOnly', 'showPanels', 'hidePanels']) {
    const list = actions[key];
    if (Array.isArray(list) && list.length > 0) parts.push(`${key}: ${list.join(', ')}`);
  }
  if (actions.setValues && typeof actions.setValues === 'object') {
    parts.push(`setValues: ${Object.entries(actions.setValues as Record<string, unknown>).map(([field, formula]) => `${field}=${String(formula)}`).join(', ')}`);
  }
  const error = actions.error;
  if (error && typeof error === 'object') parts.push(`block: ${(error as { message?: string }).message ?? ''}`);
  return parts.join(' · ');
}

/** Fields an admin may place on a panel or index — a disabled field is retired, not merely hidden. */
function memberFieldNames(entity: EntityDefinition): string[] {
  return Object.entries(entity.fields)
    .filter(([, field]) => field.type !== 'disabled')
    .map(([name]) => name);
}

/** Index keys come from the same pool minus the columns the engine owns. */
function indexableFieldNames(entity: EntityDefinition): string[] {
  return memberFieldNames(entity).filter((name) => !RESERVED_FIELDS.has(name));
}

function panelsOf(entity: EntityDefinition, view: LayoutViewType): LayoutPanel[] {
  return (entity.layouts?.[view] ?? []).flatMap((definition) => definition.panels ?? []);
}

/** A layout section is always a list of definitions, so a panel edit rewrites the first one and leaves the rest untouched. */
function layoutSection(entity: EntityDefinition, view: LayoutViewType, panels: LayoutPanel[]): Record<string, unknown> {
  const existing = entity.layouts?.[view] ?? [];
  const definitions: LayoutDefinition[] =
    existing.length === 0 ? [{ entity: entity.name, type: view, panels }] : existing.map((definition, index) => (index === 0 ? { ...definition, panels } : definition));
  return { layouts: { ...entity.layouts, [view]: definitions } };
}

/** Copies deep enough that a role write never mutates the cached permission map. */
function copyPermissions(source: Permissions): Permissions {
  const copy: Permissions = {};
  for (const [scope, actions] of Object.entries(source)) copy[scope] = { ...actions };
  return copy;
}

function copyFieldPermissions(source: FieldPermissions): FieldPermissions {
  const copy: FieldPermissions = {};
  for (const [scope, fields] of Object.entries(source)) {
    const inner: Record<string, Record<string, string>> = {};
    for (const [field, actions] of Object.entries(fields)) inner[field] = { ...actions };
    copy[scope] = inner;
  }
  return copy;
}

/** An empty level means "no override for this entity", so the key is dropped rather than blanked. */
function withLevel(actions: Record<string, string>, action: string, level: string): Record<string, string> {
  const next = { ...actions };
  if (level === '') delete next[action];
  else next[action] = level;
  return next;
}

interface MetadataTabProps {
  entity: EntityDefinition;
  save: (body: Record<string, unknown>, okText: string) => void;
}

/** Label and entity-enabled state — the two flags that decide whether the entity is usable at all. */
function SettingsTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const [form] = Form.useForm<{ label: string }>();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Form form={form} layout="vertical" initialValues={{ label: entity.label }} onFinish={(values: { label: string }) => void patch({ label: values.label }, t('web.entityAdmin.labelUpdated'))}>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Form.Item name="label" label={t('web.entityAdmin.label')} rules={[{ required: true, message: t('web.entityAdmin.labelRequired') }]} extra={t('web.entityAdmin.technicalName', { name: entity.name })}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={16}>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit">
              {t('web.entityAdmin.rename')}
            </Button>
          </Col>
        </Row>
      </Form>

      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {entity.isEntity ? t('web.entityAdmin.entityEnabled') : t('web.entityAdmin.entityDisabled')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('web.entityAdmin.entityStateHint')}
        </Typography.Paragraph>
        <Popconfirm
          title={entity.isEntity ? t('web.entityAdmin.disableConfirm', { name: entity.name }) : t('web.entityAdmin.enableConfirm', { name: entity.name })}
          okText={entity.isEntity ? t('web.entityAdmin.disable') : t('web.entityAdmin.enable')}
          onConfirm={() => void patch({ isEntity: !entity.isEntity }, t('web.entityAdmin.entityUpdated'))}
        >
          <Button danger={entity.isEntity}>
            {entity.isEntity ? t('web.entityAdmin.disableEntity') : t('web.entityAdmin.enableEntity')}
          </Button>
        </Popconfirm>
      </div>
    </Space>
  );
}

/** Field definitions of one entity (PLAN §8) — labels are managed here too: set on create, renamed per field below. */
function FieldsTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const [form] = Form.useForm<FieldDraft>();
  const fieldType = Form.useWatch('type', form);
  const [rename, setRename] = useState<{ name: string; label: string } | null>(null);

  // The metadata patch replaces a field entry wholesale, so a label rename sends the whole
  // definition back with only the label changed.
  const renameField = () => {
    if (!rename) return;
    const label = rename.label.trim();
    if (label === '') {
      void message.warning(t('web.entityAdmin.labelEmpty'));
      return;
    }
    patch({ fields: { [rename.name]: { ...entity.fields[rename.name], label } } }, t('web.entityAdmin.fieldLabelUpdated'));
    setRename(null);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Table
        rowKey="name"
        size="small"
        dataSource={Object.entries(entity.fields).map(([name, field]) => ({ name, ...field }))}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('web.common.name'), dataIndex: 'name' },
          {
            title: t('web.entityAdmin.label'),
            dataIndex: 'label',
            render: (value: string | undefined, row) => value ?? fieldLabel(row.name, row, metadata.data),
          },
          {
            title: t('web.entityAdmin.type'),
            dataIndex: 'type',
            render: (type: string, row) => (
              <Space size={4} wrap>
                <Tag>{type}</Tag>
                {row.entityKey ? <Tag color="blue">→ {row.entityKey}</Tag> : null}
              </Space>
            ),
          },
          { title: t('web.entityAdmin.required'), dataIndex: 'required', render: (value: boolean | undefined) => (value ? t('core.common.yes') : t('core.common.no')) },
          {
            title: '',
            key: 'rename',
            render: (_: unknown, row) => (
              <Button
                type="text"
                icon={<EditOutlined />}
                aria-label={t('web.entityAdmin.editFieldLabelAria', { name: row.name })}
                onClick={() => setRename({ name: row.name, label: row.label ?? '' })}
              />
            ),
          },
          {
            title: '',
            key: 'disable',
            render: (_: unknown, row) =>
              row.type === 'disabled' ? (
                <Tag>{t('web.entityAdmin.disabled')}</Tag>
              ) : (
                <Popconfirm
                  title={t('web.entityAdmin.disableFieldConfirm', { name: row.name })}
                  description={t('web.entityAdmin.disableFieldHint')}
                  okText={t('web.entityAdmin.disable')}
                  onConfirm={() => void api.disableField(entity.name, row.name).then(() => metadata.refetch()).catch((error: unknown) => message.error(error instanceof Error ? error.message : t('web.entityAdmin.failed')))}
                >
                  <Button danger type="text" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.disableFieldAria', { name: row.name })} />
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal
        title={rename ? t('web.entityAdmin.fieldLabelTitle', { name: rename.name }) : t('web.entityAdmin.fieldLabelTitlePlain')}
        open={rename !== null}
        okText={t('web.common.save')}
        cancelText={t('web.entityAdmin.cancel')}
        onOk={renameField}
        onCancel={() => setRename(null)}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t('web.entityAdmin.fieldLabelHint')}
        </Typography.Paragraph>
        <Input
          aria-label={t('web.entityAdmin.fieldLabel')}
          value={rename?.label ?? ''}
          placeholder={fieldLabel(rename?.name ?? '', rename ? entity.fields[rename.name] : undefined, metadata.data)}
          onChange={(event) => setRename((current) => (current ? { ...current, label: event.target.value } : current))}
          onPressEnter={renameField}
        />
      </Modal>
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          const draft = values as FieldDraft;
          await patch({ fields: { [draft.name]: buildFieldDefinition(draft) } }, t('web.entityAdmin.fieldAdded'));
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.fieldName')} rules={[{ required: true, pattern: /^[a-z][A-Za-z0-9]{1,40}$/, message: t('web.entityAdmin.camelCase') }]}>
              <Input placeholder="fieldName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="label" label={t('web.entityAdmin.label')}>
              <Input placeholder={t('web.entityAdmin.displayLabelPlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Form.Item name="type" label={t('web.entityAdmin.type')} initialValue="varchar">
              <Select style={{ width: '100%' }} options={FIELD_TYPES.map((type) => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Form.Item name="entityKey" label={t('web.entityAdmin.linkEntity')}>
              <Select style={{ width: '100%' }} placeholder={t('web.entityAdmin.linkEntityPlaceholder')} allowClear options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Form.Item name="maxLength" label={t('web.entityAdmin.maxLength')}>
              <InputNumber style={{ width: '100%' }} min={1} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Form.Item name="values" label={t('web.entityAdmin.enumValues')}>
              <Input placeholder={t('web.entityAdmin.enumValuesPlaceholder')} />
            </Form.Item>
          </Col>
          {fieldType === 'formula' ? (
            <Col xs={24}>
              <Form.Item name="formula" label={t('web.entityAdmin.formula')} rules={[{ required: true, message: t('web.entityAdmin.formulaRequired') }]}>
                <Input placeholder="concat(field('firstName'), ' ', field('lastName'))" />
              </Form.Item>
            </Col>
          ) : null}
          <Col xs={8} md={4}>
            <Form.Item name="required" label={t('web.entityAdmin.required')} valuePropName="checked">
              <Switch size="small" />
            </Form.Item>
          </Col>
          <Col xs={8} md={4}>
            <Form.Item name="inList" label={t('web.entityAdmin.inList')} valuePropName="checked" initialValue>
              <Switch size="small" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          {t('web.entityAdmin.addField')}
        </Button>
      </Form>
    </Space>
  );
}

/** Dynamic logic rules of one entity (PLAN §21). */
function LogicTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const [form] = Form.useForm<RuleDraft>();
  const rules = useMemo(() => currentRules(entity), [entity]);
  const fieldNames = useMemo(() => Object.keys(entity.fields), [entity]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Table
        rowKey={(row, index) => String((row as LogicRule).name ?? `rule-${String(index)}`)}
        size="small"
        dataSource={rules}
        pagination={false}
        locale={{ emptyText: t('web.entityAdmin.noRules') }}
        columns={[
          { title: t('web.common.name'), dataIndex: 'name', width: 140, render: (_: unknown, row: LogicRule) => String(row.name ?? '—') },
          { title: t('web.entityAdmin.when'), key: 'when', render: (_: unknown, row: LogicRule) => <Typography.Text code>{describeWhen(row.when)}</Typography.Text> },
          { title: t('web.entityAdmin.then'), key: 'then', render: (_: unknown, row: LogicRule) => describeThen(row.then) },
          {
            title: '',
            key: 'remove',
            width: 80,
            render: (_: unknown, row: LogicRule) => (
              <Popconfirm title={t('web.entityAdmin.removeRuleConfirm', { name: String(row.name ?? t('web.entityAdmin.thisRule')) })} okText={t('web.entityAdmin.remove')} onConfirm={() => void patch({ dynamicLogic: { rules: rules.filter((rule) => rule !== row) } }, t('web.entityAdmin.ruleRemoved'))}>
                <Button danger type="text" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.removeRuleAria', { name: String(row.name ?? '') })} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          const draft = values as RuleDraft;
          await patch({ dynamicLogic: { rules: [...rules, buildRule(draft)] } }, t('web.entityAdmin.ruleAdded'));
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.ruleName')}>
              <Input placeholder={t('web.entityAdmin.ruleNamePlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="whenField" label={t('web.entityAdmin.whenField')} rules={[{ required: true }]}>
              <Select style={{ width: '100%' }} placeholder={t('web.entityAdmin.whenFieldPlaceholder')} options={fieldNames.map((name) => ({ value: name, label: name }))} showSearch />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="whenOperator" label={t('web.entityAdmin.operator')} initialValue="equals">
              <Select style={{ width: '100%' }} options={CRITERIA_OPERATORS.map((operator) => ({ value: operator, label: operator }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="whenValue" label={t('web.entityAdmin.compareValue')}>
              <Input placeholder={t('web.entityAdmin.compareValuePlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="action" label={t('web.entityAdmin.thenAction')} initialValue="setRequired">
              <Select style={{ width: '100%' }} options={ruleActions()} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="targets" label={t('web.entityAdmin.thenFields')}>
              <Select style={{ width: '100%' }} mode="multiple" placeholder={t('web.entityAdmin.thenFieldsPlaceholder')} options={fieldNames.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="message" label={t('web.entityAdmin.blockMessage')}>
              <Input style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
            {t('web.entityAdmin.addRule')}
          </Button>
          {rules.length > 0 ? (
            <Popconfirm title={t('web.entityAdmin.clearRulesConfirm')} okText={t('web.entityAdmin.clear')} onConfirm={() => void patch({ dynamicLogic: { rules: [] } }, t('web.entityAdmin.rulesCleared'))}>
              <Button danger icon={<DeleteOutlined />}>
                {t('web.entityAdmin.clearRules')}
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      </Form>
    </Space>
  );
}

/** Relations of one entity (PLAN §8). */
function RelationsTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const metadata = useMetadata();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Table
        rowKey="name"
        size="small"
        dataSource={Object.entries(entity.relations).map(([name, relation]) => ({ name, ...relation }))}
        pagination={false}
        locale={{ emptyText: t('web.entityAdmin.noRelations') }}
        columns={[
          { title: t('web.common.name'), dataIndex: 'name' },
          { title: t('web.entityAdmin.type'), dataIndex: 'type' },
          { title: t('web.entityAdmin.target'), dataIndex: 'target' },
          { title: t('web.entityAdmin.mappedBy'), dataIndex: 'mappedBy' },
        ]}
      />
      <Form
        layout="vertical"
        onFinish={(values) => {
          const draft = values as { name: string; type: string; target: string; mappedBy?: string };
          void patch({ relations: { [draft.name]: { type: draft.type, target: draft.target, ...(draft.mappedBy ? { mappedBy: draft.mappedBy } : {}) } } }, t('web.entityAdmin.relationAdded'));
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.relationName')} rules={[{ required: true }]}>
              <Input placeholder="relationName" />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="type" label={t('web.entityAdmin.type')} initialValue="oneToMany">
              <Select style={{ width: '100%' }} options={RELATION_TYPES.map((type) => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="target" label={t('web.entityAdmin.targetEntity')} rules={[{ required: true }]}>
              <Select style={{ width: '100%' }} placeholder={t('web.entityAdmin.targetEntityPlaceholder')} options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={7}>
            <Form.Item name="mappedBy" label={t('web.entityAdmin.mappedBy')}>
              <Input placeholder="mappedBy" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          {t('web.entityAdmin.addRelation')}
        </Button>
      </Form>
    </Space>
  );
}

/** Per-view layouts assembled from panels of fields (PLAN §8). */
function LayoutTab({ entity, save }: MetadataTabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PanelDraft>();
  const [view, setView] = useState<LayoutViewType>('detail');
  const panels = useMemo(() => panelsOf(entity, view), [entity, view]);
  const fields = useMemo(() => memberFieldNames(entity), [entity]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]} align="middle">
        <Col xs={24} sm={8} md={6}>
          <label htmlFor="layout-view">{t('web.entityAdmin.view')}</label>
          <Select id="layout-view" style={{ width: '100%' }} value={view} options={LAYOUT_VIEWS.map((value) => ({ value, label: value }))} onChange={(value: LayoutViewType) => setView(value)} />
        </Col>
        <Col xs={24} sm={16} md={18}>
          <Typography.Text type="secondary">{t('web.entityAdmin.panelCount', { panels: String(panels.length), view })}</Typography.Text>
        </Col>
      </Row>

      {panels.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('web.entityAdmin.noPanels')} />
      ) : (
        <Row gutter={[12, 12]}>
          {panels.map((panel, index) => (
            <Col key={`${panel.name}-${String(index)}`} xs={24} md={12} xl={8}>
              <Card
                className="lizant-card"
                size="small"
                title={panel.label ?? panel.name}
                extra={
                  <Popconfirm title={t('web.entityAdmin.removePanelConfirm', { name: panel.name })} okText={t('web.entityAdmin.remove')} onConfirm={() => save(layoutSection(entity, view, panels.filter((candidate) => candidate !== panel)), t('web.entityAdmin.layoutSaved'))}>
                    <Button danger type="text" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.removePanelAria', { name: panel.name })} />
                  </Popconfirm>
                }
              >
                <Space size={4} wrap>
                  <Tag>{panel.name}</Tag>
                  <Tag color="blue">{t('web.entityAdmin.positionTag', { position: String(panel.position) })}</Tag>
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {(panel.fields ?? []).length > 0 ? (panel.fields ?? []).join(', ') : t('web.entityAdmin.noFieldsAssigned')}
                </Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Form
        form={form}
        layout="vertical"
        initialValues={{ position: 0 }}
        onFinish={(values: PanelDraft) => {
          const name = (values.name ?? '').trim();
          const members = (values.fields ?? []).filter((field) => field !== '');
          if (name === '') {
            void message.error(t('web.entityAdmin.panelNameRequired'));
            return;
          }
          if (members.length === 0) {
            void message.error(t('web.entityAdmin.memberRequired'));
            return;
          }
          const label = values.label?.trim() ?? '';
          const panel: LayoutPanel = { name, position: values.position ?? 0, fields: members, ...(label === '' ? {} : { label }) };
          save(layoutSection(entity, view, [...panels, panel]), t('web.entityAdmin.layoutSaved'));
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.panelName')} rules={[{ required: true, message: t('web.entityAdmin.panelName') }]}>
              <Input placeholder="panelName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="label" label={t('web.entityAdmin.label')}>
              <Input placeholder={t('web.entityAdmin.displayLabelPlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="position" label={t('web.entityAdmin.position')} initialValue={0}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="fields" label={t('web.entityAdmin.memberFields')}>
              <Select mode="multiple" style={{ width: '100%' }} placeholder={t('web.entityAdmin.memberFieldsPlaceholder')} options={fields.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          {t('web.entityAdmin.addPanel')}
        </Button>
      </Form>
    </Space>
  );
}

/** Record + field access levels per role — the enforced ACL source (PLAN §8). */
function AccessTab({ entity }: { entity: EntityDefinition }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.roles(), staleTime: 30_000 });
  const [fieldRoleId, setFieldRoleId] = useState<string | undefined>(undefined);
  const list = roles.data?.list ?? [];
  const fields = useMemo(() => memberFieldNames(entity), [entity]);
  const fieldRole = list.find((role) => role.id === fieldRoleId);

  const write = async (role: Role, body: { permissions?: Permissions | undefined; fieldPermissions?: FieldPermissions | undefined }, okText: string) => {
    try {
      await api.patchRole(role.id, body);
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      void message.success(okText);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.entityAdmin.failed'));
    }
  };

  const levelOf = (role: Role, action: AclAction): string => role.permissions[entity.name]?.[action] ?? role.permissions['*']?.[action] ?? '';

  const setLevel = (role: Role, action: AclAction, level: string) => {
    const permissions = copyPermissions(role.permissions);
    permissions[entity.name] = withLevel(permissions[entity.name] ?? {}, action, level);
    void write(role, { permissions }, t('web.entityAdmin.accessUpdated'));
  };

  const fieldLevelOf = (role: Role, field: string, action: FieldAclAction): string => role.fieldPermissions[entity.name]?.[field]?.[action] ?? '';

  const setFieldLevel = (role: Role, field: string, action: FieldAclAction, level: string) => {
    const fieldPermissions = copyFieldPermissions(role.fieldPermissions);
    const scoped = { ...fieldPermissions[entity.name] };
    scoped[field] = withLevel(scoped[field] ?? {}, action, level);
    fieldPermissions[entity.name] = scoped;
    void write(role, { fieldPermissions }, t('web.entityAdmin.fieldAccessUpdated'));
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t('web.entityAdmin.recordAccess', { entity: entity.name })}
        </Typography.Title>
        <Typography.Text type="secondary">{t('web.entityAdmin.recordAccessHint')}</Typography.Text>
        {roles.isError ? <Alert type="error" showIcon style={{ marginTop: 8 }} message={t('web.adminPortals.rolesLoadFailed')} description={roles.error instanceof Error ? roles.error.message : t('web.entityAdmin.unknownError')} /> : null}
        <Table
          rowKey="id"
          size="small"
          style={{ marginTop: 8 }}
          loading={roles.isLoading}
          dataSource={list}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('web.entityAdmin.noRoles') }}
          columns={[
            { title: t('web.entityAdmin.role'), dataIndex: 'name', width: 180 },
            ...ACL_ACTIONS.map((action) => ({
              title: action,
              key: action,
              width: 130,
              render: (_: unknown, row: Role) => (
                <Select size="small" aria-label={t('web.entityAdmin.accessAria', { action, name: row.name })} value={levelOf(row, action)} style={{ width: 110 }} options={levelOptions()} onChange={(level: string) => setLevel(row, action, level)} />
              ),
            })),
          ]}
        />
      </div>

      <div>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={8} md={6}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('web.entityAdmin.fieldAccess')}
            </Typography.Title>
          </Col>
          <Col xs={24} sm={16} md={8}>
            <label htmlFor="field-access-role">{t('web.entityAdmin.role')}</label>
            <Select
              id="field-access-role"
              style={{ width: '100%' }}
              value={fieldRoleId ?? null}
              placeholder={t('web.entityAdmin.chooseRole')}
              options={list.map((role) => ({ value: role.id, label: role.name }))}
              onChange={(value: string) => setFieldRoleId(value)}
            />
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
          {t('web.entityAdmin.fieldAccessHint', { entity: entity.name })}
        </Typography.Paragraph>
        {fieldRole ? (
          <Table
            rowKey="field"
            size="small"
            dataSource={fields.map((field) => ({ field }))}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            locale={{ emptyText: t('web.entityAdmin.noEditableFields') }}
            columns={[
              { title: t('web.entityAdmin.field'), dataIndex: 'field' },
              ...FIELD_ACL_ACTIONS.map((action) => ({
                title: action,
                key: action,
                width: 130,
                render: (_: unknown, row: { field: string }) => (
                  <Select size="small" aria-label={t('web.entityAdmin.accessAria', { action, name: row.field })} value={fieldLevelOf(fieldRole, row.field, action)} style={{ width: 110 }} options={levelOptions()} onChange={(level: string) => setFieldLevel(fieldRole, row.field, action, level)} />
                ),
              })),
            ]}
          />
        ) : (
          <Alert type="info" showIcon message={t('web.entityAdmin.pickRole')} />
        )}
      </div>
    </Space>
  );
}

/** Declarative index metadata (PLAN §8). No physical index is ever created from here. */
function IndexTab({ entity, save }: MetadataTabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<IndexDraft>();
  const indexes = useMemo(() => entity.indexes ?? [], [entity]);
  const fields = useMemo(() => indexableFieldNames(entity), [entity]);
  const names = useMemo(() => new Set(indexes.map((index) => index.name)), [indexes]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('web.entityAdmin.indexesTitle')}
        description={t('web.entityAdmin.indexesHint')}
      />
      <Table
        rowKey="name"
        size="small"
        dataSource={indexes}
        pagination={false}
        locale={{ emptyText: t('web.entityAdmin.noIndexes') }}
        columns={[
          { title: t('web.common.name'), dataIndex: 'name', width: 200 },
          { title: t('web.entityAdmin.fields'), key: 'fields', render: (_: unknown, row: IndexDefinition) => (row.fields.length > 0 ? row.fields.join(', ') : '—') },
          {
            title: t('web.entityAdmin.unique'),
            dataIndex: 'unique',
            width: 100,
            render: (value: boolean) => (value ? <Tag color="gold">{t('web.entityAdmin.unique')}</Tag> : <Tag>{t('core.common.no')}</Tag>),
          },
          {
            title: '',
            key: 'remove',
            width: 90,
            render: (_: unknown, row: IndexDefinition) => (
              <Popconfirm title={t('web.entityAdmin.removeIndexConfirm', { name: row.name })} okText={t('web.entityAdmin.remove')} onConfirm={() => save({ indexes: indexes.filter((index) => index.name !== row.name) }, t('web.entityAdmin.indexRemoved'))}>
                <Button danger type="text" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.removeIndexAria', { name: row.name })} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ unique: false }}
        onFinish={(values: IndexDraft) => {
          const name = (values.name ?? '').trim();
          const members = (values.fields ?? []).filter((field) => field !== '');
          if (name === '') {
            void message.error(t('web.entityAdmin.indexNameRequired'));
            return;
          }
          if (names.has(name)) {
            void message.error(t('web.entityAdmin.indexExists', { name }));
            return;
          }
          if (members.length === 0) {
            void message.error(t('web.entityAdmin.indexFieldsRequired'));
            return;
          }
          const index: IndexDefinition = { name, fields: members, unique: values.unique === true };
          save({ indexes: [...indexes, index] }, t('web.entityAdmin.indexSaved'));
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.indexName')}>
              <Input placeholder="indexName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={10}>
            <Form.Item name="fields" label={t('web.entityAdmin.fields')}>
              <Select mode="multiple" style={{ width: '100%' }} placeholder={t('web.entityAdmin.fieldsToIndexPlaceholder')} options={fields.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="unique" label={t('web.entityAdmin.unique')} valuePropName="checked">
              <Switch size="small" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          {t('web.entityAdmin.addIndex')}
        </Button>
      </Form>
    </Space>
  );
}

/**
 * Entity editor (PLAN §8): one entity, one tab per metadata concern.
 *
 * Reached from the Entity Manager list, so the admin never edits an entity they did not open, and
 * the active tab lives in the URL to keep a deep link (or a browser back) meaningful.
 */
export function EntityAdminPage() {
  const { entityName } = useParams<{ entityName: string }>();
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const [searchParams, setSearchParams] = useSearchParams();

  const entity = entityName ? metadata.data?.[entityName] : undefined;
  const tab = searchParams.get('tab') ?? 'fields';

  const patch = async (body: Record<string, unknown>, okText: string) => {
    if (!entity) return;
    try {
      await api.patchEntity(entity.name, body);
      void message.success(okText);
      await metadata.refetch();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.entityAdmin.changeFailed'));
    }
  };

  if (metadata.isLoading) return <Card className="lizant-card" loading />;
  if (!entity) {
    return (
      <Card className="lizant-card" title={entityName ?? t('web.entityAdmin.entityFallback')}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('web.entityAdmin.notFound', { name: entityName ?? '' })} />
        <div style={{ textAlign: 'center' }}>
          <Link to="/admin/entity-manager">
            <Button icon={<ArrowLeftOutlined />}>{t('web.entityAdmin.backToEntities')}</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const rules = currentRules(entity);
  const fieldCount = Object.keys(entity.fields).length;
  const relationCount = Object.keys(entity.relations).length;

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <Space size={8} wrap>
            <Link to="/admin/entity-manager" aria-label={t('web.entityAdmin.backToEntities')}>
              <Button size="small" icon={<ArrowLeftOutlined />} />
            </Link>
            <h1 className="lizant-page-title">{entity.label}</h1>
            <Tag>{entity.name}</Tag>
            {entity.isEntity ? <Tag color="green">{t('web.entityAdmin.enabled')}</Tag> : <Tag color="red">{t('web.entityAdmin.disabled')}</Tag>}
          </Space>
          <p className="lizant-page-sub">{t('web.entityAdmin.summary', { fields: String(fieldCount), relations: String(relationCount), rules: String(rules.length) })}</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={metadata.isFetching} onClick={() => void metadata.refetch()}>
            {t('core.common.refresh')}
          </Button>
          <Link to={`/${entity.name}`}>
            <Button>{t('web.entityAdmin.viewRecords')}</Button>
          </Link>
        </Space>
      </div>

      <Card className="lizant-card">
        <Tabs
          activeKey={tab}
          onChange={(next) => setSearchParams({ tab: next }, { replace: true })}
          items={[
            { key: 'fields', label: t('web.entityAdmin.tabFields', { n: String(fieldCount) }), children: <FieldsTab entity={entity} patch={patch} /> },
            { key: 'relations', label: t('web.entityAdmin.tabRelations', { n: String(relationCount) }), children: <RelationsTab entity={entity} patch={patch} /> },
            { key: 'logic', label: t('web.entityAdmin.tabLogic', { n: String(rules.length) }), children: <LogicTab entity={entity} patch={patch} /> },
            { key: 'layout', label: t('web.entityAdmin.tabLayout'), children: <LayoutTab entity={entity} save={patch} /> },
            { key: 'access', label: t('web.entityAdmin.tabAccess'), children: <AccessTab entity={entity} /> },
            { key: 'indexes', label: t('web.entityAdmin.tabIndexes'), children: <IndexTab entity={entity} save={patch} /> },
            { key: 'settings', label: t('web.entityAdmin.tabSettings'), children: <SettingsTab entity={entity} patch={patch} /> },
          ]}
        />
      </Card>
    </>
  );
}
