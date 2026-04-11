-- 0010_unified_events.sql
-- 통합 이벤트 버스 테이블: 4개 시스템(ERP, Orbit, AI Trainer, nenova_agent) 이벤트 통합

CREATE TABLE IF NOT EXISTS unified_events (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  source          TEXT NOT NULL,           -- 'erp-ui' | 'orbit' | 'ai-trainer' | 'nenova-agent'
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id         TEXT,
  workspace_id    TEXT NOT NULL DEFAULT 'nenova',
  session_id      TEXT,
  data            JSONB NOT NULL DEFAULT '{}',
  metadata        JSONB DEFAULT '{}',
  correlation_id  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ue_type        ON unified_events(type);
CREATE INDEX IF NOT EXISTS idx_ue_source      ON unified_events(source);
CREATE INDEX IF NOT EXISTS idx_ue_timestamp   ON unified_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_ue_user        ON unified_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ue_workspace   ON unified_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ue_correlation ON unified_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_ue_data_gin    ON unified_events USING GIN (data);

-- 30일 이상 오래된 이벤트 아카이브용 (Phase 2에서 자동 정리 구현)
-- 현재는 수동 관리

-- 이벤트 발행 시 PG NOTIFY 트리거
CREATE OR REPLACE FUNCTION notify_unified_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('unified_events', json_build_object(
    'id', NEW.id,
    'type', NEW.type,
    'source', NEW.source,
    'timestamp', NEW.timestamp,
    'user_id', NEW.user_id,
    'workspace_id', NEW.workspace_id,
    'correlation_id', NEW.correlation_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_unified_event_notify ON unified_events;
CREATE TRIGGER trg_unified_event_notify
  AFTER INSERT ON unified_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_unified_event();
