/**
 * routes/workspace.js
 * 워크스페이스(팀/회사) 관리 API
 *
 * POST /api/workspace/create       — 워크스페이스 생성 + 초대코드 발급
 * GET  /api/workspace/invite/:code — 초대코드 정보 조회 (로그인 전 공개)
 * POST /api/workspace/join         — 초대코드로 참여
 * GET  /api/workspace/my           — 내 워크스페이스 목록
 * GET  /api/workspace/team-view    — 팀뷰 데이터 (orbit3d.html 연동)
 * GET  /api/workspace/company-view — 회사뷰 데이터
 * PATCH /api/workspace/member/team — 내 팀 이름 변경
 * DELETE /api/workspace/leave      — 워크스페이스 나가기
 */

'use strict';

const express = require('express');
const { ulid }  = require('ulid');
const crypto    = require('crypto');

function createWorkspaceRouter({ db, verifyToken, getUserById, ADMIN_EMAILS }) {
  const router = express.Router();

  // ── 헬퍼: 짧은 초대코드 생성 (8자 영숫자) ────────────────────────────────
  function genInviteCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. "A1B2C3D4"
  }

  // ── 헬퍼: DB 쿼리 래퍼 (SQLite sync / PG async 통일) ─────────────────────
  function dbGet(sql, params = []) {
    if (db.prepare) return db.prepare(sql).get(...params);          // SQLite
    return db.query(sql, params).then(r => r.rows[0]);              // PG
  }
  function dbAll(sql, params = []) {
    if (db.prepare) return db.prepare(sql).all(...params);
    return db.query(sql, params).then(r => r.rows);
  }
  function dbRun(sql, params = []) {
    if (db.prepare) return db.prepare(sql).run(...params);
    return db.query(sql, params);
  }

  // ── 인증 미들웨어 ─────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.replace('Bearer ', '').trim() ||
                   req.cookies?.orbit_token || '';
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const user = verifyToken(token);
      if (!user) return res.status(401).json({ error: 'invalid token' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/workspace/create
  // body: { name, companyName }
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/workspace/create', auth, async (req, res) => {
    try {
      const { name, companyName = '' } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });

      const id          = ulid();
      const invite_code = genInviteCode();

      await dbRun(
        `INSERT INTO workspaces (id, name, company_name, owner_id, invite_code)
         VALUES (?, ?, ?, ?, ?)`,
        [id, name, companyName, req.user.id, invite_code]
      );
      await dbRun(
        `INSERT INTO workspace_members (workspace_id, user_id, role, team_name)
         VALUES (?, ?, 'owner', ?)`,
        [id, req.user.id, name]
      );

      res.json({ id, name, companyName, invite_code,
        inviteUrl: `/invite/${invite_code}` });
    } catch (e) {
      console.error('[workspace/create]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/invite/:code  (공개 — 로그인 불필요)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/invite/:code', async (req, res) => {
    try {
      const ws = await dbGet(
        `SELECT w.id, w.name, w.company_name,
                (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
         FROM workspaces w WHERE w.invite_code = ?`,
        [req.params.code]
      );
      if (!ws) return res.status(404).json({ error: 'invalid invite code' });
      res.json(ws);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/workspace/join
  // body: { inviteCode, teamName }
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/workspace/join', auth, async (req, res) => {
    try {
      const { inviteCode, teamName = '팀 1' } = req.body;
      if (!inviteCode) return res.status(400).json({ error: 'inviteCode required' });

      const ws = await dbGet(
        `SELECT id, name, company_name FROM workspaces WHERE invite_code = ?`,
        [inviteCode]
      );
      if (!ws) return res.status(404).json({ error: 'invalid invite code' });

      const existing = await dbGet(
        `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [ws.id, req.user.id]
      );
      if (existing) return res.json({ message: 'already joined', workspace: ws });

      await dbRun(
        `INSERT INTO workspace_members (workspace_id, user_id, role, team_name)
         VALUES (?, ?, 'member', ?)`,
        [ws.id, req.user.id, teamName]
      );

      res.json({ message: 'joined', workspace: ws });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/my
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/my', auth, async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT w.id, w.name, w.company_name, w.invite_code, wm.role, wm.team_name,
                (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = ?
         ORDER BY wm.joined_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/team-view?workspaceId=xxx
  // orbit3d.html 팀뷰용 — TEAM_DEMO 형식으로 반환
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/team-view', auth, async (req, res) => {
    try {
      // 파라미터 없으면 첫 번째 워크스페이스 사용
      let { workspaceId } = req.query;
      if (!workspaceId) {
        const first = await dbGet(
          `SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1`,
          [req.user.id]
        );
        if (!first) return res.json(null);
        workspaceId = first.workspace_id;
      }

      // 멤버 목록 (cross-DB JOIN 회피: 2단계 조회)
      const rawMembers = await dbAll(
        `SELECT user_id, role, team_name FROM workspace_members WHERE workspace_id = ? ORDER BY joined_at ASC`,
        [workspaceId]
      );
      const members = rawMembers.map(wm => {
        const u = typeof getUserById === 'function' ? getUserById(wm.user_id) : null;
        return {
          id: wm.user_id,
          name: u?.name || u?.email?.split('@')[0] || '사용자',
          email: u?.email || '',
          avatar: u?.avatar || null,
          role: wm.role,
          team_name: wm.team_name,
        };
      });

      const ws = await dbGet(`SELECT * FROM workspaces WHERE id = ?`, [workspaceId]);
      if (!ws) return res.status(404).json({ error: 'workspace not found' });

      // 멤버별 최근 24시간 활동 요약
      const since = new Date(Date.now() - 86400000).toISOString();
      const COLORS = ['#3fb950','#58a6ff','#bc8cff','#f0883e','#ff7b72','#ffd700','#79c0ff'];

      const teamMembers = await Promise.all(members.map(async (m, i) => {
        // 최근 세션들
        const sessions = await dbAll(
          `SELECT id, title, started_at, ended_at, project_dir, event_count
           FROM sessions
           WHERE user_id = ? AND started_at > ?
           ORDER BY started_at DESC LIMIT 5`,
          [m.id, since]
        );

        // 최근 파일 활동
        const recentFiles = await dbAll(
          `SELECT DISTINCT json_extract(data_json, '$.filePath') AS fp
           FROM events
           WHERE user_id = ? AND timestamp > ?
             AND type IN ('tool.end','file.write','file.edit')
             AND json_extract(data_json, '$.filePath') IS NOT NULL
           LIMIT 8`,
          [m.id, since]
        );

        // tasks: 세션을 task로 변환
        const tasks = sessions.map(s => ({
          name: s.title || s.project_dir?.split('/').pop() || '작업 중',
          status: s.ended_at ? 'done' : 'active',
          progress: s.ended_at ? 1.0 : 0.5,
          subtasks: recentFiles.map(f => f.fp).filter(Boolean).slice(0, 4),
          completedSubtasks: s.ended_at ? recentFiles.length : 0,
          dueDate: '',
          blocker: false,
        }));

        // 활동 없으면 플레이스홀더
        if (tasks.length === 0) {
          tasks.push({ name: '대기 중', status: 'pending', progress: 0, subtasks: [], completedSubtasks: 0 });
        }

        return {
          id: `m${i}`,
          userId: m.id,
          name: m.name || m.email.split('@')[0],
          role: m.role === 'owner' ? '팀장' : m.team_name,
          color: COLORS[i % COLORS.length],
          tasks,
          collab: [],
          tools: ['Claude Code'],
        };
      }));

      res.json({
        name: ws.name,
        goal: `🚀 ${ws.name}`,
        goalColor: '#ffd700',
        company: { name: ws.company_name || ws.name, desc: `${members.length}명` },
        members: teamMembers,
        workspaceId: ws.id,
        inviteCode: ws.invite_code,
      });
    } catch (e) {
      console.error('[workspace/team-view]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/company-view
  // 회사뷰: 팀별로 묶어서 COMPANY_DEMO 형식 반환
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/company-view', auth, async (req, res) => {
    try {
      let { workspaceId } = req.query;
      if (!workspaceId) {
        const first = await dbGet(
          `SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1`,
          [req.user.id]
        );
        if (!first) return res.json(null);
        workspaceId = first.workspace_id;
      }

      const ws = await dbGet(`SELECT * FROM workspaces WHERE id = ?`, [workspaceId]);
      if (!ws) return res.status(404).json({ error: 'not found' });

      const rawMembers2 = await dbAll(
        `SELECT user_id, role, team_name FROM workspace_members WHERE workspace_id = ? ORDER BY team_name, joined_at`,
        [workspaceId]
      );
      const members = rawMembers2.map(wm => {
        const u = typeof getUserById === 'function' ? getUserById(wm.user_id) : null;
        return {
          id: wm.user_id,
          name: u?.name || u?.email?.split('@')[0] || '사용자',
          email: u?.email || '',
          avatar: u?.avatar || null,
          role: wm.role,
          team_name: wm.team_name,
        };
      });

      // 팀 이름별로 그룹화
      const teamsMap = {};
      const COLORS = ['#3fb950','#58a6ff','#bc8cff','#f0883e','#ff7b72'];
      members.forEach((m, i) => {
        const tn = m.team_name || '기본팀';
        if (!teamsMap[tn]) teamsMap[tn] = [];
        teamsMap[tn].push({
          id: `c${i}`,
          userId: m.id,
          name: m.name || m.email.split('@')[0],
          role: m.role === 'owner' ? '팀장' : '팀원',
          color: COLORS[i % COLORS.length],
          tasks: [],
        });
      });

      const departments = Object.entries(teamsMap).map(([name, mems], di) => ({
        id: `dept${di}`,
        name,
        icon: '👥',
        color: COLORS[di % COLORS.length],
        members: mems,
      }));

      res.json({
        name: ws.company_name || ws.name,
        goal: `📈 ${ws.company_name || ws.name} 성장`,
        goalColor: '#ffd700',
        departments,
        workspaceId: ws.id,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/workspace/member/team
  // body: { workspaceId, teamName }
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/workspace/member/team', auth, async (req, res) => {
    try {
      const { workspaceId, teamName } = req.body;
      await dbRun(
        `UPDATE workspace_members SET team_name = ? WHERE workspace_id = ? AND user_id = ?`,
        [teamName, workspaceId, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/workspace/leave
  // body: { workspaceId }
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/workspace/leave', auth, async (req, res) => {
    try {
      const { workspaceId } = req.body;
      await dbRun(
        `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [workspaceId, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 어드민 권한 체크 헬퍼 ──────────────────────────────────────────────────
  function isWsAdmin(req, workspaceId) {
    // 글로벌 어드민이면 무조건 true
    if (ADMIN_EMAILS && ADMIN_EMAILS.includes(req.user.email?.toLowerCase())) return true;
    // 워크스페이스 owner/admin이면 true
    const member = db.prepare
      ? db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, req.user.id)
      : null;
    return member && (member.role === 'owner' || member.role === 'admin');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/:id/members — 멤버 목록 상세
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/:id/members', auth, async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT user_id, role, team_name, joined_at FROM workspace_members WHERE workspace_id = ? ORDER BY joined_at`,
        [req.params.id]
      );
      const members = rows.map(wm => {
        const u = typeof getUserById === 'function' ? getUserById(wm.user_id) : null;
        return {
          userId: wm.user_id,
          name: u?.name || '사용자',
          email: u?.email || '',
          avatar: u?.avatar || null,
          role: wm.role,
          teamName: wm.team_name,
          joinedAt: wm.joined_at,
          provider: u?.provider || 'local',
        };
      });
      res.json(members);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/workspace/:id/invite — 이메일로 멤버 초대
  // body: { email, teamName, role }
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/workspace/:id/invite', auth, async (req, res) => {
    try {
      const wsId = req.params.id;
      if (!isWsAdmin(req, wsId)) return res.status(403).json({ error: 'admin only' });

      const { email, teamName, role } = req.body;
      if (!email) return res.status(400).json({ error: 'email required' });

      // auth DB에서 사용자 찾기
      const { getUserByEmail } = require('../src/auth');
      const target = getUserByEmail(email);
      if (!target) return res.status(404).json({ error: 'user not found — 먼저 가입 필요' });

      // 이미 멤버인지 확인
      const existing = await dbGet(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        [wsId, target.id]
      );
      if (existing) return res.json({ message: 'already member' });

      await dbRun(
        `INSERT INTO workspace_members (workspace_id, user_id, role, team_name) VALUES (?, ?, ?, ?)`,
        [wsId, target.id, role || 'member', teamName || '팀 1']
      );
      res.json({ ok: true, userId: target.id, name: target.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/workspace/:id/members/:userId — 멤버 제거
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/workspace/:id/members/:userId', auth, async (req, res) => {
    try {
      const wsId = req.params.id;
      if (!isWsAdmin(req, wsId)) return res.status(403).json({ error: 'admin only' });
      await dbRun(
        'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        [wsId, req.params.userId]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/workspace/:id/members/:userId/role — 멤버 역할 변경
  // body: { role: 'admin' | 'member' }
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/workspace/:id/members/:userId/role', auth, async (req, res) => {
    try {
      const wsId = req.params.id;
      if (!isWsAdmin(req, wsId)) return res.status(403).json({ error: 'admin only' });
      const { role } = req.body;
      if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'invalid role' });
      await dbRun(
        'UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?',
        [role, wsId, req.params.userId]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/workspace/:id — 워크스페이스 삭제 (owner/admin만)
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/workspace/:id', auth, async (req, res) => {
    try {
      const wsId = req.params.id;
      if (!isWsAdmin(req, wsId)) return res.status(403).json({ error: 'admin only' });
      await dbRun('DELETE FROM workspace_members WHERE workspace_id = ?', [wsId]);
      await dbRun('DELETE FROM workspaces WHERE id = ?', [wsId]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/workspace/:id/regenerate-code — 초대코드 재생성
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/workspace/:id/regenerate-code', auth, async (req, res) => {
    try {
      const wsId = req.params.id;
      if (!isWsAdmin(req, wsId)) return res.status(403).json({ error: 'admin only' });
      const newCode = genInviteCode();
      await dbRun('UPDATE workspaces SET invite_code = ? WHERE id = ?', [newCode, wsId]);
      res.json({ ok: true, inviteCode: newCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/workspace/admin/all — 전체 워크스페이스 (글로벌 어드민 전용)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/workspace/admin/all', auth, async (req, res) => {
    try {
      if (!ADMIN_EMAILS || !ADMIN_EMAILS.includes(req.user.email?.toLowerCase())) {
        return res.status(403).json({ error: 'global admin only' });
      }
      const rows = await dbAll(
        `SELECT w.*, (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
         FROM workspaces w ORDER BY w.created_at DESC`
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createWorkspaceRouter;
