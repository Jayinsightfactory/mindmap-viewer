/**
 * conflict-detector.js
 * Phase 1-C: 충돌 감지
 *
 * 감지 항목:
 *   1. 같은 파일을 여러 세션/도구가 동시 수정
 *   2. 같은 파일에 짧은 시간 내 반복 수정 (AI 도구들이 서로 되돌리는 패턴)
 *   3. 오류 반복 발생 (같은 도구에서 연속 오류)
 *   4. 비정상적으로 큰 파일 수정 (의도치 않은 전체 교체 위험)
 */

const CONFLICT_WINDOW_MS  = 10 * 60 * 1000;  // 10분 내 동일 파일 중복 수정
const RAPID_EDIT_COUNT    = 4;                // 10분 내 같은 파일 N회 이상 수정
const ERROR_REPEAT_COUNT  = 3;                // 같은 도구 연속 오류 N회

// ─── 충돌 심각도 ─────────────────────────────────────
const SEVERITY = {
  HIGH:   'high',    // 즉시 알림 필요
  MEDIUM: 'medium',  // 주의 필요
  LOW:    'low',     // 참고용
};

// ─── 메인 감지 함수 ─────────────────────────────────
function detectConflicts(events) {
  const conflicts = [];

  // 파일별 수정 이벤트 그룹화
  const fileEdits = {}; // filePath → [{ ts, source, sessionId, tool }]
  for (const e of events) {
    if (!['tool.end', 'tool.start', 'file.write', 'file.create'].includes(e.type)) continue;
    const paths = [e.data?.filePath, ...(e.data?.files || [])]
      .filter(f => f && typeof f === 'string' && !f.startsWith('['));
    for (const fp of paths) {
      if (!fileEdits[fp]) fileEdits[fp] = [];
      fileEdits[fp].push({
        eventId:   e.id,
        ts:        new Date(e.timestamp).getTime(),
        tsStr:     e.timestamp,
        source:    e.source || e.aiSource || 'unknown',
        sessionId: e.sessionId,
        tool:      e.data?.toolName || e.type,
        operation: e.data?.operation || 'write',
      });
    }
  }

  // ── 충돌 1: 같은 파일 복수 세션 동시 수정 ─────────
  for (const [fp, edits] of Object.entries(fileEdits)) {
    const sorted = edits.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (b.ts - a.ts > CONFLICT_WINDOW_MS) continue;
      if (a.sessionId !== b.sessionId || a.source !== b.source) {
        conflicts.push({
          type:     'multi_session_edit',
          severity: SEVERITY.HIGH,
          filePath: fp,
          fileName: fp.split(/[\\/]/).pop(),
          message:  `⚠️ 충돌: \`${fp.split(/[\\/]/).pop()}\`을(를) ${a.source}와 ${b.source}가 ${Math.round((b.ts - a.ts) / 60000)}분 간격으로 수정`,
          events:   [a.eventId, b.eventId],
          detectedAt: new Date().toISOString(),
          detail: { sourceA: a.source, sourceB: b.source, timeDiffMin: Math.round((b.ts - a.ts) / 60000) },
        });
      }
    }
  }

  // ── 충돌 2: 짧은 시간 내 반복 수정 (AI 핑퐁 패턴) ─
  for (const [fp, edits] of Object.entries(fileEdits)) {
    const sorted = edits.sort((a, b) => a.ts - b.ts);
    // 슬라이딩 윈도우로 CONFLICT_WINDOW_MS 내 RAPID_EDIT_COUNT 이상이면 경고
    for (let i = 0; i < sorted.length; i++) {
      const windowEdits = sorted.filter(
        e => e.ts >= sorted[i].ts && e.ts <= sorted[i].ts + CONFLICT_WINDOW_MS
      );
      if (windowEdits.length >= RAPID_EDIT_COUNT) {
        const sources = [...new Set(windowEdits.map(e => e.source))];
        conflicts.push({
          type:     'rapid_repeated_edit',
          severity: sources.length > 1 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
          filePath: fp,
          fileName: fp.split(/[\\/]/).pop(),
          message:  `🔄 반복 수정: \`${fp.split(/[\\/]/).pop()}\` 10분 내 ${windowEdits.length}회 수정 (${sources.join(', ')})`,
          events:   windowEdits.map(e => e.eventId),
          detectedAt: new Date().toISOString(),
          detail: { editCount: windowEdits.length, sources },
        });
        break; // 같은 파일에 중복 추가 방지
      }
    }
  }

  // ── 충돌 3: 같은 도구 연속 오류 ──────────────────
  const errorsByTool = {};
  for (const e of events) {
    if (e.type !== 'tool.error') continue;
    const tool = e.data?.toolName || 'unknown';
    if (!errorsByTool[tool]) errorsByTool[tool] = [];
    errorsByTool[tool].push(e);
  }
  for (const [tool, errs] of Object.entries(errorsByTool)) {
    const sorted = errs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    // 연속 3회 이상 오류
    for (let i = 0; i <= sorted.length - ERROR_REPEAT_COUNT; i++) {
      const window = sorted.slice(i, i + ERROR_REPEAT_COUNT);
      const span   = new Date(window[window.length - 1].timestamp) - new Date(window[0].timestamp);
      if (span < CONFLICT_WINDOW_MS) {
        conflicts.push({
          type:     'repeated_tool_error',
          severity: SEVERITY.MEDIUM,
          filePath: null,
          fileName: null,
          message:  `❌ 반복 오류: ${tool}에서 ${ERROR_REPEAT_COUNT}회 연속 오류 발생`,
          events:   window.map(e => e.id),
          detectedAt: new Date().toISOString(),
          detail: { tool, errorCount: ERROR_REPEAT_COUNT, spanMin: Math.round(span / 60000) },
        });
        break;
      }
    }
  }

  // 중복 제거 (같은 파일+타입 조합)
  const seen = new Set();
  return conflicts.filter(c => {
    const key = `${c.type}:${c.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });
}

// ─── 실시간 단일 이벤트 충돌 체크 (WebSocket 브로드캐스트용) ──
function checkNewEvent(event, recentEvents) {
  // 새 이벤트가 들어왔을 때 최근 이벤트와 충돌하는지 즉시 확인
  const window = [...recentEvents.slice(-50), event];
  const conflicts = detectConflicts(window);
  return conflicts.filter(c => c.events.includes(event.id));
}

module.exports = { detectConflicts, checkNewEvent, SEVERITY };
