/**
 * routes/automation-scorer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vision 분석 기반 화면/앱별 자동화 가능성 점수 누적 학습
 *
 * 테이블:
 *   screen_automation_scores — 앱+화면별 자동화 점수 누적
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId, getDb }} deps
 */
module.exports = function createAutomationScorerRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId, getDb } = deps;
  const router = express.Router();

  // ── 테이블 초기화 ──────────────────────────────────────────────────────────
  async function ensureTables() {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS screen_automation_scores (
        id                  SERIAL PRIMARY KEY,
        user_id             TEXT NOT NULL,
        app                 TEXT NOT NULL,
        screen              TEXT NOT NULL,
        auto_score_avg      FLOAT NOT NULL DEFAULT 0,
        auto_score_count    INTEGER NOT NULL DEFAULT 0,
        human_required_avg  FLOAT NOT NULL DEFAULT 0,
        nenova_mappable     BOOLEAN DEFAULT FALSE,
        last_analyzed       TIMESTAMPTZ DEFAULT NOW(),
        sample_json         JSONB DEFAULT '[]',
        is_candidate        BOOLEAN DEFAULT FALSE,
        UNIQUE(user_id, app, screen)
      );
      CREATE INDEX IF NOT EXISTS idx_sas_user    ON screen_automation_scores(user_id);
      CREATE INDEX IF NOT EXISTS idx_sas_app     ON screen_automation_scores(app);
      CREATE INDEX IF NOT EXISTS idx_sas_score   ON screen_automation_scores(auto_score_avg DESC);
      CREATE INDEX IF NOT EXISTS idx_sas_cand    ON screen_automation_scores(is_candidate) WHERE is_candidate = TRUE;
    `);
  }

  ensureTables().catch(e => console.warn('[automation-scorer] 테이블 초기화 경고:', e.message));

  // ── 인증 미들웨어 (JWT + orbit_xxx 디바이스 토큰 겸용) ────────────────────
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

  // ── 공통 헬퍼: 점수 upsert ───────────────────────────────────────────────
  async function upsertScore(db, { userId, app, screen, autoScore, humanRequired, nenovaMappable, sampleEntry }) {
    const AUTO_CANDIDATE_THRESHOLD = 0.6;

    // 최근 샘플 최대 10개 유지
    const existing = await db.query(
      `SELECT auto_score_avg, auto_score_count, human_required_avg, sample_json
       FROM screen_automation_scores
       WHERE user_id=$1 AND app=$2 AND screen=$3`,
      [userId, app, screen]
    );

    let newAvgAuto, newAvgHuman, newCount, newSamples;

    if (existing.rows.length === 0) {
      newAvgAuto   = autoScore;
      newAvgHuman  = humanRequired;
      newCount     = 1;
      newSamples   = sampleEntry ? [sampleEntry] : [];
    } else {
      const row = existing.rows[0];
      const cnt = row.auto_score_count;
      newCount     = cnt + 1;
      newAvgAuto   = (row.auto_score_avg * cnt + autoScore) / newCount;
      newAvgHuman  = (row.human_required_avg * cnt + humanRequired) / newCount;
      const prevSamples = Array.isArray(row.sample_json) ? row.sample_json : [];
      newSamples   = sampleEntry
        ? [...prevSamples, sampleEntry].slice(-10)
        : prevSamples;
    }

    const isCandidate = newAvgAuto >= AUTO_CANDIDATE_THRESHOLD;

    await db.query(
      `INSERT INTO screen_automation_scores
         (user_id, app, screen, auto_score_avg, auto_score_count, human_required_avg, nenova_mappable, last_analyzed, sample_json, is_candidate)
       VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9)
       ON CONFLICT(user_id, app, screen) DO UPDATE
         SET auto_score_avg     = EXCLUDED.auto_score_avg,
             auto_score_count   = EXCLUDED.auto_score_count,
             human_required_avg = EXCLUDED.human_required_avg,
             nenova_mappable    = EXCLUDED.nenova_mappable,
             last_analyzed      = NOW(),
             sample_json        = EXCLUDED.sample_json,
             is_candidate       = EXCLUDED.is_candidate`,
      [userId, app, screen,
       parseFloat(newAvgAuto.toFixed(4)),
       newCount,
       parseFloat(newAvgHuman.toFixed(4)),
       nenovaMappable || false,
       JSON.stringify(newSamples),
       isCandidate]
    );

    return { newAvgAuto, newAvgHuman, newCount, isCandidate };
  }

  // ── 자동화 우선순위 점수 계산 ─────────────────────────────────────────────
  // score = (auto_score_avg * 0.4) + (frequency_norm * 0.3) + (time_saved_norm * 0.3)
  function calcRankScore(row, maxCount, maxDuration) {
    const freqNorm    = maxCount > 0 ? row.auto_score_count / maxCount : 0;
    const timeSavedNorm = maxDuration > 0 ? (row.avg_duration_sec || 0) / maxDuration : 0;
    return (row.auto_score_avg * 0.4) + (freqNorm * 0.3) + (timeSavedNorm * 0.3);
  }

  // ── GET /api/automation-scorer/ranking ────────────────────────────────────
  // 자동화 우선순위 랭킹 (전 사용자 또는 userId 기준)
  router.get('/ranking', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);
      const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 100);

      const db = getDb();

      // past_durations 와 LEFT JOIN 해서 time_saved 추정
      const result = await db.query(
        `SELECT s.app, s.screen,
                s.auto_score_avg, s.auto_score_count,
                s.human_required_avg, s.nenova_mappable, s.is_candidate,
                s.last_analyzed,
                COALESCE(d.avg_duration_sec, 0) AS avg_duration_sec
         FROM screen_automation_scores s
         LEFT JOIN past_durations d
           ON d.user_id = s.user_id AND LOWER(d.app) = LOWER(s.app)
         WHERE s.user_id = $1
         ORDER BY s.auto_score_avg DESC`,
        [userId]
      );

      const rows = result.rows;
      if (rows.length === 0) return res.json({ ranking: [], total: 0 });

      const maxCount    = Math.max(...rows.map(r => r.auto_score_count), 1);
      const maxDuration = Math.max(...rows.map(r => parseFloat(r.avg_duration_sec) || 0), 1);

      const ranked = rows
        .map(r => ({
          app:             r.app,
          screen:          r.screen,
          autoScoreAvg:    parseFloat(r.auto_score_avg),
          sampleCount:     r.auto_score_count,
          humanRequiredAvg: parseFloat(r.human_required_avg),
          nenovaMappable:  r.nenova_mappable,
          isCandidate:     r.is_candidate,
          avgDurationSec:  parseFloat(r.avg_duration_sec),
          rankScore:       parseFloat(calcRankScore(r, maxCount, maxDuration).toFixed(4)),
          lastAnalyzed:    r.last_analyzed,
        }))
        .sort((a, b) => b.rankScore - a.rankScore)
        .slice(0, limit);

      res.json({ ranking: ranked, total: rows.length });
    } catch (e) {
      console.error('[automation-scorer/ranking]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/automation-scorer/app/:app ───────────────────────────────────
  // 특정 앱의 화면별 자동화 점수
  router.get('/app/:app', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);
      const app = decodeURIComponent(req.params.app).toLowerCase();

      const db = getDb();
      const result = await db.query(
        `SELECT screen, auto_score_avg, auto_score_count,
                human_required_avg, nenova_mappable, is_candidate,
                last_analyzed, sample_json
         FROM screen_automation_scores
         WHERE user_id=$1 AND LOWER(app)=$2
         ORDER BY auto_score_avg DESC`,
        [userId, app]
      );

      // 앱 전체 가중 평균
      let totalWeight = 0, weightedSum = 0;
      for (const r of result.rows) {
        weightedSum += r.auto_score_avg * r.auto_score_count;
        totalWeight += r.auto_score_count;
      }
      const appAvgScore = totalWeight > 0
        ? parseFloat((weightedSum / totalWeight).toFixed(4))
        : 0;

      const nenovaMappableCount = result.rows.filter(r => r.nenova_mappable).length;
      const humanRatioPct = result.rows.length > 0
        ? parseFloat((result.rows.reduce((s, r) => s + r.human_required_avg, 0) / result.rows.length * 100).toFixed(1))
        : 0;

      res.json({
        app,
        appAvgAutoScore: appAvgScore,
        nenovaMappableScreens: nenovaMappableCount,
        humanRequiredRatioPct: humanRatioPct,
        totalScreens: result.rows.length,
        screens: result.rows.map(r => ({
          screen:          r.screen,
          autoScoreAvg:    parseFloat(r.auto_score_avg),
          sampleCount:     r.auto_score_count,
          humanRequiredAvg: parseFloat(r.human_required_avg),
          nenovaMappable:  r.nenova_mappable,
          isCandidate:     r.is_candidate,
          lastAnalyzed:    r.last_analyzed,
          recentSamples:   r.sample_json,
        })),
      });
    } catch (e) {
      console.error('[automation-scorer/app]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/automation-scorer/candidates ─────────────────────────────────
  // 신규 자동화 후보 (auto_score_avg > 0.6, is_candidate=true)
  router.get('/candidates', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.query.userId)
        : (req.query.userId || req.user.id);
      const minScore = parseFloat(req.query.min_score || '0.6');

      const db = getDb();
      const result = await db.query(
        `SELECT app, screen, auto_score_avg, auto_score_count,
                human_required_avg, nenova_mappable, last_analyzed
         FROM screen_automation_scores
         WHERE user_id=$1 AND auto_score_avg >= $2
         ORDER BY auto_score_avg DESC
         LIMIT 50`,
        [userId, minScore]
      );

      res.json({
        candidates: result.rows.map(r => ({
          app:             r.app,
          screen:          r.screen,
          autoScoreAvg:    parseFloat(r.auto_score_avg),
          sampleCount:     r.auto_score_count,
          humanRequiredAvg: parseFloat(r.human_required_avg),
          nenovaMappable:  r.nenova_mappable,
          lastAnalyzed:    r.last_analyzed,
        })),
        total: result.rows.length,
        minScore,
      });
    } catch (e) {
      console.error('[automation-scorer/candidates]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/automation-scorer/ingest ────────────────────────────────────
  // Vision 분석 결과 수동 추가 (vision-worker.js 또는 관리자 호출)
  // body: { userId, app, screen, auto_score, human_required, nenova_mappable, metadata }
  router.post('/ingest', auth, async (req, res) => {
    try {
      const userId = resolveUserId
        ? resolveUserId(req.user, req.body.userId)
        : (req.body.userId || req.user.id);

      const {
        app,
        screen,
        auto_score,
        human_required = 0,
        nenova_mappable = false,
        metadata = {},
      } = req.body;

      if (!app || !screen || auto_score == null) {
        return res.status(400).json({ error: 'app, screen, auto_score 필수' });
      }

      const autoScore     = Math.max(0, Math.min(1, parseFloat(auto_score)));
      const humanRequired = Math.max(0, Math.min(1, parseFloat(human_required)));
      const appNorm       = app.toLowerCase().replace(/\.exe$/i, '');

      const sampleEntry = {
        ts:           new Date().toISOString(),
        auto_score:   autoScore,
        human_req:    humanRequired,
        ...metadata,
      };

      const db = getDb();
      const { newAvgAuto, newAvgHuman, newCount, isCandidate } = await upsertScore(db, {
        userId,
        app: appNorm,
        screen,
        autoScore,
        humanRequired,
        nenovaMappable: nenova_mappable,
        sampleEntry,
      });

      res.json({
        ok: true,
        app: appNorm,
        screen,
        avgAutoScore:    parseFloat(newAvgAuto.toFixed(4)),
        avgHumanRequired: parseFloat(newAvgHuman.toFixed(4)),
        sampleCount:     newCount,
        isCandidate,
        newCandidateAlert: isCandidate && newCount === 1,
      });
    } catch (e) {
      console.error('[automation-scorer/ingest]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/automation-scorer/webhook ───────────────────────────────────
  // screen.analyzed 이벤트 자동 수신 (데몬/Vision 워커 → 서버 내부 호출용)
  // body: { userId, event_type, data: { app, screen, auto_score, human_required, nenova_mappable } }
  router.post('/webhook', async (req, res) => {
    try {
      // 내부 웹훅: Bearer 또는 쿼리 토큰 인증
      const token = req.headers.authorization || req.query.token;
      if (token) {
        const user = verifyToken(token);
        if (!user) return res.status(401).json({ error: 'Invalid token' });
        req.user = user;
      }

      const { event_type, data = {}, userId: bodyUserId } = req.body;

      if (event_type !== 'screen.analyzed') {
        return res.status(400).json({ error: `지원하지 않는 이벤트: ${event_type}` });
      }

      const userId = (req.user && resolveUserId)
        ? resolveUserId(req.user, bodyUserId)
        : (bodyUserId || 'unknown');

      const {
        app,
        screen,
        auto_score,
        human_required = 0,
        nenova_mappable = false,
      } = data;

      if (!app || !screen || auto_score == null) {
        return res.status(400).json({ error: 'data.app, data.screen, data.auto_score 필수' });
      }

      const autoScore     = Math.max(0, Math.min(1, parseFloat(auto_score)));
      const humanRequired = Math.max(0, Math.min(1, parseFloat(human_required)));
      const appNorm       = app.toLowerCase().replace(/\.exe$/i, '');

      const db = getDb();
      const { newAvgAuto, newCount, isCandidate } = await upsertScore(db, {
        userId,
        app: appNorm,
        screen,
        autoScore,
        humanRequired,
        nenovaMappable: nenova_mappable,
        sampleEntry: { ts: new Date().toISOString(), auto_score: autoScore },
      });

      res.json({
        ok:          true,
        app:         appNorm,
        screen,
        avgAutoScore: parseFloat(newAvgAuto.toFixed(4)),
        sampleCount: newCount,
        isCandidate,
      });
    } catch (e) {
      console.error('[automation-scorer/webhook]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
