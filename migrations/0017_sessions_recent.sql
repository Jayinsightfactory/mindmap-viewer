CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_recent ON sessions (started_at DESC);
