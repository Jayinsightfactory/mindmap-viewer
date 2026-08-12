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

function buildPrompt(name, voice, screens, hotspots, issues, prev) {
  const prevBlock = prev ? `
[지난 분석 — 이번에 확인·보강하라 (자기개선 루프)]
지난번 요약: ${(prev.summary || '').slice(0, 300)}
지난번 '추정'으로 남긴 규칙(이번에 데이터로 확인하거나 확신도 조정): ${JSON.stringify((prev.repetitiveTasks || []).map(t => t.rule).filter(r => /추정/.test(r || ''))).slice(0, 800)}
지난번 사각지대(이번에 새 데이터로 메울 수 있으면 메워라): ${JSON.stringify(prev.blindSpots || []).slice(0, 600)}
→ 위를 우선 파고들어 이번 리포트를 더 정밀하게. 새로 관측된 작업도 추가.
` : '';
  return `당신은 업무 자동화 컨설턴트다. 아래는 직원 "${name}"의 실제 관찰 데이터(화면+타이핑 입력값+반복 클릭좌표+담당 이슈)다.
이 사람의 **반복 작업을 세밀히 분석**해, 각각을 어떻게 자동화할지 판정하라. 골모드 기준: "AI가 이 일을 직접 할 수 있나 / 네노바웹에 기능을 붙일까".
${prevBlock}

[문체]
${voice.slice(0, 1500)}

[판정 원칙]
- 반복 작업 단위로 묶어라(같은 화면·같은 입력 패턴). 통계("N회") 금지 — "무슨 화면에서 무슨 값을 어떻게".
- 각 작업의 자동화 방법을 구체적으로: nenovaweb기능추가(웹에 버튼/화면 신설) / PAD·pyautogui(데스크톱 반복클릭) / Excel함수·매크로 / OCR / SOP(사람 교육). 좌표(mouseHotspots.automatable)·정형입력이면 자동화 신뢰도↑.
- 신뢰도: 100%가능(규칙완결) / 검토1스텝(매칭·해석 개입) / 부적합(판단·협상). 돈 만지는 실행은 조회까지만.
- 근거 없는 단정 금지. 데이터에 있는 화면·입력값 그대로 인용.

★이 분석의 핵심: 각 반복 작업마다 **업무의 사고 과정을 복원**하라 —
  "어느 톡방/화면에서 → 무슨 첨부(이미지·파일·PDF)를 찾아 → 무슨 데이터를 뽑아 → 어디에 입력하고 → 어떤 기준으로 분류·구분했나".
  특히 **분류 기준(암묵 규칙)** 을 추론하라. 예: "차수(32-1)별로 나눔", "거래처별 시트 분리", "출고일(8월6일/10일) 기준 구분", "품목 대체 규칙(연노랑 튤립 없으면 화이트)".
  이 규칙을 알아야 자동화가 가능하다. data의 items(화면 속 항목·첨부)·inputs(타이핑값)·screen(화면명)에서 근거를 찾아 추론하되, 불확실하면 '추정:'으로 표기.

[관찰 데이터]
화면+입력값+항목(최근): ${JSON.stringify(screens).slice(0, 42000)}
반복 클릭좌표: ${JSON.stringify(hotspots).slice(0, 2500)}
담당 이슈: ${JSON.stringify(issues).slice(0, 3500)}

[출력 — JSON 하나. 한국어. 코드블록 금지.]
{
 "user":"${name}","summary":"이 사람의 업무를 3문장으로",
 "repetitiveTasks":[{
   "task":"반복 작업명",
   "source":"어디서 시작 — 톡방/화면 + 찾은 첨부(이미지·파일·PDF 있으면 명시)",
   "extract":"거기서 뽑는 데이터(품목·수량·단가·차수·출고일 등 실제 예시)",
   "inputTo":"어디에 입력 — 화면/시트/칸",
   "classifyBy":"어떤 기준으로 분류·구분",
   "rule":"추론한 분류·판단 규칙(암묵 기준). 불확실하면 '추정:' 접두",
   "autoMethod":"nenovaweb기능추가|PAD/pyautogui|Excel|OCR|SOP","how":"위 규칙을 어떻게 기능·코드로 구현",
   "reliability":"100%가능|검토1스텝|부적합","estWeeklyMin":0,"difficulty":"하|중|상","evidence":"근거 화면/입력값/항목"
 }],
 "classificationRules":["이 사람이 업무에서 쓰는 분류·판단 규칙 모음 — 자동화 로직의 핵심"],
 "nenovawebFeatures":[{"feature":"네노바웹에 추가할 기능","why":"","replaces":"없앨 수작업","rule":"이 기능이 구현할 분류/판단 규칙"}],
 "top3":[{"action":"먼저 착수할 3가지","expected":""}],
 "blindSpots":["관찰로 못 본 것"]
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
  const screens = (si.steps || []).map(s => ({
    ts: String(s.ts).slice(5, 16), app: s.app, screen: s.screen,
    inputs: (s.inputs || []).map(x => x.ko).filter(Boolean).slice(0, 2),
    items: (s.fields || []).map(f => (f.label || '') + (f.value ? ('=' + f.value) : '')).filter(Boolean).slice(0, 5),
  })).slice(-120);
  if (screens.length < 3) { console.log(`  [${name}] 데이터 부족(${screens.length}) — 스킵`); return; }
  const hotspots = (oi.mouseHotspots || []).filter(h => true);
  const issues = (ki.issues || []).filter(i => (i.raisedBy || '') === name).slice(0, 12).map(i => ({ key: i.key, type: i.type, who: i.raisedBy }));
  const prevReport = (prev && prev.latest && prev.latest.report) || null;

  const t0 = Date.now();
  const report = parseJson(await runClaude(buildPrompt(name, voice, screens, hotspots, issues, prevReport)));
  report.generatedAtIso = new Date().toISOString(); report.userId = user; report.userName = name; report.refinedFromPrev = !!prevReport;
  await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive:' + user, source: 'deep-dive', report });
  await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive', source: 'deep-dive', report });
  console.log(`  [${name}] 완료 ${Math.round((Date.now() - t0) / 1000)}s · 반복작업 ${(report.repetitiveTasks || []).length} · 규칙 ${(report.classificationRules || []).length}${prevReport ? ' · 자기개선✓' : ''}`);
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
