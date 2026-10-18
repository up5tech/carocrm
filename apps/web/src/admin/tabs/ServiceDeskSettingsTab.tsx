import { ModuleSettingsTab } from './ModuleSettingsTab.js';

/** Service Desk settings document, hosted by the administration shell (PLAN_Phase_20 §4.3 row 21). */
export function ServiceDeskSettingsTab() {
  return <ModuleSettingsTab module="serviceDesk" />;
}
