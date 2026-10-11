import { AppstoreOutlined, CalendarOutlined, DatabaseOutlined, FileSearchOutlined, KeyOutlined, MenuFoldOutlined, MenuUnfoldOutlined, NotificationOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { App as AntApp, Dropdown, Input, Layout, Menu } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

const { Sider, Content, Footer } = Layout;

type MenuItems = Required<MenuProps>['items'];

export function AppShell({ children }: { children: ReactNode }) {
  const { principal, signOut } = useSession();
  const metadata = useMetadata();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [collapsed, setCollapsed] = useState(false);

  const navItems = useMemo<MenuItems>(() => {
    const groups: MenuItems = [{ key: '/home', icon: <AppstoreOutlined />, label: <Link to="/home">Home</Link> }];
    groups.push({ key: '/stream', icon: <NotificationOutlined />, label: <Link to="/stream">Stream</Link> });
    groups.push({ key: '/calendar', icon: <CalendarOutlined />, label: <Link to="/calendar">Calendar</Link> });

    const records: MenuItems = navEntities(metadata.data, principal?.type).map((entity) => ({
      key: `/${entity.name}`,
      icon: <DatabaseOutlined />,
      label: <Link to={`/${entity.name}`}>{entity.label}</Link>,
    }));
    if (records.length > 0) groups.push({ type: 'group', key: 'grp-records', label: 'Records', children: records });

    const admin: MenuItems = [{ key: '/admin/entity-manager', icon: <KeyOutlined />, label: <Link to="/admin/entity-manager">Entity Manager</Link> }];
    if (principal?.type === 'admin') {
      admin.push({ key: '/admin/audit-log', icon: <FileSearchOutlined />, label: <Link to="/admin/audit-log">Audit Log</Link> });
    }
    groups.push({ type: 'group', key: 'grp-admin', label: 'Administration', children: admin });
    return groups;
  }, [metadata.data, principal?.type]);

  const selectedKey = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/home';
    if (segments[0] === 'admin') return `/${segments.slice(0, 2).join('/')}`;
    return `/${segments[0]}`;
  }, [location.pathname]);

  const userMenu: MenuItems = [
    {
      key: 'signout',
      label: 'Sign out',
      onClick: async () => {
        await signOut();
        void message.success('Signed out.');
        navigate('/login', { replace: true });
      },
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header className="lizant-header">
        <div className={`lizant-brand${collapsed ? ' lizant-brand--compact' : ''}`} title="CaroCRM">
          <span className="lizant-brand-mark">C</span>
          {collapsed ? null : <span>CaroCRM</span>}
        </div>
        <span
          role="button"
          tabIndex={0}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="lizant-collapse-toggle"
          onClick={() => setCollapsed((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setCollapsed((value) => !value);
          }}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </span>
        <Input className="lizant-header-search" prefix={<SearchOutlined />} placeholder="Search records" variant="filled" />
        <div className="lizant-header-actions">
          <Dropdown menu={{ items: userMenu }} trigger={['click']}>
            <span className="lizant-avatar" title={principal?.userName}>
              {(principal?.userName ?? '?').slice(0, 2).toUpperCase()}
            </span>
          </Dropdown>
        </div>
      </header>
      <Layout>
        <Sider
          className="lizant-sider"
          width={260}
          collapsedWidth={72}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
        >
          <div className="lizant-sider-scroll">
            <Menu mode="inline" items={navItems} selectedKeys={[selectedKey]} />
          </div>
        </Sider>
        <Layout>
          <Content className="lizant-content">{children}</Content>
          <Footer className="lizant-footer">CaroCRM ©{new Date().getFullYear()} — metadata-driven CRM kernel</Footer>
        </Layout>
      </Layout>
    </Layout>
  );
}
