// ══════════════════════════════════════════════════════════════════════════════
// orbit3d-transitions.js
// TWEEN.js 기반 계층형 카메라 전환 — Personal → Team → Company
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

// ── 카메라 위치 프리셋 ────────────────────────────────────────────────────────
const CAMERA_PRESETS = {
  personal: { x: 0,  y: 25,  z: 55,  lookAt: { x:0, y:0, z:0 }, fov: 55 },
  team:     { x: 0,  y: 60,  z: 90,  lookAt: { x:0, y:0, z:0 }, fov: 58 },
  company:  { x: 0,  y: 90,  z: 130, lookAt: { x:0, y:0, z:0 }, fov: 62 },
  drilldown:{ x: 0,  y: 15,  z: 35,  lookAt: { x:0, y:0, z:0 }, fov: 50 },
};

// ── TWEEN 인스턴스 관리 ────────────────────────────────────────────────────────
let _activeTween = null;
let _lookTween   = null;

/**
 * 카메라를 지정 위치로 부드럽게 이동
 * @param {object} target  - { x, y, z, lookAt: {x,y,z}, fov }
 * @param {number} duration - ms
 * @param {Function} [onComplete]
 */
function transitionCamera(target, duration = 800, onComplete) {
  // 기존 트윈 중단
  if (_activeTween) _activeTween.stop();
  if (_lookTween)   _lookTween.stop();

  // TWEEN 라이브러리 확인
  const TW = window.TWEEN;
  if (!TW) {
    // TWEEN 없으면 즉시 이동
    camera.position.set(target.x, target.y, target.z);
    if (target.fov) { camera.fov = target.fov; camera.updateProjectionMatrix(); }
    if (onComplete) onComplete();
    return;
  }

  // ── 카메라 위치 트윈 ────────────────────────────────────────────────────
  const startPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  _activeTween = new TW.Tween(startPos)
    .to({ x: target.x, y: target.y, z: target.z }, duration)
    .easing(TW.Easing.Cubic.InOut)
    .onUpdate(() => {
      camera.position.set(startPos.x, startPos.y, startPos.z);
    })
    .onComplete(() => {
      if (onComplete) onComplete();
    })
    .start();

  // ── lookAt 트윈 ────────────────────────────────────────────────────────
  if (target.lookAt) {
    const lookCurrent = { x: 0, y: 0, z: 0 }; // 기본 origin
    const lookTarget  = target.lookAt;
    _lookTween = new TW.Tween(lookCurrent)
      .to(lookTarget, duration)
      .easing(TW.Easing.Cubic.InOut)
      .onUpdate(() => {
        camera.lookAt(lookCurrent.x, lookCurrent.y, lookCurrent.z);
      })
      .start();
  }

  // ── FOV 트윈 ───────────────────────────────────────────────────────────
  if (target.fov && camera.fov !== target.fov) {
    const fovObj = { fov: camera.fov };
    new TW.Tween(fovObj)
      .to({ fov: target.fov }, duration)
      .easing(TW.Easing.Cubic.InOut)
      .onUpdate(() => {
        camera.fov = fovObj.fov;
        camera.updateProjectionMatrix();
      })
      .start();
  }
}

/**
 * 뷰 모드 전환 (Personal / Team / Company)
 * orbit3d-team.js의 loadTeamDemo / loadCompanyDemo 호출 전 카메라 이동
 */
function transitionToPersonal(callback) {
  transitionCamera(CAMERA_PRESETS.personal, 700, callback);
  _flashLayerLabel('👤 내 화면', '#00c8ff');
}

function transitionToTeam(callback) {
  transitionCamera(CAMERA_PRESETS.team, 900, callback);
  _flashLayerLabel('👥 팀 뷰', '#a855f7');
}

function transitionToCompany(callback) {
  transitionCamera(CAMERA_PRESETS.company, 1000, callback);
  _flashLayerLabel('🏢 전사 뷰', '#00ff88');
}

function transitionToDrilldown(targetPos, callback) {
  const preset = { ...CAMERA_PRESETS.drilldown };
  if (targetPos) { preset.lookAt = targetPos; }
  transitionCamera(preset, 600, callback);
}

// ── 레이어 전환 플래시 레이블 ─────────────────────────────────────────────
function _flashLayerLabel(text, color) {
  let el = document.getElementById('layer-flash-label');
  if (!el) {
    el = document.createElement('div');
    el.id = 'layer-flash-label';
    el.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      font-size:28px; font-weight:800; letter-spacing:3px;
      pointer-events:none; z-index:500;
      text-shadow: 0 0 30px currentColor;
      opacity:0; transition:opacity 0.2s ease;
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.color = color;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

// ── TWEEN 루프 업데이트 (애니메이션 루프에서 호출) ──────────────────────────
function updateTweens() {
  if (window.TWEEN) window.TWEEN.update();
}
window.updateTweens = updateTweens;

// ── 뷰 전환 패치 (기존 loadTeamDemo / loadCompanyDemo 래핑) ──────────────
function patchViewTransitions() {
  const originalLoadTeam    = window.loadTeamDemo;
  const originalLoadCompany = window.loadCompanyDemo;
  const originalSetPersonal = window.setViewPersonal;

  window.loadTeamDemo = function() {
    transitionToTeam(() => {
      if (originalLoadTeam) originalLoadTeam.call(this);
    });
  };

  window.loadCompanyDemo = function() {
    transitionToCompany(() => {
      if (originalLoadCompany) originalLoadCompany.call(this);
    });
  };

  window.setViewPersonal = function() {
    transitionToPersonal(() => {
      if (originalSetPersonal) originalSetPersonal.call(this);
    });
  };

  console.log('[orbit3d-transitions] 뷰 전환 패치 완료');
}

// DOMContentLoaded 이후 패치 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(patchViewTransitions, 800));
} else {
  setTimeout(patchViewTransitions, 800);
}

// 전역 노출
window.transitionCamera     = transitionCamera;
window.transitionToPersonal = transitionToPersonal;
window.transitionToTeam     = transitionToTeam;
window.transitionToCompany  = transitionToCompany;
window.transitionToDrilldown = transitionToDrilldown;
window.CAMERA_PRESETS       = CAMERA_PRESETS;

console.log('[orbit3d-transitions] TWEEN 카메라 전환 모듈 로드됨');
