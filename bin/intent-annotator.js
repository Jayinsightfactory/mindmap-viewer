#!/usr/bin/env node
'use strict';
/**
 * intent-annotator.js — 의도 학습 모델 MVP (owner PC, 무과금 Claude CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * TOTAL_PLATFORM "의도 학습 모델" L1~L2 실증:
 *   관찰(screen.analyzed) → 궤적(시간순 상태-행동) → LLM 의도 역추론(단계별 '왜'+신뢰도)
 *   + ops-input timeline 시간 리듬 겹침 → ops-report kind='intent' 저장.
 * "매크로 재생 아님, 의도 이해." 화면 밖 사고는 추정으로 명시(신뢰도).
 *
 * 사용: node bin/intent-annotator.js --user <userId> [--hours 72]
 *      (userId 생략 시 최근 분석 가장 많은 직원 자동 선택)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const https = require('https');
const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const HOURS = parseInt((process.argv[process.argv.indexOf('--hours') + 1]) || process.env.INTENT_HOURS || '72');
const USER = process.argv.includes('--user') ? process.argv[process.argv.indexOf('--user') + 1] : '';
const GAP_MIN = 15; // 세션 경계(분)

const CLAUDE_CLI = (() => {
  try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; }
  catch { return null; }
})();

function httpJson(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, SERVER);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: (d || '').slice(0, 200), status: res.statusCode }); } }); });
    req.on('error', reject); req.setTimeout(timeoutMs || 45000, () => { req.destroy(); reject(new Error('timeout ' + path)); });
    if (data) req.write(data); req.end();
  });
}
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude CLI 없음'));
    const child = spawn(CLAUDE_CLI, ['-p'], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 240000);
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(out || err); });
    child.stdin.write(prompt); child.stdin.end();
  });
}
function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('JSON 없음: ' + text.slice(0, 150));
  return JSON.parse(text.slice(s, e + 1));
}
const mins = (a, b) => Math.abs(new Date(a) - new Date(b)) / 60000;

function buildPrompt(user, trajectory, rhythm) {
  return `당신은 업무 의도 분석가다. 한 직원의 화면 관찰 궤적(시간순 상태-행동)을 보고, 각 단계에서
"이 사람이 무슨 목표로 이 선택을 했나(의도)"를 역추론한다. 매크로 재생이 아니라 의도 이해가 목적.

[절대 원칙]
- 각 의도는 '가설'이다. 화면에 안 나타난 사고(전화·암묵지·순간판단)는 추론일 뿐 → confidence를 낮추고 assumed=true.
- 통계 서술 금지. 화면·앱·활동의 구체 근거로 의도를 말하라(거래처/품목/차수/문서명이 보이면 그대로).
- 시간 리듬(아래)을 의도 맥락에 활용: 차수 마감·특정 요일·이례 시간대면 그 맥락을 의도에 반영.

[직원] ${user}
[시간 리듬 — 이 사람의 요일·시간대 업무 패턴]
${JSON.stringify(rhythm).slice(0, 3000)}

[관찰 궤적 — 시간순 화면 전이]
${JSON.stringify(trajectory).slice(0, 60000)}

[출력 — 오직 아래 JSON 하나. 한국어. 코드블록 금지.]
{
 "user":"${user}",
 "sessions":[{
   "title":"이 세션의 한 줄 목표(상위 의도)",
   "spanMin":0,
   "steps":[{"seq":1,"screen":"화면/앱","intent":"이 단계에서 무엇을 하려 했나","why":"그렇게 판단한 근거","confidence":0.0,"assumed":false}],
   "goalConfidence":0.0
 }],
 "decisionRules":["관찰에서 드러난 반복 의사결정 규칙(예: 급한 톤이면 재고부터 확인)"],
 "timeInsight":"시간 리듬이 의도에 준 맥락 요약",
 "blindSpots":["관찰로는 알 수 없어 추정에 그친 부분"]
}`;
}

async function main() {
  console.log(`[intent] ${new Date().toISOString()} 시작 (hours=${HOURS})`);
  if (!CLAUDE_CLI) { console.error('claude CLI 미발견'); process.exit(1); }
  try { const q = await require('../src/quota-guard').checkQuota(20); if (q.pause) { console.log('[intent][quota]', q.reason); process.exit(0); } } catch {}

  // 대상 직원 선택 (미지정 시 최근 분석 최다)
  let user = USER;
  if (!user) {
    const f = await httpJson('GET', '/api/learning/capture-funnel?days=3').catch(() => ({}));
    const rows = (f.funnel || []).sort((a, b) => (b.analyzed || 0) - (a.analyzed || 0));
    user = rows[0]?.userId;
    if (!user) { console.error('대상 직원 없음'); process.exit(1); }
  }
  console.log('  대상:', user);

  // 궤적: screen.analyzed 시간순 → gap 기준 세션화
  const lg = await httpJson('GET', `/api/learning/logs?limit=400&userId=${encodeURIComponent(user)}`);
  const sa = (lg.logs || []).filter(l => l.type === 'screen.analyzed')
    .map(l => ({ ts: l.timestamp, app: l.app || '', screen: l.visionScreen || l.screen || '', activity: l.visionActivity || l.activity || '' }))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (sa.length < 3) { console.error(`  궤적 부족(${sa.length}) — 분석 더 쌓인 뒤 실행`); process.exit(0); }
  const sessions = []; let cur = null;
  for (const s of sa) {
    if (!cur || mins(cur[cur.length - 1].ts, s.ts) > GAP_MIN) { cur = [s]; sessions.push(cur); }
    else cur.push(s);
  }
  const traj = sessions.filter(x => x.length >= 2).slice(-8) // 최근 세션 위주
    .map((steps, i) => ({ session: i + 1, startTs: steps[0].ts, steps: steps.map((s, j) => ({ seq: j + 1, ts: String(s.ts).slice(11, 16), app: s.app, screen: s.screen, activity: s.activity })) }));
  console.log(`  궤적: ${sa.length} 화면 → ${traj.length} 세션`);

  // 시간 리듬: ops-input timeline에서 이 사람만
  const oi = await httpJson('GET', `/api/flow/ops-input?hours=168`).catch(() => ({}));
  const rhythm = (oi.timeline || []).filter(t => (t.person || '').includes(user) || t.person === user).slice(0, 60);

  // 의도 역추론
  const t0 = Date.now();
  const report = parseJson(await runClaude(buildPrompt(user, traj, rhythm)));
  report.generatedAtIso = new Date().toISOString();
  report.userId = user; report.trajectorySessions = traj.length; report.screensAnalyzed = sa.length;
  const nSteps = (report.sessions || []).reduce((s, x) => s + (x.steps || []).length, 0);
  console.log(`  의도 라벨 완료 ${Math.round((Date.now() - t0) / 1000)}s · 세션 ${(report.sessions || []).length} · 단계 ${nSteps} · 규칙 ${(report.decisionRules || []).length}`);

  const r = await httpJson('POST', '/api/flow/ops-report', { kind: 'intent:' + user, source: 'intent-annotator', report });
  const r2 = await httpJson('POST', '/api/flow/ops-report', { kind: 'intent', source: 'intent-annotator', report }); // 최신본 별칭
  console.log(`  저장: ${r.ok && r2.ok ? 'OK — GET /api/flow/ops-report?kind=intent' : JSON.stringify(r).slice(0, 150)}`);
}
main().catch(e => { console.error('[intent] 실패:', e.message); process.exit(1); });
