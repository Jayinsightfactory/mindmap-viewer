#!/usr/bin/env node
'use strict';
/**
 * ops-agent-worker.js — nenova 운영 에이전트 파이프라인 주기 실행 (owner PC, 무과금 Claude CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * Vision 워커와 동일 무과금 패턴. 주기적으로:
 *   1) 서버 /api/flow/ops-input 에서 융합 작업단위 데이터 fetch (data-fusion 산출물)
 *   2) Claude CLI(Max 구독)로 forecast+validate+orchestrate 한 번에 실행 → 구조화 JSON
 *   3) 서버 /api/flow/ops-report 에 저장 → 흐름 뷰(graph.html)가 표시
 *
 * 사용:
 *   node bin/ops-agent-worker.js            # 4시간마다 루프
 *   node bin/ops-agent-worker.js --once     # 1회만
 * 환경변수: ORBIT_SERVER_URL, OPS_TOKEN, OPS_INTERVAL_HOURS, OPS_INPUT_HOURS
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const https = require('https');
const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const INTERVAL_H = parseFloat(process.env.OPS_INTERVAL_HOURS || '4');
const INPUT_H = parseInt(process.env.OPS_INPUT_HOURS || '24');
const ONCE = process.argv.includes('--once');

const CLAUDE_CLI = (() => {
  try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; }
  catch { return null; }
})();

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, SERVER);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d, status: res.statusCode }); } }); });
    req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}

// 에이전트 역할 합성 프롬프트 (.claude/agents/nenova-* 의 규칙을 1콜로 압축)
function buildPrompt(input) {
  return `당신은 Nenova 업무 OS의 운영 에이전트다(nenova-ops-orchestrator). 아래 "융합된 작업단위 데이터"(data-fusion 산출물)를 받아,
워크플로우 예측(forecaster) + 교차검증(cross-validator)을 수행하고 결과를 JSON으로만 출력한다.

[입력 섹션 사용법 — 반드시 전부 활용]
- timeline: 사람×시간대(KST) 집계 — 하루 전체 리듬·부하·공백은 여기서 판단(units는 샘플일 뿐).
- units: 사람별 최근 작업단위 샘플(앱·거래처·타이핑·클릭·원천).
- vision: 화면 해독 원문 — "지금 무엇을 하는 중인지"의 최우선 근거. 거래처/품목/문서명이 여기 있다.
- kakao: 카톡 비즈니스 이벤트·의사결정(거래처·품목·미해결). unresolved=true는 아직 처리 안 된 요청 → 예측/병목의 1순위 재료.
- erp: ERP 상태 스냅샷 — 카톡 요청·PC 작업이 실제 ERP 반영으로 이어졌는지 교차검증에 사용. 비어 있으면 "ERP 근거 없음"을 명시.
- handoffs: 사람간 인계(count·매칭 keys). keys가 room뿐이면 톡방 교대 노이즈 가능성 감안.

[판단 기준]
- 시간은 KST. 직원 식별은 person 라벨 기준. 같은 거래처/주문/톡방을 다른 사람이 24h 내 이어받으면 인계(handoff).
- 병목: 한 담당자에게 작업이 몰리거나(부하 높음) 다음 단계 담당자가 비어 있음. kakao unresolved가 특정인에게 쌓이면 병목.
- 자동화 후보: 같은 유형 3회+·평균 5분+·입력/클릭 패턴 안정.
- 교차검증: 카톡↔ERP↔PC작업(vision 포함)이 시간/담당자/상태로 일치하면 PASS, 누락/충돌 있으면 WARN, 업무판단 불가면 FAIL.
- source_disagreement: 한 원천엔 있는데 다른 원천 근거가 없는 작업단위(예: 카톡 요청만 있고 PC/ERP 근거 없음).
- basis에는 반드시 구체 근거를 쓴다: 원천 이름(vision/kakao/erp/units/timeline) + 실제 거래처/품목/방/시각. "활동량 많음" 같은 통계 서술 금지.
- 근거 없는 단정 금지. 데이터로 설명 안 되면 confidence를 낮춘다.

[융합 데이터]
${JSON.stringify(input).slice(0, 90000)}

[출력 — 오직 아래 JSON 하나만, 한국어 값, 코드블록/설명 금지]
{
 "verdict":"PASS|WARN|FAIL","confidence":0,
 "summary":"한 줄 요약",
 "forecast":[{"horizon":"15분|60분|240분|1일","work":"","owner":"","etaMin":0,"basis":""}],
 "loads":[{"person":"","level":"낮음|보통|높음","basis":""}],
 "bottlenecks":[{"work":"","cause":"","impact":"","action":""}],
 "automation":[{"unit":"","basis":"","method":"PAD|pyautogui|AHK|API"}],
 "validations":[{"item":"","verdict":"PASS|WARN|FAIL","basis":""}],
 "disagreements":[{"unit":"","sources":"","note":""}]
}`;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude CLI 없음'));
    const child = spawn(CLAUDE_CLI, ['-p'], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 240000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(out || err); });
    child.stdin.write(prompt); child.stdin.end();
  });
}

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('JSON 없음: ' + text.slice(0, 120));
  return JSON.parse(text.slice(s, e + 1));
}

async function runOnce() {
  const t0 = Date.now();
  console.log(`[ops-agent] ${new Date().toISOString()} 시작 (입력 ${INPUT_H}h)`);
  const input = await httpJson('GET', `/api/flow/ops-input?hours=${INPUT_H}`);
  if (!input.ok) throw new Error('ops-input 실패: ' + JSON.stringify(input).slice(0, 200));
  console.log(`  데이터: 작업단위 ${input.units.length} · 직원 ${input.loads.length} · 핸드오프 ${input.handoffs.length}`);
  const report = parseJson(await runClaude(buildPrompt(input)));
  report.generatedAtIso = new Date().toISOString();
  report.windowHours = INPUT_H;
  const r = await httpJson('POST', '/api/flow/ops-report', { kind: 'ops', source: 'cli-agent', report });
  console.log(`  저장: ${r.ok ? 'OK' : JSON.stringify(r)} · verdict=${report.verdict} conf=${report.confidence} · 예측 ${report.forecast?.length||0}·병목 ${report.bottlenecks?.length||0}·자동화 ${report.automation?.length||0} · ${Math.round((Date.now()-t0)/1000)}s`);
}

(async () => {
  console.log(`[ops-agent-worker] 서버=${SERVER} CLI=${CLAUDE_CLI || '없음!'} 주기=${INTERVAL_H}h once=${ONCE}`);
  if (!CLAUDE_CLI) { console.error('Claude CLI 미발견 — claude setup-token 필요'); process.exit(1); }
  const tick = () => runOnce().catch(e => console.error('[ops-agent] 실패:', e.message));
  await tick();
  if (!ONCE) setInterval(tick, INTERVAL_H * 3600 * 1000);
})();
