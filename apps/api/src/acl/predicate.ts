/**
 * Record-scope predicate injected into list/detail queries by the record store (PLAN §18.4).
 *
 * Kept in its own module so the record store, the internal ACL facade and the Phase 18 portal
 * policy can all share the union without importing each other.
 */

/** One link attribute of an entity that points at Contact or Account. */
export interface PortalLinkField {
  readonly field: string;
  readonly multiple: boolean;
}

/**
 * Phase 18 portal record visibility (PLAN §37 "Restricted record visibility"): the portal
 * user's own Contact/Account, records carrying a link attribute to them, and records linked
 * through the generic `entity_links` store in either direction. `linkFields` is the entity's
 * own Contact/Account link surface, so list SQL and by-id checks decide identically.
 */
export type PortalPredicate = {
  readonly kind: 'portal';
  readonly entity: string;
  readonly contactId: string | null;
  readonly accountId: string | null;
  readonly linkFields: readonly PortalLinkField[];
};

export type AclPredicate =
  | { readonly kind: 'allowAll' }
  | { readonly kind: 'denyAll' }
  | { readonly kind: 'own'; readonly userId: string }
  | { readonly kind: 'team'; readonly userId: string; readonly teamIds: readonly string[] }
  | PortalPredicate;
