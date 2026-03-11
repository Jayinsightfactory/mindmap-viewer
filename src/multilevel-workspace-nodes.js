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

// ─── 황금각 산포형 배치 알고리즘 ─────────────────────────────────────────────
/**
 * 황금각(golden angle) 기반 자연스러운 산포형 위치 계산
 * - 이미지처럼 "My work" 중심에서 프로젝트들이 방사형으로 산포
 * - 원근감(perspective): 멀수록 y축 위로, z 깊이 변화
 * - 선택 노드의 위치를 새 중심으로 하위 노드 배치 지원
 *
 * @param {number} level - 레벨 (0-5)
 * @param {number} index - 노드 인덱스
 * @param {number} totalNodes - 총 노드 수
 * @param {Object} center - 중심점 {x, y, z}
 * @returns {Object} - {x, y, z} 좌표
 */
function calculateNodePosition(level, index, totalNodes, center = { x: 0, y: 0, z: 0 }) {
  if (totalNodes === 0) return { x: center.x, y: center.y, z: center.z };
  if (totalNodes === 1) return { x: center.x, y: center.y, z: center.z };

  // 황금각: 피보나치 나선 기반 자연스러운 분포
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.399 rad

  // 레벨에 따른 기본 반지름 (레벨이 깊어질수록 노드 간 거리 다양)
  const BASE_RADIUS = [4, 5, 6, 7, 8, 9][level] || 5;

  // 피보나치 나선 반지름 (균등 분포)
  const t = totalNodes === 1 ? 0.5 : (index + 0.5) / totalNodes;
  const radius = BASE_RADIUS * (0.4 + Math.sqrt(t) * 1.1);

  // 황금각 기반 방향
  const angle = GOLDEN_ANGLE * index;

  // XZ 평면 배치 (3D에서 수평 산포)
  const x = center.x + radius * Math.cos(angle);
  const z = center.z + radius * Math.sin(angle);

  // 원근감 Y: 거리에 따라 약간 위로 이동 (멀리 있는 노드는 화면 위쪽)
  const perspectiveY = radius * 0.15 * Math.sin(angle * 0.7);
  const y = center.y + perspectiveY;

  return { x, y, z };
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
async function generateLevel1Nodes(workspaceId, userId, userRole, center = { x: 0, y: 0, z: 0 }) {
  const db = getDb();

  // 멤버 목록 조회
  let query = `
    SELECT wm.user_id, wm.role, wm.team_name, wm.joined_at,
           u.name as user_name, u.email as user_email
    FROM workspace_members wm
    LEFT JOIN users u ON u.id = wm.user_id
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
    const position = calculateNodePosition(1, index, allMembers.count, center);
    const displayName = member.user_name || member.user_email?.split('@')[0] || member.user_id;
    return {
      id: `member-${member.user_id}`,
      level: 1,
      name: displayName,
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
async function generateLevel2Nodes(workspaceId, userRole, parentNodeId, center = { x: 0, y: 0, z: 0 }) {
  const db = getDb();

  // 팀 목록 조회 (workspace_members.team_name의 DISTINCT)
  const teams = db.prepare(`
    SELECT DISTINCT team_name FROM workspace_members
    WHERE workspace_id = ?
    ORDER BY team_name ASC
  `).all(workspaceId);

  const totalTeams = teams.length;

  return teams.map((team, index) => {
    const position = calculateNodePosition(2, index, totalTeams, center);
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
async function generateLevel3Nodes(workspaceId, userId, center = { x: 0, y: 0, z: 0 }) {
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
    const position = calculateNodePosition(3, index, totalCollabs, center);
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
async function generateLevel4Nodes(workspaceId, userId, userRole, center = { x: 0, y: 0, z: 0 }) {
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
    const position = calculateNodePosition(4, index, totalDepts, center);
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
async function generateLevel5Nodes(workspaceId, userRole, center = { x: 0, y: 0, z: 0 }) {
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
    const position = calculateNodePosition(5, index, totalEcosystems, center);
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
/**
 * @param {string} workspaceId
 * @param {string} userId
 * @param {number} level
 * @param {string} userRole
 * @param {string} parentNodeId - 드릴다운한 부모 노드 ID
 * @param {Object} parentNodePos - 부모 노드의 3D 위치 {x,y,z} — 이 위치를 새 중심으로 사용
 */
async function generateNodesForWorkspace(workspaceId, userId, level, userRole, parentNodeId = null, parentNodePos = null) {
  const db = getDb();

  // 드릴다운 시 부모 노드 위치를 중심으로 사용, 없으면 원점
  const center = parentNodePos || { x: 0, y: 0, z: 0 };

  try {
    // 1. 권한 검증
    const roleLevelPerms = {
      owner: { canViewLevels: [0, 1, 2, 3, 4, 5] },
      admin: { canViewLevels: [1, 2, 3, 4] },
      member: { canViewLevels: [0, 1, 2] }
    };
    const perms = roleLevelPerms[userRole];
    if (!perms || !perms.canViewLevels.includes(level)) {
      throw new Error(`Access denied to level ${level}`);
    }

    // 2. 레벨별 노드 생성 (캐시 미사용 — 위치가 center에 따라 달라지므로)
    let nodes = [];
    switch (level) {
      case 0:
        nodes = await generateLevel0Nodes(workspaceId);
        break;
      case 1:
        nodes = await generateLevel1Nodes(workspaceId, userId, userRole, center);
        break;
      case 2:
        nodes = await generateLevel2Nodes(workspaceId, userRole, parentNodeId, center);
        break;
      case 3:
        nodes = await generateLevel3Nodes(workspaceId, userId, center);
        break;
      case 4:
        nodes = await generateLevel4Nodes(workspaceId, userId, userRole, center);
        break;
      case 5:
        nodes = await generateLevel5Nodes(workspaceId, userRole, center);
        break;
      default:
        throw new Error(`Invalid level: ${level}`);
    }

    console.log(`[multilevel] 노드 생성: ws=${workspaceId}, level=${level}, role=${userRole}, nodes=${nodes.length}, center=(${center.x.toFixed(1)},${center.y.toFixed(1)},${center.z.toFixed(1)})`);
    return nodes;
  } catch (e) {
    console.error('[multilevel] generateNodesForWorkspace error:', e);
    throw e;
  }
}

module.exports = {
  // 알고리즘
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
