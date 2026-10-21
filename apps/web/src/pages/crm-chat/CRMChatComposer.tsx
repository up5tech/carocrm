import { SendOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Typography } from 'antd';
import type { ComponentRef } from 'react';
import { useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import type { CRMChatTurnResult } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { CRMChatActionCard } from './CRMChatActionCard.js';
import { CRMChatPromptTemplates } from './CRMChatPromptTemplates.js';
import { useCrmChatStream } from './useCrmChatStream.js';

const { TextArea } = Input;

export interface CRMChatComposerProps {
  readonly conversationId?: string | undefined;
  readonly enabled: boolean;
  readonly maxMessageChars: number;
  readonly turnTimeoutSeconds: number;
  /** Whether the caller may create, edit and remove saved prompt templates. */
  readonly canManagePrompts?: boolean | undefined;
  readonly onTurnSubmitted?: (result: CRMChatTurnResult) => void;
  /** Bumped by the page when the user starts a new conversation; clears and focuses the composer. */
  readonly resetSignal?: number | undefined;
}

/**
 * Phase 19-CHAT.7 — Chat composer with turn submission and streaming support.
 *
 * Handles:
 * - Prompt input with character limit validation
 * - Turn submission to AIAgents via API
 * - SSE event streaming for real-time progress
 * - Cancel/stop generation
 * - Streaming state display
 * - 19-CHAT.14 — saved prompt templates, inserted as plain text
 * - 19-CHAT.12 — the action proposal card, when a turn asks for a write to be confirmed
 */
export function CRMChatComposer(props: CRMChatComposerProps) {
  const { conversationId, enabled, maxMessageChars, turnTimeoutSeconds, canManagePrompts = false, onTurnSubmitted, resetSignal } = props;

  const [prompt, setPrompt] = useState('');
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const textAreaRef = useRef<ComponentRef<typeof TextArea>>(null);
  const seenResetSignal = useRef(resetSignal);
  // The first turn starts without a conversation id and creates one on the server. Keep the live id
  // in a ref so the stream's terminal event invalidates the right detail query, not the pre-turn key.
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);

  // "New" is a client-side action: the thread does not exist until the first turn. Clearing the
  // draft and focusing the box is the only visible effect it can have before that turn.
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === seenResetSignal.current) return;
    seenResetSignal.current = resetSignal;
    setPrompt('');
    setStreamError(null);
    textAreaRef.current?.focus();
  }, [resetSignal]);

  const queryClient = useQueryClient();

  // Stream hook for the current turn.
  const stream = useCrmChatStream({
    turnId: currentTurnId,
    enabled: currentTurnId !== null,
    onEvent: (event) => {
      // Handle different event types.
      switch (event.event) {
        case 'assistant.message':
          // Could append to a live message buffer here.
          break;
        case 'citation.added':
          // Could update citations list.
          break;
        case 'approval.required': {
          // The turn paused on a write proposal. The card decides it; the composer only shows it.
          const approvalId = event.data['approvalId'];
          if (typeof approvalId === 'string' && approvalId !== '') setPendingApprovalId(approvalId);
          break;
        }
        case 'turn.completed':
        case 'turn.failed':
        case 'turn.cancelled':
          // Invalidate queries to refresh messages, including the conversation created by turn one.
          void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
          setCurrentTurnId(null);
          break;
        case 'heartbeat':
          // Ignore heartbeats.
          break;
      }
    },
    onError: (error) => {
      setStreamError(error.message);
    },
    onComplete: () => {
      setCurrentTurnId(null);
    },
  });

  // Turn submission mutation.
  const submitTurn = useMutation<CRMChatTurnResult, Error, { prompt: string }>({
    mutationFn: async ({ prompt }) => {
      const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return api.crmChatSubmitTurn({
        prompt,
        conversationId,
        idempotencyKey,
      });
    },
    onSuccess: (result) => {
      setCurrentTurnId(result.turnId);
      setPrompt('');
      setStreamError(null);
      conversationRef.current = result.conversationId ?? conversationRef.current;
      onTurnSubmitted?.(result);

      // Round one creates the thread; seed its detail cache immediately so the history appears.
      if (result.conversationId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', result.conversationId] });
      }
      // Invalidate conversations list to show updated lastMessageAt.
      void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversations'] });
    },
    onError: (error) => {
      setStreamError(error instanceof Error ? error.message : 'Failed to submit turn.');
    },
  });

  const handleSubmit = () => {
    if (!prompt.trim() || !enabled || submitTurn.isPending) return;
    if (prompt.length > maxMessageChars) {
      setStreamError(`Message exceeds ${maxMessageChars} characters.`);
      return;
    }
    submitTurn.mutate({ prompt: prompt.trim() });
  };

  const handleCancel = () => {
    if (currentTurnId) {
      void api.crmChatCancelTurn(currentTurnId).then(() => {
        setCurrentTurnId(null);
        void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationId] });
      });
    }
  };

  const charCount = prompt.length;
  const isOverLimit = charCount > maxMessageChars;
  const canSubmit = enabled && prompt.trim().length > 0 && !isOverLimit && !submitTurn.isPending && !stream.isConnected;

  return (
    <div>
      {/* Streaming status indicator */}
      {stream.isConnected && (
        <Alert
          type="info"
          showIcon
          message={t('web.crmChat.streamingInProgress')}
          description={
            <Space size={8}>
              <Typography.Text type="secondary">
                {t('web.crmChat.receivingResponse')}
              </Typography.Text>
              <Button size="small" danger icon={<StopOutlined />} onClick={handleCancel}>
                {t('web.crmChat.stopGeneration')}
              </Button>
            </Space>
          }
          style={{ marginBottom: 12 }}
        />
      )}

      {/* Error display */}
      {streamError && (
        <Alert
          type="error"
          showIcon
          message={t('web.crmChat.errorTitle')}
          description={streamError}
          closable
          onClose={() => setStreamError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      {/* 19-CHAT.12 — the pending write proposal. The card is the only thing that can decide it. */}
      {pendingApprovalId === null ? null : (
        <CRMChatActionCard
          approvalId={pendingApprovalId}
          onDecided={() => {
            setPendingApprovalId(null);
            void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationId] });
          }}
        />
      )}

      {/* 19-CHAT.14 — saved prompt templates. Inserting one puts its text in the composer. */}
      <div style={{ marginBottom: 8 }}>
        <CRMChatPromptTemplates
          canManage={canManagePrompts}
          currentPrompt={prompt}
          onInsert={(text) => setPrompt((current) => (current.trim() === '' ? text : `${current}\n${text}`))}
        />
      </div>

      {/* Composer textarea */}
      <TextArea
        ref={textAreaRef}
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={!enabled || submitTurn.isPending || stream.isConnected}
        placeholder={
          enabled
            ? t('web.crmChat.composerPlaceholder')
            : t('web.crmChat.composerUnavailable')
        }
        maxLength={maxMessageChars + 100} // Allow slight overage for UX, validate on submit
        onKeyDown={(e) => {
          // Submit on Enter (without Shift), cancel on Escape.
          if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === 'Escape' && stream.isConnected) {
            handleCancel();
          }
        }}
      />

      {/* Footer with controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 12,
        }}
      >
        <Typography.Text
          type={isOverLimit ? 'danger' : 'secondary'}
          style={{ fontSize: 12 }}
        >
          {t('web.crmChat.composerHint', {
            max: maxMessageChars,
            seconds: turnTimeoutSeconds,
          })}{' '}
          ({charCount}/{maxMessageChars})
        </Typography.Text>

        <Space>
          <Button
            disabled={!stream.isConnected}
            onClick={handleCancel}
          >
            {t('web.crmChat.cancelTurn')}
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canSubmit}
            loading={submitTurn.isPending}
            onClick={handleSubmit}
          >
            {stream.isConnected ? t('web.crmChat.generating') : t('web.crmChat.send')}
          </Button>
        </Space>
      </div>
    </div>
  );
}
