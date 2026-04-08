'use strict';
/**
 * think-engine.js — 사고 엔진
 *
 * 모든 문제에 대해 자동으로:
 *   조사 → 대안 발견 → 테스트 → 디벨롭 → 반복
 *
 * 핵심 능력:
 *   1. 범용 업무 인식 ([상황]→[행동]→[결과] 프레임)
 *   2. 전이 확률 모델 (다음 행동 예측)
 *   3. 결과값 예측 + Vision 검증
 *   4. 카카오톡 대화 자동 저장 (Vision OCR)
 *   5. 확장 사고 ("이 데이터가 있으면 이것도 가능")
 *   6. 사고 루프 (자동 탐색+테스트+디벨롭)
 */
const express = require('express');

function createThinkEngine({ getDb, ragCore }) {
  const router = express.Router();

  function _normalizeState(raw) {
    if (!raw || raw.length < 2) return null;
    const s = raw
      .toLowerCase()
      .replace(/[-_|•·]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\d{5,}/g, '#')
      .replace(/[()[\]{}]/g, '')
      .trim()
      .slice(0, 80);
    if (s.length < 3) return null;
    const noise = ['untitled', 'desktop', 'taskbar', '시작', 'start menu', 'program manager'];
    if (noise.includes(s)) return null;
    return s;
  }

  // ── 시간대 구분 헬퍼 ──
  // 0=새벽(0-5), 1=오전(6-11), 2=오후(12-17), 3=저녁(18-23)
  function _timeSlot(date) {
    const h = (date instanceof Date ? date : new Date(date)).getHours();
    if (h < 6)  return 0;
    if (h < 12) return 1;
    if (h < 18) return 2;
    return 3;
  }
  const TIME_SLOT_NAMES = ['새벽', '오전', '오후', '저녁'];

  // ── 테이블 초기화 ──
  async function _ensureTables(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS transition_model (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        probability REAL DEFAULT 0,
        count INT DEFAULT 0,
        avg_seconds REAL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, from_state, to_state)
      )
    `);
    // 시간대별 전이 확률 테이블 (기존 테이블과 분리)
    await db.query(`
      CREATE TABLE IF NOT EXISTS transition_model_timeslot (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        time_slot INT NOT NULL,
        probability REAL DEFAULT 0,
        count INT DEFAULT 0,
        avg_seconds REAL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, from_state, to_state, time_slot)
      )
    `).catch(() => {});
    // 연속 실패 추적 테이블
    await db.query(`
      CREATE TABLE IF NOT EXISTS prediction_fail_streak (
        user_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        streak INT DEFAULT 0,
        last_fail_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, from_state, to_state)
      )
    `).catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        predicted_action TEXT,
        predicted_value TEXT,
        actual_action TEXT,
        actual_value TEXT,
        correct BOOLEAN,
        confidence REAL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS kakao_messages (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        chatroom TEXT,
        messages JSONB,
        capture_event_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // 기존 테이블에 새 컬럼 추가 (마이그레이션)
    await db.query(`ALTER TABLE kakao_messages ADD COLUMN IF NOT EXISTS messages JSONB`).catch(() => {});
    await db.query(`ALTER TABLE kakao_messages ADD COLUMN IF NOT EXISTS capture_event_id TEXT`).catch(() => {});
    // 기존 vision_event_id → capture_event_id 데이터 복사
    await db.query(`UPDATE kakao_messages SET capture_event_id = vision_event_id WHERE capture_event_id IS NULL AND vision_event_id IS NOT NULL`).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS think_log (
        id SERIAL PRIMARY KEY,
        phase TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT,
        detail JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS capability_ideas (
        id SERIAL PRIMARY KEY,
        source TEXT UNIQUE,
        current_data TEXT,
        additional_needed TEXT,
        new_capability TEXT,
        feasibility REAL DEFAULT 0,
        discovered_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/status — 사고 엔진 현재 상태
  // ═══════════════════════════════════════════════════════════════
  router.get('/status', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const [transRes, predRes, kakaoRes, logRes, capRes] = await Promise.all([
        db.query('SELECT COUNT(*) as cnt, COUNT(DISTINCT user_id) as users FROM transition_model'),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE correct=true) as correct FROM predictions`),
        db.query('SELECT COUNT(*) as cnt, COUNT(DISTINCT chatroom) as rooms FROM kakao_messages'),
        db.query('SELECT COUNT(*) as cnt FROM think_log WHERE created_at > NOW() - INTERVAL \'24 hours\''),
        db.query('SELECT COUNT(*) as cnt FROM capability_ideas'),
      ]);

      const t = transRes.rows[0] || {};
      const p = predRes.rows[0] || {};
      const k = kakaoRes.rows[0] || {};
      const total = parseInt(p.total) || 0;
      const correct = parseInt(p.correct) || 0;

      res.json({
        engine: 'think-engine v2',
        transitionModel: { rules: parseInt(t.cnt) || 0, users: parseInt(t.users) || 0 },
        predictions: { total, correct, accuracy: total > 0 ? Math.round(correct / total * 100) : 0 },
        kakaoMessages: { total: parseInt(k.cnt) || 0, chatrooms: parseInt(k.rooms) || 0 },
        capabilityIdeas: { total: parseInt(capRes.rows[0]?.cnt) || 0 },
        thinkingActivity: { last24h: parseInt(logRes.rows[0]?.cnt) || 0 },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/think/learn — 전이 확률 모델 학습 (모든 직원 범용)
  // ═══════════════════════════════════════════════════════════════
  router.post('/learn', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const hours = parseInt(req.query.hours || '24');

      // 모든 직원의 앱 전환 패턴 추출
      const transitions = await db.query(`
        WITH ordered AS (
          SELECT user_id, timestamp,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as state,
            LAG(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as prev_state,
            LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_ts
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
            AND user_id NOT IN ('MMOLABXL2066516519')
        )
        SELECT user_id, prev_state as from_state, state as to_state,
          COUNT(*) as cnt,
          AVG(EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz))) as avg_sec
        FROM ordered
        WHERE state IS NOT NULL AND prev_state IS NOT NULL
          AND state != prev_state
          AND LENGTH(state) > 3 AND LENGTH(prev_state) > 3
          AND EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz)) < 600
        GROUP BY user_id, from_state, to_state
        HAVING COUNT(*) >= 2
      `);

      // 유저별 전체 전환 수로 확률 계산
      const userTotals = {};
      for (const r of transitions.rows) {
        const key = `${r.user_id}:${r.from_state}`;
        userTotals[key] = (userTotals[key] || 0) + parseInt(r.cnt);
      }

      let upserted = 0;
      for (const r of transitions.rows) {
        const key = `${r.user_id}:${r.from_state}`;
        const prob = parseInt(r.cnt) / (userTotals[key] || 1);

        await db.query(`
          INSERT INTO transition_model (user_id, from_state, to_state, probability, count, avg_seconds, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (user_id, from_state, to_state) DO UPDATE SET
            probability = $4, count = $5, avg_seconds = $6, updated_at = NOW()
        `, [r.user_id, r.from_state, r.to_state, +prob.toFixed(3), parseInt(r.cnt), +parseFloat(r.avg_sec || 0).toFixed(1)]);
        upserted++;
      }

      // 시간대별 전이 확률 학습
      const slotTransitions = await db.query(`
        WITH ordered AS (
          SELECT user_id, timestamp,
            EXTRACT(HOUR FROM timestamp::timestamptz) as hr,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as state,
            LAG(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as prev_state,
            LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_ts
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
            AND user_id NOT IN ('MMOLABXL2066516519')
        )
        SELECT user_id, prev_state as from_state, state as to_state,
          CASE WHEN hr < 6 THEN 0 WHEN hr < 12 THEN 1 WHEN hr < 18 THEN 2 ELSE 3 END as time_slot,
          COUNT(*) as cnt,
          AVG(EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz))) as avg_sec
        FROM ordered
        WHERE state IS NOT NULL AND prev_state IS NOT NULL
          AND state != prev_state
          AND LENGTH(state) > 3 AND LENGTH(prev_state) > 3
          AND EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz)) < 600
        GROUP BY user_id, from_state, to_state, time_slot
        HAVING COUNT(*) >= 2
      `);

      const slotTotals = {};
      for (const r of slotTransitions.rows) {
        const key = `${r.user_id}:${r.from_state}:${r.time_slot}`;
        slotTotals[key] = (slotTotals[key] || 0) + parseInt(r.cnt);
      }
      let slotUpserted = 0;
      for (const r of slotTransitions.rows) {
        const key = `${r.user_id}:${r.from_state}:${r.time_slot}`;
        const prob = parseInt(r.cnt) / (slotTotals[key] || 1);
        await db.query(`
          INSERT INTO transition_model_timeslot (user_id, from_state, to_state, time_slot, probability, count, avg_seconds, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (user_id, from_state, to_state, time_slot) DO UPDATE SET
            probability = $5, count = $6, avg_seconds = $7, updated_at = NOW()
        `, [r.user_id, r.from_state, r.to_state, parseInt(r.time_slot), +prob.toFixed(3), parseInt(r.cnt), +parseFloat(r.avg_sec || 0).toFixed(1)])
          .catch(() => {});
        slotUpserted++;
      }

      await _log(db, 'learn', 'transition_model', `${upserted}건 학습(시간대:${slotUpserted}건), ${hours}시간 데이터`);

      res.json({ learned: upserted, slotLearned: slotUpserted, dataHours: hours, uniqueUsers: new Set(transitions.rows.map(r => r.user_id)).size });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/predict/:userId — 다음 행동 예측
  // ═══════════════════════════════════════════════════════════════
  router.get('/predict/:userId', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const userId = req.params.userId;

      // 현재 상태 (마지막 이벤트)
      const currentRes = await db.query(`
        SELECT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as current_state,
          timestamp
        FROM events
        WHERE user_id = $1 AND type IN ('keyboard.chunk', 'screen.capture')
        ORDER BY timestamp DESC LIMIT 1
      `, [userId]);

      if (!currentRes.rows.length) return res.json({ error: 'no data', predictions: [] });

      const currentState = currentRes.rows[0].current_state;
      const lastSeen = currentRes.rows[0].timestamp;

      // 현재 시간대 계산
      const nowSlot = _timeSlot(new Date());
      const slotName = TIME_SLOT_NAMES[nowSlot];

      // 1) 시간대별 전이 확률 (우선)
      const slotPredRes = await db.query(`
        SELECT to_state, probability, count, avg_seconds
        FROM transition_model_timeslot
        WHERE user_id = $1 AND from_state = $2 AND time_slot = $3
        ORDER BY probability DESC LIMIT 5
      `, [userId, currentState, nowSlot]).catch(() => ({ rows: [] }));

      // 2) 전체 전이 확률 (시간대 데이터 부족 시 보완)
      const predRes = await db.query(`
        SELECT to_state, probability, count, avg_seconds
        FROM transition_model
        WHERE user_id = $1 AND from_state = $2
        ORDER BY probability DESC LIMIT 5
      `, [userId, currentState]);

      // 시간대별 결과가 있으면 우선 사용, 가중치 보정
      const slotMap = {};
      for (const r of slotPredRes.rows) slotMap[r.to_state] = parseFloat(r.probability);

      const predictions = predRes.rows.map(r => {
        const slotBoost = slotMap[r.to_state] != null ? slotMap[r.to_state] * 0.4 : 0;
        const combinedProb = Math.min(1, parseFloat(r.probability) * 0.6 + slotBoost);
        return {
          nextAction: r.to_state,
          probability: +combinedProb.toFixed(2),
          slotProbability: slotMap[r.to_state] != null ? +parseFloat(slotMap[r.to_state]).toFixed(2) : null,
          basedOn: parseInt(r.count) + '회 관찰',
          expectedIn: Math.round(parseFloat(r.avg_seconds)) + '초',
        };
      }).sort((a, b) => b.probability - a.probability);

      // 예측 로그 저장 (나중에 맞았는지 확인용) — from_state도 함께 저장
      if (predictions.length > 0) {
        await db.query(`
          INSERT INTO predictions (user_id, predicted_action, predicted_value, confidence, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [userId, predictions[0].nextAction, currentState, predictions[0].probability])
          .catch(() => db.query(`
            INSERT INTO predictions (user_id, predicted_action, confidence, created_at)
            VALUES ($1, $2, $3, NOW())
          `, [userId, predictions[0].nextAction, predictions[0].probability]));
      }

      res.json({
        userId,
        currentState,
        lastSeen,
        timeSlot: slotName,
        predictions,
        model: `${predRes.rows.length}개 후보 (시간대:${slotPredRes.rows.length})`,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/think/verify — 예측 검증 (맞았는지 확인)
  // ═══════════════════════════════════════════════════════════════
  router.post('/verify', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      // 최근 예측 중 아직 검증 안 된 것들
      const unverified = await db.query(`
        SELECT p.id, p.user_id, p.predicted_action, p.created_at
        FROM predictions p
        WHERE p.correct IS NULL AND p.created_at > NOW() - INTERVAL '1 hour'
        ORDER BY p.created_at DESC LIMIT 20
      `);

      let verified = 0;
      let correct = 0;

      for (const pred of unverified.rows) {
        // 예측 시점 이후 실제 행동 확인
        const actualRes = await db.query(`
          SELECT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as actual
          FROM events
          WHERE user_id = $1 AND type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > $2::timestamptz
          ORDER BY timestamp LIMIT 1
        `, [pred.user_id, pred.created_at]);

        if (actualRes.rows.length) {
          const actual = actualRes.rows[0].actual;
          const isCorrect = actual === pred.predicted_action;

          await db.query(`
            UPDATE predictions SET actual_action = $1, correct = $2 WHERE id = $3
          `, [actual, isCorrect, pred.id]);

          verified++;
          if (isCorrect) correct++;

          // 연속 실패 감지 및 가중치 감쇠
          // predicted_value = from_state (예측 시점에 저장된 경우)
          const fromState = pred.predicted_value || null;
          if (!isCorrect && fromState) {
            await _handlePredictionFailStreak(db, pred.user_id, fromState, pred.predicted_action);
          } else if (isCorrect && fromState) {
            // 정답이면 streak 리셋
            await db.query(`
              DELETE FROM prediction_fail_streak
              WHERE user_id = $1 AND from_state = $2 AND to_state = $3
            `, [pred.user_id, fromState, pred.predicted_action]).catch(() => {});
          }
        }
      }

      await _log(db, 'verify', 'predictions', `${verified}건 검증, ${correct}건 정답`);

      res.json({ verified, correct, accuracy: verified > 0 ? Math.round(correct / verified * 100) : 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/think/extract-kakao — Vision에서 카카오톡 대화 추출
  // ═══════════════════════════════════════════════════════════════
  router.post('/extract-kakao', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      // Vision 분석 결과에서 카카오톡 화면 찾기
      const visionRes = await db.query(`
        SELECT id, user_id, timestamp,
          data_json->>'app' as app,
          data_json->>'activity' as activity,
          data_json->>'dataVisible' as data_visible,
          COALESCE(
            (SELECT data_json->>'windowTitle' FROM events e2
             WHERE e2.user_id = events.user_id
               AND e2.type = 'screen.capture'
               AND ABS(EXTRACT(EPOCH FROM (e2.timestamp::timestamptz - events.timestamp::timestamptz))) < 30
             ORDER BY ABS(EXTRACT(EPOCH FROM (e2.timestamp::timestamptz - events.timestamp::timestamptz))) LIMIT 1),
            ''
          ) as chatroom
        FROM events
        WHERE type = 'screen.analyzed'
          AND (data_json->>'app' ILIKE '%kakao%' OR data_json->>'activity' ILIKE '%카카오톡%' OR data_json->>'activity' ILIKE '%카톡%')
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          AND id NOT IN (SELECT COALESCE(capture_event_id, '') FROM kakao_messages WHERE capture_event_id IS NOT NULL)
        ORDER BY timestamp DESC
        LIMIT 20
      `);

      let extracted = 0;
      for (const v of visionRes.rows) {
        const activity = v.activity || '';
        const chatroom = v.chatroom || v.app || '';

        if (activity.length > 20) {
          // messages JSONB 배열로 저장
          const messages = [{ sender: 'unknown', message: activity.substring(0, 500), time: v.timestamp }];
          await db.query(`
            INSERT INTO kakao_messages (user_id, chatroom, messages, capture_event_id, created_at)
            VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)
          `, [v.user_id, chatroom, JSON.stringify(messages), v.id, v.timestamp]);
          extracted++;
        }
      }

      await _log(db, 'extract', 'kakao_messages', `${extracted}건 추출`);

      res.json({ scanned: visionRes.rows.length, extracted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/capabilities — 확장 가능성 조회 (DB 기반)
  // ═══════════════════════════════════════════════════════════════
  router.get('/capabilities', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      // DB에서 capability_ideas 조회
      const stored = await db.query(
        `SELECT * FROM capability_ideas ORDER BY feasibility DESC, discovered_at DESC LIMIT 50`
      );

      // DB가 비어있으면 즉시 탐지 후 저장
      if (stored.rows.length === 0) {
        await _detectCapabilities(db);
        const fresh = await db.query(
          `SELECT * FROM capability_ideas ORDER BY feasibility DESC LIMIT 50`
        );
        return res.json({ total: fresh.rows.length, capabilities: fresh.rows });
      }

      res.json({ total: stored.rows.length, capabilities: stored.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/think/run — 사고 루프 1회 실행
  // 조사 → 대안 → 테스트 → 디벨롭 전체 사이클
  // ═══════════════════════════════════════════════════════════════
  router.post('/run', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const results = { learn: null, predict: null, verify: null, kakao: null, capabilities: null };

      // Phase 1: 전이 모델 학습
      const transRes = await db.query(`
        WITH ordered AS (
          SELECT user_id,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as state,
            LAG(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as prev_state,
            timestamp, LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_ts
          FROM events
          WHERE type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '6 hours'
            AND user_id NOT IN ('MMOLABXL2066516519')
        )
        SELECT user_id, prev_state, state, COUNT(*) as cnt,
          AVG(EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz))) as avg_sec
        FROM ordered
        WHERE state IS NOT NULL AND prev_state IS NOT NULL AND state != prev_state
          AND LENGTH(state)>3 AND LENGTH(prev_state)>3
          AND EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz)) < 600
        GROUP BY user_id, prev_state, state HAVING COUNT(*) >= 2
      `);

      const userTotals = {};
      for (const r of transRes.rows) {
        const k = `${r.user_id}:${r.prev_state}`;
        userTotals[k] = (userTotals[k] || 0) + parseInt(r.cnt);
      }
      let learned = 0;
      for (const r of transRes.rows) {
        const k = `${r.user_id}:${r.prev_state}`;
        const prob = parseInt(r.cnt) / (userTotals[k] || 1);
        await db.query(`
          INSERT INTO transition_model (user_id,from_state,to_state,probability,count,avg_seconds,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (user_id,from_state,to_state) DO UPDATE SET probability=$4,count=$5,avg_seconds=$6,updated_at=NOW()
        `, [r.user_id, r.prev_state, r.state, +prob.toFixed(3), parseInt(r.cnt), +parseFloat(r.avg_sec||0).toFixed(1)]);
        learned++;
      }
      results.learn = `${learned}건 학습`;

      // Phase 2: 예측 검증
      const unverified = await db.query(`
        SELECT id, user_id, predicted_action, created_at FROM predictions
        WHERE correct IS NULL AND created_at > NOW()-INTERVAL '2 hours' LIMIT 20
      `);
      let vCorrect = 0, vTotal = 0;
      for (const p of unverified.rows) {
        const actual = await db.query(`
          SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as a
          FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > $2::timestamptz ORDER BY timestamp LIMIT 1
        `, [p.user_id, p.created_at]);
        if (actual.rows.length) {
          const isC = actual.rows[0].a === p.predicted_action;
          await db.query('UPDATE predictions SET actual_action=$1,correct=$2 WHERE id=$3', [actual.rows[0].a, isC, p.id]);
          vTotal++; if (isC) vCorrect++;
        }
      }
      results.verify = `${vTotal}건 검증, ${vCorrect}건 정답`;

      // Phase 3: 카카오톡 대화 추출 (JSONB 배열 형식)
      const visionKakao = await db.query(`
        SELECT id, user_id, timestamp, data_json->>'activity' as activity, data_json->>'app' as app
        FROM events WHERE type='screen.analyzed'
          AND (data_json->>'app' ILIKE '%kakao%' OR data_json->>'activity' ILIKE '%카카오톡%')
          AND timestamp::timestamptz > NOW()-INTERVAL '6 hours'
          AND id NOT IN (SELECT COALESCE(capture_event_id,'') FROM kakao_messages WHERE capture_event_id IS NOT NULL)
        LIMIT 20
      `);
      let kakaoSaved = 0;
      for (const v of visionKakao.rows) {
        if ((v.activity || '').length > 20) {
          const msgs = [{ sender: 'unknown', message: (v.activity||'').substring(0,500), time: v.timestamp }];
          await db.query(`INSERT INTO kakao_messages (user_id,chatroom,messages,capture_event_id,created_at) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz)`,
            [v.user_id, v.app||'', JSON.stringify(msgs), v.id, v.timestamp]);
          kakaoSaved++;
        }
      }
      results.kakao = `${kakaoSaved}건 추출`;

      // Phase 4: 확장 사고 (새 가능성 발견 + DB 저장)
      const newCaps = await _detectCapabilities(db);
      results.capabilities = `${newCaps}건 발견`;

      await _log(db, 'think_loop', 'full_run', JSON.stringify(results));

      res.json({ timestamp: new Date().toISOString(), results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/think/chain-predict/:userId — 3단계 전이 체인 예측
  router.get('/chain-predict/:userId', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const userId = req.params.userId;
      const steps = Math.min(parseInt(req.query.steps || '3'), 5);

      const curRes = await db.query(
        `SELECT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as state
         FROM events WHERE user_id = $1 AND type IN ('keyboard.chunk','screen.capture')
         ORDER BY timestamp DESC LIMIT 1`,
        [userId]
      );
      if (!curRes.rows.length) return res.json({ error: '최근 활동 없음' });

      const startState = _normalizeState(curRes.rows[0].state);
      if (!startState) return res.json({ error: '상태 인식 불가' });

      const chain = [{ state: startState, probability: 1.0, step: 0 }];
      let currentStates = [{ state: startState, prob: 1.0 }];

      for (let step = 1; step <= steps; step++) {
        const nextStates = [];
        for (const { state, prob } of currentStates) {
          const { rows } = await db.query(
            `SELECT to_state, probability FROM transition_model
             WHERE user_id = $1 AND from_state = $2
             ORDER BY probability DESC LIMIT 2`,
            [userId, state]
          ).catch(() => ({ rows: [] }));
          for (const r of rows) {
            const ns = _normalizeState(r.to_state);
            if (ns) nextStates.push({ state: ns, prob: +(prob * r.probability).toFixed(3) });
          }
        }
        if (!nextStates.length) break;
        nextStates.sort((a, b) => b.prob - a.prob);
        const top = nextStates.slice(0, 2);
        for (const ns of top) chain.push({ state: ns.state, probability: ns.prob, step });
        currentStates = top;
      }

      res.json({ userId, startState, chain, steps, generatedAt: new Date().toISOString() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/transitions — 전이 확률 테이블 조회
  // ═══════════════════════════════════════════════════════════════
  router.get('/transitions', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const userId = req.query.userId;
      let query = 'SELECT * FROM transition_model WHERE probability > 0.1 ORDER BY probability DESC LIMIT 100';
      const params = [];
      if (userId) {
        query = 'SELECT * FROM transition_model WHERE user_id=$1 AND probability > 0.1 ORDER BY probability DESC LIMIT 50';
        params.push(userId);
      }
      const result = await db.query(query, params);
      res.json({ count: result.rows.length, transitions: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/accuracy — 예측 정확도 (시간대별 + 앱별 + 트렌드)
  // ═══════════════════════════════════════════════════════════════
  router.get('/accuracy', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      // 전체 통계
      const result = await db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE correct = true) as correct,
          COUNT(*) FILTER (WHERE correct = false) as wrong,
          COUNT(*) FILTER (WHERE correct IS NULL) as pending
        FROM predictions
      `);
      const r = result.rows[0] || {};
      const total = parseInt(r.total) || 0;
      const correct = parseInt(r.correct) || 0;
      const pending = parseInt(r.pending) || 0;

      // 일별 트렌드
      const trendRes = await db.query(`
        SELECT DATE(created_at) as day,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE correct = true) as correct_cnt
        FROM predictions
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `).catch(() => ({ rows: [] }));
      const trend = trendRes.rows.map(r => ({
        day: r.day,
        accuracy: parseInt(r.total) > 0 ? Math.round(parseInt(r.correct_cnt) / parseInt(r.total) * 100) : 0,
        total: parseInt(r.total),
      }));

      // 시간대별 정확도 (predicted_value=from_state, correct 기준)
      const slotRes = await db.query(`
        SELECT
          CASE
            WHEN EXTRACT(HOUR FROM created_at) < 6  THEN 0
            WHEN EXTRACT(HOUR FROM created_at) < 12 THEN 1
            WHEN EXTRACT(HOUR FROM created_at) < 18 THEN 2
            ELSE 3
          END as slot,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE correct = true) as correct_cnt
        FROM predictions
        WHERE correct IS NOT NULL AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY slot
        ORDER BY slot
      `).catch(() => ({ rows: [] }));
      const byTimeSlot = slotRes.rows.map(r => ({
        slot: parseInt(r.slot),
        slotName: TIME_SLOT_NAMES[parseInt(r.slot)] || '기타',
        accuracy: parseInt(r.total) > 0 ? Math.round(parseInt(r.correct_cnt) / parseInt(r.total) * 100) : 0,
        total: parseInt(r.total),
        correct: parseInt(r.correct_cnt),
      }));

      // 앱별(predicted_action 기준) 정확도 Top 10
      const appRes = await db.query(`
        SELECT
          predicted_action,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE correct = true) as correct_cnt
        FROM predictions
        WHERE correct IS NOT NULL AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY predicted_action
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) DESC LIMIT 10
      `).catch(() => ({ rows: [] }));
      const byApp = appRes.rows.map(r => ({
        action: r.predicted_action,
        accuracy: parseInt(r.total) > 0 ? Math.round(parseInt(r.correct_cnt) / parseInt(r.total) * 100) : 0,
        total: parseInt(r.total),
      }));

      // 연속 실패 중인 전이 (streak >= 3)
      const streakRes = await db.query(`
        SELECT user_id, from_state, to_state, streak, last_fail_at
        FROM prediction_fail_streak
        WHERE streak >= 3
        ORDER BY streak DESC LIMIT 20
      `).catch(() => ({ rows: [] }));

      res.json({
        total, correct, wrong: parseInt(r.wrong) || 0, pending,
        accuracy: total > 0 ? Math.round(correct / Math.max(total - pending, 1) * 100) : 0,
        trend,
        byTimeSlot,
        byApp,
        failStreaks: streakRes.rows,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── 로그 헬퍼 ──
  async function _log(db, phase, action, result) {
    try {
      await db.query('INSERT INTO think_log (phase,action,result) VALUES ($1,$2,$3)', [phase, action, result]);
    } catch {}
  }

  // ── 연속 실패 감지 + 가중치 감쇠 ──
  // 같은 (user, from, to) 조합에서 3회 이상 틀리면 probability *= 0.5
  async function _handlePredictionFailStreak(db, userId, fromState, toState) {
    try {
      // streak 카운트 업서트
      const res = await db.query(`
        INSERT INTO prediction_fail_streak (user_id, from_state, to_state, streak, last_fail_at)
        VALUES ($1, $2, $3, 1, NOW())
        ON CONFLICT (user_id, from_state, to_state) DO UPDATE SET
          streak = prediction_fail_streak.streak + 1,
          last_fail_at = NOW()
        RETURNING streak
      `, [userId, fromState, toState]).catch(() => null);

      const streak = res?.rows?.[0]?.streak || 0;

      // streak >= 3 → 전이 모델 가중치 0.5 감쇠
      if (streak >= 3) {
        await db.query(`
          UPDATE transition_model
          SET probability = GREATEST(probability * 0.5, 0.001), updated_at = NOW()
          WHERE user_id = $1 AND from_state = $2 AND to_state = $3
        `, [userId, fromState, toState]).catch(() => {});
        // 시간대별 테이블도 동일하게 감쇠
        await db.query(`
          UPDATE transition_model_timeslot
          SET probability = GREATEST(probability * 0.5, 0.001), updated_at = NOW()
          WHERE user_id = $1 AND from_state = $2 AND to_state = $3
        `, [userId, fromState, toState]).catch(() => {});
        console.log(`[think-engine] 연속 실패 ${streak}회: ${fromState} → ${toState} 가중치 감쇠`);
        await _log(db, 'decay', 'fail_streak', `user:${userId} ${fromState}→${toState} streak:${streak}`);
      }
    } catch (e) {
      console.warn('[think-engine] fail streak 처리 실패:', e.message);
    }
  }

  // ── 자동 재학습 루프: 틀린 예측 집계 → 가중치 조정 ──
  async function _autoRelearn() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 최근 2시간 틀린 예측들 집계
      const wrongRes = await db.query(`
        SELECT user_id, predicted_value as from_state, predicted_action as to_state,
          COUNT(*) as wrong_cnt
        FROM predictions
        WHERE correct = false
          AND predicted_value IS NOT NULL
          AND created_at > NOW() - INTERVAL '2 hours'
        GROUP BY user_id, predicted_value, predicted_action
        HAVING COUNT(*) >= 2
      `).catch(() => ({ rows: [] }));

      let adjusted = 0;
      for (const r of wrongRes.rows) {
        if (!r.from_state || !r.to_state) continue;
        // 틀린 횟수에 비례해 감쇠 (건당 5% 추가 감쇠, 최대 50%)
        const decay = Math.max(0.5, 1 - Math.min(parseInt(r.wrong_cnt) * 0.05, 0.5));
        await db.query(`
          UPDATE transition_model
          SET probability = GREATEST(probability * $4, 0.001), updated_at = NOW()
          WHERE user_id = $1 AND from_state = $2 AND to_state = $3
        `, [r.user_id, r.from_state, r.to_state, decay]).catch(() => {});
        adjusted++;
      }

      if (adjusted > 0) {
        console.log(`[think-engine] 자동 재학습: ${adjusted}개 전이 가중치 조정`);
        await _log(db, 'relearn', 'auto_relearn', `${adjusted}건 가중치 조정`);
      }
    } catch (err) {
      console.warn('[think-engine] 자동 재학습 에러:', err.message);
    }
  }

  // ── 확장 사고: 가능성 탐지 후 capability_ideas에 upsert (source 기준) ──
  async function _detectCapabilities(db) {
    const upsert = (source, current_data, additional_needed, new_capability, feasibility) =>
      db.query(`
        INSERT INTO capability_ideas (source, current_data, additional_needed, new_capability, feasibility, discovered_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (source) DO UPDATE SET
          current_data = EXCLUDED.current_data,
          feasibility = EXCLUDED.feasibility,
          discovered_at = NOW()
      `, [source, current_data, additional_needed, new_capability, feasibility]).catch(() => {});

    // 1. 마우스 좌표 → UI 자동화
    const mouseRes = await db.query(`SELECT COUNT(*) as c FROM events WHERE type='keyboard.chunk' AND data_json->>'mousePositions' IS NOT NULL AND jsonb_array_length(data_json->'mousePositions')>0`);
    const mouseCnt = parseInt(mouseRes.rows[0]?.c) || 0;
    await upsert('mouse_coords', `마우스 좌표 ${mouseCnt}건`, '같은 버튼 클릭 좌표 클러스터링', 'nenova UI 버튼 위치 자동 학습 → pyautogui 클릭 좌표 자동 설정', mouseCnt >= 100 ? 0.9 : mouseCnt >= 30 ? 0.6 : 0.1);

    // 2. rawInput → 입력 패턴 템플릿
    const rawRes = await db.query(`SELECT COUNT(*) as c FROM events WHERE type='keyboard.chunk' AND data_json->>'rawInput' IS NOT NULL AND LENGTH(data_json->>'rawInput')>10`);
    const rawCnt = parseInt(rawRes.rows[0]?.c) || 0;
    await upsert('raw_input', `rawInput ${rawCnt}건`, '반복 입력 패턴 클러스터링', '자주 입력하는 품목명/수량 자동완성 또는 템플릿', rawCnt >= 200 ? 0.85 : rawCnt >= 50 ? 0.5 : 0.1);

    // 3. Vision → 화면 구조 학습
    const vcRes = await db.query(`SELECT COUNT(*) as c FROM events WHERE type='screen.analyzed'`);
    const vc = parseInt(vcRes.rows[0]?.c) || 0;
    await upsert('vision', `Vision 분석 ${vc}건`, '같은 앱 화면을 UI 요소 단위로 분류', 'nenova/Excel 화면 구조 자동 학습 → UI 요소 셀렉터 자동 생성', vc >= 300 ? 0.8 : vc >= 100 ? 0.5 : 0.1);

    // 4. 카카오톡 대화 → 주문 자동 감지
    const kcRes = await db.query(`SELECT COUNT(*) as c FROM kakao_messages`);
    const kc = parseInt(kcRes.rows[0]?.c) || 0;
    await upsert('kakao', `카카오톡 대화 ${kc}건`, kc < 50 ? '대화 데이터 50건+ 필요' : '주문 키워드 패턴 학습', '카톡 메시지에서 자동 주문 감지 → 자동 입력 트리거', kc >= 100 ? 0.8 : kc >= 30 ? 0.5 : 0.2);

    // 5. 전이 확률 → 워크플로우 자동화
    const tcRes = await db.query(`SELECT COUNT(*) as c FROM transition_model WHERE probability > 0.7`);
    const tc = parseInt(tcRes.rows[0]?.c) || 0;
    await upsert('transitions', `확률 70%+ 전이 규칙 ${tc}건`, '전이 체인 3단계+ 연결', '카톡→주문→차감 전체 워크플로우 원클릭 자동화', tc >= 20 ? 0.85 : tc >= 5 ? 0.5 : 0.1);

    // 6. 거래처 패턴 → 주문 예측
    const ccRes = await db.query(`SELECT COUNT(DISTINCT name) as c FROM master_customers`).catch(() => ({ rows: [{ c: 0 }] }));
    const cc = parseInt(ccRes.rows[0]?.c) || 0;
    await upsert('customers', `거래처 ${cc}곳`, '거래처별 주문 이력 30건+', '거래처별 다음 주문 예측 (품목+수량+시기)', cc >= 15 ? 0.6 : 0.3);

    return 6; // 항상 6개 소스 갱신
  }

  // ═══════════════════════════════════════════════════════════════
  // 자동 사고 루프 — 3개 주기로 분리
  //   전이 모델: 30분마다
  //   정확도 검증: 1시간마다
  //   확장 사고: 2시간마다
  // ═══════════════════════════════════════════════════════════════
  async function _autoLearnTransitions() {
    try {
      const db = getDb();
      if (!db?.query) return;
      await _ensureTables(db);

      const trans = await db.query(`
        WITH o AS (
          SELECT user_id,
            COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as s,
            LAG(COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow')) OVER (PARTITION BY user_id ORDER BY timestamp) as ps,
            timestamp, LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as pt
          FROM events WHERE type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW()-INTERVAL '2 hours' AND user_id NOT IN ('MMOLABXL2066516519')
        )
        SELECT user_id,ps,s,COUNT(*) as c,AVG(EXTRACT(EPOCH FROM (timestamp::timestamptz-pt::timestamptz))) as a
        FROM o WHERE s IS NOT NULL AND ps IS NOT NULL AND s!=ps AND LENGTH(s)>3 AND LENGTH(ps)>3
          AND EXTRACT(EPOCH FROM (timestamp::timestamptz-pt::timestamptz))<600
        GROUP BY user_id,ps,s HAVING COUNT(*)>=2
      `);
      const ut = {};
      for (const r of trans.rows) {
        const fs = _normalizeState(r.ps);
        if (!fs) continue;
        const k = `${r.user_id}:${fs}`;
        ut[k] = (ut[k] || 0) + parseInt(r.c);
      }
      let lc = 0;
      for (const r of trans.rows) {
        const fromS = _normalizeState(r.ps);
        const toS   = _normalizeState(r.s);
        if (!fromS || !toS || fromS === toS) continue;
        const k = `${r.user_id}:${fromS}`;
        const p = parseInt(r.c) / (ut[k] || 1);
        await db.query(`INSERT INTO transition_model (user_id,from_state,to_state,probability,count,avg_seconds,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (user_id,from_state,to_state) DO UPDATE SET probability=$4,count=$5,avg_seconds=$6,updated_at=NOW()`,
          [r.user_id, fromS, toS, +p.toFixed(3), parseInt(r.c), +parseFloat(r.a||0).toFixed(1)]);
        lc++;
      }
      if (lc > 0) console.log(`[think-engine] 전이 모델 학습 ${lc}건`);
    } catch (err) {
      console.error('[think-engine] 전이 학습 에러:', err.message);
    }
  }

  async function _autoVerifyAccuracy() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 카카오톡 추출
      const vk = await db.query(`
        SELECT id,user_id,timestamp,data_json->>'activity' as a,data_json->>'app' as app
        FROM events WHERE type='screen.analyzed'
          AND (data_json->>'app' ILIKE '%kakao%' OR data_json->>'activity' ILIKE '%카카오톡%')
          AND timestamp::timestamptz > NOW()-INTERVAL '2 hours'
          AND id NOT IN (SELECT COALESCE(capture_event_id,'') FROM kakao_messages WHERE capture_event_id IS NOT NULL)
        LIMIT 20
      `);
      let kc = 0;
      for (const v of vk.rows) {
        if ((v.a||'').length>20) {
          const msgs = [{ sender: 'unknown', message: (v.a||'').substring(0,500), time: v.timestamp }];
          await db.query(`INSERT INTO kakao_messages (user_id,chatroom,messages,capture_event_id,created_at) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz)`,
            [v.user_id,v.app||'',JSON.stringify(msgs),v.id,v.timestamp]);
          kc++;
        }
      }

      // 예측 검증
      const uv = await db.query(`SELECT id,user_id,predicted_action,created_at FROM predictions WHERE correct IS NULL AND created_at>NOW()-INTERVAL '4 hours' LIMIT 20`);
      let vc=0,vv=0;
      for (const p of uv.rows) {
        const a = await db.query(`SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as a FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture') AND timestamp::timestamptz>$2::timestamptz ORDER BY timestamp LIMIT 1`,[p.user_id,p.created_at]);
        if (a.rows.length) {
          await db.query('UPDATE predictions SET actual_action=$1,correct=$2 WHERE id=$3',[a.rows[0].a,a.rows[0].a===p.predicted_action,p.id]);
          vv++; if(a.rows[0].a===p.predicted_action) vc++;
        }
      }

      await _log(db, 'auto_verify', 'cycle', `카톡:${kc} 검증:${vv}(정답:${vc})`);
      if (kc > 0 || vv > 0) console.log(`[think-engine] 카톡 ${kc}건 추출, 검증 ${vv}건(정답 ${vc})`);
    } catch (err) {
      console.error('[think-engine] 검증 에러:', err.message);
    }
  }

  async function _autoDetectCapabilities() {
    try {
      const db = getDb();
      if (!db?.query) return;
      await _ensureTables(db);

      const n = await _detectCapabilities(db);
      await _log(db, 'auto_capabilities', 'cycle', `${n}건 갱신`);
      console.log(`[think-engine] 확장 사고 ${n}건 capability_ideas 갱신`);
    } catch (err) {
      console.error('[think-engine] 확장 사고 에러:', err.message);
    }
  }

  // 서버 시작 후 각 주기별 스케줄
  setTimeout(() => { _autoLearnTransitions(); setInterval(_autoLearnTransitions, 30 * 60 * 1000); }, 10 * 60 * 1000);
  setTimeout(() => { _autoVerifyAccuracy();   setInterval(_autoVerifyAccuracy,   60 * 60 * 1000); }, 15 * 60 * 1000);
  setTimeout(() => { _autoDetectCapabilities(); setInterval(_autoDetectCapabilities, 2 * 60 * 60 * 1000); }, 20 * 60 * 1000);
  // 자동 재학습: 45분마다 (verify 직후 실행 타이밍)
  setTimeout(() => { _autoRelearn(); setInterval(_autoRelearn, 45 * 60 * 1000); }, 25 * 60 * 1000);

  // ── RAG 증강 예측 ───────────────────────────────────────────────────────
  // GET /api/think/rag-predict?userId=&currentState=
  router.get('/rag-predict', async (req, res) => {
    try {
      if (!ragCore) return res.json({ error: 'RAG 미초기화' });
      const { userId, currentState } = req.query;
      if (!currentState) return res.status(400).json({ error: 'currentState 필수' });

      // 1. 유사 과거 맥락 검색
      const context = await ragCore.searchSimilarContext({
        currentState, userId, days: 14, limit: 10,
      });

      // 2. DB 전이 모델 예측과 결합
      const db = getDb();
      let dbPrediction = null;
      if (db?.query) {
        const { rows } = await db.query(
          `SELECT to_state, probability FROM transition_model
           WHERE user_id = $1 AND from_state ILIKE $2
           ORDER BY probability DESC LIMIT 3`,
          [userId || '%', `%${currentState.slice(0, 30)}%`]
        ).catch(() => ({ rows: [] }));
        if (rows.length) dbPrediction = rows;
      }

      res.json({
        ok: true,
        currentState,
        ragContext: context.slice(0, 5),
        dbPrediction,
        combined: {
          confidence: dbPrediction ? 0.7 : 0.3,
          source: dbPrediction ? 'transition_model + RAG' : 'RAG only',
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[think-engine] 사고 엔진 v3 시작 (전이:30분 / 검증:1시간 / 재학습:45분 / 확장사고:2시간 / 시간대분리+연속실패감지)');

  return router;
}

module.exports = createThinkEngine;
