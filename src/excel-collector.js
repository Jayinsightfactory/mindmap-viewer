'use strict';
/**
 * excel-collector.js — 발주서 xlsx 선별 수집 (데몬 측)
 *
 * 목적: 직원이 다루는 "발주서" 엑셀만 서버로 올려, 서버가 셀값을 구조화 저장하도록 한다.
 *       (screen-input 필드가 공백이라 톡방값↔시트값 셀단위 대조가 불가능했던 문제 해결)
 *
 * 동작:
 *   1) file-change-watcher가 감지한 file.change 이벤트를 받아
 *   2) "발주서 업무 xlsx"만 선별(파일명 키워드 + 확장자 + 임시파일 제외)
 *   3) mtime+size 로 dedup (바뀐 것만)
 *   4) 원본 파일을 base64로 POST /api/daemon/excel-ingest (토큰 + X-Device-Id)
 *
 * 최소수집 원칙: 개인/비업무 파일은 절대 올리지 않는다. 파일명이 발주 키워드에
 * 명시적으로 매칭될 때만 수집한다. 서버 2mb body 한도 안에서만 전송(대용량 스킵).
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');
const https = require('https');

// ── 설정 ──────────────────────────────────────────────────────────────────────
// [2026-09-10] 기존 키워드 4종(발주/라움/주광/초이문)은 실제 업무파일의 5.5%만 잡았다
//   (file.change 엑셀 이벤트 1778건 중 98건). 실제 파일명 대다수는 `3401_콜롬비아수국.xlsx`,
//   `37-2_Holex.xlsx`, `33-1태국.xlsx` 같은 {차수코드}_{거래처} 패턴이라 키워드에 안 걸렸다.
//   → 문서유형어/거래처명/차수코드 중 하나라도 맞으면 통과(실측 커버리지 83.1%).
// 단 "좁게 유지 — 넓히면 개인/비업무 파일이 딸려 올라감"이라는 원래 설계 의도는 유지한다:
//   DENY를 먼저 적용해 개인/민감 파일을 차단하고, 카드·이용내역류는 의도적으로 제외한다.
const PO_KEYWORDS = ['발주', '라움', '주광', '초이문'];   // 하위호환(명시 키워드)
// 개인/민감 파일 차단 — 무조건 우선
const DENY_PATTERN = /이력서|급여|연봉|주민|가족|개인|사진|청첩|진단서|보험|의료|카드명세|통장|비밀번호|password|resume|salary|personal|private/i;
// 업무 문서유형어
const DOCTYPE_KEYWORDS = ['발주', '견적', '거래명세', '손익', '정산', '출고', '입고', '재고', '수량표',
  '단가', '매입', '매출', '선발주', '원가', '물량', '명세서', '원장', '판매내역', '주문',
  'pedido', 'invoice', 'packing', 'orden', 'claim', 'preorder'];
// 거래처·농장·산지명
const PARTNER_KEYWORDS = ['라움', '주광', '초이문', '일신', '늘봄', '미카엘', '홀렉스', 'holex',
  '콜롬비아', '콜카장', 'colombia', '에콰도르', 'ecuador', '네노바', 'nenova', '미우', '센스앤센서',
  '신라', '태림'];
// 차수코드 패턴: "34차" / "33-2_" / "3401_콜롬비아" / "33-1태국" / "36초이문"
const CYCLE_PATTERNS = [
  /(^|[^0-9])\d{1,3}\s*차([^0-9]|$)/,
  /(^|[_\-\s])\d{2,4}[-_]\d{1,2}(?![0-9])/,
  /(^|[_\-\s])\d{4}[_\-][^\d]/,
  /^\d{2,3}(?![년월일.\s])[가-힣A-Za-z]/,   // "9월"·"25년"류 제외
];
const EXCEL_EXT   = /\.xlsx?$/i;            // .xlsx / .xls 만
const MAX_RAW_BYTES = 1.2 * 1024 * 1024;    // 서버 2mb JSON 한도 방어(base64 ~1.37x → <1.7mb)

// ── 상태 ──────────────────────────────────────────────────────────────────────
let _serverUrl = null;
let _token     = '';
let _enabled   = false;
const _inflight = new Set();                // 중복 업로드 방지(경로 단위 락)
const STATE_FILE = path.join(os.homedir(), '.orbit', 'excel-collect-state.json');
let _state = {};                            // { fullPath: { mtimeMs, size } }

function _loadState() {
  try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { _state = {}; }
}
function _saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state), 'utf8');
  } catch {}
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
function init(opts = {}) {
  _serverUrl = opts.serverUrl || null;
  _token     = opts.token || '';
  _enabled   = !!_serverUrl;
  _loadState();
  if (_enabled) console.log('[excel-collector] 발주서 수집 활성화');
  return _enabled;
}

// ── 발주서 판별 ────────────────────────────────────────────────────────────────
function isPurchaseOrderFile(filename) {
  if (!filename) return false;
  if (filename.startsWith('~$') || filename.startsWith('.')) return false; // 임시/락 파일
  if (!EXCEL_EXT.test(filename)) return false;
  if (DENY_PATTERN.test(filename)) return false;               // 개인/민감 파일 우선 차단
  if (PO_KEYWORDS.some(k => filename.includes(k))) return true; // 기존 규칙(하위호환)
  const low = filename.toLowerCase();
  if (DOCTYPE_KEYWORDS.some(k => low.includes(k.toLowerCase()))) return true;
  if (PARTNER_KEYWORDS.some(k => low.includes(k.toLowerCase()))) return true;
  if (CYCLE_PATTERNS.some(re => re.test(filename))) return true;
  return false;
}

// ── file-change-watcher 콜백 진입점 ────────────────────────────────────────────
// evt = { filename, dir, fullPath, isExcel, eventType, ... }
function onFileChange(evt) {
  if (!_enabled || !evt || !evt.fullPath) return;
  try {
    if (!isPurchaseOrderFile(evt.filename)) return;
    if (_inflight.has(evt.fullPath)) return;

    let stat;
    try { stat = fs.statSync(evt.fullPath); } catch { return; } // 삭제/이동된 파일
    if (!stat.isFile()) return;

    // dedup: mtime+size 동일하면 스킵(변경분만)
    const prev = _state[evt.fullPath];
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return;

    if (stat.size > MAX_RAW_BYTES) {
      console.warn(`[excel-collector] 스킵(용량 ${(stat.size/1024/1024).toFixed(1)}MB > 1.2MB): ${evt.filename}`);
      // 상태는 갱신해 반복 경고 방지
      _state[evt.fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
      _saveState();
      return;
    }

    _inflight.add(evt.fullPath);
    _upload(evt.fullPath, evt.filename, stat)
      .then((ok) => {
        if (ok) {
          _state[evt.fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
          _saveState();
          console.log(`[excel-collector] 업로드 완료: ${evt.filename}`);
        }
      })
      .catch(() => {})
      .finally(() => { _inflight.delete(evt.fullPath); });
  } catch (e) {
    console.warn('[excel-collector] onFileChange 오류:', e.message);
  }
}

// ── 서버 업로드 ────────────────────────────────────────────────────────────────
function _upload(fullPath, filename, stat) {
  return new Promise((resolve) => {
    let base64;
    try { base64 = fs.readFileSync(fullPath).toString('base64'); }
    catch { return resolve(false); }

    const payload = JSON.stringify({
      filename,
      fileBase64: base64,
      hostname: os.hostname(),
      mtime: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
    });

    let url;
    try { url = new URL('/api/daemon/excel-ingest', _serverUrl); } catch { return resolve(false); }
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Device-Id': encodeURIComponent(os.hostname()),
    };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: 20000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    req.write(payload);
    req.end();
  });
}

module.exports = { init, onFileChange, isPurchaseOrderFile };
