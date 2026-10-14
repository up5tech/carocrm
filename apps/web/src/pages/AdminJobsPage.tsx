import { ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type JobLogLine, type JobRow, type ScheduleRow } from '../api/client.js';
import { t } from '../state/i18n.js';

const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];
const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

function timeText(value: string | null): string {
  if (!value) return '—';
  return value.slice(0, 19).replace('T', ' ');
}

function secondsBetween(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  return ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function parseData(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (text === '') return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export function AdminJobsPage() {
  const { message } = AntApp.useApp();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [queue, setQueue] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [logJob, setLogJob] = useState<JobRow | undefined>(undefined);
  const [logs, setLogs] = useState<JobLogLine[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  const [runForm] = Form.useForm<{ jobName: string; data?: string | undefined }>();
  const [scheduleForm] = Form.useForm<{ id: string; job: string; scheduling: string; data?: string | undefined; enabled: boolean }>();

  const pageSize = 20;

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.jobs({ status, offset, limit: pageSize });
      setJobs(result.list);
      setTotal(result.total);
      setQueue(result.queue ?? {});
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminJobs.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [status, offset, message]);

  const loadSchedules = useCallback(async () => {
    try {
      setSchedules((await api.schedules()).list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.adminJobs.schedulesLoadFailed'));
    }
  }, [message]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const openLogs = useCallback(
    async (job: JobRow) => {
      setLogJob(job);
      try {
        setLogs((await api.jobLogs(job.id)).lines);
      } catch (error) {
        setLogs([]);
        void message.error(error instanceof Error ? error.message : t('web.adminJobs.logsLoadFailed'));
      }
    },
    [message],
  );

  const refreshLogs = useCallback(async () => {
    if (!logJob) return;
    setLogs((await api.jobLogs(logJob.id)).lines);
    setLogJob(await api.job(logJob.id));
  }, [logJob]);

  const cancel = useCallback(
    async (job: JobRow) => {
      try {
        await api.cancelJob(job.id);
        void message.success(t('web.adminJobs.cancelRequested'));
        await loadJobs();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.adminJobs.cancelFailed'));
      }
    },
    [message, loadJobs],
  );

  const counts = useMemo(
    () =>
      Object.entries(queue)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('  '),
    [queue],
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        className="lizant-card"
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>{t('web.adminJobs.title')}</Typography.Title>}
        extra={
          <Space>
            <Typography.Text type="secondary">{counts}</Typography.Text>
            <Button icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
              {t('core.common.refresh')}
            </Button>
            <Button type="primary" onClick={() => setRunOpen(true)}>
              {t('web.adminJobs.runJob')}
            </Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 12 }}>
          <Select
            allowClear
            placeholder={t('web.adminJobs.statusPlaceholder')}
            style={{ width: 160 }}
            value={status}
            onChange={(value) => {
              setStatus(value === undefined ? undefined : String(value));
              setOffset(0);
            }}
            options={JOB_STATUSES.map((value) => ({ value, label: value }))}
          />
        </Space>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={jobs}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: Math.floor(offset / pageSize) + 1,
            pageSize,
            total,
            onChange: (page, size) => {
              setOffset((page - 1) * size);
            },
          }}
          columns={[
            { title: t('web.adminJobs.job'), dataIndex: 'job', width: 200 },
            {
              title: t('web.common.status'),
              dataIndex: 'status',
              width: 110,
              render: (value: string) => <Tag className="lizant-pill" color={STATUS_COLORS[value] ?? 'default'}>{value}</Tag>,
            },
            {
              title: t('web.adminJobs.progress'),
              dataIndex: 'progress',
              width: 120,
              render: (value: number, row: JobRow) =>
                row.status === 'running' || row.status === 'pending' ? <Progress percent={value ?? 0} size="small" /> : <Typography.Text type="secondary">{value ?? 0}%</Typography.Text>,
            },
            { title: t('web.adminJobs.attempt'), key: 'attempt', width: 90, render: (_: unknown, row: JobRow) => `${String(row.attempt)} / ${String(row.maxAttempts)}` },
            { title: t('web.adminJobs.message'), dataIndex: 'message', ellipsis: true, render: (value: string | null, row: JobRow) => value ?? row.lastError ?? '—' },
            { title: t('web.adminJobs.schedule'), dataIndex: 'schedulingType', width: 90, render: (value: string | null) => (value === 'cron' ? <Tag>cron</Tag> : '—') },
            { title: t('web.adminJobs.started'), dataIndex: 'startedAt', width: 150, render: (value: string | null) => timeText(value) },
            { title: t('web.adminJobs.took'), key: 'took', width: 90, render: (_: unknown, row: JobRow) => secondsBetween(row.startedAt, row.finishedAt) },
            {
              title: '',
              key: 'actions',
              width: 170,
              render: (_: unknown, row: JobRow) => (
                <Space size={4}>
                  <Button size="small" type="text" onClick={() => void openLogs(row)}>
                    {t('web.adminJobs.log')}
                  </Button>
                  {row.status === 'pending' || row.status === 'running' ? (
                    <Popconfirm title={t('web.adminJobs.cancelConfirm')} onConfirm={() => void cancel(row)}>
                      <Button size="small" danger type="text">
                        {t('web.adminJobs.cancel')}
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card className="lizant-card" title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>{t('web.adminJobs.scheduledTitle')}</Typography.Title>}>
        <Table
          rowKey="id"
          size="small"
          dataSource={schedules}
          pagination={false}
          columns={[
            { title: t('web.adminJobs.id'), dataIndex: 'id', width: 180 },
            { title: t('web.adminJobs.job'), dataIndex: 'job', width: 200 },
            { title: t('web.adminJobs.cron'), dataIndex: 'scheduling', width: 120, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
            { title: t('web.adminJobs.data'), dataIndex: 'data', render: (value: Record<string, unknown>) => JSON.stringify(value ?? {}) },
            { title: t('web.adminJobs.lastRun'), dataIndex: 'lastRunAt', width: 150, render: (value: string | null) => timeText(value) },
            {
              title: t('web.adminJobs.enabled'),
              dataIndex: 'enabled',
              width: 90,
              render: (value: boolean, row: ScheduleRow) => (
                <Switch
                  size="small"
                  checked={value}
                  onChange={async (checked) => {
                    try {
                      await api.setScheduleEnabled(row.id, checked);
                      await loadSchedules();
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : t('web.adminJobs.scheduleUpdateFailed'));
                    }
                  }}
                />
              ),
            },
            {
              title: '',
              key: 'run',
              width: 90,
              render: (_: unknown, row: ScheduleRow) => (
                <Button
                  size="small"
                  type="text"
                  onClick={async () => {
                    try {
                      const job = await api.runScheduleNow(row.id);
                      void message.success(t('web.adminJobs.queued', { job: job.job }));
                      await Promise.all([loadJobs(), loadSchedules()]);
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : t('web.adminJobs.runFailed'));
                    }
                  }}
                >
                  {t('web.adminJobs.runNow')}
                </Button>
              ),
            },
          ]}
        />
        <Form
          form={scheduleForm}
          layout="inline"
          style={{ marginTop: 12, rowGap: 8 }}
          initialValues={{ enabled: true }}
          onFinish={async (values) => {
            try {
              await api.saveSchedule({ id: values.id, job: values.job, scheduling: values.scheduling, data: parseData(values.data), enabled: values.enabled });
              void message.success(t('web.adminJobs.scheduleSaved'));
              scheduleForm.resetFields();
              await loadSchedules();
            } catch (error) {
              void message.error(error instanceof Error ? error.message : t('web.adminJobs.scheduleSaveFailed'));
            }
          }}
        >
          <Form.Item name="id" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, message: t('web.adminJobs.idPattern') }]}>
            <Input placeholder={t('web.adminJobs.idPlaceholder')} style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="job" rules={[{ required: true, pattern: /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/, message: t('web.adminJobs.jobPattern') }]}>
            <Input placeholder="system.cleanupOutbox" style={{ width: 190 }} />
          </Form.Item>
          <Form.Item
            name="scheduling"
            rules={[
              { required: true },
              {
                validator: async (_: unknown, value: string) => {
                  if (!value) return;
                  const preview = await api.previewCron(value);
                  if (!preview.valid) throw new Error(t('web.adminJobs.cronInvalid'));
                },
              },
            ]}
          >
            <Input placeholder="0 * * * *" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="data">
            <Input placeholder='{"retentionDays":7}' style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Button size="small" type="primary" htmlType="submit">
            {t('web.adminJobs.saveSchedule')}
          </Button>
        </Form>
      </Card>

      <Modal
        title={t('web.adminJobs.runJob')}
        open={runOpen}
        onCancel={() => setRunOpen(false)}
        onOk={async () => {
          const values = await runForm.validateFields();
          try {
            const job = await api.runJob(values.jobName, parseData(values.data));
            void message.success(t('web.adminJobs.queued', { job: job.job }));
            setRunOpen(false);
            runForm.resetFields();
            await loadJobs();
          } catch (error) {
            void message.error(error instanceof Error ? error.message : t('web.adminJobs.runFailed'));
          }
        }}
      >
        <Form form={runForm} layout="vertical">
          <Form.Item name="jobName" label={t('web.adminJobs.job')} rules={[{ required: true, pattern: /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/, message: t('web.adminJobs.jobPatternHint') }]}>
            <Input placeholder="system.cleanupOutbox" />
          </Form.Item>
          <Form.Item name="data" label={t('web.adminJobs.dataLabel')} extra={t('web.adminJobs.dataHint')}>
            <Input.TextArea rows={3} placeholder='{"retentionDays":7}' />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={t('web.adminJobs.logTitle', { job: logJob?.job ?? '' })} width={720} open={logJob !== undefined} onClose={() => setLogJob(undefined)}>
        <Space style={{ marginBottom: 12 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshLogs()}>
            {t('core.common.refresh')}
          </Button>
          <Typography.Text type="secondary">{logJob ? t('web.adminJobs.attemptSummary', { status: logJob.status, attempt: String(logJob.attempt), max: String(logJob.maxAttempts) }) : ''}</Typography.Text>
        </Space>
        {logJob ? (
          <Descriptions
            size="small"
            column={1}
            style={{ marginBottom: 16 }}
            items={[
              { key: 'id', label: t('web.adminJobs.id'), children: <Typography.Text copyable>{logJob.id}</Typography.Text> },
              { key: 'message', label: t('web.adminJobs.message'), children: logJob.message ?? logJob.lastError ?? '—' },
              { key: 'result', label: t('web.adminJobs.result'), children: JSON.stringify(logJob.result ?? {}) },
            ]}
          />
        ) : null}
        <pre className="lizant-job-log">
          {logs.length === 0
            ? t('web.adminJobs.noLogs')
            : logs.map((line) => `${line.createdAt.slice(0, 19).replace('T', ' ')} [${line.level}] ${line.message}`).join('\n')}
        </pre>
      </Drawer>
    </Space>
  );
}
