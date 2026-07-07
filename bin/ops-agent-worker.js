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

// ── 직무 프로파일: "이 사람이 회사에서 실제 어떤 업무를 하는 사람인가" — 신입 매뉴얼 수준 ──
function buildDutyPrompt(input) {
  return `당신은 Nenova 업무 OS의 업무 분석가다. 아래 관찰 데이터로 "${input.label}"의 직무 프로파일을 작성한다.
목표: 통계가 아니라, 신입 직원에게 인수인계 문서로 줄 수 있는 수준의 실무 매뉴얼 초안.

[입력 데이터]
- vision: 화면 해독 원문(최우선 근거 — 실제 어떤 화면에서 무슨 업무를 봤는지). 여기의 거래처/품목/문서/화면 이름을 그대로 쓴다.
- apps/rooms/customers: 시간 배분·담당 거래처·활동 톡방.
- receivesFrom/handsTo: 업무 흐름에서 누구에게 받아 누구에게 넘기는지(회사 내 위치).
- kakaoResponder: 카톡 이슈 대응 이력. erpManagerEvents: ERP 견적 담당 건수.

[작성 원칙]
- 절차(procedure)는 "어느 화면에서 무엇을 입력하고 무엇을 누른다/확인한다" 수준으로 구체적으로. vision에 없는 단계는 지어내지 않는다.
- "OO앱 N회 사용" 같은 통계 서술 금지. 업무 이름은 실제 업무 언어로(예: "콜롬비아 수국 발주 수량 입력", "운임비 정산").
- 근거가 부족한 부분은 duties에 넣지 말고 gaps에 "무엇이 더 관찰되어야 하는지"로 적는다.
- 한국어. 오직 JSON 하나만 출력.

[관찰 데이터]
${JSON.stringify(input).slice(0, 90000)}

[출력 JSON]
{
 "person":"${input.label}",
 "roleSummary":"이 사람의 실제 역할·회사 내 위치 한 문단",
 "flowPosition":{"receivesFrom":["사람/방/시스템"],"handsTo":["사람/방/시스템"]},
 "duties":[{"name":"업무명","when":"언제/어떤 신호로 시작","procedure":["단계1","단계2"],"tools":["앱/화면"],"inputsFrom":"입력 출처","outputsTo":"결과가 가는 곳","frequency":"관찰된 빈도","evidence":"근거(vision 시각/내용)"}],
 "manualDraft":"신입 인수인계 문서 초안(마크다운, 위 duties를 절차 중심으로 서술)",
 "gaps":["더 관찰 필요한 것"],
 "confidence":0
}`;
}

async function runDutyOnce(userId) {
  const input = await httpJson('GET', `/api/flow/duty-input?userId=${encodeURIComponent(userId)}&days=14`);
  if (!input.ok) throw new Error('duty-input 실패: ' + JSON.stringify(input).slice(0, 150));
  if ((input.vision || []).length === 0 && (input.apps || []).length === 0) {
    console.log(`  [duty] ${input.label}: 관찰 데이터 없음 — 스킵`); return null;
  }
  const report = parseJson(await runClaude(buildDutyPrompt(input)));
  report.generatedAtIso = new Date().toISOString();
  report.userId = userId; report.days = input.days;
  const r = await httpJson('POST', '/api/flow/ops-report', { kind: `duty:${userId}`, source: 'cli-agent', report });
  console.log(`  [duty] ${input.label}: ${r.ok ? 'OK' : JSON.stringify(r)} · 업무 ${report.duties?.length || 0}개 · conf ${report.confidence}`);
  return report;
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
  const DUTY_ARG = process.argv.findIndex(a => a === '--duty');
  console.log(`[ops-agent-worker] 서버=${SERVER} CLI=${CLAUDE_CLI || '없음!'} 주기=${INTERVAL_H}h once=${ONCE} duty=${DUTY_ARG >= 0}`);
  if (!CLAUDE_CLI) { console.error('Claude CLI 미발견 — claude setup-token 필요'); process.exit(1); }

  // --duty [userId|all]: 직무 프로파일만 생성하고 종료
  if (DUTY_ARG >= 0) {
    const target = process.argv[DUTY_ARG + 1] || 'all';
    const pp = await httpJson('GET', '/api/flow/people');
    const people = (pp.people || []).filter(x => x.count >= 50); // 관찰량 최소선
    const targets = target === 'all' ? people : people.filter(x => x.userId === target);
    console.log(`[duty] 대상 ${targets.length}명`);
    for (const t of targets) {
      await runDutyOnce(t.userId).catch(e => console.error(`  [duty] ${t.label} 실패:`, e.message));
    }
    process.exit(0);
  }

  let dutyIdx = 0;
  const tick = async () => {
    await runOnce().catch(e => console.error('[ops-agent] 실패:', e.message));
    // 매 틱마다 1명씩 직무 프로파일 로테이션 갱신(4h×6=하루 6명 — 전직원 1~2일 주기 신선도)
    try {
      const pp = await httpJson('GET', '/api/flow/people');
      const people = (pp.people || []).filter(x => x.count >= 50);
      if (people.length) {
        const t = people[dutyIdx % people.length]; dutyIdx++;
        await runDutyOnce(t.userId).catch(e => console.error(`  [duty] ${t.label} 실패:`, e.message));
      }
    } catch (e) { console.error('[duty] 로테이션 실패:', e.message); }
  };
  await tick();
  if (!ONCE) setInterval(tick, INTERVAL_H * 3600 * 1000);
})();
