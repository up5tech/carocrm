import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Select, Space } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api, type DashboardRow } from '../api/client.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';
import { DashletResult } from './DashletResult.js';

export function DashboardsPage() {
  const metadata = useMetadata();
  const { principal } = useSession();
  const { message } = AntApp.useApp();
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [dashletOpen, setDashletOpen] = useState(false);
  const [form] = Form.useForm();
  const [dashletForm] = Form.useForm();

  const entities = navEntities(metadata.data, principal?.type).map((entity) => ({ value: entity.name, label: entity.label }));
  const active = dashboards.find((item) => item.id === activeId) ?? null;

  const load = useCallback(async (): Promise<DashboardRow[]> => {
    setLoading(true);
    try {
      const list = await api.dashboards();
      setDashboards(list);
      setActiveId((prev) => (list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? null)));
      return list;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to load dashboards.');
      return [];
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // Takes the dashboard row to run: a caller that just reloaded the list must not run the stale
  // dashlet set captured in an earlier render.
  const runAll = useCallback(
    async (dash: DashboardRow) => {
      try {
        const entries = await Promise.all(dash.dashlets.map(async (dashlet) => [dashlet.id, await api.runDashlet(dash.id, dashlet.id)] as const));
        setResults(Object.fromEntries(entries));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : 'Failed to run dashlets.');
      }
    },
    [message],
  );

  const refresh = useCallback(async () => {
    const list = await load();
    const current = list.find((item) => item.id === activeId) ?? list[0];
    if (current && current.dashlets.length > 0) await runAll(current);
  }, [activeId, load, runAll]);

  useEffect(() => {
    setResults({});
    if (active && active.dashlets.length > 0) void runAll(active);
  }, [active?.id]);

  const runOne = useCallback(
    async (dashletId: string) => {
      if (!active) return;
      try {
        const ran = await api.runDashlet(active.id, dashletId);
        setResults((prev) => ({ ...prev, [dashletId]: ran }));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : 'Failed to run dashlet.');
      }
    },
    [active, message],
  );

  const submitDashboard = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const created = await api.createDashboard({ name: String(values.name) });
      setDashboards((prev) => [...prev, created]);
      setActiveId(created.id);
      setCreateOpen(false);
      form.resetFields();
    } catch (error) {
      // A rejected validation never reaches the form when called from a modal footer.
      if (error instanceof Error) void message.error(error.message);
    }
  }, [form, message]);

  const submitDashlet = useCallback(async () => {
    if (!active) return;
    try {
      const values = await dashletForm.validateFields();
      const created = await api.createDashlet(active.id, {
        name: String(values.name),
        kind: String(values.kind),
        config: {
          entity: String(values.entity),
          maxSize: 25,
          ...(typeof values.groupBy === 'string' && values.groupBy !== '' ? { groupBy: values.groupBy } : {}),
          ...(typeof values.measure === 'string' && values.measure !== '' ? { measure: values.measure } : {}),
        },
      });
      await load();
      setDashletOpen(false);
      dashletForm.resetFields();
      const ran = await api.runDashlet(active.id, created.id);
      setResults((prev) => ({ ...prev, [created.id]: ran }));
    } catch (error) {
      if (error instanceof Error) void message.error(error.message);
    }
  }, [active, dashletForm, load, message]);

  const removeDashboard = useCallback(async () => {
    if (!active) return;
    try {
      await api.deleteDashboard(active.id);
      setResults({});
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to delete dashboard.');
    }
  }, [active, load, message]);

  const removeDashlet = useCallback(
    async (dashletId: string) => {
      if (!active) return;
      try {
        await api.deleteDashlet(active.id, dashletId);
        await load();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : 'Failed to delete dashlet.');
      }
    },
    [active, load, message],
  );

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">Dashboards</h1>
          <p className="lizant-page-sub">List, chart and KPI dashlets queried through the shared Query Engine.</p>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            New dashboard
          </Button>
        </Space>
      </div>
      <Space style={{ marginBottom: 16 }} wrap>
        {dashboards.map((item) => (
          <Button key={item.id} type={item.id === activeId ? 'primary' : 'default'} onClick={() => setActiveId(item.id)}>
            {item.name} ({item.dashlets.length})
          </Button>
        ))}
      </Space>
      {active ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <Button icon={<PlusOutlined />} onClick={() => setDashletOpen(true)}>
              Add dashlet
            </Button>
            <Popconfirm
              title={`Delete dashboard "${active.name}" and its dashlets?`}
              onConfirm={() => void removeDashboard()}
              okText="Delete"
            >
              <Button danger icon={<DeleteOutlined />} style={{ marginLeft: 8 }}>
                Delete dashboard
              </Button>
            </Popconfirm>
          </div>
          <Row gutter={[16, 16]}>
            {active.dashlets.map((dashlet) => (
              <Col key={dashlet.id} xs={24} lg={12}>
                <Card
                  className="lizant-card"
                  title={`${dashlet.name} · ${dashlet.kind}`}
                  extra={
                    <Space>
                      <Button size="small" onClick={() => void runOne(dashlet.id)}>
                        Run
                      </Button>
                      <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => void removeDashlet(dashlet.id)} />
                    </Space>
                  }
                >
                  <DashletResult dashlet={dashlet} result={results[dashlet.id]} />
                </Card>
              </Col>
            ))}
          </Row>
        </>
      ) : (
        <Card className="lizant-card">No dashboards yet.</Card>
      )}
      <Modal
        title="New dashboard"
        open={createOpen}
        onOk={() => void submitDashboard()}
        onCancel={() => setCreateOpen(false)}
        okText="Create"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="Sales overview" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="Add dashlet"
        open={dashletOpen}
        onOk={() => void submitDashlet()}
        onCancel={() => setDashletOpen(false)}
        okText="Add"
      >
        <Form form={dashletForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]} initialValue="list">
            <Select options={[{ value: 'list', label: 'List' }, { value: 'chart', label: 'Chart' }, { value: 'kpi', label: 'KPI' }]} />
          </Form.Item>
          <Form.Item name="entity" label="Entity" rules={[{ required: true }]}>
            <Select options={entities} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="groupBy" label="Group by (chart / grouped KPI)">
            <Input placeholder="type" />
          </Form.Item>
          <Form.Item name="measure" label="Measure (numeric field, with sum/avg aggregation)">
            <Input placeholder="amount" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
