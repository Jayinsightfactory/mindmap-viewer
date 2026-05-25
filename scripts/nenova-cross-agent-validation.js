#!/usr/bin/env node
'use strict';

/**
 * Build a Claude validation packet from Orbit/Nenova live evidence.
 *
 * This script is intentionally read-only against the product API. It gathers
 * work-flow evidence, writes a compact Markdown packet, and can optionally ask
 * Claude CLI to challenge Codex's interpretation with the Nenova agent team.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const getArg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const BASE_URL = getArg('--base', process.env.ORBIT_BASE_URL || 'http://localhost:4747');
const OUT_FILE = path.resolve(getArg('--out', 'artifacts/nenova-cross-agent-validation.md'));
const CLAUDE_OUT = path.resolve(getArg('--claude-out', 'artifacts/nenova-cross-agent-validation.claude.md'));
const VALIDATION_TOKEN = getArg('--token', process.env.ORBIT_TOKEN || process.env.ORBIT_ADMIN_TOKEN || '');
const VALIDATION_USER_ID = getArg('--userId', process.env.ORBIT_VALIDATION_USER_ID || '');
const SHOULD_RUN_CLAUDE = args.has('--claude');

const endpoints = [
  ['Company OS Status', '/api/os/status'],
  ['Live Pulse', '/api/os/pulse'],
  ['Cross Flow Match', '/api/cross/flow/match'],
  ['Cross Flow Timeline', '/api/cross/flow/timeline'],
  ['Data Intelligence Recommendations', '/api/data-intel/recommendations?days=7'],
  ['Company Triggers', '/api/company/triggers'],
  ['Automation Candidates', '/api/automation-scorer/candidates?min_score=0.6'],
];

async function fetchJson(label, route) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = new URL(`${BASE_URL}${route}`);
    if (VALIDATION_USER_ID && !url.searchParams.has('userId')) {
      url.searchParams.set('userId', VALIDATION_USER_ID);
    }
    const headers = VALIDATION_TOKEN ? { Authorization: `Bearer ${VALIDATION_TOKEN}` } : {};
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
    return { label, route, ok: res.ok, status: res.status, body };
  } catch (error) {
    return { label, route, ok: false, status: 0, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function compact(value, max = 9000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... truncated ${text.length - max} chars`;
}

function summarizeEvidence(results) {
  const find = route => results.find(r => r.route.startsWith(route))?.body || {};
  const os = find('/api/os/status');
  const match = find('/api/cross/flow/match');
  const dataIntel = find('/api/data-intel/recommendations');
  const triggers = find('/api/company/triggers');
  const automation = find('/api/automation-scorer/candidates');

  return {
    activeMembers10Min: os?.activeMembers10Min ?? null,
    onlineMembers: os?.company?.onlineMembers ?? null,
    currentWorkCount: Array.isArray(os?.currentWork)
      ? os.currentWork.length
      : (os?.currentWork && typeof os.currentWork === 'object' ? Object.keys(os.currentWork).length : null),
    crossFlowSessions: match?.summary?.total ?? (Array.isArray(match?.sessions) ? match.sessions.length : null),
    returnedCrossFlowSessions: Array.isArray(match?.sessions) ? match.sessions.length : null,
    fullMatches: match?.summary?.fullMatch ?? (Array.isArray(match?.sessions)
      ? match.sessions.filter(s => s.matchType === 'full_match').length
      : null),
    unverifiedClipboard: match?.summary?.unverifiedClipboard ?? null,
    dataIntelRecommendations: dataIntel?.meta?.total ?? dataIntel?.recommendations?.length ?? null,
    highPriorityDataGaps: dataIntel?.meta?.highPriorityCount ?? null,
    companyTriggers: triggers?.totalTriggers ?? triggers?.triggers?.length ?? null,
    automationCandidates: automation?.total ?? automation?.candidates?.length ?? null,
  };
}

function buildPrompt(results) {
  const summary = summarizeEvidence(results);
  const now = new Date().toISOString();
  const failed = results.filter(r => !r.ok);

  return `# Nenova Cross-Agent Validation Packet

Generated: ${now}
Base URL: ${BASE_URL}

## Mission

Codex and Claude must mutually validate Orbit/Nenova's operational interpretation.
The product goal is to fuse three primary sources into second-level Work Units:

1. nenova.exe usage history
2. KakaoTalk/KakaoWork uploaded conversation data
3. User PC work activity data

Do not accept a claim such as "employee X worked on Y" unless at least two evidence
families agree, or the answer explicitly marks it as unverified.

## Agent Order

Use the existing Claude agents in this order:

1. nenova-data-fusion
2. nenova-workflow-forecaster
3. nenova-cross-validator
4. nenova-ops-orchestrator

## Validation Questions

- Who is doing what, at what time, in which app/window?
- Which Kakao message, room, customer, order, or request explains the work?
- Does nenova.exe evidence agree with PC activity evidence?
- Did the work create a follow-up message, schedule item, manager alert, or automation candidate?
- Where do sources disagree or remain single-source only?
- Which product feature should Codex build next to make this system more sellable?

## Current Evidence Summary

\`\`\`json
${compact(summary, 3000)}
\`\`\`

${failed.length ? `## Failed Evidence Loads

\`\`\`json
${compact(failed, 4000)}
\`\`\`
` : ''}

## Raw Evidence

${results.map(r => `### ${r.label}

Route: \`${r.route}\`
Status: ${r.ok ? 'OK' : 'FAILED'} (${r.status})

\`\`\`json
${compact(r.body || { error: r.error }, 12000)}
\`\`\`
`).join('\n')}

## Required Output

Return Korean Markdown with these sections:

1. 검증 결론: PASS/WARN/FAIL
2. 직원별 Work Unit 후보: 시간, 직원, 근거, 신뢰도
3. 데이터 충돌/누락: 어떤 소스가 부족한지
4. 직원 보조 액션: 일정, 알림, 다음 행동
5. 회사 보조 액션: 관리자 요약, 병목, 자동화 후보
6. Codex 개발 지시: 다음 1개 구현 작업과 성공 조건

Be strict. If evidence is weak, say so.`;
}

async function main() {
  const results = await Promise.all(endpoints.map(([label, route]) => fetchJson(label, route)));
  const prompt = buildPrompt(results);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, prompt, 'utf8');
  console.log(`[nenova-cross-agent-validation] wrote ${OUT_FILE}`);

  if (!SHOULD_RUN_CLAUDE) return;

  const claudeArgs = [
    '--print',
    '--permission-mode', 'dontAsk',
    '--agent', 'nenova-ops-orchestrator',
    '--add-dir', process.cwd(),
  ];
  const claude = process.platform === 'win32'
    ? spawnSync(`claude ${claudeArgs.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`, {
      cwd: process.cwd(),
      input: prompt,
      encoding: 'utf8',
      shell: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10,
    })
    : spawnSync('claude', claudeArgs, {
    cwd: process.cwd(),
    input: prompt,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 10,
  });

  fs.mkdirSync(path.dirname(CLAUDE_OUT), { recursive: true });
  const output = [
    claude.stdout || '',
    claude.stderr ? `\n\n## STDERR\n\n${claude.stderr}` : '',
    claude.error ? `\n\n## Spawn Error\n\n${claude.error.message}` : '',
    claude.signal ? `\n\n## Signal\n\n${claude.signal}` : '',
    claude.status === 0 ? '' : `\n\n## Exit Code\n\n${claude.status}`,
  ].join('').trim();
  fs.writeFileSync(CLAUDE_OUT, output, 'utf8');
  console.log(`[nenova-cross-agent-validation] wrote ${CLAUDE_OUT}`);

  if (claude.status !== 0) process.exitCode = claude.status;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
