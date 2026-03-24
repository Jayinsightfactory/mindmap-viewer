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
 *   6. 사고 루프 (2시간마다 자동 탐색+테스트+디벨롭)
 */
const express = require('express');

function createThinkEngine({ getDb }) {
  const router = express.Router();

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
        sender TEXT,
        message TEXT,
        vision_event_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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
  }

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/status — 사고 엔진 현재 상태
  // ═══════════════════════════════════════════════════════════════
  router.get('/status', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const [transRes, predRes, kakaoRes, logRes] = await Promise.all([
        db.query('SELECT COUNT(*) as cnt, COUNT(DISTINCT user_id) as users FROM transition_model'),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE correct=true) as correct FROM predictions`),
        db.query('SELECT COUNT(*) as cnt, COUNT(DISTINCT chatroom) as rooms FROM kakao_messages'),
        db.query('SELECT COUNT(*) as cnt FROM think_log WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      ]);

      const t = transRes.rows[0] || {};
      const p = predRes.rows[0] || {};
      const k = kakaoRes.rows[0] || {};
      const total = parseInt(p.total) || 0;
      const correct = parseInt(p.correct) || 0;

      res.json({
        engine: 'think-engine v1',
        transitionModel: { rules: parseInt(t.cnt) || 0, users: parseInt(t.users) || 0 },
        predictions: { total, correct, accuracy: total > 0 ? Math.round(correct / total * 100) : 0 },
        kakaoMessages: { total: parseInt(k.cnt) || 0, chatrooms: parseInt(k.rooms) || 0 },
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

      await _log(db, 'learn', 'transition_model', `${upserted}건 학습, ${hours}시간 데이터`);

      res.json({ learned: upserted, dataHours: hours, uniqueUsers: new Set(transitions.rows.map(r => r.user_id)).size });
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

      // 전이 확률에서 다음 행동 예측
      const predRes = await db.query(`
        SELECT to_state, probability, count, avg_seconds
        FROM transition_model
        WHERE user_id = $1 AND from_state = $2
        ORDER BY probability DESC LIMIT 5
      `, [userId, currentState]);

      const predictions = predRes.rows.map(r => ({
        nextAction: r.to_state,
        probability: +parseFloat(r.probability).toFixed(2),
        basedOn: parseInt(r.count) + '회 관찰',
        expectedIn: Math.round(parseFloat(r.avg_seconds)) + '초',
      }));

      // 예측 로그 저장 (나중에 맞았는지 확인용)
      if (predictions.length > 0) {
        await db.query(`
          INSERT INTO predictions (user_id, predicted_action, confidence, created_at)
          VALUES ($1, $2, $3, NOW())
        `, [userId, predictions[0].nextAction, predictions[0].probability]);
      }

      res.json({
        userId,
        currentState,
        lastSeen,
        predictions,
        model: `${predRes.rows.length}개 후보`,
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
          AND id NOT IN (SELECT COALESCE(vision_event_id, '') FROM kakao_messages)
        ORDER BY timestamp DESC
        LIMIT 20
      `);

      let extracted = 0;
      for (const v of visionRes.rows) {
        const activity = v.activity || '';
        const dataVisible = v.data_visible || '';
        const chatroom = v.chatroom || v.app || '';

        // Vision activity에서 대화 내용 추출 시도
        // 패턴: "~에게 ~메시지", "~요청", "~확인" 등
        if (activity.length > 20) {
          await db.query(`
            INSERT INTO kakao_messages (user_id, chatroom, message, vision_event_id, created_at)
            VALUES ($1, $2, $3, $4, $5::timestamptz)
          `, [v.user_id, chatroom, activity.substring(0, 500), v.id, v.timestamp]);
          extracted++;
        }
      }

      await _log(db, 'extract', 'kakao_messages', `${extracted}건 추출`);

      res.json({ scanned: visionRes.rows.length, extracted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/think/capabilities — 확장 가능성 추론
  // ═══════════════════════════════════════════════════════════════
  router.get('/capabilities', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const capabilities = [];

      // 1. 마우스 좌표 → UI 자동화 가능성
      const mouseRes = await db.query(`
        SELECT user_id, COUNT(*) as cnt
        FROM events
        WHERE type = 'keyboard.chunk'
          AND data_json->>'mousePositions' IS NOT NULL
          AND jsonb_array_length(data_json->'mousePositions') > 0
        GROUP BY user_id
      `);
      for (const r of mouseRes.rows) {
        const cnt = parseInt(r.cnt);
        if (cnt >= 30) {
          capabilities.push({
            currentData: `마우스 좌표 ${cnt}건 수집됨`,
            additionalNeeded: '같은 버튼 클릭 좌표 클러스터링',
            newCapability: 'nenova UI 버튼 위치 자동 학습 → pyautogui 클릭 좌표 자동 설정',
            feasibility: cnt >= 100 ? 0.9 : 0.6,
          });
        }
      }

      // 2. rawInput → 입력 패턴 템플릿 가능성
      const rawRes = await db.query(`
        SELECT COUNT(*) as cnt FROM events
        WHERE type = 'keyboard.chunk' AND data_json->>'rawInput' IS NOT NULL AND LENGTH(data_json->>'rawInput') > 10
      `);
      const rawCnt = parseInt(rawRes.rows[0]?.cnt) || 0;
      if (rawCnt >= 50) {
        capabilities.push({
          currentData: `rawInput ${rawCnt}건`,
          additionalNeeded: '반복 입력 패턴 클러스터링',
          newCapability: '자주 입력하는 품목명/수량 자동완성 또는 템플릿',
          feasibility: rawCnt >= 200 ? 0.85 : 0.5,
        });
      }

      // 3. Vision → 화면 구조 학습 가능성
      const visionCnt = await db.query(`SELECT COUNT(*) as cnt FROM events WHERE type='screen.analyzed'`);
      const vc = parseInt(visionCnt.rows[0]?.cnt) || 0;
      if (vc >= 100) {
        capabilities.push({
          currentData: `Vision 분석 ${vc}건`,
          additionalNeeded: '같은 앱 화면을 UI 요소 단위로 분류',
          newCapability: 'nenova/Excel 화면 구조 자동 학습 → UI 요소 셀렉터 자동 생성',
          feasibility: vc >= 300 ? 0.8 : 0.5,
        });
      }

      // 4. 카카오톡 대화 → 주문 자동 감지 가능성
      const kakaoCnt = await db.query(`SELECT COUNT(*) as cnt FROM kakao_messages`);
      const kc = parseInt(kakaoCnt.rows[0]?.cnt) || 0;
      capabilities.push({
        currentData: `카카오톡 대화 ${kc}건 저장`,
        additionalNeeded: kc < 50 ? '대화 데이터 50건+ 필요' : '주문 키워드 패턴 학습',
        newCapability: '카톡 메시지에서 자동 주문 감지 → 자동 입력 트리거',
        feasibility: kc >= 100 ? 0.8 : kc >= 30 ? 0.5 : 0.2,
      });

      // 5. 전이 확률 → 워크플로우 자동화 가능성
      const transCnt = await db.query(`SELECT COUNT(*) as cnt FROM transition_model WHERE probability > 0.7`);
      const tc = parseInt(transCnt.rows[0]?.cnt) || 0;
      if (tc >= 5) {
        capabilities.push({
          currentData: `확률 70%+ 전이 규칙 ${tc}건`,
          additionalNeeded: '전이 체인 3단계+ 연결',
          newCapability: '카톡→주문→차감 전체 워크플로우 원클릭 자동화',
          feasibility: tc >= 20 ? 0.85 : 0.5,
        });
      }

      // 6. 거래처 패턴 → 주문 예측 가능성
      const custRes = await db.query(`SELECT COUNT(DISTINCT name) as cnt FROM master_customers`);
      const cc = parseInt(custRes.rows[0]?.cnt) || 0;
      capabilities.push({
        currentData: `거래처 ${cc}곳 등록`,
        additionalNeeded: '거래처별 주문 이력 30건+',
        newCapability: '거래처별 다음 주문 예측 (품목+수량+시기)',
        feasibility: cc >= 15 ? 0.6 : 0.3,
      });

      res.json({
        total: capabilities.length,
        capabilities: capabilities.sort((a, b) => b.feasibility - a.feasibility),
      });
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

      // Phase 3: 카카오톡 대화 추출
      const visionKakao = await db.query(`
        SELECT id, user_id, timestamp, data_json->>'activity' as activity, data_json->>'app' as app
        FROM events WHERE type='screen.analyzed'
          AND (data_json->>'app' ILIKE '%kakao%' OR data_json->>'activity' ILIKE '%카카오톡%')
          AND timestamp::timestamptz > NOW()-INTERVAL '6 hours'
          AND id NOT IN (SELECT COALESCE(vision_event_id,'') FROM kakao_messages)
        LIMIT 20
      `);
      let kakaoSaved = 0;
      for (const v of visionKakao.rows) {
        if ((v.activity || '').length > 20) {
          await db.query(`INSERT INTO kakao_messages (user_id,chatroom,message,vision_event_id,created_at) VALUES ($1,$2,$3,$4,$5::timestamptz)`,
            [v.user_id, v.app || '', (v.activity||'').substring(0,500), v.id, v.timestamp]);
          kakaoSaved++;
        }
      }
      results.kakao = `${kakaoSaved}건 추출`;

      // Phase 4: 확장 사고 (새 가능성 발견)
      const newCaps = [];
      const mouseTotal = await db.query(`SELECT COUNT(*) as c FROM events WHERE type='keyboard.chunk' AND data_json->>'mousePositions' IS NOT NULL AND jsonb_array_length(data_json->'mousePositions')>0`);
      if (parseInt(mouseTotal.rows[0]?.c) >= 50) {
        newCaps.push('마우스 좌표 50건+ → UI 버튼 위치 학습 가능');
      }
      const rawTotal = await db.query(`SELECT COUNT(*) as c FROM events WHERE type='keyboard.chunk' AND data_json->>'rawInput' IS NOT NULL AND LENGTH(data_json->>'rawInput')>10`);
      if (parseInt(rawTotal.rows[0]?.c) >= 100) {
        newCaps.push('rawInput 100건+ → 입력 패턴 템플릿 생성 가능');
      }
      results.capabilities = newCaps;

      await _log(db, 'think_loop', 'full_run', JSON.stringify(results));

      res.json({ timestamp: new Date().toISOString(), results });
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
  // GET /api/think/accuracy — 예측 정확도
  // ═══════════════════════════════════════════════════════════════
  router.get('/accuracy', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

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

      res.json({
        total, correct, wrong: parseInt(r.wrong) || 0, pending: parseInt(r.pending) || 0,
        accuracy: total > 0 ? Math.round(correct / Math.max(total - parseInt(r.pending || 0), 1) * 100) : 0,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── 로그 헬퍼 ──
  async function _log(db, phase, action, result) {
    try {
      await db.query('INSERT INTO think_log (phase,action,result) VALUES ($1,$2,$3)', [phase, action, result]);
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════
  // 자동 사고 루프 — 2시간마다
  // ═══════════════════════════════════════════════════════════════
  async function _autoThink() {
    try {
      const db = getDb();
      if (!db?.query) return;
      await _ensureTables(db);

      console.log('[think-engine] 🧠 사고 루프 시작...');

      // 1. 전이 모델 학습
      const trans = await db.query(`
        WITH o AS (
          SELECT user_id,
            COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as s,
            LAG(COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow')) OVER (PARTITION BY user_id ORDER BY timestamp) as ps,
            timestamp, LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as pt
          FROM events WHERE type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW()-INTERVAL '6 hours' AND user_id NOT IN ('MMOLABXL2066516519')
        )
        SELECT user_id,ps,s,COUNT(*) as c,AVG(EXTRACT(EPOCH FROM (timestamp::timestamptz-pt::timestamptz))) as a
        FROM o WHERE s IS NOT NULL AND ps IS NOT NULL AND s!=ps AND LENGTH(s)>3 AND LENGTH(ps)>3
          AND EXTRACT(EPOCH FROM (timestamp::timestamptz-pt::timestamptz))<600
        GROUP BY user_id,ps,s HAVING COUNT(*)>=2
      `);
      const ut = {};
      for (const r of trans.rows) { const k=`${r.user_id}:${r.ps}`; ut[k]=(ut[k]||0)+parseInt(r.c); }
      let lc = 0;
      for (const r of trans.rows) {
        const k=`${r.user_id}:${r.ps}`, p=parseInt(r.c)/(ut[k]||1);
        await db.query(`INSERT INTO transition_model (user_id,from_state,to_state,probability,count,avg_seconds,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (user_id,from_state,to_state) DO UPDATE SET probability=$4,count=$5,avg_seconds=$6,updated_at=NOW()`,
          [r.user_id,r.ps,r.s,+p.toFixed(3),parseInt(r.c),+parseFloat(r.a||0).toFixed(1)]);
        lc++;
      }

      // 2. 카카오톡 대화 추출
      const vk = await db.query(`
        SELECT id,user_id,timestamp,data_json->>'activity' as a,data_json->>'app' as app
        FROM events WHERE type='screen.analyzed'
          AND (data_json->>'app' ILIKE '%kakao%' OR data_json->>'activity' ILIKE '%카카오톡%')
          AND timestamp::timestamptz > NOW()-INTERVAL '6 hours'
          AND id NOT IN (SELECT COALESCE(vision_event_id,'') FROM kakao_messages)
        LIMIT 20
      `);
      let kc = 0;
      for (const v of vk.rows) {
        if ((v.a||'').length>20) {
          await db.query(`INSERT INTO kakao_messages (user_id,chatroom,message,vision_event_id,created_at) VALUES ($1,$2,$3,$4,$5::timestamptz)`,
            [v.user_id,v.app||'',(v.a||'').substring(0,500),v.id,v.timestamp]);
          kc++;
        }
      }

      // 3. 예측 검증
      const uv = await db.query(`SELECT id,user_id,predicted_action,created_at FROM predictions WHERE correct IS NULL AND created_at>NOW()-INTERVAL '4 hours' LIMIT 20`);
      let vc=0,vv=0;
      for (const p of uv.rows) {
        const a = await db.query(`SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as a FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture') AND timestamp::timestamptz>$2::timestamptz ORDER BY timestamp LIMIT 1`,[p.user_id,p.created_at]);
        if (a.rows.length) {
          await db.query('UPDATE predictions SET actual_action=$1,correct=$2 WHERE id=$3',[a.rows[0].a,a.rows[0].a===p.predicted_action,p.id]);
          vv++; if(a.rows[0].a===p.predicted_action) vc++;
        }
      }

      await _log(db, 'auto_think', 'cycle', `학습:${lc} 카톡:${kc} 검증:${vv}(정답:${vc})`);
      console.log(`[think-engine] 🧠 완료: 학습 ${lc}건, 카톡 ${kc}건, 검증 ${vv}건(정답 ${vc})`);
    } catch (err) {
      console.error('[think-engine] 에러:', err.message);
    }
  }

  // 서버 시작 10분 후 첫 실행, 이후 3시간마다 (메모리 절약)
  setTimeout(() => {
    _autoThink();
    setInterval(_autoThink, 3 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  console.log('[think-engine] 🧠 사고 엔진 시작 (2시간마다 학습+예측+검증+추출)');

  return router;
}

module.exports = createThinkEngine;
