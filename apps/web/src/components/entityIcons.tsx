import {
  ApiOutlined,
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
  GlobalOutlined,
  HddOutlined,
  HomeOutlined,
  InboxOutlined,
  MailOutlined,
  MobileOutlined,
  NotificationOutlined,
  PhoneOutlined,
  ProjectOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  SolutionOutlined,
  StarOutlined,
  TagOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TrophyOutlined,
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
  GlobalOutlined: <GlobalOutlined />,
  HddOutlined: <HddOutlined />,
  HomeOutlined: <HomeOutlined />,
  InboxOutlined: <InboxOutlined />,
  MailOutlined: <MailOutlined />,
  MobileOutlined: <MobileOutlined />,
  NotificationOutlined: <NotificationOutlined />,
  PhoneOutlined: <PhoneOutlined />,
  ProjectOutlined: <ProjectOutlined />,
  ShopOutlined: <ShopOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  SolutionOutlined: <SolutionOutlined />,
  StarOutlined: <StarOutlined />,
  TagOutlined: <TagOutlined />,
  TeamOutlined: <TeamOutlined />,
  ThunderboltOutlined: <ThunderboltOutlined />,
  ToolOutlined: <ToolOutlined />,
  TrophyOutlined: <TrophyOutlined />,
  UserOutlined: <UserOutlined />,
  VideoCameraOutlined: <VideoCameraOutlined />,
  WalletOutlined: <WalletOutlined />,
};

/** Sidebar icon for an entity: its own choice when known, the generic record mark otherwise. */
export function entityIcon(name: string | null | undefined): ReactNode {
  return (name !== undefined && name !== null ? ENTITY_ICONS[name] : undefined) ?? <DatabaseOutlined />;
}
