/**
 * Document template workspace (create + edit).
 *
 * A document template is not a record form: the body is HTML (or plain text) with `{{tokens}}`, and
 * what an operator needs is the canvas next to the page that will actually be produced. So this is
 * the same shape as the email template designer — a visual GrapesJS canvas, an HTML source tab, a
 * placeholder palette and a server-rendered preview — for the document engine instead of the mail
 * one.
 *
 * The preview calls the kernel renderer with a representative sample document, so the answer to
 * "what will this look like" comes from the same code that prints the real invoice. Saving stays
 * generic entity CRUD (`POST`/`PATCH /DocumentTemplate`); the screen adds no second storage.
 */
import { EyeOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type RecordData } from '../api/client.js';
import type { DocumentPreviewView } from '../api/types.js';
import { DOCUMENT_BLOCKS } from '../components/document/documentBlocks.js';
import type { EmailVisualEditorHandle } from '../components/email/EmailVisualEditor.js';
import { HelpTip } from '../components/HelpTip.js';
import {
  DOCUMENT_SAMPLE_DATA,
  DOCUMENT_TARGET_ENTITIES,
  DOCUMENT_TOKEN_GROUPS,
} from '../document/template-catalog.js';
import { t } from '../state/i18n.js';
import { COLOR } from '../theme/tokens.js';
import { fieldLabel, useEntity, useMetadata } from '../state/metadata.js';

const EmailVisualEditor = lazy(() => import('../components/email/EmailVisualEditor.js').then((module) => ({ default: module.EmailVisualEditor })));

type Mode = 'visual' | 'html';
type Format = 'html' | 'text';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Inserts at the caret of the body source. `insertText` keeps the caret and the undo stack; setting
 * the value by hand is the fallback when the command is refused.
 */
function insertToken(form: ReturnType<typeof Form.useForm>[0], token: string): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const target = active.getAttribute('data-token-target');
    if (target === 'body' || target === 'subject') {
      active.focus();
      if (document.execCommand('insertText', false, token)) return;
      const before = active.value;
      const start = active.selectionStart ?? before.length;
      const end = active.selectionEnd ?? before.length;
      form.setFieldValue(target, `${before.slice(0, start)}${token}${before.slice(end)}`);
      return;
    }
  }
  const current = textOf(form.getFieldValue('body'));
  form.setFieldValue('body', `${current}${token}`);
}

export function DocumentTemplateDesignerPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const definition = useEntity('DocumentTemplate');
  const metadata = useMetadata().data;
  const [form] = Form.useForm();
  const watched = Form.useWatch([], form) as RecordData | undefined;
  const visualEditorRef = useRef<EmailVisualEditorHandle | null>(null);

  const [initial, setInitial] = useState<RecordData | undefined>(id === undefined ? {} : undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('visual');
  const [previewOpen, setPreviewOpen] = useState(false);

  const [preview, setPreview] = useState<DocumentPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const subject = textOf(watched?.['subject'] ?? initial?.['subject']);
  const body = textOf(watched?.['body'] ?? initial?.['body']);
  const format = (watched?.['format'] ?? initial?.['format'] ?? 'html') === 'text' ? 'text' : 'html';
  const hasContent = body.trim() !== '' || subject.trim() !== '';
  const effectiveMode: Mode | 'text' = format === 'text' ? 'text' : mode;

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api
      .get('DocumentTemplate', id)
      .then((record) => {
        if (cancelled) return;
        setInitial(record);
        form.setFieldsValue({ ...record });
        setDirty(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        void message.error(error instanceof Error ? error.message : t('web.detail.notFound'));
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
        .previewDocument({
          body,
          subject,
          format,
          data: DOCUMENT_SAMPLE_DATA,
        })
        .then((view) => {
          if (!active) return;
          setPreview(view);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : t('web.documentTemplate.previewFailed'));
        })
        .finally(() => {
          if (active) setPreviewing(false);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [body, subject, format, hasContent]);

  const label = useCallback(
    (name: string) => fieldLabel(name, definition.data?.fields?.[name], metadata),
    [definition.data, metadata],
  );

  const targetOptions = useMemo(() => {
    const names = new Set<string>(['Document', ...DOCUMENT_TARGET_ENTITIES]);
    const current = textOf(watched?.['targetEntity'] ?? initial?.['targetEntity']);
    if (current !== '') names.add(current);
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [watched, initial]);

  const onToken = useCallback(
    (token: string) => {
      const braced = `{{${token}}}`;
      if (effectiveMode === 'visual' && visualEditorRef.current?.insertToken(braced)) {
        setDirty(true);
        return;
      }
      insertToken(form, braced);
      if (effectiveMode === 'visual') void message.info(t('web.documentTemplate.tokenAppended'));
      setDirty(true);
    },
    [effectiveMode, form, message],
  );

  const frameSrcDoc = useMemo(() => {
    const reset =
      `margin:0;padding:40px 48px;color:${COLOR.inkPrimary};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.6;background:${COLOR.surfaceRaised}`;
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    if (preview === null) return `<!doctype html><html><head>${head}</head><body style="${reset}"></body></html>`;
    if (format === 'html') {
      return `<!doctype html><html><head>${head}<base target="_blank"></head><body style="${reset}">${preview.body}</body></html>`;
    }
    const escaped = preview.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!doctype html><html><head>${head}</head><body style="${reset};white-space:pre-wrap">${escaped}</body></html>`;
  }, [preview, format]);

  if (id !== undefined && initial === undefined && !loadFailed) {
    return (
      <Card className="carocrm-card">
        <Spin />
      </Card>
    );
  }

  const entityLabel = definition.data?.label ?? 'Document Template';

  const previewPane = (
    <div className="carocrm-etpl-preview" role="region" aria-label={t('web.documentTemplate.preview')}>
      <div className="carocrm-etpl-preview-bar">
        <Typography.Text type="secondary" className="carocrm-dtpl-preview-hint">
          {t('web.documentTemplate.sampleHint')}
        </Typography.Text>
      </div>
      <div className="carocrm-dtpl-paper">
        <div className="carocrm-etpl-subject">
          <Typography.Text className="carocrm-etpl-subject-label">{label('subject')}</Typography.Text>
          <Typography.Text strong className="carocrm-etpl-subject-value">
            {preview?.subject ?? subject ?? t('web.documentTemplate.noSubject')}
            {previewing ? <Spin size="small" className="carocrm-etpl-spinner" /> : null}
          </Typography.Text>
        </div>
        {hasContent ? (
          <iframe className="carocrm-dtpl-iframe" title={t('web.documentTemplate.preview')} sandbox="" srcDoc={frameSrcDoc} />
        ) : (
          <div className="carocrm-etpl-empty">{t('web.documentTemplate.nothingToPreview')}</div>
        )}
      </div>
      {previewError !== null ? (
        <Alert type="error" showIcon message={t('web.documentTemplate.previewFailed')} description={previewError} />
      ) : null}
      {preview !== null && preview.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('web.documentTemplate.unresolved', { count: preview.warnings.length })}
          description={<span className="carocrm-dtpl-warnings">{preview.warnings.join(' · ')}</span>}
        />
      ) : null}
    </div>
  );

  const tokenPalette = (
    <div className="carocrm-dtpl-tokens">
      <Typography.Text type="secondary" className="carocrm-etpl-tokens-label">
        {t('web.documentTemplate.placeholders')}
        <HelpTip>{t('web.documentTemplate.placeholderHint')}</HelpTip>
      </Typography.Text>
      <div className="carocrm-dtpl-token-groups">
        {DOCUMENT_TOKEN_GROUPS.map((group) => (
          <div key={group.key} className="carocrm-dtpl-token-group">
            <Typography.Text className="carocrm-dtpl-token-group-label">
              {t(`web.documentTemplate.tokenGroups.${group.labelKey}`)}
              {group.loop === true ? <span className="carocrm-dtpl-loop-hint">#each lines</span> : null}
            </Typography.Text>
            <div className="carocrm-etpl-chips">
              {group.tokens.map((token) => (
                <Tooltip key={token.value} title={t(`web.documentTemplate.tokens.${token.labelKey}`)}>
                  <button type="button" className="carocrm-etpl-chip" onClick={() => onToken(token.value)}>
                    {`{{${token.value}}}`}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Card
      className="carocrm-card carocrm-etpl-card"
      title={
        <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>
          {id === undefined ? t('web.edit.createTitle', { entity: entityLabel }) : t('web.edit.editTitle', { entity: entityLabel })}
        </Typography.Title>
      }
      extra={
        <Space>
          {format === 'html' ? (
            <Segmented
              size="small"
              value={mode}
              onChange={(value) => setMode(value as Mode)}
              options={[
                { value: 'visual', label: t('web.documentTemplate.visualTab') },
                { value: 'html', label: t('web.documentTemplate.htmlTab') },
              ]}
            />
          ) : null}
          {effectiveMode === 'visual' ? (
            <Button icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>
              {t('web.documentTemplate.preview')}
            </Button>
          ) : null}
          <Button onClick={() => navigate(id === undefined ? '/DocumentTemplate' : `/DocumentTemplate/${id}`)}>{t('web.edit.cancel')}</Button>
          <Button type="primary" htmlType="submit" form="carocrm-dtpl-form" loading={saving}>
            {t('web.edit.save')}
          </Button>
        </Space>
      }
    >
      <div className={effectiveMode === 'visual' ? 'carocrm-etpl carocrm-etpl--visual' : 'carocrm-etpl'}>
        <Form
          id="carocrm-dtpl-form"
          form={form}
          layout="vertical"
          className="carocrm-etpl-edit"
          initialValues={{ active: true, isDefault: false, format: 'html', ...(initial ?? {}) }}
          onValuesChange={() => setDirty(true)}
          onFinish={async (values: RecordData) => {
            setSaving(true);
            try {
              const name = textOf(values['name']).trim();
              const description = textOf(values['description']).trim();
              const cleanSubject = textOf(values['subject']).trim();
              const locale = textOf(values['locale']).trim();
              const nextFormat: Format = values['format'] === 'text' ? 'text' : 'html';
              const payload: RecordData = {
                name,
                body: textOf(values['body']),
                format: nextFormat,
                active: values['active'] !== false,
                isDefault: values['isDefault'] === true,
              };
              if (id === undefined) {
                const created = await api.create('DocumentTemplate', {
                  ...payload,
                  code: textOf(values['code']).trim(),
                  entityType: textOf(values['targetEntity']),
                  ...(description === '' ? {} : { description }),
                  ...(cleanSubject === '' ? {} : { subject: cleanSubject }),
                  ...(locale === '' ? {} : { locale }),
                });
                setDirty(false);
                void message.success(t('web.edit.saved'));
                navigate(`/DocumentTemplate/${String(created['id'] ?? '')}`);
              } else {
                await api.update('DocumentTemplate', id, {
                  ...payload,
                  description: description === '' ? null : description,
                  subject: cleanSubject === '' ? null : cleanSubject,
                  locale: locale === '' ? null : locale,
                });
                setDirty(false);
                void message.success(t('web.edit.saved'));
                navigate(`/DocumentTemplate/${id}`);
              }
            } catch (error: unknown) {
              void message.error(error instanceof Error ? error.message : t('web.edit.saveFailed'));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="name"
                label={label('name')}
                rules={[{ required: true, message: t('web.edit.required', { field: label('name') }) }, { max: 255 }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="code"
                label={label('code')}
                rules={[{ required: true, message: t('web.edit.required', { field: label('code') }) }, { max: 64 }]}
                extra={id === undefined ? t('web.documentTemplate.codeHint') : t('web.documentTemplate.codeLocked')}
              >
                <Input disabled={id !== undefined} spellCheck={false} className="carocrm-dtpl-code" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="targetEntity"
                label={label('targetEntity')}
                rules={[{ required: true, message: t('web.edit.required', { field: label('targetEntity') }) }]}
                extra={id === undefined ? undefined : t('web.documentTemplate.targetLocked')}
              >
                <Select showSearch options={targetOptions} disabled={id !== undefined} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="format" label={label('format')} rules={[{ required: true }]}>
                <Segmented
                  block
                  options={[
                    { value: 'html', label: t('web.documentTemplate.formatHtml') },
                    { value: 'text', label: t('web.documentTemplate.formatText') },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="description" label={label('description')}>
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={2000} />
              </Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Form.Item
                name="subject"
                label={
                  <span>
                    {label('subject')}
                    <HelpTip>{t('web.documentTemplate.subjectHint')}</HelpTip>
                  </span>
                }
                rules={[{ max: 255 }]}
              >
                <Input data-token-target="subject" />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item name="locale" label={label('locale')}>
                <Input placeholder="en" maxLength={8} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Space size={16} className="carocrm-dtpl-switches">
                <Form.Item name="active" label={label('active')} valuePropName="checked">
                  <Switch size="small" />
                </Form.Item>
                <Form.Item name="isDefault" label={label('isDefault')} valuePropName="checked">
                  <Switch size="small" />
                </Form.Item>
              </Space>
            </Col>
          </Row>

          <Form.Item
            name="body"
            label={
              <span>
                {label('body')}
                <HelpTip>{t('web.documentTemplate.bodyHint')}</HelpTip>
              </span>
            }
            rules={[{ required: true, message: t('web.edit.required', { field: label('body') }) }, { max: 200_000 }]}
          >
            {effectiveMode === 'visual' ? (
              <input type="hidden" />
            ) : (
              <Input.TextArea
                className="carocrm-etpl-source"
                data-token-target="body"
                autoSize={{ minRows: 16, maxRows: 30 }}
                spellCheck={false}
                placeholder={format === 'html' ? '<h2>Invoice {{number}}</h2>' : 'Invoice {{number}}'}
              />
            )}
          </Form.Item>

          {effectiveMode === 'visual' ? (
            <>
              {tokenPalette}
              <Suspense
                fallback={
                  <div className="carocrm-gjs carocrm-gjs-loading">
                    <Spin size="large" />
                  </div>
                }
              >
                <EmailVisualEditor
                  ref={visualEditorRef}
                  value={body}
                  blocks={DOCUMENT_BLOCKS}
                  blockLabelPrefix="web.documentTemplate.blocks"
                  deviceLabelPrefix="web.documentTemplate"
                  onChange={(html) => {
                    form.setFieldValue('body', html);
                    setDirty(true);
                  }}
                />
              </Suspense>
            </>
          ) : (
            tokenPalette
          )}
        </Form>
        {effectiveMode === 'visual' ? null : previewPane}
      </div>

      <Drawer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={760}
        title={t('web.documentTemplate.preview')}
        className="carocrm-etpl-drawer"
      >
        {previewPane}
      </Drawer>
    </Card>
  );
}
