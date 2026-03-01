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
  searchEvents, getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation,
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

// ─── 상수 ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT ? parseInt(process.env.PORT) : 4747;
const CONV_FILE    = path.join(__dirname, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

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
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // 로컬호스트 + 폴링 엔드포인트는 제한 제외
  skip: req => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const isPolling = req.path === '/health' || req.path === '/api/signal' || req.path === '/api/learn/suggestions';
    return isLocal || isPolling;
  },
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
  getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
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


// ── Diff 학습 API ────────────────────────────────────────────────────────────
app.get('/api/learn/stats',       (req, res) => res.json(diffLearner.getStats()));
app.get('/api/learn/suggestions', (req, res) => res.json(diffLearner.getSuggestions()));
app.post('/api/learn/seen/:id',   (req, res) => { diffLearner.markSeen(req.params.id); res.json({ ok: true }); });
app.post('/api/learn/file',       async (req, res) => {
  const { filePath, action } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (action === 'before') { diffLearner.snapshot(filePath); return res.json({ ok: true }); }
  const entry = await diffLearner.learn(filePath);
  res.json({ ok: true, entry });
});

// ── 클라이언트 인사이트 수신 (orbit-client.js → 서버) ────────────────────────
// ★ 원본 코드 없음 — 구조화된 메타데이터만 수신
const _clientInsights = [];  // 메모리 버퍼 (DB 연결 전 임시)
const MAX_CLIENT_INSIGHTS = 5000;

app.post('/api/insights/client', (req, res) => {
  const { insights } = req.body;
  if (!Array.isArray(insights) || insights.length === 0) {
    return res.status(400).json({ error: 'insights array required' });
  }

  const received = [];
  const newSuggestions = [];

  for (const insight of insights) {
    // 원본 코드 필드가 들어오면 거부 (보안)
    if (insight.code || insight.content || insight.source) {
      continue;
    }

    // dualAnalysis 필드: 서버 측 앙상블 재계산
    let dualResult = null;
    if (insight.dualAnalysis?.primary || insight.dualAnalysis?.secondary) {
      const { primary, secondary } = insight.dualAnalysis;
      const confidence = dualSkillEngine.calcConfidence(primary, secondary);
      dualResult = dualSkillEngine.mergeAnalysis(primary, secondary, confidence);
    }

    const safe = {
      id:           require('crypto').randomUUID(),
      clientId:     String(insight.clientId    || 'unknown').slice(0, 32),
      userName:     String(insight.userName    || 'unknown').slice(0, 50),
      fileName:     String(insight.fileName    || '').slice(0, 100),
      ext:          String(insight.ext         || '').slice(0, 10),
      timestamp:    Number(insight.timestamp   || Date.now()),
      activityType: String(insight.activityType || 'file').slice(0, 20),
      addedLines:   Number(insight.addedLines  || 0),
      removedLines: Number(insight.removedLines || 0),
      changeRatio:  Number(insight.changeRatio || 0),
      pattern:      (dualResult?.pattern    || insight.pattern)    ? String(dualResult?.pattern    || insight.pattern).slice(0, 200)    : null,
      suggestion:   (dualResult?.suggestion || insight.suggestion) ? String(dualResult?.suggestion || insight.suggestion).slice(0, 500) : null,
      automatable:  dualResult ? Boolean(dualResult.automatable) : Boolean(insight.automatable),
      category:     String(dualResult?.category || insight.category || 'unknown').slice(0, 20),
      confidence:   dualResult?.confidence ?? insight.dualAnalysis?.confidence ?? null,
      receivedAt:   Date.now(),
    };

    _clientInsights.unshift(safe);
    received.push(safe);

    // 패턴 누적 → 스킬/에이전트 제안 생성
    if (safe.clientId !== 'unknown') {
      const suggestion = dualSkillEngine.accumulatePattern(
        { clientId: safe.clientId, userName: safe.userName, ext: safe.ext, fileName: safe.fileName, activityType: safe.activityType },
        { category: safe.category, automatable: safe.automatable, confidence: safe.confidence || 0.45, pattern: safe.pattern, suggestion: safe.suggestion }
      );
      if (suggestion) newSuggestions.push(suggestion);
    }
  }

  if (_clientInsights.length > MAX_CLIENT_INSIGHTS) {
    _clientInsights.splice(MAX_CLIENT_INSIGHTS);
  }

  // 실시간 브로드캐스트
  if (typeof broadcastAll === 'function' && received.length > 0) {
    broadcastAll({ type: 'client_insights', data: received });
  }

  // 새 스킬/에이전트 제안 → 해당 클라이언트에 WebSocket 알림
  for (const suggestion of newSuggestions) {
    broadcastToClientId(suggestion.clientId, { type: 'skill_suggestion', data: suggestion });
    console.log(`[Insights] 🎯 스킬 제안 브로드캐스트 → ${suggestion.clientId}: ${suggestion.alias}`);
  }

  console.log(`[Insights] 수신: ${received.length}개 from ${received[0]?.userName || '?'}`);
  res.json({ ok: true, received: received.length, suggestions: newSuggestions.length });
});

// ── 클라이언트별 WebSocket 브로드캐스트 헬퍼 ─────────────────────────────────
function broadcastToClientId(clientId, msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    const info = wsChannelMap.get(ws);
    if (ws.readyState === WebSocket.OPEN && info?.clientId === clientId) {
      ws.send(payload);
    }
  });
  // clientId 매칭 ws가 없으면 전체 브로드캐스트 (대시보드용)
  broadcastAll(msg);
}

// ── 피드백 조회 (orbit-client.js 폴링) ───────────────────────────────────────
app.get('/api/insights/feedback', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const suggestions = dualSkillEngine.getFeedback(clientId);
  res.json({ ok: true, suggestions });
});

// ── 제안 수락 ─────────────────────────────────────────────────────────────────
app.post('/api/insights/feedback/apply', (req, res) => {
  const { clientId, suggestionId } = req.body;
  if (!clientId || !suggestionId) return res.status(400).json({ error: 'clientId, suggestionId required' });
  const suggestion = dualSkillEngine.acceptSuggestion(clientId, suggestionId);
  if (!suggestion) return res.status(404).json({ error: 'suggestion not found' });
  res.json({ ok: true, suggestion });
});

// ── 패턴 통계 (디버그/대시보드) ──────────────────────────────────────────────
app.get('/api/insights/patterns', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) {
    // 전체 제안 (대시보드용)
    return res.json({ ok: true, suggestions: dualSkillEngine.getAllSuggestions(50) });
  }
  const patterns = dualSkillEngine.getPatternStats(clientId);
  const suggestions = dualSkillEngine.getFeedback(clientId);
  res.json({ ok: true, patterns, suggestions });
});

// /api/insights/dashboard — 집계 대시보드
app.get('/api/insights/dashboard', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
  const recent = _clientInsights.slice(0, limit);

  // 클라이언트별 통계
  const byClient = {};
  for (const i of recent) {
    const key = i.clientId;
    if (!byClient[key]) byClient[key] = { userName: i.userName, count: 0, categories: {}, automatable: 0 };
    byClient[key].count++;
    byClient[key].categories[i.category] = (byClient[key].categories[i.category] || 0) + 1;
    if (i.automatable) byClient[key].automatable++;
  }

  // 자동화 가능 패턴 상위
  const automatablePatterns = recent
    .filter(i => i.automatable && i.suggestion)
    .slice(0, 10)
    .map(i => ({ userName: i.userName, fileName: i.fileName, suggestion: i.suggestion, category: i.category }));

  // 카테고리 분포
  const categoryDist = {};
  for (const i of recent) {
    categoryDist[i.category] = (categoryDist[i.category] || 0) + 1;
  }

  res.json({
    total:              _clientInsights.length,
    recentCount:        recent.length,
    byClient:           Object.values(byClient),
    automatablePatterns,
    categoryDist,
    lastUpdated:        _clientInsights[0]?.receivedAt || null,
  });
});

// ── Chrome Extension AI 이벤트 수신 ─────────────────────────────────────────
app.post('/api/ai-events', (req, res) => {
  const event = req.body;
  console.log(`[Chrome Extension] ${event.tool} — ${event.action}: ${event.topic}`);
  // WebSocket으로 연결된 클라이언트들에게 브로드캐스트
  if (typeof broadcastAll === 'function') {
    broadcastAll({ type: 'ai_tool_event', data: event });
  }
  res.json({ ok: true });
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
  console.log(`   온톨로지: http://localhost:${PORT}/api/ontology\n`);

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
});
