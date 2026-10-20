import {
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  BarChartOutlined,
  BookOutlined,
  CalendarOutlined,
  CarryOutOutlined,
  CloudOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DollarOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FundOutlined,
  GlobalOutlined,
  HddOutlined,
  HomeOutlined,
  InboxOutlined,
  KeyOutlined,
  MailOutlined,
  MessageOutlined,
  MobileOutlined,
  NotificationOutlined,
  PhoneOutlined,
  ProfileOutlined,
  ProjectOutlined,
  RobotOutlined,
  ScheduleOutlined,
  SearchOutlined,
  SettingOutlined,
  ShareAltOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  SolutionOutlined,
  StarOutlined,
  TagOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TrophyOutlined,
  UserAddOutlined,
  UserOutlined,
  VideoCameraOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';

/**
 * Icons an entity definition may name (`EntityDefinition.icon`). The Entity Manager stores only a
 * name and the SPA resolves it from this fixed set, so metadata can never name a component that is
 * not here — the same rule extension manifests follow in `AppShell`.
 */
export const ENTITY_ICONS: Record<string, ReactNode> = {
  ApartmentOutlined: <ApartmentOutlined />,
  ApiOutlined: <ApiOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  BankOutlined: <BankOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  BookOutlined: <BookOutlined />,
  CalendarOutlined: <CalendarOutlined />,
  CarryOutOutlined: <CarryOutOutlined />,
  CloudOutlined: <CloudOutlined />,
  CustomerServiceOutlined: <CustomerServiceOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  DollarOutlined: <DollarOutlined />,
  EnvironmentOutlined: <EnvironmentOutlined />,
  ExperimentOutlined: <ExperimentOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  FundOutlined: <FundOutlined />,
  GlobalOutlined: <GlobalOutlined />,
  HddOutlined: <HddOutlined />,
  HomeOutlined: <HomeOutlined />,
  InboxOutlined: <InboxOutlined />,
  MailOutlined: <MailOutlined />,
  MobileOutlined: <MobileOutlined />,
  NotificationOutlined: <NotificationOutlined />,
  PhoneOutlined: <PhoneOutlined />,
  ProfileOutlined: <ProfileOutlined />,
  ProjectOutlined: <ProjectOutlined />,
  RobotOutlined: <RobotOutlined />,
  ScheduleOutlined: <ScheduleOutlined />,
  ShareAltOutlined: <ShareAltOutlined />,
  ShopOutlined: <ShopOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  SolutionOutlined: <SolutionOutlined />,
  StarOutlined: <StarOutlined />,
  TagOutlined: <TagOutlined />,
  TeamOutlined: <TeamOutlined />,
  ThunderboltOutlined: <ThunderboltOutlined />,
  ToolOutlined: <ToolOutlined />,
  TrophyOutlined: <TrophyOutlined />,
  UserAddOutlined: <UserAddOutlined />,
  UserOutlined: <UserOutlined />,
  VideoCameraOutlined: <VideoCameraOutlined />,
  WalletOutlined: <WalletOutlined />,
};

/**
 * Presentation defaults for the entities the platform ships with. They live here rather than in
 * the seed metadata because re-seeding would overwrite the admin overrides the Entity Manager
 * writes into `app_settings.entity`; an explicit `icon` on the definition always wins over these.
 */
export const ENTITY_DEFAULT_ICONS: Record<string, string> = {
  Account: 'BankOutlined',
  Bill: 'FileTextOutlined',
  BillCredit: 'WalletOutlined',
  BusinessCalendar: 'CalendarOutlined',
  Call: 'PhoneOutlined',
  Campaign: 'NotificationOutlined',
  Case: 'CustomerServiceOutlined',
  CaseAssignment: 'TeamOutlined',
  CaseQueue: 'InboxOutlined',
  CaseSLAClock: 'ScheduleOutlined',
  CaseTransition: 'ShareAltOutlined',
  Contact: 'UserOutlined',
  CreditNote: 'WalletOutlined',
  CsatSurvey: 'StarOutlined',
  CustomerSuccessGoal: 'StarOutlined',
  CustomerSuccessPlan: 'SolutionOutlined',
  CustomerSuccessPlaybookRun: 'ThunderboltOutlined',
  CustomerSuccessPlaybookStepRun: 'CarryOutOutlined',
  CustomerSuccessPlaybookTemplate: 'BookOutlined',
  CustomerSuccessProfile: 'TrophyOutlined',
  CustomerSuccessReview: 'FileTextOutlined',
  CustomerSuccessRisk: 'ExperimentOutlined',
  DeliveryOrder: 'ShopOutlined',
  DocumentTemplate: 'FileTextOutlined',
  Email: 'MailOutlined',
  EmailTemplate: 'ProfileOutlined',
  InventoryAdjustment: 'ToolOutlined',
  InventoryBatch: 'DatabaseOutlined',
  InventoryReservation: 'ScheduleOutlined',
  InventorySerial: 'TagOutlined',
  InventoryTransaction: 'DatabaseOutlined',
  Invoice: 'DollarOutlined',
  KnowledgeArticle: 'BookOutlined',
  KnowledgeCategory: 'TagOutlined',
  Lead: 'UserAddOutlined',
  MarketingConsent: 'MailOutlined',
  MarketingSuppression: 'InboxOutlined',
  Meeting: 'VideoCameraOutlined',
  Opportunity: 'FundOutlined',
  Payment: 'WalletOutlined',
  PaymentChannel: 'GlobalOutlined',
  PaymentMethod: 'TagOutlined',
  PaymentRequest: 'FileTextOutlined',
  PaymentTermProfile: 'CalendarOutlined',
  PriceBook: 'BookOutlined',
  PriceBookEntry: 'DatabaseOutlined',
  PriceRule: 'ThunderboltOutlined',
  Product: 'TagOutlined',
  ProductCategory: 'AppstoreOutlined',
  Project: 'ProjectOutlined',
  ProjectBoard: 'AppstoreOutlined',
  ProjectCategory: 'TagOutlined',
  ProjectRole: 'SolutionOutlined',
  ProjectTask: 'ScheduleOutlined',
  PurchaseOrder: 'ShoppingCartOutlined',
  QueueMember: 'UserOutlined',
  Quote: 'FileTextOutlined',
  ReceiptOrder: 'InboxOutlined',
  ReturnOrder: 'InboxOutlined',
  RoutingRule: 'ApartmentOutlined',
  SalesOrder: 'ShoppingCartOutlined',
  SLAPolicy: 'FileTextOutlined',
  Subscription: 'WalletOutlined',
  SubscriptionPeriod: 'CalendarOutlined',
  Supplier: 'TeamOutlined',
  SupplierProductPrice: 'DatabaseOutlined',
  TargetList: 'TeamOutlined',
  Task: 'CarryOutOutlined',
  TaxClass: 'FileTextOutlined',
  TaxCode: 'TagOutlined',
  TaxRate: 'DollarOutlined',
  TaxRule: 'ExperimentOutlined',
  TransferOrder: 'ShopOutlined',
  Warehouse: 'HddOutlined',
  WriteOff: 'InboxOutlined',
};

/** The icon an entity gets when its definition carries none. */
export function defaultIconName(entityName: string): string | undefined {
  return ENTITY_DEFAULT_ICONS[entityName];
}

/**
 * Sidebar icon: the entity's own choice, then its built-in default, then the generic record mark.
 */
export function entityIcon(icon: string | null | undefined, entityName?: string): ReactNode {
  const name = icon ?? (entityName === undefined ? undefined : defaultIconName(entityName));
  return (name !== undefined && name !== null ? ENTITY_ICONS[name] : undefined) ?? <DatabaseOutlined />;
}

/**
 * The icons a resolved menu entry or an administration tab may name: every entity icon plus the
 * marks the shell uses for its fixed pages, groups and panels. The server validates menu icons
 * against the same list (`NAVIGATION_ICONS` in `apps/api/src/admin-panel/settings-shapes.ts`), so a
 * settings document can never name a component that is not here.
 */
export const NAV_ICONS: Record<string, ReactNode> = {
  ...ENTITY_ICONS,
  ApartmentOutlined: <ApartmentOutlined />,
  BookOutlined: <BookOutlined />,
  CustomerServiceOutlined: <CustomerServiceOutlined />,
  DashboardOutlined: <DashboardOutlined />,
  FileSearchOutlined: <FileSearchOutlined />,
  KeyOutlined: <KeyOutlined />,
  MessageOutlined: <MessageOutlined />,
  SearchOutlined: <SearchOutlined />,
  SettingOutlined: <SettingOutlined />,
  ShareAltOutlined: <ShareAltOutlined />,
};

export const NAV_ICON_NAMES: readonly string[] = Object.keys(NAV_ICONS).sort();

/** Menu icon for a server-resolved entry; an unknown name falls back rather than rendering nothing. */
export function navIcon(name: string | undefined): ReactNode {
  return (name === undefined ? undefined : NAV_ICONS[name]) ?? <AppstoreOutlined />;
}

/**
 * Presentation defaults for nested navigation groups the server builds without an icon (the Sales
 * submenu family). A server-sent image still wins, so an administrator override is never masked.
 */
export const NAV_GROUP_DEFAULT_ICONS: Record<string, string> = {
  'group:sales-sales': 'FileTextOutlined',
  'group:sales-catalog': 'TagOutlined',
  'group:sales-payments': 'WalletOutlined',
  'group:sales-purchases': 'ShopOutlined',
  'group:sales-inventory': 'HddOutlined',
  'group:sales-subscriptions': 'CalendarOutlined',
};

export function navGroupIcon(key: string, icon: string | undefined): ReactNode {
  return navIcon(icon ?? NAV_GROUP_DEFAULT_ICONS[key]);
}
