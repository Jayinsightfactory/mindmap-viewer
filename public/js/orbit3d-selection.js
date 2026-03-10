/**
 * ══════════════════════════════════════════════════════════════════════════════
 * Orbit AI — 3D 노드 선택 및 레이아웃 시스템
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 기능:
 * 1. 노드 클릭 → 선택 상태 변경
 * 2. 카메라 애니메이션 (전체 뷰 → 선택 뷰)
 * 3. 패널 레이아웃 (왼쪽: 선택, 오른쪽/상단/하단: 하위 노드)
 * 4. 줌인/줌아웃 최적화
 */

class SelectionLayoutManager {
  constructor() {
    this.selectedNode = null;
    this.selectedNodeData = null;
    this.selectionStack = []; // 네비게이션 히스토리
    this.isAnimating = false;
    this.panelOpen = false;
    this.panelWidth = 320; // 왼쪽/오른쪽 패널 너비
    this.camera = null;
    this.scene = null;

    // 지연 초기화: camera와 scene이 로드될 때까지 대기
    this.waitForThreeJS();
    this.initPanels();
    this.setupEventListeners();
  }

  /**
   * Three.js 객체(camera, scene)가 로드될 때까지 대기
   */
  waitForThreeJS() {
    let attempts = 0;
    const check = setInterval(() => {
      // window 객체에 할당된 camera/scene이 있는지 확인
      if (typeof camera !== 'undefined' && typeof scene !== 'undefined') {
        this.camera = camera;
        this.scene = scene;
        console.log('[orbit3d-selection] Three.js 객체 로드 완료');
        clearInterval(check);
      } else if (attempts++ > 50) {
        console.warn('[orbit3d-selection] Three.js 객체를 찾을 수 없음. 스크립트 로드 순서 확인 필요');
        clearInterval(check);
      }
    }, 100);
  }

  /**
   * HTML 패널 요소 초기화
   */
  initPanels() {
    // 패널이 없으면 생성
    if (!document.getElementById('selection-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'selection-overlay';
      overlay.className = 'sel-overlay';
      overlay.innerHTML = `
        <!-- 왼쪽 패널: 선택된 노드 정보 -->
        <div class="sel-panel sel-left">
          <button class="sel-back-btn" onclick="selectionMgr.goBack()" title="뒤로">← 뒤로</button>
          <button class="sel-close-btn" onclick="selectionMgr.closeSelection()" title="닫기">✕</button>

          <div class="sel-node-info" id="sel-node-info">
            <div class="sel-title" id="sel-title">선택됨</div>
            <div class="sel-subtitle" id="sel-subtitle"></div>
            <div class="sel-badges" id="sel-badges"></div>
            <div class="sel-meta" id="sel-meta"></div>
          </div>

          <!-- 협업자 (상단) -->
          <div class="sel-collaborators-top">
            <div class="sel-label">🤝 팀원</div>
            <div class="sel-collaborators-list" id="sel-collab-top"></div>
          </div>
        </div>

        <!-- 오른쪽 패널: 하위 노드들 -->
        <div class="sel-panel sel-right">
          <div class="sel-label">📋 항목</div>
          <div class="sel-items" id="sel-items"></div>
        </div>

        <!-- 상단 협업자 -->
        <div class="sel-panel sel-top">
          <div class="sel-label">👥 같은 팀</div>
          <div class="sel-collaborators-grid" id="sel-collab-same"></div>
        </div>

        <!-- 하단 협업자 -->
        <div class="sel-panel sel-bottom">
          <div class="sel-label">🔗 협업자</div>
          <div class="sel-collaborators-grid" id="sel-collab-other"></div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
  }

  /**
   * 이벤트 리스너 설정
   */
  setupEventListeners() {
    document.addEventListener('click', (e) => {
      // 패널 외부 클릭 시 선택 해제
      const overlay = document.getElementById('selection-overlay');
      if (overlay && e.target === overlay) {
        this.closeSelection();
      }
    });

    // 휠 스크롤에서 카메라 줌 제어
    window.addEventListener('wheel', (e) => {
      if (this.panelOpen && this.isAnimating) {
        e.preventDefault();
      }
    });

    // ESC 키: 선택 해제
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panelOpen) {
        this.closeSelection();
      }
    });
  }

  /**
   * 노드 선택
   * @param {Object} node - Three.js Object3D 노드
   * @param {Object} nodeData - 노드 데이터 (id, name, type, children, collaborators)
   */
  selectNode(node, nodeData) {
    if (this.isAnimating) return;
    this.isAnimating = true;

    // 스택에 현재 선택 추가
    if (this.selectedNode) {
      this.selectionStack.push({
        node: this.selectedNode,
        data: this.selectedNodeData,
        cameraPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      });
    }

    this.selectedNode = node;
    this.selectedNodeData = nodeData;
    this.panelOpen = true;

    // UI 업데이트
    this.updateLeftPanel(nodeData);
    this.updateRightPanel(nodeData.children || []);
    this.updateCollaboratorsPanel(nodeData);

    // 카메라 애니메이션
    this.animateCamera(node);

    // 노드 하이라이트
    this.highlightNode(node);

    // 패널 표시
    const overlay = document.getElementById('selection-overlay');
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'auto';
    overlay.style.display = 'flex';
    setTimeout(() => {
      overlay.style.opacity = '1';
    }, 50);

    setTimeout(() => {
      this.isAnimating = false;
    }, 600);
  }

  /**
   * 왼쪽 패널 업데이트: 선택된 노드 정보
   */
  updateLeftPanel(nodeData) {
    const title = document.getElementById('sel-title');
    const subtitle = document.getElementById('sel-subtitle');
    const badges = document.getElementById('sel-badges');
    const meta = document.getElementById('sel-meta');

    title.textContent = nodeData.name || '노드';
    subtitle.textContent = nodeData.type || '';

    // 뱃지 (신뢰도, 상태 등)
    let badgeHTML = '';
    if (nodeData.reliability) {
      const stars = Math.round(nodeData.reliability / 20);
      badgeHTML += `<span class="sel-badge">⭐ ${'⭐'.repeat(stars)}</span>`;
    }
    if (nodeData.status) {
      badgeHTML += `<span class="sel-badge">${nodeData.status}</span>`;
    }
    badges.innerHTML = badgeHTML;

    // 메타데이터
    let metaHTML = '';
    if (nodeData.department) metaHTML += `<div>📍 부서: ${nodeData.department}</div>`;
    if (nodeData.team) metaHTML += `<div>👥 팀: ${nodeData.team}</div>`;
    if (nodeData.duration) metaHTML += `<div>⏱️ 기간: ${nodeData.duration}</div>`;
    if (nodeData.progress !== undefined) metaHTML += `<div>📊 진행률: ${nodeData.progress}%</div>`;
    meta.innerHTML = metaHTML;
  }

  /**
   * 오른쪽 패널 업데이트: 하위 노드 목록
   */
  updateRightPanel(children) {
    const itemsContainer = document.getElementById('sel-items');

    if (!children || children.length === 0) {
      itemsContainer.innerHTML = '<div class="sel-empty">항목 없음</div>';
      return;
    }

    // 그리드 레이아웃 (3열)
    itemsContainer.innerHTML = children.map((child, idx) => `
      <div class="sel-item" onclick="selectionMgr.selectNode(null, ${JSON.stringify(child)})">
        <div class="sel-item-icon">${child.icon || '◆'}</div>
        <div class="sel-item-name">${child.name}</div>
        <div class="sel-item-sub">${child.subtitle || ''}</div>
      </div>
    `).join('');
  }

  /**
   * 협업자 패널 업데이트
   */
  updateCollaboratorsPanel(nodeData) {
    const sameTeam = nodeData.collaborators?.sameTeam || [];
    const otherTeam = nodeData.collaborators?.otherTeam || [];

    // 상단: 같은 팀
    const topEl = document.getElementById('sel-collab-same');
    topEl.innerHTML = sameTeam.map(collab => `
      <div class="sel-collab" onclick="selectionMgr.selectNode(null, ${JSON.stringify(collab)})">
        <div class="sel-collab-avatar">${collab.avatar || collab.name?.[0] || '?'}</div>
        <div class="sel-collab-name">${collab.name}</div>
      </div>
    `).join('');

    // 하단: 다른 팀
    const bottomEl = document.getElementById('sel-collab-other');
    bottomEl.innerHTML = otherTeam.map(collab => `
      <div class="sel-collab" onclick="selectionMgr.selectNode(null, ${JSON.stringify(collab)})">
        <div class="sel-collab-avatar">${collab.avatar || collab.name?.[0] || '?'}</div>
        <div class="sel-collab-name">${collab.name}</div>
      </div>
    `).join('');
  }

  /**
   * 카메라 애니메이션: 줌인 + 위치 이동
   */
  animateCamera(node) {
    if (!node || !node.position || !this.camera) {
      console.warn('Invalid node or camera not ready');
      return;
    }

    const targetPos = node.position.clone();
    const distance = 3; // 노드로부터 거리

    // 카메라 목표 위치 계산
    const direction = new THREE.Vector3(0, 0, 1).normalize();
    const cameraTarget = targetPos.clone().add(
      direction.multiplyScalar(distance)
    );

    // TWEEN으로 스무스한 애니메이션
    if (typeof TWEEN !== 'undefined' && this.camera) {
      const start = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
      new TWEEN.Tween(start)
        .to(cameraTarget, 600)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => {
          this.camera.position.set(start.x, start.y, start.z);
          this.camera.lookAt(targetPos);
        })
        .start();
    } else if (this.camera) {
      // TWEEN 없으면 즉시 이동
      this.camera.position.copy(cameraTarget);
      this.camera.lookAt(targetPos);
    }
  }

  /**
   * 노드 하이라이트
   */
  highlightNode(node) {
    if (!node) return;

    // 기존 하이라이트 제거
    this.clearHighlight();

    // 새로운 하이라이트 추가
    if (node.material) {
      node.material.emissive.setHex(0x00ffff);
      node.material.emissiveIntensity = 0.5;
    }

    // 아우라 이펙트 (스케일 애니메이션)
    if (node.scale) {
      const originalScale = { x: node.scale.x, y: node.scale.y, z: node.scale.z };
      if (typeof TWEEN !== 'undefined') {
        new TWEEN.Tween(node.scale)
          .to({ x: node.scale.x * 1.2, y: node.scale.y * 1.2, z: node.scale.z * 1.2 }, 400)
          .easing(TWEEN.Easing.Cubic.Out)
          .start();
      }
    }
  }

  /**
   * 하이라이트 제거
   */
  clearHighlight() {
    if (this.selectedNode && this.selectedNode.material) {
      this.selectedNode.material.emissive.setHex(0x000000);
      this.selectedNode.material.emissiveIntensity = 0;
    }
  }

  /**
   * 선택 해제
   */
  closeSelection() {
    this.panelOpen = false;
    this.clearHighlight();

    // 패널 숨기기
    const overlay = document.getElementById('selection-overlay');
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 300);

    // 카메라를 원래 위치로 (줌아웃)
    this.resetCamera();

    this.selectedNode = null;
    this.selectedNodeData = null;
  }

  /**
   * 뒤로 가기
   */
  goBack() {
    if (this.selectionStack.length === 0) {
      this.closeSelection();
      return;
    }

    const prev = this.selectionStack.pop();
    this.selectedNode = prev.node;
    this.selectedNodeData = prev.data;

    // UI 업데이트
    this.updateLeftPanel(prev.data);
    this.updateRightPanel(prev.data.children || []);
    this.updateCollaboratorsPanel(prev.data);

    // 카메라 복원
    if (prev.cameraPos) {
      camera.position.set(prev.cameraPos.x, prev.cameraPos.y, prev.cameraPos.z);
    }
  }

  /**
   * 카메라 리셋 (초기 상태로)
   */
  resetCamera() {
    if (!this.camera) return;

    if (typeof TWEEN !== 'undefined') {
      const start = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
      const target = { x: 0, y: 0, z: 15 };
      new TWEEN.Tween(start)
        .to(target, 600)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => {
          this.camera.position.set(start.x, start.y, start.z);
          this.camera.lookAt(0, 0, 0);
        })
        .start();
    } else {
      this.camera.position.set(0, 0, 15);
      this.camera.lookAt(0, 0, 0);
    }
  }

  /**
   * Breadcrumb 네비게이션 표시
   */
  getBreadcrumb() {
    const path = [];
    for (let i = 0; i < this.selectionStack.length; i++) {
      path.push(this.selectionStack[i].data.name);
    }
    if (this.selectedNodeData) {
      path.push(this.selectedNodeData.name);
    }
    return path.join(' > ');
  }
}

// 전역 인스턴스
window.selectionMgr = new SelectionLayoutManager();
const selectionMgr = window.selectionMgr;

console.log('[orbit3d-selection] Selection manager 인스턴스 생성됨');

/**
 * 편의 함수: 노드 클릭 시 호출
 * (orbit3d-render.js에서 호출)
 */
function onNodeClicked(node, nodeData) {
  if (window.selectionMgr) {
    window.selectionMgr.selectNode(node, nodeData);
  }
}
