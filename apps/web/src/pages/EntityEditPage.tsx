import { Alert, App as AntApp, Button, Card, Form, Modal, Space, Spin, Typography } from 'antd';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, type RecordData } from '../api/client.js';
import type { EntityDefinition, FieldDefinition } from '../api/types.js';
import { FieldEditor } from '../components/fields.js';
import type { SalesLine, SalesLineTotals } from '../components/LineItemEditor.js';
import { LineItemEditor, linePayload, SalesTotalsPanel } from '../components/LineItemEditor.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { useSalesPickers } from '../components/useSalesPickers.js';
import { serverFieldErrors } from '../lib/serverFieldErrors.js';
import { salesDocumentDate, salesDocumentKind } from '../sales/documents.js';
import { PORTAL_HIDDEN_CASE_FIELDS } from '../service-desk/portal-case-fields.js';
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
import { portalBase, useIsPortalUser } from '../state/portal.js';
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

/**
 * The header fields worth sending as overrides for an Opportunity-sourced document: an input the
 * operator left untouched must not blank the party the deal already gave.
 */
function overridesOf(payload: RecordData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

function buildEntries(
  definition: EntityDefinition | undefined,
  logic: ReturnType<typeof evaluateEntityLogic>,
  hideFields?: ReadonlySet<string>,
): VisibleEntry[] {
  return editEntries(definition)
    .filter((entry) => logic.fields[entry.name]?.visible !== false)
    .filter((entry) => hideFields === undefined || !hideFields.has(entry.name))
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
  const [searchParams] = useSearchParams();
  const { principal } = useSession();
  const isPortal = useIsPortalUser();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
  const definition = useEntity(entity);
  const metadata = useMetadata();
  const [form] = Form.useForm();
  const [initial, setInitial] = useState<RecordData | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // §20.13: unsaved-changes guard + keyboard save
  const formRef = useRef(form);
  formRef.current = form;
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // §20.11: a 403 on the record itself renders the permission card instead of an empty form.
  const [denied, setDenied] = useState(false);
  // §5.5 progressive disclosure: which sections are folded. An absent entry falls back to the
  // default — everything after the first section starts closed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // §5.5: which button submitted. "Save & new" writes and stays on the create screen with the form
  // reset to its defaults so an operator can enter a batch without re-clicking Create.
  const submitIntent = useRef<'view' | 'new'>('view');

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  // §20.13 in-app guard: `beforeunload` only covers a real page load, and SPA navigation never
  // fires it — the data router's blocker is the path that actually protects a dirty form.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname,
  );
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    Modal.confirm({
      title: t('web.edit.leaveTitle'),
      content: t('web.edit.leaveBody'),
      okText: t('web.edit.leaveConfirm'),
      cancelText: t('web.edit.stayHere'),
      onOk: () => blockerRef.current.proceed?.(),
      onCancel: () => blockerRef.current.reset?.(),
    });
  }, [blocker.state]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        formRef.current.submit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Track form changes for unsaved guard via onValuesChange prop on Form
  const handleValuesChange = useCallback(() => {
    setHasUnsavedChanges(true);
  }, []);

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

  /**
   * Phase 19-S.7 — a document raised **from a CRM Opportunity**. The Opportunity screen links here with
   * `?opportunityId=…`; the deal's party is seeded into the form so the operator sees who the document
   * is for before pricing it, and the save goes through `POST /Sales/document/fromOpportunity`, which
   * owns the provenance and the double-billing guards. Without the parameter nothing changes.
   */
  const opportunityId = id === undefined && createKind !== undefined ? searchParams.get('opportunityId') : null;

  // Dynamic logic re-runs on every keystroke: the rule set is small and the engine caches parsed
  // formulas, so re-evaluating is cheaper than tracking which field each rule reads.
  const watched = Form.useWatch([], form);
  const logic = useMemo(() => evaluateEntityLogic(definition.data, watched ?? {}), [definition.data, watched]);
  const entries = useMemo(
    () =>
      buildEntries(
        definition.data,
        logic,
        isPortal && entity === 'Case' ? PORTAL_HIDDEN_CASE_FIELDS : undefined,
      ),
    [definition.data, logic, isPortal, entity],
  );
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
      if (error instanceof ApiError && error.status === 403) {
        // §20.11: a refused read is a permission card, not a toast over an empty form.
        setDenied(true);
        return;
      }
      void message.error(error instanceof Error ? error.message : t('web.edit.notFound'));
    }
  }, [entity, id, form, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // Seed the deal's party into the create form. A deal the caller may not read seeds nothing — the
  // command refuses the save with the reason, which is the answer the operator needs. Only fields this
  // form actually renders are seeded: `name` is not on a document's edit layout, and the command
  // copies the deal's title itself.
  useEffect(() => {
    if (opportunityId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const deal = await api.get('Opportunity', opportunityId);
        if (cancelled) return;
        const seed: RecordData = {};
        for (const name of ['accountId', 'contactId']) {
          const value = deal[name];
          if (value !== undefined && value !== null && value !== '') seed[name] = value;
        }
        form.setFieldsValue(seed);
      } catch {
        // See above: the refusal belongs to the save, not to the prefill.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opportunityId, form]);

  if (!entity) return <Card>{t('web.edit.missingEntity')}</Card>;

  const entityLabel = definition.data?.label ?? entity;
  const title = id ? t('web.edit.editTitle', { entity: entityLabel }) : t('web.edit.createTitle', { entity: entityLabel });
  const blocked = logic.errors.length > 0;

  // Editing must not start before the record is in the form: a late setFieldsValue would
  // otherwise overwrite whatever the user already typed.
  if (denied && id !== undefined) {
    return (
      <Card className="carocrm-card" title={<Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{title}</Typography.Title>}>
        <PermissionDenied />
      </Card>
    );
  }
  if (id && initial === undefined && !loadFailed) {
    return (
      <Card className="carocrm-card" title={<Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{title}</Typography.Title>}>
        <Spin />
      </Card>
    );
  }

  return (
    <Card className="carocrm-card" title={<Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{title}</Typography.Title>}>
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
        onValuesChange={handleValuesChange}
        // §5.5: a failed save must say where the problem is, not only that there is one — the first
        // invalid field is scrolled into view and focused.
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first === undefined) return;
          // §5.5: an error inside a folded section cannot be seen — unfold everything first.
          setCollapsed({});
          window.requestAnimationFrame(() => {
            form.scrollToField(first, { behavior: 'smooth', block: 'center' });
            const instance = form.getFieldInstance(first) as { focus?: () => void } | null;
            instance?.focus?.();
          });
        }}
        onFinish={async (values) => {
          if (!entity) return;
          // §20.13: duplicate warning on create — check if a record with the same name already exists
          if (!id && definition.data?.record?.nameField) {
            const nameField = definition.data.record.nameField;
            const nameValue = values[nameField];
            if (nameValue && typeof nameValue === 'string' && nameValue.trim() !== '') {
              try {
                const existing = await api.list(entity, { where: [{ field: nameField, operator: 'equals', value: nameValue.trim() }], maxSize: 1 });
                if (existing.list.length > 0) {
                  const confirmed = await new Promise<boolean>((resolve) => {
                    Modal.confirm({
                      title: t('web.edit.duplicateTitle'),
                      content: t('web.edit.duplicateHint', { name: nameValue.trim() }),
                      okText: t('web.edit.duplicateCreateAnyway'),
                      cancelText: t('core.common.cancel'),
                      onOk: () => resolve(true),
                      onCancel: () => resolve(false),
                    });
                  });
                  if (!confirmed) return;
                }
              } catch {
                // If the check fails, proceed anyway — don't block the user
              }
            }
          }
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
                ? opportunityId !== null
                  ? (
                      await api.salesCreateFromOpportunity({
                        opportunityId,
                        kind: createKind,
                        items: lines.map(linePayload),
                        overrides: overridesOf(payload),
                      })
                    ).id
                  : (await api.salesCreateDocument(createKind, { data: payload, items: lines.map(linePayload) })).id
                : (await api.create(entity, payload))['id'];
            if (submitIntent.current === 'new' && id === undefined && createKind === undefined) {
              submitIntent.current = 'view';
              void message.success(t('web.edit.savedCreateAnother'));
              // Back to the defaults the create screen opened with (owner = current user, pipeline
              // entry stage), so the next record starts valid instead of empty.
              form.resetFields();
              if (initial !== undefined) form.setFieldsValue(initial);
              setHasUnsavedChanges(false);
              return;
            }
            void message.success(t('web.edit.saved'));
            navigate(`${base}/${entity}/${String(savedId ?? '')}`);
          } catch (error) {
            // §14 tasks 2 and 4: the server named the fields it refused, so mark those inputs — a toast
            // that fades over a form which still looks valid sends the user pressing Save again.
            const refused = serverFieldErrors(error, ordered.map((entry) => entry.name));
            const names = Object.keys(refused);
            if (names.length > 0) {
              form.setFields(names.map((name) => ({ name, errors: [refused[name] ?? ''] })));
              const first = names[0] ?? '';
              form.scrollToField(first, { behavior: 'smooth', block: 'center' });
              const instance = form.getFieldInstance(first) as { focus?: () => void } | null;
              instance?.focus?.();
              void message.error(t('web.edit.cannotSave'));
            } else {
              void message.error(error instanceof Error ? error.message : t('web.edit.saveFailed'));
            }
          } finally {
            setSaving(false);
            setHasUnsavedChanges(false);
          }
        }}
      >
        {id ? <Form.Item name="version" hidden><input type="hidden" /></Form.Item> : null}
        {panels.length === 0 ? (
          <div style={GRID_STYLE}>{ordered.map(renderField)}</div>
        ) : (
          sections.map((section, index) => {
            // §5.5 progressive disclosure: the first section carries the fields a record is
            // identified by; the rest start folded and open on demand.
            const open = collapsed[section.key] ?? index === 0;
            return (
              <div key={section.key} style={{ marginBottom: 16 }}>
                <button
                  type="button"
                  className="carocrm-section-toggle"
                  aria-expanded={open}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [section.key]: !open }))}
                >
                  <Typography.Text strong>{section.title}</Typography.Text>
                </button>
                {open ? (
                  <div style={GRID_STYLE}>{section.entries.map(renderField)}</div>
                ) : null}
              </div>
            );
          })
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
            onClick={() => {
              submitIntent.current = 'view';
            }}
          >
            {t('web.edit.save')}
          </Button>
          {id === undefined && createKind === undefined ? (
            <Button
              disabled={blocked || linesBlocked || saving}
              onClick={() => {
                submitIntent.current = 'new';
                form.submit();
              }}
            >
              {t('web.edit.saveAndNew')}
            </Button>
          ) : null}
          <Button onClick={() => navigate(id ? `${base}/${entity}/${id}` : `${base}/${entity}`)}>{t('web.edit.cancel')}</Button>
        </Space>
      </Form>
    </Card>
  );
}
