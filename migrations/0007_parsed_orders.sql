-- parsed_orders: 클립보드/카카오 발주서 자동 파싱 결과 저장
CREATE TABLE IF NOT EXISTS parsed_orders (
  id               SERIAL PRIMARY KEY,
  source_event_id  TEXT NOT NULL,
  source_type      TEXT NOT NULL,
  customer         TEXT,
  product          TEXT,
  quantity         INTEGER,
  unit             TEXT,
  action           TEXT,
  raw_text         TEXT,
  confidence       REAL DEFAULT 0.9,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parsed_orders_source ON parsed_orders(source_event_id);
CREATE INDEX IF NOT EXISTS idx_parsed_orders_customer ON parsed_orders(customer);
CREATE INDEX IF NOT EXISTS idx_parsed_orders_created ON parsed_orders(created_at DESC);
