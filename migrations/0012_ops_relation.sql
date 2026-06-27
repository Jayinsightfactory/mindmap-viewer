-- 0012_ops_relation.sql
-- 회사 업무 온톨로지 관계 저장 (1급 데이터) — docs/nenova-ontology-spec.md §3
-- audit P3: "표준 relation store가 약하다" 해소.
-- 런타임에선 routes/ops-ontology.js ensureOpsTables()가 동일 DDL을 보장(멱등).

CREATE TABLE IF NOT EXISTS ops_relation (
  id            TEXT PRIMARY KEY,                 -- rel:{relType}:{fromRef}:{toRef}
  rel_type      TEXT NOT NULL,                    -- person_performed_action / action_in_app / action_in_room / screen_observed_action / talk_triggered_action / automation_candidate_for_process ...
  from_type     TEXT NOT NULL,                    -- Person / Action / ...
  from_ref      TEXT NOT NULL,                    -- 객체 id 또는 값키 (userId / actId / appName / room)
  to_type       TEXT NOT NULL,
  to_ref        TEXT NOT NULL,
  attrs         JSONB DEFAULT '{}',
  source        TEXT NOT NULL DEFAULT 'orbit',    -- orbit / erp-ui / nenova-agent / ai-trainer / computer-use-lab
  confidence    NUMERIC(4,3) DEFAULT 0.34,        -- 1소스=0.34 / 2=0.67 / 3+=1.0 (orbit_entity_golden과 호환)
  evidence      JSONB DEFAULT '{}',               -- {"events": ["kb-..","sa-.."]}
  ts            TIMESTAMPTZ,
  workspace_id  TEXT DEFAULT 'nenova',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opsrel_from ON ops_relation(from_ref);
CREATE INDEX IF NOT EXISTS idx_opsrel_type ON ops_relation(rel_type);
CREATE INDEX IF NOT EXISTS idx_opsrel_to   ON ops_relation(to_ref);

-- Action 객체는 별도 테이블 없이 unified_events(type='work.action', source='orbit')에 저장(0010 재사용).
