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

function buildPrompt(name, voice, screens, hotspots, issues) {
  return `당신은 업무 자동화 컨설턴트다. 아래는 직원 "${name}"의 실제 관찰 데이터(화면+타이핑 입력값+반복 클릭좌표+담당 이슈)다.
이 사람의 **반복 작업을 세밀히 분석**해, 각각을 어떻게 자동화할지 판정하라. 골모드 기준: "AI가 이 일을 직접 할 수 있나 / 네노바웹에 기능을 붙일까".

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

async function main() {
  console.log(`[deepdive] ${new Date().toISOString()} 시작`);
  if (!CLAUDE_CLI) { console.error('claude CLI 없음'); process.exit(1); }
  try { const q = await require('../src/quota-guard').checkQuota(25); if (q.pause) { console.log('[deepdive][quota]', q.reason); process.exit(0); } } catch {}

  let user = USER;
  if (!user) { const f = await httpJson('GET', '/api/learning/capture-funnel?days=7').catch(() => ({})); user = (f.funnel || []).sort((a, b) => (b.analyzed || 0) - (a.analyzed || 0))[0]?.userId; }
  if (!user) { console.error('대상 없음'); process.exit(1); }

  const [si, oi, ki, users] = await Promise.all([
    httpJson('GET', `/api/vision/screen-input?userId=${encodeURIComponent(user)}&hours=${HOURS}`).catch(() => ({})),
    httpJson('GET', `/api/flow/ops-input?hours=168`).catch(() => ({})),
    httpJson('GET', '/api/admin/kakao-intel?hours=720', null, 200000).catch(() => ({})),
    httpJson('GET', '/api/learning/logs?limit=1').catch(() => ({})),
  ]);
  // 이름 조회
  let name = user.slice(0, 10);
  try { const lg = await httpJson('GET', `/api/learning/logs?limit=2000`); const hit = (lg.logs || []).find(l => (l.userId || '').startsWith(user.slice(0, 12))); if (hit && hit.userName) name = hit.userName; } catch {}

  // 화면마다: 앱·화면명·타이핑원문 + 화면 속 항목/첨부(이미지·파일·PDF 언급) → 분류 규칙 추론 재료
  const screens = (si.steps || []).map(s => ({
    ts: String(s.ts).slice(5, 16), app: s.app, screen: s.screen,
    inputs: (s.inputs || []).map(x => x.ko).filter(Boolean).slice(0, 2),
    items: (s.fields || []).map(f => (f.label || '') + (f.value ? ('=' + f.value) : '')).filter(Boolean).slice(0, 5),
  })).slice(-120);
  const hotspots = (oi.mouseHotspots || []);
  const issues = (ki.issues || []).filter(i => (i.raisedBy || '') === name || (i.customers || []).length).slice(0, 15).map(i => ({ key: i.key, type: i.type, who: i.raisedBy }));
  console.log(`  대상: ${name} · 화면+입력 ${screens.length} · 핫스팟 ${hotspots.length} · 이슈 ${issues.length}`);
  if (screens.length < 3) { console.error('  데이터 부족'); process.exit(0); }

  const t0 = Date.now();
  const report = parseJson(await runClaude(buildPrompt(name, readMd('MOYI_VOICE.md'), screens, hotspots, issues)));
  report.generatedAtIso = new Date().toISOString(); report.userId = user; report.userName = name;
  console.log(`  완료 ${Math.round((Date.now() - t0) / 1000)}s · 반복작업 ${(report.repetitiveTasks || []).length} · 웹기능 ${(report.nenovawebFeatures || []).length}`);

  await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive:' + user, source: 'deep-dive', report });
  const r = await httpJson('POST', '/api/flow/ops-report', { kind: 'deepdive', source: 'deep-dive', report });
  console.log(`  저장: ${r.ok ? 'OK — GET /api/flow/ops-report?kind=deepdive' : JSON.stringify(r).slice(0, 120)}`);
}
main().catch(e => { console.error('[deepdive] 실패:', e.message); process.exit(1); });
