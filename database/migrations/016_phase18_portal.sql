-- Phase 18 — portals and external access (PLAN §37 / PLAN Phase 18).
--
-- A portal is an external, customer-facing application. Portal users are `users` rows with
-- `type = 'portal'` bound to one Contact record, and their authority comes ONLY from portal
-- roles (`portal_roles`) — never from the internal `roles` table. Record visibility for a
-- portal user is restricted to their contact/account and one link hop away from it, enforced
-- server-side by the portal ACL policy (apps/api/src/portal/portal-policy.service.ts).
--
-- Additive only (AGENTS.md §3.5): new tables plus nullable columns on `users`.

CREATE TABLE IF NOT EXISTS portals (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url_path    TEXT NOT NULL DEFAULT '/portal',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  settings    JSONB NOT NULL DEFAULT '{}',
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_portals_url_path CHECK (url_path ~ '^/[A-Za-z0-9/_-]*$')
);

-- Portal roles are a separate role space on purpose (PLAN §37): an internal role can never be
-- assigned to a portal user and a portal role can never be assigned to an internal user.
CREATE TABLE IF NOT EXISTS portal_roles (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  permissions       JSONB NOT NULL DEFAULT '{}',
  field_permissions JSONB NOT NULL DEFAULT '{}',
  is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roles granted to every portal user of a portal (PLAN §18.2: roles through portal roles).
CREATE TABLE IF NOT EXISTS portals_portal_roles (
  portal_id      TEXT NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
  portal_role_id TEXT NOT NULL REFERENCES portal_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (portal_id, portal_role_id)
);

-- Portal navigation: each entry either lists one metadata entity or points at a fixed route.
CREATE TABLE IF NOT EXISTS portal_nav_items (
  id         TEXT PRIMARY KEY,
  portal_id  TEXT NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  entity     TEXT,
  route      TEXT,
  icon       TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_portal_nav_target CHECK (entity IS NOT NULL OR route IS NOT NULL),
  CONSTRAINT chk_portal_nav_route CHECK (route IS NULL OR route ~ '^/[A-Za-z0-9/_-]*$')
);
CREATE INDEX IF NOT EXISTS idx_portal_nav_portal ON portal_nav_items (portal_id, position);

-- Portal dashboards: `portal_role_id` set = shown to users holding that portal role; the row
-- with `is_default` and no role is the fallback for everyone else in the portal.
CREATE TABLE IF NOT EXISTS portal_dashboards (
  id              TEXT PRIMARY KEY,
  portal_id       TEXT NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
  portal_role_id  TEXT REFERENCES portal_roles (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  layout          JSONB NOT NULL DEFAULT '[]',
  config          JSONB NOT NULL DEFAULT '{}',
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_dashboards_portal ON portal_dashboards (portal_id, is_default);
-- One default dashboard per portal, enforced by the database rather than by the API.
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_dashboards_one_default
  ON portal_dashboards (portal_id) WHERE is_default AND portal_role_id IS NULL;

CREATE TABLE IF NOT EXISTS portal_dashlets (
  id           TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES portal_dashboards (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'list',
  position     INTEGER NOT NULL DEFAULT 0,
  config       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_portal_dashlets_kind CHECK (kind IN ('list', 'chart', 'kpi'))
);
CREATE INDEX IF NOT EXISTS idx_portal_dashlets_dashboard ON portal_dashlets (dashboard_id, position);

-- Portal user linkage on `users` (PLAN §37: portal assignment + contact/account relation).
-- `portal_role_ids` holds the portal roles assigned directly to this user, on top of the
-- roles linked to the portal itself. Internal `assigned_role_ids` stays empty for portal
-- users and is ignored by the portal policy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS portal_id TEXT REFERENCES portals (id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS portal_role_ids JSONB NOT NULL DEFAULT '[]';
