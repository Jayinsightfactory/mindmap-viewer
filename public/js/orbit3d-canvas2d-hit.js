/* orbit3d-canvas2d-hit.js — 2D Canvas hit-test layer (extracted from render/animate) */

// ─── 2D 히트 영역 상태 ───────────────────────────────────────────────────────
let _hitAreas    = []; // { cx, cy, r, data, obj }
let _hoveredHit  = null;  // { cx, cy, r, data, obj }
let _selectedHit = null;

// ─── 히트 영역 관리 ──────────────────────────────────────────────────────────

/** 히트 영역 배열 초기화 (매 프레임 drawLabels 시작 시 호출) */
function clearHitAreas() {
  _hitAreas = [];
}

/** 히트 영역 등록 — _hitAreas.push 래퍼 */
function registerHitArea(hit) {
  _hitAreas.push(hit);
}

// ─── 2D 캔버스 히트 테스트 ───────────────────────────────────────────────────

/**
 * clientX/clientY 로부터 가장 가까운 히트 영역을 찾아 반환
 * @param {number} clientX
 * @param {number} clientY
 * @returns {object|null} 히트된 영역 객체 또는 null
 */
function hitTest(clientX, clientY) {
  // _labelCanvas2d 기준 로컬 좌표로 변환 (사이드바 오프셋 보정)
  const rect = _labelCanvas2d.getBoundingClientRect();
  const mx   = clientX - rect.left;
  const my   = clientY - rect.top;
  // 가장 가까운 히트 영역 반환 (겹침 시 클릭 위치에 중심이 가장 가까운 노드 선택)
  // drawCompactProjectView에서 드릴 노드를 배열 끝에 정렬해 두므로,
  // 동점일 경우 역순 우선순위(드릴 노드 우선)가 자연스럽게 적용됨
  let bestHit = null;
  let bestDist2 = Infinity;
  for (let i = _hitAreas.length - 1; i >= 0; i--) {
    const h = _hitAreas[i];
    const dx = mx - h.cx, dy = my - h.cy;
    const d2 = dx*dx + dy*dy;
    if (d2 <= h.r*h.r && d2 < bestDist2) {
      bestHit  = h;
      bestDist2 = d2;
    }
  }
  return bestHit;
}

// ─── 레이캐스트 업데이트 (매 프레임 호출) ────────────────────────────────────

function updateRaycast() {
  const tooltip = document.getElementById('tooltip');
  const hit = hitTest(_lastMouseEvent.clientX, _lastMouseEvent.clientY);

  if (hit) {
    if (hit !== _hoveredHit) {
      _hoveredHit = hit;
      renderer.domElement.style.cursor = 'pointer';
    }
    const data = hit.data;
    if (data) {
      let ttIntent = data.label || data.intent || '';
      let ttMeta   = '';
      if (data.type === 'activeFile') {
        ttIntent = `📂 ${data.fileName || ''}`;
        ttMeta = '클릭하여 VS Code에서 열기';
      }
      else if (data.type === 'member')  ttMeta = `👤 ${data.sublabel || ''} · 클릭하여 포커스`;
      else if (data.type === 'task')  ttMeta = `${data.emoji || ''} ${Math.round((data.progress||0)*100)}% 완료`;
      else if (data.type === 'goal')  ttMeta = '🎯 팀 목표';
      else if (data.type === 'file')  ttMeta = `📄 ${data.filename || ''}  ×${data.count || 1}`;
      else ttMeta = data.eventCount ? `세션 • ${data.eventCount}개 작업` : '세션';
      document.getElementById('tt-intent').textContent = ttIntent;
      document.getElementById('tt-meta').textContent   = ttMeta;
      tooltip.style.display = 'block';
      tooltip.style.left = (_lastMouseEvent.clientX + 14) + 'px';
      tooltip.style.top  = (_lastMouseEvent.clientY - 10) + 'px';
      // 편집 아이콘: 레이블 우측에 표시 (편집 중이 아닐 때)
      // 편집 아이콘: constellation 노드는 canvas 내부 버튼으로 처리 — 그 외 노드만 div 아이콘 표시
      if (!_editingNode && (data.label || data.intent || data.projName || data.catLabel) && data.type !== 'constellation') {
        _editIconEl.style.display = 'block';
        // 카드 내부 우측 상단에 배치 — 실제 카드 크기(pw/ph) 반영
        const _s = window._worldScale || 1.0;
        const _cW = hit.pw || UNI_CARD_W;
        const _cH = hit.ph || UNI_CARD_H;
        _editIconEl.style.left = (hit.cx + (_cW / 2 - 26) * _s) + 'px';
        _editIconEl.style.top  = (hit.cy + (-_cH / 2 + 4) * _s) + 'px';
      }
    }
  } else {
    _hoveredHit = null;
    tooltip.style.display = 'none';
    renderer.domElement.style.cursor = 'default';
    // 편집 아이콘 숨김 (마우스가 편집 아이콘 위에 있으면 유지)
    setTimeout(() => {
      if (!_editingNode && document.querySelector('#hover-edit-icon:hover') === null) {
        _editIconEl.style.display = 'none';
      }
    }, 80);
  }
}
