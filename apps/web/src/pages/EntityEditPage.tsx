import { Alert, App as AntApp, Button, Card, Form, Space, Spin, Typography } from 'antd';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type RecordData } from '../api/client.js';
import type { EntityDefinition, FieldDefinition } from '../api/types.js';
import { FieldEditor } from '../components/fields.js';
import { evaluateEntityLogic, isComputedField } from '../state/logic.js';
import {
  editEntries,
  fieldLabel,
  layoutFieldNames,
  layoutPanelsFor,
  orderByLayout,
  panelFieldNames,
  useEntity,
  useMetadata,
} from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
import { useSession } from '../state/session.js';

const GRID_STYLE: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 16px' };

interface FieldSection {
  key: string;
  title: string;
  entries: VisibleEntry[];
}

/** Client-side rules derived from metadata + dynamic logic (PLAN §13, §21). */
function fieldRules(name: string, field: FieldDefinition, required: boolean) {
  const rules: object[] = [];
  if (field.required === true || required) rules.push({ required: true, message: `${fieldLabel(name, field)} is required.` });
  if (field.maxLength) rules.push({ max: field.maxLength, message: `Max ${field.maxLength} characters.` });
  if (field.type === 'email') rules.push({ type: 'email', message: 'Enter a valid email address.' });
  if (field.type === 'url') rules.push({ type: 'url', message: 'Enter a valid URL.' });
  return rules;
}

interface VisibleEntry {
  name: string;
  field: FieldDefinition;
  required: boolean;
  readOnly: boolean;
}

function buildEntries(definition: EntityDefinition | undefined, logic: ReturnType<typeof evaluateEntityLogic>): VisibleEntry[] {
  return editEntries(definition)
    .filter((entry) => logic.fields[entry.name]?.visible !== false)
    .map((entry) => ({
      name: entry.name,
      field: entry.field,
      required: logic.fields[entry.name]?.required === true,
      readOnly: logic.fields[entry.name]?.readOnly === true,
    }));
}

export function EntityEditPage() {
  const { entity, id } = useParams<{ entity: string; id?: string }>();
  const navigate = useNavigate();
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
  const definition = useEntity(entity);
  const metadata = useMetadata();
  const [form] = Form.useForm();
  const [initial, setInitial] = useState<RecordData | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Dynamic logic re-runs on every keystroke: the rule set is small and the engine caches parsed
  // formulas, so re-evaluating is cheaper than tracking which field each rule reads.
  const watched = Form.useWatch([], form);
  const logic = useMemo(() => evaluateEntityLogic(definition.data, watched ?? {}), [definition.data, watched]);
  const entries = useMemo(() => buildEntries(definition.data, logic), [definition.data, logic]);
  const computedNames = useMemo(() => Object.keys(logic.values), [logic.values]);

  // PLAN §8: an entity without an 'edit' layout keeps a single grid in field order.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'edit'), [definition.data]);
  const ordered = useMemo(() => orderByLayout(entries, panels), [entries, panels]);
  const sections = useMemo(() => {
    const list: FieldSection[] = panels.map((panel) => ({
      key: panel.name,
      title: panel.label ?? panel.name,
      entries: ordered.filter((entry) => panelFieldNames(panel).has(entry.name)),
    }));
    const covered = layoutFieldNames(panels);
    const uncovered = ordered.filter((entry) => !covered.has(entry.name));
    if (uncovered.length > 0) list.push({ key: '__uncovered', title: 'Other', entries: uncovered });
    return list;
  }, [panels, ordered]);

  const renderField = (entry: VisibleEntry) => (
    <Form.Item
      key={entry.name}
      name={entry.name}
      label={fieldLabel(entry.name, entry.field, metadata.data)}
      rules={fieldRules(entry.name, entry.field, entry.required)}
      valuePropName={entry.field.type === 'bool' ? 'checked' : 'value'}
    >
      <FieldEditor fieldName={entry.name} field={entry.field} value={undefined} disabled={entry.readOnly || computedNames.includes(entry.name)} onChange={() => undefined} />
    </Form.Item>
  );

  useEffect(() => {
    for (const [name, value] of Object.entries(logic.values)) {
      if (form.getFieldValue(name) !== value) form.setFieldValue(name, value);
    }
  }, [logic.values, form]);

  const load = useCallback(async () => {
    if (!entity || !id) return;
    try {
      const record = await api.get(entity, id);
      setInitial(record);
      form.setFieldsValue({ ...record });
    } catch (error) {
      setLoadFailed(true);
      void message.error(error instanceof Error ? error.message : 'Record not found.');
    }
  }, [entity, id, form, message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!entity) return <Card>Missing entity.</Card>;

  const title = id ? `Edit ${definition.data?.label ?? entity}` : `Create ${definition.data?.label ?? entity}`;
  const blocked = logic.errors.length > 0;

  // Editing must not start before the record is in the form: a late setFieldsValue would
  // otherwise overwrite whatever the user already typed.
  if (id && initial === undefined && !loadFailed) {
    return (
      <Card className="lizant-card" title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>{title}</Typography.Title>}>
        <Spin />
      </Card>
    );
  }

  return (
    <Card className="lizant-card" title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>{title}</Typography.Title>}>
      {blocked ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="This record cannot be saved"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {logic.errors.map((error) => (
                <li key={`${error.rule}-${error.message}`}>{error.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      <Form
        form={form}
        layout="vertical"
        initialValues={initial ?? {}}
        onFinish={async (values) => {
          if (!entity) return;
          const payload: RecordData = { ...values };
          // Values the rules or a field formula compute come from the server; sending them back
          // would only risk a mismatch on a field the user cannot edit.
          for (const name of computedNames) delete payload[name];
          for (const [name, field] of Object.entries(definition.data?.fields ?? {})) {
            if (isComputedField(field.type)) delete payload[name];
          }
          setSaving(true);
          try {
            const record = id ? await api.update(entity, id, payload) : await api.create(entity, payload);
            void message.success('Saved.');
            navigate(`${base}/${entity}/${String(record['id'] ?? '')}`);
          } catch (error) {
            void message.error(error instanceof Error ? error.message : 'Save failed.');
          } finally {
            setSaving(false);
          }
        }}
      >
        {id ? <Form.Item name="version" hidden><input type="hidden" /></Form.Item> : null}
        {panels.length === 0 ? (
          <div style={GRID_STYLE}>{ordered.map(renderField)}</div>
        ) : (
          sections.map((section) => (
            <div key={section.key} style={{ marginBottom: 16 }}>
              <Typography.Text strong>{section.title}</Typography.Text>
              <div style={GRID_STYLE}>{section.entries.map(renderField)}</div>
            </div>
          ))
        )}
        <Space>
          <Button type="primary" htmlType="submit" loading={saving} disabled={blocked}>
            Save
          </Button>
          <Button onClick={() => navigate(id ? `${base}/${entity}/${id}` : `${base}/${entity}`)}>Cancel</Button>
        </Space>
      </Form>
    </Card>
  );
}
