import { AppstoreOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, StarOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Checkbox, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type DashboardRow } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { usePreference } from '../state/preferences.js';
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
  const dashletKind = Form.useWatch('kind', dashletForm);

  const entities = navEntities(metadata.data, principal?.type).map((entity) => ({ value: entity.name, label: entity.label }));
  const active = dashboards.find((item) => item.id === activeId) ?? null;
  // §20.10: the dashboard the user starred opens first, on every device — until they pick another one
  // themselves, which this ref records so the preference never fights an explicit choice.
  const defaultDashboard = usePreference<string | null>('defaultDashboard');
  const chosenManually = useRef(false);
  useEffect(() => {
    if (chosenManually.current) return;
    const preferred = defaultDashboard.value;
    // Priority: user-starred > role-scoped default > first dashboard
    if (preferred !== null && preferred !== undefined && dashboards.some((item) => item.id === preferred)) {
      setActiveId(preferred);
      return;
    }
    // Role-scoped default: find a dashboard whose roleScoped matches one of the user's roles
    const roles = principal?.roles;
    if (roles && roles.length > 0 && dashboards.length > 0) {
      const roleDefault = dashboards.find((d) => d.roleScoped !== null && d.roleScoped !== undefined && roles.includes(d.roleScoped));
      if (roleDefault) {
        setActiveId(roleDefault.id);
        return;
      }
    }
    // Fallback: first shared or personal dashboard
    const first = dashboards[0];
    if (!activeId && first !== undefined) setActiveId(first.id);
  }, [defaultDashboard.value, dashboards, principal, activeId]);

  const load = useCallback(async (): Promise<DashboardRow[]> => {
    setLoading(true);
    try {
      const list = await api.dashboards();
      setDashboards(list);
      setActiveId((prev) => (list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? null)));
      return list;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.dashboards.loadFailed'));
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
        void message.error(error instanceof Error ? error.message : t('web.dashboards.runFailed'));
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
        void message.error(error instanceof Error ? error.message : t('web.dashboards.runOneFailed'));
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
      const kind = String(values.kind);
      // The Project Task dashlet is configured by its own options, not by an entity + filter pair
      // (PLAN_Phase_19_Projects.md §4.16).
      const config =
        kind === 'projectTasks'
          ? {
              entity: 'ProjectTask',
              nextDays: Number(values.nextDays ?? 14),
              includeOwned: values.includeOwned === true,
              includeCollaboration: values.includeCollaboration === true,
              excludeAssigned: values.excludeAssigned === true,
              includeCompleted: values.includeCompleted === true,
              groupTypes: Array.isArray(values.groupTypes) ? values.groupTypes : [],
              maxSize: Number(values.maxSize ?? 20),
            }
          : {
              entity: String(values.entity),
              maxSize: 25,
              ...(typeof values.groupBy === 'string' && values.groupBy !== '' ? { groupBy: values.groupBy } : {}),
              ...(typeof values.measure === 'string' && values.measure !== '' ? { measure: values.measure } : {}),
            };
      const created = await api.createDashlet(active.id, { name: String(values.name), kind, config });
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
      // A default that points at a deleted dashboard would be dead weight on every device.
      if (defaultDashboard.value === active.id) defaultDashboard.save(null);
      setResults({});
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.dashboards.deleteFailed'));
    }
  }, [active, defaultDashboard, load, message]);

  const removeDashlet = useCallback(
    async (dashletId: string) => {
      if (!active) return;
      try {
        await api.deleteDashlet(active.id, dashletId);
        await load();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.dashboards.deleteDashletFailed'));
      }
    },
    [active, load, message],
  );

  return (
    <>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.dashboards.title')}</h1>
          <p className="carocrm-page-sub">{t('web.dashboards.subtitle')}</p>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
            {t('core.common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('web.dashboards.new')}
          </Button>
        </Space>
      </div>
      {dashboards.length > 0 ? (
        <Select
          className="carocrm-dashboard-picker"
          value={activeId}
          onChange={(value: string) => {
            chosenManually.current = true;
            setActiveId(value);
          }}
          options={dashboards.map((item) => ({ value: item.id, label: `${item.name} (${item.dashlets.length})` }))}
          placeholder={t('web.dashboards.pick')}
          showSearch
          optionFilterProp="label"
          suffixIcon={<AppstoreOutlined />}
        />
      ) : null}
      {active ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <Button icon={<PlusOutlined />} onClick={() => setDashletOpen(true)}>
              {t('web.dashboards.addDashlet')}
            </Button>
            <Button
              type={defaultDashboard.value === active.id ? 'primary' : 'default'}
              icon={<StarOutlined />}
              style={{ marginLeft: 8 }}
              aria-label={t('web.dashboards.defaultAria', { name: active.name })}
              onClick={() => defaultDashboard.save(defaultDashboard.value === active.id ? null : active.id)}
            >
              {defaultDashboard.value === active.id ? t('web.dashboards.isDefault') : t('web.dashboards.makeDefault')}
            </Button>
            <Popconfirm
              title={t('web.dashboards.deleteConfirm', { name: active.name })}
              onConfirm={() => void removeDashboard()}
              okText={t('web.common.delete')}
            >
              <Button danger icon={<DeleteOutlined />} style={{ marginLeft: 8 }}>
                {t('web.dashboards.deleteDashboard')}
              </Button>
            </Popconfirm>
          </div>
          <Row gutter={[16, 16]}>
            {active.dashlets.map((dashlet) => (
              <Col key={dashlet.id} xs={24} lg={12}>
                <Card
                  className="carocrm-card"
                  title={`${dashlet.name} · ${dashlet.kind}`}
                  extra={
                    <Space>
                      <Button size="small" onClick={() => void runOne(dashlet.id)}>
                        {t('web.common.run')}
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
        <EmptyState title={t('web.dashboards.empty')} />
      )}
      <Modal
        title={t('web.dashboards.new')}
        open={createOpen}
        onOk={() => void submitDashboard()}
        onCancel={() => setCreateOpen(false)}
        okText={t('web.common.create')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input placeholder={t('web.dashboards.namePlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('web.dashboards.addDashlet')}
        open={dashletOpen}
        onOk={() => void submitDashlet()}
        onCancel={() => setDashletOpen(false)}
        okText={t('web.common.add')}
      >
        <Form form={dashletForm} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label={t('web.dashboards.kindLabel')} rules={[{ required: true }]} initialValue="list">
            <Select
              options={[
                { value: 'list', label: t('web.reports.kindList') },
                { value: 'chart', label: t('web.reports.kindChart') },
                { value: 'kpi', label: t('web.reports.kindKpi') },
                { value: 'projectTasks', label: t('web.dashboards.kindProjectTasks') },
              ]}
            />
          </Form.Item>
          <Form.Item name="entity" label={t('web.reports.entityLabel')} rules={[{ required: dashletKind !== 'projectTasks' }]}>
            <Select options={entities} showSearch optionFilterProp="label" disabled={dashletKind === 'projectTasks'} />
          </Form.Item>
          {dashletKind === 'projectTasks' ? (
            <>
              <Form.Item name="nextDays" label={t('web.dashboards.dueWithin')} initialValue={14}>
                <InputNumber min={1} max={365} />
              </Form.Item>
              <Form.Item name="maxSize" label={t('web.dashboards.rows')} initialValue={20}>
                <InputNumber min={1} max={100} />
              </Form.Item>
              <Form.Item name="groupTypes" label={t('web.dashboards.groupTypes')}>
                <Select mode="multiple" options={['Triage', 'Backlog', 'Work', 'Phase', 'Sprint'].map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Space wrap>
                <Form.Item name="includeOwned" valuePropName="checked" initialValue={true}>
                  <Checkbox>{t('web.dashboards.ownedByMe')}</Checkbox>
                </Form.Item>
                <Form.Item name="includeCollaboration" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.sharedWithMe')}</Checkbox>
                </Form.Item>
                <Form.Item name="excludeAssigned" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.excludeAssigned')}</Checkbox>
                </Form.Item>
                <Form.Item name="includeCompleted" valuePropName="checked">
                  <Checkbox>{t('web.dashboards.includeCompleted')}</Checkbox>
                </Form.Item>
              </Space>
            </>
          ) : null}
          <Form.Item name="groupBy" label={t('web.dashboards.groupByLabel')}>
            <Input placeholder={t('web.dashboards.groupByPlaceholder')} />
          </Form.Item>
          <Form.Item name="measure" label={t('web.dashboards.measureLabel')}>
            <Input placeholder={t('web.dashboards.measurePlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
