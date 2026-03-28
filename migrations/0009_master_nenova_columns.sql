-- master_products: nenova sync에 필요한 컬럼들 추가
ALTER TABLE master_products
  ADD COLUMN IF NOT EXISTS nenova_key  TEXT,
  ADD COLUMN IF NOT EXISTS flower_name TEXT,
  ADD COLUMN IF NOT EXISTS country     TEXT,
  ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seen_count  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS synced_at   TIMESTAMPTZ;

-- master_customers: nenova sync에 필요한 컬럼들 추가
ALTER TABLE master_customers
  ADD COLUMN IF NOT EXISTS nenova_key  TEXT,
  ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seen_count  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS synced_at   TIMESTAMPTZ;
