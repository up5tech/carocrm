-- Phase 7A internationalization (PLAN §41): per-user locale/timezone columns and the
-- instance-level i18n settings row. Additive only — no existing column or data is touched.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Instance defaults only on first apply: never overwrite an administrator's configuration.
INSERT INTO app_settings (name, data)
SELECT 'i18n', '{"defaultLocale":"en","enabledLocales":["en","vi"],"defaultTimezone":"UTC"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'i18n');
