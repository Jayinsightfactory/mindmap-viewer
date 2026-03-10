/**
 * routes/nodes.js
 * 3D 노드 생성 및 분류 API
 */

const { Router } = require('express');
const classificationEngine = require('../src/node-classification-engine');
const orbitalLayout = require('../src/orbital-layout');

module.exports = function createNodesRouter({ getDb }) {
  const router = Router();

  /**
   * GET /api/nodes/analyze
   * 추적 데이터 분석 → 자동 노드 생성
   */
  router.get('/nodes/analyze', (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(500).json({ error: 'Database not initialized' });

      // 도메인별 분류
      const domainStats = classificationEngine.aggregateByDomain(db);

      // 궤도 레이아웃 생성
      const layout = orbitalLayout.generateOrbitalLayout(domainStats);

      // 시간대 분석
      const temporal = classificationEngine.analyzeTemporalPatterns(db);

      res.json({
        ok: true,
        layout: {
          planets: layout.planets,
          moons: layout.moons
        },
        statistics: {
          totalEvents: Object.values(domainStats).reduce((sum, d) => sum + d.count, 0),
          domains: domainStats,
          temporal
        }
      });
    } catch (e) {
      console.error('[nodes/analyze]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/nodes/domain/:domain
   * 특정 도메인의 세부 노드 조회 (드릴다운)
   */
  router.get('/nodes/domain/:domain', (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(500).json({ error: 'Database not initialized' });

      const domain = req.params.domain;
      
      // 도메인별 상세 이벤트 조회
      const sql = `
        SELECT * FROM events
        WHERE type LIKE ? OR data_json LIKE ? OR metadata_json LIKE ?
        ORDER BY timestamp DESC
        LIMIT 100
      `;
      
      const pattern = `%${domain.toLowerCase()}%`;
      const events = db.prepare(sql).all(pattern, pattern, pattern);

      // 도메인별 키워드 분포
      const keywords = {};
      for (const evt of events) {
        const classified = classificationEngine.classifyEvent(evt);
        if (classified.domain === domain) {
          for (const kw of classified.matched) {
            keywords[kw] = (keywords[kw] || 0) + 1;
          }
        }
      }

      res.json({
        ok: true,
        domain,
        events: events.slice(0, 20),
        keywords,
        totalCount: events.length
      });
    } catch (e) {
      console.error('[nodes/domain]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/nodes/structure
   * 현재 3D 노드 구조 조회
   */
  router.get('/nodes/structure', (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(500).json({ error: 'Database not initialized' });

      const domainStats = classificationEngine.aggregateByDomain(db);
      const layout = orbitalLayout.generateOrbitalLayout(domainStats);

      res.json({
        ok: true,
        planets: layout.planets,
        moons: layout.moons,
        summary: {
          totalPlanets: layout.planets.length,
          totalMoons: layout.moons.length,
          totalEvents: Object.values(domainStats).reduce((sum, d) => sum + d.count, 0)
        }
      });
    } catch (e) {
      console.error('[nodes/structure]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
