/**
 * Phase 19-CHAT.2 — the navigation feature-gate seam
 * (`apps/api/src/admin-panel/navigation.service.ts`, PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.2`).
 *
 * The menu pipeline is `defaults → navigation document → ACL → order`. A module page whose route is
 * not a metadata entity had no way to disappear when its module is switched off: the ACL only answers
 * "may this caller read this", never "is this deployment feature on". This token adds that second
 * question **after** the ACL, so a disabled module is absent from the menu instead of present and
 * broken.
 *
 * The kernel must not import a domain module, so the check is a function value:
 *
 *  - the admin-panel barrel provides a default that allows everything, which keeps every existing
 *    installation and every isolated module test behaving exactly as before;
 *  - `AppModule` overrides it with a resolver that reads each module's own settings row.
 *
 * A gate is only consulted for a seed that names `feature`; a seed without one costs nothing.
 */
export type NavigationFeatureGate = (module: string, flag: string) => Promise<boolean>;

export const NAVIGATION_FEATURE_GATE = Symbol('NAVIGATION_FEATURE_GATE');

export const allowEveryNavigationFeature: NavigationFeatureGate = async () => true;
