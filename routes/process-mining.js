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
function createProcessMining({ getDb }) {
  const router = express.Router();

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

  return router;
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

module.exports = createProcessMining;
