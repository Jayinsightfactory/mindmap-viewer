'use strict';
/**
 * process-mining.js — 업무 프로세스 마이닝 엔진
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

// ── 상수 ─────────────────────────────────────────────────────────────────────
const SESSION_GAP_MS  = 5 * 60 * 1000;   // 5분 이상 공백 → 새 세션
const MERGE_WINDOW_MS = 30 * 1000;        // 30초 이내 동일 앱 → 하나의 블록
const MIN_BLOCK_MS    = 5 * 1000;         // 5초 미만 블록 → 노이즈 제거

// 분석 대상 이벤트 타입
const WORK_TYPES = [
  'keyboard.chunk', 'screen.capture', 'screen.analyzed',
  'clipboard.change', 'order.detected', 'purchase.order.detected',
];

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

      const events = await fetchEvents(db, userId, date, parseInt(days) || 1);
      if (!events.length) return res.json({ sessions: [], message: '해당 기간 데이터 없음' });

      const blocks = buildActivityBlocks(events);
      const sessions = splitSessions(blocks);
      const { transitions, timeByApp } = buildTransitionMatrix(blocks);

      const userName = await getUserName(db, userId);

      res.json({
        user: { id: userId, name: userName },
        date: date || new Date().toISOString().substring(0, 10),
        totalEvents: events.length,
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
      const events = await fetchEvents(db, userId, date, d);
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
      const events = await fetchEvents(db, userId, date, d);
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
      const baseEvents = await fetchEvents(db, userId, baselineStart.toISOString().substring(0, 10), 7);
      const baseBlocks = buildActivityBlocks(baseEvents);
      const { timeByApp: baseTime } = buildTransitionMatrix(baseBlocks);
      const basePatterns = extractPatterns(baseBlocks);

      // 당일 데이터
      const todayEvents = await fetchEvents(db, userId, targetDate, 1);
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

  return router;
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

module.exports = createProcessMining;
