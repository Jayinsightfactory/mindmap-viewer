/**
 * orbit3d-renderer-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 렌더러 충돌 해결 — 모드 전환 시 이전 렌더러를 완전히 정리하고 다음 렌더러를 활성화
 *
 * 지원 모드:
 *   'personal'  — mywork-renderer.js  (buildPlanetSystem)
 *   'team'      — orbit3d-team.js     (buildTeamSystem / buildMultiHubSystem)
 *   'company'   — orbit3d-team.js     (buildCompanySystem)
 *   'workspace' — orbit3d-multilevel-renderer.js (initWorkspaceMode)
 *
 * 사용법:
 *   window.RendererManager.switchTo('workspace', { workspaceId: 'xxx', scene })
 *   window.RendererManager.switchTo('personal')
 *   window.RendererManager.currentMode  // 현재 모드 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ─── 내부 상태 ──────────────────────────────────────────────────────────────
  let _currentMode = 'personal';  // 초기값 personal (null이면 모드 검사 실패)
  let _switching   = false;  // 전환 중 중복 호출 방지

  // ─── MyWork 렌더러 정리 ──────────────────────────────────────────────────────
  function _cleanupMyWork() {
    try {
      if (typeof clearMyWork === 'function') clearMyWork();
      if (typeof clearAllPlanets === 'function') clearAllPlanets();
      // MW 내부 상태도 초기화
      if (window.MW) {
        window.MW.cardMeshes  = window.MW.cardMeshes  || [];
        window.MW.lineMeshes  = window.MW.lineMeshes  || [];
        window.MW.viewStack   = [];
      }
      console.log('[RendererManager] MyWork cleanup 완료');
    } catch (e) {
      console.warn('[RendererManager] MyWork cleanup 오류:', e.message);
    }
  }

  // ─── Multilevel/Workspace 렌더러 정리 ────────────────────────────────────────
  function _cleanupMultilevel() {
    try {
      const mlr = window.multiLevelRenderer;
      const sc  = window.scene;
      if (!mlr) return;

      // 노드 메시 제거
      Object.values(mlr.nodeMeshes || {}).forEach(mesh => {
        if (sc) sc.remove(mesh);
        mesh.traverse(child => {
          if (child.geometry)  child.geometry.dispose();
          if (child.material) {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
          }
        });
      });
      mlr.nodeMeshes = {};

      // 연결선 제거
      (mlr.connectionLines || []).forEach(line => {
        if (sc) sc.remove(line);
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
      });
      mlr.connectionLines = [];

      // billboard 콜백 해제
      mlr._updateCardBillboard = null;

      // 씬에 남은 multilevel 잔여 오브젝트 강제 제거
      // (PlaneGeometry 카드, 카드 그룹, isNode/isCard 플래그)
      if (sc) {
        const toRemove = [];
        sc.children.forEach(child => {
          if (child.userData && (child.userData.isNode || child.userData.isCard || child.userData.nodeId)) {
            toRemove.push(child);
          }
        });
        toRemove.forEach(obj => {
          sc.remove(obj);
          obj.traverse(c => {
            if (c.geometry)  c.geometry.dispose();
            if (c.material) {
              if (c.material.map) c.material.map.dispose();
              if (c.material.dispose) c.material.dispose();
            }
          });
        });
        if (toRemove.length > 0) {
          console.log(`[RendererManager] Multilevel 잔여 ${toRemove.length}개 오브젝트 강제 제거`);
        }
      }

      // 상태 초기화
      mlr.workspaceMode  = false;
      mlr.workspaceId    = null;
      mlr.currentLevel   = 0;
      mlr.userRole       = null;
      mlr.permissions    = null;
      mlr.selectedNodeId = null;
      mlr.currentNodes   = [];

      // 드릴 패널 닫기
      if (typeof closeDrillPanel === 'function') closeDrillPanel();

      console.log('[RendererManager] Multilevel cleanup 완료');
    } catch (e) {
      console.warn('[RendererManager] Multilevel cleanup 오류:', e.message);
    }
  }

  // ─── Team 렌더러 정리 ────────────────────────────────────────────────────────
  function _cleanupTeam() {
    try {
      // orbit3d-parallel.js 의 exitTeamMode 재사용
      if (typeof exitTeamMode === 'function') {
        exitTeamMode();
      } else {
        // 폴백: 팀 관련 scene 오브젝트 직접 제거
        const sc = window.scene;
        if (sc && window._teamNodes) {
          window._teamNodes.forEach(n => { if (n.mesh) sc.remove(n.mesh); });
          window._teamNodes = [];
        }
      }
      console.log('[RendererManager] Team cleanup 완료');
    } catch (e) {
      console.warn('[RendererManager] Team cleanup 오류:', e.message);
    }
  }

  // ─── 모드별 cleanup 맵 ──────────────────────────────────────────────────────
  const _cleanupMap = {
    personal:  _cleanupMyWork,
    team:      _cleanupTeam,
    company:   _cleanupTeam,
    workspace: _cleanupMultilevel,
  };

  // ─── 메인: 모드 전환 ─────────────────────────────────────────────────────────
  /**
   * @param {string} newMode - 'personal' | 'team' | 'company' | 'workspace'
   * @param {object} [params] - 모드별 파라미터
   *   workspace: { workspaceId, scene }
   */
  async function switchTo(newMode, params = {}) {
    if (_switching) {
      console.warn('[RendererManager] 이미 전환 중 — 무시됨');
      return;
    }

    if (_currentMode === newMode && newMode !== 'workspace') {
      console.log('[RendererManager] 이미 같은 모드:', newMode);
      return;
    }

    _switching = true;
    console.log(`[RendererManager] 모드 전환: ${_currentMode || 'none'} → ${newMode}`);

    try {
      // 1. 현재 모드 정리
      if (_currentMode && _cleanupMap[_currentMode]) {
        _cleanupMap[_currentMode]();
      }

      // 2. 모드 변경
      _currentMode = newMode;

      // 3. 브레드크럼 + 버튼 상태 업데이트
      _updateNavUI(newMode);

    } catch (e) {
      console.error('[RendererManager] 전환 오류:', e.message);
    } finally {
      _switching = false;
    }
  }

  // ─── 강제 cleanup: 특정 모드를 명시적으로 정리 ─────────────────────────────
  function cleanup(mode) {
    const fn = _cleanupMap[mode];
    if (fn) fn();
  }

  // ─── 모드 라벨만 변경 (cleanup 없이) — drill-down 등 내부 전환용 ──────────
  function setModeLabel(mode) {
    _currentMode = mode;
  }

  // ─── nav 버튼 UI 업데이트 ───────────────────────────────────────────────────
  function _updateNavUI(mode) {
    try {
      const map = {
        personal:  'lni-personal',
        team:      'lni-team',
        company:   'lni-company',
        workspace: 'lni-workspace',
      };
      ['lni-personal','lni-team','lni-company','lni-workspace'].forEach(id => {
        document.getElementById(id)?.classList.remove('active');
      });
      if (map[mode]) {
        document.getElementById(map[mode])?.classList.add('active');
      }
    } catch {}
  }

  // ─── 전역 노출 ──────────────────────────────────────────────────────────────
  window.RendererManager = {
    switchTo,
    cleanup,
    cleanupMultilevel: _cleanupMultilevel,
    cleanupMyWork:     _cleanupMyWork,
    setModeLabel,
    get currentMode()  { return _currentMode; },
  };

  console.log('[RendererManager] 초기화 완료');
})();
