/**
 * multilevel-auth.js
 * 워크스페이스 다계층 시스템 권한 제어
 * - 역할 기반 접근 제어 (Owner > Admin > Member)
 * - 레벨별 권한 정의
 */

const { verifyToken } = require('../src/auth');
const { getDb } = require('../src/db');

// ─── 역할별 레벨 접근 권한 정의 ─────────────────────────────────────────
const ROLE_LEVEL_PERMISSIONS = {
  owner: {
    canViewLevels: [0, 1, 2, 3, 4, 5],
    canModifyLevels: [0, 1, 2, 3, 4, 5],
    canViewOthersData: true,
    description: '모든 레벨 조회 및 수정 가능'
  },
  admin: {
    canViewLevels: [1, 2, 3, 4],
    canModifyLevels: [1, 2, 3, 4],
    canViewOthersData: true,
    description: '부서/팀 레벨만 조회 및 수정 가능'
  },
  member: {
    canViewLevels: [0, 1, 2],
    canModifyLevels: [0, 1],
    canViewOthersData: false,
    description: '개인/팀 레벨만 조회 가능, 개인 영역만 수정 가능'
  }
};

// ─── 미들웨어: 워크스페이스 인증 및 권한 확인 ──────────────────────────────
/**
 * 워크스페이스 기반 인증 미들웨어
 * - 토큰 검증
 * - workspace_id 추출 (요청 본문 또는 파라미터)
 * - 사용자 역할 조회
 * - req.wsContext에 워크스페이스 정보 저장
 */
async function authWorkspaceLevel(req, res, next) {
  try {
    // 1. 토큰 검증
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    if (!token) {
      return res.status(401).json({ error: 'token_required' });
    }

    const user = verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2. workspace_id 추출
    const workspaceId = req.params.workspaceId || req.body.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id_required' });
    }

    // 3. workspace_members에서 사용자 역할 조회
    const db = getDb();
    const member = db.prepare(`
      SELECT role FROM workspace_members
      WHERE workspace_id = ? AND user_id = ?
    `).get(workspaceId, user.id);

    if (!member) {
      return res.status(403).json({ error: 'not_workspace_member' });
    }

    // 4. req.wsContext 설정
    req.wsContext = {
      workspaceId,
      userId: user.id,
      userEmail: user.email,
      role: member.role,
      permissions: ROLE_LEVEL_PERMISSIONS[member.role]
    };

    next();
  } catch (e) {
    console.error('[multilevel-auth] authWorkspaceLevel error:', e);
    return res.status(500).json({ error: 'auth_error', message: e.message });
  }
}

// ─── 미들웨어: 특정 레벨에 대한 조회 권한 확인 ──────────────────────────────
/**
 * 특정 레벨 조회 권한 검증
 * @param {number} requiredLevel - 필요한 레벨 (0-5)
 */
function requireLevelAccess(requiredLevel) {
  return (req, res, next) => {
    const { role, permissions } = req.wsContext;

    if (!permissions.canViewLevels.includes(requiredLevel)) {
      return res.status(403).json({
        error: 'level_access_denied',
        message: `Role '${role}' cannot access level ${requiredLevel}`,
        allowedLevels: permissions.canViewLevels,
        requiredLevel
      });
    }

    next();
  };
}

// ─── 미들웨어: 특정 레벨에 대한 수정 권한 확인 ──────────────────────────────
/**
 * 특정 레벨 수정 권한 검증
 * @param {number} requiredLevel - 필요한 레벨 (0-5)
 */
function requireLevelModify(requiredLevel) {
  return (req, res, next) => {
    const { role, permissions } = req.wsContext;

    if (!permissions.canModifyLevels.includes(requiredLevel)) {
      return res.status(403).json({
        error: 'level_modify_denied',
        message: `Role '${role}' cannot modify level ${requiredLevel}`,
        modifiableLevels: permissions.canModifyLevels,
        requiredLevel
      });
    }

    next();
  };
}

// ─── 미들웨어: Owner/Admin 역할 확인 ────────────────────────────────────────
/**
 * Owner 역할만 허용
 */
function requireOwner(req, res, next) {
  const { role } = req.wsContext;

  if (role !== 'owner') {
    return res.status(403).json({
      error: 'owner_required',
      message: `Only owner can perform this action (current: ${role})`
    });
  }

  next();
}

/**
 * Owner 또는 Admin만 허용
 */
function requireOwnerOrAdmin(req, res, next) {
  const { role } = req.wsContext;

  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({
      error: 'admin_required',
      message: `Only owner/admin can perform this action (current: ${role})`
    });
  }

  next();
}

// ─── 유틸리티: 권한 정보 조회 ────────────────────────────────────────────────
/**
 * 사용자의 워크스페이스 권한 정보 조회
 */
function getUserWorkspacePermissions(workspaceId, userId) {
  const db = getDb();
  const member = db.prepare(`
    SELECT role FROM workspace_members
    WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId);

  if (!member) return null;

  return {
    role: member.role,
    permissions: ROLE_LEVEL_PERMISSIONS[member.role],
    levelDescription: ROLE_LEVEL_PERMISSIONS[member.role].description
  };
}

// ─── 유틸리티: 권한 정보 반환 ────────────────────────────────────────────────
/**
 * API 응답에 포함할 권한 정보
 */
function getPermissionsResponse(role) {
  return ROLE_LEVEL_PERMISSIONS[role];
}

module.exports = {
  // 미들웨어
  authWorkspaceLevel,
  requireLevelAccess,
  requireLevelModify,
  requireOwner,
  requireOwnerOrAdmin,
  // 유틸리티
  ROLE_LEVEL_PERMISSIONS,
  getUserWorkspacePermissions,
  getPermissionsResponse
};
