'use strict';
/**
 * work-timetable.js — 직원 업무시간 타임테이블 API (2026-08-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET /api/timetable/day?date=YYYY-MM-DD
 *       그 날 직원×시간(0~23시, KST) 활동 분. events 원천(실시간, 30일 보존).
 *       활동 분 = 5분 슬롯 근사(관측 해상도가 활동중 30~120초·유휴 5분이라 1분 단위는 무의미).
 *   GET /api/timetable/range?view=day|week|month&anchor=YYYY-MM-DD
 *       직원×버킷(일/주/월) 업무시간. unified_events work.action(durationSec 합산).
 *       events 30일 삭제 후에도 남는 유일한 장기 소스 → 주/월 뷰는 이것만 가능.
 *
 * 인증: isAdminReq(=server.js isAdminReqAsync — PG claim-token 폴백 포함) 관리자 전용.
 * 프론트: /work-timetable.html (admin-analysis '업무시간' 탭에서 iframe 로드)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// 집계에서 제외할 계정 (server.js:1837 · company-structure.js:42 관례)
const EXCLUDED_USERS = ['local', 'system', 'MMOLABXL2066516519'];
// 실작업으로 치는 이벤트 타입 (process-mining.js WORK_TYPES 관례)
const WORK_TYPES = ['keyboard.chunk', 'mouse.chunk', 'screen.capture', 'screen.analyzed', 'clipboard.change'];

module.exports = function createWorkTimetableRouter(deps = {}) {
  const getPool = deps.getPool;
  const isAdminReq = deps.isAdminReq || (async () => false);
  const router = express.Router();
  const pool = () => (getPool ? getPool() : null);

  // 45초 TTL 캐시 (flow-map.js 패턴 — 무거운 집계 반복요청 흡수)
  const _cache = new Map(); const CACHE_TTL = 45000;
  const cGet = (k) => { const v = _cache.get(k); if (v && Date.now() - v.ts < CACHE_TTL) return v.data; if (v) _cache.delete(k); return null; };
  const cSet = (k, data) => { _cache.set(k, { ts: Date.now(), data }); if (_cache.size > 100) _cache.delete(_cache.keys().next().value); };

  router.use(async (req, res, next) => {
    try { if (await isAdminReq(req)) return next(); } catch { /* fallthrough */ }
    res.status(403).json({ error: 'admin only' });
  });

  // orbit_auth_users id→이름 맵 (id UNIQUE 없음 — 이름 있는 행 우선)
  async function userNames(p) {
    const { rows } = await p.query(`SELECT id, name, email FROM orbit_auth_users`).catch(() => ({ rows: [] }));
    const m = {};
    for (const u of rows) {
      const nm = u.name || (u.email || '').split('@')[0];
      if (nm && (!m[u.id] || !m[u.id].trim())) m[u.id] = nm;
    }
    return m;
  }

  function kstDayStr(d = new Date()) {
    return d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  }

  // ── 시간별(하루): events 기반 ──────────────────────────────────────────────
  router.get('/day', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(503).json({ error: 'db unavailable' });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : kstDayStr();
      const ck = `day:${date}`;
      const hit = cGet(ck); if (hit) return res.json(hit);

      const from = new Date(`${date}T00:00:00+09:00`).toISOString();
      const to = new Date(new Date(`${date}T00:00:00+09:00`).getTime() + 86400000).toISOString();

      // 5분 슬롯 근사: 시간대별 관측 슬롯 수 × 5 = 활동 분. 시계손상 PC 방어(from/to 창 자체가 방어).
      const { rows } = await p.query(
        `WITH e AS (
           SELECT user_id, type, timestamp::timestamptz AS ts, data_json
           FROM events
           WHERE timestamp::timestamptz >= $1::timestamptz AND timestamp::timestamptz < $2::timestamptz
             AND type = ANY($3)
             AND user_id IS NOT NULL AND NOT (user_id = ANY($4))
         )
         SELECT user_id,
           EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Seoul')::int AS h,
           COUNT(DISTINCT FLOOR(EXTRACT(EPOCH FROM ts) / 300))::int AS slots,
           COUNT(*) FILTER (WHERE type = 'keyboard.chunk')::int AS kbd,
           COUNT(*) FILTER (WHERE type IN ('screen.capture','screen.analyzed'))::int AS scr,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM e GROUP BY 1, 2 ORDER BY 1, 2`,
        [from, to, WORK_TYPES, EXCLUDED_USERS]
      );

      // 직원별 상위 앱 (그 날 어떤 앱에서 일했는지 — 정밀분석 철학: 통계가 아니라 맥락)
      const { rows: appRows } = await p.query(
        `SELECT user_id,
           COALESCE(NULLIF(data_json->>'app',''), data_json#>>'{appContext,currentApp}', '?') AS app,
           COUNT(*)::int AS c
         FROM events
         WHERE timestamp::timestamptz >= $1::timestamptz AND timestamp::timestamptz < $2::timestamptz
           AND type IN ('keyboard.chunk','screen.capture')
           AND user_id IS NOT NULL AND NOT (user_id = ANY($3))
         GROUP BY 1, 2 ORDER BY 3 DESC`,
        [from, to, EXCLUDED_USERS]
      ).catch(() => ({ rows: [] }));

      const byUser = {};
      for (const r of rows) {
        const u = byUser[r.user_id] || (byUser[r.user_id] = { userId: r.user_id, hours: {}, totalMin: 0, first: null, last: null, topApps: [] });
        const min = Math.min(60, r.slots * 5);
        u.hours[r.h] = { min, kbd: r.kbd, scr: r.scr };
        u.totalMin += min;
        if (!u.first || r.first_ts < u.first) u.first = r.first_ts;
        if (!u.last || r.last_ts > u.last) u.last = r.last_ts;
      }
      for (const r of appRows) {
        const u = byUser[r.user_id];
        if (u && u.topApps.length < 3 && r.app !== '?') u.topApps.push({ app: r.app, count: r.c });
      }

      const names = await userNames(p);
      const out = {
        date,
        rows: Object.values(byUser)
          .map((u) => ({ ...u, name: names[u.userId] || u.userId.slice(0, 10) }))
          .sort((a, b) => b.totalMin - a.totalMin),
        note: '활동 분 = 5분 관측 슬롯 근사. 빈 칸은 미관측(PC꺼짐·자리비움·데몬중단)일 수 있음. events 보존 30일.',
      };
      cSet(ck, out);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ── 일별/주별/월별: unified_events work.action 기반 ───────────────────────
  router.get('/range', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(503).json({ error: 'db unavailable' });
      const view = ['day', 'week', 'month'].includes(String(req.query.view)) ? String(req.query.view) : 'day';
      const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.anchor || '')) ? String(req.query.anchor) : kstDayStr();
      const ws = String(req.query.tenant || 'WS-NENOVA-2026').slice(0, 60);
      const ck = `range:${view}:${anchor}:${ws}`;
      const hit = cGet(ck); if (hit) return res.json(hit);

      // 조회 창: 일=anchor 포함 최근 31일, 주=최근 12주, 월=최근 12개월
      const anchorEnd = new Date(new Date(`${anchor}T00:00:00+09:00`).getTime() + 86400000);
      const spanDays = view === 'day' ? 31 : view === 'week' ? 12 * 7 + 6 : 366;
      const from = new Date(anchorEnd.getTime() - spanDays * 86400000).toISOString();
      const to = anchorEnd.toISOString();

      const { rows } = await p.query(
        `SELECT user_id,
           to_char(date_trunc($1, timestamp AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD') AS bucket,
           SUM(COALESCE(NULLIF(data->>'durationSec','')::int, 0))::int AS work_sec,
           COUNT(*)::int AS actions,
           SUM(COALESCE(NULLIF(data->>'typedChars','')::int, 0))::int AS typed,
           SUM(COALESCE(NULLIF(data->>'clicks','')::int, 0))::int AS clicks
         FROM unified_events
         WHERE type = 'work.action' AND workspace_id = $2
           AND timestamp >= $3::timestamptz AND timestamp < $4::timestamptz
           AND user_id IS NOT NULL AND NOT (user_id = ANY($5))
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [view, ws, from, to, EXCLUDED_USERS]
      );

      const byUser = {};
      const buckets = new Set();
      for (const r of rows) {
        buckets.add(r.bucket);
        const u = byUser[r.user_id] || (byUser[r.user_id] = { userId: r.user_id, byBucket: {}, totalSec: 0 });
        u.byBucket[r.bucket] = { sec: r.work_sec, actions: r.actions, typed: r.typed, clicks: r.clicks };
        u.totalSec += r.work_sec;
      }

      const names = await userNames(p);
      const out = {
        view, anchor,
        buckets: [...buckets].sort(),
        rows: Object.values(byUser)
          .map((u) => ({ ...u, name: names[u.userId] || u.userId.slice(0, 10) }))
          .sort((a, b) => b.totalSec - a.totalSec),
        note: 'work.action(30분 주기 융합, 2소스 교차검증 포함) durationSec 합산. 최신 30분은 아직 융합 전일 수 있음.',
      };
      cSet(ck, out);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return router;
};
