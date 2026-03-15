/* orbit3d-drilldown.js — Drill-down state machine + 요약 대시보드
 * 계층: 프로젝트 → 세션 → 🎯목적블록 → 이벤트
 */
'use strict';

// ─── 3단계 드릴다운 상태 ──────────────────────────────────────────────────────
let _drillStage = 0;              // 0=전체, 1=세션링, 2=세션대시보드, 3=전체타임라인
let _drillProject = null;          // { name }
let _drillCategory = null;         // 호환용 (null 유지)
let _drillSession = null;          // { sessionId, events[], planet }
let _drillTimelineEvent = null;    // { fileName, filePath }

// ─── 드릴다운 자동 피트 (프로젝트 클릭 시) ──────────────────────────────────────
window.autoFitDrilldown = function(numSessions) {
  const WORLD_EXTENT = 430;
  const navW = getNavWidth();
  const W = innerWidth - navW;
  const H = innerHeight;
  const availPx = Math.min(W / 2, H / 2) - 80;
  const fitScale = Math.max(0.15, Math.min(1.0, availPx / WORLD_EXTENT));
  const sesTarget = numSessions <= 3 ? 0.90 :
                    numSessions <= 6 ? 0.75 :
                    numSessions <= 10 ? 0.65 : 0.55;
  const target = Math.min(fitScale, sesTarget);
  _animateWorldScale(target, 400);
};

// ─── 프로젝트 포커스 (1단계: 세션 표시) ──────────────────────────────────────
function focusProject(projName) {
  _focusedProject = projName;
  _focusedCategory = null;
  _drillStage = 1;
  _drillProject = { name: projName };
  _drillSession = null;
  _drillCategory = null;
  _drillTimelineEvent = null;

  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none';

  const projPos = window._projWorldPositions?.[projName];
  if (projPos) {
    lerpCameraTo(35, projPos.x, 0, projPos.z, 700);
  } else {
    lerpCameraTo(45, 0, 0, 0, 700);
  }
}
window.focusProject = focusProject;

function exitConstellationFocus() {
  _focusedProject = null;
  _drillStage = 0;
  _drillProject = null;
  _drillSession = null;
  _drillCategory = null;
  _drillTimelineEvent = null;
  closePanel();
  lerpCameraTo(100, 0, 0, 0, 700);
  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none';
}
window.exitConstellationFocus = exitConstellationFocus;

// ── 세션 드릴 (1단계 → 2단계: 요약 대시보드) ─────────────────────────────────
function drillToSession(sessionData) {
  _drillStage = 2;
  const sessionId = sessionData.clusterId || sessionData.sessionId;
  const entry = _sessionMap[sessionId];
  const events = entry?.events || [];
  events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  _drillSession = {
    sessionId,
    events,
    planet: sessionData.planet || null,
    intent: sessionData.intent || '',
    hueHex: sessionData.hueHex || '#58a6ff',
    projName: sessionData.projName || '',
  };
  _drillCategory = null; // 호환

  const dProjPos = window._projWorldPositions?.[sessionData.projName];
  if (dProjPos) {
    lerpCameraTo(25, dProjPos.x, 0, dProjPos.z, 500);
  } else {
    lerpCameraTo(35, 0, 0, 0, 500);
  }
  showSessionDashboard(_drillSession);
}
window.drillToSession = drillToSession;

// 호환: drillToCategory → drillToSession 리다이렉트
function drillToCategory(catData) {
  const sessionData = {
    clusterId: catData.planets?.[0]?.userData?.clusterId,
    sessionId: catData.planets?.[0]?.userData?.sessionId,
    intent: catData.catLabel,
    hueHex: catData.catColor,
    projName: catData.projName,
    planet: catData.planets?.[0],
  };
  drillToSession(sessionData);
}
window.drillToCategory = drillToCategory;

function drillToFileDetail(fileName, filePath) {
  _drillStage = 3;
  _drillTimelineEvent = { fileName, filePath };
  showDrillFileDetail(fileName, filePath);
}
window.drillToFileDetail = drillToFileDetail;

// ── 카테고리 포커스 (호환) ──────────────────────────────────────────────────
function focusCategoryView(catKey) {
  _focusedCategory = catKey;
  _focusedProject  = null;
  const catCfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
  const grp = _categoryGroups?.[catKey];
  if (!grp || grp.planets.length === 0) return;
  let tx = 0, tz = 0;
  grp.planets.forEach(p => { tx += p.position.x; tz += p.position.z; });
  tx /= grp.planets.length; tz /= grp.planets.length;
  lerpCameraTo(35, tx, 0, tz, 700);
}
window.focusCategoryView = focusCategoryView;

function exitCategoryFocus() {
  _focusedCategory = null;
  if (_drillStage >= 2) {
    _drillStage = 1;
    _drillSession = null;
    _drillCategory = null;
    _drillTimelineEvent = null;
    closePanel();
    const pPos = _drillProject?.name ? window._projWorldPositions?.[_drillProject.name] : null;
    if (pPos) lerpCameraTo(35, pPos.x, 0, pPos.z, 500);
    else lerpCameraTo(45, 0, 0, 0, 500);
  } else {
    lerpCameraTo(100, 0, 0, 0, 700);
  }
}
window.exitCategoryFocus = exitCategoryFocus;

// ═══════════════════════════════════════════════════════════════════════════════
// 이벤트 유틸: fullContent에서 파일 정보 추출, 중복 제거
// ═══════════════════════════════════════════════════════════════════════════════
function _extractEventMeta(e) {
  // fullContent가 JSON이면 파싱해서 파일 정보 추출
  const fc = e.fullContent || '';
  let filePath = '', fileName = '', toolName = '', error = '', exitCode = 0;
  if (fc && typeof fc === 'string' && fc.startsWith('{')) {
    try {
      const parsed = JSON.parse(fc);
      filePath = parsed.filePath || '';
      fileName = parsed.fileName || '';
      toolName = parsed.toolName || '';
      error = parsed.error || '';
      exitCode = parsed.exitCode || 0;
    } catch {}
  }
  // tool.end의 label에서 toolName 추출
  if (!toolName && e.type === 'tool.end') {
    toolName = (e.label || '').replace(/^[🔧🔍📄✏️📦⚡💻\s]+/, '').trim();
  }
  // file.write/read의 label에서 fileName 추출
  if (!fileName && (e.type === 'file.write' || e.type === 'file.read')) {
    fileName = (e.label || '').replace(/^[✏️📄\s]+/, '').replace(/\.\.\.$/, '').trim();
  }
  return { filePath, fileName, toolName, error, exitCode };
}

function _deduplicateEvents(events) {
  if (!events || events.length === 0) return [];
  const seen = new Set();
  return events.filter(e => {
    // 같은 타임스탬프(100ms 이내) + 같은 타입 + 같은 label → 중복
    const ts = e.timestamp ? Math.floor(new Date(e.timestamp).getTime() / 200) : 0;
    const key = `${ts}|${e.type}|${(e.label || '').slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 목적블록 클러스터링 (user.message 경계 + 15분 갭)
// ═══════════════════════════════════════════════════════════════════════════════
function _clusterIntoPurposeBlocks(events) {
  if (!events || events.length === 0) return [];

  // 1) 중복 제거
  const deduped = _deduplicateEvents(events);
  if (deduped.length === 0) return [];

  const blocks = [];
  let current = null;
  const GAP_MS = 15 * 60 * 1000; // 15분

  for (const e of deduped) {
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
    const isUserMsg = e.type === 'user.message';

    // 새 블록 시작 조건: user.message이거나 15분 이상 갭
    if (isUserMsg || !current || (ts - current.lastTs > GAP_MS)) {
      if (current) blocks.push(current);
      // user.message의 내용을 블록 제목으로 (label 또는 fullContent 사용)
      const title = isUserMsg
        ? ((e.fullContent || e.label || '').replace(/[\n\r]/g, ' ').trim().slice(0, 80) || '사용자 지시')
        : '(연속 작업)';
      current = {
        title,
        startTs: ts,
        lastTs: ts,
        events: [e],
        files: new Set(),
        errors: [],
        hasUserMsg: isUserMsg,
      };
    } else {
      current.events.push(e);
      current.lastTs = ts;
    }

    // 파일 추적: fullContent JSON에서 또는 label에서 추출
    const meta = _extractEventMeta(e);
    const fp = meta.filePath || meta.fileName;
    if (fp) current.files.add(fp.split(/[\\/]/).pop());

    // 에러 감지
    if (meta.error || meta.exitCode > 0) {
      current.errors.push({
        type: e.type,
        error: meta.error || `exit code ${meta.exitCode}`,
        tool: meta.toolName || '',
      });
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 이슈 분석 + 지시 개선 제안
// ═══════════════════════════════════════════════════════════════════════════════
function _analyzeIssues(blocks, events) {
  const issues = [];
  const suggestions = [];

  // 1. 에러 패턴 분석
  let totalErrors = 0;
  const errorTools = {};
  blocks.forEach(b => {
    b.errors.forEach(err => {
      totalErrors++;
      const tool = err.tool || 'unknown';
      errorTools[tool] = (errorTools[tool] || 0) + 1;
    });
  });

  if (totalErrors > 0) {
    const topTool = Object.entries(errorTools).sort((a, b) => b[1] - a[1])[0];
    issues.push({
      icon: '⚠️',
      label: `총 ${totalErrors}개 오류 발생`,
      detail: topTool ? `${topTool[0]} 도구에서 ${topTool[1]}회 오류` : '',
    });
    if (topTool && topTool[0] === 'Bash') {
      suggestions.push('명령어 실행 전 경로/권한 확인 지시를 추가하면 오류를 줄일 수 있습니다');
    }
    if (topTool && topTool[0] === 'Edit') {
      suggestions.push('수정 대상 파일을 먼저 읽도록 지시하면 편집 충돌을 예방할 수 있습니다');
    }
  }

  // 2. 재시도 패턴 감지
  let retryCount = 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.type === curr.type && prev.type?.startsWith('tool.') &&
        (prev.label || '') === (curr.label || '')) {
      retryCount++;
    }
  }
  if (retryCount > 2) {
    issues.push({
      icon: '🔄',
      label: `${retryCount}회 동일 작업 재시도 감지`,
      detail: '같은 파일/명령이 반복 실행됨',
    });
    suggestions.push('작업 전 요구사항을 더 구체적으로 명시하면 재시도를 줄일 수 있습니다');
  }

  // 3. 긴 세션 감지
  if (events.length > 0) {
    const firstTs = new Date(events[0].timestamp || 0).getTime();
    const lastTs = new Date(events[events.length - 1].timestamp || 0).getTime();
    const durationMin = Math.round((lastTs - firstTs) / 60000);
    if (durationMin > 60 && blocks.length > 5) {
      issues.push({
        icon: '⏱️',
        label: `장시간 세션 (${durationMin}분)`,
        detail: `${blocks.length}개 목적블록으로 분산됨`,
      });
      suggestions.push('목적별로 세션을 나누면 작업 효율과 추적이 향상됩니다');
    }
  }

  // 4. 지시 없는 작업 감지
  const noMsgBlocks = blocks.filter(b => !b.hasUserMsg);
  if (noMsgBlocks.length > blocks.length * 0.3 && blocks.length > 2) {
    issues.push({
      icon: '💬',
      label: `${noMsgBlocks.length}개 블록에 명시적 지시 없음`,
      detail: 'AI가 자율적으로 진행한 작업 구간',
    });
    suggestions.push('각 작업 단계마다 구체적 지시를 하면 결과 예측이 쉬워집니다');
  }

  // 기본 제안
  if (suggestions.length === 0 && totalErrors === 0) {
    suggestions.push('이 세션은 이슈 없이 원활하게 진행되었습니다 ✅');
  }

  return { issues, suggestions };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2단계: 세션 요약 대시보드 (목적블록 기반)
// ═══════════════════════════════════════════════════════════════════════════════
function showSessionDashboard(sesData) {
  const panel = document.getElementById('info-panel');
  panel.classList.add('open');

  const tabs = panel.querySelector('.ip-tabs');
  if (tabs) tabs.style.display = 'none';
  const popBtn = panel.querySelector('.ip-pop-btn');
  if (popBtn) popBtn.style.display = 'none';

  const events = sesData.events || [];
  const color = sesData.hueHex || '#58a6ff';

  // 헤더
  const _ipDot = document.getElementById('ip-dot');
  const _ipType = document.getElementById('ip-type-text');
  const _ipIntent = document.getElementById('ip-intent');
  if (_ipDot) _ipDot.style.background = color;
  if (_ipType) _ipType.textContent = '📋 세션 대시보드';
  if (_ipIntent) _ipIntent.textContent = sesData.intent ? (sesData.intent.length > 30 ? sesData.intent.slice(0, 29) + '…' : sesData.intent) : '세션 분석';

  // ── 중복 제거 후 목적블록 클러스터링 ──
  const deduped = _deduplicateEvents(events);
  const blocks = _clusterIntoPurposeBlocks(events);

  // ── 통계 계산 ── (중복 제거된 데이터 기반)
  const firstTs = deduped.length > 0 ? new Date(deduped[0].timestamp || 0) : null;
  const lastTs = deduped.length > 0 ? new Date(deduped[deduped.length - 1].timestamp || 0) : null;
  const durationMin = firstTs && lastTs ? Math.round((lastTs - firstTs) / 60000) : 0;
  const allFiles = new Set();
  let editCount = 0;
  deduped.forEach(e => {
    const meta = _extractEventMeta(e);
    const fp = meta.filePath || meta.fileName;
    if (fp) allFiles.add(fp.split(/[\\/]/).pop());
    if (e.type === 'file.write' || e.type === 'file.create') editCount++;
    if (e.type === 'tool.end' && (meta.toolName === 'Write' || meta.toolName === 'Edit')) editCount++;
  });

  // ── 이슈 분석 ── (중복 제거된 데이터 기반)
  const analysis = _analyzeIssues(blocks, deduped);

  // ── HTML 생성 ──
  let html = '<div style="display:flex;flex-direction:column;gap:0;max-height:calc(100vh - 140px);overflow-y:auto;padding:10px 14px 14px">';

  // 브레드크럼 내비게이션 (전체 > 프로젝트 > 세션)
  const bcProjName = (sesData.projName || '프로젝트').slice(0, 18);
  html += `<div style="display:flex;align-items:center;gap:0;margin-bottom:10px;font-size:11px;flex-wrap:wrap">
    <span onclick="exitConstellationFocus()" style="color:#6b7280;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#f3f4f6'" onmouseleave="this.style.background='transparent'">전체</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span onclick="exitCategoryFocus()" style="color:#3b82f6;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#eff6ff'" onmouseleave="this.style.background='transparent'">${escHtml(bcProjName)}</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span style="color:#1f2937;font-weight:600;padding:3px 6px">세션</span>
  </div>`;

  // ━━ Stats Row ━━
  const durationLabel = durationMin < 60 ? `${durationMin}분` : `${Math.floor(durationMin / 60)}시간 ${durationMin % 60}분`;
  html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px">
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 6px;text-align:center">
      <div style="font-size:16px;font-weight:700;color:#0369a1">${durationLabel}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:2px">소요 시간</div>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 6px;text-align:center">
      <div style="font-size:16px;font-weight:700;color:#15803d">${allFiles.size}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:2px">파일</div>
    </div>
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:8px 6px;text-align:center">
      <div style="font-size:16px;font-weight:700;color:#a16207">${editCount}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:2px">수정</div>
    </div>
    <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:8px 6px;text-align:center">
      <div style="font-size:16px;font-weight:700;color:#7e22ce">${blocks.length}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:2px">목적블록</div>
    </div>
  </div>`;

  // ━━ 이슈 감지 섹션 ━━
  if (analysis.issues.length > 0) {
    html += `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:#dc2626;margin-bottom:6px">⚠️ 감지된 이슈</div>`;
    analysis.issues.forEach(iss => {
      html += `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">
        <span style="font-size:13px;flex-shrink:0">${iss.icon}</span>
        <div>
          <div style="font-size:11px;color:#991b1b;font-weight:500">${escHtml(iss.label)}</div>
          ${iss.detail ? `<div style="font-size:10px;color:#b91c1c;opacity:0.8">${escHtml(iss.detail)}</div>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  }

  // ━━ 지시 개선 제안 ━━
  html += `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px 12px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:600;color:#1d4ed8;margin-bottom:6px">💡 지시 개선 제안</div>`;
  analysis.suggestions.forEach(sug => {
    html += `<div style="font-size:11px;color:#1e40af;line-height:1.5;margin-bottom:3px;padding-left:10px;border-left:2px solid #93c5fd">
      ${escHtml(sug)}
    </div>`;
  });
  html += '</div>';

  // ━━ 🎯 목적블록 목록 ━━
  html += `<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px">🎯 작업 흐름 (${blocks.length}개 목적블록)</div>`;

  blocks.forEach((block, bi) => {
    const blockTime = block.startTs ? new Date(block.startTs).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    const blockFiles = [...block.files].slice(0, 3);
    const evCount = block.events.length;
    const hasError = block.errors.length > 0;
    const borderColor = hasError ? '#fca5a5' : '#e5e7eb';
    const bgColor = hasError ? '#fef2f240' : '#ffffff';

    // 블록 제목 자르기
    const blockTitle = block.title.length > 50 ? block.title.slice(0, 47) + '…' : block.title;

    html += `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:10px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
        <div style="font-size:11px;font-weight:600;color:#1f2937;line-height:1.4;flex:1;min-width:0">${block.hasUserMsg ? '💬' : '⚙️'} ${escHtml(blockTitle)}</div>
        <div style="font-size:9px;color:#9ca3af;flex-shrink:0;margin-left:8px">${blockTime}</div>
      </div>`;

    // 파일 변경
    if (blockFiles.length > 0) {
      html += `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">`;
      blockFiles.forEach(f => {
        html += `<span style="font-size:9px;background:#f3f4f6;color:#4b5563;padding:1px 6px;border-radius:4px">📄 ${escHtml(f)}</span>`;
      });
      if (block.files.size > 3) {
        html += `<span style="font-size:9px;color:#9ca3af">+${block.files.size - 3}</span>`;
      }
      html += '</div>';
    }

    // 핵심 대화 (user.message + assistant 첫 줄)
    const keyConvos = block.events.filter(e =>
      e.type === 'user.message' || e.type === 'assistant.message' || e.type === 'assistant.response'
    ).slice(0, 2);
    keyConvos.forEach(e => {
      const content = (e.fullContent || e.label || '').replace(/[\n\r]/g, ' ').trim();
      if (!content) return;
      const isUser = e.type === 'user.message';
      const snippet = content.length > 60 ? content.slice(0, 57) + '…' : content;
      html += `<div style="font-size:10px;color:${isUser ? '#1e40af' : '#059669'};line-height:1.3;margin-top:2px;padding-left:8px;border-left:2px solid ${isUser ? '#93c5fd' : '#6ee7b7'}">
        ${isUser ? '👤' : '🤖'} ${escHtml(snippet)}
      </div>`;
    });

    // 에러 표시
    if (hasError) {
      html += `<div style="font-size:10px;color:#dc2626;margin-top:4px">⚠ ${block.errors.length}개 오류 발생</div>`;
    }

    // 이벤트 수 요약
    html += `<div style="font-size:9px;color:#9ca3af;margin-top:4px">${evCount}개 이벤트 · ${block.files.size}개 파일</div>`;
    html += '</div>';
  });

  // ━━ 전체 타임라인 보기 버튼 ━━
  html += `<button onclick="_showFullTimeline()" style="display:flex;align-items:center;justify-content:center;gap:4px;width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:12px;font-weight:500;color:#475569;cursor:pointer;margin-top:4px;font-family:inherit;transition:background .15s" onmouseenter="this.style.background='#f1f5f9'" onmouseleave="this.style.background='#f8fafc'">📜 전체 타임라인 보기 (${events.length}개 이벤트)</button>`;

  html += '</div>';

  const body = panel.querySelector('.ip-body');
  if (body) body.innerHTML = html;
}
window.showSessionDashboard = showSessionDashboard;

// 호환: showDrillTimeline → showSessionDashboard 리다이렉트
function showDrillTimeline(catData) {
  // 기존 코드 호환 — catData에서 세션 데이터 추출
  const sesData = {
    sessionId: catData.planets?.[0]?.userData?.clusterId || catData.catKey || 'unknown',
    events: catData.events || [],
    intent: catData.catLabel || '',
    hueHex: catData.catColor || '#58a6ff',
    projName: catData.projName || '',
  };
  showSessionDashboard(sesData);
}
window.showDrillTimeline = showDrillTimeline;

// ━━ 전체 타임라인 (접이식) ━━
function _showFullTimeline() {
  const sesData = _drillSession;
  if (!sesData) return;
  const events = sesData.events || [];
  const panel = document.getElementById('info-panel');
  const body = panel.querySelector('.ip-body');
  if (!body) return;

  let html = '<div style="display:flex;flex-direction:column;gap:0;max-height:calc(100vh - 140px);overflow-y:auto;padding:10px 14px 14px">';

  // 브레드크럼 내비게이션 (전체 > 프로젝트 > 세션 > 타임라인)
  const tlProjName = (sesData.projName || '프로젝트').slice(0, 16);
  html += `<div style="display:flex;align-items:center;gap:0;margin-bottom:10px;font-size:11px;flex-wrap:wrap">
    <span onclick="exitConstellationFocus()" style="color:#6b7280;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#f3f4f6'" onmouseleave="this.style.background='transparent'">전체</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span onclick="exitCategoryFocus()" style="color:#3b82f6;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#eff6ff'" onmouseleave="this.style.background='transparent'">${escHtml(tlProjName)}</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span onclick="showSessionDashboard(_drillSession)" style="color:#3b82f6;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#eff6ff'" onmouseleave="this.style.background='transparent'">세션</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span style="color:#1f2937;font-weight:600;padding:3px 6px">타임라인</span>
  </div>`;

  // 중복 제거
  const deduped = _deduplicateEvents(events);
  html += `<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px">📜 전체 타임라인 (${deduped.length}개)</div>`;

  // 날짜별 그룹핑
  const dateGroups = {};
  deduped.forEach(e => {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    if (!ts) return;
    const dateKey = ts.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
    if (!dateGroups[dateKey]) dateGroups[dateKey] = [];
    dateGroups[dateKey].push(e);
  });

  Object.entries(dateGroups).forEach(([dateKey, dayEvents]) => {
    html += `<div style="position:sticky;top:0;z-index:2;background:rgba(255,255,255,0.95);backdrop-filter:blur(4px);padding:8px 0 4px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;margin-bottom:4px">${dateKey}</div>`;

    dayEvents.forEach(e => {
      const parsed = _parseEventForDisplay(e);
      const meta = _extractEventMeta(e);
      const cfg = typeof typeCfg === 'function' ? typeCfg(e.type) : {};
      const hex = cfg.color ? '#' + new THREE.Color(cfg.color).getHexString() : '#6b7280';
      const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      const fileName = parsed.fileName || meta.fileName || '';
      const filePath = meta.filePath || '';

      html += `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 6px;border-radius:8px;cursor:${filePath ? 'pointer' : 'default'};transition:background .12s;border-left:3px solid ${hex}" ${filePath ? `onclick="drillToFileDetail('${fileName.replace(/'/g, "\\'")}','${filePath.replace(/'/g, "\\'")}')"` : ''} onmouseenter="this.style.background='rgba(0,0,0,0.03)'" onmouseleave="this.style.background='transparent'">
        <span style="font-size:12px;flex-shrink:0;margin-top:1px">${cfg.icon || '·'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:#6b7280;font-weight:500;margin-bottom:2px">${escHtml(parsed.typeLabel)}</div>
          ${parsed.detail ? `<div style="font-size:12px;color:#1a1a2e;line-height:1.4;word-break:break-all;white-space:pre-wrap;max-height:60px;overflow:hidden" title="${escHtml(parsed.detail)}">${escHtml(parsed.detail)}</div>` : ''}
          ${fileName && !parsed.detail.includes(fileName) ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">📄 ${fileName}</div>` : ''}
        </div>
        <div style="font-size:10px;color:#9ca3af;flex-shrink:0;margin-top:2px">${ts}</div>
      </div>`;
    });
  });

  if (events.length === 0) {
    html += '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:12px">이벤트 없음</div>';
  }

  html += '</div>';
  body.innerHTML = html;
}
window._showFullTimeline = _showFullTimeline;

// ── 이벤트 표시 파서 (공통) ──────────────────────────────────────────────────
// 실제 데이터 구조: data={}, label=짧은 텍스트, fullContent=전체 내용
function _parseEventForDisplay(e) {
  const t = e.type || '';
  const meta = _extractEventMeta(e);
  const fc = e.fullContent || '';
  const label = e.label || '';
  let typeLabel = '';
  let detail = '';

  if (t === 'user.message') {
    typeLabel = '💬 사용자 지시';
    detail = fc || label || '';
  } else if (t === 'assistant.message' || t === 'assistant.response') {
    typeLabel = '🤖 AI 응답';
    detail = fc || label || '';
  } else if (t === 'tool.end' || t === 'tool.start') {
    const tool = meta.toolName || label || '';
    const TOOLS = { 'Write':'파일 작성', 'Edit':'파일 수정', 'Read':'파일 읽기',
      'Bash':'명령 실행', 'Grep':'코드 검색', 'Glob':'파일 탐색',
      'Task':'에이전트', 'WebFetch':'웹 조회', 'ToolSearch':'도구 검색',
      '웹 검색':'웹 검색' };
    typeLabel = `🔧 ${TOOLS[tool] || tool}`;
    // fullContent에 검색어 등 상세 내용이 있으면 사용
    if (fc && !fc.startsWith('{')) detail = fc;
    else if (meta.filePath) detail = meta.filePath;
    else detail = '';
  } else if (t === 'terminal.command') {
    typeLabel = '⚡ 터미널';
    detail = fc || label || '';
  } else if (t === 'file.write' || t === 'file.create') {
    typeLabel = '✏️ 파일 수정';
    detail = meta.filePath || meta.fileName || label.replace(/^[✏️📄\s]+/, '') || '';
  } else if (t === 'file.read' || t === 'file') {
    typeLabel = '📄 파일 읽기';
    detail = meta.filePath || meta.fileName || label.replace(/^[📄\s]+/, '') || '';
  } else if (t === 'git.commit') {
    typeLabel = '📦 Git 커밋';
    detail = fc || label || '';
  } else if (t.startsWith('vscode.')) {
    typeLabel = '💻 VS Code';
    detail = meta.fileName || label || '';
  } else if (t === 'notification') {
    typeLabel = '🔔 알림';
    detail = fc || label || '';
  } else if (t === 'session.start') {
    typeLabel = '▶️ 세션 시작';
    detail = label || '';
  } else if (t === 'subagent.start') {
    typeLabel = '🤖 서브에이전트';
    detail = fc || label || '';
  } else if (t === 'idle') {
    typeLabel = '💤 대기';
    detail = '';
  } else {
    const cfg = typeof typeCfg === 'function' ? typeCfg(t) : {};
    typeLabel = cfg.icon ? `${cfg.icon} ${label || t}` : (label || t);
    detail = fc || '';
  }

  if (!detail && label && label !== typeLabel) {
    detail = label;
  }
  if (detail.length > 120) detail = detail.slice(0, 117) + '…';

  return { typeLabel, detail, fileName: meta.fileName || meta.filePath?.split(/[\\/]/).pop() || '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3단계: 파일 상세 (해당 파일의 전체 활동 기록)
// ═══════════════════════════════════════════════════════════════════════════════
function showDrillFileDetail(fileName, filePath) {
  const panel = document.getElementById('info-panel');
  panel.classList.add('open');

  const tabs = panel.querySelector('.ip-tabs');
  if (tabs) tabs.style.display = 'none';
  const popBtn = panel.querySelector('.ip-pop-btn');
  if (popBtn) popBtn.style.display = 'none';

  const role = typeof inferFileRole === 'function' ? inferFileRole(fileName) : '📄';
  document.getElementById('ip-dot').style.background = '#ffa657';
  document.getElementById('ip-type-text').textContent = role || '📄 파일';
  document.getElementById('ip-intent').textContent = fileName;

  const fileEvents = [];
  for (const [clusterId, entry] of Object.entries(_sessionMap || {})) {
    if (!entry?.events) continue;
    for (const e of entry.events) {
      const fp = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/');
      const fn = fp.split('/').pop();
      if (fn === fileName || fp === filePath) {
        fileEvents.push({ ...e, clusterId });
      }
    }
  }
  fileEvents.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  let html = '<div style="display:flex;flex-direction:column;gap:0;max-height:calc(100vh - 140px);overflow-y:auto;padding:10px 14px 14px">';

  // 브레드크럼 내비게이션 (전체 > 프로젝트 > 세션 > 파일)
  const fdProjName = (_drillSession?.projName || '프로젝트').slice(0, 14);
  html += `<div style="display:flex;align-items:center;gap:0;margin-bottom:10px;font-size:11px;flex-wrap:wrap">
    <span onclick="exitConstellationFocus()" style="color:#6b7280;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#f3f4f6'" onmouseleave="this.style.background='transparent'">전체</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span onclick="exitCategoryFocus()" style="color:#3b82f6;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#eff6ff'" onmouseleave="this.style.background='transparent'">${escHtml(fdProjName)}</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span onclick="if(_drillSession){_drillStage=2;_drillTimelineEvent=null;showSessionDashboard(_drillSession)}" style="color:#3b82f6;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background .12s" onmouseenter="this.style.background='#eff6ff'" onmouseleave="this.style.background='transparent'">세션</span>
    <span style="color:#d1d5db;margin:0 2px">›</span>
    <span style="color:#1f2937;font-weight:600;padding:3px 6px">${escHtml(fileName.slice(0, 20))}</span>
  </div>`;

  // 파일 정보 카드
  html += `<div style="background:#f8f9fa;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px">
    <div style="font-size:13px;font-weight:600;color:#1a1a2e">${escHtml(fileName)}</div>
    <div style="font-size:10px;color:#9ca3af;margin-top:2px;word-break:break-all">${escHtml(filePath || '')}</div>
    <div style="display:flex;gap:12px;margin-top:8px">
      <span style="font-size:11px;color:#6b7280">접근 ${fileEvents.length}회</span>
      <span style="font-size:11px;color:#ffa657">수정 ${fileEvents.filter(e => e.type === 'file.write' || (e.type === 'tool.end' && e.data?.toolName === 'Write')).length}회</span>
    </div>
  </div>`;

  if (filePath) {
    html += `<button onclick="openFileInEditor('${filePath.replace(/'/g, "\\'")}')" style="display:flex;align-items:center;justify-content:center;gap:4px;width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px;font-size:12px;font-weight:500;cursor:pointer;margin-bottom:10px;font-family:inherit">💻 VS Code에서 열기</button>`;
  }

  html += '<div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:6px">활동 기록</div>';
  fileEvents.slice(0, 50).forEach(e => {
    const parsed = _parseEventForDisplay(e);
    const cfg = typeCfg(e.type);
    const hex = '#' + new THREE.Color(cfg.color).getHexString();
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = e.timestamp ? new Date(e.timestamp).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) : '';

    html += `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-left:3px solid ${hex}">
      <span style="font-size:11px;flex-shrink:0;margin-top:1px">${cfg.icon || '·'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;color:#6b7280;font-weight:500">${escHtml(parsed.typeLabel)}</div>
        ${parsed.detail ? `<div style="font-size:11px;color:#374151;line-height:1.3;word-break:break-all;max-height:40px;overflow:hidden;margin-top:1px">${escHtml(parsed.detail)}</div>` : ''}
      </div>
      <div style="font-size:10px;color:#9ca3af;flex-shrink:0;white-space:nowrap">${dateStr} ${ts}</div>
    </div>`;
  });

  if (fileEvents.length === 0) {
    html += '<div style="padding:16px;text-align:center;color:#9ca3af;font-size:12px">활동 기록 없음</div>';
  }

  html += '</div>';
  const body = panel.querySelector('.ip-body');
  if (body) body.innerHTML = html;
}
window.showDrillFileDetail = showDrillFileDetail;
