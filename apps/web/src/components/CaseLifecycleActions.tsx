/**
 * Phase 19-SD.4/SD.5 — the Case lifecycle and assignment panel (PLAN §5.2, §5.3, task SD.4.5/SD.5.5).
 *
 * Just like `OpportunityDocumentActions`, this panel is an *entry point*, not a rule engine: the
 * server's `capabilities` answer says which commands the current actor may run on this case (from its
 * current status) and whether they may assign it. The panel renders exactly that, and every button
 * posts a domain command the server re-validates — hiding a control is never the authorisation.
 *
 * The history tables below the buttons are the visible half of "history remains auditable": each row
 * is a `CaseTransition`/`CaseAssignment` record the module wrote, including the reason and the
 * resolution code, which the generic field audit cannot express.
 */

import { App as AntApp, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type {
  ServiceDeskAssignmentRow,
  ServiceDeskCapabilities,
  ServiceDeskTransitionRow,
} from '../api/types.js';
import { formatDateTime, t } from '../state/i18n.js';
import { LinkValue } from './fields.js';

interface CaseLifecycleActionsProps {
  readonly caseId: string;
  /** Called after a command succeeds so the page can reload the record it renders. */
  readonly onChanged?: (() => void) | undefined;
}

/** The order the commands appear in — roughly the working order, not the API's arbitrary order. */
const COMMAND_ORDER = [
  'start',
  'setPendingCustomer',
  'setPendingInternal',
  'escalate',
  'deEscalate',
  'resolve',
  'reopen',
  'close',
  'cancel',
] as const;

type CommandName = (typeof COMMAND_ORDER)[number];

interface CommandFormValues {
  reason?: string;
  resolutionCode?: string;
  resolutionSummary?: string;
}

export function CaseLifecycleActions({ caseId, onChanged }: CaseLifecycleActionsProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<CommandFormValues>();
  const [caps, setCaps] = useState<ServiceDeskCapabilities | undefined>(undefined);
  const [transitions, setTransitions] = useState<ServiceDeskTransitionRow[]>([]);
  const [assignments, setAssignments] = useState<ServiceDeskAssignmentRow[]>([]);
  const [queues, setQueues] = useState<{ value: string; label: string }[]>([]);
  const [queueId, setQueueId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<CommandName | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [capabilities, history, assigned] = await Promise.all([
        api.serviceDeskCapabilities(caseId),
        api.serviceDeskHistory(caseId),
        api.serviceDeskAssignments(caseId),
      ]);
      setCaps(capabilities);
      setTransitions(history.list);
      setAssignments(assigned.list);
    } catch {
      // A case the actor cannot read simply has no panel — not an error worth shouting about.
      setCaps(undefined);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The queue picker is only fetched when the actor is told they may assign; it stays empty otherwise.
  useEffect(() => {
    if (caps?.assignment.canAssign !== true) return;
    let active = true;
    api
      .list('CaseQueue', { orderBy: 'sortOrder', maxSize: 50, total: false })
      .then((result) => {
        if (!active) return;
        setQueues(
          result.list
            .filter((queue) => queue['isActive'] !== false)
            .map((queue) => ({
              value: String(queue['id']),
              label: String(queue['name'] ?? queue['code'] ?? queue['id']),
            })),
        );
      })
      .catch(() => {
        if (active) setQueues([]);
      });
    return () => {
      active = false;
    };
  }, [caps?.assignment.canAssign]);

  const allowed = useMemo(
    () => (caps ? COMMAND_ORDER.filter((command) => caps.allowedCommands.includes(command)) : []),
    [caps],
  );

  const runCommand = async (command: CommandName, values: CommandFormValues): Promise<void> => {
    setBusy(true);
    try {
      await api.serviceDeskTransition(caseId, {
        command,
        ...(values.reason?.trim() ? { reason: values.reason.trim() } : {}),
        ...(command === 'resolve' && values.resolutionCode ? { resolutionCode: values.resolutionCode } : {}),
        ...(command === 'resolve' && values.resolutionSummary?.trim()
          ? { resolutionSummary: values.resolutionSummary.trim() }
          : {}),
      });
      void message.success(t('web.serviceDesk.commandDone'));
      setPending(undefined);
      form.resetFields();
      await load();
      onChanged?.();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.commandFailed'));
    } finally {
      setBusy(false);
    }
  };

  const assignTo = async (input: Record<string, unknown>): Promise<void> => {
    setAssigning(true);
    try {
      const result = await api.serviceDeskAssign(caseId, input);
      if (result.warnings.includes('QUEUE_HAS_NO_ELIGIBLE_AGENT')) {
        void message.warning(t('web.serviceDesk.noEligibleAgent'));
      } else {
        void message.success(t('web.serviceDesk.commandDone'));
      }
      await load();
      onChanged?.();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.commandFailed'));
    } finally {
      setAssigning(false);
    }
  };

  const route = async (): Promise<void> => {
    setAssigning(true);
    try {
      const result = await api.serviceDeskRoute(caseId, {});
      if (result.warnings.includes('QUEUE_HAS_NO_ELIGIBLE_AGENT')) {
        void message.warning(t('web.serviceDesk.noEligibleAgent'));
      } else {
        void message.success(t('web.serviceDesk.commandDone'));
      }
      await load();
      onChanged?.();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.commandFailed'));
    } finally {
      setAssigning(false);
    }
  };

  if (caps === undefined) return null;

  return (
    <Card
      className="carocrm-card"
      title={<Typography.Text strong>{t('web.serviceDesk.lifecycle')}</Typography.Text>}
      extra={<Tag color="blue">{caps.status}</Tag>}
    >
      <Space wrap size={8}>
        {allowed.map((command) => (
          <Button
            key={command}
            type={command === 'resolve' ? 'primary' : 'default'}
            danger={command === 'cancel'}
            onClick={() => {
              form.resetFields();
              setPending(command);
            }}
          >
            {t(`web.serviceDesk.command.${command}`)}
          </Button>
        ))}
        {allowed.length === 0 ? (
          <Typography.Text type="secondary">{t('web.serviceDesk.noCommands')}</Typography.Text>
        ) : null}
      </Space>

      {caps.assignment.canAssign ? (
        <Space wrap size={8} style={{ marginTop: 12 }}>
          <Select
            style={{ minWidth: 220 }}
            placeholder={t('web.serviceDesk.queuePlaceholder')}
            showSearch
            optionFilterProp="label"
            value={queueId}
            onChange={setQueueId}
            options={queues}
          />
          <Button
            loading={assigning}
            disabled={queueId === undefined}
            onClick={() => queueId !== undefined && void assignTo({ queueId })}
          >
            {t('web.serviceDesk.assignToQueue')}
          </Button>
          <Button loading={assigning} onClick={() => void route()}>
            {t('web.serviceDesk.route')}
          </Button>
        </Space>
      ) : null}

      <Modal
        open={pending !== undefined}
        title={pending ? t(`web.serviceDesk.command.${pending}`) : ''}
        okText={t('web.serviceDesk.confirm')}
        cancelText={t('web.serviceDesk.cancel')}
        confirmLoading={busy}
        onCancel={() => setPending(undefined)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => pending && void runCommand(pending, values)}>
          {pending === 'resolve' && caps.resolution.requireCode ? (
            <Form.Item
              name="resolutionCode"
              label={t('web.serviceDesk.resolutionCode')}
              rules={[{ required: true, message: t('web.serviceDesk.resolutionCodeRequired') }]}
            >
              <Select options={caps.resolution.codes.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          ) : null}
          {pending === 'resolve' && !caps.resolution.requireCode ? (
            <Form.Item name="resolutionCode" label={t('web.serviceDesk.resolutionCode')}>
              <Select allowClear options={caps.resolution.codes.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          ) : null}
          {pending === 'resolve' && caps.resolution.requireSummary ? (
            <Form.Item
              name="resolutionSummary"
              label={t('web.serviceDesk.resolutionSummary')}
              rules={[{ required: true, message: t('web.serviceDesk.resolutionSummaryRequired') }]}
            >
              <Input.TextArea rows={2} />
            </Form.Item>
          ) : null}
          {pending === 'resolve' && !caps.resolution.requireSummary ? (
            <Form.Item name="resolutionSummary" label={t('web.serviceDesk.resolutionSummary')}>
              <Input.TextArea rows={2} />
            </Form.Item>
          ) : null}
          <Form.Item name="reason" label={t('web.serviceDesk.reason')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Typography.Title level={5} style={{ marginTop: 20 }}>
        {t('web.serviceDesk.transitionHistory')}
      </Typography.Title>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={transitions}
        locale={{ emptyText: t('web.serviceDesk.noHistory') }}
        columns={[
          { title: t('web.serviceDesk.columnWhen'), dataIndex: 'occurredAt', width: 180, render: (value: string | null) => formatDateTime(value) },
          { title: t('web.serviceDesk.columnFrom'), dataIndex: 'fromStatus', width: 140 },
          { title: t('web.serviceDesk.columnTo'), dataIndex: 'toStatus', width: 140 },
          { title: t('web.serviceDesk.columnCommand'), dataIndex: 'command', width: 150 },
          { title: t('web.serviceDesk.columnReason'), dataIndex: 'reason', render: (value: string | null) => value ?? '—' },
          {
            title: t('web.serviceDesk.columnActor'),
            dataIndex: 'actorUserId',
            width: 180,
            render: (value: string | null) => (value ? <LinkValue entity="User" id={value} /> : '—'),
          },
        ]}
      />

      {assignments.length > 0 ? (
        <>
          <Typography.Title level={5} style={{ marginTop: 20 }}>
            {t('web.serviceDesk.assignmentHistory')}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={assignments}
            columns={[
              { title: t('web.serviceDesk.columnWhen'), dataIndex: 'occurredAt', width: 180, render: (value: string | null) => formatDateTime(value) },
              {
                title: t('web.serviceDesk.columnAssignedTo'),
                dataIndex: 'assignedUserId',
                render: (value: string | null) => (value ? <LinkValue entity="User" id={value} /> : t('web.serviceDesk.unassigned')),
              },
              {
                title: t('web.serviceDesk.columnQueue'),
                dataIndex: 'queueId',
                render: (value: string | null) => (value ? <LinkValue entity="CaseQueue" id={value} /> : '—'),
              },
              { title: t('web.serviceDesk.columnStrategy'), dataIndex: 'strategy', width: 130 },
              { title: t('web.serviceDesk.columnReason'), dataIndex: 'reason', render: (value: string | null) => value ?? '—' },
            ]}
          />
        </>
      ) : null}
    </Card>
  );
}
