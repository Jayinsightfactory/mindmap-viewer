/**
 * server.js
 * Express + WebSocket + SQLite + Graph Engine
 * http://localhost:4747
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

// DATABASE_URL 있으면 PostgreSQL, 없으면 SQLite 자동 선택
const dbModule = process.env.DATABASE_URL ? require('./src/db-pg') : require('./src/db');
const { initDatabase, getAllEvents, getEventsBySession, getEventsByChannel, searchEvents, getSessions, getFiles, getAnnotations, insertAnnotation, deleteAnnotation, insertEvent, rollbackToEvent, clearAll, getStats, getUserLabels, setUserLabel, deleteUserLabel, getUserCategories, upsertUserCategory, deleteUserCategory, getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig } = dbModule;
const { buildGraph, computeActivityScores, applyActivityVisualization, suggestLabel } = require('./src/graph-engine');
const { annotateEventsWithPurpose, classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES } = require('./src/purpose-classifier');
const { createAnnotationEvent } = require('./src/event-normalizer');
const { getAiStyle, AI_SOURCES } = require('./adapters/ai-adapter-base');
const { generateReport } = require('./src/code-analyzer');
const { scanForLeaks } = require('./src/security-scanner');
const { buildReportData, renderMarkdown, renderSlackBlocks } = require('./src/report-generator');
const { extractContext, renderContextMd, renderContextPrompt, saveContextFile } = require('./src/context-bridge');
const { detectConflicts, checkNewEvent } = require('./src/conflict-detector');
const { appendAuditLog, auditFromEvents, queryAuditLog, verifyIntegrity, renderAuditHtml, AUDIT_TYPES } = require('./src/audit-log');
const { detectShadowAI, checkEventForShadow, getApprovedSources, addApprovedSource, removeApprovedSource } = require('./src/shadow-ai-detector');
const { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme } = require('./src/theme-store');
const { register: authRegister, login: authLogin, verifyToken, optionalAuth } = require('./src/auth');
const { PLANS, createPayment, confirmPayment, MOCK_MODE: paymentMockMode } = require('./src/payment');
const { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates } = require('./src/growth-engine');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4747;
const CONV_FILE = path.join(__dirname, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

// ─── 채널(Room) 시스템 ──────────────────────────────
// 각 채널은 독립된 마인드맵 공간. 팀원이 같은 채널에 접속하면 실시간 공유.
// channelId → Set<WebSocket>
const channelClients = new Map();   // channelId → Set<ws>
const wsChannelMap   = new WeakMap(); // ws → { channelId, memberId, memberName, memberColor }

const MEMBER_COLORS = [
  '#58a6ff','#3fb950','#bc8cff','#f778ba','#ffa657',
  '#39d2c0','#ff9500','#79c0ff','#f85149','#8957e5',
];
let memberColorIdx = 0;

function getMemberColor() {
  const c = MEMBER_COLORS[memberColorIdx % MEMBER_COLORS.length];
  memberColorIdx++;
  return c;
}

// ─── 초기화 ─────────────────────────────────────────
if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, '');
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const db = initDatabase();
console.log('[DB] SQLite 초기화 완료');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── 그래프 빌드 헬퍼 ──────────────────────────────
function getFullGraph(sessionFilter, channelFilter) {
  const rawEvents = sessionFilter
    ? getEventsBySession(sessionFilter)
    : channelFilter
      ? (getEventsByChannel ? getEventsByChannel(channelFilter) : getAllEvents().filter(e => e.channelId === channelFilter))
      : getAllEvents();
  // 목적 자동 분류 → 각 이벤트에 purposeId/purposeColor 주입
  const events = annotateEventsWithPurpose(rawEvents);
  const graph = buildGraph(events);
  computeActivityScores(graph.nodes, Date.now());
  applyActivityVisualization(graph.nodes);
  return graph;
}

// ─── 채널별 브로드캐스트 ───────────────────────────
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

function broadcastAll(msg) {
  // 채널 미지정 클라이언트(구버전 호환) + 모든 채널
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

function getChannelMembers(channelId) {
  const clients = channelClients.get(channelId);
  if (!clients) return [];
  return Array.from(clients).map(ws => wsChannelMap.get(ws)).filter(Boolean);
}

// ─── WebSocket ──────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] 클라이언트 연결됨');

  // 초기 init — 채널 미지정 상태로 기본 데이터 전송
  try {
    const graph = getFullGraph();
    const sessions = getSessions();
    const stats = getStats();
    const userConfig = getUserConfig();
    ws.send(JSON.stringify({ type: 'init', graph, sessions, stats, userConfig }));
  } catch (e) {
    console.error('[WS] init 오류:', e.message);
  }

  // 클라이언트 → 서버 메시지
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ── 채널 입장 ──────────────────────────────────
      if (msg.type === 'channel.join') {
        const channelId  = (msg.channelId || 'default').trim();
        const memberName = (msg.memberName || '익명').substring(0, 20);
        const memberId   = msg.memberId || `m_${Date.now()}`;
        const memberColor = getMemberColor();

        // 기존 채널에서 퇴장
        const prev = wsChannelMap.get(ws);
        if (prev) {
          const prevClients = channelClients.get(prev.channelId);
          if (prevClients) {
            prevClients.delete(ws);
            if (prevClients.size === 0) channelClients.delete(prev.channelId);
          }
          broadcastToChannel(prev.channelId, {
            type: 'channel.member_left',
            memberId: prev.memberId,
            memberName: prev.memberName,
            members: getChannelMembers(prev.channelId),
          });
        }

        // 새 채널 입장
        if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
        channelClients.get(channelId).add(ws);
        wsChannelMap.set(ws, { channelId, memberId, memberName, memberColor });

        // 이 클라이언트에 채널 정보 + 현재 그래프 전송
        const graph    = getFullGraph();
        const sessions = getSessions();
        const stats    = getStats();
        ws.send(JSON.stringify({
          type: 'channel.joined',
          channelId,
          memberId,
          memberName,
          memberColor,
          members: getChannelMembers(channelId),
          graph,
          sessions,
          stats,
        }));

        // 같은 채널 다른 멤버들에게 입장 알림
        broadcastToChannel(channelId, {
          type: 'channel.member_joined',
          memberId,
          memberName,
          memberColor,
          members: getChannelMembers(channelId),
        });

        console.log(`[CHANNEL] "${memberName}" → #${channelId} (총 ${channelClients.get(channelId).size}명)`);
        return;
      }

      // ── 채널 내 커서/활동 브로드캐스트 ─────────────
      if (msg.type === 'channel.activity') {
        const info = wsChannelMap.get(ws);
        if (info) {
          broadcastToChannel(info.channelId, {
            type: 'channel.activity',
            memberId: info.memberId,
            memberName: info.memberName,
            memberColor: info.memberColor,
            action: msg.action,     // 'hover_node', 'select_node', 'typing' 등
            nodeId: msg.nodeId,
          });
        }
        return;
      }

      // ── 주석 생성 ──────────────────────────────────
      if (msg.type === 'annotation.create') {
        const event = createAnnotationEvent(msg.data);
        insertEvent(event);
        const entry = { id: event.id, type: event.type, source: event.source, sessionId: event.sessionId, parentEventId: event.parentEventId, data: event.data, ts: event.timestamp };
        fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');

        const info = wsChannelMap.get(ws);
        const channelId = info?.channelId;
        const payload = { type: 'event', event, graph: getFullGraph() };
        if (channelId) {
          broadcastToChannel(channelId, payload);
        } else {
          broadcastAll(payload);
        }
      }

      // ── 세션 필터 ──────────────────────────────────
      if (msg.type === 'filter') {
        const graph = getFullGraph(msg.sessionId);
        ws.send(JSON.stringify({ type: 'filtered', graph }));
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
        memberId,
        memberName,
        members: getChannelMembers(channelId),
      });
      console.log(`[CHANNEL] "${memberName}" 퇴장 (#${channelId})`);
    }
    console.log('[WS] 클라이언트 연결 종료');
  });

  ws.on('error', e => console.error('[WS] 에러:', e.message));
});

function broadcast(msg) {
  // 기존 코드 호환 — 모든 채널에 브로드캐스트
  broadcastAll(msg);
}

// ─── POST /api/hook — save-turn.js 직접 수신 ────────
// 파일 감시 대신 HTTP POST로 직접 이벤트 수신 (레이턴시 제거, 신뢰성 향상)
// Body: { events: MindmapEvent[], channelId?: string, memberName?: string }
app.post('/api/hook', (req, res) => {
  try {
    const { events = [], channelId = 'default', memberName = 'Claude' } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events 배열 필요' });
    }

    // DB + JSONL 저장 (이미 save-turn.js 에서 저장됨 — 중복 방지용 INSERT OR IGNORE)
    for (const event of events) {
      try { insertEvent(event); } catch {}
      try {
        const entry = { id: event.id, type: event.type, source: event.source,
          sessionId: event.sessionId, parentEventId: event.parentEventId,
          data: event.data, ts: event.timestamp };
        fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
      } catch {}
    }

    // 그래프 재계산 + 브로드캐스트
    const graph    = getFullGraph();
    const stats    = getStats();
    const sessions = getSessions();

    // tool.start → tool.end 완료 노드 추출
    const completedToolStarts = [];
    for (const ev of events) {
      if (ev.type === 'tool.end' || ev.type === 'tool.error') {
        const startNode = graph.nodes.find(n =>
          (n.eventType || n.type) === 'tool.start' && n.sessionId === ev.sessionId
        );
        if (startNode) completedToolStarts.push(startNode.id);
      }
    }

    // ── 보안 유출 스캔 ────────────────────────────────
    const leaks = scanForLeaks(events);
    if (leaks.length > 0) {
      const criticals = leaks.filter(l => l.severity === 'critical');
      console.warn(`[SECURITY] ⚠️ 유출 감지 ${leaks.length}건 (critical: ${criticals.length}건) — 채널: #${channelId}`);
    }

    // ── 감사 로그 기록 (Phase 3-G) ────────────────
    auditFromEvents(events);

    // ── Shadow AI 실시간 감지 (Phase 3-H) ─────────
    const shadowFindings = [];
    for (const ev of events) {
      const found = checkEventForShadow(ev);
      shadowFindings.push(...found);
    }
    if (shadowFindings.length > 0) {
      console.warn(`[SHADOW AI] ⚠️ 비승인 AI 감지 ${shadowFindings.length}건 — 채널: #${channelId}`);
      shadowFindings.forEach(f => appendAuditLog('shadow.ai.detected', f, { channel: channelId }));
    }

    // ── 충돌 감지 (Phase 1-C) ──────────────────────
    const recentEventsForConflict = getAllEvents().slice(-200);
    const newConflicts = [];
    for (const ev of events) {
      const found = checkNewEvent(ev, recentEventsForConflict);
      newConflicts.push(...found);
    }
    if (newConflicts.length > 0) {
      console.warn(`[CONFLICT] ⚠️ 충돌 감지 ${newConflicts.length}건 — 채널: #${channelId}`);
    }

    const payload = { type: 'update', graph, stats, sessions, completedToolStarts,
      hookSource: { channelId, memberName },
      securityLeaks: leaks,       // 클라이언트에 전달 (채널 내 경보)
      conflicts: newConflicts,    // 충돌 감지 결과
      shadowAI: shadowFindings,   // Shadow AI 감지 결과
    };

    // 채널이 있으면 해당 채널에만, 없으면 전체 브로드캐스트
    if (channelClients.has(channelId)) {
      broadcastToChannel(channelId, payload);
    } else {
      broadcastAll(payload);
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
      id: channelId,
      memberCount: clients.size,
      members: getChannelMembers(channelId),
    });
  });
  res.json(channels);
});

// ─── 헬스체크 (Docker / Railway / Render 등 배포 플랫폼용) ─
app.get('/health', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      status: 'ok',
      version: '2.0.0',
      uptime: Math.round(process.uptime()),
      events: stats.eventCount,
      sessions: stats.sessionCount,
      channels: channelClients.size,
      clients: wss.clients.size,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ─── JSONL 파일 감시 (새 이벤트 실시간 감지) ────────
let lastBytePos = 0;
try { lastBytePos = fs.statSync(CONV_FILE).size; } catch {}

chokidar.watch(CONV_FILE, {
  usePolling: true,
  interval: 300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 }
}).on('change', () => {
  try {
    const stat = fs.statSync(CONV_FILE);
    if (stat.size <= lastBytePos) {
      // 파일이 줄어든 경우 (clear/rollback)
      lastBytePos = stat.size;
      return;
    }

    const fd = fs.openSync(CONV_FILE, 'r');
    const buf = Buffer.alloc(stat.size - lastBytePos);
    fs.readSync(fd, buf, 0, buf.length, lastBytePos);
    fs.closeSync(fd);
    lastBytePos = stat.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (lines.length > 0) {
      const graph = getFullGraph();
      const stats = getStats();
      const sessions = getSessions();

      // tool.start → tool.end 완료 노드 ID 추출 (FX 게임 이펙트 완료 신호)
      // tool.end/tool.error 이벤트가 들어오면 같은 세션의 tool.start 노드를 "완료"로 표시
      const completedToolStarts = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'tool.end' || ev.type === 'tool.error') {
            // 같은 세션에서 가장 최근 tool.start 노드를 찾아서 완료 표시
            const startNode = graph.nodes.find(n =>
              (n.eventType || n.type) === 'tool.start' &&
              n.sessionId === ev.sessionId
            );
            if (startNode) completedToolStarts.push(startNode.id);
          }
        } catch {}
      }

      broadcast({ type: 'update', graph, stats, sessions, completedToolStarts });
      console.log(`[WATCH] ${lines.length}개 새 이벤트 감지 → 그래프 업데이트`);
    }
  } catch (e) {
    console.error('[WATCH] 오류:', e.message);
  }
});

// ─── 활동 점수 주기적 업데이트 (10초) ──────────────
setInterval(() => {
  if (wss.clients.size === 0) return;
  try {
    const events = getAllEvents();
    const graph = buildGraph(events);
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);

    const scores = {};
    for (const node of graph.nodes) {
      scores[node.id] = {
        activityScore: node.activityScore,
        size: node.size,
        borderWidth: node.borderWidth,
        shadow: node.shadow,
      };
    }
    broadcast({ type: 'activity', scores });
  } catch (e) {
    console.error('[ACTIVITY] 오류:', e.message);
  }
}, 10000);

// ─── REST API ───────────────────────────────────────

// 전체 그래프
app.get('/api/graph', (req, res) => {
  const graph = getFullGraph(req.query.session, req.query.channel);
  res.json(graph);
});

// 세션 목록
app.get('/api/sessions', (req, res) => {
  res.json(getSessions());
});

// ── 목적 자동 분류 ──────────────────────────────────
// GET /api/purposes?channel=X  → 채널별 목적 윈도우 목록
// GET /api/purposes/summary?channel=X → 목적별 집계 통계
// GET /api/purposes/categories → 전체 목적 카테고리 정의
app.get('/api/purposes/categories', (req, res) => {
  res.json(Object.values(PURPOSE_CATEGORIES));
});

app.get('/api/purposes/summary', (req, res) => {
  const events = req.query.channel
    ? (getEventsByChannel ? getEventsByChannel(req.query.channel) : getAllEvents().filter(e => e.channelId === req.query.channel))
    : getAllEvents();
  res.json(summarizePurposes(events));
});

app.get('/api/purposes', (req, res) => {
  const events = req.query.channel
    ? (getEventsByChannel ? getEventsByChannel(req.query.channel) : getAllEvents().filter(e => e.channelId === req.query.channel))
    : req.query.session
      ? getEventsBySession(req.query.session)
      : getAllEvents();
  res.json(classifyPurposes(events));
});

// 이벤트 검색
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  res.json(searchEvents(q));
});

// ── 멤버 오버레이 API ───────────────────────────────
// GET /api/members
// → 모든 채널에서 활동한 멤버 목록 + 각 멤버의 채널/통계
app.get('/api/members', (req, res) => {
  const allEvents  = getAllEvents();
  const allSessions = getSessions();
  const memberMap  = new Map(); // memberName → { channels, eventCount, sources, lastActive }

  // 세션의 memberName 수집
  for (const session of allSessions) {
    const name = session.memberName || session.userId || 'unknown';
    if (!memberMap.has(name)) {
      memberMap.set(name, { name, channels: new Set(), eventCount: 0, sources: new Set(), lastActive: null });
    }
    const m = memberMap.get(name);
    if (session.channelId) m.channels.add(session.channelId);
  }

  // Zoom 회의 참여자 이름도 수집
  for (const event of allEvents) {
    if (event.data?.participant) {
      const name = event.data.participant;
      if (!memberMap.has(name)) {
        memberMap.set(name, { name, channels: new Set(), eventCount: 0, sources: new Set(), lastActive: null });
      }
      const m = memberMap.get(name);
      if (event.channelId) m.channels.add(event.channelId);
      m.sources.add(event.source || 'zoom');
    }
    if (event.data?.attendees) {
      for (const a of event.data.attendees) {
        const name = a.name || a.email;
        if (!memberMap.has(name)) {
          memberMap.set(name, { name, channels: new Set(), eventCount: 0, sources: new Set(), lastActive: null });
        }
        const m = memberMap.get(name);
        if (event.channelId) m.channels.add(event.channelId);
        m.sources.add('calendar');
      }
    }
  }

  const result = [...memberMap.values()].map(m => ({
    name:       m.name,
    channels:   [...m.channels],
    eventCount: m.eventCount,
    sources:    [...m.sources],
    lastActive: m.lastActive,
  })).filter(m => m.name !== 'unknown');

  res.json(result);
});

// GET /api/overlay?members=A,B&from=ISO&to=ISO
// → 여러 채널의 이벤트를 시간 범위로 병렬 조회 (멤버 오버레이용)
app.get('/api/overlay', (req, res) => {
  const memberNames = (req.query.members || '').split(',').filter(Boolean);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;

  const allEvents = getAllEvents();

  // 시간 필터
  const filtered = allEvents.filter(e => {
    const ts = new Date(e.timestamp);
    if (from && ts < from) return false;
    if (to   && ts > to)   return false;
    return true;
  });

  // 멤버별 그룹화
  const byMember = {};
  for (const event of filtered) {
    // 채널 ID를 멤버 이름으로 간주하거나 Zoom 참여자 이름 매핑
    const candidates = [event.channelId, event.userId, event.data?.participant].filter(Boolean);
    for (const name of memberNames) {
      if (candidates.some(c => c.toLowerCase().includes(name.toLowerCase()))) {
        if (!byMember[name]) byMember[name] = [];
        byMember[name].push(event);
        break;
      }
    }
  }

  // 각 멤버별 그래프 생성
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

// 파일 목록 (접근 통계)
app.get('/api/files', (req, res) => {
  res.json(getFiles());
});

// 통계
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// 활동 점수
app.get('/api/activity', (req, res) => {
  const graph = getFullGraph();
  const scores = {};
  for (const node of graph.nodes) {
    scores[node.id] = node.activityScore;
  }
  res.json(scores);
});

// 주석 CRUD
app.get('/api/annotations', (req, res) => {
  res.json(getAnnotations());
});

app.post('/api/annotations', (req, res) => {
  const event = createAnnotationEvent(req.body);
  insertEvent(event);
  insertAnnotation({
    id: event.id,
    eventId: req.body.linkedEventId || null,
    label: req.body.label || 'Note',
    description: req.body.description || '',
    color: req.body.color || '#f0c674',
    icon: req.body.icon || null,
  });
  res.json({ success: true, id: event.id });
});

app.delete('/api/annotations/:id', (req, res) => {
  deleteAnnotation(req.params.id);
  res.json({ success: true });
});

// ─── 멀티 AI 이벤트 수신 API ─────────────────────────
// Gemini, Perplexity, OpenAI, VSCode 어댑터가 여기로 POST
// Body: normalizeAiEvent() 가 반환한 표준 이벤트 객체
app.post('/api/ai-event', (req, res) => {
  const event = req.body;

  // 필수 필드 검증
  if (!event || !event.id || !event.type || !event.aiSource) {
    return res.status(400).json({ error: 'id, type, aiSource 필드 필요' });
  }

  // aiSource 유효성 (알 수 없는 AI도 허용, 스타일만 기본값)
  const style = getAiStyle(event.aiSource);

  // _style 힌트가 없으면 서버에서 보완
  if (!event._style) {
    event._style = {
      color:      { background: style.color, border: style.borderColor,
                    highlight: { background: style.color, border: style.borderColor } },
      shape:      style.shape,
      badgeBg:    style.badgeBg,
      badgeColor: style.badgeColor,
    };
  }

  // DB 저장을 위한 필드 보완
  if (!event.source)    event.source    = 'ai-adapter';
  if (!event.userId)    event.userId    = 'local';
  if (!event.channelId) event.channelId = 'default';
  if (!event.metadata)  event.metadata  = {};
  event.metadata.aiSource = event.aiSource;
  event.metadata.aiLabel  = event.data?.aiLabel || null;
  event.metadata.model    = event.data?.model    || null;

  // DB에 저장
  try {
    insertEvent(event);
  } catch (e) {
    console.warn('[ai-event] insert 경고:', e.message);
  }

  // 실시간 브로드캐스트
  const graph = getFullGraph(null);
  broadcast({ type: 'update', graph, sessions: getSessions(), stats: getStats() });

  res.json({ success: true, id: event.id, aiSource: event.aiSource, style });
});

// AI 소스 목록 + 스타일 조회 (프론트엔드 필터 UI용)
app.get('/api/ai-sources', (req, res) => {
  const sources = Object.values(AI_SOURCES).map(src => ({
    id:    src,
    style: getAiStyle(src),
  }));
  res.json(sources);
});

// ─── 사용자 커스터마이징 API ──────────────────────────

// 사용자 설정 전체 조회
app.get('/api/user-config', (req, res) => {
  res.json(getUserConfig());
});

// 노드별 커스텀 라벨
app.get('/api/user-labels', (req, res) => {
  res.json(getUserLabels());
});

app.post('/api/user-labels', (req, res) => {
  const { eventId, customHeader, customBody } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  setUserLabel(eventId, customHeader, customBody);
  // 변경사항을 모든 클라이언트에 브로드캐스트
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

app.delete('/api/user-labels/:eventId', (req, res) => {
  deleteUserLabel(req.params.eventId);
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

// 사용자 카테고리
app.get('/api/user-categories', (req, res) => {
  res.json(getUserCategories());
});

app.post('/api/user-categories', (req, res) => {
  const cat = req.body;
  if (!cat.id || !cat.name) return res.status(400).json({ error: 'id and name required' });
  upsertUserCategory(cat);
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

app.delete('/api/user-categories/:id', (req, res) => {
  deleteUserCategory(req.params.id);
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

// 도구 라벨 매핑
app.get('/api/tool-mappings', (req, res) => {
  res.json(getToolLabelMappings());
});

app.post('/api/tool-mappings', (req, res) => {
  const { toolName, customLabel, customHeader } = req.body;
  if (!toolName || !customLabel) return res.status(400).json({ error: 'toolName and customLabel required' });
  setToolLabelMapping(toolName, customLabel, customHeader);
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

app.delete('/api/tool-mappings/:toolName', (req, res) => {
  deleteToolLabelMapping(req.params.toolName);
  broadcast({ type: 'userConfigUpdate', userConfig: getUserConfig() });
  res.json({ success: true });
});

// AI 라벨 제안
app.get('/api/suggest-label/:eventId', (req, res) => {
  const events = getAllEvents();
  const event = events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const suggestion = suggestLabel(event, events);
  res.json(suggestion);
});

// 롤백
app.post('/api/rollback/:id', (req, res) => {
  const eventId = req.params.id;
  const success = rollbackToEvent(eventId);
  if (!success) return res.status(404).json({ error: 'Event not found' });

  // JSONL도 동기화
  const events = getAllEvents();
  const content = events.map(e => JSON.stringify({
    id: e.id, type: e.type, source: e.source,
    sessionId: e.sessionId, parentEventId: e.parentEventId,
    data: e.data, ts: e.timestamp,
  })).join('\n') + (events.length ? '\n' : '');
  fs.writeFileSync(CONV_FILE, content);
  lastBytePos = fs.statSync(CONV_FILE).size;

  const graph = getFullGraph();
  broadcast({ type: 'rollback', graph });
  res.json({ success: true, eventId, kept: events.length });
});

// 전체 초기화
app.delete('/api/clear', (req, res) => {
  clearAll();
  fs.writeFileSync(CONV_FILE, '');
  lastBytePos = 0;
  broadcast({ type: 'clear' });
  console.log('[CLEAR] 전체 초기화 완료');
  res.json({ success: true });
});

// 스냅샷 목록
app.get('/api/snapshots', (req, res) => {
  const list = fs.existsSync(SNAPSHOTS_DIR)
    ? fs.readdirSync(SNAPSHOTS_DIR).filter(f =>
        fs.statSync(path.join(SNAPSHOTS_DIR, f)).isDirectory()
      )
    : [];
  res.json(list);
});

// 하위 호환: 기존 turns API
app.get('/api/turns', (req, res) => {
  res.json(getAllEvents());
});

// ─── 코드 효율 분석 API (/complexity, /refactor-suggest) ─
// POST /api/analyze  body: { code, filename }
// GET  /api/analyze?file=<절대경로>
app.post('/api/analyze', (req, res) => {
  const { code, filename = 'unknown' } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code 필드 필요' });
  try {
    const report = generateReport(code, filename);
    console.log(`[ANALYZE] ${filename} → 복잡도 ${report.complexity}, 등급 ${report.grade}`);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analyze', (req, res) => {
  const filePath = req.query.file;
  if (!filePath) return res.status(400).json({ error: 'file 쿼리 파라미터 필요' });
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const report = generateReport(code, path.basename(filePath));
    console.log(`[ANALYZE] ${filePath} → 복잡도 ${report.complexity}, 등급 ${report.grade}`);
    res.json(report);
  } catch (e) {
    res.status(404).json({ error: `파일 읽기 실패: ${e.message}` });
  }
});

// 프로젝트 전체 파일 일괄 분석
app.get('/api/analyze-project', (req, res) => {
  const dir = req.query.dir || __dirname;
  const exts = (req.query.ext || 'js').split(',');
  const IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage', 'tests'];

  function collectFiles(d) {
    let results = [];
    try {
      for (const entry of fs.readdirSync(d)) {
        if (IGNORE.some(ig => entry.startsWith(ig))) continue;
        const full = path.join(d, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) results = results.concat(collectFiles(full));
        else if (exts.some(e => entry.endsWith('.' + e))) results.push(full);
      }
    } catch {}
    return results;
  }

  const files = collectFiles(dir).slice(0, 30); // 최대 30개
  const reports = files.map(f => {
    try {
      const code = fs.readFileSync(f, 'utf8');
      return generateReport(code, path.relative(dir, f));
    } catch {
      return null;
    }
  }).filter(Boolean);

  // 전체 요약
  const avgComplexity = reports.length
    ? Math.round(reports.reduce((s, r) => s + r.complexity, 0) / reports.length)
    : 0;
  const grades = reports.map(r => r.grade);
  const gradeCount = ['A', 'B', 'C', 'D', 'F'].reduce((acc, g) => {
    acc[g] = grades.filter(x => x === g).length;
    return acc;
  }, {});

  res.json({ reports, avgComplexity, gradeCount, fileCount: reports.length });
});

// ─── Phase 3-H: Shadow AI 감지 API ───────────────────
app.get('/api/shadow-ai', (req, res) => {
  const { channel, hours } = req.query;
  let events = channel
    ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
    : getAllEvents();
  const h = parseInt(hours || '168'); // 기본 7일
  const cutoff = Date.now() - h * 3600 * 1000;
  events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  const findings = detectShadowAI(events);
  res.json({ findings, checkedEvents: events.length, windowHours: h });
});

app.get('/api/shadow-ai/approved', (req, res) => {
  res.json({ approved: getApprovedSources() });
});

app.post('/api/shadow-ai/approved', (req, res) => {
  const { source, action } = req.body;
  if (!source) return res.status(400).json({ error: 'source required' });
  if (action === 'remove') {
    removeApprovedSource(source);
    res.json({ ok: true, action: 'removed', source });
  } else {
    addApprovedSource(source);
    res.json({ ok: true, action: 'added', source });
  }
});

// ─── Phase 3-G: 감사 로그 API ────────────────────────
app.get('/api/audit', (req, res) => {
  const { from, to, type, channel, memberId, limit, format } = req.query;
  const entries = queryAuditLog({ from, to, type, channel, memberId, limit: parseInt(limit || '1000') });

  if (format === 'html') {
    return res.type('text/html').send(renderAuditHtml(entries, { from, to }));
  }
  res.json({ entries, total: entries.length });
});

app.get('/api/audit/verify', (req, res) => {
  const result = verifyIntegrity();
  res.json(result);
});

app.get('/api/audit/report', (req, res) => {
  const { from, to, channel } = req.query;
  const entries = queryAuditLog({ from, to, channel, limit: 2000 });
  const html = renderAuditHtml(entries, { from, to, title: 'Orbit AI 감사 리포트' });
  res.type('text/html').send(html);
});

// ─── Phase 1-A: 일일 리포트 API ─────────────────────
app.get('/api/report/daily', (req, res) => {
  const { from, to, channel, format } = req.query;
  let events = channel
    ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
    : getAllEvents();

  if (from || to) {
    const fromTs = from ? new Date(from).getTime() : 0;
    const toTs   = to   ? new Date(to).getTime()   : Infinity;
    events = events.filter(e => {
      const t = new Date(e.timestamp).getTime();
      return t >= fromTs && t <= toTs;
    });
  }
  if (!events.length) return res.json({ error: 'no events', events: 0 });

  const data = buildReportData(events, { from, to });
  if (format === 'markdown') return res.type('text/plain').send(renderMarkdown(data));
  if (format === 'slack')    return res.json(renderSlackBlocks(data));
  res.json(data);
});

app.get('/api/report/weekly', (req, res) => {
  const { channel } = req.query;
  const now  = Date.now();
  const from = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  let events = channel
    ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
    : getAllEvents();
  events = events.filter(e => new Date(e.timestamp).getTime() >= now - 7 * 24 * 3600 * 1000);
  const data = buildReportData(events, { from, period: 'weekly' });
  res.json(data);
});

// ─── Phase 1-B: Context Bridge API ──────────────────
app.get('/api/context/bridge', (req, res) => {
  const { session, channel, format, save } = req.query;
  let events = session
    ? getEventsBySession(session)
    : channel
      ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
      : getAllEvents();

  // 최근 2시간으로 제한
  const cutoff = Date.now() - 2 * 3600 * 1000;
  events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);
  if (!events.length) events = getAllEvents().slice(-100); // fallback: 최근 100개

  const ctx = extractContext(events, { sessionId: session });

  if (save) {
    const targetDir = save === '1' ? process.cwd() : save;
    try {
      saveContextFile(ctx, targetDir);
      return res.json({ ok: true, saved: path.join(targetDir, 'ORBIT_CONTEXT.md'), ctx });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (format === 'markdown') return res.type('text/plain').send(renderContextMd(ctx));
  if (format === 'prompt')   return res.type('text/plain').send(renderContextPrompt(ctx));
  res.json(ctx);
});

// ─── Phase 1-C: 충돌 감지 API ────────────────────────
app.get('/api/conflicts', (req, res) => {
  const { channel, session, hours } = req.query;
  let events = channel
    ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
    : getAllEvents();

  const h = parseInt(hours || '24');
  const cutoff = Date.now() - h * 3600 * 1000;
  events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  const conflicts = detectConflicts(events);
  res.json({ conflicts, checkedEvents: events.length, windowHours: h });
});

// ─── 테마 마켓 API ────────────────────────────────────
app.get('/api/themes', (req, res) => {
  res.json(getAllThemes());
});

app.get('/api/themes/:id', (req, res) => {
  const t = getThemeById(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/themes', (req, res) => {
  try {
    const theme = registerTheme(req.body);
    res.json(theme);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/themes/:id/download', (req, res) => {
  recordDownload(req.params.id);
  res.json({ ok: true });
});

app.post('/api/themes/:id/rate', (req, res) => {
  const rating = parseFloat(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5' });
  const t = rateTheme(req.params.id, rating);
  res.json(t || { error: 'not found' });
});

app.delete('/api/themes/:id', (req, res) => {
  deleteUserTheme(req.params.id);
  res.json({ ok: true });
});

// ─── 계정 시스템 API ─────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const result = authRegister(req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/auth/login', (req, res) => {
  const result = authLogin(req.body);
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization || req.query.token;
  const user  = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user });
});

// ─── 결제/플랜 API ───────────────────────────────────
app.get('/api/payment/plans', (req, res) => {
  res.json({ plans: Object.values(PLANS), mockMode: paymentMockMode });
});

app.post('/api/payment/create', async (req, res) => {
  try {
    const result = await createPayment(req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/payment/confirm', async (req, res) => {
  try {
    const result = await confirmPayment(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 성장 엔진 API ───────────────────────────────────
app.get('/api/growth/suggestions', (req, res) => {
  res.json(getSuggestions({ channelId: req.query.channel, limit: parseInt(req.query.limit)||20 }));
});

app.get('/api/growth/patterns', (req, res) => {
  res.json(getPatterns({ channelId: req.query.channel }));
});

app.post('/api/growth/feedback', (req, res) => {
  const result = saveFeedback({ ...req.body });
  res.json(result);
});

app.get('/api/growth/candidates', (req, res) => {
  res.json(getMarketCandidates());
});

// 수동 분석 트리거 (최근 이벤트 기반)
app.post('/api/growth/analyze', (req, res) => {
  try {
    const channel = req.body.channel || 'default';
    const recentEvents = dbModule.getEvents
      ? dbModule.getEvents({ channelId: channel, limit: 500 })
      : [];
    const results = analyzeAndSuggest(recentEvents, channel);
    res.json({ ok: true, patterns: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 솔루션 마켓 API ─────────────────────────────────
// 솔루션은 theme-store 구조를 재활용 (타입 필드 추가)
const solutionStore = (() => {
  const fs2   = require('fs');
  const path2 = require('path');
  const SOLUTIONS_FILE = path2.join(__dirname, 'data', 'solutions.json');
  function load() {
    try {
      if (!fs2.existsSync(SOLUTIONS_FILE)) return [];
      return JSON.parse(fs2.readFileSync(SOLUTIONS_FILE, 'utf8'));
    } catch { return []; }
  }
  function save(data) {
    const dir = path2.dirname(SOLUTIONS_FILE);
    if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
    fs2.writeFileSync(SOLUTIONS_FILE, JSON.stringify(data, null, 2));
  }
  return {
    getAll: () => load(),
    add: (sol) => {
      const data = load();
      data.push({ ...sol, id: sol.id || 'sol-' + Date.now().toString(36),
        createdAt: new Date().toISOString().slice(0,10) });
      save(data); return data[data.length-1];
    },
  };
})();

app.get('/api/growth/solutions', (req, res) => {
  res.json(solutionStore.getAll());
});

app.post('/api/growth/solutions', (req, res) => {
  const sol = solutionStore.add(req.body);
  res.json(sol);
});

// ─── 커뮤니티 API ─────────────────────────────────────
const communityStore = (() => {
  const fs2   = require('fs');
  const path2 = require('path');
  const COMM_FILE = path2.join(__dirname, 'data', 'community.json');
  function load() {
    try {
      if (!fs2.existsSync(COMM_FILE)) return { posts: [] };
      return JSON.parse(fs2.readFileSync(COMM_FILE, 'utf8'));
    } catch { return { posts: [] }; }
  }
  function save(data) {
    const dir = path2.dirname(COMM_FILE);
    if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
    fs2.writeFileSync(COMM_FILE, JSON.stringify(data, null, 2));
  }
  return {
    getPosts: () => load().posts,
    addPost: (post) => {
      const data = load();
      const entry = { ...post, id: 'p-' + Date.now().toString(36),
        votes: 0, answers: [], createdAt: new Date().toISOString().slice(0,10) };
      data.posts.push(entry);
      save(data); return entry;
    },
    addAnswer: (postId, answer) => {
      const data = load();
      const post = data.posts.find(p => p.id === postId);
      if (!post) return null;
      if (!post.answers) post.answers = [];
      const entry = { ...answer, id: 'ans-' + Date.now().toString(36),
        votes: 0, createdAt: new Date().toISOString().slice(0,10) };
      post.answers.push(entry);
      post.answered = true;
      save(data); return entry;
    },
    vote: (postId, direction) => {
      const data = load();
      const post = data.posts.find(p => p.id === postId);
      if (post) { post.votes = (post.votes||0) + (direction === 'up' ? 1 : -1); }
      save(data);
    },
  };
})();

app.get('/api/community/posts', (req, res) => res.json(communityStore.getPosts()));
app.post('/api/community/posts', (req, res) => res.json(communityStore.addPost(req.body)));
app.post('/api/community/answers', (req, res) => {
  const { postId, body } = req.body;
  if (!postId || !body) return res.status(400).json({ error: 'postId and body required' });
  const ans = communityStore.addAnswer(postId, req.body);
  res.json(ans || { error: 'post not found' });
});
app.post('/api/community/vote', (req, res) => {
  const { postId, direction } = req.body;
  communityStore.vote(postId, direction);
  res.json({ ok: true });
});

// ─── 서버 시작 ──────────────────────────────────────
server.listen(PORT, () => {
  const stats = getStats();
  console.log(`\n🧠 Claude Work MindMap Viewer v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   이벤트: ${stats.eventCount}개 | 세션: ${stats.sessionCount}개 | 파일: ${stats.fileCount}개`);
  console.log(`   감시 파일: ${CONV_FILE}\n`);
});
