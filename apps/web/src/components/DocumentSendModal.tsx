/**
 * Phase 19-S.17 — document send UI (PLAN_Phase_19_Sales.md §9.4, S.17 task 4).
 *
 * A modal for previewing a document render and confirming recipients before sending. The backend
 * `quoteSend.send` issues a draft quote and queues the email in one transaction; this UI collects
 * explicit recipient intent and a cover message first.
 */

import type { ModalProps } from 'antd';
import { Button, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

const { Text } = Typography;

interface DocumentSendProps {
  visible: boolean;
  documentId: string;
  onClose: () => void;
  onSent?: (emailId: string) => void;
}

export function DocumentSendModal({
  visible,
  documentId,
  onClose,
  onSent,
}: DocumentSendProps) {
  const [preview, setPreview] = useState<{ subject: string; body: string; warnings: string[] } | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachPdf, setAttachPdf] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateCode, setTemplateCode] = useState<string | undefined>(undefined);

  const loadPreview = useCallback(async () => {
    try {
      const rendered = await api.salesRenderQuote(documentId, templateCode);
      setPreview({
        subject: rendered.subject,
        body: rendered.text,
        warnings: [...rendered.warnings],
      });
      setSubject(rendered.subject);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sales.document.sendFailed'));
    }
  }, [documentId, templateCode]);

  useEffect(() => {
    if (visible) void loadPreview();
  }, [visible, loadPreview]);

  const addRecipient = (field: 'to' | 'cc' | 'bcc', email: string) => {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (field === 'to') setRecipients((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    if (field === 'cc') setCc((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    if (field === 'bcc') setBcc((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeRecipient = (field: 'to' | 'cc' | 'bcc', email: string) => {
    if (field === 'to') setRecipients((prev) => prev.filter((e) => e !== email));
    if (field === 'cc') setCc((prev) => prev.filter((e) => e !== email));
    if (field === 'bcc') setBcc((prev) => prev.filter((e) => e !== email));
  };

  const recipientChips = (list: string[], field: 'to' | 'cc' | 'bcc') => (
    <Space wrap>
      {list.map((email) => (
        <span key={email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f6f8fa', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 16, padding: '2px 10px', fontSize: 12 }}>
          {email}
          <Button
            size="small"
            type="text"
            danger
            icon={<Button /> as unknown as React.ReactNode}
            onClick={() => removeRecipient(field, email)}
            style={{ padding: 0, marginLeft: 4 }}
          >
            ×
          </Button>
        </span>
      ))}
    </Space>
  );

  const send = async () => {
    setError(null);
    setSending(true);
    try {
      const sendInput: {
        to: string[];
        cc: string[];
        bcc: string[];
        subject?: string;
        message?: string;
        attachPdf: boolean;
      } = {
        to: recipients,
        cc,
        bcc,
        attachPdf,
      };
      if (subject) sendInput.subject = subject;
      if (message) sendInput.message = message;
      const result = await api.salesSendQuote(documentId, sendInput);
      void onSent?.(String(result.email.id));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sales.document.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={visible}
      title={t('sales.document.send')}
      onCancel={onClose}
      confirmLoading={sending}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('core.common.cancel')}
        </Button>,
        <Button key="send" type="primary" disabled={!recipients.length || sending} onClick={send}>
          {t('core.common.send')}
        </Button>,
      ] as ModalProps['footer']}
      width={720}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {error && <div style={{ color: '#cf1322', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Select
            showSearch
            placeholder={t('sales.document.template')}
            options={[
              { label: t('sales.document.defaultTemplate'), value: '' },
              { label: 'Quote — default', value: 'quoteDefault' },
            ]}
            onChange={(val) => {
              setTemplateCode(val === '' ? undefined : val);
              void loadPreview();
            }}
          />
          <Switch checkedChildren="" unCheckedChildren="" checked={attachPdf} onChange={setAttachPdf} />
          <span style={{ fontSize: 12 }}>{t('sales.document.attachPdf')}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'rgba(0,0,0,0.65)', fontSize: 12 }}>{t('sales.document.recipients')}</Text>
            {recipientChips(recipients, 'to')}
            <Input.TextArea
              showCount
              placeholder={t('sales.lineItem.searchProduct')}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                const text = e.target.value.trim();
                const nativeEvent = e.nativeEvent as InputEvent & Event;
                if (text && (nativeEvent.inputType === 'insertLineBreak' || nativeEvent.inputType === 'insertFromPaste')) {
                  e.target.value = '';
                  addRecipient('to', text.replace(/\s+/g, ' '));
                }
              }}
              onPressEnter={() => {
                const text = recipients[recipients.length - 1];
                if (text) addRecipient('to', text);
              }}
              rows={1}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'rgba(0,0,0,0.65)', fontSize: 12 }}>{t('sales.document.subject')}</Text>
            <Input value={subject} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Text style={{ color: 'rgba(0,0,0,0.65)', fontSize: 12 }}>{t('sales.document.message')}</Text>
            <Input.TextArea value={message} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value)} rows={3} />
          </div>
        </div>

        {preview && (
          <div style={{ border: '1px solid rgba(0,0,0,0.06)', borderRadius: 4, padding: 12, marginTop: 8 }}>
            <Text strong>{preview.subject}</Text>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{preview.body}</div>
            {preview.warnings.length > 0 && (
              <div style={{ marginTop: 8, color: '#cf1322', fontSize: 12 }}>
                {t('sales.document.warnings', { warnings: preview.warnings.join(', ') })}
              </div>
            )}
          </div>
        )}
      </Space>
    </Modal>
  );
}
