'use strict';
/**
 * src/intelligence/entity-resolution/bootstrap-customer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 2 부트스트랩: erp-ui 이벤트에서 거래처(Customer) 추출 → 골든 시드
 *
 * 입력: unified_events (source='erp-ui')의 data.CustKey + data.CustName
 *        (orders/shipment/estimate 모두 거래처 식별자 보유)
 *
 * 출력: orbit_entity_golden(entity_type='customer')
 *   - id: ULID
 *   - display_name: CustName
 *   - attributes: { name, cust_key, aliases: [] }
 *   - source_refs: { 'erp-ui': ['CustKey:123'] }
 *   - confidence = 0.333 (1/3 소스)
 *
 * 클립보드 텍스트(orbit) 와 카톡 room_name(nenova-agent) 매칭은 후속 매처가 처리.
 *
 * 멱등 실행: 같은 cust_key 재실행 시 변경 없음.
 *
 * CLI: node src/intelligence/entity-resolution/bootstrap-customer.js [--dry-run]
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');
const MATCHER_VERSION = 'customer-bootstrap/1.0';

/**
 * 1회 부트스트랩.
 * @param {import('pg').Pool} pool
 * @param {object} opts { dryRun, since }
 */
async function bootstrap(pool, opts = {}) {
  const dryRun = !!opts.dryRun;
  const since = opts.since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // 1. erp-ui 이벤트에서 distinct (CustKey, CustName) 추출
  // CustKey/CustName 외에 거래처필드가 다양할 수 있어 우선순위로 처리
  const { rows: customers } = await pool.query(`
    SELECT
      COALESCE(data->>'CustKey', data->>'custKey', data->>'cust_key') AS cust_key,
      COALESCE(data->>'CustName', data->>'custName', data->>'cust_name') AS cust_name,
      COUNT(*) AS event_count
    FROM unified_events
    WHERE source = 'erp-ui'
      AND timestamp > $1
      AND (data ? 'CustKey' OR data ? 'custKey' OR data ? 'cust_key')
    GROUP BY 1, 2
    HAVING COALESCE(data->>'CustKey', data->>'custKey', data->>'cust_key') IS NOT NULL
  `, [since]);

  if (customers.length === 0) {
    return { candidates: 0, seeded: 0, skipped: 0 };
  }

  // 2. 기존 customer 골든의 source_refs['erp-ui'] 인덱스 (중복 방지)
  const { rows: existing } = await pool.query(`
    SELECT id, source_refs FROM orbit_entity_golden WHERE entity_type = 'customer'
  `);
  const indexedKeys = new Set();
  for (const e of existing) {
    for (const ref of (e.source_refs?.['erp-ui'] || [])) indexedKeys.add(ref);
  }

  let seeded = 0, skipped = 0;
  for (const c of customers) {
    if (!c.cust_key) { skipped++; continue; }
    const ref = `CustKey:${c.cust_key}`;
    if (indexedKeys.has(ref)) { skipped++; continue; }

    const id = ulid();
    const displayName = c.cust_name || `(미상 거래처 ${c.cust_key})`;
    const attrs = {
      name: displayName,
      cust_key: c.cust_key,
      aliases: [],
      observed_event_count: parseInt(c.event_count, 10),
    };
    const sourceRefs = { 'erp-ui': [ref] };

    if (!dryRun) {
      await pool.query(`
        INSERT INTO orbit_entity_golden
          (id, entity_type, display_name, attributes, source_refs, confidence, source_count)
        VALUES ($1, 'customer', $2, $3, $4, 0.333, 1)
      `, [id, displayName, JSON.stringify(attrs), JSON.stringify(sourceRefs)]);

      await pool.query(`
        INSERT INTO orbit_entity_match_log
          (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
        VALUES ($1, 'erp-ui', $2, 'exact', 1.000, $3, $4)
      `, [id, ref, JSON.stringify({ via: 'erp-ui CustKey distinct', cust_name: c.cust_name }), MATCHER_VERSION]);
    }
    seeded++;
  }

  return { candidates: customers.length, seeded, skipped };
}

module.exports = { bootstrap };

if (require.main === module) {
  require('dotenv').config();
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 미설정'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dryRun = process.argv.includes('--dry-run');

  bootstrap(pool, { dryRun })
    .then(r => { console.log(JSON.stringify(r, null, 2)); return pool.end(); })
    .catch(e => { console.error(e); pool.end(); process.exit(1); });
}
