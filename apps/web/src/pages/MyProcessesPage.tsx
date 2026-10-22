import { ApartmentOutlined, CarryOutOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { ProcessInstanceView } from '../api/types.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { INSTANCE_STATUS_COLORS, ProcessTrailModal } from '../components/ProcessTrailModal.js';
import { t } from '../state/i18n.js';
import { useProcessInstances } from '../state/processes.js';

const SCOPES = ['all', 'running', 'waiting', 'completed', 'cancelled', 'failed'] as const;
type Scope = (typeof SCOPES)[number];

/**
 * My approvals (PLAN §36).
 *
 * The tasks page answers "what is waiting for me"; this page answers the other half of the
 * participant's question — "what did I start, and where did it end up". Instances are scoped
 * server-side to the initiator and to anyone holding a task, so this list is exactly the set the
 * API decided this person is part of; a trail that moved on to the next approver stays visible to
 * the person who submitted it.
 */
export function MyProcessesPage() {
  const [scope, setScope] = useState<Scope>('all');
  const [open, setOpen] = useState<ProcessInstanceView | null>(null);
  const instances = useProcessInstances(scope === 'all' ? {} : { status: scope });

  const rows = instances.data?.list ?? [];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        className="carocrm-card"
        title={
          <Space>
            <ApartmentOutlined />
            <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>
              {t('web.myProcesses.title')}
            </Typography.Title>
            <DocsLink docKey="user/activities-and-tasks" compact />
          </Space>
        }
        extra={
          <Space>
            <Link to="/tasks">
              <Button icon={<CarryOutOutlined />}>{t('web.tasks.title')}</Button>
            </Link>
            <Button icon={<ReloadOutlined />} onClick={() => void instances.refetch()} loading={instances.isFetching}>
              {t('web.list.refresh')}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('web.myProcesses.subtitle')}</Typography.Text>
          <Space wrap>
            {SCOPES.map((value) => (
              <Button key={value} size="small" type={scope === value ? 'primary' : 'default'} onClick={() => setScope(value)}>
                {t(`web.myProcesses.scope.${value}`)}
              </Button>
            ))}
          </Space>
          <Table<ProcessInstanceView>
            rowKey="id"
            size="small"
            loading={instances.isFetching}
            dataSource={rows}
            pagination={false}
            locale={{ emptyText: t('web.myProcesses.empty') }}
            columns={[
              {
                title: t('web.myProcesses.columnApproval'),
                render: (_value: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Link onClick={() => setOpen(row)}>{row.processName}</Typography.Link>
                    <Link to={`/${row.entityType}/${row.entityId}`}>
                      <Typography.Text type="secondary">
                        {row.entityType}/{row.entityId}
                      </Typography.Text>
                    </Link>
                  </Space>
                ),
              },
              {
                title: t('web.common.status'),
                width: 150,
                render: (_value: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Tag color={INSTANCE_STATUS_COLORS[row.status] ?? 'default'}>{row.status}</Tag>
                    {row.outcome !== null ? (
                      <Typography.Text type="secondary">{t('web.processes.outcome', { outcome: row.outcome })}</Typography.Text>
                    ) : null}
                  </Space>
                ),
              },
              {
                title: t('web.myProcesses.columnWaiting'),
                render: (_value: unknown, row) => {
                  const waiting = row.tasks.filter(
                    (task) => task.status === 'open' || task.status === 'overdue' || task.status === 'escalated',
                  );
                  return waiting.length === 0 ? (
                    <Typography.Text type="secondary">{t('web.recordProcess.noOpenStep')}</Typography.Text>
                  ) : (
                    <Space size={4} wrap>
                      {waiting.map((task) => (
                        <Tag key={task.id}>{task.name}</Tag>
                      ))}
                    </Space>
                  );
                },
              },
              {
                title: t('web.workflows.started'),
                width: 170,
                render: (_value: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' '),
              },
              {
                title: '',
                width: 90,
                render: (_value: unknown, row) => (
                  <Button size="small" onClick={() => setOpen(row)}>
                    {t('web.processes.trail')}
                  </Button>
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <ProcessTrailModal instance={open} allowCancel onClose={() => setOpen(null)} onChanged={() => void instances.refetch()} />
    </Space>
  );
}
