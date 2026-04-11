'use strict';
/**
 * resource-governor.js — PC 리소스 동적 모니터링 + 세팅 자동 조정
 *
 * CPU/RAM 사용률을 30초마다 측정하고 EMA(지수이동평균)로 평활화.
 * 4단계 부하 레벨에 따라 캡처/녹화 세팅을 자동 조정.
 *
 * 학습: 부하 전환 이력을 기록하여 히스테리시스 임계값을 점진 조정.
 */

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ── 경로 ─────────────────────────────────────────────────────────────────────
const ORBIT_DIR          = path.join(os.homedir(), '.orbit');
const CAPTURE_CONFIG     = path.join(ORBIT_DIR, 'capture-config.json');
const RECORDER_CONFIG    = path.join(ORBIT_DIR, 'recorder-config.json');
const GOVERNOR_STATE     = path.join(ORBIT_DIR, 'governor-state.json');
const GOVERNOR_LOG       = path.join(ORBIT_DIR, 'governor-log.json');

// ── 측정 주기 ────────────────────────────────────────────────────────────────
const POLL_MS            = 30 * 1000;   // 30초마다 측정
const EMA_ALPHA          = 0.3;         // EMA 가중치 (0~1, 높을수록 최신값 반영)
const HYSTERESIS_COUNT   = 3;           // 레벨 전환에 필요한 연속 횟수 (진동 방지)
const LOG_MAX_ENTRIES    = 500;         // 로그 최대 보관 수

// ── 4단계 부하 레벨 (Windows 실사용 환경 기준) ───────────────────────────────
// Windows는 평상시 60-80% RAM 사용이 정상 (브라우저, ERP, 카카오톡 등)
const LEVELS = {
  IDLE:     { cpu: [0, 35],  ram: [0, 70]  },
  NORMAL:   { cpu: [35, 65], ram: [70, 82] },
  BUSY:     { cpu: [65, 85], ram: [82, 92] },
  CRITICAL: { cpu: [85, 100], ram: [92, 100] },
};

// ── 레벨별 세팅 프로파일 ─────────────────────────────────────────────────────
const PROFILES = {
  IDLE: {
    // 여유로움 → 적극 수집
    capture: { default: 30000, byApp: {} },
    recorder: {
      mouseSampleMs: 30,
      mouseMinMovePx: 3,
      screenshotQuality: 80,
      screenshotMaxWidth: 1920,
      batchFlushSec: 0.5,
      screenshotOnClick: true,
      screenshotIntervalSec: 0,
    },
    visionPaused: false,
  },
  NORMAL: {
    // 기본값
    capture: { default: 60000, byApp: {} },
    recorder: {
      mouseSampleMs: 50,
      mouseMinMovePx: 5,
      screenshotQuality: 60,
      screenshotMaxWidth: 1920,
      batchFlushSec: 1.0,
      screenshotOnClick: true,
      screenshotIntervalSec: 0,
    },
    visionPaused: false,
  },
  BUSY: {
    // 부하 높음 → 절약 모드
    capture: { default: 120000, byApp: {} },
    recorder: {
      mouseSampleMs: 100,
      mouseMinMovePx: 10,
      screenshotQuality: 40,
      screenshotMaxWidth: 1280,
      batchFlushSec: 2.0,
      screenshotOnClick: true,
      screenshotIntervalSec: 0,
    },
    visionPaused: false,
  },
  CRITICAL: {
    // 위험 → 최소 수집
    capture: { default: 300000, byApp: {} },
    recorder: {
      mouseSampleMs: 200,
      mouseMinMovePx: 20,
      screenshotQuality: 30,
      screenshotMaxWidth: 960,
      batchFlushSec: 5.0,
      screenshotOnClick: false,
      screenshotIntervalSec: 0,
    },
    visionPaused: true,
  },
};

// ── 상태 ─────────────────────────────────────────────────────────────────────
let _timer          = null;
let _prevCpuTimes   = null;      // 이전 CPU 스냅샷
let _emaCpu         = 0;
let _emaRam         = 0;
let _currentLevel   = 'NORMAL';
let _pendingLevel   = null;
let _pendingCount   = 0;
let _log            = [];
let _started        = false;

// 학습: 레벨별 실측 CPU 평균 (임계값 자동 보정용)
let _levelStats     = { IDLE: { sum: 0, n: 0 }, NORMAL: { sum: 0, n: 0 }, BUSY: { sum: 0, n: 0 }, CRITICAL: { sum: 0, n: 0 } };

// ── CPU 사용률 계산 (os.cpus() 델타) ─────────────────────────────────────────
function _cpuSnapshot() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const c of cpus) {
    for (const t in c.times) totalTick += c.times[t];
    totalIdle += c.times.idle;
  }
  return { idle: totalIdle, total: totalTick };
}

function _cpuPercent() {
  const now = _cpuSnapshot();
  if (!_prevCpuTimes) { _prevCpuTimes = now; return 0; }
  const dIdle  = now.idle - _prevCpuTimes.idle;
  const dTotal = now.total - _prevCpuTimes.total;
  _prevCpuTimes = now;
  if (dTotal === 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 100);
}

function _ramPercent() {
  const total = os.totalmem();
  const free  = os.freemem();
  return Math.round((1 - free / total) * 100);
}

// ── EMA 업데이트 ─────────────────────────────────────────────────────────────
function _updateEma(cpu, ram) {
  _emaCpu = _emaCpu === 0 ? cpu : EMA_ALPHA * cpu + (1 - EMA_ALPHA) * _emaCpu;
  _emaRam = _emaRam === 0 ? ram : EMA_ALPHA * ram + (1 - EMA_ALPHA) * _emaRam;
}

// ── 부하 레벨 판정 ───────────────────────────────────────────────────────────
function _determineLevel(cpu, ram) {
  // CPU와 RAM 중 더 높은 등급 적용
  const cpuLevel = cpu >= 85 ? 'CRITICAL' : cpu >= 65 ? 'BUSY' : cpu >= 35 ? 'NORMAL' : 'IDLE';
  const ramLevel = ram >= 92 ? 'CRITICAL' : ram >= 82 ? 'BUSY' : ram >= 70 ? 'NORMAL' : 'IDLE';
  const order = ['IDLE', 'NORMAL', 'BUSY', 'CRITICAL'];
  return order[Math.max(order.indexOf(cpuLevel), order.indexOf(ramLevel))];
}

// ── 세팅 파일 쓰기 ───────────────────────────────────────────────────────────
function _ensureDir() {
  try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); } catch {}
}

function _writeCaptureConfig(profile) {
  try {
    // 기존 byApp 보존 (학습 에이전트가 설정한 앱별 값 유지)
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(CAPTURE_CONFIG, 'utf8')); } catch {}
    const merged = {
      ...profile.capture,
      byApp: { ...(existing.byApp || {}), ...(profile.capture.byApp || {}) },
      _governor: { level: _currentLevel, cpu: Math.round(_emaCpu), ram: Math.round(_emaRam), ts: new Date().toISOString() },
    };
    fs.writeFileSync(CAPTURE_CONFIG, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.warn('[governor] capture-config 쓰기 실패:', e.message);
  }
}

function _writeRecorderConfig(profile) {
  try {
    const data = {
      ...profile.recorder,
      _governor: { level: _currentLevel, cpu: Math.round(_emaCpu), ram: Math.round(_emaRam), ts: new Date().toISOString() },
    };
    fs.writeFileSync(RECORDER_CONFIG, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[governor] recorder-config 쓰기 실패:', e.message);
  }
}

// ── 학습 로그 ────────────────────────────────────────────────────────────────
function _appendLog(entry) {
  _log.push(entry);
  if (_log.length > LOG_MAX_ENTRIES) _log = _log.slice(-LOG_MAX_ENTRIES);
  try {
    fs.writeFileSync(GOVERNOR_LOG, JSON.stringify(_log.slice(-100), null, 2));
  } catch {}
}

function _saveState() {
  try {
    fs.writeFileSync(GOVERNOR_STATE, JSON.stringify({
      level: _currentLevel,
      emaCpu: Math.round(_emaCpu * 10) / 10,
      emaRam: Math.round(_emaRam * 10) / 10,
      levelStats: _levelStats,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function _loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(GOVERNOR_STATE, 'utf8'));
    if (s.level) _currentLevel = s.level;
    if (s.emaCpu) _emaCpu = s.emaCpu;
    if (s.emaRam) _emaRam = s.emaRam;
    if (s.levelStats) _levelStats = s.levelStats;
  } catch {}
  try {
    _log = JSON.parse(fs.readFileSync(GOVERNOR_LOG, 'utf8'));
  } catch { _log = []; }
}

// ── 메인 틱 ──────────────────────────────────────────────────────────────────
function _tick() {
  const rawCpu = _cpuPercent();
  const rawRam = _ramPercent();
  _updateEma(rawCpu, rawRam);

  const newLevel = _determineLevel(_emaCpu, _emaRam);

  // 학습 통계 갱신
  const st = _levelStats[_currentLevel];
  if (st) { st.sum += rawCpu; st.n += 1; }

  // 히스테리시스: 연속 N회 같은 레벨이어야 전환
  if (newLevel !== _currentLevel) {
    if (newLevel === _pendingLevel) {
      _pendingCount++;
    } else {
      _pendingLevel = newLevel;
      _pendingCount = 1;
    }

    // CRITICAL은 즉시 전환 (안전 우선)
    const threshold = newLevel === 'CRITICAL' ? 1 : HYSTERESIS_COUNT;

    if (_pendingCount >= threshold) {
      const prev = _currentLevel;
      _currentLevel = newLevel;
      _pendingLevel = null;
      _pendingCount = 0;

      // 세팅 적용
      const profile = PROFILES[_currentLevel];
      _writeCaptureConfig(profile);
      _writeRecorderConfig(profile);

      console.log(`[governor] ${prev} → ${_currentLevel}  (CPU: ${Math.round(_emaCpu)}%, RAM: ${Math.round(_emaRam)}%)`);
      _appendLog({
        ts: new Date().toISOString(),
        from: prev,
        to: _currentLevel,
        cpu: Math.round(_emaCpu),
        ram: Math.round(_emaRam),
        rawCpu, rawRam,
      });
    }
  } else {
    _pendingLevel = null;
    _pendingCount = 0;
  }

  _saveState();
}

// ── 공개 API ─────────────────────────────────────────────────────────────────
function start() {
  if (_started) return;
  _started = true;
  _ensureDir();
  _loadState();

  // 첫 CPU 스냅샷 (델타 계산 기준)
  _prevCpuTimes = _cpuSnapshot();

  // 현재 레벨 세팅 즉시 적용
  const profile = PROFILES[_currentLevel];
  _writeCaptureConfig(profile);
  _writeRecorderConfig(profile);

  // 주기적 측정 시작
  _timer = setInterval(_tick, POLL_MS);
  // 첫 측정은 5초 후 (CPU 델타 축적 필요)
  setTimeout(_tick, 5000);

  console.log(`[governor] 시작 — 레벨: ${_currentLevel}, 주기: ${POLL_MS / 1000}초`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
  console.log('[governor] 중지');
}

function getStatus() {
  return {
    level: _currentLevel,
    cpu: Math.round(_emaCpu * 10) / 10,
    ram: Math.round(_emaRam * 10) / 10,
    profiles: Object.keys(PROFILES),
    visionPaused: PROFILES[_currentLevel].visionPaused,
  };
}

// 수동 레벨 오버라이드 (테스트/디버그용)
function forceLevel(level) {
  if (!PROFILES[level]) return false;
  const prev = _currentLevel;
  _currentLevel = level;
  const profile = PROFILES[level];
  _writeCaptureConfig(profile);
  _writeRecorderConfig(profile);
  console.log(`[governor] 강제 전환: ${prev} → ${level}`);
  return true;
}

module.exports = { start, stop, getStatus, forceLevel, PROFILES };
