/**
 * multilevel-workspace-nodes.js
 * 워크스페이스 기반 다계층 노드 생성 엔진
 * - 6단계 계층 (Level 0-5)
 * - 역할별 데이터 필터링
 * - 동심원 배치 알고리즘
 */

const { getDb } = require('./db');
const { ulid } = require('ulid');

// ─── 색상 및 스타일 정의 ────────────────────────────────────────────────────
const LEVEL_STYLES = {
  0: { color: '#3fb950', shape: 'circle', size: 1.0, name: 'Compact' },
  1: { color: '#58a6ff', shape: 'circle', size: 1.0, name: 'Personal' },
  2: { color: '#79c0ff', shape: 'diamond', size: 1.2, name: 'Team' },
  3: { color: '#a371f7', shape: 'diamond', size: 1.5, name: 'Collaboration' },
  4: { color: '#f85149', shape: 'star', size: 2.0, name: 'Department' },
  5: { color: '#d29922', shape: 'circle', size: 2.5, name: 'Universe' }
};

// ─── 동심원 배치 알고리즘 ────────────────────────────────────────────────────
/**
 * 노드 수에 따라 동심원 레이어 계산
 * @param {number} totalNodes - 총 노드 수
 * @returns {Array} - 각 레이어별 노드 수 배열
 */
function calculateConcentricLayers(totalNodes) {
  if (totalNodes <= 7) return [totalNodes];
  if (totalNodes <= 20) return [7, totalNodes - 7];
  if (totalNodes <= 50) return [7, 15, totalNodes - 22];
  return [7, 15, 20, totalNodes - 42];
}

/**
 * 동심원 배치 위치 계산
 * @param {number} level - 레벨 (0-5)
 * @param {number} index - 노드 인덱스
 * @param {number} totalNodes - 총 노드 수
 * @param {Object} center - 중심점 {x, y, z}
 * @returns {Object} - {x, y, z} 좌표
 */
function calculateNodePosition(level, index, totalNodes, center = { x: 0, y: 0, z: 0 }) {
  const layers = calculateConcentricLayers(totalNodes);

  // 현재 노드가 어느 레이어에 속하는지 계산
  let layerIndex = 0;
  let nodeIndexInLayer = index;
  let accumulatedNodes = 0;

  for (let i = 0; i < layers.length; i++) {
    if (accumulatedNodes + layers[i] > index) {
      layerIndex = i;
      nodeIndexInLayer = index - accumulatedNodes;
      break;
    }
    accumulatedNodes += layers[i];
  }

  const nodesInLayer = layers[layerIndex];
  const angle = (nodeIndexInLayer / nodesInLayer) * Math.PI * 2;
  const radius = (layerIndex + 1) * 3; // 각 레이어마다 3 단위 간격

  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle),
    z: center.z + (level - 2.5) * 0.5 // Z축 레벨별 오프셋
  };
}

// ─── Level별 노드 생성 함수 ────────────────────────────────────────────────
/**
 * Level 0 (Compact): 워크스페이스 자체
 */
async function generateLevel0Nodes(workspaceId) {
  const db = getDb();
  const ws = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId);

  if (!ws) return [];

  return [{
    id: `ws-${workspaceId}`,
    level: 0,
    name: ws.name || 'Workspace',
    type: 'workspace',
    domain: 'Workspace',
    shape: LEVEL_STYLES[0].shape,
    color: LEVEL_STYLES[0].color,
    size: LEVEL_STYLES[0].size,
    position: { x: 0, y: 0, z: 0 },
    metadata: {
      companyName: ws.company_name || '',
      createdAt: ws.created_at
    }
  }];
}

/**
 * Level 1 (Personal): 워크스페이스 멤버들
 * - Member 역할: 자신만 표시
 * - Admin/Owner: 모든 멤버 표시
 */
async function generateLevel1Nodes(workspaceId, userId, userRole) {
  const db = getDb();

  // 멤버 목록 조회
  let query = `
    SELECT wm.user_id, wm.role, wm.team_name, wm.joined_at
    FROM workspace_members wm
    WHERE wm.workspace_id = ?
  `;
  const params = [workspaceId];

  // Member 역할: 자신만 표시
  if (userRole === 'member') {
    query += ` AND wm.user_id = ?`;
    params.push(userId);
  }

  query += ` ORDER BY wm.joined_at ASC`;

  const members = db.prepare(query).all(...params);

  // 위치 계산을 위해 전체 멤버 수 필요
  const allMembers = db.prepare(`
    SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ?
  `).get(workspaceId);

  return members.map((member, index) => {
    const position = calculateNodePosition(1, index, allMembers.count);
    return {
      id: `member-${member.user_id}`,
      level: 1,
      name: member.user_id, // 실제로는 users 테이블에서 이름 가져와야 함
      type: 'member',
      domain: member.role.toUpperCase(),
      role: member.role,
      shape: LEVEL_STYLES[1].shape,
      color: LEVEL_STYLES[1].color,
      size: LEVEL_STYLES[1].size,
      position,
      metadata: {
        teamName: member.team_name || 'Default Team',
        joinedAt: member.joined_at,
        userId: member.user_id
      }
    };
  });
}

/**
 * Level 2 (Team): 워크스페이스 내 팀들
 */
async function generateLevel2Nodes(workspaceId, userRole, parentNodeId) {
  const db = getDb();

  // 팀 목록 조회 (workspace_members.team_name의 DISTINCT)
  const teams = db.prepare(`
    SELECT DISTINCT team_name FROM workspace_members
    WHERE workspace_id = ?
    ORDER BY team_name ASC
  `).all(workspaceId);

  const totalTeams = teams.length;

  return teams.map((team, index) => {
    const position = calculateNodePosition(2, index, totalTeams);
    return {
      id: `team-${team.team_name}`,
      level: 2,
      name: team.team_name,
      type: 'team',
      domain: 'TEAM',
      shape: LEVEL_STYLES[2].shape,
      color: LEVEL_STYLES[2].color,
      size: LEVEL_STYLES[2].size,
      position,
      metadata: {
        teamName: team.team_name
      }
    };
  });
}

/**
 * Level 3 (Collaboration): 협업 관계
 * 사용자 자신의 협업 관계만 표시
 */
async function generateLevel3Nodes(workspaceId, userId) {
  const db = getDb();

  // 사용자의 협업 관계 조회
  const collaborations = db.prepare(`
    SELECT
      CASE
        WHEN user_id_1 = ? THEN user_id_2
        ELSE user_id_1
      END as collab_user,
      strength
    FROM workspace_activity
    WHERE workspace_id = ? AND (user_id_1 = ? OR user_id_2 = ?)
    ORDER BY strength DESC
  `).all(userId, workspaceId, userId, userId);

  const totalCollabs = collaborations.length;

  return collaborations.map((collab, index) => {
    const position = calculateNodePosition(3, index, totalCollabs);
    // 협업 강도로 색상 결정 (강도 높을수록 더 보라색)
    const strength = collab.strength || 0.5;
    const hue = 270 + (strength * 20); // 보라색 범위
    const saturation = 70 + (strength * 30); // 강도 높을수록 포화도 높음
    const lightness = 50 - (strength * 10);

    return {
      id: `collab-${collab.collab_user}`,
      level: 3,
      name: collab.collab_user,
      type: 'collaboration',
      domain: 'COLLABORATION',
      collaborationStrength: strength,
      shape: LEVEL_STYLES[3].shape,
      color: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
      size: LEVEL_STYLES[3].size,
      position,
      metadata: {
        userId: collab.collab_user,
        strength: strength,
        strengthPercent: Math.round(strength * 100)
      }
    };
  });
}

/**
 * Level 4 (Department): 부서/조직 구조
 * - Member 역할: 자신의 부서만
 * - Admin/Owner: 모든 부서
 */
async function generateLevel4Nodes(workspaceId, userId, userRole) {
  const db = getDb();

  let departments;

  if (userRole === 'member') {
    // Member: 자신이 속한 부서만
    const userDept = db.prepare(`
      SELECT DISTINCT department_id FROM workspace_members
      WHERE workspace_id = ? AND user_id = ?
    `).get(workspaceId, userId);

    if (userDept && userDept.department_id) {
      departments = db.prepare(`
        SELECT * FROM team_hierarchy
        WHERE id = ?
      `).all(userDept.department_id);
    } else {
      departments = [];
    }
  } else {
    // Admin/Owner: 모든 부서
    departments = db.prepare(`
      SELECT * FROM team_hierarchy
      WHERE workspace_id = ? AND level_type = 'department'
      ORDER BY created_at ASC
    `).all(workspaceId);
  }

  const totalDepts = departments.length;

  return departments.map((dept, index) => {
    const position = calculateNodePosition(4, index, totalDepts);
    return {
      id: `dept-${dept.id}`,
      level: 4,
      name: dept.name,
      type: 'department',
      domain: 'DEPARTMENT',
      shape: LEVEL_STYLES[4].shape,
      color: dept.color || LEVEL_STYLES[4].color,
      size: LEVEL_STYLES[4].size,
      position,
      metadata: {
        deptId: dept.id,
        icon: dept.icon || '👥',
        createdAt: dept.created_at
      }
    };
  });
}

/**
 * Level 5 (Universe): 전체 조직 구조
 * Owner만 접근 가능
 */
async function generateLevel5Nodes(workspaceId, userRole) {
  // Member/Admin은 접근 불가
  if (userRole !== 'owner') {
    return [];
  }

  const db = getDb();

  // 루트 부서들 (parent_id가 NULL)
  const ecosystems = db.prepare(`
    SELECT * FROM team_hierarchy
    WHERE workspace_id = ? AND parent_id IS NULL
    ORDER BY created_at ASC
  `).all(workspaceId);

  const totalEcosystems = ecosystems.length;

  return ecosystems.map((eco, index) => {
    const position = calculateNodePosition(5, index, totalEcosystems);
    return {
      id: `ecosystem-${eco.id}`,
      level: 5,
      name: eco.name,
      type: 'ecosystem',
      domain: 'UNIVERSE',
      shape: LEVEL_STYLES[5].shape,
      color: eco.color || LEVEL_STYLES[5].color,
      size: LEVEL_STYLES[5].size,
      position,
      metadata: {
        ecoId: eco.id,
        icon: eco.icon || '🌌',
        createdAt: eco.created_at
      }
    };
  });
}

// ─── 연결선 생성 ────────────────────────────────────────────────────────────
/**
 * 특정 레벨의 연결선 생성
 * @param {number} fromLevel - 출발 레벨
 * @param {number} toLevel - 도착 레벨
 * @param {string} parentNodeId - 부모 노드 ID (드릴다운 시)
 */
async function generateConnectionsForLevel(nodes, toLevel, toNodes) {
  const connections = [];

  // 부모 노드에서 자식 노드로의 연결선
  if (toNodes && toNodes.length > 0) {
    nodes.forEach(parentNode => {
      toNodes.forEach(childNode => {
        connections.push({
          from: parentNode.position,
          to: childNode.position,
          color: parentNode.color,
          thickness: 1,
          dashed: false
        });
      });
    });
  }

  return connections;
}

// ─── 메인 함수: 레벨별 노드 생성 ────────────────────────────────────────────
/**
 * 역할과 레벨에 따라 노드 생성
 * @param {string} workspaceId - 워크스페이스 ID
 * @param {string} userId - 사용자 ID
 * @param {number} level - 생성할 레벨 (0-5)
 * @param {string} userRole - 사용자 역할 (owner|admin|member)
 * @param {string} parentNodeId - 부모 노드 ID (드릴다운 시)
 * @returns {Array} - 노드 배열
 */
async function generateNodesForWorkspace(workspaceId, userId, level, userRole, parentNodeId = null) {
  const db = getDb();

  try {
    // 1. 캐시 확인 (15분 TTL)
    const cached = db.prepare(`
      SELECT nodes_json FROM multilevel_cache
      WHERE workspace_id = ? AND level = ? AND role = ? AND user_id = ?
      AND datetime(expires_at) > datetime('now')
    `).get(workspaceId, level, userRole, userId);

    if (cached) {
      console.log(`[multilevel] 캐시 히트: ws=${workspaceId}, level=${level}, role=${userRole}`);
      return JSON.parse(cached.nodes_json);
    }

    // 2. 권한 검증
    const roleLevelPerms = {
      owner: { canViewLevels: [0, 1, 2, 3, 4, 5] },
      admin: { canViewLevels: [1, 2, 3, 4] },
      member: { canViewLevels: [0, 1, 2] }
    };
    const perms = roleLevelPerms[userRole];
    if (!perms || !perms.canViewLevels.includes(level)) {
      throw new Error(`Access denied to level ${level}`);
    }

    // 3. 레벨별 노드 생성
    let nodes = [];
    switch (level) {
      case 0:
        nodes = await generateLevel0Nodes(workspaceId);
        break;
      case 1:
        nodes = await generateLevel1Nodes(workspaceId, userId, userRole);
        break;
      case 2:
        nodes = await generateLevel2Nodes(workspaceId, userRole, parentNodeId);
        break;
      case 3:
        nodes = await generateLevel3Nodes(workspaceId, userId);
        break;
      case 4:
        nodes = await generateLevel4Nodes(workspaceId, userId, userRole);
        break;
      case 5:
        nodes = await generateLevel5Nodes(workspaceId, userRole);
        break;
      default:
        throw new Error(`Invalid level: ${level}`);
    }

    // 4. 캐시 저장 (15분 TTL)
    const cacheId = ulid();
    db.prepare(`
      INSERT OR REPLACE INTO multilevel_cache
      (id, workspace_id, level, role, user_id, nodes_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+15 minutes'))
    `).run(cacheId, workspaceId, level, userRole, userId, JSON.stringify(nodes));

    console.log(`[multilevel] 노드 생성: ws=${workspaceId}, level=${level}, role=${userRole}, nodes=${nodes.length}`);
    return nodes;
  } catch (e) {
    console.error('[multilevel] generateNodesForWorkspace error:', e);
    throw e;
  }
}

module.exports = {
  // 알고리즘
  calculateConcentricLayers,
  calculateNodePosition,
  // Level별 생성 함수
  generateLevel0Nodes,
  generateLevel1Nodes,
  generateLevel2Nodes,
  generateLevel3Nodes,
  generateLevel4Nodes,
  generateLevel5Nodes,
  // 연결선
  generateConnectionsForLevel,
  // 메인 함수
  generateNodesForWorkspace,
  // 스타일
  LEVEL_STYLES
};
