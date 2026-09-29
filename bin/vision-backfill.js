#!/usr/bin/env node
'use strict';
/**
 * vision-backfill.js — 이미 해독된 화면(screen.analyzed) 중 업무 흐름(workflow) 태깅이 없는 것을
 * 저장 썸네일(data_json.thumbnail, jpeg)로 새 프롬프트(업무 흐름 카탈로그 + fields.box/order + 쉬운 말투)로
 * 다시 해독해 **기존 이벤트에 병합**한다(새 이벤트 추가 없음 → 중복 없음).
 *
 *   node bin/vision-backfill.js [--max 60] [--dry-run] [--from 2026-09-17] [--to 2026-09-28T23:59:59] [--legacy]
 *
 * - 후보: GET /api/vision/backfill-candidates (관리자). --legacy 또는 404 이면 /api/learning/logs?raw=1 로 대체.
 * - 병합: POST /api/vision/backfill-merge {id, patch} (허용 키만, backfilledAt 기록 → 다음 후보에서 빠짐)
 * - 사용량 가드(quota-guard, 사용자 몫 30% 보전) 준수 — 걸리면 즉시 중단(다음 실행에 이어서).
 * - 사용자별 라운드로빈, 설연주·강현우·조현욱 가중(한 바퀴에 2건). 실패는 건너뜀(병합 안 됐으니 다음 실행에 재시도).
 * - --dry-run: 해독만 하고 병합 안 함, 결과 5개 출력.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const W = require('./vision-worker');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const MAX = Math.max(1, parseInt(arg('--max', '60')) || 60);
const DRY = argv.includes('--dry-run');
const LEGACY = argv.includes('--legacy');
const NO_QUOTA = argv.includes('--no-quota') && DRY; // 수동 검증 전용(dry-run 에서만 허용) — 예약 실행에는 쓰지 말 것
const FROM = arg('--from', '2026-09-17');
const TO = arg('--to', '2026-09-28T23:59:59');
const PRIORITY = (process.env.VISION_BACKFILL_PRIORITY || '설연주,강현우,조현욱').split(',').map((s) => s.trim()).filter(Boolean);
const PATCH_KEYS = ['workflow', 'fields', 'activity', 'purpose', 'outputArtifact', 'nextLikely', 'actionDone', 'businessStage', 'changeFromPrev', 'automationHint', 'autoAreas'];
const LOG = path.join(os.homedir(), '.orbit', 'vision-backfill.log');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
async function api(p, opt = {}) {
  const r = await fetch(new URL(p, W.ORBIT_SERVER), { ...opt, headers: { Authorization: 'Bearer ' + W.ORBIT_TOKEN, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  return r;
}

async function loadCandidates() {
  if (!LEGACY) {
    const r = await api(`/api/vision/backfill-candidates?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2000`);
    if (r.ok) {
      const j = await r.json();
      log('후보 규모(사람별):', (j.counts || []).map((c) => `${c.userName || c.user_id}=${c.n}`).join(' '));
      return j.candidates || [];
    }
    if (r.status !== 404) throw new Error('candidates HTTP ' + r.status);
    log('backfill-candidates 404(미배포) → learning/logs 로 대체');
  }
  // 대체 경로: 원문 로그(썸네일 포함이라 무거움 → 사용자 분배 전 적당히 제한)
  const lim = Math.min(2000, Math.max(MAX * 10, 50));
  const r = await api(`/api/learning/logs?type=screen.analyzed&raw=1&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=${lim}`);
  if (!r.ok) throw new Error('learning/logs HTTP ' + r.status);
  const j = await r.json();
  const rows = (j.logs || j || []).filter((x) => x && x.data && !x.data.workflow && x.data.thumbnail && !x.data.backfilledAt);
  return rows.map((x) => ({ id: x.id, userId: x.userId, userName: x.userName || '', timestamp: x.timestamp, app: x.data.app || '', windowTitle: x.data.windowTitle || '', hostname: x.data.hostname || '', _thumb: x.data.thumbnail }));
}

// 사용자별 라운드로빈(우선 인물은 한 바퀴에 2건)
function roundRobin(cands, n) {
  const by = new Map();
  for (const c of cands) { if (!by.has(c.userId)) by.set(c.userId, []); by.get(c.userId).push(c); }
  const users = [...by.keys()].sort((a, b) => {
    const pa = PRIORITY.includes((by.get(a)[0].userName || '')) ? 0 : 1, pb = PRIORITY.includes((by.get(b)[0].userName || '')) ? 0 : 1;
    return pa - pb;
  });
  const out = [];
  while (out.length < n && users.some((u) => by.get(u).length)) {
    for (const u of users) {
      const q = by.get(u); const w = PRIORITY.includes(q[0]?.userName || '') ? 2 : 1;
      for (let k = 0; k < w && q.length && out.length < n; k++) out.push(q.shift());
    }
  }
  return out;
}

async function thumbOf(c) {
  if (c._thumb) return c._thumb;
  const r = await api(`/api/vision/thumbnail/${encodeURIComponent(c.id)}`);
  if (!r.ok) throw new Error('thumbnail HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function quotaPause() {
  if (NO_QUOTA) return null;
  try { const q = await require('../src/quota-guard').checkQuota(30); if (q.pause) return q.reason || 'quota'; } catch {}
  return null;
}

async function main() {
  if (!W.ORBIT_TOKEN) throw new Error('토큰 없음(~/.orbit-config.json)');
  if (!W.USE_CLI) throw new Error('Claude CLI 필요(API 키 경로는 과금이라 백필에 쓰지 않음)');
  const cands = await loadCandidates();
  const pick = roundRobin(cands, MAX);
  log(`후보 ${cands.length}건 → 이번 실행 ${pick.length}건${DRY ? ' (dry-run)' : ''}`);
  let ok = 0, fail = 0, streak = 0; const samples = []; const t0 = Date.now();
  for (const c of pick) {
    if (streak >= 3) { log('연속 3건 실패 — 중단(CLI 로그인 만료 등 점검). 남은 건은 다음 실행에'); break; }
    const why = await quotaPause();
    if (why) { log('[quota] 중단 —', why); break; }
    try {
      await W._refreshWfCatalog();
      const b64 = await thumbOf(c);
      const ctx = { hostname: c.hostname, userId: c.userId, windowTitle: c.windowTitle, name: c.app };
      const model = W.pickModel(ctx);
      let res = await W.visionCli(b64, ctx, model);
      if (!W._isValidResult(res)) res = await W.visionCli(b64, ctx, model); // 1회 재시도
      if (!W._isValidResult(res)) { fail++; streak++; log('실패(빈 결과)', c.id); continue; }
      const patch = {};
      for (const k of PATCH_KEYS) if (res[k] !== undefined) patch[k] = res[k];
      if (patch.workflow === undefined) patch.workflow = null; // 해독했는데 업무 무관 → null 로 두되 backfilledAt 으로 재대상 제외
      patch.backfilledAt = new Date().toISOString();
      if (DRY) { if (samples.length < 5) samples.push({ id: c.id, user: c.userName, app: c.app, model, patch }); ok++; streak = 0; continue; }
      const r = await api('/api/vision/backfill-merge', { method: 'POST', body: JSON.stringify({ id: c.id, patch }) });
      if (!r.ok) { fail++; streak++; log('병합 실패', c.id, r.status); continue; }
      ok++; streak = 0;
    } catch (e) { fail++; streak++; log('실패', c.id, e.message); }
  }
  log(`완료 ok=${ok} fail=${fail} 평균 ${pick.length ? Math.round((Date.now() - t0) / 1000 / Math.max(1, ok + fail)) : 0}초/건`);
  if (DRY) console.log(JSON.stringify(samples, null, 2));
}

main().catch((e) => { log('에러', e.message); process.exit(1); });
