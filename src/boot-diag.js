'use strict';
/**
 * boot-diag.js — 데몬 급사(native crash / startup abort) 순간을 로컬 파일로 남기고 다음 기동 때 서버로 올린다.
 *
 * 배경(2026-10-05): personal-agent 가 시작 직후(~10초) 네이티브 종료(AV kill / 캡처 addon / uiohook /
 *   PowerShell spawn / OOM abort)로 죽으면 JS crash-reporter 가 스택을 못 잡고(프로세스가 그냥 사라짐),
 *   원격 exec/report 도 못 돈다(그 전에 죽음). 그래서 "어느 모듈에서 죽었나"가 서버에 영영 안 남았다.
 *
 * 설계(세 겹):
 *   1) boot-stage.log  — 워커가 시작하며 각 init 단계를 '동기 flush'(appendFileSync)로 찍는다.
 *      마지막 줄 = 죽은 모듈. native abort 라 try/catch 가 못 잡아도 파일엔 남는다.
 *   2) crash-moment.log/worker-stderr.log — '수퍼바이저(start-daemon.ps1)'가 워커 종료코드/수명/stderr 를 남긴다.
 *      (종료코드가 네이티브 vs 정상 종료를 가른다: 0xC0000005 access violation=3221225477 등)
 *   3) flushOnBoot() — 다음 기동 '초기(위험 모듈 로드 전)'에 위 세 파일의 꼬리만 서버로 POST(daemon.crashmoment)
 *      후 성공하면 비운다. 사용자 문서는 절대 포함 안 함(이 진단 파일 꼬리만).
 *
 * 전부 best-effort: 어떤 실패도 throw 하지 않는다(진단 코드가 데몬을 죽이면 본말전도).
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

let ORBIT_DIR       = path.join(os.homedir(), '.orbit');
let BOOT_STAGE_LOG  = path.join(ORBIT_DIR, 'boot-stage.log');
let BOOT_STAGE_PREV = path.join(ORBIT_DIR, 'boot-stage.prev.log');
let CRASH_MOMENT    = path.join(ORBIT_DIR, 'crash-moment.log');
let WORKER_STDERR   = path.join(ORBIT_DIR, 'worker-stderr.log');

// 테스트/격리용 — 경로 주입
function _setOrbitDir(dir) {
  ORBIT_DIR       = dir;
  BOOT_STAGE_LOG  = path.join(dir, 'boot-stage.log');
  BOOT_STAGE_PREV = path.join(dir, 'boot-stage.prev.log');
  CRASH_MOMENT    = path.join(dir, 'crash-moment.log');
  WORKER_STDERR   = path.join(dir, 'worker-stderr.log');
}

function _readConfig() {
  try {
    let raw = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return {}; }
}

function _tailFile(filepath, maxLines = 120, maxBytes = 16 * 1024) {
  try {
    if (!fs.existsSync(filepath)) return '';
    const st = fs.statSync(filepath);
    const len = Math.min(st.size, maxBytes);
    if (len === 0) return '';
    const fd = fs.openSync(filepath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      let text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/**
 * beginRun() — 워커 진입 즉시 호출. 이전 런의 boot-stage.log 를 .prev 로 밀어두고(죽은 지점 보존)
 * 이번 런용 새 boot-stage.log 를 연다. 그래야 flushOnBoot 가 '이전 런' 흔적을 올린다.
 */
function beginRun() {
  try {
    fs.mkdirSync(ORBIT_DIR, { recursive: true });
    if (fs.existsSync(BOOT_STAGE_LOG)) {
      try { fs.renameSync(BOOT_STAGE_LOG, BOOT_STAGE_PREV); } catch {
        // rename 실패(잠김 등)면 복사 후 비움 — best effort
        try { fs.copyFileSync(BOOT_STAGE_LOG, BOOT_STAGE_PREV); } catch {}
      }
    }
    fs.writeFileSync(BOOT_STAGE_LOG, '', 'utf8');
  } catch {}
  stage('process-start');
}

/**
 * stage(name) — 단계 마커를 동기 flush. 마지막 줄이 "죽은 모듈"이 되도록 '해당 모듈 로드 직전'에 호출한다.
 */
function stage(name) {
  try {
    fs.appendFileSync(BOOT_STAGE_LOG, `${new Date().toISOString()} ${name}\n`, 'utf8');
  } catch {}
}

function _post(event) {
  return new Promise((resolve) => {
    const cfg = _readConfig();
    const serverUrl = cfg.serverUrl || process.env.ORBIT_SERVER_URL;
    const token     = cfg.token || process.env.ORBIT_TOKEN || '';
    if (!serverUrl) return resolve(false);
    try {
      const body = JSON.stringify({ events: [event] });
      const url = new URL('/api/hook', serverUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Device-Id': encodeURIComponent(os.hostname()),
      };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 10000,
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
      req.write(body); req.end();
    } catch { resolve(false); }
  });
}

/**
 * buildEvent(tails) — 서버로 보낼 daemon.crashmoment 이벤트. 꼬리 문자열만 담아 작게.
 */
function buildEvent(tails) {
  const cfg = _readConfig();
  return {
    id: 'crashmoment-' + os.hostname() + '-' + Date.now(),
    type: 'daemon.crashmoment',
    source: 'boot-diag',
    sessionId: 'daemon-' + os.hostname(),
    timestamp: new Date().toISOString(),
    data: {
      hostname: os.hostname(),
      userId: cfg.userId || 'unknown',
      platform: process.platform,
      nodeVersion: process.version,
      crashMoment: tails.crashMoment,   // 수퍼바이저가 남긴 [exit] code/ranMs/lastStage 줄들
      bootStagePrev: tails.bootStagePrev, // 직전 런의 단계 마커(마지막 줄=죽은 모듈)
      workerStderr: tails.workerStderr,   // 워커 stderr 꼬리(네이티브 abort 메시지 등)
      capturedAt: new Date().toISOString(),
    },
  };
}

function _collectTails() {
  return {
    crashMoment:   _tailFile(CRASH_MOMENT, 60, 16 * 1024),
    bootStagePrev: _tailFile(BOOT_STAGE_PREV, 80, 12 * 1024),
    workerStderr:  _tailFile(WORKER_STDERR, 120, 24 * 1024),
  };
}

/**
 * flushOnBoot(postFn?) — 다음 기동 초기에 호출. 세 진단 파일 꼬리를 모아 서버로 올리고, 성공 시 crash-moment.log 를 비운다.
 * boot-stage.prev.log/worker-stderr.log 는 비우지 않는다(수퍼바이저가 다음 종료에 다시 덮어씀 + 오프라인 재시도 보존).
 * @returns {Promise<{uploaded:boolean, hadData:boolean}>}
 */
async function flushOnBoot(postFn) {
  const tails = _collectTails();
  const hadData = !!(tails.crashMoment || tails.bootStagePrev || tails.workerStderr);
  if (!hadData) return { uploaded: false, hadData: false };
  let uploaded = false;
  try {
    const ok = await (postFn || _post)(buildEvent(tails));
    uploaded = !!ok;
  } catch { uploaded = false; }
  if (uploaded) {
    // crash-moment.log 만 비운다(업로드 성공분) — [exit] 줄은 1회 올리면 충분.
    try { fs.writeFileSync(CRASH_MOMENT, '', 'utf8'); } catch {}
  }
  return { uploaded, hadData: true };
}

module.exports = {
  beginRun, stage, flushOnBoot, buildEvent,
  _setOrbitDir, _collectTails, _tailFile, _post,
  get _paths() { return { ORBIT_DIR, BOOT_STAGE_LOG, BOOT_STAGE_PREV, CRASH_MOMENT, WORKER_STDERR }; },
};
