import { DeleteOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Collapse, DatePicker, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useState } from 'react';

import type { LeadScoreEditorCatalog, LeadScoreEditorField } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { fieldOf, named, operatorLabel, selectableFields } from './shared.js';

/**
 * Phase 19-LS.8 — the rule condition builder
 * (`PLAN_Phase_19_LeadScore.md` §6.2, §6.3, §12, §16 `19-LS.8`).
 *
 * A condition is stored as a declarative JSON tree in a text attribute (LS.2: the platform has no object
 * field type), and plan §6.2 forbids anything else in it — no formula, no expression, no SQL. The exit
 * criterion of LS.8 is that an administrator can build a model **without editing raw JSON manually**, so
 * this component is the only way a rule's condition is authored on screen: it can produce a leaf or an
 * `all`/`any`/`not` group, and nothing else.
 *
 * Every choice it offers is the server's (`GET action/editor`): the fields with their refusal reasons, the
 * operators a type can answer, the value control, the list-size and length bounds, and the depth and
 * predicate budgets. The builder stops at the same boundary the parser refuses rather than after it — which
 * is also why the JSON is *shown* below the form and never typed.
 */

/** The condition node shapes the DSL allows, as editable records. */
type LeafEdit = { id: string; kind: 'leaf'; field: string; operator: string; value?: unknown };
type GroupEdit = { id: string; kind: 'group'; join: 'all' | 'any'; children: EditNode[] };
type EditNode = LeafEdit | GroupEdit;
type RootEdit = { mode: 'all' | 'any' | 'not'; children: EditNode[] };

const EMPTY: RootEdit = { mode: 'all', children: [] };

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `n${String(sequence)}`;
}

export function ConditionBuilder({
  value,
  onChange = () => undefined,
  catalog,
  fields: fieldsOverride,
  disabled = false,
}: {
  // `value` and `onChange` are what an Ant Design `Form.Item` injects, which is how this builder is used.
  value?: string | null | undefined;
  onChange?: ((raw: string) => void) | undefined;
  catalog: LeadScoreEditorCatalog | undefined;
  /** The fields to offer. A rule over an engagement source passes that source's metrics instead. */
  fields?: LeadScoreEditorField[] | undefined;
  disabled?: boolean;
}) {
  const [tree, setTree] = useState<RootEdit>(() => parseCondition(value));

  /** The one path out: the tree changes, the stored string follows. */
  function replace(next: RootEdit): void {
    setTree(next);
    onChange?.(serialize(next));
  }

  const counts = countNodes(tree);
  const limits = catalog?.condition;
  const fields = fieldsOverride ?? selectableFields(catalog);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {catalog === undefined ? (
        <Typography.Text type="secondary">{t('leadscore.admin.builder.loadingCatalog')}</Typography.Text>
      ) : fields.length === 0 ? (
        <Typography.Text type="secondary">{fieldsOverride === undefined ? t('leadscore.admin.builder.noFields') : t('leadscore.admin.builder.noMetrics')}</Typography.Text>
      ) : null}

      <Space wrap size={8} align="center">
        <Select
          size="small"
          value={tree.mode}
          disabled={disabled}
          style={{ minWidth: 168 }}
          onChange={(mode) => replace({ ...tree, mode: mode as RootEdit['mode'] })}
          options={(
            [
              ['all', t('leadscore.admin.builder.matchAll')],
              ['any', t('leadscore.admin.builder.matchAny')],
              ['not', t('leadscore.admin.builder.matchNone')],
            ] as const
          ).map(([key, label]) => ({ value: key, label }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('leadscore.admin.builder.counts', {
            predicates: String(counts.predicates),
            maxPredicates: String(limits?.maxPredicates ?? 0),
            depth: String(counts.depth),
            maxDepth: String(limits?.maxDepth ?? 0),
          })}
        </Typography.Text>
      </Space>

      {/* `not` wraps exactly one node, and a group inside it would exceed the depth budget, so the children
          of a negation are leaves — the same limit the parser applies (plan §6.3). */}
      <div className="carocrm-condition-group">
        <ConditionList
          items={tree.children}
          fields={fields}
          catalog={catalog}
          disabled={disabled}
          metricMode={fieldsOverride !== undefined}
          nested={tree.mode === 'not' ? false : undefined}
          onChangeChildren={(children) => replace({ ...tree, children })}
        />
      </div>

      <Collapse
        size="small"
        items={[
          {
            key: 'json',
            label: (
              <Space size={6}>
                <RightOutlined style={{ fontSize: 10 }} />
                {t('leadscore.admin.builder.jsonLabel')}
              </Space>
            ),
            children: (
              <Typography.Paragraph code style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>
                {serialize(tree) === '' ? t('leadscore.admin.builder.jsonEmpty') : prettyJson(serialize(tree))}
              </Typography.Paragraph>
            ),
          },
        ]}
      />
    </Space>
  );
}

/**
 * One list of conditions.
 *
 * `nested` is the third state a builder needs and the reason this component exists separately: `undefined`
 * means a child may itself be a group (the root, depth 1), `false` means leaves only (a `not`, or the inside
 * of a group — a group at depth 2 is the last one the DSL allows).
 */
function ConditionList({
  items,
  fields,
  catalog,
  disabled,
  metricMode = false,
  nested,
  onChangeChildren,
}: {
  items: EditNode[];
  fields: LeadScoreEditorField[];
  catalog: LeadScoreEditorCatalog | undefined;
  disabled: boolean;
  metricMode?: boolean;
  nested: boolean | undefined;
  onChangeChildren: (children: EditNode[]) => void;
}) {
  const allowGroups = nested !== false;
  const maxList = catalog?.condition.maxListValues ?? 25;

  function patch(index: number, next: EditNode): void {
    onChangeChildren(items.map((entry, position) => (position === index ? next : entry)));
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {items.map((child, index) =>
        child.kind === 'leaf' ? (
          <LeafRow
            key={child.id}
            leaf={child}
            fields={fields}
            catalog={catalog}
            disabled={disabled}
            metricMode={metricMode}
            onChange={(next) => patch(index, next)}
            onRemove={() => onChangeChildren(items.filter((_, position) => position !== index))}
          />
        ) : (
          <div key={child.id} className="carocrm-condition-group carocrm-condition-group--inner">
            <Space wrap size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
              <Select
                size="small"
                value={child.join}
                disabled={disabled}
                style={{ minWidth: 148 }}
                onChange={(join) => patch(index, { ...child, join: join as 'all' | 'any' })}
                options={(
                  [
                    ['all', t('leadscore.admin.builder.matchAll')],
                    ['any', t('leadscore.admin.builder.matchAny')],
                  ] as const
                ).map(([key, label]) => ({ value: key, label }))}
              />
              <Button size="small" type="text" danger disabled={disabled} icon={<DeleteOutlined />} onClick={() => onChangeChildren(items.filter((_, position) => position !== index))}>
                {t('web.common.remove')}
              </Button>
            </Space>
            <ConditionList
              items={child.children}
              fields={fields}
              catalog={catalog}
              disabled={disabled}
              metricMode={metricMode}
              nested={false}
              onChangeChildren={(inner) => patch(index, { ...child, children: inner })}
            />
          </div>
        ),
      )}

      <Space wrap size={8}>
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={disabled || items.length >= (catalog?.condition.maxNodes ?? 60)}
          onClick={() => onChangeChildren([...items, { id: nextId(), kind: 'leaf', field: fields[0]?.name ?? '', operator: fields[0]?.operators[0] ?? 'equals' }])}
        >
          {t('leadscore.admin.builder.addCondition')}
        </Button>
        {allowGroups ? (
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            disabled={disabled}
            onClick={() => onChangeChildren([...items, { id: nextId(), kind: 'group', join: 'all', children: [] }])}
          >
            {t('leadscore.admin.builder.addGroup')}
          </Button>
        ) : null}
      </Space>
      {items.length > maxList ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {t('leadscore.admin.builder.tooManyConditions', { count: String(items.length), max: String(maxList) })}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

/** One comparison: a field, an operator that field's type can answer, and the control that value needs. */
function LeafRow({
  leaf,
  fields,
  catalog,
  disabled,
  metricMode = false,
  onChange,
  onRemove,
}: {
  leaf: LeafEdit;
  fields: LeadScoreEditorField[];
  catalog: LeadScoreEditorCatalog | undefined;
  disabled: boolean;
  metricMode?: boolean;
  onChange: (leaf: LeafEdit) => void;
  onRemove: () => void;
}) {
  // The offered list *is* the vocabulary of this row: a Lead field for a `lead` rule, a metric for an
  // engagement rule. Looking the name up anywhere else would answer "no operators" for a perfectly good rule.
  const field = fields.find((entry) => entry.name === leaf.field) ?? catalog?.fields.find((entry) => entry.name === leaf.field);
  const operators = field?.operators ?? [];
  const needsValue = operators.length > 0 && !isValueless(catalog, leaf.operator);
  const isList = operators.length > 0 && (catalog?.condition.listOperators.includes(leaf.operator) ?? false);

  return (
    <Space wrap size={8} align="start" style={{ width: '100%' }} className="carocrm-condition-leaf">
      <FieldSelect fields={fields} catalog={catalog} value={leaf.field} disabled={disabled} metricMode={metricMode} onChange={(name) => {
        const next = fields.find((entry) => entry.name === name) ?? fieldOf(catalog, name);
        const operator = next?.operators[0] ?? 'equals';
        onChange({ id: leaf.id, kind: 'leaf', field: name, operator });
      }} />
      {/* Searchable, because a `varchar` answers ten operators and the list is virtualised: typing is the
          way to reach the last one. */}
      <Select
        size="small"
        showSearch
        optionFilterProp="label"
        aria-label={t('leadscore.admin.builder.operator')}
        value={operators.includes(leaf.operator) ? leaf.operator : ''}
        placeholder={t('leadscore.admin.builder.operator')}
        disabled={disabled || operators.length === 0}
        style={{ minWidth: 152 }}
        onChange={(operator) => onChange({ id: leaf.id, kind: 'leaf', field: leaf.field, operator })}
        options={operators.map((operator) => ({ value: operator, label: operatorLabel(operator) }))}
      />
      {needsValue ? (
        <ValueControl
          field={field}
          catalog={catalog}
          value={leaf.value}
          disabled={disabled}
          isList={isList}
          onChange={(value) => onChange({ id: leaf.id, kind: 'leaf', field: leaf.field, operator: leaf.operator, value })}
        />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('leadscore.admin.builder.noValue')}
        </Typography.Text>
      )}
      <Button size="small" type="text" danger disabled={disabled} icon={<DeleteOutlined />} aria-label={t('web.common.remove')} onClick={onRemove} />
    </Space>
  );
}

/**
 * The field picker, including the fields a rule may *not* read.
 *
 * A refused field is an unselectable option carrying the server's reason, because "why can't I score on
 * this?" is a question the screen should answer instead of leaving the administrator to discover by trying
 * (plan §6.3: the denylist is policy, and policy is worth explaining).
 */
function FieldSelect({
  fields,
  catalog,
  value,
  disabled,
  metricMode = false,
  onChange,
}: {
  fields: LeadScoreEditorField[];
  catalog: LeadScoreEditorCatalog | undefined;
  value: string;
  disabled: boolean;
  metricMode?: boolean;
  onChange: (name: string) => void;
}) {
  // A metric list is short, closed and already scoped to the rule's source, so there is nothing to refuse.
  const refused = metricMode ? [] : (catalog?.fields ?? []).filter((entry) => !entry.scorable);
  const shown = fields.some((entry) => entry.name === value) || value === '' ? undefined : value;
  return (
    <Select
      size="small"
      showSearch
      aria-label={t('leadscore.admin.builder.field')}
      value={shown ?? value}
      placeholder={t('leadscore.admin.builder.field')}
      disabled={disabled}
      style={{ minWidth: 216, maxWidth: 320 }}
      optionFilterProp="label"
      onChange={onChange}
      options={[
        {
          label: t('leadscore.admin.builder.scorableGroup'),
          options: fields.map((entry) => ({ value: entry.name, label: `${entry.label} · ${entry.type}` })),
        },
        ...(refused.length === 0
          ? []
          : [
              {
                label: t('leadscore.admin.builder.blockedGroup'),
                options: refused.map((entry) => ({
                  value: entry.name,
                  disabled: true,
                  label: `${entry.label} — ${refusalText(entry)}`,
                })),
              },
            ]),
      ]}
    />
  );
}

function refusalText(field: LeadScoreEditorField): string {
  return named(`leadscore.admin.refusal.${String(field.refusal)}`, String(field.refusalCode ?? field.refusal ?? field.type));
}

function isValueless(catalog: LeadScoreEditorCatalog | undefined, operator: string): boolean {
  return (catalog?.condition.valuelessOperators.includes(operator) ?? false) || (VALUELESS.has(operator) && catalog === undefined);
}

/** The fallback set, only used before the catalog answers; the server's list wins. */
const VALUELESS: ReadonlySet<string> = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

function ValueControl({
  field,
  catalog,
  value,
  disabled,
  isList,
  onChange,
}: {
  field: LeadScoreEditorField | undefined;
  catalog: LeadScoreEditorCatalog | undefined;
  value: unknown;
  disabled: boolean;
  isList: boolean;
  onChange: (value: unknown) => void;
}) {
  const kind = field?.valueKind ?? 'text';
  const options = (field?.options ?? []).map((option) => ({ value: option, label: option }));
  const maxValueChars = catalog?.condition.maxValueChars ?? 512;
  const width = { minWidth: 180, maxWidth: 360, flex: '1 1 220px' };

  if (isList) {
    const list = Array.isArray(value) ? value.map((entry) => String(entry)) : [];
    return options.length > 0 ? (
      <Select
        size="small"
        mode="multiple"
        value={list}
        disabled={disabled}
        style={width}
        placeholder={t('leadscore.admin.builder.values')}
        options={options}
        onChange={(next) => onChange(next)}
      />
    ) : (
      <Select
        size="small"
        mode="tags"
        value={list}
        disabled={disabled}
        style={width}
        open={false}
        placeholder={t('leadscore.admin.builder.values')}
        onChange={(next) => onChange(next)}
      />
    );
  }

  switch (kind) {
    case 'number': {
      return (
        <InputNumber
          size="small"
          value={typeof value === 'number' ? value : null}
          disabled={disabled}
          style={{ width: 180 }}
          placeholder={t('leadscore.admin.builder.value')}
          {...(field?.type === 'int' || field?.type === 'aggregationCount' ? { precision: 0 } : {})}
          onChange={(next) => {
            if (next === null || next === undefined) onChange(undefined);
            else onChange(Number(next));
          }}
        />
      );
    }
    case 'boolean':
      return (
        <Switch
          size="small"
          checked={value === true}
          disabled={disabled}
          checkedChildren="true"
          unCheckedChildren="false"
          onChange={(next) => onChange(next)}
          aria-label={t('leadscore.admin.builder.value')}
        />
      );
    case 'option':
      return (
        <Select
          size="small"
          value={typeof value === 'string' ? value : undefined}
          disabled={disabled}
          style={{ minWidth: 180 }}
          showSearch
          optionFilterProp="label"
          placeholder={t('leadscore.admin.builder.value')}
          options={options}
          onChange={(next) => onChange(next)}
        />
      );
    case 'options':
      return (
        <Select
          size="small"
          mode="multiple"
          value={Array.isArray(value) ? value.map((entry) => String(entry)) : []}
          disabled={disabled}
          style={width}
          placeholder={t('leadscore.admin.builder.values')}
          options={options}
          onChange={(next) => onChange(next)}
        />
      );
    case 'date':
    case 'datetime': {
      const parsed = typeof value === 'string' && value !== '' ? dayjs(value) : undefined;
      const format = kind === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss';
      return (
        <DatePicker
          size="small"
          value={parsed !== undefined && parsed.isValid() ? (parsed as Dayjs) : undefined}
          disabled={disabled}
          showTime={kind === 'datetime'}
          format={kind === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm'}
          style={{ width: 208 }}
          onChange={(next) => onChange(next === null || next === undefined ? undefined : next.format(format))}
        />
      );
    }
    case 'textarea':
      return (
        <Input.TextArea
          size="small"
          rows={1}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          style={{ maxWidth: 360 }}
          maxLength={Math.min(field?.maxLength ?? maxValueChars, maxValueChars)}
          placeholder={t('leadscore.admin.builder.value')}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <Input
          size="small"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          style={width}
          maxLength={Math.min(field?.maxLength ?? maxValueChars, maxValueChars)}
          placeholder={t('leadscore.admin.builder.value')}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** The tree the DSL stores, as the JSON the validator will read. */
function serialize(root: RootEdit): string {
  const children = root.children.map(serializeNode).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (children.length === 0) return '';
  if (root.mode === 'not') return JSON.stringify({ not: { all: children } });
  if (children.length === 1 && root.mode === 'all') return JSON.stringify(children[0]);
  return JSON.stringify({ [root.mode]: children });
}

function serializeNode(node: EditNode): Record<string, unknown> | undefined {
  if (node.kind === 'group') {
    const children = node.children.map(serializeNode).filter((entry): entry is Record<string, unknown> => entry !== undefined);
    if (children.length === 0) return undefined;
    return { [node.join]: children };
  }
  if (node.field === '' || node.operator === '') return undefined;
  const valueless = VALUELESS.has(node.operator);
  if (valueless) return { field: node.field, operator: node.operator };
  if (node.value === undefined || node.value === null) return { field: node.field, operator: node.operator };
  if (typeof node.value === 'string' && node.value.trim() === '') return { field: node.field, operator: node.operator };
  if (Array.isArray(node.value) && node.value.length === 0) return { field: node.field, operator: node.operator };
  return { field: node.field, operator: node.operator, value: node.value };
}

/**
 * Read a stored condition back into the builder.
 *
 * A condition the builder cannot represent — a hand-written tree from before this screen, or a deeper nest
 * than the builder offers — is *kept* rather than dropped: the unknown node is preserved verbatim so saving
 * the rest of the rule never silently rewrites a comparison nobody asked it to change.
 */
function parseCondition(raw: string | undefined | null): RootEdit {
  if (raw === undefined || raw === null || raw.trim() === '') return { ...EMPTY, children: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY, children: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY, children: [] };
  const record = parsed as Record<string, unknown>;
  if ('not' in record) {
    const inner = record.not;
    if (isRecord(inner) && ('all' in inner || 'any' in inner)) {
      const key = 'all' in inner ? 'all' : 'any';
      const children = (Array.isArray(inner[key]) ? inner[key] : []).map(parseNode).filter((entry): entry is EditNode => entry !== undefined);
      return { mode: 'not', children };
    }
    const leaf = parseNode(inner);
    return { mode: 'not', children: leaf === undefined ? [] : [leaf] };
  }
  const mode = 'any' in record ? 'any' : 'all';
  const children = (Array.isArray(record[mode]) ? record[mode] : []).map(parseNode).filter((entry): entry is EditNode => entry !== undefined);
  if (children.length === 0) return { ...EMPTY, children: [] };
  // A single leaf stored without a wrapper still belongs to the default `all` group when the mode allows it.
  if (children.length === 1 && children[0]?.kind === 'leaf' && mode === 'all' && !('all' in record)) return { mode, children };
  return { mode, children };
}

function parseNode(value: unknown): EditNode | undefined {
  if (!isRecord(value)) return undefined;
  if ('field' in value && typeof value.field === 'string' && typeof value.operator === 'string') {
    return { id: nextId(), kind: 'leaf', field: value.field, operator: value.operator, ...('value' in value ? { value: value.value } : {}) };
  }
  if ('all' in value || 'any' in value) {
    const join = 'all' in value ? 'all' : 'any';
    const children = (Array.isArray(value[join]) ? value[join] : []).map(parseNode).filter((entry): entry is EditNode => entry !== undefined);
    return { id: nextId(), kind: 'group', join, children };
  }
  if ('not' in value) {
    const inner = parseNode(value.not);
    return { id: nextId(), kind: 'group', join: 'all', children: inner === undefined ? [] : [inner] };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The builder's live reading of the condition against the parser's budgets (plan §6.3).
 *
 * `depth` counts the levels of grouping that exist: the root is one, and a child group makes two — which is
 * the ceiling, so a third is never offered. A `not` root is itself a wrapper level, so its leaves sit at 2.
 */
function countNodes(root: RootEdit): { predicates: number; depth: number } {
  const counted = root.children.reduce(
    (acc, child) => {
      if (child.kind === 'group') {
        acc.predicates += child.children.length;
        acc.grouped = true;
      } else {
        acc.predicates += 1;
      }
      return acc;
    },
    { predicates: 0, grouped: false },
  );
  return {
    predicates: counted.predicates,
    depth: counted.predicates === 0 ? 0 : 1 + (counted.grouped || root.mode === 'not' ? 1 : 0),
  };
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
