/**
 * Phase 19-S.17 — sending a commercial document by mail (PLAN_Phase_19_Sales.md §9.4, S.17 task 4).
 *
 * One modal for the ten document kinds. It previews the render the server would send, collects
 * recipients and a cover note, and then calls the send command — which **issues** a draft through the
 * kind's own transition and queues the email, all before this call returns. So the two rules this UI
 * has to respect:
 *
 *  - recipients may be left empty: the backend derives the counterparty's address (the supplier for a
 *    purchasing document, the contact then the account for a selling one) and refuses only when there
 *    is genuinely nobody to mail. The refusal, not a client-side guess, is the guard.
 *  - the preview is the server's render of the same template, placeholders and all. Nothing here sums
 *    a total or composes a subject line locally, so what the user reads is byte-for-byte what goes out.
 */

import { Alert, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { SalesRenderResult } from '../api/types.js';
import { t } from '../state/i18n.js';

const { Text } = Typography;

const ADDRESS_SEPARATORS = [',', ';', ' '];

interface DocumentSendModalProps {
  readonly open: boolean;
  /** The Sales document kind, e.g. `invoice`. A `quote` keeps its own documented route. */
  readonly kind: string;
  /** The metadata entity, used to list the templates configured for this document type. */
  readonly entity: string;
  readonly id: string;
  readonly onClose: () => void;
  readonly onSent?: (emailId: string) => void;
}

export function DocumentSendModal({ open, kind, entity, id, onClose, onSent }: DocumentSendModalProps) {
  const [preview, setPreview] = useState<SalesRenderResult | null>(null);
  const [templates, setTemplates] = useState<readonly { value: string; label: string }[]>([]);
  const [templateCode, setTemplateCode] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachPdf, setAttachPdf] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(
    async (code?: string) => {
      try {
        const rendered =
          kind === 'quote'
            ? await api.salesRenderQuote(id, code)
            : await api.salesRenderDocument(kind, id, code);
        setPreview(rendered);
        setSubject(rendered.subject);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('sales.document.sendFailed'));
      }
    },
    [id, kind],
  );

  useEffect(() => {
    if (!open) return;
    void loadPreview(templateCode);
    let active = true;
    void (async () => {
      try {
        const list = await api.list('DocumentTemplate', {
          maxSize: 100,
          orderBy: 'name,asc',
          where: [
            { field: 'entityType', operator: 'equals', value: entity },
            { field: 'active', operator: 'equals', value: true },
          ],
        });
        if (!active) return;
        setTemplates(
          list.list
            .map((row) => ({ value: String(row['code'] ?? ''), label: String(row['name'] ?? '') }))
            .filter((option) => option.value !== ''),
        );
      } catch {
        // With no template readable the server still renders its built-in layout, which is a valid send.
        if (active) setTemplates([]);
      }
    })();
    return () => {
      active = false;
    };
    // Opening the modal re-renders and re-reads the templates; changing the template is handled by the
    // select itself, so this effect must not depend on `templateCode` or it would render twice.
  }, [open, entity, id, loadPreview]);

  const send = async () => {
    setError(null);
    setSending(true);
    const trimmedSubject = subject.trim();
    const trimmedMessage = message.trim();
    const input = {
      ...(to.length > 0 ? { to } : {}),
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(templateCode === undefined ? {} : { templateCode }),
      ...(trimmedSubject === '' ? {} : { subject: trimmedSubject }),
      ...(trimmedMessage === '' ? {} : { message: trimmedMessage }),
      attachPdf,
    };
    try {
      const result =
        kind === 'quote'
          ? await api.salesSendQuote(id, input)
          : await api.salesSendDocument(kind, id, input);
      onSent?.(String(result.email['id']));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sales.document.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const addresses = (
    label: string,
    value: string[],
    onChange: (next: string[]) => void,
    placeholder?: string,
  ) => (
    <div style={{ flex: 1 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <Select
        mode="tags"
        style={{ width: '100%' }}
        value={value}
        onChange={onChange}
        tokenSeparators={ADDRESS_SEPARATORS}
        open={false}
        suffixIcon={null}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <Modal
      open={open}
      title={`${t('sales.document.send')} — ${entity}`}
      onCancel={onClose}
      onOk={() => void send()}
      okText={t('sales.document.send')}
      confirmLoading={sending}
      width={720}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {error !== null ? <Alert type="error" showIcon message={error} /> : null}

        <Space size={12} align="center" wrap>
          <Select
            style={{ minWidth: 240 }}
            value={templateCode ?? ''}
            placeholder={t('sales.document.defaultTemplate')}
            options={[{ value: '', label: t('sales.document.defaultTemplate') }, ...templates]}
            onChange={(value: string) => {
              const next = value === '' ? undefined : value;
              setTemplateCode(next);
              void loadPreview(next);
            }}
          />
          <Switch checked={attachPdf} onChange={setAttachPdf} />
          <Text style={{ fontSize: 12 }}>{t('sales.document.attachPdf')}</Text>
        </Space>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('sales.document.recipientsHint')}
          </Text>
          <Space size={8} align="start" style={{ width: '100%' }}>
            {addresses(t('sales.document.recipients'), to, setTo, 'name@example.com')}
            <div style={{ flex: 1 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('sales.document.subject')}
              </Text>
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </div>
          </Space>
          <Space size={8} style={{ width: '100%', marginTop: 8 }}>
            {addresses('CC', cc, setCc)}
            {addresses('BCC', bcc, setBcc)}
          </Space>
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('sales.document.message')}
          </Text>
          <Input.TextArea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} />
        </div>

        {preview !== null ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('sales.document.preview')}
            </Text>
            <div className="sales-send-preview">{preview.text}</div>
            {preview.warnings.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message={t('sales.document.warnings', { warnings: preview.warnings.join(', ') })}
              />
            ) : null}
          </div>
        ) : null}
      </Space>
    </Modal>
  );
}
