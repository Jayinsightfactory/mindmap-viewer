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

  // ═══════════════════════════════════════════════════════════════
  // 자동 스케줄러 — 매일 04:00 KST (19:00 UTC) DB 용량 체크
  // 80% 이상이면 자동 아카이브 (90일 이전 데이터 삭제)
  // ═══════════════════════════════════════════════════════════════

  const ARCHIVE_KEEP_DAYS = 90;     // 최근 90일은 무조건 보존
  const ARCHIVE_THRESHOLD = 0.75;   // 75% 넘으면 아카이브 시작
  const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6시간마다 체크

  async function _autoArchiveCheck() {
    try {
      const db = getDb();
      if (!db?.query) return;

      const sizeRes = await db.query(`SELECT pg_database_size('railway') as bytes`);
      const dbBytes = parseInt(sizeRes.rows[0]?.bytes || 0);
      const dbMB = dbBytes / 1024 / 1024;
      const limitMB = 1024;
      const usage = dbMB / limitMB;

      console.log(`[data-archive] 자동 체크: ${Math.round(dbMB)}MB / ${limitMB}MB (${Math.round(usage * 100)}%)`);

      if (usage < ARCHIVE_THRESHOLD) {
        console.log(`[data-archive] 정상 범위 — 아카이브 불필요`);
        return;
      }

      // 75% 이상: 노이즈 이벤트 먼저 삭제 (install.progress, daemon.update 등)
      const noiseTypes = ['install.progress', 'install.diag', 'daemon.update', 'daemon.error'];
      const noiseRes = await db.query(`
        DELETE FROM events
        WHERE type = ANY($1)
          AND timestamp::timestamptz < NOW() - INTERVAL '7 days'
        RETURNING id
      `, [noiseTypes]);
      const noiseDeleted = noiseRes.rowCount || 0;

      if (noiseDeleted > 0) {
        console.log(`[data-archive] 노이즈 삭제: ${noiseDeleted}건 (install/daemon 7일 이전)`);
      }

      // 다시 체크
      const sizeRes2 = await db.query(`SELECT pg_database_size('railway') as bytes`);
      const dbMB2 = parseInt(sizeRes2.rows[0]?.bytes || 0) / 1024 / 1024;
      const usage2 = dbMB2 / limitMB;

      if (usage2 < ARCHIVE_THRESHOLD) {
        console.log(`[data-archive] 노이즈 삭제 후 정상 범위: ${Math.round(dbMB2)}MB (${Math.round(usage2 * 100)}%)`);
        return;
      }

      // 여전히 75% 이상: idle 이벤트 삭제 (30일 이전)
      const idleRes = await db.query(`
        DELETE FROM events
        WHERE type = 'idle'
          AND timestamp::timestamptz < NOW() - INTERVAL '30 days'
        RETURNING id
      `);
      const idleDeleted = idleRes.rowCount || 0;
      if (idleDeleted > 0) {
        console.log(`[data-archive] idle 삭제: ${idleDeleted}건 (30일 이전)`);
      }

      // 다시 체크
      const sizeRes3 = await db.query(`SELECT pg_database_size('railway') as bytes`);
      const dbMB3 = parseInt(sizeRes3.rows[0]?.bytes || 0) / 1024 / 1024;
      const usage3 = dbMB3 / limitMB;

      if (usage3 < ARCHIVE_THRESHOLD) {
        console.log(`[data-archive] idle 삭제 후 정상: ${Math.round(dbMB3)}MB (${Math.round(usage3 * 100)}%)`);
        return;
      }

      // 여전히 75% 이상: 90일 이전 데이터 삭제 (학습 데이터 보존 기간 초과분)
      const archiveRes = await db.query(`
        DELETE FROM events
        WHERE timestamp::timestamptz < NOW() - INTERVAL '${ARCHIVE_KEEP_DAYS} days'
        RETURNING id
      `);
      const archived = archiveRes.rowCount || 0;
      console.log(`[data-archive] ${ARCHIVE_KEEP_DAYS}일 이전 아카이브: ${archived}건 삭제`);

      // 최종 상태
      const finalRes = await db.query(`SELECT pg_database_size('railway') as bytes`);
      const finalMB = parseInt(finalRes.rows[0]?.bytes || 0) / 1024 / 1024;
      console.log(`[data-archive] 최종: ${Math.round(finalMB)}MB (${Math.round(finalMB / limitMB * 100)}%)`);

    } catch (err) {
      console.error(`[data-archive] 자동 체크 에러:`, err.message);
    }
  }

  // 서버 시작 5분 후 첫 체크, 이후 6시간마다
  setTimeout(() => {
    _autoArchiveCheck();
    setInterval(_autoArchiveCheck, CHECK_INTERVAL);
  }, 5 * 60 * 1000);

  console.log('[data-archive] 자동 스케줄러 시작 (6시간마다 체크, 75% 이상 시 자동 정리)');

  return router;
}

module.exports = createDataArchiveRouter;
