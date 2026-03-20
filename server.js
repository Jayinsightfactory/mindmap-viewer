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
const logger = require('./src/logger');

// ─── 전역 미처리 Promise 거부 안전망 (Node.js v24+ 크래시 방지) ────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.warn('미처리 Promise 거부 (무시됨): %s', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  logger.error('처리되지 않은 예외: %s', err.message, { stack: err.stack });
  // OOM은 복구 불가 → Railway가 자동 재시작하도록 종료
  if (err.message && (err.message.includes('heap') || err.message.includes('memory'))) {
    logger.error('OOM 감지 — 프로세스 종료 (Railway 자동 재시작)');
    process.exit(1);
  }
  // 기타 예외는 계속 실행
});

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const chokidar     = require('chokidar');
const fs           = require('fs');
const path         = require('path');
// rate-limit: 인메모리 구현 (express-rate-limit v8 Railway 프록시 호환 문제 대체)
const _rlStore = new Map();
// 만료된 엔트리만 정리 (전체 리셋 대신 개별 만료 — 메모리 안정)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rlStore) {
    if (now > entry.resetAt) _rlStore.delete(key);
  }
}, 60 * 1000); // 1분마다 정리
const rateLimit = ({ windowMs = 900000, max = 2000 } = {}) => (req, res, next) => {
  // 인증된 사용자는 토큰 기반 키 (같은 IP 공유 시 독립 카운트)
  const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const key = authToken ? `user:${authToken.slice(0, 16)}` : (req.ip || 'unknown');
  const entry = _rlStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > entry.resetAt) { entry.count = 0; entry.resetAt = Date.now() + windowMs; }
  if (++entry.count > max) return res.status(429).json({ error: 'Too many requests' });
  _rlStore.set(key, entry);
  next();
};
const helmet       = require('helmet');
const { validateBody } = require('./src/validate');

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

// ─── 사용자별 데이터 격리 헬퍼 ──────────────────────────────────────────────
// 로그인 유저 → 본인 이벤트만, 비로그인/로컬 → 개발모드만 전체
const MAX_EVENTS_LOAD = 2000; // 메모리 절약: 최대 로드 이벤트 수
const { verifyToken: _verifyToken } = require('./src/auth');
// ⚠️ 크로스-유저 격리: AUTH_DISABLED=1(개발)만 'local' userId에 전체 데이터 허용
const _IS_DEV = process.env.AUTH_DISABLED === '1';

async function getEventsForUser(userId) {                  // userId 기반 이벤트 조회 (PG async 대응)
  if (!userId || userId === 'local' || userId === 'anonymous') {
    // 개발 모드에서만 전체 허용 — 프로덕션에서는 빈 배열 반환 (크로스-유저 노출 방지)
    return _IS_DEV ? await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD)) : [];
  }
  // 로그인한 사용자: 본인 이벤트 + 본인에게 claim된 local 이벤트만
  const userEvents = getEventsByUser ? await Promise.resolve(getEventsByUser(userId)) : [];
  // 본인 이벤트가 없고 어드민이면 local 이벤트도 포함 (자기 데이터 claim 전)
  if (userEvents.length === 0) {
    const adminEmails = (process.env.ADMIN_EMAILS || 'dlaww@kicda.com').split(',').map(s => s.trim());
    const isAdmin = adminEmails.includes(userId);
    if (isAdmin) return await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD));
  }
  return userEvents;
}

async function getSessionsForUser(userId) {                // userId 기반 세션 조회 (PG async 대응)
  if (!userId || userId === 'local' || userId === 'anonymous') {
    // 개발 모드에서만 전체 허용 — 프로덕션에서는 빈 배열 반환
    return _IS_DEV ? await Promise.resolve(getSessions()) : [];
  }
  return getSessionsByUser ? await Promise.resolve(getSessionsByUser(userId)) : await Promise.resolve(getSessions());
}

function resolveUserId(req) {                             // req에서 userId 추출
  return req?.user?.id || 'local';
}

const { buildGraph, computeActivityScores, applyActivityVisualization, suggestLabel } = require('./src/graph-engine');
const { annotateEventsWithPurpose, classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES } = require('./src/purpose-classifier');
const { createAnnotationEvent } = require('./src/event-normalizer');
const { getAiStyle, AI_SOURCES }  = require('./adapters/ai-adapter-base');
const { generateReport, countLines, measureCyclomaticComplexity, findLongFunctions, findDuplicatePatterns, analyzeSolidViolations } = require('./src/code-analyzer');
const { scanForLeaks }            = require('./src/security-scanner');
const { buildReportData, renderMarkdown, renderSlackBlocks } = require('./src/report-generator');
const { extractContext, renderContextMd, renderContextPrompt, saveContextFile } = require('./src/context-bridge');
const { detectConflicts, checkNewEvent } = require('./src/conflict-detector');
const { appendAuditLog, auditFromEvents, queryAuditLog, verifyIntegrity, renderAuditHtml } = require('./src/audit-log');
const { detectShadowAI, checkEventForShadow, getApprovedSources, addApprovedSource, removeApprovedSource } = require('./src/shadow-ai-detector');
const { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme } = require('./src/theme-store');
const { register: authRegister, login: authLogin, verifyToken, issueApiToken, getUserById, upsertOAuthUser,
  saveOAuthTokens, getOAuthTokens, refreshGoogleAccessToken, getValidGoogleToken, getGoogleOAuthUsers,
  searchUsers, upgradePlan,
  inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, ADMIN_EMAILS,
  initFromPg: authInitFromPg,  // PG → SQLite 복원 (Railway 재배포 대비)
} = require('./src/auth');
const gdriveUserBackup = require('./src/gdrive-user-backup');
const { initOAuthStrategies, createOAuthRouter } = require('./src/auth-oauth');
const payment = require('./src/payment');
const { PLANS, MOCK_MODE: paymentMockMode } = payment;
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
const createTrackerOAuthRouter = require('./routes/tracker-oauth');
const createTrackerFilesRouter = require('./routes/tracker-files');
const createTrackerMessagesRouter = require('./routes/tracker-messages');
const { getInstance: getSyncScheduler } = require('./src/tracker/sync-scheduler');
const createGrowthRouter     = require('./routes/growth');
const createCommunityRouter  = require('./routes/community');
const createGitRouter        = require('./routes/git');
const createAvatarsRouter    = require('./routes/avatars');
// const createOrgRouter        = require('./routes/org-api'); // ⚠️ Implemented inline in server.js to avoid file corruption issue
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
const createMarketplaceRouter        = require('./routes/marketplace');
const createRecommendationsRouter    = require('./routes/recommendations');
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
const createNodesRouter               = require('./routes/nodes');
const createWorkspaceActivityRouter    = require('./routes/workspace-activity');
const companyOntology                 = require('./src/company-ontology');
const companyCrawler                  = require('./src/company-crawler');

// ─── Phase 2-5: 작업 분석 + 인텔리전스 + AI 학습 ──────────────────────────────
const createWorkAnalysisRouter        = require('./routes/work-analysis');
const createIntelligenceRouter        = require('./routes/intelligence');
const createLearningRouter            = require('./routes/learning');

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
// PG 환경에서는 JSONL 파일 생성 스킵 (ENOSPC 방지, PG가 원본)
if (!process.env.DATABASE_URL) {
  if (!fs.existsSync(CONV_FILE))    fs.writeFileSync(CONV_FILE, '');
}
if (!fs.existsSync(SNAPSHOTS_DIR)) try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}

const db = initDatabase();
logger.db.info('SQLite 초기화 완료');

// ─── SQLite 안정성 설정 (배포 시 동시 요청 안전) ────────────────────────────
if (db && db.pragma) {
  try {
    db.pragma('journal_mode = WAL');           // Write-Ahead Logging (동시성 향상)
    db.pragma('busy_timeout = 5000');          // 5초 대기 (잠금 경쟁 해결)
    db.pragma('synchronous = NORMAL');         // 성능/안전 균형
    db.pragma('foreign_keys = ON');            // 외래키 제약 활성화
    logger.db.info('SQLite PRAGMAS 설정 완료 (WAL모드, busy_timeout=5000ms)');
  } catch (e) {
    logger.db.warn('PRAGMA 설정 실패: %s', e.message);
  }
}

// ─── Identity Bridge: ~/.orbit-config.json → 로컬 auth DB 동기화 ──────────
try {
  const _os = require('os');
  const _cfgPath = path.join(_os.homedir(), '.orbit-config.json');
  if (fs.existsSync(_cfgPath)) {
    const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf8'));
    if (_cfg.userId && _cfg.email) {
      const authMod = require('./src/auth');
      if (authMod.ensureCanonicalUser) {
        const result = authMod.ensureCanonicalUser(_cfg.userId, _cfg.email);
        if (result.oldId) {
          // main DB에서도 이전 ID → canonical ID로 마이그레이션
          const mainDb = dbModule.getDb ? dbModule.getDb() : null;
          if (mainDb && mainDb.prepare) {
            const r1 = mainDb.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').run(_cfg.userId, result.oldId);
            const r2 = mainDb.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(_cfg.userId, result.oldId);
            const total = (r1.changes || 0) + (r2.changes || 0);
            if (total > 0) console.log(`[identity-bridge] startup: ${result.oldId} → ${_cfg.userId}: ${total}개 레코드`);
          }
        }
        // 토큰도 로컬 auth DB에 동기화 (config의 token이 없으면 생성)
        if (_cfg.token) {
          const authDb = authMod.getDb ? authMod.getDb() : null;
          if (authDb) {
            try {
              authDb.prepare('INSERT OR IGNORE INTO tokens (token, userId, type) VALUES (?, ?, ?)').run(_cfg.token, _cfg.userId, 'api');
            } catch {}
          }
        }
      }
    }
  }
} catch (e) { console.warn('[identity-bridge] startup 실패:', e.message); }

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── CORS — 동일 도메인 + Railway 프로덕션 ──────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [
    'https://sparkling-determination-production-c88b.up.railway.app',
    'http://localhost:4747',
  ];
  if (!origin || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-token,x-device-id');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── 보안 미들웨어 ────────────────────────────────────────────────────────────
// Helmet: X-Frame-Options, X-Content-Type, CSP 등 보안 헤더 자동 설정
app.use(helmet({
  contentSecurityPolicy: false,        // 외부 CDN 10+ (Three.js, Toss, Google 등) → 화이트리스트 비실용적
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
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
// /api/hook은 Content-Length 기반 사전 차단 (base64 이미지 OOM 방지)
app.use('/api/hook', (req, res, next) => {
  const cl = parseInt(req.headers['content-length'] || '0', 10);
  if (cl > 500 * 1024) { // 500KB 이상이면 거부 (base64 이미지 포함 의심)
    return res.status(413).json({ error: 'Payload too large — 이미지는 Drive로 업로드하세요' });
  }
  next();
});
// 벌크 임포트는 rate limit 제외 (관리자 토큰 인증 필수)
app.use('/api/', (req, res, next) => {
  if (req.path === '/bulk-import') return next(); // skip apiLimiter
  return apiLimiter(req, res, next);
});

// Stripe Webhook은 서명 검증을 위해 원본 바디(Buffer)가 필요 — JSON 파싱 전에 처리
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
// 프로덕션: 압축된 JS 우선 사용
if (process.env.NODE_ENV === 'production') {
  // 개발 단계: 원본 JS 사용 (minified에서 TDZ 에러 발생)
  // app.use('/js', express.static(path.join(__dirname, 'public', 'js-min'), { maxAge: '7d', etag: true }));
}
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, // 개발 단계: 캐시 비활성화 (안정화 후 1d로 복구)
  etag: true,
}));
// setup 스크립트 서빙
app.use('/setup', express.static(path.join(__dirname, 'setup'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.ps1') || filePath.endsWith('.sh')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
  },
}));
// Chrome 확장 파일 서빙 (설치 스크립트에서 다운로드용)
app.use('/chrome-extension', express.static(path.join(__dirname, 'chrome-extension')));

// ─── 로그인 브루트포스 방지 (15분 당 10회) ────────────────────────────────────
const _loginStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _loginStore) {
    if (now > entry.resetAt) _loginStore.delete(key);
  }
}, 60 * 1000);
const loginLimiter = (req, res, next) => {
  const key = `login:${req.body?.email || req.ip || 'unknown'}`;
  const windowMs = 15 * 60 * 1000;
  const max = 10;
  const entry = _loginStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > entry.resetAt) { entry.count = 0; entry.resetAt = Date.now() + windowMs; }
  if (++entry.count > max) {
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' });
  }
  _loginStore.set(key, entry);
  next();
};
app.post('/api/auth/login', loginLimiter);
app.post('/api/auth/register', loginLimiter);

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
// ── 그래프 캐시 (5초 TTL) ─ 매 요청마다 전체 재빌드 방지 ──
const _graphCache = new Map();
const GRAPH_CACHE_TTL = 5000;
async function _getCachedGraph(key, builder) {
  const cached = _graphCache.get(key);
  if (cached && Date.now() - cached.ts < GRAPH_CACHE_TTL) return cached.graph;
  const graph = await builder();
  _graphCache.set(key, { graph, ts: Date.now() });
  // 캐시 엔트리 10개 초과 시 전부 정리 (OOM 방지)
  if (_graphCache.size > 10) {
    const now = Date.now();
    for (const [k, v] of _graphCache) { if (now - v.ts > GRAPH_CACHE_TTL) _graphCache.delete(k); }
    // 그래도 많으면 전부 삭제
    if (_graphCache.size > 10) _graphCache.clear();
  }
  return graph;
}

// ── 세션별 프로젝트 메타데이터를 이벤트에 주입 ──────────────────────────────
// mywork-renderer에서 "프로젝트명 — 작업 목적" 형태 라벨을 생성하기 위해 필요
function _enrichEventsWithSessionMeta(events) {
  const sessionMap = {};
  for (const e of events) {
    const sid = e.sessionId;
    if (!sid) continue;
    if (!sessionMap[sid]) {
      sessionMap[sid] = { firstMsg: null, projectDir: null, projectName: null };
    }
    const sm = sessionMap[sid];
    // 첫 user.message를 firstMsg로 사용
    if (!sm.firstMsg && e.type === 'user.message' && e.data?.content) {
      sm.firstMsg = String(e.data.content).slice(0, 60);
    }
    // 파일 경로에서 프로젝트 디렉토리 추출
    if (!sm.projectDir && e.data?.file_path) {
      const fp = e.data.file_path;
      const parts = fp.replace(/\\/g, '/').split('/');
      // /Users/xxx/프로젝트명/... 에서 프로젝트 폴더 추출
      const srcIdx = parts.findIndex(p => p === 'src' || p === 'public' || p === 'routes' || p === 'lib');
      if (srcIdx > 0) {
        sm.projectDir = parts.slice(0, srcIdx).join('/');
        sm.projectName = parts[srcIdx - 1];
      }
    }
    if (!sm.projectDir && e.data?.command) {
      const cdMatch = String(e.data.command).match(/cd\s+["']?([^\s"']+)/);
      if (cdMatch) {
        const dirParts = cdMatch[1].replace(/\\/g, '/').split('/');
        sm.projectName = dirParts[dirParts.length - 1] || dirParts[dirParts.length - 2];
      }
    }
    if (!sm.projectName && e.data?.projectName) sm.projectName = e.data.projectName;
    if (!sm.projectName && e.data?.project)     sm.projectName = e.data.project;
    if (!sm.projectName && e.data?.repo)        sm.projectName = e.data.repo;
  }
  // 메타데이터를 이벤트에 주입
  for (const e of events) {
    const sm = sessionMap[e.sessionId];
    if (!sm) continue;
    if (!e.data) e.data = {};
    if (sm.projectName && !e.data.projectName) e.data.projectName = sm.projectName;
    if (sm.firstMsg && !e.data.firstMsg)       e.data.firstMsg = sm.firstMsg;
    // autoTitle: 프로젝트명 + firstMsg 조합
    if (!e.autoTitle) {
      if (sm.projectName && sm.firstMsg) e.autoTitle = `${sm.projectName} — ${sm.firstMsg.slice(0, 30)}`;
      else if (sm.projectName) e.autoTitle = sm.projectName;
      else if (sm.firstMsg) e.autoTitle = sm.firstMsg.slice(0, 40);
    }
  }
  return events;
}

async function getFullGraph(sessionFilter, channelFilter) {
  const cacheKey = `full:${sessionFilter||''}:${channelFilter||''}`;
  return _getCachedGraph(cacheKey, async () => {
    const rawEvents = sessionFilter
      ? await Promise.resolve(getEventsBySession(sessionFilter))
      : channelFilter
        ? (getEventsByChannel
            ? await Promise.resolve(getEventsByChannel(channelFilter))
            : (await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD))).filter(e => e.channelId === channelFilter))
        : await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD));

    const events = _enrichEventsWithSessionMeta(annotateEventsWithPurpose(rawEvents));
    const graph  = buildGraph(events);
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);
    return graph;
  });
}

// 특정 user_id의 이벤트만 그래프로 변환 (프라이버시 격리)
async function getFullGraphForUser(userId, sessionFilter) {
  const cacheKey = `user:${userId}:${sessionFilter||''}`;
  return _getCachedGraph(cacheKey, async () => {
    let rawEvents;
    if (sessionFilter) {
      rawEvents = (await Promise.resolve(getEventsBySession(sessionFilter))).filter(e => e.userId === userId);
    } else {
      rawEvents = getEventsByUser
        ? await Promise.resolve(getEventsByUser(userId))
        : (await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD))).filter(e => e.userId === userId);
    }
    const events = _enrichEventsWithSessionMeta(annotateEventsWithPurpose(rawEvents));
    const graph  = buildGraph(events);
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);
    return graph;
  });
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
 * graph/sessions 포함 update 메시지는 자동으로 사용자별 데이터로 치환됩니다.
 * @param {object} msg - 전송할 메시지 객체
 */
function broadcastAll(msg) {
  // graph/sessions 포함 메시지 → 사용자별 격리 전송 (async 결과는 비동기 전송)
  if (msg.type === 'update' || msg.type === 'graph_update') {
    (async () => {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          const uid = client._userId || 'local';
          const userGraph    = (uid !== 'local' && uid !== 'anonymous' && typeof getFullGraphForUser === 'function')
            ? await getFullGraphForUser(uid) : msg.graph;
          const userSessions = (uid !== 'local' && uid !== 'anonymous' && typeof getSessionsForUser === 'function')
            ? await getSessionsForUser(uid) : msg.sessions;
          client.send(JSON.stringify({ ...msg, graph: userGraph, sessions: userSessions }));
        } catch {}
      }
    })();
    return;
  }
  // 그 외 메시지 → 동일하게 전체 전송
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
wss.on('connection', (ws, req) => {
  // ── WS 접속 시 토큰으로 사용자 식별 ─────────────────────────────────────
  const urlParams = new URL(req.url, 'http://localhost').searchParams;
  const token     = urlParams.get('token');                          // ws://host?token=xxx
  const wsUser    = token ? _verifyToken(token) : null;              // 토큰 검증
  const wsUserId  = wsUser?.id || 'local';                           // 사용자 ID
  ws._userId = wsUserId;                                             // WS에 사용자 ID 저장
  logger.ws.info('클라이언트 연결됨 (user: %s)', wsUserId);

  // 초기 접속: 해당 사용자의 데이터만 전송
  try {
    const userId = wsUserId;
    ws.send(JSON.stringify({
      type:       'init',
      // 인증된 사용자만 본인 데이터 수신 — 미인증은 빈 그래프 (타인 데이터 노출 방지)
      graph:      userId !== 'local' && userId !== 'anonymous'
                    ? getFullGraphForUser(userId)
                    : { nodes: [], links: [], sessions: [], projectGroups: {} },
      sessions:   userId !== 'local' && userId !== 'anonymous'
                    ? getSessionsForUser(userId) : [],
      stats:      getStats(),
      userConfig: getUserConfig(),
    }));
  } catch (e) {
    logger.ws.error('init 오류: %s', e.message);
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

        // 이 클라이언트에 채널 정보 전송 (사용자별 데이터 격리)
        const uid = ws._userId || 'local';
        ws.send(JSON.stringify({
          type:        'channel.joined',
          channelId, memberId, memberName, memberColor,
          members:  getChannelMembers(channelId),
          graph:    uid !== 'local' && uid !== 'anonymous'
                      ? getFullGraphForUser(uid) : getFullGraph(),
          sessions: getSessionsForUser(uid),
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

        if (!process.env.DATABASE_URL) {
          const entry = {
            id: event.id, type: event.type, source: event.source,
            sessionId: event.sessionId, parentEventId: event.parentEventId,
            data: event.data, ts: event.timestamp,
          };
          fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
        }

        const info      = wsChannelMap.get(ws);
        const channelId = info?.channelId;
        const payload   = { type: 'event', event, graph: getFullGraph() };

        if (channelId) broadcastToChannel(channelId, payload);
        else           broadcastAll(payload);
      }

      // ── 세션 필터 ────────────────────────────────────────────────────────
      if (msg.type === 'filter') {
        const uid = ws._userId || 'local';
        const graph = uid !== 'local' && uid !== 'anonymous'
          ? getFullGraphForUser(uid, msg.sessionId)
          : getFullGraph(msg.sessionId);
        ws.send(JSON.stringify({ type: 'filtered', graph }));
      }

      // ── WS 인증 (클라이언트에서 로그인 후 토큰 전송) ───────────────────
      if (msg.type === 'auth') {
        const u = msg.token ? _verifyToken(msg.token) : null;
        ws._userId = u?.id || 'local';
        const uid = ws._userId;
        ws.send(JSON.stringify({
          type:     'init',
          graph:    uid !== 'local' && uid !== 'anonymous'
                      ? getFullGraphForUser(uid) : getFullGraph(),
          sessions: getSessionsForUser(uid),
          stats:    getStats(),
          userConfig: getUserConfig(),
        }));
      }

    } catch (e) {
      logger.ws.error('message 처리 오류: %s', e.message);
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
    logger.ws.info('클라이언트 연결 종료');
  });

  ws.on('error', e => logger.ws.error('에러: %s', e.message));
});

// ─── 데몬용 Drive 설정 배포 API ──────────────────────────────────────────────
// 데몬이 캡처 → Google Drive 업로드에 필요한 서비스 계정 키 제공
app.get('/api/daemon/drive-config', (req, res) => {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID;
  if (!saJson || !folderId) {
    return res.json({ enabled: false });
  }
  res.json({ enabled: true, credentialsJson: saJson, folderId });
});

// ─── 자동 에러 수정 엔진 ─────────────────────────────────────────────────────
const autoFixer = (() => { try { return require('./src/auto-fixer'); } catch(e) { console.warn('[auto-fixer] 로드 실패:', e.message); return null; } })();

// ─── Vision 큐 (맥미니 CLI 워커가 폴링해서 분석) ──────────────────────────────
// 이미지를 메모리 큐에 보관 (최대 20건, 오래된 것 자동 삭제)
if (!global._visionImageQueue) global._visionImageQueue = [];

// ─── 학습 분석 API ──────────────────────────────────────────────────────────
const workLearner = (() => { try { return require('./src/work-learner'); } catch { return null; } })();
const reportSheet = (() => { try { return require('./src/report-sheet'); } catch { return null; } })();

// 리포트 시트 초기화
if (reportSheet && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const enabled = reportSheet.init({
    credentialsJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID,
  });
  if (enabled) console.log('[report-sheet] 초기화 완료');
}

// GET /api/learning/logs — 원시 이벤트 로그 조회 (관리자 대시보드용)
app.get('/api/learning/logs', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const userId = req.query.userId || null;
    const type = req.query.type || null;

    let query = "SELECT id, type, user_id, timestamp, data_json FROM events WHERE type IN ('keyboard.chunk','screen.capture','screen.analyzed','idle')";
    const params = [];
    if (userId) { params.push(userId); query += ` AND user_id=$${params.length}`; }
    if (type) { params.push(type); query += ` AND type=$${params.length}`; }
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);

    // 멤버 이름 매핑
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const names = {};
    nameRows.rows.forEach(r => { names[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const logs = rows.map(r => {
      let data = {};
      try { data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
      const ctx = data.appContext || {};
      return {
        id: r.id,
        type: r.type,
        userId: r.user_id,
        userName: names[r.user_id] || r.user_id?.substring(0, 10),
        timestamp: r.timestamp,
        app: ctx.currentApp || data.app || '',
        windowTitle: ctx.currentWindow || data.windowTitle || '',
        windowHistory: ctx.windowHistory || {},
        summary: data.summary || '',
        trigger: data.trigger || '',
        activityLevel: data.activityLevel || '',
        mouseClicks: data.mouseClicks || 0,
        // Vision 분석 결과
        visionActivity: data.activity || '',
        visionScreen: data.screen || '',
        visionAutomatable: data.automatable || false,
        visionHint: data.automationHint || '',
      };
    });

    res.json({ logs, total: logs.length });
  } catch (e) {
    res.json({ error: e.message, logs: [] });
  }
});

// 정기 리포트 생성 (매일 09:00, 13:30, 18:00 KST)
const REPORT_HOURS = [{ h: 0, m: 0 }, { h: 4, m: 30 }, { h: 9, m: 0 }]; // UTC (KST-9)
let _lastReportKey = '';
setInterval(async () => {
  if (!workLearner || !reportSheet) return;
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return; // 주말 제외

  const match = REPORT_HOURS.find(s => h === s.h && m >= s.m && m <= s.m + 2);
  if (!match) return;
  const key = `${now.toISOString().slice(0, 10)}-${h}:${match.m}`;
  if (_lastReportKey === key) return;
  _lastReportKey = key;

  console.log('[report] 정기 리포트 생성 시작');
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query("SELECT DISTINCT user_id FROM events WHERE type='keyboard.chunk'");
    const userIds = rows.map(r => r.user_id).filter(Boolean);
    if (userIds.length === 0) return;

    // 멤버 이름 매핑
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const nameMap = {};
    nameRows.rows.forEach(r => { nameMap[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const result = await workLearner.analyzeWorkspace(pool, userIds);
    const url = await reportSheet.writeReport(result, nameMap);
    if (url) console.log('[report] 리포트 전송 완료:', url);
  } catch (e) {
    console.error('[report] 에러:', e.message);
  }
}, 60 * 1000); // 1분마다 체크

// GET /api/learning/analyze?userId=xxx — 개인 분석
app.get('/api/learning/analyze', async (req, res) => {
  if (!workLearner) return res.json({ error: 'work-learner not available' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const user = token ? verifyToken(token) : null;
    const targetId = req.query.userId || user?.id || 'local';
    const pool = dbModule.getDb();
    if (!pool || !pool.query) return res.json({ error: 'DB pool not ready' });
    const result = await workLearner.analyzeUser(pool, targetId);
    res.json(result);
  } catch (e) {
    console.error('[learning] error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /api/learning/report — 즉시 리포트 생성 (수동)
app.post('/api/learning/report', async (req, res) => {
  if (!workLearner || !reportSheet) return res.json({ error: 'not available' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query("SELECT DISTINCT user_id FROM events WHERE type='keyboard.chunk'");
    const userIds = rows.map(r => r.user_id).filter(Boolean);
    if (userIds.length === 0) return res.json({ error: '데이터 없음' });

    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const nameMap = {};
    nameRows.rows.forEach(r => { nameMap[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const result = await workLearner.analyzeWorkspace(pool, userIds);
    const url = await reportSheet.writeReport(result, nameMap);
    res.json({ ok: true, url, memberCount: result.members?.length || 0 });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// POST /api/learning/deep-analyze — 키로그+마우스+캡처 조합 정밀 분석
app.post('/api/learning/deep-analyze', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const userId = req.body?.userId;

    // 전체 또는 특정 유저
    let userIds = [];
    if (userId) {
      userIds = [userId];
    } else {
      const { rows } = await pool.query("SELECT DISTINCT user_id FROM events WHERE type IN ('keyboard.chunk','screen.capture')");
      userIds = rows.map(r => r.user_id);
    }

    // 멤버 이름
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const names = {};
    nameRows.rows.forEach(r => { names[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const results = [];
    for (const uid of userIds) {
      // 키보드 로그
      const kb = await pool.query(
        "SELECT timestamp, data_json FROM events WHERE user_id=$1 AND type='keyboard.chunk' ORDER BY timestamp ASC", [uid]);
      // 캡처 로그
      const cap = await pool.query(
        "SELECT timestamp, data_json FROM events WHERE user_id=$1 AND type='screen.capture' ORDER BY timestamp ASC", [uid]);
      // idle
      const idle = await pool.query(
        "SELECT timestamp FROM events WHERE user_id=$1 AND type='idle' ORDER BY timestamp ASC", [uid]);

      // 키보드 이벤트 파싱
      const kbEvents = kb.rows.map(r => {
        const d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {});
        const ctx = d.appContext || {};
        const steps = d.patterns?.detected?.workflowSteps || [];
        return {
          ts: r.timestamp,
          app: ctx.currentApp || steps[0]?.app || '',
          window: ctx.currentWindow || '',
          windowHistory: ctx.windowHistory || {},
          summary: d.summary || '',
          mouseClicks: d.mouseClicks || 0,
          mouseRegions: d.mouseRegions || {},
          category: steps[0]?.category || '',
          activityCount: steps[0]?.activityCount || 0,
          duration: steps[0]?.duration_sec || 0,
        };
      });

      // 캡처 이벤트 파싱
      const capEvents = cap.rows.map(r => {
        const d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {});
        return {
          ts: r.timestamp,
          app: d.app || '',
          window: d.windowTitle || '',
          trigger: d.trigger || '',
          activityLevel: d.activityLevel || '',
          automationScore: d.automationScore || 0,
        };
      });

      // 앱별 사용 통계
      const appStats = {};
      kbEvents.forEach(e => {
        if (!e.app) return;
        if (!appStats[e.app]) appStats[e.app] = { count: 0, totalClicks: 0, totalDuration: 0, windows: new Set(), categories: {} };
        appStats[e.app].count++;
        appStats[e.app].totalClicks += e.mouseClicks;
        appStats[e.app].totalDuration += e.duration;
        if (e.window) appStats[e.app].windows.add(e.window);
        // windowHistory에서도 수집
        Object.entries(e.windowHistory).forEach(([app, win]) => {
          if (!appStats[app]) appStats[app] = { count: 0, totalClicks: 0, totalDuration: 0, windows: new Set(), categories: {} };
          if (win) appStats[app].windows.add(win);
        });
        if (e.category) appStats[e.app].categories[e.category] = (appStats[e.app].categories[e.category] || 0) + 1;
      });

      // Set → Array 변환
      Object.values(appStats).forEach(s => { s.windows = [...s.windows]; });

      // 앱 전환 시퀀스 (시간순)
      const appSequence = [];
      let lastApp = '';
      kbEvents.forEach(e => {
        if (e.app && e.app !== lastApp) {
          appSequence.push({ app: e.app, window: e.window, ts: e.ts });
          lastApp = e.app;
        }
      });

      // 캡처 트리거 분석
      const triggerStats = {};
      capEvents.forEach(e => {
        triggerStats[e.trigger] = (triggerStats[e.trigger] || 0) + 1;
      });

      // 마우스 클릭 총계 + 지역 분석
      let totalClicks = 0;
      const regionTotal = {};
      kbEvents.forEach(e => {
        totalClicks += e.mouseClicks;
        Object.entries(e.mouseRegions || {}).forEach(([region, cnt]) => {
          regionTotal[region] = (regionTotal[region] || 0) + cnt;
        });
      });

      // 활동 타임라인 (시간순, 키보드+캡처 합침)
      const timeline = [];
      kbEvents.forEach(e => timeline.push({ ...e, type: 'keyboard' }));
      capEvents.forEach(e => timeline.push({ ...e, type: 'capture' }));
      timeline.sort((a, b) => new Date(a.ts) - new Date(b.ts));

      results.push({
        userId: uid,
        userName: names[uid] || uid.substring(0, 10),
        keyboardEvents: kbEvents.length,
        captureEvents: capEvents.length,
        idleEvents: idle.rows.length,
        appStats,
        appSequence: appSequence.slice(-30), // 최근 30개 전환
        triggerStats,
        totalMouseClicks: totalClicks,
        mouseRegions: regionTotal,
        timeline: timeline.slice(-50), // 최근 50건
      });
    }

    res.json({ ok: true, analyzedAt: new Date().toISOString(), members: results });
  } catch (e) {
    console.error('[deep-analyze] error:', e.message);
    res.json({ error: e.message });
  }
});

// GET /api/learning/workspace?wsId=xxx — 워크스페이스 전체 분석 (관리자용)
app.get('/api/learning/workspace', async (req, res) => {
  if (!workLearner) return res.json({ error: 'work-learner not available' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND status=$2',
      [req.query.wsId, 'active']
    );
    const memberIds = rows.map(r => r.user_id);
    if (memberIds.length === 0) return res.json({ error: '멤버가 없습니다', members: [] });
    const result = await workLearner.analyzeWorkspace(pool, memberIds);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── 데몬 자동 업데이트 API ──────────────────────────────────────────────────

// 현재 서버 버전 + 배포 정보
let _serverVersion = null;
let _deployInfo = { commitMsg: '', commitDate: '', recentChanges: [] };
try {
  const { execSync } = require('child_process');
  _serverVersion = execSync('git rev-parse --short HEAD', { timeout: 3000 }).toString().trim();
  _deployInfo.commitMsg = execSync('git log -1 --format=%s', { timeout: 3000 }).toString().trim();
  _deployInfo.commitDate = execSync('git log -1 --format=%ci', { timeout: 3000 }).toString().trim();
  // 최근 5개 커밋 요약
  _deployInfo.recentChanges = execSync('git log -5 --format=%h|%s|%ci', { timeout: 3000 })
    .toString().trim().split('\n').map(line => {
      const [hash, msg, date] = line.split('|');
      return { hash, msg, date };
    });
} catch {}
if (!_serverVersion) _serverVersion = process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 8) || '54092d6';

// 데몬 명령 큐 { hostname → [commands] }
if (!global._daemonCommands) global._daemonCommands = {};

// GET /api/daemon/node-modules — npm install 실패 시 node_modules 번들 다운로드
// 서버 시작 시 미리 번들 생성 (캐시), 요청 시 즉시 전송
// uiohook-napi prebuilds에 win32-x64 포함 → Windows PC에서 그대로 사용 가능
let _nmBundlePath = null;
let _nmBundleBuilding = false;
async function _buildNmBundle() {
  if (_nmBundleBuilding) return;
  _nmBundleBuilding = true;
  try {
    const { execSync } = require('child_process');
    const nmPath = path.join(__dirname, 'node_modules');
    if (!fs.existsSync(nmPath)) return;
    const bundlePath = path.join(require('os').tmpdir(), 'orbit-node-modules.tar.gz');
    console.log('[node-modules] 번들 생성 중...');
    execSync(`tar czf "${bundlePath}" -C "${__dirname}" --exclude=".cache" --exclude=".package-lock.json" node_modules`, { timeout: 300000 });
    _nmBundlePath = bundlePath;
    const sizeMB = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1);
    console.log(`[node-modules] 번들 준비 완료: ${sizeMB}MB`);
  } catch (e) {
    console.error('[node-modules] 번들 생성 실패:', e.message);
  } finally {
    _nmBundleBuilding = false;
  }
}
// 서버 시작 30초 후 백그라운드에서 번들 생성
setTimeout(_buildNmBundle, 30000);

app.get('/api/daemon/node-modules', (req, res) => {
  if (!_nmBundlePath || !fs.existsSync(_nmBundlePath)) {
    // 번들 아직 준비 안 됨 → 즉시 생성 시도
    if (!_nmBundleBuilding) _buildNmBundle();
    return res.status(503).json({ error: 'Bundle being prepared, retry in 60s' });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename=node_modules.tar.gz');
  res.setHeader('Content-Length', fs.statSync(_nmBundlePath).size);
  fs.createReadStream(_nmBundlePath).pipe(res);
});

// === 분석 요청 큐 (맥미니 에이전트가 폴링해서 처리) ===
// NOTE: API 키는 맥미니에서만 사용. 서버에서는 분석 안 함.
if (!global._analysisQueue) global._analysisQueue = [];

// POST /api/daemon/run-vision — 분석 요청을 큐에 추가 (맥미니가 실행)
app.post('/api/daemon/run-vision', (req, res) => {
  global._analysisQueue.push({ type: 'vision', ts: new Date().toISOString(), status: 'pending' });
  res.json({ ok: true, queued: true, message: '맥미니 에이전트가 분석을 실행합니다' });
});

// GET /api/daemon/analysis-queue — 맥미니가 폴링하여 대기 중 작업 가져감
app.get('/api/daemon/analysis-queue', (req, res) => {
  const pending = global._analysisQueue.filter(q => q.status === 'pending');
  // 가져간 항목은 processing으로 변경
  pending.forEach(q => q.status = 'processing');
  res.json({ tasks: pending });
});

// POST /api/daemon/analysis-result — 맥미니가 분석 결과 전송
app.post('/api/daemon/analysis-result', async (req, res) => {
  try {
    const { type, result, error } = req.body || {};
    const ts = new Date().toISOString();
    // 큐에서 processing 항목을 완료 처리
    const processing = global._analysisQueue.find(q => q.status === 'processing' && q.type === type);
    if (processing) processing.status = error ? 'error' : 'done';
    // 오래된 큐 항목 정리 (1시간 이상)
    const cutoff = Date.now() - 60 * 60 * 1000;
    global._analysisQueue = global._analysisQueue.filter(q => new Date(q.ts).getTime() > cutoff);
    console.log(`[analysis-result] type=${type} error=${!!error} queue_size=${global._analysisQueue.length}`);
    res.json({ ok: true, ts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/daemon/version — 데몬이 폴링하여 업데이트 필요 여부 확인
app.get('/api/daemon/version', (req, res) => {
  res.json({
    version: _serverVersion || 'unknown',
    ts: new Date().toISOString(),
    deploy: _deployInfo,
  });
});

// GET /api/daemon/commands?hostname=xxx — 대기 중인 명령 가져가기
app.get('/api/daemon/commands', (req, res) => {
  const hostname = req.query.hostname || '';
  const cmds = global._daemonCommands[hostname] || [];
  // ALL 대상 명령도 포함 (5분 TTL — 모든 PC가 가져갈 수 있도록 바로 삭제 안 함)
  const allCmds = (global._daemonCommands['ALL'] || []).filter(c => {
    const age = Date.now() - new Date(c.ts).getTime();
    return age < 5 * 60 * 1000; // 5분 이내 명령만
  });
  const result = [...cmds, ...allCmds];
  // 개별 hostname 명령은 가져가면 삭제
  global._daemonCommands[hostname] = [];
  // ALL 명령은 5분 후 자동 만료 (삭제 안 함)
  global._daemonCommands['ALL'] = allCmds;
  res.json({ commands: result });
});

// GET /api/daemon/events — daemon 관련 모든 이벤트 조회 (필터 없이)
app.get('/api/daemon/events', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const { rows } = await pool.query(
      "SELECT id, type, user_id, timestamp, data_json FROM events WHERE type LIKE 'daemon.%' OR type LIKE 'install.%' OR type LIKE 'bank.%' ORDER BY timestamp DESC LIMIT $1",
      [limit]
    );
    res.json({ events: rows.map(r => ({ id: r.id, type: r.type, userId: r.user_id, ts: r.timestamp, data: r.data_json })), total: rows.length });
  } catch (e) {
    res.json({ error: e.message, events: [] });
  }
});

// POST /api/daemon/force-update — hook 응답에 업데이트 명령 끼워넣기 (켜기/끄기)
// 데몬이 구버전이라 명령 폴링이 안 될 때 사용
app.post('/api/daemon/force-update', (req, res) => {
  const { enabled } = req.body || {};
  global._forceUpdateEnabled = !!enabled;
  console.log(`[daemon] 강제 업데이트 플래그: ${global._forceUpdateEnabled ? 'ON' : 'OFF'}`);
  res.json({ ok: true, forceUpdate: global._forceUpdateEnabled });
});

// POST /api/daemon/command — 관리자가 데몬에 명령 전송
app.post('/api/daemon/command', (req, res) => {
  const { hostname = 'ALL', action, command, data } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action 필수' });
  if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
  global._daemonCommands[hostname].push({ action, command, data, ts: new Date().toISOString() });
  console.log(`[daemon-cmd] ${hostname}: ${action}`);
  res.json({ ok: true, queued: hostname });
});

// ─── 이벤트 수신 훅 ──────────────────────────────────────────────────────────

/**
 * POST /api/hook
 * Claude Code / orbit CLI 에서 직접 이벤트를 전송합니다.
 * 파일 감시 대신 HTTP POST 를 사용하면 지연 없이 실시간으로 이벤트를 처리합니다.
 * @body {{ events: MindmapEvent[], channelId?: string, memberName?: string }}
 */
app.post('/api/hook', async (req, res) => {
  try {
    // 입력 검증: events 필드 필수 + 배열 타입
    const vErr = validateBody(req.body, {
      events: { required: true, type: 'array' },
    });
    if (vErr) return res.status(400).json({ error: vErr });

    const { events = [], channelId = 'default', memberName = 'Claude' } = req.body;
    if (events.length === 0) {
      return res.status(400).json({ error: 'events 배열이 비어있습니다' });
    }

    // Authorization 헤더로 user_id 결정 (토큰 있으면 해당 유저, 없으면 'local')
    const hookToken = (req.headers.authorization || '').replace('Bearer ', '').trim()
                    || req.headers['x-api-token'] || '';
    // 1차: 직접 검증, 2차: email fallback (ID 불일치 대비)
    const _verifyFn = require('./src/auth').verifyTokenByEmail || verifyToken;
    const hookUser  = hookToken ? _verifyFn(hookToken) : null;
    const hookUserId = hookUser ? hookUser.id : 'local';
    // device_id: 클라이언트가 보낸 pcId 또는 IP (claim 시 디바이스 매칭용)
    const deviceId = req.headers['x-device-id'] || req.body.pcId || req.ip || '';

    // DB 저장 (중복 방지) + JSONL 비동기 쓰기
    const _isPg = process.env.DATABASE_URL;
    const jsonlLines = [];
    for (const event of events) {
      // user_id를 토큰에서 추출한 값으로 덮어쓰기 (프라이버시 격리)
      // hookUserId === 'local'이어도 event.userId가 있으면 보존 (신규계정 이벤트 귀속)
      if (hookUserId !== 'local') {
        event.userId = hookUserId;
      } else if (event.userId && event.userId !== 'local') {
        // 이벤트 자체에 userId가 세팅되어 있으면 그대로 사용
      } else if (deviceId) {
        // local 이벤트에 device_id 기록 (나중에 claim 시 디바이스 매칭)
        if (!event.metadata) event.metadata = {};
        event.metadata._deviceId = deviceId;
      }
      try { await Promise.resolve(insertEvent(event)); } catch (e) { console.error('[hook] insertEvent 실패:', e.message); }
      if (!_isPg) {
        jsonlLines.push(JSON.stringify({
          id: event.id, type: event.type, source: event.source,
          sessionId: event.sessionId, parentEventId: event.parentEventId,
          data: event.data, ts: event.timestamp,
        }));
      }
    }
    // JSONL 쓰기 — PG 환경에서는 스킵 (ENOSPC 방지, PG가 원본)
    if (!_isPg && jsonlLines.length > 0) {
      fs.appendFile(CONV_FILE, jsonlLines.join('\n') + '\n', e => {
        if (e) console.error('[hook] JSONL 쓰기 실패:', e.message);
      });
    }

    // ── 캡처 Vision 큐 (screen.capture + imageBase64 → 맥미니 CLI 워커용) ──
    for (const ev of events) {
      if (ev.type === 'screen.capture' && ev.data?.imageBase64) {
        // 이미지를 Vision 큐에 보관 (맥미니 워커가 폴링)
        global._visionImageQueue.push({
          id: ev.id,
          imageBase64: ev.data.imageBase64,
          app: ev.data.app || '',
          windowTitle: ev.data.windowTitle || '',
          trigger: ev.data.trigger || '',
          hostname: ev.data.hostname || '',
          sessionId: ev.sessionId,
          userId: ev.userId || hookUserId,
          ts: ev.timestamp,
        });
        // 최대 20건 유지 (메모리 관리)
        while (global._visionImageQueue.length > 20) global._visionImageQueue.shift();
        console.log(`[vision-queue] 이미지 큐잉: ${ev.data.hostname}/${ev.data.app} (큐: ${global._visionImageQueue.length}건)`);
        // base64는 DB에 저장 안 함
        delete ev.data.imageBase64;
      }
    }

    // ── 클립보드 발주서 자동 파싱 → parsed_orders 저장 ──────────────────
    if (_isPg) {
      for (const ev of events) {
        if (ev.type === 'clipboard.change' && ev.data?.orderFormat && ev.data?.parsedItems?.length > 0) {
          try {
            const pool = dbModule.getDb();
            for (const item of ev.data.parsedItems) {
              await pool.query(`
                INSERT INTO parsed_orders (source_event_id, source_type, customer, product, quantity, unit, action, raw_text, confidence)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `, [
                ev.id, ev.data.orderFormat,
                item.customer || '', item.product || '',
                item.qty || 0, item.unit || '단',
                item.action || 'add',
                (ev.data.text || '').substring(0, 500),
                item.confidence || 0.9,
              ]);
            }
            console.log(`[hook] 발주서 자동 파싱: ${ev.data.orderFormat}, ${ev.data.parsedItems.length}건 → parsed_orders`);
          } catch (e) { console.error('[hook] parsed_orders 저장 실패:', e.message); }
        }
      }
    }

    // ── 세션 자동 제목 생성 (이벤트 3개 이상 쌓인 세션) ──────────────────
    if (_isPg) {
      const sessionIds = [...new Set(events.map(e => e.sessionId).filter(Boolean))];
      for (const sid of sessionIds) {
        try {
          const sesEvents = await Promise.resolve(getEventsBySession(sid));
          if (sesEvents.length >= 3) {
            // 기존 title이 없는 세션만 자동 생성
            const sessions = await Promise.resolve(getSessions());
            const ses = sessions.find(s => s.id === sid);
            if (!ses?.title) {
              const sessStart = sesEvents.find(e => e.type === 'session.start');
              const projDir = sessStart?.data?.projectDir || sessStart?.data?.cwd || '';
              const projName = projDir ? projDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() : null;
              const firstMsg = sesEvents.find(e => e.type === 'user.message');
              const firstMsgText = (firstMsg?.data?.contentPreview || firstMsg?.data?.content || '').slice(0, 30);
              const fileCounts = {};
              for (const e of sesEvents) {
                const fp = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/').split('/').pop();
                if (fp) fileCounts[fp] = (fileCounts[fp] || 0) + 1;
              }
              const topFile = Object.entries(fileCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
              // 도메인 추론
              const domainRules = [
                [/auth|login|oauth|jwt/, '인증'], [/route|api|endpoint/, 'API'],
                [/db|database|model/, '데이터'], [/component|ui|css|style/, 'UI'],
                [/test|spec/, '테스트'], [/deploy|ci|docker/, '배포'],
              ];
              let topDomain = null;
              for (const e of sesEvents) {
                const fp = (e.data?.filePath || '').toLowerCase();
                for (const [re, label] of domainRules) {
                  if (re.test(fp)) { topDomain = label; break; }
                }
                if (topDomain) break;
              }
              // 우선순위: [projectName] firstMsg > projectName > firstMsg > topFile > domain
              let autoTitle;
              if (projName && firstMsgText) autoTitle = `[${projName}] ${firstMsgText}`;
              else if (projName) autoTitle = projName;
              else if (firstMsgText) autoTitle = firstMsgText;
              else if (topFile) autoTitle = topFile;
              else if (topDomain) autoTitle = topDomain;
              if (autoTitle) {
                await Promise.resolve(updateSessionTitle(sid, autoTitle.slice(0, 80)));
              }
            }
          }
        } catch (e) { /* 자동 타이틀 실패는 무시 */ }
      }
    }

    // ── 경량 stats (DB 집계만, 전체 이벤트 로드 없음) ────────────────────
    const stats = await Promise.resolve(getStats());

    // tool.end/error → 완료된 tool.start ID (수신된 events 배열에서만 탐색)
    const completedToolStarts = [];
    for (const ev of events) {
      if (ev.type === 'tool.end' || ev.type === 'tool.error') {
        const startEv = events.find(e =>
          (e.type === 'tool.start') && e.sessionId === ev.sessionId
        );
        if (startEv) completedToolStarts.push(startEv.id);
      }
    }

    // 보안 유출 스캔 (수신 이벤트만)
    const leaks = scanForLeaks(events);
    if (leaks.length > 0) {
      const criticals = leaks.filter(l => l.severity === 'critical');
      console.warn(`[SECURITY] ⚠️ 유출 감지 ${leaks.length}건 (critical: ${criticals.length}건) — 채널: #${channelId}`);
    }

    // 감사 로그 기록
    auditFromEvents(events);

    // Shadow AI 감지 (수신 이벤트만)
    const shadowFindings = [];
    for (const ev of events) {
      const found = checkEventForShadow(ev);
      shadowFindings.push(...found);
    }
    if (shadowFindings.length > 0) {
      console.warn(`[SHADOW AI] ⚠️ 비승인 AI 감지 ${shadowFindings.length}건 — 채널: #${channelId}`);
      shadowFindings.forEach(f => appendAuditLog('shadow.ai.detected', f, { channel: channelId }));
    }

    // ── WS 경량 브로드캐스트: 풀 그래프 대신 "새 이벤트 알림"만 전송 ───────
    // 클라이언트가 필요 시 별도 API로 그래프를 당겨가게 함 (pull 방식)
    const _broadcastLightweight = () => {
      const msg = JSON.stringify({
        type:        'hook.events',
        count:       events.length,
        stats,
        channelId,
        memberName,
        completedToolStarts,
        securityLeaks: leaks,
        shadowAI:      shadowFindings,
        // 수신된 이벤트 타입 목록만 (풀 데이터 아님)
        eventTypes: events.map(e => e.type),
      });
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        // 데이터 격리: 같은 userId 또는 같은 채널의 클라이언트에게만 전송
        const clientUserId = client._userId || 'local';
        if (hookUserId && hookUserId !== 'local' && clientUserId !== hookUserId && clientUserId !== 'local') continue;
        try { client.send(msg); } catch {}
      }
    };
    _broadcastLightweight();

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

    logger.hook.info('%d개 이벤트 수신 (채널: #%s, %s)', events.length, channelId, memberName);

    // ── 자동 에러 수정: daemon.error 이벤트 감지 → 자동 fix 명령 큐잉 ──────
    if (autoFixer) {
      for (const ev of events) {
        if (ev.type === 'daemon.error') {
          try {
            autoFixer.analyzeAndFix(ev, global._daemonCommands);
          } catch (e) {
            console.warn('[auto-fixer] 분석 오류:', e.message);
          }
        }
      }
    }

    // ── 강제 업데이트 플래그: 데몬이 구버전이면 응답에 update 명령 포함 ──────
    // 데몬이 daemon-updater 없는 구버전일 때, hook 응답으로 업데이트 지시
    const forceUpdate = global._forceUpdateEnabled || false;
    const response = { success: true, received: events.length, leaksDetected: leaks.length };
    if (forceUpdate) {
      response._commands = [{ action: 'update', reason: 'server-forced' }];
    }
    res.json(response);
  } catch (e) {
    logger.hook.error('오류: %s', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/bulk-import
 * 대량 이벤트 임포트 (로컬→프로덕션 마이그레이션용)
 * rate limit 제외, 관리자 토큰 필수
 */
app.post('/api/bulk-import', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'valid token required' });

    const { events = [] } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    let imported = 0;
    for (const event of events) {
      try {
        insertEvent(event);
        imported++;
      } catch (e) {
        // 중복 무시 (ON CONFLICT DO NOTHING)
      }
    }

    res.json({ ok: true, imported, total: events.length });
  } catch (e) {
    console.error('[BULK-IMPORT] 오류:', e.message);
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

// 클라이언트 에러 수집 (Sentry 대체)
app.post('/api/client-error', (req, res) => {
  const { msg, src, line, col, ts } = req.body || {};
  if (msg) {
    console.warn(`[CLIENT-ERROR] ${msg} (${src}:${line}:${col})`);
  }
  res.json({ ok: true });
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

// 설치 진행 상황 조회 (관리자용)
app.get('/api/install/status', async (req, res) => {
  try {
    const user = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
    if (!user) return res.json({ installs: [] });
    const allEvents = getEventsByUser ? await Promise.resolve(getEventsByUser(user.id)) : await Promise.resolve(getAllEvents(500));
    const installEvents = allEvents.filter(e => e.type === 'install.progress' || e.type === 'daemon.error')
      .sort((a, b) => a.timestamp > b.timestamp ? 1 : -1);
    // 호스트별 그룹
    const byHost = {};
    installEvents.forEach(e => {
      const host = e.data?.hostname || 'unknown';
      if (!byHost[host]) byHost[host] = { hostname: host, steps: [], errors: [], lastSeen: e.timestamp };
      if (e.type === 'install.progress') byHost[host].steps.push({ step: e.data?.step, status: e.data?.status, error: e.data?.error, ts: e.timestamp });
      if (e.type === 'daemon.error') byHost[host].errors.push({ component: e.data?.component, error: e.data?.error, ts: e.timestamp });
      byHost[host].lastSeen = e.timestamp;
    });
    res.json({ installs: Object.values(byHost) });
  } catch (e) { res.json({ installs: [], error: e.message }); }
});

// ─── 자동 에러 수정 관리 API ────────────────────────────────────────────────
// 수정 이력 조회
app.get('/api/auto-fix/history', (req, res) => {
  if (!autoFixer) return res.json({ history: [], error: 'auto-fixer not loaded' });
  const limit = parseInt(req.query.limit) || 50;
  res.json({ history: autoFixer.getFixHistory(limit) });
});

// 등록된 패턴 목록
app.get('/api/auto-fix/patterns', (req, res) => {
  if (!autoFixer) return res.json({ patterns: [] });
  res.json({ patterns: autoFixer.getPatterns() });
});

// 쿨다운 리셋 (특정 호스트/패턴에 대해 재시도 허용)
app.post('/api/auto-fix/reset-cooldown', (req, res) => {
  if (!autoFixer) return res.status(500).json({ error: 'auto-fixer not loaded' });
  const { hostname, patternId } = req.body || {};
  autoFixer.resetCooldown(hostname, patternId);
  console.log(`[auto-fixer] 쿨다운 리셋: ${hostname || 'ALL'}:${patternId || 'ALL'}`);
  res.json({ ok: true, reset: `${hostname || 'ALL'}:${patternId || 'ALL'}` });
});

// Vision 분석 큐 (맥미니 CLI 워커용 — 이미지 포함)
app.get('/api/vision/queue', (req, res) => {
  const queue = global._visionImageQueue || [];
  // 최대 3개씩 반환 (워커가 CLI로 분석)
  const batch = queue.splice(0, 3);
  res.json({ pending: queue.length, batch });
});

app.post('/api/vision/result', async (req, res) => {
  try {
    const { captureId, analysis, sessionId, userId } = req.body;
    if (!analysis) return res.status(400).json({ error: 'analysis required' });
    const event = {
      id: 'vision-' + Date.now(),
      type: 'screen.analyzed',
      source: 'vision-worker',
      sessionId: sessionId || 'vision',
      userId: userId || 'local',
      timestamp: new Date().toISOString(),
      data: analysis,
    };
    await Promise.resolve(insertEvent(event));
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// 워크플로우 학습 + 자동화 템플릿 조회
app.get('/api/workflows', (req, res) => {
  try {
    const wf = require('./src/workflow-learner');
    res.json(wf.getStatus());
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/workflows/templates', (req, res) => {
  try {
    const wf = require('./src/workflow-learner');
    const data = wf.getWorkflows();
    res.json({ templates: data.templates, patterns: data.patterns });
  } catch (e) { res.json({ templates: [], patterns: [] }); }
});

app.post('/api/workflows/generate', (req, res) => {
  try {
    const { templateId } = req.body;
    const wf = require('./src/workflow-learner');
    const executor = require('./src/automation-executor');
    const template = wf.getWorkflows().templates.find(t => t.id === templateId);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const scripts = executor.generateAll(template);
    res.json({ ok: true, scripts });
  } catch (e) { res.json({ error: e.message }); }
});

// 앱별 사용 프로필 + 피드백 조회 (tool-profiler)
app.get('/api/tool-profiles', (req, res) => {
  try {
    const profiler = require('./src/tool-profiler');
    res.json({
      profiles: profiler.getAllProfiles(),
      feedback: profiler.getRecentFeedback(20),
    });
  } catch (e) { res.json({ profiles: [], feedback: [], error: e.message }); }
});

// 트래커 상태 조회 (대시보드에서 연결 확인용)
app.get('/api/tracker/status', async (req, res) => {
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
      // 로그인 없어도 전체 이벤트 존재 시 로컬 트래커 활성 판단
      try {
        const totalStats = getStats ? await Promise.resolve(getStats()) : null;
        if (totalStats && totalStats.eventCount > 0) {
          return res.json({ online: true, lastSeen: Date.now(), hostname: 'localhost', eventCount: totalStats.eventCount });
        }
      } catch {}
      return res.json({ online: false, lastSeen: null, hostname: null, eventCount: 0 });
    }

    // 메인 DB에서 트래커 핑 조회 (PG/SQLite 양쪽 지원)
    let ping = null;
    try {
      ping = getTrackerPing ? await Promise.resolve(getTrackerPing(userId)) : null;
    } catch {}

    let isOnline = !!(ping && ping.last_ping);
    let userEventCount = 0;

    try {
      // 유저별 이벤트 확인 (PG async 대응: Promise.resolve로 래핑)
      const stats = getStatsByUser ? await Promise.resolve(getStatsByUser(userId)) : null;
      if (stats && stats.eventCount > 0) {
        userEventCount = stats.eventCount;
        isOnline = true;
      }
      // 유저 이벤트 없어도 전체 이벤트가 있으면 트래커 활성 (local 이벤트 아직 미귀속)
      // 단, eventCount는 유저 본인의 이벤트만 표시 (데이터 격리)
      if (!isOnline) {
        const totalStats = getStats ? await Promise.resolve(getStats()) : null;
        if (totalStats && totalStats.eventCount > 0) {
          isOnline = true;
        }
      }
    } catch {}

    // 워크스페이스 전체 최신 이벤트 시간 (관리자용)
    let wsLastEventAt = null;
    let lastEventAt = ping?.last_ping || null;
    try {
      const pool = dbModule.getDb();
      if (pool?.query) {
        const { rows } = await pool.query("SELECT MAX(timestamp) as last_ts FROM events WHERE type IN ('screen.capture','keyboard.chunk') AND user_id != 'local' LIMIT 1");
        if (rows[0]?.last_ts) wsLastEventAt = rows[0].last_ts;
        // 본인 최신 이벤트
        const { rows: userRows } = await pool.query("SELECT MAX(timestamp) as last_ts FROM events WHERE user_id = $1 LIMIT 1", [userId]);
        if (userRows[0]?.last_ts) lastEventAt = userRows[0].last_ts;
      }
    } catch {}

    res.json({
      online:     !!isOnline,
      lastSeen:   ping?.last_ping || null,
      lastEventAt,
      workspaceLastEventAt: wsLastEventAt,
      hostname:   ping?.hostname || null,
      eventCount: userEventCount,
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
    const _verifyFn = require('./src/auth').verifyTokenByEmail || verifyToken;
    const user = _verifyFn(authToken);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const os = require('os');
    const cfgPath = path.join(os.homedir(), '.orbit-config.json');

    // 기존 설정 로드 후 병합
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}

    const oldUserId = cfg.userId;  // 이전 ID 기록 (identity bridge용)

    const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;

    cfg.token = authToken;
    cfg.userId = user.id;
    cfg.serverUrl = serverUrl;
    cfg.email = user.email;  // email 저장 (identity 복원용)
    cfg.pcId = require('crypto').createHash('sha256')
      .update(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`)
      .digest('hex').slice(0, 16);

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`[register-hook-token] ${user.email} (${user.id}) → ${cfgPath}`);

    // Identity Bridge: 이전 ID로 된 이벤트가 있으면 새 ID로 마이그레이션
    let migrated = 0;
    if (oldUserId && oldUserId !== user.id && oldUserId !== 'local') {
      try {
        const mainDb = dbModule.getDb ? dbModule.getDb() : null;
        if (mainDb && mainDb.prepare) {
          const r1 = mainDb.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').run(user.id, oldUserId);
          const r2 = mainDb.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(user.id, oldUserId);
          migrated = (r1.changes || 0) + (r2.changes || 0);
          if (migrated > 0) console.log(`[identity-bridge] ${oldUserId} → ${user.id}: ${migrated}개 레코드 마이그레이션`);
        }
      } catch (e) { console.warn('[identity-bridge] 마이그레이션 실패:', e.message); }
    }

    // Identity Bridge: auth DB에서도 canonical ID 보장
    try {
      const { ensureCanonicalUser } = require('./src/auth');
      if (ensureCanonicalUser) ensureCanonicalUser(user.id, user.email, user.name);
    } catch {}

    res.json({ ok: true, pcId: cfg.pcId, migrated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 관리자 전체 그래프 (워크스페이스 전체 이벤트 — admin-analysis.html용) ────
app.get('/api/admin/graph', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    // 관리자 체크
    const adminEmails = (process.env.ADMIN_EMAILS || 'dlaww@kicda.com').split(',').map(s => s.trim().toLowerCase());
    if (!adminEmails.includes(user.email?.toLowerCase())) return res.status(403).json({ error: 'admin only' });
    // 전체 이벤트 (최대 5000건)
    const events = await Promise.resolve(getAllEvents(5000));
    const graph = buildGraph(events);
    res.json(graph);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 자동화 검증 API (rawInput + clipboard + vision 3중 대조) ─────────────────
app.get('/api/admin/verify-automation', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const adminEmails = (process.env.ADMIN_EMAILS || 'dlaww@kicda.com').split(',').map(s => s.trim().toLowerCase());
    if (!adminEmails.includes(user.email?.toLowerCase())) return res.status(403).json({ error: 'admin only' });

    const hours = parseInt(req.query.hours) || 24;
    const events = await Promise.resolve(getAllEvents(5000));

    // 시간 필터
    const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
    const recent = events.filter(e => e.timestamp > cutoff);

    // 3중 데이터 수집
    const keyboards = recent.filter(e => e.type === 'keyboard.chunk').map(e => ({
      userId: e.userId, ts: e.timestamp, hostname: e.data?.hostname,
      app: e.data?.appContext?.currentApp, window: e.data?.appContext?.currentWindow,
      rawInput: e.data?.rawInput || '', mouseClicks: e.data?.mouseClicks || 0,
      mousePositions: e.data?.mousePositions || [],
    }));

    const clipboards = recent.filter(e => e.type === 'clipboard.change').map(e => ({
      userId: e.userId, ts: e.timestamp, text: e.data?.text || '', sourceApp: e.data?.sourceApp || '',
    }));

    const visions = recent.filter(e => e.type === 'screen.analyzed').map(e => ({
      userId: e.userId, ts: e.timestamp, hostname: e.data?.hostname,
      app: e.data?.app, activity: e.data?.activity, automatable: e.data?.automatable,
      screen: e.data?.screen, workCategory: e.data?.workCategory,
    }));

    const orders = recent.filter(e => e.type === 'order.detected').map(e => ({
      userId: e.userId, ts: e.timestamp, items: e.data?.items || [], source: e.data?.source,
    }));

    res.json({
      period: { hours, from: cutoff },
      counts: { keyboard: keyboards.length, clipboard: clipboards.length, vision: visions.length, order: orders.length },
      keyboards, clipboards, visions, orders,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 어드민 CLI 토큰 발급 (이메일 기반, 비밀번호 불필요) ──────────────────────
// Railway 환경에서만 동작 (ADMIN_EMAILS에 등록된 이메일만 허용)
app.post('/api/admin/issue-token', (req, res) => {
  const { email, secret } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  // 보안: ADMIN_SECRET 환경변수 또는 ADMIN_EMAILS 체크
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(503).json({ error: 'ADMIN_SECRET not configured' });
  if (secret !== adminSecret && !ADMIN_EMAILS.includes(email.toLowerCase().trim())) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { getUserByEmail } = require('./src/auth');
  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const token = issueApiToken(user.id);
  res.json({ ok: true, userId: user.id, token, email: user.email, name: user.name });
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
  getEventsForUser, getSessionsForUser, resolveUserId,   // 사용자별 데이터 격리
};

// ─── 라우터 마운트 전 모든 DB 초기화 완료 (배포 시 경합 상태 방지) ──────────────
console.log('[DB Init] 주요 테이블 초기화 중...');
try {
  // 각 라우터의 초기화를 동기/비동기로 실행
  
  // 1) follow.js 초기화
  try {
    require('./routes/follow').initFollowTablesSync?.() || true;
  } catch (e) {
    console.warn('[DB Init] follow 초기화 실패:', e.message);
  }
  
  // 2) profile.js 초기화  
  try {
    const profileRouter = require('./routes/profile');
    profileRouter.initProfileTable?.() || true;
  } catch (e) {
    console.warn('[DB Init] profile 초기화 실패:', e.message);
  }
  
  // 3) llm-settings.js 초기화
  try {
    const llmRouter = require('./routes/llm-settings');
    llmRouter.ensureTable?.() || true;
  } catch (e) {
    console.warn('[DB Init] llm-settings 초기화 실패:', e.message);
  }
  
  // 4) chat.js 초기화 (비동기 — startServer에서 await)
  try {
    const chatRouter = require('./routes/chat');
    if (chatRouter.initChatTables) {
      global._chatInitPromise = chatRouter.initChatTables().catch(e => console.warn('[DB Init] chat 비동기 초기화 실패:', e.message));
    }
  } catch (e) {
    console.warn('[DB Init] chat 초기화 실패:', e.message);
  }

  // 5) analytics.js 초기화 (비동기 — startServer에서 await)
  try {
    const analyticsRouter = require('./routes/analytics');
    if (analyticsRouter.initAnalyticsTables) {
      global._analyticsInitPromise = analyticsRouter.initAnalyticsTables().catch(e => console.warn('[DB Init] analytics 비동기 초기화 실패:', e.message));
    }
  } catch (e) {
    console.warn('[DB Init] analytics 초기화 실패:', e.message);
  }
  
  console.log('[DB Init] 주요 테이블 초기화 완료');
} catch (e) {
  console.warn('[DB Init] 일부 초기화 실패 (계속 진행):', e.message);
}

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
  getEventsForUser, resolveUserId,
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
  codeAnalyzer: { generateReport, countLines, measureCyclomaticComplexity, findLongFunctions, findDuplicatePatterns, analyzeSolidViolations },
  contextBridge: { extractContext, renderContextMd, renderContextPrompt, saveContextFile },
  conflictDetector: { detectConflicts },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createSecurityRouter({
  db: dbDeps,
  shadowAiDetector: { detectShadowAI, getApprovedSources, addApprovedSource, removeApprovedSource },
  auditLog: { queryAuditLog, verifyIntegrity, renderAuditHtml },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createReportsRouter({
  db: dbDeps,
  reportGenerator: { buildReportData, renderMarkdown, renderSlackBlocks },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createThemesRouter({
  themeStore: { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme },
}));

app.use('/api', createAuthRouter({
  auth: {
    register: authRegister, login: authLogin, verifyToken,        // 기존 인증 함수
    inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, // 관리자 초대 시스템
    ADMIN_EMAILS,                                                 // 관리자 이메일 목록
  },
}));

// ─── 조직 계층 API (비활성화: 구현 예정) ──────────────────────

// Tracker OAuth (Google Drive 연동 + 설치 토큰)
app.use('/api/tracker', createTrackerOAuthRouter({
  verifyToken,
  getDb: () => db,
}));

// Tracker Files (파일 변경 감지)
const syncScheduler = getSyncScheduler({
  getValidGoogleToken: () => {
    // 구현 예시: DB에서 사용자의 Google Drive 토큰 조회
    // const token = db.prepare('SELECT googleDriveToken FROM users_google_tokens WHERE userId = ?').get(userId);
    // return token?.googleDriveToken;
    return null;  // TODO: 실제 토큰 조회 로직 구현
  },
  getUserId: () => 'tracker-system',
  getDb: () => db,
  onSync: (data) => {
    // 동기화 완료 시 WebSocket 브로드캐스트
    // broadcastAll({ type: 'tracker_sync', data });
  },
});
syncScheduler.init().catch(e => console.error('[tracker] Init error:', e.message));

app.use('/api/tracker', createTrackerFilesRouter({
  verifyToken,
  syncScheduler,
}));

// Tracker Messages (메시지 추적)
app.use('/api/tracker', createTrackerMessagesRouter({
  verifyToken,
  getValidGoogleTokenForService: (service) => {
    // 구현 예시: DB에서 각 서비스별 토큰 조회
    // const tokens = db.prepare('SELECT * FROM message_service_tokens WHERE userId = ?').get(userId);
    // return tokens?.[service];
    return null;  // TODO: 실제 토큰 조회 로직 구현
  },
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
  payment,                                                                                            // Stripe 결제 모듈 전체 전달
  upgradePlan,                                                                                        // 플랜 업그레이드 함수 (auth.js)
  verifyToken,                                                                                        // 토큰 검증 함수 (auth.js)
}));

app.use('/api', createGrowthRouter({
  growthEngine:  { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates },
  solutionStore,
  db: dbDeps,
  getEventsForUser, resolveUserId,
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
app.use('/api', createModelRouter({ getAllEvents, modelTrainer, broadcastAll, getEventsForUser, resolveUserId }));

// ─── AI 역량 포트폴리오 PDF ──────────────────────────────────────────────────
app.use('/api', createPortfolioRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 개인/팀 인사이트 분리 ───────────────────────────────────────────────────
app.use('/api', createPersonalInsightsRouter({
  getAllEvents, getEventsForUser, getSessionsForUser, resolveUserId,
  getStats,
  getSessions,
  authMiddleware: require('./src/auth').authMiddleware,
  optionalAuth:   require('./src/auth').optionalAuth,
  getInsights:    (limit, userId) => require('./src/insight-engine').getInsights(limit || 100, userId),
}));

// ─── AI 토큰 비용 추적 ────────────────────────────────────────────────────────
app.use('/api', createCostTrackerRouter({ getAllEvents, getSessions, optionalAuth: require('./src/auth').optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 외부 도구 웹훅 수신 (n8n / Slack / Notion / GitHub) ─────────────────────
app.use('/api', createWebhooksRouter({ insertEvent, broadcastAll }));

// ─── MCP Market Watcher ───────────────────────────────────────────────────────
app.use('/api', mcpWatcher.createMcpWatcherRouter({ getAllEvents }));

// ─── Orbit Badge SVG ─────────────────────────────────────────────────────────
app.use('/api', createBadgeRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Share My Session ────────────────────────────────────────────────────────
app.use('/api', createShareRouter({ getAllEvents, getSessions, getEventsBySession, insertEvent, broadcastAll, optionalAuth }));

// ─── Team Ontology Graph ──────────────────────────────────────────────────────
app.use('/api', createOntologyRouter({ getAllEvents, getFiles, optionalAuth, getEventsForUser, resolveUserId }));

// ─── AI Leaderboard ───────────────────────────────────────────────────────────
app.use('/api', createLeaderboardRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── ROI Calculator ───────────────────────────────────────────────────────────
app.use('/api', createRoiRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Analytics (사용자 행동 분석) ────────────────────────────────────────────
app.use('/api', createAnalyticsRouter({ getDb: dbModule.getDb }));
app.use('/api', createProfileRouter({ getDb: dbModule.getDb, verifyToken }));
// ─── 알림 라우터 ──────────────────────────────────────────────────────────────
const { createNotificationRouter, createNotification } = require('./routes/notification');
app.use('/api', createNotificationRouter({ getDb: dbModule.getDb, verifyToken }));
app.use('/api', createFollowRouter({ getDb: dbModule.getDb, verifyToken, searchUsers, getUserById, createNotification })); // searchUsers + getUserById + createNotification 주입
app.use('/api', createChatRouter({ getDb: dbModule.getDb, verifyToken, broadcastToRoom }));

// ─── 마켓플레이스 및 추천 엔진 ────────────────────────────────────────────────────
app.use('/api', createMarketplaceRouter({ verifyToken, dbModule }));
app.use('/api', createRecommendationsRouter({ verifyToken, dbModule }));

// ─── Workspace (팀/회사 관리) ─────────────────────────────────────────────────────
app.use('/api', createWorkspaceRouter({ getDb: dbModule.getDb, verifyToken, getUserById, ADMIN_EMAILS, createNotification }));

// ─── Google Drive 사용자 백업 ────────────────────────────────────────────────
const createGdriveRouter = require('./routes/gdrive');
app.use('/api', createGdriveRouter({
  verifyToken,
  auth: { getValidGoogleToken, getOAuthTokens, saveOAuthTokens },
  dbModule: { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent, getDb: dbModule.getDb },
  gdriveUserBackup,
}));

// ─── Regional Insight ────────────────────────────────────────────────────────
app.use('/api', createRegionalInsightRouter({ getAllEvents }));

// ─── Orbit Points Economy ────────────────────────────────────────────────────
app.use('/api', createPointsRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Orbit Certificate & Score ───────────────────────────────────────────────
app.use('/api', createCertificateRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── MCP 서버 (Claude Desktop 연동) ─────────────────────────────────────────
app.use('/api', createMcpRouter({
  getAllEvents,
  getStats,
  getSessions,
  getInsights:    (limit, userId) => require('./src/insight-engine').getInsights(limit || 50, userId),
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
app.use('/api', createPurposesRouter({ getAllEvents, getEventsBySession, getSessions, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 개인 학습 에이전트 ───────────────────────────────────────────────────────
const createPersonalLearningRouter = require('./routes/personal-learning');
app.use('/api', createPersonalLearningRouter({ getDb: dbModule.getDb, insertEvent, broadcastAll }));

// ─── Phase 2: 작업 분석 엔진 ─────────────────────────────────────────────────
app.use('/api', createWorkAnalysisRouter({ verifyToken, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Phase 3: 팔란티어 인텔리전스 ────────────────────────────────────────────
app.use('/api', createIntelligenceRouter({ verifyToken, getEventsForUser, resolveUserId, getDb: dbModule.getDb, getUserById, ADMIN_EMAILS }));

// ─── Phase 5: AI 학습 + 맞춤 추천 ────────────────────────────────────────────
app.use('/api', createLearningRouter({ verifyToken, getEventsForUser, resolveUserId }));

// ─── 데이터 관리 (Export / Delete / Summary) ─────────────────────────────────
const createDataManagementRouter = require('./routes/data-management');
app.use('/api', createDataManagementRouter({ verifyToken, dbModule }));

// ─── Issue Predictor Agent (실시간 이슈 감지 8개 규칙) ────────────────────────
app.use('/api/issues', require('./routes/issue-predictor')({ getDb: dbModule.getDb }));

// ─── Data Archive (데이터 보존 모니터 + 아카이브) ─────────────────────────────
app.use('/api/data', require('./routes/data-archive')({ getDb: dbModule.getDb }));

// ─── Automation Engine (변수 대응 자동화) ──────────────────────────────────────
app.use('/api/automation', require('./routes/automation-engine')({ getDb: dbModule.getDb }));

// ─── Orbit OS (팔란티어 스타일 회사 OS 명령 구조) ─────────────────────────────
app.use('/api/os', require('./routes/orbit-os')({ getDb: dbModule.getDb }));

// ─── 데모 시드 (개발/미리보기용) ─────────────────────────────────────────────
app.post('/api/demo/seed', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { ulid } = require('ulid');
    const now = Date.now();
    const sessions = [
      { id: 'demo-api-dev',     project: 'orbit-backend',   label: 'API 엔드포인트 개발' },
      { id: 'demo-react-ui',    project: 'orbit-frontend',  label: 'React 컴포넌트 구현' },
      { id: 'demo-db-optimize', project: 'orbit-backend',   label: 'DB 쿼리 최적화' },
      { id: 'demo-auth-flow',   project: 'orbit-auth',      label: '인증 플로우 리팩토링' },
      { id: 'demo-docs-review', project: 'orbit-docs',      label: 'API 문서 작성' },
    ];
    const types = [
      { type: 'file.write',    files: ['server.js','auth.js','routes/api.js','db.js','index.tsx','App.tsx','useAuth.ts'] },
      { type: 'tool.end',      tools: ['Edit','Write','Read','Bash','Grep'] },
      { type: 'user.message',  msgs: ['API 응답 형식 변경해줘','로그인 리다이렉트 수정','쿼리 느린 부분 최적화','테스트 추가해줘','타입 에러 수정'] },
      { type: 'assistant.message', msgs: ['수정 완료했습니다','최적화 적용했습니다','테스트 통과 확인됨'] },
      { type: 'git.commit',    msgs: ['fix: auth redirect','feat: add pagination','refactor: query optimize'] },
    ];

    const events = [];
    for (const sess of sessions) {
      // session.start
      events.push({
        id: ulid(), type: 'session.start', sessionId: sess.id,
        userId: 'local', channelId: 'default', source: 'demo',
        timestamp: new Date(now - 3600_000 * (5 - sessions.indexOf(sess))).toISOString(),
        data: { title: sess.label, projectDir: `/projects/${sess.project}` },
      });
      // 세션당 8~15개 이벤트
      const count = 8 + Math.floor(Math.random() * 8);
      for (let i = 0; i < count; i++) {
        const tg = types[Math.floor(Math.random() * types.length)];
        const ts = new Date(now - 3600_000 * (5 - sessions.indexOf(sess)) + i * 120_000).toISOString();
        const ev = { id: ulid(), type: tg.type, sessionId: sess.id, userId: 'local', channelId: 'default', source: 'demo', timestamp: ts, data: {} };
        if (tg.files) {
          const f = tg.files[Math.floor(Math.random() * tg.files.length)];
          ev.data = { filePath: `/projects/${sess.project}/${f}`, fileName: f };
        }
        if (tg.tools) ev.data.toolName = tg.tools[Math.floor(Math.random() * tg.tools.length)];
        if (tg.msgs) ev.data.contentPreview = tg.msgs[Math.floor(Math.random() * tg.msgs.length)];
        events.push(ev);
      }
    }

    // media.transcript 데모
    events.push({
      id: ulid(), type: 'media.transcript', sessionId: 'personal',
      userId: 'local', channelId: 'default', source: 'demo',
      timestamp: new Date(now - 1800_000).toISOString(),
      data: { text: 'React에서 useReducer는 복잡한 상태 관리에 적합합니다. useState보다 액션 기반으로 상태를 변경하면 예측 가능성이 높아집니다.', source: 'speech', lang: 'ko-KR', duration: 120 },
    });
    events.push({
      id: ulid(), type: 'media.transcript', sessionId: 'personal',
      userId: 'local', channelId: 'default', source: 'demo',
      timestamp: new Date(now - 900_000).toISOString(),
      data: { text: 'SQL 인덱스 설계 시 카디널리티가 높은 컬럼을 앞에 배치하고, 커버링 인덱스를 활용하면 쿼리 성능이 크게 향상됩니다.', source: 'speech', lang: 'ko-KR', duration: 180 },
    });

    for (const ev of events) {
      try { insertEvent(ev); } catch {}
    }

    broadcastAll({ type: 'refresh' });
    res.json({ ok: true, eventCount: events.length, sessions: sessions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 데모 데이터 삭제
app.post('/api/demo/clear', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const db = dbModule.getDb();
    const deleted = db.prepare(`DELETE FROM events WHERE source = 'demo'`).run();
    broadcastAll({ type: 'refresh' });
    res.json({ ok: true, deleted: deleted.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 스킬 API ────────────────────────────────────────────────────────────────
app.post('/api/skills', (req, res) => {
  const db = dbModule.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT, trigger_pattern TEXT,
    prompt TEXT, type TEXT DEFAULT 'custom', source TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const { name, description, trigger, prompt, type, source } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare('INSERT INTO skills (name, description, trigger_pattern, prompt, type, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, description || '', trigger || '', prompt || '', type || 'custom', source || 'user');
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/skills', (req, res) => {
  const db = dbModule.getDb();
  try {
    const rows = db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all();
    res.json(rows);
  } catch { res.json([]); }
});

// ─── 초대 페이지 라우트 ──────────────────────────────────────────────────────
app.get('/invite/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// ─── 클라우드 동기화 ──────────────────────────────────────────────────────────
const createSyncRouter = require('./routes/sync');
app.use('/api', createSyncRouter({ getDb: dbModule.getDb, getAllEvents }));

// ─── 회사 컨설팅 플랫폼 (Company Ontology + Diagnosis + Learning) ───────────
try { companyOntology.ensureCompanyTables(dbModule.getDb()); } catch (e) { console.warn('[DB Init] company-ontology 초기화 스킵:', e.message); }
app.use('/api', createCompanyRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createDiagnosisRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createCompanyLearningRouter({ getDb: dbModule.getDb }));
app.use('/api', createNodesRouter({ getDb: dbModule.getDb })); // 3D 노드 분류 + 궤도 레이아웃
app.use('/api', createWorkspaceActivityRouter()); // 워크스페이스 협업 신호 분석

// ─── JSONL 파일 감시 (레거시 이벤트 소스 지원) ───────────────────────────────
// /api/hook 를 사용하지 않는 구버전 save-turn.js 호환용
// PG 환경에서는 JSONL 감시 불필요 (hook → PG 직접 삽입)
let lastBytePos = 0;
if (!process.env.DATABASE_URL) {
try { lastBytePos = fs.statSync(CONV_FILE).size; } catch {}
}

if (!process.env.DATABASE_URL) {
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

      // 사용자별 데이터 격리: 각 WS 클라이언트에 본인 그래프만 전송
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          const uid = client._userId || 'local';
          const g   = uid !== 'local' && uid !== 'anonymous'
                        ? getFullGraphForUser(uid) : graph;
          const s   = getSessionsForUser(uid);
          client.send(JSON.stringify({ type: 'update', graph: g, stats, sessions: s, completedToolStarts }));
        } catch {}
      }
      console.log(`[WATCH] ${lines.length}개 새 이벤트 감지 → 사용자별 그래프 업데이트`);
    }
  } catch (e) {
    console.error('[WATCH] 오류:', e.message);
  }
});
} // end if (!process.env.DATABASE_URL) — JSONL 감시

// ─── 활동 점수 주기적 업데이트 (30초, 캐시 활용) ─────────────────────────────
setInterval(() => {
  if (wss.clients.size === 0) return;
  try {
    // 사용자별 활동 점수 전송 (캐시된 그래프 사용)
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        const uid   = client._userId || 'local';
        const graph = (uid !== 'local' && uid !== 'anonymous')
          ? getFullGraphForUser(uid) : getFullGraph();

        const scores = {};
        for (const node of graph.nodes) {
          scores[node.id] = {
            activityScore: node.activityScore,
            size:          node.size,
            borderWidth:   node.borderWidth,
            shadow:        node.shadow,
          };
        }
        client.send(JSON.stringify({ type: 'activity', scores }));
      } catch {}
    }
  } catch (e) {
    console.error('[ACTIVITY] 오류:', e.message);
  }
}, 30000);

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

// ── 행동 데이터 동기화 API ─────────────────────────────────────────────────────
// 브라우저의 orbit3d-behavior.js가 주기적으로 POST하는 행동 스냅샷 수신
const _behaviorStore = new Map(); // userId → [{ ts, score, kps, cps, ... }]

app.post('/api/behavior/sync', (req, res) => {
  try {
    const token  = (req.headers.authorization || '').replace('Bearer ','').trim() || req.query.token;
    const user   = _verifyToken(token);
    const uid    = user?.id || 'anonymous';
    const { score, kps, cps, history, sessionId } = req.body || {};
    if (typeof score !== 'number') return res.status(400).json({ error: 'score required' });

    const now = Date.now();
    const snap = { ts: now, score, kps: kps || 0, cps: cps || 0, sessionId };

    // 인메모리 저장 (최대 120개 = 2분)
    if (!_behaviorStore.has(uid)) _behaviorStore.set(uid, []);
    const arr = _behaviorStore.get(uid);
    arr.push(snap);
    if (arr.length > 120) arr.splice(0, arr.length - 120);

    // WebSocket으로 실시간 브로드캐스트 (같은 사용자 세션에게만)
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client._userId && client._userId !== uid && uid !== 'anonymous') continue;
      try { client.send(JSON.stringify({ type: 'behavior_score', uid, score, kps, cps, ts: now })); } catch {}
    }

    res.json({ ok: true, uid, score, buffered: arr.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET 최근 행동 통계
app.get('/api/behavior/stats', (req, res) => {
  const token  = (req.headers.authorization || '').replace('Bearer ','').trim() || req.query.token;
  const user   = _verifyToken(token);
  const uid    = user?.id || 'anonymous';
  const arr    = _behaviorStore.get(uid) || [];
  const avg    = arr.length ? arr.reduce((s,x) => s + x.score, 0) / arr.length : 0;
  const peak   = arr.length ? Math.max(...arr.map(x => x.score)) : 0;
  res.json({ ok: true, uid, snapshots: arr.length, avgScore: +avg.toFixed(3), peakScore: +peak.toFixed(3), latest: arr.slice(-5) });
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
// ─── API 버전닝: /api/v1/* → /api/* 포워딩 (하위호환 유지) ──────────────────
// /api/v1/graph → /api/graph, /api/v1/tracker/status → /api/tracker/status 등
app.use('/api/v1', (req, res, next) => {
  // req.url 을 /api + 원래 경로로 재작성하여 기존 핸들러로 라우팅
  req.url = '/api' + req.url;
  // Express의 내부 라우터로 재전달 (미들웨어 스택 우회)
  app._router.handle(req, res, next);
});
console.log('[API] /api/v1/* → /api/* alias registered');

// ─── 서버 시작 (PG auth 복원 후 listen) ────────────────────────────────────
async function startServer() {
  // PostgreSQL: 테이블 초기화 완료 대기 (재배포 시 경합 상태 방지)
  if (process.env.DATABASE_URL && dbModule.waitForTables) {
    await dbModule.waitForTables().catch(e => console.warn('[startup] PG 테이블 대기 실패:', e.message));
  }
  // 비동기 테이블 초기화 완료 대기 (chat, analytics)
  if (global._chatInitPromise) await global._chatInitPromise;
  if (global._analyticsInitPromise) await global._analyticsInitPromise;
  // Railway 재배포 후 SQLite가 비어있으면 PG에서 사용자/토큰 복원
  if (process.env.DATABASE_URL) {
    await authInitFromPg().catch(e => console.warn('[startup] auth PG 복원 실패:', e.message));
  }
  server.listen(PORT, async () => {
  const stats = await Promise.resolve(getStats());
  logger.info(`Orbit AI v2.0.0 — http://localhost:${PORT}`, {
    events: stats?.eventCount ?? '?',
    sessions: stats?.sessionCount ?? '?',
    files: stats?.fileCount ?? '?',
    oauth: enabledProviders.join(', ') || '미설정',
    anthropic: '맥미니 전용', // NOTE: API 키는 맥미니에서만 사용. 서버에서는 분석 안 함.
  });
  // 개발 환경에서는 엔드포인트 목록 출력 (프로덕션 JSON 로그에서는 위 메타에 포함)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   이벤트: ${stats?.eventCount ?? '?'}개 | 세션: ${stats?.sessionCount ?? '?'}개 | 파일: ${stats?.fileCount ?? '?'}개`);
    console.log(`   감시 파일: ${CONV_FILE}`);
    console.log(`   OAuth: [${enabledProviders.join(', ') || '미설정'}]`);
    console.log(`   Git hooks 설치: curl http://localhost:${PORT}/api/git/install | bash`);
    console.log(`   MCP 서버: http://localhost:${PORT}/api/mcp`);
    console.log(`   학습 데이터: http://localhost:${PORT}/api/learned-insights\n`);
  }

  // outcome 테이블 초기화 (기존 DB에 테이블 없으면 생성)
  outcomeStore.initOutcomeTable();

  // 마켓 테이블 초기화 + 사용량 트래커 시작
  try { marketStore.initMarketTables(); } catch (e) { console.warn('[DB Init] market-store 초기화 스킵:', e.message); }
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
  // 2시간마다 Drive 백업 + Sheets 학습 데이터 내보내기 (자동)
  async function _autoGdriveSync() {
    try {
      const users = getGoogleOAuthUsers();
      for (const u of users) {
        try {
          const token = await getValidGoogleToken(u.id);
          if (!token) continue;
          // JSON 백업
          await gdriveUserBackup.backupUserDataToDrive(u.id, token,
            { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent });
          // Sheets 학습 데이터 자동 내보내기
          try {
            await gdriveUserBackup.exportLearningSheet(u.id, token,
              { getAllEvents, getEventsByUser, getSessionsByUser, getSessions });
            console.log(`[gdrive-auto] ${u.email} Sheets 내보내기 완료`);
          } catch (e) {
            console.warn(`[gdrive-auto] ${u.email} Sheets 실패:`, e.message);
          }
        } catch (e) {
          console.warn(`[gdrive-auto] ${u.email} 백업 실패:`, e.message);
        }
      }
    } catch {}
  }
  // 서버 시작 5분 후 첫 실행 + 이후 1시간마다
  setTimeout(_autoGdriveSync, 5 * 60 * 1000);
  setInterval(_autoGdriveSync, 1 * 60 * 60 * 1000);

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
  });  // server.listen 콜백 끝
}
startServer();

// ─── Graceful shutdown ──────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info('%s 수신 — 정상 종료 시작', signal);
  if (server && server.close) {
    server.close(() => {
      logger.info('HTTP 서버 종료');
      // PG pool이 db-pg.js 내부에 있으므로 모듈 종료 함수 호출
      if (dbModule.close) {
        Promise.resolve(dbModule.close()).then(() => {
          logger.info('DB 연결 종료');
          process.exit(0);
        }).catch(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  }
  // 10초 후 강제 종료
  setTimeout(() => { logger.warn('강제 종료'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
