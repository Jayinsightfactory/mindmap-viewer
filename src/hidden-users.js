'use strict';
// config/hidden-users.json 기반 '목록에서만 숨기기'. 데이터 삭제·수집 중단 없음.
// /my-work 에 iframe 으로 뜨는 페이지들의 API 응답에서 숨김 사용자 항목을 걸러낸다.
const path = require('path');
const fs = require('fs');

const FILE = path.join(__dirname, '..', 'config', 'hidden-users.json');
let _cache = null;
function load() {
  if (_cache) return _cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const ids = new Set(); const names = new Set();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    ids.add(k);
    if (v && typeof v === 'object' && Array.isArray(v.names)) v.names.forEach((n) => names.add(String(n).trim().toLowerCase()));
  }
  _cache = { ids, names };
  return _cache;
}
function _reset() { _cache = null; }

const ID_KEYS = ['userId', 'user_id', 'uid', 'ownerId', 'personId'];
const NAME_KEYS = ['name', 'userName', 'user_name', 'person', 'personName', 'displayName'];
function isHiddenValue(v) {
  if (v == null) return false;
  const s = String(v).trim();
  const { ids, names } = load();
  return ids.has(s) || names.has(s.toLowerCase());
}
// 문자열 항목: '임재용', 'jaeyong lim(3건)' 처럼 숨김 이름으로 시작하는 목록 원소
function isHiddenString(str) {
  const t = String(str).trim().toLowerCase();
  const { ids, names } = load();
  if (ids.has(String(str).trim())) return true;
  for (const n of names) if (t === n || (t.startsWith(n) && /^[\s(（:,·-]/.test(t.slice(n.length)))) return true;
  return false;
}
function isHiddenEntry(o) {
  if (typeof o === 'string') return isHiddenString(o);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  for (const k of ID_KEYS) if (typeof o[k] === 'string' && isHiddenValue(o[k])) return true;
  if (typeof o.id === 'string' && load().ids.has(o.id)) return true;
  for (const k of NAME_KEYS) if (typeof o[k] === 'string' && isHiddenValue(o[k])) return true;
  return false;
}
// 배열에서 숨김 항목 제거 + 객체 키가 숨김 사용자ID인 맵(byUser 등)도 제거. 깊이 제한.
function scrub(x, depth = 0) {
  if (depth > 8 || x == null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.filter((e) => !isHiddenEntry(e)).map((e) => scrub(e, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (load().ids.has(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

// /my-work 탭들이 쓰는 API 접두사
const PREFIXES = ['/api/flow', '/api/timetable', '/api/work-flow', '/api/vision/task-sessions', '/api/vision/thumbnails',
  '/api/vision/screen-input', '/api/learning', '/api/purposes', '/api/admin/all-users', '/api/workspace/',
  '/api/work-analysis', '/api/intelligence', '/api/mining', '/api/replay', '/api/recordings'];

async function requesterId(req) {
  try {
    const raw = String((req.headers && req.headers.authorization) || '').replace('Bearer ', '').trim();
    if (!raw) return null;
    const a = require('./auth');
    const u = a.verifyToken(raw) || (a.verifyTokenAsync ? await a.verifyTokenAsync(raw) : null);
    return (u && (u.id || u.userId)) || null;
  } catch { return null; }
}

async function middleware(req, res, next) {
  if (req.method !== 'GET' || !PREFIXES.some((p) => req.path.startsWith(p))) return next();
  // 진단용 우회(화면엔 안 씀): ?showHidden=1 또는 X-Orbit-Show-Hidden: 1
  if ((req.query && req.query.showHidden === '1') || (req.headers && req.headers['x-orbit-show-hidden'] === '1')) return next();
  const q = req.query || {};
  if ([q.userId, q.user_id, q.uid].some((v) => v != null && isHiddenValue(v))) {
    // [2026-10-05] 숨김 사용자 본인(사장님 토큰)이 자기 userId로 조회 = '내 데이터' → 그대로 통과
    const qIds = [q.userId, q.user_id, q.uid].filter((v) => v != null).map((v) => String(v).trim());
    const self = await requesterId(req);
    if (self && qIds.includes(self)) return next();
    return res.status(404).json({ error: 'hidden_user', hidden: true });
  }
  const orig = res.json.bind(res);
  res.json = (body) => { try { return orig(scrub(body)); } catch { return orig(body); } };
  next();
}

module.exports = { isHiddenString, load, isHiddenValue, isHiddenEntry, scrub, middleware, PREFIXES, _reset };
