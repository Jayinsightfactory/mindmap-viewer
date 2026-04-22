'use strict';
/**
 * crash-reporter.js — 데몬 crash 포착 + 서버 전송 + 조건부 safe-mode
 *
 * 설계:
 *  1. uncaughtException / unhandledRejection 캐치
 *  2. crash context 수집 (stack, Node/OS, 최근 로그 50줄)
 *  3. 서버 /api/crash/report 로 POST (offline 시 로컬 큐)
 *  4. 1시간 내 3회 crash 감지 시 .safe-mode 파일 생성 (24h TTL)
 *     → keyboard-watcher가 읽고 uiohook 스킵
 *  5. crash 발생 시마다 Claude 분석용 패키지 전송 (server → claude-analyzer)
 *
 * 기존 daemon-updater의 무조건 .safe-mode 생성 대체.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const ORBIT_DIR   = path.join(os.homedir(), '.orbit');
const CRASH_LOG   = path.join(ORBIT_DIR, 'crash-history.jsonl');
const PENDING     = path.join(ORBIT_DIR, '.pending-crash-reports.jsonl');
const DAEMON_LOG  = path.join(ORBIT_DIR, 'daemon.log');
const SAFE_MODE   = path.join(ORBIT_DIR, '.safe-mode');

const CRASH_WINDOW_MS  = 60 * 60 * 1000;   // 1시간
const CRASH_THRESHOLD  = 3;                 // 3회 crash 시 safe-mode
const SAFE_MODE_TTL_MS = 24 * 3600 * 1000;  // 24시간

function _readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
}

function _tailLog(filepath, lines = 50) {
  try {
    if (!fs.existsSync(filepath)) return '';
    const data = fs.readFileSync(filepath, 'utf8');
    const arr = data.split('\n');
    return arr.slice(-lines).join('\n');
  } catch { return ''; }
}

function _appendJsonl(filepath, obj) {
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.appendFileSync(filepath, JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

function _recentCrashCount() {
  try {
    if (!fs.existsSync(CRASH_LOG)) return 0;
    const cutoff = Date.now() - CRASH_WINDOW_MS;
    const lines = fs.readFileSync(CRASH_LOG, 'utf8').trim().split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (new Date(e.ts).getTime() >= cutoff) count++;
      } catch {}
    }
    return count;
  } catch { return 0; }
}

function _enterSafeMode(reason) {
  try {
    fs.mkdirSync(ORBIT_DIR, { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      reason,
      ttlMs: SAFE_MODE_TTL_MS,
      expiresAt: new Date(Date.now() + SAFE_MODE_TTL_MS).toISOString(),
    };
    fs.writeFileSync(SAFE_MODE, JSON.stringify(payload) + '\n', 'utf8');
    console.warn(`[crash-reporter] .safe-mode 생성 (24h TTL) — reason=${reason}`);
  } catch (e) {
    console.warn('[crash-reporter] .safe-mode 생성 실패:', e.message);
  }
}

function _sanitize(str, maxLen = 2000) {
  if (typeof str !== 'string') return '';
  // 파일 경로 중 사용자명 마스킹
  const userName = (process.env.USERNAME || os.userInfo().username || '').trim();
  let out = str;
  if (userName) {
    const re = new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, '<USER>');
  }
  if (out.length > maxLen) out = out.slice(0, maxLen) + '...[truncated]';
  return out;
}

function _buildReport(error, origin) {
  const cfg = _readConfig();
  return {
    id: `crash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    origin,
    hostname: os.hostname(),
    userId: cfg.userId || 'unknown',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    daemonPid: process.pid,
    error: {
      name: error?.name || 'Error',
      message: _sanitize(error?.message || String(error), 500),
      stack:   _sanitize(error?.stack || '', 4000),
      code:    error?.code || null,
    },
    daemonLogTail: _sanitize(_tailLog(DAEMON_LOG, 50), 5000),
    recentCrashCount1h: _recentCrashCount(),
  };
}

function _postReport(report) {
  return new Promise((resolve) => {
    const cfg = _readConfig();
    const serverUrl = cfg.serverUrl;
    const token     = cfg.token;
    if (!serverUrl) return resolve({ ok: false, reason: 'no-server' });

    try {
      const body = JSON.stringify(report);
      const url = new URL('/api/crash/report', serverUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers,
      }, (res) => { res.resume(); resolve({ ok: res.statusCode < 400, status: res.statusCode }); });

      req.on('error', (e) => resolve({ ok: false, reason: e.message }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, reason: e.message });
    }
  });
}

async function _flushPending() {
  if (!fs.existsSync(PENDING)) return;
  try {
    const lines = fs.readFileSync(PENDING, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return;
    const surviving = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        const result = await _postReport(r);
        if (!result.ok) surviving.push(line);
      } catch {}
    }
    if (surviving.length) fs.writeFileSync(PENDING, surviving.join('\n') + '\n');
    else fs.writeFileSync(PENDING, '');
  } catch {}
}

async function _reportCrash(error, origin) {
  const report = _buildReport(error, origin);

  // 1. 로컬 이력 저장 (safe-mode 판단 근거)
  _appendJsonl(CRASH_LOG, { ts: report.ts, origin, msg: report.error.message });

  // 2. 콘솔 로그
  console.error(`[crash-reporter] ${origin}: ${report.error.message}`);
  console.error(report.error.stack);

  // 3. 서버 전송 (실패 시 큐)
  try {
    const res = await _postReport(report);
    if (!res.ok) _appendJsonl(PENDING, report);
  } catch (_e) {
    _appendJsonl(PENDING, report);
  }

  // 4. 1시간 내 3회 이상 crash → safe-mode 진입
  const count = _recentCrashCount();
  if (count >= CRASH_THRESHOLD && !fs.existsSync(SAFE_MODE)) {
    _enterSafeMode(`crash ${count}회 in 1h (origin=${origin})`);
  }
}

function installHandlers() {
  // 큐 재시도 (비동기, 에러 무시)
  _flushPending().catch(() => {});

  // 핸들러는 process.exit 호출 안 함 (기존 patterns와 동일 — 데몬 계속 살려둠)
  // native crash(SIGSEGV 등)는 JavaScript에서 못 잡으므로 래퍼 ps1이 재시작 담당
  process.on('uncaughtException', (err) => {
    _reportCrash(err, 'uncaughtException').catch(() => {});
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    _reportCrash(err, 'unhandledRejection').catch(() => {});
  });

  console.log('[crash-reporter] handlers 설치 완료 (threshold=3회/1h, TTL=24h)');
}

module.exports = { installHandlers, _reportCrash, _recentCrashCount };
