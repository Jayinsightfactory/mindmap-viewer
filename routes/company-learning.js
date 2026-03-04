'use strict';
/**
 * routes/company-learning.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 회사 데이터 학습/활용 API + Google Drive 백업 관리
 *
 * GET  /api/company/:id/learning/report       — 종합 학습 리포트
 * GET  /api/company/:id/learning/patterns      — 업무 패턴
 * GET  /api/company/:id/learning/bottlenecks   — 병목 탐지
 * GET  /api/company/:id/learning/opportunities — 자동화 기회
 * GET  /api/company/:id/learning/anomalies     — 이상 징후
 * GET  /api/company/:id/learning/collaboration — 협업 패턴
 * GET  /api/company/:id/learning/processes     — 자동 프로세스 매핑
 *
 * POST /api/gdrive/config                      — Google Drive 설정
 * GET  /api/gdrive/config                      — 설정 조회
 * POST /api/gdrive/backup-now                  — 즉시 백업
 * GET  /api/gdrive/logs                        — 백업 로그
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');

module.exports = function createCompanyLearningRouter({ getDb }) {
  const router = Router();

  function db() { return getDb(); }

  // ── 종합 학습 리포트 ──────────────────────────────────────────────────────
  router.get('/company/:id/learning/report', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const report = engine.generateCompanyLearningReport(db(), req.params.id);
      if (!report) return res.status(404).json({ error: 'company not found' });
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/patterns', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const days = parseInt(req.query.days) || 7;
      const patterns = engine.analyzeWorkPatterns(db(), req.params.id, days);
      res.json(patterns);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/bottlenecks', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const days = parseInt(req.query.days) || 7;
      const result = engine.detectBottlenecks(db(), req.params.id, days);
      res.json({ bottlenecks: result, total: result.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/opportunities', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const result = engine.discoverAutomationOpportunities(db(), req.params.id);
      const totalSavings = result.reduce((s, o) => s + (o.estimatedSavingsKrw || 0), 0);
      res.json({ opportunities: result, total: result.length, totalSavingsKrw: totalSavings });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/anomalies', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const result = engine.detectAnomalies(db(), req.params.id);
      res.json({ anomalies: result, total: result.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/collaboration', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const result = engine.analyzeCollaboration(db(), req.params.id);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/learning/processes', (req, res) => {
    try {
      const engine = require('../src/company-learning-engine');
      const result = engine.autoMapProcesses(db(), req.params.id);
      res.json({ processes: result, total: result.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Google Drive 백업 관리
  // ══════════════════════════════════════════════════════════════════════════

  router.get('/gdrive/config', (req, res) => {
    try {
      const gdrive = require('../src/gdrive-backup');
      res.json({ config: gdrive.loadConfig() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/gdrive/config', (req, res) => {
    try {
      const gdrive = require('../src/gdrive-backup');
      gdrive.saveConfig(req.body);
      res.json({ ok: true, config: gdrive.loadConfig() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/gdrive/backup-now', async (req, res) => {
    try {
      const gdrive = require('../src/gdrive-backup');
      const result = await gdrive.runBackup(db());
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/gdrive/logs', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const logs = db().prepare(
        'SELECT * FROM gdrive_backup_log ORDER BY backed_up_at DESC LIMIT ?'
      ).all(limit);
      res.json({ logs, total: logs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
