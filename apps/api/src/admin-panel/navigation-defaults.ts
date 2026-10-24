import type { AclAction } from '@carocrm/acl/types/index.js';

/**
 * The menu the platform ships with (PLAN_Phase_20_Settings_UX.md §4.4, §15.2).
 *
 * These are the entries `AppShell.tsx` used to hard-code. They move here so the resolved tree comes
 * from one place, the `navigation` settings document can override it, and the SPA renders what the
 * server computed. With no document written the tree is the menu users had before this phase.
 */

/** A menu entry before ACL filtering and before the `navigation` document is applied. */
export interface NavigationSeed {
  readonly key: string;
  readonly kind: 'page' | 'entity' | 'group' | 'extension' | 'admin';
  readonly route: string;
  readonly label?: string | undefined;
  readonly labelKey?: string | undefined;
  readonly icon?: string | undefined;
  readonly order: number;
  readonly inQuickSearch?: boolean | undefined;
  /** For entity/group seeds: the key of the container this entry sits in. */
  readonly parent?: string | undefined;
  /** For admin entries: the panel level required to see them. */
  readonly level?: 'user' | 'admin' | undefined;
  /**
   * A page that is only useful to a principal with this permission. Entity entries are filtered by
   * their own record ACL; this covers module pages whose route is not a metadata entity.
   */
  readonly permission?: { readonly entity: string; readonly action: AclAction } | undefined;
  /**
   * A module page that is only useful while its deployment feature is on (Phase 19-CHAT). Resolved
   * through `NAVIGATION_FEATURE_GATE` **after** the ACL, so a module switched off by an administrator
   * is absent from the menu rather than present and refusing every call.
   */
  readonly feature?: { readonly module: string; readonly flag: string } | undefined;
}

export interface NavigationGroupSeed {
  readonly key: string;
  /** Catalog key for the group. The Project submenu is named after its own record label instead. */
  readonly labelKey?: string | undefined;
  readonly icon?: string | undefined;
  readonly order: number;
  /** Container groups (`records`, `extensions`, `administration`) render as menu group labels. */
  readonly container: boolean;
}

const PAGE_ORDER = [10, 20, 30, 40, 50, 60, 70];

/** The fixed working surfaces, in the order the sidebar has always shown them. */
export const NAVIGATION_PAGES: readonly NavigationSeed[] = [
  { key: 'home', kind: 'page', route: '/home', labelKey: 'core.app.home', icon: 'AppstoreOutlined', order: PAGE_ORDER[0] ?? 10, inQuickSearch: true },
  { key: 'search', kind: 'page', route: '/search', labelKey: 'core.app.search', icon: 'SearchOutlined', order: PAGE_ORDER[1] ?? 20, inQuickSearch: true },
  { key: 'dashboards', kind: 'page', route: '/dashboards', labelKey: 'core.app.dashboards', icon: 'DashboardOutlined', order: PAGE_ORDER[2] ?? 30 },
  { key: 'reports', kind: 'page', route: '/reports', labelKey: 'core.app.reports', icon: 'BarChartOutlined', order: PAGE_ORDER[3] ?? 40 },
  { key: 'stream', kind: 'page', route: '/stream', labelKey: 'core.app.stream', icon: 'NotificationOutlined', order: PAGE_ORDER[4] ?? 50 },
  { key: 'calendar', kind: 'page', route: '/calendar', labelKey: 'core.app.calendar', icon: 'CalendarOutlined', order: PAGE_ORDER[5] ?? 60 },
  { key: 'myTasks', kind: 'page', route: '/tasks', labelKey: 'core.app.myTasks', icon: 'CarryOutOutlined', order: PAGE_ORDER[6] ?? 70 },
  // Phase 19-AI: the module page is not a metadata entity, so its visibility is checked against the
  // synthetic `AIAgent:read` permission (the same capability the API asserts). It is configuration
  // rather than a daily working surface, so it sits with the other module pages under Administration.
  {
    key: 'aiAgents',
    kind: 'page',
    route: '/ai-agents',
    labelKey: 'web.aiAgents.title',
    icon: 'RobotOutlined',
    parent: 'administration',
    order: 947,
    inQuickSearch: true,
    permission: { entity: 'AIAgent', action: 'read' },
  },
  // Phase 19-CHAT: the workspace is a module page too. Two server-side gates apply — the synthetic
  // `CRMChatConversation:read` permission and the `crmChat` module's `features.workspace` flag — so
  // an administrator who disables Chat removes the entry, and the page is also refused directly.
  {
    key: 'crmChat',
    kind: 'page',
    route: '/crm-chat',
    labelKey: 'web.crmChat.title',
    icon: 'CustomerServiceOutlined',
    order: 76,
    inQuickSearch: true,
    permission: { entity: 'CRMChatConversation', action: 'read' },
    feature: { module: 'crmChat', flag: 'workspace' },
  },
  // Phase 19-VC: the module's records are dedicated tables, not metadata entities, so each page is
  // gated on the same synthetic capability its API asserts. The inbox needs the conversation
  // capability (`CommunicationConversation:read`); diagnostics need `VoiceProviderAccount:read`.
  {
    key: 'voiceInbox',
    kind: 'page',
    route: '/voice-inbox',
    labelKey: 'voice.nav.inbox',
    icon: 'MessageOutlined',
    order: 77,
    inQuickSearch: true,
    permission: { entity: 'CommunicationConversation', action: 'read' },
  },
  {
    key: 'voiceCommunications',
    kind: 'page',
    route: '/voice-communications',
    labelKey: 'voice.nav.voice',
    icon: 'PhoneOutlined',
    // Module diagnostics are configuration, so the entry lives with the settings, not beside the
    // inbox. It keeps its own capability gate: `parent` only changes where the entry is drawn.
    parent: 'administration',
    order: 948,
    inQuickSearch: true,
    permission: { entity: 'VoiceProviderAccount', action: 'read' },
  },
  // Phase 19-INT.14: the connector workspace. Its records are dedicated tables, not metadata
  // entities, so the page is gated on the same synthetic capability its API asserts.
  {
    key: 'advancedIntegrations',
    kind: 'page',
    route: '/advanced-integrations',
    labelKey: 'advancedintegrations.module.label',
    icon: 'ApiOutlined',
    parent: 'administration',
    order: 949,
    inQuickSearch: true,
    permission: { entity: 'IntegrationConnection', action: 'read' },
  },
  // Phase 19-ES.1: the e-signature workspace. Its records are dedicated tables, not metadata
  // entities (audit §6), so the page is gated on the same synthetic capability its API asserts, and
  // on the module's own `enabled` switch — an unconfigured installation does not carry the entry.
  {
    key: 'esignature',
    kind: 'page',
    route: '/esignature',
    labelKey: 'esignature.module.label',
    icon: 'FileSearchOutlined',
    // Sits under RECORDS (100) and above the Extensions/Administration containers (900+).
    order: 200,
    inQuickSearch: true,
    permission: { entity: 'SignatureRequest', action: 'read' },
    feature: { module: 'eSignature', flag: 'enabled' },
  },
  // Phase 19-LS.8: the scoring model workspace. Models and rules are metadata entities whose base ACL is
  // refusal, so the entry asks for the same `LeadScoreModel:read` the module's commands assert, and the
  // module's own `enabled` switch can take the entry away (the gate runs after the ACL).
  {
    key: 'leadScore',
    kind: 'page',
    route: '/lead-score',
    labelKey: 'leadscore.admin.page.title',
    icon: 'ThunderboltOutlined',
    parent: 'administration',
    order: 948,
    inQuickSearch: true,
    permission: { entity: 'LeadScoreModel', action: 'read' },
    feature: { module: 'leadScore', flag: 'enabled' },
  },
  // Phase 21: the handbook is a static page like the others, and the only gate on it is the instance
  // document — every signed-in reader may open `/docs`, and an administrator can take the row away.
  // `feature` is consulted after the ACL, so this flag can remove an entry but never reveal one.
  // The menu row is called "Help": the page is still the handbook, but the sidebar entry reads as an
  // affordance next to Inbox rather than a module name.
  {
    key: 'docs',
    kind: 'page',
    route: '/docs',
    labelKey: 'web.docs.sidebarLabel',
    icon: 'BookOutlined',
    order: 78,
    inQuickSearch: true,
    feature: { module: 'docs', flag: 'showInSidebar' },
  },
];

export const NAVIGATION_CONTAINER_GROUPS: readonly NavigationGroupSeed[] = [
  // CRM is the customer records promoted out of RECORDS into their own group: they are the entities
  // an operator opens all day, and burying them one level down cost a click on every visit.
  { key: 'crm', labelKey: 'web.navGroup.crm', icon: 'TeamOutlined', order: 90, container: true },
  { key: 'records', labelKey: 'core.app.records', icon: 'ProfileOutlined', order: 100, container: true },
  { key: 'extensions', labelKey: 'core.app.extensions', icon: 'ApiOutlined', order: 900, container: true },
  { key: 'administration', labelKey: 'core.app.administration', icon: 'SettingOutlined', order: 950, container: true },
];

/**
 * Module submenus inside RECORDS. Membership is a name set over the navigable metadata — the rule
 * the sidebar already followed — so an entity renamed or hidden by metadata leaves its group instead
 * of leaving a dead entry. An entity's own `nav.group` metadata wins over this table (§4.5).
 */
export const NAVIGATION_SUBGROUPS: readonly (NavigationGroupSeed & { entityNames: readonly string[] })[] = [
  // `crm` is also a container (see NAVIGATION_CONTAINER_GROUPS): it stays listed here so the entity
  // → group mapping and the metadata `nav.group` validator still know the key, and the RECORDS loop
  // skips it because it renders as its own group.
  { key: 'crm', labelKey: 'web.navGroup.crm', icon: 'TeamOutlined', order: 110, container: false, entityNames: ['Account', 'Contact', 'Lead', 'Opportunity'] },
  { key: 'activities', labelKey: 'web.navGroup.activities', icon: 'CarryOutOutlined', order: 120, container: false, entityNames: ['Task', 'Call', 'Meeting', 'Email', 'EmailTemplate'] },
  { key: 'serviceDesk', labelKey: 'web.navGroup.serviceDesk', icon: 'CustomerServiceOutlined', order: 130, container: false, entityNames: ['Case', 'CaseQueue', 'CaseAssignment', 'CaseTransition', 'QueueMember', 'RoutingRule', 'SLAPolicy', 'CaseSLAClock', 'CsatSurvey', 'BusinessCalendar'] },
  { key: 'knowledge', labelKey: 'web.navGroup.knowledge', icon: 'BookOutlined', order: 140, container: false, entityNames: ['KnowledgeArticle', 'KnowledgeCategory'] },
  { key: 'customerSuccess', labelKey: 'web.navGroup.customerSuccess', icon: 'TrophyOutlined', order: 150, container: false, entityNames: ['CustomerSuccessProfile', 'CustomerSuccessPlan', 'CustomerSuccessGoal', 'CustomerSuccessReview', 'CustomerSuccessRisk', 'CustomerSuccessPlaybookTemplate', 'CustomerSuccessPlaybookRun', 'CustomerSuccessPlaybookStepRun'] },
  { key: 'project', icon: 'ProjectOutlined', order: 160, container: false, entityNames: [] },
  { key: 'marketing', labelKey: 'marketing.nav.marketing', icon: 'NotificationOutlined', order: 180, container: false, entityNames: ['Campaign', 'TargetList', 'MarketingConsent', 'MarketingSuppression'] },
];

/**
 * Sales is the one module that groups its own entities into sub-submenus, so its tree is a nested
 * descriptor rather than a flat name set (`sales.nav.<key>` labels come from the Sales catalog).
 */
export const NAVIGATION_SALES_GROUPS: readonly { key: string; entityNames: readonly string[] }[] = [
  { key: 'sales', entityNames: ['Quote', 'SalesOrder', 'Invoice', 'CreditNote', 'DeliveryOrder', 'ReturnOrder'] },
  { key: 'catalog', entityNames: ['Product', 'ProductCategory', 'PriceBook', 'PriceBookEntry', 'PriceRule', 'TaxClass', 'TaxCode', 'TaxRate', 'TaxRule'] },
  { key: 'payments', entityNames: ['Payment', 'PaymentMethod', 'PaymentChannel', 'PaymentTermProfile', 'PaymentRequest', 'WriteOff'] },
  { key: 'purchases', entityNames: ['Supplier', 'SupplierProductPrice', 'PurchaseOrder', 'ReceiptOrder', 'Bill', 'BillCredit'] },
  { key: 'inventory', entityNames: ['Warehouse', 'InventoryTransaction', 'InventoryAdjustment', 'InventoryReservation', 'TransferOrder', 'InventoryBatch', 'InventorySerial'] },
  { key: 'subscriptions', entityNames: ['Subscription', 'SubscriptionPeriod'] },
];

/** Entities the Sales submenu owns; used to keep them out of the ungrouped remainder. */
export const NAVIGATION_SALES_ENTITY_NAMES: readonly string[] = NAVIGATION_SALES_GROUPS.flatMap((group) => [...group.entityNames]);

/** Entities whose name starts with `Project` form the Project submenu, as they do today. */
export const navigationProjectName = (entityName: string): boolean => entityName.startsWith('Project');

export const NAVIGATION_ADMIN_ENTRIES: readonly NavigationSeed[] = [
  { key: 'admin:entity-manager', kind: 'admin', route: '/admin/entity-manager', labelKey: 'web.entityManager.title', icon: 'KeyOutlined', order: 910, level: 'admin' },
  { key: 'admin:audit', kind: 'admin', route: '/admin/audit-log', labelKey: 'web.adminAudit.title', icon: 'FileSearchOutlined', order: 920, level: 'admin' },
  { key: 'admin:jobs', kind: 'admin', route: '/admin/jobs', labelKey: 'web.adminJobs.title', icon: 'ThunderboltOutlined', order: 930, level: 'admin' },
  { key: 'admin:extensions', kind: 'admin', route: '/admin/extensions', labelKey: 'web.adminExtensions.title', icon: 'ApiOutlined', order: 940, level: 'admin' },
  { key: 'admin:workflows', kind: 'admin', route: '/admin/workflows', labelKey: 'web.workflows.title', icon: 'ApartmentOutlined', order: 945, level: 'admin' },
  { key: 'admin:processes', kind: 'admin', route: '/admin/processes', labelKey: 'web.processes.title', icon: 'ShareAltOutlined', order: 946, level: 'admin' },
  { key: 'admin:settings', kind: 'admin', route: '/admin/settings', labelKey: 'web.adminSettings.title', icon: 'SettingOutlined', order: 950, level: 'admin' },
  { key: 'admin:portals', kind: 'admin', route: '/admin/portals', labelKey: 'web.adminPortals.title', icon: 'ProjectOutlined', order: 960, level: 'admin' },
];

/**
 * Group keys an entity's `nav.group` may name (PLAN_Phase_20 §4.5). `sales-<key>` addresses a Sales
 * sub-group. The metadata writer validates against this list through the `NAVIGATION_GROUP_KEYS`
 * seam, so an administrator cannot type a group that would silently drop the entity into the
 * ungrouped remainder.
 */
export const navigationGroupKeyList = (): readonly string[] => [
  ...NAVIGATION_SUBGROUPS.map((group) => group.key),
  ...NAVIGATION_SALES_GROUPS.map((group) => `sales-${group.key}`),
];
