-- 0021_phase0_workspace_rls_and_retention.down.sql
-- Complete rollback for 0021_phase0_workspace_rls_and_retention.sql
-- Run manually (excluded from automatic forward migration runner in src/migrate.js).

-- 1) Drop RLS policies and disable RLS
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public.events') IS NOT NULL THEN
    DROP POLICY IF EXISTS events_workspace_isolation ON events;
    ALTER TABLE events DISABLE ROW LEVEL SECURITY;
  END IF;

  IF to_regclass('public.sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS sessions_workspace_isolation ON sessions;
    ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
  END IF;

  IF to_regclass('public.kakao_messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS kakao_messages_workspace_isolation ON kakao_messages;
    ALTER TABLE kakao_messages DISABLE ROW LEVEL SECURITY;
  END IF;

  IF to_regclass('public.messenger_messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS messenger_messages_workspace_isolation ON messenger_messages;
    ALTER TABLE messenger_messages DISABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- 2) Drop composite indexes concurrently (non-locking)
DROP INDEX CONCURRENTLY IF EXISTS idx_events_workspace_timestamp;
DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_workspace_started_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_kakao_messages_workspace_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_messenger_messages_workspace_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_orbit_auth_tokens_created_at;

-- 3) Remove workspace_id columns added by 0021
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public.events') IS NOT NULL THEN
    ALTER TABLE events DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF to_regclass('public.sessions') IS NOT NULL THEN
    ALTER TABLE sessions DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF to_regclass('public.kakao_messages') IS NOT NULL THEN
    ALTER TABLE kakao_messages DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF to_regclass('public.messenger_messages') IS NOT NULL THEN
    ALTER TABLE messenger_messages DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF to_regclass('public.orbit_pc_links') IS NOT NULL THEN
    ALTER TABLE orbit_pc_links DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF to_regclass('public.orbit_auth_tokens') IS NOT NULL THEN
    ALTER TABLE orbit_auth_tokens DROP COLUMN IF EXISTS workspace_id;
  END IF;
END $$;

-- 4) Remove migration tracking record
DELETE FROM _migrations WHERE name = '0021_phase0_workspace_rls_and_retention.sql';
