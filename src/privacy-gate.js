'use strict';
/**
 * privacy-gate.js — 송신 전 개인정보 게이트 (사장님 결정 2026-09-29)
 *
 * classify({app, windowTitle, url}) → {allow, kind, reason}
 *   kind: 'work' | 'messenger_work' | 'messenger_private' | 'personal_web' | 'paused'
 * 정책: 서버 GET /api/daemon/privacy-policy (1시간 캐시) → ~/.orbit/privacy-policy.json 폴백 → 내장 기본값.
 * 일시정지: ~/.orbit/personal-pause-until (ISO 시각). 그 시각까지 전부 kind='paused'.
 * 차단 건수: ~/.orbit/privacy-stats-YYYY-MM-DD.json 누적 → 'privacy.stats' 이벤트(건수만)로 서버 전송.
 * 판정은 동기·무I/O(캐시) — 키 입력마다 불려도 됨. 네트워크는 전부 비동기·실패 무시.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const ORBIT_DIR = path.join(os.homedir(), '.orbit');
const LOCAL_POLICY = path.join(ORBIT_DIR, 'privacy-policy.json');
const PAUSE_FILE = path.join(ORBIT_DIR, 'personal-pause-until');

const DEFAULT_POLICY = {
  version: 'builtin',
  messengerApps: ['^kakaotalk$', '카카오톡', '^wechat$', '^weixin$', '微信', '^line$', '^telegram$', '^whatsapp$', '^discord$', '^nateon$', '네이트온', '^slack$'],
  messengerTitlePatterns: ['^카카오톡$', '^kakaotalk$', '^wechat$', '^weixin$', '^微信$', '^line$', '^telegram$', '^whatsapp$'],
  workRooms: ['수입방', '현장방', '영업방', '현장 추가취소방', '수입불량방', '빌번호방', '네노바&선율방', '견적방', '스케줄방'],
  workMessengerUsers: {},
  localExtraction: { enabled: false, consentedUsers: [] },
  workDomains: ['nenovaweb.com', 'nenova', 'ecount.com', 'ecounterp.com', 'hometax.go.kr', 'unipass.customs.go.kr', 'customs.go.kr',
    'ibk.co.kr', 'kbstar.com', 'shinhan.com', 'wooribank.com', 'hanabank.com', 'kebhana.com', 'nonghyup.com', 'nhbank.com',
    'koreanair.com', 'asianacargo.com', 'flyasiana.com', 'track-trace.com', 'awb', 'cargo',
    'mindmap-viewer', 'railway.app', 'localhost', '127.0.0.1',
    'docs.google.com', 'drive.google.com', 'sheets.google.com', 'onedrive.live.com', 'sharepoint.com', 'office.com'],
  personalTitlePatterns: ['Google 검색', '- Google Search', '- NAVER', '네이버 쇼핑', 'NAVER 쇼핑', 'YouTube', '쿠팡', 'Coupang', '11번가', 'G마켓', 'Gmarket',
    '옥션', '당근', '인스타그램', 'Instagram', 'Facebook', '넷플릭스', 'Netflix', '웹툰', '나무위키', '- Daum 검색'],
};

const PERSONAL_TITLE_MARK = '[개인]';

// ── 설정(~/.orbit-config.json) ──
function _orbitConfig() {
  try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r); } catch { return {}; }
}

// ── 정책 로드/컴파일 ──
let _policy = null;          // 컴파일된 정책
let _policyFetchedAt = 0;
let _policyFetching = false;
const POLICY_TTL_MS = 60 * 60 * 1000;

function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _compileRegexList(list) {
  const out = [];
  for (const s of (Array.isArray(list) ? list : [])) { try { if (typeof s === 'string' && s) out.push(new RegExp(s, 'i')); } catch {} }
  return out;
}
// [2026-09-29] 업무방 판정 = 정규화한 방 이름 완전일치(부분일치 금지 — '화훼'가 '화훼 관리 프로그램'을 통과시키던 구멍).
// 정규화: NFKC·소문자·공백 1칸·양끝 장식(●★☆*)·카톡 제목 꼬리(" YYYY-MM-DD", "님의 메시지", "'s message", " - 카카오톡", 말줄임, 인원수 "(12)"/" 12") 제거.
function normalizeRoomName(s) {
  let t = String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/\s*-\s*(카카오톡|kakaotalk)$/, '')
      .replace(/\s+\d{4}-\d{2}-\d{2}$/, '')
      .replace(/님의 메시지$/, '').replace(/'s message$/, '')
      .replace(/(\.{2,}|…)+$/, '')
      .replace(/\s*\(\d{1,4}\)$/, '').replace(/\s+\d{1,4}$/, '')
      .replace(/^[●★☆*\s]+|[●★☆*\s]+$/g, '')
      .trim();
    if (t === before) break;
  }
  return t;
}
function _compile(raw) {
  const p = Object.assign({}, DEFAULT_POLICY, raw || {});
  const me = _orbitConfig();
  const ids = [me.userId, me.hostname, os.hostname()].filter(Boolean).map(s => String(s).toLowerCase());
  const wmu = {};
  for (const [k, v] of Object.entries(p.workMessengerUsers || {})) { if (Array.isArray(v)) wmu[String(k).toLowerCase()] = v; }
  const myWorkMessengers = [];
  for (const id of ids) for (const m of (wmu[id] || [])) myWorkMessengers.push(String(m).toLowerCase());
  const le = p.localExtraction || {};
  const consented = (Array.isArray(le.consentedUsers) ? le.consentedUsers : []).map(s => String(s).toLowerCase());
  return {
    localExtract: !!le.enabled && ids.some(id => consented.includes(id)),
    workRoomsOrig: (p.workRooms || []).filter(s => typeof s === 'string' && s),
    version: p.version || '',
    messengerApps: _compileRegexList(p.messengerApps),
    messengerTitles: _compileRegexList(p.messengerTitlePatterns),
    workRooms: (p.workRooms || []).filter(s => typeof s === 'string' && s).map(normalizeRoomName),
    workDomains: (p.workDomains || []).filter(s => typeof s === 'string' && s).map(s => s.toLowerCase()),
    personalTitles: (p.personalTitlePatterns || []).filter(s => typeof s === 'string' && s).map(s => new RegExp(_escRe(s), 'i')),
    myWorkMessengers,
  };
}
function _loadLocalPolicy() {
  try { let r = fs.readFileSync(LOCAL_POLICY, 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r); } catch { return null; }
}
function _getPolicy() {
  if (!_policy) { _policy = _compile(_loadLocalPolicy() || DEFAULT_POLICY); }
  if (Date.now() - _policyFetchedAt > POLICY_TTL_MS) _refreshPolicy();
  return _policy;
}
function _httpGetJson(urlStr, token, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, timeout }, (res) => {
        let d = ''; res.setEncoding('utf8'); res.on('data', c => { d += c; });
        res.on('end', () => { if (res.statusCode !== 200) return resolve(null); try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}
function _refreshPolicy() {
  if (_policyFetching) return;
  _policyFetching = true;
  _policyFetchedAt = Date.now(); // 실패해도 1시간 뒤 재시도(폭주 방지)
  const cfg = _orbitConfig();
  if (!cfg.serverUrl) { _policyFetching = false; return; }
  _httpGetJson(new URL('/api/daemon/privacy-policy', cfg.serverUrl).toString(), cfg.token).then((j) => {
    const pol = j && (j.policy || j);
    if (pol && Array.isArray(pol.workRooms)) {
      _policy = _compile(pol);
      try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); fs.writeFileSync(LOCAL_POLICY, JSON.stringify(pol, null, 2), 'utf8'); } catch {}
    }
  }).finally(() => { _policyFetching = false; });
}

// ── 개인 용무 일시정지 ──
let _pauseCache = { until: 0, at: 0 };
function getPauseUntil() {
  const now = Date.now();
  if (now - _pauseCache.at < 5000) return _pauseCache.until;
  let until = 0;
  try { const s = fs.readFileSync(PAUSE_FILE, 'utf8').trim(); const t = Date.parse(s); if (Number.isFinite(t)) until = t; } catch {}
  _pauseCache = { until, at: now };
  _pollServerPause();
  return until;
}
function setPauseUntil(isoOrNull) {
  try {
    fs.mkdirSync(ORBIT_DIR, { recursive: true });
    if (!isoOrNull) { try { fs.unlinkSync(PAUSE_FILE); } catch {} }
    else fs.writeFileSync(PAUSE_FILE, new Date(isoOrNull).toISOString(), 'utf8');
  } catch {}
  _pauseCache = { until: 0, at: 0 };
}
// 서버(/my-privacy.html 버튼)에서 건 일시정지를 1분마다 반영 — 트레이가 없는 PC용
let _pausePollAt = 0;
function _pollServerPause() {
  const now = Date.now();
  if (now - _pausePollAt < 60 * 1000) return;
  _pausePollAt = now;
  const cfg = _orbitConfig();
  if (!cfg.serverUrl || !cfg.token) return;
  _httpGetJson(new URL('/api/privacy/pause', cfg.serverUrl).toString(), cfg.token, 5000).then((j) => {
    if (!j || !('pauseUntil' in j)) return;
    const srv = j.pauseUntil ? Date.parse(j.pauseUntil) : 0;
    const local = _pauseCache.until;
    if (srv && srv > Date.now() && srv !== local) setPauseUntil(new Date(srv).toISOString());
    else if (!srv && j.cleared && local > Date.now()) setPauseUntil(null); // 서버에서 해제
  }).catch(() => {});
}

// ── 판정 ──
function _hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }

function classify(input = {}) {
  const app = String(input.app || '').trim();
  const title = String(input.windowTitle || '').trim();
  const url = String(input.url || '').trim();
  const pol = _getPolicy();

  const pauseUntil = getPauseUntil();
  if (pauseUntil && Date.now() < pauseUntil) {
    _noteKindTime('paused');
    return { allow: false, kind: 'paused', reason: 'personal_pause' };
  }

  const appL = app.toLowerCase().replace(/\.exe$/, '');
  const isMessenger = (appL && pol.messengerApps.some(re => re.test(appL))) || (title && pol.messengerTitles.some(re => re.test(title)));
  if (isMessenger) {
    const t = title.toLowerCase();
    if (pol.myWorkMessengers.length && pol.myWorkMessengers.some(m => appL.includes(m) || t.includes(m))) {
      return { allow: true, kind: 'messenger_work', reason: 'work_messenger_user' };
    }
    const nt = title ? normalizeRoomName(title) : '';
    const ri = nt ? pol.workRooms.indexOf(nt) : -1;
    if (ri >= 0) return { allow: true, kind: 'messenger_work', reason: 'work_room', roomName: pol.workRoomsOrig[ri] || null, roomKind: 'group' };
    // B안(로컬 처리): 정책 enabled + 이 PC 사용자가 동의 명단에 있을 때만. 원문은 PC 메모리에서 업무 항목만 추출(local-work-extractor)
    if (pol.localExtract) { _noteKindTime('messenger_local'); return { allow: false, kind: 'messenger_local', reason: 'local_extract', local: true, roomName: null, roomKind: 'unknown' }; }
    _noteKindTime('messenger_private');
    return { allow: false, kind: 'messenger_private', reason: title ? 'not_work_room' : 'messenger_no_title' };
  }

  if (url) {
    const host = _hostOf(url);
    if (!host) return { allow: false, kind: 'personal_web', reason: 'bad_url' };
    if (pol.workDomains.some(d => host.includes(d))) return { allow: true, kind: 'work', reason: 'work_domain' };
    return { allow: false, kind: 'personal_web', reason: 'non_work_domain' };
  }

  if (title === PERSONAL_TITLE_MARK || (title && pol.personalTitles.some(re => re.test(title)))) {
    return { allow: false, kind: 'personal_web', reason: 'personal_title' };
  }
  return { allow: true, kind: 'work', reason: 'default_work' };
}

/** 창제목 전용(앱 정보 없음) — sanitizeWindowTitle 경로. 개인 패턴이면 '[개인]' */
function redactTitleIfPersonal(title) {
  if (!title) return title;
  try {
    const pol = _getPolicy();
    if (pol.personalTitles.some(re => re.test(title))) return PERSONAL_TITLE_MARK;
  } catch {}
  return title;
}

/** 차단 판정 결과에 맞는 대체 제목 */
function maskedTitle(kind) {
  if (kind === 'messenger_private') return '[메신저-개인]';
  if (kind === 'messenger_local') return '[메신저]';
  if (kind === 'paused') return '[개인용무]';
  return PERSONAL_TITLE_MARK;
}

// ── 차단 통계 ──
function _today() { const d = new Date(Date.now() + 9 * 3600 * 1000); return d.toISOString().slice(0, 10); } // KST
function _statsPath(day) { return path.join(ORBIT_DIR, `privacy-stats-${day}.json`); }
let _stats = null, _statsDay = '', _statsDirty = false, _statsSaveTimer = null;
let _lastSentAt = 0, _lastSentDay = '';
function _loadStats() {
  const day = _today();
  if (_stats && _statsDay === day) return _stats;
  if (_stats && _statsDirty) _flushStats(true); // 날짜 바뀜 → 전날 마감 전송
  _statsDay = day;
  try { _stats = JSON.parse(fs.readFileSync(_statsPath(day), 'utf8')); } catch { _stats = null; }
  if (!_stats || _stats.date !== day) _stats = { date: day, blocked: {}, bySource: {}, allowed: {}, pausedMinutes: 0, minutes: {}, updatedAt: null };
  if (!_stats.minutes) _stats.minutes = {};
  return _stats;
}
function record(source, verdict, count = 1) {
  // 사장님 결정(2026-09-29): 개인 웹은 시간·건수·도메인 모두 남기지 않음(로컬 카운터 포함)
  if (verdict && verdict.kind === 'personal_web') return;
  try {
    const s = _loadStats();
    if (verdict.allow) {
      s.allowed[source] = (s.allowed[source] || 0) + count;
    } else {
      const k = verdict.kind + ':' + verdict.reason;
      s.blocked[k] = (s.blocked[k] || 0) + count;
      s.bySource[source] = s.bySource[source] || {};
      s.bySource[source][verdict.kind] = (s.bySource[source][verdict.kind] || 0) + count;
      _statsDirty = true;
    }
    s.updatedAt = new Date().toISOString();
    _scheduleSave();
  } catch {}
}
// 차단 종류별 사용 시간(분) — 판정이 연속으로 불린 간격(5분 이내)을 누적. 내용 없이 시간만.
const _kindTick = {};
function _noteKindTime(kind) {
  try {
    const now = Date.now();
    const s = _loadStats();
    const last = _kindTick[kind] || 0;
    if (last && now - last < 5 * 60 * 1000) {
      const add = (now - last) / 60000;
      s.minutes[kind] = Math.round(((s.minutes[kind] || 0) + add) * 10) / 10;
      if (kind === 'paused') s.pausedMinutes = s.minutes[kind];
      _statsDirty = true; _scheduleSave();
    }
    _kindTick[kind] = now;
  } catch {}
}
function _scheduleSave() {
  if (process.env.ORBIT_PRIVACY_NOIO) return; // 테스트: 디스크·서버 전송 없음
  if (_statsSaveTimer) return;
  _statsSaveTimer = setTimeout(() => { _statsSaveTimer = null; _flushStats(false); }, 30 * 1000);
  if (_statsSaveTimer.unref) _statsSaveTimer.unref();
}
function _flushStats(force) {
  if (!_stats) return;
  try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); fs.writeFileSync(_statsPath(_stats.date), JSON.stringify(_stats), 'utf8'); } catch {}
  // 서버 전송: 변경 있을 때 30분에 1회 + 날짜 바뀔 때 + 하루 첫 전송
  const now = Date.now();
  if (force || (_statsDirty && now - _lastSentAt > 30 * 60 * 1000) || _lastSentDay !== _stats.date) {
    _sendStats(Object.assign({}, _stats));
    _lastSentAt = now; _lastSentDay = _stats.date; _statsDirty = false;
  }
}
function _sendStats(stats) {
  try {
    const cfg = _orbitConfig();
    if (!cfg.serverUrl) return;
    const payload = JSON.stringify({ events: [{
      id: 'privacy-stats-' + os.hostname() + '-' + stats.date + '-' + Date.now(),
      type: 'privacy.stats', source: 'privacy-gate', sessionId: 'daemon-' + os.hostname(),
      timestamp: new Date().toISOString(),
      data: { date: stats.date, blocked: stats.blocked, bySource: stats.bySource, allowed: stats.allowed, pausedMinutes: stats.pausedMinutes, minutes: stats.minutes, policyVersion: (_policy && _policy.version) || '', hostname: os.hostname() },
    }] });
    const u = new URL('/api/hook', cfg.serverUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Device-Id': encodeURIComponent(os.hostname()) };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers, timeout: 10000 }, r => r.resume());
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.write(payload); req.end();
  } catch {}
}
// 하루 1회 보장(변경 없어도) — 1시간마다 확인
const _dailyTimer = setInterval(() => { try { _loadStats(); if (_lastSentDay !== _statsDay) _flushStats(false); } catch {} }, 60 * 60 * 1000);
if (_dailyTimer.unref) _dailyTimer.unref();

// 테스트용: 정책 주입
function _setPauseForTest(ms) { _pauseCache = { until: ms || 0, at: Date.now() + 1e9 }; }
function _setPolicyForTest(raw) { _policy = _compile(raw || DEFAULT_POLICY); _policyFetchedAt = Date.now(); }

module.exports = { classify, normalizeRoomName, record, redactTitleIfPersonal, maskedTitle, getPauseUntil, setPauseUntil, DEFAULT_POLICY, PERSONAL_TITLE_MARK, _setPolicyForTest, _setPauseForTest };
