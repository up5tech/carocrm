import { SendOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Spin, Typography } from 'antd';
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

/** User-safe progress phases. The server never streams hidden reasoning, only lifecycle state. */
type TurnPhase = 'idle' | 'queued' | 'thinking' | 'tool' | 'finishing';

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
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('idle');
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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

  // A visible clock is the honest "thinking" signal while the provider is still generating: the
  // transport streams lifecycle/tool events, not hidden reasoning tokens.
  useEffect(() => {
    if (currentTurnId === null) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [currentTurnId]);

  const queryClient = useQueryClient();

  // Stream hook for the current turn.
  const stream = useCrmChatStream({
    turnId: currentTurnId,
    enabled: currentTurnId !== null,
    onEvent: (event) => {
      // Handle different event types.
      switch (event.event) {
        case 'turn.started':
          setTurnPhase(event.data['state'] === 'running' ? 'thinking' : 'queued');
          break;
        case 'tool.started': {
          const label = event.data['label'];
          setToolLabel(typeof label === 'string' && label !== '' ? label : null);
          setTurnPhase('tool');
          break;
        }
        case 'tool.completed':
          setToolLabel(null);
          setTurnPhase('thinking');
          break;
        case 'assistant.message':
          setTurnPhase('finishing');
          break;
        case 'citation.added':
          // Citations arrive in the final conversation history; nothing to do live.
          break;
        case 'approval.required': {
          // The turn paused on a write proposal. The card decides it; the composer only shows it.
          const approvalId = event.data['approvalId'];
          if (typeof approvalId === 'string' && approvalId !== '') setPendingApprovalId(approvalId);
          break;
        }
        case 'turn.failed': {
          const message = event.data['message'];
          if (typeof message === 'string' && message !== '') setStreamError(message);
          setTurnPhase('idle');
          setToolLabel(null);
          void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
          void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversations'] });
          setCurrentTurnId(null);
          break;
        }
        case 'turn.completed':
        case 'turn.cancelled':
          // Invalidate queries to refresh messages, including the conversation created by turn one.
          setTurnPhase('idle');
          setToolLabel(null);
          void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
          void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversations'] });
          setCurrentTurnId(null);
          break;
        case 'heartbeat':
          // Ignore heartbeats.
          break;
      }
    },
    onError: (error) => {
      const failedTurnId = currentTurnId;
      setTurnPhase('idle');
      setToolLabel(null);

      const finish = () => {
        setCurrentTurnId(null);
        void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
        void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversations'] });
      };

      // A transport close can race the final event. The run is authoritative: if it completed, show
      // the saved answer instead of a misleading "connection closed" error.
      if (failedTurnId === null) {
        setStreamError(error.message);
        finish();
        return;
      }

      void api
        .crmChatGetTurn(failedTurnId)
        .then((status) => {
          if (status.status === 'succeeded' || status.status === 'partially_succeeded') {
            finish();
            return;
          }
          setStreamError(
            status.status === 'queued' || status.status === 'running'
              ? t('web.crmChat.streamDisconnected')
              : (status.failureMessage ?? error.message),
          );
          finish();
        })
        .catch(() => {
          setStreamError(error.message);
          finish();
        });
    },
    onComplete: () => {
      setTurnPhase('idle');
      setToolLabel(null);
      void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
      void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversations'] });
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
      setTurnPhase('queued');
      setToolLabel(null);
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
      setTurnPhase('idle');
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
        setTurnPhase('idle');
        setToolLabel(null);
        void queryClient.invalidateQueries({ queryKey: ['crmChat', 'conversation', conversationRef.current] });
      });
    }
  };

  const charCount = prompt.length;
  const isOverLimit = charCount > maxMessageChars;
  const turnActive = currentTurnId !== null;
  const canSubmit = enabled && prompt.trim().length > 0 && !isOverLimit && !submitTurn.isPending && !stream.isConnected && !turnActive;

  const progressText =
    turnPhase === 'tool' && toolLabel !== null
      ? t('web.crmChat.thinkingTool', { tool: toolLabel, seconds: elapsedSeconds })
      : turnPhase === 'queued'
        ? t('web.crmChat.thinkingQueued', { seconds: elapsedSeconds })
        : turnPhase === 'finishing'
          ? t('web.crmChat.thinkingFinishing', { seconds: elapsedSeconds })
          : t('web.crmChat.thinkingRunning', { seconds: elapsedSeconds });

  return (
    <div>
      {/* Live turn progress: lifecycle and tool steps from SSE, never hidden reasoning. */}
      {turnActive || stream.isConnected ? (
        <Alert
          type="info"
          showIcon
          icon={<Spin size="small" />}
          message={t('web.crmChat.streamingInProgress')}
          description={
            <Space size={8}>
              <Typography.Text type="secondary">{progressText}</Typography.Text>
              <Button size="small" danger icon={<StopOutlined />} onClick={handleCancel}>
                {t('web.crmChat.stopGeneration')}
              </Button>
            </Space>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

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
        disabled={!enabled || submitTurn.isPending || stream.isConnected || turnActive}
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
          if (e.key === 'Escape' && turnActive) {
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
            disabled={!turnActive}
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
            {turnActive || stream.isConnected ? t('web.crmChat.generating') : t('web.crmChat.send')}
          </Button>
        </Space>
      </div>
    </div>
  );
}
