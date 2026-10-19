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
  ApiOutlined: <ApiOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  BankOutlined: <BankOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  CalendarOutlined: <CalendarOutlined />,
  CarryOutOutlined: <CarryOutOutlined />,
  CloudOutlined: <CloudOutlined />,
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
  Call: 'PhoneOutlined',
  // Phase 19-MA — Marketing Automation. Defaults, not seed metadata: re-seeding would overwrite the
  // overrides the Entity Manager writes, and the icon set is fixed in the SPA.
  Campaign: 'NotificationOutlined',
  TargetList: 'TeamOutlined',
  Contact: 'UserOutlined',
  Email: 'MailOutlined',
  EmailTemplate: 'ProfileOutlined',
  Lead: 'UserAddOutlined',
  Meeting: 'VideoCameraOutlined',
  Opportunity: 'FundOutlined',
  Project: 'ProjectOutlined',
  ProjectBoard: 'AppstoreOutlined',
  ProjectCategory: 'TagOutlined',
  ProjectRole: 'SolutionOutlined',
  ProjectTask: 'ScheduleOutlined',
  Task: 'CarryOutOutlined',
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
  SearchOutlined: <SearchOutlined />,
  SettingOutlined: <SettingOutlined />,
  ShareAltOutlined: <ShareAltOutlined />,
};

export const NAV_ICON_NAMES: readonly string[] = Object.keys(NAV_ICONS).sort();

/** Menu icon for a server-resolved entry; an unknown name falls back rather than rendering nothing. */
export function navIcon(name: string | undefined): ReactNode {
  return (name === undefined ? undefined : NAV_ICONS[name]) ?? <AppstoreOutlined />;
}
