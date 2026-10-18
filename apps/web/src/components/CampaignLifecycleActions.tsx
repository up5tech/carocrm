/**
 * Phase 19-MA.3 — the campaign lifecycle panel
 * (PLAN_Phase_19_Marketing_Automation.md §8.2, §8.4, §10.2).
 *
 * Like `CaseLifecycleActions`, this is an *entry point*, not a rule engine. `GET
 * /MarketingAutomation/action/campaign/:id/capabilities` answers, from the server's own ACL and the
 * campaign's real status, which commands this actor may run; the panel renders exactly that list and every
 * button posts one named command that the server validates again. Hiding a button is never the authorisation
 * (AGENTS.md §5.3), and a campaign's send-readiness gate is not re-implemented here — the blockers shown are
 * the ones the server produced.
 *
 * The reason column and the validation fingerprint in the history table are the visible half of §5.1's
 * "explainable automation": who moved this campaign, why, and under which report.
 */

import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type {
  MarketingAudiencePreview,
  MarketingCampaignCapabilities,
  MarketingCampaignTransitionRow,
} from '../api/types.js';
import { formatDateTime, t } from '../state/i18n.js';
import { LinkValue } from './fields.js';

interface CampaignLifecycleActionsProps {
  readonly campaignId: string;
  /** Called after a command succeeds so the page reloads the record it renders. */
  readonly onChanged?: (() => void) | undefined;
}

/** Working order of the commands, not the API's declaration order (§10.2 "explicit confirmation"). */
const COMMAND_ORDER = [
  'schedule',
  'unschedule',
  'start',
  'pause',
  'resume',
  'complete',
  'cancel',
  'archive',
] as const;

type CampaignCommand = (typeof COMMAND_ORDER)[number];

interface CommandValues {
  reason?: string;
}

/**
 * The server's `message` is a localized category ("Validation failed."); the explanation the operator needs
 * travels in `details.reason` (§12.5 "user-visible errors are clear and do not reveal internals"). A command
 * refusal without its blockers is not an actionable message, so the panel prefers the reason when the API
 * supplied one.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as Error & { details?: Record<string, unknown> }).details;
    const reason = details?.['reason'];
    if (typeof reason === 'string' && reason.trim() !== '') return reason;
    return error.message;
  }
  return String(error);
}

export function CampaignLifecycleActions({ campaignId, onChanged }: CampaignLifecycleActionsProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<CommandValues>();
  const [caps, setCaps] = useState<MarketingCampaignCapabilities | undefined>(undefined);
  const [transitions, setTransitions] = useState<MarketingCampaignTransitionRow[]>([]);
  const [pending, setPending] = useState<CampaignCommand | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [audience, setAudience] = useState<MarketingAudiencePreview | undefined>(undefined);
  const [audienceBusy, setAudienceBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [capabilities, history] = await Promise.all([
        api.marketingCampaignCapabilities(campaignId),
        api.marketingCampaignHistory(campaignId),
      ]);
      setCaps(capabilities);
      setTransitions(history.list);
    } catch {
      // A campaign the actor cannot read simply has no panel; the page already reports the record itself.
      setCaps(undefined);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allowed = useMemo(
    () => (caps ? COMMAND_ORDER.filter((command) => caps.allowedCommands.includes(command)) : []),
    [caps],
  );

  const runCommand = async (command: CampaignCommand, values: CommandValues): Promise<void> => {
    setBusy(true);
    try {
      await api.marketingCampaignCommand(campaignId, command, {
        ...(values.reason?.trim() ? { reason: values.reason.trim() } : {}),
      });
      void message.success(t('web.marketingAutomation.commandDone'));
      setPending(undefined);
      form.resetFields();
      await load();
      onChanged?.();
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const previewAudience = async (): Promise<void> => {
    setAudienceBusy(true);
    try {
      setAudience(await api.marketingAudiencePreview(campaignId));
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setAudienceBusy(false);
    }
  };

  const checkReadiness = async (): Promise<void> => {
    setChecking(true);
    try {
      await api.marketingCampaignValidate(campaignId);
      await load();
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setChecking(false);
    }
  };

  const duplicate = async (): Promise<void> => {
    setDuplicating(true);
    try {
      await api.marketingCampaignDuplicate(campaignId, {});
      void message.success(t('web.marketingAutomation.duplicateDone'));
      onChanged?.();
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setDuplicating(false);
    }
  };

  if (caps === undefined) return null;

  const blockers = caps.report.blockers;
  const warnings = caps.report.warnings;
  // The report shown is computed live; a stored fingerprint that no longer matches means the campaign
  // changed after the last explicit check (§5.5 "a material change invalidates a prior approval").
  const stale = caps.validationHash !== null && caps.validationHash !== caps.report.validationHash;

  return (
    <Card
      className="lizant-card"
      size="small"
      title={<Typography.Text strong>{t('web.marketingAutomation.lifecycle')}</Typography.Text>}
      extra={<Tag color="blue">{t(`marketing.status.${caps.status}`)}</Tag>}
    >
      <Space wrap size={8}>
        {allowed.map((command) => (
          <Button
            key={command}
            size="small"
            type={command === 'start' || command === 'schedule' ? 'primary' : 'default'}
            danger={command === 'cancel'}
            onClick={() => {
              form.resetFields();
              setPending(command);
            }}
          >
            {t(`marketing.command.${command}`)}
          </Button>
        ))}
        {allowed.length === 0 ? (
          <Typography.Text type="secondary">{t('web.marketingAutomation.noCommands')}</Typography.Text>
        ) : null}
      </Space>

      <Space wrap size={8} style={{ marginTop: 12 }}>
        <Button size="small" loading={checking} onClick={() => void checkReadiness()}>
          {t('web.marketingAutomation.validate')}
        </Button>
        <Button size="small" loading={duplicating} onClick={() => void duplicate()}>
          {t('web.marketingAutomation.duplicate')}
        </Button>
        <Button size="small" loading={audienceBusy} onClick={() => void previewAudience()}>
          {t('web.marketingAutomation.previewAudience')}
        </Button>
      </Space>

      {audience !== undefined ? (
        <Alert
          style={{ marginTop: 12 }}
          type={audience.eligible > 0 ? 'success' : 'info'}
          showIcon
          message={t('web.marketingAutomation.audienceSummary', {
            resolved: audience.resolved,
            eligible: audience.eligible,
          })}
          description={
            <>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {audience.categories.map((item) => (
                  <li key={item.category}>
                    {t(`web.marketingAutomation.category.${item.category}`)}: {item.count}
                  </li>
                ))}
              </ul>
              {audience.truncated ? (
                <Typography.Text type="danger">{t('web.marketingAutomation.truncated')}</Typography.Text>
              ) : null}
            </>
          }
        />
      ) : null}

      {blockers.length > 0 ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message={t('web.marketingAutomation.blockedTitle')}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {blockers.map((finding) => (
                <li key={finding.code + (finding.field ?? '')}>{finding.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      {warnings.length > 0 ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message={t('web.marketingAutomation.warningTitle')}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.map((finding) => (
                <li key={finding.code + (finding.field ?? '')}>{finding.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      {stale ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('web.marketingAutomation.staleReportHint')}
        </Typography.Paragraph>
      ) : null}

      <Modal
        open={pending !== undefined}
        title={pending ? t(`marketing.command.${pending}`) : ''}
        okText={t('web.marketingAutomation.confirm')}
        cancelText={t('web.marketingAutomation.cancel')}
        confirmLoading={busy}
        onCancel={() => setPending(undefined)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => pending && void runCommand(pending, values)}>
          <Form.Item
            name="reason"
            label={t('web.marketingAutomation.reason')}
            // The client mirrors the server's rule so the operator is told before submitting; the server
            // still refuses a `cancel` without a reason (§10.2), which is the actual enforcement.
            rules={pending === 'cancel' ? [{ required: true, message: t('web.marketingAutomation.reasonRequired') }] : []}
          >
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Typography.Title level={5} style={{ marginTop: 20 }}>
        {t('web.marketingAutomation.historyTitle')}
      </Typography.Title>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={transitions}
        columns={[
          {
            title: t('web.marketingAutomation.history.occurredAt'),
            dataIndex: 'occurredAt',
            width: 180,
            render: (value: string | null) => formatDateTime(value),
          },
          { title: t('web.marketingAutomation.history.from'), dataIndex: 'fromStatus', width: 120 },
          { title: t('web.marketingAutomation.history.to'), dataIndex: 'toStatus', width: 120 },
          { title: t('web.marketingAutomation.history.command'), dataIndex: 'command', width: 130 },
          {
            title: t('web.marketingAutomation.history.reason'),
            dataIndex: 'reason',
            render: (value: string | null) => value ?? '—',
          },
          {
            title: t('web.marketingAutomation.history.actor'),
            dataIndex: 'actorUserId',
            width: 170,
            render: (value: string | null) => (value ? <LinkValue entity="User" id={value} /> : '—'),
          },
        ]}
      />
    </Card>
  );
}
