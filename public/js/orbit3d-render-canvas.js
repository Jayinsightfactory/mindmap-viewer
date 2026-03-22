'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Canvas2D 기반 렌더링 (LOD, 숨김노드, glow, 토픽링크, 별자리, 피라미드)
// [orbit3d-render.js에서 분할]
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Canvas2D rendering, labels, constellations, LOD, zoom summary
// ══════════════════════════════════════════════════════════════════════════════
// ─── Canvas2D 오버레이 — LOD 텍스트 행성 ────────────────────────────────────
const _labelCanvas2d = document.createElement('canvas');
_labelCanvas2d.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:50;';
document.body.appendChild(_labelCanvas2d);
const _lctx = _labelCanvas2d.getContext('2d');
window._lctx = _lctx;
window._labelCanvas2d = _labelCanvas2d;

function resizeLabelCanvas() {
  const sw = getNavWidth();
  _labelCanvas2d.width  = innerWidth - sw;
  _labelCanvas2d.height = innerHeight;
  _labelCanvas2d.style.left = sw + 'px';
}
resizeLabelCanvas();
// DOM 준비 후 초기 렌더 영역 적용
window.addEventListener('DOMContentLoaded', () => {
  resizeRendererToSidebar();
  initClaudeStatusBadge();     // Claude 트래킹 배지 초기화
  _loadPersonalStats();        // 개인 학습 통계 초기화
  _initTrackerStatusBadge();   // 트래커 연결 상태 배지

  // 숨긴 노드 있으면 사이드바 버튼 표시
  if (Object.keys(_hiddenNodes).length > 0) {
    const btn = document.getElementById('ln-hidden-btn');
    if (btn) btn.style.display = '';
  }

  // ── 뷰 모드 복원 (개인 모드가 기본, 팀/전사는 명시적 전환만) ──────────────
  // 이전 세션에서 팀/전사 모드였어도 개인 모드로 시작 (안정성)
  localStorage.setItem('orbitViewMode', 'personal');
}, { once: true });

// ─── Escape: 드릴다운 복귀 ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (window._drillDownSource === 'team') {
    window._drillDownSource = null;
    window._drillDownMemberId = null;
    window._drillDownMemberName = null;
    loadTeamDemo(); // 샘플 직접 호출 금지 → 로그인 검증 경유
  } else if (window._drillDownSource === 'follower') {
    window._drillDownSource = null;
    window._drillDownMemberId = null;
    window._drillDownMemberName = null;
    if (typeof loadData === 'function') loadData(); // 내 데이터로 복귀
  }
});
setTimeout(resizeRendererToSidebar, 100); // fallback

// ─── 줌 거리 → LOD 레벨 ─────────────────────────────────────────────────────
// LOD 0: 줌인 (r < 60)   — 행성 크게 + 위성 상세
// LOD 1: 중간 (r 60~130) — 행성 보통 + 위성 보통
// LOD 2: 줌아웃 (r > 130) — 행성만 작게, 위성 숨김
// LOD 3: 최대줌아웃 (>180) — 요약 오버레이 (updateZoomSummary 처리)
function getLOD() {
  const r = controls.sph.r;
  if (r < 45)  return 0;   // 매우 가까이: 모든 디테일 표시
  if (r < 100) return 1;   // 팀 기본 뷰: 멤버+목표 (task/skill 숨김)
  if (r < 170) return 2;   // 회사 뷰: 부서+목표만
  return 3;                 // 유니버스 뷰
}

// [extracted to orbit3d-card-texture.js]: screenScale, roundRect, drawWireframeGrid, UNI_CARD_W/H/R/BAR

// ── 노드 숨기기 ────────────────────────────────────────────────────────────
const _hiddenNodes = (() => { try { return JSON.parse(localStorage.getItem('orbitHiddenNodes') || '{}'); } catch { return {}; } })();
function _saveHiddenNodes() { localStorage.setItem('orbitHiddenNodes', JSON.stringify(_hiddenNodes)); }
window._hiddenNodes = _hiddenNodes;
window._saveHiddenNodes = _saveHiddenNodes;
window.unhideNode = function(key) { delete _hiddenNodes[key]; _saveHiddenNodes(); };
window.getHiddenNodeList = function() { return Object.keys(_hiddenNodes).map(k => ({ key: k, label: _hiddenNodes[k] })); };

// [extracted to orbit3d-card-texture.js]: drawCardIcons, drawUnifiedCard, toScreen

// ─── 실시간 작업 빛 상태 ─────────────────────────────────────────────────────
// WS 이벤트로 최근 활성화된 clusterId → 타임스탬프
const _activeGlow = {}; // clusterId → lastActiveMs
const GLOW_FADE_MS = 4000; // 4초 후 서서히 소멸

function markClusterActive(clusterId) {
  _activeGlow[clusterId] = Date.now();
}

// glow 강도 (0~1)
function glowIntensity(clusterId) {
  const t = _activeGlow[clusterId];
  if (!t) return 0;
  const age = Date.now() - t;
  if (age > GLOW_FADE_MS) return 0;
  return 1 - age / GLOW_FADE_MS;
}

// ─── 프로젝트별 활성 파일 추적 ────────────────────────────────────────────────
// 최근 5분 내 이벤트에서 파일 경로를 추출하여 프로젝트별로 그룹화
const _activeFilesPerProject = {};          // projName → [{ file, shortName, timestamp, filePath }]
const ACTIVE_FILE_TTL = 5 * 60 * 1000;     // 5분간 활성 표시

// 씬 빌드 후 또는 데이터 로드 시 호출
function updateActiveFiles() {
  const now = Date.now();
  // _sessionMap: clusterId → { planet, fileSats, events }
  Object.keys(_activeFilesPerProject).forEach(k => delete _activeFilesPerProject[k]);

  for (const [clusterId, entry] of Object.entries(_sessionMap || {})) {
    if (!entry || !entry.events) continue;
    const proj = entry.planet?.userData?.projectName || '기타';
    if (!_activeFilesPerProject[proj]) _activeFilesPerProject[proj] = [];

    // 최근 이벤트에서 파일 경로 추출
    for (let i = entry.events.length - 1; i >= 0; i--) {
      const e = entry.events[i];
      const ts = new Date(e.timestamp).getTime();
      if (now - ts > ACTIVE_FILE_TTL) break;     // 5분 초과 → 중단

      const fp = e.data?.filePath || e.data?.fileName || '';
      if (!fp) continue;
      const shortName = fp.replace(/\\/g, '/').split('/').pop();
      // 중복 방지
      if (_activeFilesPerProject[proj].some(f => f.filePath === fp)) continue;

      _activeFilesPerProject[proj].push({
        file: shortName,
        shortName: shortName.length > 18 ? shortName.slice(0, 16) + '…' : shortName,
        timestamp: e.timestamp,
        filePath: fp,
        eventType: e.type,
        isWrite: e.type === 'file.write' || e.type === 'tool.end',
      });
      if (_activeFilesPerProject[proj].length >= 5) break;  // 프로젝트당 최대 5개
    }
  }
}

// VS Code로 파일 열기 (vscode:// 프로토콜 사용)
function openFileInEditor(filePath) {
  if (!filePath) return;
  // Windows 경로 → URI 변환
  const uri = filePath.replace(/\\/g, '/');
  const vscodeUrl = `vscode://file/${uri}`;
  window.open(vscodeUrl, '_blank');
  if (typeof showToast === 'function') showToast(`📂 ${uri.split('/').pop()} 열기`, 2000);
}

// [extracted to orbit3d-card-texture.js]: drawGlow

// ─── 토픽 유사도 기반 글로잉 연결선 ──────────────────────────────────────────
// 로컬 키워드 분석: Ollama 없이도 의미 있는 연결 추론
const _topicLinks = [];         // { a, b, score, color } — 행성 쌍
let _topicLinksBuilt = false;
let _topicLinksLastBuilt = 0;   // 마지막 빌드 시각 (ms) — 5초마다 재빌드

function _tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[🛠🔧⚙️📝🌐🔐🗄️🎨🧪🚀🐳💬🌿📐]/gu, '')
    .split(/[\s\-_/.,!?·]+/)
    .filter(t => t.length >= 2 && !/^(및|의|을|를|이|가|은|는|로|에|와|과|그|이|저|것|들|수|않|없|있|하|했|됩|될|게|도|만|좀|더|잘|안|못|제|제가|저는)$/.test(t));
}

function _topicSimilarity(intentA, intentB, domainA, domainB) {
  // 1. 같은 도메인 → 기본 점수
  let score = (domainA === domainB && domainA !== 'general' && domainA !== 'purpose') ? 0.35 : 0;
  // 2. 공통 키워드 비율
  const ta = new Set(_tokenize(intentA));
  const tb = new Set(_tokenize(intentB));
  if (ta.size && tb.size) {
    let common = 0;
    ta.forEach(w => { if (tb.has(w)) common++; });
    score += common / Math.sqrt(ta.size * tb.size) * 1.5;
  }
  // 3. 핵심 주제어 일치 보너스 (SaaS, auth, deploy, 결제 등)
  const keywords = ['saas','auth','deploy','결제','랜딩','pipeline','automation','api','test','bug','fix','버그'];
  const sharedKw = keywords.filter(k => (intentA||'').toLowerCase().includes(k) && (intentB||'').toLowerCase().includes(k));
  score += sharedKw.length * 0.25;
  return Math.min(score, 1.0);
}

function buildTopicLinks() {
  if (planetMeshes.length < 2) return;
  const now = Date.now();
  // loadSessionContext() 비동기 완료 대기: 씬 초기화 후 3초 뒤부터 빌드
  // 이후 인텐트가 업데이트될 수 있으므로 5초마다 재빌드
  if (_topicLinksBuilt && now - _topicLinksLastBuilt < 5000) return;
  _topicLinksBuilt = true;
  _topicLinksLastBuilt = now;
  _topicLinks.length = 0;

  for (let i = 0; i < planetMeshes.length; i++) {
    for (let j = i + 1; j < planetMeshes.length; j++) {
      const a = planetMeshes[i], b = planetMeshes[j];
      // 같은 세션 내 클러스터끼리는 이미 별자리로 연결됨 → 스킵
      if (a.userData.sessionId === b.userData.sessionId) continue;
      // 둘 다 제네릭(기타/general) 이면 스킵 (노이즈 방지)
      const iA = a.userData.intent || '', iB = b.userData.intent || '';
      if (/^⚙️\s?기타|^⚙️\s?작업/.test(iA) && /^⚙️\s?기타|^⚙️\s?작업/.test(iB)) continue;
      // 둘 다 짧은 도메인 레이블(구체적 내용 없음)이면 스킵
      const isGenericLabel = t => t.replace(/[^\s\w가-힣]/gu, '').trim().length < 6;
      if (isGenericLabel(iA) && isGenericLabel(iB)) continue;
      const score = _topicSimilarity(iA, iB, a.userData.domain, b.userData.domain);
      if (score >= 0.45) {
        _topicLinks.push({ a, b, score });
      }
    }
  }
}

function drawTopicLinks() {
  if (!planetMeshes.length) return;
  buildTopicLinks();
  if (!_topicLinks.length) return;

  const now = performance.now() / 1000;
  const lod = getLOD();
  if (lod >= 3) return;   // 너무 줌아웃 시 표시 안 함

  _topicLinks.forEach(({ a, b, score }) => {
    const sa = toScreen(a.position);
    const sb = toScreen(b.position);
    if (sa.z > 1 || sb.z > 1) return;

    const hexA = a.userData.hueHex || '#58a6ff';
    const hexB = b.userData.hueHex || '#3fb950';

    // 애니메이션: pulse + 흐름 효과
    const pulse = 0.5 + 0.5 * Math.sin(now * 1.8 + score * 5);
    const baseAlpha = 0.12 + score * 0.28;
    const alpha = baseAlpha * (0.7 + pulse * 0.3);

    // 그래디언트 선
    const grad = _lctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
    grad.addColorStop(0, hexA + Math.round(alpha * 255).toString(16).padStart(2,'0'));
    grad.addColorStop(1, hexB + Math.round(alpha * 255).toString(16).padStart(2,'0'));

    _lctx.save();
    _lctx.globalAlpha = 1;
    _lctx.strokeStyle = grad;
    _lctx.lineWidth   = score >= 0.7 ? 2.2 : score >= 0.5 ? 1.6 : 1.0;

    // 높은 유사도: 실선 + glow / 낮은 유사도: 점선
    if (score >= 0.55) {
      _lctx.shadowColor = hexA;
      _lctx.shadowBlur  = 8 + pulse * 6;
    } else {
      _lctx.setLineDash([6, 10]);
    }

    _lctx.beginPath();
    _lctx.moveTo(sa.x, sa.y);
    _lctx.lineTo(sb.x, sb.y);
    _lctx.stroke();
    _lctx.setLineDash([]);
    _lctx.shadowBlur = 0;
    _lctx.restore();

    // 유사도 뱃지 (중간 지점, score가 높을 때만)
    if (score >= 0.6 && lod <= 1) {
      const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
      const label = `${Math.round(score * 100)}%`;
      _lctx.save();
      _lctx.globalAlpha = alpha * 1.2;
      _lctx.font = '600 9px -apple-system,sans-serif';
      _lctx.textAlign = 'center';
      _lctx.fillStyle = hexA;
      _lctx.fillText(label, mx, my - 4);
      _lctx.restore();
    }
  });
}

// ─── 별자리 그리기 ────────────────────────────────────────────────────────────
function drawConstellations() {
  const projEntries = Object.entries(_projectGroups);
  if (!projEntries.length) return;

  const now = performance.now() / 1000;

  projEntries.forEach(([projName, grp]) => {
    const pts = grp.planetMeshes
      .map(p => toScreen(p.position))
      .filter(s => s.z <= 1);
    if (!pts.length) return;

    // 별자리 중심 (스크린 좌표 평균)
    let cx = 0, cy = 0;
    pts.forEach(s => { cx += s.x; cy += s.y; });
    cx /= pts.length; cy /= pts.length;

    const color    = grp.color || '#58a6ff';
    const cnt      = grp.planetMeshes.length;
    const isHover  = _hoveredHit?.data?.type === 'constellation' && _hoveredHit?.data?.projName === projName;

    // ── 개별 별 점 (희미하게) ────────────────────────────────────────────
    pts.forEach((s, i) => {
      const pulse = 0.5 + 0.5 * Math.sin(now * 1.4 + i * 1.2);
      _lctx.save();
      _lctx.globalAlpha = 0.35 + pulse * 0.25;
      _lctx.fillStyle   = color;
      _lctx.shadowColor = color; _lctx.shadowBlur = 6;
      _lctx.beginPath(); _lctx.arc(s.x, s.y, 3 + pulse, 0, Math.PI*2); _lctx.fill();
      _lctx.restore();
    });

    // ── 별 연결선 (콘스텔레이션 라인) ────────────────────────────────────
    if (pts.length >= 2) {
      _lctx.save();
      _lctx.strokeStyle = color;
      _lctx.globalAlpha = 0.15;
      _lctx.lineWidth   = 1;
      _lctx.setLineDash([4, 6]);
      _lctx.beginPath();
      // 중심 → 각 별 (허브-앤-스포크)
      pts.forEach(s => {
        _lctx.moveTo(cx, cy);
        _lctx.lineTo(s.x, s.y);
      });
      _lctx.stroke();
      _lctx.setLineDash([]);
      _lctx.restore();
    }

    // ── 중심 오브 (프로젝트 이름 pill) ───────────────────────────────────
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.9);
    // projName 정제: 세션-XXXX → 대표 의도로 대체, hyphen-name → Readable Name
    let _dispName = projName;
    if (/^세션-/.test(projName)) {
      const best = grp.planetMeshes.map(p => p.userData.intent).find(t => t && !/^(⚙️\s?기타|⚙️\s?작업)/.test(t));
      _dispName = best ? best.split(/\s{2,}/)[0].trim() : projName;
    } else if (/[-_]/.test(projName) && !/\s/.test(projName)) {
      _dispName = projName.split(/[-_]/).filter(s => s !== 'session' && s !== 'wf').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ').slice(0, 28);
    }
    const label = `🗂 ${_dispName}`;
    // ── 별자리 서브: 최근 활동 내용 또는 세션 수 ──────────────────────────
    let sub = `${cnt}개 세션`;
    const _grpLatestAct = grp.planetMeshes.reduce((best, pm) => {
      const ent = _sessionMap[pm.userData.clusterId];
      if (!ent) return best;
      const actEv = [...(ent.events || [])].reverse().find(e =>
        e.type === 'app_switch' || e.type === 'browse' || e.type === 'browser_activity'
      );
      if (actEv && (!best || (actEv.timestamp || '') > (best.timestamp || ''))) return actEv;
      return best;
    }, null);
    if (_grpLatestAct) {
      const _actText = extractIntent(_grpLatestAct);
      if (_actText) sub = _actText.slice(0, 30);
    }
    const pxMain = isHover ? 17 : 15;
    const pxSub  = 11;

    _lctx.font = `700 ${pxMain}px -apple-system,'Segoe UI',sans-serif`;
    _lctx.textAlign = 'center';
    const tw   = _lctx.measureText(label).width;
    const pw   = tw + 28;
    const ph   = pxMain + 16;
    const lx   = cx - pw / 2;
    const ly   = cy - ph / 2;

    // 글로우
    _lctx.save();
    _lctx.globalAlpha = 0.18 + pulse * 0.12;
    _lctx.shadowColor = color; _lctx.shadowBlur = 22 + pulse * 8;
    _lctx.fillStyle = color;
    _lctx.beginPath(); _lctx.arc(cx, cy, (pw + ph) / 4 + 6, 0, Math.PI * 2); _lctx.fill();
    _lctx.restore();

    // 배경 pill
    _lctx.globalAlpha = isHover ? 0.97 : 0.88;
    _lctx.fillStyle   = 'rgba(6,10,16,0.93)';
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.fill();

    // 3D 와이어프레임 그리드
    drawWireframeGrid(_lctx, lx, ly, pw, ph, ph / 2, color, isHover ? 0.28 : 0.18);

    // 테두리
    _lctx.strokeStyle = color;
    _lctx.lineWidth   = isHover ? 2.5 : 1.8;
    _lctx.shadowColor = color; _lctx.shadowBlur = isHover ? 14 : 6;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.stroke();
    _lctx.shadowBlur  = 0;

    // 텍스트
    _lctx.fillStyle = isHover ? '#ffffff' : '#e6edf3';
    _lctx.fillText(label, cx, ly + ph * 0.67);

    // 서브 레이블
    _lctx.font = `400 ${pxSub}px -apple-system,sans-serif`;
    _lctx.fillStyle = color + '99';
    _lctx.globalAlpha = 0.85;
    _lctx.fillText(sub, cx, ly + ph + pxSub + 2);

    _lctx.globalAlpha = 1;

    // ── 활성 파일 배지 (프로젝트 pill 아래에 표시) ─────────────────────────
    const activeFiles = _activeFilesPerProject[projName] || [];
    if (activeFiles.length > 0) {
      const badgeY = ly + ph + pxSub + 18;       // 서브 레이블 아래
      const badgePx = 10;
      const badgeH = badgePx + 8;
      const badgeGap = 3;
      const maxBadges = Math.min(activeFiles.length, 3);   // 최대 3개 표시

      // 전체 너비 계산 (중앙 정렬용)
      _lctx.font = `600 ${badgePx}px -apple-system,'Segoe UI',monospace`;
      let totalW = 0;
      for (let bi = 0; bi < maxBadges; bi++) {
        totalW += _lctx.measureText('⚡ ' + activeFiles[bi].shortName).width + 16;
        if (bi < maxBadges - 1) totalW += badgeGap;
      }
      let bx = cx - totalW / 2;

      for (let bi = 0; bi < maxBadges; bi++) {
        const af = activeFiles[bi];
        const afLabel = (af.isWrite ? '✏️ ' : '⚡ ') + af.shortName;
        const afW = _lctx.measureText(afLabel).width + 16;
        const bPulse = 0.5 + 0.5 * Math.sin(now * 2.5 + bi * 1.3);

        // 배지 배경 (어두운 반투명 + 활성 색상 테두리)
        _lctx.save();
        _lctx.globalAlpha = 0.92;
        _lctx.fillStyle = 'rgba(13,17,23,0.95)';
        roundRect(_lctx, bx, badgeY, afW, badgeH, badgeH / 2);
        _lctx.fill();

        // 테두리 + 펄스 글로우
        _lctx.strokeStyle = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.lineWidth = 1.5;
        _lctx.shadowColor = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.shadowBlur = 4 + bPulse * 6;
        roundRect(_lctx, bx, badgeY, afW, badgeH, badgeH / 2);
        _lctx.stroke();
        _lctx.shadowBlur = 0;

        // 텍스트
        _lctx.font = `600 ${badgePx}px -apple-system,'Segoe UI',monospace`;
        _lctx.fillStyle = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.globalAlpha = 0.7 + bPulse * 0.3;
        _lctx.textAlign = 'left';
        _lctx.fillText(afLabel, bx + 8, badgeY + badgeH * 0.7);
        _lctx.restore();

        // 히트 영역 (클릭으로 파일 열기)
        registerHitArea({
          cx: bx + afW / 2, cy: badgeY + badgeH / 2,
          r: Math.max(afW, badgeH) / 2 + 4,
          obj: null,
          data: { type: 'activeFile', filePath: af.filePath, fileName: af.file, projName },
        });

        bx += afW + badgeGap;
      }

      // 추가 파일 수 표시 (+N more)
      if (activeFiles.length > maxBadges) {
        _lctx.save();
        _lctx.font = `400 9px -apple-system,sans-serif`;
        _lctx.fillStyle = '#6e7681';
        _lctx.globalAlpha = 0.7;
        _lctx.textAlign = 'left';
        _lctx.fillText(`+${activeFiles.length - maxBadges}`, bx + 4, badgeY + badgeH * 0.7);
        _lctx.restore();
      }

      _lctx.textAlign = 'center';  // 원래대로 복원
    }

    // 히트 영역
    registerHitArea({
      cx, cy,
      r: (Math.max(pw, ph) / 2) + 6,
      obj: null,
      data: { type: 'constellation', projName, planetCount: cnt, color },
    });
  });
}

// [extracted to orbit3d-layout.js]: _TEAM_WORLD_POS, _drawTeamClusters, drawCompactProjectView, _drawPersonalPlanets, _usedRects, LABEL_PADDING, rectOverlaps, reserveRect

// ═══════════════════════════════════════════════════════════════════════════════
// 세션 상세 윈도우 — 데스크톱 창 스타일
// 세션 클릭 시 화면 중앙에 윈도우 형태로 표시
// ═══════════════════════════════════════════════════════════════════════════════
let _pyramidTrayScale = 1.0;

function drawInvertedPyramid(planetObj, hitData) {
  const sc = toScreen(planetObj.position);
  if (sc.z > 1) return;

  const ctx = _lctx;
  const clusterId = planetObj.userData?.clusterId || planetObj.userData?.sessionId;
  const entry     = _sessionMap[clusterId];
  const events    = entry?.events || [];
  if (events.length === 0) return;

  const hex = planetObj.userData?.hueHex || '#58a6ff';

  // ── 데이터 준비 ─────────────────────────────────────────────────────────
  const sessionCtx = _sessionContextCache[clusterId] || {};
  const projName   = sessionCtx.projectName || planetObj.userData?.projectName || '';
  const firstMsg   = sessionCtx.firstMsg || sessionCtx.autoTitle || '';

  // 파일 집계
  const fileCounts = {};
  let writeCount = 0, readCount = 0, msgCount = 0, toolCount = 0;
  for (const e of events) {
    let d = e.data || {};
    if (e.fullContent && typeof e.fullContent === 'string' && e.fullContent.startsWith('{')) {
      try { d = {...d, ...JSON.parse(e.fullContent)}; } catch {}
    }
    // 통계
    if (e.type === 'file.write' || (e.type === 'tool.end' && d.toolName === 'Write')) writeCount++;
    else if (e.type === 'file.read') readCount++;
    else if (e.type === 'user.message' || e.type === 'assistant.message' || e.type === 'assistant.response') msgCount++;
    else toolCount++;

    const raw = d.filePath || d.fileName || '';
    if (!raw) continue;
    const fname = raw.replace(/\\/g, '/').split('/').pop();
    if (!fname || fname.length < 2) continue;
    if (!fileCounts[fname]) fileCounts[fname] = { count: 0, writes: 0 };
    fileCounts[fname].count++;
    if (e.type === 'file.write' || (e.type === 'tool.end' && d.toolName === 'Write')) fileCounts[fname].writes++;
  }
  const fileList = Object.entries(fileCounts).sort((a,b) => b[1].count - a[1].count).slice(0, 8);

  // 시간 범위
  const timestamps = events.filter(e => e.timestamp).map(e => new Date(e.timestamp).getTime());
  const startTime = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;
  const endTime   = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
  const durationMin = startTime && endTime ? Math.round((endTime - startTime) / 60000) : 0;

  // 최근 이벤트 (스크롤 오프셋 적용)
  const recentEvts = [...events].reverse().slice(0, 50);
  const scrollIdx  = Math.min(Math.floor((_pyramidScrollOffset || 0) / 36), Math.max(0, recentEvts.length - 6));
  const visibleEvts = recentEvts.slice(scrollIdx, scrollIdx + 6);

  // ── 레이아웃 ─────────────────────────────────────────────────────────────
  const WIN_W   = Math.min(480, ctx.canvas.width * 0.80);
  const PAD     = 18;
  const TITLE_H = 38;   // 타이틀바
  const SUMMARY_H = 60; // 요약 카드 영역
  const ROW_H   = 30;
  const GAP     = 3;
  const FILE_ROW_H = 28;

  const evtSectionH = visibleEvts.length * (ROW_H + GAP) + 24;
  const fileSectionH = fileList.length > 0 ? (24 + fileList.length * (FILE_ROW_H + GAP)) : 0;
  const scrollHintH = recentEvts.length > 6 ? 20 : 0;
  const totalH = TITLE_H + SUMMARY_H + evtSectionH + scrollHintH + fileSectionH + PAD;

  const centerX = ctx.canvas.width / 2;
  const winX = centerX - WIN_W / 2;
  const winY = Math.max(30, (ctx.canvas.height - totalH) / 2 - 30);

  // ── 호버 윈도우 영역 미리 예약 (라벨이 겹치지 않도록) ────────────────────
  reserveRect(winX - 20, winY - 20, WIN_W + 40, totalH + 40);

  ctx.save();

  // ── 윈도우 그림자 (다크 글래스) ───────────────────────────────────────
  ctx.shadowColor = 'rgba(6,182,212,0.1)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
  roundRect(ctx, winX, winY, WIN_W, totalH, 12);
  ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // 윈도우 테두리 (white/10)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  roundRect(ctx, winX, winY, WIN_W, totalH, 12);
  ctx.stroke();

  // ── 타이틀바 (다크 글래스) ───────────────────────────────────────────
  ctx.fillStyle = 'rgba(6,182,212,0.06)';
  // 상단 좌/우 모서리만 둥글게
  ctx.beginPath();
  ctx.moveTo(winX + 12, winY);
  ctx.lineTo(winX + WIN_W - 12, winY);
  ctx.arcTo(winX + WIN_W, winY, winX + WIN_W, winY + 12, 12);
  ctx.lineTo(winX + WIN_W, winY + TITLE_H);
  ctx.lineTo(winX, winY + TITLE_H);
  ctx.lineTo(winX, winY + 12);
  ctx.arcTo(winX, winY, winX + 12, winY, 12);
  ctx.closePath();
  ctx.fill();

  // 타이틀바 하단선
  ctx.strokeStyle = hex + '30';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(winX, winY + TITLE_H); ctx.lineTo(winX + WIN_W, winY + TITLE_H); ctx.stroke();

  // 윈도우 버튼 (장식)
  const btnY = winY + TITLE_H / 2;
  [['#ff5f57', winX + 16], ['#ffbd2e', winX + 32], ['#28c840', winX + 48]].forEach(([c, bx]) => {
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(bx, btnY, 5, 0, Math.PI * 2); ctx.fill();
  });

  // 타이틀 텍스트
  const titleText = firstMsg
    ? (firstMsg.length > 40 ? firstMsg.slice(0, 39) + '…' : firstMsg)
    : planetObj.userData?.intent?.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu, '').trim().slice(0, 40) || '세션 상세';
  ctx.font = "600 13px 'Inter',-apple-system,'Segoe UI',sans-serif";
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(titleText, centerX, winY + TITLE_H / 2 + 4);

  let curY = winY + TITLE_H + 12;

  // ── 요약 카드 섹션 (stat chips) ────────────────────────────────────────
  const stats = [
    { icon: '💬', label: '대화', value: msgCount, color: '#79c0ff' },
    { icon: '✏️', label: '편집', value: writeCount, color: '#ffa657' },
    { icon: '📄', label: '파일', value: fileList.length, color: '#3fb950' },
    { icon: '⏱', label: '소요', value: durationMin > 0 ? `${durationMin}분` : '-', color: '#d2a8ff' },
  ];

  const CHIP_W = (WIN_W - PAD * 2 - 12) / 4;
  const CHIP_H = 42;
  stats.forEach((st, si) => {
    const chipX = winX + PAD + si * (CHIP_W + 4);
    const chipY = curY;

    // 칩 배경 (다크 글래스)
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    roundRect(ctx, chipX, chipY, CHIP_W, CHIP_H, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    roundRect(ctx, chipX, chipY, CHIP_W, CHIP_H, 8); ctx.stroke();

    // 값
    ctx.textAlign = 'center';
    ctx.font = "700 15px 'JetBrains Mono','Fira Code',monospace";
    ctx.fillStyle = st.color;
    ctx.fillText(`${st.value}`, chipX + CHIP_W / 2, chipY + 18);

    // 라벨
    ctx.font = "400 9px 'Inter',-apple-system,sans-serif";
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${st.icon} ${st.label}`, chipX + CHIP_W / 2, chipY + 34);
  });

  curY += CHIP_H + 14;

  // 시간 범위 표시
  if (startTime) {
    ctx.textAlign = 'left';
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#94a3b8';
    const timeRange = `${startTime.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})} ~ ${endTime.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})}`;
    const dateStr = startTime.toLocaleDateString('ko-KR', {month:'short', day:'numeric'});
    ctx.fillText(`📅 ${dateStr}  ${timeRange}`, winX + PAD, curY);
    if (projName) {
      ctx.textAlign = 'right';
      ctx.fillStyle = hex;
      ctx.fillText(`📂 ${projName}`, winX + WIN_W - PAD, curY);
    }
    curY += 16;
  }

  // 구분선
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(winX + PAD, curY); ctx.lineTo(winX + WIN_W - PAD, curY); ctx.stroke();
  curY += 8;

  // ── 타임라인 이벤트 (세로 카드) ────────────────────────────────────────
  const TYPE_ICONS = {
    'user.message': '💬', 'assistant.message': '🤖', 'assistant.response': '🤖',
    'tool.start': '⚡', 'tool.end': '✅', 'tool.error': '❌',
    'file.read': '📄', 'file.write': '✏️', 'git.commit': '🌿', 'git.push': '🚀',
    'session.start': '🌟', 'browse': '🌐', 'app_switch': '🔄',
  };
  const evtCardW = WIN_W - PAD * 2;

  visibleEvts.forEach((evt, i) => {
    const ex = winX + PAD;
    const ey = curY + i * (ROW_H + GAP);
    const icon = TYPE_ICONS[evt.type] || '⚙️';
    const label = (evt.label || extractIntent(evt) || evt.type || '').slice(0, 45);
    const ts = evt.timestamp
      ? new Date(evt.timestamp).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' })
      : '';

    // 타임라인 점
    ctx.fillStyle = hex;
    ctx.beginPath(); ctx.arc(ex + 6, ey + ROW_H / 2, 3, 0, Math.PI * 2); ctx.fill();
    // 타임라인 수직선
    if (i < visibleEvts.length - 1) {
      ctx.strokeStyle = hex + '25';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ex + 6, ey + ROW_H / 2 + 3); ctx.lineTo(ex + 6, ey + ROW_H + GAP + ROW_H / 2 - 3); ctx.stroke();
    }

    // 이벤트 카드 배경
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0)';
    roundRect(ctx, ex + 16, ey, evtCardW - 16, ROW_H, 6); ctx.fill();

    // 아이콘 + 라벨
    ctx.textAlign = 'left';
    ctx.font = `500 12px -apple-system,sans-serif`;
    ctx.fillStyle = '#cdd9e5';
    ctx.fillText(`${icon}  ${label}`, ex + 22, ey + ROW_H * 0.62);

    // 시간
    ctx.textAlign = 'right';
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(ts, ex + evtCardW - 4, ey + ROW_H * 0.62);

    registerHitArea({
      cx: ex + evtCardW / 2, cy: ey + ROW_H / 2, r: evtCardW / 2,
      obj: planetObj,
      data: { type: 'session', intent: label, clusterId, sessionId: planetObj.userData?.sessionId,
              eventCount: events.length, hueHex: hex },
    });
  });

  curY += visibleEvts.length * (ROW_H + GAP);

  // ── 스크롤 힌트 ──────────────────────────────────────────────────────────
  if (recentEvts.length > 6) {
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText(
      `↕ 마우스 휠로 스크롤 (${scrollIdx + 1}~${scrollIdx + visibleEvts.length} / ${recentEvts.length})`,
      centerX, curY + 6
    );
    curY += 20;
  }

  // ── 파일 섹션 ────────────────────────────────────────────────────────────
  if (fileList.length > 0) {
    // 구분선
    ctx.strokeStyle = '#ffffff10';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(winX + PAD, curY + 4); ctx.lineTo(winX + WIN_W - PAD, curY + 4); ctx.stroke();
    curY += 12;

    ctx.textAlign = 'left';
    ctx.font = `600 11px -apple-system,sans-serif`;
    ctx.fillStyle = '#8b949e';
    ctx.fillText(`📁 관련 파일 (${fileList.length})`, winX + PAD, curY + 4);
    curY += 14;

    fileList.forEach(([fname, info], i) => {
      const fx = winX + PAD;
      const fy = curY + i * (FILE_ROW_H + GAP);
      const isWrite = info.writes > 0;

      // 파일 행 배경
      ctx.fillStyle = isWrite ? 'rgba(255,166,87,0.06)' : 'rgba(88,166,255,0.04)';
      roundRect(ctx, fx, fy, WIN_W - PAD * 2, FILE_ROW_H, 6); ctx.fill();

      // 파일명
      const shortName = fname.length > 30 ? fname.slice(0, 29) + '…' : fname;
      ctx.font = `500 11px -apple-system,sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = isWrite ? '#ffa657' : '#79c0ff';
      ctx.fillText(`${isWrite ? '✏️' : '📄'} ${shortName}`, fx + 10, fy + FILE_ROW_H * 0.62);

      // 횟수
      ctx.textAlign = 'right';
      ctx.font = `400 10px -apple-system,sans-serif`;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${info.count}회`, fx + WIN_W - PAD * 2 - 8, fy + FILE_ROW_H * 0.62);

      registerHitArea({
        cx: fx + (WIN_W - PAD * 2) / 2, cy: fy + FILE_ROW_H / 2, r: (WIN_W - PAD * 2) / 2,
        obj: planetObj,
        data: { type: 'file', intent: fname, fileLabel: fname, filename: fname,
                count: info.count, isWrite },
      });
    });
  }

  ctx.restore();
}
