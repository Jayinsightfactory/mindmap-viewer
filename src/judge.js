'use strict';
/**
 * judge.js — Jev식 "판단 계층". 문장을 만들지 않고 choice / score / bool + 확신도만 돌려준다.
 *   뒤쪽 엔진은 싸고 빠른 순서로 시도하고, 확신도가 문턱을 넘으면 거기서 멈춘다:
 *     1 캐시(같은 입력=같은 답, 사람 라벨은 영구) → 2 규칙(호출측이 넘긴 정규식 등, 답+확신도)
 *     → 3 로컬 kNN(문자 n-gram 해시 벡터, 결정 로그의 라벨로 학습, 모델·의존성 없음) → 4 폴백(호출측 async: Jev/Claude/보수적 기본값)
 *   모든 결정은 ~/.orbit/judge-log.jsonl 에 남고(입력 요약·답·확신도·엔진), 사람이 고친 답은 label()로 넣으면 kNN이 바로 반영한다.
 *   설계 문서: "Jev식 판단 계층 로컬 적용 설계"(2026-09-26). 첫 적용: ocr-triage(Vision 캡처 선별).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.orbit');
const LOG = path.join(DIR, 'judge-log.jsonl');
const LABELS = path.join(DIR, 'judge-labels.jsonl');
const DIM = 2048;
const _cache = new Map();          // key|hash → {answer, confidence, by}
const _labels = new Map();         // key → [{vec, answer}]  (사람 라벨 + 고확신 규칙 답)
const MAX_PER_KEY = 3000;
let _loaded = false;

const norm = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 2000);
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
// 문자 3-gram 해시 벡터(한글·영문 혼용 짧은 텍스트에 충분). L2 정규화.
function vec(text) {
  const t = norm(text); const v = new Float32Array(DIM); if (t.length < 3) return v;
  for (let i = 0; i + 3 <= t.length; i++) { let h = 0; for (let j = 0; j < 3; j++) h = (h * 31 + t.charCodeAt(i + j)) >>> 0; v[h % DIM] += 1; }
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n; return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };

function _load() {
  if (_loaded) return; _loaded = true;
  try { for (const l of fs.readFileSync(LABELS, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); _addLabel(r.key, r.text, r.answer, false); } catch {} } } catch {}
}
function _addLabel(key, text, answer, persist) {
  const arr = _labels.get(key) || []; arr.push({ vec: vec(text), answer }); if (arr.length > MAX_PER_KEY) arr.splice(0, arr.length - MAX_PER_KEY); _labels.set(key, arr);
  if (persist) { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LABELS, JSON.stringify({ at: new Date().toISOString(), key, text: norm(text), answer }) + '\n'); } catch {} }
}
function _log(row) { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch {} }

// kNN: 이웃 k개의 답 분포 → 최다 답 + 확신도(= 최다 비율 × 평균 유사도)
function _knn(key, text, k = 7) {
  const arr = _labels.get(key); if (!arr || arr.length < 20) return null; // 라벨 20개 미만이면 판단하지 않음
  const q = vec(text); const scored = arr.map((r) => ({ s: dot(q, r.vec), a: r.answer })).sort((a, b) => b.s - a.s).slice(0, k);
  if (!scored.length || scored[0].s < 0.35) return null;
  const cnt = {}; let simSum = 0; for (const x of scored) { cnt[x.a] = (cnt[x.a] || 0) + 1; simSum += x.s; }
  const [answer, n] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  return { answer, confidence: Math.round((n / scored.length) * (simSum / scored.length) * 100) / 100, probs: Object.fromEntries(Object.entries(cnt).map(([a, c]) => [a, c / scored.length])) };
}

/**
 * judge.choice({ key, text, options, rule?, fallback?, thresholds? })
 *   key: 판단 종류 이름(예 'vision-triage'), text: 판단 근거 텍스트, options: 허용 답 배열
 *   rule(text) → { answer, confidence } | null      fallback(text) → Promise<{answer, confidence}> | null
 *   thresholds: { rule: 0.9, local: 0.8 }  각 단이 이 이상이면 채택
 */
async function choice({ key, text, options, rule, fallback, thresholds = {}, learn = true }) {
  _load();
  const th = { rule: 0.9, local: 0.8, ...thresholds };
  const h = hashOf(norm(text)); const ck = key + '|' + h;
  const done = (answer, confidence, by, extra = {}) => {
    const out = { answer, confidence, by, ...extra };
    if (!options.includes(answer)) return { answer: options[0], confidence: 0, by: 'invalid' };
    _cache.set(ck, out); if (_cache.size > 20000) _cache.delete(_cache.keys().next().value);
    _log({ at: new Date().toISOString(), key, h, t: norm(text).slice(0, 160), answer, confidence, by });
    if (learn && by !== 'cache' && by !== 'local' && confidence >= 0.9) _addLabel(key, text, answer, false); // 고확신 답은 kNN 재료(메모리만)
    return out;
  };
  if (_cache.has(ck)) return { ..._cache.get(ck), by: 'cache' };
  const r = rule ? rule(text) : null;
  if (r && r.confidence >= th.rule) return done(r.answer, r.confidence, 'rule', { reason: r.reason });
  const l = _knn(key, text);
  if (l && l.confidence >= th.local) return done(l.answer, l.confidence, 'local', { probs: l.probs });
  if (fallback) { const f = await fallback(text); if (f && f.answer) return done(f.answer, f.confidence ?? 0.5, f.by || 'fallback'); }
  if (r) return done(r.answer, r.confidence, 'rule-low', { reason: r.reason });
  if (l) return done(l.answer, l.confidence, 'local-low');
  return done(options[0], 0, 'default');
}
async function bool(opts) { const r = await choice({ ...opts, options: ['yes', 'no'] }); return { ...r, yes: r.answer === 'yes' }; }
async function score(opts) { const r = await choice({ ...opts, options: opts.levels }); return { ...r, level: r.answer, index: opts.levels.indexOf(r.answer) }; }

// 사람이 고친 답 — 영구 라벨 + 캐시 갱신
function label(key, text, answer) { _load(); _addLabel(key, text, answer, true); _cache.set(key + '|' + hashOf(norm(text)), { answer, confidence: 1, by: 'label' }); }
function stats() { _load(); const out = {}; for (const [k, v] of _labels) out[k] = v.length; return { labels: out, cache: _cache.size, log: LOG }; }

module.exports = { choice, bool, score, label, stats, _test: { vec, dot, norm } };
