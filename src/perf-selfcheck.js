'use strict';
/**
 * perf-selfcheck.js — 성능 자기점검 (사장 명시 요구, 추가·격리 모듈)
 *
 * 기존 daemon-health 텔레메트리(RSS/RAM/cpuCount/governor)와 메모리 워치독을 대체하지 않고
 * 그 옆에 다음을 덧붙인다:
 *   1) CPU 자기측정 — 데몬 프로세스 + 사이드카 프로세스의 CPU%·메모리를 실측
 *   2) "PC 느림이 우리 탓이냐" 판정 — 우리 두 프로세스 점유 vs 시스템 전체(governor) 비교.
 *      임계 초과가 지속되면 사이드카를 자동 스로틀(pause)하고 daemon.perf.alert 보고.
 *   3) 업데이트 성능 재점검 게이트 — 코드세대(codeVersion)별 정상상태 스냅샷을 파일에 남겨,
 *      업데이트(=코드세대 변경)마다 전/후 CPU·RSS·핸들을 비교해 회귀를 daemon.perf.gate 로 보고.
 *
 * 시스템 전체 CPU 는 resource-governor 가 이미 os.cpus() 델타로 측정하므로 재발명하지 않고
 * getSystemCpu() 로 주입받아 쓴다. 여기서는 '우리 프로세스' CPU 만 새로 측정한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TICK_MS = 30 * 1000;
const WARMUP_MS = 120 * 1000;      // 기동 직후 모듈 로드 피크 제외(정상상태 측정)
const EMA_ALPHA = 0.4;
// 판정 임계(우리 프로세스 CPU 총합). 데몬은 below-normal 우선순위라 여유롭게 잡는다.
const OUR_CPU_SOFT = 25;           // 우리 CPU% 가 이 이상 2회 연속 → 스로틀
const OUR_CPU_RESUME = 12;         // 이 아래로 떨어지면 해제
const SYS_BUSY = 75;               // 시스템 전체가 바쁠 때(이때만 '우리 탓' 공유율 따짐)
const OUR_SHARE = 0.5;             // 바쁜 시스템에서 우리가 절반 이상 차지하면 우리 탓

const BASELINE_FILE = path.join(os.homedir(), '.orbit', 'perf-baseline.json');

let _opts = null;
let _timer = null;
let _prevCpuUsage = null;          // process.cpuUsage()
let _prevHr = null;                // process.hrtime.bigint 대신 Date 기반
let _emaDaemonCpu = 0;
let _latest = null;
let _throttled = false;
let _overHits = 0;
let _startedAt = Date.now();
let _gateDone = false;

function _log(msg) { try { console.log('[perf-selfcheck] ' + msg); } catch {} }

function _daemonCpuPct() {
  try {
    const now = Date.now();
    const cu = process.cpuUsage(); // microseconds (user+system, 누적)
    if (!_prevCpuUsage) { _prevCpuUsage = cu; _prevHr = now; return 0; }
    const dUser = cu.user - _prevCpuUsage.user;
    const dSys = cu.system - _prevCpuUsage.system;
    const dWallMs = now - _prevHr;
    _prevCpuUsage = cu; _prevHr = now;
    const cores = Math.max(1, os.cpus().length);
    if (dWallMs <= 0) return 0;
    const pct = ((dUser + dSys) / 1000) / (dWallMs * cores) * 100;
    return pct < 0 ? 0 : Math.round(pct * 100) / 100;
  } catch { return 0; }
}

function _handleCount() {
  try {
    if (typeof process._getActiveHandles === 'function') return process._getActiveHandles().length;
  } catch {}
  try { return process.getActiveResourcesInfo().length; } catch {}
  return 0;
}

function _codeVersion() {
  try { if (_opts && typeof _opts.getCodeVersion === 'function') return _opts.getCodeVersion() || 'unknown'; } catch {}
  return 'unknown';
}

function _snapshot() {
  const mu = process.memoryUsage();
  const sidecar = (() => { try { return _opts.getSidecar ? _opts.getSidecar() : null; } catch { return null; } })();
  return {
    daemonCpuPct: Math.round(_emaDaemonCpu * 100) / 100,
    daemonRssMB: Math.round(mu.rss / 1024 / 1024),
    handles: _handleCount(),
    sidecarCpuPct: sidecar ? (sidecar.cpuPct || 0) : null,
    sidecarWsMB: sidecar ? (sidecar.wsMB || 0) : null,
    t: new Date().toISOString(),
  };
}

function _readBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; }
}
function _writeBaseline(obj) {
  try { fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true }); fs.writeFileSync(BASELINE_FILE, JSON.stringify(obj)); } catch {}
}

// 업데이트 게이트: 코드세대가 저장본과 다르면(=업데이트 발생) 전/후 비교 보고. 기동당 1회.
function _runUpdateGate(snap) {
  if (_gateDone) return;
  _gateDone = true;
  const version = _codeVersion();
  const prev = _readBaseline();
  try {
    if (prev && prev.codeVersion && prev.codeVersion !== version && prev.snapshot) {
      const before = prev.snapshot, after = snap;
      const regressions = [];
      const grew = (a, b, absMin, relMin) => (b != null && a != null && b - a >= absMin && b >= a * relMin);
      if (grew(before.daemonCpuPct, after.daemonCpuPct, 10, 1.5)) regressions.push('daemonCpu ' + before.daemonCpuPct + '→' + after.daemonCpuPct + '%');
      if (grew(before.daemonRssMB, after.daemonRssMB, 300, 1.3)) regressions.push('daemonRss ' + before.daemonRssMB + '→' + after.daemonRssMB + 'MB');
      if (grew(before.handles, after.handles, 50, 1.5)) regressions.push('handles ' + before.handles + '→' + after.handles);
      if (grew(before.sidecarCpuPct, after.sidecarCpuPct, 8, 1.5)) regressions.push('sidecarCpu ' + before.sidecarCpuPct + '→' + after.sidecarCpuPct + '%');
      if (grew(before.sidecarWsMB, after.sidecarWsMB, 80, 1.5)) regressions.push('sidecarWs ' + before.sidecarWsMB + '→' + after.sidecarWsMB + 'MB');
      _report('daemon.perf.gate', {
        prevVersion: prev.codeVersion, version,
        before, after,
        regression: regressions.length > 0,
        regressions,
      });
      _log('업데이트 성능 게이트: ' + prev.codeVersion + '→' + version + ' 회귀=' + (regressions.length ? regressions.join('; ') : '없음'));
    }
  } catch (e) { _log('게이트 비교 실패: ' + (e && e.message)); }
  _writeBaseline({ codeVersion: version, snapshot: snap, prevSnapshot: prev ? prev.snapshot : null });
}

function _report(type, data) {
  try { if (_opts && typeof _opts.report === 'function') _opts.report(type, { ...data, hostname: os.hostname() }); } catch {}
}

function _tick() {
  try {
    const dCpu = _daemonCpuPct();
    _emaDaemonCpu = _emaDaemonCpu === 0 ? dCpu : EMA_ALPHA * dCpu + (1 - EMA_ALPHA) * _emaDaemonCpu;

    const sidecar = (() => { try { return _opts.getSidecar ? _opts.getSidecar() : null; } catch { return null; } })();
    const sideCpu = sidecar && sidecar.cpuPct ? sidecar.cpuPct : 0;
    const ourCpu = Math.round((_emaDaemonCpu + sideCpu) * 100) / 100;
    const sysCpu = (() => { try { return _opts.getSystemCpu ? (_opts.getSystemCpu() || 0) : 0; } catch { return 0; } })();

    // "우리 탓" 판정: 우리 CPU 과다 OR (시스템이 바쁜데 그 중 우리 비중이 큼)
    const share = sysCpu > 0 ? ourCpu / sysCpu : 0;
    const ourFault = (ourCpu >= OUR_CPU_SOFT) || (sysCpu >= SYS_BUSY && share >= OUR_SHARE);

    if (!_throttled) {
      _overHits = ourFault ? _overHits + 1 : 0;
      if (_overHits >= 2) {
        _throttled = true;
        try { if (_opts.onThrottle) _opts.onThrottle(true); } catch {}
        _report('daemon.perf.alert', {
          action: 'throttle', reason: 'our-cpu-high',
          daemonCpuPct: _emaDaemonCpu, sidecarCpuPct: sideCpu, ourCpuPct: ourCpu, systemCpuPct: sysCpu, ourShare: Math.round(share * 100) / 100,
        });
        _log('과부하 — 사이드카 스로틀(pause). ourCpu=' + ourCpu + '% sys=' + sysCpu + '%');
      }
    } else if (ourCpu <= OUR_CPU_RESUME) {
      _throttled = false; _overHits = 0;
      try { if (_opts.onThrottle) _opts.onThrottle(false); } catch {}
      _report('daemon.perf.alert', { action: 'resume', daemonCpuPct: _emaDaemonCpu, sidecarCpuPct: sideCpu, ourCpuPct: ourCpu, systemCpuPct: sysCpu });
      _log('부하 해제 — 사이드카 재개. ourCpu=' + ourCpu + '%');
    }

    _latest = {
      daemonCpuPct: Math.round(_emaDaemonCpu * 100) / 100,
      daemonRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      handles: _handleCount(),
      sidecarCpuPct: sideCpu, sidecarWsMB: sidecar ? (sidecar.wsMB || 0) : null,
      ourCpuPct: ourCpu, systemCpuPct: sysCpu, ourShare: Math.round(share * 100) / 100,
      throttled: _throttled, t: new Date().toISOString(),
    };

    // 워밍업 후 1회: 정상상태 스냅샷 → 업데이트 게이트 실행 + 베이스라인 갱신
    if (!_gateDone && (Date.now() - _startedAt) >= WARMUP_MS) {
      _runUpdateGate(_snapshot());
    }
  } catch (e) { _log('tick 실패: ' + (e && e.message)); }
}

function getStatus() { return _latest; }

function start(opts) {
  _opts = opts || {};
  try {
    _prevCpuUsage = process.cpuUsage();
    _prevHr = Date.now();
    _startedAt = Date.now();
    if (_timer) clearInterval(_timer);
    _timer = setInterval(_tick, TICK_MS);
    _log('시작 — CPU 자기측정/느림판정/업데이트게이트');
  } catch (e) { _log('start 실패(계속): ' + (e && e.message)); }
}

function stop() { try { if (_timer) { clearInterval(_timer); _timer = null; } } catch {} }

module.exports = { start, stop, getStatus };
