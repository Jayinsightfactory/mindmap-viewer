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

const { initDatabase, getAllEvents, getEventsBySession, searchEvents, getSessions, getFiles, getAnnotations, insertAnnotation, deleteAnnotation, insertEvent, rollbackToEvent, clearAll, getStats, getUserLabels, setUserLabel, deleteUserLabel, getUserCategories, upsertUserCategory, deleteUserCategory, getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig } = require('./db');
const { buildGraph, computeActivityScores, applyActivityVisualization, suggestLabel } = require('./graph-engine');
const { createAnnotationEvent } = require('./event-normalizer');
const { getAiStyle, AI_SOURCES } = require('./adapters/ai-adapter-base');
const { generateReport } = require('./code-analyzer');

const PORT = 4747;
const CONV_FILE = path.join(__dirname, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

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
function getFullGraph(sessionFilter) {
  const events = sessionFilter
    ? getEventsBySession(sessionFilter)
    : getAllEvents();
  const graph = buildGraph(events);
  computeActivityScores(graph.nodes, Date.now());
  applyActivityVisualization(graph.nodes);
  return graph;
}

// ─── WebSocket ──────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] 클라이언트 연결됨');

  try {
    const graph = getFullGraph();
    const sessions = getSessions();
    const stats = getStats();
    const userConfig = getUserConfig();
    ws.send(JSON.stringify({
      type: 'init',
      graph,
      sessions,
      stats,
      userConfig,
    }));
  } catch (e) {
    console.error('[WS] init 오류:', e.message);
  }

  // 클라이언트 → 서버 메시지
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'annotation.create') {
        const event = createAnnotationEvent(msg.data);
        insertEvent(event);
        const entry = { id: event.id, type: event.type, source: event.source, sessionId: event.sessionId, parentEventId: event.parentEventId, data: event.data, ts: event.timestamp };
        fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');

        broadcast({
          type: 'event',
          event,
          graph: getFullGraph(),
        });
      }

      if (msg.type === 'filter') {
        const graph = getFullGraph(msg.sessionId);
        ws.send(JSON.stringify({ type: 'filtered', graph }));
      }
    } catch (e) {
      console.error('[WS] message 처리 오류:', e.message);
    }
  });

  ws.on('close', () => console.log('[WS] 클라이언트 연결 종료'));
  ws.on('error', e => console.error('[WS] 에러:', e.message));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

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
  const graph = getFullGraph(req.query.session);
  res.json(graph);
});

// 세션 목록
app.get('/api/sessions', (req, res) => {
  res.json(getSessions());
});

// 이벤트 검색
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  res.json(searchEvents(q));
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

// ─── 서버 시작 ──────────────────────────────────────
server.listen(PORT, () => {
  const stats = getStats();
  console.log(`\n🧠 Claude Work MindMap Viewer v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   이벤트: ${stats.eventCount}개 | 세션: ${stats.sessionCount}개 | 파일: ${stats.fileCount}개`);
  console.log(`   감시 파일: ${CONV_FILE}\n`);
});
