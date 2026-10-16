import { Alert, App as AntApp, Button, Card, Form, Space, Spin, Typography } from 'antd';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type RecordData } from '../api/client.js';
import type { EntityDefinition, FieldDefinition } from '../api/types.js';
import { FieldEditor } from '../components/fields.js';
import type { SalesLine, SalesLineTotals } from '../components/LineItemEditor.js';
import { LineItemEditor, linePayload, SalesTotalsPanel } from '../components/LineItemEditor.js';
import { useSalesPickers } from '../components/useSalesPickers.js';
import { salesDocumentDate, salesDocumentKind } from '../sales/documents.js';
import { t } from '../state/i18n.js';
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

/** Client-side rules derived from metadata + dynamic logic (PLAN §13, §21, §41.9 messages). */
function fieldRules(name: string, field: FieldDefinition, required: boolean) {
  const rules: object[] = [];
  const label = fieldLabel(name, field);
  if (field.required === true || required) rules.push({ required: true, message: t('web.edit.required', { field: label }) });
  if (field.maxLength) rules.push({ max: field.maxLength, message: t('web.edit.maxLength', { max: field.maxLength }) });
  if (field.type === 'email') rules.push({ type: 'email', message: t('web.edit.invalidEmail') });
  if (field.type === 'url') rules.push({ type: 'url', message: t('web.edit.invalidUrl') });
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

  // A commercial document cannot be made by the generic form alone: its totals only exist once the
  // server has priced, taxed and summed at least one line. So creating one carries the line editor and
  // writes through the document command; an existing document edits its lines on its own detail screen.
  const createKind = id === undefined ? salesDocumentKind(entity ?? '') : undefined;
  const [lines, setLines] = useState<SalesLine[]>([]);
  const [lineTotals, setLineTotals] = useState<SalesLineTotals | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const pickers = useSalesPickers();
  // The same rule the server applies: a line that is not fully priced cannot be part of a document
  // (§4.3 — a missing price is never zero), and a document needs at least one line.
  const linesBlocked =
    createKind !== undefined &&
    (lines.length === 0 ||
      lines.some((line) => line.productId === null && line.name.trim() === '') ||
      lines.some((line) => line.unitPrice === null || line.unitPrice === ''));

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
    if (uncovered.length > 0) list.push({ key: '__uncovered', title: t('core.common.other'), entries: uncovered });
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
      void message.error(error instanceof Error ? error.message : t('web.edit.notFound'));
    }
  }, [entity, id, form, message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!entity) return <Card>{t('web.edit.missingEntity')}</Card>;

  const entityLabel = definition.data?.label ?? entity;
  const title = id ? t('web.edit.editTitle', { entity: entityLabel }) : t('web.edit.createTitle', { entity: entityLabel });
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
          message={t('web.edit.cannotSave')}
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
          }            setSaving(true);
          try {
            const savedId = id
              ? (await api.update(entity, id, payload))['id']
              : createKind !== undefined
                ? (await api.salesCreateDocument(createKind, { data: payload, items: lines.map(linePayload) })).id
                : (await api.create(entity, payload))['id'];
            void message.success(t('web.edit.saved'));
            navigate(`${base}/${entity}/${String(savedId ?? '')}`);
          } catch (error) {
            void message.error(error instanceof Error ? error.message : t('web.edit.saveFailed'));
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
        {createKind !== undefined ? (
          <div style={{ marginTop: 8 }}>
            <Typography.Text strong>{t('sales.document.lines')}</Typography.Text>
            <LineItemEditor
              lines={lines}
              onChange={setLines}
              currency={String(watched?.['currency'] ?? 'USD')}
              date={salesDocumentDate(createKind, watched ?? {})}
              taxInclusive={watched?.['taxInclusive'] === true}
              accountId={(watched?.['accountId'] as string | null) ?? null}
              priceBookId={(watched?.['priceBookId'] as string | null) ?? null}
              products={pickers.products}
              taxCodes={pickers.taxCodes}
              allowCustomLines
              onTotalsChange={setLineTotals}
              onPreviewError={setPreviewError}
            />
            {previewError !== null ? (
              <Alert type="warning" showIcon style={{ marginTop: 8 }} message={previewError} />
            ) : null}
            {lineTotals !== null ? <SalesTotalsPanel totals={lineTotals} /> : null}
          </div>
        ) : null}
        <Space>
          <Button
            type="primary"
            htmlType="submit"
            loading={saving}
            disabled={blocked || linesBlocked}
            title={linesBlocked ? t('sales.document.linesRequired') : undefined}
          >
            {t('web.edit.save')}
          </Button>
          <Button onClick={() => navigate(id ? `${base}/${entity}/${id}` : `${base}/${entity}`)}>{t('web.edit.cancel')}</Button>
        </Space>
      </Form>
    </Card>
  );
}
