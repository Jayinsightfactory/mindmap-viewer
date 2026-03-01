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
  writePid();

  // Orbit 서버 대기
  const serverUp = await waitForServer();
  if (!serverUp) {
    console.warn('[personal-agent] Orbit 서버에 연결할 수 없습니다. 계속 진행합니다.');
  }

  // ① keyboard-watcher 시작
  let keyboardWatcher = null;
  try {
    keyboardWatcher = require(path.join(ROOT, 'src/keyboard-watcher'));
    keyboardWatcher.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 키보드 와처 시작 실패:', err.message);
  }

  // ② file-learner 시작
  let fileLearner = null;
  try {
    fileLearner = require(path.join(ROOT, 'src/file-learner'));
    fileLearner.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 파일 와처 시작 실패:', err.message);
  }

  // ③ 30분마다 suggestion-engine 실행
  await runSuggestions(); // 최초 즉시 실행
  const suggestionTimer = setInterval(runSuggestions, 30 * 60 * 1000);

  // ── 상태 출력 ──────────────────────────────────────────────────────────────
  console.log(`[personal-agent] 실행 중`);
  console.log(`  ⌨️  키보드 캡처: ${keyboardWatcher?.isRunning() ? 'ON' : 'OFF'}`);
  console.log(`  📁 파일 와처:    ${fileLearner?.isRunning() ? 'ON' : 'OFF'}`);
  console.log(`  💡 제안 엔진:    30분마다 실행`);
  console.log(`  PID 파일: ${PID_FILE}`);

  // ── 종료 핸들러 ────────────────────────────────────────────────────────────
  function shutdown(sig) {
    console.log(`\n[personal-agent] 종료 신호(${sig}) 수신`);
    clearInterval(suggestionTimer);
    try { keyboardWatcher?.stop(); } catch {}
    try { fileLearner?.stop(); } catch {}
    removePid();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('[personal-agent] 예상치 못한 오류:', err.message);
  });
}

main().catch(err => {
  console.error('[personal-agent] 시작 실패:', err.message);
  removePid();
  process.exit(1);
});
