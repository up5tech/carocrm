import { ApartmentOutlined, ApiOutlined, AppstoreOutlined, BarChartOutlined, CalendarOutlined, CarryOutOutlined, DashboardOutlined, DatabaseOutlined, FileSearchOutlined, KeyOutlined, MenuFoldOutlined, MenuUnfoldOutlined, NotificationOutlined, ProjectOutlined, SearchOutlined, SettingOutlined, ShareAltOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { App as AntApp, Dropdown, Input, Layout, Menu } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { useExtensionNav } from '../state/extensions.js';
import { activateLocale, activeLocaleName, localesEnabled, t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { portalBase, usePortalContext } from '../state/portal.js';
import { useSession } from '../state/session.js';
import { DEFAULT_BRAND, useSettings } from '../state/settings.js';
import { entityIcon } from './entityIcons.js';

const { Sider, Content, Footer } = Layout;

/** Phase 7A (PLAN §41.5): the signed-in user switches UI language right from the avatar menu. */
function useLanguageSwitch() {
  const { message } = AntApp.useApp();
  return (locale: string) => {
    void (async () => {
      try {
        await api.patchMyProfile({ locale });
        window.localStorage.setItem('carocrm.locale', locale);
        await activateLocale(locale);
        void message.success(t('web.language.switched'));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.language.changeFailed'));
      }
    })();
  };
}

type MenuItems = Required<MenuProps>['items'];

/**
 * Icons an extension may name in `manifest.frontend.nav[].icon`.
 *
 * The SPA resolves them from this fixed set — a package ships data, never remote code, so a
 * manifest can add a menu entry but cannot make the browser execute or fetch anything.
 */
const EXTENSION_ICONS: Record<string, ReactNode> = {
  ApiOutlined: <ApiOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  ProjectOutlined: <ProjectOutlined />,
  ThunderboltOutlined: <ThunderboltOutlined />,
};

/**
 * Shell selector (PLAN §37): portal users get the portal chrome, everyone else the internal
 * one. The user type resolves asynchronously (`/AppUser/me`), so the branch lives in its own
 * component instead of an early return inside a hook-using render.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { principal } = useSession();
  if (principal?.type === 'portal') return <PortalShell>{children}</PortalShell>;
  return <InternalShell>{children}</InternalShell>;
}

function InternalShell({ children }: { children: ReactNode }) {
  const { principal, signOut } = useSession();
  const settings = useSettings();
  const metadata = useMetadata();
  const extensionNav = useExtensionNav();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [collapsed, setCollapsed] = useState(false);

  // The menu labels are translated at build time, so the memo has to be keyed on the locale —
  // otherwise switching language would repaint the page but leave the sidebar in the old one.
  const locale = activeLocaleName();

  const navItems = useMemo<MenuItems>(() => {
    const groups: MenuItems = [{ key: '/home', icon: <AppstoreOutlined />, label: <Link to="/home">{t('core.app.home')}</Link> }];
    groups.push({ key: '/search', icon: <SearchOutlined />, label: <Link to="/search">{t('core.app.search')}</Link> });
    groups.push({ key: '/dashboards', icon: <DashboardOutlined />, label: <Link to="/dashboards">{t('core.app.dashboards')}</Link> });
    groups.push({ key: '/reports', icon: <BarChartOutlined />, label: <Link to="/reports">{t('core.app.reports')}</Link> });
    groups.push({ key: '/stream', icon: <NotificationOutlined />, label: <Link to="/stream">{t('core.app.stream')}</Link> });
    groups.push({ key: '/calendar', icon: <CalendarOutlined />, label: <Link to="/calendar">{t('core.app.calendar')}</Link> });
    groups.push({ key: '/tasks', icon: <CarryOutOutlined />, label: <Link to="/tasks">{t('core.app.myTasks')}</Link> });

    const recordItem = (entity: EntityDefinition): MenuItems[number] => ({
      key: `/${entity.name}`,
      icon: entityIcon(entity.icon, entity.name),
      label: <Link to={`/${entity.name}`}>{entity.label}</Link>,
    });
    // The Project entities form one submenu of their own instead of six entries in RECORDS; the
    // group is named after the Project entity so the metadata label stays the source of truth.
    const navList = navEntities(metadata.data, principal?.type);
    const projectEntities = navList.filter((entity) => entity.name.startsWith('Project'));
    const records: MenuItems = navList
      .filter((entity) => !entity.name.startsWith('Project'))
      .map((entity) => recordItem(entity));
    if (projectEntities.length > 0) {
      const project = projectEntities.find((entity) => entity.name === 'Project');
      records.push({
        key: 'sub-project',
        icon: entityIcon(project?.icon, project?.name ?? 'Project'),
        label: project?.label ?? 'Project',
        children: projectEntities.map((entity) => recordItem(entity)),
      });
    }
    if (records.length > 0) groups.push({ type: 'group', key: 'grp-records', label: t('core.app.records'), children: records });

    // Entries contributed by installed extensions (PLAN §38). The server already filtered the ones
    // this user may not see, so the client renders them as-is.
    const contributed: MenuItems = (extensionNav.data?.nav ?? []).map((item) => ({
      key: item.route,
      icon: item.icon ? EXTENSION_ICONS[item.icon] ?? <DatabaseOutlined /> : <DatabaseOutlined />,
      label: <Link to={item.route}>{item.label}</Link>,
    }));
    if (contributed.length > 0) groups.push({ type: 'group', key: 'grp-extensions', label: t('core.app.extensions'), children: contributed });

    const admin: MenuItems = [{ key: '/admin/entity-manager', icon: <KeyOutlined />, label: <Link to="/admin/entity-manager">{t('web.entityManager.title')}</Link> }];
    if (principal?.type === 'admin') {
      admin.push({ key: '/admin/audit-log', icon: <FileSearchOutlined />, label: <Link to="/admin/audit-log">{t('web.adminAudit.title')}</Link> });
      admin.push({ key: '/admin/jobs', icon: <ThunderboltOutlined />, label: <Link to="/admin/jobs">{t('web.adminJobs.title')}</Link> });
      admin.push({ key: '/admin/extensions', icon: <ApiOutlined />, label: <Link to="/admin/extensions">{t('web.adminExtensions.title')}</Link> });
      admin.push({ key: '/admin/workflows', icon: <ApartmentOutlined />, label: <Link to="/admin/workflows">{t('web.workflows.title')}</Link> });
      admin.push({ key: '/admin/processes', icon: <ShareAltOutlined />, label: <Link to="/admin/processes">{t('web.processes.title')}</Link> });
      admin.push({ key: '/admin/settings', icon: <SettingOutlined />, label: <Link to="/admin/settings">{t('web.adminSettings.title')}</Link> });
    }
    admin.push({ key: '/admin/portals', icon: <ProjectOutlined />, label: <Link to="/admin/portals">{t('web.adminPortals.title')}</Link> });
    groups.push({ type: 'group', key: 'grp-admin', label: t('core.app.administration'), children: admin });
    return groups;
  }, [metadata.data, principal?.type, extensionNav.data, locale]);

  const selectedKey = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/home';
    if (segments[0] === 'admin') return `/${segments.slice(0, 2).join('/')}`;
    return `/${segments[0]}`;
  }, [location.pathname]);

  const switchLanguage = useLanguageSwitch();
  const languageMenu: MenuItems = localesEnabled().map((locale) => ({
    key: `lang:${locale}`,
    label: t(`web.language.${locale}`),
    onClick: () => switchLanguage(locale),
  }));
  const userMenu: MenuItems = [
    { key: 'profile', label: <Link to="/profile">{t('web.profile.title')}</Link> },
    { key: 'language', label: t('web.language.label'), children: languageMenu },
    {
      key: 'signout',
      label: t('core.app.signOut'),
      onClick: async () => {
        await signOut();
        void message.success(t('core.app.signedOut'));
        navigate('/login', { replace: true });
      },
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header className="lizant-header">
        <div className={`lizant-brand${collapsed ? ' lizant-brand--compact' : ''}`} title={settings.data?.pageTitle ?? DEFAULT_BRAND}>
          {settings.data?.logoUrl ? (
            <img className="lizant-brand-logo" src={settings.data.logoUrl} alt="" />
          ) : (
            <span className="lizant-brand-mark">C</span>
          )}
          {collapsed ? null : <span>{settings.data?.pageTitle ?? DEFAULT_BRAND}</span>}
        </div>
        <span
          role="button"
          tabIndex={0}
          aria-label={collapsed ? t('core.app.expandSidebar') : t('core.app.collapseSidebar')}
          className="lizant-collapse-toggle"
          onClick={() => setCollapsed((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setCollapsed((value) => !value);
          }}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </span>
        <Input
          className="lizant-header-search"
          prefix={<SearchOutlined />}
          placeholder={t('core.app.searchRecords')}
          variant="filled"
          onPressEnter={(event) => {
            const q = (event.target as HTMLInputElement).value.trim();
            if (q !== '') navigate(`/search?q=${encodeURIComponent(q)}`);
          }}
        />
        <div className="lizant-header-actions">
          <Dropdown menu={{ items: userMenu }} trigger={['click']}>
            <span className="lizant-avatar" title={principal?.userName}>
              {principal?.avatarId ? (
                <img className="lizant-avatar-img" src={`/api/v1/Attachment/${principal.avatarId}/file`} alt="" />
              ) : (
                (principal?.userName ?? '?').slice(0, 2).toUpperCase()
              )}
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
            <Menu
              mode="inline"
              items={navItems}
              selectedKeys={[selectedKey]}
              defaultOpenKeys={selectedKey.startsWith('/Project') ? ['sub-project'] : []}
            />
          </div>
        </Sider>
        <Layout>
          <Content className="lizant-content">{children}</Content>
          <Footer className="lizant-footer">
            {settings.data?.footerText ?? t('web.shell.footer', { year: String(new Date().getFullYear()) })}
          </Footer>
        </Layout>
      </Layout>
    </Layout>
  );
}

/**
 * Phase 18 portal shell (PLAN §37): the portal's own name and navigation only. Internal
 * entities appear solely when the portal's nav items name them, and every record read is
 * portal-ACL scoped server-side, so this chrome grants nothing by itself.
 */
function PortalShell({ children }: { children: ReactNode }) {
  const { principal, signOut } = useSession();
  const context = usePortalContext();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [collapsed, setCollapsed] = useState(false);
  const base = portalBase(principal?.type);
  // Same as the internal shell: the "Home" entry is translated, so the memo follows the locale.
  const locale = activeLocaleName();

  const navItems = useMemo<MenuItems>(() => {
    const items: MenuItems = [{ key: '/portal', icon: <AppstoreOutlined />, label: <Link to="/portal">{t('core.app.home')}</Link> }];
    for (const item of context.data?.nav ?? []) {
      items.push({
        key: item.route ?? (item.entity ? `${base}/${item.entity}` : '/portal'),
        icon: <DatabaseOutlined />,
        label: <Link to={item.entity ? `${base}/${item.entity}` : (item.route ?? base)}>{item.label}</Link>,
      });
    }
    return items;
  }, [context.data?.nav, base, locale]);

  const selectedKey = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length <= 1) return '/portal';
    return `/portal/${segments[1]}`;
  }, [location.pathname]);

  const userMenu: MenuItems = [
    {
      key: 'signout',
      label: t('core.app.signOut'),
      onClick: async () => {
        await signOut();
        void message.success(t('core.app.signedOut'));
        navigate('/login', { replace: true });
      },
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header className="lizant-header">
        <div className="lizant-brand" title={context.data?.portal.name ?? t('web.portal.portal')}>
          <span className="lizant-brand-mark">P</span>
          {context.data?.portal.name ?? t('web.portal.portal')}
        </div>
        <div className="lizant-header-actions">
          <Dropdown menu={{ items: userMenu }} trigger={['click']}>
            <span className="lizant-avatar" title={principal?.userName}>
              {principal?.avatarId ? (
                <img className="lizant-avatar-img" src={`/api/v1/Attachment/${principal.avatarId}/file`} alt="" />
              ) : (
                (principal?.userName ?? '?').slice(0, 2).toUpperCase()
              )}
            </span>
          </Dropdown>
        </div>
      </header>
      <Layout>
        <Sider
          className="lizant-sider"
          width={220}
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
          <Footer className="lizant-footer">{t('web.shell.portalFooter')}</Footer>
        </Layout>
      </Layout>
    </Layout>
  );
}
