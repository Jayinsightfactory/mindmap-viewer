'use strict';

/**
 * purpose-engine.js
 * 이벤트 스트림을 목적(Purpose) 단위로 그룹화 + 풍부한 필드 추가
 *
 * Claude Code 훅 데이터 특성:
 *   - user.message 없음 → assistant.message 또는 시간 갭으로 창 분할
 *   - tool.start/end 로 도구 사용 추적
 *   - file.write / Write 도구로 파일 변경 추적
 *   - git.commit 으로 커밋 추적
 */

const { classifyPurposes } = require('./purpose-classifier');

// ── 목적 카테고리 (purpose-classifier와 동일 구조) ────────────────────────────
const CATEGORIES = {
  implement: { label: '기능 구현',  icon: '🛠',  color: '#3fb950' },
  fix:       { label: '버그 수정',  icon: '🔧',  color: '#f85149' },
  refactor:  { label: '코드 정리',  icon: '♻️',  color: '#bc8cff' },
  test:      { label: '테스트',     icon: '🧪',  color: '#ffa657' },
  deploy:    { label: '배포/운영',  icon: '🚀',  color: '#58a6ff' },
  research:  { label: '조사/분석',  icon: '🔍',  color: '#79c0ff' },
  config:    { label: '설정/환경',  icon: '⚙️',  color: '#d29922' },
  review:    { label: '검토/리뷰',  icon: '👁',  color: '#f778ba' },
  discuss:   { label: '논의/질문',  icon: '💬',  color: '#8b949e' },
  unknown:   { label: '기타',       icon: '📌',  color: '#6b7280' },
};

/**
 * 이벤트 목록에 user.message가 충분히 있으면 true (정석 대화 데이터)
 */
function hasUserMessages(events) {
  const cnt = events.filter(e => e.type === 'user.message').length;
  return cnt >= Math.min(2, events.length * 0.01);
}

/**
 * Claude Code 훅 데이터용 창 분할:
 * assistant.message 를 기준으로 창을 나누고,
 * 같은 assistant.message 없으면 5분 시간 갭으로 나눈다.
 */
function splitByAssistantOrTime(events, gapMs = 5 * 60 * 1000) {
  if (!events.length) return [];

  const sorted = [...events].sort((a, b) =>
    new Date(a.timestamp || a.ts || 0) - new Date(b.timestamp || b.ts || 0)
  );

  const windows = [];
  let current   = [];
  let lastTs    = new Date(sorted[0].timestamp || sorted[0].ts || 0).getTime();

  for (const e of sorted) {
    const ts  = new Date(e.timestamp || e.ts || 0).getTime();
    const gap = ts - lastTs;

    // assistant.message 또는 5분 이상 갭 → 새 창 시작
    const isAssistant = e.type === 'assistant.message' || e.type === 'assistant.response';
    if ((isAssistant || gap > gapMs) && current.length > 0) {
      windows.push(current);
      current = [];
    }
    current.push(e);
    lastTs = ts;
  }
  if (current.length) windows.push(current);
  return windows;
}

/**
 * 창(window)에서 도구 사용 패턴으로 purposeId 추측
 */
function inferPurposeFromTools(windowEvents) {
  const scores = { implement: 0, fix: 0, refactor: 0, test: 0, deploy: 0,
                   research: 0, config: 0, review: 0, discuss: 0 };

  for (const e of windowEvents) {
    const tool = e.data?.toolName || '';
    const cmd  = e.data?.command || e.data?.inputPreview || '';
    const fp   = e.data?.filePath || e.data?.fileName || '';

    // Write/Edit → 구현 또는 수정
    if (/Write|Edit/i.test(tool)) {
      scores.implement += 2;
      if (/test|spec/i.test(fp)) scores.test += 3;
      if (/config|settings|\.json$/i.test(fp)) scores.config += 2;
    }
    // Read/Grep → 조사
    if (/Read|Grep|Glob/i.test(tool)) scores.research += 1;
    // Bash
    if (tool === 'Bash') {
      if (/git push|deploy|railway/i.test(cmd)) scores.deploy += 3;
      if (/git commit|git add/i.test(cmd))      scores.deploy += 1;
      if (/npm test|jest|pytest/i.test(cmd))    scores.test   += 3;
      if (/npm install|pip install/i.test(cmd)) scores.config += 2;
      if (/fix|bug|error/i.test(cmd))           scores.fix    += 2;
    }
    // git.commit
    if (e.type === 'git.commit') scores.deploy += 2;
    // file.write
    if (e.type === 'file.write') scores.implement += 1;
    // assistant.message content 힌트
    if (e.type === 'assistant.message') {
      const txt = (e.data?.content || e.data?.contentPreview || '').toLowerCase();
      if (/fix|bug|오류|수정/i.test(txt))           scores.fix       += 2;
      if (/구현|implement|추가|add|기능/i.test(txt)) scores.implement += 2;
      if (/refactor|정리|최적/i.test(txt))           scores.refactor  += 2;
      if (/설정|config|setup/i.test(txt))            scores.config    += 2;
      if (/배포|deploy|push/i.test(txt))             scores.deploy    += 2;
    }
  }

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const purposeId  = (top && top[1] > 0) ? top[0] : 'unknown';
  const confidence = Math.min((top?.[1] || 0) / 8, 1.0);
  return { purposeId, confidence, scores };
}

/**
 * 창에서 변경된 파일 목록 추출
 */
function extractFiles(windowEvents) {
  const fileSet = new Set();
  for (const e of windowEvents) {
    const tool = e.data?.toolName || '';
    const fp   = e.data?.filePath || e.data?.fileName || '';

    if (/Write|Edit|NotebookEdit/i.test(tool) && fp)
      fileSet.add(fp.replace(/\\/g, '/'));
    if (e.type === 'file.write' && fp)
      fileSet.add(fp.replace(/\\/g, '/'));

    // git add <files>
    if (tool === 'Bash') {
      const cmd = e.data?.command || e.data?.inputPreview || '';
      const m   = cmd.match(/git add\s+(.+)/);
      if (m) m[1].trim().split(/\s+/).forEach(f => {
        if (f && !f.startsWith('-') && !f.includes('*')) fileSet.add(f);
      });
    }
  }
  return [...fileSet];
}

/**
 * 창에서 마지막 git 커밋 정보 추출
 */
function extractGitCommit(windowEvents) {
  const commits = windowEvents.filter(e => e.type === 'git.commit');
  const last    = commits[commits.length - 1];
  if (!last) return { gitHash: null, gitMessage: null };
  return {
    gitHash:    last.data?.hash || last.data?.commitHash || null,
    gitMessage: last.data?.message?.split('\n')[0]?.slice(0, 80) || null,
  };
}

/**
 * 메인 함수
 * @param {object[]} events
 * @param {object}   [opts]
 * @param {number}   [opts.limit=100]
 */
function groupEventsByPurpose(events, { limit = 100 } = {}) {
  if (!events || !events.length) return [];

  let windows;

  if (hasUserMessages(events)) {
    // 정석 대화 데이터 → purpose-classifier 사용
    const rawPurposes = classifyPurposes(events);
    const eventMap    = new Map(events.map(e => [e.id, e]));

    return rawPurposes
      .map((p, idx) => {
        const wEvs      = p.eventIds.map(id => eventMap.get(id)).filter(Boolean);
        const triggerEv = wEvs.find(e => e.type === 'user.message');
        const { gitHash, gitMessage } = extractGitCommit(wEvs);
        return {
          purposeId:   p.purposeId,
          label:       p.label,
          icon:        p.icon,
          color:       p.color,
          confidence:  p.confidence,
          scores:      p.scores,
          idx,
          sessionId:   triggerEv?.sessionId || wEvs[0]?.sessionId || null,
          triggerText: (triggerEv?.data?.contentPreview || triggerEv?.data?.content || '').slice(0, 150),
          files:       extractFiles(wEvs),
          gitHash,
          gitMessage,
          eventsCount: p.eventIds.length,
          startTs:     p.startAt,
          endTs:       p.endAt,
          agentSources:[...new Set(wEvs.map(e => e.aiSource).filter(Boolean))],
          eventIds:    p.eventIds,
        };
      })
      .sort((a, b) => new Date(b.startTs || 0) - new Date(a.startTs || 0))
      .slice(0, limit);
  }

  // Claude Code 훅 데이터 → assistant.message / 시간 갭으로 분할
  windows = splitByAssistantOrTime(events);

  return windows
    .map((wEvs, idx) => {
      if (!wEvs.length) return null;
      const { purposeId, confidence, scores } = inferPurposeFromTools(wEvs);
      const cat = CATEGORIES[purposeId] || CATEGORIES.unknown;
      const { gitHash, gitMessage } = extractGitCommit(wEvs);

      // triggerText: assistant.message 의 첫 응답 요약
      const assistantEv = wEvs.find(e =>
        e.type === 'assistant.message' || e.type === 'assistant.response'
      );
      const triggerText = (
        assistantEv?.data?.contentPreview ||
        assistantEv?.data?.content || ''
      ).slice(0, 150);

      const startTs = wEvs[0].timestamp || wEvs[0].ts;
      const endTs   = wEvs[wEvs.length - 1].timestamp || wEvs[wEvs.length - 1].ts;

      return {
        purposeId,
        label:       cat.label,
        icon:        cat.icon,
        color:       cat.color,
        confidence:  Math.round(confidence * 100) / 100,
        scores,
        idx,
        sessionId:   wEvs[0].sessionId || wEvs[0].session_id || null,
        triggerText,
        files:       extractFiles(wEvs),
        gitHash,
        gitMessage,
        eventsCount: wEvs.length,
        startTs,
        endTs,
        agentSources:[...new Set(wEvs.map(e => e.aiSource).filter(Boolean))],
        eventIds:    wEvs.map(e => e.id),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startTs || 0) - new Date(a.startTs || 0))
    .slice(0, limit);
}

module.exports = { groupEventsByPurpose };
