'use strict';
/**
 * work-file-uploader.js — 직원 PC의 "업무 파일"을 네노바웹 업무 드라이브로 자동 업로드.
 *
 * 흐름: file-change-watcher(Desktop/Documents/Downloads 5초 폴링) → 이 모듈 → POST {nenovaweb}/api/work/drive-ingest
 * 설정: Orbit 서버 GET /api/daemon/nenova-ingest-config (url·token·내 이름). 서버에 미설정이면 조용히 무동작.
 *
 * 개인 파일은 여기서 원천 차단한다(서버에 도달하지 않음). 올리는 조건은 전부 AND:
 *   ① 확장자 화이트리스트(xlsx/xls/xlsm/csv/pdf/docx/doc/hwp/pptx/zip/html/htm) — 사진·영상은 올리지 않는다
 *   ② 1KB ≤ 크기 ≤ 25MB, 임시파일(~$·.tmp·.) 아님, 실제 존재(삭제 이벤트 제외)
 *   ③ 업무 신호가 있다: 승인된 업무 도구 파일명 또는 차수(38-2/3802/38차…) 또는 업무 키워드(발주·입고·출고·원가·운임·견적·명세·결의·송금·인보이스·proforma·order·packing·불량…)
 *   ④ 개인 신호가 없다: 계약·contrato·이력서·급여·연봉·개인·사진·가족·병원·보험·여권·주민·통장·카드명세·연말정산·KakaoTalk_ 이미지·스크린샷…
 * 분류(차수·단계·부서·민감)는 네노바웹이 최종 판단. 같은 파일은 sha256 로 한 번만, 저장 직후 연타는 90초 디바운스.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// xlsb·hwpx 추가: file-change-watcher._DOC_EXT 는 이미 둘을 감시하는데 여기서 'ext'로 버려 불일치였다(엑셀 바이너리·한글 신버전 누락).
// txt 추가: 단, 비승인 파일은 아래 no-signal 게이트에서 업무 신호(WORK_RE/CYCLE_RE)가 있어야만 통과하므로 메모성 txt는 걸러진다.
const EXT_OK = /\.(xlsx|xlsm|xlsb|xls|csv|pdf|docx|doc|hwp|hwpx|pptx|zip|html|htm|txt)$/i;
// 승인된 업무 도구 파일명은 파일명 업무 신호가 없어도 허용한다.
const APPROVED_BUSINESS_TOOLS = new Set([
  'generador_pedidos.zip',
  'nenova.html',
  'nenova_app.zip',
  'import_team_checklist_diario_2.html',
]);
const MIN_BYTES = 1024, MAX_BYTES = 25 * 1024 * 1024;
// 차수 표기: 기존 '38-2'/'3802'/'38차' 에 더해 '38주차'/'38W'/'제38차'/'2026-38-2'(연-주차-서브) 를 인정.
const CYCLE_RE = /(?:^|[^\d])\d{2}\s*[-_]\s*0?\d(?!\d)|(?:^|[^\dA-Za-z])\d{2}0?\d(?=차|_|\s|\.)|(?:^|[^\d])\d{2}\s*차(?!수)|(?:^|[^\d])\d{1,2}\s*주\s*차|(?:^|[^\dA-Za-z])\d{2}\s*[Ww](?![A-Za-z])|제\s*\d{1,3}\s*차|(?:^|[^\d])20\d{2}\s*[-_]\s*\d{1,2}\s*[-_]\s*\d/; // 영문 뒤 숫자(무작위 ID 'G547')는 차수 아님
// 업무 신호(한/영/스페인어). 스페인어 거래처(가브리엘 등) 파일명 대응: factura/cotización/remesa/remision/guia/pedido/envio…
const WORK_RE = /발주|입고|출고|분배|원가|운임|견적|명세|결의|송금|외화|정산|매출|재고|물량|취합|인보이스|invoice|proforma|packing|list|order|pedido|awb|phyto|불량|quality|claim|클레임|holex|farm|농장|수국|장미|카네이션|알스트로|출고내역|거래명세|세금계산|면장|통관|도착원가|freight|arrival|shipment|factura|cotizaci[oó]n|cotizacion|remesa|remisi[oó]n|remision|gu[ií]a|envio|env[ií]o|hub\b/i;
const PERSONAL_RE = /계약|contrato|contract|이력서|resume|cv\b|급여|연봉|월급|개인|사진|photo|가족|병원|진단|처방|보험|여권|passport|주민|신분증|통장|카드명세|카드내역|대출|연말정산|세금신고|KakaoTalk_\d|screenshot|스크린샷|캡처|capture|메모\b|note\b|일기|편지/i;
const JUNK_RE = /^[a-z]{6,}(\.\w+)?$|^[A-Za-z0-9]{12,}\.\w+$|^new\s|^제목 없음|^무제|^untitled/i; // aaaaaa… / 무작위 ID(FL68KFM75D8G547) / 새 파일

let _cfg = null, _cfgAt = 0, _serverUrl = null, _token = null;
const _seenSha = new Map();   // sha → at (7일 보관)
const _lastAt = new Map();    // fullPath → 마지막 업로드 시도 시각(디바운스)
let _timers = new Map();      // fullPath → setTimeout (저장 연타 흡수)
// heartbeat로 서버에 보고(PC별 원격 진단). 기존 필드명 유지 + 사유별 세분화 추가.
// 이전엔 considered 만 세고 ext/temp/junk/크기초과는 어떤 버킷에도 안 들어가 "considered 큰데 uploaded 0"의 원인을 서버에서 볼 수 없었다.
let _stats = {
  considered: 0, uploaded: 0, skippedPersonal: 0, skippedNoSignal: 0, skippedDup: 0, failed: 0, lastError: '', lastBackfill: null,
  skippedExt: 0, skippedTemp: 0, skippedJunk: 0, skippedTooSmall: 0, skippedTooBig: 0, server507: 0, serverRetry: 0,
};
// 사유별 최근 파일명 표본(각 20개). 개인(personal)은 파일명 대신 건수만 — 프라이버시.
const SAMPLE_MAX = 20;
const _samples = {}; // reason → [name,...]
function _sample(reason, name) {
  if (reason === 'personal' || !name) return; // 개인 파일명은 서버로 보내지 않는다
  const a = _samples[reason] || (_samples[reason] = []);
  if (a[a.length - 1] === name) return;
  a.push(name); if (a.length > SAMPLE_MAX) a.shift();
}
const _retry = new Map();     // fullPath → { tries, evt } — 잠긴 파일·네트워크 실패는 5분 뒤 최대 3회 재시도
const RETRY_MS = 5 * 60 * 1000, RETRY_MAX = 3;
const BACKFILL_MARK = path.join(os.homedir(), '.orbit', 'drive-backfill-done.json'); // 기존 파일 일괄 업로드 1회 완료 표식

function init({ serverUrl, token }) {
  _serverUrl = serverUrl; _token = token;
  setInterval(() => { for (const [fp, r] of _retry) { _retry.delete(fp); _upload(r.evt, r.tries).catch(() => {}); } }, RETRY_MS).unref?.();
  // 기존 파일 일괄 업로드는 PC당 1회 자동(서버에서 기능이 켜져 있을 때만). 완료 표식이 있으면 건너뛴다. 재실행은 서버 명령 drive-backfill.
  setTimeout(async () => {
    try { const cfg = await _config(); if (fs.existsSync(BACKFILL_MARK)) return; if (!cfg || !cfg.enabled) return; // 설정은 마커와 무관하게 먼저 받는다(health 통계가 'not-fetched'로 진단을 가리지 않게)
      const r = await backfill({}); _stats.lastBackfill = { at: new Date().toISOString(), auto: true, ...r, stats: undefined }; if (r && r.ok) fs.writeFileSync(BACKFILL_MARK, JSON.stringify(_stats.lastBackfill));
    } catch (e) { _stats.lastError = 'auto-backfill: ' + e.message; console.warn('[work-file-uploader] 자동 backfill 실패:', e.message); }
  }, 2 * 60 * 1000).unref?.();
}

async function _config() {
  if (!_serverUrl || !_token) return null;
  if (_cfg && Date.now() - _cfgAt < 10 * 60 * 1000) return _cfg;
  try {
    const r = await fetch(`${_serverUrl}/api/daemon/nenova-ingest-config`, { headers: { Authorization: 'Bearer ' + _token, 'X-Device-Id': os.hostname() }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    _cfg = j && j.enabled ? j : { enabled: false, reason: (j && j.reason) || ('http ' + r.status) };
  } catch { _cfg = _cfg || { enabled: false }; }
  _cfgAt = Date.now();
  return _cfg;
}

// 올릴지 결정 — 이유를 돌려준다(로그·통계용). 내용은 읽지 않고 이름·크기만 본다.
function decide(evt) {
  const name = String(evt.filename || '');
  const isApprovedTool = APPROVED_BUSINESS_TOOLS.has(name.toLowerCase());
  if (!isApprovedTool && !EXT_OK.test(name)) return 'ext';
  if (name.startsWith('~$') || name.startsWith('.') || /\.tmp$/i.test(name)) return 'temp';
  if (PERSONAL_RE.test(name)) return 'personal';
  if (isApprovedTool) return 'ok';
  // 업무 신호는 파일명뿐 아니라 '상위 폴더 경로'에서도 인정한다(예: ...\45차 발주\sheet1.xlsx — 파일명엔 신호 없지만 폴더엔 있음).
  // 개인 폴더 오탐 방지: 폴더 경로에 개인 신호가 있으면 폴더 신호를 쓰지 않는다.
  const dirPath = String(evt.fullPath || '').slice(0, -name.length);
  const dirSignal = dirPath && !PERSONAL_RE.test(dirPath) && (CYCLE_RE.test(dirPath) || WORK_RE.test(dirPath));
  if (CYCLE_RE.test(name) || WORK_RE.test(name) || dirSignal) return 'ok'; // 업무 신호가 있으면 junk 판정보다 우선
  // 신호가 없을 때만 junk(무작위 ID·무제·aaaaaa) 를 가려낸다. 과거엔 junk 를 먼저 봐서 remesa/factura/invoice 같은 소문자 단어 업무 파일이 junk 로 버려졌다.
  if (!isApprovedTool && JUNK_RE.test(name)) return 'junk';
  return 'no-signal';
}

function onFileChange(evt) {
  try {
    if (!evt || !evt.fullPath || !evt.filename) return;
    if (evt.eventType !== 'change' && evt.eventType !== 'rename') return;
    _stats.considered++;
    const why = decide(evt);
    if (why !== 'ok') {
      if (why === 'personal') _stats.skippedPersonal++;
      else if (why === 'no-signal') { _stats.skippedNoSignal++; _sample('no-signal', evt.filename); }
      else if (why === 'ext') { _stats.skippedExt++; _sample('ext', evt.filename); }
      else if (why === 'temp') { _stats.skippedTemp++; }
      else if (why === 'junk') { _stats.skippedJunk++; _sample('junk', evt.filename); }
      return;
    }
    // 저장 연타(엑셀 자동저장·복사 중) 흡수: 마지막 변경 후 8초 조용하면 올린다. 이후 같은 파일은 90초 디바운스.
    const prev = _timers.get(evt.fullPath); if (prev) clearTimeout(prev);
    _timers.set(evt.fullPath, setTimeout(() => { _timers.delete(evt.fullPath); _upload(evt).catch(() => {}); }, 8000));
  } catch {}
}

const _queueRetry = (evt, tries, why) => { if (tries >= RETRY_MAX) { _stats.failed++; _stats.lastError = '포기: ' + why; _sample('failed', evt.filename); console.warn(`[work-file-uploader] 포기(${why}) ${evt.filename}`); return; } _retry.set(evt.fullPath, { tries: tries + 1, evt }); };
async function _upload(evt, tries = 0) {
  const cfg = await _config(); if (!cfg || !cfg.enabled) return;
  const last = _lastAt.get(evt.fullPath) || 0; if (tries === 0 && Date.now() - last < 90 * 1000) return;
  let st; try { st = fs.statSync(evt.fullPath); } catch { return; } // 삭제/이동됨
  if (!st.isFile()) return;
  if (st.size < MIN_BYTES) { if (tries === 0) { _stats.skippedTooSmall++; _sample('too-small', evt.filename); } return; }
  if (st.size > MAX_BYTES) { if (tries === 0) { _stats.skippedTooBig++; _sample('too-big', evt.filename); } return; } // 서버 FILE_MAX 25MB 동일 — 유지
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
      _seenSha.set(sha, Date.now()); _stats.uploaded++; _sample('uploaded', evt.filename);
      const c = j.classification || {};
      console.log(`[work-file-uploader] ${j.duplicate ? '중복' : '업로드'} ${evt.filename} → ${c.cycle || '-'} / ${c.stage || '-'}${c.sensitive ? ' 🔒' : ''}`);
    } else if (r.status >= 500 || r.status === 429) { if (r.status === 507) { _stats.server507++; _stats.lastError = '507 업무드라이브 저장공간 부족(서버)'; _sample('server-507', evt.filename); } _stats.serverRetry++; _queueRetry(evt, tries, 'server ' + r.status); }
    else { _stats.failed++; _stats.lastError = `${r.status} ${j.error || ''}`.trim(); _sample('failed', evt.filename); console.warn(`[work-file-uploader] 실패 ${r.status} ${evt.filename}: ${j.error || ''}`); } // 4xx는 재시도해도 같음
  } catch (e) { _stats.lastError = 'network: ' + e.message; _queueRetry(evt, tries, 'network'); }
  // sha 캐시 7일 정리
  const cut = Date.now() - 7 * 86400e3; for (const [k, at] of _seenSha) if (at < cut) _seenSha.delete(k);
}

function getStats() { return { ..._stats, enabled: !!(_cfg && _cfg.enabled), cfgUser: _cfg ? (_cfg.userName || '') : '', cfgReason: _cfg ? (_cfg.reason || '') : 'not-fetched', retryQueue: _retry.size, samples: _samples }; } // samples: 사유별 최근 파일명(개인 제외) — 서버에서 바로 누락 원인 확인

// 기존 파일 일괄 업로드(backfill) — 서버 명령 'drive-backfill' 로 1회 실행. 감시 폴더 3곳을 하위 depth 단계까지 훑어
// 같은 게이트(decide)를 통과하는 파일만, 최근 maxAgeDays 내 수정본만, 초당 1건 간격으로 올린다(서버·PC 부하 방지).
// 중복(sha)은 서버가 걸러 주므로 여러 번 실행해도 안전하다.
let _backfillRunning = false;
async function backfill({ depth = 3, maxFiles = 1000, maxAgeDays = 548, dryRun = false } = {}) {
  if (_backfillRunning) return { ok: false, reason: 'already-running' };
  const cfg = await _config(); if (!cfg || !cfg.enabled) { _stats.lastBackfill = { at: new Date().toISOString(), ok: false, reason: 'not-enabled' }; return { ok: false, reason: 'not-enabled' }; }
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
  _stats.lastBackfill = { at: new Date().toISOString(), ok: true, candidates: found.length, attempted: n };
  console.log(`[work-file-uploader] backfill 완료: 시도 ${n}, 누적 업로드 ${s.uploaded}, 중복 ${s.skippedDup}, 실패 ${s.failed}`);
  return { ok: true, candidates: found.length, attempted: n, stats: s };
}

module.exports = { init, onFileChange, decide, getStats, backfill, getConfig: _config };
