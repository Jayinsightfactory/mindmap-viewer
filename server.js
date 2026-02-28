/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 서버 진입점
 *
 * 역할: WebSocket 서버, 파일 감시, 라우터 조립, 서버 시작
 * 비즈니스 로직은 routes/ 폴더의 각 라우터 파일에 위치합니다.
 *
 * 아키텍처:
 *   server.js          ← 서버 조립 (의존성 주입, 라우터 마운트)
 *   routes/graph.js    ← 그래프·세션·검색·스냅샷
 *   routes/annotations.js ← 주석·사용자 설정·라벨
 *   routes/ai-events.js   ← 멀티 AI 이벤트 수신
 *   routes/analysis.js    ← 코드 분석·컨텍스트 브릿지·충돌 감지
 *   routes/security.js    ← Shadow AI·감사 로그
 *   routes/reports.js     ← 일일·주간 리포트
 *   routes/themes.js      ← 테마 마켓
 *   routes/auth.js        ← 계정 인증
 *   routes/payment.js     ← 결제/구독
 *   routes/growth.js      ← 성장 엔진·솔루션 마켓
 *   routes/community.js   ← 커뮤니티 게시판
 *
 * http://localhost:4747
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const chokidar     = require('chokidar');
const fs           = require('fs');
const path         = require('path');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');

// ─── 의존성 로드 ─────────────────────────────────────────────────────────────
// DATABASE_URL 있으면 PostgreSQL, 없으면 SQLite 자동 선택
const dbModule = process.env.DATABASE_URL
  ? require('./src/db-pg')
  : require('./src/db');

const {
  initDatabase, getAllEvents, getEventsBySession, getEventsByChannel,
  searchEvents, getSessions, getFiles, getAnnotations, insertAnnotation,
  deleteAnnotation, insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
} = dbModule;

const { buildGraph, computeActivityScores, applyActivityVisualization, suggestLabel } = require('./src/graph-engine');
const { annotateEventsWithPurpose, classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES } = require('./src/purpose-classifier');
const { createAnnotationEvent } = require('./src/event-normalizer');
const { getAiStyle, AI_SOURCES }  = require('./adapters/ai-adapter-base');
const { generateReport }          = require('./src/code-analyzer');
const { scanForLeaks }            = require('./src/security-scanner');
const { buildReportData, renderMarkdown, renderSlackBlocks } = require('./src/report-generator');
const { extractContext, renderContextMd, renderContextPrompt, saveContextFile } = require('./src/context-bridge');
const { detectConflicts, checkNewEvent } = require('./src/conflict-detector');
const { appendAuditLog, auditFromEvents, queryAuditLog, verifyIntegrity, renderAuditHtml } = require('./src/audit-log');
const { detectShadowAI, checkEventForShadow, getApprovedSources, addApprovedSource, removeApprovedSource } = require('./src/shadow-ai-detector');
const { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme } = require('./src/theme-store');
const { register: authRegister, login: authLogin, verifyToken, issueApiToken, getUserById, upsertOAuthUser } = require('./src/auth');
const { initOAuthStrategies, createOAuthRouter } = require('./src/auth-oauth');
const { PLANS, createPayment, confirmPayment, MOCK_MODE: paymentMockMode } = require('./src/payment');
const { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates } = require('./src/growth-engine');
const solutionStore  = require('./src/solution-store');
const communityStore = require('./src/community-store');

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────
const createGraphRouter      = require('./routes/graph');
const createAnnotationsRouter = require('./routes/annotations');
const createAiEventsRouter   = require('./routes/ai-events');
const createAnalysisRouter   = require('./routes/analysis');
const createSecurityRouter   = require('./routes/security');
const createReportsRouter    = require('./routes/reports');
const createThemesRouter     = require('./routes/themes');
const createAuthRouter       = require('./routes/auth');
const createPaymentRouter    = require('./routes/payment');
const createGrowthRouter     = require('./routes/growth');
const createCommunityRouter  = require('./routes/community');
const createGitRouter        = require('./routes/git');
const createAvatarsRouter    = require('./routes/avatars');
const createMcpRouter        = require('./src/mcp-server');
const outcomeStore           = require('./src/outcome-store');
const marketStore            = require('./src/market-store');
const usageTracker           = require('./src/usage-tracker');
const createMarketRouter     = require('./routes/market');

// ─── 상수 ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT ? parseInt(process.env.PORT) : 4747;
const CONV_FILE    = path.join(__dirname, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

// ─── 채널(Room) 시스템 ────────────────────────────────────────────────────────
// 각 채널은 독립된 마인드맵 공간. 팀원이 같은 채널에 접속하면 실시간 공유.
const channelClients = new Map();    // channelId → Set<WebSocket>
const wsChannelMap   = new WeakMap(); // ws → { channelId, memberId, memberName, memberColor }

/** 멤버별 색상 팔레트 (순환 할당) */
const MEMBER_COLORS = [
  '#58a6ff','#3fb950','#bc8cff','#f778ba','#ffa657',
  '#39d2c0','#ff9500','#79c0ff','#f85149','#8957e5',
];
let memberColorIdx = 0;

/**
 * 다음 멤버 색상을 순환 할당합니다.
 * @returns {string} HEX 색상 코드
 */
function getMemberColor() {
  const c = MEMBER_COLORS[memberColorIdx % MEMBER_COLORS.length];
  memberColorIdx++;
  return c;
}

// ─── 초기화 ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONV_FILE))    fs.writeFileSync(CONV_FILE, '');
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const db = initDatabase();
console.log('[DB] SQLite 초기화 완료');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── 보안 미들웨어 ────────────────────────────────────────────────────────────
// Helmet: X-Frame-Options, X-Content-Type, CSP 등 보안 헤더 자동 설정
app.use(helmet({
  contentSecurityPolicy: false,  // orbit.html 인라인 스크립트 허용 (개발 편의)
  crossOriginEmbedderPolicy: false,
}));

// Rate Limiting: API 남용 방지 (15분 당 최대 200회)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: req => req.path === '/health',  // 헬스체크 제외
});

// 훅 엔드포인트는 별도 제한 (CI 자동 호출 많음 — 5분 당 500회)
const hookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Hook rate limit exceeded.' },
});

app.use('/api/hook', hookLimiter);
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── OAuth 초기화 ─────────────────────────────────────────────────────────────
const session = require('express-session');
app.use(session({
  secret:            process.env.SESSION_SECRET || 'orbit-session-' + Math.random(),
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000 },
}));

const { passport: oauthPassport, enabledProviders } = initOAuthStrategies({
  upsertOAuthUser,
  getUserById,
  insertToken: issueApiToken,
});
app.use(oauthPassport.initialize());
app.use(oauthPassport.session());

// ─── 그래프 빌드 헬퍼 ────────────────────────────────────────────────────────

/**
 * DB에서 이벤트를 조회해 그래프로 변환합니다.
 * 목적 자동 분류 → 활동 점수 계산 → 시각화 속성 적용 순서로 처리합니다.
 * @param {string} [sessionFilter]  - 세션 ID 필터
 * @param {string} [channelFilter]  - 채널 ID 필터
 * @returns {{ nodes: Node[], edges: Edge[] }}
 */
function getFullGraph(sessionFilter, channelFilter) {
  const rawEvents = sessionFilter
    ? getEventsBySession(sessionFilter)
    : channelFilter
      ? (getEventsByChannel
          ? getEventsByChannel(channelFilter)
          : getAllEvents().filter(e => e.channelId === channelFilter))
      : getAllEvents();

  const events = annotateEventsWithPurpose(rawEvents);
  const graph  = buildGraph(events);
  computeActivityScores(graph.nodes, Date.now());
  applyActivityVisualization(graph.nodes);
  return graph;
}

// ─── 브로드캐스트 ────────────────────────────────────────────────────────────

/**
 * 특정 채널의 모든 WebSocket 클라이언트에 메시지를 전송합니다.
 * @param {string} channelId - 대상 채널 ID
 * @param {object} msg       - 전송할 메시지 객체
 */
function broadcastToChannel(channelId, msg) {
  const clients = channelClients.get(channelId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

/**
 * 연결된 모든 WebSocket 클라이언트에 메시지를 전송합니다.
 * @param {object} msg - 전송할 메시지 객체
 */
function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

/**
 * 채널의 현재 접속 멤버 정보 배열을 반환합니다.
 * @param {string} channelId
 * @returns {{ memberId, memberName, memberColor }[]}
 */
function getChannelMembers(channelId) {
  const clients = channelClients.get(channelId);
  if (!clients) return [];
  return Array.from(clients).map(ws => wsChannelMap.get(ws)).filter(Boolean);
}

// ─── WebSocket 서버 ──────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] 클라이언트 연결됨');

  // 초기 접속: 채널 미지정 상태로 현재 그래프 전송
  try {
    ws.send(JSON.stringify({
      type:       'init',
      graph:      getFullGraph(),
      sessions:   getSessions(),
      stats:      getStats(),
      userConfig: getUserConfig(),
    }));
  } catch (e) {
    console.error('[WS] init 오류:', e.message);
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ── 채널 입장 ────────────────────────────────────────────────────────
      if (msg.type === 'channel.join') {
        const channelId   = (msg.channelId  || 'default').trim();
        const memberName  = (msg.memberName || '익명').substring(0, 20);
        const memberId    = msg.memberId || `m_${Date.now()}`;
        const memberColor = getMemberColor();

        // 기존 채널 퇴장
        const prev = wsChannelMap.get(ws);
        if (prev) {
          const prevClients = channelClients.get(prev.channelId);
          if (prevClients) {
            prevClients.delete(ws);
            if (prevClients.size === 0) channelClients.delete(prev.channelId);
          }
          broadcastToChannel(prev.channelId, {
            type:       'channel.member_left',
            memberId:   prev.memberId,
            memberName: prev.memberName,
            members:    getChannelMembers(prev.channelId),
          });
        }

        // 새 채널 입장
        if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
        channelClients.get(channelId).add(ws);
        wsChannelMap.set(ws, { channelId, memberId, memberName, memberColor });

        // 이 클라이언트에 채널 정보 전송
        ws.send(JSON.stringify({
          type:        'channel.joined',
          channelId, memberId, memberName, memberColor,
          members:  getChannelMembers(channelId),
          graph:    getFullGraph(),
          sessions: getSessions(),
          stats:    getStats(),
        }));

        // 같은 채널 다른 멤버들에게 입장 알림
        broadcastToChannel(channelId, {
          type: 'channel.member_joined',
          memberId, memberName, memberColor,
          members: getChannelMembers(channelId),
        });

        console.log(`[CHANNEL] "${memberName}" → #${channelId} (총 ${channelClients.get(channelId).size}명)`);
        return;
      }

      // ── 채널 내 커서/활동 브로드캐스트 ─────────────────────────────────
      if (msg.type === 'channel.activity') {
        const info = wsChannelMap.get(ws);
        if (info) {
          broadcastToChannel(info.channelId, {
            type:        'channel.activity',
            memberId:    info.memberId,
            memberName:  info.memberName,
            memberColor: info.memberColor,
            action:      msg.action,  // 'hover_node', 'select_node', 'typing' 등
            nodeId:      msg.nodeId,
          });
        }
        return;
      }

      // ── 주석 생성 ────────────────────────────────────────────────────────
      if (msg.type === 'annotation.create') {
        const event = createAnnotationEvent(msg.data);
        insertEvent(event);

        const entry = {
          id: event.id, type: event.type, source: event.source,
          sessionId: event.sessionId, parentEventId: event.parentEventId,
          data: event.data, ts: event.timestamp,
        };
        fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');

        const info      = wsChannelMap.get(ws);
        const channelId = info?.channelId;
        const payload   = { type: 'event', event, graph: getFullGraph() };

        if (channelId) broadcastToChannel(channelId, payload);
        else           broadcastAll(payload);
      }

      // ── 세션 필터 ────────────────────────────────────────────────────────
      if (msg.type === 'filter') {
        ws.send(JSON.stringify({ type: 'filtered', graph: getFullGraph(msg.sessionId) }));
      }

    } catch (e) {
      console.error('[WS] message 처리 오류:', e.message);
    }
  });

  ws.on('close', () => {
    const info = wsChannelMap.get(ws);
    if (info) {
      const { channelId, memberId, memberName } = info;
      const clients = channelClients.get(channelId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) channelClients.delete(channelId);
      }
      broadcastToChannel(channelId, {
        type: 'channel.member_left',
        memberId, memberName,
        members: getChannelMembers(channelId),
      });
      console.log(`[CHANNEL] "${memberName}" 퇴장 (#${channelId})`);
    }
    console.log('[WS] 클라이언트 연결 종료');
  });

  ws.on('error', e => console.error('[WS] 에러:', e.message));
});

// ─── 이벤트 수신 훅 ──────────────────────────────────────────────────────────

/**
 * POST /api/hook
 * Claude Code / orbit CLI 에서 직접 이벤트를 전송합니다.
 * 파일 감시 대신 HTTP POST 를 사용하면 지연 없이 실시간으로 이벤트를 처리합니다.
 * @body {{ events: MindmapEvent[], channelId?: string, memberName?: string }}
 */
app.post('/api/hook', (req, res) => {
  try {
    const { events = [], channelId = 'default', memberName = 'Claude' } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events 배열 필요' });
    }

    // DB + JSONL 저장 (save-turn.js 에서 이미 저장한 경우 중복 방지)
    for (const event of events) {
      try { insertEvent(event); } catch {}
      try {
        const entry = {
          id: event.id, type: event.type, source: event.source,
          sessionId: event.sessionId, parentEventId: event.parentEventId,
          data: event.data, ts: event.timestamp,
        };
        fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
      } catch {}
    }

    const graph    = getFullGraph();
    const stats    = getStats();
    const sessions = getSessions();

    // tool.end 이벤트 → 완료된 tool.start 노드 ID 추출 (FX 완료 효과용)
    const completedToolStarts = [];
    for (const ev of events) {
      if (ev.type === 'tool.end' || ev.type === 'tool.error') {
        const startNode = graph.nodes.find(n =>
          (n.eventType || n.type) === 'tool.start' && n.sessionId === ev.sessionId
        );
        if (startNode) completedToolStarts.push(startNode.id);
      }
    }

    // 보안 유출 스캔
    const leaks = scanForLeaks(events);
    if (leaks.length > 0) {
      const criticals = leaks.filter(l => l.severity === 'critical');
      console.warn(`[SECURITY] ⚠️ 유출 감지 ${leaks.length}건 (critical: ${criticals.length}건) — 채널: #${channelId}`);
    }

    // 감사 로그 기록
    auditFromEvents(events);

    // Shadow AI 실시간 감지
    const shadowFindings = [];
    for (const ev of events) {
      const found = checkEventForShadow(ev);
      shadowFindings.push(...found);
    }
    if (shadowFindings.length > 0) {
      console.warn(`[SHADOW AI] ⚠️ 비승인 AI 감지 ${shadowFindings.length}건 — 채널: #${channelId}`);
      shadowFindings.forEach(f => appendAuditLog('shadow.ai.detected', f, { channel: channelId }));
    }

    // 충돌 감지
    const recentEventsForConflict = getAllEvents().slice(-200);
    const newConflicts = [];
    for (const ev of events) {
      const found = checkNewEvent(ev, recentEventsForConflict);
      newConflicts.push(...found);
    }
    if (newConflicts.length > 0) {
      console.warn(`[CONFLICT] ⚠️ 충돌 감지 ${newConflicts.length}건 — 채널: #${channelId}`);
    }

    const payload = {
      type: 'update',
      graph, stats, sessions, completedToolStarts,
      hookSource:   { channelId, memberName },
      securityLeaks: leaks,
      conflicts:     newConflicts,
      shadowAI:      shadowFindings,
    };

    if (channelClients.has(channelId)) broadcastToChannel(channelId, payload);
    else                               broadcastAll(payload);

    console.log(`[HOOK] ${events.length}개 이벤트 수신 (채널: #${channelId}, ${memberName})`);
    res.json({ success: true, received: events.length, leaksDetected: leaks.length });
  } catch (e) {
    console.error('[HOOK] 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 채널 목록 조회
app.get('/api/channels', (req, res) => {
  const channels = [];
  channelClients.forEach((clients, channelId) => {
    channels.push({
      id:          channelId,
      memberCount: clients.size,
      members:     getChannelMembers(channelId),
    });
  });
  res.json(channels);
});

// 헬스체크 (Docker / Railway / Render 배포 플랫폼용)
app.get('/health', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      status:    'ok',
      version:   '2.0.0',
      uptime:    Math.round(process.uptime()),
      events:    stats.eventCount,
      sessions:  stats.sessionCount,
      channels:  channelClients.size,
      clients:   wss.clients.size,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ─── 라우터 의존성 조립 + 마운트 ─────────────────────────────────────────────
// 각 라우터는 createRouter(deps) 패턴으로 의존성을 주입받습니다.
// deps 에 mock 객체를 주입하면 테스트 시 DB 없이 단위 테스트 가능합니다.

/** 공용 db 의존성 객체 — DB 함수들을 한 곳에서 관리 */
const dbDeps = {
  getAllEvents, getEventsBySession, getEventsByChannel: getEventsByChannel || null,
  getSessions, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
  insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
  searchEvents,
};

app.use('/api', createGraphRouter({
  getFullGraph, broadcastAll, broadcastToChannel,
  db: dbDeps,
  purposeClassifier: { classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES, annotateEventsWithPurpose },
  graphEngine: { buildGraph, computeActivityScores, applyActivityVisualization },
  CONV_FILE, SNAPSHOTS_DIR,
}));

app.use('/api', createAnnotationsRouter({
  broadcastAll,
  db: dbDeps,
  eventNormalizer: { createAnnotationEvent },
  graphEngine: { suggestLabel },
}));

app.use('/api', createAiEventsRouter({
  broadcastAll,
  db: dbDeps,
  aiAdapter: { getAiStyle, AI_SOURCES },
  getFullGraph,
}));

app.use('/api', createAnalysisRouter({
  db: dbDeps,
  codeAnalyzer: { generateReport },
  contextBridge: { extractContext, renderContextMd, renderContextPrompt, saveContextFile },
  conflictDetector: { detectConflicts },
}));

app.use('/api', createSecurityRouter({
  db: dbDeps,
  shadowAiDetector: { detectShadowAI, getApprovedSources, addApprovedSource, removeApprovedSource },
  auditLog: { queryAuditLog, verifyIntegrity, renderAuditHtml },
}));

app.use('/api', createReportsRouter({
  db: dbDeps,
  reportGenerator: { buildReportData, renderMarkdown, renderSlackBlocks },
}));

app.use('/api', createThemesRouter({
  themeStore: { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme },
}));

app.use('/api', createAuthRouter({
  auth: { register: authRegister, login: authLogin, verifyToken },
}));

// OAuth 소셜 로그인 (Google, GitHub)
const oauthRouter = createOAuthRouter({
  passport:  oauthPassport,
  enabledProviders,
  insertToken: issueApiToken,
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`,
});
app.use('/api/auth', oauthRouter);

app.use('/api', createPaymentRouter({
  payment: { PLANS, createPayment, confirmPayment, MOCK_MODE: paymentMockMode },
}));

app.use('/api', createGrowthRouter({
  growthEngine:  { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates },
  solutionStore,
  db: dbDeps,
}));

app.use('/api', createCommunityRouter({
  communityStore,
}));

app.use('/api', createGitRouter({
  insertEvent,
  broadcastAll,
}));

const { authMiddleware, optionalAuth } = require('./src/auth');
app.use('/api', createAvatarsRouter({ authMiddleware, optionalAuth }));

// ─── 수익 공유 마켓 2.0 ──────────────────────────────────────────────────────
app.use('/api', createMarketRouter({ marketStore, authMiddleware, optionalAuth }));

// ─── MCP 서버 (Claude Desktop 연동) ─────────────────────────────────────────
app.use('/api', createMcpRouter({
  getAllEvents,
  getStats,
  getSessions,
  getInsights:    () => require('./src/insight-engine').getInsights(50),
  getPatterns,
  getSuggestions,
  getOutcomes:    outcomeStore.getOutcomes,
  saveOutcome:    outcomeStore.saveOutcome,
  analyzeEvents:  require('./src/insight-engine').analyzeEvents,
  searchEvents,
}));

// ─── JSONL 파일 감시 (레거시 이벤트 소스 지원) ───────────────────────────────
// /api/hook 를 사용하지 않는 구버전 save-turn.js 호환용
let lastBytePos = 0;
try { lastBytePos = fs.statSync(CONV_FILE).size; } catch {}

chokidar.watch(CONV_FILE, {
  usePolling:       true,
  interval:         300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
}).on('change', () => {
  try {
    const stat = fs.statSync(CONV_FILE);
    if (stat.size <= lastBytePos) {
      lastBytePos = stat.size;
      return;
    }

    const fd  = fs.openSync(CONV_FILE, 'r');
    const buf = Buffer.alloc(stat.size - lastBytePos);
    fs.readSync(fd, buf, 0, buf.length, lastBytePos);
    fs.closeSync(fd);
    lastBytePos = stat.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (lines.length > 0) {
      const graph    = getFullGraph();
      const stats    = getStats();
      const sessions = getSessions();

      // tool.end 완료 노드 추출
      const completedToolStarts = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'tool.end' || ev.type === 'tool.error') {
            const startNode = graph.nodes.find(n =>
              (n.eventType || n.type) === 'tool.start' && n.sessionId === ev.sessionId
            );
            if (startNode) completedToolStarts.push(startNode.id);
          }
        } catch {}
      }

      broadcastAll({ type: 'update', graph, stats, sessions, completedToolStarts });
      console.log(`[WATCH] ${lines.length}개 새 이벤트 감지 → 그래프 업데이트`);
    }
  } catch (e) {
    console.error('[WATCH] 오류:', e.message);
  }
});

// ─── 활동 점수 주기적 업데이트 (10초) ───────────────────────────────────────
setInterval(() => {
  if (wss.clients.size === 0) return;
  try {
    const graph  = buildGraph(getAllEvents());
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);

    const scores = {};
    for (const node of graph.nodes) {
      scores[node.id] = {
        activityScore: node.activityScore,
        size:          node.size,
        borderWidth:   node.borderWidth,
        shadow:        node.shadow,
      };
    }
    broadcastAll({ type: 'activity', scores });
  } catch (e) {
    console.error('[ACTIVITY] 오류:', e.message);
  }
}, 10000);

// ─── 인사이트 엔진 ────────────────────────────────────────────────────────────
const insightEngine = require('./src/insight-engine');

// /api/insights — 최근 인사이트 조회
app.get('/api/insights', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(insightEngine.getInsights(limit));
});

// /api/insights/run — 즉시 분석 실행 (POST)
app.post('/api/insights/run', async (req, res) => {
  const { analyzeAndSuggest: saveSuggestion } = require('./src/growth-engine');
  const results = await insightEngine.runOnce({ getAllEvents, saveSuggestion, broadcastAll });
  res.json({ ok: true, count: results.length, insights: results });
});

// ─── 서버 시작 ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const stats = getStats();
  console.log(`\n⬡ Orbit AI v2.0.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   이벤트: ${stats.eventCount}개 | 세션: ${stats.sessionCount}개 | 파일: ${stats.fileCount}개`);
  console.log(`   감시 파일: ${CONV_FILE}`);
  console.log(`   OAuth: [${enabledProviders.join(', ') || '미설정'}]`);
  console.log(`   Git hooks 설치: curl http://localhost:${PORT}/api/git/install | bash`);
  console.log(`   MCP 서버: http://localhost:${PORT}/api/mcp`);
  console.log(`   마켓 2.0: http://localhost:${PORT}/api/market/leaderboard\n`);

  // outcome 테이블 초기화 (기존 DB에 테이블 없으면 생성)
  outcomeStore.initOutcomeTable();

  // 마켓 테이블 초기화 + 사용량 트래커 시작
  marketStore.initMarketTables();
  usageTracker.start({ broadcastAll });

  // 인사이트 엔진 자동 시작 (INSIGHT_DISABLED=1 이면 스킵)
  if (process.env.INSIGHT_DISABLED !== '1') {
    const { analyzeAndSuggest: saveSuggestion } = require('./src/growth-engine');
    insightEngine.start({ getAllEvents, saveSuggestion, broadcastAll });
  }
});
