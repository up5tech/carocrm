-- Phase 19-S — module identity rename: `ua-sales` → `sales` (PLAN_Phase_19_Sales.md §1, §14).
--
-- The Sales settings document lives in the kernel's `app_settings` table under the module's name
-- (`apps/api/src/sales/sales-settings.service.ts`). Renaming the module must not silently discard an
-- installation's configured policy, so the existing row is carried over instead of being abandoned
-- and re-created with defaults.
--
-- Additive and narrow: one row, one verified predicate. The `NOT EXISTS` guard means that if a
-- `sales` row already exists (a fresh install, or an operator who set it up under the new name) the
-- old row is left untouched rather than colliding on the `app_settings` primary key.
--
-- No table, column, index or record other than this single settings row is read or written.

UPDATE app_settings
   SET name = 'sales',
       modified_at = now()
 WHERE name = 'uaSales'
   AND NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'sales');
