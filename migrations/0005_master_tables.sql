-- master_products: 제품/상품 마스터 (nenova ERP 동기화)
CREATE TABLE IF NOT EXISTS master_products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  name_en     TEXT,
  name_alias  TEXT,
  category    TEXT,
  origin      TEXT,
  unit        TEXT,
  code        TEXT,
  source      TEXT DEFAULT 'manual',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- master_customers: 거래처 마스터 (카카오톡 방 매칭용)
CREATE TABLE IF NOT EXISTS master_customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  name_alias  TEXT,
  region      TEXT,
  kakao_room  TEXT,
  staff       TEXT,
  source      TEXT DEFAULT 'manual',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_master_products_name ON master_products(name);
CREATE INDEX IF NOT EXISTS idx_master_products_category ON master_products(category);
CREATE INDEX IF NOT EXISTS idx_master_customers_name ON master_customers(name);
CREATE INDEX IF NOT EXISTS idx_master_customers_kakao ON master_customers(kakao_room);
