-- Add platform column to user_tokens if it doesn't already exist.
-- This was previously added manually but never had a migration,
-- risking token save failures if the database is recreated.
ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS platform TEXT;
