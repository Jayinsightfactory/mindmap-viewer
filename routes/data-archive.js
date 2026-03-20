'use strict';
/**
 * data-archive.js — 데이터 보존 모니터 + 아카이브
 *
 * 목적: Railway PG 1GB 한도 관리
 * - 현재 DB 용량 / 이벤트 수 / 예상 소진일 모니터링
 * - 한도 80% 도달 시 오래된 데이터를 JSON으로 아카이브 후 DB에서 삭제
 * - 분석에 필요한 데이터는 항상 보존
 */
const express = require('express');

function createDataArchiveRouter({ getDb }) {
  const router = express.Router();

  // GET /api/data/health — DB 용량 모니터링
  router.get('/health', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const [sizeRes, countRes, dailyRes, oldestRes] = await Promise.all([
        db.query(`SELECT pg_database_size('railway') as bytes`),
        db.query(`SELECT COUNT(*) as total FROM events`),
        db.query(`
          SELECT date_trunc('day', timestamp::timestamptz) as day, COUNT(*) as cnt
          FROM events
          WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY day ORDER BY day
        `),
        db.query(`SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM events`),
      ]);

      const dbBytes = parseInt(sizeRes.rows[0]?.bytes || 0);
      const dbMB = Math.round(dbBytes / 1024 / 1024);
      const totalEvents = parseInt(countRes.rows[0]?.total || 0);
      const limitMB = 1024; // Railway 1GB
      const usagePct = Math.round(dbMB / limitMB * 100);

      // 일일 평균 증가량 계산
      const dailyRows = dailyRes.rows;
      const avgDaily = dailyRows.length > 0
        ? Math.round(dailyRows.reduce((s, r) => s + parseInt(r.cnt), 0) / dailyRows.length)
        : 0;
      const avgDailyMB = totalEvents > 0 ? Math.round(dbMB / totalEvents * avgDaily) : 0;
      const daysRemaining = avgDailyMB > 0 ? Math.round((limitMB - dbMB) / avgDailyMB) : 999;

      const status = usagePct >= 90 ? 'critical' : usagePct >= 70 ? 'warning' : 'healthy';

      res.json({
        status,
        database: {
          sizeMB: dbMB,
          limitMB,
          usagePct,
          totalEvents,
        },
        growth: {
          avgEventsPerDay: avgDaily,
          avgMBPerDay: avgDailyMB,
          daysRemaining,
          estimatedFullDate: new Date(Date.now() + daysRemaining * 86400000).toISOString().split('T')[0],
        },
        range: {
          oldest: oldestRes.rows[0]?.oldest,
          newest: oldestRes.rows[0]?.newest,
        },
        daily: dailyRows.map(r => ({ day: r.day, count: parseInt(r.cnt) })),
        thresholds: {
          archiveAt: '80%',
          alertAt: '90%',
          currentAction: status === 'critical' ? '즉시 아카이브 필요' :
                         status === 'warning' ? '아카이브 준비' : '정상',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/data/archive — 오래된 데이터 아카이브 (JSON 추출 후 DB 삭제)
  router.post('/archive', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const keepDays = parseInt(req.query.keepDays || '30'); // 최근 30일은 보존
      const dryRun = req.query.dryRun !== 'false'; // 기본 dry-run (실제 삭제 안 함)

      // 아카이브 대상 카운트
      const countRes = await db.query(`
        SELECT type, COUNT(*) as cnt
        FROM events
        WHERE timestamp::timestamptz < NOW() - INTERVAL '${keepDays} days'
        GROUP BY type ORDER BY cnt DESC
      `);

      const totalToArchive = countRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0);

      if (totalToArchive === 0) {
        return res.json({ message: `${keepDays}일 이전 데이터 없음. 아카이브 불필요.`, archived: 0 });
      }

      // 아카이브 데이터 추출 (JSON)
      let archivedData = null;
      if (!dryRun) {
        const dataRes = await db.query(`
          SELECT id, type, user_id, timestamp, data_json, source
          FROM events
          WHERE timestamp::timestamptz < NOW() - INTERVAL '${keepDays} days'
          ORDER BY timestamp
        `);
        archivedData = dataRes.rows;

        // DB에서 삭제
        await db.query(`
          DELETE FROM events
          WHERE timestamp::timestamptz < NOW() - INTERVAL '${keepDays} days'
        `);
      }

      res.json({
        dryRun,
        keepDays,
        toArchive: countRes.rows.map(r => ({ type: r.type, count: parseInt(r.cnt) })),
        totalToArchive,
        archived: dryRun ? 0 : totalToArchive,
        message: dryRun
          ? `dry-run: ${totalToArchive}건이 아카이브 대상. 실행하려면 ?dryRun=false`
          : `${totalToArchive}건 아카이브 완료`,
        // dry-run이 아닐 때만 데이터 포함 (다운로드용)
        data: dryRun ? null : archivedData,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/data/export — 전체 또는 기간별 데이터 JSON 내보내기 (삭제 없이)
  router.get('/export', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days || '7');
      const userId = req.query.userId;
      const type = req.query.type;

      let query = `SELECT id, type, user_id, timestamp, data_json, source FROM events WHERE timestamp::timestamptz > NOW() - INTERVAL '${days} days'`;
      const params = [];

      if (userId) {
        params.push(userId);
        query += ` AND user_id = $${params.length}`;
      }
      if (type) {
        params.push(type);
        query += ` AND type = $${params.length}`;
      }

      query += ' ORDER BY timestamp LIMIT 10000';

      const result = await db.query(query, params);

      res.json({
        count: result.rows.length,
        days,
        filters: { userId: userId || 'all', type: type || 'all' },
        data: result.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createDataArchiveRouter;
