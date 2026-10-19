import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentApprovalView } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { formatTimestamp, RiskTag } from './shared.js';

/**
 * Phase 19-AI.10 — the approval inbox
 * (PLAN_Phase_19_AI_Agents.md §9.2, §9.3, §15.5, §20 `19-AI.10`).
 *
 * The reviewer sees the exact proposal: the tool, its effect class, the target record and the
 * before/after values. Approving is a recorded decision attributed to the reviewer; the engine still
 * revalidates the tool, the grant, the arguments and the target before it executes, so a stale
 * approval can never execute after the facts changed.
 */

interface ApprovalsTabProps {
  readonly capabilities: Record<string, boolean>;
}

/** Status filter values paired with their translation keys; the API accepts the raw status. */
const APPROVAL_FILTERS = [
  ['pending', 'approvalFilterPending'],
  ['approved', 'approvalFilterApproved'],
  ['rejected', 'approvalFilterRejected'],
  ['executed', 'approvalFilterExecuted'],
  ['expired', 'approvalFilterExpired'],
  ['invalidated', 'approvalFilterInvalidated'],
  ['all', 'approvalFilterAll'],
] as const;

export function AIAgentsApprovalsTab({ capabilities }: ApprovalsTabProps) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState<AIAgentApprovalView | undefined>(undefined);
  const [note, setNote] = useState('');

  const canApprove = capabilities['approval'] === true;
  const approvals = useQuery({
    queryKey: ['aiAgents', 'approvals', status],
    queryFn: () => api.aiAgentsApprovals({ status }),
    enabled: canApprove,
    refetchInterval: 15_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runs'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'run'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runApprovals'] });
  };

  const decide = useMutation({
    mutationFn: async (decision: 'approve' | 'reject') => {
      if (selected === undefined) throw new Error('No approval selected.');
      return decision === 'approve'
        ? api.aiAgentsApprove(selected.id, note.trim() === '' ? undefined : note.trim())
        : api.aiAgentsReject(selected.id, note.trim() === '' ? undefined : note.trim());
    },
    onSuccess: (result) => {
      void message.success(
        result.approval.status === 'approved' ? t('web.aiAgents.approved') : t('web.aiAgents.rejected'),
      );
      setSelected(undefined);
      setNote('');
      invalidate();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!canApprove) {
    return <Alert type="info" showIcon message={t('web.aiAgents.approvalNoAccess')} description={t('web.aiAgents.approvalNoAccessHint')} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Select
          style={{ width: 200 }}
          value={status}
          onChange={(value) => setStatus(value)}
          options={APPROVAL_FILTERS.map(([value, key]) => ({ value, label: t(`web.aiAgents.${key}`) }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void approvals.refetch()}>
          {t('core.common.reload')}
        </Button>
        {(approvals.data?.expired ?? 0) > 0 ? (
          <Tag color="orange">{t('web.aiAgents.expiredCount', { count: String(approvals.data?.expired ?? 0) })}</Tag>
        ) : null}
      </div>

      <Table<AIAgentApprovalView>
        rowKey="id"
        size="middle"
        loading={approvals.isLoading}
        dataSource={[...(approvals.data?.list ?? [])]}
        scroll={{ x: 760 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={status === 'pending' ? t('web.aiAgents.inboxEmpty') : t('web.aiAgents.noApprovals')} /> }}
        onRow={(approval) => ({ onClick: () => setSelected(approval), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: t('web.aiAgents.proposal'),
            key: 'summary',
            render: (_value, approval) => (
              <Space direction="vertical" size={2}>
                <Typography.Text strong>{approval.summary}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {approval.agentName} · v{approval.agentVersion} · {approval.toolKey ?? '—'}
                </Typography.Text>
              </Space>
            ),
          },
          { title: t('web.aiAgents.risk'), dataIndex: 'riskLevel', key: 'riskLevel', width: 150, render: (risk: string) => <RiskTag risk={risk} /> },
          { title: t('web.aiAgents.status'), dataIndex: 'status', key: 'status', width: 120, render: (value: string) => <Tag>{value}</Tag> },
          {
            title: t('web.aiAgents.expires'),
            dataIndex: 'expiresAt',
            key: 'expiresAt',
            width: 170,
            render: (value: string) => formatTimestamp(value),
          },
        ]}
      />

      <Modal
        open={selected !== undefined}
        title={t('web.aiAgents.reviewProposal')}
        onCancel={() => {
          setSelected(undefined);
          setNote('');
        }}
        width={720}
        footer={
          selected === undefined || selected.status !== 'pending'
            ? [
                <Button key="close" onClick={() => setSelected(undefined)}>
                  {t('core.common.close')}
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setSelected(undefined)}>
                  {t('core.common.cancel')}
                </Button>,
                <Button key="reject" danger loading={decide.isPending} onClick={() => decide.mutate('reject')}>
                  {t('web.aiAgents.reject')}
                </Button>,
                <Button key="approve" type="primary" loading={decide.isPending} onClick={() => decide.mutate('approve')}>
                  {t('web.aiAgents.approve')}
                </Button>,
              ]
        }
      >
        {selected === undefined ? null : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Alert
              type={selected.status === 'pending' ? 'warning' : selected.status === 'executed' ? 'success' : 'info'}
              showIcon
              message={selected.summary}
              description={
                <Space size={[6, 6]} wrap>
                  <RiskTag risk={selected.riskLevel} />
                  <Tag>{selected.toolKey ?? '—'}</Tag>
                  <Typography.Text type="secondary">{t('web.aiAgents.expires')}: {formatTimestamp(selected.expiresAt)}</Typography.Text>
                </Space>
              }
            />
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('web.aiAgents.agent')}>
                {selected.agentName} · v{selected.agentVersion}
              </Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.run')}>{selected.runId.slice(0, 8)}</Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.status')}>{selected.status}</Descriptions.Item>
              {selected.decidedAt === null ? null : (
                <Descriptions.Item label={t('web.aiAgents.decided')}>
                  {formatTimestamp(selected.decidedAt)} · {selected.decidedByUserId ?? '—'}
                  {selected.selfApproval ? <Tag color="gold" style={{ marginLeft: 8 }}>{t('web.aiAgents.selfApproval')}</Tag> : null}
                </Descriptions.Item>
              )}
              {selected.decisionNote === null ? null : (
                <Descriptions.Item label={t('web.aiAgents.note')}>{selected.decisionNote}</Descriptions.Item>
              )}
            </Descriptions>
            <ProposalView approval={selected} />
            {selected.status !== 'pending' ? null : (
              <div>
                <Typography.Title level={5}>{t('web.aiAgents.decisionNote')}</Typography.Title>
                <Input.TextArea
                  rows={3}
                  maxLength={1_000}
                  showCount
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('web.aiAgents.decisionNotePlaceholder')}
                />
              </div>
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}

function ProposalView({ approval }: { readonly approval: AIAgentApprovalView }) {
  const proposal = asRecord(approval.proposal);
  const detail = asRecord(proposal['detail']);
  const before = asRecord(detail['before']);
  const after = asRecord(detail['after']);
  const argumentsView = detail['arguments'] ?? proposal['arguments'];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {fields.length === 0 ? null : (
        <Table
          size="small"
          pagination={false}
          rowKey="field"
          dataSource={fields.map((field) => ({ field, before: before[field], after: after[field] }))}
          columns={[
            { title: t('web.aiAgents.field'), dataIndex: 'field', key: 'field', width: 180 },
            {
              title: t('web.aiAgents.before'),
              dataIndex: 'before',
              key: 'before',
              render: (value: unknown) => renderValue(value),
            },
            {
              title: t('web.aiAgents.after'),
              dataIndex: 'after',
              key: 'after',
              render: (value: unknown) => renderValue(value),
            },
          ]}
        />
      )}
      {Array.isArray(approval.targets) && approval.targets.length > 0 ? (
        <div>
          <Typography.Text strong>{t('web.aiAgents.targets')}</Typography.Text>
          <Space size={[6, 6]} wrap style={{ marginLeft: 8 }}>
            {(approval.targets as { type?: string; id?: string; label?: string }[]).map((target, index) => (
              <Tag key={`${target.type ?? 'target'}-${String(index)}`}>
                {target.type ?? 'record'} · {target.label ?? target.id ?? ''}
              </Tag>
            ))}
          </Space>
        </div>
      ) : null}
      {argumentsView === undefined ? null : (
        <div>
          <Typography.Text strong>{t('web.aiAgents.arguments')}</Typography.Text>
          <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(argumentsView, null, 2)}
          </pre>
        </div>
      )}
      {approval.executionResult === null || approval.executionResult === undefined ? null : (
        <div>
          <Typography.Text strong>{t('web.aiAgents.executionResult')}</Typography.Text>
          <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify(approval.executionResult, null, 2)}
          </pre>
        </div>
      )}
    </Space>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
