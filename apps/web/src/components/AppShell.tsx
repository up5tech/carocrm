import { ApartmentOutlined, ApiOutlined, AppstoreOutlined, BarChartOutlined, CalendarOutlined, CarryOutOutlined, DashboardOutlined, DatabaseOutlined, FileSearchOutlined, KeyOutlined, MenuFoldOutlined, MenuUnfoldOutlined, NotificationOutlined, ProjectOutlined, SearchOutlined, SettingOutlined, ShareAltOutlined, ShoppingCartOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { App as AntApp, Dropdown, Input, Layout, Menu } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
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

/**
 * Phase 19-S.17 task 8 — the sidebar as a rail on desktop and a drawer on a phone.
 *
 * Below 768px the shell used to render the same fixed 260px-rail Sider, which left the content area
 * ~80px wide on a 390px screen (measured). Now the rail becomes an off-canvas drawer: fixed, fully
 * translated off-screen until the operator opens it, with the content taking the whole viewport.
 *
 * The two breakpoints get **two state variables on purpose**. `collapsed` is the desktop rail's, and
 * deriving the drawer from it (`!collapsed`) opens the drawer for one render when the viewport
 * crosses into narrow — a flash of a 260px panel over the screen. `drawerOpen` is its own,
 * initially-closed state, so a resize can never open it and only the header toggle (or a link, or
 * Escape) does.
 */
function useSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)');
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return { collapsed, setCollapsed, drawerOpen, setDrawerOpen, narrow };
}

function InternalShell({ children }: { children: ReactNode }) {
  const { principal, signOut } = useSession();
  const settings = useSettings();
  const metadata = useMetadata();
  const extensionNav = useExtensionNav();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { collapsed, setCollapsed, drawerOpen, setDrawerOpen, narrow } = useSidebar();

  // Phase 19-S.17 task 5 — the module-visibility signal. The Sales submenu is built from metadata the
  // browser has, so until now it appeared for every user; `GET /Sales/action/nav` answers from the
  // platform's own ACL whether this caller may read anything in the domain at all, and the group is
  // hidden when it does. Until the answer arrives the group is shown as it always was: hiding a menu
  // item is presentation, never the enforcement, which stays server-side.
  const [salesVisible, setSalesVisible] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .salesNavigation()
      .then((value) => {
        if (active) setSalesVisible(value.visible);
      })
      .catch(() => {
        // A module that refuses is a module the caller cannot see; showing the group as before is the
        // honest fallback rather than hiding navigation that the roles may well allow.
        if (active) setSalesVisible(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Phase 19-MA.1 — the same visibility signal for Marketing Automation. The group is built from the
  // metadata the browser already has, so without this every user would see campaign links that all answer
  // 403. Hiding the entry is presentation only; enforcement stays server-side.
  const [marketingVisible, setMarketingVisible] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .marketingNavigation()
      .then((value) => {
        if (active) setMarketingVisible(value.visible);
      })
      .catch(() => {
        if (active) setMarketingVisible(true);
      });
    return () => {
      active = false;
    };
  }, []);

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
    // Phase 19-S.17 — Sales groups its own entities under one submenu instead of scattering thirteen
    // entries across RECORDS, exactly the way Project does. The grouping is by **name sets over the
    // metadata the user may already navigate**, so nothing is added to the menu that the entity list
    // does not have, and a Sales entity renamed or hidden by metadata simply leaves the group instead
    // of leaving a dead entry. Every other record entity stays where it was.
    const salesGroups = SALES_NAV_GROUPS.map((group) => ({
      ...group,
      entities: group.entityNames
        .map((name) => navList.find((entity) => entity.name === name))
        .filter((entity): entity is EntityDefinition => entity !== undefined),
    })).filter((group) => group.entities.length > 0);
    const salesNames = new Set(salesGroups.flatMap((group) => group.entities.map((entity) => entity.name)));
    // Phase 19-MA.1 — Marketing gets one submenu of its own, the way Project does. Membership is resolved
    // from the navigable metadata by name, so an entity renamed or hidden by metadata leaves the group
    // instead of leaving a dead link; the module's evidence rows (TargetListEntry, CampaignTransition) are
    // not navigable at all, so they never appear here.
    const marketingEntities = MARKETING_NAV_NAMES
      .map((name) => navList.find((entity) => entity.name === name))
      .filter((entity): entity is EntityDefinition => entity !== undefined);
    const marketingNames = new Set(marketingEntities.map((entity) => entity.name));
    const records: MenuItems = navList
      .filter(
        (entity) =>
          !entity.name.startsWith('Project') && !salesNames.has(entity.name) && !marketingNames.has(entity.name),
      )
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
    if (salesGroups.length > 0 && salesVisible !== false) {
      records.push({
        key: 'sub-sales',
        icon: <ShoppingCartOutlined />,
        label: t('sales.nav.sales'),
        children: salesGroups.map((group) => ({
          key: `sub-sales-${group.key}`,
          label: t(`sales.nav.${group.key}`),
          children: group.entities.map((entity) => recordItem(entity)),
        })),
      });
    }
    if (marketingEntities.length > 0 && marketingVisible !== false) {
      records.push({
        key: 'sub-marketing',
        icon: <NotificationOutlined />,
        label: t('marketing.nav.marketing'),
        children: marketingEntities.map((entity) => recordItem(entity)),
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
  }, [metadata.data, principal?.type, extensionNav.data, salesVisible, locale]);

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

  // Navigating anywhere closes the drawer, so the link the operator picked is the screen they get.
  useEffect(() => {
    if (narrow) setDrawerOpen(false);
  }, [location.pathname, narrow, setDrawerOpen]);

  // Escape closes the drawer without a mouse - the same affordance the desktop rail has.
  useEffect(() => {
    if (!narrow || !drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [narrow, drawerOpen, setDrawerOpen]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header className="lizant-header">
        <div className={`lizant-brand${(narrow ? drawerOpen : collapsed) ? ' lizant-brand--compact' : ''}`} title={settings.data?.pageTitle ?? DEFAULT_BRAND}>
          {settings.data?.logoUrl ? (
            <img className="lizant-brand-logo" src={settings.data.logoUrl} alt="" />
          ) : (
            <span className="lizant-brand-mark">C</span>
          )}
          {(narrow ? drawerOpen : collapsed) ? null : <span>{settings.data?.pageTitle ?? DEFAULT_BRAND}</span>}
        </div>
        <span
          role="button"
          tabIndex={0}
          aria-label={(narrow ? drawerOpen : collapsed) ? t('core.app.expandSidebar') : t('core.app.collapseSidebar')}
          className="lizant-collapse-toggle"
          onClick={() => (narrow ? setDrawerOpen(!drawerOpen) : setCollapsed(!collapsed))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (narrow) setDrawerOpen(!drawerOpen);
              else setCollapsed(!collapsed);
            }
          }}
        >
          {(narrow ? drawerOpen : collapsed) ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
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
          className={`lizant-sider${narrow ? ` lizant-sider--drawer${drawerOpen ? ' is-open' : ''}` : ''}`}
          width={260}
          collapsedWidth={72}
          collapsible={!narrow}
          collapsed={collapsed && !narrow}
          onCollapse={(value: boolean) => {
            if (!narrow) setCollapsed(value);
          }}
          trigger={null}
        >
          <div className="lizant-sider-scroll">
            <Menu
              mode="inline"
              items={navItems}
              selectedKeys={[selectedKey]}
              defaultOpenKeys={selectedKey.startsWith('/Project') ? ['sub-project'] : []}
              onClick={() => {
                // Following a link closes the drawer; on desktop it does nothing.
                if (narrow) setDrawerOpen(false);
              }}
            />
          </div>
        </Sider>
        {narrow && drawerOpen ? (
          <div className="lizant-drawer-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
        ) : null}
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

/** The Sales submenu layout (19-S.17). Names are the metadata entity names; a name the installation
 *  does not navigate to is skipped, so the menu never offers a record the user cannot open. */
/**
 * Phase 19-MA.1 — the entities the Marketing submenu names. These are navigable records only; a campaign's
 * membership and history rows are read through the campaign itself (§9.2).
 */
const MARKETING_NAV_NAMES = ['Campaign', 'TargetList'] as const;

const SALES_NAV_GROUPS: readonly { key: string; entityNames: readonly string[] }[] = [
  { key: 'sales', entityNames: ['Quote', 'SalesOrder', 'Invoice', 'CreditNote', 'DeliveryOrder', 'ReturnOrder'] },
  { key: 'catalog', entityNames: ['Product', 'ProductCategory', 'PriceBook', 'PriceBookEntry', 'PriceRule', 'TaxClass', 'TaxCode', 'TaxRate', 'TaxRule'] },
  { key: 'payments', entityNames: ['Payment', 'PaymentMethod', 'PaymentChannel', 'PaymentTermProfile', 'PaymentRequest', 'WriteOff'] },
  { key: 'purchases', entityNames: ['Supplier', 'SupplierProductPrice', 'PurchaseOrder', 'ReceiptOrder', 'Bill', 'BillCredit'] },
  { key: 'inventory', entityNames: ['Warehouse', 'InventoryTransaction', 'InventoryAdjustment', 'InventoryReservation', 'TransferOrder', 'InventoryBatch', 'InventorySerial'] },
  { key: 'subscriptions', entityNames: ['Subscription', 'SubscriptionPeriod'] },
];
