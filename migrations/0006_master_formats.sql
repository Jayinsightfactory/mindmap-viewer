-- master_formats: 텍스트 패턴/포맷 마스터 (자동화 엔진 파싱용)
CREATE TABLE IF NOT EXISTS master_formats (
  id           SERIAL PRIMARY KEY,
  pattern      TEXT NOT NULL,
  format_type  TEXT NOT NULL,
  parser_regex TEXT,
  seen_count   INTEGER DEFAULT 0,
  source       TEXT DEFAULT 'manual',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_master_formats_type ON master_formats(format_type);
