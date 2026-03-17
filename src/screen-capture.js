'use strict';
/**
 * screen-capture.js — 지능형 스크린 캡처
 *
 * 키로거 데이터를 기반으로 캡처 타이밍을 동적 조절:
 * - 업무 작업 감지 → 짧은 간격 (2분) + Vision 분석
 * - 비업무/대기 → 긴 간격 (10분) + Vision 스킵
 * - 자동화 가능 영역 감지 → 연속 캡처 + 상세 분석
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const https = require('https');

const CAPTURE_DIR   = path.join(os.homedir(), '.orbit', 'captures');
const MAX_CAPTURES  = 100;

// ── 동적 쿨타임 설정 ──
const COOLTIME = {
  work_high:   90 * 1000,     // 고가치 작업 (스프레드시트/코딩/문서) → 1.5분
  work_normal: 3 * 60 * 1000, // 일반 작업 → 3분
  idle:        10 * 60 * 1000, // 비활동/비업무 → 10분
  automation:  60 * 1000,      // 자동화 분석 대상 → 1분 (연속 캡처)
};

// 업무 앱 판별
const WORK_APPS = {
  high: new Set(['excel', 'powerpnt', 'word', 'code', 'rider', 'pycharm', 'intellij',
    'cursor', 'windsurf', 'figma', 'photoshop', 'illustrator', 'premiere',
    'autocad', 'solidworks', 'tableau', 'powerbi']),
  normal: new Set(['chrome', 'firefox', 'edge', 'brave', 'whale', 'safari',
    'outlook', 'thunderbird', 'slack', 'teams', 'notion', 'obsidian',
    'terminal', 'iterm', 'cmd', 'powershell']),
  idle: new Set(['explorer', 'finder', 'systempreferences', 'settings',
    'calculator', 'photos', 'music', 'vlc', 'spotify']),
};

// 자동화 가능 패턴 (반복 작업 감지)
const AUTOMATION_PATTERNS = [
  /vlookup|hlookup|index.*match|pivot|피벗/i,
  /복사.*붙여넣기|copy.*paste|ctrl\+c.*ctrl\+v/i,
  /반복.*입력|같은.*작업|동일.*패턴/i,
  /매크로|macro|자동화|automate/i,
];

let _lastCaptureTime = 0;
let _lastActiveApp   = '';
let _lastWindowTitle  = '';
let _idleTimer       = null;
let _running         = false;
let _visionEnabled   = false;
let _lastAnalysis    = null;

// ── 활동 상태 추적 (키로거에서 업데이트) ──
let _currentActivity = 'idle';     // high / normal / idle / automation
let _keyActivityCount = 0;         // 최근 키 입력 횟수
let _lastKeyTime = 0;
let _recentApps = [];              // 최근 앱 이력 (반복 패턴 감지용)
let _automationScore = 0;          // 자동화 가능성 점수

function _checkVisionEnabled() {
  try {
    const { getApiKey } = require('./vision-analyzer');
    _visionEnabled = !!getApiKey();
    if (_visionEnabled) console.log('[screen-capture] Vision AI 분석 활성화');
  } catch { _visionEnabled = false; }
}

function _sendAnalysisToServer(result, trigger, filepath) {
  try {
    const orbitConfig = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); } catch { return {}; }
    })();
    const serverUrl = orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL;
    const token = orbitConfig.token || process.env.ORBIT_TOKEN || '';
    const payload = JSON.stringify({
      events: [{
        id: 'vision-' + Date.now(),
        type: 'screen.analyzed',
        source: 'vision-analyzer',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          trigger,
          activity: result.activity,
          app: result.app,
          description: result.description,
          details: result.details || '',
          confidence: result.confidence,
          filename: path.basename(filepath),
          automationScore: _automationScore,
          activityLevel: _currentActivity,
        },
      }],
    });
    // localhost
    try {
      const lr = http.request({ hostname: 'localhost', port: parseInt(process.env.ORBIT_PORT || '4747'), path: '/api/hook', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, r => r.resume());
      lr.on('error', () => {}); lr.write(payload); lr.end();
    } catch {}
    // remote
    if (serverUrl) {
      try {
        const url = new URL('/api/hook', serverUrl);
        const mod = url.protocol === 'https:' ? https : http;
        const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
        if (token) h['Authorization'] = 'Bearer ' + token;
        const rr = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'POST', headers: h, timeout: 10000 }, r => r.resume());
        rr.on('error', () => {}); rr.write(payload); rr.end();
      } catch {}
    }
  } catch {}
}

function ensureDir() { fs.mkdirSync(CAPTURE_DIR, { recursive: true }); }

/**
 * 현재 활동 레벨에 맞는 쿨타임 반환
 */
function _getCurrentCooltime() {
  return COOLTIME[_currentActivity] || COOLTIME.idle;
}

/**
 * 키로거 데이터 기반 활동 레벨 업데이트
 */
function _updateActivityLevel(app, windowTitle) {
  const appLow = (app || '').toLowerCase();

  // 자동화 패턴 감지 (윈도우 타이틀에서)
  const isAutomation = AUTOMATION_PATTERNS.some(p => p.test(windowTitle || ''));
  if (isAutomation) {
    _automationScore = Math.min(10, _automationScore + 2);
    if (_automationScore >= 4) {
      _currentActivity = 'automation';
      return;
    }
  } else {
    _automationScore = Math.max(0, _automationScore - 0.5);
  }

  // 앱 기반 분류
  if (WORK_APPS.high.has(appLow)) {
    _currentActivity = 'work_high';
  } else if (WORK_APPS.normal.has(appLow)) {
    _currentActivity = _keyActivityCount > 10 ? 'work_normal' : 'idle';
  } else if (WORK_APPS.idle.has(appLow)) {
    _currentActivity = 'idle';
  } else {
    // 알 수 없는 앱 — 키 입력량으로 판단
    _currentActivity = _keyActivityCount > 20 ? 'work_normal' : 'idle';
  }

  // 반복 앱 전환 감지 (같은 앱 2개를 번갈아 사용 = 복사/참조 작업)
  _recentApps.push(appLow);
  if (_recentApps.length > 10) _recentApps = _recentApps.slice(-10);
  const uniqueRecent = [...new Set(_recentApps.slice(-6))];
  if (uniqueRecent.length === 2 && _recentApps.length >= 6) {
    // 2개 앱만 번갈아 사용 → 자동화 후보
    _automationScore = Math.min(10, _automationScore + 1);
  }
}

/**
 * 캡처 실행
 */
function capture(trigger = 'manual') {
  const now = Date.now();
  const cooltime = _getCurrentCooltime();

  // 쿨타임 체크
  if (now - _lastCaptureTime < cooltime) return null;

  ensureDir();
  const filename = `screen-${now}-${trigger}-${_currentActivity}.png`;
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
    } else { return null; }

    if (!fs.existsSync(filepath)) return null;
    _lastCaptureTime = now;

    const shouldAnalyze = _visionEnabled && (_currentActivity === 'work_high' || _currentActivity === 'automation');
    console.log(`[screen-capture] ${trigger}/${_currentActivity}: ${filename}${shouldAnalyze ? ' +Vision' : ''}`);

    // Vision AI 분석 (업무 작업 + 자동화 대상만)
    if (shouldAnalyze) {
      try {
        const { analyzeScreenshot } = require('./vision-analyzer');
        analyzeScreenshot(filepath, { app: _lastActiveApp, windowTitle: _lastWindowTitle }).then(result => {
          if (result) {
            console.log(`[screen-capture] AI: ${result.activity} — ${result.description}`);
            _lastAnalysis = result;
            _sendAnalysisToServer(result, trigger, filepath);
            // 자동화 패턴 강화
            if (result.details && AUTOMATION_PATTERNS.some(p => p.test(result.details))) {
              _automationScore = Math.min(10, _automationScore + 3);
            }
          }
        }).catch(() => {});
      } catch {}
    }

    // 정리
    try {
      const files = fs.readdirSync(CAPTURE_DIR).filter(f => f.startsWith('screen-') && f.endsWith('.png')).sort().reverse();
      files.slice(MAX_CAPTURES).forEach(f => { try { fs.unlinkSync(path.join(CAPTURE_DIR, f)); } catch {} });
    } catch {}

    return filepath;
  } catch (e) {
    console.warn('[screen-capture] 실패:', e.message);
    return null;
  }
}

// ── 외부 트리거 ──
function onAppChange(appName) {
  if (!_running) return;
  if (appName && appName !== _lastActiveApp) {
    _lastActiveApp = appName;
    _keyActivityCount = 0; // 앱 전환 시 리셋
    _updateActivityLevel(appName, _lastWindowTitle);
    capture('app_switch');
  }
}

function onKeyActivity() {
  if (!_running) return;
  _keyActivityCount++;
  _lastKeyTime = Date.now();
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    capture('idle');
  }, _currentActivity === 'work_high' ? 20000 : 30000); // 고가치 작업은 20초 idle
}

function onWindowTitleChange(title) {
  if (!_running) return;
  _lastWindowTitle = title || '';
  _updateActivityLevel(_lastActiveApp, _lastWindowTitle);
}

function onToolEnd() { if (_running) capture('tool_end'); }
function onFileWrite() { if (_running) capture('file_write'); }

function start() {
  if (_running) return;
  _running = true;
  _lastCaptureTime = 0;
  _checkVisionEnabled();
  console.log(`[screen-capture] 지능형 캡처 시작 (저장: ${CAPTURE_DIR})`);
  console.log(`[screen-capture] 쿨타임: 고가치=${COOLTIME.work_high/1000}s 일반=${COOLTIME.work_normal/1000}s idle=${COOLTIME.idle/1000}s 자동화=${COOLTIME.automation/1000}s`);
  capture('startup');
}

function stop() {
  _running = false;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

function getLastAnalysis() { return _lastAnalysis; }
function getCurrentActivity() { return { level: _currentActivity, automationScore: _automationScore, cooltime: _getCurrentCooltime() }; }

function getRecentCaptures(count = 10) {
  ensureDir();
  try {
    return fs.readdirSync(CAPTURE_DIR).filter(f => f.startsWith('screen-') && f.endsWith('.png'))
      .sort().reverse().slice(0, count).map(f => path.join(CAPTURE_DIR, f));
  } catch { return []; }
}

module.exports = {
  start, stop, capture, getRecentCaptures, getLastAnalysis, getCurrentActivity,
  onAppChange, onKeyActivity, onWindowTitleChange, onToolEnd, onFileWrite,
  CAPTURE_DIR,
};
