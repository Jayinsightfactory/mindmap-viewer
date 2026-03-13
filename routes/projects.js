'use strict';
/**
 * routes/projects.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 프로젝트 관리 API (세션 상위 그룹핑)
 *
 * 엔드포인트:
 *   GET    /api/projects                     - 내 프로젝트 목록
 *   POST   /api/projects                     - 프로젝트 생성
 *   GET    /api/projects/:id                 - 프로젝트 상세
 *   PUT    /api/projects/:id                 - 프로젝트 수정
 *   DELETE /api/projects/:id                 - 프로젝트 삭제
 *   POST   /api/projects/:id/sessions        - 세션 → 프로젝트 매핑
 *   DELETE /api/projects/:id/sessions/:sid   - 세션 매핑 해제
 *   GET    /api/projects/:id/sessions        - 프로젝트의 세션 목록
 *   GET    /api/projects/by-session/:sid     - 세션의 프로젝트 조회
 *   POST   /api/projects/:id/learnings       - 학습 기록 추가
 *   GET    /api/projects/:id/learnings       - 학습 기록 조회
 *   DELETE /api/projects/learnings/:lid      - 학습 기록 삭제
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

function createProjectsRouter({ verifyToken, dbModule }) {
  const router = express.Router();

  // ── 인증 미들웨어 ────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  }

  // ── GET /api/projects — 내 프로젝트 목록 ────────────────────────────────
  router.get('/projects', auth, async (req, res) => {
    try {
      const projects = await Promise.resolve(
        dbModule.getProjectsByUser(req.user.id)
      );
      // tags/metadata_json 파싱
      (projects || []).forEach(p => {
        try { p.tags = typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []); } catch { p.tags = []; }
        try { p.metadata = typeof p.metadata_json === 'string' ? JSON.parse(p.metadata_json) : (p.metadata_json || {}); } catch { p.metadata = {}; }
      });
      res.json({ ok: true, count: (projects || []).length, projects: projects || [] });
    } catch (e) {
      console.error('[projects] list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/projects — 프로젝트 생성 ──────────────────────────────────
  router.post('/projects', auth, async (req, res) => {
    try {
      const { name, description, color, icon, tags, metadata } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });

      const id = await Promise.resolve(dbModule.createProject({
        user_id: req.user.id,
        name, description, color, icon, tags, metadata
      }));
      res.json({ ok: true, id, name });
    } catch (e) {
      console.error('[projects] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/projects/:id — 프로젝트 상세 ──────────────────────────────
  router.get('/projects/:id', auth, async (req, res) => {
    try {
      const project = await Promise.resolve(dbModule.getProjectById(req.params.id));
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (project.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

      try { project.tags = typeof project.tags === 'string' ? JSON.parse(project.tags) : (project.tags || []); } catch { project.tags = []; }
      try { project.metadata = typeof project.metadata_json === 'string' ? JSON.parse(project.metadata_json) : (project.metadata_json || {}); } catch { project.metadata = {}; }

      // 세션 목록도 함께 반환
      const sessions = await Promise.resolve(dbModule.getSessionsByProject(req.params.id));
      const learnings = await Promise.resolve(dbModule.getProjectLearnings(req.params.id));

      res.json({ ok: true, project, sessions: sessions || [], learnings: learnings || [] });
    } catch (e) {
      console.error('[projects] detail error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/projects/:id — 프로젝트 수정 ──────────────────────────────
  router.put('/projects/:id', auth, async (req, res) => {
    try {
      const project = await Promise.resolve(dbModule.getProjectById(req.params.id));
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (project.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

      await Promise.resolve(dbModule.updateProject(req.params.id, req.body));
      res.json({ ok: true, id: req.params.id });
    } catch (e) {
      console.error('[projects] update error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/projects/:id — 프로젝트 삭제 ───────────────────────────
  router.delete('/projects/:id', auth, async (req, res) => {
    try {
      const project = await Promise.resolve(dbModule.getProjectById(req.params.id));
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (project.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

      await Promise.resolve(dbModule.deleteProject(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      console.error('[projects] delete error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/projects/:id/sessions — 세션 매핑 ────────────────────────
  router.post('/projects/:id/sessions', auth, async (req, res) => {
    try {
      const { sessionId, confidence, assignedBy } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

      await Promise.resolve(dbModule.assignSessionToProject(
        sessionId, req.params.id, confidence || 1.0, assignedBy || 'manual'
      ));
      res.json({ ok: true, projectId: req.params.id, sessionId });
    } catch (e) {
      console.error('[projects] assign session error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/projects/:id/sessions/:sid — 세션 매핑 해제 ────────────
  router.delete('/projects/:id/sessions/:sid', auth, async (req, res) => {
    try {
      await Promise.resolve(dbModule.removeSessionFromProject(req.params.sid, req.params.id));
      res.json({ ok: true });
    } catch (e) {
      console.error('[projects] remove session error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/projects/:id/sessions — 프로젝트의 세션 목록 ──────────────
  router.get('/projects/:id/sessions', auth, async (req, res) => {
    try {
      const sessions = await Promise.resolve(dbModule.getSessionsByProject(req.params.id));
      res.json({ ok: true, projectId: req.params.id, count: (sessions || []).length, sessions: sessions || [] });
    } catch (e) {
      console.error('[projects] sessions error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/projects/by-session/:sid — 세션의 프로젝트 조회 ───────────
  router.get('/projects/by-session/:sid', auth, async (req, res) => {
    try {
      const projects = await Promise.resolve(dbModule.getProjectBySession(req.params.sid));
      res.json({ ok: true, sessionId: req.params.sid, projects: projects || [] });
    } catch (e) {
      console.error('[projects] by-session error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/projects/:id/learnings — 학습 기록 추가 ──────────────────
  router.post('/projects/:id/learnings', auth, async (req, res) => {
    try {
      const { type, title, content, context } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' });

      const id = await Promise.resolve(dbModule.addProjectLearning({
        project_id: req.params.id,
        user_id: req.user.id,
        type: type || 'insight',
        title, content, context
      }));
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[projects] add learning error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/projects/:id/learnings — 학습 기록 조회 ───────────────────
  router.get('/projects/:id/learnings', auth, async (req, res) => {
    try {
      const learnings = await Promise.resolve(dbModule.getProjectLearnings(req.params.id));
      res.json({ ok: true, projectId: req.params.id, count: (learnings || []).length, learnings: learnings || [] });
    } catch (e) {
      console.error('[projects] learnings error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/projects/learnings/:lid — 학습 기록 삭제 ───────────────
  router.delete('/projects/learnings/:lid', auth, async (req, res) => {
    try {
      await Promise.resolve(dbModule.deleteProjectLearning(req.params.lid));
      res.json({ ok: true });
    } catch (e) {
      console.error('[projects] delete learning error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createProjectsRouter;
