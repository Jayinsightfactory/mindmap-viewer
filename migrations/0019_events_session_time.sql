CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_session_time ON events (session_id, timestamp);
