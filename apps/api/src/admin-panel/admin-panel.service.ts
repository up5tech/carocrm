import { Inject, Injectable } from '@nestjs/common';

import { type SettingsLevel,SettingsRegistryService } from './settings-registry.service.js';

/**
 * Administration panel descriptors (PLAN_Phase_20_Settings_UX.md §4.1, §4.9).
 *
 * One source of truth for the settings tab rail, the `/admin/settings/:tabKey` routes and the
 * standalone administration screens, so the sidebar, the rail and the router cannot drift apart.
 * A module contributes an entry by adding it here — the shell itself is never edited.
 *
 * The descriptors are code rather than an `app > adminPanel` metadata row because a tab is a lazy
 * loaded component: a descriptor naming a component that does not exist would render an empty tab.
 * Registration in one list keeps the contribution path open to modules while staying honest about
 * what can actually be drawn. Recorded in `docs/compatibility/settings-ux.md`.
 */
export interface AdminPanelTab {
  readonly key: string;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly icon: string;
  readonly order: number;
  readonly level: SettingsLevel;
  /** `tab` renders inside the settings shell; `page` is an existing full-screen admin route. */
  readonly kind: 'tab' | 'page';
  readonly route: string;
  /** The settings document a tab edits, when it has one. */
  readonly document?: string;
  /** Module settings tabs read their own endpoint instead of the document registry (§8.3). */
  readonly moduleEndpoint?: string;
  /**
   * Record-editing tabs save per action and show no bar; a tab that edits a draft — such as the layout
   * manager, which writes entity metadata — opts into the shell's save bar and dirty guard.
   */
  readonly usesSaveBar?: boolean;
}

export interface AdminPanelGroup {
  readonly key: string;
  readonly labelKey: string;
  readonly order: number;
  readonly tabs: readonly AdminPanelTab[];
}

const TAB_CATALOG: readonly (AdminPanelTab & { group: string })[] = [
  { group: 'system', key: 'general', labelKey: 'web.adminPanel.tabs.general', descriptionKey: 'web.adminPanel.descriptions.general', icon: 'GlobalOutlined', order: 110, level: 'admin', kind: 'tab', route: '/admin/settings/general', document: 'brand' },
  { group: 'system', key: 'localization', labelKey: 'web.adminPanel.tabs.localization', descriptionKey: 'web.adminPanel.descriptions.localization', icon: 'ScheduleOutlined', order: 120, level: 'admin', kind: 'tab', route: '/admin/settings/localization', document: 'i18n' },
  { group: 'system', key: 'menu', labelKey: 'web.adminPanel.tabs.menu', descriptionKey: 'web.adminPanel.descriptions.menu', icon: 'AppstoreOutlined', order: 130, level: 'admin', kind: 'tab', route: '/admin/settings/menu', document: 'navigation' },
  { group: 'system', key: 'layout', labelKey: 'web.adminPanel.tabs.layout', descriptionKey: 'web.adminPanel.descriptions.layout', icon: 'ToolOutlined', order: 135, level: 'admin', kind: 'tab', route: '/admin/settings/layout', usesSaveBar: true },
  { group: 'system', key: 'entity-manager', labelKey: 'web.entityManager.title', descriptionKey: 'web.adminPanel.descriptions.entityManager', icon: 'KeyOutlined', order: 140, level: 'admin', kind: 'page', route: '/admin/entity-manager' },
  { group: 'system', key: 'attachments', labelKey: 'web.adminPanel.tabs.attachments', descriptionKey: 'web.adminPanel.descriptions.attachments', icon: 'FileTextOutlined', order: 145, level: 'admin', kind: 'tab', route: '/admin/settings/attachments', document: 'fileStorage' },
  { group: 'system', key: 'jobs', labelKey: 'web.adminJobs.title', descriptionKey: 'web.adminPanel.descriptions.jobs', icon: 'ThunderboltOutlined', order: 150, level: 'admin', kind: 'page', route: '/admin/jobs' },
  { group: 'system', key: 'audit', labelKey: 'web.adminAudit.title', descriptionKey: 'web.adminPanel.descriptions.audit', icon: 'FileSearchOutlined', order: 160, level: 'admin', kind: 'page', route: '/admin/audit-log' },
  { group: 'system', key: 'internal', labelKey: 'web.adminPanel.tabs.internal', descriptionKey: 'web.adminPanel.descriptions.internal', icon: 'SettingOutlined', order: 170, level: 'sysAdmin', kind: 'tab', route: '/admin/settings/internal' },
  { group: 'security', key: 'authentication', labelKey: 'web.adminPanel.tabs.authentication', descriptionKey: 'web.adminPanel.descriptions.authentication', icon: 'KeyOutlined', order: 310, level: 'sysAdmin', kind: 'tab', route: '/admin/settings/authentication', document: 'security' },
  { group: 'security', key: 'permissions', labelKey: 'web.adminPanel.tabs.permissions', descriptionKey: 'web.adminPanel.descriptions.permissions', icon: 'ProfileOutlined', order: 320, level: 'admin', kind: 'tab', route: '/admin/settings/permissions' },
  { group: 'messaging', key: 'email', labelKey: 'web.adminPanel.tabs.email', descriptionKey: 'web.adminPanel.descriptions.email', icon: 'MailOutlined', order: 410, level: 'admin', kind: 'tab', route: '/admin/settings/email' },
  { group: 'messaging', key: 'notifications', labelKey: 'web.adminPanel.tabs.notifications', descriptionKey: 'web.adminPanel.descriptions.notifications', icon: 'NotificationOutlined', order: 420, level: 'admin', kind: 'tab', route: '/admin/settings/notifications', document: 'notifications' },
  { group: 'users', key: 'portals', labelKey: 'web.adminPortals.title', descriptionKey: 'web.adminPanel.descriptions.portals', icon: 'ProjectOutlined', order: 210, level: 'admin', kind: 'page', route: '/admin/portals' },
  { group: 'users', key: 'users', labelKey: 'web.adminPanel.tabs.users', descriptionKey: 'web.adminPanel.descriptions.users', icon: 'UserOutlined', order: 220, level: 'admin', kind: 'tab', route: '/admin/settings/users' },
  { group: 'users', key: 'teams', labelKey: 'web.adminPanel.tabs.teams', descriptionKey: 'web.adminPanel.descriptions.teams', icon: 'TeamOutlined', order: 230, level: 'admin', kind: 'tab', route: '/admin/settings/teams' },
  { group: 'users', key: 'roles', labelKey: 'web.adminPanel.tabs.roles', descriptionKey: 'web.adminPanel.descriptions.roles', icon: 'SolutionOutlined', order: 240, level: 'admin', kind: 'tab', route: '/admin/settings/roles' },
  { group: 'users', key: 'apiKeys', labelKey: 'web.adminPanel.tabs.apiKeys', descriptionKey: 'web.adminPanel.descriptions.apiKeys', icon: 'ApiOutlined', order: 250, level: 'sysAdmin', kind: 'tab', route: '/admin/settings/apiKeys' },
  // Phase 19-INT.14: the connector workspace is a full page, not a settings document, so the tab
  // is `kind: 'page'` — a `kind: 'tab'` without a document would render an empty panel.
  { group: 'integrations', key: 'advancedIntegrations', labelKey: 'web.adminPanel.tabs.advancedIntegrations', descriptionKey: 'web.adminPanel.descriptions.advancedIntegrations', icon: 'ApiOutlined', order: 515, level: 'admin', kind: 'page', route: '/advanced-integrations' },
  { group: 'integrations', key: 'sales', labelKey: 'web.adminPanel.tabs.sales', descriptionKey: 'web.adminPanel.descriptions.sales', icon: 'ShoppingCartOutlined', order: 510, level: 'admin', kind: 'tab', route: '/admin/settings/sales', moduleEndpoint: 'Sales' },
  { group: 'integrations', key: 'serviceDesk', labelKey: 'web.adminPanel.tabs.serviceDesk', descriptionKey: 'web.adminPanel.descriptions.serviceDesk', icon: 'CustomerServiceOutlined', order: 520, level: 'admin', kind: 'tab', route: '/admin/settings/serviceDesk', moduleEndpoint: 'ServiceDesk' },
  { group: 'integrations', key: 'customerSuccess', labelKey: 'web.adminPanel.tabs.customerSuccess', descriptionKey: 'web.adminPanel.descriptions.customerSuccess', icon: 'TrophyOutlined', order: 530, level: 'admin', kind: 'tab', route: '/admin/settings/customerSuccess', moduleEndpoint: 'CustomerSuccess' },
  { group: 'integrations', key: 'extensions', labelKey: 'web.adminExtensions.title', descriptionKey: 'web.adminPanel.descriptions.extensions', icon: 'ApiOutlined', order: 540, level: 'admin', kind: 'page', route: '/admin/extensions' },
  { group: 'integrations', key: 'webhooks', labelKey: 'web.adminPanel.tabs.webhooks', descriptionKey: 'web.adminPanel.descriptions.webhooks', icon: 'CloudOutlined', order: 545, level: 'admin', kind: 'tab', route: '/admin/settings/webhooks' },
  { group: 'integrations', key: 'workflows', labelKey: 'web.workflows.title', descriptionKey: 'web.adminPanel.descriptions.workflows', icon: 'ApartmentOutlined', order: 550, level: 'admin', kind: 'page', route: '/admin/workflows' },
  { group: 'integrations', key: 'processes', labelKey: 'web.processes.title', descriptionKey: 'web.adminPanel.descriptions.processes', icon: 'ShareAltOutlined', order: 560, level: 'admin', kind: 'page', route: '/admin/processes' },
];

const GROUP_CATALOG: readonly { key: string; labelKey: string; order: number }[] = [
  { key: 'system', labelKey: 'web.adminPanel.groups.system', order: 100 },
  { key: 'users', labelKey: 'web.adminPanel.groups.users', order: 200 },
  { key: 'security', labelKey: 'web.adminPanel.groups.security', order: 250 },
  { key: 'customization', labelKey: 'web.adminPanel.groups.customization', order: 300 },
  { key: 'messaging', labelKey: 'web.adminPanel.groups.messaging', order: 400 },
  { key: 'integrations', labelKey: 'web.adminPanel.groups.integrations', order: 500 },
];

@Injectable()
export class AdminPanelService {
  constructor(@Inject(SettingsRegistryService) private readonly registry: SettingsRegistryService) {}

  /**
   * The panel for the caller. A tab the caller may not open is absent here, and the settings
   * controller refuses it anyway on a direct URL — rendering is never the enforcement (§4.1, §10).
   */
  forCaller(): { groups: AdminPanelGroup[]; defaultTab: string | null } {
    const allowed = TAB_CATALOG.filter((tab) => this.registry.mayRead(tab.level));
    const groups = GROUP_CATALOG.map((group) => ({
      ...group,
      tabs: allowed
        .filter((tab) => tab.group === group.key)
        .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
        .map(({ group: _group, ...tab }) => tab),
    })).filter((group) => group.tabs.length > 0);
    const firstTab = groups[0]?.tabs[0];
    return { groups, defaultTab: firstTab === undefined ? null : firstTab.key };
  }

  /** Server-side answer for "may this caller open this tab", used by the settings routes. */
  tab(key: string): AdminPanelTab | undefined {
    const found = TAB_CATALOG.find((tab) => tab.key === key);
    if (!found) return undefined;
    const { group: _group, ...tab } = found;
    return tab;
  }

  mayOpen(key: string): boolean {
    const tab = this.tab(key);
    return tab !== undefined && this.registry.mayRead(tab.level);
  }
}
