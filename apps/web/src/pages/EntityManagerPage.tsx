import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

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

/** Per-view layouts assembled from panels of fields (PLAN §8). */
function LayoutTab({ entity, save }: MetadataTabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PanelDraft>();
  const [view, setView] = useState<LayoutViewType>('detail');
  const panels = useMemo(() => panelsOf(entity, view), [entity, view]);
  const fields = useMemo(() => memberFieldNames(entity), [entity]);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Typography.Text type="secondary">View</Typography.Text>
        <Select size="small" value={view} style={{ width: 140 }} options={LAYOUT_VIEWS.map((value) => ({ value, label: value }))} onChange={(value: LayoutViewType) => setView(value)} />
        <Typography.Text type="secondary">{`${String(panels.length)} panel(s)`}</Typography.Text>
      </Space>

      {panels.length === 0 ? (
        <Alert type="info" showIcon message="No panels for this view yet." description="Add one below; the generated view then groups its fields inside these panels." />
      ) : (
        panels.map((panel, index) => (
          <Card
            key={`${panel.name}-${String(index)}`}
            className="lizant-card"
            size="small"
            title={panel.label ?? panel.name}
            extra={
              <Popconfirm title={`Remove panel ${panel.name}?`} okText="Remove" onConfirm={() => save(layoutSection(entity, view, panels.filter((candidate) => candidate !== panel)), 'Layout saved.')}>
                <Button size="small" danger type="text">
                  Remove
                </Button>
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
        ))
      )}

      <Form
        form={form}
        layout="inline"
        style={{ rowGap: 8 }}
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
        <Form.Item name="name" rules={[{ required: true, message: 'Panel name' }]}>
          <Input placeholder="panelName" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="label">
          <Input placeholder="label (optional)" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="position" initialValue={0}>
          <InputNumber min={0} style={{ width: 90 }} placeholder="position" />
        </Form.Item>
        <Form.Item name="fields">
          <Select mode="multiple" style={{ width: 260 }} placeholder="member fields" options={fields.map((name) => ({ value: name, label: name }))} />
        </Form.Item>
        <Button size="small" type="primary" htmlType="submit">
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
          pagination={false}
          locale={{ emptyText: 'No roles yet — create one before assigning entity access.' }}
          columns={[
            { title: 'Role', dataIndex: 'name', width: 180 },
            ...ACL_ACTIONS.map((action) => ({
              title: action,
              key: action,
              width: 130,
              render: (_: unknown, row: Role) => (
                <Select size="small" value={levelOf(row, action)} style={{ width: 110 }} options={LEVEL_OPTIONS} onChange={(level: string) => setLevel(row, action, level)} />
              ),
            })),
          ]}
        />
      </div>

      <div>
        <Space size={8} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Field access
          </Typography.Title>
          <Select
            size="small"
            value={fieldRoleId ?? null}
            style={{ width: 220 }}
            placeholder="Choose a role"
            options={list.map((role) => ({ value: role.id, label: role.name }))}
            onChange={(value: string) => setFieldRoleId(value)}
          />
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 8 }}>
          {`Field levels only affect the fields of ${entity.name}; "inherit" falls back to the entity record level.`}
        </Typography.Paragraph>
        {fieldRole ? (
          <Table
            rowKey="field"
            size="small"
            dataSource={fields.map((field) => ({ field }))}
            pagination={false}
            locale={{ emptyText: 'No editable fields on this entity.' }}
            columns={[
              { title: 'Field', dataIndex: 'field' },
              ...FIELD_ACL_ACTIONS.map((action) => ({
                title: action,
                key: action,
                width: 130,
                render: (_: unknown, row: { field: string }) => (
                  <Select size="small" value={fieldLevelOf(fieldRole, row.field, action)} style={{ width: 110 }} options={LEVEL_OPTIONS} onChange={(level: string) => setFieldLevel(fieldRole, row.field, action, level)} />
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
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
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
                <Button size="small" danger type="text">
                  Remove
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Form
        form={form}
        layout="inline"
        style={{ rowGap: 8 }}
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
        <Form.Item name="name">
          <Input placeholder="indexName" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="fields">
          <Select mode="multiple" style={{ width: 260 }} placeholder="fields to index" options={fields.map((name) => ({ value: name, label: name }))} />
        </Form.Item>
        <Form.Item name="unique" valuePropName="checked">
          <Switch size="small" />
        </Form.Item>
        <Button size="small" type="primary" htmlType="submit">
          Add index
        </Button>
      </Form>
    </Space>
  );
}

export function EntityManagerPage() {
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [fieldForm] = Form.useForm<FieldDraft>();
  const [entityForm] = Form.useForm<{ name: string; label: string }>();
  const [ruleForm] = Form.useForm<RuleDraft>();
  const fieldType = Form.useWatch('type', fieldForm);

  const entities = useMemo(() => Object.values(metadata.data ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [metadata.data]);
  const active = useMemo(() => entities.find((entity) => entity.name === selected) ?? undefined, [entities, selected]);
  const rules = useMemo(() => currentRules(active), [active]);
  const fieldNames = useMemo(() => Object.keys(active?.fields ?? {}), [active]);

  const refresh = async () => {
    await metadata.refetch();
  };

  const patch = async (entity: string, body: Record<string, unknown>, okText: string) => {
    try {
      await api.patchEntity(entity, body);
      void message.success(okText);
      await refresh();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Metadata change failed.');
    }
  };

  /** Metadata write bound to the selected entity — shared by the Layout and Index tabs. */
  const save = (body: Record<string, unknown>, okText: string) => {
    if (active) void patch(active.name, body, okText);
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        className="lizant-card"
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Entity Manager</Typography.Title>}
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            New entity
          </Button>
        }
      >
        <Table
          rowKey="name"
          size="small"
          loading={metadata.isLoading}
          dataSource={entities}
          pagination={false}
          onRow={(record) => ({ onClick: () => setSelected(record.name), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Entity', dataIndex: 'name' },
            { title: 'Label', dataIndex: 'label' },
            { title: 'Fields', key: 'fields', render: (_: unknown, row: EntityDefinition) => String(Object.keys(row.fields).length) },
            {
              title: 'Enabled',
              key: 'enabled',
              render: (_: unknown, row: EntityDefinition) => (
                <Switch
                  size="small"
                  checked={row.isEntity}
                  onClick={(_, event) => {
                    event.stopPropagation();
                    void patch(row.name, { isEntity: !row.isEntity }, 'Entity updated.');
                  }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="Create entity"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const values = await entityForm.validateFields();
          try {
            await api.patchEntity(values.name, { label: values.label, fields: { code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true } } });
            void message.success('Entity created.');
            setCreateOpen(false);
            setSelected(values.name);
            await refresh();
          } catch (error) {
            void message.error(error instanceof Error ? error.message : 'Create failed.');
          }
        }}
      >
        <Form form={entityForm} layout="vertical">
          <Form.Item name="name" label="Name (PascalCase)" rules={[{ required: true, pattern: /^[A-Z][A-Za-z0-9]{1,49}$/, message: 'Use PascalCase, letters and digits only.' }]}>
            <Input placeholder="Warehouse" />
          </Form.Item>
          <Form.Item name="label" label="Label" rules={[{ required: true }]}>
            <Input placeholder="Warehouse" />
          </Form.Item>
        </Form>
      </Modal>

      {active ? (
        <>
          <Card className="lizant-card" size="small" title={<Typography.Text strong>{active.label}</Typography.Text>}>
            <Form
              layout="inline"
              initialValues={{ label: active.label }}
              onFinish={(values: { label: string }) => void patch(active.name, { label: values.label }, 'Label updated.')}
            >
              <Form.Item name="label" label="Label">
                <Input />
              </Form.Item>
              <Button size="small" type="primary" htmlType="submit">
                Rename
              </Button>
            </Form>
          </Card>

          <Card className="lizant-card" size="small" title="Fields">
            <Table
              rowKey="name"
              size="small"
              dataSource={Object.entries(active.fields).map(([name, field]) => ({ name, ...field }))}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name' },
                {
                  title: 'Type',
                  dataIndex: 'type',
                  render: (type: string, row) => (
                    <Space size={4}>
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
                      <Button
                        size="small"
                        danger
                        type="text"
                        onClick={() => void api.disableField(active.name, row.name).then(() => refresh()).catch((error: unknown) => message.error(error instanceof Error ? error.message : 'Failed'))}
                      >
                        Disable
                      </Button>
                    ),
                },
              ]}
            />
            <Form form={fieldForm} layout="inline" style={{ marginTop: 12 }} onFinish={async (values) => {
              const draft = values as FieldDraft;
              await patch(active.name, { fields: { [draft.name]: buildFieldDefinition(draft) } }, 'Field added.');
              fieldForm.resetFields();
            }}>
              <Form.Item name="name" rules={[{ required: true, pattern: /^[a-z][A-Za-z0-9]{1,40}$/, message: 'camelCase name' }]}>
                <Input placeholder="fieldName" style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="type" initialValue="varchar">
                <Select style={{ width: 120 }} options={FIELD_TYPES.map((type) => ({ value: type, label: type }))} />
              </Form.Item>
              <Form.Item name="entityKey">
                <Select style={{ width: 140 }} placeholder="link entity" allowClear options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
              </Form.Item>
              <Form.Item name="maxLength">
                <InputNumber placeholder="max" style={{ width: 80 }} min={1} />
              </Form.Item>
              <Form.Item name="values">
                <Input placeholder="enum values, comma" style={{ width: 160 }} />
              </Form.Item>
              {fieldType === 'formula' ? (
                <Form.Item name="formula" rules={[{ required: true, message: 'A formula field needs an expression.' }]}>
                  <Input placeholder="concat(field('firstName'), ' ', field('lastName'))" style={{ width: 320 }} />
                </Form.Item>
              ) : null}
              <Form.Item name="required" valuePropName="checked">
                <Switch size="small" />
              </Form.Item>
              <Form.Item name="inList" valuePropName="checked" initialValue>
                <Switch size="small" />
              </Form.Item>
              <Button size="small" type="primary" htmlType="submit">
                Add field
              </Button>
            </Form>
          </Card>

          <Card className="lizant-card" size="small" title="Dynamic logic">
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
                    <Button
                      size="small"
                      danger
                      type="text"
                      onClick={() => void patch(active.name, { dynamicLogic: { rules: rules.filter((rule) => rule !== row) } }, 'Rule removed.')}
                    >
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
            <Form
              form={ruleForm}
              layout="inline"
              style={{ marginTop: 12, rowGap: 8 }}
              onFinish={async (values) => {
                const draft = values as RuleDraft;
                await patch(active.name, { dynamicLogic: { rules: [...rules, buildRule(draft)] } }, 'Rule added.');
                ruleForm.resetFields();
              }}
            >
              <Form.Item name="name">
                <Input placeholder="rule name" style={{ width: 130 }} />
              </Form.Item>
              <Form.Item name="whenField" rules={[{ required: true }]}>
                <Select style={{ width: 150 }} placeholder="when field" options={fieldNames.map((name) => ({ value: name, label: name }))} showSearch />
              </Form.Item>
              <Form.Item name="whenOperator" initialValue="equals">
                <Select style={{ width: 120 }} options={CRITERIA_OPERATORS.map((operator) => ({ value: operator, label: operator }))} />
              </Form.Item>
              <Form.Item name="whenValue">
                <Input placeholder="compare value" style={{ width: 130 }} />
              </Form.Item>
              <Form.Item name="action" initialValue="setRequired">
                <Select style={{ width: 150 }} options={RULE_ACTIONS} />
              </Form.Item>
              <Form.Item name="targets">
                <Select style={{ width: 200 }} mode="multiple" placeholder="then fields" options={fieldNames.map((name) => ({ value: name, label: name }))} />
              </Form.Item>
              <Form.Item name="message">
                <Input placeholder="message for a blocked save" style={{ width: 200 }} />
              </Form.Item>
              <Button size="small" type="primary" htmlType="submit">
                Add rule
              </Button>
            </Form>
            {rules.length > 0 ? (
              <Button
                size="small"
                danger
                type="text"
                style={{ marginTop: 8 }}
                onClick={() => void patch(active.name, { dynamicLogic: { rules: [] } }, 'Rules cleared.')}
              >
                Clear all rules
              </Button>
            ) : null}
          </Card>

          <Card className="lizant-card" size="small" title="Relations">
            <Table
              rowKey="name"
              size="small"
              dataSource={Object.entries(active.relations).map(([name, relation]) => ({ name, ...relation }))}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name' },
                { title: 'Type', dataIndex: 'type' },
                { title: 'Target', dataIndex: 'target' },
                { title: 'Mapped by', dataIndex: 'mappedBy' },
              ]}
            />
            <Form
              layout="inline"
              style={{ marginTop: 12 }}
              onFinish={(values) => {
                const draft = values as { name: string; type: string; target: string; mappedBy?: string };
                void patch(active.name, { relations: { [draft.name]: { type: draft.type, target: draft.target, ...(draft.mappedBy ? { mappedBy: draft.mappedBy } : {}) } } }, 'Relation added.');
              }}
            >
              <Form.Item name="name" rules={[{ required: true }]}>
                <Input placeholder="relationName" style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="type" initialValue="oneToMany">
                <Select style={{ width: 130 }} options={RELATION_TYPES.map((type) => ({ value: type, label: type }))} />
              </Form.Item>
              <Form.Item name="target" rules={[{ required: true }]}>
                <Select style={{ width: 140 }} placeholder="target entity" options={(metadata.data ? Object.keys(metadata.data) : []).map((name) => ({ value: name, label: name }))} />
              </Form.Item>
              <Form.Item name="mappedBy">
                <Input placeholder="mappedBy" style={{ width: 120 }} />
              </Form.Item>
              <Button size="small" type="primary" htmlType="submit">
                Add relation
              </Button>
            </Form>
          </Card>

          <Card className="lizant-card" size="small" title="Metadata">
            <Tabs
              size="small"
              items={[
                { key: 'layout', label: 'Layout', children: <LayoutTab entity={active} save={save} /> },
                { key: 'access', label: 'Access', children: <AccessTab entity={active} /> },
                { key: 'indexes', label: 'Indexes', children: <IndexTab entity={active} save={save} /> },
              ]}
            />
          </Card>
        </>
      ) : (
        <Card className="lizant-card" size="small">Select an entity above to edit labels, fields and relations.</Card>
      )}
    </Space>
  );
}
