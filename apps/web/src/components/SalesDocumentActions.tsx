/**
 * Phase 19-S.17 task 8 — the document's own commands, driven by the server's descriptor.
 *
 * Until now a document could only be **sent** from the UI; issuing an invoice, voiding it, confirming
 * an order, cancelling one, converting a quote into an order and unlocking an issued document were
 * API-only. That is the difference between a module you can use and one you can only demonstrate.
 *
 * Three rules shape this component, and each of them is the reason it looks the way it does:
 *
 *  - **The server decides what is possible.** The buttons come from `view.actions` /
 *    `view.conversions`, which the engine derives from the document's current state and its own
 *    descriptor. Nothing here hard-codes "an issued invoice can be voided" — if the state machine
 *    changes, this screen follows without an edit.
 *  - **A privileged action asks for its reason first.** `requiresReason` is on the action itself, so
 *    the modal appears before the request rather than as a 422 afterwards. The reason is the audit
 *    trail's, not decoration: the server refuses the command without it.
 *  - **Issuing is confirmed.** It allocates the official number, freezes the snapshot and locks the
 *    document (§4.7), so it is the one click that deserves a question. Everything else runs on the
 *    click, because a confirm dialog on every button trains people to dismiss them.
 */

import { LockOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Input, Modal, Space, Typography } from 'antd';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { SalesDocumentAction, SalesDocumentView } from '../api/types.js';
import { t } from '../state/i18n.js';

interface SalesDocumentActionsProps {
  readonly view: SalesDocumentView;
  /** Called after a command succeeded, so the panel reloads the document it now describes. */
  readonly onChanged: () => void;
}

/**
 * The quote's issuing transition is `send`, and sending is the Send button's job: it renders the
 * document, picks a template and a recipient first. Offering it here as well would be two buttons
 * that issue the same quote with different side effects.
 */
const SEND_ACTION = 'send';

/** A reason the operator is being asked for: which command, and whether it is the unlock. */
interface ReasonPrompt {
  readonly action: string;
  readonly label: string;
  readonly unlock: boolean;
}

export function SalesDocumentActions({ view, onChanged }: SalesDocumentActionsProps) {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);
  const [reason, setReason] = useState('');

  const runTransition = useCallback(
    async (action: SalesDocumentAction, why?: string) => {
      setBusy(action.action);
      setError(null);
      try {
        await api.salesTransitionDocument(view.kind, view.id, {
          action: action.action,
          ...(why === undefined ? {} : { reason: why }),
        });
        void message.success(t('sales.document.actionDone', { action: action.label }));
        onChanged();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t('sales.document.actionFailed'));
      } finally {
        setBusy(null);
      }
    },
    [message, onChanged, view.id, view.kind],
  );

  const runConversion = useCallback(
    async (action: string) => {
      setBusy(action);
      setError(null);
      try {
        const created = await api.salesConvertDocument(view.kind, view.id, { action });
        const number = created.document['number'];
        void message.success(
          t('sales.document.converted', {
            label: created.descriptor.label,
            number: typeof number === 'string' && number !== '' ? number : t('sales.document.noNumber'),
          }),
        );
        // The destination is a document in its own right; open it, because the next thing the user
        // does — pricing it, confirming it — happens there.
        navigate(`/${encodeURIComponent(created.descriptor.entity)}/${encodeURIComponent(created.id)}`);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t('sales.document.actionFailed'));
        setBusy(null);
      }
    },
    [message, navigate, view.id, view.kind],
  );

  const runUnlock = useCallback(
    async (why: string) => {
      setBusy('unlock');
      setError(null);
      try {
        await api.salesUnlockDocument(view.kind, view.id, why);
        void message.success(t('sales.document.unlocked'));
        onChanged();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t('sales.document.actionFailed'));
      } finally {
        setBusy(null);
      }
    },
    [message, onChanged, view.id, view.kind],
  );

  const start = useCallback(
    (action: SalesDocumentAction) => {
      if (action.requiresReason) {
        setReason('');
        setPrompt({ action: action.action, label: action.label, unlock: false });
        return;
      }
      if (!action.issues) {
        void runTransition(action);
        return;
      }
      // The one irreversible click: it takes the number and freezes the document.
      modal.confirm({
        title: t('sales.document.confirmIssueTitle', { action: action.label }),
        content: t('sales.document.confirmIssueBody'),
        okText: action.label,
        onOk: () => runTransition(action),
      });
    },
    [modal, runTransition],
  );

  const startUnlock = useCallback(() => {
    setReason('');
    setPrompt({ action: 'unlock', label: t('sales.document.unlock'), unlock: true });
  }, []);

  const submitReason = useCallback(async () => {
    if (prompt === null) return;
    const why = reason.trim();
    if (why === '') return;
    const current = prompt;
    setPrompt(null);
    if (current.unlock) {
      await runUnlock(why);
      return;
    }
    const action = view.actions.find((entry) => entry.action === current.action);
    if (action !== undefined) await runTransition(action, why);
  }, [prompt, reason, runTransition, runUnlock, view.actions]);

  const actions = view.actions.filter((action) => action.action !== SEND_ACTION);
  const locked = view.lock.locked === true;
  if (actions.length === 0 && view.conversions.length === 0 && !locked) return null;

  return (
    <>
      {error !== null ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} /> : null}
      <Space wrap size={4} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
          {t('sales.document.actions')}
        </Typography.Text>
        {actions.map((action) => (
          <Button
            key={action.action}
            size="small"
            type={action.issues ? 'primary' : 'default'}
            loading={busy === action.action}
            disabled={busy !== null}
            onClick={() => start(action)}
          >
            {action.label}
          </Button>
        ))}
        {view.conversions.map((conversion) => (
          <Button
            key={conversion.action}
            size="small"
            icon={<SwapOutlined />}
            loading={busy === conversion.action}
            disabled={busy !== null}
            onClick={() => void runConversion(conversion.action)}
          >
            {conversion.label}
          </Button>
        ))}
        {locked ? (
          <Button size="small" icon={<LockOutlined />} loading={busy === 'unlock'} disabled={busy !== null} onClick={startUnlock}>
            {t('sales.document.unlock')}
          </Button>
        ) : null}
      </Space>

      <Modal
        open={prompt !== null}
        title={prompt === null ? '' : t('sales.document.reasonTitle', { action: prompt.label })}
        okText={prompt?.label ?? t('sales.document.actions')}
        okButtonProps={{ disabled: reason.trim() === '' }}
        onOk={() => void submitReason()}
        onCancel={() => setPrompt(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {prompt?.unlock === true ? t('sales.document.unlockHint') : t('sales.document.reasonHint')}
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('sales.document.reasonPlaceholder')}
        />
      </Modal>
    </>
  );
}
