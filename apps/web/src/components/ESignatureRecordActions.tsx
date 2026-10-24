import { FileProtectOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, List, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import { formatDateTime, t } from '../state/i18n.js';

/**
 * Phase 19-ES.18 — the ESignature entry point on a CRM record page
 * (`PLAN_Phase_19_ESignature.md` §2.3, §13.1, §18 `19-ES.18`).
 *
 * The component is generic: it renders on every record page (outside the portal), asks the server
 * whether this entity is a supported entry point and whether the caller may use it, and disappears
 * when the answer is no. That is what keeps ESignature optional — the record page imports one small
 * component, never Sales, Projects, Service Desk or Customer Success, and a module that is not
 * installed simply never appears as an entity.
 *
 * The server answer also carries the caller's `canPrepare` and a few recent requests linked to this
 * record, so the card is useful without granting any extra read: the list is already filtered by the
 * caller's ESignature record scope.
 */
export function ESignatureRecordActions(props: { entityType: string; entityId: string; recordLabel?: string | undefined }) {
  const navigate = useNavigate();
  const entry = useQuery({
    queryKey: ['eSignature', 'record-entry', props.entityType, props.entityId],
    queryFn: () => api.eSignatureRecordEntry(props.entityType, props.entityId),
    staleTime: 30_000,
    retry: false,
  });
  const view = entry.data;
  if (entry.isError || view === undefined || !view.available) return null;

  const openCreate = () => {
    const params = new URLSearchParams({ sourceEntityType: view.entityType, sourceRecordId: view.recordId });
    // The form shows the record's own name; the URL carries it so the drawer does not have to
    // re-read the record just to label the source.
    if (props.recordLabel !== undefined && props.recordLabel !== '') params.set('sourceRecordLabel', props.recordLabel);
    navigate(`/esignature?${params.toString()}`);
  };
  const openRequest = (id: string) => {
    const params = new URLSearchParams({ request: id });
    navigate(`/esignature?${params.toString()}`);
  };

  return (
    <Card
      className="carocrm-card"
      title={
        <Space>
          <FileProtectOutlined />
          <Typography.Text strong>{t('esignature.recordEntry.title')}</Typography.Text>
          {view.requests.length > 0 ? <Tag>{view.requests.length}</Tag> : null}
        </Space>
      }
      extra={
        view.canPrepare ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('esignature.recordEntry.create')}
          </Button>
        ) : null
      }
    >
      {view.requests.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('esignature.recordEntry.empty')} />
      ) : (
        <List
          size="small"
          dataSource={[...view.requests]}
          renderItem={(request) => (
            <List.Item
              actions={[
                <Button key="open" size="small" onClick={() => openRequest(request.id)}>
                  {t('esignature.recordEntry.open')}
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <Typography.Text strong>{request.name}</Typography.Text>
                    <Tag color={statusColor(request.status)}>{t(`esignature.requests.statuses.${request.status}`)}</Tag>
                    {request.approvalStatus === 'not_required' ? null : (
                      <Tag color="orange">{t(`esignature.requests.approvalStatuses.${request.approvalStatus}`)}</Tag>
                    )}
                  </Space>
                }
                description={
                  <Typography.Text type="secondary">
                    {t('esignature.recordEntry.updated', { date: formatDateTime(request.modifiedAt) })}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

function statusColor(status: string): string {
  if (status === 'completed') return 'green';
  if (status === 'declined' || status === 'expired' || status === 'provider_error') return 'red';
  if (status === 'voided' || status === 'reconciliation_required') return 'volcano';
  if (status === 'sent' || status === 'delivered' || status === 'partially_signed') return 'blue';
  if (status === 'draft') return 'default';
  return 'gold';
}
