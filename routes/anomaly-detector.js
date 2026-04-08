/**
 * routes/anomaly-detector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 실시간 이상행동 감지 (개인 기준선 대비)
 *
 * 알고리즘:
 *   1. 개인 기준선 학습: 최근 7일 이벤트 → 시간대별 평균/표준편차
 *   2. 실시간 이상 감지 4종:
 *      a. 갑작스러운 활동 중단 (평소 활동 시간대 2시간 이상 이벤트 없음)
 *      b. 비정상 야간 작업 (23:00~05:00 이벤트 기준선 3배 이상)
 *      c. 카카오 과다 (전체 이벤트 중 80% 이상 3시간 지속)
 *      d. 반복 오류 패턴 (같은 화면에서 취소/닫기 5회 이상)
 *
 * DB 테이블:
 *   - baseline_stats   : 시간대별 평균/표준편차 기준선
 *   - anomaly_events   : 감지된 이상 이벤트
 *
 * API:
 *   GET  /api/anomaly/recent?userId=xxx   → 최근 24h 이상 이벤트
 *   GET  /api/anomaly/stats               → 전체 직원 이상 집계
 *   POST /api/anomaly/baseline/update     → 기준선 재계산 트리거
 *
 * Export: module.exports = (deps) => router
 *   deps: { db } — getDb() 결과 (pg Pool)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { Router } = require('express');

// ─── 상수 ────────────────────────────────────────────────────────────────────

const ANOMALY_TYPE = {
  SUDDEN_STOP:       'SUDDEN_STOP',       // 갑작스러운 활동 중단
  NIGHT_OVERWORK:    'NIGHT_OVERWORK',    // 비정상 야간 작업
  KAKAO_OVERDOSE:    'KAKAO_OVERDOSE',    // 카카오 과다 사용
  REPEAT_ERROR:      'REPEAT_ERROR',      // 반복 오류 패턴
};

const SEVERITY = {
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL',
};

/** 야간 시간대 (23~24, 0~5) */
const NIGHT_HOURS = new Set([23, 0, 1, 2, 3, 4, 5]);

/** 카카오 과다 임계값 */
const KAKAO_RATIO_THRESHOLD   = 0.80;  // 80% 이상
const KAKAO_SUSTAINED_MS      = 3 * 60 * 60 * 1000; // 3시간

/** 반복 오류 패턴 임계값 */
const REPEAT_ERROR_COUNT       = 5;

/** 활동 중단 임계값 */
const SUDDEN_STOP_MS           = 2 * 60 * 60 * 1000; // 2시간

/** 야간 이상 배수 */
const NIGHT_ANOMALY_MULTIPLIER = 3.0;

// ─── DB 초기화 ────────────────────────────────────────────────────────────────

async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS baseline_stats (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT    NOT NULL,
      hour        SMALLINT NOT NULL CHECK (hour >= 0 AND hour <= 23),
      avg_events  REAL    NOT NULL DEFAULT 0,
      stddev_events REAL  NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, hour)
    );
    CREATE INDEX IF NOT EXISTS idx_baseline_user ON baseline_stats(user_id);

    CREATE TABLE IF NOT EXISTS anomaly_events (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT        NOT NULL,
      type        TEXT        NOT NULL,
      severity    TEXT        NOT NULL DEFAULT 'MEDIUM',
      description TEXT        NOT NULL DEFAULT '',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_anomaly_user       ON anomaly_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_anomaly_detected   ON anomaly_events(detected_at);
    CREATE INDEX IF NOT EXISTS idx_anomaly_type       ON anomaly_events(type);
  `);
}

// ─── 기준선 계산 ──────────────────────────────────────────────────────────────

/**
 * userId의 최근 7일 이벤트로 시간대별 기준선 재계산 후 DB upsert
 * @param {import('pg').Pool} db
 * @param {string} userId
 */
async function recalcBaseline(db, userId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // 시간대별 이벤트 수 집계
  const r = await db.query(
    `SELECT
       EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul')::SMALLINT AS hour,
       DATE(created_at AT TIME ZONE 'Asia/Seoul') AS day,
       COUNT(*) AS cnt
     FROM events
     WHERE user_id = $1 AND created_at >= $2
     GROUP BY hour, day`,
    [userId, sevenDaysAgo]
  );

  // hour → [cnt, cnt, ...] 배열 구성
  const hourMap = {};
  for (const row of r.rows) {
    const h = parseInt(row.hour, 10);
    if (!hourMap[h]) hourMap[h] = [];
    hourMap[h].push(parseInt(row.cnt, 10));
  }

  const updates = [];
  for (let h = 0; h < 24; h++) {
    const vals = hourMap[h] || [];
    const avg = vals.length > 0
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : 0;
    const stddev = vals.length > 1
      ? Math.sqrt(vals.map(v => (v - avg) ** 2).reduce((a, b) => a + b, 0) / vals.length)
      : 0;
    updates.push({ h, avg, stddev });
  }

  // upsert
  for (const { h, avg, stddev } of updates) {
    await db.query(
      `INSERT INTO baseline_stats (user_id, hour, avg_events, stddev_events, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, hour) DO UPDATE
         SET avg_events    = EXCLUDED.avg_events,
             stddev_events = EXCLUDED.stddev_events,
             updated_at    = NOW()`,
      [userId, h, avg, stddev]
    );
  }
  return updates;
}

/**
 * userId의 기준선 조회 (hour → { avg_events, stddev_events })
 */
async function getBaseline(db, userId) {
  const r = await db.query(
    `SELECT hour, avg_events, stddev_events FROM baseline_stats WHERE user_id = $1`,
    [userId]
  );
  const map = {};
  for (const row of r.rows) {
    map[parseInt(row.hour, 10)] = {
      avg:    parseFloat(row.avg_events),
      stddev: parseFloat(row.stddev_events),
    };
  }
  return map;
}

// ─── 이상 이벤트 저장 ─────────────────────────────────────────────────────────

async function saveAnomaly(db, userId, type, severity, description) {
  try {
    await db.query(
      `INSERT INTO anomaly_events (user_id, type, severity, description)
       VALUES ($1, $2, $3, $4)`,
      [userId, type, severity, description]
    );
  } catch (e) {
    console.warn('[AnomalyDetector] 이상 이벤트 저장 실패:', e.message);
  }
}

// ─── 이상 감지 로직 ───────────────────────────────────────────────────────────

/**
 * a. 갑작스러운 활동 중단 감지
 * 평소 활동 시간대(avg > 2)인데 2시간 이상 이벤트 없음
 */
async function detectSuddenStop(db, userId, baseline) {
  const now       = new Date();
  const nowHour   = now.getHours();
  const base      = baseline[nowHour];

  if (!base || base.avg < 2) return null; // 원래 조용한 시간대

  // 최근 2시간 이내 이벤트 수 확인
  const since = new Date(Date.now() - SUDDEN_STOP_MS).toISOString();
  const r = await db.query(
    `SELECT COUNT(*) AS cnt FROM events WHERE user_id = $1 AND created_at >= $2`,
    [userId, since]
  );
  const cnt = parseInt(r.rows[0].cnt, 10);

  if (cnt === 0) {
    return {
      type:        ANOMALY_TYPE.SUDDEN_STOP,
      severity:    SEVERITY.MEDIUM,
      description: `평소 활동 시간대(${nowHour}시, 평균 ${base.avg.toFixed(1)}건/시간)인데 2시간 이상 이벤트 없음`,
    };
  }
  return null;
}

/**
 * b. 비정상 야간 작업 감지
 * 23:00~05:00에 이벤트가 기준선 3배 이상
 */
async function detectNightOverwork(db, userId, baseline) {
  const nowHour = new Date().getHours();
  if (!NIGHT_HOURS.has(nowHour)) return null;

  const base = baseline[nowHour];
  if (!base) return null;

  // 최근 1시간 이벤트 수
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const r = await db.query(
    `SELECT COUNT(*) AS cnt FROM events WHERE user_id = $1 AND created_at >= $2`,
    [userId, since]
  );
  const cnt = parseInt(r.rows[0].cnt, 10);

  const threshold = (base.avg + base.stddev) * NIGHT_ANOMALY_MULTIPLIER;

  if (cnt > threshold && cnt > 5) { // 최소 5건은 넘어야 감지
    return {
      type:        ANOMALY_TYPE.NIGHT_OVERWORK,
      severity:    cnt > threshold * 2 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      description: `야간(${nowHour}시) 이벤트 ${cnt}건 — 기준선(${base.avg.toFixed(1)})의 ${(cnt / Math.max(base.avg, 1)).toFixed(1)}배`,
    };
  }
  return null;
}

/**
 * c. 카카오 과다 감지
 * 최근 3시간 이벤트 중 카카오 비율 80% 이상
 */
async function detectKakaoOverdose(db, userId) {
  const since = new Date(Date.now() - KAKAO_SUSTAINED_MS).toISOString();
  const total = await db.query(
    `SELECT COUNT(*) AS cnt FROM events WHERE user_id = $1 AND created_at >= $2`,
    [userId, since]
  );
  const totalCnt = parseInt(total.rows[0].cnt, 10);
  if (totalCnt < 10) return null; // 샘플 부족

  const kakao = await db.query(
    `SELECT COUNT(*) AS cnt FROM events
     WHERE user_id = $1 AND created_at >= $2
       AND (
         data_json->>'app'    ILIKE '%kakao%'
         OR data_json->>'title' ILIKE '%카카오%'
         OR data_json->>'title' ILIKE '%kakaotalk%'
         OR data_json->>'window_title' ILIKE '%kakaotalk%'
       )`,
    [userId, since]
  );
  const kakaoCnt = parseInt(kakao.rows[0].cnt, 10);
  const ratio    = kakaoCnt / totalCnt;

  if (ratio >= KAKAO_RATIO_THRESHOLD) {
    return {
      type:        ANOMALY_TYPE.KAKAO_OVERDOSE,
      severity:    ratio >= 0.95 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      description: `최근 3시간 카카오 사용 비율 ${(ratio * 100).toFixed(0)}% (${kakaoCnt}/${totalCnt}건)`,
    };
  }
  return null;
}

/**
 * d. 반복 오류 패턴 감지
 * 최근 30분 내 같은 화면(window_title)에서 취소/닫기 5회 이상
 */
async function detectRepeatError(db, userId) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await db.query(
    `SELECT
       COALESCE(data_json->>'window_title', data_json->>'title', 'unknown') AS screen,
       COUNT(*) AS cnt
     FROM events
     WHERE user_id = $1 AND created_at >= $2
       AND (
         data_json->>'type'  ILIKE '%cancel%'
         OR data_json->>'type'  ILIKE '%close%'
         OR data_json->>'key'   ILIKE '%escape%'
         OR type ILIKE '%cancel%'
         OR type ILIKE '%close%'
       )
     GROUP BY screen
     HAVING COUNT(*) >= $3`,
    [userId, since, REPEAT_ERROR_COUNT]
  );

  if (r.rows.length > 0) {
    const worst = r.rows.reduce((a, b) =>
      parseInt(a.cnt, 10) > parseInt(b.cnt, 10) ? a : b
    );
    return {
      type:        ANOMALY_TYPE.REPEAT_ERROR,
      severity:    parseInt(worst.cnt, 10) >= 10 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      description: `화면 "${worst.screen}"에서 취소/닫기 ${worst.cnt}회 반복 (최근 30분)`,
    };
  }
  return null;
}

/**
 * 모든 이상 감지 실행 후 새로운 이상 이벤트를 DB에 저장
 * @param {import('pg').Pool} db
 * @param {string} userId
 * @returns {Promise<Array>} 감지된 이상 이벤트 배열
 */
async function runDetection(db, userId) {
  const baseline = await getBaseline(db, userId);

  const [stop, night, kakao, repeat] = await Promise.all([
    detectSuddenStop(db, userId, baseline).catch(() => null),
    detectNightOverwork(db, userId, baseline).catch(() => null),
    detectKakaoOverdose(db, userId).catch(() => null),
    detectRepeatError(db, userId).catch(() => null),
  ]);

  const detected = [stop, night, kakao, repeat].filter(Boolean);

  // 중복 방지: 같은 타입이 최근 1시간 내 이미 있으면 skip
  const saved = [];
  for (const anomaly of detected) {
    const recent = await db.query(
      `SELECT id FROM anomaly_events
       WHERE user_id = $1 AND type = $2 AND detected_at >= NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [userId, anomaly.type]
    );
    if (recent.rows.length === 0) {
      await saveAnomaly(db, userId, anomaly.type, anomaly.severity, anomaly.description);
      saved.push(anomaly);
    }
  }
  return saved;
}

// ─── Express 라우터 ───────────────────────────────────────────────────────────

/**
 * @param {{ db: import('pg').Pool }} deps
 * @returns {import('express').Router}
 */
module.exports = function createAnomalyRouter(deps) {
  const db     = deps.db;
  const router = Router();

  // DB 테이블 초기화 (비동기, 에러 무시)
  ensureTables(db).catch(e =>
    console.warn('[AnomalyDetector] 테이블 초기화 경고:', e.message)
  );

  // ── GET /api/anomaly/recent?userId=xxx ────────────────────────────────
  router.get('/recent', async (req, res) => {
    const { userId, hours = 24 } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const since = new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString();
      const r = await db.query(
        `SELECT id, user_id, type, severity, description, detected_at
         FROM anomaly_events
         WHERE user_id = $1 AND detected_at >= $2
         ORDER BY detected_at DESC`,
        [userId, since]
      );
      res.json({ userId, hours: Number(hours), count: r.rows.length, events: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/anomaly/stats ────────────────────────────────────────────
  router.get('/stats', async (req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const r = await db.query(
        `SELECT
           user_id,
           type,
           severity,
           COUNT(*) AS cnt,
           MAX(detected_at) AS last_detected
         FROM anomaly_events
         WHERE detected_at >= $1
         GROUP BY user_id, type, severity
         ORDER BY cnt DESC`,
        [since]
      );
      // userId별로 집계
      const byUser = {};
      for (const row of r.rows) {
        if (!byUser[row.user_id]) byUser[row.user_id] = { userId: row.user_id, total: 0, types: {} };
        byUser[row.user_id].total += parseInt(row.cnt, 10);
        byUser[row.user_id].types[row.type] = {
          count:        parseInt(row.cnt, 10),
          severity:     row.severity,
          lastDetected: row.last_detected,
        };
      }
      res.json({
        since,
        userCount: Object.keys(byUser).length,
        stats:     Object.values(byUser),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/anomaly/baseline/update ────────────────────────────────
  router.post('/baseline/update', async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const result = await recalcBaseline(db, userId);
      res.json({ ok: true, userId, hoursUpdated: result.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/anomaly/detect (수동 트리거) ─────────────────────────────
  router.post('/detect', async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const detected = await runDetection(db, userId);
      res.json({ ok: true, userId, detected: detected.length, events: detected });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// 내부 함수 export (테스트용)
module.exports.recalcBaseline = recalcBaseline;
module.exports.runDetection   = runDetection;
module.exports.ANOMALY_TYPE   = ANOMALY_TYPE;
module.exports.SEVERITY       = SEVERITY;
