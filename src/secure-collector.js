'use strict';
/**
 * secure-collector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 은행 보안 프로그램 실행 중에도 일반 업무 수집
 *
 * 핵심 원리:
 *   은행 보안(TouchEn nxKey, AhnLab Safe Transaction)은
 *   SetWindowsHookEx(전역 훅)를 차단하지만,
 *   P/Invoke 직접 호출 / WMI 쿼리 / GDI 캡처(비銀行 창)는 차단하지 않는다.
 *
 * 수집 항목 (일반 업무 창만, 은행 브라우저 창 자동 제외):
 *   1. 화면 캡처       — GDI CopyFromScreen (P/Invoke, 후킹 아님)
 *   2. 마우스 위치/클릭 — GetCursorPos + GetAsyncKeyState (P/Invoke, 폴링)
 *   3. 키보드 활동량   — GetLastInputInfo 변화 감지 (내용 아닌 활동 여부)
 *   4. 활성 창/앱      — GetForegroundWindow + GetWindowText (P/Invoke)
 *   5. 앱 사용 시간    — 포커스 지속시간 누적
 *   6. 프로세스 증감   — Get-Process diff
 *   7. 파일 변경       — fs.watch (ReadDirectoryChangesW)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os    = require('os');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ── 설정 ────────────────────────────────────────────────────────────────────
const _cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); }
  catch { return {}; }
})();
const _url   = _cfg.serverUrl || process.env.ORBIT_SERVER_URL || null;
const _token = _cfg.token     || process.env.ORBIT_TOKEN      || '';

const MOUSE_POLL_MS   = 1000;          // 마우스 1초 폴링
const CAPTURE_MS      = 2 * 60 * 1000; // 2분마다 화면 캡처 (일반 모드와 동일)
const APP_POLL_MS     = 30 * 1000;     // 30초 앱 포커스 추적
const SEND_MS         = 5 * 60 * 1000; // 5분 배치 전송
const PS_OPTS         = { timeout: 6000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' };
const CAPTURE_DIR     = path.join(os.homedir(), '.orbit', 'captures');

// 은행 창 판단 키워드 — 이 창이 활성화되면 캡처 스킵 (프라이버시)
const BANK_TITLE_PATTERNS = [
  /인터넷뱅킹|인터넷 뱅킹|기업뱅킹|스마트뱅킹/,
  /계좌이체|이체확인|OTP|보안카드|공인인증|공동인증/,
  /kbstar|shinhan.*bank|wooribank|hanabank|ibk\.co\.kr/i,
  /nonghyup.*bank|부산은행|대구은행|광주은행|전북은행/i,
];

function _isBankWindow(title = '') {
  return BANK_TITLE_PATTERNS.some(re => re.test(title));
}

// ── 상태 ────────────────────────────────────────────────────────────────────
let _running        = false;
let _mouseTimer     = null;
let _captureTimer   = null;
let _appTimer       = null;
let _sendTimer      = null;
let _ps1Path        = null;

// 누적 데이터 버퍼
let _appHistory     = [];   // { app, title, start, durationSec }
let _mouseClicks    = [];   // { x, y, app, title, ts }
let _mouseTrail     = [];   // { x, y, ts } 최근 1분 궤적
let _fileEvents     = [];   // { dir, file, action, ts }
let _prevProcs      = new Set();
let _procChanges    = [];   // { started:[], stopped:[], ts }

// 현재 포커스 앱 추적
let _currentApp     = '';
let _currentTitle   = '';
let _focusStart     = Date.now();

// 키보드 활동 추적 (내용 아님, 활동 여부)
let _lastIdleMs     = 0;
let _keyActivity    = [];   // { ts, active: bool }

// 파일 감시 핸들
let _fileWatchers   = [];

// ══════════════════════════════════════════════════════════════════════════════
// PowerShell P/Invoke 스크립트 (1개 파일로 재사용 — 매 호출 JIT 비용 절감)
// ══════════════════════════════════════════════════════════════════════════════

const _PS1_CONTENT = `
param([string]$Action = 'status')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class OrbitCapture {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint IdleMs() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    GetLastInputInfo(ref li);
    return (uint)Environment.TickCount - li.dwTime;
  }
  public static string CaptureScreen(string outPath) {
    try {
      var screen = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
      using(var bmp = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppArgb))
      using(var g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(screen.Location, Point.Empty, screen.Size);
        bmp.Save(outPath, ImageFormat.Png);
        return "ok:" + screen.Width + "x" + screen.Height;
      }
    } catch(Exception ex) { return "err:" + ex.Message; }
  }
}
"@ -ReferencedAssemblies "System.Drawing","System.Windows.Forms" -EA SilentlyContinue

if ($Action -eq 'capture') {
  $outPath = $args[1]
  Write-Output ([OrbitCapture]::CaptureScreen($outPath))
} else {
  # status: 현재 창 + 마우스 + 유휴시간
  $hw = [OrbitCapture]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][OrbitCapture]::GetWindowText($hw, $sb, 512)
  $title = $sb.ToString()
  $pid = [uint32]0
  [void][OrbitCapture]::GetWindowThreadProcessId($hw, [ref]$pid)
  $proc = if($pid -gt 0){try{(Get-Process -Id $pid -EA Stop).ProcessName}catch{''}}else{''}
  $cp = New-Object OrbitCapture+POINT
  [void][OrbitCapture]::GetCursorPos([ref]$cp)
  $lmb = ([OrbitCapture]::GetAsyncKeyState(1) -band 0x8000) -ne 0
  $rmb = ([OrbitCapture]::GetAsyncKeyState(2) -band 0x8000) -ne 0
  $idle = [OrbitCapture]::IdleMs()
  [PSCustomObject]@{
    title=$title; proc=$proc; pid=$pid
    mouseX=$cp.X; mouseY=$cp.Y; lmb=$lmb; rmb=$rmb; idleMs=$idle
  } | ConvertTo-Json -Compress
}
`.trim();

function _ensurePs1() {
  if (_ps1Path && fs.existsSync(_ps1Path)) return _ps1Path;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  _ps1Path = path.join(CAPTURE_DIR, `orbit-sc-${process.pid}.ps1`);
  fs.writeFileSync(_ps1Path, _PS1_CONTENT, 'utf8');
  return _ps1Path;
}

// ══════════════════════════════════════════════════════════════════════════════
// [1] 상태 조회 (활성 창 + 마우스 위치 + 클릭 + 유휴시간)
// ══════════════════════════════════════════════════════════════════════════════

function _getStatus() {
  try {
    const ps1 = _ensurePs1();
    const raw = execSync(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1}" status`,
      PS_OPTS
    ).trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    // 폴백: WMI만
    try {
      const raw = execSync(
        `powershell -NoProfile -WindowStyle Hidden -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p=Get-Process | Where-Object{$_.MainWindowTitle -ne ''} | Sort-Object CPU -Desc | Select-Object -First 1; if($p){($p|Select-Object ProcessName,MainWindowTitle|ConvertTo-Json -Compress)}else{'null'}"`,
        PS_OPTS
      ).trim();
      if (raw && raw !== 'null') {
        const p = JSON.parse(raw);
        return { proc: p.ProcessName, title: p.MainWindowTitle, mouseX: 0, mouseY: 0, lmb: false, idleMs: 0 };
      }
    } catch {}
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// [2] 화면 캡처 — GDI CopyFromScreen (은행 창 제외)
// ══════════════════════════════════════════════════════════════════════════════

function _captureScreen(status) {
  try {
    // 은행 창이 활성화되어 있으면 캡처 안 함
    if (status && _isBankWindow(status.title || '')) {
      console.log('[secure-collector] 은행 창 감지 — 캡처 스킵');
      return null;
    }

    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    const ts       = Date.now();
    const capPath  = path.join(CAPTURE_DIR, `sc-${ts}.png`);
    const ps1      = _ensurePs1();

    const result = execSync(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1}" capture "${capPath}"`,
      { ...PS_OPTS, timeout: 10000 }
    ).trim();

    if (!result.startsWith('ok:') || !fs.existsSync(capPath)) return null;

    // base64 인코딩 후 서버 전송
    const imgBuf  = fs.readFileSync(capPath);
    const base64  = imgBuf.toString('base64');
    const size    = result.replace('ok:', '');

    // 캡처 파일은 최대 50개 유지
    _cleanOldCaptures();

    return { capPath, base64, size, ts, app: status?.proc || '', title: status?.title || '' };
  } catch (err) {
    console.warn('[secure-collector] 캡처 실패:', err.message);
    return null;
  }
}

function _cleanOldCaptures() {
  try {
    const files = fs.readdirSync(CAPTURE_DIR)
      .filter(f => f.startsWith('sc-') && f.endsWith('.png'))
      .map(f => ({ name: f, ts: parseInt(f.replace('sc-','').replace('.png','')) || 0 }))
      .sort((a, b) => b.ts - a.ts);
    for (const f of files.slice(50)) {
      try { fs.unlinkSync(path.join(CAPTURE_DIR, f.name)); } catch {}
    }
  } catch {}
}

function _sendCapture(capture) {
  if (!_url || !capture) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id:        'sc-cap-' + capture.ts,
        type:      'screen.capture',
        source:    'secure-collector',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date(capture.ts).toISOString(),
        data: {
          hostname:    os.hostname(),
          app:         capture.app,
          windowTitle: capture.title,
          resolution:  capture.size,
          trigger:     'secure-mode-timer',
          imageBase64: capture.base64,
          bankMode:    true,
        },
      }],
    });

    // 2MB 초과 시 스킵 (Railway 메모리 보호)
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) return;

    _post('/api/hook', payload);
    console.log(`[secure-collector] 화면 캡처 전송: ${capture.app} / ${capture.size}`);
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// [3] 마우스 1초 폴링 — 위치 + 클릭 감지
// ══════════════════════════════════════════════════════════════════════════════

let _prevLmb = false;

function _pollMouse() {
  try {
    const s = _getStatus();
    if (!s) return;

    const now = Date.now();

    // 마우스 궤적 (은행 창이면 좌표 저장 안 함)
    if (!_isBankWindow(s.title || '')) {
      _mouseTrail.push({ x: s.mouseX, y: s.mouseY, ts: now });
      if (_mouseTrail.length > 60) _mouseTrail.shift(); // 1분치 유지
    }

    // 클릭 감지 (버튼 누름 → 이전 상태와 비교)
    if (s.lmb && !_prevLmb && !_isBankWindow(s.title || '')) {
      _mouseClicks.push({
        x: s.mouseX, y: s.mouseY,
        app: s.proc || '', title: s.title || '',
        ts: now,
      });
      if (_mouseClicks.length > 300) _mouseClicks.shift();
    }
    _prevLmb = !!s.lmb;

    // 키보드 활동 감지 (유휴시간 감소 = 입력 중)
    const wasIdle = _lastIdleMs > 3000;
    const isIdle  = (s.idleMs || 0) > 3000;
    if (wasIdle && !isIdle) {
      // 입력 재개
      _keyActivity.push({ ts: now, active: true });
    } else if (!wasIdle && isIdle) {
      // 입력 멈춤
      _keyActivity.push({ ts: now, active: false });
    }
    _lastIdleMs = s.idleMs || 0;
    if (_keyActivity.length > 200) _keyActivity.shift();

  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// [4] 30초 앱 포커스 추적
// ══════════════════════════════════════════════════════════════════════════════

function _pollApp() {
  try {
    const s = _getStatus();
    if (!s || !s.proc) return;

    const now      = Date.now();
    const appChg   = s.proc !== _currentApp || s.title !== _currentTitle;

    if (appChg) {
      if (_currentApp) {
        const sec = Math.round((now - _focusStart) / 1000);
        if (sec >= 5) {
          _appHistory.push({ app: _currentApp, title: _currentTitle, start: new Date(_focusStart).toISOString(), durationSec: sec });
          if (_appHistory.length > 100) _appHistory.shift();
        }
      }
      _currentApp   = s.proc;
      _currentTitle = s.title;
      _focusStart   = now;
      console.log(`[secure-collector] 앱 전환: ${s.proc} — ${(s.title || '').slice(0, 40)}`);
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// [5] 프로세스 증감 감지
// ══════════════════════════════════════════════════════════════════════════════

function _pollProcs() {
  try {
    const raw = execSync(
      `powershell -NoProfile -WindowStyle Hidden -Command "Get-Process | Select-Object -ExpandProperty Name -Unique | ConvertTo-Json -Compress"`,
      PS_OPTS
    ).trim();
    if (!raw) return;
    const arr  = JSON.parse(raw);
    const curr = new Set(Array.isArray(arr) ? arr : [arr]);
    const started = [...curr].filter(n => !_prevProcs.has(n));
    const stopped = [..._prevProcs].filter(n => !curr.has(n));
    if (started.length || stopped.length) {
      _procChanges.push({ started, stopped, ts: Date.now() });
      if (_procChanges.length > 50) _procChanges.shift();
    }
    _prevProcs = curr;
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// [6] 파일 변경 감시 (fs.watch)
// ══════════════════════════════════════════════════════════════════════════════

const WATCH_DIRS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  ...['OneDrive', 'OneDrive - 회사'].map(d => path.join(os.homedir(), d)).filter(d => { try { return fs.existsSync(d); } catch { return false; } }),
];
const IGNORE = [/^~\$/, /^\./, /\.tmp$/i, /\.crdownload$/i, /Thumbs\.db$/i, /desktop\.ini$/i];

function _startFileWatchers() {
  _stopFileWatchers();
  for (const dir of WATCH_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const w = fs.watch(dir, { recursive: false }, (evt, fn) => {
        if (!fn || IGNORE.some(r => r.test(fn))) return;
        _fileEvents.push({ dir: path.basename(dir), file: fn, action: evt === 'rename' ? 'created/deleted' : 'modified', ts: Date.now() });
        if (_fileEvents.length > 200) _fileEvents.splice(0, _fileEvents.length - 200);
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
// 배치 전송 — 5분 누적 데이터를 서버로
// ══════════════════════════════════════════════════════════════════════════════

function _sendBatch() {
  if (!_url) return;
  try {
    const appHistory  = _appHistory.splice(0);
    const clicks      = _mouseClicks.splice(0);
    const fileEvts    = _fileEvents.splice(0);
    const procChgs    = _procChanges.splice(0);
    const keyAct      = _keyActivity.splice(0);
    const trail       = _mouseTrail.splice(0);

    if (!appHistory.length && !clicks.length && !fileEvts.length) return;

    // 앱별 사용 시간 집계
    const appSec = {};
    for (const e of appHistory) appSec[e.app] = (appSec[e.app] || 0) + e.durationSec;
    const topApps = Object.entries(appSec).sort((a,b) => b[1]-a[1]).slice(0,10).map(([app,sec]) => ({app,sec}));

    // 마우스 클릭 앱별 집계
    const clicksByApp = {};
    for (const c of clicks) clicksByApp[c.app] = (clicksByApp[c.app] || 0) + 1;

    // 키보드 활동 비율 (5분 중 몇 초 활성)
    const activeEvents = keyAct.filter(k => k.active);
    const keyActiveSec = activeEvents.length * (MOUSE_POLL_MS / 1000);

    // 마우스 이동 범위 (작업 영역 파악)
    const xs = trail.map(p => p.x);
    const ys = trail.map(p => p.y);
    const mouseRange = xs.length ? {
      xMin: Math.min(...xs), xMax: Math.max(...xs),
      yMin: Math.min(...ys), yMax: Math.max(...ys),
    } : null;

    const payload = JSON.stringify({
      events: [{
        id:        'sc-batch-' + Date.now(),
        type:      'secure.activity',
        source:    'secure-collector',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          hostname:    os.hostname(),
          mode:        'bank-security-safe',

          // 활성 앱 현황
          activeApp:   _currentApp,
          activeTitle: _currentTitle,
          idleSec:     Math.round(_lastIdleMs / 1000),

          // 앱 사용 시간 (5분간)
          topApps,
          appHistory:  appHistory.slice(-20),

          // 마우스 클릭
          clickCount:  clicks.length,
          clicksByApp,
          mouseRange,             // 화면 어느 영역에서 작업했는지
          recentClicks: clicks.slice(-20).map(c => ({
            x: c.x, y: c.y, app: c.app,
            title: (c.title || '').slice(0,50),
            ts: new Date(c.ts).toISOString(),
          })),

          // 키보드 활동 (내용 아님, 활동 여부)
          keyActiveSec,           // 몇 초 동안 입력 활동 있었는지

          // 파일 변경
          fileChanges: fileEvts.slice(-30).map(e => ({
            dir: e.dir, file: e.file, action: e.action,
            ts: new Date(e.ts).toISOString(),
          })),

          // 프로세스 변화
          procChanges: procChgs.slice(-10),
        },
      }],
    });

    _post('/api/hook', payload);
    console.log(`[secure-collector] 배치 전송 — 앱이력:${appHistory.length} 클릭:${clicks.length} 파일:${fileEvts.length}`);
  } catch (err) {
    console.warn('[secure-collector] 배치 전송 오류:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP 전송 헬퍼
// ══════════════════════════════════════════════════════════════════════════════

function _post(apiPath, payload) {
  if (!_url) return;
  try {
    const u   = new URL(apiPath, _url);
    const mod = u.protocol === 'https:' ? https : http;
    const h   = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (_token) h['Authorization'] = 'Bearer ' + _token;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST', headers: h, timeout: 15000 }, r => r.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// 공개 API
// ══════════════════════════════════════════════════════════════════════════════

function start(opts = {}) {
  if (_running) return;
  if (process.platform !== 'win32') { console.log('[secure-collector] Windows 전용'); return; }
  _running = true;

  console.log('[secure-collector] 시작 (은행 보안 우회 수집기)');
  console.log(`[secure-collector] 화면캡처: ${CAPTURE_MS/1000}초 / 마우스: ${MOUSE_POLL_MS/1000}초 / 전송: ${SEND_MS/1000}초`);

  // PS1 파일 미리 생성 (첫 JIT 컴파일 준비)
  try { _ensurePs1(); } catch {}

  // 파일 감시 시작
  _startFileWatchers();

  // 초기 프로세스 목록
  try {
    const raw = execSync(`powershell -NoProfile -WindowStyle Hidden -Command "Get-Process | Select-Object -ExpandProperty Name -Unique | ConvertTo-Json -Compress"`, PS_OPTS).trim();
    _prevProcs = new Set(JSON.parse(raw || '[]'));
  } catch {}

  // ① 마우스 + 유휴시간 1초 폴링
  _pollMouse();
  _mouseTimer = setInterval(_pollMouse, MOUSE_POLL_MS);

  // ② 앱 포커스 30초 폴링 (마우스 폴링과 분리 — 별도 PS1 호출 최소화)
  _pollApp();
  _appTimer = setInterval(() => { _pollApp(); _pollProcs(); }, APP_POLL_MS);

  // ③ 화면 캡처 2분마다
  _captureTimer = setInterval(() => {
    const s = _getStatus();
    const cap = _captureScreen(s);
    if (cap) _sendCapture(cap);
  }, CAPTURE_MS);

  // ④ 배치 전송 5분마다
  _sendTimer = setInterval(_sendBatch, SEND_MS);
}

function stop() {
  if (!_running) return;
  try { _sendBatch(); } catch {}
  if (_mouseTimer)   { clearInterval(_mouseTimer);   _mouseTimer   = null; }
  if (_captureTimer) { clearInterval(_captureTimer); _captureTimer = null; }
  if (_appTimer)     { clearInterval(_appTimer);     _appTimer     = null; }
  if (_sendTimer)    { clearInterval(_sendTimer);    _sendTimer    = null; }
  _stopFileWatchers();
  if (_ps1Path) { try { fs.unlinkSync(_ps1Path); } catch {} _ps1Path = null; }
  _running = false;
  console.log('[secure-collector] 중지됨');
}

function getStatus() {
  return { running: _running, currentApp: _currentApp, currentTitle: _currentTitle,
    appHistoryCount: _appHistory.length, clickCount: _mouseClicks.length,
    fileEventCount: _fileEvents.length, idleSec: Math.round(_lastIdleMs / 1000) };
}

module.exports = { start, stop, getStatus };
