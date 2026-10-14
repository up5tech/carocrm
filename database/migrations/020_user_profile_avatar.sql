-- The signed-in user's own profile page: an avatar reference for the user.
--
-- Additive only — a nullable column linked to `attachments` with ON DELETE SET NULL, so deleting
-- the stored file never blocks the delete and never leaves a dangling reference. The other fields
-- the profile edits (first/last name, email, phone, title) already exist since 001.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id TEXT REFERENCES attachments (id) ON DELETE SET NULL;
