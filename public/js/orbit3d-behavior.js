// ══════════════════════════════════════════════════════════════════════════════
// orbit3d-behavior.js
// 행동 데이터 → 3D 시각화 매핑 모듈
// 키보드 활동 강도 → 노드 글로우/회전 속도
// 프로그램 포커스 시간 → 노드 색상 온도
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

// ── 행동 상태 추적 ──────────────────────────────────────────────────────────
const _behavior = {
  keyCount:       0,          // 단위시간 키입력 수
  clickCount:     0,          // 단위시간 클릭 수
  focusProgram:   null,       // 현재 포커스 프로그램
  activityScore:  0,          // 0~1 종합 활성도 스코어
  lastActivity:   Date.now(),
  history:        [],         // { ts, keyCount, clickCount, score }
};

// ── 활성도 측정 (페이지 이벤트 기반) ────────────────────────────────────────
let _keyBuffer  = 0;
let _clickBuffer = 0;
let _lastBatch  = Date.now();
const BATCH_MS  = 1000; // 1초 단위 집계

document.addEventListener('keydown', () => {
  _keyBuffer++;
  _behavior.lastActivity = Date.now();
}, { passive: true });

document.addEventListener('mousedown', () => {
  _clickBuffer++;
  _behavior.lastActivity = Date.now();
}, { passive: true });

// 1초마다 배치 집계 → 활성도 스코어 계산
setInterval(() => {
  const now    = Date.now();
  const dt     = (now - _lastBatch) / 1000;
  _lastBatch   = now;
  const kps    = _keyBuffer  / dt;  // keys per second
  const cps    = _clickBuffer / dt; // clicks per second
  _keyBuffer   = 0;
  _clickBuffer = 0;

  // 활성도 스코어: 키입력 가중치 0.7 + 클릭 가중치 0.3, 최대 포화 10kps/3cps
  const rawScore = Math.min(1, kps / 10) * 0.7 + Math.min(1, cps / 3) * 0.3;
  // 지수 이동 평균 (EMA α=0.3)
  _behavior.activityScore = _behavior.activityScore * 0.7 + rawScore * 0.3;
  _behavior.keyCount   = Math.round(kps);
  _behavior.clickCount = Math.round(cps);

  // 히스토리 기록 (최대 60개 = 1분)
  _behavior.history.push({ ts: now, kps, cps, score: _behavior.activityScore });
  if (_behavior.history.length > 60) _behavior.history.shift();
}, BATCH_MS);

// ── 비활성 감지 (30초 미입력 → 활성도 0으로 감소) ─────────────────────────
setInterval(() => {
  const idle = (Date.now() - _behavior.lastActivity) / 1000;
  if (idle > 30) {
    _behavior.activityScore *= 0.85; // 천천히 감소
  }
}, 2000);

// ── 3D 씬 시각화 매핑 ───────────────────────────────────────────────────────
/**
 * 현재 활성도 스코어를 Three.js 씬에 반영
 * - planetMeshes의 emissiveIntensity
 * - orbitRings의 rotation speed
 * - 별 배경의 opacity
 */
function applyBehaviorToScene() {
  const score  = _behavior.activityScore;
  const lerp   = (a, b, t) => a + (b - a) * t;

  // 행성 글로우 강도: 활성도 높을수록 밝게
  if (typeof planetMeshes !== 'undefined') {
    planetMeshes.forEach(m => {
      const mat = m.material;
      if (!mat) return;
      const base = m.userData._baseEmissive ?? mat.emissiveIntensity ?? 0.2;
      if (m.userData._baseEmissive === undefined) m.userData._baseEmissive = base;
      mat.emissiveIntensity = lerp(base * 0.6, base * 1.8, score);
    });
  }

  // 궤도 링 회전 속도 가중치 (orbit3d-animate에서 참조)
  window._behaviorOrbitSpeedMult = 1.0 + score * 1.5;

  // 코어 스킬 글로우 (MY CREATIVE CORE)
  if (typeof _coreSkillData !== 'undefined') {
    _coreSkillData.forEach((sk, i) => {
      if (!sk.mesh || !sk.mesh.material) return;
      sk.mesh.material.emissiveIntensity = lerp(0.3, 1.2, score) + 0.2 * Math.sin(Date.now() * 0.002 + i);
    });
  }
}
window.applyBehaviorToScene = applyBehaviorToScene;
window._behavior = _behavior;

// ── 활성도 UI 표시 (HUD 하단 작은 바) ─────────────────────────────────────
function renderActivityBar() {
  let bar = document.getElementById('activity-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'activity-bar';
    bar.style.cssText = `
      position:fixed; bottom:8px; left:50%; transform:translateX(-50%);
      width:120px; height:4px; border-radius:2px;
      background:rgba(0,200,255,0.1); z-index:99;
      overflow:hidden; pointer-events:none;
    `;
    const fill = document.createElement('div');
    fill.id = 'activity-bar-fill';
    fill.style.cssText = `
      height:100%; width:0%; border-radius:2px;
      background:linear-gradient(90deg,#00c8ff,#a855f7);
      transition:width 0.3s ease;
      box-shadow: 0 0 8px rgba(0,200,255,0.6);
    `;
    bar.appendChild(fill);
    document.body.appendChild(bar);
  }
  const fill = document.getElementById('activity-bar-fill');
  if (fill) fill.style.width = (_behavior.activityScore * 100).toFixed(0) + '%';
}

// ── 주기적 씬 업데이트 ─────────────────────────────────────────────────────
setInterval(() => {
  applyBehaviorToScene();
  renderActivityBar();
}, 500);

// ── 서버 동기화 (10초마다 행동 스냅샷을 /api/behavior/sync 에 POST) ─────────
let _behaviorSyncFail = 0;
setInterval(async () => {
  if (_behaviorSyncFail > 5) return; // 연속 실패 시 중단
  try {
    const token = typeof _getAuthToken === 'function' ? _getAuthToken() : (localStorage.getItem('orbit_token') || '');
    const payload = {
      score:     _behavior.activityScore,
      kps:       _behavior.keyCount,
      cps:       _behavior.clickCount,
      sessionId: (typeof _currentSessionId !== 'undefined') ? _currentSessionId : null,
      history:   _behavior.history.slice(-6),
    };
    const res = await fetch('/api/behavior/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5000),
    });
    if (res.ok) _behaviorSyncFail = 0;
    else _behaviorSyncFail++;
  } catch { _behaviorSyncFail++; }
}, 10000);

// ── WebSocket 행동 스코어 수신 (서버 → 다른 사용자 행동 반영) ──────────────
if (typeof window !== 'undefined') {
  window.addEventListener('orbit-ws-message', (e) => {
    const msg = e?.detail;
    if (!msg || msg.type !== 'behavior_score') return;
    // 다른 사용자의 활동을 글로우로 반영할 수 있음 (미래 확장)
    window._remoteBehaviorScores = window._remoteBehaviorScores || {};
    window._remoteBehaviorScores[msg.uid] = { score: msg.score, ts: msg.ts };
  });
}

console.log('[orbit3d-behavior] 행동 → 시각화 매핑 모듈 로드됨');
