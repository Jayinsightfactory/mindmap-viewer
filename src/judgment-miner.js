'use strict';
/**
 * judgment-miner.js — 골 자동디벨롭 엔진 (2026-07-10)
 *
 * 목적: work.step 시퀀스에서 (1) 반복 루틴을 스스로 발견하고,
 *       (2) 각 스텝에 "사람 판단 개입 점수"를 매겨,
 *       (3) 판단 없는 연속 구간(=자동화 가능)만 잘라낸다.
 *   → 인력 대체는 "판단 없는 구간"에서만. 판단 스텝 = 사람이 남을 경계.
 *
 * 판단 5신호 (낮을수록 기계적=자동화 가능):
 *   1) 입력 파생성  : 값이 직전 스텝 값에서 파생(복사/포함)되나 → 파생되면 판단 아님
 *   2) 변동성      : 같은 루틴 위치에서 값이 매번 다른가 (파생 아니면서)
 *   3) 주저        : 스텝 전 대기(gapSec)가 긴가
 *   4) 분기        : 이 위치 다음 스텝이 인스턴스마다 갈라지나
 *   5) 액션종류    : 고정 버튼(저장/조회 등) click = 기계적
 *
 * v1: 정확한 통계 엔진이 아니라 "판단 경계가 눈에 보이게" 하는 휴리스틱.
 *     실데이터로 돌려 경계가 깔끔히 잡히면 그림자실행→자율승격 루프로 확장.
 */

// ── 스텝 시그니처 (값 제외, 숫자 일반화) — 루틴 매칭 키 ──────────────────────
function _hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function stepApp(d) { return (d.app || _hostOf(d.url) || '?').toLowerCase(); }
function _targetKey(t) {
  if (!t) return '';
  const raw = t.id || t.selector || t.label || (t.path ? String(t.path).split('>').pop().trim() : '') || t.text || t.name || '';
  return String(raw).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function stepSig(d) { return `${stepApp(d)}|${d.action || ''}|${_targetKey(d.target)}`; }

const _isButtonLabel = (v) => {
  const s = String(v || '').replace(/\s/g, '');
  return /^(저장|조회|검색|확정|등록|신규|삭제|취소|출력|닫기|확인|다음|이전|save|search|ok|submit|조 회|저 장)/i.test(s);
};
const _norm = (s) => String(s == null ? '' : s).replace(/[\s,]/g, '').toLowerCase();

// ── 세션 분할: user별 시간순, 3분 이상 간격이면 새 세션 ──────────────────────
function _splitSessions(steps, gapMs = 3 * 60 * 1000) {
  const out = []; let cur = null; let lastT = 0;
  for (const s of steps) {
    const t = new Date(s.t || s.timestamp || 0).getTime();
    if (!cur || (t - lastT) > gapMs) { cur = []; out.push(cur); }
    cur.push(s); lastT = t;
  }
  return out.filter(x => x.length >= 3);
}

// ── 빈발 n-gram(연속 서브시퀀스) = 반복 루틴 ────────────────────────────────
function _mineFrequent(sessions, { minLen = 3, maxLen = 8, minInst = 3 } = {}) {
  const windows = new Map(); // sigSeq -> [{sessIdx, start, len}]
  sessions.forEach((sess, si) => {
    const sigs = sess.map(stepSig);
    for (let L = minLen; L <= maxLen; L++) {
      for (let i = 0; i + L <= sigs.length; i++) {
        const key = sigs.slice(i, i + L).join(' >> ');
        if (!windows.has(key)) windows.set(key, []);
        windows.get(key).push({ si, start: i, len: L });
      }
    }
  });
  // minInst 이상 반복 + 겹치는 짧은 것 제거(가장 긴 것 우선)
  let routines = [...windows.entries()]
    .filter(([, occ]) => occ.length >= minInst)
    .map(([key, occ]) => ({ key, len: occ[0].len, occ }))
    .sort((a, b) => (b.len - a.len) || (b.occ.length - a.occ.length));
  // 다른 루틴 키에 완전 포함되는 짧은 루틴은 스킵(중복 축소)
  const kept = [];
  for (const r of routines) {
    if (kept.some(k => k.key.includes(r.key))) continue;
    kept.push(r);
    if (kept.length >= 30) break;
  }
  return kept;
}

// ── 루틴별 스텝 판단 분석 ───────────────────────────────────────────────────
function _analyzeRoutine(routine, sessions) {
  const L = routine.len;
  // 각 위치의 실제 스텝들(인스턴스별) 수집
  const inst = routine.occ.map(o => sessions[o.si].slice(o.start, o.start + L));
  const nextSigs = routine.occ.map(o => {
    const sess = sessions[o.si]; const after = sess[o.start + L];
    return after ? stepSig(after) : '(끝)';
  });
  const N = inst.length;
  const steps = [];
  for (let p = 0; p < L; p++) {
    const col = inst.map(seq => seq[p]).filter(Boolean);
    const d0 = col[0] || {};
    const values = col.map(s => _norm(s.value));
    const distinct = new Set(values.filter(v => v !== '')).size;
    const gaps = col.map(s => Number(s.gapSec) || 0);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);

    // 신호 계산
    const isInput = /input|select|type|cell_edit/i.test(d0.action || '');
    const btn = (d0.action === 'click') && _isButtonLabel(d0.value || (d0.target && (d0.target.text || d0.target.name)));
    // 변동성
    const variability = isInput ? (distinct / Math.max(1, N)) : 0;
    // 파생성: 이 위치 값이 같은 인스턴스의 "이전 스텝" 값에 나타나나
    let derivedHits = 0, derivCheck = 0;
    inst.forEach(seq => {
      const v = _norm(seq[p] && seq[p].value);
      if (!v || v.length < 2) return;
      derivCheck++;
      const priors = seq.slice(0, p).map(x => _norm(x.value)).filter(Boolean);
      if (priors.some(pv => pv.includes(v) || v.includes(pv))) derivedHits++;
    });
    const derivability = derivCheck ? (derivedHits / derivCheck) : 0; // 1=완전 파생
    // 분기: 이 위치가 마지막이면 다음 분기 대신 자기 다음 스텝 분기
    // 주저
    const hesitation = Math.min(1, avgGap / 180); // 3분 대기면 1
    // 액션 종류
    const mechanicalAction = btn ? 1 : (isInput ? 0 : 0.5);

    // 판단점수: 입력인데 파생 안 되고 변동 크거나 주저 크면 ↑. 버튼/파생/저변동이면 ↓.
    let judgment;
    if (btn) judgment = 0.05;
    else if (isInput) {
      judgment = 0.55 * variability * (1 - derivability) + 0.30 * hesitation + 0.15 * (derivability < 0.3 && variability > 0.5 ? 1 : 0);
    } else {
      judgment = 0.25 + 0.4 * hesitation; // 네비게이션/포커스 등 — 보통 기계적이나 주저 반영
    }
    judgment = Math.max(0, Math.min(1, judgment));

    steps.push({
      pos: p, sig: stepSig(d0), app: stepApp(d0), action: d0.action || '',
      target: _targetKey(d0.target), sampleValue: (d0.value || '').toString().slice(0, 24),
      distinctValues: distinct, instances: N, avgGapSec: Math.round(avgGap),
      derivability: +derivability.toFixed(2), variability: +variability.toFixed(2),
      judgment: +judgment.toFixed(2),
      verdict: judgment < 0.35 ? 'auto' : 'human',
      why: btn ? '고정 버튼' : (isInput ? (derivability > 0.5 ? '이전값 파생' : (variability > 0.5 ? '값 변동 큼(판단 의심)' : '저변동')) : '네비/포커스'),
    });
  }
  // 분기 신호를 마지막 스텝에 반영(다음 스텝 다양성)
  const nextDistinct = new Set(nextSigs).size;
  if (nextDistinct > 1 && steps.length) {
    const branchP = Math.min(1, (nextDistinct - 1) / Math.max(1, N));
    const last = steps[steps.length - 1];
    last.judgment = +Math.min(1, last.judgment + 0.3 * branchP).toFixed(2);
    last.verdict = last.judgment < 0.35 ? 'auto' : 'human';
    if (branchP > 0.3) last.why += ' +분기';
  }

  // 자동화 가능 런(최장 연속 auto) + 비율
  let best = { s: 0, e: -1 }, run = { s: 0, e: -1 };
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].verdict === 'auto') { if (run.e < i - 1) run = { s: i, e: i }; else run.e = i; if ((run.e - run.s) > (best.e - best.s)) best = { ...run }; }
  }
  const autoCount = steps.filter(s => s.verdict === 'auto').length;
  return {
    key: routine.key, length: L, instances: N,
    apps: [...new Set(steps.map(s => s.app))],
    automatableRatio: +(autoCount / L).toFixed(2),
    autoRun: best.e >= best.s ? { from: best.s, to: best.e, len: best.e - best.s + 1 } : null,
    boundarySteps: steps.filter(s => s.verdict === 'human').map(s => s.pos),
    steps,
  };
}

// ── 진입점 ──────────────────────────────────────────────────────────────────
async function mineJudgment(pool, opts = {}) {
  const hours = Math.min(opts.hours || 72, 336);
  const { rows } = await pool.query(
    `SELECT user_id, data_json, timestamp FROM events
      WHERE type='work.step' AND timestamp::timestamptz > NOW() - ($1 || ' hours')::interval
      ORDER BY user_id ASC, timestamp ASC`, [String(hours)]);
  // user별 스텝
  const byUser = new Map();
  for (const r of rows) {
    const d = typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })();
    d.t = d.t || r.timestamp;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(d);
  }
  // 전 user 세션 합침(루틴은 사람 간에도 공통일 수 있음)
  let sessions = [];
  for (const steps of byUser.values()) sessions = sessions.concat(_splitSessions(steps));
  if (!sessions.length) return { totalSteps: rows.length, sessions: 0, routines: [] };

  const freq = _mineFrequent(sessions, { minInst: opts.minInstances || 3 });
  const routines = freq.map(r => _analyzeRoutine(r, sessions))
    .filter(r => r.instances >= (opts.minInstances || 3))
    .sort((a, b) => (b.automatableRatio * b.instances) - (a.automatableRatio * a.instances));

  const totalAuto = routines.reduce((n, r) => n + (r.autoRun ? r.autoRun.len : 0) * r.instances, 0);
  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    totalSteps: rows.length, sessions: sessions.length, routineCount: routines.length,
    automatableStepInstances: totalAuto,
    routines: routines.slice(0, 20),
  };
}

module.exports = { mineJudgment, stepSig, _analyzeRoutine };
