/**
 * ══════════════════════════════════════════════════════════════════════════════
 * Orbit AI — 히스토리 팝업 시스템
 * 노드 선택 시 작업 히스토리 타임라인 표시
 * ══════════════════════════════════════════════════════════════════════════════
 */

let currentHistoryNode = null;
let currentHistoryEvents = [];
let selectedEventIndex = -1;

/**
 * 히스토리 팝업 표시
 */
async function showHistoryPopup(nodeData) {
  console.log('📊 히스토리 팝업 열기:', nodeData.name);
  
  currentHistoryNode = nodeData;
  selectedEventIndex = -1;

  // 팝업과 오버레이 표시
  const overlay = document.getElementById('history-overlay');
  const modal = document.getElementById('history-modal');
  const titleEl = document.getElementById('history-node-name');
  
  if (!overlay || !modal) {
    console.error('History popup elements not found');
    return;
  }

  // 노드명 설정
  titleEl.textContent = nodeData.name || '작업 히스토리';

  // 오버레이와 모달 표시
  overlay.classList.add('show');
  modal.classList.add('show');

  // 이벤트 로드
  await loadHistoryEvents(nodeData.id);
}

/**
 * 히스토리 팝업 닫기
 */
function closeHistoryPopup() {
  console.log('📊 히스토리 팝업 닫기');
  
  const overlay = document.getElementById('history-overlay');
  const modal = document.getElementById('history-modal');

  if (overlay) overlay.classList.remove('show');
  if (modal) modal.classList.remove('show');

  // 애니메이션 완료 후 상태 초기화
  setTimeout(() => {
    currentHistoryNode = null;
    currentHistoryEvents = [];
    selectedEventIndex = -1;
    clearHistoryDetail();
  }, 300);
}

/**
 * 히스토리 이벤트 로드
 */
async function loadHistoryEvents(nodeId) {
  const eventsList = document.getElementById('history-events-list');
  
  if (!eventsList) return;

  // 로딩 상태
  eventsList.innerHTML = '<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">이벤트 로딩 중...</div>';

  try {
    // API에서 이벤트 로드 (또는 더미 데이터 사용)
    const response = await fetch(`/api/graph/nodeHistory?nodeId=${encodeURIComponent(nodeId)}`);
    
    if (!response.ok) {
      throw new Error(`Failed to load history: ${response.status}`);
    }

    const data = await response.json();
    currentHistoryEvents = Array.isArray(data) ? data : (data.events || []);

    // 타임라인이 없으면 더미 데이터 사용
    if (currentHistoryEvents.length === 0) {
      currentHistoryEvents = generateDummyHistoryEvents(currentHistoryNode);
    }

    renderHistoryTimeline();
  } catch (error) {
    console.error('Error loading history:', error);
    
    // 더미 데이터로 폴백
    console.log('Using dummy history events');
    currentHistoryEvents = generateDummyHistoryEvents(currentHistoryNode);
    renderHistoryTimeline();
  }
}

/**
 * 더미 히스토리 이벤트 생성 (API 없을 때)
 */
function generateDummyHistoryEvents(nodeData) {
  const now = new Date();
  
  return [
    {
      id: 'event_1',
      timestamp: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      action: '작업 시작',
      title: '프로젝트 초기화',
      status: '완료',
      description: '프로젝트 기본 구조 설정 및 초기 분석',
      analysis: '초기 진단 완료. 18개 모듈 식별됨. 의존성 분석 완료.',
      icon: '🚀',
      progress: 10,
      metadata: {
        duration: '2시간 30분',
        completionRate: 100,
        issues: 0
      }
    },
    {
      id: 'event_2',
      timestamp: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      action: '미팅 진행',
      title: '팀 회의 - 요구사항 정의',
      status: '완료',
      description: '팀원들과 함께 프로젝트 요구사항 논의 및 마일스톤 수립',
      analysis: '팀 합의 완료. 5개 마일스톤 정의. 리소스 할당 완료.',
      icon: '👥',
      progress: 25,
      metadata: {
        duration: '1시간',
        participants: 5,
        decisions: 3
      }
    },
    {
      id: 'event_3',
      timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      action: '개발 진행',
      title: '핵심 모듈 개발',
      status: '진행중',
      description: '주요 기능 모듈 구현 중. 현재 60% 완료.',
      analysis: '2개 모듈 완성. 1개 모듈 진행 중 (진행률 60%). 테스트 대기 중.',
      icon: '🔧',
      progress: 60,
      metadata: {
        duration: '24시간 (누적)',
        completionRate: 60,
        issues: 2
      }
    },
    {
      id: 'event_4',
      timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      action: '테스트 및 검증',
      title: '단위 테스트 수행',
      status: '진행중',
      description: '개발된 모듈에 대한 단위 테스트 진행 중',
      analysis: '12개 테스트 케이스 작성. 10개 통과, 2개 실패. 실패 원인 분석 중.',
      icon: '✅',
      progress: 75,
      metadata: {
        duration: '8시간 (누적)',
        testCases: 12,
        passRate: 83.3
      }
    },
    {
      id: 'event_5',
      timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      action: '최종 검토',
      title: '코드 리뷰 및 최적화',
      status: '진행중',
      description: '팀 리더와 코드 리뷰 진행. 최적화 사항 파악.',
      analysis: '3개 이슈 발견. 2개는 중요도 낮음. 1개는 보안 관련 필수 수정.',
      icon: '🔍',
      progress: 85,
      metadata: {
        duration: '2시간',
        issuesFound: 3,
        criticalIssues: 1
      }
    }
  ];
}

/**
 * 히스토리 타임라인 렌더링
 */
function renderHistoryTimeline() {
  const eventsList = document.getElementById('history-events-list');
  
  if (!eventsList) return;

  if (currentHistoryEvents.length === 0) {
    eventsList.innerHTML = '<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">이벤트가 없습니다</div>';
    return;
  }

  // 시간순 정렬 (최신순)
  const sorted = [...currentHistoryEvents].sort((a, b) => {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  // HTML 생성
  const html = sorted.map((event, idx) => {
    const time = new Date(event.timestamp);
    const timeStr = formatEventTime(time);
    
    return `
      <div class="history-event ${idx === selectedEventIndex ? 'active' : ''}" 
           data-index="${currentHistoryEvents.findIndex(e => e.id === event.id)}"
           onclick="selectHistoryEvent(${currentHistoryEvents.findIndex(e => e.id === event.id)})">
        <div class="history-event-marker">${idx + 1}</div>
        <div class="history-event-info">
          <div class="history-event-time">${timeStr}</div>
          <div class="history-event-title">${event.title || event.action}</div>
          <div class="history-event-status">
            ${event.icon ? event.icon + ' ' : ''}${event.status || '진행중'}
          </div>
        </div>
      </div>
    `;
  }).join('');

  eventsList.innerHTML = html;
}

/**
 * 이벤트 선택
 */
function selectHistoryEvent(index) {
  if (index < 0 || index >= currentHistoryEvents.length) return;

  selectedEventIndex = index;
  const event = currentHistoryEvents[index];

  // 타임라인 UI 업데이트
  const events = document.querySelectorAll('.history-event');
  events.forEach((el, idx) => {
    const eventIndex = parseInt(el.dataset.index);
    if (eventIndex === index) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // 상세 정보 표시
  showHistoryDetail(event);
}

/**
 * 히스토리 상세 정보 표시
 */
function showHistoryDetail(event) {
  const titleEl = document.getElementById('history-detail-title');
  const timeEl = document.getElementById('history-detail-time');
  const contentEl = document.getElementById('history-detail-content');

  if (!titleEl || !timeEl || !contentEl) return;

  // 시간 포맷
  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // 제목과 시간 설정
  titleEl.textContent = event.title || event.action || '이벤트';
  timeEl.textContent = timeStr;

  // 상세 내용 생성
  const html = `
    <div class="history-detail-field">
      <div class="history-detail-label">📋 설명</div>
      <div class="history-detail-value">${event.description || '설명이 없습니다'}</div>
    </div>

    <div class="history-detail-field">
      <div class="history-detail-label">🎯 분석 결과</div>
      <div class="history-detail-value">${event.analysis || '분석 결과가 없습니다'}</div>
    </div>

    ${event.progress !== undefined ? `
    <div class="history-detail-field">
      <div class="history-detail-label">⏳ 진행률</div>
      <div class="history-detail-value">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden">
            <div style="width:${event.progress}%;height:100%;background:#3a7bd5;transition:width 0.3s"></div>
          </div>
          <span style="font-weight:600;color:#58a6ff">${event.progress}%</span>
        </div>
      </div>
    </div>
    ` : ''}

    ${event.metadata ? `
    <div class="history-detail-field">
      <div class="history-detail-label">📊 메타데이터</div>
      <div class="history-detail-value">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
          ${Object.entries(event.metadata).map(([key, value]) => `
            <div style="padding:6px;background:#1e293b;border-radius:4px">
              <div style="color:#94a3b8;font-size:10px;margin-bottom:2px">${key}</div>
              <div style="color:#cbd5e1;font-weight:500">${formatMetadata(value)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    ` : ''}

    <div class="history-detail-field">
      <div class="history-detail-label">✨ 상태</div>
      <div class="history-detail-value">
        <span style="display:inline-block;padding:4px 8px;background:${getStatusColor(event.status)};border-radius:4px;font-size:12px;font-weight:600">
          ${event.status || '진행중'}
        </span>
      </div>
    </div>
  `;

  contentEl.innerHTML = html;

  // 액션 버튼 활성화 상태 설정
  const editBtn = document.getElementById('history-edit-btn');
  const restartBtn = document.getElementById('history-restart-btn');

  if (editBtn && restartBtn) {
    editBtn.disabled = false;
    restartBtn.disabled = false;
  }
}

/**
 * 히스토리 상세 정보 초기화
 */
function clearHistoryDetail() {
  const contentEl = document.getElementById('history-detail-content');
  const titleEl = document.getElementById('history-detail-title');
  const timeEl = document.getElementById('history-detail-time');

  if (contentEl) {
    contentEl.innerHTML = '<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">타임라인에서 항목을 선택하세요</div>';
  }
  if (titleEl) titleEl.textContent = '작업 상세 정보';
  if (timeEl) timeEl.textContent = '';
}

/**
 * 히스토리 항목 수정
 */
function editHistoryItem() {
  if (selectedEventIndex < 0 || selectedEventIndex >= currentHistoryEvents.length) {
    alert('수정할 항목을 선택하세요');
    return;
  }

  const event = currentHistoryEvents[selectedEventIndex];
  console.log('🖊️ 항목 수정:', event.id);

  // 수정 모드 진입 (실제 구현 필요)
  alert(`"${event.title}" 항목을 수정합니다.\n\n(실제 수정 UI는 추후 구현)`);
}

/**
 * 히스토리 항목부터 재시작
 */
function restartFromHistoryItem() {
  if (selectedEventIndex < 0 || selectedEventIndex >= currentHistoryEvents.length) {
    alert('재시작할 항목을 선택하세요');
    return;
  }

  const event = currentHistoryEvents[selectedEventIndex];
  console.log('🔄 재시작:', event.id);

  if (confirm(`"${event.title}" 부터 다시 시작하시겠습니까?\n\n이전 작업 내용은 보존됩니다.`)) {
    // 재시작 로직 (실제 구현 필요)
    alert(`재시작 요청 완료.\n\n(실제 재시작 처리는 추후 구현)`);
  }
}

/**
 * 이벤트 시간 포맷 (타임라인용)
 */
function formatEventTime(date) {
  const now = new Date();
  const diff = now - date;

  // 밀리초를 날짜 단위로 변환
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor(diff / (1000 * 60));

  if (days > 0) {
    return `${days}일 전`;
  } else if (hours > 0) {
    return `${hours}시간 전`;
  } else if (minutes > 0) {
    return `${minutes}분 전`;
  } else {
    return '방금 전';
  }
}

/**
 * 메타데이터 포맷
 */
function formatMetadata(value) {
  if (typeof value === 'number') {
    if (value > 1000) {
      return (value / 1000).toFixed(1) + 'K';
    }
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? '예' : '아니오';
  }
  return value.toString();
}

/**
 * 상태별 배경색
 */
function getStatusColor(status) {
  const colors = {
    '완료': '#10b981',
    '진행중': '#f59e0b',
    '대기': '#6366f1',
    '실패': '#ef4444',
    '취소': '#64748b'
  };
  
  return colors[status] || '#3a7bd5';
}

// 스크립트 로드 완료
console.log('[orbit3d-history] History popup system initialized');

// 글로벌 함수 노출
window.showHistoryPopup = showHistoryPopup;
window.closeHistoryPopup = closeHistoryPopup;
window.selectHistoryEvent = selectHistoryEvent;
window.editHistoryItem = editHistoryItem;
window.restartFromHistoryItem = restartFromHistoryItem;
