/**
 * multilevel-auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 4단계 조직 계층 권한 제어 시스템
 * 
 * 계층 구조:
 *   Level 3: 회사 (Company)
 *   Level 2: 부서 (Department)
 *   Level 1: 팀 (Team)
 *   Level 0: 개인/멤버 (Member/Individual)
 * 
 * 역할 (Role):
 *   - owner: 회사 전체 관리
 *   - admin: 부서/팀 관리
 *   - lead: 팀 리더
 *   - member: 팀 멤버
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { verifyToken } = require('../src/auth');
const { getDb } = require('../src/db');

// ─── 개발환경 권한 자동승인 플래그 ────────────────────────────────────────
const ENABLE_AUTO_PERMISSION = process.env.AUTO_PERMISSION === 'true' || process.env.NODE_ENV === 'development';

// ─── 역할별 레벨 접근 권한 정의 ─────────────────────────────────────────
/**
 * 역할별 권한 정의
 * - canViewLevels: 조회 가능 레벨
 * - canModifyLevels: 수정 가능 레벨
 * - canViewOthersData: 타 사용자 데이터 조회 가능 여부
 * - canManageMembers: 멤버 관리 가능 여부
 */
const ROLE_LEVEL_PERMISSIONS = {
  owner: {
    canViewLevels: [0, 1, 2, 3],           // 모든 레벨 조회
    canModifyLevels: [0, 1, 2, 3],         // 모든 레벨 수정
    canViewOthersData: true,               // 타 사용자 데이터 조회
    canManageMembers: true,                // 멤버 관리
    description: '회사 전체 관리 - 모든 레벨 조회/수정 가능'
  },
  admin: {
    canViewLevels: [0, 1, 2],              // 개인 ~ 부서 레벨
    canModifyLevels: [1, 2],               // 팀, 부서 수정
    canViewOthersData: true,               // 타 사용자 데이터 조회
    canManageMembers: true,                // 멤버 관리
    description: '부서/팀 관리 - 부서 이하 조회/수정 가능'
  },
  lead: {
    canViewLevels: [0, 1],                 // 개인, 팀 레벨
    canModifyLevels: [0, 1],               // 팀, 멤버 수정
    canViewOthersData: true,               // 팀 내 타 사용자 데이터 조회
    canManageMembers: true,                // 팀 내 멤버 관리
    description: '팀 리더 - 팀 레벨 조회/수정 가능'
  },
  member: {
    canViewLevels: [0],                    // 개인 레벨만
    canModifyLevels: [0],                  // 개인 영역만 수정
    canViewOthersData: false,              // 타 사용자 데이터 조회 불가
    canManageMembers: false,               // 멤버 관리 불가
    description: '팀 멤버 - 개인 영역만 조회/수정 가능'
  }
};

// ─── 미들웨어: 워크스페이스 인증 및 권한 확인 ──────────────────────────────
/**
 * 워크스페이스 기반 인증 미들웨어
 * - 토큰 검증
 * - workspace_id 추출 (요청 본문 또는 파라미터)
 * - 사용자 역할 조회
 * - req.wsContext에 워크스페이스 정보 저장
 * 
 * 개발환경에서 AUTO_PERMISSION=true 이면 권한 검증 스킵
 */
async function authWorkspaceLevel(req, res, next) {
  try {
    // 개발환경 권한 자동승인
    if (ENABLE_AUTO_PERMISSION) {
      const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token || 'dev-token';
      const user = verifyToken(token) || { id: 'dev-user', email: 'dev@localhost' };
      const workspaceId = req.params.workspaceId || req.body.workspaceId || 'dev-workspace';
      
      req.wsContext = {
        workspaceId,
        userId: user.id,
        userEmail: user.email,
        role: 'owner',  // 개발환경에서는 owner 권한 자동 부여
        permissions: ROLE_LEVEL_PERMISSIONS['owner'],
        isDevelopment: true
      };
      
      return next();
    }

    // 프로덕션 환경 권한 확인
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
      permissions: ROLE_LEVEL_PERMISSIONS[member.role],
      isDevelopment: false
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
 * @param {number} requiredLevel - 필요한 레벨 (0-3)
 *   Level 0: 개인/멤버
 *   Level 1: 팀
 *   Level 2: 부서
 *   Level 3: 회사
 */
function requireLevelAccess(requiredLevel) {
  return (req, res, next) => {
    // 개발환경에선 항상 허용
    if (req.wsContext?.isDevelopment) return next();
    
    const { role, permissions } = req.wsContext;

    if (!permissions.canViewLevels.includes(requiredLevel)) {
      return res.status(403).json({
        error: 'level_access_denied',
        message: `Role '${role}' cannot access level ${requiredLevel}`,
        allowedLevels: permissions.canViewLevels,
        requiredLevel,
        levelMap: { 0: 'Member', 1: 'Team', 2: 'Department', 3: 'Company' }
      });
    }

    next();
  };
}

// ─── 미들웨어: 특정 레벨에 대한 수정 권한 확인 ──────────────────────────────
/**
 * 특정 레벨 수정 권한 검증
 * @param {number} requiredLevel - 필요한 레벨 (0-3)
 */
function requireLevelModify(requiredLevel) {
  return (req, res, next) => {
    // 개발환경에선 항상 허용
    if (req.wsContext?.isDevelopment) return next();
    
    const { role, permissions } = req.wsContext;

    if (!permissions.canModifyLevels.includes(requiredLevel)) {
      return res.status(403).json({
        error: 'level_modify_denied',
        message: `Role '${role}' cannot modify level ${requiredLevel}`,
        modifiableLevels: permissions.canModifyLevels,
        requiredLevel,
        levelMap: { 0: 'Member', 1: 'Team', 2: 'Department', 3: 'Company' }
      });
    }

    next();
  };
}

// ─── 미들웨어: 역할 기반 접근 제어 ──────────────────────────────────────────
/**
 * Owner 역할만 허용
 */
function requireOwner(req, res, next) {
  // 개발환경에선 항상 허용
  if (req.wsContext?.isDevelopment) return next();
  
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
  // 개발환경에선 항상 허용
  if (req.wsContext?.isDevelopment) return next();
  
  const { role } = req.wsContext;

  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({
      error: 'admin_required',
      message: `Only owner/admin can perform this action (current: ${role})`
    });
  }

  next();
}

/**
 * Owner/Admin/Lead 허용 (멤버 관리 가능)
 */
function requireMemberManagement(req, res, next) {
  // 개발환경에선 항상 허용
  if (req.wsContext?.isDevelopment) return next();
  
  const { role, permissions } = req.wsContext;

  if (!permissions.canManageMembers) {
    return res.status(403).json({
      error: 'member_management_denied',
      message: `Role '${role}' cannot manage members`,
      allowedRoles: ['owner', 'admin', 'lead']
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

/**
 * 레벨 이름 조회
 */
function getLevelName(level) {
  const names = { 0: 'Member', 1: 'Team', 2: 'Department', 3: 'Company' };
  return names[level] || 'Unknown';
}

/**
 * 개발환경 권한 자동승인 활성화 여부
 */
function isAutoPermissionEnabled() {
  return ENABLE_AUTO_PERMISSION;
}

module.exports = {
  // 미들웨어
  authWorkspaceLevel,
  requireLevelAccess,
  requireLevelModify,
  requireOwner,
  requireOwnerOrAdmin,
  requireMemberManagement,
  // 유틸리티
  ROLE_LEVEL_PERMISSIONS,
  getUserWorkspacePermissions,
  getPermissionsResponse,
  getLevelName,
  isAutoPermissionEnabled
};
