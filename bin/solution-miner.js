#!/usr/bin/env node
'use strict';
/**
 * solution-miner.js — 관찰 세션 → 재현가능 절차 spec 상시 추출 (owner PC, 무과금)
 * ─────────────────────────────────────────────────────────────────────────────
 * 골 파이프라인의 마지막 추출단(관찰 → 실행가능 절차)을 상시화한다.
 * vision-worker(화면해독)·ops-agent-worker(예측/병목)가 채우지 못하는 지점:
 *   "스티칭된 작업 세션(task-session)을 dry-run 자동화 spec으로 자동 변환·누적"
 * 이게 지금까지 관리자가 UI 버튼을 눌러야만 돌던 걸 상시 에이전트로 돌린다.
 *
 * 무과금: /api/scripts/from-session 의 생성 로직(_generateFromSession)이 규칙기반(LLM 아님)
 *         → Claude 구독한도 소모 0. vision/ops 워커와 자원 경합 없음.
 * 안전:   읽기 위주 + 소량 INSERT만. 서버 힙/OOM 무관(이미지·큐 미접촉). 틱당 상한 있음.
 *
 * 사용:
 *   node bin/solution-miner.js            # SOLUTION_POLL_MS(기본 15분)마다 루프
 *   node bin/solution-miner.js --once     # 1회만
 * env: ORBIT_SERVER_URL, ORBIT_TOKEN(or ~/.orbit-config.json), SOLUTION_POLL_MS,
 *      SOLUTION_HOURS(세션 조회창, 기본 24), SOLUTION_MAX_PER_TICK(기본 40),
 *      SOLUTION_MIN_STEP_GROWTH(재생성 임계 단계 증가분, 기본 2)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.ORBIT_TOKEN || (() => {
  try { let r = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r).token || ''; }
  catch { return ''; }
})();
const POLL_MS = parseInt(process.env.SOLUTION_POLL_MS) || 15 * 60 * 1000;
const HOURS = parseInt(process.env.SOLUTION_HOURS) || 24;
const MAX_PER_TICK = parseInt(process.env.SOLUTION_MAX_PER_TICK) || 40;
const MIN_STEP_GROWTH = parseInt(process.env.SOLUTION_MIN_STEP_GROWTH) || 2;
const ONCE = process.argv.includes('--once');

// ── 로컬 dedup 상태 (세션당 마지막 생성 시점의 단계수 기록) ─────────────────────
// key = `${userId}|${startTs}` → lastStepCount. 세션이 자라면(+MIN_STEP_GROWTH) 재생성해 spec 갱신.
const STATE_FILE = path.join(os.homedir(), '.orbit', 'solution-miner-state.json');
function _loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { seen: {}, generated: 0 }; }
}
function _saveState(st) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch {}
}
// 오래된 세션 키 정리(조회창 밖은 다시 안 나오므로 무한 성장 방지)
function _pruneState(st) {
  const cutoff = Date.now() - Math.max(HOURS + 24, 72) * 3600 * 1000;
  for (const k of Object.keys(st.seen)) {
    const ts = Date.parse(k.split('|')[1] || '');
    if (ts && ts < cutoff) delete st.seen[k];
  }
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve) => {
    const u = new URL(urlPath, SERVER);
    const mod = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (TOKEN) headers['authorization'] = 'Bearer ' + TOKEN;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: 30000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d, _status: res.statusCode }); } }); });
    req.on('error', (e) => resolve({ _error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ _error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

// ── L3 인과 사슬 조립(검증된 원인→작업→결과) ─────────────────────────────────
// 엔티티 추출은 이미 대규모 작동(action_mentions_customer·kakao_event_mentions_customer 수천).
// 빠진 건 "같은 거래처로 이어 검증된 사슬로 조립"하는 것. 여기서 읽기전용으로 조립·채점한다.
// 검증사슬 = 카톡[거래처X]@T0 → 작업[거래처X]@T0+8h → (있으면)ERP[거래처X]. 시간근접만인
// talk_triggered_action(수천, 거래처 미검증)과 달리, 이건 거래처 키가 양쪽에 일치해야 함.
async function assembleCausalChains(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const W = 8 * 3600 * 1000; // 원인→작업, 작업→결과 인정 시간창
  const pull = async (relType) => {
    const r = await httpJson('GET', `/api/ops-ontology/relations?relType=${relType}&limit=2000`);
    return (r.relations || []).filter(x => new Date(x.ts).getTime() >= since)
      .map(x => ({ from: x.from_ref, cust: x.to_ref, t: new Date(x.ts).getTime() }));
  };
  const [kakaoMent, actMent, actErp] = await Promise.all([
    pull('kakao_event_mentions_customer'), pull('action_mentions_customer'), pull('action_updated_erp'),
  ]);
  const erpActionIds = new Set((await httpJson('GET', `/api/ops-ontology/relations?relType=action_updated_erp&limit=2000`)).relations?.map(x => x.from_ref) || []);
  // 거래처(to_ref)별로 카톡·작업 모으기
  const byCust = new Map();
  const bucket = c => byCust.get(c) || (byCust.set(c, { kakao: [], act: [] }), byCust.get(c));
  for (const k of kakaoMent) bucket(k.cust).kakao.push(k);
  for (const a of actMent) bucket(a.cust).act.push(a);
  let verified = 0, complete = 0, custWithChain = 0, causeOnly = 0, actOnly = 0;
  const samples = [];
  for (const [cust, g] of byCust) {
    let has = false;
    for (const k of g.kakao) {
      const act = g.act.find(a => a.t >= k.t && a.t <= k.t + W); // 같은 거래처 카톡 뒤 8h 내 작업
      if (!act) continue;
      verified++; has = true;
      const hasErp = erpActionIds.has(act.from) || g.act.some(a => a.t >= act.t && a.t <= act.t + W && erpActionIds.has(a.from));
      if (hasErp) complete++;
      if (samples.length < 6) samples.push({ cust, hasErp });
    }
    if (has) custWithChain++;
    else if (g.kakao.length && !g.act.length) causeOnly++; // 원인만=미처리 요청 후보
    else if (g.act.length && !g.kakao.length) actOnly++;   // 작업만=원인불명
  }
  return { kakaoMent: kakaoMent.length, actMent: actMent.length, verified, complete, custWithChain, causeOnly, actOnly, samples };
}

async function runOnce() {
  const t0 = Date.now();
  const st = _loadState();
  const pp = await httpJson('GET', '/api/flow/people');
  const people = (pp.people || []).filter(x => (x.count || 0) >= 50); // 관찰량 최소선(ops-agent와 동일)
  if (!people.length) { console.log(`[solution-miner] ${new Date().toISOString()} people 없음 — 스킵`); return; }

  let scanned = 0, withCoords = 0, generated = 0, updated = 0, skipped = 0;
  const highlights = [];

  for (const p of people) {
    if (generated + updated >= MAX_PER_TICK) break;
    const sres = await httpJson('GET', `/api/vision/task-sessions?userId=${encodeURIComponent(p.userId)}&hours=${HOURS}`);
    const sessions = sres.sessions || [];
    for (const s of sessions) {
      if (generated + updated >= MAX_PER_TICK) break;
      scanned++;
      // 실행좌표(clickXY)가 있는 세션만 = 실제 자동화/매뉴얼화 재료
      if (!(s.clickStepCount > 0)) { skipped++; continue; }
      withCoords++;
      const key = `${p.userId}|${s.startTs}`;
      const prev = st.seen[key];
      const grew = prev != null && s.stepCount >= prev + MIN_STEP_GROWTH;
      if (prev != null && !grew) { skipped++; continue; } // 이미 생성됨 + 유의미하게 안 자람
      const name = `관찰절차:${(s.apps || [s.app]).join('→')}·${(p.label || p.userId).slice(0, 12)}`.slice(0, 80);
      const gen = await httpJson('POST', '/api/scripts/from-session', { session: { steps: s.steps }, name, userId: p.userId });
      if (gen && gen.ok) {
        st.seen[key] = s.stepCount;
        if (prev == null) generated++; else updated++;
        st.generated = (st.generated || 0) + 1;
        if (highlights.length < 6) highlights.push(`${p.label || p.userId}: ${(s.apps || []).join('→')} ${s.stepCount}단계·클릭${s.clickStepCount}${gen.saved?.id ? ` #${gen.saved.id}` : ''}`);
      } else {
        skipped++; // no_click_coords 등
      }
    }
  }

  // ── 광맥 2: per-screen 자동화 후보(scan) 수확 — 단, 실행가능(좌표보유)한 것만 저장 ──
  // 핵심 교훈(2026-07-14 감사): 좌표 학습(pad_mouse_map)이 비어 있으면 generate가 만드는 스크립트는
  // 클릭 좌표가 0개인 "껍데기"(구조는 맞지만 실행 불가). 껍데기를 solution으로 저장하면 라이브러리가
  // 쓰레기로 오염된다. → 좌표가 실제로 붙는(coordsUsed>0) 후보만 저장하고, 나머지는 gap으로 기록.
  let actGen = 0, hollowGaps = [];
  st.seenActions = st.seenActions || {};
  let coordCount = 0;
  try { const cm = await httpJson('GET', '/api/pad/mouse-map'); coordCount = (cm.learnedMap?.count || 0) + (cm.eventClusters?.count || 0); } catch {}
  try {
    const scan = await httpJson('GET', '/api/scripts/scan?minScore=0.5&limit=800');
    const groups = (scan.patterns || []).filter(g => g.hasTemplate && g.count >= 3);
    for (const g of groups) {
      if (generated + updated + actGen >= MAX_PER_TICK) break;
      const last = st.seenActions[g.actionType];
      const recentlyDone = last && last.saved && Date.now() - last.ts < 24 * 3600 * 1000 && g.count <= (last.count || 0) + 5;
      if (recentlyDone) continue;
      // 좌표가 아예 없으면 generate는 껍데기만 만든다 — 저장하지 말고 gap으로 기록(불필요한 쓰레기행 방지)
      if (coordCount === 0) { hollowGaps.push(`${g.actionType}(관찰 ${g.count}회, 좌표 0)`); st.seenActions[g.actionType] = { ts: Date.now(), count: g.count, saved: false }; continue; }
      const inputMap = (g.inputMaps && g.inputMaps[0]) || [];
      const gen = await httpJson('POST', '/api/scripts/generate', {
        actionType: g.actionType, scriptType: 'pyautogui', inputMap,
        eventIds: (g.eventIds || []).slice(0, 10),
        name: `자동화후보:${g.actionType}(관찰 ${g.count}회·점수 ${g.avgScore})`,
      });
      const coordsUsed = gen?.script?.coordsUsed || 0;
      if (gen && gen.ok && coordsUsed > 0) {
        st.seenActions[g.actionType] = { ts: Date.now(), count: g.count, saved: true };
        actGen++; st.generated = (st.generated || 0) + 1;
        if (highlights.length < 10) highlights.push(`[후보] ${g.actionType}: 관찰 ${g.count}회·좌표 ${coordsUsed}개${gen.script?.id ? ` #${gen.script.id}` : ''}`);
      } else {
        // 좌표 0 → 방금 만든 껍데기 즉시 삭제(라이브러리 오염 방지)
        if (gen?.script?.id) await httpJson('DELETE', `/api/scripts/${gen.script.id}`);
        hollowGaps.push(`${g.actionType}(관찰 ${g.count}회, 좌표 0)`);
        st.seenActions[g.actionType] = { ts: Date.now(), count: g.count, saved: false };
      }
    }
  } catch (e) { console.error('  [scan] 실패:', e.message); }

  // ── 크리틱(디벨롭 루프): 라이브러리 실행가능성 채점 + gap 산출 → 매 사이클 추세 기록 ──
  // "생성했다"가 아니라 "실행 가능한가"로 품질을 측정한다. 좌표/값이 없으면 executable=false.
  const critic = { at: new Date().toISOString(), coordCount, sessionsWithClicks: withCoords,
    executable: 0, structural: 0, total: 0, gaps: [] };
  try {
    const lst = await httpJson('GET', '/api/scripts/list?limit=100');
    const scripts = lst.scripts || [];
    critic.total = scripts.length;
    for (const s of scripts) {
      const det = await httpJson('GET', `/api/scripts/${s.id}`);
      const c = (det.script || det).script_content || (det.script || det).content || '';
      const hasCoords = /plan_click\(\s*\d+\s*,\s*\d+/.test(c) || /\bclick\(\s*x?=?\d+/.test(c);
      const hasValues = /plan_type\(\s*["'][^"']+["']/.test(c);
      if (hasCoords) critic.executable++; else critic.structural++;
      if (!hasCoords && hasValues) critic.gaps.push(`#${s.id} ${s.action_type}: 값은 있으나 좌표 없음`);
    }
  } catch (e) { console.error('  [critic] 실패:', e.message); }
  // ── L3 인과 사슬 채점: 엔티티키 커버리지 + 검증된 원인→작업→결과 사슬 ──────────
  // 사장님 질문(왜→연계→결과)의 측정. "링크가 있다"가 아니라 "거래처로 검증된 사슬이 몇 개인가".
  const L3 = { coverage: null, actions: 0, custMentions: 0 };
  try {
    const stats = await httpJson('GET', '/api/ops-ontology/stats');
    L3.actions = stats.actions || 0;
    const rel = (stats.relations || []).reduce((m, r) => (m[r.type] = r.count, m), {});
    L3.custMentions = Number(rel.action_mentions_customer || 0);
    L3.talkTriggered = Number(rel.talk_triggered_action || 0);
    L3.coverage = L3.actions ? +(L3.custMentions / L3.actions * 100).toFixed(1) : 0; // 거래처키 보유 작업 %
    const ch = await assembleCausalChains(HOURS * 7); // 사슬은 관찰창의 7배로 넉넉히
    L3.chains = ch;
    // 거래처 라벨 붙이기(샘플)
    if (ch.samples.length) {
      const ents = await httpJson('GET', '/api/ops-ontology/entities?type=customer&limit=500');
      const nameOf = new Map((ents.entities || []).map(e => [e.id, e.display_name]));
      L3.sampleChains = ch.samples.map(s => `${nameOf.get(s.cust) || s.cust}${s.hasErp ? '(원인→작업→ERP 완결)' : '(원인→작업)'}`);
    }
  } catch (e) { console.error('  [L3] 실패:', e.message); }
  critic.L3 = L3;

  // 근본 gap 진단 — 3개 층 통합
  if (coordCount === 0) critic.rootGap = 'L1: 좌표 학습(pad_mouse_map) 0 → spec 실행 불가';
  else if (withCoords === 0) critic.rootGap = 'L1: 세션 clickXY 미부착';
  else critic.rootGap = null;
  if (L3.coverage != null && L3.coverage < 10) critic.rootGapL3 = `L3: 작업의 거래처키 ${L3.coverage}%만 → 검증사슬 ${L3.chains?.verified || 0}개(원인만 ${L3.chains?.causeOnly || 0}·작업만 ${L3.chains?.actOnly || 0}). 거래처 관측 커버리지 확대가 사슬의 관건`;

  // 추세 저장(최근 20틱) + 서버 리포트
  st.criticHistory = (st.criticHistory || []).concat([{ at: critic.at, exec: critic.executable, total: critic.total, coordCount, l3cov: L3.coverage, verified: L3.chains?.verified }]).slice(-20);
  try { await httpJson('POST', '/api/flow/ops-report', { kind: 'solution-critic', source: 'solution-miner', report: critic }); } catch {}

  _pruneState(st);
  _saveState(st);
  console.log(`[solution-miner] ${new Date().toISOString()} 세션 ${scanned}(좌표세션 ${withCoords}) → spec 신규 ${generated}·갱신 ${updated} | 후보 ${actGen} | 껍데기gap ${hollowGaps.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  [L1 실행] 라이브러리 ${critic.total}개 中 실행가능 ${critic.executable}·구조만 ${critic.structural} | 학습좌표 ${coordCount}`);
  console.log(`  [L3 인과] 거래처키 커버리지 ${L3.coverage}% (작업 ${L3.actions}·태깅 ${L3.custMentions}) | 검증사슬 ${L3.chains?.verified || 0}(완결 ${L3.chains?.complete || 0}) | 원인만 ${L3.chains?.causeOnly || 0}·작업만 ${L3.chains?.actOnly || 0}`);
  if (L3.sampleChains?.length) console.log(`  [사슬예시] ${L3.sampleChains.slice(0, 5).join(', ')}`);
  if (critic.rootGapL3) console.log(`  [근본gap] ${critic.rootGapL3}`);
  for (const h of highlights) console.log(`  + ${h}`);
  if (hollowGaps.length) console.log(`  [gap] 좌표대기 후보: ${hollowGaps.slice(0, 8).join(', ')}`);
}

(async () => {
  console.log(`[solution-miner] 관찰세션→절차 spec 상시 추출 (무과금)`);
  console.log(`  서버=${SERVER} 폴링=${POLL_MS / 1000}초 창=${HOURS}h 틱상한=${MAX_PER_TICK}`);
  if (!TOKEN) console.warn('  ⚠ 토큰 없음(~/.orbit-config.json) — 일부 엔드포인트 401 가능');
  await runOnce().catch(e => console.error('[solution-miner] 실패:', e.message));
  if (ONCE) process.exit(0);
  setInterval(() => runOnce().catch(e => console.error('[solution-miner] 실패:', e.message)), POLL_MS);
})();
