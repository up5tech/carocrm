import { ApartmentOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Dropdown, Empty, List, Space, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../api/client.js';
import type { ProcessInstanceView } from '../api/types.js';
import { t } from '../state/i18n.js';
import { useAvailableProcesses, useProcessInstances } from '../state/processes.js';
import { useSession } from '../state/session.js';
import { INSTANCE_STATUS_COLORS, ProcessTrailModal } from './ProcessTrailModal.js';

/**
 * Approvals on one record (PLAN §36).
 *
 * The process engine has always been participant-facing server-side — anyone who can read a record
 * may start an approval on it, and every participant may answer their task — but for a long time
 * the only UI was the admin area, so a salesperson could not start the approval the API was willing
 * to accept. This panel is that missing surface: it names the processes this record type offers,
 * starts one, and shows the trail of what already ran here.
 *
 * It renders nothing when the record has no history and no process is available, so an ordinary
 * record does not grow an empty card. Starting and cancelling are the server's decisions — a refusal
 * is reported verbatim rather than pre-empted by a client-side guess.
 */
export function ProcessPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const available = useAvailableProcesses(entityType);
  // A panel shows the recent history, not the whole life of the record: the list endpoint returns a
  // full view per row (tasks + events), so it is asked for a page, not everything.
  const instances = useProcessInstances({ entityType, entityId, limit: 20 });
  const [open, setOpen] = useState<ProcessInstanceView | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['processes'] });
  };

  const start = useMutation({
    mutationFn: (processId: string) => api.startProcess({ processId, entityType, entityId }),
    onSuccess: (instance) => {
      void message.success(t('web.recordProcess.started'));
      setOpen(instance);
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  // A record the caller may not read answers with an error; the panel simply stays out of the page.
  if (instances.isError) return null;

  const list = instances.data?.list ?? [];
  const startable = available.data?.list ?? [];
  if (list.length === 0 && startable.length === 0) return null;

  // Only the starter (or an admin) may cancel — the server enforces it; this just avoids a button
  // that can only fail.
  const mine =
    open !== null && (principal?.type === 'admin' || (open.initiatedBy !== null && open.initiatedBy === principal?.id));

  return (
    <Card
      className="carocrm-card"
      title={
        <Space>
          <ApartmentOutlined />
          <Typography.Text strong>{t('web.recordProcess.title')}</Typography.Text>
          {list.length > 0 ? <Tag>{list.length}</Tag> : null}
        </Space>
      }
      extra={
        startable.length > 0 ? (
          <Dropdown
            trigger={['click']}
            menu={{
              items: startable.map((process) => ({
                key: process.id,
                label: (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{process.name}</Typography.Text>
                    {process.description !== null ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {process.description}
                      </Typography.Text>
                    ) : null}
                  </Space>
                ),
                onClick: () => start.mutate(process.id),
              })),
            }}
          >
            <Button type="primary" icon={<PlusOutlined />} loading={start.isPending}>
              {t('web.recordProcess.start')}
            </Button>
          </Dropdown>
        ) : null
      }
    >
      {list.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('web.recordProcess.empty')} />
      ) : (
        <List
          size="small"
          dataSource={list}
          renderItem={(instance) => {
            const waiting = instance.tasks.filter(
              (task) => task.status === 'open' || task.status === 'overdue' || task.status === 'escalated',
            );
            return (
              <List.Item
                actions={[
                  <Button key="trail" size="small" onClick={() => setOpen(instance)}>
                    {t('web.processes.trail')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <Typography.Text strong>{instance.processName}</Typography.Text>
                      <Tag color={INSTANCE_STATUS_COLORS[instance.status] ?? 'default'}>{instance.status}</Tag>
                      {instance.outcome !== null ? <Tag>{instance.outcome}</Tag> : null}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary">
                        {t('web.recordProcess.startedAt', { date: instance.startedAt.slice(0, 19).replace('T', ' ') })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {waiting.length === 0
                          ? t('web.recordProcess.noOpenStep')
                          : t('web.recordProcess.waitingOn', { names: waiting.map((task) => task.name).join(', ') })}
                      </Typography.Text>
                      {instance.error !== null ? <Typography.Text type="danger">{instance.error}</Typography.Text> : null}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}

      <ProcessTrailModal
        instance={open}
        allowCancel={mine}
        onClose={() => setOpen(null)}
        onChanged={refresh}
      />
    </Card>
  );
}
