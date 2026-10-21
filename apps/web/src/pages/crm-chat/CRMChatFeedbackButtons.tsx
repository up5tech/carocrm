import { DislikeOutlined, LikeOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Button, Input, Modal, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';

export interface CRMChatFeedbackButtonsProps {
  /** The turn that produced the answer being rated. */
  readonly turnId: string;
  /** Whether the feedback feature is on and the caller may rate. */
  readonly enabled: boolean;
}

/**
 * Phase 19-CHAT.14 — answer feedback (PLAN_Phase_19_CRM_Chat.md §7.6, §17 `19-CHAT.14`;
 * contract §6.3, §7.6).
 *
 * A rating is an auditable fact about one answer, recorded once per user per answer. It is
 * deliberately inert: it never changes the model, the tools, the permissions or a prompt. The
 * component therefore says nothing about "improving" the assistant — that would be a promise the
 * system does not make.
 *
 * The two buttons are the whole interaction. A negative rating offers an optional comment,
 * because a down vote without a reason is not actionable, but the comment is never required.
 */
export function CRMChatFeedbackButtons(props: CRMChatFeedbackButtonsProps) {
  const { turnId, enabled } = props;

  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');

  const submit = useMutation({
    mutationFn: async (input: { rating: 'up' | 'down'; comment?: string }) =>
      api.crmChatSubmitFeedback(turnId, input),
    onSuccess: (result) => {
      setRating(result.feedback.rating);
      setCommentOpen(false);
      setComment('');
    },
  });
  if (!enabled) return null;

  const rate = (value: 'up' | 'down'): void => {
    if (submit.isPending) return;
    if (value === 'down') {
      // A negative rating may carry a reason; ask for it, but do not block the rating on it.
      setRating('down');
      setCommentOpen(true);
      submit.mutate({ rating: 'down' });
      return;
    }
    submit.mutate({ rating: 'up' });
  };

  return (
    <>
      <Space size={4}>
        <Tooltip title={t('web.crmChat.feedback.up')}>
          <Button
            size="small"
            type="text"
            icon={<LikeOutlined />}
            aria-label={t('web.crmChat.feedback.up')}
            aria-pressed={rating === 'up'}
            {...(rating === 'up' ? { color: 'blue' as const } : {})}
            disabled={submit.isPending}
            onClick={() => rate('up')}
          />
        </Tooltip>
        <Tooltip title={t('web.crmChat.feedback.down')}>
          <Button
            size="small"
            type="text"
            icon={<DislikeOutlined />}
            aria-label={t('web.crmChat.feedback.down')}
            aria-pressed={rating === 'down'}
            {...(rating === 'down' ? { color: 'red' as const } : {})}
            disabled={submit.isPending}
            onClick={() => rate('down')}
          />
        </Tooltip>
        {rating === null ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {t('web.crmChat.feedback.hint')}
          </Typography.Text>
        ) : null}
        {submit.isError ? (
          <Typography.Text type="danger" style={{ fontSize: 11 }}>
            {submit.error instanceof Error ? submit.error.message : t('web.crmChat.feedback.failed')}
          </Typography.Text>
        ) : null}
      </Space>

      <Modal
        open={commentOpen}
        title={t('web.crmChat.feedback.commentTitle')}
        okText={t('web.crmChat.feedback.commentSubmit')}
        cancelText={t('core.common.cancel')}
        onCancel={() => setCommentOpen(false)}
        onOk={() => {
          const text = comment.trim();
          submit.mutate(text === '' ? { rating: 'down' } : { rating: 'down', comment: text });
        }}
        confirmLoading={submit.isPending}
      >
        <Input.TextArea
          rows={3}
          value={comment}
          maxLength={2000}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t('web.crmChat.feedback.commentPlaceholder')}
        />
      </Modal>
    </>
  );
}
