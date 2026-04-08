/**
 * routes/context-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 외부 컨텍스트(시간대/요일/월 위치)가 업무 패턴에 미치는 영향 분석
 *
 * API:
 *   GET /api/context/current?userId=xxx   현재 컨텍스트 + 예상 패턴
 *   GET /api/context/patterns?userId=xxx  전체 컨텍스트별 패턴
 *   GET /api/context/insights             컨텍스트 기반 자동 생성 인사이트
 *
 * Express router: module.exports = (deps) => router
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');

// ─── 컨텍스트 팩터 정의 ──────────────────────────────────────────────────────

/**
 * 주어진 Date 객체로부터 4가지 컨텍스트 팩터를 계산합니다.
 * @param {Date} [now]
 * @returns {{ timeSlot, dayType, weekPos, monthPos }}
 */
function calcContextFactors(now = new Date()) {
  const hour  = now.getHours();
  const dow   = now.getDay();   // 0=일, 1=월 ... 6=토
  const dom   = now.getDate();

  // timeSlot: dawn / morning / afternoon / evening / night
  let timeSlot;
  if (hour >= 0  && hour <= 6)  timeSlot = 'dawn';
  else if (hour <= 11)           timeSlot = 'morning';
  else if (hour <= 17)           timeSlot = 'afternoon';
  else if (hour <= 22)           timeSlot = 'evening';
  else                           timeSlot = 'night';

  // dayType: weekday / weekend
  const dayType = (dow === 0 || dow === 6) ? 'weekend' : 'weekday';

  // weekPos: weekStart(월-화) / weekMid(수-목) / weekEnd(금) / weekend
  let weekPos;
  if (dow === 0 || dow === 6)    weekPos = 'weekend';
  else if (dow === 1 || dow === 2) weekPos = 'weekStart';
  else if (dow === 3 || dow === 4) weekPos = 'weekMid';
  else                           weekPos = 'weekEnd';

  // monthPos: monthStart(1-5) / monthMid(6-20) / monthEnd(21-31)
  let monthPos;
  if (dom <= 5)        monthPos = 'monthStart';
  else if (dom <= 20)  monthPos = 'monthMid';
  else                 monthPos = 'monthEnd';

  return { timeSlot, dayType, weekPos, monthPos };
}

/**
 * 컨텍스트 팩터들을 단일 문자열 키로 직렬화
 * @param {{ timeSlot, dayType, weekPos, monthPos }} factors
 * @returns {string}
 */
function toContextKey(factors) {
  return `${factors.timeSlot}|${factors.dayType}|${factors.weekPos}|${factors.monthPos}`;
}

// ─── DB 테이블 초기화 ─────────────────────────────────────────────────────────
let _tableReady = false;

async function ensureContextTable(db) {
  if (_tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS context_patterns (
      id                BIGSERIAL PRIMARY KEY,
      user_id           TEXT NOT NULL,
      context_key       TEXT NOT NULL,
      time_slot         TEXT,
      day_type          TEXT,
      week_pos          TEXT,
      month_pos         TEXT,
      avg_events        REAL DEFAULT 0,
      top_app           TEXT DEFAULT '',
      productivity_score REAL DEFAULT 0.5,
      sample_count      INTEGER DEFAULT 0,
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, context_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_user    ON context_patterns(user_id);
    CREATE INDEX IF NOT EXISTS idx_cp_key     ON context_patterns(context_key);
    CREATE INDEX IF NOT EXISTS idx_cp_updated ON context_patterns(updated_at);
  `);
  _tableReady = true;
}

// ─── 이벤트 배열에서 컨텍스트 패턴 학습 ─────────────────────────────────────

/**
 * 이벤트 배열을 스캔하여 context_patterns 테이블을 UPSERT 방식으로 업데이트합니다.
 * @param {string} userId
 * @param {object[]} events
 * @param {import('pg').Pool} db
 */
async function learnContextPatterns(userId, events, db) {
  if (!db || !events?.length) return;
  await ensureContextTable(db);

  // context_key 별 이벤트 그룹핑
  const buckets = {};
  for (const e of events) {
    const ts = new Date(e.timestamp);
    if (isNaN(ts)) continue;
    const factors = calcContextFactors(ts);
    const key = toContextKey(factors);
    if (!buckets[key]) buckets[key] = { factors, apps: {}, count: 0 };
    buckets[key].count++;
    const app = e.data?.appName || e.data?.app || e.data?.toolName || '';
    if (app) buckets[key].apps[app] = (buckets[key].apps[app] || 0) + 1;
  }

  for (const [key, bucket] of Object.entries(buckets)) {
    const topApp = Object.entries(bucket.apps).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    // 생산성 점수: 주간 오전에 이벤트 집중 → 높음
    const prod = (bucket.factors.dayType === 'weekday' && bucket.factors.timeSlot === 'morning') ? 0.8
      : (bucket.factors.dayType === 'weekday') ? 0.65
      : 0.4;

    await db.query(`
      INSERT INTO context_patterns
        (user_id, context_key, time_slot, day_type, week_pos, month_pos,
         avg_events, top_app, productivity_score, sample_count, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (user_id, context_key) DO UPDATE SET
        avg_events        = ROUND((context_patterns.avg_events * context_patterns.sample_count + EXCLUDED.avg_events) / (context_patterns.sample_count + 1), 2),
        top_app           = EXCLUDED.top_app,
        productivity_score = ROUND((context_patterns.productivity_score + EXCLUDED.productivity_score) / 2, 3),
        sample_count      = context_patterns.sample_count + 1,
        updated_at        = NOW()
    `, [
      userId, key,
      bucket.factors.timeSlot, bucket.factors.dayType,
      bucket.factors.weekPos, bucket.factors.monthPos,
      bucket.count, topApp, prod, 1,
    ]);
  }
}

// ─── 크로스 컨텍스트 인사이트 자동 생성 ─────────────────────────────────────

/**
 * context_patterns에서 눈에 띄는 패턴을 추출하여 인사이트 텍스트 배열을 반환합니다.
 * @param {object[]} patterns - DB 조회 결과 rows
 * @returns {string[]}
 */
function generateContextInsights(patterns) {
  const insights = [];

  // 월말 + afternoon 급증 패턴 (마감 작업)
  const monthEndAfternoon = patterns.filter(
    p => p.month_pos === 'monthEnd' && p.time_slot === 'afternoon' && p.sample_count >= 3
  );
  if (monthEndAfternoon.length > 0) {
    const top = monthEndAfternoon.sort((a, b) => b.avg_events - a.avg_events)[0];
    insights.push(
      `월말 오후에 업무량이 집중됩니다 (평균 ${Math.round(top.avg_events)}건/세션). ` +
      `마감 관련 전산 작업이 급증하는 패턴이 감지되었습니다.`
    );
  }

  // 주초 오전 집중 패턴
  const weekStartMorning = patterns.filter(
    p => p.week_pos === 'weekStart' && p.time_slot === 'morning' && p.sample_count >= 3
  );
  if (weekStartMorning.length > 0) {
    const top = weekStartMorning.sort((a, b) => b.productivity_score - a.productivity_score)[0];
    const appHint = top.top_app ? ` (주요 앱: ${top.top_app})` : '';
    insights.push(`월·화요일 오전이 가장 생산성이 높습니다${appHint}. 중요한 작업을 이 시간대에 배치하세요.`);
  }

  // 야간 주말 작업 감지
  const nightWeekend = patterns.filter(
    p => p.day_type === 'weekend' && (p.time_slot === 'night' || p.time_slot === 'dawn') && p.sample_count >= 2
  );
  if (nightWeekend.length > 0) {
    insights.push('주말 야간 작업 패턴이 감지되었습니다. 지속 가능한 업무 리듬을 위해 휴식을 권장합니다.');
  }

  // 특정 앱이 특정 컨텍스트에 집중
  const appContextMap = {};
  for (const p of patterns) {
    if (!p.top_app || p.sample_count < 3) continue;
    if (!appContextMap[p.top_app]) appContextMap[p.top_app] = [];
    appContextMap[p.top_app].push(p);
  }
  for (const [app, rows] of Object.entries(appContextMap)) {
    if (rows.length === 1) {
      const r = rows[0];
      const timeLabel = { dawn: '새벽', morning: '오전', afternoon: '오후', evening: '저녁', night: '야간' }[r.time_slot] || r.time_slot;
      const dayLabel  = { weekStart: '주초(월·화)', weekMid: '주중(수·목)', weekEnd: '주말 직전(금)', weekend: '주말' }[r.week_pos] || r.week_pos;
      insights.push(`${app}는 주로 ${dayLabel} ${timeLabel}에 집중 사용됩니다 (${r.sample_count}회 패턴).`);
    }
  }

  return insights;
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId, db }} deps
 */
module.exports = function createContextRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId, db } = deps;
  const router = express.Router();

  // ── 인증 미들웨어 (JWT + orbit_xxx + userId 파라미터 겸용) ──
  function auth(req, res, next) {
    const token = req.headers.authorization || req.query.token || req.cookies?.orbit_token;
    if (token) {
      const user = verifyToken(token);
      if (user) { req.user = user; return next(); }
      const userId = req.query.userId || req.body?.userId;
      if (userId) { req.user = { id: userId }; return next(); }
      return res.status(401).json({ error: 'Invalid token' });
    }
    const userId = req.query.userId || req.body?.userId;
    if (userId) { req.user = { id: userId }; return next(); }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/context/current
  // 현재 컨텍스트 + 오늘 예상 패턴
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/current', auth, async (req, res) => {
    try {
      const userId  = resolveUserId(req);
      const factors = calcContextFactors();
      const key     = toContextKey(factors);

      let prediction = null;
      if (db) {
        await ensureContextTable(db);
        const { rows } = await db.query(
          `SELECT * FROM context_patterns WHERE user_id=$1 AND context_key=$2 LIMIT 1`,
          [userId, key]
        );
        if (rows.length > 0) prediction = rows[0];
      }

      // 학습 데이터가 없으면 배경 학습 실행 (비동기, 응답 차단 안 함)
      if (!prediction && getEventsForUser) {
        getEventsForUser(userId).then(events => {
          if (events?.length) learnContextPatterns(userId, events, db).catch(() => {});
        }).catch(() => {});
      }

      res.json({
        ok: true,
        currentContext: factors,
        contextKey: key,
        prediction: prediction ? {
          avgEvents:         prediction.avg_events,
          topApp:            prediction.top_app,
          productivityScore: prediction.productivity_score,
          sampleCount:       prediction.sample_count,
        } : null,
        message: prediction
          ? `이 시간대(${factors.timeSlot}/${factors.weekPos})는 평균 ${Math.round(prediction.avg_events)}건의 이벤트가 예상됩니다.`
          : '아직 이 컨텍스트에 대한 학습 데이터가 없습니다.',
      });
    } catch (e) {
      console.error('[ContextEngine] current error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/context/patterns
  // 전체 컨텍스트별 패턴 조회 + 즉시 학습 트리거
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/patterns', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);

      // 최신 이벤트로 패턴 재학습
      if (db && getEventsForUser) {
        const events = await getEventsForUser(userId);
        if (events?.length) await learnContextPatterns(userId, events, db);
      }

      let patterns = [];
      if (db) {
        await ensureContextTable(db);
        const { rows } = await db.query(
          `SELECT * FROM context_patterns WHERE user_id=$1 ORDER BY sample_count DESC, productivity_score DESC`,
          [userId]
        );
        patterns = rows;
      }

      res.json({
        ok: true,
        patterns: patterns.map(p => ({
          contextKey:        p.context_key,
          timeSlot:          p.time_slot,
          dayType:           p.day_type,
          weekPos:           p.week_pos,
          monthPos:          p.month_pos,
          avgEvents:         p.avg_events,
          topApp:            p.top_app,
          productivityScore: p.productivity_score,
          sampleCount:       p.sample_count,
          updatedAt:         p.updated_at,
        })),
        total: patterns.length,
      });
    } catch (e) {
      console.error('[ContextEngine] patterns error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/context/insights
  // 컨텍스트 기반 자동 생성 인사이트
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/insights', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);

      let patterns = [];
      if (db) {
        await ensureContextTable(db);
        const { rows } = await db.query(
          `SELECT * FROM context_patterns WHERE user_id=$1 AND sample_count >= 2`,
          [userId]
        );
        patterns = rows;
      }

      const insights = generateContextInsights(patterns);

      res.json({
        ok: true,
        insights,
        total: insights.length,
        basedOn: patterns.length,
      });
    } catch (e) {
      console.error('[ContextEngine] insights error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
