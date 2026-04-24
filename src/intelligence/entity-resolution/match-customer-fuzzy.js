'use strict';
/**
 * src/intelligence/entity-resolution/match-customer-fuzzy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 2 정밀 매처: orbit 클립보드 + nenova-agent room_name → Customer 골든
 *
 * 흐름:
 *   1) customer 골든 인덱스 로드 (display_name + attributes.aliases)
 *   2) orbit 이벤트의 클립보드 텍스트 스캔 → substring 후보
 *   3) nenova-agent 이벤트의 room_name 스캔 → fuzzy 후보
 *   4) 빈도 기반 필터: 같은 (golden, source_ref) 가 N회 이상 등장한 매칭만 채택
 *   5) source_refs 갱신 + match_log 기록 (provenance)
 *
 * 보수성: substring 매칭은 false positive 적지만, 짧은 이름(2글자 이하)은
 *         빈도 임계 ↑ 로 보호. 단발성 매칭은 신뢰도 낮음.
 *
 * 멱등: 같은 (golden_id, source, source_ref) 는 추가 안 함.
 *
 * CLI: node src/intelligence/entity-resolution/match-customer-fuzzy.js [--dry-run]
 * ─────────────────────────────────────────────────────────────────────────────
 */

const N = require('./korean-normalizer');

const MATCHER_VERSION = 'customer-fuzzy/1.0';

// 채택 임계값 (frequency-aware)
const MIN_FREQ_LONG_NAME = 2;    // 3글자+ 이름은 2회 이상 관찰 시 채택
const MIN_FREQ_SHORT_NAME = 5;   // 2글자 이름은 5회 이상 (false positive 위험 큼)
const SCORE_FLOOR = 0.7;

async function _loadCustomerIndex(pool) {
  const { rows } = await pool.query(`
    SELECT id, display_name, attributes, source_refs
      FROM orbit_entity_golden
     WHERE entity_type = 'customer'
  `);
  // 후보는 display_name + aliases 모두 normalize 해서 평탄화
  const index = [];
  for (const r of rows) {
    const names = new Set([r.display_name, ...(r.attributes?.aliases || [])]);
    for (const nm of names) {
      const norm = N.normalizeName(nm);
      if (norm && norm.length >= 2) {
        index.push({ id: r.id, displayName: r.display_name, normName: norm, source_refs: r.source_refs || {} });
      }
    }
  }
  return { index, rows };
}

/**
 * orbit 이벤트(클립보드/포커스) 텍스트 스캔.
 * 반환: Map<golden_id, Map<sourceRef, count>>
 */
async function _scanOrbit(pool, index, since) {
  const { rows } = await pool.query(`
    SELECT id, data, metadata
      FROM unified_events
     WHERE source = 'orbit'
       AND timestamp > $1
       AND (
         data ? 'text' OR data ? 'clipboard' OR data ? 'title' OR data ? 'window_title'
       )
     LIMIT 50000
  `, [since]);

  const acc = new Map(); // golden_id → Map<orbit:eventId, count>
  for (const r of rows) {
    const text = (r.data?.text || r.data?.clipboard || r.data?.title || r.data?.window_title || '');
    if (!text || text.length < 2) continue;
    const hits = N.findCandidates(text, index);
    for (const h of hits) {
      // sourceRef는 hostname 단위로 집계 (이벤트 ID 단위는 너무 fragmented)
      const hostname = r.metadata?.hostname || r.metadata?.channel_id || 'unknown';
      const ref = `clipboard:${hostname}`;
      if (!acc.has(h.id)) acc.set(h.id, new Map());
      const m = acc.get(h.id);
      m.set(ref, (m.get(ref) || 0) + 1);
    }
  }
  return acc;
}

/**
 * nenova-agent 이벤트의 room_name 스캔.
 */
async function _scanAgent(pool, index, since) {
  const { rows } = await pool.query(`
    SELECT data->>'room_name' AS room_name, COUNT(*) AS cnt
      FROM unified_events
     WHERE source = 'nenova-agent'
       AND timestamp > $1
       AND data ? 'room_name'
     GROUP BY data->>'room_name'
  `, [since]);

  const acc = new Map();
  for (const r of rows) {
    if (!r.room_name) continue;
    const hits = N.findCandidates(r.room_name, index);
    for (const h of hits) {
      const ref = `room:${r.room_name}`;
      if (!acc.has(h.id)) acc.set(h.id, new Map());
      const m = acc.get(h.id);
      m.set(ref, (m.get(ref) || 0) + parseInt(r.cnt, 10));
    }
  }
  return acc;
}

/**
 * 1회 매칭.
 */
async function matchOnce(pool, opts = {}) {
  const dryRun = !!opts.dryRun;
  const since = opts.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { index, rows: customers } = await _loadCustomerIndex(pool);
  if (index.length === 0) return { customers: 0, matchedOrbit: 0, matchedAgent: 0, skipped: 0 };

  const [orbitHits, agentHits] = await Promise.all([
    _scanOrbit(pool, index, since),
    _scanAgent(pool, index, since),
  ]);

  // golden 기존 source_refs 캐시
  const goldenById = new Map(customers.map(r => [r.id, { ...r, source_refs: r.source_refs || {} }]));

  let matchedOrbit = 0, matchedAgent = 0, skipped = 0;

  async function _apply(source, hits) {
    let matched = 0;
    for (const [goldenId, refMap] of hits) {
      const g = goldenById.get(goldenId);
      if (!g) continue;
      const existingRefs = new Set(g.source_refs[source] || []);

      const lenName = N.normalizeName(g.display_name).length;
      const minFreq = lenName >= 3 ? MIN_FREQ_LONG_NAME : MIN_FREQ_SHORT_NAME;

      const newRefs = [];
      for (const [ref, cnt] of refMap) {
        if (existingRefs.has(ref)) { skipped++; continue; }
        if (cnt < minFreq) continue;
        newRefs.push({ ref, cnt });
      }
      if (newRefs.length === 0) continue;

      const merged = [...existingRefs, ...newRefs.map(r => r.ref)];
      const updated = { ...g.source_refs, [source]: merged };
      const newCount = Object.keys(updated).filter(k => (updated[k] || []).length > 0).length;
      const newConf = Number((newCount / 3).toFixed(3));

      if (!dryRun) {
        await pool.query(`
          UPDATE orbit_entity_golden
             SET source_refs = $1, source_count = $2, confidence = $3
           WHERE id = $4
        `, [JSON.stringify(updated), newCount, newConf, g.id]);

        for (const { ref, cnt } of newRefs) {
          await pool.query(`
            INSERT INTO orbit_entity_match_log
              (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
            VALUES ($1, $2, $3, 'fuzzy', $4, $5, $6)
          `, [g.id, source, ref, Math.min(1.0, SCORE_FLOOR + Math.log10(cnt) * 0.1),
              JSON.stringify({ frequency: cnt, normalized_name: N.normalizeName(g.display_name) }),
              MATCHER_VERSION]);
        }
      }
      // 로컬 캐시 갱신 — 다음 source 처리 시 source_count 재계산 정확
      g.source_refs = updated;
      matched++;
    }
    return matched;
  }

  matchedOrbit = await _apply('orbit', orbitHits);
  matchedAgent = await _apply('nenova-agent', agentHits);

  return { customers: customers.length, matchedOrbit, matchedAgent, skipped };
}

module.exports = { matchOnce };

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
