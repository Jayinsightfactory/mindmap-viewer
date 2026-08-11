#!/usr/bin/env node
'use strict';
/**
 * xray-worker.js — 회사 업무 X-ray 진단 (owner PC, 무과금 Claude CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * TOTAL_PLATFORM.md "업무 진단 레이어" 18항목을 관찰 데이터로 합성:
 *   사장님 8: 구조도·비효율·편차·AI화·Excel/OCR 미활용·RPA후보·신뢰도판정
 *   보완 10: 정량화·우선순위·속인화·부하편차·이중입력·재작업·SOP·권한분리·사각지대·delta
 * 실행하지 않는다 — 진단·기회식별·신뢰도 등급까지만(컨설턴트 레이어).
 *
 * 입력: /api/flow/ops-input(융합 작업단위) + /api/admin/kakao-intel(플레이북 요약)
 *      + /api/learning/capture-funnel(커버리지→사각지대) + 직전 xray 리포트(delta용)
 * 출력: POST /api/flow/ops-report kind='xray' → GET ?kind=xray 로 조회(추가 서버코드 불필요)
 *
 * 사용: node bin/xray-worker.js --once   (주1회 수동/스케줄 실행 상정)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const https = require('https');
const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const INPUT_H = parseInt(process.env.XRAY_INPUT_HOURS || '168'); // 주간

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
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 300000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
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

function buildPrompt(bundle) {
  return `당신은 회사 업무 X-ray 진단 컨설턴트다. 아래 관찰 데이터(화면해독·카톡·작업단위·커버리지)로
소기업(화훼 수입유통)의 업무를 진단한다. **작업을 실행하라는 게 아니다 — 진단·기회식별·신뢰도 판정까지만.**

[절대 원칙]
- ★정적 인원표·조직도가 아니라, **이 데이터에 실제로 나타난 활동·사람만으로** 판단하라. 명단에 있어도 데이터가 없으면 언급 금지. 데이터에만 있고 이름 미상이면 계정ID 그대로 쓰되 '이름 미상'으로 표기(억지로 아는 사람에 끼워맞추지 말 것).
- 통계 서술 금지("N회 사용" 무의미). 반드시 "누가·어느 화면에서·무슨 업무를·어떻게" 수준으로.
- 근거 없는 단정 금지: 각 항목에 evidence(원천+실제 화면/거래처/품목/방 이름) 필수. 데이터로 안 보이면 항목을 비우고 blindSpots에 사유를 적어라.
- 시간 정량화: 관찰된 세션 길이·빈도에서 보수적으로 추정하고 "추정"임을 명시.

[신뢰도 등급 정의 — opportunities.reliability]
- "100%가능": 규칙이 완결(정형양식 옮기기·Excel 함수 치환·고정화면 반복클릭). 판단 개입 0.
- "검토1스텝": 매칭/해석 개입(거래처명 매칭·자유양식 파싱) → AI 처리 후 사람 확인 1회.
- "부적합": 판단·협상·예외처리가 본질 → 사람 유지.

[관찰 데이터 — 섹션 활용법 (반드시 전부 활용)]
- ops.vision: 화면 해독 원문 — "무슨 화면에서 무슨 업무" 최우선 근거. 거래처/품목/문서명이 여기 있다.
- ops.typedSamples: 실제 타이핑한 값(한글 복원) — **무엇을 입력했는지의 직접 근거**(거래처명·품목·수량·검색어). 이중입력·자동화후보·업무내용 판단에 결정적으로 써라.
- ops.mouseHotspots: 반복 클릭 좌표{x,y,count,automatable} — automatable=true면 pyautogui 자동화 후보 지점. reliability='100%가능' 근거로 활용.
- ops.units/timeline: 작업단위 샘플·사람×시간대 리듬(부하·피크·이례). ops.handoffs: 사람간 인계.
- kakaoPlaybook: 카톡 자동화후보·판단규칙·미해결이슈·거래처 대응. coverage: 분석 커버리지(사각지대 근거).
- ★인코딩 깨진 값(U+FFFD·물음표)은 근거로 쓰지 말고 blindSpots에 "인코딩 손상"으로 남겨라.

[관찰 데이터]
${JSON.stringify(bundle).slice(0, 95000)}

[출력 — 오직 아래 JSON 하나만. 한국어 값. 코드블록·설명 금지. 데이터 없는 배열은 빈 배열.]
{
 "summary":"회사 업무 전체를 3문장으로",
 "coverage":{"visiblePeople":0,"note":"관찰이 커버하는 범위","blindSpots":["전화·대면·미설치PC 등 이 진단이 못 보는 것"]},
 "orgMap":[{"person":"","mainDuties":["실제 관찰된 주업무"],"receivesFrom":"","handsTo":"","evidence":""}],
 "inefficiencies":[{"what":"","person":"","causeType":"도구|프로세스|숙련","evidence":"","estWeeklyMin":0}],
 "variances":[{"task":"","people":["같은 업무를 다르게 하는 사람들"],"difference":"","betterWay":"어느 방식이 왜 나은가","sopDraft":"표준절차 1-2줄"}],
 "duplicateEntry":[{"info":"","chain":"카톡→엑셀→ERP 등","evidence":"","estWeeklyMin":0}],
 "rework":[{"what":"","signal":"수정/취소/재입력 근거","estWeeklyMin":0}],
 "keyPersonRisks":[{"task":"","onlyPerson":"","risk":"이 사람 부재 시 무슨 일이 생기나"}],
 "loadBalance":[{"person":"","level":"낮음|보통|높음","peak":"요일/시간대 패턴","evidence":""}],
 "opportunities":[{"task":"","tool":"AI|Excel기능|OCR|ComputerUse","method":"구체 방법(예: VLOOKUP, 정형OCR, pyautogui 반복클릭)","reliability":"100%가능|검토1스텝|부적합","reliabilityBasis":"","estWeeklyMinSaved":0,"difficulty":"하|중|상","evidence":""}],
 "sensitiveOps":[{"what":"이체/정산 등 돈 만지는 업무","who":"","dualCheck":"이중확인 관찰됨|한 사람 단독|불명","note":""}],
 "top3":[{"action":"다음에 할 딱 3가지","why":"임팩트×신뢰도×난이도 근거","expected":""}],
 "delta":"직전 리포트 대비 변화(첫 회면 'baseline')"
}`;
}

async function main() {
  console.log(`[xray] ${new Date().toISOString()} 진단 시작 (입력 ${INPUT_H}h)`);
  if (!CLAUDE_CLI) { console.error('Claude CLI 미발견'); process.exit(1); }
  try { const q = await require('../src/quota-guard').checkQuota(30); if (q.pause) { console.log('[xray][quota]', q.reason); process.exit(0); } } catch {}

  // 1) 데이터 수집 — 실패한 소스는 스킵하고 사각지대에 반영되게 null 표시
  const [opsInput, funnel, prevXray] = await Promise.all([
    httpJson('GET', `/api/flow/ops-input?hours=${INPUT_H}`).catch(e => ({ _err: e.message })),
    httpJson('GET', '/api/learning/capture-funnel?days=7').catch(e => ({ _err: e.message })),
    httpJson('GET', '/api/flow/ops-report?kind=xray').catch(() => null),
  ]);
  // kakao-intel 롤업은 느림(콜드 100s+) — 넉넉한 타임아웃, 실패해도 진행
  const kakao = await httpJson('GET', '/api/admin/kakao-intel?hours=720', null, 200000).catch(e => ({ _err: e.message }));

  const bundle = {
    generatedAt: new Date().toISOString(), inputHours: INPUT_H,
    ops: opsInput && !opsInput._err ? opsInput : { unavailable: opsInput?._err },
    coverage: funnel && !funnel._err ? funnel : { unavailable: funnel?._err },
    kakaoPlaybook: kakao && !kakao._err ? {
      // 요약만(프롬프트 예산): 플레이북·이슈요약·거래처/직원 상위
      automationCandidates: (kakao.playbook?.automationCandidates || []).slice(0, 25),
      judgmentRules: (kakao.playbook?.judgmentRules || []).slice(0, 25),
      steps: kakao.playbook?.steps || [],
      issueSummary: kakao.issueSummary || null,
      topIssues: (kakao.issues || []).slice(0, 25),
      customers: (kakao.customers || []).slice(0, 15),
      employees: (kakao.employees || []).slice(0, 15),
    } : { unavailable: kakao?._err },
    prevReportSummary: prevXray?.latest?.report ? {
      ts: prevXray.latest.ts, summary: prevXray.latest.report.summary,
      top3: prevXray.latest.report.top3, counts: {
        inefficiencies: (prevXray.latest.report.inefficiencies || []).length,
        opportunities: (prevXray.latest.report.opportunities || []).length,
      },
    } : null, // delta(⑱)용
  };
  console.log(`  수집: ops=${!bundle.ops.unavailable} funnel=${!bundle.coverage.unavailable} kakao=${!bundle.kakaoPlaybook.unavailable} prev=${!!bundle.prevReportSummary}`);

  // 2) 진단 합성 (CLI 1콜)
  const t0 = Date.now();
  const report = parseJson(await runClaude(buildPrompt(bundle)));
  report.generatedAtIso = new Date().toISOString();
  report.inputHours = INPUT_H;
  console.log(`  진단 완료 ${Math.round((Date.now() - t0) / 1000)}s · 기회 ${report.opportunities?.length || 0} · 비효율 ${report.inefficiencies?.length || 0} · top3 ${report.top3?.length || 0}`);

  // 3) 저장
  const r = await httpJson('POST', '/api/flow/ops-report', { kind: 'xray', source: 'xray-worker', report });
  console.log(`  저장: ${r.ok ? 'OK — GET /api/flow/ops-report?kind=xray' : JSON.stringify(r).slice(0, 200)}`);
}

main().catch(e => { console.error('[xray] 실패:', e.message); process.exit(1); });
