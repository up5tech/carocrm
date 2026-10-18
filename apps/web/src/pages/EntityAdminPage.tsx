import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { closestCorners, type CollisionDetection, DndContext, type DragEndEvent, type DragOverEvent, DragOverlay, type DragStartEvent, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Radio, Row, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition, FieldDefinition, IndexDefinition, LayoutDefinition, LayoutPanel, LayoutViewType, Role } from '../api/types.js';
import { defaultIconName,ENTITY_ICONS } from '../components/entityIcons.js';
import { useNavigationGroupKeys } from '../state/admin.js';
import { t } from '../state/i18n.js';
import { boardGroupFields, fieldLabel, useMetadata } from '../state/metadata.js';

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

/** Label, icon and entity-enabled state — the flags that decide how the entity looks and is usable. */
function SettingsTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const [form] = Form.useForm<{ label: string; icon: string }>();
  const builtInIcon = defaultIconName(entity.name);
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ label: entity.label, icon: entity.icon ?? builtInIcon ?? '' }}
        onFinish={(values: { label: string; icon: string }) =>
          // Picking the entity's built-in icon is the same as having no choice at all, so it is
          // stored as null and stays a default rather than an override.
          void patch({ label: values.label, icon: values.icon === '' || values.icon === builtInIcon ? null : values.icon }, t('web.entityAdmin.settingsUpdated'))
        }
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Form.Item name="label" label={t('web.entityAdmin.label')} rules={[{ required: true, message: t('web.entityAdmin.labelRequired') }]} extra={t('web.entityAdmin.technicalName', { name: entity.name })}>
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="icon" label={t('web.entityAdmin.iconLabel')} extra={t('web.entityAdmin.iconHint')}>
          <Radio.Group className="carocrm-icon-picker" optionType="button">
            <Radio.Button value="">{t('web.entityAdmin.iconDefault')}</Radio.Button>
            {Object.entries(ENTITY_ICONS).map(([name, icon]) => (
              <Radio.Button key={name} value={name} aria-label={name}>
                {icon}
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>
        <Button type="primary" icon={<SaveOutlined />} htmlType="submit">
          {t('web.common.save')}
        </Button>
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

/**
 * Navigation tab (PLAN_Phase_20_Settings_UX.md §4.5): how this entity behaves in the main menu.
 *
 * These values are metadata, edited through the same `POST /Metadata/:entity` path as every other
 * section, and the server resolves them into `GET /Navigation`. Hiding an entity removes it from the
 * menu only — the records, the list URL and the API stay reachable, because hiding is presentation and
 * the ACL is the enforcement.
 */
function NavigationTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const groups = useNavigationGroupKeys();
  const boardFields = boardGroupFields(entity);
  const [form] = Form.useForm<{ group: string | null; order: number | null; hidden: boolean; defaultGroupBy: string | null }>();

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        group: entity.nav?.group ?? null,
        order: entity.nav?.order ?? null,
        hidden: entity.nav?.hidden === true,
        defaultGroupBy: entity.nav?.board?.defaultGroupBy ?? null,
      }}
      onFinish={(values: { group: string | null; order: number | null; hidden: boolean; defaultGroupBy: string | null }) =>
        // A field left empty is stored as null, which the resolver reads as "no override", so the
        // entity falls back to the shipped group and order rather than to a blank value.
        void patch(
          {
            nav: {
              hidden: values.hidden,
              group: values.group === '' ? null : values.group,
              order: values.order ?? null,
              board: {
                enabled: values.defaultGroupBy !== null,
                ...(values.defaultGroupBy === null ? {} : { defaultGroupBy: values.defaultGroupBy }),
              },
            },
          },
          t('web.entityAdmin.navUpdated'),
        )
      }
    >
      <Row gutter={[12, 12]}>
        <Col xs={24} md={10}>
          <Form.Item name="group" label={t('web.entityAdmin.navGroup')} extra={t('web.entityAdmin.navGroupHint')}>
            <Select allowClear placeholder={t('web.entityAdmin.navGroupDefault')} options={groups.map((key) => ({ value: key, label: key }))} />
          </Form.Item>
        </Col>
        <Col xs={24} md={7}>
          <Form.Item name="order" label={t('web.entityAdmin.navOrder')} extra={t('web.entityAdmin.navOrderHint')}>
            <InputNumber style={{ width: '100%' }} min={-100000} max={100000} placeholder="1000" />
          </Form.Item>
        </Col>
        <Col xs={24} md={7}>
          <Form.Item name="defaultGroupBy" label={t('web.entityAdmin.navBoardGroupBy')} extra={t('web.entityAdmin.navBoardGroupByHint')}>
            <Select allowClear options={boardFields.map((entry) => ({ value: entry.name, label: entry.field.label ?? entry.name }))} />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="hidden" label={t('web.entityAdmin.navHidden')} valuePropName="checked" extra={t('web.entityAdmin.navHiddenHint')}>
        <Switch checkedChildren={t('core.common.yes')} unCheckedChildren={t('core.common.no')} />
      </Form.Item>
      <Button type="primary" icon={<SaveOutlined />} htmlType="submit">
        {t('web.common.save')}
      </Button>
    </Form>
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
  const [rename, setRename] = useState<{ name: string; label: string } | null>(null);

  // A relation patch replaces the whole entry, so a label edit sends the definition back with only
  // its label changed. An empty label clears it, and the panel falls back to the relation name.
  const renameRelation = () => {
    const relation = rename ? entity.relations[rename.name] : undefined;
    if (!rename || !relation) return;
    const label = rename.label.trim();
    patch({ relations: { [rename.name]: { ...relation, ...(label === '' ? { label: null } : { label }) } } }, t('web.entityAdmin.relationLabelUpdated'));
    setRename(null);
  };

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
          {
            title: t('web.entityAdmin.label'),
            dataIndex: 'label',
            render: (value: string | undefined, row) => value ?? fieldLabel(row.name),
          },
          { title: t('web.entityAdmin.type'), dataIndex: 'type' },
          { title: t('web.entityAdmin.target'), dataIndex: 'target' },
          { title: t('web.entityAdmin.mappedBy'), dataIndex: 'mappedBy' },
          {
            title: '',
            key: 'rename',
            render: (_: unknown, row) => (
              <Button
                type="text"
                icon={<EditOutlined />}
                aria-label={t('web.entityAdmin.editRelationLabelAria', { name: row.name })}
                onClick={() => setRename({ name: row.name, label: row.label ?? '' })}
              />
            ),
          },
        ]}
      />
      <Modal
        title={rename ? t('web.entityAdmin.relationLabelTitle', { name: rename.name }) : t('web.entityAdmin.relationLabel')}
        open={rename !== null}
        okText={t('web.common.save')}
        cancelText={t('web.entityAdmin.cancel')}
        onOk={renameRelation}
        onCancel={() => setRename(null)}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t('web.entityAdmin.relationLabelHint')}
        </Typography.Paragraph>
        <Input
          aria-label={t('web.entityAdmin.relationLabel')}
          value={rename?.label ?? ''}
          placeholder={fieldLabel(rename?.name ?? '')}
          onChange={(event) => setRename((current) => (current ? { ...current, label: event.target.value } : current))}
          onPressEnter={renameRelation}
        />
      </Modal>
      <Form
        layout="vertical"
        onFinish={(values) => {
          const draft = values as { name: string; type: string; target: string; mappedBy?: string; label?: string };
          const label = draft.label?.trim() ?? '';
          void patch({ relations: { [draft.name]: { type: draft.type, target: draft.target, ...(label !== '' ? { label } : {}), ...(draft.mappedBy ? { mappedBy: draft.mappedBy } : {}) } } }, t('web.entityAdmin.relationAdded'));
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label={t('web.entityAdmin.relationName')} rules={[{ required: true }]}>
              <Input placeholder="relationName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="label" label={t('web.entityAdmin.label')}>
              <Input placeholder={t('web.entityAdmin.displayLabelPlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="type" label={t('web.entityAdmin.type')} initialValue="oneToMany">
              <Select style={{ width: '100%' }} options={RELATION_TYPES.map((type) => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={7}>
            <Form.Item name="target" label={t('web.entityAdmin.targetEntity')} rules={[{ required: true }]}>
              <Select style={{ width: '100%' }} placeholder={t('web.entityAdmin.targetEntityPlaceholder')} options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
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

/** Prefix that keeps panel ids distinguishable from field ids inside one DndContext. */
const PANEL_ID_PREFIX = 'panel:';
/** The pool of member fields no panel of the view places. */
const LAYOUT_POOL_ID = 'disabled';
/** The dashed zone under the groups — dropping here appends the field to the last group. */
const LAYOUT_APPEND_ID = 'append';

interface LayoutDraft {
  panels: LayoutPanel[];
  disabled: string[];
}

/** Editor draft for a view: panels in position order plus every member field not yet placed. */
function layoutDraftOf(entity: EntityDefinition, view: LayoutViewType): LayoutDraft {
  const panels = [...panelsOf(entity, view)].sort((a, b) => a.position - b.position);
  const assigned = new Set(panels.flatMap((panel) => panel.fields ?? []));
  return { panels, disabled: memberFieldNames(entity).filter((name) => !assigned.has(name)) };
}

/** Which draft container currently holds a drag id — panel body, pool, or the chip's owner. */
function layoutContainerOf(state: LayoutDraft, id: string): string | undefined {
  if (id === LAYOUT_POOL_ID) return LAYOUT_POOL_ID;
  if (id.startsWith(PANEL_ID_PREFIX)) {
    const name = id.slice(PANEL_ID_PREFIX.length);
    return state.panels.some((panel) => panel.name === name) ? name : undefined;
  }
  if (state.disabled.includes(id)) return LAYOUT_POOL_ID;
  return state.panels.find((panel) => (panel.fields ?? []).includes(id))?.name;
}

/**
 * Pointer-first collision: the editor's panels shift while a panel is dragged, so a purely
 * geometric fallback (closestCorners) can resolve to a far-away chip once layouts move.
 */
const layoutCollisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  if (byPointer.length > 0) return byPointer;
  const byIntersection = rectIntersection(args);
  if (byIntersection.length > 0) return byIntersection;
  return closestCorners(args);
};

function LayoutFieldRow({ name, label, overlay }: { name: string; label: string; overlay?: boolean }) {
  return (
    <div className="carocrm-layout-row" title={name} style={overlay ? { boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)', cursor: 'grabbing' } : undefined}>
      <HolderOutlined />
      <span>{label}</span>
    </div>
  );
}

function SortableLayoutRow({ name, label }: { name: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: name });
  return (
    <div ref={setNodeRef} className="carocrm-layout-row-wrap" {...attributes} {...listeners} style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}>
      <LayoutFieldRow name={name} label={label} />
    </div>
  );
}

/** A layout panel rendered as a named block of field rows with rename/remove actions. */
function LayoutGroup({ panel, labelOf, onEdit, onRemove }: { panel: LayoutPanel; labelOf: (name: string) => string; onEdit: (name: string) => void; onRemove: (name: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `${PANEL_ID_PREFIX}${panel.name}` });
  const fields = panel.fields ?? [];
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}>
      <div className="carocrm-layout-group">
        <div className="carocrm-layout-group-head">
          <span className="carocrm-board-drag-handle" {...attributes} {...listeners}>
            <HolderOutlined />
          </span>
          <span className="carocrm-layout-group-name">{panel.label ?? panel.name}</span>
          <span className="carocrm-layout-group-count">({fields.length})</span>
          <span style={{ display: 'inline-flex', gap: 2, marginLeft: 'auto' }}>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={t('web.entityAdmin.layoutEditGroupAria', { name: panel.name })} onClick={() => onEdit(panel.name)} />
            <Popconfirm title={t('web.entityAdmin.removePanelConfirm', { name: panel.name })} okText={t('web.entityAdmin.remove')} onConfirm={() => onRemove(panel.name)}>
              <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={t('web.entityAdmin.removePanelAria', { name: panel.name })} />
            </Popconfirm>
          </span>
        </div>
        <div className="carocrm-layout-group-body">
          {fields.length === 0 ? (
            <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 10px' }}>
              {t('web.entityAdmin.layoutPanelEmpty')}
            </Typography.Text>
          ) : (
            <SortableContext items={fields} strategy={verticalListSortingStrategy}>
              <div className="carocrm-layout-rows">
                {fields.map((field) => (
                  <SortableLayoutRow key={field} name={field} label={labelOf(field)} />
                ))}
              </div>
            </SortableContext>
          )}
        </div>
      </div>
    </div>
  );
}

/** The dashed zone under the groups: dropping a field here appends it to the last group. */
function AppendZone({ empty }: { empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: LAYOUT_APPEND_ID });
  return (
    <div ref={setNodeRef} className="carocrm-layout-append" style={{ background: isOver ? '#f0f7ff' : undefined }}>
      {empty ? t('web.entityAdmin.noPanels') : t('web.entityAdmin.layoutDropToEnd')}
    </div>
  );
}

function DisabledPool({ draft, labelOf }: { draft: LayoutDraft; labelOf: (name: string) => string }) {
  const { setNodeRef, isOver } = useDroppable({ id: LAYOUT_POOL_ID });
  return (
    <Card size="small" className="carocrm-card" title={t('web.entityAdmin.layoutDisabled')}>
      <div ref={setNodeRef} className="carocrm-layout-pool" style={{ background: isOver ? '#f0f7ff' : '#fafafa' }}>
        {draft.disabled.length === 0 ? (
          <Typography.Text type="secondary">{t('web.entityAdmin.layoutPoolEmpty')}</Typography.Text>
        ) : (
          <SortableContext items={draft.disabled} strategy={verticalListSortingStrategy}>
            <div className="carocrm-layout-rows">
              {draft.disabled.map((field) => (
                <SortableLayoutRow key={field} name={field} label={labelOf(field)} />
              ))}
            </div>
          </SortableContext>
        )}
      </div>
    </Card>
  );
}

/** Per-view layouts assembled from panels of fields, edited by drag and drop (PLAN §8). */
function LayoutTab({ entity, save }: MetadataTabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PanelDraft>();
  const [view, setView] = useState<LayoutViewType>('detail');
  const [draft, setDraft] = useState<LayoutDraft>(() => layoutDraftOf(entity, view));
  const [dirty, setDirty] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [groupModal, setGroupModal] = useState<{ mode: 'add' } | { mode: 'edit'; original: string } | null>(null);
  const metadata = useMetadata();
  const labelOf = (name: string) => fieldLabel(name, entity.fields?.[name], metadata.data);

  useEffect(() => {
    setDraft(layoutDraftOf(entity, view));
    setDirty(false);
  }, [entity, view]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  /** Moves a field row across containers mid-drag so the drop lands where the pointer is. */
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const fieldId = String(active.id);
    if (fieldId.startsWith(PANEL_ID_PREFIX)) return;
    setDraft((current) => {
      const overId = String(over.id);
      const source = layoutContainerOf(current, fieldId);
      // The append zone targets the last group; everything else resolves to its own container.
      const target = overId === LAYOUT_APPEND_ID ? current.panels[current.panels.length - 1]?.name : layoutContainerOf(current, overId);
      if (!source || !target || source === target) return current;
      let panels = current.panels;
      let disabled = current.disabled;
      if (source === LAYOUT_POOL_ID) disabled = disabled.filter((field) => field !== fieldId);
      else panels = panels.map((panel) => (panel.name === source ? { ...panel, fields: (panel.fields ?? []).filter((field) => field !== fieldId) } : panel));
      if (target === LAYOUT_POOL_ID) {
        const next = [...disabled];
        const overIndex = overId === LAYOUT_POOL_ID ? next.length : next.indexOf(overId);
        next.splice(overIndex < 0 ? next.length : overIndex, 0, fieldId);
        disabled = next;
      } else {
        const targetPanel = panels.find((panel) => panel.name === target);
        if (!targetPanel) return current;
        const fields = [...(targetPanel.fields ?? [])];
        const overIndex = fields.indexOf(overId);
        fields.splice(overIndex < 0 ? fields.length : overIndex, 0, fieldId);
        panels = panels.map((panel) => (panel.name === target ? { ...panel, fields } : panel));
      }
      return { panels, disabled };
    });
    setDirty(true);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const activeIdText = String(active.id);
    const overId = String(over.id);
    if (activeIdText.startsWith(PANEL_ID_PREFIX)) {
      setDraft((current) => {
        let overPanelId = overId;
        if (!overPanelId.startsWith(PANEL_ID_PREFIX)) {
          // Collision usually resolves to a field row inside the target group — map it back.
          if (overPanelId === LAYOUT_POOL_ID || overPanelId === LAYOUT_APPEND_ID) return current;
          const owner = current.panels.find((panel) => (panel.fields ?? []).includes(overPanelId));
          if (!owner) return current;
          overPanelId = `${PANEL_ID_PREFIX}${owner.name}`;
        }
        if (activeIdText === overPanelId) return current;
        const from = current.panels.findIndex((panel) => `${PANEL_ID_PREFIX}${panel.name}` === activeIdText);
        const to = current.panels.findIndex((panel) => `${PANEL_ID_PREFIX}${panel.name}` === overPanelId);
        return from < 0 || to < 0 ? current : { ...current, panels: arrayMove(current.panels, from, to) };
      });
      setDirty(true);
      return;
    }
    setDraft((current) => {
      const source = layoutContainerOf(current, activeIdText);
      if (!source || layoutContainerOf(current, overId) !== source || activeIdText === overId) return current;
      if (source === LAYOUT_POOL_ID) {
        const from = current.disabled.indexOf(activeIdText);
        const to = current.disabled.indexOf(overId);
        return from < 0 || to < 0 ? current : { ...current, disabled: arrayMove(current.disabled, from, to) };
      }
      return {
        ...current,
        panels: current.panels.map((panel) => {
          if (panel.name !== source) return panel;
          const fields = panel.fields ?? [];
          const from = fields.indexOf(activeIdText);
          const to = fields.indexOf(overId);
          return from < 0 || to < 0 ? panel : { ...panel, fields: arrayMove(fields, from, to) };
        }),
      };
    });
    setDirty(true);
  };

  const resetDraft = () => {
    setDraft(layoutDraftOf(entity, view));
    setDirty(false);
  };

  const persistDraft = () => {
    const panels = draft.panels.map((panel, index) => ({ ...panel, position: index }));
    save(layoutSection(entity, view, panels), t('web.entityAdmin.layoutSaved'));
  };

  const openGroupModal = (mode: 'add' | 'edit', original?: string) => {
    if (mode === 'edit' && original) form.setFieldsValue({ name: original, label: draft.panels.find((panel) => panel.name === original)?.label ?? '' });
    else form.resetFields();
    setGroupModal(mode === 'edit' && original ? { mode, original } : { mode: 'add' });
  };

  const submitGroupModal = (values: PanelDraft) => {
    const name = (values.name ?? '').trim();
    if (name === '') {
      void message.error(t('web.entityAdmin.panelNameRequired'));
      return;
    }
    const label = values.label?.trim() ?? '';
    setDraft((current) => {
      const taken = current.panels.some((panel) => panel.name === name && panel.name !== (groupModal?.mode === 'edit' ? groupModal.original : ''));
      if (taken) {
        void message.error(t('web.entityAdmin.panelNameRequired'));
        return current;
      }
      if (groupModal?.mode === 'edit') {
        return { ...current, panels: current.panels.map((panel) => (panel.name === groupModal.original ? { ...panel, name, ...(label === '' ? {} : { label }) } : panel)) };
      }
      return { ...current, panels: [...current.panels, { name, position: current.panels.length, fields: [], ...(label === '' ? {} : { label }) }] };
    });
    setDirty(true);
    setGroupModal(null);
  };

  const removePanel = (name: string) => {
    setDraft((current) => {
      const panel = current.panels.find((candidate) => candidate.name === name);
      if (!panel) return current;
      return {
        panels: current.panels.filter((candidate) => candidate.name !== name),
        disabled: [...current.disabled, ...(panel.fields ?? [])],
      };
    });
    setDirty(true);
  };

  const activeField = activeId !== null && !activeId.startsWith(PANEL_ID_PREFIX) ? activeId : null;
  const activePanel = activeId !== null && activeId.startsWith(PANEL_ID_PREFIX) ? draft.panels.find((panel) => `${PANEL_ID_PREFIX}${panel.name}` === activeId) : undefined;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]} align="middle">
        <Col xs={24} sm={8} md={6}>
          <label htmlFor="layout-view">{t('web.entityAdmin.view')}</label>
          <Select id="layout-view" style={{ width: '100%' }} value={view} options={LAYOUT_VIEWS.map((value) => ({ value, label: value }))} onChange={(value: LayoutViewType) => setView(value)} />
        </Col>
        <Col xs={24} sm={16} md={18}>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Text type="secondary">{t('web.entityAdmin.panelCount', { panels: String(draft.panels.length), view })}</Typography.Text>
            {dirty ? (
              <Space>
                <Typography.Text type="warning">{t('web.entityAdmin.layoutUnsaved')}</Typography.Text>
                <Button icon={<UndoOutlined />} onClick={resetDraft}>
                  {t('web.entityAdmin.layoutReset')}
                </Button>
                <Button type="primary" icon={<SaveOutlined />} onClick={persistDraft}>
                  {t('web.common.save')}
                </Button>
              </Space>
            ) : null}
          </Space>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('web.entityAdmin.layoutEditorHint')}
      </Typography.Paragraph>

      <DndContext sensors={sensors} collisionDetection={layoutCollisionDetection} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              size="small"
              className="carocrm-card"
              title={t('web.entityAdmin.layoutVisible')}
              extra={
                <Button size="small" icon={<PlusOutlined />} onClick={() => openGroupModal('add')}>
                  {t('web.entityAdmin.layoutAddGroup')}
                </Button>
              }
            >
              <SortableContext items={draft.panels.map((panel) => `${PANEL_ID_PREFIX}${panel.name}`)} strategy={verticalListSortingStrategy}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {draft.panels.map((panel) => (
                    <LayoutGroup key={panel.name} panel={panel} labelOf={labelOf} onEdit={(name) => openGroupModal('edit', name)} onRemove={removePanel} />
                  ))}
                </Space>
              </SortableContext>
              <AppendZone empty={draft.panels.length === 0} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <DisabledPool draft={draft} labelOf={labelOf} />
          </Col>
        </Row>
        <DragOverlay dropAnimation={null}>
          {activeField !== null ? <LayoutFieldRow name={activeField} label={labelOf(activeField)} overlay /> : null}
          {activePanel ? (
            <div className="carocrm-layout-group" style={{ width: 340, boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)' }}>
              <div className="carocrm-layout-group-head">
                <HolderOutlined />
                <span className="carocrm-layout-group-name">{activePanel.label ?? activePanel.name}</span>
                <span className="carocrm-layout-group-count">({(activePanel.fields ?? []).length})</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <Modal
        title={groupModal?.mode === 'edit' ? t('web.entityAdmin.layoutEditGroupTitle', { name: groupModal.original }) : t('web.entityAdmin.layoutAddGroup')}
        open={groupModal !== null}
        forceRender
        onCancel={() => setGroupModal(null)}
        onOk={() => form.submit()}
        okText={groupModal?.mode === 'edit' ? t('web.common.save') : t('web.common.add')}
      >
        <Form form={form} layout="vertical" onFinish={submitGroupModal}>
          <Form.Item name="name" label={t('web.entityAdmin.panelName')} rules={[{ required: true, message: t('web.entityAdmin.panelNameRequired') }]}>
            <Input placeholder="panelName" />
          </Form.Item>
          <Form.Item name="label" label={t('web.entityAdmin.label')}>
            <Input placeholder={t('web.entityAdmin.displayLabelPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
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

  if (metadata.isLoading) return <Card className="carocrm-card" loading />;
  if (!entity) {
    return (
      <Card className="carocrm-card" title={entityName ?? t('web.entityAdmin.entityFallback')}>
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
      <div className="carocrm-page-head">
        <div>
          <Space size={8} wrap>
            <Link to="/admin/entity-manager" aria-label={t('web.entityAdmin.backToEntities')}>
              <Button size="small" icon={<ArrowLeftOutlined />} />
            </Link>
            <h1 className="carocrm-page-title">{entity.label}</h1>
            <Tag>{entity.name}</Tag>
            {entity.isEntity ? <Tag color="green">{t('web.entityAdmin.enabled')}</Tag> : <Tag color="red">{t('web.entityAdmin.disabled')}</Tag>}
          </Space>
          <p className="carocrm-page-sub">{t('web.entityAdmin.summary', { fields: String(fieldCount), relations: String(relationCount), rules: String(rules.length) })}</p>
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

      <Card className="carocrm-card">
        <Tabs
          activeKey={tab}
          onChange={(next) => setSearchParams({ tab: next }, { replace: true })}
          items={[
            { key: 'fields', label: t('web.entityAdmin.tabFields', { n: String(fieldCount) }), children: <FieldsTab entity={entity} patch={patch} /> },
            { key: 'relations', label: t('web.entityAdmin.tabRelations', { n: String(relationCount) }), children: <RelationsTab entity={entity} patch={patch} /> },
            { key: 'logic', label: t('web.entityAdmin.tabLogic', { n: String(rules.length) }), children: <LogicTab entity={entity} patch={patch} /> },
            { key: 'layout', label: t('web.entityAdmin.tabLayout'), children: <LayoutTab entity={entity} save={patch} /> },
            { key: 'navigation', label: t('web.entityAdmin.tabNavigation'), children: <NavigationTab key={entity.name} entity={entity} patch={patch} /> },
            { key: 'access', label: t('web.entityAdmin.tabAccess'), children: <AccessTab entity={entity} /> },
            { key: 'indexes', label: t('web.entityAdmin.tabIndexes'), children: <IndexTab entity={entity} save={patch} /> },
            { key: 'settings', label: t('web.entityAdmin.tabSettings'), children: <SettingsTab key={entity.name} entity={entity} patch={patch} /> },
          ]}
        />
      </Card>
    </>
  );
}
