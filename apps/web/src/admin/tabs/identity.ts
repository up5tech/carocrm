import { useQuery } from '@tanstack/react-query';

import { api,ApiError } from '../../api/client.js';
import type { ListResult, Role, TeamRow, UserRow } from '../../api/types.js';

/**
 * Shared vocabulary and lookups for the identity tabs (PLAN_Phase_20_Settings_UX.md §4.3 rows 9–12).
 *
 * The action and level names are the ones the enforced ACL reads (`AclAction` / `AclRoleLevel` in
 * `packages/acl`), restated here because the SPA does not depend on that package. Keeping them in one
 * place means a role edited in the UI is written in exactly the shape the server evaluates.
 */
export const ACL_ACTIONS = ['create', 'read', 'edit', 'delete', 'stream'] as const;
export type AclAction = (typeof ACL_ACTIONS)[number];

/** Weakest to strongest; `yes` is unrestricted access and `no` means "the role states nothing". */
export const ACL_LEVELS = ['no', 'own', 'team', 'all', 'yes'] as const;
export type AclLevel = (typeof ACL_LEVELS)[number];

const LEVEL_RANK: Record<AclLevel, number> = { no: 0, own: 1, team: 2, all: 3, yes: 4 };

/** A permission that is absent from a role grants nothing, so the matrix shows it as `no`. */
export function aclLevel(role: Role | undefined, entity: string, action: AclAction): AclLevel {
  const stated = role?.permissions[entity]?.[action];
  return isAclLevel(stated) ? stated : 'no';
}

/** Roles are additive: the strongest level any role states is the one that applies. */
export function maxAclLevel(levels: readonly AclLevel[]): AclLevel {
  let best: AclLevel = 'no';
  for (const level of levels) if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  return best;
}

export function isAclLevel(value: unknown): value is AclLevel {
  return typeof value === 'string' && (ACL_LEVELS as readonly string[]).includes(value);
}

export function useRolesQuery() {
  return useQuery<ListResult<Role>>({
    queryKey: ['identity', 'roles'],
    queryFn: () => api.roles({ maxSize: 500 }),
    staleTime: 30_000,
  });
}

export function useTeamsQuery() {
  return useQuery<ListResult<TeamRow>>({
    queryKey: ['identity', 'teams'],
    queryFn: () => api.teams({ maxSize: 500 }),
    staleTime: 30_000,
  });
}

/** The user picker options: names come from the same list endpoint the users tab pages through. */
export function useUsersQuery() {
  return useQuery<ListResult<UserRow>>({
    queryKey: ['identity', 'users', 'picker'],
    queryFn: () => api.users({ maxSize: 500 }),
    staleTime: 30_000,
  });
}

/**
 * A rejected write keeps the rule name in `details` (the last-administrator and role-in-use refusals),
 * which is what lets the form explain itself inline instead of showing a bare message.
 */
export function errorRule(error: unknown): string | undefined {
  return error instanceof ApiError && typeof error.details?.['rule'] === 'string' ? error.details['rule'] : undefined;
}

/** Field-level validation failures arrive as `details.issues[]`, the same shape settings use. */
export function errorIssues(error: unknown): string[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details?.['issues'])) return [];
  return (error.details['issues'] as unknown[]).map((issue) => {
    if (typeof issue === 'string') return issue;
    const record = issue as { path?: string; message?: string };
    return [record.path, record.message].filter(Boolean).join(': ');
  });
}

export function errorMessage(error: unknown, fallback: string): string {
  const issues = errorIssues(error);
  if (issues.length > 0) return `${error instanceof ApiError ? error.message : fallback} (${issues.join(', ')})`;
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}
