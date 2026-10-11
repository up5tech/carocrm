import { App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type { EntityDefinition, FieldDefinition } from '../api/types.js';
import { useMetadata } from '../state/metadata.js';

const FIELD_TYPES = ['varchar', 'text', 'int', 'float', 'decimal', 'bool', 'date', 'datetime', 'enum', 'multiEnum', 'currency', 'url', 'email', 'phone', 'link', 'linkMultiple', 'formula'];
const RELATION_TYPES = ['oneToMany', 'manyToOne', 'manyToMany'];

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
        </>
      ) : (
        <Card className="lizant-card" size="small">Select an entity above to edit labels, fields and relations.</Card>
      )}
    </Space>
  );
}
