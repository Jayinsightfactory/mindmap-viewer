'use strict';
/**
 * src/self-healer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터 수집 셀프힐링 + PC 이슈 감지 엔진
 *
 * [A] 자동 복구 (조용히 수정)
 *   1. 업무시간 30분 무이벤트 → keyboard-watcher 재시작
 *   2. 서버 전송 에러 5회 연속 → 토큰 캐시 초기화
 *   3. 스크린캡처 에러 5회 연속 → screen-capture 재시작
 *   4. isRunning() = false → 해당 컴포넌트 재시작
 *
 * [B] 이슈 감지 + 관리자 리포트 (daemon.perf.issue 이벤트 전송)
 *   5. PowerShell 창 3개 이상 → powershell_flood (서버 리포트)
 *   6. 검은화면 캡처 (5KB 미만) → capture_blackscreen + screen-capture 재시작
 *   7. 캡처 파일 200개 이상 → capture_accumulation + 7일 이상 파일 자동 정리
 *   8. Node.js 메모리 400MB 이상 → memory_high (서버 리포트)
 *   9. Python 좀비 프로세스 3개 이상 → python_zombie + 정리 시도
 *  10. .orbit 디렉토리 쓰기 불가 → file_write_fail (서버 리포트)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

const HEAL_INTERVAL_MS   = 5 * 60 * 1000;   // 5분마다 전체 헬스체크
const PERF_INTERVAL_MS   = 3 * 60 * 1000;   // 3분마다 성능/이슈 체크
const MAX_SILENCE_MS     = 30 * 60 * 1000;  // 업무시간 중 30분 무이벤트 = 이상
const MAX_SEND_ERRS      = 5;
const MAX_CAPTURE_ERRS   = 5;
const WORK_START_HOUR    = 8;
const WORK_END_HOUR      = 21;

const ORBIT_CAPTURE_DIR  = path.join(os.homedir(), '.orbit', 'captures');
const ORBIT_DIR          = path.join(os.homedir(), '.orbit');

// 이슈 리포트 쿨다운 — 같은 이슈를 30분 내 중복 리포트 방지
const ISSUE_COOLDOWN_MS  = 30 * 60 * 1000;
const _issueCooldown     = {};   // { issueType: lastReportedAt }

// ── 내부 상태 ─────────────────────────────────────────────────────────────────
let _components      = {};
let _lastEventAt     = Date.now();
let _sendErrCount    = 0;
let _captureErrCount = 0;
let _healTimer       = null;
let _perfTimer       = null;
let _reportEvent     = null;
let _clearTokenCache = null;
let _healCount       = 0;
let _initialized     = false;

// ── 초기화 ────────────────────────────────────────────────────────────────────
function init({ components = {}, reportEvent, clearTokenCache } = {}) {
  _components      = components;
  _reportEvent     = reportEvent     || (() => {});
  _clearTokenCache = clearTokenCache || (() => {});
  _initialized     = true;
}

// ── 외부 상태 기록 ────────────────────────────────────────────────────────────
function recordEvent()         { _lastEventAt = Date.now(); _sendErrCount = 0; }
function recordSendError()     { _sendErrCount++; }
function recordCaptureError()  { _captureErrCount++; }
function recordCaptureSuccess(){ _captureErrCount = 0; }

// ── 업무시간 체크 ─────────────────────────────────────────────────────────────
function _isWorkHour() {
  const h = new Date().getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

// ── 이슈 쿨다운 체크 ──────────────────────────────────────────────────────────
function _shouldReport(issueType) {
  const last = _issueCooldown[issueType] || 0;
  if (Date.now() - last < ISSUE_COOLDOWN_MS) return false;
  _issueCooldown[issueType] = Date.now();
  return true;
}

// ── execSync 래퍼 (WindowsHide, 빠른 타임아웃) ───────────────────────────────
function _exec(cmd, timeoutMs = 5000) {
  try {
    const { execSync } = require('child_process');
    return execSync(cmd, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// ── 컴포넌트 재시작 ───────────────────────────────────────────────────────────
async function _restartComponent(name) {
  const comp = _components[name];
  if (!comp?.ref) return false;
  try { if (typeof comp.ref.stop === 'function') comp.ref.stop(); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  try {
    if (typeof comp.ref.start === 'function') {
      comp.ref.start(comp.startArgs || {});
      console.log(`[self-healer] ${name} 재시작 완료`);
      return true;
    }
  } catch (e) { console.error(`[self-healer] ${name} 재시작 실패:`, e.message); }
  return false;
}

// ── 이슈 서버 리포트 ──────────────────────────────────────────────────────────
function _reportIssue(issueType, detail = {}) {
  if (!_shouldReport(issueType)) return;
  console.warn(`[self-healer] 이슈 감지: ${issueType}`, detail);
  try {
    _reportEvent('daemon.perf.issue', {
      issueType,
      hostname:  os.hostname(),
      platform:  os.platform(),
      memMB:     Math.round(process.memoryUsage().rss / 1024 / 1024),
      ts:        new Date().toISOString(),
      ...detail,
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// [B] PC 이슈 감지 (Windows 전용 포함)
// ═══════════════════════════════════════════════════════════════════════════════
async function _checkPerfIssues() {
  if (!_initialized) return;
  const isWin = os.platform() === 'win32';

  // ── 1. Node.js 메모리 400MB 이상 ────────────────────────────────────────────
  const memMB = process.memoryUsage().rss / 1024 / 1024;
  if (memMB > 400) {
    _reportIssue('memory_high', { memMB: Math.round(memMB), cause: 'Node.js RSS 과다' });
  }

  // ── 2. .orbit 디렉토리 쓰기 테스트 ──────────────────────────────────────────
  try {
    const testFile = path.join(ORBIT_DIR, '.write-test');
    fs.writeFileSync(testFile, '1');
    fs.unlinkSync(testFile);
  } catch (e) {
    _reportIssue('file_write_fail', { dir: ORBIT_DIR, error: e.message, cause: '파일 수정/삭제 불가' });
  }

  if (!isWin) return;  // 아래는 Windows 전용

  // ── 3. PowerShell 창 팝업 감지 (3개 이상 = Orbit 코드 문제) ─────────────────
  try {
    const psOut = _exec(
      'tasklist /FI "IMAGENAME eq powershell.exe" /NH /FO CSV 2>nul',
      4000
    );
    const psCount = (psOut.match(/powershell\.exe/gi) || []).length;
    if (psCount >= 3) {
      _reportIssue('powershell_flood', {
        psCount,
        cause: 'PowerShell 창 다수 팝업 — keyboard-watcher execSync 의심',
      });
    }
  } catch {}

  // ── 4. Python 좀비 프로세스 (screen-capture 잔여 프로세스) ──────────────────
  try {
    const pyOut = _exec(
      'tasklist /FI "IMAGENAME eq python.exe" /NH /FO CSV 2>nul',
      4000
    );
    const pyCount = (pyOut.match(/python\.exe/gi) || []).length;
    if (pyCount >= 3) {
      _reportIssue('python_zombie', {
        pyCount,
        cause: 'Python 캡처 프로세스 좀비 — screen-capture 누적',
      });
      // 자동 정리: 오래된 python 프로세스 종료 (kill all python)
      try { _exec('taskkill /F /IM python.exe /T 2>nul', 5000); } catch {}
      await _restartComponent('screen-capture');
    }
  } catch {}

  // ── 5. 캡처 파일 체크 (검은화면 / 누적 / stale) ────────────────────────────
  if (!fs.existsSync(ORBIT_CAPTURE_DIR)) return;
  try {
    const files = fs.readdirSync(ORBIT_CAPTURE_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => {
        const full = path.join(ORBIT_CAPTURE_DIR, f);
        const stat = fs.statSync(full);
        return { name: f, full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    // 5-a. 검은화면: 가장 최근 캡처 파일이 5KB 미만
    if (files.length > 0 && files[0].size < 5 * 1024) {
      _reportIssue('capture_blackscreen', {
        file:  files[0].name,
        size:  files[0].size,
        cause: '캡처 파일 크기 이상 — 검은화면 또는 빈 캡처 (screen-capture 재시작)',
      });
      await _restartComponent('screen-capture');
    }

    // 5-b. 캡처 파일 누적 (200개 이상): 7일 이상 된 파일 자동 삭제
    if (files.length > 200) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let deleted = 0;
      for (const f of files) {
        if (f.mtime < cutoff) {
          try { fs.unlinkSync(f.full); deleted++; } catch {}
        }
      }
      _reportIssue('capture_accumulation', {
        total:   files.length,
        deleted,
        cause:   `캡처 파일 ${files.length}개 누적 — ${deleted}개 자동 삭제 (7일 이상)`,
      });
    }

    // 5-c. 업무시간 중 60분 이상 캡처 없음 (stale)
    if (_isWorkHour() && files.length > 0) {
      const staleMs = Date.now() - files[0].mtime;
      if (staleMs > 60 * 60 * 1000) {
        _reportIssue('capture_stale', {
          lastCapMin: Math.round(staleMs / 60000),
          cause:      `업무시간 중 ${Math.round(staleMs/60000)}분간 캡처 없음 — screen-capture 재시작`,
        });
        await _restartComponent('screen-capture');
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// [A] 메인 힐링 루프
// ═══════════════════════════════════════════════════════════════════════════════
async function _runHeal() {
  if (!_initialized) return;
  const now    = Date.now();
  const issues = [];

  // 1. 업무시간 중 이벤트 흐름 체크
  if (_isWorkHour()) {
    const silenceMs = now - _lastEventAt;
    if (silenceMs > MAX_SILENCE_MS) {
      issues.push(`event_silence_${Math.round(silenceMs / 60000)}min`);
      const ok = await _restartComponent('keyboard-watcher');
      if (ok) _lastEventAt = now;
    }
  }

  // 2. 서버 연속 전송 에러
  if (_sendErrCount >= MAX_SEND_ERRS) {
    issues.push(`send_errors_${_sendErrCount}`);
    if (_clearTokenCache) _clearTokenCache();
    _sendErrCount = 0;
  }

  // 3. 스크린 캡처 연속 실패
  if (_captureErrCount >= MAX_CAPTURE_ERRS) {
    issues.push(`capture_errors_${_captureErrCount}`);
    await _restartComponent('screen-capture');
    _captureErrCount = 0;
  }

  // 4. 컴포넌트별 isRunning 체크
  for (const [name, comp] of Object.entries(_components)) {
    if (!comp?.ref) continue;
    let running = null;
    if (typeof comp.ref.isRunning === 'function')       running = comp.ref.isRunning();
    else if (typeof comp.ref.isAlive === 'function')    running = comp.ref.isAlive();
    if (running === false) {
      issues.push(`${name}_stopped`);
      await _restartComponent(name);
    }
  }

  // 5. 이슈 발생 시 서버 리포트 (daemon.healed)
  if (issues.length > 0) {
    _healCount++;
    console.log(`[self-healer] 치유 #${_healCount}: ${issues.join(', ')}`);
    try {
      _reportEvent('daemon.healed', {
        healCount: _healCount,
        issues,
        hostname:  os.hostname(),
        platform:  os.platform(),
        ts:        new Date().toISOString(),
      });
    } catch {}
  }
}

// ===============================================================================
// [C] Config/Connection self-repair
// ===============================================================================
async function _checkConfigHealth() {
  if (!_initialized) return;
  const cfgPath = path.join(os.homedir(), '.orbit-config.json');

  // C-1: Config file parseable
  try {
    let raw = fs.readFileSync(cfgPath, 'utf8');
    let repaired = false;

    // BOM auto-remove
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
      fs.writeFileSync(cfgPath, raw, 'utf8');
      repaired = true;
      console.log('[self-healer] config BOM removed');
    }

    const cfg = JSON.parse(raw.trim());

    // C-2: serverUrl must match canonical
    const CANONICAL = 'https://mindmap-viewer-production-adb2.up.railway.app';
    if (cfg.serverUrl && cfg.serverUrl !== CANONICAL) {
      cfg.serverUrl = CANONICAL;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      repaired = true;
      console.log('[self-healer] serverUrl repaired to canonical');
    }

    // C-3: hostname must exist
    if (!cfg.hostname) {
      cfg.hostname = os.hostname();
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      repaired = true;
    }

    // C-4: token invalid (401 count > 10) -> re-register
    if (_sendErrCount >= 10) {
      console.log('[self-healer] 401 errors > 10 -> attempting re-register');
      try {
        const http = require('http');
        const https = require('https');
        const payload = JSON.stringify({ hostname: os.hostname(), platform: os.platform() });
        const url = new (require('url').URL)('/api/daemon/register', cfg.serverUrl || CANONICAL);
        const mod = url.protocol === 'https:' ? https : http;
        await new Promise((resolve) => {
          const req = mod.request({
            hostname: url.hostname, port: url.port || 443,
            path: url.pathname, method: 'POST', timeout: 10000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.ok && result.token) {
                  cfg.token = result.token;
                  cfg.userId = result.userId;
                  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
                  _sendErrCount = 0;
                  console.log(`[self-healer] re-registered: userId=${result.userId}`);
                }
              } catch {}
              resolve();
            });
          });
          req.on('error', resolve);
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.write(payload);
          req.end();
        });
      } catch {}
    }

    if (repaired) {
      _reportIssue('config_repaired', { cause: 'config auto-repaired' });
    }
  } catch (e) {
    _reportIssue('config_corrupt', { cause: `config parse failed: ${e.message}` });
    // Emergency: write minimal config
    try {
      const minimal = { serverUrl: 'https://mindmap-viewer-production-adb2.up.railway.app', hostname: os.hostname() };
      fs.writeFileSync(cfgPath, JSON.stringify(minimal, null, 2), 'utf8');
      console.log('[self-healer] emergency config written');
    } catch {}
  }

  // C-5: git remote URL check
  try {
    const { execSync } = require('child_process');
    const ROOT = path.resolve(__dirname, '..');
    const CANONICAL_REPO = 'https://github.com/Jayinsightfactory/mindmap-viewer.git';
    const currentUrl = execSync('git remote get-url origin', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim();
    if (currentUrl !== CANONICAL_REPO) {
      execSync(`git remote set-url origin "${CANONICAL_REPO}"`, { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' });
      console.log('[self-healer] git remote URL repaired');
    }
  } catch {}

  // C-6: disk space check (< 500MB free = warning)
  if (os.platform() === 'win32') {
    try {
      const out = _exec('powershell -WindowStyle Hidden -Command "(Get-PSDrive C).Free"', 5000);
      const freeBytes = parseInt(out, 10);
      if (freeBytes && freeBytes < 500 * 1024 * 1024) {
        _reportIssue('disk_low', { freeMB: Math.round(freeBytes / 1024 / 1024), cause: 'disk space < 500MB' });
        // Auto cleanup: old captures + logs
        try {
          const captureDir = path.join(os.homedir(), '.orbit', 'captures');
          if (fs.existsSync(captureDir)) {
            const files = fs.readdirSync(captureDir).map(f => path.join(captureDir, f));
            files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
            // Delete oldest 50%
            const toDelete = files.slice(0, Math.floor(files.length / 2));
            toDelete.forEach(f => { try { fs.unlinkSync(f); } catch {} });
            if (toDelete.length) console.log(`[self-healer] disk cleanup: ${toDelete.length} captures deleted`);
          }
        } catch {}
      }
    } catch {}
  }

  // C-7: daemon.log size check (truncate if > 20MB)
  try {
    const logPath = path.join(os.homedir(), '.orbit', 'daemon.log');
    const stat = fs.statSync(logPath);
    if (stat.size > 20 * 1024 * 1024) {
      const oldPath = logPath + '.old';
      try { fs.unlinkSync(oldPath); } catch {}
      try { fs.renameSync(logPath, oldPath); } catch {}
      console.log(`[self-healer] daemon.log rotated (${Math.round(stat.size/1024/1024)}MB)`);
    }
  } catch {}
}

// -- Start / Stop
function start() {
  if (_healTimer) return;

  // First check after 2min (avoid startup noise)
  setTimeout(() => {
    _runHeal().catch(() => {});
    _checkPerfIssues().catch(() => {});
    _checkConfigHealth().catch(() => {});

    _healTimer = setInterval(() => {
      _runHeal().catch(e => console.warn('[self-healer] heal error:', e.message));
    }, HEAL_INTERVAL_MS);

    _perfTimer = setInterval(() => {
      _checkPerfIssues().catch(e => console.warn('[self-healer] perf error:', e.message));
    }, PERF_INTERVAL_MS);

    // Config health check every 10min
    setInterval(() => {
      _checkConfigHealth().catch(() => {});
    }, 10 * 60 * 1000);
  }, 2 * 60 * 1000);

  console.log('[self-healer] started (heal 5m / perf 3m / config 10m)');
}

function stop() {
  if (_healTimer) { clearInterval(_healTimer); _healTimer = null; }
  if (_perfTimer) { clearInterval(_perfTimer); _perfTimer = null; }
}

module.exports = {
  init, start, stop,
  recordEvent, recordSendError,
  recordCaptureError, recordCaptureSuccess,
};
