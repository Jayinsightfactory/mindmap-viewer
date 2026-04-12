'use strict';
/**
 * process-mining.js — 업무 프로세스 마이닝 엔진
 *
 * 3개 데이터 소스 교차 분석:
 *   A. Orbit 활동 이벤트 (PG) — keyboard.chunk, screen.capture, clipboard.change
 *   B. Nenova 전산 (SQL Server) — 주문, 출하, 거래처, 상품
 *   C. 카톡 분석 (Google Sheets) — 비즈니스이벤트, 의사결정, 불량
 *
 * 이벤트 데이터 → 앱 전환 패턴 → 업무 흐름 추출 → 병목/의사결정 분석
 *
 * 엔드포인트:
 *   GET /api/mining/timeline    — 사용자별 활동 타임라인
 *   GET /api/mining/workflows   — 업무 흐름(프로세스 시퀀스) 추출
 *   GET /api/mining/bottlenecks — 병목 감지 + 시간 이상치
 *   GET /api/mining/compare     — 직원 간 비교 분석
 *   GET /api/mining/summary     — 전체 프로세스 마이닝 요약
 *   GET /api/mining/decisions   — 의사결정 분기점 분석
 *   GET /api/mining/anomalies   — 비정상 패턴 감지
 *   POST /api/mining/report     — 종합 리포트 생성 + Google Sheets 저장
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

// ── 상수 ─────────────────────────────────────────────────────────────────────
const SESSION_GAP_MS  = 5 * 60 * 1000;   // 5분 이상 공백 → 새 세션
const MERGE_WINDOW_MS = 30 * 1000;        // 30초 이내 동일 앱 → 하나의 블록
const MIN_BLOCK_MS    = 5 * 1000;         // 5초 미만 블록 → 노이즈 제거

// 분석 대상 이벤트 타입
const WORK_TYPES = [
  'keyboard.chunk', 'screen.capture', 'screen.analyzed',
  'clipboard.change', 'order.detected', 'purchase.order.detected',
];

// Recorder 이벤트 타입 (SQLite에서 병합 시 사용)
const RECORDER_TYPES = ['recorder.click', 'recorder.key', 'recorder.screenshot'];

// windowTitle에서 앱 추론 (app 필드가 비어있을 때)
function inferAppFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (t.includes('카카오톡') || t.includes('kakaotalk')) return 'kakaotalk';
  if (t.includes('excel') || t.includes('.xlsx') || t.includes('.xls')) return 'excel';
  if (t.includes('chrome')) return 'chrome';
  if (t.includes('edge')) return 'msedge';
  if (t.includes('powerpoint') || t.includes('.pptx')) return 'powerpnt';
  if (t.includes('word') || t.includes('.docx')) return 'word';
  if (t.includes('nenova') || t.includes('네노바')) return 'nenova';
  if (t.includes('wechat')) return 'wechat';
  if (t.includes('discord')) return 'discord';
  if (t.includes('물량') || t.includes('주문') || t.includes('출고') || t.includes('발주') || t.includes('재고')) return 'nenova';
  return null;
}

// 앱 이름 정규화
function normalizeApp(raw, windowTitle) {
  if (!raw || raw === 'unknown') raw = inferAppFromTitle(windowTitle) || '';
  if (!raw) return 'unknown';
  const l = raw.toLowerCase().trim();
  if (l.includes('kakaotalk') || l.includes('카카오톡')) return 'KakaoTalk';
  if (l.includes('excel') || l.includes('스프레드시트')) return 'Excel';
  if (l.includes('nenova') || l.includes('네노바') || l.includes('재고관리') || l.includes('주문관리')) return 'Nenova ERP';
  if (l.includes('chrome') || l.includes('edge') || l.includes('브라우저')) return 'Browser';
  if (l.includes('explorer') || l.includes('파일')) return 'Explorer';
  if (l.includes('outlook') || l.includes('메일')) return 'Email';
  if (l.includes('teams') || l.includes('팀즈')) return 'Teams';
  if (l.includes('discord')) return 'Discord';
  if (l.includes('메모장') || l.includes('notepad')) return 'Notepad';
  if (l.includes('powerpnt') || l.includes('powerpoint')) return 'PowerPoint';
  if (l.includes('word') || l.includes('winword')) return 'Word';
  if (l.includes('hwp') || l.includes('한글')) return 'HWP';
  if (l.includes('주문감지')) return '주문감지';
  if (l.includes('발주감지')) return '발주감지';
  if (l.includes('wechat')) return 'WeChat';
  if (l.includes('msedge')) return 'Browser';
  if (!raw || raw === 'unknown') return 'unknown';
  return raw.length > 30 ? raw.substring(0, 30) : raw;
}

// ── 핵심 함수: 이벤트 → 활동 블록 변환 ──────────────────────────────────────
function buildActivityBlocks(events) {
  if (!events.length) return [];

  const blocks = [];
  let cur = null;

  for (const ev of events) {
    const ts = new Date(ev.timestamp).getTime();
    // 이벤트 타입별 기본 앱 지정
    let rawApp = ev.app || ev.sourceApp || '';
    if (!rawApp && ev.type === 'order.detected') rawApp = '주문감지';
    if (!rawApp && ev.type === 'purchase.order.detected') rawApp = '발주감지';
    const app = normalizeApp(rawApp, ev.windowTitle);
    if (app === 'unknown') continue; // 앱 추론 불가능한 이벤트 스킵
    const detail = ev.activity || ev.windowTitle || ev.screen || ev.text || '';

    if (!cur || app !== cur.app || (ts - cur.endTs) > MERGE_WINDOW_MS) {
      // 새 블록 시작
      if (cur) blocks.push(cur);
      cur = {
        app,
        startTs: ts,
        endTs: ts,
        duration: 0,
        events: 1,
        details: detail ? [detail] : [],
        types: new Set([ev.type]),
        workCategory: ev.workCategory || null,
        automationScore: ev.automationScore != null ? parseFloat(ev.automationScore) : null,
      };
    } else {
      // 기존 블록 확장
      cur.endTs = ts;
      cur.duration = cur.endTs - cur.startTs;
      cur.events++;
      if (detail && !cur.details.includes(detail)) cur.details.push(detail);
      cur.types.add(ev.type);
      if (ev.workCategory && !cur.workCategory) cur.workCategory = ev.workCategory;
      if (ev.automationScore != null && cur.automationScore == null) cur.automationScore = parseFloat(ev.automationScore);
    }
  }
  if (cur) blocks.push(cur);

  // 후처리: duration 계산 + Set→Array + 노이즈 제거
  return blocks
    .map(b => ({
      ...b,
      duration: b.endTs - b.startTs,
      types: [...b.types],
      details: b.details.slice(0, 5), // 최대 5개
    }))
    .filter(b => b.duration >= MIN_BLOCK_MS || b.events >= 2);
}

// ── 활동 블록 → 세션 분리 ────────────────────────────────────────────────────
function splitSessions(blocks) {
  if (!blocks.length) return [];
  const sessions = [];
  let cur = { blocks: [blocks[0]], startTs: blocks[0].startTs, endTs: blocks[0].endTs };

  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].startTs - cur.endTs > SESSION_GAP_MS) {
      sessions.push(cur);
      cur = { blocks: [blocks[i]], startTs: blocks[i].startTs, endTs: blocks[i].endTs };
    } else {
      cur.blocks.push(blocks[i]);
      cur.endTs = blocks[i].endTs;
    }
  }
  sessions.push(cur);

  return sessions.map((s, i) => ({
    sessionIndex: i,
    startTime: new Date(s.startTs).toISOString(),
    endTime: new Date(s.endTs).toISOString(),
    durationMin: Math.round((s.endTs - s.startTs) / 60000),
    blockCount: s.blocks.length,
    apps: [...new Set(s.blocks.map(b => b.app))],
    blocks: s.blocks.map(b => ({
      app: b.app,
      startTime: new Date(b.startTs).toISOString(),
      endTime: new Date(b.endTs).toISOString(),
      durationSec: Math.round(b.duration / 1000),
      events: b.events,
      workCategory: b.workCategory,
      details: b.details,
      automationScore: b.automationScore,
    })),
  }));
}

// ── 전이 행렬 (앱 A → 앱 B 빈도) ────────────────────────────────────────────
function buildTransitionMatrix(blocks) {
  const matrix = {};  // { "A→B": count }
  const appTime = {}; // { app: totalMs }

  for (let i = 0; i < blocks.length; i++) {
    const app = blocks[i].app;
    appTime[app] = (appTime[app] || 0) + blocks[i].duration;

    if (i > 0) {
      const prev = blocks[i - 1].app;
      if (prev !== app) {
        const key = `${prev}→${app}`;
        matrix[key] = (matrix[key] || 0) + 1;
      }
    }
  }

  // 정렬된 전이 목록
  const transitions = Object.entries(matrix)
    .map(([key, count]) => {
      const [from, to] = key.split('→');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  // 앱별 시간 (분 단위, 정렬)
  const timeByApp = Object.entries(appTime)
    .map(([app, ms]) => ({ app, minutes: Math.round(ms / 60000), ms }))
    .sort((a, b) => b.ms - a.ms);

  return { transitions, timeByApp };
}

// ── 워크플로우 패턴 추출 (N-gram) ───────────────────────────────────────────
function extractPatterns(blocks, minSupport = 2) {
  const appSeq = blocks.map(b => b.app);
  const patterns = {};  // { "A→B→C": { count, avgDurationMs, instances: [...] } }

  // 2-gram, 3-gram, 4-gram 추출
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i <= appSeq.length - n; i++) {
      const slice = appSeq.slice(i, i + n);
      // 연속 중복 제거 (A→A→B → A→B)
      if (slice[0] === slice[1]) continue;
      const key = slice.join('→');
      if (!patterns[key]) patterns[key] = { count: 0, totalDuration: 0, instances: [] };
      patterns[key].count++;
      const durMs = blocks[i + n - 1].endTs - blocks[i].startTs;
      patterns[key].totalDuration += durMs;
      patterns[key].instances.push({
        startTime: new Date(blocks[i].startTs).toISOString(),
        durationMin: Math.round(durMs / 60000),
      });
    }
  }

  return Object.entries(patterns)
    .filter(([, v]) => v.count >= minSupport)
    .map(([pattern, v]) => ({
      pattern,
      steps: pattern.split('→'),
      count: v.count,
      avgDurationMin: Math.round(v.totalDuration / v.count / 60000),
      instances: v.instances.slice(0, 10),
    }))
    .sort((a, b) => b.count - a.count);
}

// ── 병목 감지 ────────────────────────────────────────────────────────────────
function detectBottlenecks(blocks) {
  // 앱별 블록 duration 수집
  const byApp = {};
  for (const b of blocks) {
    if (!byApp[b.app]) byApp[b.app] = [];
    byApp[b.app].push(b.duration);
  }

  const bottlenecks = [];
  for (const [app, durations] of Object.entries(byApp)) {
    if (durations.length < 3) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length;

    // 평균 대비 2배 이상인 블록 = 이상치
    const outliers = blocks.filter(b => b.app === app && b.duration > avg * 2);
    if (outliers.length > 0) {
      bottlenecks.push({
        app,
        avgDurationSec: Math.round(avg / 1000),
        medianDurationSec: Math.round(median / 1000),
        outlierCount: outliers.length,
        worstCaseSec: Math.round(Math.max(...durations) / 1000),
        totalOccurrences: durations.length,
        outlierExamples: outliers.slice(0, 3).map(b => ({
          startTime: new Date(b.startTs).toISOString(),
          durationSec: Math.round(b.duration / 1000),
          details: b.details,
        })),
      });
    }
  }

  return bottlenecks.sort((a, b) => b.outlierCount - a.outlierCount);
}

// ═════════════════════════════════════════════════════════════════════════════
// 라우터 생성
// ═════════════════════════════════════════════════════════════════════════════
function createProcessMining({ getDb, reportSheet }) {
  const router = express.Router();
  router.use(express.json());

  // ── 공통: 이벤트 조회 ──────────────────────────────────────────────────────
  async function fetchEvents(db, userId, date, days) {
    const d = days || 1;
    const startDate = date || new Date().toISOString().substring(0, 10);
    const { rows } = await db.query(`
      SELECT type, timestamp,
        COALESCE(data_json->>'app', data_json->>'sourceApp', '') as app,
        data_json->>'windowTitle' as "windowTitle",
        data_json->>'activity' as activity,
        data_json->>'screen' as screen,
        data_json->>'workCategory' as "workCategory",
        data_json->>'automationScore' as "automationScore",
        LEFT(data_json->>'text', 100) as text
      FROM events
      WHERE user_id = $1
        AND type = ANY($2)
        AND timestamp::date >= $3::date
        AND timestamp::date < ($3::date + $4 * INTERVAL '1 day')
      ORDER BY timestamp ASC
    `, [userId, WORK_TYPES, startDate, d]);
    return rows;
  }

  // ── recorder DB에서 이벤트 가져오기 (SQLite → 동일 형식 변환) ─────────────
  function fetchRecorderEvents(date, days) {
    const dbPath = path.join(__dirname, '..', 'data', 'recording.db');
    if (!fs.existsSync(dbPath)) return [];

    let Database;
    try { Database = require('better-sqlite3'); } catch { return []; }

    let rdb;
    try {
      rdb = new Database(dbPath, { readonly: true });

      const d = days || 1;
      const startDate = date || new Date().toISOString().substring(0, 10);
      const endDate = new Date(new Date(startDate).getTime() + d * 86400000).toISOString().substring(0, 10);

      // 해당 날짜 범위의 세션 찾기
      const sessions = rdb.prepare(`
        SELECT id FROM recording_sessions
        WHERE started_at >= ? AND started_at < ?
      `).all(startDate, endDate + 'T23:59:59Z');

      if (!sessions.length) { rdb.close(); return []; }

      const sessionIds = sessions.map(s => s.id);
      const placeholders = sessionIds.map(() => '?').join(',');

      // mouse_click + keydown 이벤트만 (mouse_move/scroll은 노이즈)
      const rows = rdb.prepare(`
        SELECT event_type, timestamp_abs, data_json
        FROM activity_events
        WHERE session_id IN (${placeholders})
          AND event_type IN ('mouse_click', 'keydown', 'screenshot')
        ORDER BY timestamp_abs ASC
        LIMIT 50000
      `).all(...sessionIds);

      rdb.close();

      // process-mining 이벤트 형식으로 변환
      return rows.map(row => {
        let data = {};
        try { data = JSON.parse(row.data_json || '{}'); } catch {}

        // mouse_click만 pressed=true 필터 (눌림만, 뗌은 제외)
        if (row.event_type === 'mouse_click' && data.pressed === false) return null;
        // keydown은 modifier키 제외 (shift, ctrl, alt 단독은 스킵)
        if (row.event_type === 'keydown' && data.is_special && !data.key?.startsWith('f')) return null;

        const app = data.processName || '';
        const windowTitle = data.windowTitle || '';

        return {
          type: row.event_type === 'mouse_click' ? 'recorder.click'
              : row.event_type === 'keydown'     ? 'recorder.key'
              : 'recorder.screenshot',
          timestamp: row.timestamp_abs,
          app,
          windowTitle,
          activity: row.event_type === 'mouse_click'
            ? `click(${data.x},${data.y}) ${data.button || ''}`
            : row.event_type === 'keydown'
            ? `key:${data.key || ''}`
            : `screenshot:${data.screenshot_id || ''}`,
          screen: null,
          workCategory: null,
          automationScore: null,
          text: null,
          // recorder 고유 메타데이터
          _recorder: {
            clickX: data.x, clickY: data.y,
            button: data.button,
            key: data.key,
            screenshotId: data.screenshot_id,
          },
        };
      }).filter(Boolean);
    } catch (e) {
      if (rdb) try { rdb.close(); } catch {}
      console.warn('[mining] recorder 이벤트 조회 실패:', e.message);
      return [];
    }
  }

  // ── 통합 이벤트 조회 (PG + recorder 병합) ──────────────────────────────────
  async function fetchMergedEvents(db, userId, date, days) {
    const pgEvents = await fetchEvents(db, userId, date, days);
    const recEvents = fetchRecorderEvents(date, days);

    if (!recEvents.length) return pgEvents;

    // 타임스탬프 기준 병합 정렬
    const all = [...pgEvents, ...recEvents];
    all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return all;
  }

  // 사용자 이름 조회 헬퍼
  async function getUserName(db, userId) {
    const { rows } = await db.query(
      'SELECT name FROM orbit_auth_users WHERE id = $1', [userId]
    );
    return rows[0]?.name || userId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/timeline — 사용자 활동 타임라인
  // ?userId=xxx&date=2026-04-10&days=1
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/timeline', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { userId, date, days } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const events = await fetchMergedEvents(db, userId, date, parseInt(days) || 1);
      if (!events.length) return res.json({ sessions: [], message: '해당 기간 데이터 없음' });

      const blocks = buildActivityBlocks(events);
      const sessions = splitSessions(blocks);
      const { transitions, timeByApp } = buildTransitionMatrix(blocks);

      const userName = await getUserName(db, userId);
      const recorderEvents = events.filter(e => RECORDER_TYPES.includes(e.type)).length;

      res.json({
        user: { id: userId, name: userName },
        date: date || new Date().toISOString().substring(0, 10),
        totalEvents: events.length,
        recorderEvents,
        totalBlocks: blocks.length,
        sessions,
        timeByApp,
        topTransitions: transitions.slice(0, 15),
      });
    } catch (e) {
      console.error('[mining/timeline]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/workflows — 업무 흐름 패턴 추출
  // ?userId=xxx&date=2026-04-10&days=7
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/workflows', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { userId, date, days } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const d = parseInt(days) || 7;
      const events = await fetchMergedEvents(db, userId, date, d);
      if (!events.length) return res.json({ patterns: [], message: '데이터 없음' });

      const blocks = buildActivityBlocks(events);
      const patterns = extractPatterns(blocks);
      const { transitions, timeByApp } = buildTransitionMatrix(blocks);

      const userName = await getUserName(db, userId);

      // 프로세스 맵 요약 (가장 빈번한 패턴 해석)
      const processMap = patterns.slice(0, 5).map(p => ({
        flow: p.steps.join(' → '),
        frequency: `${p.count}회 반복`,
        avgTime: `평균 ${p.avgDurationMin}분`,
        interpretation: _interpretFlow(p.steps),
      }));

      res.json({
        user: { id: userId, name: userName },
        period: { start: date || 'last 7 days', days: d },
        totalEvents: events.length,
        patterns,
        processMap,
        transitions: transitions.slice(0, 20),
        timeByApp,
      });
    } catch (e) {
      console.error('[mining/workflows]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/bottlenecks — 병목 감지
  // ?userId=xxx&date=2026-04-10&days=7
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/bottlenecks', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { userId, date, days } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const d = parseInt(days) || 7;
      const events = await fetchMergedEvents(db, userId, date, d);
      if (!events.length) return res.json({ bottlenecks: [], message: '데이터 없음' });

      const blocks = buildActivityBlocks(events);
      const bottlenecks = detectBottlenecks(blocks);

      // 자동화 기회 분석 (automationScore 기반)
      const automationOpportunities = blocks
        .filter(b => b.automationScore != null && b.automationScore >= 0.6)
        .map(b => ({
          app: b.app,
          durationSec: Math.round(b.duration / 1000),
          automationScore: b.automationScore,
          details: b.details,
          startTime: new Date(b.startTs).toISOString(),
        }))
        .sort((a, b) => b.automationScore - a.automationScore)
        .slice(0, 20);

      const userName = await getUserName(db, userId);

      res.json({
        user: { id: userId, name: userName },
        bottlenecks,
        automationOpportunities,
        summary: {
          totalBottlenecks: bottlenecks.length,
          totalAutomatable: automationOpportunities.length,
          estimatedSavingsMin: automationOpportunities.reduce((s, o) => s + o.durationSec, 0) / 60,
        },
      });
    } catch (e) {
      console.error('[mining/bottlenecks]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/compare — 직원 간 비교 분석
  // ?date=2026-04-10&days=7
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/compare', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 활성 사용자 목록
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name
        HAVING count(*) >= 10
      `, [WORK_TYPES, startDate, d]);

      const userProfiles = [];
      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        const { timeByApp } = buildTransitionMatrix(blocks);
        const patterns = extractPatterns(blocks);
        const sessions = splitSessions(blocks);

        const totalWorkMin = timeByApp.reduce((s, t) => s + t.minutes, 0);

        userProfiles.push({
          userId: u.user_id,
          name: u.name || u.user_id,
          totalEvents: events.length,
          totalBlocks: blocks.length,
          totalSessions: sessions.length,
          totalWorkMin,
          timeByApp: timeByApp.slice(0, 5),
          topPatterns: patterns.slice(0, 3).map(p => ({
            flow: p.steps.join(' → '),
            count: p.count,
            avgMin: p.avgDurationMin,
          })),
          avgSessionMin: sessions.length
            ? Math.round(sessions.reduce((s, ses) => s + ses.durationMin, 0) / sessions.length)
            : 0,
        });
      }

      // 앱별 사용 시간 비교
      const allApps = [...new Set(userProfiles.flatMap(p => p.timeByApp.map(t => t.app)))];
      const appComparison = allApps.map(app => ({
        app,
        users: userProfiles
          .map(p => ({
            name: p.name,
            minutes: p.timeByApp.find(t => t.app === app)?.minutes || 0,
          }))
          .filter(u => u.minutes > 0)
          .sort((a, b) => b.minutes - a.minutes),
      })).filter(a => a.users.length >= 2).sort((a, b) => b.users.length - a.users.length);

      // 베스트 프랙티스 (같은 패턴에서 가장 빠른 사용자)
      const patternMap = {};
      for (const p of userProfiles) {
        for (const pat of p.topPatterns) {
          if (!patternMap[pat.flow]) patternMap[pat.flow] = [];
          patternMap[pat.flow].push({ name: p.name, count: pat.count, avgMin: pat.avgMin });
        }
      }
      const bestPractices = Object.entries(patternMap)
        .filter(([, users]) => users.length >= 2)
        .map(([flow, users]) => {
          const sorted = users.sort((a, b) => a.avgMin - b.avgMin);
          return {
            flow,
            fastest: sorted[0],
            slowest: sorted[sorted.length - 1],
            gapMin: sorted[sorted.length - 1].avgMin - sorted[0].avgMin,
          };
        })
        .filter(bp => bp.gapMin > 0)
        .sort((a, b) => b.gapMin - a.gapMin);

      res.json({
        period: { start: startDate, days: d },
        users: userProfiles.sort((a, b) => b.totalWorkMin - a.totalWorkMin),
        appComparison,
        bestPractices,
      });
    } catch (e) {
      console.error('[mining/compare]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/summary — 전체 요약 (관리자 대시보드용)
  // ?date=2026-04-10&days=1
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/summary', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 1;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 전체 이벤트 요약
      const { rows: [stats] } = await db.query(`
        SELECT
          count(*) as total_events,
          count(DISTINCT user_id) as active_users,
          count(*) FILTER (WHERE type = 'screen.analyzed' AND data_json->>'app' != '') as vision_analyzed,
          count(*) FILTER (WHERE type = 'keyboard.chunk') as keyboard_events,
          count(*) FILTER (WHERE type = 'clipboard.change') as clipboard_events,
          count(*) FILTER (WHERE type = 'order.detected') as orders_detected
        FROM events
        WHERE type = ANY($1)
          AND timestamp::date >= $2::date
          AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
      `, [WORK_TYPES, startDate, d]);

      // 사용자별 활동량
      const { rows: userActivity } = await db.query(`
        SELECT e.user_id, u.name, count(*) as events,
          count(DISTINCT type) as event_types,
          min(e.timestamp)::text as first_active,
          max(e.timestamp)::text as last_active
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name
        ORDER BY events DESC
      `, [WORK_TYPES, startDate, d]);

      // 시간대별 활동 히트맵 (한국시간 기준)
      const { rows: hourly } = await db.query(`
        SELECT
          EXTRACT(HOUR FROM (timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as hour,
          count(*) as events
        FROM events
        WHERE type = ANY($1)
          AND timestamp::date >= $2::date
          AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
        GROUP BY 1 ORDER BY 1
      `, [WORK_TYPES, startDate, d]);

      res.json({
        date: startDate,
        days: d,
        stats: {
          totalEvents: parseInt(stats.total_events),
          activeUsers: parseInt(stats.active_users),
          visionAnalyzed: parseInt(stats.vision_analyzed),
          keyboardEvents: parseInt(stats.keyboard_events),
          clipboardEvents: parseInt(stats.clipboard_events),
          ordersDetected: parseInt(stats.orders_detected),
        },
        users: userActivity.map(u => ({
          userId: u.user_id,
          name: u.name || u.user_id,
          events: parseInt(u.events),
          eventTypes: parseInt(u.event_types),
          firstActive: u.first_active,
          lastActive: u.last_active,
        })),
        hourlyHeatmap: hourly.map(h => ({
          hour: parseInt(h.hour),
          events: parseInt(h.events),
        })),
      });
    } catch (e) {
      console.error('[mining/summary]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/decisions — 의사결정 패턴 분석
  // ?date=2026-04-04&days=7
  // 같은 앱에서 나간 후 다른 앱을 선택하는 분기점 감지
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/decisions', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 활성 사용자 데이터 수집
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 20
      `, [WORK_TYPES, startDate, d]);

      // 사용자별 전이 행렬 수집
      const userTransitions = {};
      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        const { transitions } = buildTransitionMatrix(blocks);
        userTransitions[u.name || u.user_id] = transitions;
      }

      // 분기점 감지: 같은 앱에서 나갈 때 사용자마다 다른 선택
      const fromApps = {};
      for (const [userName, transitions] of Object.entries(userTransitions)) {
        for (const t of transitions) {
          if (!fromApps[t.from]) fromApps[t.from] = {};
          if (!fromApps[t.from][t.to]) fromApps[t.from][t.to] = [];
          fromApps[t.from][t.to].push({ user: userName, count: t.count });
        }
      }

      const decisionPoints = [];
      for (const [fromApp, toApps] of Object.entries(fromApps)) {
        const destinations = Object.entries(toApps);
        if (destinations.length < 2) continue; // 분기가 없으면 스킵

        const choices = destinations.map(([toApp, users]) => ({
          nextApp: toApp,
          users: users.sort((a, b) => b.count - a.count),
          totalTransitions: users.reduce((s, u) => s + u.count, 0),
        })).sort((a, b) => b.totalTransitions - a.totalTransitions);

        decisionPoints.push({
          fromApp,
          choiceCount: choices.length,
          choices,
          insight: _interpretDecision(fromApp, choices),
        });
      }

      res.json({
        period: { start: startDate, days: d },
        decisionPoints: decisionPoints.sort((a, b) => b.choiceCount - a.choiceCount),
        userCount: activeUsers.length,
      });
    } catch (e) {
      console.error('[mining/decisions]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/anomalies — 비정상 패턴 감지
  // ?userId=xxx&date=2026-04-10
  // 해당일의 업무 패턴을 이전 7일 평균과 비교
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/anomalies', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { userId, date } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const targetDate = date || new Date().toISOString().substring(0, 10);

      // 이전 7일 기준선 데이터
      const baselineStart = new Date(targetDate);
      baselineStart.setDate(baselineStart.getDate() - 7);
      const baseEvents = await fetchMergedEvents(db, userId, baselineStart.toISOString().substring(0, 10), 7);
      const baseBlocks = buildActivityBlocks(baseEvents);
      const { timeByApp: baseTime } = buildTransitionMatrix(baseBlocks);
      const basePatterns = extractPatterns(baseBlocks);

      // 당일 데이터
      const todayEvents = await fetchMergedEvents(db, userId, targetDate, 1);
      const todayBlocks = buildActivityBlocks(todayEvents);
      const { timeByApp: todayTime } = buildTransitionMatrix(todayBlocks);
      const todayPatterns = extractPatterns(todayBlocks);
      const todaySessions = splitSessions(todayBlocks);

      const userName = await getUserName(db, userId);
      const anomalies = [];

      // 1. 앱별 사용 시간 이상치 (일 평균 대비 ±50%)
      const baseDailyAvg = {};
      for (const t of baseTime) baseDailyAvg[t.app] = Math.round(t.minutes / 7);

      for (const t of todayTime) {
        const avg = baseDailyAvg[t.app] || 0;
        if (avg === 0 && t.minutes >= 5) {
          anomalies.push({
            type: 'new_app',
            severity: 'info',
            app: t.app,
            todayMin: t.minutes,
            avgMin: 0,
            message: `${t.app}을(를) 오늘 처음 사용 (${t.minutes}분)`,
          });
        } else if (avg > 0 && t.minutes > avg * 1.5) {
          anomalies.push({
            type: 'time_spike',
            severity: 'warning',
            app: t.app,
            todayMin: t.minutes,
            avgMin: avg,
            ratio: +(t.minutes / avg).toFixed(1),
            message: `${t.app} 사용 시간 ${+(t.minutes / avg).toFixed(1)}배 증가 (평소 ${avg}분 → 오늘 ${t.minutes}분)`,
          });
        } else if (avg > 5 && t.minutes < avg * 0.3) {
          anomalies.push({
            type: 'time_drop',
            severity: 'info',
            app: t.app,
            todayMin: t.minutes,
            avgMin: avg,
            message: `${t.app} 사용 급감 (평소 ${avg}분 → 오늘 ${t.minutes}분)`,
          });
        }
      }

      // 2. 평소 사용하는 앱을 오늘 안 사용
      for (const [app, avg] of Object.entries(baseDailyAvg)) {
        if (avg >= 5 && !todayTime.find(t => t.app === app)) {
          anomalies.push({
            type: 'missing_app',
            severity: 'warning',
            app,
            avgMin: avg,
            message: `${app} 미사용 (평소 일 평균 ${avg}분)`,
          });
        }
      }

      // 3. 세션 길이 이상치
      if (todaySessions.length > 0) {
        const avgSessionMin = baseBlocks.length > 0
          ? Math.round(splitSessions(baseBlocks).reduce((s, ses) => s + ses.durationMin, 0) / Math.max(splitSessions(baseBlocks).length, 1))
          : 0;
        for (const ses of todaySessions) {
          if (avgSessionMin > 0 && ses.durationMin > avgSessionMin * 3) {
            anomalies.push({
              type: 'long_session',
              severity: 'warning',
              sessionStart: ses.startTime,
              durationMin: ses.durationMin,
              avgSessionMin,
              apps: ses.apps,
              message: `비정상 긴 세션 ${ses.durationMin}분 (평소 평균 ${avgSessionMin}분)`,
            });
          }
        }
      }

      // 4. 새로운 워크플로우 패턴 (기준선에 없는)
      const basePatternSet = new Set(basePatterns.map(p => p.pattern));
      for (const p of todayPatterns) {
        if (!basePatternSet.has(p.pattern) && p.count >= 2) {
          anomalies.push({
            type: 'new_pattern',
            severity: 'info',
            pattern: p.pattern,
            count: p.count,
            message: `새로운 업무 패턴 감지: ${p.steps.join(' → ')} (${p.count}회)`,
          });
        }
      }

      res.json({
        user: { id: userId, name: userName },
        date: targetDate,
        baselineDays: 7,
        anomalies: anomalies.sort((a, b) => {
          const sev = { warning: 0, info: 1 };
          return (sev[a.severity] ?? 2) - (sev[b.severity] ?? 2);
        }),
        todaySummary: {
          events: todayEvents.length,
          sessions: todaySessions.length,
          timeByApp: todayTime,
        },
        baselineSummary: {
          avgDailyEvents: Math.round(baseEvents.length / 7),
          avgDailyTimeByApp: Object.entries(baseDailyAvg)
            .map(([app, min]) => ({ app, avgMin: min }))
            .sort((a, b) => b.avgMin - a.avgMin),
        },
      });
    } catch (e) {
      console.error('[mining/anomalies]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/mining/report — 종합 리포트 생성 + Google Sheets 저장
  // body: { date?, days? }
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/report', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.body || req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      console.log(`[mining/report] 종합 리포트 생성 시작 (${startDate}, ${d}일)`);

      // 1. 전체 요약 (summary 로직)
      const { rows: [stats] } = await db.query(`
        SELECT count(*) as total, count(DISTINCT user_id) as users,
          count(*) FILTER (WHERE type = 'screen.analyzed' AND data_json->>'app' != '') as vision
        FROM events WHERE type = ANY($1)
          AND timestamp::date >= $2::date AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
      `, [WORK_TYPES, startDate, d]);

      const { rows: hourly } = await db.query(`
        SELECT EXTRACT(HOUR FROM (timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as hour,
          count(*) as events
        FROM events WHERE type = ANY($1)
          AND timestamp::date >= $2::date AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
        GROUP BY 1 ORDER BY 1
      `, [WORK_TYPES, startDate, d]);

      // 2. 활성 사용자 목록
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 10
      `, [WORK_TYPES, startDate, d]);

      // 3. 사용자별 분석 수집 (compare + bottlenecks + decisions)
      const userProfiles = [];
      const allBlocks = [];
      const allPatterns = [];

      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        allBlocks.push(...blocks);
        const { timeByApp } = buildTransitionMatrix(blocks);
        const patterns = extractPatterns(blocks);
        allPatterns.push(...patterns);
        const sessions = splitSessions(blocks);
        const totalWorkMin = timeByApp.reduce((s, t) => s + t.minutes, 0);

        userProfiles.push({
          userId: u.user_id,
          name: u.name || u.user_id,
          totalEvents: events.length,
          totalBlocks: blocks.length,
          totalSessions: sessions.length,
          totalWorkMin,
          avgSessionMin: sessions.length ? Math.round(sessions.reduce((s, ses) => s + ses.durationMin, 0) / sessions.length) : 0,
          timeByApp: timeByApp.slice(0, 5),
          topPatterns: patterns.slice(0, 3).map(p => ({ flow: p.steps.join(' → '), count: p.count, avgMin: p.avgDurationMin })),
        });
      }

      // 4. 전체 패턴 (중복 제거 + 빈도순)
      const patternMap = {};
      for (const p of allPatterns) {
        const key = p.pattern;
        if (!patternMap[key]) patternMap[key] = { ...p, count: 0, totalDuration: 0 };
        patternMap[key].count += p.count;
      }
      const topPatterns = Object.values(patternMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, 15)
        .map(p => ({
          flow: p.steps.join(' → '),
          pattern: p.pattern,
          count: p.count,
          avgDurationMin: p.avgDurationMin,
          interpretation: _interpretFlow(p.steps),
        }));

      // 5. 병목
      const bottlenecks = detectBottlenecks(allBlocks);

      // 6. 자동화 기회
      const automationOpps = allBlocks
        .filter(b => b.automationScore != null && b.automationScore >= 0.6)
        .map(b => ({ app: b.app, durationSec: Math.round(b.duration / 1000), automationScore: b.automationScore, details: b.details }))
        .sort((a, b) => b.automationScore - a.automationScore)
        .slice(0, 20);

      // 7. 의사결정 분기
      const userTransitions = {};
      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        const { transitions } = buildTransitionMatrix(blocks);
        userTransitions[u.name || u.user_id] = transitions;
      }
      const fromApps = {};
      for (const [userName, transitions] of Object.entries(userTransitions)) {
        for (const t of transitions) {
          if (!fromApps[t.from]) fromApps[t.from] = {};
          if (!fromApps[t.from][t.to]) fromApps[t.from][t.to] = [];
          fromApps[t.from][t.to].push({ user: userName, count: t.count });
        }
      }
      const decisionPoints = [];
      for (const [fromApp, toApps] of Object.entries(fromApps)) {
        const destinations = Object.entries(toApps);
        if (destinations.length < 2) continue;
        const choices = destinations.map(([toApp, users]) => ({
          nextApp: toApp, users, totalTransitions: users.reduce((s, u) => s + u.count, 0),
        })).sort((a, b) => b.totalTransitions - a.totalTransitions);
        decisionPoints.push({ fromApp, choiceCount: choices.length, choices, insight: _interpretDecision(fromApp, choices) });
      }

      // 8. 베스트 프랙티스
      const bpMap = {};
      for (const p of userProfiles) {
        for (const pat of p.topPatterns) {
          if (!bpMap[pat.flow]) bpMap[pat.flow] = [];
          bpMap[pat.flow].push({ name: p.name, count: pat.count, avgMin: pat.avgMin });
        }
      }
      const bestPractices = Object.entries(bpMap)
        .filter(([, u]) => u.length >= 2)
        .map(([flow, users]) => {
          const sorted = users.sort((a, b) => a.avgMin - b.avgMin);
          return { flow, fastest: sorted[0], slowest: sorted[sorted.length - 1], gapMin: sorted[sorted.length - 1].avgMin - sorted[0].avgMin };
        })
        .filter(bp => bp.gapMin > 0)
        .sort((a, b) => b.gapMin - a.gapMin);

      // 9. 텍스트 리포트 생성
      const textReport = _generateTextReport({
        period: `${startDate} ~ ${d}일`, stats, userProfiles, topPatterns, bottlenecks, decisionPoints, bestPractices,
      });

      // 10. Google Sheets 저장
      let sheetsUrl = null;
      if (reportSheet?.writeMiningReport) {
        sheetsUrl = await reportSheet.writeMiningReport({
          period: `${startDate} ~ ${d}일`,
          activeUsers: parseInt(stats.users),
          totalEvents: parseInt(stats.total),
          visionAnalyzed: parseInt(stats.vision),
          hourlyHeatmap: hourly.map(h => ({ hour: parseInt(h.hour), events: parseInt(h.events) })),
          patterns: topPatterns,
          bottlenecks,
          automationOpportunities: automationOpps,
          users: userProfiles.sort((a, b) => b.totalWorkMin - a.totalWorkMin),
          bestPractices,
          decisionPoints: decisionPoints.sort((a, b) => b.choiceCount - a.choiceCount),
          anomalies: [], // 개별 사용자별 anomalies는 별도 호출
        });
      }

      console.log(`[mining/report] 완료 — ${activeUsers.length}명, ${topPatterns.length} 패턴, sheets=${!!sheetsUrl}`);

      res.json({
        ok: true,
        sheetsUrl,
        textReport,
        summary: {
          period: `${startDate} ~ ${d}일`,
          activeUsers: activeUsers.length,
          totalEvents: parseInt(stats.total),
          patterns: topPatterns.length,
          bottlenecks: bottlenecks.length,
          decisionPoints: decisionPoints.length,
        },
      });
    } catch (e) {
      console.error('[mining/report]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/full-map — 전체 업무 지도 (직원+거래처+카톡방+전산화면+앱)
  // ?date=2026-04-01&days=14
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/full-map', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 1. 직원 목록
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 5
      `, [WORK_TYPES, startDate, d]);

      const nodes = [];   // { id, type, label, group?, color?, size? }
      const links = [];   // { source, target, value, label? }
      const nodeSet = new Set();

      function addNode(id, type, label, extra) {
        if (nodeSet.has(id)) return;
        nodeSet.add(id);
        nodes.push({ id, type, label, ...extra });
      }

      // 2. 사용자별 세부 데이터 수집
      for (const u of activeUsers) {
        const userId = u.user_id;
        const userName = u.name || userId;
        addNode(`user:${userId}`, 'user', userName, { group: 'user' });

        // 이벤트 조회 (windowTitle 포함)
        const { rows: events } = await db.query(`
          SELECT type, timestamp,
            COALESCE(data_json->>'app', data_json->>'sourceApp', '') as app,
            data_json->>'windowTitle' as wt,
            LEFT(data_json->>'text', 200) as text,
            data_json->>'activity' as activity,
            data_json->>'screen' as screen
          FROM events
          WHERE user_id = $1 AND type = ANY($2)
            AND timestamp::date >= $3::date
            AND timestamp::date < ($3::date + $4 * INTERVAL '1 day')
          ORDER BY timestamp ASC
        `, [userId, WORK_TYPES, startDate, d]);

        // 앱별 사용 시간 + windowTitle 세부 추출
        const appTime = {};
        const kakaoRooms = {};   // 카톡방명 → 건수
        const nenovaScreens = {}; // nenova 화면 → 건수
        const excelFiles = {};   // 엑셀 파일명 → 건수
        const customers = {};    // 거래처명 → 건수

        for (const ev of events) {
          const rawApp = ev.app || '';
          const app = normalizeApp(rawApp, ev.wt);
          if (app === 'unknown') continue;
          appTime[app] = (appTime[app] || 0) + 1;

          const wt = ev.wt || '';
          const text = ev.text || '';

          // 카카오톡: 방 이름 추출
          if (app === 'KakaoTalk' && wt) {
            const room = _extractKakaoRoom(wt);
            if (room) kakaoRooms[room] = (kakaoRooms[room] || 0) + 1;
            // 텍스트에서 거래처명 추출
            const custs = _extractCustomers(text + ' ' + wt);
            for (const c of custs) customers[c] = (customers[c] || 0) + 1;
          }

          // Nenova: 화면명 추출
          if (app === 'Nenova ERP' && wt) {
            const screen = _extractNenovaScreen(wt);
            if (screen) nenovaScreens[screen] = (nenovaScreens[screen] || 0) + 1;
          }

          // Excel: 파일명 추출
          if (app === 'Excel' && wt) {
            const file = _extractExcelFile(wt);
            if (file) excelFiles[file] = (excelFiles[file] || 0) + 1;
          }

          // 주문/발주감지에서 거래처
          if ((ev.type === 'order.detected' || ev.type === 'purchase.order.detected') && text) {
            const custs = _extractCustomers(text);
            for (const c of custs) customers[c] = (customers[c] || 0) + 1;
          }
        }

        // 앱 노드 + 사용자→앱 링크
        for (const [app, count] of Object.entries(appTime)) {
          addNode(`app:${app}`, 'app', app, { group: 'app' });
          links.push({ source: `user:${userId}`, target: `app:${app}`, value: count, label: `${count}건` });
        }

        // 카톡방 노드
        for (const [room, count] of Object.entries(kakaoRooms)) {
          if (count < 2) continue;
          addNode(`kakao:${room}`, 'kakao', room, { group: 'kakao' });
          links.push({ source: `app:KakaoTalk`, target: `kakao:${room}`, value: count });
        }

        // Nenova 화면 노드
        for (const [screen, count] of Object.entries(nenovaScreens)) {
          if (count < 2) continue;
          addNode(`nenova:${screen}`, 'nenova_screen', screen, { group: 'nenova' });
          links.push({ source: `app:Nenova ERP`, target: `nenova:${screen}`, value: count });
        }

        // Excel 파일 노드
        for (const [file, count] of Object.entries(excelFiles)) {
          if (count < 2) continue;
          addNode(`excel:${file}`, 'excel_file', file, { group: 'excel' });
          links.push({ source: `app:Excel`, target: `excel:${file}`, value: count });
        }

        // 거래처 노드
        for (const [cust, count] of Object.entries(customers)) {
          if (count < 2) continue;
          addNode(`cust:${cust}`, 'customer', cust, { group: 'customer' });
          // 거래처는 카카오/주문감지에서 발견
          if (appTime['KakaoTalk']) links.push({ source: `kakao:${Object.keys(kakaoRooms)[0] || 'KakaoTalk'}`, target: `cust:${cust}`, value: count });
        }
      }

      // 3. 앱간 전이
      for (const u of activeUsers) {
        const ev2 = await fetchEvents(db, u.user_id, startDate, d);
        const bl = buildActivityBlocks(ev2);
        const { transitions } = buildTransitionMatrix(bl);
        for (const t of transitions) {
          if (t.count >= 2) links.push({ source: `app:${t.from}`, target: `app:${t.to}`, value: t.count, type: 'transition' });
        }
      }

      // ── B. nenova 전산 데이터 (자체 API 내부 호출) ─────────────────────
      try {
        const baseUrl = `http://localhost:${process.env.PORT || 4747}`;

        // B-1. 최근 주문 → 거래처 + 상품 노드
        const orderData = await _internalGet(`${baseUrl}/api/nenova/orders?limit=300`);
        if (orderData?.items) {
          const custOrders = {};
          addNode('nenova:주문관리', 'nenova_screen', '주문관리', { group: 'nenova' });
          for (const o of orderData.items) {
            const cn = o.CustName || o.CustomerName || '';
            if (!cn) continue;
            const custId = `cust:${cn}`;
            addNode(custId, 'customer', cn, { group: 'customer' });
            custOrders[custId] = (custOrders[custId] || 0) + 1;
          }
          for (const [custId, count] of Object.entries(custOrders)) {
            links.push({ source: custId, target: 'nenova:주문관리', value: count, type: 'order' });
          }
        }

        // B-1b. 주문 상세 → 상품(꽃) 추출
        const dashData = await _internalGet(`${baseUrl}/api/nenova/dashboard`);
        if (dashData?.byFlower) {
          addNode('nenova:주문관리', 'nenova_screen', '주문관리', { group: 'nenova' });
          for (const f of dashData.byFlower.slice(0, 12)) {
            const name = f.flower || f.Flower || '';
            if (!name) continue;
            addNode(`product:${name}`, 'product', name, { group: 'product', total: f.total });
            links.push({ source: 'nenova:주문관리', target: `product:${name}`, value: Math.round(f.total || 1), type: 'product' });
          }
        }

        // B-2. 최근 출하 → 거래처↔출고 연결
        const shipData = await _internalGet(`${baseUrl}/api/nenova/shipments?limit=200`);
        if (shipData?.items) {
          const custShips = {};
          for (const s of shipData.items) {
            const cn = s.CustName || s.CustomerName || '';
            if (!cn) continue;
            const custId = `cust:${cn}`;
            addNode(custId, 'customer', cn, { group: 'customer' });
            addNode('nenova:출고', 'nenova_screen', '출고', { group: 'nenova' });
            custShips[custId] = (custShips[custId] || 0) + 1;
          }
          for (const [custId, count] of Object.entries(custShips)) {
            links.push({ source: 'nenova:출고', target: custId, value: count, type: 'shipment' });
          }
        }

        // Nenova ERP앱 ↔ 전산화면 연결
        if (nodeSet.has('app:Nenova ERP')) {
          for (const n of nodes) {
            if (n.type === 'nenova_screen') {
              links.push({ source: 'app:Nenova ERP', target: n.id, value: 5, type: 'contains' });
            }
          }
        }
      } catch (ne) {
        console.warn('[full-map] nenova 데이터:', ne.message);
      }

      // ── C. 중복 link 병합 ─────────────────────────────────────────────
      const linkMap = {};
      for (const l of links) {
        const key = `${l.source}→${l.target}`;
        if (!linkMap[key]) linkMap[key] = { ...l };
        else linkMap[key].value += l.value;
      }

      res.json({
        nodes,
        links: Object.values(linkMap).sort((a, b) => b.value - a.value),
        stats: {
          users: activeUsers.length, nodeCount: nodes.length, linkCount: Object.keys(linkMap).length,
          sources: { orbit: true, nenova: nodes.some(n => n.type === 'customer'), kakao: nodeSet.has('app:KakaoTalk') },
        },
      });
    } catch (e) {
      console.error('[mining/full-map]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/mining/deep-analyze — AI 기반 의사결정 심층 분석
  // body: { date?, days?, userId? }
  // Claude를 사용해 "왜 이렇게 했는가", "대안은 무엇인가" 분석
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/deep-analyze', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days, userId } = req.body || {};
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 1. 대상 사용자 결정
      let targetUsers;
      if (userId) {
        const name = await getUserName(db, userId);
        targetUsers = [{ user_id: userId, name }];
      } else {
        const { rows } = await db.query(`
          SELECT DISTINCT e.user_id, u.name
          FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
          WHERE e.type = ANY($1)
            AND e.timestamp::date >= $2::date
            AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
            AND e.user_id IS NOT NULL AND e.user_id != 'local'
          GROUP BY e.user_id, u.name HAVING count(*) >= 20
        `, [WORK_TYPES, startDate, d]);
        targetUsers = rows;
      }

      if (!targetUsers.length) return res.json({ insights: [], message: '분석할 데이터 부족' });

      // 2. 사용자별 패턴 수집
      const userAnalyses = [];
      for (const u of targetUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        if (events.length < 10) continue;
        const blocks = buildActivityBlocks(events);
        const { transitions, timeByApp } = buildTransitionMatrix(blocks);
        const patterns = extractPatterns(blocks);
        const sessions = splitSessions(blocks);
        const bottlenecks = detectBottlenecks(blocks);

        userAnalyses.push({
          userId: u.user_id,
          name: u.name || u.user_id,
          totalEvents: events.length,
          totalWorkMin: timeByApp.reduce((s, t) => s + t.minutes, 0),
          timeByApp: timeByApp.slice(0, 8),
          topPatterns: patterns.slice(0, 5).map(p => ({
            flow: p.steps.join(' → '), count: p.count, avgMin: p.avgDurationMin,
          })),
          topTransitions: transitions.slice(0, 10),
          sessionCount: sessions.length,
          avgSessionMin: sessions.length ? Math.round(sessions.reduce((s, ses) => s + ses.durationMin, 0) / sessions.length) : 0,
          bottlenecks: bottlenecks.slice(0, 3),
        });
      }

      // 3. 의사결정 분기 데이터 수집
      const userTransitions = {};
      for (const ua of userAnalyses) {
        userTransitions[ua.name] = ua.topTransitions;
      }
      const decisionData = _extractDecisionData(userTransitions);

      // 4. Claude AI 분석 호출
      const analysisPrompt = _buildDeepAnalysisPrompt(userAnalyses, decisionData, { startDate, days: d });
      const aiInsights = await _callClaudeAnalysis(analysisPrompt);

      // 5. 결과를 DB에 저장 (rag_documents로)
      const reportId = `mining-deep-${Date.now()}`;
      try {
        await db.query(`
          INSERT INTO rag_documents (id, title, content, source, metadata_json)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO UPDATE SET content = $3, metadata_json = $5
        `, [
          reportId,
          `프로세스 마이닝 심층분석 ${startDate}`,
          aiInsights.fullText || JSON.stringify(aiInsights),
          'process-mining',
          JSON.stringify({ type: 'deep-analysis', date: startDate, days: d, generatedAt: new Date().toISOString() }),
        ]);
      } catch (e) { console.warn('[mining/deep-analyze] DB 저장 실패:', e.message); }

      res.json({
        ok: true,
        reportId,
        period: { start: startDate, days: d },
        userCount: userAnalyses.length,
        insights: aiInsights,
        rawData: {
          users: userAnalyses.map(u => ({ name: u.name, workMin: u.totalWorkMin, events: u.totalEvents })),
          decisionPoints: decisionData.slice(0, 10),
        },
      });
    } catch (e) {
      console.error('[mining/deep-analyze]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/infographic — 인포그래픽 시각화용 구조화 데이터
  // ?date=2026-04-10&days=7
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/infographic', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 활성 사용자
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 10
      `, [WORK_TYPES, startDate, d]);

      // 사용자별 데이터 수집
      const userData = [];
      const allBlocks = [];
      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        allBlocks.push(...blocks);
        const { timeByApp } = buildTransitionMatrix(blocks);
        const totalMin = timeByApp.reduce((s, t) => s + t.minutes, 0);
        userData.push({
          name: u.name || u.user_id,
          userId: u.user_id,
          totalMin,
          apps: timeByApp.map(t => ({ name: t.app, minutes: t.minutes, pct: totalMin ? Math.round(t.minutes / totalMin * 100) : 0 })),
        });
      }

      // 시간대별 히트맵
      const { rows: hourly } = await db.query(`
        SELECT
          EXTRACT(HOUR FROM (timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as hour,
          count(*) as events,
          count(DISTINCT user_id) as users
        FROM events
        WHERE type = ANY($1)
          AND timestamp::date >= $2::date
          AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
        GROUP BY 1 ORDER BY 1
      `, [WORK_TYPES, startDate, d]);

      // 일별 트렌드
      const { rows: daily } = await db.query(`
        SELECT timestamp::date as day, count(*) as events, count(DISTINCT user_id) as users
        FROM events WHERE type = ANY($1)
          AND timestamp::date >= $2::date
          AND timestamp::date < ($2::date + $3 * INTERVAL '1 day')
        GROUP BY 1 ORDER BY 1
      `, [WORK_TYPES, startDate, d]);

      // 앱 사용 비율 (전체 합산)
      const appTotals = {};
      for (const u of userData) {
        for (const a of u.apps) {
          appTotals[a.name] = (appTotals[a.name] || 0) + a.minutes;
        }
      }
      const totalAllMin = Object.values(appTotals).reduce((s, m) => s + m, 0);
      const appDistribution = Object.entries(appTotals)
        .map(([name, minutes]) => ({ name, minutes, pct: totalAllMin ? Math.round(minutes / totalAllMin * 100) : 0 }))
        .sort((a, b) => b.minutes - a.minutes);

      // 프로세스 흐름도 데이터 (Sankey/Flow용)
      const { transitions } = buildTransitionMatrix(allBlocks);
      const flowNodes = [...new Set(transitions.flatMap(t => [t.from, t.to]))];
      const flowLinks = transitions.slice(0, 20).map(t => ({
        source: t.from, target: t.to, value: t.count,
      }));

      // 자동화 ROI
      const autoBlocks = allBlocks.filter(b => b.automationScore != null && b.automationScore >= 0.6);
      const autoSavingsMinPerDay = autoBlocks.reduce((s, b) => s + b.duration, 0) / 60000 / Math.max(d, 1);
      const autoSavingsMonthly = Math.round(autoSavingsMinPerDay * 22); // 월 22 근무일
      const autoSavingsYearly = autoSavingsMonthly * 12;
      const hourlyWage = 15000; // 시급 기준 (원)
      const roiMonthly = Math.round(autoSavingsMonthly / 60 * hourlyWage);
      const roiYearly = roiMonthly * 12;

      res.json({
        period: { start: startDate, days: d },
        charts: {
          // 파이차트: 앱 사용 분포
          appDistribution,
          // 바차트: 직원별 총 업무 시간
          userWorktime: userData.map(u => ({ name: u.name, minutes: u.totalMin })).sort((a, b) => b.minutes - a.minutes),
          // 히트맵: 시간대별 활동량
          hourlyHeatmap: hourly.map(h => ({ hour: parseInt(h.hour), events: parseInt(h.events), users: parseInt(h.users) })),
          // 라인차트: 일별 트렌드
          dailyTrend: daily.map(d => ({ date: d.day, events: parseInt(d.events), users: parseInt(d.users) })),
          // Sankey/Flow: 앱 전환 흐름도
          processFlow: { nodes: flowNodes, links: flowLinks },
          // 스택바: 직원별 앱 사용 분포
          userAppBreakdown: userData.map(u => ({
            name: u.name,
            apps: u.apps.slice(0, 6),
          })),
        },
        roi: {
          autoSavingsMinPerDay: Math.round(autoSavingsMinPerDay),
          autoSavingsHoursMonthly: Math.round(autoSavingsMonthly / 60),
          roiMonthlyKRW: roiMonthly,
          roiYearlyKRW: roiYearly,
          roiYearlyFormatted: `${Math.round(roiYearly / 10000)}만원`,
          automatableBlockCount: autoBlocks.length,
        },
      });
    } catch (e) {
      console.error('[mining/infographic]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/mining/migrate-vision — Vision raw 데이터 마이그레이션
  // GET /api/mining/kakao-debug — 카톡 시트 연결 디버그 (?keyonly=1 for key info only)
  router.get('/kakao-debug', async (req, res) => {
    if (req.query.rawdebug) {
      try {
        _cachedCred = null; // 캐시 무효화
        const cfg = await _internalGet(`http://localhost:${process.env.PORT || 4747}/api/daemon/drive-config`);
        const raw = cfg?.credentialsJson || '';
        const pkMatch = raw.match(/"private_key"\s*:\s*"([^"]*)"/);
        const pkVal = pkMatch ? pkMatch[1] : '(no match)';
        return res.json({
          rawFirst80: raw.substring(0, 80),
          pkValFirst60: pkVal.substring(0, 60),
          pkValCharCodes: [...pkVal.substring(0, 20)].map(c => c.charCodeAt(0)),
          rawLen: raw.length,
        });
      } catch (e) { return res.json({ error: e.message }); }
    }
    if (req.query.keyonly) {
      try {
        _cachedCred = null; // 캐시 무효화하여 항상 재파싱
        const cred = await _parseServiceAccountJson();
        const pk = cred.private_key || '';
        return res.json({
          email: cred.client_email, type: cred.type,
          pkLen: pk.length, hasBegin: pk.startsWith('-----BEGIN'), hasEnd: pk.includes('-----END'),
          nlCount: (pk.match(/\n/g) || []).length,
          bsNlCount: (pk.match(/\\\n/g) || []).length,
          pkFirst50: pk.substring(0, 50), pkLast30: pk.substring(pk.length - 30),
          charCodes: [...pk.substring(0, 30)].map(c => c.charCodeAt(0)),
        });
      } catch (e) { return res.json({ error: e.message }); }
    }
    try {
      const https = require('https');
      const crypto = require('crypto');
      const SHEET_ID = '1pXLVZqiMwWt6Vh0IhWwASBvgLtZqLnbHXMWqOLNwAXU';

      let cred;
      try { cred = await _parseServiceAccountJson(); } catch (e) { return res.json({ error: e.message }); }
      if (!cred?.private_key) return res.json({ error: 'no private_key' });
      // Debug: key info
      const pkStart = cred.private_key.substring(0, 40);
      const pkEnd = cred.private_key.substring(cred.private_key.length - 40);
      const pkLen = cred.private_key.length;
      const hasBegin = cred.private_key.includes('-----BEGIN');
      const hasEnd = cred.private_key.includes('-----END');
      const nlCount = (cred.private_key.match(/\n/g) || []).length;

      // Token
      const now = Math.floor(Date.now() / 1000);
      const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({alg:'RS256',typ:'JWT'})}.${b64({iss:cred.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
      const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
      const jwt = `${unsigned}.${sign.sign(cred.private_key,'base64url')}`;
      const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

      const token = await new Promise((resolve) => {
        const req = https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}}, r => {
          let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve({error:d.substring(0,200)})}});
        }); req.on('error',e=>resolve({error:e.message})); req.write(body); req.end();
      });

      if (!token.access_token) return res.json({ step: 'token', result: token });

      // Sheet meta
      const meta = await new Promise((resolve) => {
        https.get({hostname:'sheets.googleapis.com',path:`/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,headers:{Authorization:`Bearer ${token.access_token}`}}, r => {
          let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve({raw:d.substring(0,500)})}});
        }).on('error',e=>resolve({error:e.message}));
      });

      const tabs = (meta.sheets || []).map(s => s.properties?.title);

      // Try reading first tab
      let sample = null;
      if (tabs.length) {
        const range = encodeURIComponent(`${tabs[0]}!A1:E5`);
        sample = await new Promise((resolve) => {
          https.get({hostname:'sheets.googleapis.com',path:`/v4/spreadsheets/${SHEET_ID}/values/${range}`,headers:{Authorization:`Bearer ${token.access_token}`}}, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve({raw:d.substring(0,500)})}});
          }).on('error',e=>resolve({error:e.message}));
        });
      }

      res.json({ ok: true, email: cred.client_email, tabs, tabCount: tabs.length, meta: meta.error || null, sample, keyDebug: { pkStart, pkEnd, pkLen, hasBegin, hasEnd, nlCount } });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // 기존 screen.analyzed raw JSON 문자열 재파싱
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/migrate-vision', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      // 1. raw 필드에 JSON 문자열이 있는 레코드 조회
      const { rows: rawRecords } = await db.query(`
        SELECT id, data_json
        FROM events
        WHERE type = 'screen.analyzed'
          AND data_json->>'raw' IS NOT NULL
          AND data_json->>'raw' != ''
          AND (data_json->>'app' IS NULL OR data_json->>'app' = '')
        LIMIT 200
      `);

      let fixed = 0, failed = 0;
      const results = [];

      for (const row of rawRecords) {
        const rawText = row.data_json.raw;
        if (!rawText || rawText.length < 10) { failed++; continue; }

        // _parseResult 로직과 동일한 파싱 시도
        let parsed = null;

        // Strategy 1: ```json 코드블록
        const codeBlock = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlock) {
          try { parsed = JSON.parse(codeBlock[1].trim()); } catch {}
        }

        // Strategy 2: 가장 바깥 { ... }
        if (!parsed) {
          const m = rawText.match(/\{[\s\S]*\}/);
          if (m) {
            const cleaned = m[0]
              .replace(/:\s*true\/false/g, ': true')
              .replace(/:\s*(\d+\.?\d*)~(\d+\.?\d*)/g, ': $1')
              .replace(/,\s*([}\]])/g, '$1')
              .replace(/\/\/[^\n]*/g, '')
              .replace(/\/\*[\s\S]*?\*\//g, '');
            try { parsed = JSON.parse(cleaned); } catch {}
            if (!parsed) try { parsed = JSON.parse(m[0]); } catch {}
          }
        }

        // Strategy 3: 전체 텍스트
        if (!parsed) try { parsed = JSON.parse(rawText.trim()); } catch {}

        if (parsed && (parsed.app || parsed.activity || parsed.screen)) {
          // 기존 metadata 보존하면서 파싱된 데이터 병합
          const newData = {
            ...row.data_json,
            ...parsed,
            raw: undefined, // raw 제거
            _migratedAt: new Date().toISOString(),
          };
          delete newData.raw;

          await db.query(
            'UPDATE events SET data_json = $1 WHERE id = $2',
            [JSON.stringify(newData), row.id]
          );
          fixed++;
          results.push({ id: row.id, app: parsed.app, activity: parsed.activity?.substring(0, 50) });
        } else {
          failed++;
        }
      }

      // 2. 완전히 빈 screen.analyzed 카운트
      const { rows: [emptyCount] } = await db.query(`
        SELECT COUNT(*) as cnt FROM events
        WHERE type = 'screen.analyzed'
          AND (data_json->>'app' IS NULL OR data_json->>'app' = '')
          AND (data_json->>'raw' IS NULL OR data_json->>'raw' = '')
      `);

      res.json({
        ok: true,
        migration: { found: rawRecords.length, fixed, failed },
        emptyRecords: parseInt(emptyCount.cnt),
        fixedSamples: results.slice(0, 10),
        message: `${fixed}건 재파싱 완료, ${failed}건 파싱 실패, ${emptyCount.cnt}건 빈 데이터 남음`,
      });
    } catch (e) {
      console.error('[mining/migrate-vision]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/automation-blueprint — 자동화 블루프린트
  // ?date=2026-04-10&days=7
  // "기계가 대체한다면 이런 식으로 해야겠구나" — 구체적 자동화 설계
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/automation-blueprint', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);

      // 사용자 데이터 수집
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date
          AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 20
      `, [WORK_TYPES, startDate, d]);

      const allBlocks = [];
      const allPatterns = [];
      for (const u of activeUsers) {
        const events = await fetchEvents(db, u.user_id, startDate, d);
        const blocks = buildActivityBlocks(events);
        allBlocks.push(...blocks);
        allPatterns.push(...extractPatterns(blocks));
      }

      // 반복 패턴 → 자동화 후보
      const patternMap = {};
      for (const p of allPatterns) {
        if (!patternMap[p.pattern]) patternMap[p.pattern] = { ...p, count: 0, totalDuration: 0 };
        patternMap[p.pattern].count += p.count;
        patternMap[p.pattern].totalDuration += p.avgDurationMin * p.count;
      }

      const automationCandidates = Object.values(patternMap)
        .filter(p => p.count >= 3)
        .sort((a, b) => b.totalDuration - a.totalDuration)
        .slice(0, 15)
        .map(p => {
          const steps = p.steps || p.pattern.split('→');
          const blueprint = _designAutomation(steps, p);
          return {
            pattern: p.pattern,
            flow: steps.join(' → '),
            frequency: p.count,
            totalTimeMin: Math.round(p.totalDuration / p.count) * p.count,
            avgTimeMin: Math.round(p.totalDuration / p.count),
            ...blueprint,
          };
        });

      // ROI 계산
      const totalSavableMin = automationCandidates
        .filter(c => c.automationFeasibility >= 0.5)
        .reduce((s, c) => s + c.savingsPerMonth, 0);
      const hourlyWage = 15000;

      res.json({
        period: { start: startDate, days: d },
        candidates: automationCandidates,
        roi: {
          totalSavableMinPerMonth: totalSavableMin,
          totalSavableHoursPerMonth: Math.round(totalSavableMin / 60),
          monthlySavingsKRW: Math.round(totalSavableMin / 60 * hourlyWage),
          yearlySavingsKRW: Math.round(totalSavableMin / 60 * hourlyWage * 12),
          yearlySavingsFormatted: `${Math.round(totalSavableMin / 60 * hourlyWage * 12 / 10000)}만원`,
        },
        implementationPlan: automationCandidates
          .filter(c => c.automationFeasibility >= 0.5)
          .sort((a, b) => b.savingsPerMonth - a.savingsPerMonth)
          .slice(0, 5)
          .map((c, i) => ({
            priority: i + 1,
            flow: c.flow,
            method: c.automationMethod,
            difficulty: c.difficulty,
            savingsPerMonth: `${c.savingsPerMonth}분`,
            steps: c.implementationSteps,
          })),
      });
    } catch (e) {
      console.error('[mining/automation-blueprint]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/cross-analysis — 교차 분석 엔진
  // 카톡 ↔ nenova 주문 ↔ 직원 활동을 시간축으로 엮어서
  // 의사결정 경로, 병목, 베스트프랙티스 추출
  // ═══════════════════════════════════════════════════════════════════════════
  router.get('/cross-analysis', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const { date, days } = req.query;
      const d = parseInt(days) || 7;
      const startDate = date || new Date().toISOString().substring(0, 10);
      const baseUrl = `http://localhost:${process.env.PORT || 4747}`;

      // ── 0. 카톡 분석 데이터 (Google Sheets) ─────────────────────
      let kakaoEvents = [];
      try {
        kakaoEvents = await _fetchKakaoSheetData();
        console.log(`[cross-analysis] 카톡 시트 데이터: ${kakaoEvents.length}건`);
      } catch (e) { console.warn('[cross-analysis] 카톡 시트 읽기 실패:', e.message); }

      // 1. 직원별 활동 시퀀스
      const { rows: activeUsers } = await db.query(`
        SELECT DISTINCT e.user_id, u.name
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = ANY($1)
          AND e.timestamp::date >= $2::date AND e.timestamp::date < ($2::date + $3 * INTERVAL '1 day')
          AND e.user_id IS NOT NULL AND e.user_id != 'local'
        GROUP BY e.user_id, u.name HAVING count(*) >= 20
      `, [WORK_TYPES, startDate, d]);

      const userTimelines = {};
      for (const u of activeUsers) {
        const { rows } = await db.query(`
          SELECT type, timestamp,
            COALESCE(data_json->>'app', data_json->>'sourceApp', '') as app,
            data_json->>'windowTitle' as wt,
            LEFT(data_json->>'text', 300) as text
          FROM events WHERE user_id = $1 AND type = ANY($2)
            AND timestamp::date >= $3::date AND timestamp::date < ($3::date + $4 * INTERVAL '1 day')
          ORDER BY timestamp ASC
        `, [u.user_id, WORK_TYPES, startDate, d]);
        userTimelines[u.name || u.user_id] = rows.map(ev => ({
          ts: new Date(ev.timestamp).getTime(), time: ev.timestamp,
          app: normalizeApp(ev.app || '', ev.wt), wt: ev.wt || '', text: ev.text || '', type: ev.type,
        }));
      }

      // 2. 업무 사이클 추출 (카톡→앱전환→작업→완료)
      const workCycles = {};
      for (const [userName, timeline] of Object.entries(userTimelines)) {
        const cycles = [];
        let cur = null;
        for (let i = 0; i < timeline.length; i++) {
          const ev = timeline[i];
          if (ev.app === 'KakaoTalk' && _isWorkRelated(ev.text, ev.wt)) {
            if (cur && cur.steps.length > 1) { cur.durationSec = Math.round((cur.endTs - cur.startTs) / 1000); cycles.push(cur); }
            cur = { trigger: { wt: ev.wt, text: ev.text.substring(0, 80) }, startTs: ev.ts, endTs: ev.ts, steps: [{ app: ev.app, wt: ev.wt, ts: ev.ts }], apps: new Set(['KakaoTalk']) };
          } else if (cur) {
            if (ev.app !== 'unknown') {
              const last = cur.steps[cur.steps.length - 1];
              if (ev.app !== last.app || ev.ts - last.ts > 60000) { cur.steps.push({ app: ev.app, wt: ev.wt, ts: ev.ts }); cur.apps.add(ev.app); }
              cur.endTs = ev.ts;
            }
            if (i + 1 < timeline.length && timeline[i + 1].ts - ev.ts > 300000) { cur.durationSec = Math.round((cur.endTs - cur.startTs) / 1000); if (cur.steps.length > 1) cycles.push(cur); cur = null; }
          }
        }
        if (cur && cur.steps.length > 1) { cur.durationSec = Math.round((cur.endTs - cur.startTs) / 1000); cycles.push(cur); }
        workCycles[userName] = cycles.map(c => ({ ...c, apps: [...c.apps], route: c.steps.map(s => s.app).filter((v, i, a) => i === 0 || v !== a[i - 1]).join(' → '), stepCount: c.steps.length }));
      }

      // 3. 같은 업무 다른 경로 비교
      const routeMap = {};
      for (const [userName, cycles] of Object.entries(workCycles)) {
        for (const c of cycles) {
          const key = [...c.apps].sort().join('+');
          if (!routeMap[key]) routeMap[key] = [];
          routeMap[key].push({ user: userName, ...c });
        }
      }
      const comparisons = [];
      for (const [routeKey, cycles] of Object.entries(routeMap)) {
        const userCycles = {};
        for (const c of cycles) { if (!userCycles[c.user]) userCycles[c.user] = []; userCycles[c.user].push(c); }
        if (Object.keys(userCycles).length < 2) continue;
        const stats = Object.entries(userCycles).map(([user, cs]) => ({
          user, count: cs.length,
          avgSec: Math.round(cs.reduce((s, c) => s + c.durationSec, 0) / cs.length),
          commonRoute: _mostCommon(cs.map(c => c.route)),
          avgSteps: Math.round(cs.reduce((s, c) => s + c.stepCount, 0) / cs.length),
        })).sort((a, b) => a.avgSec - b.avgSec);
        const gap = stats[stats.length - 1].avgSec - stats[0].avgSec;
        if (gap > 10) comparisons.push({
          apps: routeKey.split('+'), users: stats,
          fastest: stats[0].user, slowest: stats[stats.length - 1].user, gapSec: gap,
          bestPractice: stats[0].commonRoute !== stats[stats.length - 1].commonRoute
            ? `${stats[0].user}의 경로(${stats[0].commonRoute})가 ${stats[0].avgSteps}단계로 더 효율적`
            : `같은 경로, ${stats[0].user}가 ${gap}초 빠름`,
        });
      }

      // 4. 앱 전환 대기 시간 (병목)
      const transDelays = {};
      for (const [userName, tl] of Object.entries(userTimelines)) {
        for (let i = 1; i < tl.length; i++) {
          const p = tl[i - 1], c = tl[i];
          if (p.app === 'unknown' || c.app === 'unknown' || p.app === c.app) continue;
          const sec = (c.ts - p.ts) / 1000;
          if (sec > 300 || sec < 1) continue;
          const key = `${p.app}→${c.app}`;
          if (!transDelays[key]) transDelays[key] = [];
          transDelays[key].push({ user: userName, sec, from: p.wt?.substring(0, 30), to: c.wt?.substring(0, 30) });
        }
      }
      const bottlenecks = Object.entries(transDelays)
        .filter(([, d]) => d.length >= 3)
        .map(([tr, d]) => {
          const sorted = d.map(x => x.sec).sort((a, b) => a - b);
          const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
          return { transition: tr, count: d.length, avgSec: avg, medianSec: Math.round(sorted[Math.floor(sorted.length / 2)]),
            isBottleneck: avg > 30,
            samples: d.sort((a, b) => b.sec - a.sec).slice(0, 3).map(x => ({ user: x.user, sec: Math.round(x.sec), context: `${x.from || ''} → ${x.to || ''}` })),
          };
        }).sort((a, b) => b.avgSec - a.avgSec);

      // 5. 카톡 ↔ nenova 주문 매칭
      let orderMatches = [];
      try {
        const orderData = await _internalGet(`${baseUrl}/api/nenova/orders?limit=100`);
        if (orderData?.items) {
          for (const order of orderData.items.slice(0, 50)) {
            const cn = order.CustName || '';
            if (!cn) continue;
            const oTs = new Date(order.CreateDtm || order.OrderDtm).getTime();
            if (!oTs) continue;
            for (const [userName, tl] of Object.entries(userTimelines)) {
              const mention = tl.find(ev => ev.app === 'KakaoTalk' && (ev.text.includes(cn) || ev.wt.includes(cn)) && Math.abs(ev.ts - oTs) < 1800000);
              if (mention) {
                const startIdx = tl.indexOf(mention);
                const route = [];
                for (let j = startIdx; j < Math.min(startIdx + 20, tl.length); j++) {
                  if (tl[j].ts - mention.ts > 1800000) break;
                  if (!route.length || route[route.length - 1].app !== tl[j].app) route.push({ app: tl[j].app, wt: tl[j].wt?.substring(0, 40) });
                }
                orderMatches.push({ customer: cn, employee: userName, delaySec: Math.round((oTs - mention.ts) / 1000), route: route.map(s => s.app).join(' → ') });
              }
            }
          }
        }
      } catch (e) {}

      // 6. 카톡 시트 데이터 교차 분석
      let kakaoAnalysis = null;
      if (kakaoEvents.length) {
        kakaoAnalysis = _analyzeKakaoEvents(kakaoEvents, orderMatches);
      }

      // 7. 인사이트 (모든 소스 종합)
      const insights = [];
      if (comparisons.length) {
        const top = comparisons.sort((a, b) => b.gapSec - a.gapSec)[0];
        insights.push({ type: 'best_practice', title: `${top.fastest}의 방식 전파 시 건당 ${top.gapSec}초 절감`, detail: top.bestPractice });
      }
      const realBn = bottlenecks.filter(b => b.isBottleneck);
      if (realBn.length) insights.push({ type: 'bottleneck', title: `${realBn[0].transition} 전환에 평균 ${realBn[0].avgSec}초`, detail: `${realBn[0].count}회 발생` });
      if (orderMatches.length) {
        const avg = Math.round(orderMatches.reduce((s, m) => s + Math.abs(m.delaySec), 0) / orderMatches.length);
        insights.push({ type: 'process_time', title: `카톡→전산 평균 ${Math.round(avg / 60)}분`, detail: `${orderMatches.length}건 매칭` });
      }
      if (kakaoAnalysis) {
        if (kakaoAnalysis.orderChanges) insights.push({ type: 'kakao_order', title: `카톡 주문변경 ${kakaoAnalysis.orderChanges}건`, detail: `방: ${kakaoAnalysis.topRooms.join(', ')}` });
        if (kakaoAnalysis.defects) insights.push({ type: 'kakao_defect', title: `불량/클레임 ${kakaoAnalysis.defects}건`, detail: `주요품목: ${kakaoAnalysis.defectProducts.join(', ')}` });
        if (kakaoAnalysis.decisions) insights.push({ type: 'kakao_decision', title: `의사결정 ${kakaoAnalysis.decisions}건`, detail: `미해결: ${kakaoAnalysis.unresolvedDecisions}건` });
        if (kakaoAnalysis.responseAvgMin) insights.push({ type: 'kakao_response', title: `카톡 평균 응답시간 ${kakaoAnalysis.responseAvgMin}분`, detail: `최장: ${kakaoAnalysis.responseMaxMin}분` });
      }

      res.json({
        period: { start: startDate, days: d }, userCount: activeUsers.length,
        dataSources: {
          orbit: { events: Object.values(userTimelines).reduce((s, t) => s + t.length, 0) },
          nenova: { orders: orderMatches.length > 0 },
          kakao: { events: kakaoEvents.length, analysis: !!kakaoAnalysis },
        },
        insights, comparisons: comparisons.slice(0, 10), bottlenecks: bottlenecks.slice(0, 15),
        orderKakaoMatches: orderMatches.slice(0, 30),
        kakaoAnalysis,
        workCycles: Object.fromEntries(Object.entries(workCycles).map(([u, cs]) => [u, { total: cs.length, avgSec: cs.length ? Math.round(cs.reduce((s, c) => s + c.durationSec, 0) / cs.length) : 0, topRoutes: _topN(cs.map(c => c.route), 5) }])),
      });
    } catch (e) {
      console.error('[mining/cross-analysis]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/mining/total-analysis — 카톡+전산+비전 토탈 교차분석
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/total-analysis', async (req, res) => {
    try {
      const db = getDb();
      const baseUrl = `http://localhost:${process.env.PORT || 4747}`;

      // ── 1. Google Sheets 인증 토큰 ──────────────────────────────────────
      let token = null;
      try {
        const cred = await _parseServiceAccountJson();
        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
        const unsigned = `${b64({alg:'RS256',typ:'JWT'})}.${b64({iss:cred.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
        const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
        const jwt = `${unsigned}.${sign.sign(cred.private_key,'base64url')}`;
        const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
        const https = require('https');
        token = await new Promise(resolve => {
          const r2 = https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}}, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d).access_token);}catch{resolve(null);} });
          }); r2.on('error',()=>resolve(null)); r2.write(body); r2.end();
        });
      } catch(e) { console.warn('[total-analysis] 토큰 실패:', e.message); }

      // ── 2. 카톡 시트 7개 탭 전체 읽기 ──────────────────────────────────
      let tabs = {};
      if (token) {
        try { tabs = await _fetchFullKakaoTabs(token); } catch(e) { console.warn('[total-analysis] 시트 오류:', e.message); }
      }

      // ── 3. Nenova + Vision 데이터 병렬 조회 ─────────────────────────────
      const [dashData, orderData, visionData] = await Promise.all([
        _internalGet(`${baseUrl}/api/nenova/dashboard`),
        _internalGet(`${baseUrl}/api/nenova/orders?limit=500`),
        db?.query ? db.query(`
          SELECT data_json->>'app' as app, data_json->>'windowTitle' as wt,
            data_json->>'screen' as screen, count(*)::int as cnt
          FROM events WHERE type='screen.analyzed' AND timestamp > NOW() - INTERVAL '30 days'
          GROUP BY 1,2,3 ORDER BY cnt DESC LIMIT 50
        `).catch(()=>null) : null,
      ]);

      // ── 4. 카톡 데이터 집계 ─────────────────────────────────────────────
      const messages  = tabs['메시지분류']      || [];
      const bizEvents = tabs['비즈니스이벤트']  || [];
      const decisions = tabs['의사결정추적']    || [];
      const rooms     = tabs['방프로파일']       || [];
      const products  = tabs['품목매칭']         || [];
      const customers = tabs['거래처매칭']       || [];
      const patterns  = tabs['패턴라이브러리']   || [];

      // 이벤트타입·방·거래처·품목별 집계
      const eventTypeMap = {}, roomEventMap = {}, custEventMap = {}, prodEventMap = {};
      const defectList = [];
      for (const e of bizEvents) {
        const type = e['이벤트타입'] || '';
        const room = e['방이름'] || '';
        const cust = e['거래처'] || '';
        const prod = e['품목']   || '';
        eventTypeMap[type] = (eventTypeMap[type]||0)+1;
        if (room) roomEventMap[room] = (roomEventMap[room]||0)+1;
        if (cust) custEventMap[cust] = (custEventMap[cust]||0)+1;
        if (prod) prodEventMap[prod] = (prodEventMap[prod]||0)+1;
        if (/불량|클레임|DEFECT|반품|불인정/i.test(type)) defectList.push(e);
      }

      // AI분류·방별 메시지 집계
      const aiTypeMap = {}, roomMsgMap = {};
      for (const m of messages) {
        const ai   = m['AI분류'] || m['분류'] || '';
        const room = m['방이름'] || '';
        if (ai)   aiTypeMap[ai]   = (aiTypeMap[ai]||0)+1;
        if (room) roomMsgMap[room] = (roomMsgMap[room]||0)+1;
      }

      // ── 5. 의사결정 분석 ─────────────────────────────────────────────────
      const unresolvedDec = decisions.filter(d => !d['결과'] || d['결과']==='미해결' || d['결과']==='');
      const resolvedDec   = decisions.filter(d =>  d['결과'] && d['결과']!=='미해결' && d['결과']!=='');
      const decByRoom = {}, unresolvByRoom = {};
      for (const d of decisions) {
        const room = d['발생방'] || '';
        if (room) {
          decByRoom[room] = (decByRoom[room]||0)+1;
          if (!d['결과']||d['결과']==='미해결') unresolvByRoom[room]=(unresolvByRoom[room]||0)+1;
        }
      }
      const resTimes = decisions.map(d=>parseFloat(d['소요시간(분)']||'0')).filter(t=>t>0);
      const avgResTime = resTimes.length ? Math.round(resTimes.reduce((a,b)=>a+b,0)/resTimes.length) : 0;

      // ── 6. 품목 불량 위험도 ──────────────────────────────────────────────
      const defByProd = {};
      for (const d of defectList) { const p=d['품목']||''; if(p) defByProd[p]=(defByProd[p]||0)+1; }
      const productRisk = Object.entries(prodEventMap)
        .filter(([,c])=>c>=3)
        .map(([name,total])=>{
          const pm = products.find(p=>p['카톡품명']===name||p['DB ProdName']===name);
          return { name, total, defects:defByProd[name]||0,
            defectRate:Math.round((defByProd[name]||0)/total*100),
            flower:pm?.['꽃종류']||'', country:pm?.['국가']||'', matched:!!(pm?.['DB ProdKey']) };
        })
        .sort((a,b)=>b.defects-a.defects).slice(0,12);

      // ── 7. 거래처 위험도 매트릭스 ────────────────────────────────────────
      const defByCust = {};
      for (const d of defectList) { const c=d['거래처']||''; if(c) defByCust[c]=(defByCust[c]||0)+1; }
      const customerRisk = Object.entries(custEventMap)
        .filter(([,c])=>c>=2)
        .map(([name,total])=>{
          const cm = customers.find(c=>c['카톡거래처명']===name);
          return { name, total, defects:defByCust[name]||0,
            riskScore:Math.round((defByCust[name]||0)/total*100),
            custKey:cm?.['DB CustKey']||'', group:cm?.['그룹']||'', matched:!!(cm?.['DB CustKey']) };
        })
        .sort((a,b)=>b.total-a.total).slice(0,15);

      // ── 8. 파이프라인 현황 (방프로파일 × 이벤트 × 이슈) ─────────────────
      const pipelineRooms = rooms.map(r=>{
        const nm = r['방이름']||'';
        return {
          name: nm, purpose:r['목적']||'', mainType:r['주요유형']||'',
          keySenders:r['핵심발신자']||'', automation:r['자동화기회']||'',
          msgCount: roomMsgMap[nm]||0, bizEventCount:roomEventMap[nm]||0,
          defectCount: defectList.filter(d=>d['방이름']===nm).length,
          issueCount: decByRoom[nm]||0, unresolvedIssues:unresolvByRoom[nm]||0,
        };
      }).sort((a,b)=>b.bizEventCount-a.bizEventCount);

      // ── 9. Nenova 교차 매칭 ──────────────────────────────────────────────
      const nOrders = orderData?.items || [];
      const nCustNames = nOrders.map(o=>o.CustName||'').filter(Boolean);
      // 카톡 거래처 → 네노바 거래처 fuzzy match
      const kakaoToNenova = customerRisk.map(c=>{
        const match = nCustNames.find(n=>n.includes(c.name)||c.name.includes(n));
        return match ? { kakao:c.name, nenova:match, events:c.total } : null;
      }).filter(Boolean);

      // 차수 공통 집계 (카톡 비즈니스이벤트 차수 vs 네노바 OrderWeek)
      const kakaoWeeks = {};
      for (const e of bizEvents) {
        const w = e['차수']||''; if(w) kakaoWeeks[w]=(kakaoWeeks[w]||0)+1;
      }
      const nenovaWeeks = {};
      for (const o of nOrders) {
        const w = o.OrderWeek||''; if(w) nenovaWeeks[w]=(nenovaWeeks[w]||0)+1;
      }
      const commonWeeks = Object.keys(kakaoWeeks).filter(w=>nenovaWeeks[w]);

      // ── 10. 자동화 기회 ──────────────────────────────────────────────────
      const automationOpps = patterns
        .filter(p=>p['패턴이름'])
        .map(p=>({
          name:p['패턴이름']||'', type:p['분류']||'',
          accuracy:parseFloat(p['정확도']||'0'),
          status:p['상태']||'', example:p['예시']||'',
        }))
        .sort((a,b)=>b.accuracy-a.accuracy).slice(0,10);

      // ── 11. Vision/Orbit 화면 분석 ────────────────────────────────────────
      const visionRows = visionData?.rows || [];

      // ── 12. AI 인사이트 생성 ──────────────────────────────────────────────
      const insights = [];
      const unresolvedRate = decisions.length ? Math.round(unresolvedDec.length/decisions.length*100) : 0;

      if (unresolvedRate>=50)
        insights.push({ level:'critical', icon:'🚨',
          title:`의사결정 미해결율 ${unresolvedRate}%`,
          detail:`전체 ${decisions.length}건 중 ${unresolvedDec.length}건 처리 안됨. 평균 처리시간 ${avgResTime}분.`,
          action:'대응자 지정 + 에스컬레이션 기준 수립' });

      const topDP = productRisk.find(p=>p.defectRate>15);
      if (topDP)
        insights.push({ level:'warning', icon:'⚠️',
          title:`${topDP.name} 불량율 ${topDP.defectRate}% (${topDP.defects}/${topDP.total}건)`,
          detail:`${topDP.flower||''}${topDP.country?' ('+topDP.country+')':''} 품목에 집중 불량 발생.`,
          action:'수입 검품 강화 또는 공급처 재검토' });

      const unmatchCust = customers.filter(c=>!c['DB CustKey']||c['DB CustKey']==='');
      if (unmatchCust.length>10)
        insights.push({ level:'info', icon:'🔗',
          title:`거래처 전산 미매칭 ${unmatchCust.length}개`,
          detail:`카톡 거래처 ${customers.length}개 중 ${unmatchCust.length}개가 네노바 DB에 미연결.`,
          action:'거래처매칭 탭 → DB CustKey 입력으로 교차분석 정확도 향상' });

      const ocCount = eventTypeMap['주문변경']||eventTypeMap['ORDER_CHANGE']||0;
      if (ocCount>50)
        insights.push({ level:'opportunity', icon:'⚡',
          title:`주문변경 ${ocCount}건 — 자동화 시 ${Math.round(ocCount*7)}분 절감`,
          detail:`반복 주문변경 메시지를 자동으로 전산 반영하면 건당 평균 7분 절감.`,
          action:'PAD 또는 메시지 파싱 봇으로 자동화 우선 검토' });

      if (commonWeeks.length>0)
        insights.push({ level:'success', icon:'✅',
          title:`카톡↔전산 차수 ${commonWeeks.length}개 연결됨`,
          detail:`카톡 비즈니스이벤트 차수와 네노바 OrderWeek 교차 확인 완료.`,
          action:`연결율 100% 달성 시 카톡→전산 자동입력 자동화 가능` });

      const matchRate = customerRisk.length ? Math.round(kakaoToNenova.length/customerRisk.length*100) : 0;
      insights.push({ level:matchRate>60?'success':'warning', icon:matchRate>60?'✅':'⚠️',
        title:`카톡↔네노바 거래처 연결율 ${matchRate}%`,
        detail:`카톡 상위 거래처 ${customerRisk.length}개 중 ${kakaoToNenova.length}개 전산 연결.`,
        action:matchRate<70?'미연결 거래처 수동 매핑으로 데이터 완결성 향상':'연결율 양호 — 교차분석 신뢰도 높음' });

      res.json({
        generatedAt: new Date().toISOString(),
        summary: {
          kakaoMessages: messages.length,
          kakaoBizEvents: bizEvents.length,
          decisions: decisions.length,
          unresolvedDecisions: unresolvedDec.length,
          defects: defectList.length,
          productMatches: products.length,
          customerMatches: customers.length,
          patterns: patterns.length,
          nenovaOrders: dashData?.totalOrders||0,
          nenovaShipments: dashData?.totalShipments||0,
          nenovaCustomers: dashData?.totalCustomers||0,
          nenovaProducts: dashData?.totalProducts||0,
        },
        eventTypes: Object.entries(eventTypeMap).sort((a,b)=>b[1]-a[1]).map(([type,count])=>({type,count})),
        aiTypes:    Object.entries(aiTypeMap).sort((a,b)=>b[1]-a[1]).map(([type,count])=>({type,count})),
        pipelineRooms,
        productRisk,
        customerRisk,
        automationOpps,
        nenovaFlower:  dashData?.byFlower  || [],
        nenovaCountry: dashData?.byCountry || [],
        crossMatch: {
          kakaoToNenova, commonWeeks,
          matchRate, kakaoCustomers:customerRisk.length,
        },
        decisionStats: {
          total:decisions.length, unresolved:unresolvedDec.length,
          resolved:resolvedDec.length, unresolvedRate, avgResponseMin:avgResTime,
          byRoom: Object.entries(decByRoom).sort((a,b)=>b[1]-a[1])
            .map(([room,count])=>({room,count,unresolved:unresolvByRoom[room]||0})),
        },
        visionScreens: visionRows.slice(0,20),
        insights,
      });
    } catch(e) {
      console.error('[mining/total-analysis]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ── 카톡 시트 전체 탭 읽기 (total-analysis 전용) ────────────────────────────
async function _fetchFullKakaoTabs(token) {
  const https = require('https');
  const TABS = [
    { name:'메시지분류',     range:'A1:J5000' },
    { name:'비즈니스이벤트', range:'A1:R2000' },
    { name:'의사결정추적',   range:'A1:N200'  },
    { name:'방프로파일',     range:'A1:H20'   },
    { name:'품목매칭',       range:'A1:J800'  },
    { name:'거래처매칭',     range:'A1:H400'  },
    { name:'패턴라이브러리', range:'A1:H60'   },
  ];
  const result = {};
  for (const { name, range } of TABS) {
    const r = encodeURIComponent(`${name}!${range}`);
    const data = await new Promise(resolve => {
      https.get({ hostname:'sheets.googleapis.com',
        path:`/v4/spreadsheets/${KAKAO_SHEET_ID}/values/${r}`,
        headers:{ Authorization:`Bearer ${token}` } }, res => {
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(null);} });
      }).on('error',()=>resolve(null));
    });
    if (data?.values?.length>1) {
      const headers = data.values[0];
      result[name] = data.values.slice(1).map(row=>{
        const obj={};
        headers.forEach((h,j)=>{ obj[h]=row[j]||''; });
        return obj;
      });
    } else { result[name]=[]; }
    console.log(`[total-analysis] ${name}: ${result[name].length}행`);
  }
  return result;
}

// ── 업무 관련 카톡 메시지 판별 ──────────────────────────────────────────────
function _isWorkRelated(text, wt) {
  const t = (text + ' ' + wt).toLowerCase();
  const workKeywords = ['주문','발주','출고','배송','물량','박스','단','속','재고','견적','단가','입금','수량','거래처','카네이션','장미','수국','튤립','네노바','차감','확인요청','추가'];
  return workKeywords.some(k => t.includes(k));
}

function _mostCommon(arr) {
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function _topN(arr, n) {
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => ({ route: v, count: c }));
}

// ── 텍스트 리포트 생성 (관리자 보고용) ───────────────────────────────────────
function _generateTextReport({ period, stats, userProfiles, topPatterns, bottlenecks, decisionPoints, bestPractices }) {
  const lines = [];
  lines.push(`📊 Orbit 프로세스 마이닝 리포트 (${period})`);
  lines.push(`총 ${stats.total}건 이벤트, ${stats.users}명 활성`);
  lines.push('');

  // 직원별 업무 시간
  lines.push('▸ 직원별 업무 시간');
  for (const u of userProfiles.sort((a, b) => b.totalWorkMin - a.totalWorkMin)) {
    const apps = (u.timeByApp || []).slice(0, 3).map(t => t.app).join(', ');
    lines.push(`  ${u.name}: ${u.totalWorkMin}분 (${u.totalSessions}세션) — ${apps}`);
  }
  lines.push('');

  // 주요 업무 패턴
  if (topPatterns.length) {
    lines.push('▸ 주요 업무 흐름');
    for (const p of topPatterns.slice(0, 5)) {
      lines.push(`  ${p.flow} — ${p.count}회, 평균 ${p.avgDurationMin}분 (${p.interpretation})`);
    }
    lines.push('');
  }

  // 병목
  if (bottlenecks.length) {
    lines.push('▸ 병목 감지');
    for (const b of bottlenecks.slice(0, 3)) {
      lines.push(`  ${b.app}: 평균 ${b.avgDurationSec}초, 이상치 ${b.outlierCount}건 (최대 ${b.worstCaseSec}초)`);
    }
    lines.push('');
  }

  // 의사결정 분기
  if (decisionPoints.length) {
    lines.push('▸ 의사결정 분기');
    for (const dp of decisionPoints.slice(0, 3)) {
      lines.push(`  ${dp.fromApp} → ${dp.choices.map(c => c.nextApp).slice(0, 3).join('/')} (${dp.insight})`);
    }
    lines.push('');
  }

  // 베스트 프랙티스
  if (bestPractices.length) {
    lines.push('▸ 베스트 프랙티스');
    for (const bp of bestPractices.slice(0, 3)) {
      lines.push(`  ${bp.flow}: ${bp.fastest.name}(${bp.fastest.avgMin}분) vs ${bp.slowest.name}(${bp.slowest.avgMin}분) — 차이 ${bp.gapMin}분`);
    }
  }

  return lines.join('\n');
}

// ── 의사결정 분기 해석 ───────────────────────────────────────────────────────
function _interpretDecision(fromApp, choices) {
  if (choices.length < 2) return '';
  const top2 = choices.slice(0, 2);
  const apps = top2.map(c => c.nextApp).join(', ');
  if (fromApp === 'KakaoTalk') return `카카오 확인 후 ${apps} 중 선택 — 주문 유형에 따라 분기`;
  if (fromApp === 'Excel') return `엑셀 작업 후 ${apps} 중 선택 — 데이터 처리 방식 차이`;
  if (fromApp === 'Nenova ERP') return `ERP 처리 후 ${apps} 중 선택 — 후속 업무 패턴 차이`;
  return `${fromApp} 이후 ${choices.length}가지 경로 — 업무 상황별 의사결정 분기`;
}

// ── 워크플로우 패턴 해석 ─────────────────────────────────────────────────────
function _interpretFlow(steps) {
  const hasKakao = steps.includes('KakaoTalk');
  const hasExcel = steps.includes('Excel');
  const hasNenova = steps.includes('Nenova ERP');
  const hasBrowser = steps.includes('Browser');

  if (hasKakao && hasNenova) return '카카오 주문 → ERP 입력 (주문접수 프로세스)';
  if (hasKakao && hasExcel) return '카카오 주문 → 엑셀 정리 (물량표 작업)';
  if (hasExcel && hasNenova) return '엑셀 데이터 → ERP 전산처리';
  if (hasKakao && hasExcel && hasNenova) return '주문접수 → 물량표 → ERP 입력 (전체 프로세스)';
  if (hasBrowser && hasExcel) return '웹 조회 → 엑셀 정리';
  if (hasKakao) return '카카오 커뮤니케이션 중심 워크플로우';
  return '업무 전환 패턴';
}

// ── 서비스계정 JSON 파싱 (Railway 리터럴 \n 대응) ───────────────────────────
let _cachedCred = null;
async function _parseServiceAccountJson() {
  if (_cachedCred) return _cachedCred;

  // report-sheet.js에서 이미 파싱한 인증정보 재사용
  try {
    const rs = require('../src/report-sheet');
    if (rs._getCredentials) {
      const c = rs._getCredentials();
      if (c?.private_key) { _cachedCred = c; return c; }
    }
  } catch {}

  // 폴백: 내부 drive-config API에서 가져와서 직접 파싱
  const cfg = await _internalGet(`http://localhost:${process.env.PORT || 4747}/api/daemon/drive-config`);
  if (!cfg?.credentialsJson) throw new Error('drive-config 없음');
  const raw = cfg.credentialsJson;

  // Railway의 리터럴 \n 을 실제 줄바꿈으로 변환
  // Step 1: private_key 블록을 임시 치환
  const pkMatch = raw.match(/"private_key"\s*:\s*"([^"]*)"/);
  let pkValue = '';
  let jsonWithoutPk = raw;
  if (pkMatch) {
    pkValue = pkMatch[1];
    jsonWithoutPk = raw.replace(pkMatch[0], '"private_key": "__PK__"');
  }
  // Step 2: JSON 구조의 \n → 줄바꿈 (private_key 제외)
  const cleanJson = jsonWithoutPk.split('\\n').join('\n');
  const cred = JSON.parse(cleanJson);
  // Step 3: private_key 복원 — \\n → \n(줄바꿈), 잔여 \+newline 제거
  cred.private_key = pkValue.split('\\n').join('\n').replace(/\\\n/g, '\n');

  if (!cred.private_key.includes('BEGIN')) throw new Error('private_key 형식 오류');
  _cachedCred = cred;
  return cred;
}

// ── 구글시트에서 카톡 분석 데이터 읽기 ───────────────────────────────────────
const KAKAO_SHEET_ID = '1pXLVZqiMwWt6Vh0IhWwASBvgLtZqLnbHXMWqOLNwAXU';
let _kakaoSheetCache = null;
let _kakaoSheetCacheTs = 0;

async function _fetchKakaoSheetData() {
  // 5분 캐시
  if (_kakaoSheetCache && Date.now() - _kakaoSheetCacheTs < 300000) return _kakaoSheetCache;

  const https = require('https');
  const crypto = require('crypto');

  // 서비스 계정 토큰
  let cred = null;
  try { cred = await _parseServiceAccountJson(); } catch { return []; }
  if (!cred?.private_key) return [];

  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg:'RS256', typ:'JWT' })}.${b64({ iss: cred.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(cred.private_key, 'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  const token = await new Promise((resolve) => {
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
  if (!token) { console.warn('[kakao-sheet] 토큰 발급 실패'); return []; }

  // 시트 탭 목록 조회
  const sheetMeta = await new Promise((resolve) => {
    https.get({ hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${KAKAO_SHEET_ID}?fields=sheets.properties`, headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  if (!sheetMeta?.sheets) { console.warn('[kakao-sheet] 시트 메타 조회 실패:', JSON.stringify(sheetMeta)?.substring(0, 200)); return []; }
  const tabs = sheetMeta.sheets.map(s => s.properties?.title).filter(Boolean);
  console.log('[kakao-sheet] 탭 목록:', tabs.join(', '));

  // 핵심 탭 읽기: 메시지분류, 비즈니스이벤트, 의사결정추적, 파이프라인보고서
  const allEvents = [];
  const targetTabs = tabs.filter(t => ['메시지분류', '비즈니스이벤트', '의사결정추적', '방프로파일'].includes(t));

  for (const tab of targetTabs) {
    const range = encodeURIComponent(`${tab}!A1:Z5000`);
    const data = await new Promise((resolve) => {
      https.get({ hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${KAKAO_SHEET_ID}/values/${range}`, headers: { Authorization: `Bearer ${token}` } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (data?.values?.length > 1) {
      const headers = data.values[0];
      for (let i = 1; i < data.values.length; i++) {
        const row = {};
        headers.forEach((h, j) => { row[h] = data.values[i]?.[j] || ''; });
        row._tab = tab;
        allEvents.push(row);
      }
    }
  }

  _kakaoSheetCache = allEvents;
  _kakaoSheetCacheTs = Date.now();
  return allEvents;
}

// ── 카톡 이벤트 분석 ────────────────────────────────────────────────────────
function _analyzeKakaoEvents(events, orderMatches) {
  const bizEvents = events.filter(e => e._tab === '비즈니스이벤트');
  const decisions = events.filter(e => e._tab === '의사결정추적');
  const messages = events.filter(e => e._tab === '메시지분류');
  const rooms = events.filter(e => e._tab === '방프로파일');

  // 비즈니스 이벤트 분류
  const eventTypes = {};
  for (const e of bizEvents) {
    const type = e['이벤트타입'] || e['event_type'] || e['타입'] || 'unknown';
    eventTypes[type] = (eventTypes[type] || 0) + 1;
  }

  // 불량 분석
  const defects = bizEvents.filter(e => {
    const t = (e['이벤트타입'] || e['event_type'] || '').toLowerCase();
    return t.includes('불량') || t.includes('클레임') || t.includes('defect');
  });
  const defectProducts = {};
  for (const d of defects) {
    const prod = d['품목'] || d['product'] || d['상품'] || '';
    if (prod) defectProducts[prod] = (defectProducts[prod] || 0) + 1;
  }

  // 방별 활동량
  const roomActivity = {};
  for (const m of messages) {
    const room = m['방'] || m['room'] || m['채팅방'] || '';
    if (room) roomActivity[room] = (roomActivity[room] || 0) + 1;
  }

  // 응답 시간 계산 (같은 방 내 연속 메시지 간 시간 차이)
  const responseTimes = [];
  const msgByRoom = {};
  for (const m of messages) {
    const room = m['방'] || m['room'] || '';
    const ts = m['시간'] || m['timestamp'] || m['날짜'] || '';
    if (room && ts) {
      if (!msgByRoom[room]) msgByRoom[room] = [];
      msgByRoom[room].push({ ts: new Date(ts).getTime(), sender: m['발신자'] || m['sender'] || '' });
    }
  }
  for (const [, msgs] of Object.entries(msgByRoom)) {
    msgs.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].sender !== msgs[i - 1].sender && msgs[i].ts - msgs[i - 1].ts < 3600000) {
        responseTimes.push((msgs[i].ts - msgs[i - 1].ts) / 60000); // 분
      }
    }
  }

  const topRooms = Object.entries(roomActivity).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r);
  const topDefectProducts = Object.entries(defectProducts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);

  return {
    totalMessages: messages.length,
    totalBizEvents: bizEvents.length,
    eventTypes,
    orderChanges: eventTypes['주문변경'] || eventTypes['ORDER_CHANGE'] || 0,
    defects: defects.length,
    defectProducts: topDefectProducts,
    decisions: decisions.length,
    unresolvedDecisions: decisions.filter(d => (d['결과'] || d['status'] || '') === '미해결' || (d['결과'] || d['status'] || '') === '').length,
    topRooms,
    roomCount: Object.keys(roomActivity).length,
    responseAvgMin: responseTimes.length ? Math.round(responseTimes.reduce((s, t) => s + t, 0) / responseTimes.length) : null,
    responseMaxMin: responseTimes.length ? Math.round(Math.max(...responseTimes)) : null,
    rooms: rooms.map(r => ({ name: r['방이름'] || r['name'] || '', type: r['분류'] || r['type'] || '', pipeline: r['파이프라인'] || '' })),
  };
}

// ── 내부 API 호출 헬퍼 ──────────────────────────────────────────────────────
function _internalGet(url) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── 카톡방 이름 추출 ────────────────────────────────────────────────────────
function _extractKakaoRoom(windowTitle) {
  if (!windowTitle) return null;
  // "카카오톡 - 방이름" 또는 windowTitle 자체가 방 이름
  const m = windowTitle.match(/카카오톡\s*[-–]\s*(.+)/);
  if (m) return m[1].trim().substring(0, 30);
  // 주요 키워드 포함 시 방 이름으로 간주
  const t = windowTitle.trim();
  if (t.length > 2 && t.length < 40 && !t.includes('카카오톡 받은 파일')) return t.substring(0, 30);
  return null;
}

// ── Nenova 화면명 추출 ──────────────────────────────────────────────────────
function _extractNenovaScreen(windowTitle) {
  if (!windowTitle) return null;
  const screens = ['신규주문등록','주문관리','출고','재고','거래처','발주','입고','견적','Pivot','주문입력','매출','물량'];
  for (const s of screens) {
    if (windowTitle.includes(s)) return s;
  }
  if (windowTitle.includes('화훼 관리')) return '메인';
  if (windowTitle.includes('Preview') || windowTitle.includes('인쇄')) return '인쇄';
  return null;
}

// ── Excel 파일명 추출 ───────────────────────────────────────────────────────
function _extractExcelFile(windowTitle) {
  if (!windowTitle) return null;
  // "파일명.xlsx - Excel" 패턴
  const m = windowTitle.match(/(.+?)\s*[-–]\s*(?:Microsoft\s*)?Excel/i);
  if (m) return m[1].trim().substring(0, 40);
  // ".xlsx" 포함
  const x = windowTitle.match(/([^\\/]+\.xlsx?)/i);
  if (x) return x[1].substring(0, 40);
  // 물량표, 차감 등 키워드
  const kw = ['물량표','차감','발주','매출','견적','출고','재고'];
  for (const k of kw) {
    if (windowTitle.includes(k)) return windowTitle.substring(0, 40);
  }
  return null;
}

// ── 거래처명 추출 (간단 규칙 기반) ──────────────────────────────────────────
function _extractCustomers(text) {
  if (!text || text.length < 3) return [];
  const custs = [];
  // 알려진 패턴: "○○농원", "○○화훼", "○○소재", "○○다원" 등
  const patterns = [/([가-힣]{2,6}(?:농원|화훼|소재|다원|플라워|팜|원예|종묘|화원|가든|무역))/g];
  for (const p of patterns) {
    let m; while ((m = p.exec(text)) !== null) {
      if (m[1].length >= 3 && m[1].length <= 12) custs.push(m[1]);
    }
  }
  // "경부다원", "에이스" 같은 이름 — 명시적 키워드
  return [...new Set(custs)];
}

// ── 의사결정 분기 데이터 추출 (deep-analyze용) ──────────────────────────────
function _extractDecisionData(userTransitions) {
  const fromApps = {};
  for (const [userName, transitions] of Object.entries(userTransitions)) {
    for (const t of transitions) {
      if (!fromApps[t.from]) fromApps[t.from] = {};
      if (!fromApps[t.from][t.to]) fromApps[t.from][t.to] = [];
      fromApps[t.from][t.to].push({ user: userName, count: t.count });
    }
  }
  const points = [];
  for (const [fromApp, toApps] of Object.entries(fromApps)) {
    const destinations = Object.entries(toApps);
    if (destinations.length < 2) continue;
    const choices = destinations.map(([toApp, users]) => ({
      nextApp: toApp, users, total: users.reduce((s, u) => s + u.count, 0),
    })).sort((a, b) => b.total - a.total);
    points.push({ fromApp, choices });
  }
  return points.sort((a, b) => b.choices.length - a.choices.length);
}

// ── Claude API 호출 (심층 분석) ─────────────────────────────────────────────
async function _callClaudeAnalysis(prompt) {
  const https = require('https');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      fullText: '(ANTHROPIC_API_KEY 미설정 — AI 분석 불가, 규칙 기반 분석만 제공)',
      decisions: [], recommendations: [], automationDesign: [],
    };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const text = JSON.parse(d).content?.[0]?.text || '';
          // JSON 응답 파싱 시도
          const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            try {
              const parsed = JSON.parse(jsonStr.trim());
              parsed.fullText = text;
              resolve(parsed);
              return;
            } catch {}
          }
          resolve({ fullText: text, decisions: [], recommendations: [], automationDesign: [] });
        } catch (e) {
          resolve({ fullText: `분석 오류: ${e.message}`, decisions: [], recommendations: [], automationDesign: [] });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ fullText: `API 호출 실패: ${e.message}`, decisions: [], recommendations: [], automationDesign: [] });
    });
    req.write(body);
    req.end();
  });
}

// ── 심층 분석 프롬프트 생성 ─────────────────────────────────────────────────
function _buildDeepAnalysisPrompt(userAnalyses, decisionData, period) {
  const userData = userAnalyses.map(u =>
    `■ ${u.name}: ${u.totalWorkMin}분 작업, ${u.totalEvents}건 이벤트, ${u.sessionCount}세션\n` +
    `  앱 사용: ${u.timeByApp.map(t => `${t.app}(${t.minutes}분)`).join(', ')}\n` +
    `  주요 패턴: ${u.topPatterns.map(p => `${p.flow}(${p.count}회, ${p.avgMin}분)`).join(' | ')}\n` +
    `  병목: ${u.bottlenecks.map(b => `${b.app}(평균${b.avgDurationSec}초, 이상치${b.outlierCount}건)`).join(', ') || '없음'}`
  ).join('\n\n');

  const decisionText = decisionData.slice(0, 5).map(dp =>
    `  ${dp.fromApp} → ${dp.choices.map(c => `${c.nextApp}(${c.users.map(u => u.user).join(',')})`).join(' / ')}`
  ).join('\n');

  return `당신은 기업 업무 프로세스 분석 전문가입니다.

다음은 네노바(농자재 유통 회사) 직원들의 ${period.startDate}부터 ${period.days}일간 PC 활동 데이터 분석 결과입니다.

=== 직원별 업무 패턴 ===
${userData}

=== 의사결정 분기점 ===
${decisionText || '(데이터 부족)'}

다음을 분석하여 JSON으로 응답하세요:

\`\`\`json
{
  "decisions": [
    {
      "situation": "어떤 상황에서 의사결정이 발생하는지",
      "pattern": "직원들이 실제로 하는 선택 패턴",
      "reasoning": "왜 이런 선택을 하는지 추정되는 이유",
      "betterAlternative": "더 나은 대안이 있다면 무엇인지",
      "automationPossible": true/false,
      "automationDesign": "자동화한다면 어떤 로직으로 구현할지"
    }
  ],
  "bestPractices": [
    {
      "who": "가장 효율적인 직원",
      "what": "그 직원이 다르게 하는 점",
      "impact": "이를 전체 적용하면 예상되는 효과"
    }
  ],
  "recommendations": [
    {
      "priority": 1,
      "title": "개선 제안 제목",
      "description": "구체적 설명",
      "expectedSavings": "예상 절감 시간/비용",
      "implementation": "구현 방법"
    }
  ],
  "processMap": "주문접수부터 출고까지 전체 프로세스를 텍스트로 설명",
  "bottleneckAnalysis": "병목 구간에 대한 심층 분석"
}
\`\`\``;
}

// ── 자동화 블루프린트 설계 ──────────────────────────────────────────────────
function _designAutomation(steps, patternData) {
  const hasKakao = steps.includes('KakaoTalk');
  const hasExcel = steps.includes('Excel');
  const hasNenova = steps.includes('Nenova ERP');
  const hasBrowser = steps.includes('Browser');

  let method = 'manual_review';
  let difficulty = 'high';
  let feasibility = 0.3;
  const implSteps = [];

  // 카카오 → ERP 패턴: 메시지 파싱 → 자동 입력
  if (hasKakao && hasNenova) {
    method = 'kakao_parse_to_erp';
    difficulty = 'medium';
    feasibility = 0.7;
    implSteps.push(
      '1. 카카오톡 주문 메시지 자동 파싱 (정규식 + AI)',
      '2. 파싱된 데이터를 nenova 입력 형식으로 변환',
      '3. PAD(Power Automate Desktop)로 nenova UI 자동 입력',
      '4. 입력 결과 카카오톡으로 확인 메시지 발송',
    );
  }
  // 카카오 → 엑셀 패턴: 메시지 → 스프레드시트 자동 기록
  else if (hasKakao && hasExcel) {
    method = 'kakao_parse_to_excel';
    difficulty = 'low';
    feasibility = 0.85;
    implSteps.push(
      '1. 카카오톡 메시지 감지 (clipboard.change 이벤트)',
      '2. 주문 정보 추출 (품명/수량/단가/거래처)',
      '3. Excel COM 자동화로 물량표에 행 추가',
      '4. 추가 결과 로그 기록',
    );
  }
  // 엑셀 → ERP 패턴: 데이터 전송
  else if (hasExcel && hasNenova) {
    method = 'excel_to_erp_sync';
    difficulty = 'medium';
    feasibility = 0.75;
    implSteps.push(
      '1. 엑셀 물량표 변경 감지 (file.change 이벤트)',
      '2. 변경된 행 데이터 추출 (COM 자동화)',
      '3. nenova 해당 화면으로 이동 (PAD)',
      '4. 데이터 입력 + 저장',
    );
  }
  // 브라우저 → 엑셀: 웹 데이터 → 스프레드시트
  else if (hasBrowser && hasExcel) {
    method = 'web_scrape_to_excel';
    difficulty = 'low';
    feasibility = 0.8;
    implSteps.push(
      '1. 브라우저 페이지 데이터 자동 추출 (playwright/puppeteer)',
      '2. 데이터 정제 및 포맷 변환',
      '3. Excel에 자동 기록',
    );
  }
  // 기타
  else {
    method = 'workflow_automation';
    difficulty = steps.length > 3 ? 'high' : 'medium';
    feasibility = 0.4;
    implSteps.push(
      '1. 워크플로우 트리거 조건 정의',
      '2. 각 단계별 자동화 스크립트 작성',
      '3. 예외 처리 + 수동 개입 지점 설정',
    );
  }

  const avgMin = patternData.avgDurationMin || Math.round((patternData.totalDuration || 0) / Math.max(patternData.count, 1));
  const savingsPerOccurrence = Math.round(avgMin * feasibility);
  const monthlyOccurrences = Math.round(patternData.count / 7 * 22); // 주간→월간 환산
  const savingsPerMonth = savingsPerOccurrence * monthlyOccurrences;

  return {
    automationMethod: method,
    automationFeasibility: feasibility,
    difficulty,
    implementationSteps: implSteps,
    savingsPerOccurrence,
    monthlyOccurrences,
    savingsPerMonth,
  };
}

// ── Recorder 통합 전용 유틸리티 (recording.js에서도 사용) ─────────────────
createProcessMining._normalizeApp = normalizeApp;
createProcessMining._inferAppFromTitle = inferAppFromTitle;

module.exports = createProcessMining;
