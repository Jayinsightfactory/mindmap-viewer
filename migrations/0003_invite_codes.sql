-- Invite codes table (timed invites)
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  used_by TEXT,
  max_uses INTEGER DEFAULT 1,
  use_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invite_ws ON invite_codes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invite_exp ON invite_codes(expires_at);
