-- Add status column to workspace_members (if not exists)
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
