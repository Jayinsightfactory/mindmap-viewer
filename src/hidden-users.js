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
function isHiddenEntry(o) {
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

function middleware(req, res, next) {
  if (req.method !== 'GET' || !PREFIXES.some((p) => req.path.startsWith(p))) return next();
  // 진단용 우회(화면엔 안 씀): ?showHidden=1 또는 X-Orbit-Show-Hidden: 1
  if ((req.query && req.query.showHidden === '1') || (req.headers && req.headers['x-orbit-show-hidden'] === '1')) return next();
  const q = req.query || {};
  if ([q.userId, q.user_id, q.uid].some((v) => v != null && isHiddenValue(v))) {
    return res.status(404).json({ error: 'hidden_user', hidden: true });
  }
  const orig = res.json.bind(res);
  res.json = (body) => { try { return orig(scrub(body)); } catch { return orig(body); } };
  next();
}

module.exports = { load, isHiddenValue, isHiddenEntry, scrub, middleware, PREFIXES, _reset };
