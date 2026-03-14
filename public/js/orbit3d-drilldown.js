/* orbit3d-drilldown.js — Drill-down state machine (extracted from render/animate/core) */
'use strict';

// ─── 4단계 드릴다운 상태 ──────────────────────────────────────────────────────
let _drillStage = 0;              // 0=전체, 1=카테고리링, 2=타임라인, 3=파일상세
let _drillProject = null;          // { name, planets[], info }
let _drillCategory = null;         // { catKey, catLabel, catColor, planets[], events[] }
let _drillTimelineEvent = null;    // { fileName, filePath }

// ─── 드릴다운 카테고리 수 기반 자동 피트 ────────────────────────────────────────
// 프로젝트 클릭 시 호출 — 뷰포트 크기 기반 실제 픽셀 맞춤 줌아웃 적용
window.autoFitDrilldown = function(numCats) {
  // 드릴다운 체인의 월드 공간 최대 반경
  // (ME→노드 ~170 + CAT_DIST 200 + 카드 절반 ~60 = 430)
  const WORLD_EXTENT = 430;
  const navW = getNavWidth();
  const W = innerWidth - navW;
  const H = innerHeight;
  // 화면 중심에서 사용 가능한 픽셀 반경 (여백 80px)
  const availPx = Math.min(W / 2, H / 2) - 80;
  // 뷰포트 맞춤 스케일
  const fitScale = Math.max(0.15, Math.min(1.0, availPx / WORLD_EXTENT));
  // numCats 기반 보수적 추가 여유
  const catTarget = numCats <= 2 ? 0.90 :
                    numCats <= 4 ? 0.75 :
                    numCats <= 6 ? 0.65 : 0.55;
  // 둘 중 더 작은 값으로 줌아웃 (화면에 반드시 들어오게)
  const target = Math.min(fitScale, catTarget);
  _animateWorldScale(target, 400);
};

// ─── 4단계 드릴다운 네비게이션 ─────────────────────────────────────────────
function focusProject(projName) {
  _focusedProject = projName;
  _focusedCategory = null;
  _drillStage = 1;
  _drillProject = { name: projName };
  _drillCategory = null;
  _drillTimelineEvent = null;

  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none';

  // 해당 프로젝트의 3D 월드 좌표로 카메라 줌인
  const projPos = window._projWorldPositions?.[projName];
  if (projPos) {
    // 프로젝트 위치를 향해 줌인 (카메라 거리 35, 타겟 = 프로젝트 좌표)
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
  _drillCategory = null;
  _drillTimelineEvent = null;
  closePanel();
  // 원래 전체 뷰로 복귀 (카메라를 원점으로, 넓은 거리로)
  lerpCameraTo(140, 0, 0, 0, 700);
  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none';
}
window.exitConstellationFocus = exitConstellationFocus;

// ── 카테고리 드릴 (2단계 → 3단계: 타임라인 패널) ───────────────────────────
function drillToCategory(catData) {
  _drillStage = 2;
  _drillCategory = catData;
  _focusedCategory = catData.catKey;

  // 해당 카테고리의 모든 이벤트 수집
  const allEvents = [];
  (catData.planets || []).forEach(planet => {
    const entry = _sessionMap[planet.userData.clusterId];
    if (!entry) return;
    for (const e of entry.events) {
      allEvents.push({ ...e, clusterId: planet.userData.clusterId });
    }
  });
  allEvents.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  _drillCategory.events = allEvents;

  // 드릴 프로젝트 위치로 더 가까이 줌인
  const dProjPos = window._projWorldPositions?.[catData.projName];
  if (dProjPos) {
    lerpCameraTo(25, dProjPos.x, 0, dProjPos.z, 500);
  } else {
    lerpCameraTo(35, 0, 0, 0, 500);
  }
  showDrillTimeline(_drillCategory);
}
window.drillToCategory = drillToCategory;

function drillToFileDetail(fileName, filePath) {
  _drillStage = 3;
  _drillTimelineEvent = { fileName, filePath };
  showDrillFileDetail(fileName, filePath);
}
window.drillToFileDetail = drillToFileDetail;

// ── 카테고리 포커스 (동적 프로젝트 타입 - 호환) ─────────────────────────────
function focusCategoryView(catKey) {
  _focusedCategory = catKey;
  _focusedProject  = null;
  const catCfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
  const grp = _categoryGroups[catKey];
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
    _drillCategory = null;
    _drillTimelineEvent = null;
    closePanel();
    // 프로젝트 줌 레벨로 복귀
    const pPos = _drillProject?.name ? window._projWorldPositions?.[_drillProject.name] : null;
    if (pPos) lerpCameraTo(35, pPos.x, 0, pPos.z, 500);
    else lerpCameraTo(45, 0, 0, 0, 500);
  } else {
    lerpCameraTo(140, 0, 0, 0, 700);
  }
}
window.exitCategoryFocus = exitCategoryFocus;

// ═══════════════════════════════════════════════════════════════════════════════
// 3단계: 우측 타임라인 패널 (카테고리 이벤트 시간순)
// ═══════════════════════════════════════════════════════════════════════════════
function showDrillTimeline(catData) {
  const panel = document.getElementById('info-panel');
  panel.classList.add('open');

  // 탭바 숨기고 전체를 타임라인으로 활용
  const tabs = panel.querySelector('.ip-tabs');
  if (tabs) tabs.style.display = 'none';

  // 헤더
  document.getElementById('ip-dot').style.background = catData.catColor || '#58a6ff';
  document.getElementById('ip-type-text').textContent = catData.catIcon ? `${catData.catIcon} ${catData.catLabel}` : catData.catLabel;
  document.getElementById('ip-intent').textContent = `${catData.sessionCount || 0} 세션 · 타임라인`;

  // 팝아웃 버튼 숨기기
  const popBtn = panel.querySelector('.ip-pop-btn');
  if (popBtn) popBtn.style.display = 'none';

  // 본문: 날짜별 그룹핑 타임라인
  const events = catData.events || [];
  const dateGroups = {};
  events.forEach(e => {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    if (!ts) return;
    const dateKey = ts.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
    if (!dateGroups[dateKey]) dateGroups[dateKey] = [];
    dateGroups[dateKey].push(e);
  });

  let html = '<div style="display:flex;flex-direction:column;gap:0;max-height:calc(100vh - 140px);overflow-y:auto;padding:10px 14px 14px">';

  Object.entries(dateGroups).forEach(([dateKey, dayEvents]) => {
    html += `<div style="position:sticky;top:0;z-index:2;background:rgba(255,255,255,0.95);backdrop-filter:blur(4px);padding:8px 0 4px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;margin-bottom:4px">${dateKey}</div>`;

    dayEvents.forEach(e => {
      const cfg = typeCfg(e.type);
      const hex = '#' + new THREE.Color(cfg.color).getHexString();
      const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      const fileName = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/').split('/').pop();
      const filePath = e.data?.filePath || e.data?.fileName || '';

      // ── 이벤트 상세 내용 추출 (타임라인에서 실제 내용 표시) ──
      let d = e.data || {};
      const fc = e.fullContent;
      if (fc && typeof fc === 'string' && fc.startsWith('{')) {
        try { d = { ...d, ...JSON.parse(fc) }; } catch {}
      }
      const t = e.type || '';
      let typeLabel = '';   // 이벤트 종류 (짧은 라벨)
      let detail = '';      // 실제 내용 (명령, 메시지 등)

      if (t === 'user.message') {
        typeLabel = '\u{1F4AC} 사용자 지시';
        detail = d.contentPreview || d.content || '';
      } else if (t === 'assistant.message' || t === 'assistant.response') {
        typeLabel = '\u{1F916} AI 응답';
        detail = d.contentPreview || d.content || '';
      } else if (t === 'tool.end' || t === 'tool.start') {
        const tool = d.toolName || '';
        const TOOLS = { 'Write':'파일 작성', 'Edit':'파일 수정', 'Read':'파일 읽기',
          'Bash':'명령 실행', 'Grep':'코드 검색', 'Glob':'파일 탐색',
          'Task':'에이전트', 'WebFetch':'웹 조회' };
        typeLabel = `\u{1F527} ${TOOLS[tool] || tool}`;
        // 실제 내용: 명령어, 수정 내용, 파일경로 등
        if (tool === 'Bash') {
          detail = d.command || d.input || '';
        } else if (tool === 'Edit') {
          detail = fileName ? `${fileName}` : '';
          if (d.old_string || d.new_string) detail += d.old_string ? ` — "${(d.old_string||'').slice(0,60)}…" → "${(d.new_string||'').slice(0,60)}…"` : '';
        } else if (tool === 'Write') {
          detail = d.filePath || fileName || '';
        } else if (tool === 'Read') {
          detail = d.filePath || fileName || '';
        } else if (tool === 'Grep') {
          detail = d.pattern ? `검색: "${d.pattern}"` : (d.query || '');
        } else {
          detail = d.filePath || d.input || fileName || '';
        }
      } else if (t === 'terminal.command') {
        typeLabel = '\u26A1 터미널';
        detail = d.command || '';
      } else if (t === 'file.write' || t === 'file.create') {
        typeLabel = '\u270F\uFE0F 파일 수정';
        detail = d.filePath || d.fileName || '';
      } else if (t === 'file.read') {
        typeLabel = '\u{1F4C4} 파일 읽기';
        detail = d.filePath || d.fileName || '';
      } else if (t === 'git.commit') {
        typeLabel = '\u{1F4E6} Git 커밋';
        detail = d.message || '';
      } else if (t.startsWith('vscode.')) {
        typeLabel = '\u{1F4BB} VS Code';
        detail = d.fileName || d.filePath || t.replace('vscode.', '');
      } else {
        typeLabel = cfg.icon ? `${cfg.icon} ${e.label || t}` : (e.label || t);
        detail = d.contentPreview || d.content || d.command || '';
      }

      // detail이 비어있으면 extractIntent fallback 또는 label 사용
      if (!detail) {
        detail = (typeof extractIntent === 'function' ? extractIntent(e) : '') || e.label || '';
        // extractIntent가 typeLabel과 같으면 중복 방지
        if (detail === typeLabel || detail === t) detail = '';
      }
      // 상세 내용이 너무 길면 120자로 자르기 (하지만 충분히 보여줌)
      if (detail.length > 120) detail = detail.slice(0, 117) + '…';

      html += `<div class="drill-tl-item" onclick="${filePath ? `drillToFileDetail('${fileName.replace(/'/g, "\\'")}','${filePath.replace(/'/g, "\\'")}')` : ''}" style="display:flex;align-items:flex-start;gap:8px;padding:8px 6px;border-radius:8px;cursor:${filePath ? 'pointer' : 'default'};transition:background .12s;border-left:3px solid ${hex}" onmouseenter="this.style.background='rgba(0,0,0,0.03)'" onmouseleave="this.style.background='transparent'">
        <span style="font-size:12px;flex-shrink:0;margin-top:1px">${cfg.icon || '·'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:#6b7280;font-weight:500;margin-bottom:2px">${escHtml(typeLabel)}</div>
          ${detail ? `<div style="font-size:12px;color:#1a1a2e;line-height:1.4;word-break:break-all;white-space:pre-wrap;max-height:60px;overflow:hidden" title="${escHtml(detail)}">${escHtml(detail)}</div>` : ''}
          ${fileName && !detail.includes(fileName) ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">\u{1F4C4} ${fileName}</div>` : ''}
        </div>
        <div style="font-size:10px;color:#9ca3af;flex-shrink:0;margin-top:2px">${ts}</div>
      </div>`;
    });
  });

  if (events.length === 0) {
    html += '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:12px">이벤트 없음</div>';
  }

  html += '</div>';

  // 탭 콘텐츠 영역 전체를 타임라인으로 교체
  const body = panel.querySelector('.ip-body');
  if (body) {
    body.innerHTML = html;
  }
}
window.showDrillTimeline = showDrillTimeline;

// ═══════════════════════════════════════════════════════════════════════════════
// 4단계: 파일 상세 (해당 파일의 전체 활동 기록)
// ═══════════════════════════════════════════════════════════════════════════════
function showDrillFileDetail(fileName, filePath) {
  const panel = document.getElementById('info-panel');
  panel.classList.add('open');

  const tabs = panel.querySelector('.ip-tabs');
  if (tabs) tabs.style.display = 'none';
  const popBtn = panel.querySelector('.ip-pop-btn');
  if (popBtn) popBtn.style.display = 'none';

  // 헤더
  const role = typeof inferFileRole === 'function' ? inferFileRole(fileName) : '\u{1F4C4}';
  document.getElementById('ip-dot').style.background = '#ffa657';
  document.getElementById('ip-type-text').textContent = role || '\u{1F4C4} 파일';
  document.getElementById('ip-intent').textContent = fileName;

  // 해당 파일의 모든 이벤트 수집
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

  // 뒤로가기 버튼
  html += `<button onclick="if(_drillCategory){_drillStage=2;_drillTimelineEvent=null;showDrillTimeline(_drillCategory)}" style="display:flex;align-items:center;gap:4px;background:none;border:1px solid #e1e4e8;border-radius:6px;padding:6px 10px;font-size:11px;color:#6b7280;cursor:pointer;margin-bottom:8px;font-family:inherit;transition:background .15s" onmouseenter="this.style.background='#f3f4f6'" onmouseleave="this.style.background='transparent'">\u2190 타임라인으로</button>`;

  // 파일 정보 카드
  html += `<div style="background:#f8f9fa;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px">
    <div style="font-size:13px;font-weight:600;color:#1a1a2e">${escHtml(fileName)}</div>
    <div style="font-size:10px;color:#9ca3af;margin-top:2px;word-break:break-all">${escHtml(filePath || '')}</div>
    <div style="display:flex;gap:12px;margin-top:8px">
      <span style="font-size:11px;color:#6b7280">접근 ${fileEvents.length}회</span>
      <span style="font-size:11px;color:#ffa657">수정 ${fileEvents.filter(e => e.type === 'file.write' || (e.type === 'tool.end' && e.data?.toolName === 'Write')).length}회</span>
    </div>
  </div>`;

  // VS Code 열기 버튼
  if (filePath) {
    html += `<button onclick="openFileInEditor('${filePath.replace(/'/g, "\\'")}')" style="display:flex;align-items:center;justify-content:center;gap:4px;width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px;font-size:12px;font-weight:500;cursor:pointer;margin-bottom:10px;font-family:inherit">\u{1F4BB} VS Code에서 열기</button>`;
  }

  // 활동 기록
  html += '<div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:6px">활동 기록</div>';
  fileEvents.slice(0, 50).forEach(e => {
    const cfg = typeCfg(e.type);
    const hex = '#' + new THREE.Color(cfg.color).getHexString();
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = e.timestamp ? new Date(e.timestamp).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) : '';

    // 파일 상세에서도 실제 내용 표시
    let d = e.data || {};
    const fc = e.fullContent;
    if (fc && typeof fc === 'string' && fc.startsWith('{')) {
      try { d = { ...d, ...JSON.parse(fc) }; } catch {}
    }
    const t = e.type || '';
    let typeLabel = '';
    let detail = '';
    if (t === 'user.message') { typeLabel = '\u{1F4AC} 지시'; detail = d.contentPreview || d.content || ''; }
    else if (t === 'assistant.message' || t === 'assistant.response') { typeLabel = '\u{1F916} 응답'; detail = d.contentPreview || d.content || ''; }
    else if (t === 'tool.end' || t === 'tool.start') {
      const tool = d.toolName || '';
      const TOOLS = { 'Write':'작성', 'Edit':'수정', 'Read':'읽기', 'Bash':'실행', 'Grep':'검색', 'Glob':'탐색' };
      typeLabel = `\u{1F527} ${TOOLS[tool] || tool}`;
      if (tool === 'Bash') detail = d.command || d.input || '';
      else if (tool === 'Edit') detail = d.old_string ? `"${(d.old_string||'').slice(0,50)}…"` : '';
      else detail = d.pattern || d.input || '';
    } else if (t === 'terminal.command') { typeLabel = '\u26A1 터미널'; detail = d.command || ''; }
    else if (t === 'git.commit') { typeLabel = '\u{1F4E6} 커밋'; detail = d.message || ''; }
    else { typeLabel = cfg.icon ? `${cfg.icon} ${e.label || t}` : (e.label || t); detail = d.contentPreview || d.command || ''; }
    if (detail.length > 80) detail = detail.slice(0, 77) + '…';

    html += `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-left:3px solid ${hex}">
      <span style="font-size:11px;flex-shrink:0;margin-top:1px">${cfg.icon || '·'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;color:#6b7280;font-weight:500">${escHtml(typeLabel)}</div>
        ${detail ? `<div style="font-size:11px;color:#374151;line-height:1.3;word-break:break-all;max-height:40px;overflow:hidden;margin-top:1px">${escHtml(detail)}</div>` : ''}
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
