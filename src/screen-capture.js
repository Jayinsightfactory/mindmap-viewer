'use strict';

/**
 * screen-capture.js
 * ---------------------------------------------------------------------------
 * 이벤트 기반 스크린 캡처 — 의미 있는 시점에만 캡처
 *
 * 트리거:
 *  1. 앱/윈도우 전환 시 (activeApp 변경 감지)
 *  2. 키보드 idle 30초 후 (작업 결과물 화면)
 *  3. tool.end 이벤트 (Claude Code 도구 실행 완료)
 *  4. file.write 이벤트 (파일 저장)
 *  5. 최소 2분 간격 제한 (과도한 캡처 방지)
 *
 * macOS: screencapture / Linux: scrot / Windows: PowerShell
 * 저장: ~/.orbit/captures/ (최근 100개 유지)
 * ---------------------------------------------------------------------------
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const CAPTURE_DIR   = path.join(os.homedir(), '.orbit', 'captures');
const MAX_CAPTURES  = 100;
const MIN_INTERVAL  = 2 * 60 * 1000;  // 최소 2분 간격
const IDLE_TRIGGER  = 30 * 1000;       // 30초 idle 후 캡처

let _lastCaptureTime = 0;
let _lastActiveApp   = '';
let _idleTimer       = null;
let _running         = false;

function ensureDir() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

/**
 * 스크린샷 촬영 → 파일 경로 반환 (null = 실패)
 * @param {string} trigger — 캡처 이유 (app_switch, idle, tool_end, file_write, manual)
 */
function capture(trigger = 'manual') {
  // 최소 간격 체크
  const now = Date.now();
  if (now - _lastCaptureTime < MIN_INTERVAL) return null;

  ensureDir();
  const filename = `screen-${now}-${trigger}.png`;
  const filepath = path.join(CAPTURE_DIR, filename);

  try {
    if (process.platform === 'darwin') {
      execSync(`screencapture -x -t png "${filepath}"`, { timeout: 5000 });
    } else if (process.platform === 'linux') {
      try { execSync(`scrot "${filepath}"`, { timeout: 5000 }); }
      catch { execSync(`gnome-screenshot -f "${filepath}"`, { timeout: 5000 }); }
    } else if (process.platform === 'win32') {
      const escaped = filepath.replace(/\\/g, '\\\\');
      execSync(
        `powershell -NoProfile -c "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${escaped}') }"`,
        { timeout: 10000 }
      );
    } else {
      return null;
    }

    if (!fs.existsSync(filepath)) return null;

    _lastCaptureTime = now;
    console.log(`[screen-capture] ${trigger}: ${filename}`);

    // 오래된 캡처 정리 (최근 100개만 유지)
    try {
      const files = fs.readdirSync(CAPTURE_DIR)
        .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
        .sort().reverse();
      files.slice(MAX_CAPTURES).forEach(f => {
        try { fs.unlinkSync(path.join(CAPTURE_DIR, f)); } catch {}
      });
    } catch {}

    return filepath;
  } catch (e) {
    console.warn('[screen-capture] 캡처 실패:', e.message);
    return null;
  }
}

// ── 트리거 1: 앱/윈도우 전환 감지 ─────────────────────────────────
function onAppChange(appName) {
  if (!_running) return;
  if (appName && appName !== _lastActiveApp) {
    _lastActiveApp = appName;
    capture('app_switch');
  }
}

// ── 트리거 2: 키보드 idle 감지 ────────────────────────────────────
function onKeyActivity() {
  if (!_running) return;
  // idle 타이머 리셋
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    capture('idle');
  }, IDLE_TRIGGER);
}

// ── 트리거 3: Claude 도구 실행 완료 ───────────────────────────────
function onToolEnd() {
  if (!_running) return;
  capture('tool_end');
}

// ── 트리거 4: 파일 저장 ──────────────────────────────────────────
function onFileWrite() {
  if (!_running) return;
  capture('file_write');
}

function start() {
  if (_running) return;
  _running = true;
  _lastCaptureTime = 0;
  console.log(`[screen-capture] 이벤트 기반 캡처 시작 (저장: ${CAPTURE_DIR})`);
  capture('startup'); // 시작 시 1회
}

function stop() {
  _running = false;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  console.log('[screen-capture] 종료');
}

function getRecentCaptures(count = 10) {
  ensureDir();
  try {
    return fs.readdirSync(CAPTURE_DIR)
      .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
      .sort().reverse().slice(0, count)
      .map(f => path.join(CAPTURE_DIR, f));
  } catch { return []; }
}

module.exports = {
  start, stop, capture, getRecentCaptures,
  onAppChange, onKeyActivity, onToolEnd, onFileWrite,
  CAPTURE_DIR,
};
