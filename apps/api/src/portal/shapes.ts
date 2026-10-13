/**
 * Phase 18 — portals and external access (PLAN §37).
 *
 * Shared shapes and limits. A portal is an external, customer-facing application whose users are
 * `users` rows with `type = 'portal'`, bound to one Contact record, authorized ONLY by portal
 * roles (`portal_roles`) — the internal `roles` table is never consulted for a portal request.
 */

import { z } from 'zod';

export const PORTAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _&()/.-]{0,63}$/;
export const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{1,49}$/;
export const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const MAX_PORTALS = 50;
export const MAX_PORTAL_ROLES = 100;
export const MAX_NAV_ITEMS = 50;
export const MAX_PORTAL_DASHBOARDS = 50;
export const MAX_PORTAL_DASHLETS = 50;
/** Same vocabulary and levels as the internal ACL (PLAN §18): yes|all|team|own|no. */
export const PORTAL_LEVELS = ['yes', 'all', 'team', 'own', 'no'] as const;
export const PORTAL_ACTIONS = ['create', 'read', 'edit', 'delete', 'stream'] as const;

export const PortalInputSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().trim().regex(PORTAL_NAME, 'Invalid portal name.'),
  urlPath: z.string().trim().regex(/^\/[A-Za-z0-9/_-]*$/, 'urlPath must start with "/".').max(190).default('/portal'),
  isActive: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const PortalRoleInputSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().trim().min(1).max(150),
  permissions: z.record(z.string(), z.record(z.string(), z.enum(PORTAL_LEVELS))).default({}),
  fieldPermissions: z
    .record(z.string(), z.record(z.string(), z.record(z.string(), z.enum(PORTAL_LEVELS))))
    .default({}),
});

/** Links portal roles to a portal (every portal user of the portal holds them, PLAN §18.2). */
export const PortalRoleLinkSchema = z.object({
  portalRoleIds: z.array(z.string().min(1).max(36)).max(MAX_PORTAL_ROLES),
});

export const PortalNavInputSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  label: z.string().trim().min(1).max(120),
  entity: z.string().trim().regex(ENTITY_NAME).nullable().default(null),
  route: z.string().trim().regex(/^\/[A-Za-z0-9/_-]*$/, 'route must start with "/".').max(190).nullable().default(null),
  icon: z.string().trim().max(64).nullable().default(null),
  position: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

export const PortalDashboardInputSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().trim().min(1).max(190),
  portalRoleId: z.string().trim().min(1).max(36).nullable().default(null),
  layout: z.array(z.unknown()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  isDefault: z.boolean().default(false),
});

export const PortalDashletInputSchema = z.object({
  id: z.string().min(1).max(36).optional(),
  name: z.string().trim().min(1).max(190),
  kind: z.enum(['list', 'chart', 'kpi']),
  position: z.number().int().min(0).max(10_000).default(0),
  config: z.record(z.string(), z.unknown()),
});

/** Dashlet execution config — identical vocabulary to the internal dashlets (PLAN §33). */
export const PortalDashletConfigSchema = z.object({
  entity: z.string().trim().min(1).max(64),
  where: z.unknown().optional(),
  maxSize: z.coerce.number().int().min(1).max(200).default(10),
  groupBy: z.string().trim().min(1).max(64).optional(),
  measure: z.string().trim().min(1).max(64).optional(),
  aggregation: z.enum(['count', 'sum', 'avg']).default('count'),
});

/** Portal user creation/update payload (validated by the identity layer). */
export const PortalUserSchema = z.object({
  userName: z.string().trim().min(2).max(100),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  emailAddress: z.string().email().optional(),
  password: z.string().min(8).optional(),
  contactId: z.string().min(1).max(36),
  portalId: z.string().min(1).max(36),
  portalRoleIds: z.array(z.string().min(1).max(36)).max(MAX_PORTAL_ROLES).default([]),
  isActive: z.boolean().optional(),
});

export interface PortalContextContact {
  id: string;
  name: string | null;
}

/** What a signed-in portal user is allowed to know about itself and its portal. */
export interface PortalContextView {
  portal: { id: string; name: string; urlPath: string };
  user: {
    id: string;
    userName: string;
    firstName: string | null;
    lastName: string | null;
    emailAddress: string | null;
    isActive: boolean;
  };
  contact: PortalContextContact | null;
  roles: { id: string; name: string }[];
  nav: {
    id: string;
    label: string;
    entity: string | null;
    route: string | null;
    icon: string | null;
    position: number;
  }[];
  dashboard: {
    id: string;
    name: string;
    dashlets: { id: string; name: string; kind: string; position: number; config: Record<string, unknown> }[];
  } | null;
}
