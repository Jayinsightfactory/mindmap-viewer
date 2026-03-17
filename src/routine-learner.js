'use strict';
/**
 * routine-learner.js
 * 작업 루틴 패턴 학습 엔진
 *
 * 의도 기반 타임라인 데이터를 분석하여:
 * 1. 반복되는 작업 패턴 감지 (예: "안드로이드 앱 배포 = gradle 수정 → manifest 수정 → build → deploy")
 * 2. 작업 시간 패턴 (언제 어떤 작업을 많이 하는지)
 * 3. 도구 사용 패턴 (어떤 작업에 어떤 도구를 쓰는지)
 * 4. 개선 제안 (더 효율적인 순서, 빠진 단계 등)
 */

/**
 * Extract work units from events (same logic as frontend renderWorkUnits)
 */
function extractWorkUnits(events) {
  const CLI_NOISE = /^(dangerously[-\s]?skip|--?[\w-]+|y|n|yes|no|exit|quit)$/i;
  const units = [];
  let cur = null;

  for (const e of events) {
    if (e.type === 'user.message') {
      const msg = (e.data?.content || e.data?.contentPreview || '').replace(/[\n\r]/g, ' ').trim();
      if (msg.length > 2 && !CLI_NOISE.test(msg)) {
        if (cur && cur.intent !== msg.slice(0, 60)) units.push(cur);
        cur = { intent: msg.slice(0, 60), actions: [], result: '', files: [], startTime: e.timestamp };
      }
    } else if (cur) {
      if (e.type === 'assistant.message') {
        const msg = (e.data?.content || e.data?.contentPreview || '').trim();
        if (msg.length > 5) cur.result = msg.split(/[.!?]/)[0]?.slice(0, 60) || '';
      } else if (e.type === 'file.write' || e.type === 'file.create') {
        const fn = (e.data?.fileName || '').replace(/^[✏️📝📄\s]+/, '');
        if (fn) { cur.actions.push({ type: 'write', file: fn }); cur.files.push(fn); }
      } else if (e.type === 'tool.end') {
        const tn = e.data?.toolName || '';
        if (tn === 'Edit') {
          const fn = e.data?.filePath?.split('/').pop() || '';
          if (fn) { cur.actions.push({ type: 'edit', file: fn }); cur.files.push(fn); }
        } else if (tn === 'Bash') {
          cur.actions.push({ type: 'bash', file: (e.data?.inputPreview || '').slice(0, 30) });
        } else if (tn === 'WebSearch' || tn === 'WebFetch') {
          cur.actions.push({ type: 'research', file: 'web' });
        }
      }
    }
  }
  if (cur) units.push(cur);
  return units;
}

/**
 * File role inference (same as graph-engine)
 */
const FILE_ROLES = [
  [/auth|login|oauth|jwt|token/i, '인증'],
  [/route|router|api|endpoint|controller/i, 'API'],
  [/service|manager|provider/i, '서비스'],
  [/component|view|page|screen|activity/i, 'UI'],
  [/model|schema|entity/i, '모델'],
  [/test|spec|mock/i, '테스트'],
  [/config|setting|gradle|toml/i, '설정'],
  [/receiver|listener|handler/i, '이벤트처리'],
  [/deploy|docker|ci/i, '배포'],
];

function getFileRole(filename) {
  for (const [re, role] of FILE_ROLES) {
    if (re.test(filename)) return role;
  }
  return '코드';
}

/**
 * Analyze work patterns from multiple sessions
 * @param {Array} allSessionEvents - array of { sessionId, events }
 * @returns {Object} patterns
 */
function analyzePatterns(allSessionEvents) {
  const patterns = {
    routines: [],       // 반복되는 작업 순서
    timePatterns: {},   // 시간대별 작업 유형
    toolPatterns: {},   // 작업 유형별 도구 사용
    fileRolePatterns: {},// 파일 역할별 빈도
    suggestions: [],    // 개선 제안
    totalSessions: allSessionEvents.length,
    totalWorkUnits: 0,
  };

  const actionSequences = []; // All action sequences across sessions

  for (const { events } of allSessionEvents) {
    const units = extractWorkUnits(events);
    patterns.totalWorkUnits += units.length;

    for (const unit of units) {
      // Time patterns
      if (unit.startTime) {
        const hour = new Date(unit.startTime).getHours();
        const timeSlot = hour < 6 ? '새벽' : hour < 12 ? '오전' : hour < 18 ? '오후' : '저녁';
        patterns.timePatterns[timeSlot] = (patterns.timePatterns[timeSlot] || 0) + 1;
      }

      // Tool patterns
      const actionTypes = [...new Set(unit.actions.map(a => a.type))];
      actionTypes.forEach(t => {
        patterns.toolPatterns[t] = (patterns.toolPatterns[t] || 0) + 1;
      });

      // File role patterns
      unit.files.forEach(f => {
        const role = getFileRole(f);
        patterns.fileRolePatterns[role] = (patterns.fileRolePatterns[role] || 0) + 1;
      });

      // Action sequences (for routine detection)
      if (unit.actions.length >= 2) {
        const seq = unit.actions.map(a => {
          if (a.type === 'write' || a.type === 'edit') return getFileRole(a.file);
          return a.type;
        });
        actionSequences.push(seq);
      }
    }
  }

  // Detect repeating routines (sequences that appear 2+ times)
  const seqCounts = {};
  actionSequences.forEach(seq => {
    // Use 2-4 item subsequences
    for (let len = 2; len <= Math.min(4, seq.length); len++) {
      for (let i = 0; i <= seq.length - len; i++) {
        const sub = seq.slice(i, i + len).join('\u2192');
        seqCounts[sub] = (seqCounts[sub] || 0) + 1;
      }
    }
  });

  patterns.routines = Object.entries(seqCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([seq, count]) => ({ sequence: seq, count, description: `${seq} (${count}회 반복)` }));

  // Generate suggestions
  if (patterns.routines.length > 0) {
    patterns.suggestions.push({
      type: 'routine',
      message: `자주 반복하는 작업 패턴: ${patterns.routines[0].sequence}. 이 순서를 템플릿으로 자동화할 수 있습니다.`,
    });
  }

  const topTime = Object.entries(patterns.timePatterns).sort((a, b) => b[1] - a[1])[0];
  if (topTime) {
    patterns.suggestions.push({
      type: 'time',
      message: `${topTime[0]}에 가장 많이 작업합니다 (${topTime[1]}건). 이 시간대에 집중 모드를 활성화하는 것을 추천합니다.`,
    });
  }

  // File role distribution suggestion
  const topRole = Object.entries(patterns.fileRolePatterns).sort((a, b) => b[1] - a[1])[0];
  if (topRole && topRole[1] >= 5) {
    patterns.suggestions.push({
      type: 'specialization',
      message: `${topRole[0]} 작업이 가장 많습니다 (${topRole[1]}건). 이 영역의 자동화 템플릿을 만들면 효율이 높아집니다.`,
    });
  }

  // Tool usage suggestion
  const toolEntries = Object.entries(patterns.toolPatterns).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length >= 2) {
    const topTool = toolEntries[0];
    const TOOL_KR = { edit: '편집', write: '파일 생성', bash: '터미널', research: '검색' };
    patterns.suggestions.push({
      type: 'tool',
      message: `가장 많이 사용하는 도구: ${TOOL_KR[topTool[0]] || topTool[0]} (${topTool[1]}회). 관련 단축키/매크로를 설정해보세요.`,
    });
  }

  return patterns;
}

/**
 * Generate routine report for a user
 */
function generateReport(patterns) {
  const lines = [];
  lines.push('작업 루틴 분석 리포트');
  lines.push(`총 ${patterns.totalSessions}개 세션, ${patterns.totalWorkUnits}개 작업 단위 분석`);
  lines.push('');

  if (patterns.routines.length > 0) {
    lines.push('반복 작업 패턴:');
    patterns.routines.slice(0, 5).forEach(r => {
      lines.push(`  ${r.sequence} — ${r.count}회`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.timePatterns).length > 0) {
    lines.push('시간대별 작업량:');
    Object.entries(patterns.timePatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${k}: ${v}건`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.fileRolePatterns).length > 0) {
    lines.push('파일 역할별 빈도:');
    Object.entries(patterns.fileRolePatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${k}: ${v}건`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.toolPatterns).length > 0) {
    const TOOL_KR = { edit: '편집', write: '파일 생성', bash: '터미널', research: '검색' };
    lines.push('도구 사용 빈도:');
    Object.entries(patterns.toolPatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${TOOL_KR[k] || k}: ${v}회`);
    });
    lines.push('');
  }

  if (patterns.suggestions.length > 0) {
    lines.push('개선 제안:');
    patterns.suggestions.forEach(s => {
      lines.push(`  ${s.message}`);
    });
  }

  return lines.join('\n');
}

module.exports = { extractWorkUnits, analyzePatterns, generateReport, getFileRole };
