import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type { PortalDashboardRow, PortalNavItemRow, PortalRoleRow, PortalRow } from '../api/types.js';
import { t } from '../state/i18n.js';
import { useSession } from '../state/session.js';
/** Portal administration (PLAN 37, Phase 18). Admin-only; record visibility is server-enforced. */
export function AdminPortalsPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const [portals, setPortals] = useState<PortalRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; urlPath?: string }>();
  const active = useMemo(() => portals.find((p) => p.id === activeId) ?? null, [portals, activeId]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.portals();
      setPortals(rows);
      setActiveId((prev) => (rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)));
    } catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.loadFailed')); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  if (principal?.type !== 'admin') return <Alert type="error" message={t('web.admin.accessRequiredPortals')} />;
  return (
    <>
      <div className="lizant-page-head"><div><h1 className="lizant-page-title">{t('web.adminPortals.title')}</h1>
      <p className="lizant-page-sub">{t('web.adminPortals.subtitle')}</p></div>
      <Space wrap><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('core.common.refresh')}</Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>{t('web.adminPortals.new')}</Button></Space></div>
      <Card className="lizant-card" title={t('web.adminPortals.cardTitle')}>
        <Table<PortalRow> rowKey="id" size="small" loading={loading} dataSource={portals} pagination={false}
          onRow={(r) => ({ onClick: () => setActiveId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: t('web.common.name'), dataIndex: 'name' },
            { title: t('web.adminPortals.urlPath'), dataIndex: 'urlPath' },
            { title: t('web.adminPortals.users'), dataIndex: 'userCount', width: 80 },
            { title: t('web.adminPortals.active'), dataIndex: 'isActive', width: 90, render: (v: boolean, row) => (
              <Switch size="small" checked={v} aria-label={t('web.adminPortals.toggleAria', { name: row.name })} onClick={(_, e) => e.stopPropagation()}
                onChange={async (c) => { try { await api.updatePortal(row.id, { isActive: c }); await load(); }
                  catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.updateFailed')); } }} /> ) },
            { title: '', width: 110, render: (_: unknown, row: PortalRow) => (
              <Popconfirm title={t('web.adminPortals.deleteConfirm', { name: row.name })} description={t('web.adminPortals.deleteHint')}
                onConfirm={() => void (async () => { try { await api.deletePortal(row.id); await load(); }
                  catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.deleteFailed')); } })()} okText={t('web.common.delete')}>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()}>{t('web.common.delete')}</Button>
              </Popconfirm> ) },
          ]} />
      </Card>
      {active ? (
        <Card className="lizant-card" title={t('web.adminPortals.portalTitle', { name: active.name })} style={{ marginTop: 16 }}>
          <Tabs defaultActiveKey="roles" items={[
            { key: 'roles', label: t('web.adminPortals.tabRoles'), children: <RolesTab portal={active} /> },
            { key: 'navigation', label: t('web.adminPortals.tabNavigation'), children: <NavTab portal={active} /> },
            { key: 'dashboards', label: t('web.dashboards.title'), children: <DashboardsTab portal={active} /> },
          ]} />
        </Card>
      ) : <Card className="lizant-card" style={{ marginTop: 16 }}><Typography.Text type="secondary">{t('web.adminPortals.selectPortal')}</Typography.Text></Card>}
      <Modal title={t('web.adminPortals.createTitle')} open={open} onCancel={() => setOpen(false)}
        onOk={() => void (async () => { const v = await form.validateFields();
          try { const c = await api.createPortal({ name: v.name, ...(v.urlPath ? { urlPath: v.urlPath } : {}) });
            void message.success(t('web.adminPortals.created', { name: c.name })); setOpen(false); form.resetFields(); await load(); setActiveId(c.id); }
          catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.createFailed')); } })()}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('web.common.name')} rules={[{ required: true }]}><Input placeholder={t('web.adminPortals.namePlaceholder')} /></Form.Item>
          <Form.Item name="urlPath" label={t('web.adminPortals.urlPath')} rules={[{ pattern: /^\/[A-Za-z0-9/_-]*$/, message: t('web.adminPortals.urlPathInvalid') }]}>
            <Input placeholder="/portal" /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
function RolesTab({ portal }: { portal: PortalRow }) {
  const { message } = AntApp.useApp();
  const [roles, setRoles] = useState<PortalRoleRow[]>([]);
  const [selected, setSelected] = useState<string[]>(portal.portalRoleIds);
  const load = useCallback(async () => { try { setRoles(await api.portalRoles()); }
    catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.rolesLoadFailed')); } }, [message]);
  useEffect(() => { setSelected(portal.portalRoleIds); }, [portal.id, portal.portalRoleIds]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">{t('web.adminPortals.rolesHint')}</Typography.Paragraph>
      <Table<PortalRoleRow> rowKey="id" size="small" dataSource={roles} pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[{ title: t('web.adminPortals.role'), dataIndex: 'name' },
          { title: t('web.adminPortals.linked'), key: 'linked', width: 100, render: (_: unknown, row: PortalRoleRow) => (
            <Switch size="small" checked={selected.includes(row.id)} aria-label={t('web.adminPortals.linkAria', { name: row.name })}
              onChange={async (c) => { const next = c ? [...selected, row.id] : selected.filter((id) => id !== row.id);
                setSelected(next);
                try { await api.setPortalRoles(portal.id, next); void message.success(t('web.adminPortals.rolesUpdated')); }
                catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.updateFailed')); } }} /> ) }]} />
    </Space>
  );
}
function NavTab({ portal }: { portal: PortalRow }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<PortalNavItemRow[]>([]);
  const load = useCallback(async () => { try { setItems(await api.portalNavItems(portal.id)); }
    catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.navLoadFailed')); } }, [message, portal.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Table<PortalNavItemRow> rowKey="id" size="small" dataSource={items} pagination={false}
      columns={[{ title: t('web.adminPortals.label'), dataIndex: 'label' },
        { title: t('web.reports.entityLabel'), dataIndex: 'entity', render: (v: string | null) => v ?? '---' },
        { title: t('web.adminPortals.route'), dataIndex: 'route', render: (v: string | null) => v ?? '---' },
        { title: t('web.adminPortals.position'), dataIndex: 'position', width: 90 }]} />
  );
}
function DashboardsTab({ portal }: { portal: PortalRow }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<PortalDashboardRow[]>([]);
  const load = useCallback(async () => { try { setRows(await api.portalDashboards(portal.id)); }
    catch (e) { void message.error(e instanceof Error ? e.message : t('web.adminPortals.dashboardsLoadFailed')); } }, [message, portal.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Table<PortalDashboardRow> rowKey="id" size="small" dataSource={rows} pagination={false}
      expandable={{ expandedRowRender: (r) => (
        <Space direction="vertical" style={{ width: '100%' }}>
          {r.dashlets.map((d) => <Typography.Text key={d.id}>{d.name} ({d.kind})</Typography.Text>)}
          {r.dashlets.length === 0 ? <Typography.Text type="secondary">{t('web.adminPortals.noDashlets')}</Typography.Text> : null}
        </Space> ) }}
      columns={[{ title: t('web.adminPortals.dashboard'), dataIndex: 'name' },
        { title: t('web.adminPortals.default'), dataIndex: 'isDefault', width: 90, render: (v: boolean) => (v ? 'yes' : '---') },
        { title: t('web.adminPortals.dashlets'), key: 'n', width: 90, render: (_: unknown, r: PortalDashboardRow) => String(r.dashlets.length) }]} />
  );
}
