#!/usr/bin/env node
'use strict';
/**
 * orderflow-agent.js — 설연주 발주업무 감시·검증 CLI 워커 (owner PC, 무과금)
 * ─────────────────────────────────────────────────────────────────────────────
 * 직원 설연주(MNIAFICB3DC88DCB34)의 발주업무를 거래처(라움/초이문/주광)×차수 단위로
 * 3단계 판정한다: ①데이터확인 ②데이터정리 ③변경. 오늘 데이터로 가능한 ①·③(카톡↔ERP 2-hop)을
 * 규칙기반으로 판정하고, ②(엑셀 정리)는 별도 팀 수집 대기라 '미확인'으로 자리만 둔다.
 *
 * 소비 엔드포인트(기존만 사용, 신규 서버코드 없음):
 *   GET /api/kakao/messages          — 카톡 원문(방·발신자·시각). shared 그룹방만 미러링됨.
 *   GET /api/flow/ops-input?hours=   — .erp[] = erp-ui.order.history 변경원장(차수·거래처·품목·변경유형·변경사용자)
 *                                       .vision[] = screen 화면해독 원문(전용 소규모방 보완용)
 *   POST /api/flow/ops-report        — kind='orderflow:<userId>' (+별칭 'orderflow') 저장
 *
 * 판정(핵심 · Codex 판정무결성 반영):
 *   ① 데이터확인: 거래처·차수 원문이 카톡에 있고 (설연주 발신 ∨ 발주성 원문)이면 PASS(원문 첨부),
 *              타인 단순 언급뿐이면 WARN, screen vision 서술만이면 WARN, 아무 근거도 없으면 UNKNOWN_SOURCE_GAP.
 *   ② 데이터정리: 항상 '미확인(엑셀수집대기)'.
 *   ③ 변경: 카톡 변경메시지(취소/추가/정정)와 ERP order.history 변경레코드를
 *          (차수)∧(거래처정규화)∧(품목사전정규화)∧(시각근접 ±1일) 4중 + 변경유형/값 가산으로 1:1 매칭(사용 ERP 소거).
 *          전건 매칭 PASS · 일부만/품목불일치 WARN · 이 차수 ERP 미관측(LIMIT20 절단) UNKNOWN_SOURCE_GAP.
 *          FAIL은 카톡·ERP 둘 다 존재하며 명백히 충돌할 때만(사실상 드묾). matchedCount/total 노출. 매칭로그 남김.
 *
 * 사용: node bin/orderflow-agent.js            (설연주 고정)
 *      ORDERFLOW_LLM=1 로 두면 애매한 카톡 원문 엔티티추출에 Claude CLI 보조(기본 OFF=규칙기반).
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const https = require('https'); const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const HOURS = parseInt(process.env.ORDERFLOW_HOURS || '336'); // 카톡·ERP 관측창(기본 14일)
const USE_LLM = process.env.ORDERFLOW_LLM === '1';
const TARGET_USER = process.env.ORDERFLOW_USER || 'MNIAFICB3DC88DCB34';
const TARGET_NAME = '설연주';

// ERP 계정↔직원 매핑. 근거: ops-input erp[] '변경사용자' 필드 = ERP 로그인 계정(nenovaSS1 등).
// nenovaSS1=설연주 ★사장님 확인됨(2026-08-13). 변경레코드 erpBySeol로 본인/타계정 구분.
const SEOL_ERP_ACCOUNTS = (process.env.ORDERFLOW_ERP_ACCT || 'nenovaSS1').split(',').map(s => s.trim());

// 거래처 정규화: '라움'=주식회사 트라움에스앤씨/라움, '초이문', '주광'=주광농원 등
const VENDORS = [
  { key: '라움', aliases: ['라움', '트라움에스앤씨', '트라움'] },
  { key: '초이문', aliases: ['초이문'] },
  { key: '주광', aliases: ['주광농원', '주광'] },
];
// 카톡 미러링 안 되는 전용 소규모방(선행조사) — 이 방 발주는 카톡 근거 없음 = 사각지대
const BLIND_ROOMS = ['미우라움+초이문방', '주광담당방'];
const CHANGE_RE = /취소|추가|변경|정정|삭제|바꿔|→|->/;
// 발주성 원문 판정: 수량·단위·주문/발주 어휘·변경어. 단순 타인 언급(잡담)과 구분(Codex #4).
const ORDERLIKE_RE = /주문|발주|출고|입고|\d+\s*(박스|박|box|단|속|입|본|줄기|스템|ea|st|주|st\b)|취소|추가|정정|변경|삭제/i;

function httpJson(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, SERVER); const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: (d || '').slice(0, 200), status: res.statusCode }); } }); });
    req.on('error', reject); req.setTimeout(timeoutMs || 90000, () => { req.destroy(); reject(new Error('timeout ' + p)); });
    if (data) req.write(data); req.end();
  });
}
const CLAUDE_CLI = (() => { try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; } catch { return null; } })();
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude CLI 없음'));
    const child = spawn(CLAUDE_CLI, ['-p'], { windowsHide: true });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 300000);
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject); child.on('close', () => { clearTimeout(timer); resolve(out || err); });
    child.stdin.write(prompt); child.stdin.end();
  });
}

// ── 품목/약어 정규화 사전(카톡 한글 ↔ ERP 영문 매칭 재료) ──
let ABBREV = {};
try {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'abbreviations.json'), 'utf8'));
  for (const [k, v] of Object.entries(d)) { if (k === '_meta') continue; ABBREV[k] = String(v).replace(/\(.*$/, '').trim(); }
} catch {}

// ── 정규화 헬퍼 ──
function vendorsIn(text) { const t = String(text || ''); return VENDORS.filter(v => v.aliases.some(a => t.includes(a))).map(v => v.key); }
function vendorOfErp(name) { const t = String(name || ''); const v = VENDORS.find(v => v.aliases.some(a => t.includes(a))); return v ? v.key : null; }
// 카톡 자유문에서 차수 토큰 추출: "33-1","33-2차","33차"(대차수만) 모두 수용 → 정규형 major 또는 major-minor
function cyclesIn(text) {
  const out = new Set(); const s = String(text || ''); let m;
  // 세부차수는 정정 카운터(1~9)라 minor 1자리로 제한 → "60-20cm"(줄기길이)·가격을 차수로 오인 방지.
  const re = /(?<![\d])(\d{1,3})\s*-\s*0*([1-9])(?![0-9])/g; // 33-1 / 33-01 / 33 - 2
  while ((m = re.exec(s))) out.add(m[1] + '-' + parseInt(m[2], 10));
  const re2 = /(?<![\d.-])(\d{1,3})\s*차/g;              // 33차 (대차수만)
  while ((m = re2.exec(s))) out.add(m[1]);
  return [...out];
}
function normCycle(s) { // ERP '차수' "33-01" → "33-1"
  const m = String(s || '').match(/(\d{1,3})\s*-\s*0*(\d{1,2})/); if (m) return m[1] + '-' + parseInt(m[2], 10);
  const m2 = String(s || '').match(/(\d{1,3})/); return m2 ? m2[1] : null;
}
const major = c => String(c).split('-')[0];
// 대차수만(minor 없음) 표기는 같은 대차수의 모든 세부차수와 매칭 허용
function cycleMatch(a, b) { if (a === b) return true; if (major(a) !== major(b)) return false; return a === major(a) || b === major(b); }
// 문자열 → 정규화 토큰셋(영문 3+ / 한글 2+, 약어 치환). 카톡 한글품목 ↔ ERP 영문품목 교집합 판정용.
function tokens(s) {
  const set = new Set(); const str = String(s || '');
  (str.toLowerCase().match(/[a-z]{3,}/g) || []).forEach(w => set.add(w));
  (str.match(/[가-힣]{2,}/g) || []).forEach(w => {
    const n = ABBREV[w] || w;
    (n.match(/[가-힣]{2,}/g) || [n]).forEach(x => set.add(x));
    (n.toLowerCase().match(/[a-z]{3,}/g) || []).forEach(x => set.add(x));
  });
  return set;
}
function itemOverlap(a, b) { const A = tokens(a), B = tokens(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n; }
const kstDay = iso => { try { return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10); } catch { return ''; } };
function dayDiff(aIso, bDay) { const a = kstDay(aIso), b = (bDay || '').slice(0, 10); if (!a || !b) return 99; return Math.abs((new Date(a) - new Date(b)) / 86400000); }
const snip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// ── 카톡 페이지네이션 수집(startDate로 관측창 제한) ──
async function pullKakao(sinceIso) {
  const out = [];
  for (let off = 0; off < 8000; off += 1000) {
    const r = await httpJson('GET', `/api/kakao/messages?limit=1000&offset=${off}&startDate=${encodeURIComponent(sinceIso)}`).catch(() => ({}));
    const m = r.messages || []; out.push(...m); if (m.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`[orderflow] ${new Date().toISOString()} 시작 · 대상=${TARGET_NAME}(${TARGET_USER}) · 창=${HOURS}h`);
  const sinceIso = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const [msgsAll, oi] = await Promise.all([
    pullKakao(sinceIso),
    httpJson('GET', `/api/flow/ops-input?hours=${HOURS}`).catch(() => ({})),
  ]);
  console.log(`  카톡 원문 ${msgsAll.length}건 · ops-input.erp ${(oi.erp || []).length}건 · vision ${(oi.vision || []).length}건`);

  // ERP 변경원장 파싱(erp-ui.order.history만). ops-input.erp는 서버에서 LIMIT 20 → 관측창 좁음(blindSpot).
  const erpAll = (oi.erp || []).filter(e => e.type === 'erp-ui.order.history').map(e => {
    try { return { _ts: e.ts, ...JSON.parse(e.data) }; } catch { return null; }
  }).filter(Boolean).map(r => ({
    ts: r._ts, cycle: normCycle(r['차수']), vendor: vendorOfErp(r['거래처명']), vendorRaw: r['거래처명'],
    item: r['품목명'], kind: r['변경유형'], field: r['변경항목'], date: r['변경일자'],
    base: r['기준값'], val: r['변경값'], erpUser: r['변경사용자'],
  }));

  // 카톡: 대상 거래처를 언급한 메시지만(잡음 축소). 방은 shared 그룹방 전부 수용.
  const vendorMsgs = msgsAll.map(m => ({ ...m, vendors: vendorsIn(m.message), cycles: cyclesIn(m.message) }))
    .filter(m => m.vendors.length);

  // vision 화면해독(전용 소규모방 보완): 설연주 관련 + 거래처 언급
  const visionSeol = (oi.vision || []).filter(v => (v.person || '').includes(TARGET_NAME) || vendorsIn(v.activity).length)
    .map(v => ({ ts: v.ts, activity: v.activity, vendors: vendorsIn(v.activity), cycles: cyclesIn(v.activity) }));

  // 선택: LLM 엔티티추출(애매한 변경문만, 기본 OFF). 규칙기반이 1차라 실패해도 계속.
  let llmEntities = null;
  if (USE_LLM && CLAUDE_CLI) {
    try {
      const sample = vendorMsgs.filter(m => CHANGE_RE.test(m.message)).slice(0, 25)
        .map(m => `[${(m.created_at || '').slice(5, 16)}] ${m.sender}: ${snip(m.message)}`).join('\n');
      const out = await runClaude(`아래 화훼 수입회사 카톡 변경메시지에서 각 줄의 {거래처,차수,품목,행동(취소/추가/변경)}만 JSON 배열로 추출. 코드블록 금지, JSON만.\n${sample}`);
      const s = out.indexOf('['), e = out.lastIndexOf(']'); if (s >= 0 && e > s) llmEntities = JSON.parse(out.slice(s, e + 1));
    } catch (err) { console.log('  [llm] 스킵:', err.message); }
  }

  const auditLog = [];
  const vendorsOut = [];
  const overall = { pass: 0, warn: 0, fail: 0, unknown: 0 };

  for (const V of VENDORS) {
    const vMsgs = vendorMsgs.filter(m => m.vendors.includes(V.key));
    const vErp = erpAll.filter(e => e.vendor === V.key);
    // 이 거래처의 차수 유니버스: 카톡 언급 차수 ∪ ERP 차수
    const cycSet = new Set();
    vMsgs.forEach(m => m.cycles.forEach(c => cycSet.add(c)));
    vErp.forEach(e => { if (e.cycle) cycSet.add(e.cycle); });
    // 대차수만/세부차수 중복 정리: 세부차수가 있으면 그걸 우선(대차수-only 별도 유지)
    const cycles = [...cycSet].sort();

    const cyclesOut = [];
    for (const cyc of cycles) {
      // ── ① 데이터확인 ──
      const s1msgs = vMsgs.filter(m => m.cycles.some(c => cycleMatch(c, cyc)));
      let step1;
      if (s1msgs.length) {
        // 발신자 판정 반영(Codex #4): 설연주 본인발신 또는 발주성 원문일 때만 PASS. 단순 타인 언급뿐이면 WARN.
        const seolMsgs = s1msgs.filter(m => (m.sender || '').includes(TARGET_NAME));
        const orderLike = s1msgs.filter(m => ORDERLIKE_RE.test(m.message || ''));
        const bySeol = seolMsgs.length > 0;
        // 근거 선택: (본인+발주성) > 발주성 > 본인 > 첫 메시지
        const rep = seolMsgs.find(m => ORDERLIKE_RE.test(m.message || '')) || orderLike[0] || seolMsgs[0] || s1msgs[0];
        const qualifies = bySeol || orderLike.length > 0;
        step1 = { verdict: qualifies ? 'PASS' : 'WARN', evidence: {
          ts: rep.created_at, room: rep.chatroom, sender: rep.sender, text: snip(rep.message),
          bySeol, orderLike: orderLike.length > 0, msgCount: s1msgs.length,
          note: qualifies ? undefined : '거래처·차수 언급은 있으나 설연주 발신도 발주성 원문도 아님(타인 언급뿐)' } };
      } else {
        const vis = visionSeol.find(v => v.vendors.includes(V.key) && v.cycles.some(c => cycleMatch(c, cyc)));
        step1 = vis
          ? { verdict: 'WARN', evidence: { source: 'screen-vision', ts: vis.ts, text: snip(vis.activity), note: '카톡 원문 없음·화면해독 서술만' } }
          : { verdict: 'UNKNOWN_SOURCE_GAP', evidence: { note: '카톡·화면 근거 모두 없음 → 미러링/수집 공백(전용 소규모방 가능). 미발주 단정 불가(≠FAIL)' } };
      }

      // ── ② 데이터정리 (엑셀수집 대기) ──
      const step2 = { verdict: '미확인', reason: '엑셀 정리값 소스 미연결(별도 팀 수집중). 붙으면 발주 원문 vs 엑셀 정리값 대사(對査)로 확장.' };

      // ── ③ 변경 ──
      const kChanges = s1msgs.filter(m => CHANGE_RE.test(m.message));
      const eChanges = vErp.filter(e => e.cycle && cycleMatch(e.cycle, cyc));
      const changes = [];
      const usedErp = new Set();       // 1:1 매칭(Codex #2): 이미 근거로 쓴 ERP 레코드 인덱스 소거
      const unmatchedKakao = [];       // 미매칭 카톡 변경(Codex #1 노출)
      let matchedCount = 0, anyTimeOnly = false;
      for (const km of kChanges) {
        // 최적 ERP 매칭: 품목 교집합·일자 근접 + 변경유형/항목/값 참고(Codex #5). 소거된 ERP는 제외.
        let best = null;
        for (let i = 0; i < eChanges.length; i++) {
          if (usedErp.has(i)) continue;
          const e = eChanges[i];
          const ov = itemOverlap(km.message, e.item);
          const dd = dayDiff(km.created_at, e.date);
          // 변경유형/항목/기준값·변경값도 카톡 원문과 겹치면 신뢰 가산(품목+날짜만 매칭 과신 방지)
          const metaHit = itemOverlap(km.message, `${e.kind || ''} ${e.field || ''} ${e.base || ''} ${e.val || ''}`) > 0 ? 1 : 0;
          const score = 2 /*차수+거래처(그룹핑으로 성립)*/ + (ov > 0 ? 1 : 0) + (dd <= 1 ? 1 : 0) + metaHit;
          if (!best || score > best.score || (score === best.score && ov > best.ov)) best = { e, i, ov, dd, score, metaHit };
        }
        // 4중(차수+거래처+품목+시각)이 성립해야 매칭. metaHit은 가산점일 뿐 품목/시각 부재를 대체하지 않음.
        const matched = !!best && best.ov > 0 && best.dd <= 1;
        if (matched) { usedErp.add(best.i); matchedCount++; }
        else { unmatchedKakao.push(snip(km.message).slice(0, 60)); if (best && best.dd <= 1) anyTimeOnly = true; }
        const rec = { what: snip(km.message), kakaoTs: km.created_at, sender: km.sender,
          erpTs: best ? best.e.date : null, erpItem: best ? best.e.item : null, erpUser: best ? best.e.erpUser : null,
          erpBySeol: best ? SEOL_ERP_ACCOUNTS.includes(best.e.erpUser) : null,
          score: best ? best.score : 0, itemOverlap: best ? best.ov : 0, dayDiff: best ? best.dd : null, matched };
        changes.push(rec);
        auditLog.push({ vendor: V.key, cycle: cyc, kakao: snip(km.message).slice(0, 60), erp: best ? best.e.item : '(무)', score: rec.score, matched });
      }
      const total = kChanges.length;
      let step3;
      if (total) {
        const ev = { matchedCount, total, unmatchedKakao };
        if (matchedCount === total) {
          // 전건 매칭일 때만 PASS(Codex #1: 부분성공→전체PASS 금지)
          step3 = { verdict: 'PASS', changes, evidence: { ...ev, note: `카톡 변경 ${total}건 전건 ERP 4중매칭 성립` } };
        } else if (matchedCount > 0) {
          // 일부만 매칭 → WARN(부분매칭)
          step3 = { verdict: 'WARN', changes, evidence: { ...ev, note: `부분매칭 ${matchedCount}/${total} — 나머지 ${total - matchedCount}건 ERP 매칭 실패` } };
        } else if (eChanges.length) {
          // 이 차수 ERP 변경레코드는 존재하나 전건 매칭 실패 → 품목 정규화 저신뢰 가능(Codex #3: FAIL 아님, WARN)
          step3 = { verdict: 'WARN', changes, evidence: { ...ev, note: anyTimeOnly
            ? '차수+거래처+시각은 맞으나 품목 정규화 불일치(한↔영 매칭 저신뢰)'
            : '이 차수 ERP 변경레코드는 있으나 품목·시각 매칭 실패(품목 정규화 저신뢰 가능)' } };
        } else {
          // 이 차수 ERP 레코드 없음 = ERP 원장 LIMIT 20 절단 관측한계 → 소스공백(Codex #3: FAIL 아님)
          step3 = { verdict: 'UNKNOWN_SOURCE_GAP', changes, evidence: { ...ev, note: 'ERP order.history가 서버 LIMIT 20으로 절단 → 이 차수 미관측. 미반영 단정 불가(≠FAIL). ERP 전량 소스 필요' } };
        }
      } else if (eChanges.length) {
        step3 = { verdict: 'WARN', changes: eChanges.slice(0, 5).map(e => ({ what: `ERP ${e.kind} ${e.item} ${e.field} ${e.base}→${e.val}`, kakaoTs: null, erpTs: e.date, erpUser: e.erpUser, matched: false })),
          evidence: { matchedCount: 0, total: 0, unmatchedKakao: [], note: 'ERP 변경레코드만 있고 카톡 변경 원문 없음(전용방/구두 가능)' } };
      } else {
        step3 = { verdict: '변경없음', changes: [], evidence: { matchedCount: 0, total: 0, unmatchedKakao: [], note: '이 차수 변경 신호 없음' } };
      }

      for (const st of [step1, step3]) { const v = st.verdict; if (v === 'PASS') overall.pass++; else if (v === 'WARN') overall.warn++; else if (v === 'FAIL') overall.fail++; else if (v === 'UNKNOWN_SOURCE_GAP') overall.unknown++; }
      cyclesOut.push({ cycle: cyc, step1, step2, step3 });
    }

    const p = cyclesOut.filter(c => c.step1.verdict === 'PASS').length;
    const s3pass = cyclesOut.filter(c => c.step3.verdict === 'PASS').length;
    const s3warn = cyclesOut.filter(c => c.step3.verdict === 'WARN').length;
    const s3gap = cyclesOut.filter(c => c.step3.verdict === 'UNKNOWN_SOURCE_GAP').length;
    const summary = cyclesOut.length
      ? `차수 ${cyclesOut.length}건 관측 · ①PASS ${p} · 변경 PASS ${s3pass}/WARN ${s3warn}/소스공백 ${s3gap}`
      : '관측창 내 발주·변경 신호 없음';
    vendorsOut.push({ vendor: V.key, cycles: cyclesOut, summary });
  }

  const blindSpots = [
    `판정 무결성(Codex 반영): '미반영'은 FAIL이 아니라 UNKNOWN_SOURCE_GAP(소스공백)으로 표기. FAIL은 카톡·ERP 둘 다 존재하며 명백히 충돌할 때만(현 규칙에선 방향성 미검증이라 사실상 미발생).`,
    `전용 소규모방(${BLIND_ROOMS.join('·')})은 카톡 미러링 대상 아님 → 그 방 발주·정정은 카톡 근거 부재. screen-vision 보완만 가능(소스공백이 실제 누락이 아닐 수 있음).`,
    `ERP 변경원장(ops-input.erp)은 서버에서 최근 20건만 반환 → 관측창 내 과거 변경 누락 가능(관측한계≠실제없음). 정밀 검증엔 erp-ui.order.history 전량 소스 필요.`,
    `방향성 미검증: 카톡 '취소'와 ERP '추가'처럼 반대 방향이어도 차수+품목+시각이 맞으면 매칭됨(인과≠상관). 변경유형(kind) 일치까지 강제하려면 카톡 행동어 파싱 강화 필요.`,
    `복합키 부재: 매칭은 (차수 major/minor)∧(거래처 정규화)∧(품목 토큰)∧(±1일)로만 성립. 안정적 (orderYear,vendorId,majorCycle,minorCycle) 복합키·ERP 레코드 안정 ID 없음 → 1:1 소거는 관측창 내에서만 보장.`,
    `ERP 계정 매핑 nenovaSS1=${TARGET_NAME} 확정(2026-08-13 사장님 확인). 변경레코드 erpBySeol=false면 타계정 입력.`,
    `품목 한↔영 매칭(카톡 한글 vs ERP 'Hydrangea Dark Pink (진핑크)')은 토큰 교집합 기반 저신뢰. 품목 불일치 WARN은 실제 매칭일 수 있음.`,
    `② 데이터정리는 엑셀 수집 미연결로 전건 '미확인'(엑셀수집대기).`,
  ];

  const report = {
    user: TARGET_NAME, userId: TARGET_USER, generatedAtIso: new Date().toISOString(),
    windowHours: HOURS, method: USE_LLM ? '규칙기반+LLM보조' : '규칙기반',
    vendors: vendorsOut, overall, blindSpots,
    auditTrail: auditLog.slice(0, 50),
  };

  await httpJson('POST', '/api/flow/ops-report', { kind: 'orderflow:' + TARGET_USER, source: 'orderflow-agent', report });
  await httpJson('POST', '/api/flow/ops-report', { kind: 'orderflow', source: 'orderflow-agent', report });

  console.log(`[orderflow] 완료 · overall PASS ${overall.pass}/WARN ${overall.warn}/FAIL ${overall.fail}/소스공백 ${overall.unknown}`);
  for (const v of vendorsOut) console.log(`  · ${v.vendor}: ${v.summary}`);
  return report;
}

main().catch(e => { console.error('[orderflow] 실패:', e.message); process.exit(1); });
