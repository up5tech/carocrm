import {
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  BarChartOutlined,
  CalendarOutlined,
  CarryOutOutlined,
  CloudOutlined,
  DatabaseOutlined,
  DollarOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FundOutlined,
  GlobalOutlined,
  HddOutlined,
  HomeOutlined,
  InboxOutlined,
  MailOutlined,
  MobileOutlined,
  NotificationOutlined,
  PhoneOutlined,
  ProfileOutlined,
  ProjectOutlined,
  ScheduleOutlined,
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

/** Sidebar icon: the entity's own choice, then its built-in default, then the generic record mark. */
export function entityIcon(icon: string | null | undefined, entityName?: string): ReactNode {
  const name = icon ?? (entityName === undefined ? undefined : defaultIconName(entityName));
  return (name !== undefined && name !== null ? ENTITY_ICONS[name] : undefined) ?? <DatabaseOutlined />;
}
