'use strict';
/**
 * market-store.js
 * 수익 공유 마켓 2.0 — 기여자 도구 등록 + 사용량 집계 + 수익 정산
 *
 * 테이블:
 *   contributors      — 기여자 등록 (개인/팀/기업/국가)
 *   marketplace_items — 도구/컴포넌트 등록
 *   usage_ledger      — 사용량 일별 집계 (itemId + date)
 *   revenue_distributions — 월말 정산 기록
 */

const { getDb } = require('./db');
const crypto = require('crypto');

// ─── 테이블 초기화 ──────────────────────────────────────────────────────────

function initMarketTables() {
  const db = getDb();
  if (!db) return;

  db.exec(`
    -- 기여자 프로필
    CREATE TABLE IF NOT EXISTS contributors (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL DEFAULT 'local',
      name         TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'individual',  -- individual | team | enterprise | nation
      email        TEXT,
      wallet       TEXT,    -- 수익 수취 계좌/주소 (암호화 권장)
      share_pct    REAL NOT NULL DEFAULT 70.0, -- 기여자 몫 (%)
      status       TEXT NOT NULL DEFAULT 'active',  -- active | suspended | pending
      joined_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors(user_id);

    -- 마켓 아이템 (도구/컴포넌트/템플릿 등)
    CREATE TABLE IF NOT EXISTS marketplace_items (
      id             TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      category       TEXT NOT NULL DEFAULT 'tool',  -- tool | template | workflow | ai-model
      tags           TEXT,                          -- JSON array
      version        TEXT NOT NULL DEFAULT '1.0.0',
      price_type     TEXT NOT NULL DEFAULT 'free',  -- free | subscription | one-time
      price_usd      REAL NOT NULL DEFAULT 0.0,
      status         TEXT NOT NULL DEFAULT 'active',  -- active | draft | suspended
      download_count INTEGER NOT NULL DEFAULT 0,
      use_count      INTEGER NOT NULL DEFAULT 0,
      rating_sum     REAL NOT NULL DEFAULT 0.0,
      rating_count   INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY (contributor_id) REFERENCES contributors(id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_contributor ON marketplace_items(contributor_id);
    CREATE INDEX IF NOT EXISTS idx_items_category    ON marketplace_items(category);
    CREATE INDEX IF NOT EXISTS idx_items_status      ON marketplace_items(status);

    -- 사용량 원장 (일별 집계)
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id             TEXT PRIMARY KEY,
      item_id        TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      user_id        TEXT NOT NULL DEFAULT 'local',
      usage_date     TEXT NOT NULL,  -- YYYY-MM-DD
      usage_count    INTEGER NOT NULL DEFAULT 1,
      revenue_usd    REAL NOT NULL DEFAULT 0.0,
      FOREIGN KEY (item_id) REFERENCES marketplace_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_item ON usage_ledger(item_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_date ON usage_ledger(usage_date);
    CREATE INDEX IF NOT EXISTS idx_ledger_contributor ON usage_ledger(contributor_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique ON usage_ledger(item_id, user_id, usage_date);

    -- 월말 정산 기록
    CREATE TABLE IF NOT EXISTS revenue_distributions (
      id             TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL,
      period         TEXT NOT NULL,   -- YYYY-MM
      total_usage    INTEGER NOT NULL DEFAULT 0,
      gross_usd      REAL NOT NULL DEFAULT 0.0,
      share_pct      REAL NOT NULL DEFAULT 70.0,
      net_usd        REAL NOT NULL DEFAULT 0.0,
      status         TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed
      paid_at        TEXT,
      created_at     TEXT NOT NULL,
      FOREIGN KEY (contributor_id) REFERENCES contributors(id)
    );

    CREATE INDEX IF NOT EXISTS idx_distributions_contributor ON revenue_distributions(contributor_id);
    CREATE INDEX IF NOT EXISTS idx_distributions_period      ON revenue_distributions(period);
  `);
}

// ─── 기여자 CRUD ──────────────────────────────────────────────────────────────

function registerContributor({ userId = 'local', name, type = 'individual', email, wallet, sharePct = 70.0 }) {
  const db = getDb();
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO contributors (id, user_id, name, type, email, wallet, share_pct, status, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, userId, name, type, email || null, wallet || null, sharePct, new Date().toISOString());
  return { id };
}

function getContributor(id) {
  return getDb().prepare('SELECT * FROM contributors WHERE id = ?').get(id) || null;
}

function getContributorByUser(userId) {
  return getDb().prepare('SELECT * FROM contributors WHERE user_id = ? ORDER BY joined_at DESC').all(userId);
}

// ─── 마켓 아이템 CRUD ─────────────────────────────────────────────────────────

function registerItem({ contributorId, name, description, category = 'tool', tags = [], version = '1.0.0', priceType = 'free', priceUsd = 0.0 }) {
  const db = getDb();

  // 기여자 존재 확인
  const contributor = db.prepare('SELECT id FROM contributors WHERE id = ?').get(contributorId);
  if (!contributor) throw new Error('기여자를 찾을 수 없습니다.');

  const id  = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO marketplace_items
      (id, contributor_id, name, description, category, tags, version, price_type, price_usd, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, contributorId, name, description || null, category, JSON.stringify(tags), version, priceType, priceUsd, now, now);
  return { id };
}

function getItem(id) {
  const row = getDb().prepare('SELECT * FROM marketplace_items WHERE id = ?').get(id);
  return row ? deserializeItem(row) : null;
}

function getItems({ category, status = 'active', limit = 50, offset = 0 } = {}) {
  const db = getDb();
  if (category) {
    return db.prepare(`
      SELECT * FROM marketplace_items WHERE status = ? AND category = ?
      ORDER BY use_count DESC LIMIT ? OFFSET ?
    `).all(status, category, limit, offset).map(deserializeItem);
  }
  return db.prepare(`
    SELECT * FROM marketplace_items WHERE status = ?
    ORDER BY use_count DESC LIMIT ? OFFSET ?
  `).all(status, limit, offset).map(deserializeItem);
}

function getItemsByContributor(contributorId) {
  return getDb().prepare(`
    SELECT * FROM marketplace_items WHERE contributor_id = ? ORDER BY created_at DESC
  `).all(contributorId).map(deserializeItem);
}

function rateItem(itemId, score) {
  const s = Math.max(1, Math.min(5, Number(score)));
  getDb().prepare(`
    UPDATE marketplace_items
    SET rating_sum = rating_sum + ?, rating_count = rating_count + 1, updated_at = ?
    WHERE id = ?
  `).run(s, new Date().toISOString(), itemId);
}

// ─── 사용량 기록 ──────────────────────────────────────────────────────────────

function recordUsage({ itemId, userId = 'local', revenueUsd = 0.0 }) {
  const db   = getDb();
  const item = db.prepare('SELECT id, contributor_id FROM marketplace_items WHERE id = ?').get(itemId);
  if (!item) return;

  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const id    = crypto.randomBytes(8).toString('hex');

  // UPSERT: 같은 (item_id, user_id, date) 이면 카운트 증가
  db.prepare(`
    INSERT INTO usage_ledger (id, item_id, contributor_id, user_id, usage_date, usage_count, revenue_usd)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(item_id, user_id, usage_date)
    DO UPDATE SET usage_count = usage_count + 1, revenue_usd = revenue_usd + excluded.revenue_usd
  `).run(id, itemId, item.contributor_id, userId, today, revenueUsd);

  // use_count 업데이트
  db.prepare('UPDATE marketplace_items SET use_count = use_count + 1 WHERE id = ?').run(itemId);
}

// ─── 리더보드 ─────────────────────────────────────────────────────────────────

function getLeaderboard({ period = 7, limit = 20 } = {}) {
  const db   = getDb();
  const from = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return db.prepare(`
    SELECT
      mi.id,
      mi.name,
      mi.category,
      mi.price_type,
      c.name  AS contributor_name,
      c.type  AS contributor_type,
      SUM(ul.usage_count) AS period_usage,
      SUM(ul.revenue_usd) AS period_revenue,
      ROUND(CAST(mi.rating_sum AS REAL) / NULLIF(mi.rating_count, 0), 1) AS avg_rating,
      mi.use_count AS total_usage
    FROM marketplace_items mi
    JOIN contributors c ON mi.contributor_id = c.id
    LEFT JOIN usage_ledger ul ON mi.id = ul.item_id AND ul.usage_date >= ?
    WHERE mi.status = 'active'
    GROUP BY mi.id
    ORDER BY period_usage DESC, mi.use_count DESC
    LIMIT ?
  `).all(from, limit);
}

// ─── 수익 현황 조회 ───────────────────────────────────────────────────────────

function getRevenueByContributor({ contributorId, months = 3 } = {}) {
  const db   = getDb();
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  const fromDate = from.toISOString().slice(0, 10);

  const monthly = db.prepare(`
    SELECT
      substr(usage_date, 1, 7) AS month,
      SUM(usage_count)         AS total_usage,
      SUM(revenue_usd)         AS gross_usd
    FROM usage_ledger
    WHERE contributor_id = ? AND usage_date >= ?
    GROUP BY month
    ORDER BY month DESC
  `).all(contributorId, fromDate);

  const contributor = getContributor(contributorId);
  return {
    contributor,
    monthly: monthly.map(row => ({
      ...row,
      net_usd: row.gross_usd * ((contributor?.share_pct ?? 70) / 100),
    })),
  };
}

// ─── 월말 정산 ────────────────────────────────────────────────────────────────

function runMonthlyDistribution(period) {
  const db = getDb();
  // period: 'YYYY-MM' (없으면 지난달)
  if (!period) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    period = d.toISOString().slice(0, 7);
  }

  const rows = db.prepare(`
    SELECT
      contributor_id,
      SUM(usage_count) AS total_usage,
      SUM(revenue_usd) AS gross_usd
    FROM usage_ledger
    WHERE substr(usage_date, 1, 7) = ?
    GROUP BY contributor_id
  `).all(period);

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO revenue_distributions
      (id, contributor_id, period, total_usage, gross_usd, share_pct, net_usd, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const contributor = getContributor(row.contributor_id);
      const sharePct    = contributor?.share_pct ?? 70;
      const netUsd      = row.gross_usd * (sharePct / 100);
      const id          = crypto.randomBytes(8).toString('hex');
      insert.run(id, row.contributor_id, period, row.total_usage, row.gross_usd, sharePct, netUsd, now);
    }
  });
  tx();

  return rows.length;
}

function getDistributions({ contributorId, period } = {}) {
  const db = getDb();
  if (contributorId && period) {
    return db.prepare('SELECT * FROM revenue_distributions WHERE contributor_id = ? AND period = ? ORDER BY created_at DESC').all(contributorId, period);
  }
  if (contributorId) {
    return db.prepare('SELECT * FROM revenue_distributions WHERE contributor_id = ? ORDER BY period DESC').all(contributorId);
  }
  if (period) {
    return db.prepare('SELECT * FROM revenue_distributions WHERE period = ? ORDER BY created_at DESC').all(period);
  }
  return db.prepare('SELECT * FROM revenue_distributions ORDER BY period DESC LIMIT 100').all();
}

// ─── 직렬화 헬퍼 ─────────────────────────────────────────────────────────────

function deserializeItem(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    avgRating: row.rating_count > 0 ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : null,
  };
}

module.exports = {
  initMarketTables,
  // 기여자
  registerContributor,
  getContributor,
  getContributorByUser,
  // 아이템
  registerItem,
  getItem,
  getItems,
  getItemsByContributor,
  rateItem,
  // 사용량
  recordUsage,
  // 리더보드 + 수익
  getLeaderboard,
  getRevenueByContributor,
  // 정산
  runMonthlyDistribution,
  getDistributions,
};
