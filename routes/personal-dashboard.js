'use strict';
/**
 * personal-dashboard.js — 개인 대시보드 API (analysis.html 연동)
 *
 * analysis.html이 호출하는 9개 API를 구현:
 * 1. GET /api/work-analysis/dashboard — 종합 (KPI, 효율, 목적 분배, 병목, 자동화)
 * 2. GET /api/intelligence/heatmap — 활동 히트맵 (24h × 7d)
 * 3. GET /api/intelligence/decisions — 의사결정/예측/리스크
 * 4. GET /api/intelligence/anomalies — 이상 탐지
 * 5. GET /api/intelligence/workflow — 업무 흐름 그래프
 * 6. GET /api/work-analysis/capability — 역량 프로필
 * 7. GET /api/learning/profile — 루틴/트리거
 * 8. GET /api/learning/recommendations — 맞춤 추천
 * 9. GET /api/learning/data-sheet — 학습 데이터 시트
 */
const express = require('express');

function createPersonalDashboard({ getDb, verifyToken }) {
  const router = express.Router();

  // 인증 미들웨어
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token || req.cookies?.orbit_token;
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. GET /api/work-analysis/dashboard — 종합 대시보드
  // ═══════════════════════════════════════════════════════════════
  router.get('/work-analysis/dashboard', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({});
      const userId = req.user.id;
      const period = req.query.period || '7d';
      const days = period === '30d' ? 30 : period === 'all' ? 365 : 7;

      const [totalRes, todayRes, weekRes, purposeRes, bottleRes] = await Promise.all([
        db.query(`SELECT COUNT(*) as cnt FROM events WHERE user_id=$1 AND timestamp::timestamptz > NOW()-INTERVAL '${days} days'`, [userId]),
        db.query(`SELECT COUNT(*) as cnt, COUNT(DISTINCT EXTRACT(HOUR FROM timestamp::timestamptz)) * 5 as active_min FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture') AND timestamp::timestamptz > NOW()-INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) as cnt FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture') AND timestamp::timestamptz > NOW()-INTERVAL '7 days'`, [userId]),
        // 목적별 분배 (윈도우 패턴 기반)
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~* '주문') as order_min,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~* '발주') as purchase_min,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') LIKE '%Excel%') as excel_min,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~* '(카카오톡|네노바.*영업|네노바.*현장)') as comm_min,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~* '(Claude|ChatGPT|PowerShell)') as dev_min,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~* '(chrome|edge|검색)') as search_min,
            COUNT(*) FILTER (WHERE type='idle') as idle_min,
            COUNT(*) as total
          FROM events WHERE user_id=$1 AND timestamp::timestamptz > NOW()-INTERVAL '${days} days'
        `, [userId]),
        // 반복 작업 (자동화 후보)
        db.query(`
          SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as win, COUNT(*) as cnt
          FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW()-INTERVAL '${days} days'
          GROUP BY win HAVING COUNT(*) >= 30 ORDER BY cnt DESC LIMIT 5
        `, [userId]),
      ]);

      const total = parseInt(totalRes.rows[0]?.cnt) || 0;
      const todayEvents = parseInt(todayRes.rows[0]?.cnt) || 0;
      const activeMin = parseInt(todayRes.rows[0]?.active_min) || 0;
      const weekEvents = parseInt(weekRes.rows[0]?.cnt) || 0;
      const p = purposeRes.rows[0] || {};
      const pTotal = parseInt(p.total) || 1;

      // 효율 점수 계산
      const idleRatio = parseInt(p.idle_min || 0) / pTotal;
      const workRatio = 1 - idleRatio;
      const score = Math.round(workRatio * 100);
      const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';

      const purposes = [
        { label: '주문 처리', icon: '📋', color: '#3fb950', minutes: Math.round(parseInt(p.order_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.order_min||0)/pTotal*100) },
        { label: '발주 관리', icon: '📦', color: '#58a6ff', minutes: Math.round(parseInt(p.purchase_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.purchase_min||0)/pTotal*100) },
        { label: 'Excel 작업', icon: '📊', color: '#d29922', minutes: Math.round(parseInt(p.excel_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.excel_min||0)/pTotal*100) },
        { label: '커뮤니케이션', icon: '💬', color: '#8b949e', minutes: Math.round(parseInt(p.comm_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.comm_min||0)/pTotal*100) },
        { label: '개발/도구', icon: '🛠', color: '#bc8cff', minutes: Math.round(parseInt(p.dev_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.dev_min||0)/pTotal*100) },
        { label: '검색/브라우징', icon: '🔍', color: '#79c0ff', minutes: Math.round(parseInt(p.search_min||0)/pTotal*activeMin), percent: Math.round(parseInt(p.search_min||0)/pTotal*100) },
      ].filter(x => x.percent > 0).sort((a, b) => b.percent - a.percent);

      const automationCandidates = bottleRes.rows.filter(r => r.win && parseInt(r.cnt) >= 50).map(r => ({
        task: r.win, suggestion: `"${r.win}" 화면 ${r.cnt}회 반복 — 자동화 가능`, estimatedTimeSavedMin: Math.round(parseInt(r.cnt) * 0.5), difficulty: parseInt(r.cnt) > 200 ? 'high' : 'medium',
      }));

      res.json({
        totalEvents: total,
        todaySummary: { activeMinutes: activeMin, events: todayEvents },
        trend: { direction: weekEvents > total / 2 ? 'up' : 'stable', recentCount: weekEvents },
        efficiency: {
          score, grade,
          breakdown: {
            focus: { label: '집중도', score: Math.min(100, Math.round(workRatio * 120)) },
            consistency: { label: '일관성', score: Math.min(100, Math.round(todayEvents / Math.max(total / days, 1) * 100)) },
            tools: { label: '도구 활용', score: Math.min(100, purposes.length * 20) },
          },
          insights: [
            score >= 70 ? { type: 'positive', message: `효율 점수 ${score}점 — 양호한 업무 패턴입니다` } : { type: 'warning', message: `효율 점수 ${score}점 — idle 비율이 높습니다` },
            purposes[0] ? { type: 'suggestion', message: `가장 많은 시간: ${purposes[0].label} (${purposes[0].percent}%)` } : null,
          ].filter(Boolean),
        },
        timeDistribution: { byPurpose: purposes },
        bottlenecks: { bottlenecks: automationCandidates.filter(a => parseInt(a.estimatedTimeSavedMin) > 30).map(a => ({ type: 'repetitive', severity: 'medium', description: a.task, suggestion: a.suggestion })) },
        repetitiveWork: { automationCandidates },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. GET /api/intelligence/heatmap — 24h × 7d 히트맵
  // ═══════════════════════════════════════════════════════════════
  router.get('/intelligence/heatmap', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ heatmap: [] });
      const userId = req.user.id;

      const result = await db.query(`
        SELECT EXTRACT(DOW FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as dow,
          EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as hour,
          COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        GROUP BY dow, hour
      `, [userId]);

      const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
      const heatmap = dayNames.map((name, dow) => ({
        day: name,
        hours: Array.from({ length: 24 }, (_, h) => {
          const found = result.rows.find(r => parseInt(r.dow) === dow && parseInt(r.hour) === h);
          const count = found ? parseInt(found.cnt) : 0;
          return { hour: h, count, intensity: Math.min(100, count * 2) };
        }),
      }));

      res.json({ heatmap });
    } catch (e) { res.json({ heatmap: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. GET /api/intelligence/decisions — 의사결정 + 예측 + 리스크
  // ═══════════════════════════════════════════════════════════════
  router.get('/intelligence/decisions', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ actions: [], predictions: [], risks: [] });
      const userId = req.user.id;

      // 반복 작업에서 액션 추출
      const repRes = await db.query(`
        SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as win, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        GROUP BY win HAVING COUNT(*) >= 50 ORDER BY cnt DESC LIMIT 5
      `, [userId]);

      const actions = repRes.rows.filter(r => r.win).map(r => ({
        title: `"${(r.win || '').substring(0, 30)}" 반복 작업`, priority: parseInt(r.cnt) > 200 ? 'high' : 'medium',
        action: `${r.cnt}회 반복 — 자동화 스크립트 적용 시 ${Math.round(parseInt(r.cnt) * 0.5)}분 절약`,
      }));

      // Vision 기반 예측
      const visionRes = await db.query(`
        SELECT data_json->>'automationHint' as hint, data_json->>'automatable' as auto
        FROM events WHERE user_id=$1 AND type='screen.analyzed'
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
          AND data_json->>'automationHint' IS NOT NULL
        ORDER BY timestamp DESC LIMIT 5
      `, [userId]);

      const predictions = visionRes.rows.filter(r => r.hint).map(r => ({
        title: r.auto === 'true' ? '자동화 가능 업무 발견' : '개선 가능 업무',
        description: (r.hint || '').substring(0, 100),
      }));

      res.json({ actions, predictions, risks: [] });
    } catch (e) { res.json({ actions: [], predictions: [], risks: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. GET /api/intelligence/anomalies — 이상 탐지
  // ═══════════════════════════════════════════════════════════════
  router.get('/intelligence/anomalies', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ anomalies: [] });
      const userId = req.user.id;

      const anomalies = [];

      // idle 비율 체크
      const idleRes = await db.query(`
        SELECT COUNT(*) FILTER (WHERE type='idle') as idle, COUNT(*) FILTER (WHERE type IN ('keyboard.chunk','screen.capture')) as active
        FROM events WHERE user_id=$1 AND timestamp::timestamptz > NOW()-INTERVAL '24 hours'
      `, [userId]);
      const ir = idleRes.rows[0] || {};
      const idleR = (parseInt(ir.idle)||0) / Math.max(parseInt(ir.idle||0) + parseInt(ir.active||0), 1);
      if (idleR > 0.5) anomalies.push({ severity: 'alert', description: `idle 비율 ${Math.round(idleR * 100)}% — 비활동 시간이 많습니다` });

      // 과거 주문 접근
      const pastRes = await db.query(`
        SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as win, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '24 hours'
          AND COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') ~ '202[0-9]-[0-9]{2}-[0-9]{2}'
        GROUP BY win HAVING COUNT(*) >= 3
      `, [userId]);
      for (const r of pastRes.rows) {
        const m = (r.win || '').match(/(202\d-\d{2}-\d{2})/);
        if (m) {
          const d = Math.floor((Date.now() - new Date(m[1]).getTime()) / 86400000);
          if (d >= 3) anomalies.push({ severity: 'warning', description: `${d}일 전 주문 "${r.win}" ${r.cnt}회 접근` });
        }
      }

      res.json({ anomalies });
    } catch (e) { res.json({ anomalies: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. GET /api/intelligence/workflow — 업무 흐름 그래프
  // ═══════════════════════════════════════════════════════════════
  router.get('/intelligence/workflow', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ nodes: [], edges: [] });
      const userId = req.user.id;

      // 앱별 사용량 → 노드
      const nodeRes = await db.query(`
        SELECT COALESCE(data_json->>'app',data_json->'appContext'->>'currentApp') as app, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        GROUP BY app HAVING COUNT(*) >= 5 ORDER BY cnt DESC LIMIT 10
      `, [userId]);

      const colors = ['#3fb950','#58a6ff','#d29922','#f85149','#bc8cff','#8b949e','#79c0ff','#ffa657'];
      const nodes = nodeRes.rows.filter(r => r.app).map((r, i) => ({
        label: r.app, count: parseInt(r.cnt), color: colors[i % colors.length],
      }));

      // 앱 전환 → 엣지
      const edgeRes = await db.query(`
        WITH ordered AS (
          SELECT COALESCE(data_json->>'app',data_json->'appContext'->>'currentApp') as app,
            LAG(COALESCE(data_json->>'app',data_json->'appContext'->>'currentApp')) OVER (ORDER BY timestamp) as prev
          FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        )
        SELECT prev as "from", app as "to", COUNT(*) as weight
        FROM ordered WHERE app != prev AND app IS NOT NULL AND prev IS NOT NULL
        GROUP BY prev, app HAVING COUNT(*) >= 3 ORDER BY weight DESC LIMIT 15
      `, [userId]);

      res.json({
        nodes,
        edges: edgeRes.rows.map(r => ({ from: r.from, to: r.to, weight: parseInt(r.weight) })),
      });
    } catch (e) { res.json({ nodes: [], edges: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. GET /api/work-analysis/capability — 역량 프로필
  // ═══════════════════════════════════════════════════════════════
  router.get('/work-analysis/capability', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({});
      const userId = req.user.id;

      // 윈도우별 사용 → 스킬 추출
      const winRes = await db.query(`
        SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as win, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '30 days'
        GROUP BY win HAVING COUNT(*) >= 10 ORDER BY cnt DESC LIMIT 30
      `, [userId]);

      const skillMap = { 'Excel': 'Excel', 'Word': 'Word', 'PowerPoint': 'PowerPoint', 'Chrome': 'Chrome', 'Claude': 'Claude AI', 'ChatGPT': 'ChatGPT', 'PowerShell': 'PowerShell', 'cmd': 'Command Line', '카카오톡': 'KakaoTalk', 'nenova': 'nenova ERP', '화훼 관리': 'nenova ERP', '주문': '주문 관리', '발주': '발주 관리', '물량': '물량표 관리', '매출': '매출 분석' };

      const skills = [];
      const seen = new Set();
      for (const r of winRes.rows) {
        for (const [kw, name] of Object.entries(skillMap)) {
          if ((r.win || '').includes(kw) && !seen.has(name)) {
            seen.add(name);
            const cnt = parseInt(r.cnt);
            skills.push({ name, level: cnt > 100 ? 'expert' : cnt > 30 ? 'advanced' : 'intermediate', eventCount: cnt });
          }
        }
      }

      // 전문 분야
      const expertise = [
        { icon: '📋', area: '주문 처리', eventCount: winRes.rows.filter(r => /주문/.test(r.win||'')).reduce((s, r) => s + parseInt(r.cnt), 0) },
        { icon: '📦', area: '발주 관리', eventCount: winRes.rows.filter(r => /발주|물량/.test(r.win||'')).reduce((s, r) => s + parseInt(r.cnt), 0) },
        { icon: '📊', area: 'Excel 데이터', eventCount: winRes.rows.filter(r => /Excel/.test(r.win||'')).reduce((s, r) => s + parseInt(r.cnt), 0) },
        { icon: '💬', area: '커뮤니케이션', eventCount: winRes.rows.filter(r => /카카오톡|네노바/.test(r.win||'')).reduce((s, r) => s + parseInt(r.cnt), 0) },
      ].filter(e => e.eventCount > 0).sort((a, b) => b.eventCount - a.eventCount);

      // 작업 스타일
      const styleRes = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE type IN ('keyboard.chunk','screen.capture')) as active,
          COUNT(*) FILTER (WHERE type = 'idle') as idle,
          COUNT(DISTINCT COALESCE(data_json->>'app',data_json->'appContext'->>'currentApp')) as tools
        FROM events WHERE user_id=$1 AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
      `, [userId]);
      const st = styleRes.rows[0] || {};
      const activeR = parseInt(st.active||0) / Math.max(parseInt(st.active||0) + parseInt(st.idle||0), 1);

      res.json({
        skills: skills.sort((a, b) => b.eventCount - a.eventCount),
        expertise,
        workStyle: {
          type: activeR > 0.8 ? '🔥 고집중형' : activeR > 0.5 ? '⚡ 밸런스형' : '🌊 여유형',
          focusLevel: Math.round(activeR * 100),
          consistency: Math.min(100, Math.round((parseInt(st.active||0) / 7) / 50 * 100)),
          toolDiversity: Math.min(100, parseInt(st.tools||0) * 15),
        },
        topProjects: winRes.rows.filter(r => r.win && /Excel|발주|물량|매출/.test(r.win)).slice(0, 5).map(r => ({
          name: (r.win || '').substring(0, 40), eventCount: parseInt(r.cnt), period: '최근 30일',
        })),
      });
    } catch (e) { res.json({}); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. GET /api/learning/profile — 루틴 + 트리거
  // ═══════════════════════════════════════════════════════════════
  router.get('/learning/profile', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ routines: [], triggers: [] });
      const userId = req.user.id;

      // 시간대별 패턴 → 루틴
      const hourRes = await db.query(`
        SELECT EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as h, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        GROUP BY h ORDER BY cnt DESC LIMIT 5
      `, [userId]);

      const routines = hourRes.rows.map(r => ({
        description: `${r.h}시에 활동 집중 (${r.cnt}건/주)`,
        hour: parseInt(r.h), count: parseInt(r.cnt),
      }));

      // 반복 앱 전환 → 트리거
      const trigRes = await db.query(`
        SELECT COALESCE(data_json->>'windowTitle',data_json->'appContext'->>'currentWindow') as win, COUNT(*) as cnt
        FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        GROUP BY win HAVING COUNT(*) >= 50 ORDER BY cnt DESC LIMIT 5
      `, [userId]);

      const triggers = trigRes.rows.filter(r => r.win).map(r => ({
        description: `"${(r.win||'').substring(0, 30)}" ${r.cnt}회 반복`,
        automatable: parseInt(r.cnt) > 100,
      }));

      res.json({ routines, triggers });
    } catch (e) { res.json({ routines: [], triggers: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. GET /api/learning/recommendations — 맞춤 추천
  // ═══════════════════════════════════════════════════════════════
  router.get('/learning/recommendations', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ recommendations: [] });
      const userId = req.user.id;

      // Vision 자동화 힌트에서 추천 생성
      const hintRes = await db.query(`
        SELECT DISTINCT data_json->>'automationHint' as hint, data_json->>'automatable' as auto
        FROM events WHERE user_id=$1 AND type='screen.analyzed'
          AND data_json->>'automationHint' IS NOT NULL AND data_json->>'automationHint' != ''
          AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
        LIMIT 5
      `, [userId]);

      const recommendations = hintRes.rows.filter(r => r.hint).map((r, i) => ({
        icon: ['🤖', '⚡', '📊', '🔄', '📋'][i % 5],
        name: r.auto === 'true' ? '자동화 추천' : '개선 추천',
        description: (r.hint || '').substring(0, 120),
        personalFit: r.auto === 'true' ? 85 : 60,
        estimatedSavingsPerWeek: r.auto === 'true' ? 120 : 30,
        estimatedSetupHours: r.auto === 'true' ? 4 : 1,
        difficulty: r.auto === 'true' ? '중간' : '쉬움',
      }));

      // 기본 추천 추가
      if (recommendations.length === 0) {
        recommendations.push({
          icon: '📊', name: '데이터 축적 중',
          description: '더 많은 데이터가 쌓이면 맞춤 자동화 추천이 생성됩니다.',
          personalFit: 50, estimatedSavingsPerWeek: 0, estimatedSetupHours: 0, difficulty: '-',
        });
      }

      res.json({ recommendations });
    } catch (e) { res.json({ recommendations: [] }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. GET /api/learning/data-sheet — 학습 데이터 시트
  // ═══════════════════════════════════════════════════════════════
  router.get('/learning/data-sheet', auth, async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ rows: [] });
      const userId = req.user.id;

      const [appRes, visionRes, masterRes] = await Promise.all([
        db.query(`
          SELECT COALESCE(data_json->>'app',data_json->'appContext'->>'currentApp') as app, COUNT(*) as cnt
          FROM events WHERE user_id=$1 AND type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW()-INTERVAL '7 days'
          GROUP BY app HAVING COUNT(*) >= 5 ORDER BY cnt DESC LIMIT 10
        `, [userId]),
        db.query(`SELECT COUNT(*) as cnt, COUNT(*) FILTER (WHERE data_json->>'automatable'='true') as auto FROM events WHERE user_id=$1 AND type='screen.analyzed'`, [userId]),
        db.query(`SELECT COUNT(*) as products FROM master_products`),
      ]);

      const rows = [];
      // 앱 사용 데이터
      for (const r of appRes.rows) {
        if (r.app) rows.push({ category: '앱 사용', item: r.app, value: `${r.cnt}건`, insight: parseInt(r.cnt) > 100 ? '주력 도구' : '보조 도구' });
      }
      // Vision 데이터
      const v = visionRes.rows[0] || {};
      rows.push({ category: 'Vision 분석', item: '분석 완료', value: `${v.cnt || 0}건`, insight: `자동화 가능 ${v.auto || 0}건` });
      rows.push({ category: '마스터 DB', item: '등록 품목', value: `${masterRes.rows[0]?.products || 0}개`, insight: '자동 학습 중' });

      res.json({ rows });
    } catch (e) { res.json({ rows: [] }); }
  });

  return router;
}

module.exports = createPersonalDashboard;
