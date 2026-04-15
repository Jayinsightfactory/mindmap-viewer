/**
 * win-shell — Windows에서 long-lived PowerShell process 1개를 띄워
 *             stdin/stdout으로 명령을 송수신. 매 호출마다 콘솔 창이 깜빡이는
 *             execSync('powershell ...') 패턴을 대체하기 위한 모듈.
 *
 * 설계 원칙:
 * - PowerShell 프로세스는 데몬 lifetime 동안 1개만 유지
 * - spawn('powershell.exe', ['-Command', '-']) + windowsHide:true → 새 콘솔 창 생성 X
 * - 명령은 큐에 직렬화 (한 번에 하나씩 처리) — 응답 파싱 단순화
 * - 응답 끝은 sentinel 문자열로 구분
 * - PowerShell 프로세스 죽으면 다음 호출 시 자동 재시작
 * - Windows가 아니면 모든 호출이 즉시 reject (caller가 폴백 처리)
 */

const { spawn } = require('child_process');
const os = require('os');

const SENTINEL = '__ORBIT_PS_END__';
const SPAWN_TIMEOUT_MS = 8000; // 5s → 8s (타임아웃으로 인한 과도한 재시작 방지)

let _ps = null;
let _stdoutBuf = '';
let _stderrBuf = '';
let _pending = null;          // { resolve, reject, timer }
let _queue = [];              // [{ cmd, resolve, reject, timeoutMs }]
let _starting = false;
let _initFailed = false;       // 초기화 영구 실패 시 true (caller가 폴백 사용)

function isAvailable() {
  return os.platform() === 'win32' && !_initFailed;
}

function _kill() {
  if (_ps) {
    try { _ps.kill(); } catch {}
    _ps = null;
  }
  _stdoutBuf = '';
  _stderrBuf = '';
  if (_pending) {
    if (_pending.timer) clearTimeout(_pending.timer);
    _pending.reject(new Error('ps process killed'));
    _pending = null;
  }
}

function _spawn() {
  if (_ps || _starting || os.platform() !== 'win32') return;
  _starting = true;
  try {
    _ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-',
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    _ps.stdout.setEncoding('utf8');
    _ps.stderr.setEncoding('utf8');

    _ps.stdout.on('data', (chunk) => {
      _stdoutBuf += chunk;
      _drainStdout();
    });

    _ps.stderr.on('data', (chunk) => {
      _stderrBuf += chunk;
      // stderr만 무한정 자라지 않게 자름
      if (_stderrBuf.length > 4096) _stderrBuf = _stderrBuf.slice(-2048);
    });

    _ps.on('error', (err) => {
      console.warn('[win-shell] spawn error:', err.message);
      _kill();
      _initFailed = true;
    });

    // stdin/stdout/stderr EPIPE 크래시 방지 — 프로세스 죽어도 write 시도 안전하게
    _ps.stdin.on('error', (err) => {
      console.warn('[win-shell] stdin error (ignored):', err.code || err.message);
    });
    _ps.stdout.on('error', () => {});
    _ps.stderr.on('error', () => {});

    _ps.on('exit', (code) => {
      console.warn(`[win-shell] ps exited (code=${code})`);
      _ps = null;
      if (_pending) {
        if (_pending.timer) clearTimeout(_pending.timer);
        _pending.reject(new Error('ps exited'));
        _pending = null;
      }
    });

    // UTF-8 출력 강제 (한글 윈도우 타이틀 처리)
    _ps.stdin.write('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n');
    _ps.stdin.write('$ErrorActionPreference="SilentlyContinue"\n');
  } catch (err) {
    console.warn('[win-shell] spawn failed:', err.message);
    _initFailed = true;
    _ps = null;
  } finally {
    _starting = false;
  }
}

function _drainStdout() {
  if (!_pending) return;
  const idx = _stdoutBuf.indexOf(SENTINEL);
  if (idx < 0) return;
  const result = _stdoutBuf.slice(0, idx).trim();
  _stdoutBuf = _stdoutBuf.slice(idx + SENTINEL.length);
  const cb = _pending;
  _pending = null;
  if (cb.timer) clearTimeout(cb.timer);
  cb.resolve(result);
  _processQueue();
}

function _processQueue() {
  if (_pending || _queue.length === 0) return;
  const next = _queue.shift();
  _send(next.cmd, next.timeoutMs, next.resolve, next.reject);
}

function _send(cmd, timeoutMs, resolve, reject) {
  if (!_ps) _spawn();
  if (!_ps || _initFailed) {
    reject(new Error('win-shell unavailable'));
    return;
  }
  const timer = setTimeout(() => {
    if (_pending && _pending.resolve === resolve) {
      console.warn('[win-shell] cmd timeout:', cmd.slice(0, 80));
      _pending = null;
      reject(new Error('win-shell timeout'));
      // 타임아웃 시 process 유지 — 재시작하면 conhost 깜빡임 + EPIPE 유발
      // stdout 버퍼 정리만 하고 다음 명령에서 sentinel 다시 찾도록 함
      _stdoutBuf = '';
      _processQueue();
    }
  }, timeoutMs);
  _pending = { resolve, reject, timer };
  try {
    // 명령 실행 후 sentinel 출력 → 응답 끝 식별
    _ps.stdin.write(`try { ${cmd} } catch {}; Write-Output "${SENTINEL}"\n`);
  } catch (err) {
    if (timer) clearTimeout(timer);
    _pending = null;
    reject(err);
  }
}

/**
 * PowerShell 명령을 비동기 실행
 * @param {string} cmd  PowerShell command (single line preferred)
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<string>}  trimmed stdout
 */
function exec(cmd, timeoutMs = SPAWN_TIMEOUT_MS) {
  if (os.platform() !== 'win32') return Promise.reject(new Error('win-shell: not windows'));
  if (_initFailed) return Promise.reject(new Error('win-shell: init failed'));
  return new Promise((resolve, reject) => {
    if (_pending || _queue.length > 0) {
      _queue.push({ cmd, timeoutMs, resolve, reject });
      return;
    }
    _send(cmd, timeoutMs, resolve, reject);
  });
}

function shutdown() {
  _kill();
  _initFailed = false;
}

module.exports = { exec, isAvailable, shutdown };
