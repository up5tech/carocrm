import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type { PortalDashboardRow, PortalNavItemRow, PortalRoleRow, PortalRow } from '../api/types.js';
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
    } catch (e) { void message.error(e instanceof Error ? e.message : 'Could not load portals.'); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  if (principal?.type !== 'admin') return <Alert type="error" message="Administrator access is required to manage portals." />;
  return (
    <>
      <div className="lizant-page-head"><div><h1 className="lizant-page-title">Portals</h1>
      <p className="lizant-page-sub">External apps portal users sign in to. Roles, nav and dashboards are scoped to the selected portal.</p></div>
      <Space wrap><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>Refresh</Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>New portal</Button></Space></div>
      <Card className="lizant-card" title="Portals">
        <Table<PortalRow> rowKey="id" size="small" loading={loading} dataSource={portals} pagination={false}
          onRow={(r) => ({ onClick: () => setActiveId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'URL path', dataIndex: 'urlPath' },
            { title: 'Users', dataIndex: 'userCount', width: 80 },
            { title: 'Active', dataIndex: 'isActive', width: 90, render: (v: boolean, row) => (
              <Switch size="small" checked={v} aria-label={'Toggle ' + row.name} onClick={(_, e) => e.stopPropagation()}
                onChange={async (c) => { try { await api.updatePortal(row.id, { isActive: c }); await load(); }
                  catch (e) { void message.error(e instanceof Error ? e.message : 'Update failed.'); } }} /> ) },
            { title: '', width: 110, render: (_: unknown, row: PortalRow) => (
              <Popconfirm title={'Delete ' + row.name + '?'} description="Portals with users cannot be deleted."
                onConfirm={() => void (async () => { try { await api.deletePortal(row.id); await load(); }
                  catch (e) { void message.error(e instanceof Error ? e.message : 'Delete failed.'); } })()} okText="Delete">
                <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()}>Delete</Button>
              </Popconfirm> ) },
          ]} />
      </Card>
      {active ? (
        <Card className="lizant-card" title={'Portal: ' + active.name} style={{ marginTop: 16 }}>
          <Tabs defaultActiveKey="roles" items={[
            { key: 'roles', label: 'Roles', children: <RolesTab portal={active} /> },
            { key: 'navigation', label: 'Navigation', children: <NavTab portal={active} /> },
            { key: 'dashboards', label: 'Dashboards', children: <DashboardsTab portal={active} /> },
          ]} />
        </Card>
      ) : <Card className="lizant-card" style={{ marginTop: 16 }}><Typography.Text type="secondary">Select a portal above.</Typography.Text></Card>}
      <Modal title="Create portal" open={open} onCancel={() => setOpen(false)}
        onOk={() => void (async () => { const v = await form.validateFields();
          try { const c = await api.createPortal({ name: v.name, ...(v.urlPath ? { urlPath: v.urlPath } : {}) });
            void message.success('Portal "' + c.name + '" created.'); setOpen(false); form.resetFields(); await load(); setActiveId(c.id); }
          catch (e) { void message.error(e instanceof Error ? e.message : 'Create failed.'); } })()}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input placeholder="Customer Portal" /></Form.Item>
          <Form.Item name="urlPath" label="URL path" rules={[{ pattern: /^\/[A-Za-z0-9/_-]*$/, message: 'Must start with "/".' }]}>
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
    catch (e) { void message.error(e instanceof Error ? e.message : 'Could not load roles.'); } }, [message]);
  useEffect(() => { setSelected(portal.portalRoleIds); }, [portal.id, portal.portalRoleIds]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">Portal roles are a separate role space (PLAN 37). Linked roles apply to every user of this portal.</Typography.Paragraph>
      <Table<PortalRoleRow> rowKey="id" size="small" dataSource={roles} pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[{ title: 'Role', dataIndex: 'name' },
          { title: 'Linked', key: 'linked', width: 100, render: (_: unknown, row: PortalRoleRow) => (
            <Switch size="small" checked={selected.includes(row.id)} aria-label={'Link ' + row.name}
              onChange={async (c) => { const next = c ? [...selected, row.id] : selected.filter((id) => id !== row.id);
                setSelected(next);
                try { await api.setPortalRoles(portal.id, next); void message.success('Portal roles updated.'); }
                catch (e) { void message.error(e instanceof Error ? e.message : 'Update failed.'); } }} /> ) }]} />
    </Space>
  );
}
function NavTab({ portal }: { portal: PortalRow }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<PortalNavItemRow[]>([]);
  const load = useCallback(async () => { try { setItems(await api.portalNavItems(portal.id)); }
    catch (e) { void message.error(e instanceof Error ? e.message : 'Could not load navigation.'); } }, [message, portal.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Table<PortalNavItemRow> rowKey="id" size="small" dataSource={items} pagination={false}
      columns={[{ title: 'Label', dataIndex: 'label' },
        { title: 'Entity', dataIndex: 'entity', render: (v: string | null) => v ?? '---' },
        { title: 'Route', dataIndex: 'route', render: (v: string | null) => v ?? '---' },
        { title: 'Position', dataIndex: 'position', width: 90 }]} />
  );
}
function DashboardsTab({ portal }: { portal: PortalRow }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<PortalDashboardRow[]>([]);
  const load = useCallback(async () => { try { setRows(await api.portalDashboards(portal.id)); }
    catch (e) { void message.error(e instanceof Error ? e.message : 'Could not load dashboards.'); } }, [message, portal.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Table<PortalDashboardRow> rowKey="id" size="small" dataSource={rows} pagination={false}
      expandable={{ expandedRowRender: (r) => (
        <Space direction="vertical" style={{ width: '100%' }}>
          {r.dashlets.map((d) => <Typography.Text key={d.id}>{d.name} ({d.kind})</Typography.Text>)}
          {r.dashlets.length === 0 ? <Typography.Text type="secondary">No dashlets yet.</Typography.Text> : null}
        </Space> ) }}
      columns={[{ title: 'Dashboard', dataIndex: 'name' },
        { title: 'Default', dataIndex: 'isDefault', width: 90, render: (v: boolean) => (v ? 'yes' : '---') },
        { title: 'Dashlets', key: 'n', width: 90, render: (_: unknown, r: PortalDashboardRow) => String(r.dashlets.length) }]} />
  );
}
