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
const MAX_CAPTURES  = 500; // 개발 단계: 최대 보관

// ── 개발 단계: 모든 데이터 최대 수집 ──
const COOLTIME = {
  work_high:   60 * 1000,     // 1분
  work_normal: 60 * 1000,     // 1분
  idle:        2 * 60 * 1000, // 2분 (idle도 수집 — 뭘 안 하는지도 데이터)
  automation:  30 * 1000,     // 30초 (자동화 대상은 최대한 촘촘히)
};

// 앱별 기본 가치 (윈도우 타이틀/키 입력으로 재판단됨)
const APP_BASE = {
  high: new Set(['excel', 'powerpnt', 'word', 'code', 'rider', 'pycharm', 'intellij',
    'cursor', 'windsurf', 'figma', 'photoshop', 'illustrator', 'premiere',
    'autocad', 'solidworks', 'tableau', 'powerbi']),
  low: new Set(['calculator', 'photos', 'music', 'vlc', 'spotify', 'games']),
  // 나머지 앱은 전부 "내용으로 판단" (카카오톡/크롬/슬랙/탐색기 등)
};

// 윈도우 타이틀에서 업무 키워드 감지
const WORK_KEYWORDS = [
  /매출|수익|이익|비용|예산|결산|회계|invoice|budget/i,
  /계약|견적|발주|수주|납품|재고|물류|shipping/i,
  /보고서|기획서|제안서|회의록|분석|report|proposal/i,
  /프로젝트|일정|마감|deadline|task|이슈|issue/i,
  /고객|클라이언트|거래처|client|customer/i,
  /개발|코드|버그|배포|서버|API|데이터베이스/i,
  /디자인|UI|UX|레이아웃|목업|mockup/i,
  /채용|면접|인사|평가|교육|training/i,
  /\.xlsx|\.pptx|\.docx|\.pdf|\.csv/i,
  /jira|confluence|notion|asana|trello|linear/i,
];

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
 * 현재 활동 레벨에 맞는 쿨타임 반환 (tool-profiler 전략 우선)
 */
function _getCurrentCooltime() {
  // tool-profiler에서 앱별 맞춤 전략 확인
  try {
    const { getStrategy } = require('./tool-profiler');
    const strategy = getStrategy(_lastActiveApp);
    if (strategy && strategy.captureInterval) {
      return strategy.captureInterval * 1000; // 초→밀리초
    }
  } catch {}
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

  // 1단계: 윈도우 타이틀에 업무 키워드가 있는지 (앱 무관)
  const titleHasWork = WORK_KEYWORDS.some(p => p.test(windowTitle || ''));

  if (titleHasWork) {
    // 업무 내용 감지 → 고가치 (카카오톡이든 크롬이든)
    _currentActivity = 'work_high';
  } else if (APP_BASE.high.has(appLow)) {
    // 업무 전용 앱 (Excel/코딩 등)
    _currentActivity = 'work_high';
  } else if (APP_BASE.low.has(appLow)) {
    // 비업무 앱 (계산기/음악 등)
    _currentActivity = 'idle';
  } else if (_keyActivityCount > 15) {
    // 키 입력 활발 → 뭔가 하고 있음
    _currentActivity = 'work_normal';
  } else if (_keyActivityCount > 5) {
    _currentActivity = 'work_normal';
  } else {
    _currentActivity = 'idle';
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

    // 개발 단계: 모든 캡처에 Vision 분석 (전부 수집)
    const shouldAnalyze = _visionEnabled;
    console.log(`[screen-capture] ${trigger}/${_currentActivity}: ${filename}${shouldAnalyze ? ' +Vision' : ''}`);

    if (shouldAnalyze) {
      try {
        const { analyzeScreenshot } = require('./vision-analyzer');
        analyzeScreenshot(filepath, { app: _lastActiveApp, windowTitle: _lastWindowTitle }).then(result => {
          if (result) {
            console.log(`[screen-capture] AI: ${result.activity} — ${result.description}`);
            _lastAnalysis = result;
            _sendAnalysisToServer(result, trigger, filepath);
            // tool-profiler에 Vision 인사이트 축적
            try { require('./tool-profiler').recordVisionInsight(_lastActiveApp, result); } catch {}
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
