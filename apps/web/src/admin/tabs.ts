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
  voiceCommunications: lazy(() =>
    import('./tabs/VoiceCommunicationsSettingsTab.js').then((module) => ({ default: module.VoiceCommunicationsSettingsTab })),
  ),
  customerSuccess: lazy(() => import('./tabs/CustomerSuccessSettingsTab.js').then((module) => ({ default: module.CustomerSuccessSettingsTab }))),
  users: lazy(() => import('./tabs/UsersTab.js').then((module) => ({ default: module.UsersTab }))),
  teams: lazy(() => import('./tabs/TeamsTab.js').then((module) => ({ default: module.TeamsTab }))),
  roles: lazy(() => import('./tabs/RolesTab.js').then((module) => ({ default: module.RolesTab }))),
  apiKeys: lazy(() => import('./tabs/ApiKeysTab.js').then((module) => ({ default: module.ApiKeysTab }))),
  layout: lazy(() => import('./tabs/LayoutTab.js').then((module) => ({ default: module.LayoutSettingsTab }))),
  authentication: lazy(() => import('./tabs/AuthenticationTab.js').then((module) => ({ default: module.AuthenticationTab }))),
  permissions: lazy(() => import('./tabs/PermissionsTab.js').then((module) => ({ default: module.PermissionsTab }))),
  attachments: lazy(() => import('./tabs/AttachmentsTab.js').then((module) => ({ default: module.AttachmentsTab }))),
  email: lazy(() => import('./tabs/EmailTab.js').then((module) => ({ default: module.EmailTab }))),
  notifications: lazy(() => import('./tabs/NotificationsTab.js').then((module) => ({ default: module.NotificationsTab }))),
  webhooks: lazy(() => import('./tabs/WebhooksTab.js').then((module) => ({ default: module.WebhooksTab }))),
  internal: lazy(() => import('./tabs/InternalTab.js').then((module) => ({ default: module.InternalTab }))),
  docs: lazy(() => import('./tabs/DocsTab.js').then((module) => ({ default: module.DocsTab }))),
};
