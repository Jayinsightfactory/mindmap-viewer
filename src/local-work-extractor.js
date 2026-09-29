'use strict';
/**
 * local-work-extractor.js — 메신저 내용 로컬 처리 (사장님 결정 2026-09-29)
 *
 * 원칙: 메신저 원문(키보드 입력·화면·OCR 텍스트)은 이 PC 메모리에서만 다루고 디스크·서버·외부 AI 로 보내지 않는다.
 *       원문에서 사전 기반으로 뽑은 '업무 항목'(차수·품목·거래처·농장·수량·업무어)만 'messenger.work' 이벤트로 전송.
 *       업무 항목이 하나도 없으면 아무것도 보내지 않고 로컬 카운터(메신저 개인 분)만 올린다.
 * 1단계 = 사전·정규식만(LLM 없음). 2단계(미구현): 로컬 소형 LLM(ollama 등)으로 요약 품질 향상 — PRIVACY_POLICY.md 참고.
 *
 * 출력 스키마(원문·상대방 이름·전화번호 없음 — 사전에 있는 이름과 숫자+단위만 나갈 수 있게 구조적으로 제한):
 *   { app, roomKind:'group'|'direct'|'unknown', roomName: workRooms 매칭 시만(아니면 null),
 *     cycle, products[], customers[], farms[], quantities[{value,unit}], keywords[], source, ts }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

let _hangul = null; try { _hangul = require('./hangul'); } catch {}

const DICT_CACHE = path.join(os.homedir(), '.orbit', 'work-dictionary.json');
const OCR_PS1 = path.join(__dirname, '..', 'setup', 'ocr-screen-memory.ps1');
const DEFAULT_DICT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'work-dictionary.json'), 'utf8')); } catch { return { products: [], customers: [], farms: [], keywords: ['발주', '입고', '분배', '출고', '견적', '송금', '클레임', '인보이스', 'AWB'], units: ['박스', '단', '송이', 'box'] }; } })();

function _orbitConfig() {
  try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r); } catch { return {}; }
}

// ── 사전 (서버 GET /api/daemon/work-dictionary, 6시간 캐시. 사전은 원문이 아니므로 디스크 캐시 허용) ──
let _dict = null, _dictAt = 0, _dictFetching = false;
function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _compileDict(d) {
  const norm = (arr, min) => [...new Set((Array.isArray(arr) ? arr : []).map(s => String(s || '').trim()).filter(s => s.length >= min))]
    .sort((a, b) => b.length - a.length);
  const mk = (list) => list.map(s => ({ name: s, re: /^[\x00-\x7f]+$/.test(s) ? new RegExp('(^|[^a-z0-9])' + _escRe(s.toLowerCase()) + '($|[^a-z0-9])', 'i') : null, lower: s.toLowerCase() }));
  const units = norm(d.units || DEFAULT_DICT.units, 1);
  return {
    products: mk(norm([...(d.products || []), ...(DEFAULT_DICT.products || [])], 2)),
    customers: mk(norm(d.customers, 2)),
    farms: mk(norm([...(d.farms || []), ...(DEFAULT_DICT.farms || [])], 3)),
    keywords: mk(norm([...(d.keywords || []), ...(DEFAULT_DICT.keywords || [])], 2)),
    qtyRe: new RegExp('(\\d{1,5}(?:[.,]\\d{1,2})?)\\s*(' + units.map(_escRe).join('|') + ')(?![a-z가-힣])', 'gi'),
  };
}
function _getDict() {
  if (!_dict) {
    let d = null; try { d = JSON.parse(fs.readFileSync(DICT_CACHE, 'utf8')); } catch {}
    _dict = _compileDict(d || DEFAULT_DICT);
  }
  if (Date.now() - _dictAt > 6 * 3600 * 1000) _refreshDict();
  return _dict;
}
function _refreshDict() {
  if (_dictFetching) return;
  _dictFetching = true; _dictAt = Date.now();
  const cfg = _orbitConfig();
  if (!cfg.serverUrl) { _dictFetching = false; return; }
  try {
    const u = new URL('/api/daemon/work-dictionary', cfg.serverUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {}; if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'GET', headers, timeout: 15000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
      res.on('end', () => {
        _dictFetching = false;
        try { const j = JSON.parse(b); const d = j.dictionary || j; if (res.statusCode === 200 && d && Array.isArray(d.keywords)) { _dict = _compileDict(d); try { fs.writeFileSync(DICT_CACHE, JSON.stringify(d), 'utf8'); } catch {} } } catch {}
      });
    });
    req.on('error', () => { _dictFetching = false; }); req.on('timeout', () => { req.destroy(); });
    req.end();
  } catch { _dictFetching = false; }
}

// ── 추출 (순수 함수 — 테스트 대상) ──
function _toReadable(text) {
  const t = String(text || '');
  // 키보드 버퍼는 두벌식 QWERTY 원시 입력 → 한글 복원(OCR 텍스트는 이미 한글)
  try { return _hangul ? _hangul.smartQwertyToHangul(t) : t; } catch { return t; }
}
function _find(list, hay, hayLower) {
  const out = [];
  for (const e of list) {
    if (out.length >= 10) break;
    if (e.re ? e.re.test(hay) : hayLower.includes(e.lower)) out.push(e.name);
  }
  return out;
}
function extract(text, opts = {}) {
  const d = opts.dict ? _compileDict(opts.dict) : _getDict();
  const hay = opts.readable ? String(text || '') : _toReadable(text);
  const lower = hay.toLowerCase();
  // 차수: 40-01차, 40-1차, 40차, 39-2A (접미 영문 1자 허용)
  let cycle = null;
  const cm = hay.match(/(?:^|[^\d])(\d{1,2})\s*-\s*(\d{1,2})\s*([a-z])?\s*차/i) || hay.match(/(?:^|[^\d])(\d{1,2})\s*-\s*(\d{1,2})([a-z])(?![a-z])/i) || hay.match(/(?:^|[^\d])(\d{1,2})\s*차(?!이|량)/);
  if (cm) { const wk = Number(cm[1]); if (wk >= 1 && wk <= 53) cycle = cm[2] ? `${String(wk).padStart(2, '0')}-${String(Number(cm[2])).padStart(2, '0')}${cm[3] ? cm[3].toUpperCase() : ''}` : String(wk).padStart(2, '0'); }
  const quantities = [];
  d.qtyRe.lastIndex = 0; let m;
  while ((m = d.qtyRe.exec(hay)) && quantities.length < 20) quantities.push({ value: Number(String(m[1]).replace(',', '.')), unit: m[2].toLowerCase() });
  const products = _find(d.products, hay, lower);
  const customers = _find(d.customers, hay, lower);
  const farms = _find(d.farms, hay, lower);
  const keywords = _find(d.keywords, hay, lower);
  // 업무 판정: 품목/거래처/농장/업무어 중 하나 이상, 또는 차수. 수량 단독은 업무 아님(사적 대화의 "2개" 등)
  const isWork = !!(cycle || products.length || customers.length || farms.length || keywords.length);
  return { isWork, cycle, products, customers, farms, quantities: isWork ? quantities : [], keywords };
}

// 전송 페이로드 구성 — 허용 필드만 명시적으로 복사(원문 필드 자체가 없음)
function buildPayload(ctx, ex, source) {
  return {
    app: String(ctx.app || '').slice(0, 40),
    roomKind: ctx.roomKind || 'unknown',
    roomName: ctx.roomName || null,
    cycle: ex.cycle || null,
    products: ex.products.slice(0, 10), customers: ex.customers.slice(0, 10), farms: ex.farms.slice(0, 10),
    quantities: ex.quantities.slice(0, 20).map(q => ({ value: q.value, unit: q.unit })),
    keywords: ex.keywords.slice(0, 10),
    source: source === 'ocr' ? 'ocr' : 'keyboard',
    ts: new Date().toISOString(),
  };
}

let _sender = null; // 테스트 주입용
function _send(data) {
  if (_sender) return _sender(data);
  try {
    const cfg = _orbitConfig();
    if (!cfg.serverUrl) return;
    const payload = JSON.stringify({ events: [{ id: 'msgwork-' + os.hostname() + '-' + Date.now(), type: 'messenger.work', source: 'local-work-extractor',
      sessionId: 'daemon-' + os.hostname(), timestamp: new Date().toISOString(), data }] });
    const u = new URL('/api/hook', cfg.serverUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Device-Id': encodeURIComponent(os.hostname()) };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers, timeout: 10000 }, r => r.resume());
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.write(payload); req.end();
  } catch {}
}
function _gate() { try { return require('./privacy-gate'); } catch { return null; } }

// 한 조각(메시지/OCR 화면) 처리: 업무면 전송, 아니면 로컬 카운터만. 원문은 여기서 끝나고 어디에도 남지 않음.
let _lastSig = '', _lastSigAt = 0;
function processText(ctx, text, source, startedAt) {
  const ex = extract(text, { readable: source === 'ocr' });
  const g = _gate();
  if (!ex.isWork) {
    if (g) g.record(source === 'ocr' ? 'screen' : 'keyboard', { allow: false, kind: 'messenger_local', reason: 'no_work_items' });
    return null;
  }
  const data = buildPayload(ctx, ex, source);
  // 같은 결과 반복 전송 방지(OCR 은 같은 화면을 자주 읽음) — 10분
  const sig = JSON.stringify([data.app, data.roomName, data.cycle, data.products, data.customers, data.farms, data.quantities, data.keywords]);
  if (sig === _lastSig && Date.now() - _lastSigAt < 10 * 60 * 1000) return null;
  _lastSig = sig; _lastSigAt = Date.now();
  if (g) g.record(source === 'ocr' ? 'screen' : 'keyboard', { allow: false, kind: 'messenger_local', reason: 'work_items_sent' });
  _send(data);
  return data;
}

// ── 키보드: 메신저 입력을 메모리 버퍼에 모았다가 Enter/창 전환/60초 무입력 시 처리 ──
let _buf = '', _bufCtx = null, _bufStart = 0, _idleTimer = null;
function _flushKeyboard() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const text = _buf, ctx = _bufCtx, st = _bufStart;
  _buf = ''; _bufCtx = null; _bufStart = 0;
  if (text && text.trim() && ctx) processText(ctx, text, 'keyboard', st);
}
function feedKey(verdict, app, ch) {
  const ctx = { app, roomKind: verdict.roomKind || 'unknown', roomName: verdict.roomName || null };
  if (_bufCtx && (_bufCtx.app !== ctx.app || _bufCtx.roomName !== ctx.roomName)) _flushKeyboard();
  if (!_bufCtx) { _bufCtx = ctx; _bufStart = Date.now(); }
  if (ch === '\b') _buf = _buf.slice(0, -1);
  else if (ch === '\n') { _buf += '\n'; _flushKeyboard(); return; }
  else _buf += ch;
  if (_buf.length > 4000) _buf = _buf.slice(-4000);
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(_flushKeyboard, 60 * 1000);
  if (_idleTimer.unref) _idleTimer.unref();
}

// ── 화면: 전면 메신저 창을 메모리에서 OCR (파일 저장 없음). 60초에 1회 제한, 비동기 ──
let _ocrBusy = false, _ocrAt = 0;
function ocrForeground(verdict, app) {
  if (process.platform !== 'win32' || _ocrBusy || Date.now() - _ocrAt < 60 * 1000) return;
  if (!fs.existsSync(OCR_PS1)) return;
  _ocrBusy = true; _ocrAt = Date.now();
  const ctx = { app, roomKind: verdict.roomKind || 'unknown', roomName: verdict.roomName || null };
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1],
    { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      _ocrBusy = false;
      let text = err ? '' : String(stdout || '');
      if (text.trim()) { try { processText(ctx, text, 'ocr', Date.now()); } catch {} }
      text = null; // 원문 참조 즉시 해제
    });
}

function _setSenderForTest(fn) { _sender = fn; }
module.exports = { extract, buildPayload, processText, feedKey, ocrForeground, flush: _flushKeyboard, _setSenderForTest };
