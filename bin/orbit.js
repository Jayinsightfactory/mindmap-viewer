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

${BOLD}사용법:${RESET}
  orbit <command> [options]

${BOLD}명령어:${RESET}
  ${CYAN}init${RESET}              초기 설정 (Claude Code hooks + CLAUDE.md)
  ${CYAN}start [port]${RESET}      서버 시작 (--bg: 백그라운드)
  ${CYAN}stop${RESET}              서버 종료
  ${CYAN}status${RESET}            서버 상태 확인
  ${CYAN}open${RESET}              브라우저로 대시보드 열기
  ${CYAN}login <e> <t>${RESET}     계정 로그인
  ${CYAN}whoami${RESET}            현재 계정 확인
  ${CYAN}hook${RESET}              Claude Code hook 핸들러 (내부용)
  ${CYAN}help${RESET}              이 도움말

${BOLD}빠른 시작:${RESET}
  npx orbit-ai init       초기 설정
  npx orbit-ai start      서버 시작
  npx orbit-ai open       대시보드 열기

${BOLD}하네스 단축 명령 (CLAUDE.md 설정 후):${RESET}
  ulw: [작업]             울트라 워크 모드
  fix: [오류]             오라클 디버그 모드
  plan: [기능]            프로메테우스 계획 모드
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

// ─── 라우팅 ────────────────────────────────────────
const [,, cmd, ...args] = process.argv;
switch (cmd) {
  case 'init':    cmdInit();        break;
  case 'start':   cmdStart(args);   break;
  case 'stop':    cmdStop();        break;
  case 'status':  cmdStatus();      break;
  case 'open':    cmdOpen();        break;
  case 'hook':    cmdHook(args);    break;
  case 'login':   cmdLogin(args);   break;
  case 'whoami':  cmdWhoami();      break;
  case 'learn':   cmdLearn(args);   break;
  case 'help': default: cmdHelp();  break;
}
