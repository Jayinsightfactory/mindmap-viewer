/**
 * routes/graph.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래프·세션·목적 분류·오버레이 관련 API 라우터
 *
 * 담당 엔드포인트:
 *   GET /api/graph          - 전체 그래프 데이터 (노드 + 엣지)
 *   GET /api/sessions        - 세션 목록
 *   GET /api/purposes        - 목적 분류 윈도우
 *   GET /api/purposes/summary - 목적별 통계
 *   GET /api/purposes/categories - 목적 카테고리 정의
 *   GET /api/search          - 이벤트 키워드 검색
 *   GET /api/members         - 멤버 목록 (Zoom, Calendar, Claude 통합)
 *   GET /api/overlay         - 멤버별 그래프 오버레이
 *   GET /api/files           - 파일 접근 통계
 *   GET /api/stats           - 전체 통계
 *   GET /api/activity        - 노드별 활동 점수
 *   GET /api/turns           - 전체 이벤트 (레거시)
 *   GET /api/snapshots       - 스냅샷 목록
 *   POST /api/rollback/:id   - 특정 이벤트까지 롤백
 *   DELETE /api/clear        - 전체 초기화
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const router   = express.Router();

// ─── 의존성 주입 패턴 ────────────────────────────────────────────────────────
// server.js에서 생성한 공유 객체(db, broadcastAll, getFullGraph 등)를
// createRouter(deps) 형태로 주입받습니다.
// 이렇게 하면 테스트 시 mock 주입이 가능하고, 순환 의존성을 방지합니다.

/**
 * @param {object} deps - 의존성 객체
 * @param {Function} deps.getFullGraph     - (session?, channel?) → {nodes, edges}
 * @param {Function} deps.broadcastAll     - (msg) → void
 * @param {Function} deps.broadcastToChannel - (channelId, msg) → void
 * @param {object}   deps.db              - DB 모듈 (getAllEvents, getSessions 등)
 * @param {object}   deps.purposeClassifier - { classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES }
 * @param {string}   deps.CONV_FILE       - conversation.jsonl 절대 경로
 * @param {string}   deps.SNAPSHOTS_DIR   - 스냅샷 디렉토리 절대 경로
 * @returns {express.Router}
 */
function createRouter(deps) {
  const {
    getFullGraph, getFullGraphForUser, broadcastAll, broadcastToChannel,
    db, purposeClassifier, CONV_FILE, SNAPSHOTS_DIR, verifyToken,
  } = deps;

  const {
    getAllEvents, getEventsBySession, getEventsByChannel,
    getSessions, updateSessionTitle, getFiles, getStats, rollbackToEvent, clearAll,
    getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
    hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds,
  } = db;

  const { classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES } = purposeClassifier;

  // AI 분류기 (ollama-analyzer)
  let _aiClassifier = null;
  try { _aiClassifier = require('../src/ollama-analyzer'); } catch {}

  // ── 인증 헬퍼 ─────────────────────────────────────────────────────────────
  // 토큰에서 사용자 추출. AUTH_DISABLED=1이면 'local' 반환 (로컬 개발용)
  function getUserFromReq(req) {
    if (process.env.AUTH_DISABLED === '1') return { id: 'local' };
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.query.token || req.cookies?.orbit_token;
    return verifyToken ? verifyToken(token) : null;
  }

  // ── 그래프 ────────────────────────────────────────────────────────────────

  /**
   * GET /api/graph
   * 로그인 시: 해당 user_id의 이벤트만 반환 (프라이버시 격리)
   * 비로그인 시: AUTH_DISABLED=1이면 전체, 아니면 빈 그래프
   */
  router.get('/graph', (req, res) => {
    const user = getUserFromReq(req);
    if (!user) {
      // 비로그인: 빈 그래프 반환 (프라이버시 보호)
      return res.json({ nodes: [], edges: [] });
    }
    const graph = user.id === 'local'
      ? getFullGraph(req.query.session, req.query.channel)
      : (getFullGraphForUser
          ? getFullGraphForUser(user.id, req.query.session)
          : getFullGraph(req.query.session, req.query.channel));

    // hidden 이벤트 제외
    if (getHiddenEventIds) {
      const hiddenSet = new Set(getHiddenEventIds(user.id));
      if (hiddenSet.size > 0) {
        graph.nodes = graph.nodes.filter(n => !hiddenSet.has(n.id));
        graph.edges = graph.edges.filter(e => !hiddenSet.has(e.from) && !hiddenSet.has(e.to));
      }
    }

    res.json(graph);
  });

  /**
   * POST /api/claim-local-events
   * 'local' user_id로 저장된 기존 이벤트를 로그인 유저의 것으로 귀속
   */
  router.post('/claim-local-events', (req, res) => {
    const user = getUserFromReq(req);
    if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });
    const changed = claimLocalEvents ? claimLocalEvents(user.id) : 0;
    res.json({ ok: true, claimed: changed });
  });

  // ── 노드 숨김 (소프트 삭제) ─────────────────────────────────────────────────

  /** POST /api/events/hide — 이벤트 숨김 */
  router.post('/events/hide', (req, res) => {
    const user = getUserFromReq(req);
    if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });
    const ids = req.body.eventIds;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'eventIds required' });
    const count = hideEvents(ids, user.id);
    res.json({ ok: true, hidden: count });
  });

  /** POST /api/events/unhide — 이벤트 복원 */
  router.post('/events/unhide', (req, res) => {
    const user = getUserFromReq(req);
    if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });
    const ids = req.body.eventIds;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'eventIds required' });
    const count = unhideEvents(ids, user.id);
    res.json({ ok: true, unhidden: count });
  });

  /** POST /api/events/unhide-all — 모든 숨긴 이벤트 복원 */
  router.post('/events/unhide-all', (req, res) => {
    const user = getUserFromReq(req);
    if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });
    const count = unhideAllEvents(user.id);
    res.json({ ok: true, unhidden: count });
  });

  /** GET /api/events/hidden — 숨긴 이벤트 ID 목록 */
  router.get('/events/hidden', (req, res) => {
    const user = getUserFromReq(req);
    if (!user || user.id === 'local') return res.json({ eventIds: [] });
    const ids = getHiddenEventIds(user.id);
    res.json({ eventIds: ids, count: ids.length });
  });

  // ── 세션 ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/sessions
   * 로그인 시: 해당 유저의 세션만 반환
   */
  router.get('/sessions', (req, res) => {
    const user = getUserFromReq(req);
    if (!user) return res.json([]);                                            // 비로그인: 빈 목록
    const sessions = (user.id !== 'local' && getSessionsByUser)
      ? getSessionsByUser(user.id)
      : getSessions();
    res.json(sessions);
  });

  /**
   * PUT /api/sessions/:id/title
   * 세션의 수동 타이틀을 설정합니다.
   * @body { title: string }
   */
  router.put('/sessions/:id/title', (req, res) => {
    const { id }    = req.params;
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title 필드가 필요합니다.' });
    }
    const result = updateSessionTitle(id, title.slice(0, 80));
    if (result.changes === 0) {
      return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    }
    res.json({ success: true, sessionId: id, title });
  });

  /**
   * GET /api/sessions/:id/context
   * 세션의 첫 메시지 + projectDir 을 반환합니다. (orbit3d 자동 타이틀용)
   */
  router.get('/sessions/:id/context', (req, res) => {
    const { id } = req.params;
    const events  = getEventsBySession(id);

    // projectDir — session.start 이벤트에서
    const sessStart = events.find(e => e.type === 'session.start');
    const projectDir = sessStart?.data?.projectDir || null;
    const projectName = projectDir
      ? projectDir.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      : null;

    // 첫 user.message 내용
    const firstMsg = events.find(e => e.type === 'user.message');
    const firstMsgText = firstMsg?.data?.contentPreview || firstMsg?.data?.content || null;

    // 가장 많이 편집된 파일
    const fileCounts = {};
    for (const e of events) {
      const fp = e.data?.filePath || e.data?.fileName || '';
      const f  = fp.replace(/\\/g, '/').split('/').pop();
      if (f) fileCounts[f] = (fileCounts[f] || 0) + 1;
    }
    const topFile = Object.entries(fileCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // 이벤트 도메인 분류 (파일명 기반)
    const domainCounts = {};
    const DOMAIN_RULES = [
      [/auth|login|oauth|jwt|token|password/, '🔐 인증 구현'],
      [/route|router|api|endpoint|controller/, '🌐 API 개발'],
      [/db|database|schema|migration|model|store/, '🗄️ 데이터'],
      [/component|widget|ui|view|page|style|css/, '🎨 UI 작업'],
      [/test|spec|e2e|jest|vitest/, '🧪 테스트'],
      [/server|app\.js|main|index/, '🚀 서버 개발'],
      [/docker|deploy|ci|cd|yml|yaml/, '🐳 인프라'],
      [/doc|readme|\.md/, '📝 문서화'],
      [/bug|fix|error|issue/, '🔧 버그 수정'],
    ];
    for (const e of events) {
      const fp = (e.data?.filePath || e.data?.fileName || '').toLowerCase();
      for (const [re, label] of DOMAIN_RULES) {
        if (re.test(fp)) { domainCounts[label] = (domainCounts[label]||0) + 1; break; }
      }
    }
    const topDomain = Object.entries(domainCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

    // 자동 타이틀 조합
    const autoTitle = (() => {
      if (projectName && firstMsgText) return `[${projectName}] ${firstMsgText.slice(0, 30)}`;
      if (projectName && topFile)      return `[${projectName}] ${topFile}`;
      if (projectName)                 return projectName;
      if (firstMsgText)                return firstMsgText.slice(0, 40);
      if (topFile)                     return topFile;
      if (topDomain)                   return topDomain;
      // 세션명 readable 변환 (UUID가 아닌 경우, 'session'/'wf' prefix 제거)
      if (!/^[0-9a-f]{8}-/.test(id) && id.length <= 30) {
        const parts = id.split(/[-_]/).filter(s => s && s !== 'session' && s !== 'wf');
        if (parts.length > 0) return parts.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
      }
      return '⚙️ 작업 중';
    })();

    // AI 분류 결과 (캐시에 있으면 즉시 반환, 없으면 비동기 분류 시작)
    let aiLabel = null;
    let aiCat   = null;
    if (_aiClassifier) {
      const cached = _aiClassifier.getSessionClassification(id);
      if (cached) {
        aiLabel = cached.purposeLabel;
        aiCat   = cached.macroCat;
      } else {
        // 비동기로 분류 시작 (다음 요청 시 캐시됨)
        _aiClassifier.classifySession(id, events).catch(() => {});
      }
    }

    res.json({
      sessionId:   id,
      projectDir,
      projectName,
      firstMsg:    firstMsgText,
      topFile,
      autoTitle:   aiLabel || autoTitle,          // AI 라벨 우선
      aiLabel,                                     // AI 생성 목적 라벨
      aiCat,                                       // AI 매크로 카테고리
      eventCount:  events.length,
    });
  });

  // ── 목적 분류 ──────────────────────────────────────────────────────────────

  /**
   * GET /api/purposes/categories
   * @returns {PurposeCategory[]} implement, fix, refactor 등 9개 카테고리 정의
   */
  router.get('/purposes/categories', (req, res) => {
    res.json(Object.values(PURPOSE_CATEGORIES));
  });

  /**
   * GET /api/purposes/summary
   * @query {string} [channel] - 채널 필터
   * @returns {object} { implement: 12, fix: 5, ... }
   */
  router.get('/purposes/summary', (req, res) => {
    const events = _getEventsByQuery(req.query, getAllEvents, getEventsBySession, getEventsByChannel);
    res.json(summarizePurposes(events));
  });

  /**
   * GET /api/purposes
   * @query {string} [channel] - 채널 필터
   * @query {string} [session] - 세션 필터
   * @returns {PurposeWindow[]} 목적 윈도우 목록 (시간순)
   */
  router.get('/purposes', (req, res) => {
    const events = _getEventsByQuery(req.query, getAllEvents, getEventsBySession, getEventsByChannel);
    res.json(classifyPurposes(events));
  });

  // ── 검색 ──────────────────────────────────────────────────────────────────

  /**
   * GET /api/search?q=키워드
   * @query {string} q - 검색 키워드 (이벤트 내용, 파일명, 도구명 대상)
   * @returns {Event[]}
   */
  router.get('/search', (req, res) => {
    const { searchEvents } = db;
    const q = req.query.q;
    if (!q) return res.json([]);
    res.json(searchEvents(q));
  });

  // ── 멤버 / 오버레이 ────────────────────────────────────────────────────────

  /**
   * GET /api/members
   * Claude Code, Zoom, Calendar 등 다양한 소스에서 참여한 멤버를 통합하여 반환합니다.
   * @returns {Member[]} { name, channels, eventCount, sources, lastActive }[]
   */
  router.get('/members', (req, res) => {
    const allEvents   = getAllEvents();
    const allSessions = getSessions();

    // memberName → 집계 정보 맵
    const memberMap = new Map();

    // 세션의 memberName 수집 (Claude Code, Cursor 등)
    for (const session of allSessions) {
      const name = session.memberName || session.userId || 'unknown';
      if (!memberMap.has(name)) {
        memberMap.set(name, { name, channels: new Set(), eventCount: 0, sources: new Set(), lastActive: null });
      }
      const m = memberMap.get(name);
      if (session.channelId) m.channels.add(session.channelId);
    }

    // Zoom 회의 참여자, Calendar 참석자 수집
    for (const event of allEvents) {
      if (event.data?.participant) {
        _addMember(memberMap, event.data.participant, event, 'zoom');
      }
      if (event.data?.attendees) {
        for (const a of event.data.attendees) {
          _addMember(memberMap, a.name || a.email, event, 'calendar');
        }
      }
    }

    const result = [...memberMap.values()]
      .filter(m => m.name !== 'unknown')
      .map(m => ({ name: m.name, channels: [...m.channels], eventCount: m.eventCount, sources: [...m.sources], lastActive: m.lastActive }));

    res.json(result);
  });

  /**
   * GET /api/overlay?members=A,B&from=ISO&to=ISO
   * 여러 멤버의 이벤트를 시간 범위로 조회하여 멤버별 그래프를 반환합니다.
   * @query {string} members - 쉼표 구분 멤버 이름 목록
   * @query {string} [from]  - ISO 8601 시작 시간
   * @query {string} [to]    - ISO 8601 종료 시간
   * @returns {{ overlay: { [name]: Graph }, timeRange: { from, to } }}
   */
  router.get('/overlay', (req, res) => {
    const { annotateEventsWithPurpose } = purposeClassifier;
    const { buildGraph, computeActivityScores, applyActivityVisualization } = deps.graphEngine;

    const memberNames = (req.query.members || '').split(',').filter(Boolean);
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const allEvents = getAllEvents();

    // 시간 범위 필터
    const filtered = allEvents.filter(e => {
      const ts = new Date(e.timestamp);
      if (from && ts < from) return false;
      if (to   && ts > to)   return false;
      return true;
    });

    // 멤버별 이벤트 그룹화 (채널, userId, Zoom 참여자 이름 매칭)
    const byMember = {};
    for (const event of filtered) {
      const candidates = [event.channelId, event.userId, event.data?.participant].filter(Boolean);
      for (const name of memberNames) {
        if (candidates.some(c => c.toLowerCase().includes(name.toLowerCase()))) {
          if (!byMember[name]) byMember[name] = [];
          byMember[name].push(event);
          break;
        }
      }
    }

    // 멤버별 그래프 생성
    const result = {};
    for (const [name, events] of Object.entries(byMember)) {
      const annotated = annotateEventsWithPurpose(events);
      const graph = buildGraph(annotated);
      computeActivityScores(graph.nodes, Date.now());
      applyActivityVisualization(graph.nodes);
      result[name] = graph;
    }

    res.json({ overlay: result, timeRange: { from: from?.toISOString(), to: to?.toISOString() } });
  });

  // ── 파일 / 통계 / 활동 점수 ────────────────────────────────────────────────

  /** GET /api/files → 파일 접근 통계 목록 */
  router.get('/files', (req, res) => {
    const user = getUserFromReq(req);
    if (!user) return res.json([]);                                            // 비로그인: 빈 목록
    res.json(getFiles());
  });

  /** GET /api/stats → 이벤트/세션/파일 수 */
  router.get('/stats', (req, res) => {
    const user = getUserFromReq(req);
    if (!user) return res.json({ events: 0, sessions: 0, files: 0 });         // 비로그인: 빈 통계
    res.json(getStats());
  });

  /**
   * GET /api/activity
   * @returns {{ [nodeId]: number }} 각 노드의 활동 점수 (0.0~1.0, 24h 감쇠)
   */
  router.get('/activity', (req, res) => {
    const graph  = getFullGraph();
    const scores = {};
    for (const node of graph.nodes) scores[node.id] = node.activityScore;
    res.json(scores);
  });

  // ── 스냅샷 / 롤백 / 초기화 ─────────────────────────────────────────────────

  /** GET /api/snapshots → 저장된 스냅샷 파일 목록 */
  router.get('/snapshots', (req, res) => {
    const files = fs.existsSync(SNAPSHOTS_DIR)
      ? fs.readdirSync(SNAPSHOTS_DIR)
          .filter(f => f.endsWith('.json'))
          .map(f => ({ name: f, path: path.join(SNAPSHOTS_DIR, f) }))
      : [];
    res.json(files);
  });

  /**
   * GET /api/turns
   * 전체 이벤트 반환. 구버전 index.html 호환용으로 유지합니다.
   * @deprecated /api/graph 사용 권장
   * @returns {Event[]}
   */
  router.get('/turns', (req, res) => {
    const user = getUserFromReq(req);
    if (!user) return res.json([]);                                            // 비로그인: 빈 목록
    res.json(getAllEvents());
  });

  /**
   * POST /api/rollback/:id
   * 지정 이벤트 ID 이후의 모든 이벤트를 삭제합니다. 되돌리기 불가능.
   * @param {string} id - 유지할 마지막 이벤트 ID
   */
  router.post('/rollback/:id', (req, res) => {
    try {
      rollbackToEvent(req.params.id);

      // JSONL 파일 동기화: DB와 일치시킴
      const remaining = getAllEvents();
      fs.writeFileSync(CONV_FILE, remaining.map(e => JSON.stringify(e)).join('\n') + '\n');

      const graph = getFullGraph();
      broadcastAll({ type: 'graph_update', graph, sessions: getSessions(), stats: getStats() });

      res.json({ success: true, remaining: remaining.length });
    } catch (e) {
      console.error('[ROLLBACK] 오류:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/clear
   * 전체 이벤트, 세션, 주석을 삭제하고 JSONL 파일을 초기화합니다.
   * ⚠️ 되돌리기 불가능. 프로덕션에서는 권한 미들웨어 추가 권장.
   */
  router.delete('/clear', (req, res) => {
    try {
      clearAll();
      fs.writeFileSync(CONV_FILE, '');
      broadcastAll({ type: 'graph_update', graph: { nodes: [], edges: [] }, stats: getStats() });
      res.json({ success: true });
    } catch (e) {
      console.error('[CLEAR] 오류:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ─── 내부 헬퍼 ──────────────────────────────────────────────────────────────

/**
 * query 파라미터에 따라 이벤트 배열을 반환합니다.
 * channel → session → 전체 순으로 우선순위를 적용합니다.
 *
 * @private
 */
function _getEventsByQuery(query, getAllEvents, getEventsBySession, getEventsByChannel) {
  if (query.channel && getEventsByChannel) return getEventsByChannel(query.channel);
  if (query.channel) return getAllEvents().filter(e => e.channelId === query.channel);
  if (query.session) return getEventsBySession(query.session);
  return getAllEvents();
}

/**
 * memberMap에 멤버 정보를 추가/업데이트합니다.
 * @private
 */
function _addMember(memberMap, name, event, source) {
  if (!name) return;
  if (!memberMap.has(name)) {
    memberMap.set(name, { name, channels: new Set(), eventCount: 0, sources: new Set(), lastActive: null });
  }
  const m = memberMap.get(name);
  if (event.channelId) m.channels.add(event.channelId);
  m.sources.add(source);
}

module.exports = createRouter;
