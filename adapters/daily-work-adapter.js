/**
 * daily-work-adapter.js
 * 중소기업 직원 일상 업무 추적 어댑터
 *
 * 추적 항목:
 *   - KakaoTalk 업무 메시지 (카카오워크 API or 클립보드)
 *   - Excel/Google Sheets 파일 수정 (파일 감시)
 *   - 브라우저 활동 (Chrome Extension 연동)
 *   - ERP/전산 시스템 (HTTP 폴링 or 파일 감시)
 *   - 클립보드 기반 텍스트 캡처
 *
 * 실행: node adapters/daily-work-adapter.js
 * 환경변수:
 *   MINDMAP_CHANNEL    채널 ID (기본: daily)
 *   MINDMAP_PORT       Orbit 서버 포트 (기본: 4747)
 *   WATCH_DIRS         감시할 디렉터리 (기본: ~/Documents,~/Desktop)
 *   WATCH_EXTENSIONS   감시할 확장자 (기본: .xlsx,.xls,.csv,.docx,.pptx,.hwp,.pdf)
 *   KAKAOTALK_TOKEN    카카오워크 API 토큰 (선택)
 *   BROWSER_PORT       브라우저 Extension 연결 포트 (기본: 4750)
 *   ERP_WATCH_DIR      ERP 내보내기 디렉터리 (선택)
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ─── 설정 ────────────────────────────────────────
const CHANNEL_ID    = process.env.MINDMAP_CHANNEL  || 'daily';
const MEMBER_NAME   = process.env.MINDMAP_MEMBER   || os.userInfo().username || 'Local';
const ORBIT_PORT    = parseInt(process.env.MINDMAP_PORT || '4747');
const BROWSER_PORT  = parseInt(process.env.BROWSER_PORT || '4750');

const DEFAULT_WATCH_DIRS = [
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Downloads'),
].filter(d => fs.existsSync(d));

const WATCH_DIRS = process.env.WATCH_DIRS
  ? process.env.WATCH_DIRS.split(',').map(s => s.trim())
  : DEFAULT_WATCH_DIRS;

const WATCH_EXTENSIONS = new Set(
  (process.env.WATCH_EXTENSIONS || '.xlsx,.xls,.csv,.docx,.doc,.pptx,.ppt,.hwp,.pdf,.numbers,.pages')
    .split(',').map(s => s.trim().toLowerCase())
);

const ERP_WATCH_DIR = process.env.ERP_WATCH_DIR;

// ─── ULID 간단 구현 ────────────────────────────
function ulid() {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,12).toUpperCase();
}

// ─── Orbit 전송 ──────────────────────────────
function postToOrbit(events) {
  const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: MEMBER_NAME });
  const req  = http.request({
    hostname: '127.0.0.1', port: ORBIT_PORT, path: '/api/hook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => res.resume());
  req.on('error', () => {});
  req.setTimeout(3000, () => req.destroy());
  req.write(body); req.end();
}

// ─── 문서 파일 수정 이벤트 ───────────────────
function makeDocEvent(filePath, eventType = 'file.write') {
  const ext  = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);

  const typeMap = {
    '.xlsx': 'Excel', '.xls': 'Excel', '.csv': 'Excel',
    '.docx': 'Word',  '.doc': 'Word',
    '.pptx': 'PowerPoint', '.ppt': 'PowerPoint',
    '.hwp':  'HWP',
    '.pdf':  'PDF',
    '.numbers': 'Numbers', '.pages': 'Pages',
  };
  const appName = typeMap[ext] || 'Document';

  const icons = {
    'Excel': '📊', 'Word': '📝', 'PowerPoint': '📋',
    'HWP': '📄', 'PDF': '📕', 'Document': '📄',
    'Numbers': '📊', 'Pages': '📝',
  };

  return {
    id:        ulid(),
    type:      eventType,
    source:    'daily-work',
    aiSource:  'document',
    sessionId: `daily-${CHANNEL_ID}`,
    userId:    'local',
    channelId: CHANNEL_ID,
    timestamp: new Date().toISOString(),
    data: {
      toolName:     appName,
      filePath:     filePath,
      fileName:     name,
      fileExt:      ext,
      operation:    eventType === 'file.create' ? 'create' : 'write',
      inputPreview: `${icons[appName] || '📄'} ${appName}: ${name}`,
    },
    metadata: {
      source:   'daily-work-adapter',
      aiSource: 'document',
      aiLabel:  appName,
      aiIcon:   icons[appName] || '📄',
      category: 'daily_work',
    },
  };
}

// ─── 파일 감시 ───────────────────────────────
const watchedFiles = new Map(); // path → lastMtime
const DEBOUNCE_MS  = 2000;     // 2초 debounce
const debounceMap  = new Map();

function watchDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  console.log(`[Daily] 📁 감시 시작: ${dir}`);

  fs.watch(dir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const ext = path.extname(filename).toLowerCase();
    if (!WATCH_EXTENSIONS.has(ext)) return;
    if (filename.includes('~$') || filename.startsWith('.')) return; // 임시 파일 제외

    const fullPath = path.join(dir, filename);

    // 중복 이벤트 debounce
    clearTimeout(debounceMap.get(fullPath));
    debounceMap.set(fullPath, setTimeout(() => {
      try {
        const stat = fs.statSync(fullPath);
        const prev = watchedFiles.get(fullPath);
        const orbitEventType = prev ? 'file.write' : 'file.create';
        watchedFiles.set(fullPath, stat.mtimeMs);

        const event = makeDocEvent(fullPath, orbitEventType);
        postToOrbit([event]);
        console.log(`[Daily] ${orbitEventType === 'file.create' ? '✨' : '✏️'} ${path.basename(fullPath)}`);
      } catch {}
    }, DEBOUNCE_MS));
  });

  // 초기 파일 스캔
  try {
    const scan = (d, depth = 0) => {
      if (depth > 3) return;
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        try {
          const st = fs.statSync(fp);
          if (st.isDirectory()) { scan(fp, depth + 1); continue; }
          const ext = path.extname(f).toLowerCase();
          if (WATCH_EXTENSIONS.has(ext)) {
            watchedFiles.set(fp, st.mtimeMs);
          }
        } catch {}
      }
    };
    scan(dir);
  } catch {}
}

// ─── ERP/전산 시스템 감시 ────────────────────
function watchErpDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  console.log(`[Daily] 🏢 ERP 감시 시작: ${dir}`);

  fs.watch(dir, { recursive: false }, (eventType, filename) => {
    if (!filename) return;
    const fullPath = path.join(dir, filename);

    clearTimeout(debounceMap.get('erp:' + fullPath));
    debounceMap.set('erp:' + fullPath, setTimeout(() => {
      try {
        const stat = fs.statSync(fullPath);
        const event = {
          id:        ulid(),
          type:      'tool.end',
          source:    'daily-work',
          aiSource:  'erp',
          sessionId: `daily-${CHANNEL_ID}`,
          userId:    'local',
          channelId: CHANNEL_ID,
          timestamp: new Date().toISOString(),
          data: {
            toolName:     'ERP',
            filePath:     fullPath,
            fileName:     filename,
            operation:    'export',
            inputPreview: `🏢 ERP 내보내기: ${filename} (${(stat.size/1024).toFixed(1)}KB)`,
          },
          metadata: { source: 'daily-work-adapter', aiSource: 'erp', aiLabel: 'ERP', aiIcon: '🏢', category: 'daily_work' },
        };
        postToOrbit([event]);
        console.log(`[Daily] 🏢 ERP 내보내기: ${filename}`);
      } catch {}
    }, DEBOUNCE_MS));
  });
}

// ─── 카카오워크 API 폴링 (토큰 있을 때만) ─────
const KAKAOTALK_TOKEN = process.env.KAKAOTALK_TOKEN;
let lastKakaoTs = Date.now();

async function pollKakaoWork() {
  if (!KAKAOTALK_TOKEN) return;

  try {
    const since = new Date(lastKakaoTs).toISOString();
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.kakaowork.com',
        path:     `/v1/messages?since=${encodeURIComponent(since)}&limit=20`,
        headers:  { 'Authorization': `Bearer ${KAKAOTALK_TOKEN}` },
        method:   'GET',
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy());
      req.end();
    });

    const messages = result.messages || result.data || [];
    if (!messages.length) return;

    lastKakaoTs = Date.now();

    const events = messages.map(msg => ({
      id:        ulid(),
      type:      'user.message',
      source:    'daily-work',
      aiSource:  'kakaotalk',
      sessionId: `daily-${CHANNEL_ID}`,
      userId:    msg.sender?.nickname || 'kakao-user',
      channelId: CHANNEL_ID,
      timestamp: msg.created_at ? new Date(msg.created_at * 1000).toISOString() : new Date().toISOString(),
      data: {
        toolName:     'KakaoWork',
        content:      msg.text?.slice(0, 500) || '',
        contentPreview: msg.text?.slice(0, 100) || '',
        wordCount:    (msg.text || '').split(/\s+/).filter(Boolean).length,
        inputPreview: `🟡 카카오워크: ${msg.text?.slice(0, 80) || ''}`,
        sender:       msg.sender?.nickname,
        channelName:  msg.channel?.name,
      },
      metadata: { source: 'daily-work-adapter', aiSource: 'kakaotalk', aiLabel: 'KakaoWork', aiIcon: '🟡', category: 'daily_work' },
    }));

    postToOrbit(events);
    console.log(`[Daily] 🟡 카카오워크 ${events.length}개 메시지`);
  } catch (e) {
    // 오류 무시 (네트워크 없을 때 등)
  }
}

// ─── 브라우저 Extension 연결 (HTTP 서버) ──────
// Chrome Extension이 방문 URL을 POST /browser-activity로 전송
const { createServer } = require('http');
const browserServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/browser-activity') {
    res.writeHead(404); res.end(); return;
  }

  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"ok":true}');

    try {
      const payload = JSON.parse(data);
      const url     = payload.url || '';
      const title   = payload.title || url;

      // 개인정보 보호: 소셜 미디어, 쇼핑, 금융 사이트는 URL 마스킹
      const SENSITIVE_PATTERNS = [/facebook|instagram|twitter|x\.com|shopping|bank|finance|카드|계좌/i];
      const isSensitive = SENSITIVE_PATTERNS.some(p => p.test(url + title));

      const preview = isSensitive
        ? `🌐 브라우저 활동 (비공개)`
        : `🌐 ${title.slice(0, 80)} — ${new URL(url).hostname}`;

      const event = {
        id:        ulid(),
        type:      'user.message',
        source:    'daily-work',
        aiSource:  'browser',
        sessionId: `daily-${CHANNEL_ID}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          toolName:     'Browser',
          content:      isSensitive ? '[비공개]' : url,
          contentPreview: preview,
          inputPreview: preview,
          url:          isSensitive ? '[masked]' : url,
          title:        isSensitive ? '[비공개]' : title.slice(0, 100),
          hostname:     isSensitive ? '[masked]' : (new URL(url).hostname),
          isSensitive,
        },
        metadata: { source: 'daily-work-adapter', aiSource: 'browser', aiLabel: 'Browser', aiIcon: '🌐', category: 'daily_work' },
      };

      postToOrbit([event]);
      if (!isSensitive) console.log(`[Daily] 🌐 ${new URL(url).hostname}`);
    } catch {}
  });
});

browserServer.on('error', () => {}); // 포트 충돌 무시

// ─── 진입점 ─────────────────────────────────
console.log(`[Daily Work] 시작 — 채널: ${CHANNEL_ID}, 멤버: ${MEMBER_NAME}`);
console.log(`[Daily Work] Orbit 서버: http://localhost:${ORBIT_PORT}`);

// 파일 감시 시작
WATCH_DIRS.forEach(d => watchDirectory(d));
if (ERP_WATCH_DIR) watchErpDirectory(ERP_WATCH_DIR);

// 브라우저 Extension 리스너
browserServer.listen(BROWSER_PORT, () => {
  console.log(`[Daily Work] 🌐 브라우저 Extension 수신: http://localhost:${BROWSER_PORT}/browser-activity`);
});

// 카카오워크 폴링 (2분마다)
if (KAKAOTALK_TOKEN) {
  pollKakaoWork();
  setInterval(pollKakaoWork, 2 * 60 * 1000);
  console.log('[Daily Work] 🟡 카카오워크 폴링 시작 (2분 간격)');
} else {
  console.log('[Daily Work] 🟡 카카오워크 비활성화 (KAKAOTALK_TOKEN 없음)');
}

// 시작 이벤트 전송
postToOrbit([{
  id:        ulid(),
  type:      'session.start',
  source:    'daily-work',
  aiSource:  'daily-work',
  sessionId: `daily-${CHANNEL_ID}-${Date.now()}`,
  userId:    'local',
  channelId: CHANNEL_ID,
  timestamp: new Date().toISOString(),
  data: {
    toolName:     'DailyWork',
    inputPreview: `💼 일상 업무 추적 시작 — ${MEMBER_NAME}`,
    watchDirs:    WATCH_DIRS,
    extensions:   [...WATCH_EXTENSIONS],
  },
  metadata: { source: 'daily-work-adapter', aiLabel: 'Daily Work', aiIcon: '💼', category: 'daily_work' },
}]);

console.log('\n[Daily Work] 감시 중:');
WATCH_DIRS.forEach(d => console.log(`  📁 ${d}`));
console.log(`  📎 확장자: ${[...WATCH_EXTENSIONS].join(', ')}`);
console.log('\nChrome Extension 사용법:');
console.log(`  → chrome-extension/ 폴더를 Chrome에 로드하거나`);
console.log(`  → POST http://localhost:${BROWSER_PORT}/browser-activity 로 URL 전송\n`);
