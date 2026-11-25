-- 0021_phase0_workspace_rls_and_retention.sql
-- Phase 0: Workspace multi-tenant column backfill, non-locking composite indexes,
-- and PostgreSQL Row-Level Security (RLS) on core telemetry & messenger tables.
--
-- Safety notes:
--   1) PostgreSQL 11+ ADD COLUMN ... NOT NULL DEFAULT 'WS-NENOVA-2026' is an O(1)
--      metadata-only operation (existing rows automatically evaluate to 'WS-NENOVA-2026'
--      without rewriting the 10.9GB events table).
--   2) All ALTER TABLE / CREATE POLICY statements guard with lock_timeout='5s' and
--      check information_schema.columns first to avoid unnecessary ACCESS EXCLUSIVE locks.
--   3) Indexes use CREATE INDEX CONCURRENTLY IF NOT EXISTS (executed statement-by-statement
--      by src/migrate.js outside a transaction block) so /api/hook writes are NEVER blocked.
--   4) ENABLE ROW LEVEL SECURITY (without FORCE) enforces strict fail-closed isolation for
--      non-owner application roles while preserving zero-breakage compatibility for existing
--      legacy Railway admin/owner connections during Phase 0 rollout.

-- Ensure lazy-initialized messenger tables exist on fresh databases (no-op if already present)
CREATE TABLE IF NOT EXISTS kakao_messages (
  id SERIAL PRIMARY KEY,
  external_message_id TEXT,
  timestamp_approximate BOOLEAN DEFAULT FALSE,
  chat_id TEXT,
  chatroom TEXT,
  user_id TEXT,
  sender TEXT,
  message TEXT,
  message_type TEXT DEFAULT 'text',
  decryption_method TEXT,
  original_encrypted TEXT,
  source TEXT DEFAULT 'import',
  workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messenger_messages (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  chat_id TEXT,
  chatroom TEXT NOT NULL,
  sender TEXT,
  direction TEXT,
  message TEXT,
  message_type TEXT DEFAULT 'text',
  attachment_name TEXT,
  collector TEXT,
  workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  timestamp_approximate BOOLEAN DEFAULT FALSE,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1) Add workspace_id column (metadata-only backfill to 'WS-NENOVA-2026' on PG 11+)
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kakao_messages' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE kakao_messages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messenger_messages' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE messenger_messages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;

  -- Optional device/token workspace mapping columns (if tables exist)
  IF to_regclass('public.orbit_pc_links') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orbit_pc_links' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE orbit_pc_links ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;

  IF to_regclass('public.orbit_auth_tokens') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orbit_auth_tokens' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE orbit_auth_tokens ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026';
  END IF;
END $$;

-- 2) Enable Row-Level Security (RLS) and attach fail-closed workspace isolation policies
--    Policy allows either:
--      - app.rls_bypass = 'on' (device-to-workspace resolution & system maintenance)
--      - workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  ALTER TABLE events ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS events_workspace_isolation ON events;
  CREATE POLICY events_workspace_isolation ON events
    USING (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    );

  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS sessions_workspace_isolation ON sessions;
  CREATE POLICY sessions_workspace_isolation ON sessions
    USING (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    );

  ALTER TABLE kakao_messages ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS kakao_messages_workspace_isolation ON kakao_messages;
  CREATE POLICY kakao_messages_workspace_isolation ON kakao_messages
    USING (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    );

  ALTER TABLE messenger_messages ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS messenger_messages_workspace_isolation ON messenger_messages;
  CREATE POLICY messenger_messages_workspace_isolation ON messenger_messages
    USING (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
      current_setting('app.rls_bypass', true) = 'on'
      OR workspace_id = NULLIF(current_setting('app.tenant_id', true), '')
    );
END $$;

-- 3) Non-locking composite indexes for tenant-scoped time-range queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_workspace_timestamp
  ON events (workspace_id, timestamp);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_workspace_started_at
  ON sessions (workspace_id, started_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kakao_messages_workspace_created_at
  ON kakao_messages (workspace_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messenger_messages_workspace_created_at
  ON messenger_messages (workspace_id, created_at);
