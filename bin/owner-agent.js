#!/usr/bin/env node
'use strict';
/**
 * owner-agent.js — 사장님 대리 에이전트 (owner PC, 무과금 Claude CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * docs/OWNER_INSIGHT.md(헌법=사장님 판단기준) + 회사 데이터(그래프·X-ray·조기경보·ROI)를
 * 종합해 "사장님이라면 오늘 이걸 챙길 것 + 왜 + 제안"을 낸다. 요약·판단이지 실행 아님.
 * 매크로가 아니라 관점: 헌법대로 우선순위를 매기고, 민감업무는 제안까지만.
 * 출력: POST /api/flow/ops-report kind='owner-brief' → /owner.html·admin 허브에서 조회.
 *
 * 사용: node bin/owner-agent.js --once   (매일 스케줄 상정)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const CLAUDE_CLI = (() => { try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; } catch { return null; } })();

function httpJson(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, SERVER);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: (d || '').slice(0, 200) }); } }); });
    req.on('error', reject); req.setTimeout(timeoutMs || 60000, () => { req.destroy(); reject(new Error('timeout ' + p)); });
    if (data) req.write(data); req.end();
  });
}
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
function parseJson(t) { const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s < 0 || e < 0) throw new Error('JSON 없음: ' + t.slice(0, 150)); return JSON.parse(t.slice(s, e + 1)); }

// 거래처 위험도(조기경보와 동일 로직) + 미수 결합
function rank(customers, arMap) {
  const norm = s => String(s || '').replace(/㈜|주식회사|주\)/g, '').replace(/\(.*?\)/g, '').replace(/[\s·.\-]/g, '').trim();
  return (customers || []).filter(c => (c.mentions || 0) >= 80).map(c => {
    const tones = c.tones || [], tot = tones.reduce((a, t) => a + (t.v || 0), 0) || 1;
    const urg = (tones.find(t => /급함|긴급/.test(t.k)) || {}).v || 0;
    let r = Math.round(100 * (0.5 * (1 - (c.resolveRate == null ? 1 : c.resolveRate)) + 0.32 * (urg / tot) + 0.18 * Math.min((c.issues || 0) / (c.mentions || 1) * 4, 1)));
    const ar = arMap[norm(c.name)]; let why = [];
    if (c.resolveRate != null && c.resolveRate < 0.85) why.push('해결률 ' + Math.round(c.resolveRate * 100) + '%');
    if (ar && ar.balance > 0) { const b = ar.agingMonths >= 13 ? 30 : ar.agingMonths >= 7 ? 20 : ar.agingMonths >= 4 ? 12 : 4; r = Math.min(100, r + b); if (b >= 12) why.push('미수 ' + Math.round(ar.balance / 10000).toLocaleString() + '만·' + (ar.bucketLabel || ar.agingMonths + '개월')); }
    return { name: c.name, risk: r, why: why.join(' · ') };
  }).sort((a, b) => b.risk - a.risk).slice(0, 8);
}

function buildPrompt(constitution, data) {
  return `당신은 네노바 사장의 대리 에이전트다. 아래 [사장님 헌법]이 당신의 판단 기준이다 — 통계가 아니라 사장님의 관점으로 판단하라.
[사장님 헌법]
${constitution.slice(0, 6000)}

[오늘의 회사 데이터]
${JSON.stringify(data).slice(0, 40000)}

[임무] 헌법의 우선순위(거래처 대응·위험거래처·반복비효율·자금)로 데이터를 해석해, "사장님이라면 오늘 이걸 챙길 것"을 골라라.
- 민감업무(이체·정산 실행)는 제안까지만. 실행 지시 금지.
- 근거 없는 단정 금지. 데이터에 있는 거래처·직원·숫자로 말하라. 없으면 비운다.
- 통계 서술 금지 — "누가·무엇을·왜 챙겨야 하나".

[출력 — 오직 아래 JSON 하나. 한국어. 코드블록 금지.]
{
 "asOf":"",
 "headline":"오늘 사장님이 알아야 할 한 문장",
 "priorities":[{"rank":1,"what":"챙길 것","why":"헌법상 왜 중요한가","action":"다음 액션(제안)","who":"관련 사람/거래처","sensitive":false}],
 "watchCustomers":[{"name":"","risk":0,"why":""}],
 "quickWins":[{"task":"","tool":"","save":"주 N분/원 추정"}],
 "askOwner":["사장님 결정이 필요한 것(있으면)"],
 "blindSpots":["오늘 데이터로 못 본 것"]
}`;
}

async function main() {
  console.log(`[owner] ${new Date().toISOString()} 사장님 브리핑 생성`);
  if (!CLAUDE_CLI) { console.error('claude CLI 없음'); process.exit(1); }
  try { const q = await require('../src/quota-guard').checkQuota(25); if (q.pause) { console.log('[owner][quota]', q.reason); process.exit(0); } } catch {}

  const constitution = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OWNER_INSIGHT.md'), 'utf8');
  const [ki, ar, xr, roi] = await Promise.all([
    httpJson('GET', '/api/admin/kakao-intel?hours=720', null, 200000).catch(e => ({ _err: e.message })),
    httpJson('GET', '/api/admin/ecount-receivables').catch(() => ({ customers: {} })),
    httpJson('GET', '/api/flow/ops-report?kind=xray').catch(() => ({})),
    httpJson('GET', '/api/roi/automation-potential').catch(() => ({})),
  ]);
  const xrep = (xr.latest && xr.latest.report) || {};
  const data = {
    generatedAt: new Date().toISOString(),
    watchCustomers: rank(ki.customers, (ar && ar.customers) || {}),
    unresolvedIssues: (ki.issueSummary || {}).unresolved,
    topIssues: (ki.issues || []).filter(i => !i.resolved).slice(0, 12).map(i => ({ key: i.key, type: i.type, who: i.raisedBy, customers: i.customers, summary: (i.summary || '').slice(0, 80) })),
    xrayTop3: xrep.top3 || [],
    xrayOpportunities: (xrep.opportunities || []).slice(0, 6),
    xraySensitive: xrep.sensitiveOps || [],
    automationPotential: { yearlyUsd: (roi.total || {}).yearlyUsd, weeklyHours: (roi.total || {}).weeklyHours, ready100min: (roi.ready100 || {}).weeklyMin },
    orgMap: (xrep.orgMap || []).map(p => ({ person: p.person, duties: (p.mainDuties || [])[0] })),
  };
  console.log(`  데이터: 위험거래처 ${data.watchCustomers.length} · 미해결 ${data.unresolvedIssues} · xrayTop3 ${data.xrayTop3.length} · ROI $${(data.automationPotential.yearlyUsd) || '?'}`);

  const t0 = Date.now();
  const brief = parseJson(await runClaude(buildPrompt(constitution, data)));
  brief.generatedAtIso = new Date().toISOString();
  console.log(`  브리핑 완료 ${Math.round((Date.now() - t0) / 1000)}s · 우선순위 ${(brief.priorities || []).length} · headline: ${(brief.headline || '').slice(0, 50)}`);

  const r = await httpJson('POST', '/api/flow/ops-report', { kind: 'owner-brief', source: 'owner-agent', report: brief });
  console.log(`  저장: ${r.ok ? 'OK — GET /api/flow/ops-report?kind=owner-brief' : JSON.stringify(r).slice(0, 150)}`);
}
main().catch(e => { console.error('[owner] 실패:', e.message); process.exit(1); });
