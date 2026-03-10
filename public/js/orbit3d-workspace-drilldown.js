/**
 * orbit3d-workspace-drilldown.js
 * 워크스페이스 다계층 드릴다운 UI 통합
 */

class WorkspaceDrilldownManager {
  constructor(workspaceId, token) {
    this.workspaceId = workspaceId;
    this.token = token;
    this.sessionId = 'session-' + Date.now();
    this.currentLevel = 0;
    this.navigationStack = [];
    this.currentNodes = [];
    this.currentPermissions = null;
    this.baseUrl = '/api';
  }

  // 초기화: Level 0 로드
  async initializeWorkspace() {
    try {
      const response = await fetch(`${this.baseUrl}/multilevel/workspace/${this.workspaceId}/structure`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId: this.sessionId })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load workspace');

      this.currentLevel = data.level;
      this.currentNodes = data.nodes;
      this.currentPermissions = data.permissions;
      
      console.log('[WorkspaceDrilldown] 워크스페이스 로드:', {
        level: this.currentLevel,
        nodeCount: this.currentNodes.length,
        role: data.role
      });

      return data;
    } catch (e) {
      console.error('[WorkspaceDrilldown] 초기화 실패:', e);
      throw e;
    }
  }

  // 드릴다운: 다음 레벨로 이동
  async drillDown(nodeId, nextLevel) {
    try {
      // 권한 확인
      if (!this.currentPermissions.canViewLevels.includes(nextLevel)) {
        throw new Error(`Level ${nextLevel}에 접근할 수 없습니다 (권한: ${this.currentPermissions.description})`);
      }

      const response = await fetch(`${this.baseUrl}/multilevel/workspace/${this.workspaceId}/drill/down`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          nodeId: nodeId,
          level: nextLevel
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Drill down failed');

      // 상태 업데이트
      this.currentLevel = data.level;
      this.currentNodes = data.nodes;
      this.currentPermissions = data.permissions;

      console.log('[WorkspaceDrilldown] 드릴다운:', {
        fromLevel: this.currentLevel - 1,
        toLevel: this.currentLevel,
        nodeCount: this.currentNodes.length
      });

      return data;
    } catch (e) {
      console.error('[WorkspaceDrilldown] 드릴다운 실패:', e);
      throw e;
    }
  }

  // 드릴업: 이전 레벨로 돌아가기
  async drillUp() {
    try {
      const response = await fetch(`${this.baseUrl}/multilevel/workspace/${this.workspaceId}/drill/up`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId: this.sessionId })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Drill up failed');

      this.currentLevel = data.level;
      this.currentNodes = data.nodes;
      this.currentPermissions = data.permissions;

      console.log('[WorkspaceDrilldown] 드릴업:', { level: this.currentLevel });

      return data;
    } catch (e) {
      console.error('[WorkspaceDrilldown] 드릴업 실패:', e);
      throw e;
    }
  }

  // 협업 신호 분석
  async analyzeCollaborationSignals(hours = 24) {
    try {
      const response = await fetch(`${this.baseUrl}/workspace/${this.workspaceId}/activity/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours })
      });

      const data = await response.json();
      console.log('[WorkspaceDrilldown] 협업 분석:', data.result);
      return data;
    } catch (e) {
      console.error('[WorkspaceDrilldown] 협업 분석 실패:', e);
      throw e;
    }
  }

  // 협업 관계 조회
  async getCollaborationNetwork() {
    try {
      const response = await fetch(`${this.baseUrl}/workspace/${this.workspaceId}/activity/all`);
      const data = await response.json();
      return data.activities || [];
    } catch (e) {
      console.error('[WorkspaceDrilldown] 협업 네트워크 조회 실패:', e);
      throw e;
    }
  }

  // 현재 상태 조회
  getState() {
    return {
      level: this.currentLevel,
      nodes: this.currentNodes,
      permissions: this.currentPermissions,
      navigation: {
        canDrillDown: this.currentLevel < 5 && 
                     this.currentPermissions.canViewLevels.includes(this.currentLevel + 1),
        canDrillUp: this.currentLevel > 0
      }
    };
  }

  // 렌더링을 위한 노드 데이터 변환
  getNodeDataForRendering() {
    return this.currentNodes.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      color: node.color,
      shape: node.shape,
      size: node.size,
      position: node.position,
      domain: node.domain
    }));
  }
}

// 사용 예시:
// const manager = new WorkspaceDrilldownManager('workspace-id', 'token');
// await manager.initializeWorkspace();
// const data = await manager.drillDown('node-id', 1);
// const state = manager.getState();
