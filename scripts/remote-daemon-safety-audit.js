'use strict';

/**
 * Read-only audit against the production Orbit/Nenova server.
 *
 * This does not call daemon start/stop/restart/update endpoints and does not
 * enqueue commands. It only reads already-uploaded employee PC events.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'remote-daemon-safety-audit.md');
const BASE = (
  process.argv[2] ||
  process.env.ORBIT_AUDIT_SERVER_URL ||
  'https://mindmap-viewer-production-adb2.up.railway.app'
).replace(/\/+$/, '');

async function getJson(pathname) {
  const url = BASE + pathname;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
  return { url, status: res.status, ok: res.ok, body };
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function pct(n, d) {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

function latestLearningByHost(configs) {
  const byHost = new Map();
  for (const c of configs || []) {
    const host = c.hostname || c.config?.hostname;
    if (!host) continue;
    const prev = byHost.get(host);
    if (!prev || new Date(c.ts || c.config?.analyzedAt || 0) > new Date(prev.ts || prev.config?.analyzedAt || 0)) {
      byHost.set(host, c);
    }
  }
  return [...byHost.values()].sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
}

function summarizeDaemonEvents(events) {
  const byType = {};
  const byHost = {};
  const errors = [];
  for (const ev of events || []) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
    const d = ev.data || {};
    const host = d.hostname || d.host || 'unknown';
    byHost[host] ||= { total: 0, types: {}, latest: null, states: {}, details: {}, errors: [] };
    byHost[host].total++;
    byHost[host].types[ev.type] = (byHost[host].types[ev.type] || 0) + 1;
    if (!byHost[host].latest || new Date(ev.ts) > new Date(byHost[host].latest)) byHost[host].latest = ev.ts;
    if (d.state) byHost[host].states[d.state] = (byHost[host].states[d.state] || 0) + 1;
    if (d.detail) byHost[host].details[d.detail] = (byHost[host].details[d.detail] || 0) + 1;
    if (ev.type === 'daemon.error' || /error|fail|dead|powershell|java|cpu/i.test(JSON.stringify(d))) {
      const item = { host, type: ev.type, ts: ev.ts, data: d };
      errors.push(item);
      byHost[host].errors.push(item);
    }
  }
  return { byType, byHost, errors };
}

function linesForCounts(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .map(([type, v]) => `  - ${type}: ${v.count} latest=${v.lastTs || '-'}`);
}

function render(report) {
  const lines = [];
  lines.push('# Remote Daemon Safety Audit');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Server: ${BASE}`);
  lines.push('- Mode: read-only GET requests only; no daemon stop/restart/update');
  lines.push('');

  lines.push('## Server And Live Heartbeat');
  lines.push(`- health: HTTP ${report.health.status}, status=${report.health.body.status || report.health.body.error || 'unknown'}, timestamp=${report.health.body.timestamp || '-'}`);
  const dh = report.daemonHealth.body;
  lines.push(`- daemon-health total(last 1h): ${dh.total ?? 0}`);
  lines.push(`- daemon-health summary: ${JSON.stringify(dh.summary || {})}`);
  if (!dh.total) lines.push('- finding: 최근 1시간 heartbeat가 없어, 현재 켜져 있는 직원 PC 상태는 서버 기준으로 확인되지 않습니다.');
  lines.push('');

  lines.push('## Capture Timing Learning');
  lines.push(`- latest learned host configs: ${report.learningLatest.length}`);
  for (const c of report.learningLatest) {
    const cfg = c.config || {};
    const useful = cfg.usefulCount || 0;
    const samples = cfg.sampleCount || 0;
    lines.push(`- ${c.hostname}: samples=${samples}, useful=${useful} (${pct(useful, samples)}), default=${cfg.default || '-'}ms, byApp=${JSON.stringify(cfg.byApp || {})}, analyzed=${cfg.analyzedAt || c.ts || '-'}, delivered=${c.delivered}`);
  }
  lines.push('');

  lines.push('## Recent Event Counts By Learned User');
  for (const item of report.userCounts) {
    lines.push(`### ${item.userId}`);
    if (!item.ok) {
      lines.push(`- error: HTTP ${item.status}`);
    } else {
      const countLines = linesForCounts(item.counts);
      lines.push(countLines.length ? countLines.join('\n') : '- no events in the selected window');
    }
    lines.push('');
  }

  lines.push('## Data Intelligence');
  const quality = report.quality.body.quality || [];
  lines.push('- trigger quality:');
  for (const q of quality) lines.push(`  - ${q.trigger}: score=${q.avgScore}, count=${q.count}, avgCooltime=${q.avgCooltime}`);
  const cov = report.coverage.body.coverage || {};
  lines.push(`- work-hour Vision coverage: ${cov.workHourCoverage ?? '-'}%`);
  lines.push(`- kbCount=${cov.kbCount ?? '-'}, capCount=${cov.capCount ?? '-'}, kbToCaptureRatio=${cov.kbToCaptureRatio ?? '-'}`);
  const recs = report.recommendations.body.recommendations || [];
  lines.push('- recommendations:');
  for (const r of recs.slice(0, 20)) lines.push(`  - [${r.priority}] ${r.type}: ${r.reason} -> ${r.action}`);
  const gaps = report.gaps.body.gaps || [];
  lines.push('- gaps:');
  for (const g of gaps) lines.push(`  - [${g.impact || '-'}] ${g.name}: ${g.currentData || '-'} -> ${g.solution || '-'}`);
  lines.push('');

  lines.push('## Daemon Event Sample');
  const ev = report.daemonEventSummary;
  lines.push(`- sampled daemon events: ${report.daemonEvents.body.total || 0}`);
  lines.push(`- by type: ${JSON.stringify(ev.byType)}`);
  for (const [host, h] of Object.entries(ev.byHost).sort((a, b) => String(b[1].latest).localeCompare(String(a[1].latest))).slice(0, 20)) {
    lines.push(`- ${host}: total=${h.total}, latest=${h.latest}, types=${JSON.stringify(h.types)}, states=${JSON.stringify(h.states)}`);
    const topDetails = Object.entries(h.details).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topDetails.length) lines.push(`  - details: ${topDetails.map(([k, v]) => `${k}=${v}`).join(' | ')}`);
    if (h.errors.length) lines.push(`  - risk excerpts: ${h.errors.slice(0, 3).map(e => `${e.ts} ${e.type} ${JSON.stringify(e.data).slice(0, 180)}`).join(' | ')}`);
  }
  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const [health, daemonHealth, learning, daemonEvents, quality, coverage, gaps, recommendations] = await Promise.all([
    getJson('/health'),
    getJson('/api/admin/daemon-health'),
    getJson('/api/learning/capture-timing'),
    getJson('/api/daemon/events?limit=500'),
    getJson('/api/data-intel/quality?days=7'),
    getJson('/api/data-intel/coverage?days=7'),
    getJson('/api/data-intel/gaps'),
    getJson('/api/data-intel/recommendations?days=7'),
  ]);

  const learningLatest = latestLearningByHost(learning.body.configs || []);
  const userIds = uniq(learningLatest.map(c => c.config?.userId));
  const userCounts = [];
  for (const userId of userIds) {
    const r = await getJson(`/api/admin/event-counts?userId=${encodeURIComponent(userId)}&hours=72`);
    userCounts.push({ userId, status: r.status, ok: r.ok && r.body.ok, counts: r.body.counts || {} });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    health,
    daemonHealth,
    learning,
    learningLatest,
    daemonEvents,
    daemonEventSummary: summarizeDaemonEvents(daemonEvents.body.events || []),
    quality,
    coverage,
    gaps,
    recommendations,
    userCounts,
  };
  fs.writeFileSync(OUT, render(report), 'utf8');
  console.log(OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
