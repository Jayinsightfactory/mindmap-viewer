'use strict';
/**
 * src/intelligence/entity-resolution/seed-person-from-pc-links.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 2 시드: orbit_pc_links + orbit_auth_users → orbit_entity_golden (person)
 *
 * 9 PC 매핑(이미 완료)을 첫 번째 골든 레코드로 부트스트랩.
 *   - 1소스(orbit)만 매칭 → confidence = 0.33
 *   - source_refs.orbit = [hostname...]
 *   - source_refs['erp-ui'] / ['nenova-agent'] 는 향후 매처가 채움
 *
 * 멱등 실행 가능: 같은 user_id가 들어오면 source_refs.orbit 에 hostname 추가만.
 *
 * CLI: node src/intelligence/entity-resolution/seed-person-from-pc-links.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

const MATCHER_VERSION = 'pc-links-seed/1.0';

async function seed(pool, opts = {}) {
  const dryRun = !!opts.dryRun;

  // 1. PC 링크 + 사용자 정보 JOIN
  const { rows: links } = await pool.query(`
    SELECT pl.hostname, pl.user_id, au.name, au.email
      FROM orbit_pc_links pl
      LEFT JOIN orbit_auth_users au ON au.id = pl.user_id
     ORDER BY pl.user_id, pl.hostname
  `);

  if (links.length === 0) {
    return { seeded: 0, updated: 0, skipped: 0, total: 0 };
  }

  // 2. user_id 기준 그룹핑 — 한 사람이 PC 여러 대일 수 있음
  const byUser = new Map();
  for (const r of links) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { ...r, hostnames: [] });
    byUser.get(r.user_id).hostnames.push(r.hostname);
  }

  let seeded = 0, updated = 0, skipped = 0;

  for (const [userId, u] of byUser) {
    const displayName = u.name || userId;

    // 3. 기존 person 골든 검색 — attributes.user_id 또는 source_refs.orbit 교집합으로
    const { rows: existing } = await pool.query(`
      SELECT id, source_refs, attributes
        FROM orbit_entity_golden
       WHERE entity_type = 'person'
         AND (
           attributes ->> 'user_id' = $1
           OR source_refs -> 'orbit' ?| $2::text[]
         )
       LIMIT 1
    `, [userId, u.hostnames]);

    if (existing.length === 0) {
      // 신규 골든 생성
      const id = ulid();
      const sourceRefs = { orbit: u.hostnames };
      const attrs = {
        user_id: userId,
        name: displayName,
        email: u.email || null,
        aliases: [],
      };
      if (!dryRun) {
        await pool.query(`
          INSERT INTO orbit_entity_golden
            (id, entity_type, display_name, attributes, source_refs, confidence, source_count)
          VALUES ($1, 'person', $2, $3, $4, 0.333, 1)
        `, [id, displayName, JSON.stringify(attrs), JSON.stringify(sourceRefs)]);

        for (const hn of u.hostnames) {
          await pool.query(`
            INSERT INTO orbit_entity_match_log
              (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
            VALUES ($1, 'orbit', $2, 'exact', 1.000, $3, $4)
          `, [id, hn, JSON.stringify({ via: 'orbit_pc_links', user_id: userId }), MATCHER_VERSION]);
        }
      }
      seeded++;
    } else {
      // 기존 골든 업데이트 — orbit hostnames 합집합
      const g = existing[0];
      const cur = (g.source_refs?.orbit) || [];
      const merged = [...new Set([...cur, ...u.hostnames])];
      const added = merged.filter(h => !cur.includes(h));

      if (added.length === 0) { skipped++; continue; }

      if (!dryRun) {
        const newRefs = { ...(g.source_refs || {}), orbit: merged };
        await pool.query(`
          UPDATE orbit_entity_golden
             SET source_refs = $1
           WHERE id = $2
        `, [JSON.stringify(newRefs), g.id]);

        for (const hn of added) {
          await pool.query(`
            INSERT INTO orbit_entity_match_log
              (golden_id, source, source_ref, match_type, match_score, evidence, matcher_version)
            VALUES ($1, 'orbit', $2, 'exact', 1.000, $3, $4)
          `, [g.id, hn, JSON.stringify({ via: 'orbit_pc_links', user_id: userId, added_to_existing: true }), MATCHER_VERSION]);
        }
      }
      updated++;
    }
  }

  return { seeded, updated, skipped, total: byUser.size };
}

module.exports = { seed };

// CLI 직접 실행 지원
if (require.main === module) {
  require('dotenv').config();
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 미설정'); process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dryRun = process.argv.includes('--dry-run');

  seed(pool, { dryRun })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      return pool.end();
    })
    .catch(e => { console.error(e); pool.end(); process.exit(1); });
}
