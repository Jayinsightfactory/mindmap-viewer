'use strict';
/**
 * work-file-uploader.js — 직원 PC의 "업무 파일"을 네노바웹 업무 드라이브로 자동 업로드.
 *
 * 흐름: file-change-watcher(Desktop/Documents/Downloads 5초 폴링) → 이 모듈 → POST {nenovaweb}/api/work/drive-ingest
 * 설정: Orbit 서버 GET /api/daemon/nenova-ingest-config (url·token·내 이름). 서버에 미설정이면 조용히 무동작.
 *
 * 개인 파일은 여기서 원천 차단한다(서버에 도달하지 않음). 올리는 조건은 전부 AND:
 *   ① 확장자 화이트리스트(xlsx/xls/xlsm/csv/pdf/docx/doc/hwp/pptx) — 사진·영상·압축은 올리지 않는다
 *   ② 1KB ≤ 크기 ≤ 25MB, 임시파일(~$·.tmp·.) 아님, 실제 존재(삭제 이벤트 제외)
 *   ③ 업무 신호가 있다: 파일명에 차수(38-2/3802/38차…) 또는 업무 키워드(발주·입고·출고·원가·운임·견적·명세·결의·송금·인보이스·proforma·order·packing·불량…)
 *   ④ 개인 신호가 없다: 계약·contrato·이력서·급여·연봉·개인·사진·가족·병원·보험·여권·주민·통장·카드명세·연말정산·KakaoTalk_ 이미지·스크린샷…
 * 분류(차수·단계·부서·민감)는 네노바웹이 최종 판단. 같은 파일은 sha256 로 한 번만, 저장 직후 연타는 90초 디바운스.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EXT_OK = /\.(xlsx|xlsm|xls|csv|pdf|docx|doc|hwp|pptx)$/i;
const MIN_BYTES = 1024, MAX_BYTES = 25 * 1024 * 1024;
const CYCLE_RE = /(?:^|[^\d])\d{2}\s*[-_]\s*0?\d(?!\d)|(?:^|[^\dA-Za-z])\d{2}0?\d(?=차|_|\s|\.)|(?:^|[^\d])\d{2}\s*차(?!수)/; // 영문 뒤 숫자(무작위 ID 'G547')는 차수 아님
const WORK_RE = /발주|입고|출고|분배|원가|운임|견적|명세|결의|송금|외화|정산|매출|재고|물량|취합|인보이스|invoice|proforma|packing|order|pedido|awb|phyto|불량|quality|claim|클레임|holex|farm|농장|수국|장미|카네이션|알스트로|출고내역|거래명세|세금계산|면장|통관|도착원가|freight|arrival/i;
const PERSONAL_RE = /계약|contrato|contract|이력서|resume|cv\b|급여|연봉|월급|개인|사진|photo|가족|병원|진단|처방|보험|여권|passport|주민|신분증|통장|카드명세|카드내역|대출|연말정산|세금신고|KakaoTalk_\d|screenshot|스크린샷|캡처|capture|메모\b|note\b|일기|편지/i;
const JUNK_RE = /^[a-z]{6,}(\.\w+)?$|^[A-Za-z0-9]{12,}\.\w+$|^new\s|^제목 없음|^무제|^untitled/i; // aaaaaa… / 무작위 ID(FL68KFM75D8G547) / 새 파일

let _cfg = null, _cfgAt = 0, _serverUrl = null, _token = null;
const _seenSha = new Map();   // sha → at (7일 보관)
const _lastAt = new Map();    // fullPath → 마지막 업로드 시도 시각(디바운스)
let _timers = new Map();      // fullPath → setTimeout (저장 연타 흡수)
let _stats = { considered: 0, uploaded: 0, skippedPersonal: 0, skippedNoSignal: 0, skippedDup: 0, failed: 0 };
const _retry = new Map();     // fullPath → { tries, evt } — 잠긴 파일·네트워크 실패는 5분 뒤 최대 3회 재시도
const RETRY_MS = 5 * 60 * 1000, RETRY_MAX = 3;
const BACKFILL_MARK = path.join(os.homedir(), '.orbit', 'drive-backfill-done.json'); // 기존 파일 일괄 업로드 1회 완료 표식

function init({ serverUrl, token }) {
  _serverUrl = serverUrl; _token = token;
  setInterval(() => { for (const [fp, r] of _retry) { _retry.delete(fp); _upload(r.evt, r.tries).catch(() => {}); } }, RETRY_MS).unref?.();
  // 기존 파일 일괄 업로드는 PC당 1회 자동(서버에서 기능이 켜져 있을 때만). 완료 표식이 있으면 건너뛴다. 재실행은 서버 명령 drive-backfill.
  setTimeout(async () => {
    try { if (fs.existsSync(BACKFILL_MARK)) return; const cfg = await _config(); if (!cfg || !cfg.enabled) return;
      const r = await backfill({}); if (r && r.ok) fs.writeFileSync(BACKFILL_MARK, JSON.stringify({ at: new Date().toISOString(), ...r, stats: undefined }));
    } catch (e) { console.warn('[work-file-uploader] 자동 backfill 실패:', e.message); }
  }, 2 * 60 * 1000).unref?.();
}

async function _config() {
  if (!_serverUrl || !_token) return null;
  if (_cfg && Date.now() - _cfgAt < 10 * 60 * 1000) return _cfg;
  try {
    const r = await fetch(`${_serverUrl}/api/daemon/nenova-ingest-config`, { headers: { Authorization: 'Bearer ' + _token }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    _cfg = j && j.enabled ? j : { enabled: false };
  } catch { _cfg = _cfg || { enabled: false }; }
  _cfgAt = Date.now();
  return _cfg;
}

// 올릴지 결정 — 이유를 돌려준다(로그·통계용). 내용은 읽지 않고 이름·크기만 본다.
function decide(evt) {
  const name = String(evt.filename || '');
  if (!EXT_OK.test(name)) return 'ext';
  if (name.startsWith('~$') || name.startsWith('.') || /\.tmp$/i.test(name)) return 'temp';
  if (JUNK_RE.test(name)) return 'junk';
  if (PERSONAL_RE.test(name)) return 'personal';
  if (!CYCLE_RE.test(name) && !WORK_RE.test(name)) return 'no-signal';
  return 'ok';
}

function onFileChange(evt) {
  try {
    if (!evt || !evt.fullPath || !evt.filename) return;
    if (evt.eventType !== 'change' && evt.eventType !== 'rename') return;
    _stats.considered++;
    const why = decide(evt);
    if (why === 'personal') { _stats.skippedPersonal++; return; }
    if (why !== 'ok') { if (why === 'no-signal') _stats.skippedNoSignal++; return; }
    // 저장 연타(엑셀 자동저장·복사 중) 흡수: 마지막 변경 후 8초 조용하면 올린다. 이후 같은 파일은 90초 디바운스.
    const prev = _timers.get(evt.fullPath); if (prev) clearTimeout(prev);
    _timers.set(evt.fullPath, setTimeout(() => { _timers.delete(evt.fullPath); _upload(evt).catch(() => {}); }, 8000));
  } catch {}
}

const _queueRetry = (evt, tries, why) => { if (tries >= RETRY_MAX) { _stats.failed++; console.warn(`[work-file-uploader] 포기(${why}) ${evt.filename}`); return; } _retry.set(evt.fullPath, { tries: tries + 1, evt }); };
async function _upload(evt, tries = 0) {
  const cfg = await _config(); if (!cfg || !cfg.enabled) return;
  const last = _lastAt.get(evt.fullPath) || 0; if (tries === 0 && Date.now() - last < 90 * 1000) return;
  let st; try { st = fs.statSync(evt.fullPath); } catch { return; } // 삭제/이동됨
  if (!st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) return;
  let buf; try { buf = fs.readFileSync(evt.fullPath); } catch { return _queueRetry(evt, tries, 'locked'); } // 엑셀이 잠근 중 → 5분 뒤 재시도
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (_seenSha.has(sha)) { _stats.skippedDup++; return; }
  _lastAt.set(evt.fullPath, Date.now());
  const form = new FormData();
  form.append('file', new Blob([buf]), evt.filename);
  form.append('filename', evt.filename);
  form.append('orbitUserId', cfg.userId || '');
  form.append('userName', cfg.userName || '');
  form.append('hostname', os.hostname());
  form.append('dir', path.basename(path.dirname(evt.fullPath)));
  form.append('mtime', new Date(st.mtimeMs).toISOString());
  form.append('eventType', evt.eventType);
  try {
    const r = await fetch(`${cfg.url}/api/work/drive-ingest`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token }, body: form, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) {
      _seenSha.set(sha, Date.now()); _stats.uploaded++;
      const c = j.classification || {};
      console.log(`[work-file-uploader] ${j.duplicate ? '중복' : '업로드'} ${evt.filename} → ${c.cycle || '-'} / ${c.stage || '-'}${c.sensitive ? ' 🔒' : ''}`);
    } else if (r.status >= 500 || r.status === 429) { _queueRetry(evt, tries, 'server ' + r.status); }
    else { _stats.failed++; console.warn(`[work-file-uploader] 실패 ${r.status} ${evt.filename}: ${j.error || ''}`); } // 4xx는 재시도해도 같음
  } catch (e) { _queueRetry(evt, tries, 'network'); }
  // sha 캐시 7일 정리
  const cut = Date.now() - 7 * 86400e3; for (const [k, at] of _seenSha) if (at < cut) _seenSha.delete(k);
}

function getStats() { return { ..._stats, enabled: !!(_cfg && _cfg.enabled) }; }

// 기존 파일 일괄 업로드(backfill) — 서버 명령 'drive-backfill' 로 1회 실행. 감시 폴더 3곳을 하위 depth 단계까지 훑어
// 같은 게이트(decide)를 통과하는 파일만, 최근 maxAgeDays 내 수정본만, 초당 1건 간격으로 올린다(서버·PC 부하 방지).
// 중복(sha)은 서버가 걸러 주므로 여러 번 실행해도 안전하다.
let _backfillRunning = false;
async function backfill({ depth = 3, maxFiles = 1000, maxAgeDays = 548, dryRun = false } = {}) {
  if (_backfillRunning) return { ok: false, reason: 'already-running' };
  const cfg = await _config(); if (!cfg || !cfg.enabled) return { ok: false, reason: 'not-enabled' };
  _backfillRunning = true;
  const home = os.homedir(); const roots = ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d));
  const cut = Date.now() - maxAgeDays * 86400e3; const found = [];
  const walk = (dir, d) => {
    if (d > depth || found.length >= maxFiles * 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('~$') || /^(node_modules|\.git|AppData)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, d + 1); continue; }
      if (!e.isFile() || decide({ filename: e.name }) !== 'ok') continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size < MIN_BYTES || st.size > MAX_BYTES || st.mtimeMs < cut) continue;
      found.push({ full, name: e.name, mtime: st.mtimeMs });
    }
  };
  for (const r of roots) walk(r, 1);
  found.sort((a, b) => b.mtime - a.mtime); // 최신부터
  const list = found.slice(0, maxFiles);
  console.log(`[work-file-uploader] backfill 시작: 후보 ${found.length}건, 올릴 것 ${list.length}건${dryRun ? ' (dryRun — 목록만)' : ''}`);
  if (dryRun) { _backfillRunning = false; return { ok: true, dryRun: true, candidates: found.length, sample: list.slice(0, 60).map((f) => path.relative(home, f.full)) }; }
  let n = 0;
  for (const f of list) {
    _lastAt.delete(f.full); // backfill 은 디바운스 무시
    await _upload({ eventType: 'backfill', filename: f.name, fullPath: f.full });
    n++; await new Promise((r) => setTimeout(r, 1200));
  }
  _backfillRunning = false;
  const s = getStats();
  console.log(`[work-file-uploader] backfill 완료: 시도 ${n}, 누적 업로드 ${s.uploaded}, 중복 ${s.skippedDup}, 실패 ${s.failed}`);
  return { ok: true, candidates: found.length, attempted: n, stats: s };
}

module.exports = { init, onFileChange, decide, getStats, backfill };
