/**
 * ══════════════════════════════════════════════════════════════════════════════
 * Orbit AI — 3D 상호작용 시스템 (클릭, 마우스오버 등)
 * ══════════════════════════════════════════════════════════════════════════════
 */

// Raycaster 초기화 (Three.js 로드 후)
let raycaster = null;
const mouse = new THREE.Vector2();

// 클릭 가능한 객체 추적
const interactiveObjects = new Map();

// Three.js 객체 초기화 대기 (window.camera/scene에서 참조)
function getCamera() { return window.camera || null; }
function getScene() { return window.scene || null; }

function ensureRaycaster() {
  if (!raycaster && typeof THREE !== 'undefined') {
    raycaster = new THREE.Raycaster();
    console.log('[orbit3d-interaction] Raycaster 초기화 완료');
  }
}

/**
 * 객체를 클릭 가능하게 등록
 * @param {THREE.Object3D} obj - Three.js 객체
 * @param {Object} data - 연결 데이터
 */
function registerInteractive(obj, data) {
  interactiveObjects.set(obj, data);
  obj.userData._interactive = true;
}

// 전역 노출
window.registerInteractive = registerInteractive;
window.unregisterInteractive = unregisterInteractive;
console.log('[orbit3d-interaction] registerInteractive/unregisterInteractive exposed to window');

/**
 * 객체 등록 해제
 */
function unregisterInteractive(obj) {
  interactiveObjects.delete(obj);
  if (obj.userData) delete obj.userData._interactive;
}

document.addEventListener('click', (event) => {
  // 드래그 체크 (animate.js의 _mouseDownPos 사용)
  if (typeof _mouseDownPos !== 'undefined' && _mouseDownPos) {
    const dx = Math.abs(event.clientX - _mouseDownPos.x);
    const dy = Math.abs(event.clientY - _mouseDownPos.y);
    if (dx > 5 || dy > 5) return;
  }

  ensureRaycaster();
  const cam = getCamera();
  if (!raycaster || !cam) return;

  // 패널이나 버튼 등 UI 요소 클릭 무시
  if (event.target.closest('.sel-panel') ||
      event.target.closest('button') ||
      event.target.closest('input') ||
      event.target.closest('#left-nav')) {
    return;
  }

  // 레이캐스팅으로 선택된 객체 찾기
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, cam);

  // 대화형 객체만 검사
  const interactiveArray = Array.from(interactiveObjects.keys());
  const intersects = raycaster.intersectObjects(interactiveArray, true);

  if (intersects.length > 0) {
    let clickedObj = intersects[0].object;

    // 부모 객체에서 등록된 데이터 찾기
    while (clickedObj && !interactiveObjects.has(clickedObj)) {
      clickedObj = clickedObj.parent;
    }

    if (clickedObj && interactiveObjects.has(clickedObj)) {
      // MW 카드는 mywork-renderer.js가 자체 클릭 핸들러로 처리
      if (clickedObj.userData && clickedObj.userData.isCard) return;
      const data = interactiveObjects.get(clickedObj);
      handleObjectClick(clickedObj, data);
    }
  }
});

/**
 * 객체 클릭 처리 - 히스토리 팝업 표시
 */
function handleObjectClick(obj, data) {
  console.log('Node clicked:', data);

  // 노드 데이터 포맷 정규화
  const nodeData = {
    id: data.id || 'node_' + Math.random().toString(36).substr(2, 9),
    name: data.name || data.label || 'Unnamed',
    type: data.type || 'node',
    subtitle: data.role || data.status || '',
    icon: data.icon || '◆',
    avatar: data.avatar || data.icon || '?',

    // 메타데이터
    department: data.department || data.team || '',
    team: data.team || '',
    duration: data.duration || '',
    progress: data.progress || 0,
    status: data.status || '',
    reliability: data.reliability || 80,

    // 자식 노드
    children: data.children || generateChildrenFromData(data),

    // 협업자
    collaborators: {
      sameTeam: data.sameTeam || data.teammates || [],
      otherTeam: data.otherTeam || data.collaborators || []
    }
  };

  // 히스토리 팝업 표시
  if (typeof showHistoryPopup === 'function') {
    showHistoryPopup(nodeData);
  }
}

/**
 * 데이터로부터 자식 노드 생성 (더미)
 */
function generateChildrenFromData(data) {
  if (!data.members) return [];

  return data.members.slice(0, 9).map((member, idx) => ({
    id: 'child_' + idx,
    name: member.name || `Member ${idx}`,
    icon: member.icon || '👤',
    subtitle: member.role || '',
    type: 'person'
  }));
}

/**
 * 마우스오버 - 하이라이트 준비
 */
document.addEventListener('mousemove', (event) => {
  ensureRaycaster();
  const cam = getCamera();
  if (!raycaster || !cam) return;
  if (typeof window.selectionMgr !== 'undefined' && window.selectionMgr && window.selectionMgr.panelOpen) return; // 선택 중에는 무시

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, cam);
  const interactiveArray = Array.from(interactiveObjects.keys());
  const intersects = raycaster.intersectObjects(interactiveArray, true);

  // 마우스오버 스타일 업데이트 (필요시)
  if (intersects.length > 0) {
    document.body.style.cursor = 'pointer';
  } else {
    document.body.style.cursor = 'default';
  }
});

/**
 * 글로벌 헬퍼 함수: 장면의 모든 노드를 대화형으로 만들기
 */
function makeSceneInteractive(group) {
  group.traverse((child) => {
    if (child.userData && child.userData.nodeData) {
      registerInteractive(child, child.userData.nodeData);
    }
  });
}

/**
 * 클릭 가능 여부 확인
 */
function isInteractive(obj) {
  return interactiveObjects.has(obj) || obj.userData._interactive;
}

/**
 * 모든 상호작용 비활성화 (선택 시)
 */
function disableInteraction() {
  raycaster.enabled = false;
}

/**
 * 모든 상호작용 활성화
 */
function enableInteraction() {
  raycaster.enabled = true;
}

// 스크립트 로드 완료 확인
console.log('[orbit3d-interaction] Script fully loaded and initialized');
