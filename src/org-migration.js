/**
 * src/org-migration.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 4단계 조직 계층 마이그레이션 유틸리티
 * 
 * 기존 구조:
 *   - workspaces, workspace_members
 *   - companies, departments, employees (company-ontology)
 * 
 * 새로운 구조:
 *   - org_companies, org_departments, org_teams, org_members
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

/**
 * 기본 회사 생성 (Workspace 당 1개)
 * @param {Database} db - SQLite 또는 PostgreSQL 인스턴스
 * @param {string} workspaceId - 워크스페이스 ID
 * @param {string} companyName - 회사명
 * @returns {string} company_id
 */
function createDefaultCompany(db, workspaceId, companyName) {
  try {
    const companyId = ulid();
    
    db.prepare(`
      INSERT INTO org_companies (id, workspace_id, name, status)
      VALUES (?, ?, ?, 'active')
    `).run(companyId, workspaceId, companyName || '기본 회사');
    
    console.log(`[ORG] Company created: ${companyId}`);
    return companyId;
  } catch (e) {
    console.error('[ORG] createDefaultCompany error:', e.message);
    throw e;
  }
}

/**
 * 부서 생성
 * @param {Database} db
 * @param {string} companyId - 회사 ID
 * @param {string} deptName - 부서명
 * @param {string} [headId] - 부서장 user_id
 * @returns {string} department_id
 */
function createDepartment(db, companyId, deptName, headId = '') {
  try {
    const deptId = ulid();
    
    db.prepare(`
      INSERT INTO org_departments (id, company_id, name, head_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(deptId, companyId, deptName, headId);
    
    console.log(`[ORG] Department created: ${deptId}`);
    return deptId;
  } catch (e) {
    console.error('[ORG] createDepartment error:', e.message);
    throw e;
  }
}

/**
 * 팀 생성
 * @param {Database} db
 * @param {string} departmentId - 부서 ID
 * @param {string} teamName - 팀명
 * @param {string} [leaderId] - 팀리더 user_id
 * @returns {string} team_id
 */
function createTeam(db, departmentId, teamName, leaderId = '') {
  try {
    const teamId = ulid();
    
    db.prepare(`
      INSERT INTO org_teams (id, department_id, name, leader_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(teamId, departmentId, teamName, leaderId);
    
    console.log(`[ORG] Team created: ${teamId}`);
    return teamId;
  } catch (e) {
    console.error('[ORG] createTeam error:', e.message);
    throw e;
  }
}

/**
 * 멤버 추가
 * @param {Database} db
 * @param {string} teamId - 팀 ID
 * @param {string} userId - 사용자 ID
 * @param {string} [role] - owner/admin/lead/member (기본: member)
 * @param {string} [position] - 직책
 * @returns {string} member_id
 */
function addMember(db, teamId, userId, role = 'member', position = '') {
  try {
    const memberId = ulid();
    
    db.prepare(`
      INSERT INTO org_members (id, team_id, user_id, role, position, status, joined_at)
      VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
    `).run(memberId, teamId, userId, role, position);
    
    console.log(`[ORG] Member added: ${memberId}`);
    return memberId;
  } catch (e) {
    console.error('[ORG] addMember error:', e.message);
    throw e;
  }
}

/**
 * workspace_members를 org_members로 마이그레이션
 * @param {Database} db
 * @param {string} workspaceId - 워크스페이스 ID
 * @returns {{companyId, departmentId, teamId, migratedCount}}
 */
function migrateWorkspaceMembers(db, workspaceId) {
  try {
    // 1. 워크스페이스 회사 존재 확인, 없으면 생성
    let companyId = db.prepare(`
      SELECT id FROM org_companies WHERE workspace_id = ? LIMIT 1
    `).get(workspaceId)?.id;
    
    if (!companyId) {
      const ws = db.prepare(`SELECT name FROM workspaces WHERE id = ?`).get(workspaceId);
      companyId = createDefaultCompany(db, workspaceId, ws?.name);
    }
    
    // 2. 기본 부서 생성
    const departmentId = createDepartment(db, companyId, '기본 부서');
    
    // 3. workspace_members의 team_name별 팀 생성
    const teams = db.prepare(`
      SELECT DISTINCT team_name FROM workspace_members WHERE workspace_id = ?
    `).all(workspaceId);
    
    const teamMap = {};
    for (const t of teams) {
      const teamId = createTeam(db, departmentId, t.team_name);
      teamMap[t.team_name] = teamId;
    }
    
    // 4. 멤버 마이그레이션
    const members = db.prepare(`
      SELECT user_id, role, team_name FROM workspace_members WHERE workspace_id = ?
    `).all(workspaceId);
    
    let migratedCount = 0;
    for (const m of members) {
      const teamId = teamMap[m.team_name] || Object.values(teamMap)[0];
      try {
        addMember(db, teamId, m.user_id, m.role);
        migratedCount++;
      } catch (e) {
        // 중복: 이미 존재하는 멤버, 무시
      }
    }
    
    console.log(`[ORG] Migrated ${migratedCount} members`);
    
    return { companyId, departmentId, teamId: Object.values(teamMap)[0], migratedCount };
  } catch (e) {
    console.error('[ORG] migrateWorkspaceMembers error:', e.message);
    throw e;
  }
}

/**
 * 조직 계층 조회
 * @param {Database} db
 * @param {string} workspaceId - 워크스페이스 ID
 * @returns {Array} 계층 구조
 */
function getOrgHierarchy(db, workspaceId) {
  try {
    const companies = db.prepare(`
      SELECT * FROM org_companies WHERE workspace_id = ?
    `).all(workspaceId);
    
    const hierarchy = [];
    
    for (const company of companies) {
      const depts = db.prepare(`
        SELECT * FROM org_departments WHERE company_id = ?
      `).all(company.id);
      
      const deptList = [];
      
      for (const dept of depts) {
        const teams = db.prepare(`
          SELECT * FROM org_teams WHERE department_id = ?
        `).all(dept.id);
        
        const teamList = [];
        
        for (const team of teams) {
          const members = db.prepare(`
            SELECT om.*, u.email FROM org_members om
            LEFT JOIN users u ON om.user_id = u.id
            WHERE om.team_id = ?
          `).all(team.id);
          
          teamList.push({
            ...team,
            members: members || []
          });
        }
        
        deptList.push({
          ...dept,
          teams: teamList
        });
      }
      
      hierarchy.push({
        ...company,
        departments: deptList
      });
    }
    
    return hierarchy;
  } catch (e) {
    console.error('[ORG] getOrgHierarchy error:', e.message);
    throw e;
  }
}

module.exports = {
  createDefaultCompany,
  createDepartment,
  createTeam,
  addMember,
  migrateWorkspaceMembers,
  getOrgHierarchy
};
