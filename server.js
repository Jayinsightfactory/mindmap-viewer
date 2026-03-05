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

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const chokidar     = require('chokidar');
const fs           = require('fs');
const path         = require('path');
// rate-limit: 인메모리 구현 (express-rate-limit v8 Railway 프록시 호환 문제 대체)
const _rlStore = new Map();
setInterval(() => _rlStore.clear(), 15 * 60 * 1000); // 15분마다 리셋
const rateLimit = ({ windowMs = 900000, max = 2000 } = {}) => (req, res, next) => {
  const key = req.ip || 'unknown';
  const entry = _rlStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > entry.resetAt) { entry.count = 0; entry.resetAt = Date.now() + windowMs; }
  if (++entry.count > max) return res.status(429).json({ error: 'Too many requests' });
  _rlStore.set(key, entry);
  next();
};
const helmet       = require('helmet');

// ─── 의존성 로드 ─────────────────────────────────────────────────────────────
// DATABASE_URL 있으면 PostgreSQL, 없으면 SQLite 자동 선택
const dbModule = process.env.DATABASE_URL
  ? require('./src/db-pg')
  : require('./src/db');

const {
  initDatabase, getAllEvents, getEventsBySession, getEventsByChannel,
  searchEvents, getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation,
  deleteAnnotation, insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
  getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
  hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds,
  getNodeMemos, upsertNodeMemo, deleteNodeMemo,
  getBookmarks, addBookmark, removeBookmark,
  touchTrackerPing, getTrackerPing,
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
const { register: authRegister, login: authLogin, verifyToken, issueApiToken, getUserById, upsertOAuthUser,
  saveOAuthTokens, getOAuthTokens, refreshGoogleAccessToken, getValidGoogleToken, getGoogleOAuthUsers } = require('./src/auth');
const gdriveUserBackup = require('./src/gdrive-user-backup');
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
const createModelRouter      = require('./routes/model');
const createPortfolioRouter  = require('./routes/portfolio');
const modelTrainer           = require('./src/model-trainer');
const outcomeStore           = require('./src/outcome-store');
const marketStore            = require('./src/market-store');
const usageTracker           = require('./src/usage-tracker');
const createMarketRouter          = require('./routes/market');
const createPersonalInsightsRouter  = require('./routes/personal-insights');
const createCostTrackerRouter       = require('./routes/cost-tracker');
const createWebhooksRouter          = require('./routes/webhooks');
const revenueScheduler              = require('./src/revenue-scheduler');
const mcpWatcher                    = require('./src/mcp-watcher');
const createBadgeRouter             = require('./routes/badge');
const createShareRouter             = require('./routes/share');
const createOntologyRouter          = require('./routes/ontology');
const createLeaderboardRouter       = require('./routes/leaderboard');
const createRoiRouter               = require('./routes/roi');
const createAnalyticsRouter          = require('./routes/analytics');
const createProfileRouter            = require('./routes/profile');
const createFollowRouter             = require('./routes/follow');
const createChatRouter               = require('./routes/chat');
const { createRegionalInsightRouter } = require('./src/regional-insight');
const { createPointsRouter }          = require('./src/points-engine');
const { createCertificateRouter }     = require('./src/certificate-engine');
const signalEngine                    = require('./src/signal-engine');
const diffLearner                     = require('./src/diff-learner');
const dualSkillEngine                 = require('./src/dual-skill-engine');
const createWorkspaceRouter           = require('./routes/workspace');
const ollamaAnalyzer                  = require('./src/ollama-analyzer'); // Ollama 실시간 분석

// ─── 회사 컨설팅 플랫폼 (Palantir for SMEs) ──────────────────────────────────
const createCompanyRouter             = require('./routes/company');
const createDiagnosisRouter           = require('./routes/diagnosis');
const createCompanyLearningRouter     = require('./routes/company-learning');
const companyOntology                 = require('./src/company-ontology');
const companyCrawler                  = require('./src/company-crawler');

// ─── 상수 ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT ? parseInt(process.env.PORT) : 4747;
const _dataRoot     = process.env.DATA_DIR || __dirname;
const CONV_FILE    = path.join(_dataRoot, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(_dataRoot, 'snapshots');

// ─── 채널(Room) 시스템 ────────────────────────────────────────────────────────
// 각 채널은 독립된 마인드맵 공간. 팀원이 같은 채널에 접속하면 실시간 공유.
const channelClients = new Map();    // channelId → Set<WebSocket>
const wsChannelMap   = new WeakMap(); // ws → { channelId, memberId, memberName, memberColor }

// ── 메신저 채팅 방 구독 ─────────────────────────────────────────────────────
const chatRoomClients = new Map();   // chatRoomId → Set<WebSocket>
const wsChatRoomMap   = new WeakMap(); // ws → Set<chatRoomId>

function broadcastToRoom(roomId, msg) {
  const clients = chatRoomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch {}
    }
  });
}

function subscribeChatRoom(ws, roomId) {
  if (!chatRoomClients.has(roomId)) chatRoomClients.set(roomId, new Set());
  chatRoomClients.get(roomId).add(ws);
  if (!wsChatRoomMap.has(ws)) wsChatRoomMap.set(ws, new Set());
  wsChatRoomMap.get(ws).add(roomId);
}

function unsubscribeChatRooms(ws) {
  const rooms = wsChatRoomMap.get(ws);
  if (!rooms) return;
  rooms.forEach(roomId => {
    const clients = chatRoomClients.get(roomId);
    if (clients) { clients.delete(ws); if (clients.size === 0) chatRoomClients.delete(roomId); }
  });
  wsChatRoomMap.delete(ws);
}

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
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── 보안 미들웨어 ────────────────────────────────────────────────────────────
// Helmet: X-Frame-Options, X-Content-Type, CSP 등 보안 헤더 자동 설정
app.use(helmet({
  contentSecurityPolicy: false,       // orbit.html 인라인 스크립트 허용 (개발 편의)
  crossOriginEmbedderPolicy: false,   // Three.js CDN 허용
  crossOriginOpenerPolicy: false,     // MCP 브라우저 확장 탭 접근 허용 (개발)
  crossOriginResourcePolicy: false,   // 외부 리소스 로드 허용 (개발)
}));

// Rate Limiting: API 남용 방지 (15분 당 최대 2000회)
const _rlOpts = { validate: { xForwardedForHeader: false, trustProxy: false, ip: false } };
const apiLimiter = rateLimit({
  ..._rlOpts,
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  message: { error: 'Too many requests, please try again later.' },
  skip: req => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const isPolling = req.path === '/health' || req.path === '/api/signal' || req.path === '/api/learn/suggestions';
    return isLocal || isPolling;
  },
});

// 훅 엔드포인트는 별도 제한 (CI 자동 호출 많음 — 5분 당 500회)
const hookLimiter = rateLimit({
  ..._rlOpts,
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
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
  saveOAuthTokens,
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

// 특정 user_id의 이벤트만 그래프로 변환 (프라이버시 격리)
function getFullGraphForUser(userId, sessionFilter) {
  const rawEvents = sessionFilter
    ? getEventsBySession(sessionFilter).filter(e => e.userId === userId)
    : (getEventsByUser ? getEventsByUser(userId) : getAllEvents().filter(e => e.userId === userId));
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

// Ollama 분석기 초기화 (broadcastAll 정의 직후)
ollamaAnalyzer.init(broadcastAll);

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

      // ── 메신저 채팅 방 구독 ───────────────────────────────────────────────
      if (msg.type === 'chat.subscribe') {
        const roomId = msg.roomId;
        if (roomId) subscribeChatRoom(ws, roomId);
        return;
      }
      if (msg.type === 'chat.unsubscribe') {
        const roomId = msg.roomId;
        if (roomId) {
          const clients = chatRoomClients.get(roomId);
          if (clients) clients.delete(ws);
          const myRooms = wsChatRoomMap.get(ws);
          if (myRooms) myRooms.delete(roomId);
        }
        return;
      }

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
    unsubscribeChatRooms(ws); // 채팅 방 구독 정리
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

    // Authorization 헤더로 user_id 결정 (토큰 있으면 해당 유저, 없으면 'local')
    const hookToken = (req.headers.authorization || '').replace('Bearer ', '').trim()
                    || req.headers['x-api-token'] || '';
    const hookUser  = hookToken ? verifyToken(hookToken) : null;
    const hookUserId = hookUser ? hookUser.id : 'local';

    // DB + JSONL 저장 (save-turn.js 에서 이미 저장한 경우 중복 방지)
    for (const event of events) {
      // user_id를 토큰에서 추출한 값으로 덮어쓰기 (프라이버시 격리)
      if (hookUserId !== 'local') event.userId = hookUserId;
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

    // Ollama 실시간 분석 (이벤트 큐에 추가)
    for (const ev of events) ollamaAnalyzer.addEvent(ev);

    // ── 트래커 핑 자동 갱신 (hook 이벤트 수신 → 온라인 표시) ──────────────
    if (hookUserId && hookUserId !== 'local') {
      try {
        const authDb = require('./src/auth').getDb();
        if (authDb) {
          authDb.prepare(`
            INSERT INTO tracker_pings (userId, hostname, eventCount, lastSeen)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(userId) DO UPDATE SET eventCount=eventCount+?, lastSeen=?
          `).run(hookUserId, '', events.length, Date.now(),
                 events.length, Date.now());
        }
      } catch {}
    }

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

// ── 트래커 핑 (로컬 서버 → Railway로 주기적 보고) ─────────────────────────
// DB 기반 — 배포해도 상태 유지됨
app.post('/api/tracker/ping', (req, res) => {
  try {
    const { userId: bodyUserId, hostname, eventCount } = req.body || {};

    // 1) Authorization 토큰으로 사용자 식별
    const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    let resolvedUserId = bodyUserId || '';
    if (authToken && !resolvedUserId) {
      try {
        const user = verifyToken(authToken);
        if (user) resolvedUserId = user.id;
      } catch {}
    }
    if (!resolvedUserId) resolvedUserId = req.ip; // fallback

    // 2) DB에 upsert
    try {
      const authDb = require('./src/auth').getDb();
      if (authDb) {
        authDb.prepare(`
          INSERT INTO tracker_pings (userId, hostname, eventCount, lastSeen)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(userId) DO UPDATE SET hostname=?, eventCount=?, lastSeen=?
        `).run(resolvedUserId, hostname || '', eventCount || 0, Date.now(),
               hostname || '', eventCount || 0, Date.now());
      }
    } catch (dbErr) {
      console.warn('[tracker/ping] DB 저장 실패:', dbErr.message);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 트래커 상태 조회 (대시보드에서 연결 확인용)
app.get('/api/tracker/status', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    let userId = '';

    // 토큰으로 사용자 식별
    if (token) {
      try {
        const user = verifyToken(token);
        if (user) userId = user.id;
      } catch {}
    }

    if (!userId) {
      return res.json({ online: false, lastSeen: null, hostname: null, eventCount: 0 });
    }

    // DB에서 핑 조회
    let ping = null;
    try {
      const authDb = require('./src/auth').getDb();
      if (authDb) {
        ping = authDb.prepare('SELECT * FROM tracker_pings WHERE userId = ?').get(userId);
      }
    } catch {}

    const isOnline = ping && (Date.now() - ping.lastSeen < 6 * 60 * 1000); // 6분 이내
    res.json({
      online:     !!isOnline,
      lastSeen:   ping?.lastSeen || null,
      hostname:   ping?.hostname || null,
      eventCount: ping?.eventCount || 0,
    });
  } catch (e) {
    res.json({ online: false, lastSeen: null });
  }
});

// ── 토큰 등록 (로컬 PC에 ~/.orbit-config.json 저장) ─────────────────────────
// 프론트엔드 _postLoginSync → 이 엔드포인트 호출 → save-turn.js가 토큰 사용
app.post('/api/register-hook-token', (req, res) => {
  try {
    const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const user = verifyToken(authToken);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const os = require('os');
    const cfgPath = path.join(os.homedir(), '.orbit-config.json');

    // 기존 설정 로드 후 병합
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}

    const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;

    cfg.token = authToken;
    cfg.userId = user.id;
    cfg.serverUrl = serverUrl;
    cfg.pcId = require('crypto').createHash('sha256')
      .update(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`)
      .digest('hex').slice(0, 16);

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`[register-hook-token] ${user.email} → ${cfgPath}`);
    res.json({ ok: true, pcId: cfg.pcId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 라우터 의존성 조립 + 마운트 ─────────────────────────────────────────────
// 각 라우터는 createRouter(deps) 패턴으로 의존성을 주입받습니다.
// deps 에 mock 객체를 주입하면 테스트 시 DB 없이 단위 테스트 가능합니다.

/** 공용 db 의존성 객체 — DB 함수들을 한 곳에서 관리 */
const dbDeps = {
  getAllEvents, getEventsBySession, getEventsByChannel: getEventsByChannel || null,
  getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
  insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
  searchEvents,
  getNodeMemos, upsertNodeMemo, deleteNodeMemo,
  getBookmarks, addBookmark, removeBookmark,
  touchTrackerPing, getTrackerPing,
};

app.use('/api', createGraphRouter({
  getFullGraph, getFullGraphForUser, broadcastAll, broadcastToChannel,
  db: { ...dbDeps, getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
        hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds },
  purposeClassifier: { classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES, annotateEventsWithPurpose },
  graphEngine: { buildGraph, computeActivityScores, applyActivityVisualization },
  CONV_FILE, SNAPSHOTS_DIR,
  verifyToken,
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

// Tesla FSD 방식 원시 신호 감지 엔진
app.use('/api/signal', signalEngine.createRouter());

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

// ─── 현재 유저 정보 + API 토큰 발급 ─────────────────────────────────────────
// GET /api/me — 내 정보 반환 (이미 session 토큰 보유 전제)
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
              || req.query.token || req.cookies?.orbit_token;
  const user  = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: user.id, email: user.email, name: user.name, plan: user.plan });
});

// ─── 수익 공유 마켓 2.0 ──────────────────────────────────────────────────────
app.use('/api', createMarketRouter({ marketStore, authMiddleware, optionalAuth }));

// ─── Ollama 커스텀 모델 관리 ──────────────────────────────────────────────────
app.use('/api', createModelRouter({ getAllEvents, modelTrainer, broadcastAll }));

// ─── AI 역량 포트폴리오 PDF ──────────────────────────────────────────────────
app.use('/api', createPortfolioRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth }));

// ─── 개인/팀 인사이트 분리 ───────────────────────────────────────────────────
app.use('/api', createPersonalInsightsRouter({
  getAllEvents,
  getStats,
  getSessions,
  authMiddleware: require('./src/auth').authMiddleware,
  optionalAuth:   require('./src/auth').optionalAuth,
  getInsights:    () => require('./src/insight-engine').getInsights(100),
}));

// ─── AI 토큰 비용 추적 ────────────────────────────────────────────────────────
app.use('/api', createCostTrackerRouter({ getAllEvents, getSessions, optionalAuth: require('./src/auth').optionalAuth }));

// ─── 외부 도구 웹훅 수신 (n8n / Slack / Notion / GitHub) ─────────────────────
app.use('/api', createWebhooksRouter({ insertEvent, broadcastAll }));

// ─── MCP Market Watcher ───────────────────────────────────────────────────────
app.use('/api', mcpWatcher.createMcpWatcherRouter({ getAllEvents }));

// ─── Orbit Badge SVG ─────────────────────────────────────────────────────────
app.use('/api', createBadgeRouter({ getAllEvents, getSessions, optionalAuth }));

// ─── Share My Session ────────────────────────────────────────────────────────
app.use('/api', createShareRouter({ getAllEvents, getSessions, getEventsBySession, insertEvent, broadcastAll, optionalAuth }));

// ─── Team Ontology Graph ──────────────────────────────────────────────────────
app.use('/api', createOntologyRouter({ getAllEvents, getFiles, optionalAuth }));

// ─── AI Leaderboard ───────────────────────────────────────────────────────────
app.use('/api', createLeaderboardRouter({ getAllEvents, getSessions, optionalAuth }));

// ─── ROI Calculator ───────────────────────────────────────────────────────────
app.use('/api', createRoiRouter({ getAllEvents, getSessions, optionalAuth }));

// ─── Analytics (사용자 행동 분석) ────────────────────────────────────────────
app.use('/api', createAnalyticsRouter({ getDb: dbModule.getDb }));
app.use('/api', createProfileRouter({ getDb: dbModule.getDb, verifyToken }));
app.use('/api', createFollowRouter({ getDb: dbModule.getDb, verifyToken }));
app.use('/api', createChatRouter({ getDb: dbModule.getDb, verifyToken, broadcastToRoom }));

// ─── Workspace (팀/회사 관리) ─────────────────────────────────────────────────
app.use('/api', createWorkspaceRouter({ db: dbModule.getDb ? dbModule.getDb() : null, verifyToken }));

// ─── Google Drive 사용자 백업 ────────────────────────────────────────────────
const createGdriveRouter = require('./routes/gdrive');
app.use('/api', createGdriveRouter({
  verifyToken,
  auth: { getValidGoogleToken, getOAuthTokens, saveOAuthTokens },
  dbModule: { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent },
  gdriveUserBackup,
}));

// ─── Regional Insight ────────────────────────────────────────────────────────
app.use('/api', createRegionalInsightRouter({ getAllEvents }));

// ─── Orbit Points Economy ────────────────────────────────────────────────────
app.use('/api', createPointsRouter({ getAllEvents, getSessions, optionalAuth }));

// ─── Orbit Certificate & Score ───────────────────────────────────────────────
app.use('/api', createCertificateRouter({ getAllEvents, getSessions, optionalAuth }));

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

// ─── LLM 프로바이더 설정 (API 키 CRUD + 테스트 + generate) ──────────────────
const createLlmSettingsRouter = require('./routes/llm-settings');
app.use('/api', createLlmSettingsRouter({ getDb: dbModule.getDb }));

// ─── 실행 패널 (generate / execute / ai-status) ──────────────────────────────
const createExecRouter = require('./routes/exec');
app.use('/api', createExecRouter({ getAllEvents, broadcastAll, getDb: dbModule.getDb }));

// ─── 환경 감지 + 원키 설치 + Claude 트래킹 ───────────────────────────────────
const createSetupRouter = require('./routes/setup');
app.use('/api', createSetupRouter({ getAllEvents, getDb: dbModule.getDb, port: PORT }));

// ─── 목적(Purpose) 타임라인 ──────────────────────────────────────────────────
const createPurposesRouter = require('./routes/purposes');
app.use('/api', createPurposesRouter({ getAllEvents, getEventsBySession, getSessions }));

// ─── 개인 학습 에이전트 ───────────────────────────────────────────────────────
const createPersonalLearningRouter = require('./routes/personal-learning');
app.use('/api', createPersonalLearningRouter({ getDb: dbModule.getDb, insertEvent, broadcastAll }));

// ─── 클라우드 동기화 ──────────────────────────────────────────────────────────
const createSyncRouter = require('./routes/sync');
app.use('/api', createSyncRouter({ getDb: dbModule.getDb, getAllEvents }));

// ─── 회사 컨설팅 플랫폼 (Company Ontology + Diagnosis + Learning) ───────────
companyOntology.ensureCompanyTables(dbModule.getDb());
app.use('/api', createCompanyRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createDiagnosisRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createCompanyLearningRouter({ getDb: dbModule.getDb }));

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


// ── 인사이트/학습/클라이언트 API (routes/insights-api.js) ────────────────────
const createInsightsApiRouter = require('./routes/insights-api');
app.use('/api', createInsightsApiRouter({
  getAllEvents, broadcastAll, insightEngine, diffLearner, dualSkillEngine,
  wsChannelMap, wss,
  broadcastToClientId(clientId, msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(ws => {
      const info = wsChannelMap.get(ws);
      if (ws.readyState === WebSocket.OPEN && info?.clientId === clientId) ws.send(payload);
    });
    broadcastAll(msg);
  },
}));

// ── 학습 데이터 자동 크롤링 API ─────────────────────────────────────────────
app.get('/api/learned-insights', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const data = ollamaAnalyzer.getLearnedInsights(limit);
  res.json({ ok: true, count: data.length, insights: data });
});
app.get('/api/learned-insights/latest', (req, res) => {
  const data = ollamaAnalyzer.getLearnedInsights(1);
  res.json({ ok: true, insight: data[0] || null });
});

// ── 설치 스크립트 (.ps1 / .sh) ─────────────────────────────────────────────
const createSetupScriptsRouter = require('./routes/setup-scripts');
app.use('/', createSetupScriptsRouter({ PORT }));

// ── 외부 통합 API (terminal, vscode, browser, keylog, chrome, AI conversations) ──
const createIntegrationsRouter = require('./routes/integrations');
app.use('/', createIntegrationsRouter({ broadcastAll, ollamaAnalyzer, dbModule, PORT, verifyToken }));

// ── 시스템 모니터 (활성 앱/윈도우/클립보드/브라우저 URL 추적) ──────────────
try {
  const { getInstance: getSystemMonitor } = require('./src/system-monitor');
  const sysMonitor = getSystemMonitor({ cdp: true, clipboard: true, app: true });
  sysMonitor.start();
  sysMonitor.on('activity', (ev) => {
    // 이벤트를 DB에 저장 + 대시보드로 브로드캐스트
    try {
      const eventId = `sm-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      insertEvent({
        id: eventId,
        type: ev.type || 'app_switch',
        source: ev.app || 'system',
        filePath: ev.url || ev.title || '',
        aiSource: 'system-monitor',
        timestamp: new Date(ev.timestamp || Date.now()).toISOString(),
        data: JSON.stringify(ev),
      });
      broadcastAll({ type: 'new_event', event: { ...ev, id: eventId } });
    } catch {}
  });
} catch (e) {
  console.log(`   시스템 모니터: 비활성 (${e.message})`);
}
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
  console.log(`   마켓 2.0: http://localhost:${PORT}/api/market/leaderboard`);
  console.log(`   타임라인: http://localhost:${PORT}/orbit-timeline.html`);
  console.log(`   개인 인사이트: http://localhost:${PORT}/api/me/insights`);
  console.log(`   비용 추적: http://localhost:${PORT}/api/costs/dashboard`);
  console.log(`   웹훅 설정: http://localhost:${PORT}/api/webhooks/config`);
  console.log(`   MCP 마켓: http://localhost:${PORT}/api/mcp-market/trending`);
  console.log(`   배지: http://localhost:${PORT}/api/badge/local/svg`);
  console.log(`   리더보드: http://localhost:${PORT}/api/leaderboard`);
  console.log(`   ROI: http://localhost:${PORT}/api/roi/dashboard`);
  console.log(`   인증서: http://localhost:${PORT}/api/certificate/local/score`);
  console.log(`   포인트: http://localhost:${PORT}/api/points/balance`);
  console.log(`   온톨로지: http://localhost:${PORT}/api/ontology`);
  console.log(`   AI 분석: Haiku ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'} / Ollama 폴백`);
  console.log(`   학습 데이터: http://localhost:${PORT}/api/learned-insights\n`);

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

  // 수익 정산 스케줄러 시작 (매일 자정 집계 + 매월 1일 정산)
  revenueScheduler.start({ broadcastAll });

  // MCP Market Watcher 시작 (1시간 간격 폴링)
  mcpWatcher.start({ broadcastAll });

  // 회사 컨설팅 크롤러 시작 (활동 집계 + 학습 + 진단 + 백업)
  companyCrawler.start({ db: dbModule.getDb(), broadcastAll });

  // Google Drive 사용자 자동 백업 (2시간마다)
  setInterval(async () => {
    try {
      const users = getGoogleOAuthUsers();
      for (const u of users) {
        try {
          const token = await getValidGoogleToken(u.id);
          if (token) {
            await gdriveUserBackup.backupUserDataToDrive(u.id, token,
              { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent });
          }
        } catch (e) {
          console.warn(`[gdrive-auto] ${u.email} 백업 실패:`, e.message);
        }
      }
    } catch {}
  }, 2 * 60 * 60 * 1000); // 2시간

  console.log(`   회사 진단: http://localhost:${PORT}/api/company`);
  console.log(`   컨설턴트: http://localhost:${PORT}/consultant.html`);
  console.log(`   트래커 설치: http://localhost:${PORT}/api/tracker/install?token=TOKEN`);
  console.log(`   부트캠프: http://localhost:${PORT}/api/bootcamp/start`);

  // ── 로컬→Railway 주기적 동기화 (5분마다) ──────────────────────────────────
  // Railway 환경이 아닌 로컬 서버에서만 실행
  if (!process.env.RAILWAY_PUBLIC_DOMAIN && !process.env.RAILWAY_ENVIRONMENT) {
    const orbitCfgPath = require('path').join(require('os').homedir(), '.orbit-config.json');
    let railwayUrl = null;
    let railwayToken = '';
    try {
      const ocfg = JSON.parse(require('fs').readFileSync(orbitCfgPath, 'utf8'));
      railwayUrl = ocfg.serverUrl || null;
      railwayToken = ocfg.token || '';
    } catch {}
    railwayUrl = process.env.ORBIT_SERVER_URL || railwayUrl;

    if (railwayUrl && railwayUrl !== `http://localhost:${PORT}`) {
      console.log(`\n[Sync] Railway 동기화 활성화 (5분 간격)`);
      console.log(`   → ${railwayUrl}`);

      const _syncToRailway = async () => {
        try {
          const stats = getStats();
          // 1) 핑 전송 — verifyToken으로 실제 userId 확인
          let resolvedUserId = require('os').hostname();
          if (railwayToken) {
            try {
              const user = verifyToken(railwayToken);
              if (user) resolvedUserId = user.id;
            } catch {}
          }
          const pingBody = JSON.stringify({
            userId: resolvedUserId,
            hostname: require('os').hostname(),
            eventCount: stats.eventCount,
          });
          const pingUrl = new URL('/api/tracker/ping', railwayUrl);
          const mod = pingUrl.protocol === 'https:' ? require('https') : require('http');
          const pingReq = mod.request({
            hostname: pingUrl.hostname, port: pingUrl.port || (pingUrl.protocol === 'https:' ? 443 : 80),
            path: pingUrl.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pingBody),
              ...(railwayToken ? { 'Authorization': `Bearer ${railwayToken}` } : {}) },
          }, () => {});
          pingReq.on('error', () => {});
          pingReq.write(pingBody);
          pingReq.end();

          // 2) 최근 이벤트 동기화
          const { execSync } = require('child_process');
          const syncScript = require('path').join(__dirname, 'bin', 'sync-to-railway.js');
          if (require('fs').existsSync(syncScript)) {
            execSync(`node "${syncScript}" --limit=200`, { timeout: 30000, stdio: 'ignore' });
          }
        } catch (e) {
          // 동기화 실패 시 조용히 넘어감
        }
      };

      // 시작 후 10초 뒤 첫 동기화, 이후 5분마다
      setTimeout(_syncToRailway, 10000);
      setInterval(_syncToRailway, 5 * 60 * 1000);
    }
  }
});
