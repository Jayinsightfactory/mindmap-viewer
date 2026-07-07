'use strict';
/**
 * src/intelligence/entity-resolution/match-person-erp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 2 매처: ERP UserID(`erp-ui` 이벤트의 user_id) → Person 골든 레코드
 *
 * 매칭 전략 (보수적 — 오매칭 비용이 큼):
 *   1) exact: golden.attributes.user_id == erp.user_id   → score 1.0
 *   2) exact: golden.attributes.aliases ?| [erp.user_id] → score 1.0
 *   3) fuzzy: golden.attributes.name 토큰 vs erp.user_id (대소문자/공백/-_ 무시) → score 0.7
 *
 * 매칭 시:
 *   - source_refs['erp-ui'] 에 erp.user_id 추가 (중복 제거)
 *   - source_count, confidence 재계산 (count/3)
 *   - match_log 기록 (provenance)
 *
 * 멱등: 같은 (golden_id, 'erp-ui', user_id) 매칭은 스킵.
 *
 * CLI: node src/intelligence/entity-resolution/match-person-erp.js [--dry-run]
 * ─────────────────────────────────────────────────────────────────────────────
 */

const MATCHER_VERSION = 'person-erp/1.0';

// config/erp-user-map.json: ERP 로그인ID → 실명 매핑 (자동 fuzzy 불가 시 사용)
let _erpUserMap = null;
function _getErpUserMap() {
  if (_erpUserMap) return _erpUserMap;
  try {
    _erpUserMap = require('../../../config/erp-user-map.json');
  } catch (_) {
    _erpUserMap = {};
  }
  return _erpUserMap;
}

function _norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-.]/g, '');
}

/**
 * 1회 매칭 사이클.
 * @param {import('pg').Pool} pool
 * @param {object} opts { dryRun, since }
 */
async function matchOnce(pool, opts = {}) {
  const dryRun = !!opts.dryRun;
  const since = opts.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. erp-ui 이벤트에서 distinct user_id 추출
  const { rows: erpUsers } = await pool.query(`
    SELECT DISTINCT user_id
      FROM unified_events
     WHERE source = 'erp-ui'
       AND user_id IS NOT NULL
       AND user_id <> ''
       AND timestamp > $1
  `, [since]);

  if (erpUsers.length === 0) {
    return { candidates: 0, matched: 0, skipped: 0, ambiguous: 0 };
  }

  // 2. person 골든 전체 로드 (수가 적음 — 보통 < 100)
  const { rows: persons } = await pool.query(`
    SELECT id, display_name, attributes, source_refs, source_count
      FROM orbit_entity_golden
     WHERE entity_type = 'person'
  `);

  let matched = 0, skipped = 0, ambiguous = 0;

  for (const erp of erpUsers) {
    const erpUid = erp.user_id;
    const normErp = _norm(erpUid);

    // 이미 다른 골든의 erp-ui refs 에 등록돼 있으면 스킵 (멱등)
    const already = persons.find(p => (p.source_refs?.['erp-ui'] || []).includes(erpUid));
    if (already) { skipped++; continue; }

    // 3. 후보 매칭
    const hits = [];
    // (0) config map: ERP ID → 실명 직접 매핑
    const mapEntry = _getErpUserMap()[erpUid];
    if (mapEntry?.name) {
      const normMapped = _norm(mapEntry.name);
      for (const p of persons) {
        const a = p.attributes || {};
        const pName = _norm(a.name || p.display_name || '');
        if (pName && (pName === normMapped || pName.includes(normMapped) || normMapped.includes(pName))) {
          hits.push({ p, score: 1.0, type: 'exact', via: 'config-map' }); break;
        }
      }
    }
    if (hits.length === 0) {
      for (const p of persons) {
        const a = p.attributes || {};
        // (1) exact user_id
        if (a.user_id === erpUid) { hits.push({ p, score: 1.0, type: 'exact', via: 'attributes.user_id' }); continue; }
        // (2) aliases
        if (Array.isArray(a.aliases) && a.aliases.includes(erpUid)) {
          hits.push({ p, score: 1.0, type: 'exact', via: 'attributes.aliases' }); continue;
        }
        // (3) fuzzy name
        if (a.name && _norm(a.name) === normErp) {
          hits.push({ p, score: 0.7, type: 'fuzzy', via: 'attributes.name~user_id' });
        }
      }
    }

    if (hits.length === 0) continue;
    if (hits.length > 1) {
      // 동점 처리: 점수 최고만, 그래도 둘 이상이면 ambiguous (사람 검토)
      const top = Math.max(...hits.map(h => h.score));
      const tops = hits.filter(h => h.score === top);
      if (tops.length > 1) { ambiguous++; continue; }
      hits.length = 0; hits.push(tops[0]);
    }

    const hit = hits[0];
    const g = hit.p;
    const newRefs = { ...(g.source_refs || {}) };
    newRefs['erp-ui'] = [...new Set([...(newRefs['erp-ui'] || []), erpUid])];
    const newCount = Object.keys(newRefs).filter(k => (newRefs[k] || []).length > 0).length;
    const newConf = Number((newCount / 3).toFixed(3));

    if (!dryRun) {
      await pool.query(`
        UPDATE orbit_entity_golden
           SET source_refs = $1, source_count = $2, confidence = $3
         WHERE id = $4
      `, [JSON.stringify(newRefs), newCount, newConf, g.id]);

      await pool.query(`
        INSERT INTO orbit_entity_match_log
          (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
        VALUES ($1, 'erp-ui', $2, $3, $4, $5, $6)
      `, [g.id, erpUid, hit.type, hit.score,
          JSON.stringify({ via: hit.via, prev_count: g.source_count, new_count: newCount, new_conf: newConf }),
          MATCHER_VERSION]);
    }
    matched++;
  }

  return { candidates: erpUsers.length, matched, skipped, ambiguous };
}

/**
 * ERP 전용 담당자 골든 생성 — erp-ui 이벤트의 Manager(실명) 중 골든에 없는 사람을 생성.
 * PC 데몬 미추적 직원(예: 견적 담당 조현욱·정재훈·김원영)이 온톨로지에 "알 수 없는 사람"으로
 * 남아 교차검증이 WARN을 남발하는 문제 해소. 보수적: 한글 2~4자 실명만, 멱등.
 */
async function seedFromManagers(pool, opts = {}) {
  const dryRun = !!opts.dryRun;
  const since = opts.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { ulid } = require('ulid');

  const { rows: mgrRows } = await pool.query(`
    SELECT DISTINCT data ->> 'Manager' AS name
      FROM unified_events
     WHERE source = 'erp-ui'
       AND data ->> 'Manager' IS NOT NULL
       AND timestamp > $1
  `, [since]);
  const names = mgrRows.map(r => (r.name || '').trim()).filter(n => /^[가-힣]{2,4}$/.test(n));
  if (names.length === 0) return { managers: 0, seeded: 0, skipped: 0 };

  const { rows: persons } = await pool.query(`
    SELECT id, display_name, attributes FROM orbit_entity_golden WHERE entity_type = 'person'
  `);
  const known = new Set();
  for (const p of persons) {
    if (p.display_name) known.add(_norm(p.display_name));
    if (p.attributes?.name) known.add(_norm(p.attributes.name));
  }

  let seeded = 0, skipped = 0;
  for (const name of names) {
    if (known.has(_norm(name))) { skipped++; continue; }
    // erp-user-map 역참조: 실명 → ERP 로그인ID (있으면 aliases로 보존해 향후 user_id 매칭에 사용)
    const loginIds = Object.entries(_getErpUserMap()).filter(([, v]) => v?.name === name).map(([id]) => id);
    const id = ulid();
    const attrs = { name, aliases: loginIds, erp_only: true };
    if (!dryRun) {
      await pool.query(`
        INSERT INTO orbit_entity_golden
          (id, entity_type, display_name, attributes, source_refs, confidence, source_count)
        VALUES ($1, 'person', $2, $3, $4, 0.333, 1)
      `, [id, name, JSON.stringify(attrs), JSON.stringify({ 'erp-ui': [`manager:${name}`] })]);
      await pool.query(`
        INSERT INTO orbit_entity_match_log
          (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
        VALUES ($1, 'erp-ui', $2, 'exact', 1.000, $3, $4)
      `, [id, `manager:${name}`, JSON.stringify({ via: 'estimate.Manager', loginIds }), MATCHER_VERSION]);
    }
    known.add(_norm(name));
    seeded++;
  }
  return { managers: names.length, seeded, skipped };
}

module.exports = { matchOnce, seedFromManagers };

if (require.main === module) {
  require('dotenv').config();
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 미설정'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dryRun = process.argv.includes('--dry-run');

  matchOnce(pool, { dryRun })
    .then(r => { console.log(JSON.stringify(r, null, 2)); return pool.end(); })
    .catch(e => { console.error(e); pool.end(); process.exit(1); });
}
