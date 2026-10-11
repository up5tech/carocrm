import { ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type JobLogLine, type JobRow, type ScheduleRow } from '../api/client.js';

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
      void message.error(error instanceof Error ? error.message : 'Could not load jobs.');
    } finally {
      setLoading(false);
    }
  }, [status, offset, message]);

  const loadSchedules = useCallback(async () => {
    try {
      setSchedules((await api.schedules()).list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Could not load schedules.');
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
        void message.error(error instanceof Error ? error.message : 'Could not load job logs.');
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
        void message.success('Cancellation requested.');
        await loadJobs();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : 'Cancel failed.');
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
        title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Jobs</Typography.Title>}
        extra={
          <Space>
            <Typography.Text type="secondary">{counts}</Typography.Text>
            <Button icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
              Refresh
            </Button>
            <Button type="primary" onClick={() => setRunOpen(true)}>
              Run a job
            </Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 12 }}>
          <Select
            allowClear
            placeholder="status"
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
            { title: 'Job', dataIndex: 'job', width: 200 },
            {
              title: 'Status',
              dataIndex: 'status',
              width: 110,
              render: (value: string) => <Tag className="lizant-pill" color={STATUS_COLORS[value] ?? 'default'}>{value}</Tag>,
            },
            {
              title: 'Progress',
              dataIndex: 'progress',
              width: 120,
              render: (value: number, row: JobRow) =>
                row.status === 'running' || row.status === 'pending' ? <Progress percent={value ?? 0} size="small" /> : <Typography.Text type="secondary">{value ?? 0}%</Typography.Text>,
            },
            { title: 'Attempt', key: 'attempt', width: 90, render: (_: unknown, row: JobRow) => `${String(row.attempt)} / ${String(row.maxAttempts)}` },
            { title: 'Message', dataIndex: 'message', ellipsis: true, render: (value: string | null, row: JobRow) => value ?? row.lastError ?? '—' },
            { title: 'Schedule', dataIndex: 'schedulingType', width: 90, render: (value: string | null) => (value === 'cron' ? <Tag>cron</Tag> : '—') },
            { title: 'Started', dataIndex: 'startedAt', width: 150, render: (value: string | null) => timeText(value) },
            { title: 'Took', key: 'took', width: 90, render: (_: unknown, row: JobRow) => secondsBetween(row.startedAt, row.finishedAt) },
            {
              title: '',
              key: 'actions',
              width: 170,
              render: (_: unknown, row: JobRow) => (
                <Space size={4}>
                  <Button size="small" type="text" onClick={() => void openLogs(row)}>
                    Log
                  </Button>
                  {row.status === 'pending' || row.status === 'running' ? (
                    <Popconfirm title="Cancel this job?" onConfirm={() => void cancel(row)}>
                      <Button size="small" danger type="text">
                        Cancel
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card className="lizant-card" title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Scheduled jobs</Typography.Title>}>
        <Table
          rowKey="id"
          size="small"
          dataSource={schedules}
          pagination={false}
          columns={[
            { title: 'Id', dataIndex: 'id', width: 180 },
            { title: 'Job', dataIndex: 'job', width: 200 },
            { title: 'Cron', dataIndex: 'scheduling', width: 120, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
            { title: 'Data', dataIndex: 'data', render: (value: Record<string, unknown>) => JSON.stringify(value ?? {}) },
            { title: 'Last run', dataIndex: 'lastRunAt', width: 150, render: (value: string | null) => timeText(value) },
            {
              title: 'Enabled',
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
                      void message.error(error instanceof Error ? error.message : 'Could not update the schedule.');
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
                      void message.success(`Queued ${job.job}.`);
                      await Promise.all([loadJobs(), loadSchedules()]);
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : 'Run failed.');
                    }
                  }}
                >
                  Run now
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
              void message.success('Schedule saved.');
              scheduleForm.resetFields();
              await loadSchedules();
            } catch (error) {
              void message.error(error instanceof Error ? error.message : 'Could not save the schedule.');
            }
          }}
        >
          <Form.Item name="id" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, message: 'letters, digits, _ or -' }]}>
            <Input placeholder="schedule id" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="job" rules={[{ required: true, pattern: /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/, message: 'module.action' }]}>
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
                  if (!preview.valid) throw new Error('Not a valid cron expression');
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
            Save schedule
          </Button>
        </Form>
      </Card>

      <Modal
        title="Run a job"
        open={runOpen}
        onCancel={() => setRunOpen(false)}
        onOk={async () => {
          const values = await runForm.validateFields();
          try {
            const job = await api.runJob(values.jobName, parseData(values.data));
            void message.success(`Queued ${job.job}.`);
            setRunOpen(false);
            runForm.resetFields();
            await loadJobs();
          } catch (error) {
            void message.error(error instanceof Error ? error.message : 'Run failed.');
          }
        }}
      >
        <Form form={runForm} layout="vertical">
          <Form.Item name="jobName" label="Job" rules={[{ required: true, pattern: /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/, message: 'Use "<module>.<action>", e.g. system.cleanupOutbox.' }]}>
            <Input placeholder="system.cleanupOutbox" />
          </Form.Item>
          <Form.Item name="data" label="Data (JSON object, optional)" extra="Only the registered job name is executed — never code.">
            <Input.TextArea rows={3} placeholder='{"retentionDays":7}' />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={`Job log — ${logJob?.job ?? ''}`} width={720} open={logJob !== undefined} onClose={() => setLogJob(undefined)}>
        <Space style={{ marginBottom: 12 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshLogs()}>
            Refresh
          </Button>
          <Typography.Text type="secondary">{logJob ? `${logJob.status} · attempt ${String(logJob.attempt)} of ${String(logJob.maxAttempts)}` : ''}</Typography.Text>
        </Space>
        {logJob ? (
          <Descriptions
            size="small"
            column={1}
            style={{ marginBottom: 16 }}
            items={[
              { key: 'id', label: 'Id', children: <Typography.Text copyable>{logJob.id}</Typography.Text> },
              { key: 'message', label: 'Message', children: logJob.message ?? logJob.lastError ?? '—' },
              { key: 'result', label: 'Result', children: JSON.stringify(logJob.result ?? {}) },
            ]}
          />
        ) : null}
        <pre className="lizant-job-log">
          {logs.length === 0
            ? 'No log lines yet.'
            : logs.map((line) => `${line.createdAt.slice(0, 19).replace('T', ' ')} [${line.level}] ${line.message}`).join('\n')}
        </pre>
      </Drawer>
    </Space>
  );
}
