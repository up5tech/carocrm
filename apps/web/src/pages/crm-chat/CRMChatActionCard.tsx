import { CheckOutlined, CloseOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';

import { api } from '../../api/client.js';
import type { CRMChatActionView } from '../../api/types.js';
import { formatDateTime, t } from '../../state/i18n.js';

const { Text } = Typography;

export interface CRMChatActionCardProps {
  readonly approvalId: string;
  /** Called after a decision so the caller can refresh the thread. */
  readonly onDecided?: (action: CRMChatActionView) => void;
}

/**
 * Phase 19-CHAT.12 — the action proposal card (PLAN_Phase_19_CRM_Chat.md §10, §17 `19-CHAT.12`;
 * contract §6.4, §10).
 *
 * A proposal is a **write the assistant wants to make**. The user sees exactly what would change
 * and decides; nothing happens until they do. The card therefore shows:
 *
 *  - the action class and the risk level the runtime assigned,
 *  - the target the action would touch,
 *  - the proposal preview, rendered as plain text,
 *  - the expiry, after which the card can no longer decide anything.
 *
 * The card renders what the **server** decided it may show. `actionable` already accounts for the
 * decision state and the expiry, so the buttons never appear for a proposal that is already
 * decided or already stale — and the card never decides anything by itself: both buttons are
 * calls to the server, which revalidates the target, the record state, the proposal hash and the
 * expiry before anything runs.
 *
 * A rejected or confirmed proposal stays on screen with its outcome, because a silent disappearance
 * would leave the user unsure whether their decision was recorded.
 */
export function CRMChatActionCard(props: CRMChatActionCardProps) {
  const { approvalId, onDecided } = props;

  const action = useQuery({
    queryKey: ['crmChat', 'action', approvalId],
    queryFn: () => api.crmChatAction(approvalId),
    staleTime: 10_000,
    retry: false,
  });

  const decide = useMutation({
    mutationFn: async (decision: 'confirm' | 'reject') =>
      decision === 'confirm'
        ? api.crmChatConfirmAction(approvalId)
        : api.crmChatRejectAction(approvalId),
    onSuccess: (result) => {
      onDecided?.(result.action);
    },
  });

  if (action.isLoading) {
    return (
      <Card size="small" className="carocrm-card">
        <Text type="secondary">{t('web.crmChat.action.loading')}</Text>
      </Card>
    );
  }

  if (action.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('web.crmChat.action.unavailable')}
        description={action.error instanceof Error ? action.error.message : undefined}
      />
    );
  }

  const view = action.data;
  if (view === undefined) return null;

  return (
    <Card
      size="small"
      className="carocrm-card"
      title={
        <Space size={6} wrap>
          <ExclamationCircleOutlined />
          <span>{t('web.crmChat.action.title')}</span>
          <Tag color={riskTone(view.riskLevel)}>{view.riskLevel}</Tag>
          <Tag>{view.actionClass}</Tag>
        </Space>
      }
      style={{ marginTop: 12 }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text>{view.summary}</Text>

        <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label={t('web.crmChat.action.agent')}>
            {view.agentName} (v{view.agentVersion})
          </Descriptions.Item>
          <Descriptions.Item label={t('web.crmChat.action.expires')}>
            {formatDateTime(view.expiresAt, false)}
          </Descriptions.Item>
        </Descriptions>

        {view.proposal === null || view.proposal === undefined ? null : (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.crmChat.action.preview')}
            </Text>
            <pre
              style={{
                margin: '4px 0 0',
                padding: 8,
                maxHeight: 180,
                overflow: 'auto',
                background: 'rgba(0,0,0,0.03)',
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {safePreview(view.proposal)}
            </pre>
          </div>
        )}

        {view.status !== 'pending' ? (
          <Tag color="default">
            {t('web.crmChat.action.decided', { status: view.status })}
            {view.decidedAt === null ? '' : ` · ${formatDateTime(view.decidedAt, false)}`}
          </Tag>
        ) : null}

        {view.actionable ? (
          <Space>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={decide.isPending && decide.variables === 'confirm'}
              onClick={() => decide.mutate('confirm')}
            >
              {t('web.crmChat.action.confirm')}
            </Button>
            <Button
              danger
              icon={<CloseOutlined />}
              loading={decide.isPending && decide.variables === 'reject'}
              onClick={() => decide.mutate('reject')}
            >
              {t('web.crmChat.action.reject')}
            </Button>
          </Space>
        ) : null}

        {decide.isError ? (
          <Alert
            type="error"
            showIcon
            message={decide.error instanceof Error ? decide.error.message : t('web.crmChat.action.failed')}
          />
        ) : null}
      </Space>
    </Card>
  );
}

/** The risk level is a server-side classification; the tone only reflects it. */
function riskTone(riskLevel: string): string {
  switch (riskLevel.toLowerCase()) {
    case 'high':
      return 'red';
    case 'medium':
      return 'orange';
    default:
      return 'blue';
  }
}

/**
 * Render the proposal preview as text. The value is opaque JSON from the runtime, so it is shown
 * verbatim and escaped by the renderer — never interpreted as markup.
 */
function safePreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}
