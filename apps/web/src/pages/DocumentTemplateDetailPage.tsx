/**
 * Document template detail.
 *
 * The generic record page would show the body as one long cell, which is exactly the wrong thing to
 * look at: a template's body is source. This page shows the rendered page instead — against the same
 * sample document the designer previews — and keeps the source one tab away, with the template's
 * contract (target entity, format, locale, default flag) beside it.
 *
 * Rendering goes through the kernel preview endpoint, so what is shown here is produced by the same
 * renderer that prints the real document, not by a client-side imitation.
 */
import { CodeOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FileTextOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Descriptions, Popconfirm, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { DocumentPreviewView } from '../api/types.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { StreamPanel } from '../components/StreamPanel.js';
import { DOCUMENT_SAMPLE_DATA } from '../document/template-catalog.js';
import { formatDateTime, t } from '../state/i18n.js';
import { fieldLabel, useEntity, useMetadata } from '../state/metadata.js';

type View = 'preview' | 'source';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The tokens a body names, de-duplicated; loop markers (`#each`) are skipped. */
function tokensOf(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(/\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g)) {
    const token = match[1];
    if (token !== undefined && token !== '') out.add(token);
  }
  return [...out];
}

export function DocumentTemplateDetailPage() {
  usePageDocs('user/document-templates');
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const definition = useEntity('DocumentTemplate');
  const metadata = useMetadata().data;

  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('preview');

  const [preview, setPreview] = useState<DocumentPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    if (id === undefined) return;
    setLoading(true);
    try {
      setRecord(await api.get('DocumentTemplate', id));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.detail.notFound'));
      setRecord(undefined);
    } finally {
      setLoading(false);
    }
  }, [id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const code = textOf(record?.['code']);
  const format = textOf(record?.['format']) === 'text' ? 'text' : 'html';
  const subject = textOf(record?.['subject']);
  const body = textOf(record?.['body']);

  useEffect(() => {
    if (code === '') return;
    let active = true;
    setPreviewing(true);
    api
      .previewDocument({ templateCode: code, data: DOCUMENT_SAMPLE_DATA })
      .then((result) => {
        if (!active) return;
        setPreview(result);
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
    return () => {
      active = false;
    };
  }, [code]);

  const tokens = useMemo(() => tokensOf(`${subject}\n${body}`), [subject, body]);

  const frameSrcDoc = useMemo(() => {
    const reset =
      "margin:0;padding:40px 48px;color:var(--carocrm-c-31373d);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.6;background:var(--carocrm-c-ffffff)";
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    if (preview === null) return `<!doctype html><html><head>${head}</head><body style="${reset}"></body></html>`;
    if (format === 'html') {
      return `<!doctype html><html><head>${head}<base target="_blank"></head><body style="${reset}">${preview.body}</body></html>`;
    }
    const escaped = preview.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!doctype html><html><head>${head}</head><body style="${reset};white-space:pre-wrap">${escaped}</body></html>`;
  }, [preview, format]);

  const label = (name: string) => fieldLabel(name, definition.data?.fields?.[name], metadata);
  const name = textOf(record?.['name']);
  const targetEntity = textOf(record?.['targetEntity']);

  if (id === undefined) return <Card>{t('web.detail.missingParams')}</Card>;

  return (
    <Spin spinning={loading}>
      <div className="carocrm-card-stack">
        <Card className="carocrm-card carocrm-dtpl-hero">
          <div className="carocrm-dtpl-hero-main">
            <span className="carocrm-dtpl-icon" aria-hidden>
              <FileTextOutlined />
            </span>
            <div className="carocrm-dtpl-heading">
              <div className="carocrm-dtpl-title-row">
                <Typography.Title level={3} className="carocrm-page-title">
                  {name === '' ? t('web.documentTemplate.untitled') : name}
                </Typography.Title>
                {code === '' ? null : <Tag className="carocrm-dtpl-code-tag">{code}</Tag>}
              </div>
              <Typography.Text type="secondary" className="carocrm-dtpl-description">
                {textOf(record?.['description']) || subject || t('web.documentTemplate.noDescription')}
              </Typography.Text>
              <Space size={6} wrap className="carocrm-dtpl-tags">
                {targetEntity === '' ? null : (
                  <Tag>
                    <Link to={`/${targetEntity}`}>{targetEntity}</Link>
                  </Tag>
                )}
                <Tag>{format === 'html' ? t('web.documentTemplate.formatHtml') : t('web.documentTemplate.formatText')}</Tag>
                {textOf(record?.['locale']) === '' ? null : <Tag>{textOf(record?.['locale'])}</Tag>}
                <Tag color={record?.['active'] === false ? 'default' : 'green'}>
                  {record?.['active'] === false ? t('web.documentTemplate.inactive') : t('web.documentTemplate.active')}
                </Tag>
                {record?.['isDefault'] === true ? <Tag color="blue">{t('web.documentTemplate.default')}</Tag> : null}
              </Space>
            </div>
          </div>
          <Space>
            <Button icon={<EditOutlined />} type="primary" onClick={() => navigate(`/DocumentTemplate/${id}/edit`)}>
              {t('web.detail.edit')}
            </Button>
            <Popconfirm
              title={t('web.detail.deleteThisRecord')}
              onConfirm={async () => {
                try {
                  await api.remove('DocumentTemplate', id);
                  void message.success(t('web.detail.deleted'));
                  navigate('/DocumentTemplate');
                } catch (error) {
                  void message.error(error instanceof Error ? error.message : t('web.detail.deleteFailed'));
                }
              }}
            >
              <Button danger icon={<DeleteOutlined />}>
                {t('web.detail.delete')}
              </Button>
            </Popconfirm>
          </Space>
        </Card>

        <div className="carocrm-dtpl-detail-grid">
          <Card
            className="carocrm-card carocrm-dtpl-preview-card"
            title={
              <Space size={8}>
                <Segmented
                  size="small"
                  value={view}
                  onChange={(value) => setView(value as View)}
                  options={[
                    { value: 'preview', label: t('web.documentTemplate.preview'), icon: <EyeOutlined /> },
                    { value: 'source', label: t('web.documentTemplate.source'), icon: <CodeOutlined /> },
                  ]}
                />
              </Space>
            }
            extra={previewing ? <Spin size="small" /> : null}
          >
            {view === 'preview' ? (
              <div className="carocrm-dtpl-preview-body">
                <div className="carocrm-dtpl-paper carocrm-dtpl-paper--detail">
                  <div className="carocrm-etpl-subject">
                    <Typography.Text className="carocrm-etpl-subject-label">{label('subject')}</Typography.Text>
                    <Typography.Text strong className="carocrm-etpl-subject-value">
                      {preview?.subject ?? subject ?? t('web.documentTemplate.noSubject')}
                    </Typography.Text>
                  </div>
                  <iframe className="carocrm-dtpl-iframe carocrm-dtpl-iframe--detail" title={t('web.documentTemplate.preview')} sandbox="" srcDoc={frameSrcDoc} />
                </div>
                {previewError !== null ? (
                  <Alert
                    type={preview === null ? 'warning' : 'error'}
                    showIcon
                    message={t('web.documentTemplate.previewFailed')}
                    description={previewError}
                  />
                ) : null}
                {preview !== null && preview.warnings.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('web.documentTemplate.unresolved', { count: preview.warnings.length })}
                    description={<span className="carocrm-dtpl-warnings">{preview.warnings.join(' · ')}</span>}
                  />
                ) : null}
                <Typography.Text type="secondary" className="carocrm-dtpl-sample-note">
                  {t('web.documentTemplate.sampleHint')}
                </Typography.Text>
              </div>
            ) : body === '' ? (
              <div className="carocrm-etpl-empty">{t('web.documentTemplate.sourceDenied')}</div>
            ) : (
              <pre className="carocrm-dtpl-source">{body}</pre>
            )}
          </Card>

          <div className="carocrm-card-stack">
            <Card className="carocrm-card" title={t('web.documentTemplate.templateDetails')}>
              <Descriptions
                column={1}
                size="small"
                colon={false}
                styles={{ label: { width: 132, color: 'var(--carocrm-ink-secondary)' } }}
                items={[
                  { key: 'code', label: label('code'), children: <span className="carocrm-dtpl-code">{code}</span> },
                  {
                    key: 'target',
                    label: label('targetEntity'),
                    children: targetEntity === '' ? '—' : <Link to={`/${targetEntity}`}>{targetEntity}</Link>,
                  },
                  {
                    key: 'format',
                    label: label('format'),
                    children: format === 'html' ? t('web.documentTemplate.formatHtml') : t('web.documentTemplate.formatText'),
                  },
                  { key: 'locale', label: label('locale'), children: textOf(record?.['locale']) || '—' },
                  { key: 'subject', label: label('subject'), children: subject || '—' },
                  { key: 'active', label: label('active'), children: record?.['active'] === false ? t('web.documentTemplate.inactive') : t('web.documentTemplate.active') },
                  { key: 'default', label: label('isDefault'), children: record?.['isDefault'] === true ? t('core.common.yes') : t('core.common.no') },
                  { key: 'created', label: t('web.documentTemplate.created'), children: formatDateTime(textOf(record?.['createdAt'])) || '—' },
                  { key: 'modified', label: t('web.documentTemplate.modified'), children: formatDateTime(textOf(record?.['modifiedAt'])) || '—' },
                ]}
              />
            </Card>

            <Card className="carocrm-card" title={t('web.documentTemplate.placeholders')}>
              {tokens.length === 0 ? (
                <Typography.Text type="secondary">{t('web.documentTemplate.noPlaceholders')}</Typography.Text>
              ) : (
                <div className="carocrm-etpl-chips">
                  {tokens.map((token) => (
                    <span key={token} className="carocrm-etpl-chip carocrm-etpl-chip--static">{`{{${token}}}`}</span>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        <StreamPanel entity="DocumentTemplate" id={id} definition={definition.data} canPost />
      </div>
    </Spin>
  );
}
