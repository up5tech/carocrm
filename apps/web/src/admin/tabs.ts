import { type ComponentType, lazy, type LazyExoticComponent } from 'react';

/**
 * Tab key → lazy component (PLAN_Phase_20_Settings_UX.md §9.1). A tab is a route-level chunk, so the
 * administration bundle does not grow with the catalog: opening the Sales settings never pulls the
 * menu editor in, and vice versa. The keys match `GET /AdminPanel`; a key the server lists with no
 * component here renders the refusal state rather than a blank tab.
 */
export const TAB_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  general: lazy(() => import('./tabs/GeneralTab.js').then((module) => ({ default: module.GeneralTab }))),
  localization: lazy(() => import('./tabs/LocalizationTab.js').then((module) => ({ default: module.LocalizationTab }))),
  menu: lazy(() => import('./tabs/MenuTab.js').then((module) => ({ default: module.MenuTab }))),
  sales: lazy(() => import('./tabs/SalesSettingsTab.js').then((module) => ({ default: module.SalesSettingsTab }))),
  serviceDesk: lazy(() => import('./tabs/ServiceDeskSettingsTab.js').then((module) => ({ default: module.ServiceDeskSettingsTab }))),
  customerSuccess: lazy(() => import('./tabs/CustomerSuccessSettingsTab.js').then((module) => ({ default: module.CustomerSuccessSettingsTab }))),
  users: lazy(() => import('./tabs/UsersTab.js').then((module) => ({ default: module.UsersTab }))),
  teams: lazy(() => import('./tabs/TeamsTab.js').then((module) => ({ default: module.TeamsTab }))),
  roles: lazy(() => import('./tabs/RolesTab.js').then((module) => ({ default: module.RolesTab }))),
  apiKeys: lazy(() => import('./tabs/ApiKeysTab.js').then((module) => ({ default: module.ApiKeysTab }))),
};
