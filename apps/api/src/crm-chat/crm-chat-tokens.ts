/**
 * Phase 19-CHAT.2 — the cross-module seam `CRMChat` needs, as a token instead of an import
 * (PLAN_Phase_19_CRM_Chat.md §4.5, §13).
 *
 * The resolved menu is cached in `NavigationService` for 30 s per user. A feature-flag write has to
 * drop that cache, otherwise "disabled Chat is absent from navigation" would only become true after
 * a pathologically long wait. The kernel cannot import this module, so `AppModule` binds the token to
 * `NavigationService.invalidate()` and this barrel keeps a no-op default for isolated tests.
 */
export type MenuInvalidator = () => void;

export const CRM_CHAT_MENU_INVALIDATOR = Symbol('CRM_CHAT_MENU_INVALIDATOR');

export const noopMenuInvalidator: MenuInvalidator = () => {
  /* no navigation surface to invalidate */
};
