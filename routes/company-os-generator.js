'use strict';

const express = require('express');
const {
  CAPABILITIES,
  buildNonExecutableSimulation,
  evaluateComputerUseReadiness,
} = require('../src/computer-use-capability-model');
const {
  GENERATION_AGENT,
  OS_LAYERS,
  scanWorkspace,
  buildGenerationBrief,
} = require('../src/company-os-generation-agent');

function createCompanyOsGenerator({ getDb, rootDir } = {}) {
  const router = express.Router();

  router.get('/capabilities', (_req, res) => {
    res.json({
      ok: true,
      stage: 'structure_only',
      employeeFacing: false,
      executionEnabled: false,
      generator: GENERATION_AGENT,
      osLayers: OS_LAYERS,
      computerUseCapabilities: CAPABILITIES,
    });
  });

  router.get('/workspace-map', (req, res) => {
    try {
      const workspace = scanWorkspace(rootDir || process.cwd(), {
        maxFiles: req.query.limit || 800,
        maxDepth: req.query.depth || 4,
      });
      res.json({ ok: true, ...workspace });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/evaluate', async (req, res) => {
    try {
      const db = getDb && getDb();
      const days = clampInt(req.query.days, 1, 30, 7);
      const limit = clampInt(req.query.limit, 50, 5000, 1000);
      const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
      const workspace = scanWorkspace(rootDir || process.cwd(), { maxFiles: 800, maxDepth: 4 });

      let events = [];
      let mouseMapRows = [];
      let dbWarning = null;
      if (db && typeof db.query === 'function') {
        try {
          const params = [days, limit];
          let userClause = '';
          if (userId) {
            params.push(userId);
            userClause = ` AND user_id = $${params.length}`;
          }
          const eventResult = await db.query(
            `SELECT id, type, user_id, timestamp, data_json
             FROM events
             WHERE timestamp::timestamptz > NOW() - ($1::int * INTERVAL '1 day')
               AND type IN (
                 'screen.analyzed',
                 'screen.capture',
                 'keyboard.chunk',
                 'mouse.chunk',
                 'browser.navigation',
                 'clipboard.change',
                 'automation.result',
                 'automation.test',
                 'pad.result',
                 'autotest.result'
               )
               ${userClause}
             ORDER BY timestamp DESC
             LIMIT $2`,
            params
          );
          events = eventResult.rows || [];
        } catch (e) {
          dbWarning = `events query failed: ${e.message}`;
        }

        try {
          const mouseResult = await db.query(
            `SELECT element_name, window_title, x, y, confidence, source, sample_count
             FROM pad_mouse_map
             ORDER BY confidence DESC NULLS LAST
             LIMIT 500`
          );
          mouseMapRows = mouseResult.rows || [];
        } catch (e) {
          dbWarning = dbWarning ? `${dbWarning}; pad_mouse_map query failed: ${e.message}` : `pad_mouse_map query failed: ${e.message}`;
        }
      } else {
        dbWarning = 'db.query is not available; returning workspace-only evaluation.';
      }

      const readiness = evaluateComputerUseReadiness(events, mouseMapRows, workspace.repositorySignals);
      const brief = buildGenerationBrief({
        workspaceSummary: workspace,
        readiness,
        objective: req.query.objective || '회사 전체 업무를 하나의 운영 UI로 통합',
      });

      res.json({
        ok: true,
        stage: 'structure_only',
        employeeFacing: false,
        executionEnabled: false,
        days,
        userId: userId || null,
        warning: dbWarning,
        readiness,
        generationBrief: brief,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/simulate', express.json({ limit: '256kb' }), (req, res) => {
    try {
      const workspace = scanWorkspace(rootDir || process.cwd(), { maxFiles: 800, maxDepth: 4 });
      const readiness = evaluateComputerUseReadiness([], [], workspace.repositorySignals);
      res.json({
        ok: true,
        stage: 'simulation_only',
        employeeFacing: false,
        executionEnabled: false,
        simulation: buildNonExecutableSimulation(req.body || {}),
        generationBrief: buildGenerationBrief({
          workspaceSummary: workspace,
          readiness,
          objective: req.body?.intent || '',
        }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

module.exports = createCompanyOsGenerator;
