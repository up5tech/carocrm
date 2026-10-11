import { App as AntApp, Button, Card, Form, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type RecordData } from '../api/client.js';
import type { FieldDefinition } from '../api/types.js';
import { FieldEditor } from '../components/fields.js';
import { editEntries, fieldLabel, useEntity, useMetadata } from '../state/metadata.js';

/** Client-side rules derived from metadata (PLAN §13: metadata drives validation). */
function fieldRules(name: string, field: FieldDefinition) {
  const rules: object[] = [];
  if (field.required === true) rules.push({ required: true, message: `${fieldLabel(name, field)} is required.` });
  if (field.maxLength) rules.push({ max: field.maxLength, message: `Max ${field.maxLength} characters.` });
  if (field.type === 'email') rules.push({ type: 'email', message: 'Enter a valid email address.' });
  if (field.type === 'url') rules.push({ type: 'url', message: 'Enter a valid URL.' });
  return rules;
}

export function EntityEditPage() {
  const { entity, id } = useParams<{ entity: string; id?: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const definition = useEntity(entity);
  const metadata = useMetadata();
  const [form] = Form.useForm();
  const [initial, setInitial] = useState<RecordData | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const entries = useMemo(() => editEntries(definition.data), [definition.data]);

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
      <Form
        form={form}
        layout="vertical"
        initialValues={initial ?? {}}
        onFinish={async (values) => {
          if (!entity) return;
          setSaving(true);
          try {
            const payload: RecordData = { ...values };
            const record = id ? await api.update(entity, id, payload) : await api.create(entity, payload);
            void message.success('Saved.');
            navigate(`/${entity}/${String(record['id'] ?? '')}`);
          } catch (error) {
            void message.error(error instanceof Error ? error.message : 'Save failed.');
          } finally {
            setSaving(false);
          }
        }}
      >
        {id ? <Form.Item name="version" hidden><input type="hidden" /></Form.Item> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 16px' }}>
          {entries.map((entry) => (
            <Form.Item
              key={entry.name}
              name={entry.name}
              label={fieldLabel(entry.name, entry.field, metadata.data)}
              rules={fieldRules(entry.name, entry.field)}
              valuePropName={entry.field.type === 'bool' ? 'checked' : 'value'}
            >
              <FieldEditor fieldName={entry.name} field={entry.field} value={undefined} onChange={() => undefined} />
            </Form.Item>
          ))}
        </div>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save
          </Button>
          <Button onClick={() => navigate(id ? `/${entity}/${id}` : `/${entity}`)}>Cancel</Button>
        </Space>
      </Form>
    </Card>
  );
}
