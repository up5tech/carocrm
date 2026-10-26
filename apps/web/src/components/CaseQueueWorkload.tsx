/**
 * Phase 19-SD.5 — the queue workload view (PLAN §5.3, task SD.5.5).
 *
 * The server answers with the queue's eligible agents, how many active cases each owns and how many
 * still sit unowned — computed from the same eligibility the assignment command uses, so the view
 * cannot disagree with the routing. Access is decided server-side: a viewer without queue/team access
 * gets a permission answer and this panel shows that state instead of numbers.
 */

import { App as AntApp, Card, Statistic, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { ServiceDeskQueueWorkload } from '../api/types.js';
import { t } from '../state/i18n.js';
import { EmptyState } from './EmptyState.js';
import { linkLabelsOf,LinkValue } from './fields.js';

interface CaseQueueWorkloadProps {
  readonly queueId: string;
}

export function CaseQueueWorkload({ queueId }: CaseQueueWorkloadProps) {
  const { message } = AntApp.useApp();
  const [workload, setWorkload] = useState<ServiceDeskQueueWorkload | undefined>(undefined);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkload(await api.serviceDeskQueueWorkload(queueId));
      setDenied(false);
    } catch (error) {
      // 403 is a legitimate state for this panel; anything else is worth a message.
      const status = (error as { status?: number }).status;
      if (status === 403) setDenied(true);
      else void message.error(error instanceof Error ? error.message : t('web.serviceDesk.workloadFailed'));
      setWorkload(undefined);
    } finally {
      setLoading(false);
    }
  }, [queueId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (denied) {
    return (
      <Card className="carocrm-card" title={<Typography.Text strong>{t('web.serviceDesk.workload')}</Typography.Text>}>
        <Typography.Text type="secondary">{t('web.serviceDesk.workloadDenied')}</Typography.Text>
      </Card>
    );
  }

  return (
    <Card
      className="carocrm-card"
      size="small"
      loading={loading}
      title={<Typography.Text strong>{t('web.serviceDesk.workload')}</Typography.Text>}
    >
      {workload === undefined ? (
        <EmptyState description={t('web.serviceDesk.workloadEmpty')} />
      ) : (
        <>
          <Statistic title={t('web.serviceDesk.unassigned')} value={workload.unassigned} style={{ marginBottom: 16 }} />
          <Table
            rowKey="userId"
            size="small"
            pagination={false}
            dataSource={[...workload.members]}
            locale={{ emptyText: t('web.serviceDesk.noEligibleMember') }}
            columns={[
              {
                title: t('web.serviceDesk.columnAgent'),
                dataIndex: 'userId',
                render: (value: string, row: { userId: string; activeCases: number; _linkLabels?: unknown }) => {
                  const labels = linkLabelsOf(row);
                  return (
                    <LinkValue
                      entity="User"
                      id={value}
                      label={labels?.['userId']?.[value]}
                      resolve={labels === undefined}
                    />
                  );
                },
              },
              {
                title: t('web.serviceDesk.columnActiveCases'),
                dataIndex: 'activeCases',
                width: 160,
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
