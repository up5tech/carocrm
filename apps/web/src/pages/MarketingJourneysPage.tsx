import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PageHeader } from '../components/PageHeader.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { formatDateTime, t } from '../state/i18n.js';

/**
 * Phase 19-MA.12 — the journey list.
 *
 * `MarketingJourney` is registered with `client.web: false`, so the metadata-driven SPA never offered a way
 * in: the definitions, versions and enrollments were reachable only by calling the API by hand. This page is
 * that door. It lists what the reader may see — record ACL is `own`, so a marketer gets their own journeys —
 * and every row opens the editor, which is where the graph, the validation and the publishing live.
 */

const STATUS_COLORS: Record<string, string> = {
  Draft: 'default',
  Published: 'green',
  Paused: 'gold',
  Archived: 'default',
};

interface JourneyRow {
  id: string;
  name: string | null;
  status: string | null;
  triggerFamily: string | null;
  currentVersion: number | null;
  createdAt: string | null;
}

export function MarketingJourneysPage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; description?: string }>();

  const journeys = useQuery({
    queryKey: ['marketingJourneys'],
    queryFn: async () => ((await api.list('MarketingJourney', { maxSize: 200, orderBy: 'createdAt,desc' })).list as unknown) as JourneyRow[],
    staleTime: 15_000,
    retry: false,
  });

  const create = useMutation({
    mutationFn: async (values: { name: string; description?: string }) => {
      const created = await api.create('MarketingJourney', {
        name: values.name,
        status: 'Draft',
        ...(values.description === undefined || values.description === '' ? {} : { description: values.description }),
      });
      return created;
    },
    onSuccess: (created) => {
      setCreateOpen(false);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['marketingJourneys'] });
      void navigate(`/marketing/journeys/${String(created.id)}`);
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (journeys.isLoading) return <LoadingSkeleton rows={6} />;
  if (journeys.isError) {
    if (journeys.error instanceof ApiError && journeys.error.status === 403) {
      return <PermissionDenied hint={t('web.journeys.denied')} />;
    }
    return <ErrorState message={t('web.journeys.loadFailed')} onRetry={() => void journeys.refetch()} />;
  }

  return (
    <div>
      <PageHeader
        title={t('web.journeys.title')}
        subtitle={t('web.journeys.subtitle')}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('web.journeys.new')}
          </Button>
        }
      />

      <Table<JourneyRow>
        size="small"
        rowKey={(row) => row.id}
        dataSource={journeys.data}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <EmptyState description={t('web.journeys.empty')} /> }}
        columns={[
          {
            title: t('web.journeys.name'),
            dataIndex: 'name',
            render: (_: unknown, row) => <Link to={`/marketing/journeys/${row.id}`}>{row.name ?? row.id}</Link>,
          },
          {
            title: t('web.journeys.status'),
            dataIndex: 'status',
            width: 130,
            render: (value: string | null) => <Tag color={STATUS_COLORS[value ?? ''] ?? 'default'}>{value ?? '—'}</Tag>,
          },
          { title: t('web.journeys.triggerFamily'), dataIndex: 'triggerFamily', width: 150, render: (value: string | null) => value ?? '—' },
          {
            title: t('web.journeys.currentVersion'),
            dataIndex: 'currentVersion',
            width: 110,
            render: (value: number | null) => (value === null || value === 0 ? t('web.journeys.neverPublished') : String(value)),
          },
          {
            title: t('web.journeys.createdAt'),
            dataIndex: 'createdAt',
            width: 170,
            render: (value: string | null) => (typeof value === 'string' ? formatDateTime(value) : '—'),
          },
        ]}
      />

      <Modal
        title={t('web.journeys.new')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        okText={t('web.common.create')}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}>
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('web.journeys.description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.journeys.createHint')}
            </Typography.Text>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
