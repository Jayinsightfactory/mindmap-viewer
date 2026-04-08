/**
 * routes/prediction-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 업무 패턴 기반 완료 시간 예측 + 다음 작업 예측 엔진
 *
 * 테이블:
 *   past_durations    — 앱+화면별 평균 소요시간 누적
 *   daily_predictions — 일일 예측값 vs 실제값 (재학습용)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId, getDb }} deps
 */
module.exports = function createPredictionEngineRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId, getDb } = deps;
  const router = express.Router();

  // ── 테이블 초기화 ──────────────────────────────────────────────────────────
  async function ensureTables() {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS past_durations (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        app         TEXT NOT NULL,
        screen_type TEXT NOT NULL DEFAULT 'default',
        avg_duration_sec FLOAT NOT NULL DEFAULT 0,
        sample_count     INTEGER NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, app, screen_type)
      );
      CREATE INDEX IF NOT EXISTS idx_past_durations_user ON past_durations(user_id);

      CREATE TABLE IF NOT EXISTS daily_predictions (
        id                SERIAL PRIMARY KEY,
        user_id           TEXT NOT NULL,
        date              DATE NOT NULL,
        predicted_events  INTEGER,
        actual_events     INTEGER,
        error_rate        FLOAT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_pred_user ON daily_predictions(user_id, date);
    `);
  }

  // 서버 시작 시 테이블 보장 (비동기, 실패해도 라우트는 등록됨)
  ensureTables().catch(e => console.warn('[prediction-engine] 테이블 초기화 경고:', e.message));

  // ── 인증 미들웨어 ──────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = req.headers.authorization || req.query.token || req.cookies?.orbit_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  }

  // ── 공통 헬퍼: 앱 시퀀스 추출 ────────────────────────────────────────────
  function extractAppSequence(events, n = 20) {
    return events
      .filter(e => e.data_json?.app || e.data_json?.window_title)
      .map(e => (e.data_json?.app || '').toLowerCase().replace(/\.exe$/i, ''))
      .filter(Boolean)
      .slice(-n);
  }

  // ── 앱 전환 트랜지션 행렬 구축 ───────────────────────────────────────────
  function buildTransitionMatrix(appSeq) {
    const matrix = {};
    for (let i = 0; i < appSeq.length - 1; i++) {
      const cur = appSeq[i];
      const nxt = appSeq[i + 1];
      if (!matrix[cur]) matrix[cur] = {};
      matrix[cur][nxt] = (matrix[cur][nxt] || 0) + 1;
    }
    return matrix;
  }

  // ── 시간대별 이벤트 밀도 히스토그램 구축 ─────────────────────────────────
  function buildHourHistogram(events) {
    const hist = new Array(24).fill(0);
    for (const e of events) {
      const ts = e.timestamp || e.created_at;
      if (!ts) continue;
      const h = new Date(ts).getHours();
      if (h >= 0 && h < 24) hist[h]++;
    }
    return hist;
  }

  // ── 요일별 평균 이벤트 수 계산 ───────────────────────────────────────────
  function buildDowStats(events) {
    const buckets = Array.from({ length: 7 }, () => ({ total: 0, days: new Set() }));
    for (const e of events) {
      const ts = e.timestamp || e.created_at;
      if (!ts) continue;
      const d = new Date(ts);
      const dow = d.getDay(); // 0=일 ~ 6=토
      const dateStr = d.toISOString().slice(0, 10);
      buckets[dow].total++;
      buckets[dow].days.add(dateStr);
    }
    return buckets.map(b => ({
      avg: b.days.size > 0 ? b.total / b.days.size : 0,
      samples: b.days.size,
    }));
  }

  // ── 주요 앱 추출 ─────────────────────────────────────────────────────────
  function getMainApp(events) {
    const freq = {};
    for (const e of events) {
      const app = (e.data_json?.app || '').toLowerCase().replace(/\.exe$/i, '');
      if (app) freq[app] = (freq[app] || 0) + 1;
    }
    let best = null, bestCount = 0;
    for (const [app, cnt] of Object.entries(freq)) {
      if (cnt > bestCount) { best = app; bestCount = cnt; }
    }
    return best;
  }

  // ── GET /api/predict/next ─────────────────────────────────────────────────
  // 현재 앱 + 이전 시퀀스 기반으로 다음 앱 예측
  router.get('/next', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);
      const currentApp = (req.query.currentApp || '').toLowerCase().replace(/\.exe$/i, '');

      const events = await getEventsForUser(userId, { limit: 500 });
      const appSeq = extractAppSequence(events);
      const matrix = buildTransitionMatrix(appSeq);

      // 현재 앱 기준 다음 앱 확률 계산
      const transitions = matrix[currentApp] || {};
      const total = Object.values(transitions).reduce((s, v) => s + v, 0);

      if (total === 0) {
        // 전체 빈도 기반 fallback
        const freq = {};
        for (const app of appSeq) freq[app] = (freq[app] || 0) + 1;
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
        return res.json({
          currentApp,
          predictions: sorted.map(([app, cnt]) => ({
            app,
            probability: parseFloat((cnt / appSeq.length).toFixed(3)),
            confidence: 0.3,
          })),
          method: 'frequency_fallback',
        });
      }

      const predictions = Object.entries(transitions)
        .map(([app, cnt]) => ({
          app,
          probability: parseFloat((cnt / total).toFixed(3)),
          confidence: parseFloat(Math.min(1.0, total / 10).toFixed(3)),
        }))
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 5);

      // 현재 시간대 고려한 시간대 보정
      const hour = new Date().getHours();
      const hist = buildHourHistogram(events);
      const peakHour = hist.indexOf(Math.max(...hist));
      const isNearPeak = Math.abs(hour - peakHour) <= 1;

      res.json({
        currentApp,
        predictions,
        context: {
          currentHour: hour,
          peakHour,
          isNearPeak,
          recentSequence: appSeq.slice(-5),
        },
        method: 'transition_matrix',
      });
    } catch (e) {
      console.error('[predict/next]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/predict/today ────────────────────────────────────────────────
  // 오늘 예상 업무량 (이벤트 수, 소요시간, 주요 앱, 피크타임)
  router.get('/today', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);

      const events = await getEventsForUser(userId, { limit: 2000 });

      const dow = new Date().getDay();
      const dowStats = buildDowStats(events);
      const todayStat = dowStats[dow];

      const expectedEvents = Math.round(todayStat.avg);
      const confidence = parseFloat(Math.min(1.0, todayStat.samples / 4).toFixed(3));

      // 평균 이벤트당 소요시간 추정 (30초 기본)
      const db = getDb();
      const durRes = await db.query(
        `SELECT AVG(avg_duration_sec) AS avg FROM past_durations WHERE user_id = $1`,
        [userId]
      ).catch(() => ({ rows: [{ avg: 30 }] }));
      const avgDurSec = parseFloat(durRes.rows[0]?.avg || 30);
      const expectedDuration = Math.round(expectedEvents * avgDurSec);

      const mainApp = getMainApp(events);

      // 피크타임 계산 (오늘 같은 요일 이벤트 기반)
      const hist = buildHourHistogram(events);
      const peakHour = hist.indexOf(Math.max(...hist));

      // daily_predictions 에 오늘 예측 저장 (upsert)
      const today = new Date().toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO daily_predictions(user_id, date, predicted_events)
         VALUES($1, $2, $3)
         ON CONFLICT(user_id, date) DO UPDATE SET predicted_events = EXCLUDED.predicted_events`,
        [userId, today, expectedEvents]
      ).catch(() => {});

      res.json({
        userId,
        date: today,
        dayOfWeek: ['일', '월', '화', '수', '목', '금', '토'][dow],
        expectedEvents,
        expectedDurationSec: expectedDuration,
        expectedDurationMin: Math.round(expectedDuration / 60),
        mainApp,
        peakHour,
        confidence,
        sampleDays: todayStat.samples,
      });
    } catch (e) {
      console.error('[predict/today]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/predict/duration ─────────────────────────────────────────────
  // 특정 앱+화면 유형의 예상 완료 시간
  router.get('/duration', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);
      const app = (req.query.app || '').toLowerCase().replace(/\.exe$/i, '');
      const screenType = req.query.screen_type || 'default';

      if (!app) return res.status(400).json({ error: 'app 파라미터 필수' });

      const db = getDb();
      const result = await db.query(
        `SELECT avg_duration_sec, sample_count, updated_at
         FROM past_durations
         WHERE user_id = $1 AND app = $2 AND screen_type = $3`,
        [userId, app, screenType]
      );

      if (result.rows.length === 0) {
        return res.json({
          app,
          screenType,
          avgDurationSec: null,
          confidence: 0,
          message: '데이터 없음 — 히스토리 누적 중',
        });
      }

      const row = result.rows[0];
      const confidence = parseFloat(Math.min(1.0, row.sample_count / 20).toFixed(3));

      res.json({
        app,
        screenType,
        avgDurationSec: Math.round(row.avg_duration_sec),
        avgDurationMin: parseFloat((row.avg_duration_sec / 60).toFixed(1)),
        sampleCount: row.sample_count,
        confidence,
        updatedAt: row.updated_at,
      });
    } catch (e) {
      console.error('[predict/duration]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/predict/peak-times ───────────────────────────────────────────
  // 시간대별 예상 피크타임 (히스토그램 반환)
  router.get('/peak-times', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);

      const events = await getEventsForUser(userId, { limit: 2000 });
      const hist = buildHourHistogram(events);
      const maxVal = Math.max(...hist);
      const peakHours = hist
        .map((cnt, h) => ({ hour: h, count: cnt, isPeak: cnt === maxVal }))
        .filter(h => h.count > 0);

      const topPeaks = peakHours
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map(h => h.hour);

      res.json({
        histogram: hist,
        peakHours: topPeaks,
        totalEvents: events.length,
        description: topPeaks.map(h => `${h}시~${h + 1}시`).join(', '),
      });
    } catch (e) {
      console.error('[predict/peak-times]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/predict/record ──────────────────────────────────────────────
  // 실제 완료 시간 기록 (재학습용) — 데몬/Vision 워커가 호출
  // body: { userId, app, screen_type, actual_duration_sec }
  router.post('/record', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.body.userId)
        : (req.body.userId || req.user.id);
      const app = (req.body.app || '').toLowerCase().replace(/\.exe$/i, '');
      const screenType = req.body.screen_type || 'default';
      const actualDuration = parseFloat(req.body.actual_duration_sec);

      if (!app || isNaN(actualDuration) || actualDuration <= 0) {
        return res.status(400).json({ error: 'app, actual_duration_sec 필수' });
      }

      const db = getDb();

      // 지수이동평균 upsert (가중: 기존 avg * count + new) / (count+1)
      await db.query(
        `INSERT INTO past_durations(user_id, app, screen_type, avg_duration_sec, sample_count, updated_at)
         VALUES($1, $2, $3, $4, 1, NOW())
         ON CONFLICT(user_id, app, screen_type) DO UPDATE
           SET avg_duration_sec = (
                 past_durations.avg_duration_sec * past_durations.sample_count + EXCLUDED.avg_duration_sec
               ) / (past_durations.sample_count + 1),
               sample_count = past_durations.sample_count + 1,
               updated_at   = NOW()`,
        [userId, app, screenType, actualDuration]
      );

      res.json({ ok: true, app, screenType, recorded: actualDuration });
    } catch (e) {
      console.error('[predict/record]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/predict/record-actual-day ──────────────────────────────────
  // 하루 끝에 실제 이벤트 수 기록 → error_rate 계산 및 저장
  // body: { userId, date, actual_events }
  router.post('/record-actual-day', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.body.userId)
        : (req.body.userId || req.user.id);
      const date = req.body.date || new Date().toISOString().slice(0, 10);
      const actualEvents = parseInt(req.body.actual_events, 10);

      if (isNaN(actualEvents)) return res.status(400).json({ error: 'actual_events 필수' });

      const db = getDb();
      const existing = await db.query(
        `SELECT predicted_events FROM daily_predictions WHERE user_id=$1 AND date=$2`,
        [userId, date]
      );

      let errorRate = null;
      if (existing.rows.length > 0 && existing.rows[0].predicted_events != null) {
        const pred = existing.rows[0].predicted_events;
        errorRate = pred > 0 ? parseFloat(Math.abs(pred - actualEvents) / pred).toFixed(3) : null;
      }

      await db.query(
        `INSERT INTO daily_predictions(user_id, date, actual_events, error_rate)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(user_id, date) DO UPDATE
           SET actual_events = EXCLUDED.actual_events,
               error_rate    = EXCLUDED.error_rate`,
        [userId, date, actualEvents, errorRate]
      );

      res.json({ ok: true, date, actualEvents, errorRate: parseFloat(errorRate) });
    } catch (e) {
      console.error('[predict/record-actual-day]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
