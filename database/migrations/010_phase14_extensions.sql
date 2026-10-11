-- Phase 14 — extension installation state (PLAN §38.3).
--
-- `installed_extensions` is the *activation* record: a package is merely present on disk until an
-- administrator installs it. The API and the worker read it at boot to decide which packages load
-- and in what order (module `order`, dependencies first).
--
-- `extension_migrations` is a per-extension ledger, deliberately separate from the kernel's
-- `schema_migrations`: an extension can neither claim nor re-run a core migration. Nothing here
-- drops or rewrites anything — uninstalling keeps the tables an extension created.

CREATE TABLE IF NOT EXISTS installed_extensions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  order_num     INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  manifest      JSONB NOT NULL,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extension_migrations (
  extension_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_id, name)
);

CREATE INDEX IF NOT EXISTS idx_installed_extensions_enabled ON installed_extensions (enabled);