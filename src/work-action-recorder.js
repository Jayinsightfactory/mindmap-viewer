'use strict';
/**
 * work-action-recorder.js — nenova.exe 행동순서 캡쳐 사이드카 감시자 (추가·격리 모듈)
 *
 * 기존 screen/keyboard/uia-recorder 수집·업로드 코드는 건드리지 않는다. 이 모듈은:
 *  1) 네이티브 사이드카(win-action-spy.exe, x86 SetWinEventHook)를 자식으로 띄우고 감시·재기동
 *  2) 사이드카가 쓴 개인정보-안전 JSONL 을 tail 해서 work.action 이벤트로 기존 업로드 파이프라인에 실어보냄
 *  3) 사이드카의 CPU/메모리 자기측정(__perf)을 노출(heartbeat/perf-selfcheck 소비)
 *
 * 실패 격리: 컴파일 실패/미기동/크래시여도 throw 하지 않는다 — 데몬 기존 동작 무영향.
 * 기능 플래그: config.workActionRecorder===false 또는 env WORK_ACTION=off 이면 비활성.
 *
 * ⚠️ 개인정보: 사이드카는 get_accValue 를 호출하지 않아 입력값/셀내용을 구조적으로 수집 못 함.
 *    여기서도 캡쳐 name(컨트롤 캡션/라벨)만 전달한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let _child = null;
let _opts = null;
let _state = 'init';          // init|disabled|compiling|running|crashed|stopped
let _exePath = null;
let _jsonlPath = null;
let _controlPath = null;
let _tailOffset = 0;
let _tailTimer = null;
let _restartTimer = null;
let _restarts = [];           // 최근 재기동 타임스탬프(폭주 방지)
let _buf = [];                // 전송 대기 work.action
let _flushTimer = null;
let _events = 0, _emitted = 0, _sent = 0;
let _lastEventAt = null;
let _sidecarPerf = null;      // { cpuPct, wsMB, hooked, targets, t }
let _stopped = false;

const ORBIT_DIR = path.join(os.homedir(), '.orbit');
const BIN_DIR = path.join(ORBIT_DIR, 'bin');
const WORK_DIR = path.join(ORBIT_DIR, 'work-actions');
const FLUSH_MS = 5000;
const MAX_BATCH = 60;

function _log(msg) { try { console.log('[work-action] ' + msg); } catch {} }

function _findCsc() {
  const bases = [
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  ];
  for (const b of bases) { try { if (fs.existsSync(b)) return b; } catch {} }
  return null;
}
function _findAccessibilityDll() {
  // 프레임워크 디렉토리의 Accessibility.dll (GAC 중복 interop 에러 회피 위해 명시 경로 사용)
  const bases = [
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\Accessibility.dll',
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\Accessibility.dll',
  ];
  for (const b of bases) { try { if (fs.existsSync(b)) return b; } catch {} }
  return null;
}

// 소스 → exe 컴파일(없거나 소스가 더 최신일 때만). 실패해도 throw 안 함.
function _ensureExe(root) {
  const src = path.join(root, 'src', 'win-action-spy.cs');
  const exe = path.join(BIN_DIR, 'win-action-spy.exe');
  try {
    if (!fs.existsSync(src)) { _log('소스 없음: ' + src); return null; }
    let needBuild = true;
    try {
      if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(src).mtimeMs) needBuild = false;
    } catch {}
    if (!needBuild) return exe;

    const csc = _findCsc();
    const acc = _findAccessibilityDll();
    if (!csc || !acc) { _log('csc/Accessibility.dll 없음 — 컴파일 불가'); return fs.existsSync(exe) ? exe : null; }
    fs.mkdirSync(BIN_DIR, { recursive: true });
    _state = 'compiling';
    // x86 + /noconfig + System.Core(HashSet) + 명시 Accessibility.dll
    execFileSync(csc, [
      '/nologo', '/noconfig', '/platform:x86', '/target:exe',
      '/reference:System.dll', '/reference:System.Core.dll', '/reference:' + acc,
      '/out:' + exe, src,
    ], { timeout: 60000, windowsHide: true, stdio: 'pipe' });
    _log('컴파일 완료: ' + exe);
    return fs.existsSync(exe) ? exe : null;
  } catch (e) {
    _log('컴파일 실패(계속): ' + (e && e.message));
    try { if (fs.existsSync(exe)) return exe; } catch {}
    return null;
  }
}

function _procNamesCsv() {
  // 관찰대상 프로세스명(확장자 제외). 기본 nenova. config.workActionProcs 로 확장 가능.
  let names = ['nenova'];
  try {
    const c = _opts && _opts.config && _opts.config.workActionProcs;
    if (Array.isArray(c) && c.length) names = c;
    else if (typeof c === 'string' && c.trim()) names = c.split(',').map(s => s.trim()).filter(Boolean);
  } catch {}
  return names.join(',');
}

function _spawnSidecar() {
  if (_stopped) return;
  if (!_exePath) { _state = 'disabled'; return; }
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    _jsonlPath = path.join(WORK_DIR, 'actions-' + Date.now() + '.jsonl');
    _controlPath = path.join(WORK_DIR, 'control');
    try { fs.writeFileSync(_controlPath, 'run'); } catch {}
    _tailOffset = 0;
    const maxMin = (_opts && _opts.maxMinutes) ? String(_opts.maxMinutes) : '0';
    _child = spawn(_exePath, [_jsonlPath, _controlPath, String(process.pid), _procNamesCsv(), maxMin],
      { detached: false, stdio: 'ignore', windowsHide: true });
    _state = 'running';
    _log('사이드카 시작 pid=' + _child.pid + ' → ' + path.basename(_jsonlPath));
    _child.on('exit', (code) => {
      _child = null;
      if (_stopped) { _state = 'stopped'; return; }
      _state = 'crashed';
      _log('사이드카 종료 code=' + code + ' — 재기동 예약');
      _scheduleRestart();
    });
    _child.on('error', (e) => { _log('사이드카 spawn 오류: ' + (e && e.message)); });
    _startTail();
  } catch (e) {
    _log('사이드카 시작 실패(계속): ' + (e && e.message));
    _state = 'crashed';
    _scheduleRestart();
  }
}

function _scheduleRestart() {
  if (_stopped) return;
  const now = Date.now();
  _restarts = _restarts.filter(t => now - t < 60 * 60 * 1000);
  // 시간당 10회 초과 재기동 폭주 방지 → 15분 백오프
  const delay = _restarts.length >= 10 ? 15 * 60 * 1000 : 10 * 1000;
  _restarts.push(now);
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(() => { _restartTimer = null; _spawnSidecar(); }, delay);
}

function _startTail() {
  if (_tailTimer) return;
  _tailTimer = setInterval(_drainJsonl, 2000);
  if (!_flushTimer) _flushTimer = setInterval(_flush, FLUSH_MS);
}

function _drainJsonl() {
  try {
    if (!_jsonlPath || !fs.existsSync(_jsonlPath)) return;
    const size = fs.statSync(_jsonlPath).size;
    if (size <= _tailOffset) return;
    const fd = fs.openSync(_jsonlPath, 'r');
    try {
      const len = size - _tailOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, _tailOffset);
      _tailOffset = size;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.kind === '__perf') { _sidecarPerf = obj; continue; }
        if (obj.kind === '__end') continue;
        if (!obj.ev) continue;
        _events++;
        _emitted++;
        _lastEventAt = obj.t || new Date().toISOString();
        _buf.push({
          seq: obj.seq, t: obj.t, ev: obj.ev,
          role: obj.role, name: obj.name,
          hostname: os.hostname(),
        });
        if (_buf.length >= MAX_BATCH) _flush();
      }
    } finally { fs.closeSync(fd); }
  } catch (e) { /* tail 실패는 조용히 — 다음 주기 재시도 */ }
}

function _flush() {
  if (!_buf.length) return;
  const steps = _buf.splice(0, _buf.length);
  try {
    if (_opts && typeof _opts.report === 'function') { _opts.report('work.action', steps); _sent += steps.length; }
  } catch (e) { _log('전송 실패(버퍼폐기 방지 위해 재큐): ' + (e && e.message)); _buf.unshift(...steps); }
}

// perf-selfcheck 가 과부하 판정 시 호출 → 사이드카 훅 일시정지/재개
function setPaused(paused) {
  try { if (_controlPath) fs.writeFileSync(_controlPath, paused ? 'pause' : 'run'); } catch {}
}

function getStatus() {
  const base = { state: _state, events: _events, emitted: _emitted, sent: _sent, lastEventAt: _lastEventAt };
  if (_state === 'disabled' || _state === 'init') return base;
  base.pid = _child ? _child.pid : null;
  base.sidecar = _sidecarPerf ? {
    cpuPct: _sidecarPerf.cpuPct, wsMB: _sidecarPerf.wsMB,
    hooked: _sidecarPerf.hooked, targets: _sidecarPerf.targets, t: _sidecarPerf.t,
  } : null;
  return base;
}

function start(opts) {
  _opts = opts || {};
  _stopped = false;
  try {
    if (process.platform !== 'win32') { _state = 'disabled'; _log('Windows 전용 — 비활성'); return; }
    const cfg = _opts.config || {};
    if (cfg.workActionRecorder === false || process.env.WORK_ACTION === 'off') {
      _state = 'disabled'; _log('기능 플래그 off — 비활성'); return;
    }
    const root = _opts.root || path.resolve(__dirname, '..');
    _exePath = _ensureExe(root);
    if (!_exePath) { _state = 'disabled'; _log('exe 준비 실패 — 비활성(데몬 영향 없음)'); return; }
    _spawnSidecar();
  } catch (e) {
    _state = 'disabled';
    _log('start 실패(계속): ' + (e && e.message));
  }
}

function stop() {
  _stopped = true;
  _state = 'stopped';
  try { if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; } } catch {}
  try { if (_tailTimer) { clearInterval(_tailTimer); _tailTimer = null; } } catch {}
  try { _drainJsonl(); _flush(); } catch {}
  try { if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; } } catch {}
  try { if (_child) _child.kill(); } catch {}
  _child = null;
}

module.exports = { start, stop, getStatus, setPaused };
