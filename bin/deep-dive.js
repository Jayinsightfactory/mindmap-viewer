#!/usr/bin/env node
'use strict';
/**
 * deep-dive.js — 직원 작업 세밀분석 (온디맨드, owner PC 무과금 CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 직원의 화면+입력값+좌표+담당이슈를 종합해 "반복 작업마다 어떻게 자동화할지"를 세밀 분석.
 * 골모드: 통계가 아니라 "AI가 이 일을 직접 할 수 있나"·"네노바웹에 기능을 붙일까" 기준.
 * 출력: ops-report kind='deepdive:<userId>' + 'deepdive'(최신 별칭). /deepdive.html·admin에서 조회.
 *
 * 사용: node bin/deep-dive.js --user <userId>   (userId 없으면 분석 최다 직원)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const https = require('https'); const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const USER = process.argv.includes('--user') ? process.argv[process.argv.indexOf('--user') + 1] : '';
const ALL = process.argv.includes('--all'); // 전 직원 순회(새 사용자 자동 포함)
const HOURS = parseInt(process.env.DEEP_HOURS || '336');
const CLAUDE_CLI = (() => { try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; } catch { return null; } })();

function httpJson(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, SERVER); const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: (d || '').slice(0, 200) }); } }); });
    req.on('error', reject); req.setTimeout(timeoutMs || 90000, () => { req.destroy(); reject(new Error('timeout ' + p)); });
    if (data) req.write(data); req.end();
  });
}
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude CLI 없음'));
    const child = spawn(CLAUDE_CLI, ['-p'], { windowsHide: true });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 420000);
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject); child.on('close', () => { clearTimeout(timer); resolve(out || err); });
    child.stdin.write(prompt); child.stdin.end();
  });
}
function parseJson(t) { const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s < 0 || e < 0) throw new Error('JSON 없음: ' + t.slice(0, 150)); return JSON.parse(t.slice(s, e + 1)); }
const readMd = f => { try { return fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8'); } catch { return ''; } };
// 색상/품목 약어 사전(입력값 정규화용). 파일 없어도 안전(빈 문자열).
function readAbbrevBlock() {
  try {
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'abbreviations.json'), 'utf8'));
    const meta = dict._meta || {};
    const pairs = Object.entries(dict).filter(([k]) => k !== '_meta');
    if (!pairs.length) return '';
    const lines = pairs.map(([k, v]) => `  ${k} → ${v}`).join('\n');
    return `\n[색상/품목 약어 사전 — 입력값 정규화용]\n이 회사(화훼 절화 수입) 직원들이 실제로 쓰는 색상·품목·거래처 약어와 오타 표기다. 관찰 데이터의 입력값을 **먼저 이 사전으로 정규화한 뒤** 품목·수량·색상을 복원하고, 그 정규화된 값 위에서 category와 rule을 확정하라. '추정'/'미확정' 표기 항목은 확정 규칙으로 쓰지 말고 blindSpots에 남겨 사장님 확인 대상으로 표시하라.\n한/영 전환 규칙: ${meta.imeTypoRule || ''}\n${lines}\n`;
  } catch { return ''; }
}

// [골:좌표↔라벨] clickXY 파싱 — 배열 [x,y] / 문자열 "x,y" 둘 다 수용, 숫자 2개 못뽑으면 무효.
function _ddParseXY(v) {
  if (Array.isArray(v)) { const x = +v[0], y = +v[1]; return (Number.isFinite(x) && Number.isFinite(y)) ? [x, y] : null; }
  if (typeof v === 'string') { const m = v.match(/-?\d+(?:\.\d+)?/g); if (m && m.length >= 2 && Number.isFinite(+m[0]) && Number.isFinite(+m[1])) return [+m[0], +m[1]]; }
  return null;
}
// 사용자별 screen-input의 fields[].clickXY에서 직접 반복 클릭 핫스팟을 뽑는다(라벨 포함).
// 워크스페이스 공용 mouseHotspots(오귀속·데이터공백 취약) 대신 이걸 쓴다. 50px 격자 집계 → 상위 12.
function hotspotsFromScreenInput(steps) {
  const grid = new Map();
  for (const s of (steps || [])) {
    for (const f of (s.fields || [])) {
      const xy = _ddParseXY(f && f.clickXY); if (!xy) continue;
      const gx = Math.round(xy[0] / 50) * 50, gy = Math.round(xy[1] / 50) * 50, k = gx + ',' + gy;
      let e = grid.get(k); if (!e) { e = { x: gx, y: gy, count: 0, labels: {}, screens: {} }; grid.set(k, e); }
      e.count++;
      const lb = (f.label || '').trim().slice(0, 60); if (lb) e.labels[lb] = (e.labels[lb] || 0) + 1;
      const sc = (s.screen || '').trim().slice(0, 40); if (sc) e.screens[sc] = (e.screens[sc] || 0) + 1;
    }
  }
  const top = o => (Object.entries(o).sort((a, b) => b[1] - a[1])[0] || [null])[0];
  return [...grid.values()].sort((a, b) => b.count - a.count).slice(0, 12)
    .map(e => ({ x: e.x, y: e.y, count: e.count, label: top(e.labels), screen: top(e.screens) || '', automatable: e.count >= 3 }));
}

function buildPrompt(name, voice, screens, hotspots, issues, prev) {
  const prevBlock = prev ? `
[지난 분석 — 이번에 확인·보강하라 (자기개선 루프)]
지난번 요약: ${(prev.summary || '').slice(0, 300)}
지난번 '추정'으로 남긴 규칙/사각지대(이번에 데이터로 확인하거나 메워라): ${JSON.stringify([...((prev.workflows || prev.repetitiveTasks || []).map(t => t.rule).filter(r => /추정/.test(r || ''))), ...(prev.blindSpots || [])]).slice(0, 1000)}
→ 위를 우선 파고들어 이번 리포트를 더 정밀하게. 새로 관측된 흐름도 추가.
` : '';
  return `당신은 업무 프로세스 분석가다. 아래는 직원 "${name}"의 **시간순** 실제 관찰 데이터(화면 전환+타이핑 입력값+반복 클릭좌표)다.
핵심 임무: 흩어진 화면들을 **하나의 업무 흐름(워크플로우)으로 이어붙여** 복원하라. 골모드 기준: "AI가 이 흐름을 그대로 대신 수행할 수 있나".
${prevBlock}

[문체]
${voice.slice(0, 1200)}
${readAbbrevBlock()}
★★ 가장 중요 — 업무를 "낱개 작업"이 아니라 "앱→앱 순차 흐름"으로 복원하라 ★★
관찰 데이터는 시간순이다. 연속된 화면들을 읽어 **하나의 산출물을 만들기까지의 실제 단계 순서**를 이어붙여라.
예시(반드시 이 형태로):
  업무 "에콰도르 장미 34차 발주 처리" (분류: 발주처리)
   1. [카카오톡] 수입방에서 '출고 수량표 사진' 확인 → 품목·수량 파악
   2. [nenova ERP] 주문등록 화면에서 해당 거래처 품목 조회
   3. [Excel] '주광 발주' 시트에 품목·단수·출고일 입력
   4. [카카오톡] 수입방+주광담당방 대조로 발주내역 확인
   5. [이카운트] 판매전표로 전산 등록(전송)
   → 산출물: 라움 34차 발주서 → 이카운트 전표
낱개 카드로 쪼개지 말 것. "카톡 확인 → 엑셀 입력 → 전산입력 → 분산작업"처럼 도구를 넘나드는 실제 순서를 반드시 살려라.

[복원·판정 원칙]
- 각 단계 = {앱, 무슨 행동, 다룬 데이터(품목·수량·차수·출고일 등 실제 예시), 근거(시각·화면명)}. 통계("N회") 금지.
- 업무마다 **분류(category)** 를 붙여라: 발주처리 / 재고응대 / 수입카탈로그조회 / 변경사항반영 / 전산등록 / 기타. 같은 분류끼리 묶인다.
- 업무마다 **암묵 규칙(rule)** 추론: "거래처별 시트 분리", "차수_출고일(34차_0825) 시트", "정정은 32-1/32-2 분기", "품목 대체(연노랑 없으면 화이트)". 불확실하면 '추정:' 접두.
  · 위 [약어 사전]으로 입력값의 색상/품목/거래처 약어를 정규화한 뒤 rule을 확정하라(예: '진그'→진그린, '콜카장'→콜롬비아 카네이션). 사전에 없거나 '미확정'인 약어는 지어내지 말고 blindSpots에 "약어 미확정: <표기>"로 남겨라.
- 자동화 방법: nenovaweb기능추가 / PAD·pyautogui / Excel / OCR / SOP. 신뢰도: 100%가능 / 검토1스텝 / 부적합. 돈 만지는 실행은 조회까지만.
- 데이터에 있는 화면·입력값·항목 그대로 인용. 근거 없는 단계 지어내지 말 것.

[관찰 데이터 — 시간순]
화면 흐름(ts 오름차순): ${JSON.stringify(screens).slice(0, 44000)}
반복 클릭좌표: ${JSON.stringify(hotspots).slice(0, 2000)}
담당 이슈: ${JSON.stringify(issues).slice(0, 2500)}

[출력 — JSON 하나. 한국어. 코드블록 금지.]
{
 "user":"${name}","summary":"이 사람의 업무를 3문장으로",
 "workflows":[{
   "name":"업무 흐름명(예: 에콰도르 장미 34차 발주 처리)",
   "category":"발주처리|재고응대|수입카탈로그조회|변경사항반영|전산등록|기타",
   "frequency":"반복 주기(예: 출고주기마다·매일)","trigger":"이 흐름을 시작시키는 신호(예: 카톡 수입방에 출고 수량표 사진 도착)",
   "steps":[{"seq":1,"app":"카카오톡","action":"무슨 행동","data":"다룬 데이터 실제 예시","evidence":"근거 시각/화면명"}],
   "inputs":["이 흐름에 들어온 원천 데이터(톡방·첨부·시트)"],
   "output":"최종 산출물(어느 시트/전표/파일) + 다음 단계로의 핸드오프",
   "rule":"이 흐름의 분류·판단 암묵 규칙. 불확실하면 '추정:' 접두",
   "autoMethod":"nenovaweb기능추가|PAD/pyautogui|Excel|OCR|SOP","how":"이 흐름을 어떻게 자동화",
   "reliability":"100%가능|검토1스텝|부적합","estWeeklyMin":0,"difficulty":"하|중|상",
   "blindSpots":["이 흐름에서 관찰로 못 본·추정한 부분"]
 }],
 "categories":[{"name":"업무분류명","workflowNames":["그 분류에 속한 업무명들"]}],
 "classificationRules":["이 사람이 업무에서 쓰는 분류·판단 규칙 모음 — 자동화 로직의 핵심"],
 "nenovawebFeatures":[{"feature":"네노바웹에 추가할 기능","replaces":"없앨 수작업","rule":"이 기능이 구현할 분류/판단 규칙"}],
 "top3":[{"action":"먼저 착수할 3가지","expected":""}],
 "blindSpots":["전체 관찰로 못 본 것"]
}`;
}

// 한 직원 세밀분석 (자기개선: 이전 리포트의 추정·사각지대를 이번에 보강)
async function runOne(user, ctx) {
  const { oi, ki, nameMap, voice } = ctx;
  const name = nameMap[Object.keys(nameMap).find(k => user.startsWith(k.slice(0, 12))) || ''] || user.slice(0, 10);
  const [si, prev] = await Promise.all([
    httpJson('GET', `/api/vision/screen-input?userId=${encodeURIComponent(user)}&hours=${HOURS}`).catch(() => ({})),
    httpJson('GET', `/api/flow/ops-report?kind=deepdive:${user}`).catch(() => null), // 이전 리포트(자기개선)
  ]);
  const screens = (si.steps || [])
    .slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts))) // 시간순 정렬(앱→앱 흐름 복원용)
    .map(s => ({
      ts: String(s.ts).slice(5, 19), app: s.app, screen: s.screen,
      inputs: (s.inputs || []).map(x => x.ko).filter(Boolean).slice(0, 2),
      items: (s.fields || []).map(f => (f.label || '') + (f.value ? ('=' + f.value) : '')).filter(Boolean).slice(0, 5),
    })).slice(-120);
  if (screens.length < 3) { console.log(`  [${name}] 데이터 부족(${screens.length}) — 스킵`); return; }
  // 사용자별 라벨 핫스팟(screen-input clickXY 클러스터). 없으면 워크스페이스 공용으로 폴백.
  let hotspots = hotspotsFromScreenInput(si.steps);
  if (!hotspots.length) hotspots = (oi.mouseHotspots || []);
  const issues = (ki.issues || []).filter(i => (i.raisedBy || '') === name).slice(0, 12).map(i => ({ key: i.key, type: i.type, who: i.raisedBy }));
  const prevReport = (prev && prev.latest && prev.latest.report) || null;

  const t0 = Date.now();
  const report = parseJson(await runClaude(buildPrompt(name, voice, screens, hotspots, issues, prevReport)));
  report.generatedAtIso = new Date().toISOString(); report.userId = user; report.userName = name; report.refinedFromPrev = !!prevReport;
  await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive:' + user, source: 'deep-dive', report });
  await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive', source: 'deep-dive', report });
  const wfN = (report.workflows || report.repetitiveTasks || []).length;
  const stepN = (report.workflows || []).reduce((a, w) => a + (w.steps || []).length, 0);
  console.log(`  [${name}] 완료 ${Math.round((Date.now() - t0) / 1000)}s · 업무흐름 ${wfN} · 단계 ${stepN} · 규칙 ${(report.classificationRules || []).length}${prevReport ? ' · 자기개선✓' : ''}`);
}

async function main() {
  console.log(`[deepdive] ${new Date().toISOString()} 시작 ${ALL ? '(전 직원 순회)' : ''}`);
  if (!CLAUDE_CLI) { console.error('claude CLI 없음'); process.exit(1); }
  try { const q = await require('../src/quota-guard').checkQuota(25); if (q.pause) { console.log('[deepdive][quota]', q.reason); process.exit(0); } } catch {}

  // 공통 컨텍스트(한 번만 로드): ops-input·kakao·이름원장·문체
  const [oi, ki, lg, au] = await Promise.all([
    httpJson('GET', `/api/flow/ops-input?hours=168`).catch(() => ({})),
    httpJson('GET', '/api/admin/kakao-intel?hours=720', null, 200000).catch(() => ({})),
    httpJson('GET', '/api/learning/logs?limit=2000').catch(() => ({})),
    httpJson('GET', '/api/admin/all-users').catch(() => ({})), // 설치 때 입력한 이름 원장(권위 소스)
  ]);
  // 이름맵: 설치 원장(orbit_auth_users) 우선 — 깨진(�)·빈 이름은 제외, 부족분만 이벤트 로그로 보강
  const nameMap = {}; const valid = n => n && !/�/.test(n) && n.trim();
  (au.users || []).forEach(u => { if (u.id && valid(u.name)) nameMap[u.id] = u.name.trim(); });
  (lg.logs || []).forEach(l => { if (l.userId && valid(l.userName) && !nameMap[l.userId]) nameMap[l.userId] = l.userName; });
  const ctx = { oi, ki, nameMap, voice: readMd('MOYI_VOICE.md') };

  // 대상: --all이면 활동 직원 전부(새 사용자 자동 포함), 아니면 지정/최다
  let targets = [];
  if (ALL) {
    const f = await httpJson('GET', '/api/learning/capture-funnel?days=7').catch(() => ({}));
    targets = (f.funnel || []).filter(r => (r.analyzed || 0) >= 10).sort((a, b) => b.analyzed - a.analyzed).map(r => r.userId);
    console.log(`  전 직원 순회 대상 ${targets.length}명 (분석 10+): ${targets.map(u => nameMap[Object.keys(nameMap).find(k => u.startsWith(k.slice(0, 12))) || ''] || u.slice(0, 6)).join(', ')}`);
  } else {
    let u = USER;
    if (!u) { const f = await httpJson('GET', '/api/learning/capture-funnel?days=7').catch(() => ({})); u = (f.funnel || []).sort((a, b) => (b.analyzed || 0) - (a.analyzed || 0))[0]?.userId; }
    targets = u ? [u] : [];
  }
  if (!targets.length) { console.error('대상 없음'); process.exit(1); }

  // 순차 실행(서버 부하·CLI 경합 회피)
  for (const u of targets) { try { await runOne(u, ctx); } catch (e) { console.error(`  [${u.slice(0, 8)}] 실패: ${e.message}`); } }
  console.log('[deepdive] 완료');
}
main().catch(e => { console.error('[deepdive] 실패:', e.message); process.exit(1); });
