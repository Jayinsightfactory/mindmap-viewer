#!/usr/bin/env node
/**
 * orbit CLI
 * npm install -g orbit-ai  →  orbit init / orbit start / orbit status
 */
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const VERSION  = require('../package.json').version;
const ORBIT_DIR = path.join(os.homedir(), '.orbit');
const CONFIG_FILE = path.join(ORBIT_DIR, 'config.json');
const DEFAULT_PORT = 4747;

const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const RED   = '\x1b[31m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

function log(msg)  { console.log(`${CYAN}[orbit]${RESET} ${msg}`); }
function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET}  ${msg}`); }
function err(msg)  { console.error(`${RED}✗${RESET}  ${msg}`); }

// ─── 설정 읽기/쓰기 ────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  if (!fs.existsSync(ORBIT_DIR)) fs.mkdirSync(ORBIT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── 서버 상태 확인 ────────────────────────────────
function checkServer(port) {
  return new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/stats', method: 'GET' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ running: true, data: JSON.parse(d) }); } catch { resolve({ running: true }); } });
    });
    req.on('error', () => resolve({ running: false }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ running: false }); });
    req.end();
  });
}

// ─── 헬퍼 함수 ──────────────────────────────────────
function getBaseUrl() {
  const cfg = loadConfig();
  if (process.argv.includes('--remote')) {
    if (!cfg.remote) { err('원격 URL 미설정. orbit remote <url>'); process.exit(1); }
    return cfg.remote;
  }
  return `http://127.0.0.1:${cfg.port || DEFAULT_PORT}`;
}

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const base = getBaseUrl();
    const isHttps = base.startsWith('https');
    const mod = isHttps ? require('https') : http;
    const u = new URL(urlPath, base);
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json' },
    };
    const cfg = loadConfig();
    if (cfg.token) opts.headers['Authorization'] = `Bearer ${cfg.token}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = mod.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', e => reject(e));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function table(rows, cols) {
  if (!rows || !rows.length) return '  (데이터 없음)';
  const widths = cols.map(c => Math.min(40, Math.max(
    c.label.length, ...rows.map(r => String(r[c.key] ?? '').slice(0, 40).length)
  )));
  const hdr = cols.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  const sep = cols.map((_, i) => '─'.repeat(widths[i])).join('──');
  const lines = rows.map(r =>
    cols.map((c, i) => String(r[c.key] ?? '').slice(0, 40).padEnd(widths[i])).join('  ')
  );
  return ['  ' + hdr, '  ' + sep, ...lines.map(l => '  ' + l)].join('\n');
}

function timeAgo(ts) {
  if (!ts) return '-';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return '방금';
  if (d < 3600000) return `${Math.floor(d / 60000)}분 전`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}시간 전`;
  return `${Math.floor(d / 86400000)}일 전`;
}

// ─── orbit init ────────────────────────────────────
async function cmdInit() {
  console.log(`\n${BOLD}${CYAN}⬡ Orbit ${VERSION} 초기 설정${RESET}\n`);

  // Claude Code hooks 설정
  const hookDir = path.join(os.homedir(), '.claude');
  const hooksFile = path.join(hookDir, 'settings.json');

  let hooks = {};
  try { hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch {}

  const orbitBin  = process.argv[1];
  const hookCmd   = `node "${orbitBin}" hook`;

  const HOOK_EVENTS = ['PostToolUse', 'PreToolUse', 'Notification', 'Stop'];
  if (!hooks.hooks) hooks.hooks = {};
  let changed = false;
  for (const ev of HOOK_EVENTS) {
    if (!hooks.hooks[ev]) hooks.hooks[ev] = [];
    const already = hooks.hooks[ev].some(h => h.command?.includes('orbit') || h.command?.includes('save-turn'));
    if (!already) {
      hooks.hooks[ev].push({ matcher: '', command: `${hookCmd} ${ev.toLowerCase()}` });
      changed = true;
    }
  }

  if (changed) {
    if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2));
    ok(`Claude Code hooks 등록 완료 (${hooksFile})`);
  } else {
    ok('Claude Code hooks 이미 등록됨');
  }

  // 기본 설정 저장
  const cfg = loadConfig();
  if (!cfg.port) {
    saveConfig({ ...cfg, port: DEFAULT_PORT, installedAt: new Date().toISOString(), version: VERSION });
    ok(`설정 저장: ${CONFIG_FILE}`);
  }

  // CLAUDE.md 생성 (하네스 시스템)
  const claudeMd = path.join(process.cwd(), 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8').catch?.() ||
      generateClaudeMd();
    fs.writeFileSync(claudeMd, content);
    ok(`CLAUDE.md 생성 (하네스 시스템 포함)`);
  } else {
    warn('CLAUDE.md 이미 존재함 — 덮어쓰지 않음');
  }

  console.log(`\n${BOLD}완료!${RESET} 다음 명령으로 서버를 시작하세요:\n`);
  console.log(`  ${CYAN}orbit start${RESET}     서버 시작`);
  console.log(`  ${CYAN}orbit status${RESET}    상태 확인`);
  console.log(`  ${CYAN}orbit open${RESET}      브라우저 열기\n`);
}

// ─── orbit start ───────────────────────────────────
async function cmdStart(args) {
  const cfg    = loadConfig();
  const port   = parseInt(args[0]) || cfg.port || DEFAULT_PORT;
  const status = await checkServer(port);

  if (status.running) {
    warn(`Orbit 서버가 이미 실행 중 (포트 ${port})`);
    console.log(`  → http://localhost:${port}`);
    return;
  }

  log(`Orbit 서버 시작 중... (포트 ${port})`);

  const serverScript = path.join(__dirname, '..', 'server.js');
  const child = spawn('node', [serverScript], {
    env:   { ...process.env, PORT: String(port) },
    detached: args.includes('--bg'),
    stdio:    args.includes('--bg') ? 'ignore' : 'inherit',
  });

  if (args.includes('--bg')) {
    child.unref();
    // 3초 후 확인
    await new Promise(r => setTimeout(r, 3000));
    const st = await checkServer(port);
    if (st.running) {
      ok(`백그라운드 시작 완료 → http://localhost:${port}`);
    } else {
      err('시작 실패. orbit start 로 직접 로그를 확인하세요.');
    }
  }
}

// ─── orbit stop ────────────────────────────────────
async function cmdStop() {
  const cfg  = loadConfig();
  const port = cfg.port || DEFAULT_PORT;
  try {
    execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`);
    ok(`포트 ${port} 프로세스 종료`);
  } catch {
    warn('실행 중인 서버 없음');
  }
}

// ─── orbit status ──────────────────────────────────
async function cmdStatus() {
  const cfg    = loadConfig();
  const port   = cfg.port || DEFAULT_PORT;
  const status = await checkServer(port);

  console.log(`\n${BOLD}⬡ Orbit ${VERSION} 상태${RESET}`);
  if (status.running) {
    ok(`서버 실행 중 → http://localhost:${port}`);
    if (status.data) {
      log(`  이벤트: ${status.data.eventCount || 0}개`);
      log(`  세션:   ${status.data.sessionCount || 0}개`);
      log(`  파일:   ${status.data.fileCount || 0}개`);
    }
  } else {
    warn(`서버 미실행 (포트 ${port})`);
    console.log(`  → ${CYAN}orbit start${RESET} 로 시작하세요`);
  }
  console.log('');
}

// ─── orbit open ────────────────────────────────────
async function cmdOpen() {
  const cfg  = loadConfig();
  const port = cfg.port || DEFAULT_PORT;
  const url  = `http://localhost:${port}`;
  const cmd  = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execSync(`${cmd} "${url}"`); ok(`브라우저 열기: ${url}`); }
  catch { log(`브라우저에서 수동으로 여세요: ${url}`); }
}

// ─── orbit hook (Claude Code hook 핸들러) ──────────
function cmdHook(args) {
  // stdin에서 hook 데이터 읽기
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    const cfg  = loadConfig();
    const port = cfg.port || DEFAULT_PORT;
    try {
      const payload = data ? JSON.parse(data) : {};
      const body = JSON.stringify({ events: [payload], channelId: cfg.channel || 'default' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/hook', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => res.resume());
      req.on('error', () => {}); // 서버 미실행 시 무시
      req.setTimeout(1000, () => req.destroy());
      req.write(body); req.end();
    } catch {}
  });
}

// ─── orbit login ───────────────────────────────────
async function cmdLogin(args) {
  const email = args[0];
  const token = args[1];
  if (!email || !token) {
    log('사용법: orbit login <email> <token>');
    log('  토큰은 https://orbit.ai/settings/token 에서 발급');
    return;
  }
  saveConfig({ ...loadConfig(), email, token, loggedInAt: new Date().toISOString() });
  ok(`로그인: ${email}`);
}

// ─── orbit whoami ──────────────────────────────────
function cmdWhoami() {
  const cfg = loadConfig();
  if (cfg.email) {
    log(`로그인: ${cfg.email}`);
    log(`토큰:   ${cfg.token ? cfg.token.slice(0,8) + '...' : '없음'}`);
  } else {
    warn('로그인하지 않음. orbit login <email> <token>');
  }
}

// ─── CLAUDE.md 기본 내용 ───────────────────────────
function generateClaudeMd() {
  return `# ⬡ Orbit 하네스 시스템 (Sisyphus Harness)

이 프로젝트는 **Orbit AI** 추적 시스템과 연결되어 있습니다.
모든 작업은 자동으로 기록되고 시각화됩니다.

---

## 작업 원칙 (Claude Code 지침)

### 1. 시지푸스 모드 (Sisyphus Mode)
작업이 완전히 끝날 때까지 멈추지 않는다.
자동으로 검증(lint/test/build)하고 오류가 있으면 스스로 수정한다.
사용자가 다시 말하지 않아도 끝까지 완수한다.

### 2. 프로메테우스 계획 (Prometheus Plan)
큰 작업은 바로 시작하지 않는다.
먼저 핵심 질문 3-5개를 통해 의도를 명확히 파악한다.
계획을 세운 후 승인을 받고 시작한다.

### 3. 울트라 워크 (Ultra Work) — \`ulw\`
\`ulw:\` 로 시작하는 명령은 최고 성능으로 처리한다.
병렬 에이전트 호출, 깊은 분석, 완전한 구현까지 끝낸다.
LSP 검증 + 테스트 실행 + 최종 보고까지 포함한다.

### 4. 오라클 모드 (Oracle Mode) — \`fix\`
\`fix:\` 로 시작하면 오류의 근본 원인을 다른 시각에서 분석한다.
공식 문서를 참조해 최신 API 규격에 맞는지 확인한다.

---

## 단축 명령어

| 명령 | 동작 |
|------|------|
| \`ulw: [작업]\` | 울트라 워크 — 모든 도구 총동원해 완성 |
| \`fix: [오류]\` | 오라클 — 근본 원인 분석 및 해결 |
| \`plan: [기능]\` | 프로메테우스 — 질문 후 설계 |

---

*⬡ Orbit v${VERSION} · 모든 작업이 자동 추적됩니다*
`;
}

// ─── orbit help ────────────────────────────────────
function cmdHelp() {
  console.log(`
${BOLD}${CYAN}⬡ Orbit ${VERSION}${RESET}
AI 작업 흐름 실시간 시각화 + 하네스 시스템

${BOLD}사용법:${RESET}  orbit <command> [options] [--remote]

${BOLD}서버 관리${RESET}
  ${CYAN}init${RESET}              초기 설정 (Claude Code hooks + CLAUDE.md)
  ${CYAN}start [port]${RESET}      서버 시작 (--bg: 백그라운드)
  ${CYAN}stop${RESET}              서버 종료
  ${CYAN}status${RESET}            서버 상태 확인
  ${CYAN}open${RESET}              브라우저로 대시보드 열기

${BOLD}데이터 조회${RESET}
  ${CYAN}dashboard${RESET}         터미널 미니 대시보드
  ${CYAN}events [n]${RESET}        최근 이벤트 목록
  ${CYAN}sessions${RESET}          세션 목록
  ${CYAN}stats${RESET}             상세 통계
  ${CYAN}search <q>${RESET}        이벤트 검색
  ${CYAN}files${RESET}             파일 활동
  ${CYAN}tracker${RESET}           트래커 상태
  ${CYAN}logs${RESET}              실시간 로그 감시

${BOLD}조작${RESET}
  ${CYAN}push <msg>${RESET}        수동 이벤트 전송
  ${CYAN}theme [name]${RESET}      테마 목록/적용
  ${CYAN}sync${RESET}              클라우드 동기화

${BOLD}설정${RESET}
  ${CYAN}login <e> <t>${RESET}     계정 로그인
  ${CYAN}whoami${RESET}            현재 계정 확인
  ${CYAN}config [k] [v]${RESET}    설정 보기/변경
  ${CYAN}remote [url]${RESET}      원격 URL 설정

${BOLD}분석 (Phase 2-5)${RESET}
  ${CYAN}analysis [dash|cap|learn]${RESET}  작업 분석 대시보드
  ${CYAN}learn start|stop|status${RESET}    개인 학습 에이전트
  ${CYAN}deploy install [code]${RESET}      전사 배포 (직원 PC)
  ${CYAN}deploy batch [code]${RESET}        일괄 설치 스크립트 생성
  ${CYAN}deploy status [ws-id]${RESET}      배포 현황 확인

${BOLD}글로벌 옵션${RESET}
  ${CYAN}--remote${RESET}          Railway 원격 서버 대상으로 실행

${BOLD}빠른 시작:${RESET}
  npx orbit-ai init       초기 설정
  npx orbit-ai start      서버 시작
  npx orbit-ai dashboard   터미널 대시보드
`);
}

// ─── orbit learn ───────────────────────────────────
const PID_DIR  = ORBIT_DIR;
const PID_FILE = path.join(PID_DIR, 'personal-agent.pid');
const DAEMON   = path.resolve(__dirname, '../daemon/personal-agent.js');

function cmdLearn(subArgs) {
  const sub  = subArgs[0];
  const port = loadConfig().port || DEFAULT_PORT;

  if (sub === 'start') {
    // 이미 실행 중인지 확인
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
      try {
        process.kill(parseInt(pid), 0); // 존재하면 예외 없음
        warn(`개인 학습 에이전트 이미 실행 중 (PID: ${pid})`);
        return;
      } catch { /* 종료됨 — PID 파일 오래된 것 */ }
    }

    if (!fs.existsSync(DAEMON)) {
      err(`daemon/personal-agent.js 를 찾을 수 없습니다: ${DAEMON}`);
      return;
    }

    const child = spawn('node', [DAEMON, '--port', String(port)], {
      detached: true,
      stdio:    'ignore',
    });
    child.unref();
    ok(`개인 학습 에이전트 시작 (PID: ${child.pid})`);
    log('  ⌨️  키보드 캡처 · 📁 파일 학습 · 💡 30분마다 제안 생성');
    log(`  Accessibility 권한이 필요합니다`);

  } else if (sub === 'stop') {
    if (!fs.existsSync(PID_FILE)) {
      warn('실행 중인 에이전트가 없습니다');
      return;
    }
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 'SIGTERM');
      ok(`개인 학습 에이전트 종료 (PID: ${pid})`);
      try { fs.unlinkSync(PID_FILE); } catch {}
    } catch {
      warn('프로세스를 찾을 수 없습니다. PID 파일을 삭제합니다.');
      try { fs.unlinkSync(PID_FILE); } catch {}
    }

  } else if (sub === 'status') {
    const http = require('http');
    const req  = http.request(
      { hostname: '127.0.0.1', port, path: '/api/personal/status', method: 'GET' },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const s = JSON.parse(d);
            const t = s.today || {};
            log(`개인 학습 에이전트 상태`);
            console.log(`  ⌨️  키보드 청크: ${t.keyboardChunks || 0}개 · ${(t.keywordChars || 0).toLocaleString()}자`);
            console.log(`  📁 파일 처리:   ${t.fileContents || 0}개`);
            console.log(`  🖥️  앱 활동:     ${t.appActivities || 0}회`);
            console.log(`  💡 대기 제안:   ${s.pendingSuggestions || 0}개`);
            console.log(`  ☁️  동기화:      ${s.syncConsented ? '켜짐' : '꺼짐 (로컬 전용)'}`);
          } catch { err('상태 파싱 실패'); }
        });
      }
    );
    req.on('error', () => err('Orbit 서버에 연결할 수 없습니다. orbit start 먼저 실행하세요.'));
    req.setTimeout(3000, () => { req.destroy(); err('연결 시간 초과'); });
    req.end();

  } else {
    console.log(`
${BOLD}orbit learn${RESET} — 개인 학습 에이전트

  ${CYAN}orbit learn start${RESET}    에이전트 시작 (백그라운드)
  ${CYAN}orbit learn stop${RESET}     에이전트 종료
  ${CYAN}orbit learn status${RESET}   오늘 학습 통계 확인
    `);
  }
}

// ─── orbit dashboard ──────────────────────────────
async function cmdDashboard() {
  try {
    const [stats, health, graph] = await Promise.all([
      apiCall('GET', '/api/stats').catch(() => null),
      apiCall('GET', '/health').catch(() => null),
      apiCall('GET', '/api/graph?limit=5').catch(() => null),
    ]);
    console.log(`\n${BOLD}${CYAN}⬡ Orbit Dashboard${RESET}  ${getBaseUrl()}\n`);
    if (health) {
      const st = health.status === 'ok' ? `${GREEN}● 정상${RESET}` : `${RED}● 오류${RESET}`;
      console.log(`  상태: ${st}  가동: ${health.uptime || '-'}`);
    }
    if (stats) {
      console.log(`  이벤트: ${BOLD}${stats.eventCount || 0}${RESET}  세션: ${BOLD}${stats.sessionCount || 0}${RESET}  파일: ${BOLD}${stats.fileCount || 0}${RESET}`);
    }
    const events = Array.isArray(graph) ? graph : graph?.events || [];
    if (events.length) {
      console.log(`\n${BOLD}  최근 이벤트${RESET}`);
      events.slice(0, 5).forEach(e => {
        console.log(`  ${CYAN}│${RESET} ${timeAgo(e.timestamp || e.created_at)}  ${e.type || e.event_type || '-'}  ${(e.summary || e.data || '').toString().slice(0, 50)}`);
      });
    }
    console.log('');
  } catch (e) { err(`대시보드 로드 실패: ${e.message}`); }
}

// ─── orbit events ─────────────────────────────────
async function cmdEvents(args) {
  try {
    const limit = args.find(a => /^\d+$/.test(a)) || '20';
    const data = await apiCall('GET', `/api/graph?limit=${limit}`);
    const events = (Array.isArray(data) ? data : data?.events || []).map(e => ({
      time: timeAgo(e.timestamp || e.created_at),
      type: e.type || e.event_type || '-',
      summary: (e.summary || e.data || '').toString().slice(0, 50),
    }));
    console.log(`\n${BOLD}⬡ 이벤트 (${events.length}건)${RESET}\n`);
    console.log(table(events, [
      { key: 'time', label: '시간' },
      { key: 'type', label: '유형' },
      { key: 'summary', label: '내용' },
    ]));
    console.log('');
  } catch (e) { err(`이벤트 조회 실패: ${e.message}`); }
}

// ─── orbit sessions ───────────────────────────────
async function cmdSessions() {
  try {
    const data = await apiCall('GET', '/api/sessions');
    const sessions = (Array.isArray(data) ? data : data?.sessions || []).map(s => ({
      id: (s.id || s.session_id || '').toString().slice(0, 8),
      start: timeAgo(s.started_at || s.created_at || s.start),
      events: s.eventCount || s.event_count || s.events || 0,
      status: s.active ? '활성' : '종료',
    }));
    console.log(`\n${BOLD}⬡ 세션 (${sessions.length}개)${RESET}\n`);
    console.log(table(sessions, [
      { key: 'id', label: 'ID' },
      { key: 'start', label: '시작' },
      { key: 'events', label: '이벤트' },
      { key: 'status', label: '상태' },
    ]));
    console.log('');
  } catch (e) { err(`세션 조회 실패: ${e.message}`); }
}

// ─── orbit stats ──────────────────────────────────
async function cmdStats() {
  try {
    const [stats, health] = await Promise.all([
      apiCall('GET', '/api/stats'),
      apiCall('GET', '/health').catch(() => null),
    ]);
    console.log(`\n${BOLD}⬡ Orbit 통계${RESET}  ${getBaseUrl()}\n`);
    if (health) {
      console.log(`  서버 상태:  ${health.status === 'ok' ? GREEN + '정상' : RED + '오류'}${RESET}`);
      console.log(`  가동 시간:  ${health.uptime || '-'}`);
      console.log(`  버전:       ${health.version || VERSION}`);
    }
    console.log(`  이벤트:     ${stats.eventCount || 0}개`);
    console.log(`  세션:       ${stats.sessionCount || 0}개`);
    console.log(`  파일:       ${stats.fileCount || 0}개`);
    if (stats.dbSize) console.log(`  DB 크기:    ${stats.dbSize}`);
    if (stats.todayEvents != null) console.log(`  오늘 이벤트: ${stats.todayEvents}개`);
    console.log('');
  } catch (e) { err(`통계 조회 실패: ${e.message}`); }
}

// ─── orbit search ─────────────────────────────────
async function cmdSearch(args) {
  const q = args.filter(a => !a.startsWith('--')).join(' ');
  if (!q) { log('사용법: orbit search <검색어>'); return; }
  try {
    const data = await apiCall('GET', `/api/search?q=${encodeURIComponent(q)}`);
    const results = (Array.isArray(data) ? data : data?.results || []).map(r => ({
      time: timeAgo(r.timestamp || r.created_at),
      type: r.type || r.event_type || '-',
      match: (r.summary || r.data || '').toString().slice(0, 50),
    }));
    console.log(`\n${BOLD}⬡ 검색: "${q}" (${results.length}건)${RESET}\n`);
    console.log(table(results, [
      { key: 'time', label: '시간' },
      { key: 'type', label: '유형' },
      { key: 'match', label: '내용' },
    ]));
    console.log('');
  } catch (e) { err(`검색 실패: ${e.message}`); }
}

// ─── orbit files ──────────────────────────────────
async function cmdFiles() {
  try {
    const data = await apiCall('GET', '/api/files');
    const files = (Array.isArray(data) ? data : data?.files || []).map(f => ({
      path: (f.path || f.file_path || f.name || '').slice(-40),
      edits: f.editCount || f.edit_count || f.count || 0,
      last: timeAgo(f.lastEdited || f.last_edited || f.updated_at),
    }));
    console.log(`\n${BOLD}⬡ 파일 활동 (${files.length}개)${RESET}\n`);
    console.log(table(files, [
      { key: 'path', label: '파일' },
      { key: 'edits', label: '편집' },
      { key: 'last', label: '최근' },
    ]));
    console.log('');
  } catch (e) { err(`파일 조회 실패: ${e.message}`); }
}

// ─── orbit tracker ────────────────────────────────
async function cmdTracker() {
  try {
    const data = await apiCall('GET', '/api/tracker/status');
    console.log(`\n${BOLD}⬡ 트래커 상태${RESET}\n`);
    if (typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (k === 'status') console.log(`  상태: ${v === 'active' ? GREEN + '활성' : YELLOW + v}${RESET}`);
        else console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    } else { console.log(`  ${data}`); }
    console.log('');
  } catch (e) { err(`트래커 조회 실패: ${e.message}`); }
}

// ─── orbit push ───────────────────────────────────
async function cmdPush(args) {
  const msg = args.filter(a => !a.startsWith('--')).join(' ');
  if (!msg) { log('사용법: orbit push <메시지>'); return; }
  try {
    await apiCall('POST', '/api/hook', {
      events: [{ type: 'manual', summary: msg, timestamp: new Date().toISOString() }],
      channelId: loadConfig().channel || 'default',
    });
    ok(`이벤트 전송: ${msg}`);
  } catch (e) { err(`전송 실패: ${e.message}`); }
}

// ─── orbit logs ───────────────────────────────────
async function cmdLogs() {
  log('실시간 로그 감시... (Ctrl+C 종료)');
  let lastId = null;
  const poll = async () => {
    try {
      const data = await apiCall('GET', '/api/graph?limit=10');
      const events = Array.isArray(data) ? data : data?.events || [];
      const newer = lastId ? events.filter(e => (e.id || e._id) > lastId) : events.slice(0, 1);
      for (const e of newer.reverse()) {
        const t = new Date(e.timestamp || e.created_at || Date.now()).toLocaleTimeString();
        console.log(`${CYAN}${t}${RESET}  ${e.type || e.event_type || '-'}  ${(e.summary || '').slice(0, 60)}`);
      }
      if (events.length) lastId = events[0].id || events[0]._id;
    } catch {}
  };
  await poll();
  setInterval(poll, 3000);
}

// ─── orbit theme ──────────────────────────────────
async function cmdTheme(args) {
  const name = args.filter(a => !a.startsWith('--'))[0];
  try {
    if (!name) {
      const data = await apiCall('GET', '/api/themes');
      const themes = Array.isArray(data) ? data : data?.themes || [];
      console.log(`\n${BOLD}⬡ 테마${RESET}\n`);
      if (themes.length) {
        themes.forEach(t => {
          const active = t.active ? ` ${GREEN}← 현재${RESET}` : '';
          console.log(`  ${CYAN}${t.name || t.id}${RESET}${active}`);
        });
      } else { console.log('  (테마 없음)'); }
      console.log(`\n  적용: orbit theme <이름>\n`);
    } else {
      await apiCall('POST', '/api/themes', { theme: name });
      ok(`테마 적용: ${name}`);
    }
  } catch (e) { err(`테마 실패: ${e.message}`); }
}

// ─── orbit config ─────────────────────────────────
function cmdConfigCli(args) {
  const cfg = loadConfig();
  if (args.length === 0) {
    console.log(`\n${BOLD}⬡ Orbit 설정${RESET} (${CONFIG_FILE})\n`);
    for (const [k, v] of Object.entries(cfg)) {
      console.log(`  ${CYAN}${k}${RESET} = ${v}`);
    }
    console.log('');
  } else if (args.length === 1) {
    console.log(cfg[args[0]] ?? '(미설정)');
  } else {
    cfg[args[0]] = args[1];
    saveConfig(cfg);
    ok(`${args[0]} = ${args[1]}`);
  }
}

// ─── orbit remote ─────────────────────────────────
function cmdRemote(args) {
  const cfg = loadConfig();
  if (!args.length) {
    console.log(cfg.remote || '(미설정) — orbit remote <url>');
  } else {
    cfg.remote = args[0];
    saveConfig(cfg);
    ok(`원격 URL: ${args[0]}`);
  }
}

// ─── orbit deploy (Phase 4: 전사 배포) ──────────────
async function cmdDeploy(args) {
  const sub = args[0];

  if (sub === 'install') {
    // 원격 서버에 접속해서 현재 PC를 워크스페이스에 등록
    console.log(`\n${BOLD}${CYAN}⬡ Orbit 전사 배포 — 직원 PC 설치${RESET}\n`);
    const cfg = loadConfig();

    if (!cfg.remote) {
      err('원격 서버 미설정. orbit remote <url> 먼저 실행하세요.');
      return;
    }
    if (!cfg.token) {
      err('로그인 필요. orbit login <email> <token> 먼저 실행하세요.');
      return;
    }

    log('1/4  환경 감지...');
    const platform = process.platform;
    const hostname = os.hostname();
    const username = os.userInfo().username;
    ok(`  OS: ${platform}, 호스트: ${hostname}, 사용자: ${username}`);

    log('2/4  Claude Code hooks 설정...');
    await cmdInit();

    log('3/4  원격 서버에 PC 등록...');
    try {
      const result = await apiCall('POST', '/api/tracker/register-device', {
        hostname,
        username,
        platform,
        nodeVersion: process.version,
        installedAt: new Date().toISOString(),
      });
      if (result?.ok) {
        ok(`  디바이스 등록 완료 (ID: ${result.deviceId || 'ok'})`);
      } else {
        warn(`  등록 응답: ${JSON.stringify(result).slice(0, 100)}`);
      }
    } catch (e) {
      warn(`  디바이스 등록 실패 (서버 미지원일 수 있음): ${e.message}`);
    }

    log('4/4  워크스페이스 연결...');
    const workspaceCode = args[1];
    if (workspaceCode) {
      try {
        const result = await apiCall('POST', '/api/workspace/join', { inviteCode: workspaceCode });
        if (result?.ok) {
          ok(`  워크스페이스 참여 완료`);
        } else {
          warn(`  참여 실패: ${result?.error || JSON.stringify(result)}`);
        }
      } catch (e) {
        warn(`  워크스페이스 참여 실패: ${e.message}`);
      }
    } else {
      log('  초대 코드 없음 — orbit deploy install <invite-code> 로 워크스페이스 참여 가능');
    }

    console.log(`\n${BOLD}${GREEN}✓ 설치 완료!${RESET}`);
    console.log(`  → orbit start --bg   백그라운드 서버 시작`);
    console.log(`  → orbit learn start  학습 에이전트 시작`);
    console.log(`  → orbit dashboard    대시보드 확인\n`);

  } else if (sub === 'batch') {
    // 일괄 설치 스크립트 생성
    console.log(`\n${BOLD}⬡ 일괄 설치 스크립트 생성${RESET}\n`);
    const cfg = loadConfig();
    const remote = cfg.remote || 'https://your-orbit-server.com';
    const token  = cfg.token  || '<YOUR_API_TOKEN>';
    const code   = args[1]    || '<INVITE_CODE>';

    const script = `#!/bin/bash
# ⬡ Orbit AI — 전사 일괄 설치 스크립트
# 각 직원 PC에서 실행
# 생성일: ${new Date().toISOString()}

set -e

echo "⬡ Orbit AI 설치 시작..."

# 1. Node.js 확인
if ! command -v node &>/dev/null; then
  echo "❌ Node.js가 필요합니다. https://nodejs.org 에서 설치하세요."
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 2. Orbit 설치
npm install -g orbit-ai 2>/dev/null || npx orbit-ai --version

# 3. 원격 서버 설정
orbit remote ${remote}

# 4. 로그인 (관리자가 토큰 발급 후 배포)
orbit login "$USER@company.com" "${token}"

# 5. 전사 설치 + 워크스페이스 참여
orbit deploy install ${code}

# 6. 백그라운드 시작
orbit start --bg

echo ""
echo "⬡ Orbit AI 설치 완료!"
echo "  대시보드: orbit dashboard"
echo "  웹 뷰: orbit open"
`;
    console.log(script);
    log('위 스크립트를 install-orbit.sh 로 저장 후 배포하세요.');
    log('  각 직원 PC에서: bash install-orbit.sh');

  } else if (sub === 'status') {
    // 전사 배포 현황
    try {
      const data = await apiCall('GET', '/api/intelligence/realtime?workspaceId=' + (args[1] || 'default'));
      console.log(`\n${BOLD}⬡ 전사 배포 현황${RESET}\n`);
      console.log(`  전체 멤버: ${data.totalMemberCount || 0}명`);
      console.log(`  활성 멤버: ${data.activeMemberCount || 0}명`);
      console.log(`  최근 이벤트: ${data.recentEvents || 0}건\n`);
      if (data.activeMembers?.length) {
        for (const m of data.activeMembers) {
          console.log(`  ${GREEN}●${RESET} ${m.userId.slice(0, 8)} — ${m.currentPurpose} (${timeAgo(m.lastActivity)})`);
        }
      } else {
        console.log('  (활성 멤버 없음)');
      }
      console.log('');
    } catch (e) {
      err(`배포 현황 조회 실패: ${e.message}`);
    }

  } else {
    console.log(`
${BOLD}orbit deploy${RESET} — 전사 배포 관리 (Phase 4)

  ${CYAN}orbit deploy install [invite-code]${RESET}   이 PC에 Orbit 설치 + 워크스페이스 참여
  ${CYAN}orbit deploy batch [invite-code]${RESET}     일괄 설치 스크립트 생성
  ${CYAN}orbit deploy status [workspace-id]${RESET}   배포 현황 확인
    `);
  }
}

// ─── orbit analysis (Phase 2 터미널 분석) ──────────────
async function cmdAnalysis(args) {
  const sub = args[0] || 'dashboard';
  try {
    if (sub === 'dashboard' || sub === 'dash') {
      const data = await apiCall('GET', '/api/work-analysis/dashboard?period=7d');
      console.log(`\n${BOLD}${CYAN}⬡ 작업 분석 대시보드${RESET} (최근 7일)\n`);

      if (data.efficiency) {
        const eff = data.efficiency;
        const gradeColor = eff.grade === 'S' || eff.grade === 'A' ? GREEN : eff.grade === 'B' ? CYAN : YELLOW;
        console.log(`  효율 점수: ${BOLD}${gradeColor}${eff.score}점 (${eff.grade})${RESET}  ${eff.comparison || ''}`);
        if (eff.breakdown) {
          const bd = eff.breakdown;
          console.log(`  ├ 집중도:    ${'█'.repeat(Math.round(bd.focus?.score / 10))}${'░'.repeat(10 - Math.round(bd.focus?.score / 10))} ${bd.focus?.score || 0}`);
          console.log(`  ├ 도구활용:  ${'█'.repeat(Math.round(bd.toolUsage?.score / 10))}${'░'.repeat(10 - Math.round(bd.toolUsage?.score / 10))} ${bd.toolUsage?.score || 0}`);
          console.log(`  ├ 에러회복:  ${'█'.repeat(Math.round(bd.resilience?.score / 10))}${'░'.repeat(10 - Math.round(bd.resilience?.score / 10))} ${bd.resilience?.score || 0}`);
          console.log(`  ├ 꾸준함:    ${'█'.repeat(Math.round(bd.consistency?.score / 10))}${'░'.repeat(10 - Math.round(bd.consistency?.score / 10))} ${bd.consistency?.score || 0}`);
          console.log(`  └ 자동화:    ${'█'.repeat(Math.round(bd.automation?.score / 10))}${'░'.repeat(10 - Math.round(bd.automation?.score / 10))} ${bd.automation?.score || 0}`);
        }
      }

      if (data.todaySummary) {
        const ts = data.todaySummary;
        console.log(`\n  ${BOLD}오늘${RESET}: ${ts.eventCount}건, ${ts.activeMinutes}분 활동, ${ts.topPurpose?.label || '-'}`);
      }

      if (data.efficiency?.insights?.length) {
        console.log(`\n  ${BOLD}인사이트${RESET}`);
        for (const ins of data.efficiency.insights) {
          const icon = ins.type === 'positive' ? GREEN + '✓' : ins.type === 'warning' ? YELLOW + '⚠' : CYAN + '💡';
          console.log(`  ${icon}${RESET} ${ins.message}`);
        }
      }
      console.log('');

    } else if (sub === 'capability' || sub === 'cap') {
      const data = await apiCall('GET', '/api/work-analysis/capability');
      console.log(`\n${BOLD}⬡ 역량 프로필${RESET}\n`);
      if (data.workStyle) {
        console.log(`  작업 스타일: ${BOLD}${data.workStyle.type}${RESET}`);
        console.log(`  등급: ${data.workStyle.overallGrade}\n`);
      }
      if (data.skills?.length) {
        console.log(`  ${BOLD}기술 스택${RESET}`);
        for (const s of data.skills.slice(0, 10)) {
          const bar = '█'.repeat(Math.min(15, Math.round(s.usage / 10)));
          console.log(`  ${CYAN}${s.name.padEnd(18)}${RESET} ${bar} ${s.level}`);
        }
      }
      console.log('');

    } else if (sub === 'learn') {
      const data = await apiCall('GET', '/api/learning/profile');
      console.log(`\n${BOLD}⬡ AI 학습 프로필${RESET}\n`);
      if (data.routines?.length) {
        console.log(`  ${BOLD}루틴${RESET}`);
        data.routines.forEach(r => console.log(`  📅 ${r.description}`));
      }
      if (data.triggers?.length) {
        console.log(`\n  ${BOLD}트리거${RESET}`);
        data.triggers.slice(0, 5).forEach(t => console.log(`  ⚡ ${t.description}`));
      }
      if (data.automationAreas?.areas?.length) {
        console.log(`\n  ${BOLD}자동화 추천${RESET}`);
        data.automationAreas.areas.forEach(a => console.log(`  🤖 ${a.area}: ${a.currentWaste}`));
      }
      console.log('');
    }
  } catch (e) {
    err(`분석 조회 실패: ${e.message}`);
  }
}

// ─── orbit sync ───────────────────────────────────
async function cmdSync() {
  try {
    log('동기화 시작...');
    const result = await apiCall('POST', '/api/sync');
    if (result?.success || result?.status === 'ok') {
      ok(`동기화 완료${result.synced ? ` (${result.synced}건)` : ''}`);
    } else {
      ok(`동기화 응답: ${JSON.stringify(result).slice(0, 100)}`);
    }
  } catch (e) { err(`동기화 실패: ${e.message}`); }
}

// ─── 라우팅 ────────────────────────────────────────
const [,, cmd, ...args] = process.argv;
const cleanArgs = args.filter(a => a !== '--remote');
switch (cmd) {
  case 'init':      cmdInit();              break;
  case 'start':     cmdStart(cleanArgs);    break;
  case 'stop':      cmdStop();              break;
  case 'status':    cmdStatus();            break;
  case 'open':      cmdOpen();              break;
  case 'hook':      cmdHook(cleanArgs);     break;
  case 'login':     cmdLogin(cleanArgs);    break;
  case 'whoami':    cmdWhoami();            break;
  case 'learn':     cmdLearn(cleanArgs);    break;
  case 'dashboard': cmdDashboard();         break;
  case 'events':    cmdEvents(cleanArgs);   break;
  case 'sessions':  cmdSessions();          break;
  case 'stats':     cmdStats();             break;
  case 'search':    cmdSearch(cleanArgs);   break;
  case 'files':     cmdFiles();             break;
  case 'tracker':   cmdTracker();           break;
  case 'push':      cmdPush(cleanArgs);     break;
  case 'logs':      cmdLogs();              break;
  case 'theme':     cmdTheme(cleanArgs);    break;
  case 'config':    cmdConfigCli(cleanArgs); break;
  case 'remote':    cmdRemote(cleanArgs);   break;
  case 'sync':      cmdSync();              break;
  case 'deploy':    cmdDeploy(cleanArgs);   break;
  case 'analysis':  cmdAnalysis(cleanArgs); break;
  case 'analyze':   cmdAnalysis(cleanArgs); break;
  case 'help': default: cmdHelp();          break;
}
