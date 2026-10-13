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

/**
 * Phase 19 project-scoped access (PLAN_Phase_19_Projects.md §4.4, §9): the global own/team scope
 * PLUS access granted by the current user's `ProjectRole` in the record's project. It is a union
 * because the role is how a member reaches a colleague's task; it is bounded by membership, so a
 * role can never open a record of a project the user does not belong to, and an entity-level 'no'
 * still denies everything.
 *
 * Plain data only — the record store turns it into SQL and `ProjectPolicyService` evaluates the same
 * rule for by-id reads, so a list and a detail read can never disagree.
 */
export type ProjectScopedPredicate = {
  readonly kind: 'projectScoped';
  readonly userId: string;
  /** The global record scope the project rule is unioned with. */
  readonly base: { readonly kind: 'own' | 'team'; readonly userId: string; readonly teamIds: readonly string[] };
  /** Attribute holding the project id; `id` when the record IS the project. */
  readonly projectAttr: string;
  /** `null` = membership alone is enough, otherwise the `ProjectRole` field that decides. */
  readonly roleField: string | null;
  /** Role values granting the whole project. */
  readonly allValues: readonly string[];
  /** Role values granting tasks assigned to the user. */
  readonly assignedValues: readonly string[];
  /** Role values granting the user's own tasks (owner, assignee or collaborator). */
  readonly ownValues: readonly string[];
};

export type AclPredicate =
  | { readonly kind: 'allowAll' }
  | { readonly kind: 'denyAll' }
  | { readonly kind: 'own'; readonly userId: string }
  | { readonly kind: 'team'; readonly userId: string; readonly teamIds: readonly string[] }
  | PortalPredicate
  | ProjectScopedPredicate;
