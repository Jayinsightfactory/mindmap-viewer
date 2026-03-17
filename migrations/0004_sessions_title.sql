-- Add title column to sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
