import { AppstoreOutlined, DatabaseOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { App as AntApp, Dropdown, Input, Layout, Menu } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { NavigationNode } from '../api/types.js';
import { useNavigation } from '../state/admin.js';
import { useDocsSettings } from '../state/docs.js';
import { activateLocale, activeLocaleName, localesEnabled, t } from '../state/i18n.js';
import { portalBase, usePortalContext } from '../state/portal.js';
import { useSession } from '../state/session.js';
import { DEFAULT_BRAND, useSettings } from '../state/settings.js';
import { navAccent } from '../theme.js';
import { CommandPalette } from './CommandPalette.js';
import { CRMChatQuickAccess } from './CRMChatQuickAccess.js';
import { entityIcon, navGroupIcon, navIcon } from './entityIcons.js';
import { IncomingCallBanner } from './IncomingCallBanner.js';

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
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { collapsed, setCollapsed, drawerOpen, setDrawerOpen, narrow } = useSidebar();
  // Phase 20 (PLAN_Phase_20_Settings_UX.md §4.4): the menu is the tree the server resolved for this
  // caller — ACL-filtered, ordered and renamed by the Main Menu tab. The shell used to build it from
  // hard-coded name sets plus two per-module visibility probes; both are gone.
  const navigation = useNavigation();
  const tree = navigation.data?.items ?? [];
  // Labels are resolved for the request locale on the server, so switching language re-fetches the
  // tree instead of repainting the old one.
  const locale = activeLocaleName();

  // A direct hit on a deep URL (bookmark, link, refresh) must still show where the user is, so the
  // submenu that owns the selected entry opens on arrival. `defaultOpenKeys` cannot do this: antd
  // reads it once on mount, before the tree or the location is known.
  const [openKeys, setOpenKeys] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    if (navigation.data === undefined) return;
    setOpenKeys(ancestorKeys(navigation.data.items, selectedRoute(location.pathname)));
  }, [navigation.data, location.pathname]);

  const navItems = useMemo<MenuItems>(() => toMenuItems(tree), [tree, locale]);
  const selectedKey = selectedRoute(location.pathname);
  // The quick-chat button is only offered to a caller the server put the Chat workspace on the
  // menu for. The tree is already ACL-filtered and feature-gated, so the shell never re-decides.
  const chatAvailable = useMemo(() => hasRoute(tree, '/crm-chat'), [tree]);

  const switchLanguage = useLanguageSwitch();
  const languageMenu: MenuItems = localesEnabled().map((locale) => ({
    key: `lang:${locale}`,
    label: t(`web.language.${locale}`),
    onClick: () => switchLanguage(locale),
  }));
  // The handbook entry follows the instance's own switches: an organisation that moved its help to a
  // wiki gets a link to that wiki, and `showHelpMenu: false` takes the row away without a deploy.
  const docsSettings = useDocsSettings();
  const helpExternal = docsSettings.data?.value.externalUrl ?? null;
  const helpItem: MenuItems = docsSettings.data?.value.showHelpMenu === false
    ? []
    : [
        {
          key: 'help',
          label:
            helpExternal === null ? (
              <Link to="/docs">{t('web.docs.menuItem')}</Link>
            ) : (
              <a href={helpExternal} target="_blank" rel="noopener noreferrer">
                {t('web.docs.menuItem')}
              </a>
            ),
        },
      ];

  const userMenu: MenuItems = [
    { key: 'profile', label: <Link to="/profile">{t('web.profile.title')}</Link> },
    ...helpItem,
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
    <>
      {/* Phase 21 §5.9: the first focusable thing on any screen jumps past the header and the navigation to
          the content, so a keyboard reader is not forced through the whole sidebar to reach a page. */}
      <a className="carocrm-skip-link" href="#carocrm-content">
        {t('core.app.skipToContent')}
      </a>
      <CommandPalette />
      <Layout style={{ minHeight: '100vh' }}>
        <header className="carocrm-header">
          <div className={`carocrm-brand${(narrow ? drawerOpen : collapsed) ? ' carocrm-brand--compact' : ''}`} title={settings.data?.pageTitle ?? DEFAULT_BRAND}>
          {settings.data?.logoUrl ? (
            <img className="carocrm-brand-logo" src={settings.data.logoUrl} alt="" />
          ) : (
            <span className="carocrm-brand-mark">C</span>
          )}
          {(narrow ? drawerOpen : collapsed) ? null : <span>{settings.data?.pageTitle ?? DEFAULT_BRAND}</span>}
        </div>
        <span
          role="button"
          tabIndex={0}
          aria-label={(narrow ? drawerOpen : collapsed) ? t('core.app.expandSidebar') : t('core.app.collapseSidebar')}
          className="carocrm-collapse-toggle"
          onClick={() => (narrow ? setDrawerOpen(!drawerOpen) : setCollapsed(!collapsed))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              // Space would otherwise scroll the page behind the toggle.
              event.preventDefault();
              if (narrow) setDrawerOpen(!drawerOpen);
              else setCollapsed(!collapsed);
            }
          }}
        >
          {(narrow ? drawerOpen : collapsed) ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </span>
        <Input
          className="carocrm-header-search"
          prefix={<SearchOutlined />}
          placeholder={t('core.app.searchRecords')}
          variant="filled"
          onPressEnter={(event) => {
            const q = (event.target as HTMLInputElement).value.trim();
            if (q !== '') navigate(`/search?q=${encodeURIComponent(q)}`);
          }}
        />
        <div className="carocrm-header-actions">
          {chatAvailable ? <CRMChatQuickAccess compact={narrow} /> : null}
          <Dropdown menu={{ items: userMenu }} trigger={['click']}>
            <span className="carocrm-avatar" title={principal?.userName}>
              {principal?.avatarId ? (
                <img className="carocrm-avatar-img" src={`/api/v1/Attachment/${principal.avatarId}/file`} alt="" />
              ) : (
                (principal?.userName ?? '?').slice(0, 2).toUpperCase()
              )}
            </span>
          </Dropdown>
        </div>
      </header>
      <Layout>
        <Sider
          className={`carocrm-sider${narrow ? ` carocrm-sider--drawer${drawerOpen ? ' is-open' : ''}` : ''}`}
          width={260}
          collapsedWidth={72}
          collapsible={!narrow}
          collapsed={collapsed && !narrow}
          onCollapse={(value: boolean) => {
            if (!narrow) setCollapsed(value);
          }}
          trigger={null}
        >
          <div className="carocrm-sider-scroll">
            <Menu
              mode="inline"
              items={navItems}
              selectedKeys={[selectedKey]}
              openKeys={openKeys ?? []}
              onOpenChange={(keys) => setOpenKeys(keys.map(String))}
              onClick={() => {
                // Following a link closes the drawer; on desktop it does nothing.
                if (narrow) setDrawerOpen(false);
              }}
            />
          </div>
        </Sider>
        {narrow && drawerOpen ? (
          <div className="carocrm-drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        ) : null}
        <Layout>
          <Content id="carocrm-content" tabIndex={-1} className="carocrm-content">
            {/* Screen-reader announcements for moves that happen by keyboard in the settings tabs. */}
            <span id="carocrm-live-region" className="carocrm-live-region" role="status" aria-live="polite" />
            {/* Phase 19-VC.9: only the calls the server addressed to this user appear, and only here —
                the portal shell has no internal call surface at all. */}
            <IncomingCallBanner />
            {children}
          </Content>
          <Footer className="carocrm-footer">
            {settings.data?.footerText ?? t('web.shell.footer', { year: String(new Date().getFullYear()) })}
          </Footer>
        </Layout>
      </Layout>
    </Layout>
    </>
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
      <header className="carocrm-header">
        <div className="carocrm-brand" title={context.data?.portal.name ?? t('web.portal.portal')}>
          <span className="carocrm-brand-mark">P</span>
          {context.data?.portal.name ?? t('web.portal.portal')}
        </div>
        <div className="carocrm-header-actions">
          <Dropdown menu={{ items: userMenu }} trigger={['click']}>
            <span className="carocrm-avatar" title={principal?.userName}>
              {principal?.avatarId ? (
                <img className="carocrm-avatar-img" src={`/api/v1/Attachment/${principal.avatarId}/file`} alt="" />
              ) : (
                (principal?.userName ?? '?').slice(0, 2).toUpperCase()
              )}
            </span>
          </Dropdown>
        </div>
      </header>
      <Layout>
        <Sider
          className="carocrm-sider"
          width={220}
          collapsedWidth={72}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
        >
          <div className="carocrm-sider-scroll">
            <Menu mode="inline" items={navItems} selectedKeys={[selectedKey]} />
          </div>
        </Sider>
        <Layout>
          <Content className="carocrm-content">
            {/* Screen-reader announcements for moves that happen by keyboard in the settings tabs. */}
            <span id="carocrm-live-region" className="carocrm-live-region" role="status" aria-live="polite" />
            {children}
          </Content>
          <Footer className="carocrm-footer">{t('web.shell.portalFooter')}</Footer>
        </Layout>
      </Layout>
    </Layout>
  );
}

/**
 * The resolved navigation tree as antd menu items (PLAN_Phase_20 §4.4).
 *
 * A top-level group is a labelled menu group — the way the sidebar has always drawn RECORDS and
 * ADMINISTRATION — and a nested group is a submenu. Leaves link to the route the server gave them:
 * the shell never decides whether an entry exists, it renders what it was told. An accent tints the
 * label alongside the icon and the text, never replacing them (§5.8).
 */
function toMenuItems(nodes: readonly NavigationNode[], depth = 0): MenuItems {
  const items: MenuItems = [];
  for (const node of nodes) {
    const text = node.kind === 'entity' ? entityNavLabel(node) : node.label;
    const accent = node.accent === undefined ? undefined : navAccent(node.accent).fg;
    const label = accent === undefined ? text : <span style={{ color: accent }}>{text}</span>;
    if (node.kind === 'group') {
      const children = node.children === undefined ? [] : toMenuItems(node.children, depth + 1);
      if (depth === 0) items.push({ type: 'group', key: node.key, label, children });
      else items.push({ key: node.key, icon: navGroupIcon(node.key, node.icon), label, children });
      continue;
    }
    items.push({
      key: node.route,
      // An entity without an explicit metadata icon keeps its built-in mark instead of the
      // generic appstore fallback; an administrator's icon override still wins.
      icon:
        node.kind === 'entity'
          ? entityIcon(node.icon, node.key.startsWith('entity:') ? node.key.slice('entity:'.length) : undefined)
          : navIcon(node.icon),
      label: <Link to={node.route}>{text}</Link>,
    });
  }
  return items;
}

/** Whether the resolved menu really carries a route — the shell never invents one. */
function hasRoute(nodes: readonly NavigationNode[], route: string): boolean {
  for (const node of nodes) {
    if (node.route === route) return true;
    const children = node.children;
    if (children !== undefined && hasRoute(children, route)) return true;
  }
  return false;
}

/**
 * Inside the Customer Success group every entity repeats the group name, and the sidebar is too
 * narrow for the repeated prefix. The page/list titles keep the metadata label; only the menu leaf
 * is shortened.
 */
function entityNavLabel(node: NavigationNode): string {
  const prefix = 'Customer Success ';
  if (!node.key.startsWith('entity:CustomerSuccess') || !node.label.startsWith(prefix)) return node.label;
  return node.label.slice(prefix.length);
}

/** The route the current path selects: `/Contact/…` → `/Contact`, `/admin/jobs` → `/admin/jobs`. */
function selectedRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/home';
  if (segments[0] === 'admin') return `/${segments.slice(0, 2).join('/')}`;
  return `/${segments[0]}`;
}

/** Group keys on the path to a route, so the submenu that owns the selection opens. */
function ancestorKeys(nodes: readonly NavigationNode[], route: string, trail: string[] = []): string[] {
  for (const node of nodes) {
    if (node.route === route) return trail;
    const children = node.children;
    if (children === undefined) continue;
    const nested = ancestorKeys(children, route, node.kind === 'group' ? [...trail, node.key] : trail);
    if (nested.length > 0) return nested;
  }
  return [];
}
