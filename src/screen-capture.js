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

// ── 변화 감지 기반 캡처 (고정 간격 아님) ──
// 최소 쿨타임만 설정 (연속 캡처 방지)
// ── 학습 에이전트 제안 캡처 간격 (~/.orbit/capture-config.json) ──────────────
// 학습 에이전트가 사용자 패턴 분석 후 최적 간격을 여기에 기록
// 파일 없으면 기본값 사용. 5분마다 재로드.
const CAPTURE_CONFIG_PATH = path.join(os.homedir(), '.orbit', 'capture-config.json');
const DEFAULT_COOLTIME = 60 * 1000; // 데이터 미학습 시 기본값: 60초
let _captureConfig = null;
let _captureConfigLoadedAt = 0;

function _loadCaptureConfig() {
  if (Date.now() - _captureConfigLoadedAt < 5 * 60 * 1000) return; // 5분 캐시
  try {
    _captureConfig = JSON.parse(fs.readFileSync(CAPTURE_CONFIG_PATH, 'utf8'));
    _captureConfigLoadedAt = Date.now();
  } catch { _captureConfig = null; }
}

function _getLearnedCooltime(app, windowTitle) {
  _loadCaptureConfig();
  if (!_captureConfig) return null;
  // 앱별 제안값 (학습 에이전트가 { byApp: { excel: 120000, kakaotalk: 45000 }, default: 60000 } 형태로 저장)
  const appLow = (app || '').toLowerCase();
  if (_captureConfig.byApp?.[appLow]) return _captureConfig.byApp[appLow];
  if (_captureConfig.default) return _captureConfig.default;
  return null;
}

const MIN_COOLTIME = DEFAULT_COOLTIME;

// ── 캡처 타이밍 인텔리전스 ──────────────────────────────────────────────────
// 활동 상태 머신: IDLE → ACTIVE → FOCUSED → BURST → COOLDOWN
const ACTIVITY_STATES = {
  IDLE:     { captureInterval: 5 * 60 * 1000, label: 'idle' },       // 5분
  ACTIVE:   { captureInterval: 90 * 1000,     label: 'active' },     // 90초
  FOCUSED:  { captureInterval: 2 * 60 * 1000, label: 'focused' },    // 2분
  BURST:    { captureInterval: 30 * 1000,     label: 'burst' },      // 30초
  COOLDOWN: { captureInterval: Infinity,      label: 'cooldown' },   // 캡처 안 함
};

let _activityState = ACTIVITY_STATES.IDLE;
let _stateEnteredAt = Date.now();
let _sameAppStartTime = Date.now(); // 같은 앱 연속 사용 시작 시간
let _lastInputTime = 0;             // 마지막 키/마우스 입력 시간
let _inputCountWindow = 0;          // 30초 윈도우 내 입력 횟수
let _inputWindowStart = Date.now();
let _consecutiveIdleCaptures = 0;   // 연속 idle 캡처 횟수

// 앱별 프로파일 (priority + minInterval)
const APP_PROFILES = {
  nenova:     { priority: 'critical', minInterval: 30000,  sendImage: true },
  excel:      { priority: 'high',     minInterval: 45000,  sendImage: true },
  powerpnt:   { priority: 'high',     minInterval: 60000,  sendImage: true },
  word:       { priority: 'high',     minInterval: 60000,  sendImage: false },
  code:       { priority: 'high',     minInterval: 60000,  sendImage: false },
  rider:      { priority: 'high',     minInterval: 60000,  sendImage: false },
  pycharm:    { priority: 'high',     minInterval: 60000,  sendImage: false },
  cursor:     { priority: 'high',     minInterval: 60000,  sendImage: false },
  chrome:     { priority: 'medium',   minInterval: 90000,  sendImage: false },
  edge:       { priority: 'medium',   minInterval: 90000,  sendImage: false },
  whale:      { priority: 'medium',   minInterval: 90000,  sendImage: false },
  kakaotalk:  { priority: 'low',      minInterval: 180000, sendImage: false },
  slack:      { priority: 'low',      minInterval: 180000, sendImage: false },
  explorer:   { priority: 'low',      minInterval: 120000, sendImage: false },
  calculator: { priority: 'skip',     minInterval: 300000, sendImage: false },
  spotify:    { priority: 'skip',     minInterval: 300000, sendImage: false },
};

// 트리거별 중요도
const TRIGGER_PRIORITY = {
  app_switch:      'high',
  title_change:    'medium',
  idle_result:     'medium',
  keyboard_done:   'high',    // ★ 키보드 입력 완료 (4초 idle 후)
  keyboard_flush:  'high',    // ★ keyboard.chunk 서버 전송 완료
  mouse_click:     'high',    // ★ 마우스 클릭 후 UI 반응 캡처
  ctrl_print:      'high',    // ★ Ctrl+P 인쇄 — 발주서/청구서 출력 감지
  excel_formula:   'high',    // ★ Ctrl+Enter Excel 수식 확정
  key_burst:       'medium',
  click_burst:     'medium',
  startup:         'high',
  tool_end:        'high',
  file_write:      'high',
  manual:          'high',
};

/**
 * 활동 상태 머신 업데이트
 */
function _updateActivityState() {
  const now = Date.now();
  const sinceLast = now - _lastInputTime;
  const sameAppDuration = now - _sameAppStartTime;

  // 30초 윈도우 리셋
  if (now - _inputWindowStart > 30000) {
    _inputCountWindow = 0;
    _inputWindowStart = now;
  }

  // BURST: 30초 내 50+ 입력
  if (_inputCountWindow >= 50) {
    _activityState = ACTIVITY_STATES.BURST;
  }
  // IDLE: 60초 무입력
  else if (sinceLast > 60000) {
    _activityState = ACTIVITY_STATES.IDLE;
  }
  // FOCUSED: 같은 앱 3분+ 연속 사용
  else if (sameAppDuration > 3 * 60 * 1000 && sinceLast < 60000) {
    _activityState = ACTIVITY_STATES.FOCUSED;
  }
  // ACTIVE: 입력 있음
  else if (sinceLast < 60000) {
    _activityState = ACTIVITY_STATES.ACTIVE;
  }
}

/**
 * 스마트 쿨타임 — 앱 프로파일 + 활동 상태 + 학습값 종합
 */
function _smartCooltime(app, trigger) {
  const appLow = (app || '').toLowerCase();
  const profile = APP_PROFILES[appLow];

  // 1순위: 학습 에이전트 제안값
  const learned = _getLearnedCooltime(appLow, _lastWindowTitle);
  if (learned) return learned;

  // 2순위: 앱 프로파일 minInterval
  if (profile) return profile.minInterval;

  // 3순위: 활동 상태 기반
  return _activityState.captureInterval;
}

/**
 * 캡처 여부 판단 — 중요도 + 쿨타임 + 중복 제거
 */
function _shouldCapture(trigger, app) {
  const now = Date.now();
  const appLow = (app || '').toLowerCase();
  const profile = APP_PROFILES[appLow];
  const triggerPriority = TRIGGER_PRIORITY[trigger] || 'medium';

  // skip 프로파일 앱은 5분 간격만
  if (profile?.priority === 'skip') {
    return (now - _lastCaptureTime) >= 300000;
  }

  // idle 상태에서 연속 캡처 방지 (첫 1회 후 5분마다)
  if (_activityState === ACTIVITY_STATES.IDLE && trigger !== 'app_switch' && trigger !== 'startup') {
    if (_consecutiveIdleCaptures > 0) {
      return (now - _lastCaptureTime) >= 5 * 60 * 1000;
    }
  }

  // 능동 트리거 (키보드/마우스 이벤트 기반) → 짧은 고정 쿨타임 (앱 프로파일 무시)
  // 이 트리거들은 사용자가 의미 있는 행동을 했을 때만 발생 → 캡처 가치 높음
  const REACTIVE_TRIGGERS = new Set(['keyboard_flush', 'keyboard_done', 'mouse_click', 'ctrl_print', 'excel_formula']);
  if (REACTIVE_TRIGGERS.has(trigger)) {
    return (now - _lastCaptureTime) >= 45000; // 45초 쿨타임 (앱 무관)
  }

  // HIGH 트리거 → 앱 프로파일 minInterval만 준수
  if (triggerPriority === 'high') {
    const minInt = profile?.minInterval || 30000;
    return (now - _lastCaptureTime) >= minInt;
  }

  // MEDIUM 트리거 → 스마트 쿨타임 준수
  const cooltime = _smartCooltime(app, trigger);
  return (now - _lastCaptureTime) >= cooltime;
}

/**
 * 이미지 전송 여부 판단 — HIGH 이벤트 + critical/high 앱만
 */
function _shouldSendImage(trigger, app) {
  const appLow = (app || '').toLowerCase();
  const profile = APP_PROFILES[appLow];
  const triggerPriority = TRIGGER_PRIORITY[trigger] || 'medium';

  // mouse_click 트리거 → critical 앱(nenova)만 이미지, 나머지 metadata
  // 이유: 클릭은 빈번 → 과도한 이미지 전송 방지
  if (trigger === 'mouse_click') {
    return profile?.priority === 'critical';
  }

  // keyboard_flush / keyboard_done → critical + high 앱만 이미지
  if (trigger === 'keyboard_flush' || trigger === 'keyboard_done') {
    return profile?.priority === 'critical' || (profile?.priority === 'high' && profile?.sendImage);
  }

  // ctrl_print → 인쇄 의도 → critical/high 앱이면 이미지 전송 (뭘 출력했는지 확인)
  if (trigger === 'ctrl_print') {
    return profile?.priority === 'critical' || profile?.priority === 'high';
  }

  // excel_formula (Ctrl+Enter) → Excel이면 이미지 전송 (수식 결과 확인)
  if (trigger === 'excel_formula') {
    return appLow.includes('excel') || profile?.priority === 'critical';
  }

  // critical 앱 (nenova) → 항상 이미지
  if (profile?.priority === 'critical') return true;

  // HIGH 트리거 + high 앱 → 이미지
  if (triggerPriority === 'high' && profile?.sendImage) return true;

  // 앱 전환 → 매 3번째만 이미지
  if (trigger === 'app_switch') {
    return (global._captureCounter || 0) % 3 === 0;
  }

  // 나머지 → metadata만
  return false;
}

// 앱별 기본 가치 (윈도우 타이틀/키 입력으로 재판단됨)
const APP_BASE = {
  high: new Set(['excel', 'powerpnt', 'word', 'code', 'rider', 'pycharm', 'intellij',
    'cursor', 'windsurf', 'figma', 'photoshop', 'illustrator', 'premiere',
    'autocad', 'solidworks', 'tableau', 'powerbi', 'nenova']),
  low: new Set(['calculator', 'photos', 'music', 'vlc', 'spotify', 'games']),
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
let _lastCapturePath = ''; // 이전 캡처 경로 (diff 비교용)
let _lastActiveApp   = '';
let _lastWindowTitle  = '';
let _idleTimer       = null;
let _running         = false;
let _paused          = false;  // 은행 보안프로그램 감지 시 일시정지

// heartbeat 진단용 상태
let _scCaptureCount  = 0;  // 이 세션에서 성공한 capture 수
let _scLastCaptureAt = 0;
let _scErrorCount    = 0;
let _scLastErrorAt   = 0;
let _scLastErrorMsg  = '';
let _visionEnabled   = false;
let _lastAnalysis    = null;
let _screenResolution = null;  // 화면 해상도 캐시

// ── 활동 상태 추적 (키로거에서 업데이트) ──
let _currentActivity = 'idle';     // high / normal / idle / automation
let _keyActivityCount = 0;         // 최근 키 입력 횟수
let _lastKeyTime = 0;
let _recentApps = [];              // 최근 앱 이력 (반복 패턴 감지용)
let _automationScore = 0;          // 자동화 가능성 점수

/**
 * 화면 해상도 감지 (시작 시 1회 + 캐시)
 */
function _detectScreenResolution() {
  if (_screenResolution) return _screenResolution;
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell.exe -NoProfile -WindowStyle Hidden -NonInteractive -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ForEach-Object { \\"$($_.Width)x$($_.Height)\\" }"',
        { timeout: 3000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
      ).trim();
      _screenResolution = out || 'unknown';
    } else if (process.platform === 'darwin') {
      const out = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution', { timeout: 3000, encoding: 'utf8' }).trim();
      const m = out.match(/(\d+)\s*x\s*(\d+)/);
      _screenResolution = m ? `${m[1]}x${m[2]}` : 'unknown';
    } else {
      _screenResolution = 'unknown';
    }
  } catch { _screenResolution = 'unknown'; }
  return _screenResolution;
}

function _checkVisionEnabled() {
  try {
    const { getApiKey } = require('./vision-analyzer');
    _visionEnabled = !!getApiKey();
    // vision enabled
  } catch { _visionEnabled = false; }
}

function _sendAnalysisToServer(result, trigger, filepath) {
  try {
    const orbitConfig = (() => {
      try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if(r.charCodeAt(0)===0xFEFF) r=r.slice(1); return JSON.parse(r); } catch { return {}; }
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
          path: url.pathname, method: 'POST', headers: h, timeout: 10000 }, r => {
          let rd = ''; r.on('data', c => rd += c);
          r.on('end', () => {
            try {
              const rj = JSON.parse(rd);
              if (rj._commands && Array.isArray(rj._commands)) {
                for (const cmd of rj._commands) {
                  if (cmd.action === 'update') {
                    console.log('[screen-capture] 서버 강제 업데이트 명령 수신!');
                    try {
                      const { execSync } = require('child_process');
                      const ROOT = require('path').resolve(__dirname, '..');
                      execSync('git pull origin main --ff-only', { cwd: ROOT, timeout: 30000, windowsHide: true });
                      console.log('[screen-capture] git pull 완료 — 10초 후 재시작');
                      setTimeout(() => process.exit(0), 10000);
                    } catch (e) { console.warn('[screen-capture] 강제 업데이트 실패:', e.message); }
                  }
                }
              }
            } catch {}
          });
        });
        rr.on('error', () => {}); rr.write(payload); rr.end();
      } catch {}
    }
  } catch {}
}

function ensureDir() { fs.mkdirSync(CAPTURE_DIR, { recursive: true }); }

/**
 * 캡처 파일을 서버로 업로드 (서버에서 Vision 분석)
 */
function _uploadCaptureToServer(filepath, trigger, context) {
  try {
    const orbitConfig = (() => {
      try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if(r.charCodeAt(0)===0xFEFF) r=r.slice(1); return JSON.parse(r); } catch { return {}; }
    })();
    const serverUrl = orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL;
    const token = orbitConfig.token || process.env.ORBIT_TOKEN || '';
    if (!serverUrl) return;

    // 이미지를 base64로 인코딩해서 전송
    const imageData = fs.readFileSync(filepath);
    const base64 = imageData.toString('base64');

    const payload = JSON.stringify({
      events: [{
        id: 'capture-' + Date.now(),
        type: 'screen.capture',
        source: 'screen-capture',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          trigger,
          triggerReason: _getTriggerDescription(trigger),
          app: context.app || '',
          windowTitle: context.windowTitle || '',
          activityLevel: context.activityLevel || '',
          automationScore: context.automationScore || 0,
          screenResolution: _detectScreenResolution(),
          previousCapture: context.previousCapture || '',
          filename: path.basename(filepath),
          imageBase64: base64,  // 서버에서 Vision 분석용
          hostname: os.hostname(),
        },
      }],
    });

    // 원격 서버 전송
    const url = new URL('/api/hook', serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: 30000,
    }, res => res.resume());
    req.on('error', (e) => { console.warn('[screen-capture] 업로드 실패:', e.message); });
    req.write(payload);
    req.end();
  } catch (e) { console.warn('[screen-capture] 업로드 에러:', e.message); }
}

/**
 * 최소 쿨타임 반환 — 카카오톡/주문 앱 활성 시 단축
 */
function _getCurrentCooltime() {
  const app = (_lastActiveApp || '').toLowerCase();
  const win = (_lastWindowTitle || '').toLowerCase();

  // 1순위: 학습 에이전트 제안값 (capture-config.json)
  const learned = _getLearnedCooltime(app, win);
  if (learned) return learned;

  // 2순위: 기본 fallback (학습 전 초기값)
  return MIN_COOLTIME; // 60초
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
  // 은행 보안프로그램 일시정지 중이면 캡처 스킵
  if (_paused) return null;

  // ── 인텔리전스: 상태 머신 업데이트 + 스마트 판단 ──
  _updateActivityState();

  if (!_shouldCapture(trigger, _lastActiveApp)) return null;

  ensureDir();
  const now = Date.now();
  const stateLabel = _activityState.label || 'unknown';
  const filename = `screen-${now}-${trigger}-${stateLabel}.png`;
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
        `powershell.exe -NoProfile -WindowStyle Hidden -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${escaped}') }"`,
        { timeout: 10000, windowsHide: true, stdio: 'pipe' }
      );
    } else { return null; }

    if (!fs.existsSync(filepath)) {
      _scErrorCount++;
      _scLastErrorAt = Date.now();
      _scLastErrorMsg = 'capture command returned no file';
      return null;
    }
    const prevCapturePath = _lastCapturePath;
    _lastCapturePath = filepath;
    _lastCaptureTime = now;
    _scCaptureCount++;
    _scLastCaptureAt = now;

    // idle 연속 카운트
    if (_activityState === ACTIVITY_STATES.IDLE) _consecutiveIdleCaptures++;
    else _consecutiveIdleCaptures = 0;

    console.log(`[screen-capture] ${trigger}/${stateLabel}: ${filename}`);

    // ── 인텔리전스: 이미지 전송 여부 판단 ──
    if (!global._captureCounter) global._captureCounter = 0;
    global._captureCounter++;

    const context = {
      app: _lastActiveApp,
      windowTitle: _lastWindowTitle,
      activityLevel: stateLabel,
      automationScore: _automationScore,
      previousCapture: prevCapturePath || '',
    };

    if (_shouldSendImage(trigger, _lastActiveApp)) {
      _uploadCaptureToServer(filepath, trigger, context);
    } else {
      _sendCaptureMetadata(filepath, trigger, context);
    }

    // 정리
    try {
      const files = fs.readdirSync(CAPTURE_DIR).filter(f => f.startsWith('screen-') && f.endsWith('.png')).sort().reverse();
      files.slice(MAX_CAPTURES).forEach(f => { try { fs.unlinkSync(path.join(CAPTURE_DIR, f)); } catch {} });
    } catch {}

    return filepath;
  } catch (e) {
    _scErrorCount++;
    _scLastErrorAt = Date.now();
    _scLastErrorMsg = e.message;
    console.warn('[screen-capture] 실패:', e.message);
    return null;
  }
}

// heartbeat 진단용 — 모듈 상태 보고
function getStatus() {
  const now = Date.now();
  const sinceLast = _scLastCaptureAt ? Math.round((now - _scLastCaptureAt) / 1000) : null;
  let state = 'ok';
  if (!_running)                           state = 'dead';
  else if (_paused)                        state = 'paused';
  else if (_scErrorCount >= 5)             state = 'degraded';
  // recency 기반 degrade 제거 — 캡처는 전적으로 활동(앱 전환/키 입력 등) 트리거
  return {
    running:      _running,
    paused:       _paused,
    state,
    captureCount: _scCaptureCount,
    lastCaptureAt:  _scLastCaptureAt ? new Date(_scLastCaptureAt).toISOString() : null,
    secondsSinceCapture: sinceLast,
    errorCount:   _scErrorCount,
    lastErrorAt:  _scLastErrorAt ? new Date(_scLastErrorAt).toISOString() : null,
    lastErrorMsg: _scLastErrorMsg || null,
    activityState: _activityState,
  };
}

// ── 변화 감지 트리거 (고정 간격 없음 — 변화가 있을 때만 캡처) ──

// 트리거 1: 앱 전환 → 즉시 캡처
function onAppChange(appName) {
  if (!_running) return;
  if (appName && appName !== _lastActiveApp) {
    const prevApp = _lastActiveApp;
    _lastActiveApp = appName;
    _keyActivityCount = 0;
    _sameAppStartTime = Date.now(); // FOCUSED 상태 리셋
    _lastInputTime = Date.now();
    _updateActivityLevel(appName, _lastWindowTitle);
    capture('app_switch');
  }
}

// 트리거 2: 윈도우 타이틀 변경 → 캡처 (같은 앱 내에서 탭/문서 전환)
let _lastCapturedTitle = '';
function onWindowTitleChange(title) {
  if (!_running) return;
  _lastWindowTitle = title || '';
  _updateActivityLevel(_lastActiveApp, _lastWindowTitle);
  // 타이틀이 실질적으로 변경됐을 때만 (숫자/시간 변경 무시)
  const normalized = (title || '').replace(/[\d:/.]+/g, '').trim();
  const lastNorm = _lastCapturedTitle.replace(/[\d:/.]+/g, '').trim();
  if (normalized !== lastNorm && normalized.length > 3) {
    _lastCapturedTitle = title || '';
    capture('title_change');
  }
}

// 트리거 3: 키보드 idle → 결과물 화면 캡처
// 키 입력 멈춘 직후 = 뭔가 입력 완료 = 그 화면이 중요한 순간
function onKeyActivity() {
  if (!_running) return;
  _keyActivityCount++;
  _lastKeyTime = Date.now();
  _lastInputTime = Date.now();
  _inputCountWindow++;
  if (_idleTimer) clearTimeout(_idleTimer);
  // 4초 idle → 입력 완료 화면 캡처 (기존 15초에서 단축)
  _idleTimer = setTimeout(() => {
    capture('keyboard_done');
  }, 4000);
}

// 트리거 3-B: 키보드 chunk flush → keyboard.chunk 이벤트 전송 완료 = 입력 사이클 종료
// keyboard-watcher.js의 _flush() 에서 호출됨
let _flushCaptureTimer = null;
function onKeyboardFlush() {
  if (!_running) return;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_flushCaptureTimer) clearTimeout(_flushCaptureTimer);
  // 1.5초 후 캡처 (서버 전송 완료 후 화면 안정 대기)
  _flushCaptureTimer = setTimeout(() => {
    capture('keyboard_flush');
    _flushCaptureTimer = null;
  }, 1500);
}

// 트리거 4: 키보드 폭주 → 작업 중 캡처 (임계값 대폭 낮춤)
let _burstTimer = null;
function onKeyBurst() {
  if (!_running) return;
  if (_keyActivityCount > 15 && !_burstTimer) { // 기존 50 → 15
    _burstTimer = setTimeout(() => {
      capture('key_burst');
      _burstTimer = null;
    }, 3000); // 기존 5s → 3s
  }
}

// 트리거 5-A: 마우스 클릭 단일 → 2초 후 캡처 (버튼/메뉴 클릭 결과)
// 핵심: 클릭 1번만으로 트리거 (기존엔 20번 필요)
let _clickSingleTimer = null;
function onMouseClick() {
  if (!_running) return;
  _lastInputTime = Date.now();
  _inputCountWindow++;
  if (_clickSingleTimer) clearTimeout(_clickSingleTimer);
  // 2초 후 캡처 — UI 반응 대기 (다이얼로그, 화면전환 등)
  _clickSingleTimer = setTimeout(() => {
    capture('mouse_click');
    _clickSingleTimer = null;
  }, 2000);
}

// 트리거 5-B: 마우스 폭주 (연속 클릭) → UI 조작 중 즉시
let _clickBurstCount = 0;
let _clickBurstTimer = null;
function onMouseBurst() {
  if (!_running) return;
  _clickBurstCount++;
  _lastInputTime = Date.now();
  _inputCountWindow++;
  if (_clickBurstCount > 5 && !_clickBurstTimer) { // 기존 20 → 5
    _clickBurstTimer = setTimeout(() => {
      capture('click_burst');
      _clickBurstCount = 0;
      _clickBurstTimer = null;
    }, 1500); // 기존 3s → 1.5s
  }
}

// 트리거 6: 도구/파일 이벤트 → 즉시
// 캡처 메타데이터만 서버 전송 (이미지 없이 — OOM 방지)
function _sendCaptureMetadata(filepath, trigger, context) {
  try {
    const orbitConfig = (() => {
      try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if(r.charCodeAt(0)===0xFEFF) r=r.slice(1); return JSON.parse(r); } catch { return {}; }
    })();
    const serverUrl = orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL;
    const token = orbitConfig.token || process.env.ORBIT_TOKEN || '';
    if (!serverUrl) return;

    const payload = JSON.stringify({
      events: [{
        id: 'capture-' + Date.now(),
        type: 'screen.capture',
        source: 'screen-capture',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          trigger,
          triggerReason: _getTriggerDescription(trigger),
          app: context.app || '',
          windowTitle: context.windowTitle || '',
          activityLevel: context.activityLevel || '',
          automationScore: context.automationScore || 0,
          screenResolution: _detectScreenResolution(),
          filename: path.basename(filepath),
          hostname: os.hostname(),
          // imageBase64 제외 — 서버 OOM 방지, 로컬에만 보관
        },
      }],
    });

    const url = new URL('/api/hook', serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, r => r.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

/**
 * 트리거 유형을 사람이 읽을 수 있는 설명으로 변환
 */
function _getTriggerDescription(trigger) {
  const descriptions = {
    startup:         '데몬 시작 시 초기 캡처',
    app_switch:      '앱 전환 감지',
    title_change:    '윈도우 타이틀 변경 (탭/문서 전환)',
    keyboard_flush:  '★ 입력 완료 — keyboard.chunk 서버 전송 직후',
    keyboard_done:   '★ 입력 완료 — 4초 키보드 idle 감지',
    mouse_click:     '★ 마우스 클릭 후 UI 반응 화면',
    idle_result:     '키 입력 후 idle 감지',
    key_burst:       '키보드 연속 입력 중',
    click_burst:     '마우스 연속 클릭 중',
    tool_end:        '도구/명령 완료',
    file_write:      '파일 저장 감지',
    manual:          '수동 캡처',
  };
  return descriptions[trigger] || trigger;
}

function onToolEnd() { if (_running) capture('tool_end'); }
function onFileWrite() { if (_running) capture('file_write'); }

// Ctrl+P 인쇄 감지 → 즉시 캡처 (발주서/청구서 출력 순간)
let _lastPrintCapture = 0;
function onPrint() {
  if (!_running) return;
  const now = Date.now();
  if (now - _lastPrintCapture < 10000) return; // 10초 cooltime
  _lastPrintCapture = now;
  capture('ctrl_print');
}

// Ctrl+Enter Excel 수식 확정 → 즉시 캡처 (수식 결과 화면)
let _lastFormulaCapture = 0;
function onExcelFormula() {
  if (!_running) return;
  const now = Date.now();
  if (now - _lastFormulaCapture < 15000) return; // 15초 cooltime
  _lastFormulaCapture = now;
  capture('excel_formula');
}

function start() {
  if (_running) return;
  _running = true;
  _lastCaptureTime = 0;
  _checkVisionEnabled();
  _detectScreenResolution();
  // 캡처 시작
  capture('startup');
}

function stop() {
  _running = false;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

/**
 * 일시정지 (은행 보안프로그램 감지 시)
 * 캡처 트리거를 무시
 */
function pause() {
  if (_paused) return;
  _paused = true;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  console.log('[screen-capture] 일시정지됨 (은행 보안)');
}

/**
 * 재개 (은행 보안프로그램 종료 시)
 */
function resume() {
  if (!_paused) return;
  _paused = false;
  console.log('[screen-capture] 재개됨');
}

/**
 * 일시정지 상태 확인
 * @returns {boolean}
 */
function isPaused() { return _paused; }

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
  onAppChange, onKeyActivity, onKeyboardFlush, onWindowTitleChange, onToolEnd, onFileWrite,
  onKeyBurst, onMouseBurst, onMouseClick, onPrint, onExcelFormula,
  pause, resume, isPaused,
  getStatus,
  CAPTURE_DIR,
};
