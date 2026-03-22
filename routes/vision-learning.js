'use strict';
/**
 * routes/vision-learning.js
 * ─────────────────────────────────────────────────────────────────────────────
 * UI 학습 엔진 — 스크린 캡처 분석 결과로부터 UI 요소를 학습하고,
 * 마우스 좌표와 매칭하여 nenova 프로그램의 시각적 지도를 구축한다.
 *
 * 문제 해결:
 *   1. 화면 영역 분할 (Zone Segmentation)
 *   2. UI 요소 DB 학습 (버튼, 입력, 메뉴, 테이블 등)
 *   3. 마우스 좌표 → UI 요소 매칭
 *   4. 화면 전이 패턴 학습 → 다음 클릭 예측
 *   5. 중복 분석 방지 (이미 학습된 화면 skip)
 *
 * 엔드포인트:
 *   POST /api/vision/learn-elements     — Vision 분석 결과에서 UI 요소 추출·저장
 *   POST /api/vision/learn-screen       — 화면 fingerprint 등록
 *   POST /api/vision/match-click        — 마우스 좌표 → UI 요소 매칭
 *   GET  /api/vision/elements           — 학습된 UI 요소 목록
 *   GET  /api/vision/screens            — 학습된 화면 목록
 *   GET  /api/vision/click-map          — 클릭 히트맵
 *   GET  /api/vision/click-map/:userId  — 직원별 클릭 패턴
 *   POST /api/vision/analyze-zones      — 화면 영역별 분석 결과 저장
 *   GET  /api/vision/screen-structure/:app — 앱 화면 구조 트리
 *   GET  /api/vision/predictions        — 다음 클릭 예측
 *   POST /api/vision/auto-learn         — 기존 screen.analyzed 일괄 학습
 *   GET  /api/vision/learning-status    — 학습 현황
 *   GET  /api/vision/unknown-screens    — 미학습 화면 목록
 *   GET  /api/vision/enhanced-prompt    — 화면별 맞춤 분석 프롬프트 생성
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// 화면 영역 정의 (nenova ERP 기준)
// ═══════════════════════════════════════════════════════════════════════════

const SCREEN_ZONES = [
  { name: 'title_bar',  label: '제목 바',   yStart: 0.00, yEnd: 0.05 },
  { name: 'menu_bar',   label: '메뉴 바',   yStart: 0.05, yEnd: 0.10 },
  { name: 'toolbar',    label: '도구 바',   yStart: 0.10, yEnd: 0.15 },
  { name: 'data_area',  label: '데이터 영역', yStart: 0.15, yEnd: 0.85 },
  { name: 'action_bar', label: '액션 바',   yStart: 0.85, yEnd: 0.95 },
  { name: 'status_bar', label: '상태 바',   yStart: 0.95, yEnd: 1.00 },
];

// ═══════════════════════════════════════════════════════════════════════════
// 위치 텍스트 → 정규화 좌표 변환
// ═══════════════════════════════════════════════════════════════════════════

const POSITION_KEYWORDS = {
  // Y 축
  '상단':   { y: 0.05 },
  '최상단': { y: 0.02 },
  '중상단': { y: 0.15 },
  '중앙':   { y: 0.50, x: 0.50 },
  '중간':   { y: 0.50 },
  '하단':   { y: 0.90 },
  '중하단': { y: 0.75 },
  '최하단': { y: 0.97 },
  // X 축
  '왼쪽':   { x: 0.10 },
  '좌측':   { x: 0.10 },
  '오른쪽': { x: 0.90 },
  '우측':   { x: 0.90 },
  // 복합
  '좌상단': { x: 0.10, y: 0.10 },
  '좌상':   { x: 0.10, y: 0.10 },
  '우상단': { x: 0.90, y: 0.10 },
  '우상':   { x: 0.90, y: 0.10 },
  '좌하단': { x: 0.10, y: 0.90 },
  '좌하':   { x: 0.10, y: 0.90 },
  '우하단': { x: 0.90, y: 0.90 },
  '우하':   { x: 0.90, y: 0.90 },
  // 영어
  'top':    { y: 0.05 },
  'bottom': { y: 0.90 },
  'left':   { x: 0.10 },
  'right':  { x: 0.90 },
  'center': { x: 0.50, y: 0.50 },
  'top-left':     { x: 0.10, y: 0.10 },
  'top-right':    { x: 0.90, y: 0.10 },
  'bottom-left':  { x: 0.10, y: 0.90 },
  'bottom-right': { x: 0.90, y: 0.90 },
};

/**
 * 위치 텍스트를 정규화 좌표로 변환 (fuzzy matching)
 * "상단 왼쪽" → { x: 0.10, y: 0.05 }
 * "중앙" → { x: 0.50, y: 0.50 }
 */
function parsePosition(posText) {
  if (!posText || typeof posText !== 'string') return { x: 0.5, y: 0.5 };

  const text = posText.trim().toLowerCase();
  let result = {};

  // 키워드 순서대로 매칭 (긴 키워드 먼저)
  const sortedKeys = Object.keys(POSITION_KEYWORDS).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (text.includes(key.toLowerCase())) {
      result = { ...result, ...POSITION_KEYWORDS[key] };
    }
  }

  // 디폴트 값 보정
  if (result.x === undefined) result.x = 0.5;
  if (result.y === undefined) result.y = 0.5;

  return result;
}

/**
 * 두 점 사이의 유클리드 거리 (정규화 좌표)
 */
function euclidean(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

/**
 * 정규화 좌표가 속하는 화면 영역(Zone) 반환
 */
function getZone(ny) {
  for (const z of SCREEN_ZONES) {
    if (ny >= z.yStart && ny < z.yEnd) return z;
  }
  return SCREEN_ZONES[SCREEN_ZONES.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════
// 테이블 초기화
// ═══════════════════════════════════════════════════════════════════════════

let _tablesCreated = false;

async function ensureTables(db) {
  if (_tablesCreated || !db?.query) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ui_elements (
        id SERIAL PRIMARY KEY,
        app_name TEXT NOT NULL,
        screen_name TEXT NOT NULL,
        element_type TEXT NOT NULL,
        element_label TEXT NOT NULL,
        position_x REAL,
        position_y REAL,
        width REAL,
        height REAL,
        confidence REAL DEFAULT 0.5,
        seen_count INT DEFAULT 1,
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        action_hint TEXT,
        UNIQUE(app_name, screen_name, element_label, element_type)
      );

      CREATE TABLE IF NOT EXISTS ui_screen_fingerprints (
        id SERIAL PRIMARY KEY,
        app_name TEXT NOT NULL,
        screen_name TEXT NOT NULL,
        title_pattern TEXT,
        element_count INT DEFAULT 0,
        description TEXT,
        sample_event_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(app_name, screen_name)
      );

      CREATE TABLE IF NOT EXISTS ui_click_map (
        id SERIAL PRIMARY KEY,
        app_name TEXT NOT NULL,
        screen_name TEXT NOT NULL,
        click_x REAL NOT NULL,
        click_y REAL NOT NULL,
        element_id INT REFERENCES ui_elements(id) ON DELETE SET NULL,
        user_id TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        before_screen TEXT,
        after_screen TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ui_elements_app ON ui_elements(app_name, screen_name);
      CREATE INDEX IF NOT EXISTS idx_ui_click_map_app ON ui_click_map(app_name, screen_name);
      CREATE INDEX IF NOT EXISTS idx_ui_click_map_user ON ui_click_map(user_id);
      CREATE INDEX IF NOT EXISTS idx_ui_click_map_element ON ui_click_map(element_id);
    `);
    _tablesCreated = true;
    console.log('[vision-learning] 테이블 초기화 완료');
  } catch (e) {
    console.warn('[vision-learning] 테이블 초기화 경고:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 자동 학습 내부 함수
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 단일 screen.analyzed 이벤트에서 UI 요소 추출하여 DB 저장
 * @returns {number} 학습된 요소 수
 */
async function learnFromEvent(db, eventData, eventId) {
  const app = eventData.app || 'unknown';
  const screen = eventData.screen || 'unknown';
  const elements = eventData.elements || [];
  let learned = 0;

  for (const el of elements) {
    try {
      const type = (el.type || 'unknown').toLowerCase();
      const label = el.label || el.name || '';
      if (!label) continue;

      // 위치 파싱
      const pos = parsePosition(el.position || '');

      // UPSERT: 존재하면 seen_count 증가, 없으면 삽입
      await db.query(`
        INSERT INTO ui_elements (app_name, screen_name, element_type, element_label,
                                 position_x, position_y, confidence, seen_count, action_hint)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
        ON CONFLICT (app_name, screen_name, element_label, element_type) DO UPDATE SET
          seen_count = ui_elements.seen_count + 1,
          last_seen = NOW(),
          position_x = COALESCE(EXCLUDED.position_x, ui_elements.position_x),
          position_y = COALESCE(EXCLUDED.position_y, ui_elements.position_y),
          confidence = LEAST(1.0, ui_elements.confidence + 0.05),
          action_hint = COALESCE(EXCLUDED.action_hint, ui_elements.action_hint)
      `, [app, screen, type, label, pos.x, pos.y, 0.5, el.actionHint || el.action_hint || null]);

      learned++;
    } catch (e) {
      // 개별 요소 실패는 무시
    }
  }

  // 화면 fingerprint 등록/갱신
  if (elements.length > 0) {
    try {
      const desc = eventData.activity || eventData.description || '';
      await db.query(`
        INSERT INTO ui_screen_fingerprints (app_name, screen_name, element_count, description, sample_event_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (app_name, screen_name) DO UPDATE SET
          element_count = GREATEST(ui_screen_fingerprints.element_count, EXCLUDED.element_count),
          description = COALESCE(EXCLUDED.description, ui_screen_fingerprints.description),
          sample_event_id = COALESCE(EXCLUDED.sample_event_id, ui_screen_fingerprints.sample_event_id)
      `, [app, screen, elements.length, desc, eventId || null]);
    } catch (e) {
      // fingerprint 실패는 무시
    }
  }

  return learned;
}

/**
 * 기존 screen.analyzed 이벤트를 스캔하여 일괄 학습
 */
async function autoLearnBatch(db, limit = 500) {
  const result = {
    scanned: 0,
    learned: 0,
    screens: new Set(),
    errors: 0,
  };

  try {
    // 최근 screen.analyzed 이벤트 조회 (이미 학습한 것도 재스캔 — seen_count 증가)
    const eventsRes = await db.query(`
      SELECT id, data_json, timestamp
      FROM events
      WHERE type = 'screen.analyzed'
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);

    for (const row of eventsRes.rows) {
      try {
        result.scanned++;
        const data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json;
        if (!data || !data.elements || data.elements.length === 0) continue;

        const count = await learnFromEvent(db, data, row.id);
        result.learned += count;
        if (data.screen) result.screens.add(`${data.app || 'unknown'}:${data.screen}`);
      } catch (e) {
        result.errors++;
      }
    }
  } catch (e) {
    console.warn('[vision-learning] auto-learn 쿼리 실패:', e.message);
    result.errors++;
  }

  result.screens = [...result.screens];
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createVisionLearningRouter({ getDb }) {
  const router = express.Router();

  // 자동 학습 스케줄러 상태
  let _autoLearnInterval = null;
  let _lastAutoLearn = null;
  let _autoLearnStats = null;

  // ── 테이블 초기화 (첫 요청 시) ─────────────────────────────────────────────
  async function withDb(res, fn) {
    const db = getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    await ensureTables(db);
    return fn(db);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /learn-elements — Vision 분석 결과에서 UI 요소 추출·저장
  // Body: { app, screen, elements: [{type, label, position, actionHint}], activity }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/learn-elements', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, elements, activity, eventId } = req.body;
        if (!app || !screen) return res.status(400).json({ error: 'app and screen required' });
        if (!elements || !Array.isArray(elements) || elements.length === 0) {
          return res.status(400).json({ error: 'elements array required' });
        }

        const data = { app, screen, elements, activity };
        const count = await learnFromEvent(db, data, eventId);

        res.json({
          ok: true,
          learned: count,
          total_elements: elements.length,
          app,
          screen,
        });
      });
    } catch (e) {
      console.error('[vision-learning] learn-elements error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /learn-screen — 화면 fingerprint 등록
  // Body: { app, screen, titlePattern, description, sampleEventId }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/learn-screen', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, titlePattern, description, sampleEventId } = req.body;
        if (!app || !screen) return res.status(400).json({ error: 'app and screen required' });

        // 요소 수 카운트
        const countRes = await db.query(
          'SELECT COUNT(*) as cnt FROM ui_elements WHERE app_name = $1 AND screen_name = $2',
          [app, screen]
        );
        const elementCount = parseInt(countRes.rows[0]?.cnt || 0);

        await db.query(`
          INSERT INTO ui_screen_fingerprints (app_name, screen_name, title_pattern, element_count, description, sample_event_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (app_name, screen_name) DO UPDATE SET
            title_pattern = COALESCE(EXCLUDED.title_pattern, ui_screen_fingerprints.title_pattern),
            element_count = EXCLUDED.element_count,
            description = COALESCE(EXCLUDED.description, ui_screen_fingerprints.description),
            sample_event_id = COALESCE(EXCLUDED.sample_event_id, ui_screen_fingerprints.sample_event_id)
        `, [app, screen, titlePattern || null, elementCount, description || null, sampleEventId || null]);

        res.json({ ok: true, app, screen, elementCount });
      });
    } catch (e) {
      console.error('[vision-learning] learn-screen error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /match-click — 마우스 좌표 → UI 요소 매칭
  // Body: { userId, mouseX, mouseY, windowTitle, timestamp, screenWidth?, screenHeight?, beforeScreen? }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/match-click', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const {
          userId, mouseX, mouseY, windowTitle, timestamp,
          screenWidth = 1920, screenHeight = 1080,
          beforeScreen, afterScreen,
        } = req.body;

        if (mouseX === undefined || mouseY === undefined) {
          return res.status(400).json({ error: 'mouseX and mouseY required' });
        }

        // 정규화
        const nx = mouseX / screenWidth;
        const ny = mouseY / screenHeight;

        // windowTitle에서 앱·화면 추론
        let appName = 'unknown';
        let screenName = 'unknown';

        if (windowTitle) {
          // 화면 fingerprint에서 title_pattern 매칭 시도
          const fpRes = await db.query(
            'SELECT app_name, screen_name, title_pattern FROM ui_screen_fingerprints WHERE title_pattern IS NOT NULL'
          );
          for (const fp of fpRes.rows) {
            try {
              if (fp.title_pattern && new RegExp(fp.title_pattern, 'i').test(windowTitle)) {
                appName = fp.app_name;
                screenName = fp.screen_name;
                break;
              }
            } catch (e) { /* regex 오류 무시 */ }
          }

          // regex 매칭 실패 시 단순 추론
          if (appName === 'unknown') {
            const lowerTitle = windowTitle.toLowerCase();
            if (lowerTitle.includes('nenova') || lowerTitle.includes('네노바') || lowerTitle.includes('화훼관리')) {
              appName = 'nenova';
              // 화면명 추출: 타이틀에서 " - " 뒤 부분
              const parts = windowTitle.split(/\s*[-–]\s*/);
              if (parts.length > 1) screenName = parts[parts.length - 1].trim();
            } else if (lowerTitle.includes('chrome') || lowerTitle.includes('edge')) {
              appName = 'browser';
            } else if (lowerTitle.includes('excel')) {
              appName = 'excel';
            } else if (lowerTitle.includes('kakaotalk') || lowerTitle.includes('카카오톡')) {
              appName = 'kakaotalk';
            }
          }
        }

        // 가장 가까운 UI 요소 찾기
        const elementsRes = await db.query(
          'SELECT id, element_type, element_label, position_x, position_y, width, height, action_hint, confidence FROM ui_elements WHERE app_name = $1 AND screen_name = $2',
          [appName, screenName]
        );

        let matched = null;
        let minDist = Infinity;
        const MATCH_THRESHOLD = 0.05; // 5% 이내 → 높은 확신도
        const WEAK_THRESHOLD = 0.10;  // 10% 이내 → 약한 매칭

        for (const el of elementsRes.rows) {
          if (el.position_x === null || el.position_y === null) continue;
          const dist = euclidean(nx, ny, el.position_x, el.position_y);
          if (dist < minDist) {
            minDist = dist;
            matched = el;
          }
        }

        const matchConfidence = minDist <= MATCH_THRESHOLD ? 'high'
          : minDist <= WEAK_THRESHOLD ? 'medium' : 'low';

        // 클릭 기록 저장
        const elementId = (matched && minDist <= WEAK_THRESHOLD) ? matched.id : null;
        await db.query(`
          INSERT INTO ui_click_map (app_name, screen_name, click_x, click_y, element_id, user_id, timestamp, before_screen, after_screen)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          appName, screenName, nx, ny, elementId,
          userId || null,
          timestamp ? new Date(timestamp) : new Date(),
          beforeScreen || null, afterScreen || null,
        ]);

        // 화면 전이 기록 (Zone 정보 포함)
        const zone = getZone(ny);

        res.json({
          ok: true,
          click: { x: nx, y: ny, rawX: mouseX, rawY: mouseY },
          zone: zone.name,
          zoneLabel: zone.label,
          app: appName,
          screen: screenName,
          matchConfidence,
          distance: Math.round(minDist * 10000) / 10000,
          matched: matched && minDist <= WEAK_THRESHOLD ? {
            id: matched.id,
            type: matched.element_type,
            label: matched.element_label,
            actionHint: matched.action_hint,
            confidence: matched.confidence,
          } : null,
        });
      });
    } catch (e) {
      console.error('[vision-learning] match-click error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /elements — 학습된 UI 요소 목록
  // Query: ?app=nenova&screen=주문등록&type=button
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/elements', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, type } = req.query;

        let sql = 'SELECT * FROM ui_elements WHERE 1=1';
        const params = [];
        let idx = 1;

        if (app) { sql += ` AND app_name = $${idx++}`; params.push(app); }
        if (screen) { sql += ` AND screen_name = $${idx++}`; params.push(screen); }
        if (type) { sql += ` AND element_type = $${idx++}`; params.push(type); }

        sql += ' ORDER BY screen_name, element_type, element_label';

        const result = await db.query(sql, params);

        // 화면별 그룹핑
        const grouped = {};
        for (const row of result.rows) {
          const key = `${row.app_name}:${row.screen_name}`;
          if (!grouped[key]) grouped[key] = { app: row.app_name, screen: row.screen_name, elements: [] };
          grouped[key].elements.push({
            id: row.id,
            type: row.element_type,
            label: row.element_label,
            position: { x: row.position_x, y: row.position_y },
            size: { width: row.width, height: row.height },
            confidence: row.confidence,
            seenCount: row.seen_count,
            lastSeen: row.last_seen,
            firstSeen: row.first_seen,
            actionHint: row.action_hint,
            zone: row.position_y !== null ? getZone(row.position_y).label : null,
          });
        }

        res.json({
          ok: true,
          total: result.rows.length,
          screens: Object.values(grouped),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /screens — 학습된 화면 목록
  // Query: ?app=nenova
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/screens', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app } = req.query;
        let sql = 'SELECT * FROM ui_screen_fingerprints';
        const params = [];

        if (app) { sql += ' WHERE app_name = $1'; params.push(app); }
        sql += ' ORDER BY app_name, screen_name';

        const result = await db.query(sql, params);

        res.json({
          ok: true,
          total: result.rows.length,
          screens: result.rows.map(r => ({
            id: r.id,
            app: r.app_name,
            screen: r.screen_name,
            titlePattern: r.title_pattern,
            elementCount: r.element_count,
            description: r.description,
            sampleEventId: r.sample_event_id,
            createdAt: r.created_at,
          })),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /click-map — 클릭 히트맵
  // Query: ?app=nenova&screen=주문등록&limit=1000
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/click-map', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, limit = 1000 } = req.query;

        let sql = `
          SELECT cm.*, ue.element_label, ue.element_type, ue.action_hint
          FROM ui_click_map cm
          LEFT JOIN ui_elements ue ON cm.element_id = ue.id
          WHERE 1=1
        `;
        const params = [];
        let idx = 1;

        if (app) { sql += ` AND cm.app_name = $${idx++}`; params.push(app); }
        if (screen) { sql += ` AND cm.screen_name = $${idx++}`; params.push(screen); }

        sql += ` ORDER BY cm.timestamp DESC LIMIT $${idx++}`;
        params.push(parseInt(limit));

        const result = await db.query(sql, params);

        // 히트맵 생성: 좌표 영역별 클릭 빈도
        const heatmap = {};
        for (const row of result.rows) {
          // 5% 단위로 영역 구분
          const gx = Math.floor(row.click_x * 20);
          const gy = Math.floor(row.click_y * 20);
          const key = `${gx},${gy}`;
          if (!heatmap[key]) heatmap[key] = { x: gx / 20, y: gy / 20, count: 0, elements: [] };
          heatmap[key].count++;
          if (row.element_label && !heatmap[key].elements.includes(row.element_label)) {
            heatmap[key].elements.push(row.element_label);
          }
        }

        // 전이 패턴 (before → after 화면)
        const transitions = {};
        for (const row of result.rows) {
          if (row.before_screen && row.after_screen && row.before_screen !== row.after_screen) {
            const key = `${row.before_screen} → ${row.after_screen}`;
            transitions[key] = (transitions[key] || 0) + 1;
          }
        }

        res.json({
          ok: true,
          total: result.rows.length,
          heatmap: Object.values(heatmap).sort((a, b) => b.count - a.count),
          transitions: Object.entries(transitions)
            .map(([path, count]) => ({ path, count }))
            .sort((a, b) => b.count - a.count),
          clicks: result.rows.map(r => ({
            x: r.click_x,
            y: r.click_y,
            app: r.app_name,
            screen: r.screen_name,
            element: r.element_label || null,
            elementType: r.element_type || null,
            userId: r.user_id,
            timestamp: r.timestamp,
            zone: getZone(r.click_y).label,
          })),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /click-map/:userId — 직원별 클릭 패턴
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/click-map/:userId', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { userId } = req.params;
        const { app, limit = 500 } = req.query;

        let sql = `
          SELECT cm.*, ue.element_label, ue.element_type, ue.action_hint
          FROM ui_click_map cm
          LEFT JOIN ui_elements ue ON cm.element_id = ue.id
          WHERE cm.user_id = $1
        `;
        const params = [userId];
        let idx = 2;

        if (app) { sql += ` AND cm.app_name = $${idx++}`; params.push(app); }

        sql += ` ORDER BY cm.timestamp DESC LIMIT $${idx++}`;
        params.push(parseInt(limit));

        const result = await db.query(sql, params);

        // 사용자 클릭 패턴 분석
        const elementFreq = {};
        const screenFreq = {};
        const zoneFreq = {};

        for (const row of result.rows) {
          // 요소별 빈도
          if (row.element_label) {
            const eKey = `${row.element_type}:${row.element_label}`;
            elementFreq[eKey] = (elementFreq[eKey] || 0) + 1;
          }
          // 화면별 빈도
          const sKey = `${row.app_name}:${row.screen_name}`;
          screenFreq[sKey] = (screenFreq[sKey] || 0) + 1;
          // 영역별 빈도
          const zone = getZone(row.click_y);
          zoneFreq[zone.label] = (zoneFreq[zone.label] || 0) + 1;
        }

        res.json({
          ok: true,
          userId,
          total: result.rows.length,
          topElements: Object.entries(elementFreq)
            .map(([el, count]) => ({ element: el, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20),
          topScreens: Object.entries(screenFreq)
            .map(([scr, count]) => ({ screen: scr, count }))
            .sort((a, b) => b.count - a.count),
          zoneDistribution: zoneFreq,
          recentClicks: result.rows.slice(0, 50).map(r => ({
            x: r.click_x,
            y: r.click_y,
            element: r.element_label,
            screen: r.screen_name,
            zone: getZone(r.click_y).label,
            timestamp: r.timestamp,
          })),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /analyze-zones — 화면 영역별 분석 결과 저장
  // Body: { app, screen, zones: [{ name, elements: [...] }] }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/analyze-zones', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, zones } = req.body;
        if (!app || !screen) return res.status(400).json({ error: 'app and screen required' });
        if (!zones || !Array.isArray(zones)) return res.status(400).json({ error: 'zones array required' });

        let totalLearned = 0;

        for (const zone of zones) {
          const zoneDef = SCREEN_ZONES.find(z => z.name === zone.name);
          if (!zoneDef || !zone.elements) continue;

          for (const el of zone.elements) {
            const label = el.label || el.name || '';
            if (!label) continue;

            // Zone 기반 Y좌표 보정
            const yMid = (zoneDef.yStart + zoneDef.yEnd) / 2;
            const pos = parsePosition(el.position || '');
            // Zone 내부 상대 위치를 Zone 절대 위치로 매핑
            const adjustedY = zoneDef.yStart + (pos.y * (zoneDef.yEnd - zoneDef.yStart));

            try {
              await db.query(`
                INSERT INTO ui_elements (app_name, screen_name, element_type, element_label,
                                         position_x, position_y, confidence, action_hint)
                VALUES ($1, $2, $3, $4, $5, $6, 0.7, $7)
                ON CONFLICT (app_name, screen_name, element_label, element_type) DO UPDATE SET
                  seen_count = ui_elements.seen_count + 1,
                  last_seen = NOW(),
                  position_x = EXCLUDED.position_x,
                  position_y = EXCLUDED.position_y,
                  confidence = LEAST(1.0, ui_elements.confidence + 0.05)
              `, [
                app, screen,
                (el.type || 'unknown').toLowerCase(),
                label,
                pos.x,
                adjustedY,
                el.actionHint || null,
              ]);
              totalLearned++;
            } catch (e) { /* 개별 실패 무시 */ }
          }
        }

        res.json({
          ok: true,
          learned: totalLearned,
          zonesProcessed: zones.length,
          app,
          screen,
        });
      });
    } catch (e) {
      console.error('[vision-learning] analyze-zones error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /screen-structure/:app — 앱의 화면 구조 트리
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/screen-structure/:app', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app } = req.params;

        // 화면 목록
        const screensRes = await db.query(
          'SELECT * FROM ui_screen_fingerprints WHERE app_name = $1 ORDER BY screen_name',
          [app]
        );

        // 각 화면의 요소 통계
        const elemStatsRes = await db.query(`
          SELECT screen_name, element_type, COUNT(*) as cnt
          FROM ui_elements
          WHERE app_name = $1
          GROUP BY screen_name, element_type
          ORDER BY screen_name, cnt DESC
        `, [app]);

        // 화면 간 전이 (클릭맵 기반)
        const transitionsRes = await db.query(`
          SELECT before_screen, after_screen, COUNT(*) as cnt
          FROM ui_click_map
          WHERE app_name = $1
            AND before_screen IS NOT NULL
            AND after_screen IS NOT NULL
            AND before_screen != after_screen
          GROUP BY before_screen, after_screen
          ORDER BY cnt DESC
          LIMIT 50
        `, [app]);

        // 구조 트리 구성
        const tree = {};
        for (const scr of screensRes.rows) {
          tree[scr.screen_name] = {
            screen: scr.screen_name,
            description: scr.description,
            elementCount: scr.element_count,
            titlePattern: scr.title_pattern,
            elements: {},
            transitions: [],
          };
        }

        // 요소 통계 매핑
        for (const stat of elemStatsRes.rows) {
          if (tree[stat.screen_name]) {
            tree[stat.screen_name].elements[stat.element_type] = parseInt(stat.cnt);
          }
        }

        // 전이 매핑
        for (const tr of transitionsRes.rows) {
          if (tree[tr.before_screen]) {
            tree[tr.before_screen].transitions.push({
              to: tr.after_screen,
              count: parseInt(tr.cnt),
            });
          }
        }

        res.json({
          ok: true,
          app,
          screenCount: screensRes.rows.length,
          structure: Object.values(tree),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /predictions — 다음 클릭 예측 (학습된 패턴 기반)
  // Query: ?app=nenova&screen=주문목록&lastClick=신규주문&userId=xxx
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/predictions', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, lastClick, userId } = req.query;
        if (!app) return res.status(400).json({ error: 'app required' });

        const predictions = [];

        // Strategy 1: 화면 전이 예측 (현재 화면에서 가장 빈번한 다음 화면)
        if (screen) {
          const transRes = await db.query(`
            SELECT after_screen, COUNT(*) as cnt
            FROM ui_click_map
            WHERE app_name = $1 AND before_screen = $2
              AND after_screen IS NOT NULL AND after_screen != $2
            GROUP BY after_screen
            ORDER BY cnt DESC
            LIMIT 5
          `, [app, screen]);

          const total = transRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
          for (const row of transRes.rows) {
            predictions.push({
              type: 'screen_transition',
              prediction: `다음 화면: ${row.after_screen}`,
              probability: total > 0 ? Math.round((parseInt(row.cnt) / total) * 100) : 0,
              count: parseInt(row.cnt),
              target: row.after_screen,
            });
          }
        }

        // Strategy 2: 클릭 순서 예측 (특정 요소 클릭 후 가장 빈번한 다음 클릭 요소)
        if (lastClick) {
          // lastClick 요소 ID 찾기
          const lastElRes = await db.query(
            'SELECT id FROM ui_elements WHERE app_name = $1 AND element_label = $2 LIMIT 1',
            [app, lastClick]
          );

          if (lastElRes.rows.length > 0) {
            const lastElId = lastElRes.rows[0].id;

            // 이 요소 클릭 이후 바로 다음에 클릭된 요소 (시간순)
            const nextClickRes = await db.query(`
              WITH clicks_ordered AS (
                SELECT element_id, timestamp,
                       LEAD(element_id) OVER (PARTITION BY user_id ORDER BY timestamp) as next_element_id
                FROM ui_click_map
                WHERE app_name = $1
                  AND element_id IS NOT NULL
              )
              SELECT ue.element_label, ue.element_type, COUNT(*) as cnt
              FROM clicks_ordered co
              JOIN ui_elements ue ON co.next_element_id = ue.id
              WHERE co.element_id = $2
                AND co.next_element_id IS NOT NULL
                AND co.next_element_id != $2
              GROUP BY ue.element_label, ue.element_type
              ORDER BY cnt DESC
              LIMIT 5
            `, [app, lastElId]);

            const total = nextClickRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
            for (const row of nextClickRes.rows) {
              predictions.push({
                type: 'next_click',
                prediction: `다음 클릭: ${row.element_label} (${row.element_type})`,
                probability: total > 0 ? Math.round((parseInt(row.cnt) / total) * 100) : 0,
                count: parseInt(row.cnt),
                target: row.element_label,
                targetType: row.element_type,
              });
            }
          }
        }

        // Strategy 3: 사용자별 패턴 (해당 시간대 가장 많이 사용하는 화면)
        if (userId) {
          const hourlyRes = await db.query(`
            SELECT cm.screen_name, COUNT(*) as cnt
            FROM ui_click_map cm
            WHERE cm.app_name = $1
              AND cm.user_id = $2
              AND EXTRACT(HOUR FROM cm.timestamp) = EXTRACT(HOUR FROM NOW())
            GROUP BY cm.screen_name
            ORDER BY cnt DESC
            LIMIT 3
          `, [app, userId]);

          for (const row of hourlyRes.rows) {
            predictions.push({
              type: 'user_habit',
              prediction: `이 시간대 자주 사용: ${row.screen_name}`,
              count: parseInt(row.cnt),
              target: row.screen_name,
            });
          }
        }

        res.json({
          ok: true,
          app,
          currentScreen: screen || null,
          lastClick: lastClick || null,
          predictions,
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /auto-learn — 기존 screen.analyzed 이벤트에서 일괄 학습
  // Body: { limit? }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/auto-learn', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { limit = 500 } = req.body || {};
        const stats = await autoLearnBatch(db, parseInt(limit));
        _lastAutoLearn = new Date().toISOString();
        _autoLearnStats = stats;

        res.json({
          ok: true,
          ...stats,
          timestamp: _lastAutoLearn,
        });
      });
    } catch (e) {
      console.error('[vision-learning] auto-learn error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /learning-status — 학습 현황 (요소 수, 화면 수, 정확도)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning-status', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const [elementsRes, screensRes, clicksRes, typesRes, appsRes, avgConfRes] = await Promise.all([
          db.query('SELECT COUNT(*) as cnt FROM ui_elements'),
          db.query('SELECT COUNT(*) as cnt FROM ui_screen_fingerprints'),
          db.query('SELECT COUNT(*) as cnt FROM ui_click_map'),
          db.query('SELECT element_type, COUNT(*) as cnt FROM ui_elements GROUP BY element_type ORDER BY cnt DESC'),
          db.query('SELECT DISTINCT app_name FROM ui_elements ORDER BY app_name'),
          db.query('SELECT AVG(confidence) as avg_conf, MAX(seen_count) as max_seen FROM ui_elements'),
        ]);

        // 매칭률 계산 (element_id가 있는 클릭 / 전체 클릭)
        let matchRate = 0;
        try {
          const matchRes = await db.query(`
            SELECT
              COUNT(*) FILTER (WHERE element_id IS NOT NULL) as matched,
              COUNT(*) as total
            FROM ui_click_map
          `);
          const r = matchRes.rows[0];
          if (r && parseInt(r.total) > 0) {
            matchRate = Math.round((parseInt(r.matched) / parseInt(r.total)) * 100);
          }
        } catch (e) { /* 무시 */ }

        res.json({
          ok: true,
          elements: parseInt(elementsRes.rows[0]?.cnt || 0),
          screens: parseInt(screensRes.rows[0]?.cnt || 0),
          clicks: parseInt(clicksRes.rows[0]?.cnt || 0),
          apps: appsRes.rows.map(r => r.app_name),
          elementTypes: typesRes.rows.map(r => ({
            type: r.element_type,
            count: parseInt(r.cnt),
          })),
          avgConfidence: parseFloat(avgConfRes.rows[0]?.avg_conf || 0).toFixed(3),
          maxSeenCount: parseInt(avgConfRes.rows[0]?.max_seen || 0),
          clickMatchRate: `${matchRate}%`,
          autoLearn: {
            lastRun: _lastAutoLearn,
            stats: _autoLearnStats,
            schedulerActive: !!_autoLearnInterval,
          },
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /unknown-screens — 아직 학습 안 된 화면 목록
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/unknown-screens', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        // screen.analyzed 이벤트에서 발견된 화면 중 ui_screen_fingerprints에 없는 것
        const result = await db.query(`
          SELECT
            data_json->>'app' as app,
            data_json->>'screen' as screen,
            COUNT(*) as event_count,
            MAX(timestamp) as last_seen
          FROM events
          WHERE type = 'screen.analyzed'
            AND data_json->>'app' IS NOT NULL
            AND data_json->>'screen' IS NOT NULL
          GROUP BY data_json->>'app', data_json->>'screen'
          HAVING NOT EXISTS (
            SELECT 1 FROM ui_screen_fingerprints fp
            WHERE fp.app_name = data_json->>'app'
              AND fp.screen_name = data_json->>'screen'
          )
          ORDER BY event_count DESC
        `);

        res.json({
          ok: true,
          total: result.rows.length,
          unknownScreens: result.rows.map(r => ({
            app: r.app,
            screen: r.screen,
            eventCount: parseInt(r.event_count),
            lastSeen: r.last_seen,
          })),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /enhanced-prompt — 화면별 맞춤 분석 프롬프트 생성
  // Query: ?app=nenova&screen=주문등록
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/enhanced-prompt', async (req, res) => {
    try {
      await withDb(res, async (db) => {
        const { app, screen, windowTitle } = req.query;

        let targetApp = app;
        let targetScreen = screen;

        // windowTitle로 자동 감지
        if (!targetApp && windowTitle) {
          const fpRes = await db.query(
            'SELECT app_name, screen_name, title_pattern FROM ui_screen_fingerprints WHERE title_pattern IS NOT NULL'
          );
          for (const fp of fpRes.rows) {
            try {
              if (fp.title_pattern && new RegExp(fp.title_pattern, 'i').test(windowTitle)) {
                targetApp = fp.app_name;
                targetScreen = fp.screen_name;
                break;
              }
            } catch (e) { /* regex 오류 무시 */ }
          }
        }

        // 알려진 요소 조회
        let knownElements = [];
        let screenInfo = null;

        if (targetApp && targetScreen) {
          const elemRes = await db.query(
            'SELECT element_type, element_label, position_x, position_y, confidence, seen_count FROM ui_elements WHERE app_name = $1 AND screen_name = $2 ORDER BY confidence DESC, seen_count DESC',
            [targetApp, targetScreen]
          );
          knownElements = elemRes.rows;

          const fpRes = await db.query(
            'SELECT * FROM ui_screen_fingerprints WHERE app_name = $1 AND screen_name = $2',
            [targetApp, targetScreen]
          );
          screenInfo = fpRes.rows[0] || null;
        }

        // 프롬프트 생성
        let prompt = '';

        if (knownElements.length > 0) {
          // 학습된 화면 → 정밀 프롬프트
          const elementSummary = knownElements.slice(0, 20).map(el => {
            const zone = getZone(el.position_y || 0.5);
            return `  - ${el.element_label} (${el.element_type}, ${zone.label}, 확신도 ${(el.confidence * 100).toFixed(0)}%)`;
          }).join('\n');

          prompt = `이 화면은 ${targetApp} '${targetScreen}' 화면입니다.

알려진 UI 요소 (${knownElements.length}개):
${elementSummary}

분석 지침:
1. 위 요소들의 현재 상태(활성/비활성, 값, 변경점)를 확인해주세요.
2. 새로 발견된 요소가 있으면 위치와 함께 추가해주세요.
3. 특히 데이터 영역(15-85% 높이)의 변경사항에 집중해주세요.
4. 이전에 없던 팝업, 모달, 알림이 있으면 별도 표시해주세요.

JSON 응답 형식:
{
  "app": "${targetApp}",
  "screen": "${targetScreen}",
  "screenChanged": true/false,
  "elements": [{"type":"...","label":"...","position":"위치설명","status":"활성|비활성|변경됨","value":"표시 값"}],
  "newElements": [{"type":"...","label":"...","position":"위치설명"}],
  "dataArea": { "type":"table|form|chart", "summary":"데이터 영역 설명" },
  "activity": "사용자 작업 1줄 설명",
  "automatable": true/false,
  "automationHint": "자동화 가능 부분",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타"
}`;
        } else {
          // 미학습 화면 → 탐색 프롬프트
          prompt = `이 스크린샷을 분석하여 UI 요소를 학습합니다.

화면을 6개 영역으로 분할 분석:
- 제목 바 (0-5%): 프로그램 제목, 버전
- 메뉴 바 (5-10%): 메뉴 항목
- 도구 바 (10-15%): 버튼, 검색, 필터
- 데이터 영역 (15-85%): 테이블, 입력 폼, 차트
- 액션 바 (85-95%): 저장, 취소, 인쇄 등
- 상태 바 (95-100%): 상태 정보

JSON 응답 형식:
{
  "app": "프로그램명",
  "screen": "화면명/메뉴명",
  "elements": [
    {"type":"button|input|menu|table|tab|label|dropdown|checkbox",
     "label":"텍스트",
     "position":"영역 위치 설명 (예: 상단 왼쪽, 중앙 데이터 영역)",
     "actionHint":"클릭 시 동작 추정"}
  ],
  "zones": {
    "title_bar": "제목 바 내용",
    "menu_bar": "메뉴 항목 목록",
    "toolbar": "도구 바 내용",
    "data_area": "데이터 영역 유형 및 설명",
    "action_bar": "하단 버튼 목록",
    "status_bar": "상태 바 정보"
  },
  "activity": "사용자 작업 1줄 설명",
  "dataVisible": "화면 데이터 종류",
  "automatable": true/false,
  "automationHint": "자동화 가능 부분",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타"
}`;
        }

        res.json({
          ok: true,
          app: targetApp || null,
          screen: targetScreen || null,
          isKnownScreen: knownElements.length > 0,
          knownElementCount: knownElements.length,
          screenInfo: screenInfo ? {
            description: screenInfo.description,
            elementCount: screenInfo.element_count,
          } : null,
          prompt,
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 자동 학습 스케줄러 — 2시간마다 신규 이벤트 학습
  // 서버 시작 10분 후 첫 실행, 이후 2시간마다 반복
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async function _runAutoLearn() {
    try {
      const db = getDb();
      if (!db?.query) return;
      await ensureTables(db);

      console.log('[vision-learning] 자동 학습 시작...');
      const stats = await autoLearnBatch(db, 200);
      _lastAutoLearn = new Date().toISOString();
      _autoLearnStats = stats;
      console.log(`[vision-learning] 자동 학습 완료: ${stats.scanned}건 스캔, ${stats.learned}개 요소 학습, ${stats.screens.length}개 화면`);
    } catch (e) {
      console.warn('[vision-learning] 자동 학습 실패:', e.message);
    }
  }

  // 10분 후 첫 실행, 이후 2시간 간격
  setTimeout(() => {
    _runAutoLearn();
    _autoLearnInterval = setInterval(_runAutoLearn, 2 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  return router;
};
