-- master_products: first_seen 컬럼 추가 (self-evolve.js 건강도 추적용)
ALTER TABLE master_products ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW();

-- 기존 데이터에 first_seen 채우기 (created_at 기준)
UPDATE master_products SET first_seen = created_at WHERE first_seen IS NULL;

-- master_customers: first_seen 도 추가 (일관성)
ALTER TABLE master_customers ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW();
UPDATE master_customers SET first_seen = created_at WHERE first_seen IS NULL;
