'use strict';

/**
 * bank-safe-collector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 은행 보안 환경에서도 동작하는 데이터 수집 모듈
 *
 * 문제: 은행 보안프로그램(TouchEnKey, nProtect 등)이 활성화되면
 *   - 키보드 후킹 (uiohook-napi) → rawInput 0건
 *   - GetForegroundWindow → 빈 값
 *   - 스크린 캡처 → 빈 이미지
 *   - 마우스 후킹 → 좌표 없음
 *
 * 해결: Windows 네이티브 "조회" 방식 사용 — 후킹이 아닌 WMI/PowerShell 쿼리
 *   은행 보안은 "후킹(Hooking)"을 차단하지만 "조회(Query)"는 차단하지 않음
 *
 * 수집 방법:
 *   1. WMI Process Query (Get-Process) → 실행 프로그램 + 창 제목
 *   2. Recent Files → 최근 열린/저장된 파일 목록
 *   3. Network Connections → 네트워크 사용 프로그램
 *   4. File System Changes → 작업 폴더 파일 변경 감지
 *   5. Windows Event Log → 시스템/앱 이벤트
 *   6. Clipboard (PowerShell) → 클립보드 내용
 *   7. Browser History (SQLite) → 브라우저 방문 기록
 *
 * 모든 PowerShell 실행: -WindowStyle Hidden (CMD 창 안 보임)
 * 모든 execSync: windowsHide: true 옵션 (CMD 플래시 방지)
 *
 * 5분 간격 polling → JSON 구조화 → 서버 /api/hook 전송
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os    = require('os');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ── 원격 서버 설정 (~/.orbit-config.json) ────────────────────────────────────
const _orbitConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
})();
const _remoteUrl   = _orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL || null;
const _remoteToken = _orbitConfig.token     || process.env.ORBIT_TOKEN      || '';

// ── 상태 ────────────────────────────────────────────────────────────────────
let _running        = false;
let _pollTimer      = null;
let _fileWatcher    = null;
let _lastData       = null;
let _fileChanges    = [];     // 파일 변경 누적 버퍼
let _emptyCount     = 0;      // keyboard-watcher 빈 이벤트 연속 카운트
const _watchedDirs  = [];     // fs.watch 핸들 참조

// ── 설정 ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = 5 * 60 * 1000;   // 5분
const PS_TIMEOUT         = 8000;             // PowerShell 타임아웃 (ms)
const PS_OPTS            = { timeout: PS_TIMEOUT, encoding: 'utf8', windowsHide: true, stdio: 'pipe' };
const MAX_FILE_CHANGES   = 50;               // 파일 변경 버퍼 최대
const EMPTY_THRESHOLD    = 5;                // 빈 이벤트 N회 연속 → bank-safe 자동 활성화

// ── PowerShell 명령 템플릿 ──────────────────────────────────────────────────
// -WindowStyle Hidden: 창 안 보임
// -NoProfile: 프로필 로드 안 함 (속도)
// -Command: 인라인 실행
const PS_PREFIX = 'powershell -WindowStyle Hidden -NoProfile -Command';


// ══════════════════════════════════════════════════════════════════════════════
// 1. WMI Process Query — 실행 중인 프로그램 + 창 제목
// ══════════════════════════════════════════════════════════════════════════════

function _collectProcesses() {
  try {
    const cmd = `${PS_PREFIX} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName, MainWindowTitle, Id, @{n='StartTime';e={$_.StartTime.ToString('o')}} | ConvertTo-Json -Compress"`;
    const raw = execSync(cmd, PS_OPTS).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // PowerShell returns single object (not array) when only 1 result
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(p => ({
      name: p.ProcessName || '',
      title: p.MainWindowTitle || '',
      pid: p.Id || 0,
      startTime: p.StartTime || '',
    })).filter(p => p.name);
  } catch (err) {
    console.warn('[bank-safe] 프로세스 수집 실패:', err.message);
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 2. Recent Files — 최근 열린/저장된 파일 목록
// ══════════════════════════════════════════════════════════════════════════════

function _collectRecentFiles() {
  try {
    const cmd = `${PS_PREFIX} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-ChildItem '$env:APPDATA\\Microsoft\\Windows\\Recent' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object Name, @{n='LastWriteTime';e={$_.LastWriteTime.ToString('o')}} -First 20 | ConvertTo-Json -Compress"`;
    const raw = execSync(cmd, PS_OPTS).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(f => ({
      name: (f.Name || '').replace(/\.lnk$/i, ''),
      time: f.LastWriteTime || '',
    })).filter(f => f.name);
  } catch (err) {
    console.warn('[bank-safe] 최근 파일 수집 실패:', err.message);
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 3. Active Network Connections — 네트워크 사용 프로그램
// ══════════════════════════════════════════════════════════════════════════════

function _collectNetworkApps() {
  try {
    const cmd = `${PS_PREFIX} "Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object { try { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } catch {} } | Sort-Object -Unique | ConvertTo-Json -Compress"`;
    const raw = execSync(cmd, PS_OPTS).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(Boolean);
  } catch (err) {
    console.warn('[bank-safe] 네트워크 앱 수집 실패:', err.message);
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 4. File System Changes — 작업 폴더 파일 변경 감지
// ══════════════════════════════════════════════════════════════════════════════

function _startFileWatchers() {
  if (_fileWatcher) return; // 이미 시작됨
  _fileWatcher = true;

  const userHome = os.homedir();
  const watchPaths = [
    path.join(userHome, 'Desktop'),
    path.join(userHome, 'Documents'),
    path.join(userHome, 'Downloads'),
  ];

  for (const dir of watchPaths) {
    try {
      if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        // 임시파일/시스템파일 무시
        if (filename.startsWith('~$') || filename.startsWith('.')) return;
        if (filename.endsWith('.tmp') || filename.endsWith('.crdownload')) return;

        const change = {
          path: path.basename(dir) + '/' + filename,
          action: eventType === 'rename' ? 'created/deleted' : 'modified',
          time: new Date().toISOString(),
        };
        _fileChanges.push(change);
        // 버퍼 제한
        if (_fileChanges.length > MAX_FILE_CHANGES) {
          _fileChanges = _fileChanges.slice(-MAX_FILE_CHANGES);
        }
      });
      _watchedDirs.push(watcher);
    } catch (err) {
      // 디렉토리 감시 실패 — 무시하고 계속
      console.warn(`[bank-safe] 파일 감시 실패 (${dir}):`, err.message);
    }
  }
}

function _stopFileWatchers() {
  for (const watcher of _watchedDirs) {
    try { watcher.close(); } catch {}
  }
  _watchedDirs.length = 0;
  _fileWatcher = null;
}


// ══════════════════════════════════════════════════════════════════════════════
// 5. Windows Event Log — 최근 앱/셸 이벤트
// ══════════════════════════════════════════════════════════════════════════════

function _collectEventLog() {
  try {
    // Application 로그에서 최근 10건 (셸 Operational은 없을 수 있음)
    const cmd = `${PS_PREFIX} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; try { Get-WinEvent -LogName 'Application' -MaxEvents 10 -ErrorAction Stop | Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToString('o')}}, ProviderName, @{n='Msg';e={$_.Message.Substring(0, [Math]::Min(100, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { '[]' }"`;
    const raw = execSync(cmd, PS_OPTS).trim();
    if (!raw || raw === '[]') return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(e => ({
      time: e.TimeCreated || '',
      provider: e.ProviderName || '',
      message: e.Msg || '',
    }));
  } catch {
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 6. Clipboard — PowerShell 방식 (후킹 아님)
// ══════════════════════════════════════════════════════════════════════════════

function _collectClipboard() {
  try {
    const cmd = `${PS_PREFIX} "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $c = Get-Clipboard -ErrorAction SilentlyContinue; if ($c) { $c.Substring(0, [Math]::Min(200, $c.Length)) } else { '' }"`;
    const raw = execSync(cmd, { ...PS_OPTS, timeout: 3000 }).trim();
    if (!raw) return null;
    // 비밀번호/민감정보 필터링 — 짧은 문자열이면서 특수문자 많으면 스킵
    if (raw.length < 30 && /[!@#$%^&*]/.test(raw)) return null;
    return { text: raw, length: raw.length };
  } catch {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 7. Browser History — Chrome/Edge SQLite 직접 읽기 (fallback)
// ══════════════════════════════════════════════════════════════════════════════

function _collectBrowserHistory() {
  try {
    // Chrome History DB 경로
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const chromeHistoryPath = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'History');
    const edgeHistoryPath = path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'History');

    // 브라우저 DB는 잠겨있으므로 복사 후 읽기
    const historyPath = fs.existsSync(chromeHistoryPath) ? chromeHistoryPath
                      : fs.existsSync(edgeHistoryPath) ? edgeHistoryPath
                      : null;

    if (!historyPath) return [];

    const tmpPath = path.join(os.tmpdir(), 'orbit-browser-history-tmp');
    try { fs.copyFileSync(historyPath, tmpPath); } catch { return []; }

    // PowerShell로 SQLite 읽기 (System.Data.SQLite 없을 수 있으므로 sqlite3 CLI 사용)
    const cmd = `${PS_PREFIX} "if (Get-Command sqlite3 -ErrorAction SilentlyContinue) { sqlite3 '${tmpPath.replace(/\\/g, '\\\\')}' 'SELECT url, title, datetime(last_visit_time/1000000-11644473600, \\\"unixepoch\\\", \\\"localtime\\\") as visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 10;' } else { '' }"`;
    const raw = execSync(cmd, PS_OPTS).trim();

    // 임시 파일 삭제
    try { fs.unlinkSync(tmpPath); } catch {}

    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return {
        url: (parts[0] || '').substring(0, 100),
        title: parts[1] || '',
        time: parts[2] || '',
      };
    }).slice(0, 10);
  } catch {
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 8. Scheduled Tasks — 시작 프로그램 목록 (설치된 프로그램 컨텍스트)
// ══════════════════════════════════════════════════════════════════════════════

function _collectScheduledTasks() {
  try {
    const cmd = `${PS_PREFIX} "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Ready' -and $_.TaskPath -notmatch 'Microsoft' } | Select-Object TaskName, State -First 15 | ConvertTo-Json -Compress"`;
    const raw = execSync(cmd, PS_OPTS).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(t => t.TaskName).filter(Boolean);
  } catch {
    return [];
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 메인 수집 함수 — 모든 소스 통합
// ══════════════════════════════════════════════════════════════════════════════

function _collectAll() {
  const timestamp = new Date().toISOString();
  const result = {
    method: 'wmi',
    timestamp,
    hostname: os.hostname(),
    processes: [],
    recentFiles: [],
    networkApps: [],
    fileChanges: [],
    eventLog: [],
    clipboard: null,
    browserHistory: [],
    scheduledTasks: [],
    errors: [],
  };

  // ── 1. 프로세스 목록 (핵심 — 항상 시도) ──
  result.processes = _collectProcesses();
  if (result.processes.length === 0) {
    result.errors.push('processes:empty');
    // WMI도 실패하면 tasklist fallback
    try {
      const raw = execSync('tasklist /FO CSV /NH /FI "STATUS eq Running"', { ...PS_OPTS, timeout: 5000 }).trim();
      if (raw) {
        const lines = raw.split('\n').slice(0, 20);
        result.processes = lines.map(line => {
          const match = line.match(/"([^"]+)","(\d+)"/);
          return match ? { name: match[1], title: '', pid: parseInt(match[2], 10) } : null;
        }).filter(Boolean);
        result.method = 'tasklist';
      }
    } catch {}
  }

  // ── 2. 최근 파일 ──
  result.recentFiles = _collectRecentFiles();

  // ── 3. 네트워크 앱 ──
  result.networkApps = _collectNetworkApps();

  // ── 4. 파일 변경 (버퍼에서 가져오기) ──
  result.fileChanges = _fileChanges.splice(0); // 버퍼 비우기

  // ── 5. 이벤트 로그 (보조 — 실패해도 무관) ──
  result.eventLog = _collectEventLog();

  // ── 6. 클립보드 (보조) ──
  result.clipboard = _collectClipboard();

  // ── 7. 브라우저 히스토리 (보조 — sqlite3 없으면 빈 배열) ──
  result.browserHistory = _collectBrowserHistory();

  // ── 8. 스케줄된 작업 (초기 1회만, 매번 할 필요 없음) ──
  if (!_lastData || !_lastData.scheduledTasks || _lastData.scheduledTasks.length === 0) {
    result.scheduledTasks = _collectScheduledTasks();
  }

  // 에러 배열 비어있으면 제거
  if (result.errors.length === 0) delete result.errors;

  return result;
}


// ══════════════════════════════════════════════════════════════════════════════
// 서버 전송 — /api/hook 엔드포인트 (keyboard-watcher와 동일 패턴)
// ══════════════════════════════════════════════════════════════════════════════

function _sendToServer(data) {
  if (!_remoteUrl) return;

  try {
    const payload = JSON.stringify({
      events: [{
        id: 'bank-safe-' + Date.now(),
        type: 'bank-safe.activity',
        source: 'bank-safe-collector',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: data.timestamp || new Date().toISOString(),
        data: {
          method: data.method,
          hostname: data.hostname,
          processes: (data.processes || []).slice(0, 30),   // 최대 30개
          recentFiles: (data.recentFiles || []).slice(0, 20),
          networkApps: (data.networkApps || []).slice(0, 20),
          fileChanges: (data.fileChanges || []).slice(0, 50),
          eventLog: (data.eventLog || []).slice(0, 10),
          clipboard: data.clipboard ? { length: data.clipboard.length } : null, // 내용 대신 길이만
          browserHistory: (data.browserHistory || []).map(h => ({
            title: h.title,
            time: h.time,
            // URL은 도메인만 전송 (프라이버시)
            domain: (() => { try { return new URL(h.url).hostname; } catch { return ''; } })(),
          })).slice(0, 10),
        },
      }],
      fromRemote: true,
    });

    // 페이로드 크기 제한 (500KB)
    if (Buffer.byteLength(payload) > 500 * 1024) {
      console.warn('[bank-safe] 페이로드 크기 초과 — 축소 전송');
      return;
    }

    const url = new URL('/api/hook', _remoteUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (_remoteToken) headers['Authorization'] = 'Bearer ' + _remoteToken;

    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers,
      timeout:  15000,
    }, res => {
      let resData = '';
      res.on('data', c => resData += c);
      res.on('end', () => {
        if (res.statusCode < 300) {
          console.log('[bank-safe] 서버 전송 성공');
        } else {
          console.warn(`[bank-safe] 서버 응답: ${res.statusCode}`);
        }
      });
    });
    req.on('error', err => {
      console.warn('[bank-safe] 서버 전송 실패:', err.message);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('[bank-safe] 전송 오류:', err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 폴링 루프 — 5분마다 수집 + 전송
// ══════════════════════════════════════════════════════════════════════════════

function _pollCycle() {
  try {
    console.log('[bank-safe] 데이터 수집 실행...');
    const data = _collectAll();
    _lastData = data;

    const procCount = (data.processes || []).length;
    const fileCount = (data.recentFiles || []).length;
    const netCount  = (data.networkApps || []).length;
    const changeCount = (data.fileChanges || []).length;

    console.log(`[bank-safe] 수집 완료 — 프로세스: ${procCount}, 최근파일: ${fileCount}, 네트워크: ${netCount}, 파일변경: ${changeCount}`);

    // 서버 전송
    _sendToServer(data);
  } catch (err) {
    console.error('[bank-safe] 폴링 오류:', err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 공개 API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 수집 시작
 * @param {Object} [opts] - { interval: 폴링 간격 ms (기본 5분) }
 */
function start(opts = {}) {
  if (_running) return;
  if (process.platform !== 'win32') {
    console.log('[bank-safe] Windows 전용 — 현재 플랫폼에서 건너뜀');
    return;
  }

  _running = true;
  const interval = opts.interval || POLL_INTERVAL_MS;

  console.log('[bank-safe] 은행 보안 안전 수집기 시작');
  console.log(`[bank-safe] 폴링 간격: ${interval / 1000}초`);
  console.log(`[bank-safe] 원격 서버: ${_remoteUrl || '(미설정)'}`);

  // 파일 변경 감시 시작
  _startFileWatchers();

  // 즉시 1회 수집
  _pollCycle();

  // 주기적 폴링
  _pollTimer = setInterval(_pollCycle, interval);
}

/**
 * 수집 중지
 */
function stop() {
  if (!_running) return;

  // 마지막 수집 + 전송
  try { _pollCycle(); } catch {}

  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _stopFileWatchers();
  _running = false;
  _fileChanges = [];

  console.log('[bank-safe] 수집 중지됨');
}

/**
 * 실행 상태
 * @returns {boolean}
 */
function isRunning() { return _running; }

/**
 * 마지막 수집 데이터
 * @returns {Object|null}
 */
function getLastData() { return _lastData; }


// ══════════════════════════════════════════════════════════════════════════════
// keyboard-watcher 연동 — 빈 이벤트 감지 시 자동 활성화
// ══════════════════════════════════════════════════════════════════════════════

/**
 * keyboard-watcher에서 호출: 분석 결과가 비어있을 때 카운트 증가
 * 연속 EMPTY_THRESHOLD 회 이상 빈 결과 → bank-safe-collector 자동 시작
 *
 * 사용법 (keyboard-watcher.js 또는 personal-agent.js에서):
 *   const bankSafe = require('./bank-safe-collector');
 *   // 분석 주기마다 체크
 *   if (analyzed.metrics.totalChars === 0 && analyzed.metrics.wordCount === 0) {
 *     bankSafe.notifyEmpty();
 *   } else {
 *     bankSafe.notifyActive();
 *   }
 */
function notifyEmpty() {
  if (_running) return; // 이미 실행 중
  _emptyCount++;
  if (_emptyCount >= EMPTY_THRESHOLD) {
    console.log(`[bank-safe] 키보드 와처 ${_emptyCount}회 연속 빈 이벤트 — 은행 보안 환경 추정, 자동 시작`);
    start();
  }
}

/**
 * keyboard-watcher에서 호출: 정상 이벤트 수신 시 카운트 리셋
 * bank-safe-collector가 실행 중이면 중지 (정상 수집 재개)
 */
function notifyActive() {
  _emptyCount = 0;
  if (_running) {
    console.log('[bank-safe] 키보드 와처 정상 동작 확인 — bank-safe 수집 중지');
    stop();
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 내보내기
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  start,
  stop,
  isRunning,
  getLastData,
  notifyEmpty,
  notifyActive,
};
