'use strict';
/**
 * pc-user-resolver.js — hostname → user_id 자동 매칭 통합 모듈
 *
 * Q1A: PC 이름 직접 매핑 (PC_USER_MAP, PC_NAME_MAP)
 * Q1B: 카톡 윈도우 타이틀 + 클립보드 텍스트에서 본인 이름 검출
 *
 * 우선순위:
 *   1) orbit_pc_links (admin 명시적 매핑) — 외부 호출자가 먼저 체크
 *   2) PC_USER_MAP (회사 직접 매핑 — 하드코딩)
 *   3) PC_NAME_MAP (PC명 → 이름 → orbit_auth_users 동적 조회)
 *   4) 카톡 윈도우 타이틀 — "{이름} - 카카오톡" / "{이름} - KakaoTalk" 패턴
 *   5) 클립보드 텍스트 — 자기 이메일/이름 자주 나오면 매칭
 *   6) 실패 → null (호출자가 pc_HOSTNAME 익명 처리)
 */

// ── PC 이름 → user_id 직접 매핑 (Q1A) ─────────────────────────────────────
//   회사에서 "이 PC = 이 사람" 확정된 매핑만 등재
const PC_USER_MAP = {
  '이재만':            'MNH03H73690BB2CD82', // jaeyong lim (관리자)
  'DESKTOP-T09911T':  'MNMRX6SR07F5FF7C0C', // 강현우
  'Papi-Chulo-PC':    'MNMRVD11EDCCF6E7CE', // wbk (대소문자 변형)
  'DESKTOP-CAA5TA1':  'MNMR8568CC8950F81D', // hoon J / 현욱 — 전용 PC
  'DESKTOP-L0C2IOT':  'MNMSAQJD78E544A631', // 강명훈
  'DESKTOP-4OM3URA':  'MNSKAQSQ649D9E5936', // Luke 전용 PC
};

// ── PC 이름 → 사용자 이름 매핑 (Q1A) ─────────────────────────────────────
//   orbit_auth_users 에서 이름으로 user_id 동적 조회
const PC_NAME_MAP = {
  'NENOVA2025':       '설연주',
  'NEONVA':           '설연주',
  'neonva':           '설연주',
  'DESKTOP-HGNEA1S':  '박성수',
};

// ── 카톡 윈도우 타이틀 패턴 (Q1B) ─────────────────────────────────────
//   카카오톡 윈도우 타이틀이 본인 이름인 경우가 일반적
//   예: "박성수", "박성수 - 카카오톡", "[박성수] 카카오톡"
const KAKAO_TITLE_PATTERNS = [
  /^([가-힣]{2,4})\s*[-—:]?\s*(?:카카오톡|kakaotalk|talk)$/i,
  /^\[([가-힣]{2,4})\]/,
  /([가-힣]{2,4})\s*님\s*-\s*카카오톡/i,
];

/**
 * 1단계: 직접 매핑 (PC_USER_MAP)
 * @returns {string|null} userId
 */
function resolveByDirect(hostname) {
  if (!hostname) return null;
  if (PC_USER_MAP[hostname]) return PC_USER_MAP[hostname];
  // 대소문자 변형 (예: "neonva" vs "NEONVA")
  for (const [k, v] of Object.entries(PC_USER_MAP)) {
    if (k.toLowerCase() === hostname.toLowerCase()) return v;
  }
  return null;
}

/**
 * 2단계: 이름 매핑 (PC_NAME_MAP → orbit_auth_users)
 * @returns {Promise<string|null>}
 */
async function resolveByName(pool, hostname) {
  if (!pool || !hostname) return null;
  let name = PC_NAME_MAP[hostname];
  if (!name) {
    for (const [k, v] of Object.entries(PC_NAME_MAP)) {
      if (k.toLowerCase() === hostname.toLowerCase()) { name = v; break; }
    }
  }
  if (!name) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM orbit_auth_users WHERE name ILIKE $1 LIMIT 1`,
      [`%${name}%`]
    );
    if (rows.length > 0) return rows[0].id;
  } catch {}
  return null;
}

/**
 * 3단계: 카톡 윈도우 타이틀에서 본인 이름 추출
 * @returns {Promise<{userId:string,name:string,confidence:number}|null>}
 */
async function resolveByKakaoTitle(pool, hostname, days = 7) {
  if (!pool || !hostname) return null;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  try {
    // 최근 N일 카톡 활동 윈도우 타이틀 (keyboard.chunk / screen.capture)
    const { rows } = await pool.query(
      `SELECT data_json->>'windowTitle' AS title, COUNT(*)::int AS cnt
       FROM events
       WHERE data_json->>'hostname' = $1
         AND timestamp > $2
         AND (data_json->>'app' ILIKE '%kakao%' OR LOWER(data_json->>'windowTitle') LIKE '%카카오%')
         AND data_json->>'windowTitle' IS NOT NULL
       GROUP BY data_json->>'windowTitle'
       ORDER BY cnt DESC LIMIT 30`,
      [hostname, since]
    );
    // 패턴 매칭으로 후보 이름 수집
    const nameCount = {};
    for (const r of rows) {
      const t = (r.title || '').trim();
      for (const re of KAKAO_TITLE_PATTERNS) {
        const m = t.match(re);
        if (m && m[1]) {
          const name = m[1];
          nameCount[name] = (nameCount[name] || 0) + r.cnt;
        }
      }
    }
    // 최다 빈도 이름 채택
    const best = Object.entries(nameCount).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 3) return null;
    const [name, count] = best;
    // orbit_auth_users 에서 이름 매칭
    const { rows: ur } = await pool.query(
      `SELECT id, name FROM orbit_auth_users WHERE name ILIKE $1 LIMIT 1`,
      [`%${name}%`]
    );
    if (ur.length > 0) {
      return { userId: ur[0].id, name: ur[0].name, confidence: Math.min(count / 10, 1.0) };
    }
  } catch {}
  return null;
}

/**
 * 4단계: 클립보드 텍스트에서 본인 이름/이메일 검출
 * @returns {Promise<{userId:string,name:string,confidence:number}|null>}
 */
async function resolveByClipboard(pool, hostname, days = 7) {
  if (!pool || !hostname) return null;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  try {
    // 모든 OAuth 사용자 이름/이메일 후보 로드
    const { rows: users } = await pool.query(
      `SELECT id, name, email FROM orbit_auth_users WHERE name IS NOT NULL`
    );
    if (users.length === 0) return null;

    // hostname 의 클립보드 샘플
    const { rows: clips } = await pool.query(
      `SELECT data_json->>'text' AS text
       FROM events
       WHERE type='clipboard.change'
         AND data_json->>'hostname' = $1
         AND timestamp > $2
         AND length(data_json->>'text') > 0
       ORDER BY timestamp DESC LIMIT 200`,
      [hostname, since]
    );
    if (clips.length === 0) return null;

    // 각 사용자 이름/이메일이 클립보드에 등장 횟수
    const score = {};
    const allText = clips.map(c => c.text || '').join(' ');
    for (const u of users) {
      let s = 0;
      if (u.name && u.name.length >= 2) {
        const re = new RegExp(u.name, 'g');
        const matches = allText.match(re);
        if (matches) s += matches.length * 2;
      }
      if (u.email) {
        const re = new RegExp(u.email.replace(/[.@]/g, '\\$&'), 'gi');
        const matches = allText.match(re);
        if (matches) s += matches.length * 5;
      }
      if (s > 0) score[u.id] = { score: s, name: u.name };
    }

    const best = Object.entries(score).sort((a, b) => b[1].score - a[1].score)[0];
    if (!best || best[1].score < 3) return null;
    return {
      userId: best[0],
      name: best[1].name,
      confidence: Math.min(best[1].score / 20, 1.0),
    };
  } catch {}
  return null;
}

/**
 * 통합 매칭 — 모든 단계 순차 시도
 * @returns {Promise<{userId:string,source:string,confidence:number}|null>}
 */
async function resolveHostnameToUser(pool, hostname) {
  if (!hostname) return null;

  // 1) 직접 매핑 (가장 신뢰도 높음)
  const direct = resolveByDirect(hostname);
  if (direct) return { userId: direct, source: 'direct_map', confidence: 1.0 };

  // 2) 이름 매핑
  const byName = await resolveByName(pool, hostname);
  if (byName) return { userId: byName, source: 'name_map', confidence: 0.95 };

  // 3) 카톡 타이틀 (Q1B)
  const byKakao = await resolveByKakaoTitle(pool, hostname);
  if (byKakao && byKakao.confidence >= 0.5) {
    return { userId: byKakao.userId, source: 'kakao_title', confidence: byKakao.confidence, name: byKakao.name };
  }

  // 4) 클립보드 텍스트 (Q1B)
  const byClip = await resolveByClipboard(pool, hostname);
  if (byClip && byClip.confidence >= 0.5) {
    return { userId: byClip.userId, source: 'clipboard_text', confidence: byClip.confidence, name: byClip.name };
  }

  // 5) 모두 실패 — null 반환 (호출자가 pc_HOSTNAME 익명 처리)
  return null;
}

module.exports = {
  PC_USER_MAP,
  PC_NAME_MAP,
  resolveByDirect,
  resolveByName,
  resolveByKakaoTitle,
  resolveByClipboard,
  resolveHostnameToUser,
};
