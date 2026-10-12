CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_user_recent ON sessions (user_id, started_at DESC);
