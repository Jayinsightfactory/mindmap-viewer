-- 0011_entity_golden.sql
-- Layer 2: Entity Resolution — Person/Customer/Document/Task 골든 레코드
-- Senzing/Quantexa "골든 레코드" + Palantir Ontology 객체 패턴.

-- ─────────────────────────────────────────────────────────────────────────────
-- 골든 레코드: 다중 소스에서 같은 실세계 엔티티로 해소된 객체
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orbit_entity_golden (
  id              TEXT PRIMARY KEY,                 -- ULID
  entity_type     TEXT NOT NULL,                    -- 'person' | 'customer' | 'document' | 'task'
  display_name    TEXT NOT NULL,                    -- 사람의 표시명/거래처명/문서명
  attributes      JSONB NOT NULL DEFAULT '{}',      -- 표준화된 속성 (이름, 이메일, 사번, 별칭 등)
  source_refs     JSONB NOT NULL DEFAULT '{}',      -- {"orbit": ["DESKTOP-XXX"], "erp-ui": ["UserKey:7"], "nenova-agent": ["room:대명"]}
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0,  -- 0.000~1.000 골든 등급 (3소스=1.0)
  source_count    SMALLINT NOT NULL DEFAULT 0,      -- 일치한 소스 개수 (1=추정 / 2=확인 / 3=골든)
  workspace_id    TEXT NOT NULL DEFAULT 'nenova',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eg_type            ON orbit_entity_golden(entity_type);
CREATE INDEX IF NOT EXISTS idx_eg_workspace       ON orbit_entity_golden(workspace_id);
CREATE INDEX IF NOT EXISTS idx_eg_confidence      ON orbit_entity_golden(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_eg_attrs_gin       ON orbit_entity_golden USING GIN (attributes);
CREATE INDEX IF NOT EXISTS idx_eg_sources_gin     ON orbit_entity_golden USING GIN (source_refs);

-- ─────────────────────────────────────────────────────────────────────────────
-- 매칭 로그: 모든 매칭 시도와 근거 — Provenance (Palantir 패턴)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orbit_entity_match_log (
  id              BIGSERIAL PRIMARY KEY,
  golden_id       TEXT REFERENCES orbit_entity_golden(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,                    -- 'orbit' | 'erp-ui' | 'nenova-agent'
  source_ref      TEXT NOT NULL,                    -- 원본 식별자 (hostname / UserKey / room_name 등)
  match_type      TEXT NOT NULL,                    -- 'exact' | 'fuzzy' | 'manual' | 'temporal'
  match_score     NUMERIC(4,3) NOT NULL,
  evidence        JSONB,                            -- 매칭 근거 (어떤 필드가 일치했나)
  matcher_version TEXT,                             -- 매칭 알고리즘 버전 (재현성)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eml_golden    ON orbit_entity_match_log(golden_id);
CREATE INDEX IF NOT EXISTS idx_eml_source    ON orbit_entity_match_log(source, source_ref);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at 자동 갱신 트리거
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_entity_golden_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_eg_touch ON orbit_entity_golden;
CREATE TRIGGER trg_eg_touch
  BEFORE UPDATE ON orbit_entity_golden
  FOR EACH ROW
  EXECUTE FUNCTION touch_entity_golden_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 시드: 9 PC 매핑(orbit_pc_links)에서 person 골든 즉시 생성용 헬퍼 뷰
-- 실제 시드는 entity-resolution/seed-from-pc-links.js 에서 실행
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE orbit_entity_golden IS
  '엔티티 골든 레코드. 다중 소스(orbit/erp-ui/nenova-agent) 매칭으로 해소된 실세계 객체. confidence=1.0=3소스 골든.';
COMMENT ON TABLE orbit_entity_match_log IS
  '엔티티 매칭 시도 기록. Provenance — 모든 매칭의 근거와 알고리즘 버전 추적.';
