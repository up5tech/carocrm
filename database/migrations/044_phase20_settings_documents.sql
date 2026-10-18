-- Phase 20 — Settings documents (PLAN_Phase_20_Settings_UX.md §6.1, §15.1)
--
-- Additive only (AGENTS.md §3.5, §3.6): no table is created, dropped, truncated or rewritten, no
-- column changes meaning, and no existing row is overwritten. Every insert is guarded by
-- WHERE NOT EXISTS, so re-applying this migration — or applying it to an instance where an
-- administrator has already configured the menu — changes nothing.
--
-- The documents live in the existing `app_settings` table, one row per document, in the shape the
-- Phase 20 registry writes: `{version, value, updatedAt, updatedBy}`. A row that does not exist at
-- all is served from the registered defaults, so this seed only makes the baseline explicit and
-- reviewable in the database.

INSERT INTO app_settings (name, data)
SELECT 'navigation', '{"version":1,"value":{"items":[],"groups":[],"accentPalette":["blue","green","orange","red","purple","cyan","magenta","gold"]}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'navigation');

INSERT INTO app_settings (name, data)
SELECT 'security', '{"version":1,"value":{"password":{"minLength":8,"requireUppercase":false,"requireNumber":false,"requireSymbol":false},"session":{"idleLogoutMinutes":0,"singleSession":false},"loginNotice":null}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'security');

INSERT INTO app_settings (name, data)
SELECT 'fileStorage', '{"version":1,"value":{"maxUploadSizeMb":25,"allowedExtensions":["png","jpg","jpeg","gif","webp","pdf","csv","xlsx","docx"]}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'fileStorage');

INSERT INTO app_settings (name, data)
SELECT 'notifications', '{"version":1,"value":{"digest":"daily","emailOnAssignment":true,"emailOnStreamUpdate":false}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'notifications');
