'use strict';
/**
 * secure-collector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 어떤 보안 프로그램(은행 보안, 백신, DRM)도 막지 못하는 작업 추적 수집기
 *
 * 원리:
 *   은행 보안프로그램은 "전역 후킹(SetWindowsHookEx)"을 차단하지만
 *   "직접 Win32 API 호출(P/Invoke)"과 "WMI 쿼리"는 차단하지 않는다.
 *
 * 수집 항목:
 *   1. 활성 창 제목 + 앱명      — GetForegroundWindow (P/Invoke, 후킹 아님)
 *   2. 유휴 시간                — GetLastInputInfo   (P/Invoke, 후킹 아님)
 *   3. 앱 사용 시간 누적         — 30초 폴링으로 포커스 지속시간 계산
 *   4. 프로세스 증감 감지        — Get-Process diff (신규 실행/종료 앱)
 *   5. 파일 변경 감지            — ReadDirectoryChangesW (fs.watch, 후킹 아님)
 *   6. 네트워크 접속 앱          — Get-NetTCPConnection WMI 쿼리
 *   7. 최근 파일                 — Shell Recent 폴더 스캔
 *
 * 수집하지 않는 항목 (프라이버시):
 *   - 키 입력 원문
 *   - 클립보드 내용
 *   - 화면 캡처
 *   - 브라우저 URL 전체
 *
 * 폴링: 30초 (bank-safe-collector의 5분보다 세밀)
 * 서버 전송: 5분마다 누적 배치 전송 (네트워크 절약)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os    = require('os');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');

// ── 원격 서버 설정 ─────────────────────────────────────────────────────────
const _cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); }
  catch { return {}; }
})();
const _url   = _cfg.serverUrl || process.env.ORBIT_SERVER_URL || null;
const _token = _cfg.token     || process.env.ORBIT_TOKEN      || '';

// ── 수집 설정 ──────────────────────────────────────────────────────────────
const POLL_MS         = 30 * 1000;          // 30초 폴링 (앱 포커스 추적)
const SEND_MS         = 5 * 60 * 1000;      // 5분마다 서버 전송
const PS_TIMEOUT      = 6000;               // PowerShell 타임아웃
const MAX_FILE_EVENTS = 200;                // 파일 변경 버퍼 최대
const MAX_APP_HISTORY = 100;               // 앱 사용 이력 최대

// ── 상태 ───────────────────────────────────────────────────────────────────
let _running       = false;
let _pollTimer     = null;
let _sendTimer     = null;
let _prevProcesses = new Set();             // 직전 폴링 프로세스명 Set
let _fileEvents    = [];                    // 파일 변경 이벤트 버퍼
let _fileWatchers  = [];                    // fs.watch 핸들
let _appHistory    = [];                    // 앱 포커스 이력
let _currentApp    = null;                  // 현재 포커스 앱명
let _currentTitle  = '';                    // 현재 창 제목
let _focusStart    = Date.now();            // 현재 앱 포커스 시작 시각

// ── PowerShell 공통 옵션 ───────────────────────────────────────────────────
const PS_OPTS = { timeout: PS_TIMEOUT, encoding: 'utf8', windowsHide: true, stdio: 'pipe' };
const PS      = 'powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command';

// ══════════════════════════════════════════════════════════════════════════════
// [1] 활성 창 감지 — P/Invoke GetForegroundWindow + GetWindowText
//     SetWindowsHookEx(전역 훅)가 아니므로 은행 보안에 차단되지 않음
// ══════════════════════════════════════════════════════════════════════════════

// 인라인 C# 코드를 PS 변수로 유지 (매 호출 시 Add-Type 비용 절감을 위해 캐싱 스크립트 활용)
const _PINVOKE_SCRIPT = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OrbitWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint GetIdleMs() {
    var li = new LASTINPUTINFO(); li.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(li);
    GetLastInputInfo(ref li); return (uint)Environment.TickCount - li.dwTime;
  }
}
"@ -ErrorAction SilentlyContinue
$hWnd = [OrbitWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][OrbitWin32]::GetWindowText($hWnd, $sb, 512)
$title = $sb.ToString()
$pid = 0
[void][OrbitWin32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
$proc = if ($pid -gt 0) { try { (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { '' } } else { '' }
$idleMs = [OrbitWin32]::GetIdleMs()
[PSCustomObject]@{ title=$title; proc=$proc; pid=$pid; idleMs=$idleMs } | ConvertTo-Json -Compress
`.trim();

let _ps1TmpPath = null;  // 임시 .ps1 파일 경로 (재사용)

function _ensurePs1() {
  if (_ps1TmpPath && fs.existsSync(_ps1TmpPath)) return _ps1TmpPath;
  _ps1TmpPath = path.join(os.tmpdir(), `orbit-wincap-${process.pid}.ps1`);
  fs.writeFileSync(_ps1TmpPath, _PINVOKE_SCRIPT, 'utf8');
  return _ps1TmpPath;
}

function _getActiveWindow() {
  try {
    const ps1 = _ensurePs1();
    const raw = execSync(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1}"`,
      PS_OPTS
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      title:  (parsed.title  || '').trim(),
      proc:   (parsed.proc   || '').trim(),
      pid:    parsed.pid    || 0,
      idleMs: parsed.idleMs || 0,
    };
  } catch {
    // 폴백: WMI Get-Process 방식 (Add-Type 없이)
    try {
      const raw = execSync(
        `${PS} "(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object CPU -Desc | Select-Object -First 1 | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress)"`,
        PS_OPTS
      ).trim();
      if (!raw) return null;
      const p = JSON.parse(raw);
      return { title: p.MainWindowTitle || '', proc: p.ProcessName || '', pid: 0, idleMs: 0 };
    } catch { return null; }
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// [2] 프로세스 증감 감지 — Get-Process diff
//     은행 보안이 차단 못 함 (WMI 쿼리, 훅 아님)
// ══════════════════════════════════════════════════════════════════════════════

function _getProcessNames() {
  try {
    const raw = execSync(
      `${PS} "Get-Process | Select-Object -ExpandProperty Name -Unique | ConvertTo-Json -Compress"`,
      PS_OPTS
    ).trim();
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : [arr]);
  } catch { return new Set(); }
}

function _diffProcesses(prev, curr) {
  const started = [...curr].filter(n => !prev.has(n));
  const stopped = [...prev].filter(n => !curr.has(n));
  return { started, stopped };
}


// ══════════════════════════════════════════════════════════════════════════════
// [3] 파일 변경 감지 — fs.watch (ReadDirectoryChangesW)
//     커널 파일 시스템 알림 → 후킹 아님, 보안 프로그램에 차단 안 됨
// ══════════════════════════════════════════════════════════════════════════════

const WATCH_DIRS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  // OneDrive 공용 경로 자동 감지
  ...['OneDrive', 'OneDrive - 회사', 'OneDrive - Personal'].map(d =>
    path.join(os.homedir(), d)
  ).filter(d => { try { return fs.existsSync(d); } catch { return false; } }),
];

// 무시 패턴 (임시파일, 시스템파일, 썸네일)
const IGNORE_PATTERNS = [
  /^~/,               // 임시 Word/Excel 파일 (~~$...)
  /^\..*$/,           // 숨김파일
  /\.tmp$/i,
  /\.crdownload$/i,
  /\.part$/i,
  /Thumbs\.db$/i,
  /desktop\.ini$/i,
];

function _shouldIgnore(filename) {
  return IGNORE_PATTERNS.some(re => re.test(filename));
}

function _startFileWatchers() {
  _stopFileWatchers();
  for (const dir of WATCH_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const w = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename || _shouldIgnore(filename)) return;
        _fileEvents.push({
          dir:    path.basename(dir),
          file:   filename,
          action: eventType === 'rename' ? 'created/deleted' : 'modified',
          ts:     Date.now(),
        });
        if (_fileEvents.length > MAX_FILE_EVENTS) _fileEvents.splice(0, _fileEvents.length - MAX_FILE_EVENTS);
      });
      _fileWatchers.push(w);
    } catch {}
  }
}

function _stopFileWatchers() {
  for (const w of _fileWatchers) { try { w.close(); } catch {} }
  _fileWatchers = [];
}


// ══════════════════════════════════════════════════════════════════════════════
// [4] 네트워크 접속 앱 — Get-NetTCPConnection (WMI, 훅 아님)
// ══════════════════════════════════════════════════════════════════════════════

function _getNetworkApps() {
  try {
    const raw = execSync(
      `${PS} "Get-NetTCPConnection -State Established -EA SilentlyContinue | ForEach-Object { try{(Get-Process -Id $_.OwningProcess -EA Stop).ProcessName}catch{} } | Sort-Object -Unique | ConvertTo-Json -Compress"`,
      PS_OPTS
    ).trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) ? arr : [arr]).filter(Boolean).slice(0, 20);
  } catch { return []; }
}


// ══════════════════════════════════════════════════════════════════════════════
// [5] 최근 파일 — Shell Recent 폴더 (WMI, 훅 아님)
// ══════════════════════════════════════════════════════════════════════════════

function _getRecentFiles() {
  try {
    const raw = execSync(
      `${PS} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-ChildItem '$env:APPDATA\\Microsoft\\Windows\\Recent' -EA SilentlyContinue | Sort-Object LastWriteTime -Desc | Select-Object Name,@{n='t';e={$_.LastWriteTime.ToString('o')}} -First 15 | ConvertTo-Json -Compress"`,
      PS_OPTS
    ).trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) ? arr : [arr]).map(f => ({
      name: (f.Name || '').replace(/\.lnk$/i, ''),
      time: f.t || '',
    })).filter(f => f.name);
  } catch { return []; }
}


// ══════════════════════════════════════════════════════════════════════════════
// 30초 폴링 — 활성 창 + 프로세스 diff
// ══════════════════════════════════════════════════════════════════════════════

function _poll() {
  try {
    const win = _getActiveWindow();
    const ts  = Date.now();

    // ── 앱 포커스 추적 ──
    if (win && win.proc) {
      const appChanged = win.proc !== _currentApp || win.title !== _currentTitle;
      if (appChanged) {
        // 이전 앱 사용 시간 기록
        if (_currentApp) {
          const durationSec = Math.round((ts - _focusStart) / 1000);
          if (durationSec >= 5) {  // 5초 미만 전환은 노이즈로 제외
            _appHistory.push({
              app:      _currentApp,
              title:    _currentTitle,
              start:    new Date(_focusStart).toISOString(),
              durationSec,
            });
            if (_appHistory.length > MAX_APP_HISTORY) _appHistory.shift();
          }
        }
        _currentApp   = win.proc;
        _currentTitle = win.title;
        _focusStart   = ts;
      }
    }

    // ── 프로세스 증감 감지 ──
    const currProcs = _getProcessNames();
    const diff      = _diffProcesses(_prevProcesses, currProcs);
    _prevProcesses  = currProcs;

    if (diff.started.length > 0 || diff.stopped.length > 0) {
      console.log(`[secure-collector] 프로세스 변경 — 시작: ${diff.started.join(',')} / 종료: ${diff.stopped.join(',')}`);
    }

    // 유휴 상태 로그
    if (win?.idleMs > 5 * 60 * 1000) {
      // 5분 이상 유휴 — 조용히 기록만 (서버 전송은 배치로)
    }

  } catch (err) {
    console.warn('[secure-collector] 폴링 오류:', err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 5분 배치 전송 — 누적 데이터를 서버로
// ══════════════════════════════════════════════════════════════════════════════

function _sendBatch() {
  if (!_url) return;

  try {
    // 1. 앱 사용 이력 스냅샷 (초기화)
    const appHistory  = _appHistory.splice(0);
    // 2. 파일 변경 스냅샷 (초기화)
    const fileEvents  = _fileEvents.splice(0);
    // 3. 현재 앱 상태
    const win         = _getActiveWindow();
    // 4. 네트워크 앱 (전송 시점 조회)
    const networkApps = _getNetworkApps();
    // 5. 최근 파일
    const recentFiles = _getRecentFiles();

    if (appHistory.length === 0 && fileEvents.length === 0 && !win?.proc) return;

    // 앱별 누적 시간 집계
    const appSummary = {};
    for (const entry of appHistory) {
      appSummary[entry.app] = (appSummary[entry.app] || 0) + entry.durationSec;
    }
    const topApps = Object.entries(appSummary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([app, sec]) => ({ app, sec }));

    const payload = JSON.stringify({
      events: [{
        id:        'sc-' + Date.now(),
        type:      'secure.activity',
        source:    'secure-collector',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          hostname:    os.hostname(),
          platform:    os.platform(),
          // 현재 포커스 앱
          activeApp:   win?.proc   || _currentApp || '',
          activeTitle: win?.title  || _currentTitle || '',
          idleSec:     win ? Math.round((win.idleMs || 0) / 1000) : 0,
          // 앱 사용 시간 집계 (5분간)
          topApps,
          // 앱 전환 이력 (최대 20건)
          appHistory:  appHistory.slice(-20),
          // 파일 변경 (최대 50건, 파일명만)
          fileChanges: fileEvents.slice(-50).map(e => ({
            dir: e.dir, file: e.file, action: e.action,
            ts: new Date(e.ts).toISOString(),
          })),
          // 네트워크 접속 앱
          networkApps,
          // 최근 파일 (쉘 Recent, 이름만)
          recentFiles: recentFiles.map(f => f.name).slice(0, 15),
        },
      }],
    });

    const parsedUrl = new URL('/api/hook', _url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;

    const req = mod.request({
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers,
      timeout:  15000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode < 300) {
          console.log(`[secure-collector] 전송 완료 — 앱이력: ${appHistory.length}건, 파일변경: ${fileEvents.length}건`);
        } else {
          console.warn(`[secure-collector] 서버 응답: ${res.statusCode}`);
        }
      });
    });
    req.on('error', e => console.warn('[secure-collector] 전송 오류:', e.message));
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();

  } catch (err) {
    console.warn('[secure-collector] 배치 전송 오류:', err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 공개 API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 수집 시작
 * @param {Object} [opts] - { pollMs, sendMs }
 */
function start(opts = {}) {
  if (_running) return;
  if (process.platform !== 'win32') {
    console.log('[secure-collector] Windows 전용 — 건너뜀');
    return;
  }

  _running     = true;
  const pollMs = opts.pollMs || POLL_MS;
  const sendMs = opts.sendMs || SEND_MS;

  console.log('[secure-collector] 시작 (후킹 없는 안전 수집기)');
  console.log(`[secure-collector] 폴링: ${pollMs/1000}초 / 전송: ${sendMs/1000}초`);
  console.log(`[secure-collector] 서버: ${_url || '(미설정)'}`);

  // 파일 감시 시작
  _startFileWatchers();

  // 초기 프로세스 목록 로드
  _prevProcesses = _getProcessNames();

  // 30초 폴링
  _poll();
  _pollTimer = setInterval(_poll, pollMs);

  // 5분 배치 전송
  _sendTimer = setInterval(_sendBatch, sendMs);
}

/**
 * 수집 중지
 */
function stop() {
  if (!_running) return;
  // 마지막 배치 전송
  try { _sendBatch(); } catch {}

  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_sendTimer) { clearInterval(_sendTimer); _sendTimer = null; }
  _stopFileWatchers();

  // 임시 PS1 파일 정리
  if (_ps1TmpPath) { try { fs.unlinkSync(_ps1TmpPath); } catch {} _ps1TmpPath = null; }

  _running = false;
  console.log('[secure-collector] 중지됨');
}

/**
 * 현재 상태 스냅샷
 */
function getStatus() {
  return {
    running:      _running,
    currentApp:   _currentApp,
    currentTitle: _currentTitle,
    appHistoryCount: _appHistory.length,
    fileEventCount:  _fileEvents.length,
    watchDirCount:   _fileWatchers.length,
  };
}

module.exports = { start, stop, getStatus };
