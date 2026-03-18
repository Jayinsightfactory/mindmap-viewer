#!/usr/bin/env node
'use strict';

/**
 * daemon/personal-agent.js
 * 개인 학습 에이전트 데몬
 *
 * 실행: node daemon/personal-agent.js [--port 4747]
 * 종료: SIGTERM / SIGINT
 *
 * 기능:
 *  - keyboard-watcher (글로벌 키보드 캡처)
 *  - file-learner (파일 저장 내용 학습)
 *  - 30분마다 suggestion-engine 실행
 */

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const http    = require('http');
const https   = require('https');

// ── 원격 서버 설정 (~/.orbit-config.json) ──────────────────────────────────
const _orbitConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
})();
const REMOTE_URL   = _orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL || null;
const REMOTE_TOKEN = _orbitConfig.token     || process.env.ORBIT_TOKEN      || '';

// ── 에러 리포트 서버 전송 ──────────────────────────────────────────────────
function _reportError(component, error, detail) {
  if (!REMOTE_URL) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id: 'daemon-err-' + Date.now(),
        type: 'daemon.error',
        source: 'personal-agent',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          component,
          error: String(error),
          detail: detail || '',
          hostname: os.hostname(),
          platform: os.platform(),
          nodeVersion: process.version,
        },
      }],
    });
    const url = new URL('/api/hook', REMOTE_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, res => res.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── 설정 ─────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const PORT     = parseInt(args[args.indexOf('--port') + 1] || process.env.ORBIT_PORT || '4747', 10);
const PID_DIR  = path.join(os.homedir(), '.orbit');
const PID_FILE = path.join(PID_DIR, 'personal-agent.pid');
const ROOT     = path.resolve(__dirname, '..');

// ── PID 파일 관리 ─────────────────────────────────────────────────────────────
function writePid() {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  } catch {}
}
function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ── 서버 헬스 체크 ────────────────────────────────────────────────────────────
function waitForServer(retries = 10) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(`http://localhost:${PORT}/api/personal/status`, res => {
        res.resume();
        if (res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });

      function retry() {
        attempts++;
        if (attempts >= retries) resolve(false);
        else setTimeout(check, 2000);
      }
    };
    check();
  });
}

// ── 원격 서버 헬스 체크 (비차단) ──────────────────────────────────────────────
function checkRemoteServer() {
  if (!REMOTE_URL) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/personal/status', REMOTE_URL);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get(url.href, { timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

// ── content-analyzer: 로컬 Ollama로 키보드 내용 태깅 ────────────────────────
async function runContentAnalysis() {
  try {
    const contentAnalyzer = require(path.join(ROOT, 'src/content-analyzer'));
    const dbModule        = require(path.join(ROOT, 'src/db'));
    const db              = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    // 최근 4시간 미분석 이벤트
    const since  = new Date(Date.now() - 4 * 3600_000).toISOString();
    const events = db.prepare(
      `SELECT * FROM events WHERE type='keyboard.chunk' AND timestamp > ? ORDER BY timestamp ASC`
    ).all(since);

    await contentAnalyzer.analyzeAndStore(events, db);
  } catch (err) {
    console.error('[personal-agent] content-analyzer 오류:', err.message);
  }
}

// ── trigger-engine: 이슈 역추적 + 트리거 패턴 학습 ──────────────────────────
async function runTriggerLearning() {
  try {
    const triggerEngine = require(path.join(ROOT, 'src/trigger-engine'));
    const dbModule      = require(path.join(ROOT, 'src/db'));
    const db            = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    const learned = triggerEngine.processUnanalyzedIssues(db);
    if (learned.length) {
      console.log(`[personal-agent] 트리거 패턴 학습 완료: ${learned.length}개`);
    }
  } catch (err) {
    console.error('[personal-agent] trigger-engine 오류:', err.message);
  }
}

// ── suggestion-engine 실행 ────────────────────────────────────────────────────
async function runSuggestions() {
  try {
    const { run }    = require(path.join(ROOT, 'src/suggestion-engine'));
    const dbModule   = require(path.join(ROOT, 'src/db'));
    const db         = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    // 최근 7일 이벤트
    const since  = new Date(Date.now() - 7 * 86400_000).toISOString();
    const events = db.prepare(`SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC`).all(since);
    await run(events, db);
  } catch (err) {
    console.error('[personal-agent] suggestion-engine 오류:', err.message);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[personal-agent] 시작 (PID: ${process.pid}, Orbit Port: ${PORT})`);
  console.log(`[personal-agent] 원격 서버: ${REMOTE_URL || '(없음)'}`);
  writePid();

  // Orbit 서버 대기 (localhost)
  const serverUp = await waitForServer();
  if (!serverUp) {
    console.warn('[personal-agent] 로컬 Orbit 서버에 연결할 수 없습니다. 계속 진행합니다.');
  }

  // 원격 서버 헬스 체크 (비차단 — 실패해도 계속)
  checkRemoteServer().then(up => {
    if (up) console.log('[personal-agent] 원격 서버 연결 확인됨');
    else if (REMOTE_URL) console.warn('[personal-agent] 원격 서버에 연결할 수 없습니다. 로컬만 사용합니다.');
  });

  // ① keyboard-watcher 시작
  let keyboardWatcher = null;
  try {
    keyboardWatcher = require(path.join(ROOT, 'src/keyboard-watcher'));
    keyboardWatcher.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 키보드 와처 시작 실패:', err.message);
    _reportError('keyboard-watcher', err.message, err.stack);
  }

  // ①-b daemon-updater 시작 (자동 업데이트 + 원격 명령)
  let daemonUpdater = null;
  try {
    daemonUpdater = require(path.join(ROOT, 'src/daemon-updater'));
    daemonUpdater.start();
  } catch (err) {
    console.error('[personal-agent] 자동 업데이트 모듈 시작 실패:', err.message);
  }

  // ② file-learner 시작
  let fileLearner = null;
  try {
    fileLearner = require(path.join(ROOT, 'src/file-learner'));
    fileLearner.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 파일 와처 시작 실패:', err.message);
    _reportError('file-learner', err.message, err.stack);
  }

  // ②-b screen-capture 시작 + keyboard-watcher 연결
  let screenCapture = null;
  try {
    screenCapture = require(path.join(ROOT, 'src/screen-capture'));
    screenCapture.start();
    // 키보드 와처 → 스크린 캡처 이벤트 연결 (앱 전환/idle 시 캡처)
    if (keyboardWatcher?.setScreenCapture) keyboardWatcher.setScreenCapture(screenCapture);
  } catch (err) {
    console.error('[personal-agent] 스크린 캡처 시작 실패:', err.message);
  }

  // ②-c Google Drive 캡처 업로드 초기화
  let driveUploader = null;
  try {
    driveUploader = require(path.join(ROOT, 'src/drive-uploader'));
    // 서버에서 Drive 설정 가져오기
    if (REMOTE_URL) {
      const driveConfig = await new Promise((resolve) => {
        const url = new URL('/api/daemon/drive-config', REMOTE_URL);
        const mod = url.protocol === 'https:' ? https : http;
        const headers = {};
        if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
        const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (driveConfig?.enabled) {
        driveUploader.init(driveConfig);
        // 5분마다 미업로드 캡처 일괄 업로드
        setInterval(() => driveUploader.uploadPending(), 5 * 60 * 1000);
        // 시작 시 즉시 1회
        setTimeout(() => driveUploader.uploadPending(), 10000);
      }
    }
  } catch (err) {
    console.error('[personal-agent] Drive 업로더 초기화 실패:', err.message);
  }

  // ②-d Vision 워커 자동 실행 (Claude CLI 있는 PC만)
  let _visionRunning = false;
  try {
    const { execSync } = require('child_process');
    const claudeCli = execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0];
    if (claudeCli && driveUploader?.isEnabled()) {
      _visionRunning = true;
      console.log(`[personal-agent] Vision 워커 활성화 (CLI: ${claudeCli})`);
      // 5분마다 Vision 분석 실행
      const visionWorkerPath = path.join(ROOT, 'bin', 'vision-worker.js');
      if (fs.existsSync(visionWorkerPath)) {
        const { fork } = require('child_process');
        const visionChild = fork(visionWorkerPath, [], {
          env: { ...process.env, ORBIT_SERVER_URL: REMOTE_URL, ORBIT_TOKEN: REMOTE_TOKEN },
          stdio: 'pipe',
        });
        visionChild.stdout?.on('data', d => console.log('[vision] ' + d.toString().trim()));
        visionChild.stderr?.on('data', d => console.warn('[vision] ' + d.toString().trim()));
        visionChild.on('exit', (code) => {
          console.warn(`[vision] 워커 종료 (code: ${code})`);
          _visionRunning = false;
        });
      }
    }
  } catch {}

  // ③ 10분마다 content-analyzer 실행 (Ollama 로컬 태깅)
  await runContentAnalysis();
  const contentTimer = setInterval(runContentAnalysis, 10 * 60 * 1000);

  // ④ 30분마다 suggestion-engine + trigger-engine 실행
  await runSuggestions();
  await runTriggerLearning();
  const suggestionTimer = setInterval(async () => {
    await runSuggestions();
    await runTriggerLearning();
  }, 30 * 60 * 1000);

  // ── 상태 출력 ──────────────────────────────────────────────────────────────
  console.log(`[personal-agent] 실행 중`);
  console.log(`  키보드 캡처:   ${keyboardWatcher?.isRunning() ? 'ON' : 'OFF'}`);
  console.log(`  파일 와처:     ${fileLearner?.isRunning() ? 'ON' : 'OFF'}`);
  console.log(`  스크린 캡처:   ${screenCapture ? 'ON (이벤트 기반)' : 'OFF'}`);
  console.log(`  Drive 업로드:  ${driveUploader?.isEnabled() ? 'ON (5분 간격)' : 'OFF'}`);
  console.log(`  Vision 분석:  ${_visionRunning ? 'ON (Claude CLI)' : 'OFF (CLI 없음)'}`);
  console.log(`  자동 업데이트: ${daemonUpdater ? 'ON (평일 09:30/13:00/15:00)' : 'OFF'}`);
  console.log(`  제안 엔진:     30분마다 실행`);
  console.log(`  원격 서버:     ${REMOTE_URL || '(미설정)'}`);
  console.log(`  PID 파일: ${PID_FILE}`);

  // ── 종료 핸들러 ────────────────────────────────────────────────────────────
  function shutdown(sig) {
    console.log(`\n[personal-agent] 종료 신호(${sig}) 수신`);
    clearInterval(contentTimer);
    clearInterval(suggestionTimer);
    try { daemonUpdater?.stop(); } catch {}
    try { keyboardWatcher?.stop(); } catch {}
    try { fileLearner?.stop(); } catch {}
    try { screenCapture?.stop(); } catch {}
    removePid();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('[personal-agent] 예상치 못한 오류:', err.message);
    _reportError('uncaughtException', err.message, err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[personal-agent] Promise 거부:', reason);
    _reportError('unhandledRejection', String(reason));
  });
}

main().catch(err => {
  console.error('[personal-agent] 시작 실패:', err.message);
  removePid();
  process.exit(1);
});
