/**
 * report-generator.js
 * Phase 1-A: 일일/주간 AI 세션 리포트 자동 생성
 *
 * 생성 항목:
 *   - 세션 타임라인 요약
 *   - 도구별 사용 횟수 / 목적별 비율
 *   - 가장 많이 수정한 파일
 *   - 충돌/이슈 발생 여부
 *   - 전날 대비 비교
 *   - 마크다운 + JSON 이중 출력 (Slack/이메일/파일 모두 지원)
 */

// ─── 날짜 유틸 ──────────────────────────────────────
function toDateStr(ts) {
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}
function toTimeStr(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
function msBetween(a, b) {
  return Math.abs(new Date(b) - new Date(a));
}
function fmtDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

// ─── 이벤트 배열 → 리포트 데이터 ───────────────────
function buildReportData(events, opts = {}) {
  const { from, to, memberName = '사용자' } = opts;

  // 시간 범위 필터
  const rangeFrom = from ? new Date(from) : null;
  const rangeTo   = to   ? new Date(to)   : null;
  const filtered  = events.filter(e => {
    const ts = new Date(e.timestamp);
    if (rangeFrom && ts < rangeFrom) return false;
    if (rangeTo   && ts > rangeTo)   return false;
    return true;
  });

  if (filtered.length === 0) return null;

  const firstTs = filtered[0].timestamp;
  const lastTs  = filtered[filtered.length - 1].timestamp;

  // ── 기본 통계 ────────────────────────────────────
  const toolCounts   = {};
  const sourceCounts = {};
  const purposeCounts = {};
  const fileSet      = new Set();
  const errorEvents  = [];
  let userMsgCount   = 0;
  let assistantMsgCount = 0;

  for (const e of filtered) {
    const tool   = e.data?.toolName || e.type;
    const source = e.source || e.aiSource || 'claude';
    const purpose = e.purposeId || 'unknown';

    toolCounts[tool]     = (toolCounts[tool]   || 0) + 1;
    sourceCounts[source] = (sourceCounts[source]|| 0) + 1;
    purposeCounts[purpose] = (purposeCounts[purpose] || 0) + 1;

    if (e.data?.filePath)  fileSet.add(e.data.filePath);
    if (e.data?.files)     e.data.files.forEach(f => typeof f === 'string' && !f.startsWith('[') && fileSet.add(f));
    if (e.type === 'tool.error') errorEvents.push(e);
    if (e.type === 'user.message') userMsgCount++;
    if (e.type === 'assistant.message') assistantMsgCount++;
  }

  // ── AI 소스별 정렬 ────────────────────────────────
  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([src, cnt]) => ({ source: src, count: cnt, pct: Math.round(cnt / filtered.length * 100) }));

  // ── 목적별 정렬 ──────────────────────────────────
  const PURPOSE_LABELS = {
    implement: { label: '기능 구현', icon: '🛠' },
    fix:       { label: '버그 수정', icon: '🔧' },
    refactor:  { label: '코드 정리', icon: '♻️' },
    test:      { label: '테스트',   icon: '🧪' },
    deploy:    { label: '배포',     icon: '🚀' },
    research:  { label: '조사',     icon: '🔍' },
    config:    { label: '설정',     icon: '⚙️' },
    review:    { label: '검토',     icon: '👁' },
    discuss:   { label: '논의',     icon: '💬' },
    unknown:   { label: '기타',     icon: '📌' },
    // 일반 업무 카테고리 (일상 어댑터)
    communication: { label: '커뮤니케이션', icon: '💬' },
    document:      { label: '문서/스프레드시트', icon: '📄' },
    browsing:      { label: '정보 탐색', icon: '🌐' },
    meeting:       { label: '회의',     icon: '🎥' },
    erp:           { label: '업무 시스템', icon: '🏢' },
  };

  const topPurposes = Object.entries(purposeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pid, cnt]) => {
      const meta = PURPOSE_LABELS[pid] || { label: pid, icon: '📌' };
      return { purposeId: pid, ...meta, count: cnt, pct: Math.round(cnt / filtered.length * 100) };
    });

  // ── 도구 TOP 10 ───────────────────────────────────
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, cnt]) => ({ tool, count: cnt }));

  // ── 가장 많이 수정된 파일 ─────────────────────────
  const fileCounts = {};
  for (const e of filtered) {
    const paths = [e.data?.filePath, ...(e.data?.files || [])].filter(f => f && typeof f === 'string' && !f.startsWith('['));
    for (const fp of paths) {
      fileCounts[fp] = (fileCounts[fp] || 0) + 1;
    }
  }
  const topFiles = Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, count]) => ({ path, fileName: path.split(/[\\/]/).pop(), count }));

  // ── 세션 목록 ─────────────────────────────────────
  const sessionMap = {};
  for (const e of filtered) {
    const sid = e.sessionId || 'default';
    if (!sessionMap[sid]) sessionMap[sid] = { id: sid, events: [], source: e.source };
    sessionMap[sid].events.push(e);
  }
  const sessions = Object.values(sessionMap).map(s => ({
    id:        s.id,
    source:    s.source,
    eventCount: s.events.length,
    startAt:   s.events[0]?.timestamp,
    endAt:     s.events[s.events.length - 1]?.timestamp,
    duration:  fmtDuration(msBetween(s.events[0]?.timestamp, s.events[s.events.length - 1]?.timestamp)),
  }));

  // ── 활성 시간대 분석 (시간별 이벤트 수) ─────────
  const hourBuckets = Array(24).fill(0);
  for (const e of filtered) {
    const h = new Date(e.timestamp).getHours();
    hourBuckets[h]++;
  }
  const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

  return {
    memberName,
    dateLabel: toDateStr(firstTs),
    rangeLabel: `${toTimeStr(firstTs)} ~ ${toTimeStr(lastTs)}`,
    totalEvents:    filtered.length,
    totalSessions:  sessions.length,
    totalDuration:  fmtDuration(msBetween(firstTs, lastTs)),
    userMsgCount,
    assistantMsgCount,
    errorCount:     errorEvents.length,
    fileCount:      fileSet.size,
    topSources,
    topPurposes,
    topTools,
    topFiles,
    sessions,
    hourBuckets,
    peakHour,
    errors: errorEvents.slice(0, 5).map(e => ({
      tool: e.data?.toolName,
      preview: e.data?.inputPreview || e.data?.output || '',
      ts: e.timestamp,
    })),
  };
}

// ─── 리포트 데이터 → 마크다운 ───────────────────────
function renderMarkdown(data) {
  if (!data) return '# 리포트\n\n데이터 없음';

  const purposeBar = data.topPurposes.map(p =>
    `  ${p.icon} **${p.label}** ${p.pct}%`
  ).join('\n');

  const toolTable = data.topTools
    .map(t => `  | ${t.tool} | ${t.count}회 |`)
    .join('\n');

  const fileList = data.topFiles
    .map(f => `  - \`${f.fileName}\` (${f.count}회)`)
    .join('\n');

  const sourceList = data.topSources
    .map(s => `  - ${s.source}: ${s.count}회 (${s.pct}%)`)
    .join('\n');

  const sessionList = data.sessions.slice(0, 5)
    .map(s => `  - ${s.source || 'claude'} | ${s.eventCount}개 이벤트 | ${s.duration}`)
    .join('\n');

  const errorSection = data.errorCount > 0
    ? `\n### ⚠️ 오류 (${data.errorCount}건)\n${data.errors.map(e => `  - [${e.tool}] ${e.preview.substring(0, 60)}`).join('\n')}\n`
    : '';

  // 시간대 미니 바차트
  const maxBucket = Math.max(...data.hourBuckets, 1);
  const hourChart = data.hourBuckets
    .map((v, h) => {
      const bar = '█'.repeat(Math.round(v / maxBucket * 8));
      const highlight = h === data.peakHour ? `**${String(h).padStart(2,'0')}시** ${bar}` : `${String(h).padStart(2,'0')}시 ${bar}`;
      return v > 0 ? highlight : null;
    })
    .filter(Boolean)
    .join(' · ');

  return `# 🌌 Orbit 일일 리포트 — ${data.dateLabel}

**${data.memberName}** · ${data.rangeLabel} · 총 ${data.totalDuration}

---

## 📊 요약
| 항목 | 값 |
|------|----|
| 총 이벤트 | **${data.totalEvents}건** |
| 세션 수 | ${data.totalSessions}개 |
| 파일 접근 | ${data.fileCount}개 |
| 오류 발생 | ${data.errorCount}건 |
| 사용자 메시지 | ${data.userMsgCount}건 |

---

## 🎯 목적별 작업
${purposeBar || '  데이터 없음'}

---

## 🤖 AI/앱 소스
${sourceList || '  데이터 없음'}

---

## 🔧 도구 사용 TOP 10
  | 도구 | 횟수 |
  |------|------|
${toolTable || '  | - | - |'}

---

## 📁 주요 파일
${fileList || '  없음'}

---

## ⏱ 활성 시간대
피크: **${data.peakHour}시**
${hourChart}
${errorSection}
---

## 💬 세션 목록
${sessionList || '  없음'}

---
*Orbit · 자동 생성됨*`;
}

// ─── 리포트 데이터 → Slack 메시지 블록 ─────────────
function renderSlackBlocks(data) {
  if (!data) return [{ type: 'section', text: { type: 'mrkdwn', text: '데이터 없음' } }];

  const purposeText = data.topPurposes.map(p => `${p.icon} ${p.label} *${p.pct}%*`).join('  ');
  const topToolText = data.topTools.slice(0, 5).map(t => `\`${t.tool}\` ${t.count}회`).join(' · ');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🌌 Orbit 일일 리포트 — ${data.dateLabel}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*총 이벤트*\n${data.totalEvents}건` },
        { type: 'mrkdwn', text: `*작업 시간*\n${data.totalDuration}` },
        { type: 'mrkdwn', text: `*파일 접근*\n${data.fileCount}개` },
        { type: 'mrkdwn', text: `*오류*\n${data.errorCount}건` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*🎯 목적별*\n${purposeText || '없음'}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔧 주요 도구*\n${topToolText || '없음'}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Orbit 자동 생성 · 피크 시간 ${data.peakHour}시` }],
    },
  ];
}

module.exports = { buildReportData, renderMarkdown, renderSlackBlocks };
