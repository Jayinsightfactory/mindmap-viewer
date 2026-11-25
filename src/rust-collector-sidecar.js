'use strict';
/**
 * rust-collector-sidecar.js — Phase 1 카나리 1대 Opt-in Rust 수집기 사이드카 래퍼
 *
 * 안전 원칙:
 *  1) 100% DEFAULT OFF:
 *     config.rustCollector === true || env.ORBIT_RUST_COLLECTOR === '1'
 *     AND 바이너리(~/.orbit/bin/orbit-collector-rs.exe) 실존 시에만 스폰한다.
 *  2) 미설정 또는 바이너리 미존재 시 즉시 Node 기존 경로(screen-capture.js / local-buffer.js) 유지.
 *  3) 서킷브레이커: 5분(300,000ms) 내 3회 이상 크래시/스폰 실패 시 세션 동안 영구 오픈하고
 *     onFallback()을 즉시 호출해 100% Node 경로로 무중단 폴백한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');

const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_RESPAWN_BACKOFF_MS = 2000;

function isOptedIn(config, env) {
  const cfgOn = !!(config && config.rustCollector === true);
  const envOn = !!(env && env.ORBIT_RUST_COLLECTOR === '1');
  return cfgOn || envOn;
}

function resolveBinaryPath(opts = {}) {
  if (opts.binaryPath) return opts.binaryPath;
  const env = opts.env || process.env;
  if (env && env.ORBIT_RUST_COLLECTOR_BIN) return env.ORBIT_RUST_COLLECTOR_BIN;
  const home = opts.homeDir || os.homedir();
  return path.join(home, '.orbit', 'bin', 'orbit-collector-rs.exe');
}

function createSidecar(deps = {}) {
  const spawnFn = deps.spawn || defaultSpawn;
  const existsSyncFn = deps.existsSync || fs.existsSync;
  const nowFn = deps.now || Date.now;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;

  let _child = null;
  let _opts = null;
  let _state = 'disabled'; // disabled | fallback_node | running | restarting | circuit_open | stopped
  let _binaryPath = null;
  let _optedIn = false;
  let _active = false;
  let _stopped = false;
  let _circuitOpen = false;
  let _fallbackTriggered = false;
  let _crashTimestamps = [];
  let _totalCrashes = 0;
  let _lastExitCode = null;
  let _lastError = null;
  let _respawnTimer = null;

  function _pruneCrashes(now) {
    const winMs = (_opts && _opts.circuitWindowMs) || DEFAULT_CIRCUIT_WINDOW_MS;
    _crashTimestamps = _crashTimestamps.filter((ts) => now - ts <= winMs);
  }

  function _triggerFallback(reason) {
    if (_fallbackTriggered) return;
    _fallbackTriggered = true;
    _active = false;
    try {
      if (_opts && typeof _opts.reportEvent === 'function') {
        _opts.reportEvent('daemon.rust_collector.fallback', {
          reason,
          state: _state,
          crashesInWindow: _crashTimestamps.length,
          totalCrashes: _totalCrashes,
          lastExitCode: _lastExitCode,
          lastError: _lastError,
        });
      }
    } catch {}
    try {
      if (_opts && typeof _opts.onFallback === 'function') {
        _opts.onFallback({
          reason,
          state: _state,
          crashesInWindow: _crashTimestamps.length,
          totalCrashes: _totalCrashes,
          lastExitCode: _lastExitCode,
          lastError: _lastError,
        });
      }
    } catch {}
  }

  function _recordFailure(exitCode, errMsg) {
    if (_stopped || _circuitOpen) return;
    const now = nowFn();
    _totalCrashes += 1;
    _lastExitCode = exitCode !== undefined ? exitCode : null;
    if (errMsg) _lastError = String(errMsg);
    _crashTimestamps.push(now);
    _pruneCrashes(now);

    const threshold = (_opts && _opts.circuitThreshold) || DEFAULT_CIRCUIT_THRESHOLD;
    if (_crashTimestamps.length >= threshold) {
      _circuitOpen = true;
      _state = 'circuit_open';
      if (_respawnTimer) {
        clearTimer(_respawnTimer);
        _respawnTimer = null;
      }
      _triggerFallback('circuit_breaker_open');
      return;
    }

    _state = 'restarting';
    const baseBackoff = (_opts && _opts.respawnBackoffMs != null)
      ? _opts.respawnBackoffMs
      : DEFAULT_RESPAWN_BACKOFF_MS;
    const delay = Math.max(0, baseBackoff * _crashTimestamps.length);
    if (_respawnTimer) clearTimer(_respawnTimer);
    _respawnTimer = setTimer(() => {
      _respawnTimer = null;
      if (!_stopped && !_circuitOpen) _spawnOnce();
    }, delay);
    if (_respawnTimer && typeof _respawnTimer.unref === 'function') {
      _respawnTimer.unref();
    }
  }

  function _spawnOnce() {
    if (_stopped || _circuitOpen || !_binaryPath) return false;
    const args = [];
    if (_opts && _opts.dryRun) args.push('--dry-run');
    if (_opts && Array.isArray(_opts.extraArgs)) args.push(..._opts.extraArgs);

    const baseEnv = (_opts && _opts.env) || process.env;
    const childEnv = {
      ...baseEnv,
      COLL_SERVER: (_opts && _opts.serverUrl) || baseEnv.COLL_SERVER || baseEnv.ORBIT_SERVER_URL || '',
      COLL_TOKEN: (_opts && _opts.token) || baseEnv.COLL_TOKEN || baseEnv.ORBIT_TOKEN || '',
      COLL_USER: (_opts && _opts.userId) || baseEnv.COLL_USER || baseEnv.ORBIT_USER_ID || os.hostname(),
    };
    if (_opts && _opts.capdir) childEnv.COLL_CAPDIR = _opts.capdir;

    let handledFailure = false;
    const onFailOnce = (code, errMsg) => {
      if (handledFailure) return;
      handledFailure = true;
      _child = null;
      _recordFailure(code, errMsg);
    };

    try {
      const child = spawnFn(_binaryPath, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv,
      });
      _child = child;
      _state = 'running';
      _active = true;

      if (child && typeof child.on === 'function') {
        child.on('error', (err) => {
          onFailOnce(null, err && err.message ? err.message : String(err));
        });
        child.on('exit', (code, signal) => {
          if (_stopped) {
            _child = null;
            return;
          }
          onFailOnce(code, signal ? `signal:${signal}` : `exit:${code}`);
        });
      }
      return true;
    } catch (err) {
      onFailOnce(null, err && err.message ? err.message : String(err));
      return false;
    }
  }

  function start(opts = {}) {
    _opts = opts;
    _stopped = false;
    const env = opts.env || process.env;
    const config = opts.config || {};
    _optedIn = isOptedIn(config, env);
    _binaryPath = resolveBinaryPath(opts);

    if (!_optedIn) {
      _state = 'disabled';
      _active = false;
      return { active: false, state: _state, reason: 'opt_in_disabled', binaryPath: _binaryPath };
    }

    if (_circuitOpen) {
      _state = 'circuit_open';
      _active = false;
      return { active: false, state: _state, reason: 'circuit_breaker_open', binaryPath: _binaryPath };
    }

    if (!existsSyncFn(_binaryPath)) {
      _state = 'fallback_node';
      _active = false;
      _lastError = 'binary_missing';
      return { active: false, state: _state, reason: 'binary_missing', binaryPath: _binaryPath };
    }

    const spawned = _spawnOnce();
    return {
      active: spawned && !_circuitOpen,
      state: _state,
      reason: spawned ? 'started' : (_circuitOpen ? 'circuit_breaker_open' : 'spawn_failed'),
      binaryPath: _binaryPath,
      pid: _child ? _child.pid : null,
    };
  }

  function stop() {
    _stopped = true;
    _active = false;
    if (_respawnTimer) {
      clearTimer(_respawnTimer);
      _respawnTimer = null;
    }
    if (_child) {
      try { _child.kill(); } catch {}
      _child = null;
    }
    if (_state !== 'disabled' && _state !== 'circuit_open') {
      _state = 'stopped';
    }
  }

  function getStatus() {
    _pruneCrashes(nowFn());
    return {
      optedIn: _optedIn,
      active: _active && !_circuitOpen && !_stopped,
      state: _state,
      binaryPath: _binaryPath,
      pid: _child ? _child.pid : null,
      crashesInWindow: _crashTimestamps.length,
      totalCrashes: _totalCrashes,
      circuitOpen: _circuitOpen,
      fallbackTriggered: _fallbackTriggered,
      lastExitCode: _lastExitCode,
      lastError: _lastError,
    };
  }

  return { start, stop, getStatus };
}

function _readConfigSafe(configPath) {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw.trim());
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Guardian(watchdog.ps1) 우회 대응 동적 감시기:
 * guardian-watchdog.ps1이 config 명령을 먼저 소비해 ~/.orbit-config.json에 rustCollector: true를
 * 기록하더라도, 60초 루프에서 이를 감지해 바이너리 동기화 → 사이드카 동적 기동(또는 OFF 전환 시 Node 복귀)을 수행한다.
 */
function createConfigWatcher({
  configPath = path.join(os.homedir(), '.orbit-config.json'),
  env = process.env,
  sidecar = _defaultSidecar,
  syncBinaryFn = null,
  getStartOpts = null,
  onActivated = null,
  onDeactivated = null,
} = {}) {
  let _busy = false;

  async function tick() {
    if (_busy) return { action: 'busy', active: !!(sidecar && sidecar.getStatus && sidecar.getStatus().active) };
    _busy = true;
    try {
      const freshCfg = _readConfigSafe(configPath);
      const optedIn = isOptedIn(freshCfg, env);
      const status = sidecar && typeof sidecar.getStatus === 'function' ? sidecar.getStatus() : { active: false, circuitOpen: false };

      if (!optedIn) {
        if (status.active) {
          try { sidecar.stop(); } catch {}
          try { if (typeof onDeactivated === 'function') onDeactivated(freshCfg); } catch {}
          return { action: 'stopped_opt_out', active: false };
        }
        return { action: 'disabled', active: false };
      }

      if (status.circuitOpen) {
        return { action: 'circuit_open', active: false };
      }
      if (status.active) {
        return { action: 'already_active', active: true };
      }

      let syncRes = null;
      if (typeof syncBinaryFn === 'function') {
        try {
          syncRes = await syncBinaryFn({ config: freshCfg, env, sidecar });
        } catch (err) {
          syncRes = { ok: false, reason: 'sync_exception', error: err && err.message ? err.message : String(err), fallback: 'node' };
        }
      }

      const extraOpts = typeof getStartOpts === 'function' ? (getStartOpts(freshCfg) || {}) : {};
      const startRes = sidecar.start({
        ...extraOpts,
        config: freshCfg,
        env,
      });

      if (startRes && startRes.active) {
        try { if (typeof onActivated === 'function') onActivated(startRes, freshCfg); } catch {}
        return { action: 'started', active: true, syncRes, startRes };
      }
      return { action: 'fallback_node', active: false, syncRes, startRes };
    } catch (err) {
      return { action: 'error_fallback_node', active: false, error: err && err.message ? err.message : String(err) };
    } finally {
      _busy = false;
    }
  }

  return { tick };
}

const _defaultSidecar = createSidecar();

module.exports = {
  isOptedIn,
  resolveBinaryPath,
  createSidecar,
  createConfigWatcher,
  start: _defaultSidecar.start,
  stop: _defaultSidecar.stop,
  getStatus: _defaultSidecar.getStatus,
  DEFAULT_CIRCUIT_THRESHOLD,
  DEFAULT_CIRCUIT_WINDOW_MS,
};
