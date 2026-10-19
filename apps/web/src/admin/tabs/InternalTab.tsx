import { useQuery } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';
import { errorMessage } from './identity.js';

/**
 * Internal tab (PLAN_Phase_20_Settings_UX.md §4.3 row 8): instance facts and the guarded danger zone.
 * The two destructive actions live behind exact typed confirmations on the server — the modal typing
 * is the client's mirror of that, never the enforcement — and every execution is audited.
 */
export function InternalTab() {
  const info = useQuery({ queryKey: ['adminInternal'], queryFn: () => api.internalInfo(), staleTime: 15_000 });
  const [resetting, setResetting] = useState(false);
  const [purging, setPurging] = useState(false);

  return (
    <div className="carocrm-admin-records">
      <Card className="carocrm-card" title={t('web.adminInternal.title')} extra={info.isFetching ? <Typography.Text type="secondary">{t('web.adminEmail.loading')}</Typography.Text> : null}>
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
          <Descriptions.Item label={t('web.adminInternal.metadataVersion')}>{info.data?.metadataVersion ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.entityCount')}>{info.data?.entityCount ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.overrideCount')}>{info.data?.overrideCount ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.extensions')}>{info.data === undefined ? '—' : info.data.extensions.length === 0 ? '---' : info.data.extensions.join(', ')}</Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.queueName')}>
            <Typography.Text code>{info.data?.jobQueue.name ?? '—'}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.queueCounts')}>
            <QueueCounts counts={info.data?.jobQueue.counts ?? null} />
          </Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.nodeVersion')}>
            <Typography.Text code>{info.data?.nodeVersion ?? '—'}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('web.adminInternal.uptime')}>{info.data === undefined ? '—' : `${Math.floor(info.data.uptimeSeconds / 60)} min`}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card className="carocrm-card" title={t('web.adminInternal.dangerTitle')}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('web.adminInternal.dangerHint')}</Typography.Text>
          <Space wrap size={8}>
            <Button danger loading={resetting} onClick={() => setResetting(true)}>
              {t('web.adminInternal.resetButton', { count: info.data?.overrideCount ?? 0 })}
            </Button>
            <Button danger loading={purging} onClick={() => setPurging(true)}>
              {t('web.adminInternal.purgeButton')}
            </Button>
          </Space>
        </Space>
      </Card>
      {resetting ? (
        <ConfirmActionModal
          phrase="RESET METADATA"
          title={t('web.adminInternal.resetTitle')}
          warning={t('web.adminInternal.resetWarning')}
          actionLabel={t('web.adminInternal.resetButton', { count: info.data?.overrideCount ?? 0 })}
          onClose={() => setResetting(false)}
          onDone={(detail) => {
            setResetting(false);
            void info.refetch();
            return t('web.adminInternal.resetDone', { count: detail });
          }}
          run={(confirm) => api.resetMetadataOverrides(confirm)}
        />
      ) : null}
      {purging ? (
        <ConfirmActionModal
          phrase="PURGE QUEUE"
          title={t('web.adminInternal.purgeTitle')}
          warning={t('web.adminInternal.purgeWarning')}
          actionLabel={t('web.adminInternal.purgeButton')}
          onClose={() => setPurging(false)}
          onDone={(detail) => {
            setPurging(false);
            void info.refetch();
            return t('web.adminInternal.purgeDone', { count: detail === null ? 0 : detail });
          }}
          run={(confirm) => api.purgeJobQueue(confirm)}
        />
      ) : null}
    </div>
  );
}

function QueueCounts({ counts }: { readonly counts: Record<string, number> | null }) {
  if (counts === null) return <Tag>{t('web.adminInternal.queueUnreachable')}</Tag>;
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <Tag>{t('web.adminInternal.queueEmpty')}</Tag>;
  return (
    <Space size={4} wrap>
      {entries.map(([name, count]) => (
        <Tag key={name} className="carocrm-admin-tag">
          {name}: {count}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * The typed confirmation the plan requires: the phrase is displayed, the administrator retypes it, and
 * the server independently refuses anything else (§20.9 acceptance — "require typed confirmation").
 */
function ConfirmActionModal({
  phrase,
  title,
  warning,
  actionLabel,
  run,
  onDone,
  onClose,
}: {
  readonly phrase: string;
  readonly title: string;
  readonly warning: string;
  readonly actionLabel: string;
  readonly run: (confirm: string) => Promise<{ drained?: number | null; cleared?: number }>;
  readonly onDone: (detail: number | null) => string;
  readonly onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = typed === phrase;

  const execute = async () => {
    setRunning(true);
    setFailed(null);
    try {
      const result = await run(typed);
      void message.success(onDone(result.cleared ?? result.drained ?? null));
      onClose();
    } catch (error) {
      setFailed(errorMessage(error, t('web.adminInternal.actionFailed')));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      width={520}
      title={title}
      okText={actionLabel}
      okButtonProps={{ danger: true, disabled: !ready }}
      confirmLoading={running}
      onCancel={onClose}
      onOk={() => void execute()}
      destroyOnHidden
    >
      <Alert type="warning" showIcon message={warning} />
      <Typography.Paragraph type="secondary">{t('web.adminInternal.typePhrase', { phrase })}</Typography.Paragraph>
      <Input
        value={typed}
        autoComplete="off"
        aria-label={t('web.adminInternal.confirmAria')}
        placeholder={phrase}
        onChange={(event) => setTyped(event.target.value)}
        {...(ready ? { onPressEnter: () => void execute() } : {})}
      />
      {failed !== null ? (
        <Typography.Paragraph type="danger" role="alert" style={{ marginTop: 12 }}>
          {failed}
        </Typography.Paragraph>
      ) : null}
    </Modal>
  );
}
