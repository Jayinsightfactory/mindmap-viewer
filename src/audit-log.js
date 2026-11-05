/**
 * audit-log.js
 * Phase 3-G: AI 감사 로그 + PDF/HTML 리포트 생성
 *
 * 기능:
 *   1. 불변 감사 로그 (append-only JSON Lines)
 *   2. 감사 이벤트 쿼리
 *   3. HTML 리포트 렌더링 (브라우저에서 print → PDF)
 *   4. PDF 리포트 (puppeteer 선택적 사용, 없으면 HTML fallback)
 */
const fs   = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');

const AUDIT_DIR  = path.join(__dirname, '..', 'data', 'audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl');

if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

// ─── 메모리/디스크 안전 설정 ──────────────────────
// 파일당 상한(기본 50MB). 넘으면 audit.jsonl → audit.1.jsonl 로 로테이션.
const AUDIT_MAX_BYTES    = parseInt(process.env.AUDIT_MAX_BYTES, 10)    || 50 * 1024 * 1024;
// 보관 아카이브 수. 0 = 무제한(오래된 것 삭제 안 함). 오래된 아카이브 삭제는 #3(승인 필요)라 기본 OFF.
const AUDIT_MAX_ARCHIVES = parseInt(process.env.AUDIT_MAX_ARCHIVES, 10) || 0;
// 이보다 큰 단일 파일은 통째로 안 읽고 끝에서 필요한 만큼만(tail) 읽는다(레거시 대용량 아카이브 방어).
const _SAFE_READ_BYTES   = AUDIT_MAX_BYTES * 2;

function _archivePath(n) { return path.join(AUDIT_DIR, `audit.${n}.jsonl`); }

// audit 파일 목록을 '오래된 → 최신' 순으로. (audit.N 의 N 이 클수록 오래됨, 그다음 audit.jsonl 이 최신)
function _auditFilesChrono() {
  const archives = [];
  for (let n = 1; fs.existsSync(_archivePath(n)); n++) archives.push(n);
  archives.sort((a, b) => b - a); // 큰 N(오래된) 먼저
  const files = archives.map(_archivePath);
  if (fs.existsSync(AUDIT_FILE)) files.push(AUDIT_FILE); // 현재가 가장 최신
  return files;
}

// 상한 초과 시 로테이션. 체인(메모리 prevHash)은 그대로 유지돼 파일 경계를 넘어 연속된다.
let _appendsSinceCheck = 0;
function _rotateIfNeeded() {
  let size = 0;
  try { size = fs.statSync(AUDIT_FILE).size; } catch { return; }
  if (size < AUDIT_MAX_BYTES) return;
  let last = 0;
  for (let n = 1; fs.existsSync(_archivePath(n)); n++) last = n;
  for (let n = last; n >= 1; n--) {
    try { fs.renameSync(_archivePath(n), _archivePath(n + 1)); } catch {}
  }
  try { fs.renameSync(AUDIT_FILE, _archivePath(1)); } catch { return; }
  if (AUDIT_MAX_ARCHIVES > 0) { // 기본 0 = 아무것도 안 지움(#3는 별도 승인)
    for (let n = AUDIT_MAX_ARCHIVES + 1; fs.existsSync(_archivePath(n)); n++) {
      try { fs.unlinkSync(_archivePath(n)); } catch {}
    }
  }
}

// 파일 끝에서 최대 maxLines 줄만 읽기(뒤→앞 청크). 누적 버퍼를 한 번에 디코드해 멀티바이트 경계 안전.
function _tailLines(file, maxLines) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    let pos = fs.fstatSync(fd).size;
    const CHUNK = 64 * 1024;
    let buf = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      buf = Buffer.concat([chunk, buf]);
      const n = buf.toString('utf8').split('\n').filter(Boolean).length;
      if (n > maxLines) break;
    }
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
  } finally { try { fs.closeSync(fd); } catch {} }
}

// 파일을 청크 스트리밍으로 한 줄씩 콜백(상수 메모리, 멀티바이트 경계 안전). 크기 무관.
function _forEachLineSync(file, cb) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);
    const dec = new StringDecoder('utf8');
    let pos = 0, leftover = '';
    while (pos < size) {
      const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (len <= 0) break;
      pos += len;
      const parts = (leftover + dec.write(buf.slice(0, len))).split('\n');
      leftover = parts.pop();
      for (const line of parts) if (line) cb(line);
    }
    leftover += dec.end();
    if (leftover) cb(leftover);
  } finally { try { fs.closeSync(fd); } catch {} }
}

// ─── 감사 이벤트 타입 ──────────────────────────────
const AUDIT_TYPES = {
  SESSION_START:    'session.start',
  SESSION_END:      'session.end',
  FILE_MODIFIED:    'file.modified',
  TOOL_USED:        'tool.used',
  TOOL_ERROR:       'tool.error',
  SECURITY_LEAK:    'security.leak',
  CONFLICT:         'conflict.detected',
  CONTEXT_EXPORTED: 'context.exported',
  REPORT_GENERATED: 'report.generated',
  PRIVACY_CHANGED:  'privacy.changed',
  DATA_EXPORTED:    'data.exported',
};

// ─── 감사 로그 기록 ──────────────────────────────
let prevHash = '';

// 재시작 시 체인 연속성 복원: 마지막 기록의 hash 를 이어받는다.
// (이전엔 재시작마다 prevHash 가 ''로 리셋돼 그 지점에서 체인이 끊겼음)
try {
  const _last = _tailLines(AUDIT_FILE, 1);
  if (_last.length) { const _e = JSON.parse(_last[0]); if (_e && _e.hash) prevHash = _e.hash; }
} catch {}

function appendAuditLog(type, data, meta = {}) {
  if ((_appendsSinceCheck++ % 50) === 0) _rotateIfNeeded();
  const entry = {
    id:        Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    type,
    timestamp: new Date().toISOString(),
    data,
    meta: {
      source:   meta.source   || 'orbit',
      memberId: meta.memberId || null,
      channel:  meta.channel  || null,
      ...meta,
    },
    // 체인 해시 (불변성 검증용)
    prevHash,
  };

  const entryStr  = JSON.stringify(entry);
  entry.hash      = createHash('sha256').update(prevHash + entryStr).digest('hex').slice(0, 16);
  prevHash        = entry.hash;

  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

// ─── 감사 로그 쿼리 ──────────────────────────────
function queryAuditLog({ from, to, type, channel, memberId, limit = 1000 } = {}) {
  const files = _auditFilesChrono(); // 오래된 → 최신
  if (!files.length) return [];

  const applyFilters = (entries) => {
    if (from)     entries = entries.filter(e => e.timestamp >= from);
    if (to)       entries = entries.filter(e => e.timestamp <= to);
    if (type)     entries = entries.filter(e => e.type === type);
    if (channel)  entries = entries.filter(e => e.meta?.channel === channel);
    if (memberId) entries = entries.filter(e => e.meta?.memberId === memberId);
    return entries;
  };

  let collected = [];
  // 최신 파일부터(뒤→앞) 훑어, 필터 통과분을 limit 만큼 모으면 멈춘다 → 파일 크기와 무관하게 상한 메모리.
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i];
    let size = 0; try { size = fs.statSync(f).size; } catch {}
    let lines;
    if (size > _SAFE_READ_BYTES) {
      // 과대 파일(로테이션된 레거시 대용량)은 통째로 안 읽고 끝에서 필요한 만큼만.
      const need = Math.min(limit + collected.length + 2000, 200000);
      lines = _tailLines(f, need);
    } else {
      lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    }
    const entries = applyFilters(
      lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    );
    collected = entries.concat(collected); // 더 오래된 파일을 앞에 붙임
    // 날짜 하한(from) 범위질의가 아니면 최신 limit 로 충분 → 더 오래된 파일은 안 읽음.
    if (!from && collected.length >= limit) break;
  }

  return collected.slice(-limit);
}

// ─── 이벤트 → 감사 로그 자동 변환 ──────────────────
function auditFromEvents(events) {
  for (const e of events) {
    const type = e.type;
    if (type === 'session.start') {
      appendAuditLog(AUDIT_TYPES.SESSION_START, { sessionId: e.sessionId, source: e.source }, { channel: e.channelId });
    } else if (type === 'session.end') {
      appendAuditLog(AUDIT_TYPES.SESSION_END, { sessionId: e.sessionId }, { channel: e.channelId });
    } else if (['file.write','file.create'].includes(type)) {
      appendAuditLog(AUDIT_TYPES.FILE_MODIFIED, { filePath: e.data?.filePath, operation: e.data?.operation }, { channel: e.channelId, source: e.source });
    } else if (type === 'tool.end') {
      appendAuditLog(AUDIT_TYPES.TOOL_USED, { tool: e.data?.toolName, success: true }, { channel: e.channelId, source: e.source });
    } else if (type === 'tool.error') {
      appendAuditLog(AUDIT_TYPES.TOOL_ERROR, { tool: e.data?.toolName, error: e.data?.error?.slice?.(0, 200) }, { channel: e.channelId });
    }
  }
}

// ─── 무결성 검증 ─────────────────────────────────
function verifyIntegrity() {
  const files = _auditFilesChrono(); // 오래된 → 최신: 체인은 파일 경계를 넘어 이어진다
  if (!files.length) return { valid: true, checked: 0, broken: [] };

  const broken = [];
  let prev = '';
  let checked = 0;

  // 파일 크기와 무관하게 청크 스트리밍으로 한 줄씩 검증(상수 메모리).
  for (const f of files) {
    _forEachLineSync(f, (line) => {
      let entry; try { entry = JSON.parse(line); } catch { return; }
      checked++;
      if (entry.prevHash !== prev) broken.push({ id: entry.id, reason: 'chain broken' });
      prev = entry.hash;
    });
  }

  return { valid: broken.length === 0, checked, broken };
}

// ─── HTML 리포트 생성 ─────────────────────────────
function renderAuditHtml(entries, opts = {}) {
  const { from, to, title } = opts;
  const typeIcons = {
    'session.start': '🔵', 'session.end': '⚫',
    'file.modified': '📝', 'tool.used': '🔧', 'tool.error': '❌',
    'security.leak': '🚨', 'conflict.detected': '⚠️',
    'context.exported': '📤', 'report.generated': '📊',
    'privacy.changed': '🔒', 'data.exported': '📦',
  };

  // 통계 계산
  const typeCounts = {};
  const dayCounts  = {};
  entries.forEach(e => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    const day = e.timestamp.slice(0, 10);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  });

  const totalEvents = entries.length;
  const dateRange   = entries.length
    ? `${entries[0].timestamp.slice(0,10)} ~ ${entries[entries.length-1].timestamp.slice(0,10)}`
    : '—';

  const typeRows = Object.entries(typeCounts)
    .sort((a,b) => b[1]-a[1])
    .map(([t, cnt]) => `<tr><td>${typeIcons[t]||'◦'} ${t}</td><td>${cnt}</td></tr>`)
    .join('');

  const entryRows = entries.slice(-500).reverse().map(e => `
    <tr>
      <td class="mono">${e.timestamp.slice(0,19).replace('T',' ')}</td>
      <td>${typeIcons[e.type]||'◦'} ${e.type}</td>
      <td class="mono">${e.meta?.channel || '—'}</td>
      <td class="mono">${e.meta?.source || e.data?.source || '—'}</td>
      <td>${JSON.stringify(e.data || {}).slice(0, 80)}</td>
      <td class="mono small">${e.hash}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${title || 'Orbit AI 감사 로그'}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; font-size: 13px; color: #24292f; background: #fff; padding: 32px; }
  h1 { font-size: 22px; margin-bottom: 6px; }
  .subtitle { color: #57606a; font-size: 13px; margin-bottom: 24px; }
  .stats-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-box { border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 18px; min-width: 120px; }
  .stat-box .val { font-size: 24px; font-weight: 700; color: #0969da; }
  .stat-box .lbl { font-size: 11px; color: #57606a; margin-top: 2px; }
  h2 { font-size: 15px; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #d0d7de; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 10px; border: 1px solid #d0d7de; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  tr:nth-child(even) td { background: #f6f8fa; }
  .mono { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; }
  .small { font-size: 10px; color: #57606a; }
  .footer { margin-top: 32px; color: #57606a; font-size: 11px; border-top: 1px solid #d0d7de; padding-top: 12px; }
  @media print {
    body { padding: 16px; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="no-print" style="margin-bottom:16px">
  <button onclick="window.print()" style="padding:6px 14px;cursor:pointer;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa">🖨️ PDF로 저장 (Ctrl+P)</button>
</div>

<h1>⬡ Orbit AI 감사 로그</h1>
<div class="subtitle">기간: ${dateRange}${from ? '' : ' (전체)'}　생성: ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC</div>

<div class="stats-row">
  <div class="stat-box"><div class="val">${totalEvents.toLocaleString()}</div><div class="lbl">총 감사 항목</div></div>
  <div class="stat-box"><div class="val">${Object.keys(typeCounts).length}</div><div class="lbl">이벤트 타입</div></div>
  <div class="stat-box"><div class="val">${Object.keys(dayCounts).length}</div><div class="lbl">기록된 날짜</div></div>
  <div class="stat-box"><div class="val">${typeCounts['tool.error']||0}</div><div class="lbl">도구 오류</div></div>
  <div class="stat-box"><div class="val">${typeCounts['security.leak']||0}</div><div class="lbl">보안 유출 감지</div></div>
</div>

<h2>이벤트 타입 요약</h2>
<table>
  <thead><tr><th>타입</th><th>건수</th></tr></thead>
  <tbody>${typeRows}</tbody>
</table>

<h2>감사 로그 (최근 500건)</h2>
<table>
  <thead>
    <tr><th>시각</th><th>타입</th><th>채널</th><th>소스</th><th>데이터</th><th>해시</th></tr>
  </thead>
  <tbody>${entryRows}</tbody>
</table>

<div class="footer">
  Orbit v2 · 이 감사 로그는 불변 체인으로 기록됩니다 · 해시 검증: SHA-256
</div>
</body>
</html>`;
}

module.exports = {
  appendAuditLog,
  auditFromEvents,
  queryAuditLog,
  verifyIntegrity,
  renderAuditHtml,
  AUDIT_TYPES,
};
