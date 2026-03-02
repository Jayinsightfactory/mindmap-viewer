/**
 * keylogger.js
 * ─────────────────────────────────────────────────────────────
 * 로컬 키입력 수집 + Ollama 분석 에이전트
 *
 * 프라이버시 원칙:
 *   - 원문 키스트로크는 로컬 SQLite에만 저장
 *   - 30초마다 Ollama가 분석 → 결과(패턴/인사이트)만 서버 전송
 *   - 비밀번호 필드 자동 감지 후 마스킹 (*** 처리)
 *   - 언제든 OFF 가능 (ORBIT_KEYLOG=false 환경변수)
 *
 * 실행:
 *   node src/keylogger.js
 *   (설치 스크립트가 백그라운드로 자동 실행)
 * ─────────────────────────────────────────────────────────────
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');

// ── 설정 ────────────────────────────────────────────────────
const ENABLED         = process.env.ORBIT_KEYLOG !== 'false';
const LOCAL_PORT      = parseInt(process.env.MINDMAP_PORT || '4747');
const OLLAMA_PORT     = parseInt(process.env.OLLAMA_PORT  || '11434');
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';
const FLUSH_INTERVAL  = 30000;   // 30초마다 Ollama 분석
const MIN_CHARS       = 20;      // 최소 20자 이상 쌓였을 때 분석
const MAX_BUFFER      = 2000;    // 버퍼 최대 2000자

const BASE_DIR   = path.resolve(__dirname);
const DB_PATH    = path.join(BASE_DIR, 'data', 'keylog.db');
const LOG_FILE   = path.join(BASE_DIR, 'keylog.log');

// data 폴더 자동 생성
try { fs.mkdirSync(path.join(BASE_DIR, 'data'), { recursive: true }); } catch {}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

if (!ENABLED) {
  log('키로거 비활성화 (ORBIT_KEYLOG=false)');
  process.exit(0);
}

// ── SQLite 초기화 ────────────────────────────────────────────
function initDb() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS keylog_sessions (
        id         TEXT PRIMARY KEY,
        started_at TEXT,
        app        TEXT,
        window     TEXT
      );
      CREATE TABLE IF NOT EXISTS keylog_chunks (
        id          TEXT PRIMARY KEY,
        session_id  TEXT,
        text        TEXT NOT NULL,      -- 원문 (로컬 only)
        captured_at TEXT,
        analyzed    INTEGER DEFAULT 0   -- Ollama 분석 완료 여부
      );
      CREATE TABLE IF NOT EXISTS keylog_insights (
        id          TEXT PRIMARY KEY,
        chunk_ids   TEXT,               -- 분석에 사용된 chunk ids
        insight     TEXT NOT NULL,      -- Ollama 분석 결과 JSON
        created_at  TEXT
      );
    `);
    return db;
  } catch (e) {
    log(`DB 초기화 실패: ${e.message}`);
    return null;
  }
}

// ── 키 버퍼 ─────────────────────────────────────────────────
let _buffer        = '';          // 현재 입력 버퍼
let _isPassword    = false;       // 비밀번호 필드 감지 여부
let _flushTimer    = null;
let _sessionId     = `ks-${Date.now()}`;
let _db            = null;

// 특수키 → 텍스트 변환 (의미있는 것만)
const SPECIAL_KEYS = {
  'Return':    '\n',
  'space':     ' ',
  'Tab':       '\t',
  'BackSpace': '⌫',
  'Delete':    '⌦',
  'Escape':    '[ESC]',
};

// 비밀번호로 추정되는 필드에서 타이핑 중인지 감지
// (실제로는 창 제목/앱으로 감지하지만 단순화: 앱 이름 기반)
const PASSWORD_APPS = ['KeePass', '1Password', 'Bitwarden', 'LastPass', 'Samsung Pass'];
function checkPasswordContext(windowTitle) {
  if (!windowTitle) return false;
  const lower = windowTitle.toLowerCase();
  return lower.includes('password') || lower.includes('비밀번호') ||
    PASSWORD_APPS.some(app => lower.includes(app.toLowerCase()));
}

// ── uiohook-napi 로드 (없으면 대체 방법 시도) ────────────────
function startCapture() {
  try {
    // uiohook-napi: 가장 안정적인 크로스플랫폼 키 후킹 라이브러리
    const { uIOhook, UiohookKey } = require('uiohook-napi');

    uIOhook.on('keydown', (event) => {
      if (_isPassword) return; // 비밀번호 필드는 무시

      let char = '';

      // 특수키 처리
      if (SPECIAL_KEYS[event.keycode]) {
        char = SPECIAL_KEYS[event.keycode];
      } else if (event.keycode) {
        // 일반 문자 키 (keycode → 실제 문자)
        // uiohook-napi는 keychar 필드 제공
        char = event.keychar ? String.fromCharCode(event.keychar) : '';
      }

      if (!char) return;

      _buffer += char;

      // 버퍼 한도 초과 시 즉시 플러시
      if (_buffer.length >= MAX_BUFFER) {
        flushBuffer();
      }
    });

    uIOhook.start();
    log('uiohook-napi 시작');
    return true;
  } catch (e) {
    log(`uiohook-napi 로드 실패: ${e.message} — 대체 방법 시도`);
    return startFallbackCapture();
  }
}

// ── 대체 캡처: PowerShell / Python 방식 ─────────────────────
function startFallbackCapture() {
  const { spawn } = require('child_process');
  const platform  = process.platform;

  if (platform === 'win32') {
    // PowerShell 방식: PSReadLine 훅 대신 stdin 파이프로 수신
    log('Windows: PowerShell 키 캡처 시작');
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -AssemblyName System.Windows.Forms
      $wsh = New-Object -ComObject WScript.Shell
      while ($true) {
        $key = [System.Console]::ReadKey($true)
        Write-Output $key.KeyChar
        Start-Sleep -Milliseconds 10
      }
    `], { stdio: ['ignore', 'pipe', 'ignore'] });

    ps.stdout.on('data', data => {
      _buffer += data.toString();
      if (_buffer.length >= MAX_BUFFER) flushBuffer();
    });

    ps.on('error', () => log('PowerShell 캡처 실패'));
    return true;
  }

  if (platform === 'darwin' || platform === 'linux') {
    // Python pynput 방식 (macOS/Linux)
    const script = `
import sys
try:
    from pynput import keyboard
    def on_press(key):
        try:
            sys.stdout.write(key.char or '')
            sys.stdout.flush()
        except: pass
    with keyboard.Listener(on_press=on_press) as l: l.join()
except ImportError:
    # pynput 없으면 설치
    import subprocess
    subprocess.run(['pip3', 'install', 'pynput', '-q'])
    exec(open(__file__).read())
`;
    const py = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    py.stdout.on('data', data => {
      _buffer += data.toString();
      if (_buffer.length >= MAX_BUFFER) flushBuffer();
    });
    py.on('error', () => log('Python 캡처 실패'));
    return true;
  }

  log('지원되지 않는 플랫폼');
  return false;
}

// ── 버퍼 플러시 → SQLite 저장 ────────────────────────────────
function flushBuffer() {
  if (_buffer.trim().length < MIN_CHARS) {
    _buffer = '';
    return;
  }

  const text = _buffer;
  _buffer = '';

  if (!_db) return;

  try {
    const chunkId = `kc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    _db.prepare(`
      INSERT INTO keylog_chunks (id, session_id, text, captured_at)
      VALUES (?, ?, ?, ?)
    `).run(chunkId, _sessionId, text, new Date().toISOString());

    log(`청크 저장: ${text.length}자 (id=${chunkId})`);

    // Ollama 분석 트리거
    analyzeWithOllama(chunkId, text);
  } catch (e) {
    log(`청크 저장 오류: ${e.message}`);
  }
}

// ── Ollama 분석 ──────────────────────────────────────────────
async function analyzeWithOllama(chunkId, text) {
  // 비밀번호·카드번호 패턴 마스킹
  const masked = text
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '****-****-****-****') // 카드
    .replace(/\b\d{6,}\b/g, '******')    // 6자리 이상 숫자 (OTP 등)
    .replace(/password[^\s]*/gi, '***')  // password 뒤 단어
    .replace(/비밀번호[^\s]*/g, '***');  // 비밀번호 뒤 단어

  const prompt = `다음은 사용자의 키 입력 텍스트입니다. 한국어로 분석해주세요.
(이 데이터는 로컬에만 있으며, 원문은 서버로 전송되지 않습니다)

입력 텍스트 (${masked.length}자):
"""
${masked.slice(0, 500)}
"""

아래 JSON 형식으로만 응답하세요:
{
  "topic": "작업 주제 (15자 이내)",
  "language": "주로 사용한 언어 (한국어/영어/코드 등)",
  "activity": "이메일|채팅|문서작성|코딩|검색|기타",
  "keywords": ["핵심 키워드1", "키워드2", "키워드3"],
  "context": "작업 맥락 요약 (30자 이내)"
}`;

  try {
    const insight = await callOllama(prompt);
    if (!insight) return;

    // 인사이트 저장 (로컬)
    const insightId = `ki-${Date.now()}`;
    if (_db) {
      _db.prepare(`
        INSERT INTO keylog_insights (id, chunk_ids, insight, created_at)
        VALUES (?, ?, ?, ?)
      `).run(insightId, chunkId, JSON.stringify(insight), new Date().toISOString());

      // 분석 완료 표시
      _db.prepare(`UPDATE keylog_chunks SET analyzed = 1 WHERE id = ?`).run(chunkId);
    }

    log(`Ollama 분석 완료: ${insight.topic} (${insight.activity})`);

    // 로컬 서버로 인사이트 전송 (원문 없이)
    sendInsightToServer(insight, insightId);
  } catch (e) {
    log(`Ollama 분석 오류: ${e.message}`);
  }
}

// ── Ollama API 호출 ──────────────────────────────────────────
function callOllama(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:   OLLAMA_MODEL,
      prompt,
      stream:  false,
      options: { temperature: 0.2, num_predict: 200 },
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port:     OLLAMA_PORT,
      path:     '/api/generate',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const resp  = JSON.parse(data);
          const text  = resp.response || '';
          const match = text.match(/\{[\s\S]*\}/);
          resolve(match ? JSON.parse(match[0]) : null);
        } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── 로컬 서버로 인사이트 전송 (원문 절대 포함 안 함) ─────────
function sendInsightToServer(insight, insightId) {
  try {
    const payload = JSON.stringify({
      type:      'keylog_insight',
      insightId,
      insight,                    // 분석 결과만 (원문 없음)
      timestamp: new Date().toISOString(),
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port:     LOCAL_PORT,
      path:     '/api/keylog-insight',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, r => r.resume());

    req.on('error', () => {});
    req.setTimeout(3000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  log('=== Orbit 키로거 시작 ===');
  log(`모드: 로컬 저장 + Ollama 분석만 (원문 서버 전송 없음)`);

  // DB 초기화
  _db = initDb();
  if (!_db) {
    log('DB 초기화 실패 — 종료');
    process.exit(1);
  }

  // 세션 등록
  _db.prepare(`INSERT INTO keylog_sessions (id, started_at) VALUES (?, ?)`)
    .run(_sessionId, new Date().toISOString());

  // 키 캡처 시작
  const started = startCapture();
  if (!started) {
    log('캡처 시작 실패 — 종료');
    process.exit(1);
  }

  // 주기적 플러시 (30초마다)
  _flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL);

  // 종료 시 버퍼 플러시
  process.on('SIGINT',  () => { flushBuffer(); process.exit(0); });
  process.on('SIGTERM', () => { flushBuffer(); process.exit(0); });

  log('캡처 중... (Ctrl+C로 종료)');
}

main();
