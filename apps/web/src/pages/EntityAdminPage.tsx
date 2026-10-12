import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Empty, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition, FieldDefinition, IndexDefinition, LayoutDefinition, LayoutPanel, LayoutViewType, Role } from '../api/types.js';
import { useMetadata } from '../state/metadata.js';

const FIELD_TYPES = ['varchar', 'text', 'int', 'float', 'decimal', 'bool', 'date', 'datetime', 'enum', 'multiEnum', 'currency', 'url', 'email', 'phone', 'link', 'linkMultiple', 'formula'];
const RELATION_TYPES = ['oneToMany', 'manyToOne', 'manyToMany'];

/** Views an admin can lay out by hand (PLAN §8). */
const LAYOUT_VIEWS: LayoutViewType[] = ['list', 'detail', 'edit'];

/** Record actions a role can be granted on an entity (PLAN §8). */
const ACL_ACTIONS = ['create', 'read', 'edit', 'delete', 'stream'] as const;
/** Record access levels, from "everything" down to "nothing" (PLAN §8). */
const ACL_LEVELS = ['yes', 'all', 'team', 'own', 'no'] as const;
const FIELD_ACL_ACTIONS = ['read', 'edit'] as const;

const LEVEL_OPTIONS = [{ value: '', label: 'inherit' }, ...ACL_LEVELS.map((level) => ({ value: level, label: level }))];

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

const RULE_ACTIONS = [
  { value: 'setRequired', label: 'Make required' },
  { value: 'hide', label: 'Hide fields' },
  { value: 'show', label: 'Show fields' },
  { value: 'setReadOnly', label: 'Make read-only' },
  { value: 'error', label: 'Block the save' },
];

interface FieldDraft {
  name: string;
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
  if (draft.action === 'error') then.error = { message: draft.message ?? 'This record does not meet a validation rule.', ...(targets.length > 0 ? { fields: targets } : {}) };
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
      <Form form={form} layout="vertical" initialValues={{ label: entity.label }} onFinish={(values: { label: string }) => void patch({ label: values.label }, 'Label updated.')}>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Form.Item name="label" label="Label" rules={[{ required: true, message: 'A label is required.' }]} extra={`Technical name: ${entity.name}`}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={16}>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit">
              Rename
            </Button>
          </Col>
        </Row>
      </Form>

      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {entity.isEntity ? 'Entity is enabled' : 'Entity is disabled'}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          A disabled definition keeps its fields, records and metadata but drops out of navigation, search and the generated forms. Re-enable it to make it a working entity again.
        </Typography.Paragraph>
        <Popconfirm
          title={entity.isEntity ? `Disable ${entity.name}?` : `Enable ${entity.name}?`}
          okText={entity.isEntity ? 'Disable' : 'Enable'}
          onConfirm={() => void patch({ isEntity: !entity.isEntity }, 'Entity updated.')}
        >
          <Button danger={entity.isEntity}>
            {entity.isEntity ? 'Disable entity' : 'Enable entity'}
          </Button>
        </Popconfirm>
      </div>
    </Space>
  );
}

/** Field definitions of one entity (PLAN §8). */
function FieldsTab({ entity, patch }: { entity: EntityDefinition; patch: (body: Record<string, unknown>, okText: string) => void }) {
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const [form] = Form.useForm<FieldDraft>();
  const fieldType = Form.useWatch('type', form);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Table
        rowKey="name"
        size="small"
        dataSource={Object.entries(entity.fields).map(([name, field]) => ({ name, ...field }))}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          {
            title: 'Type',
            dataIndex: 'type',
            render: (type: string, row) => (
              <Space size={4} wrap>
                <Tag>{type}</Tag>
                {row.entityKey ? <Tag color="blue">→ {row.entityKey}</Tag> : null}
              </Space>
            ),
          },
          { title: 'Required', dataIndex: 'required', render: (value: boolean | undefined) => (value ? 'yes' : 'no') },
          {
            title: '',
            key: 'disable',
            render: (_: unknown, row) =>
              row.type === 'disabled' ? (
                <Tag>disabled</Tag>
              ) : (
                <Popconfirm
                  title={`Disable field ${row.name}?`}
                  description="The column and its data stay; the field is retired from the entity definition."
                  okText="Disable"
                  onConfirm={() => void api.disableField(entity.name, row.name).then(() => metadata.refetch()).catch((error: unknown) => message.error(error instanceof Error ? error.message : 'Failed'))}
                >
                  <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Disable field ${row.name}`} />
                </Popconfirm>
              ),
          },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          const draft = values as FieldDraft;
          await patch({ fields: { [draft.name]: buildFieldDefinition(draft) } }, 'Field added.');
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label="Field name" rules={[{ required: true, pattern: /^[a-z][A-Za-z0-9]{1,40}$/, message: 'camelCase name' }]}>
              <Input placeholder="fieldName" />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Form.Item name="type" label="Type" initialValue="varchar">
              <Select style={{ width: '100%' }} options={FIELD_TYPES.map((type) => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Form.Item name="entityKey" label="Link entity">
              <Select style={{ width: '100%' }} placeholder="link entity" allowClear options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={3}>
            <Form.Item name="maxLength" label="Max length">
              <InputNumber style={{ width: '100%' }} min={1} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6} md={7}>
            <Form.Item name="values" label="Enum values">
              <Input placeholder="enum values, comma" />
            </Form.Item>
          </Col>
          {fieldType === 'formula' ? (
            <Col xs={24}>
              <Form.Item name="formula" label="Formula" rules={[{ required: true, message: 'A formula field needs an expression.' }]}>
                <Input placeholder="concat(field('firstName'), ' ', field('lastName'))" />
              </Form.Item>
            </Col>
          ) : null}
          <Col xs={8} md={4}>
            <Form.Item name="required" label="Required" valuePropName="checked">
              <Switch size="small" />
            </Form.Item>
          </Col>
          <Col xs={8} md={4}>
            <Form.Item name="inList" label="In list" valuePropName="checked" initialValue>
              <Switch size="small" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          Add field
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
        locale={{ emptyText: 'No rules yet. A rule can require, hide, compute or block a field when another field changes.' }}
        columns={[
          { title: 'Name', dataIndex: 'name', width: 140, render: (_: unknown, row: LogicRule) => String(row.name ?? '—') },
          { title: 'When', key: 'when', render: (_: unknown, row: LogicRule) => <Typography.Text code>{describeWhen(row.when)}</Typography.Text> },
          { title: 'Then', key: 'then', render: (_: unknown, row: LogicRule) => describeThen(row.then) },
          {
            title: '',
            key: 'remove',
            width: 80,
            render: (_: unknown, row: LogicRule) => (
              <Popconfirm title={`Remove rule ${String(row.name ?? 'this rule')}?`} okText="Remove" onConfirm={() => void patch({ dynamicLogic: { rules: rules.filter((rule) => rule !== row) } }, 'Rule removed.')}>
                <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Remove rule ${String(row.name ?? '')}`} />
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
          await patch({ dynamicLogic: { rules: [...rules, buildRule(draft)] } }, 'Rule added.');
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label="Rule name">
              <Input placeholder="rule name" />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="whenField" label="When field" rules={[{ required: true }]}>
              <Select style={{ width: '100%' }} placeholder="when field" options={fieldNames.map((name) => ({ value: name, label: name }))} showSearch />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="whenOperator" label="Operator" initialValue="equals">
              <Select style={{ width: '100%' }} options={CRITERIA_OPERATORS.map((operator) => ({ value: operator, label: operator }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="whenValue" label="Compare value">
              <Input placeholder="compare value" />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="action" label="Then action" initialValue="setRequired">
              <Select style={{ width: '100%' }} options={RULE_ACTIONS} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="targets" label="Then fields">
              <Select style={{ width: '100%' }} mode="multiple" placeholder="then fields" options={fieldNames.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="message" label="Message for a blocked save">
              <Input style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
            Add rule
          </Button>
          {rules.length > 0 ? (
            <Popconfirm title="Remove every dynamic logic rule of this entity?" okText="Clear" onConfirm={() => void patch({ dynamicLogic: { rules: [] } }, 'Rules cleared.')}>
              <Button danger icon={<DeleteOutlined />}>
                Clear all rules
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
        locale={{ emptyText: 'No relations yet.' }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Type', dataIndex: 'type' },
          { title: 'Target', dataIndex: 'target' },
          { title: 'Mapped by', dataIndex: 'mappedBy' },
        ]}
      />
      <Form
        layout="vertical"
        onFinish={(values) => {
          const draft = values as { name: string; type: string; target: string; mappedBy?: string };
          void patch({ relations: { [draft.name]: { type: draft.type, target: draft.target, ...(draft.mappedBy ? { mappedBy: draft.mappedBy } : {}) } } }, 'Relation added.');
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label="Relation name" rules={[{ required: true }]}>
              <Input placeholder="relationName" />
            </Form.Item>
          </Col>
          <Col xs={12} md={5}>
            <Form.Item name="type" label="Type" initialValue="oneToMany">
              <Select style={{ width: '100%' }} options={RELATION_TYPES.map((type) => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="target" label="Target entity" rules={[{ required: true }]}>
              <Select style={{ width: '100%' }} placeholder="target entity" options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={7}>
            <Form.Item name="mappedBy" label="Mapped by">
              <Input placeholder="mappedBy" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          Add relation
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
          <label htmlFor="layout-view">View</label>
          <Select id="layout-view" style={{ width: '100%' }} value={view} options={LAYOUT_VIEWS.map((value) => ({ value, label: value }))} onChange={(value: LayoutViewType) => setView(value)} />
        </Col>
        <Col xs={24} sm={16} md={18}>
          <Typography.Text type="secondary">{`${String(panels.length)} panel(s) laid out for the ${view} view.`}</Typography.Text>
        </Col>
      </Row>

      {panels.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No panels for this view yet — add one below" />
      ) : (
        <Row gutter={[12, 12]}>
          {panels.map((panel, index) => (
            <Col key={`${panel.name}-${String(index)}`} xs={24} md={12} xl={8}>
              <Card
                className="lizant-card"
                size="small"
                title={panel.label ?? panel.name}
                extra={
                  <Popconfirm title={`Remove panel ${panel.name}?`} okText="Remove" onConfirm={() => save(layoutSection(entity, view, panels.filter((candidate) => candidate !== panel)), 'Layout saved.')}>
                    <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Remove panel ${panel.name}`} />
                  </Popconfirm>
                }
              >
                <Space size={4} wrap>
                  <Tag>{panel.name}</Tag>
                  <Tag color="blue">{`position ${String(panel.position)}`}</Tag>
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {(panel.fields ?? []).length > 0 ? (panel.fields ?? []).join(', ') : 'No fields assigned — the generated view fills this panel.'}
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
            void message.error('A panel needs a name.');
            return;
          }
          if (members.length === 0) {
            void message.error('Select at least one member field.');
            return;
          }
          const label = values.label?.trim() ?? '';
          const panel: LayoutPanel = { name, position: values.position ?? 0, fields: members, ...(label === '' ? {} : { label }) };
          save(layoutSection(entity, view, [...panels, panel]), 'Layout saved.');
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label="Panel name" rules={[{ required: true, message: 'Panel name' }]}>
              <Input placeholder="panelName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="label" label="Label">
              <Input placeholder="Display label" />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="position" label="Position" initialValue={0}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="fields" label="Member fields">
              <Select mode="multiple" style={{ width: '100%' }} placeholder="member fields" options={fields.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          Add panel
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
      void message.error(error instanceof Error ? error.message : 'Failed.');
    }
  };

  const levelOf = (role: Role, action: AclAction): string => role.permissions[entity.name]?.[action] ?? role.permissions['*']?.[action] ?? '';

  const setLevel = (role: Role, action: AclAction, level: string) => {
    const permissions = copyPermissions(role.permissions);
    permissions[entity.name] = withLevel(permissions[entity.name] ?? {}, action, level);
    void write(role, { permissions }, 'Access updated.');
  };

  const fieldLevelOf = (role: Role, field: string, action: FieldAclAction): string => role.fieldPermissions[entity.name]?.[field]?.[action] ?? '';

  const setFieldLevel = (role: Role, field: string, action: FieldAclAction, level: string) => {
    const fieldPermissions = copyFieldPermissions(role.fieldPermissions);
    const scoped = { ...fieldPermissions[entity.name] };
    scoped[field] = withLevel(scoped[field] ?? {}, action, level);
    fieldPermissions[entity.name] = scoped;
    void write(role, { fieldPermissions }, 'Field access updated.');
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {`Record access — ${entity.name}`}
        </Typography.Title>
        <Typography.Text type="secondary">A level applies to every record of the entity. "inherit" falls back to the role's "*" scope.</Typography.Text>
        {roles.isError ? <Alert type="error" showIcon style={{ marginTop: 8 }} message="Could not load roles." description={roles.error instanceof Error ? roles.error.message : 'Unknown error.'} /> : null}
        <Table
          rowKey="id"
          size="small"
          style={{ marginTop: 8 }}
          loading={roles.isLoading}
          dataSource={list}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No roles yet — create one before assigning entity access.' }}
          columns={[
            { title: 'Role', dataIndex: 'name', width: 180 },
            ...ACL_ACTIONS.map((action) => ({
              title: action,
              key: action,
              width: 130,
              render: (_: unknown, row: Role) => (
                <Select size="small" aria-label={`${action} access for ${row.name}`} value={levelOf(row, action)} style={{ width: 110 }} options={LEVEL_OPTIONS} onChange={(level: string) => setLevel(row, action, level)} />
              ),
            })),
          ]}
        />
      </div>

      <div>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={8} md={6}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              Field access
            </Typography.Title>
          </Col>
          <Col xs={24} sm={16} md={8}>
            <label htmlFor="field-access-role">Role</label>
            <Select
              id="field-access-role"
              style={{ width: '100%' }}
              value={fieldRoleId ?? null}
              placeholder="Choose a role"
              options={list.map((role) => ({ value: role.id, label: role.name }))}
              onChange={(value: string) => setFieldRoleId(value)}
            />
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
          {`Field levels only affect the fields of ${entity.name}; "inherit" falls back to the entity record level.`}
        </Typography.Paragraph>
        {fieldRole ? (
          <Table
            rowKey="field"
            size="small"
            dataSource={fields.map((field) => ({ field }))}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            locale={{ emptyText: 'No editable fields on this entity.' }}
            columns={[
              { title: 'Field', dataIndex: 'field' },
              ...FIELD_ACL_ACTIONS.map((action) => ({
                title: action,
                key: action,
                width: 130,
                render: (_: unknown, row: { field: string }) => (
                  <Select size="small" aria-label={`${action} access for ${row.field}`} value={fieldLevelOf(fieldRole, row.field, action)} style={{ width: 110 }} options={LEVEL_OPTIONS} onChange={(level: string) => setFieldLevel(fieldRole, row.field, action, level)} />
                ),
              })),
            ]}
          />
        ) : (
          <Alert type="info" showIcon message="Pick a role to edit its field access." />
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
        message="Indexes are declarative metadata."
        description="Adding or removing an index only updates the entity definition. A reviewed migration creates or drops the physical database index — the app never alters the schema on its own."
      />
      <Table
        rowKey="name"
        size="small"
        dataSource={indexes}
        pagination={false}
        locale={{ emptyText: 'No indexes declared.' }}
        columns={[
          { title: 'Name', dataIndex: 'name', width: 200 },
          { title: 'Fields', key: 'fields', render: (_: unknown, row: IndexDefinition) => (row.fields.length > 0 ? row.fields.join(', ') : '—') },
          {
            title: 'Unique',
            dataIndex: 'unique',
            width: 100,
            render: (value: boolean) => (value ? <Tag color="gold">unique</Tag> : <Tag>no</Tag>),
          },
          {
            title: '',
            key: 'remove',
            width: 90,
            render: (_: unknown, row: IndexDefinition) => (
              <Popconfirm title={`Remove index ${row.name}?`} okText="Remove" onConfirm={() => save({ indexes: indexes.filter((index) => index.name !== row.name) }, 'Index removed.')}>
                <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Remove index ${row.name}`} />
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
            void message.error('An index needs a name.');
            return;
          }
          if (names.has(name)) {
            void message.error(`Index ${name} already exists on this entity.`);
            return;
          }
          if (members.length === 0) {
            void message.error('Select at least one field to index.');
            return;
          }
          const index: IndexDefinition = { name, fields: members, unique: values.unique === true };
          save({ indexes: [...indexes, index] }, 'Index saved.');
          form.resetFields();
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Form.Item name="name" label="Index name">
              <Input placeholder="indexName" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} md={10}>
            <Form.Item name="fields" label="Fields">
              <Select mode="multiple" style={{ width: '100%' }} placeholder="fields to index" options={fields.map((name) => ({ value: name, label: name }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="unique" label="Unique" valuePropName="checked">
              <Switch size="small" />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<PlusOutlined />} htmlType="submit">
          Add index
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
      void message.error(error instanceof Error ? error.message : 'Metadata change failed.');
    }
  };

  if (metadata.isLoading) return <Card className="lizant-card" loading />;
  if (!entity) {
    return (
      <Card className="lizant-card" title={entityName ?? 'Entity'}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`No entity "${entityName ?? ''}" in this workspace.`} />
        <div style={{ textAlign: 'center' }}>
          <Link to="/admin/entity-manager">
            <Button icon={<ArrowLeftOutlined />}>Back to entities</Button>
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
            <Link to="/admin/entity-manager" aria-label="Back to entities">
              <Button size="small" icon={<ArrowLeftOutlined />} />
            </Link>
            <h1 className="lizant-page-title">{entity.label}</h1>
            <Tag>{entity.name}</Tag>
            {entity.isEntity ? <Tag color="green">enabled</Tag> : <Tag color="red">disabled</Tag>}
          </Space>
          <p className="lizant-page-sub">{`${String(fieldCount)} field(s) · ${String(relationCount)} relation(s) · ${String(rules.length)} logic rule(s)`}</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={metadata.isFetching} onClick={() => void metadata.refetch()}>
            Refresh
          </Button>
          <Link to={`/${entity.name}`}>
            <Button>View records</Button>
          </Link>
        </Space>
      </div>

      <Card className="lizant-card">
        <Tabs
          activeKey={tab}
          onChange={(next) => setSearchParams({ tab: next }, { replace: true })}
          items={[
            { key: 'fields', label: `Fields (${String(fieldCount)})`, children: <FieldsTab entity={entity} patch={patch} /> },
            { key: 'relations', label: `Relations (${String(relationCount)})`, children: <RelationsTab entity={entity} patch={patch} /> },
            { key: 'logic', label: `Logic (${String(rules.length)})`, children: <LogicTab entity={entity} patch={patch} /> },
            { key: 'layout', label: 'Layout', children: <LayoutTab entity={entity} save={patch} /> },
            { key: 'access', label: 'Access', children: <AccessTab entity={entity} /> },
            { key: 'indexes', label: 'Indexes', children: <IndexTab entity={entity} save={patch} /> },
            { key: 'settings', label: 'Settings', children: <SettingsTab entity={entity} patch={patch} /> },
          ]}
        />
      </Card>
    </>
  );
}
