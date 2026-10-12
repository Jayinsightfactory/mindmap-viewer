CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_user_time ON events (user_id, timestamp);
