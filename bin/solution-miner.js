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

  // ── 광맥 2: per-screen 자동화 후보(scan) 수확 ─────────────────────────────
  // 세션 스티칭이 얇아도, 화면단위 분석(screen.analyzed)엔 이미 자동화 후보가 풍부하다.
  // 템플릿 보유 액션(ACTION_TEMPLATES 7종)이 3회+ 반복되면 spec으로 자동 변환(무과금 규칙기반).
  // 24h당 액션종류별 1회만 생성(같은 후보 매틱 재생성 방지) — 바운드된 집합이라 flooding 없음.
  let actGen = 0;
  st.seenActions = st.seenActions || {};
  try {
    const scan = await httpJson('GET', '/api/scripts/scan?minScore=0.5&limit=800');
    const groups = (scan.patterns || []).filter(g => g.hasTemplate && g.count >= 3);
    for (const g of groups) {
      if (generated + updated + actGen >= MAX_PER_TICK) break;
      const last = st.seenActions[g.actionType];
      if (last && Date.now() - last.ts < 24 * 3600 * 1000 && g.count <= (last.count || 0) + 5) continue; // 최근 생성 + 유의미 증가 없음
      const inputMap = (g.inputMaps && g.inputMaps[0]) || [];
      const gen = await httpJson('POST', '/api/scripts/generate', {
        actionType: g.actionType, scriptType: 'pyautogui', inputMap,
        eventIds: (g.eventIds || []).slice(0, 10),
        name: `자동화후보:${g.actionType}(관찰 ${g.count}회·점수 ${g.avgScore})`,
      });
      if (gen && gen.ok) {
        st.seenActions[g.actionType] = { ts: Date.now(), count: g.count };
        actGen++; st.generated = (st.generated || 0) + 1;
        if (highlights.length < 10) highlights.push(`[후보] ${g.actionType}: 관찰 ${g.count}회·점수 ${g.avgScore}${gen.script?.id ? ` #${gen.script.id}` : ''}`);
      }
    }
  } catch (e) { console.error('  [scan] 실패:', e.message); }

  _pruneState(st);
  _saveState(st);
  console.log(`[solution-miner] ${new Date().toISOString()} 세션 ${scanned}(좌표 ${withCoords}) → spec 신규 ${generated}·갱신 ${updated} | 자동화후보 ${actGen} | 스킵 ${skipped} · 누적 ${st.generated} · ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const h of highlights) console.log(`  + ${h}`);
}

(async () => {
  console.log(`[solution-miner] 관찰세션→절차 spec 상시 추출 (무과금)`);
  console.log(`  서버=${SERVER} 폴링=${POLL_MS / 1000}초 창=${HOURS}h 틱상한=${MAX_PER_TICK}`);
  if (!TOKEN) console.warn('  ⚠ 토큰 없음(~/.orbit-config.json) — 일부 엔드포인트 401 가능');
  await runOnce().catch(e => console.error('[solution-miner] 실패:', e.message));
  if (ONCE) process.exit(0);
  setInterval(() => runOnce().catch(e => console.error('[solution-miner] 실패:', e.message)), POLL_MS);
})();
