-- Legacy sessions may contain duplicate IDs: preserve rows, use a nonunique index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_id_lookup ON sessions (id);
