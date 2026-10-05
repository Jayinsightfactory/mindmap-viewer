/**
 * file-skiplist — poison 파일(파싱 중 데몬을 네이티브로 죽이는 파일) 격리기.
 *
 * 왜 try/catch로 부족한가:
 *   XLSX.readFile 등은 손상/거대 파일에서 V8 heap OOM abort나 네이티브 kill을 일으킬 수 있고,
 *   이건 JavaScript try/catch로 못 잡는다(프로세스가 그냥 죽는다). 그래서 "처리 직전에 디스크에
 *   in-flight 마커를 남기고, 성공하면 지운다". 프로세스가 처리 중 죽으면 마커가 남으므로,
 *   재시작 때 같은 파일을 다시 열지 않고 건너뛴다 → poison 한 개가 크래시루프를 만들지 못한다.
 *
 * 저장소: ~/.orbit/file-skiplist.json  { "<normPath>": {file, attempts, firstSeen, lastSeen, skipped, reason} }
 * MAX_ATTEMPTS회 비정상 종료가 누적되면 영구 스킵(skipped=true). 정상 처리되면 항목 제거.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ORBIT_DIR    = path.join(os.homedir(), '.orbit');
const SKIPLIST     = path.join(ORBIT_DIR, 'file-skiplist.json');
const MAX_ATTEMPTS = 2;   // 2회 불결 종료 누적 시 영구 스킵

let _map = null;

function _norm(fp) {
  try { return path.resolve(fp).toLowerCase(); } catch { return String(fp || '').toLowerCase(); }
}

function _load() {
  if (_map) return _map;
  try { _map = JSON.parse(fs.readFileSync(SKIPLIST, 'utf8')) || {}; } catch { _map = {}; }
  // 시작 시: 지난번 깨끗이 끝나지 않은(in-flight) 항목 = 처리 중 크래시. attempts 증가 → 한도 넘으면 영구 스킵.
  let changed = false;
  for (const k of Object.keys(_map)) {
    const e = _map[k];
    if (e && e.inFlight && !e.skipped) {
      e.inFlight = false;
      e.attempts = (e.attempts || 0) + 1;
      e.lastSeen = new Date().toISOString();
      if (e.attempts >= MAX_ATTEMPTS) { e.skipped = true; e.reason = 'native crash during parse x' + e.attempts; }
      changed = true;
    }
  }
  if (changed) _save();
  return _map;
}

function _save() {
  try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(SKIPLIST, JSON.stringify(_map, null, 0), 'utf8'); } catch {}
}

/** 이 파일을 건너뛰어야 하나? (영구 스킵 처리된 poison) */
function isSkipped(fp) {
  const m = _load();
  const e = m[_norm(fp)];
  return !!(e && e.skipped);
}

/**
 * 위험한 파싱 직전에 호출. 영구 스킵이면 false(처리하지 말 것).
 * 아니면 in-flight 마커를 남기고 true 반환(프로세스가 여기서 죽으면 마커가 증거로 남음).
 */
function beginFile(fp) {
  const m = _load();
  const k = _norm(fp);
  const e = m[k];
  if (e && e.skipped) return false;
  m[k] = {
    file:      path.basename(fp),
    attempts:  e ? (e.attempts || 0) : 0,
    firstSeen: e && e.firstSeen ? e.firstSeen : new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
    inFlight:  true,
    skipped:   false,
  };
  _save();
  return true;
}

/** 정상 처리 완료 — 마커 제거(깨끗이 끝남). */
function endFileOk(fp) {
  const m = _load();
  const k = _norm(fp);
  if (m[k]) { delete m[k]; _save(); }
}

/** JS에서 잡힌(네이티브 아님) 파싱 실패 — in-flight만 내리고 기록은 보존하되 영구 스킵은 하지 않음. */
function endFileErr(fp) {
  const m = _load();
  const k = _norm(fp);
  const e = m[k];
  if (e) { e.inFlight = false; e.lastSeen = new Date().toISOString(); _save(); }
}

module.exports = { isSkipped, beginFile, endFileOk, endFileErr, SKIPLIST, MAX_ATTEMPTS };
