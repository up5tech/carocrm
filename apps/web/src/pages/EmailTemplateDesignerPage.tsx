/**
 * The Email Template designer (PLAN Phase 11 "Email templates").
 *
 * A template is three text parts and a handful of `{{placeholders}}`, and what an operator
 * needs is the HTML source next to what it looks like in a mailbox — so this is a workspace,
 * not the generic record form.
 *
 * Two ways to shape the HTML part:
 *  - **Visual** (default): a GrapesJS canvas with email-safe blocks. The canvas keeps its
 *    styles as rules while editing; the export is folded back into inline styles, because
 *    that is the form Outlook and friends actually render. Tokens drop into the selected
 *    text component, so personalisation is composed, not pasted.
 *  - **HTML / plain text**: the source editor, with the same live preview beside it.
 *
 * The preview is rendered by the server (`POST /EmailTemplate/action/preview`), because the
 * honest question a designer asks is "what leaves the system", not "what my browser makes of
 * this string". Values are escaped server-side before they enter the HTML and the frame is
 * sandboxed, so neither a draft nor a CRM field that happens to contain markup can run code
 * inside the editor.
 *
 * Saving stays generic entity CRUD (`POST`/`PATCH /EmailTemplate`): the screen adds no
 * storage and no second source of truth for a template record.
 */
import { EyeOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Collapse, Drawer, Form, Input, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type RecordData } from '../api/client.js';
import type { EmailTemplatePreviewView } from '../api/types.js';
import type { EmailVisualEditorHandle } from '../components/email/EmailVisualEditor.js';
import { FieldEditor } from '../components/fields.js';
import { HelpTip } from '../components/HelpTip.js';
import { t } from '../state/i18n.js';
import { editEntries, fieldLabel, recordLabel, useEntity, useMetadata } from '../state/metadata.js';
import { COLOR } from '../theme/tokens.js';

/**
 * GrapesJS is a heavy dependency only the visual mode of this screen needs, so it loads on
 * demand: the source modes and the rest of the app never pay for it.
 */
const EmailVisualEditor = lazy(() => import('../components/email/EmailVisualEditor.js').then((module) => ({ default: module.EmailVisualEditor })));

/** The record shapes the server allowlists as a personalisation sample. */
const SAMPLE_ENTITIES = ['Contact', 'Lead', 'Account', 'User'];

/** Field types whose value is text-like, and therefore a usable placeholder. */
const TOKEN_FIELD_TYPES = new Set(['varchar', 'text', 'int', 'float', 'bool', 'enum', 'datetime', 'date']);

/** The parts the workspace renders itself; every other editable field stays reachable. */
const WORKSPACE_FIELDS = new Set(['name', 'category', 'subject', 'body', 'bodyHtml']);

type DraftKey = 'subject' | 'body' | 'bodyHtml';

/** How the HTML part is being edited. */
type EditMode = 'visual' | 'html' | 'text';

interface Draft {
  subject: string;
  body: string;
  bodyHtml: string;
}

function draftOf(values: RecordData | undefined): Draft {
  const text = (key: DraftKey) => (typeof values?.[key] === 'string' ? String(values?.[key]) : '');
  return { subject: text('subject'), body: text('body'), bodyHtml: text('bodyHtml') };
}

/**
 * Inserts at the caret of whichever part last had focus. `insertText` is the editor-grade path because
 * it keeps the caret, the undo stack and the controlled value in step; writing the value by hand is the
 * fallback where the command is refused.
 */
function insertToken(form: ReturnType<typeof Form.useForm>[0], token: string, fallback: DraftKey): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const target = active.getAttribute('data-token-target');
    if (target === 'subject' || target === 'body' || target === 'bodyHtml') {
      active.focus();
      if (document.execCommand('insertText', false, token)) return true;
      const before = active.value;
      const start = active.selectionStart ?? before.length;
      const end = active.selectionEnd ?? before.length;
      form.setFieldValue(target, `${before.slice(0, start)}${token}${before.slice(end)}`);
      return true;
    }
  }
  const current = typeof form.getFieldValue(fallback) === 'string' ? String(form.getFieldValue(fallback)) : '';
  form.setFieldValue(fallback, `${current}${token}`);
  return false;
}

export function EmailTemplateDesignerPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const definition = useEntity('EmailTemplate');
  const metadata = useMetadata().data;
  const [form] = Form.useForm();
  const watched = Form.useWatch([], form) as RecordData | undefined;
  const visualEditorRef = useRef<EmailVisualEditorHandle | null>(null);

  const [initial, setInitial] = useState<RecordData | undefined>(id === undefined ? {} : undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<EditMode>('visual');
  const [previewOpen, setPreviewOpen] = useState(false);

  const [preview, setPreview] = useState<EmailTemplatePreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  const [sampleType, setSampleType] = useState<string>('Contact');
  const [sampleId, setSampleId] = useState<string | undefined>(undefined);
  const [sampleTerm, setSampleTerm] = useState('');
  const [sampleOptions, setSampleOptions] = useState<{ value: string; label: string }[]>([]);
  const [activePart, setActivePart] = useState<DraftKey>('bodyHtml');

  const sampleDefinition = useEntity(sampleType).data;
  const draft = useMemo(() => draftOf(watched ?? initial), [watched, initial]);
  const hasContent = draft.subject !== '' || draft.body !== '' || draft.bodyHtml !== '';

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api
      .get('EmailTemplate', id)
      .then((record) => {
        if (cancelled) return;
        setInitial(record);
        form.setFieldsValue({ ...record });
        setDirty(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        void message.error(error instanceof Error ? error.message : t('web.edit.notFound'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, form, message]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        form.submit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [form]);

  // Server-side search: a workspace holds far more records than one page.
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api
        .list(sampleType, {
          where: sampleTerm.trim() === '' ? undefined : [{ field: 'name', operator: 'contains', value: sampleTerm.trim() }],
          orderBy: '-createdAt',
          maxSize: 30,
          total: false,
        })
        .then((result) => {
          if (active) setSampleOptions(result.list.map((record) => ({ value: String(record['id']), label: recordLabel(record) })));
        })
        .catch(() => {
          if (active) setSampleOptions([]);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sampleType, sampleTerm]);

  useEffect(() => {
    if (!hasContent) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    let active = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewEmailTemplate({
          subject: draft.subject,
          body: draft.body,
          bodyHtml: draft.bodyHtml,
          ...(sampleId === undefined ? {} : { sampleEntityType: sampleType, sampleEntityId: sampleId }),
        })
        .then((view) => {
          if (!active) return;
          setPreview(view);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : t('web.emailTemplate.previewFailed'));
        })
        .finally(() => {
          if (active) setPreviewing(false);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft.subject, draft.body, draft.bodyHtml, hasContent, sampleId, sampleType]);

  /**
   * The palette names the fields of the sample type that is selected: those are the tokens a send
   * resolves against the recipient, and the list stays the same length whether or not a record has
   * been picked yet.
   */
  const paletteFields = sampleDefinition?.fields;
  const tokens = useMemo(
    () =>
      [...new Set(['id', ...Object.entries(paletteFields ?? {}).filter(([, field]) => TOKEN_FIELD_TYPES.has(field.type)).map(([name]) => name)])],
    [paletteFields],
  );
  const tokenLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, field] of Object.entries(paletteFields ?? {})) out[name] = fieldLabel(name, field, metadata);
    return out;
  }, [paletteFields, metadata]);

  const otherEntries = useMemo(() => editEntries(definition.data).filter((entry) => !WORKSPACE_FIELDS.has(entry.name)), [definition.data]);

  const onToken = useCallback(
    (token: string) => {
      if (mode === 'visual') {
        if (visualEditorRef.current?.insertToken(`{{${token}}}`)) {
          setDirty(true);
          return;
        }
      }
      if (!insertToken(form, `{{${token}}}`, activePart)) void message.info(t('web.emailTemplate.tokenAppended'));
      setDirty(true);
    },
    [activePart, form, message, mode],
  );

  const label = (name: DraftKey | 'name' | 'category') => fieldLabel(name, definition.data?.fields?.[name], metadata);

  const frameSrcDoc = useMemo(() => {
    const reset = `margin:0;padding:16px;color:${COLOR.inkPrimary};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6`;
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    if (preview === null) return `<!doctype html><html><head>${head}</head><body style="${reset}"></body></html>`;
    if (preview.bodyHtml !== null && preview.bodyHtml !== '') {
      return `<!doctype html><html><head>${head}<base target="_blank"></head><body style="${reset}">${preview.bodyHtml}</body></html>`;
    }
    const text = (preview.body ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!doctype html><html><head>${head}</head><body style="${reset};white-space:pre-wrap">${text}</body></html>`;
  }, [preview]);

  if (id !== undefined && initial === undefined && !loadFailed) {
    return (
      <Card className="carocrm-card">
        <Spin />
      </Card>
    );
  }

  const entityLabel = definition.data?.label ?? 'Email Template';

  /** The server render and its controls; the visual mode shows it in a drawer, the source modes beside the editor. */
  const previewPane = (
    <div className="carocrm-etpl-preview" role="region" aria-label={t('web.emailTemplate.preview')}>
      <div className="carocrm-etpl-preview-bar">
        <Segmented
          size="small"
          value={device}
          onChange={(value) => setDevice(value as 'desktop' | 'mobile')}
          options={[{ value: 'desktop', label: t('web.emailTemplate.desktop') }, { value: 'mobile', label: t('web.emailTemplate.mobile') }]}
        />
        <div className="carocrm-etpl-sample">
          <Select
            size="small"
            value={sampleType}
            aria-label={t('web.emailTemplate.sampleType')}
            className="carocrm-etpl-sample-type"
            onChange={(value: string) => {
              setSampleType(value);
              setSampleId(undefined);
              setSampleTerm('');
            }}
            options={SAMPLE_ENTITIES.map((entity) => ({ value: entity, label: entity }))}
          />
          <Select
            size="small"
            showSearch
            allowClear
            placeholder={t('web.emailTemplate.sampleRecord')}
            aria-label={t('web.emailTemplate.sampleRecord')}
            className="carocrm-etpl-sample-record"
            value={sampleId}
            filterOption={false}
            onSearch={setSampleTerm}
            onChange={(value: string | undefined) => setSampleId(value)}
            options={sampleOptions}
            notFoundContent={sampleTerm.trim() === '' ? t('web.emailTemplate.sampleEmpty') : <Spin size="small" />}
          />
        </div>
      </div>

      <div className={`carocrm-etpl-frame carocrm-etpl-frame--${device}`}>
        <div className="carocrm-etpl-subject">
          <Typography.Text className="carocrm-etpl-subject-label">{label('subject')}</Typography.Text>
          <Typography.Text strong className="carocrm-etpl-subject-value">
            {preview?.subject ?? draft.subject ?? t('web.emailTemplate.noSubject')}
            {previewing ? <Spin size="small" className="carocrm-etpl-spinner" /> : null}
          </Typography.Text>
        </div>
        {hasContent ? (
          <iframe className="carocrm-etpl-iframe" title={t('web.emailTemplate.preview')} sandbox="" srcDoc={frameSrcDoc} />
        ) : (
          <div className="carocrm-etpl-empty">{t('web.emailTemplate.nothingToPreview')}</div>
        )}
      </div>

      {previewError !== null ? <Alert type="error" showIcon message={t('web.emailTemplate.previewFailed')} description={previewError} /> : null}
      {preview !== null && preview.unresolved.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('web.emailTemplate.unresolved', { tokens: preview.unresolved.map((token) => `{{${token}}}`).join(', ') })}
          description={t('web.emailTemplate.unresolvedHint')}
        />
      ) : null}
      {preview !== null && preview.sample !== null && preview.unresolved.length === 0 && preview.placeholders.length > 0 ? (
        <Typography.Text type="secondary" className="carocrm-etpl-note">
          {t('web.emailTemplate.personalisedWith', { record: preview.sample.label })}
        </Typography.Text>
      ) : null}
    </div>
  );

  /** The placeholder chips; the same palette feeds the canvas and the source editors. */
  const tokenChips = (
    <div className="carocrm-etpl-tokens">
      <Typography.Text type="secondary" className="carocrm-etpl-tokens-label">
        {t('web.emailTemplate.placeholders')}
        <HelpTip>
          {mode === 'visual'
            ? t('web.emailTemplate.placeholderVisualHint', { entity: sampleType })
            : t('web.emailTemplate.placeholderHint', { entity: sampleType })}
        </HelpTip>
      </Typography.Text>
      <div className="carocrm-etpl-chips">
        {tokens.map((token) => (
          <Tooltip key={token} title={tokenLabels[token] ?? token}>
            <button type="button" className="carocrm-etpl-chip" onClick={() => onToken(token)}>
              {`{{${token}}}`}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );

  return (
    <Card
      className="carocrm-card carocrm-etpl-card"
      title={<Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{id === undefined ? t('web.edit.createTitle', { entity: entityLabel }) : t('web.edit.editTitle', { entity: entityLabel })}</Typography.Title>}
      extra={
        <Space>
          <Segmented
            size="small"
            value={mode}
            onChange={(value) => setMode(value as EditMode)}
            options={[
              { value: 'visual', label: t('web.emailTemplate.visualTab') },
              { value: 'html', label: t('web.emailTemplate.htmlTab') },
              { value: 'text', label: t('web.emailTemplate.textTab') },
            ]}
          />
          {mode === 'visual' ? (
            <Button icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>
              {t('web.emailTemplate.preview')}
            </Button>
          ) : null}
          <Button onClick={() => navigate(id ? `/EmailTemplate/${id}` : '/EmailTemplate')}>{t('web.edit.cancel')}</Button>
          <Button type="primary" htmlType="submit" form="carocrm-etpl-form" loading={saving}>{t('web.edit.save')}</Button>
        </Space>
      }
    >
      <div className={mode === 'visual' ? 'carocrm-etpl carocrm-etpl--visual' : 'carocrm-etpl'}>
        <Form
          id="carocrm-etpl-form"
          form={form}
          layout="vertical"
          className="carocrm-etpl-edit"
          initialValues={initial ?? {}}
          onValuesChange={() => setDirty(true)}
          onFinish={async (values: RecordData) => {
            setSaving(true);
            try {
              const payload: RecordData = { ...values };
              if (id === undefined) {
                const created = await api.create('EmailTemplate', payload);
                setDirty(false);
                void message.success(t('web.edit.saved'));
                navigate(`/EmailTemplate/${String(created['id'] ?? '')}`);
              } else {
                await api.update('EmailTemplate', id, { ...payload, version: initial?.['version'] });
                setDirty(false);
                void message.success(t('web.edit.saved'));
                navigate(`/EmailTemplate/${id}`);
              }
            } catch (error: unknown) {
              void message.error(error instanceof Error ? error.message : t('web.edit.saveFailed'));
            } finally {
              setSaving(false);
            }
          }}
        >
          {id ? <Form.Item name="version" hidden><input type="hidden" /></Form.Item> : null}

          <div className="carocrm-etpl-meta">
            <Form.Item name="name" label={label('name')} rules={[{ required: true, message: t('web.edit.required', { field: label('name') }) }, { max: 255 }]}>
              <Input />
            </Form.Item>
            <Form.Item name="category" label={label('category')}>
              <Input />
            </Form.Item>
          </div>

          <Form.Item
            name="subject"
            label={
              <span>
                {label('subject')}
                <HelpTip>{t('web.emailTemplate.subjectHint')}</HelpTip>
              </span>
            }
            rules={[{ required: true, message: t('web.edit.required', { field: label('subject') }) }, { max: 998 }]}
          >
            <Input data-token-target="subject" onFocus={() => setActivePart('subject')} />
          </Form.Item>

          {mode === 'visual' ? (
            <>
              <Form.Item name="bodyHtml" hidden><input type="hidden" /></Form.Item>
              {tokenChips}
              <Suspense
                fallback={
                  <div className="carocrm-gjs carocrm-gjs-loading">
                    <Spin size="large" />
                  </div>
                }
              >
                <EmailVisualEditor
                  ref={visualEditorRef}
                  value={draft.bodyHtml}
                  onChange={(html) => {
                    form.setFieldValue('bodyHtml', html);
                    setDirty(true);
                  }}
                />
              </Suspense>
            </>
          ) : (
            <>
              <Form.Item name={mode === 'html' ? 'bodyHtml' : 'body'} noStyle>
                <Input.TextArea
                  className="carocrm-etpl-source"
                  data-token-target={mode}
                  autoSize={{ minRows: 14, maxRows: 26 }}
                  spellCheck={false}
                  placeholder={mode === 'html' ? '<p>{{firstName}},</p>' : '{{firstName}},'}
                  onFocus={() => setActivePart(mode === 'html' ? 'bodyHtml' : 'body')}
                />
              </Form.Item>
              {tokenChips}
            </>
          )}

          {otherEntries.length > 0 ? (
            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'other',
                  label: t('web.emailTemplate.otherFields'),
                  children: (
                    <div className="carocrm-etpl-meta">
                      {otherEntries.map((entry) => (
                        <Form.Item
                          key={entry.name}
                          name={entry.name}
                          label={fieldLabel(entry.name, entry.field, metadata)}
                          valuePropName={entry.field.type === 'bool' ? 'checked' : 'value'}
                        >
                          <FieldEditor fieldName={entry.name} field={entry.field} value={undefined} onChange={() => undefined} />
                        </Form.Item>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          ) : null}
        </Form>

        {mode === 'visual' ? null : previewPane}
      </div>

      {mode === 'visual' ? (
        <Drawer
          title={t('web.emailTemplate.preview')}
          placement="right"
          width={520}
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          className="carocrm-etpl-drawer"
        >
          {previewPane}
        </Drawer>
      ) : null}
    </Card>
  );
}
