/**
 * routes/workspace-activity.js
 * 워크스페이스 협업 신호 분석
 * - events 테이블에서 협업 패턴 추출
 * - workspace_activity에 저장
 */

const { Router } = require('express');

module.exports = function createWorkspaceActivityRouter() {
  const router = Router();

  // ── DB 획득 (PG or SQLite 자동 감지) ──────────────────────────────────
  function _getDb() {
    try {
      const mod = process.env.DATABASE_URL ? require('../src/db-pg') : require('../src/db');
      return typeof mod.getDb === 'function' ? mod.getDb() : null;
    } catch { return null; }
  }

  // ── DB 헬퍼 (? → $N 자동 변환) ────────────────────────────────────────
  function _toPg(sql) {
    let i = 0;
    let s = sql.replace(/\?/g, () => `$${++i}`);
    s = s.replace(/datetime\('now'\)/g, 'NOW()');
    return s;
  }
  function dbAll(sql, params = []) {
    const db = _getDb();
    if (!db) return [];
    if (db.prepare) return db.prepare(sql).all(...params);
    return db.query(_toPg(sql), params).then(r => r.rows);
  }
  function dbRun(sql, params = []) {
    const db = _getDb();
    if (!db) return;
    if (db.prepare) return db.prepare(sql).run(...params);
    return db.query(_toPg(sql), params);
  }

  // ─── 유틸리티: 시간 겹침 감지 ──────────────────────────────────────────
  function calculateEventOverlap(events1, events2, windowMs = 60 * 60 * 1000) {
    let overlap = 0;
    events1.forEach(e1 => {
      const t1 = new Date(e1.timestamp).getTime();
      events2.forEach(e2 => {
        const t2 = new Date(e2.timestamp).getTime();
        if (Math.abs(t1 - t2) < windowMs) overlap++;
      });
    });
    return overlap;
  }

  // ─── 협업 신호 분석 엔진 ────────────────────────────────────────────────
  async function analyzeWorkspaceActivity(workspaceId, timePeriodHours = 24) {
    try {
      console.log(`[workspace-activity] 분석 시작: ws=${workspaceId}, period=${timePeriodHours}h`);

      const members = await Promise.resolve(dbAll(
        'SELECT DISTINCT user_id FROM workspace_members WHERE workspace_id = ?',
        [workspaceId]
      ));
      if (!members || members.length === 0) {
        console.log('[workspace-activity] 분석 대상 멤버 없음');
        return { analyzed: 0, saved: 0 };
      }

      const since = new Date(Date.now() - timePeriodHours * 3600000).toISOString();
      const memberIds = members.map(m => m.user_id);

      // PG/SQLite 호환 IN 절 생성
      const db = _getDb();
      let events;
      if (db && db.prepare) {
        // SQLite
        const placeholders = memberIds.map(() => '?').join(',');
        events = db.prepare(
          `SELECT user_id, type, timestamp, data_json FROM events
           WHERE user_id IN (${placeholders}) AND timestamp > ?
           ORDER BY timestamp ASC`
        ).all(...memberIds, since);
      } else if (db) {
        // PG: $1,$2,...,$N,$N+1
        const placeholders = memberIds.map((_, i) => `$${i + 1}`).join(',');
        const r = await db.query(
          `SELECT user_id, type, timestamp, data_json FROM events
           WHERE user_id IN (${placeholders}) AND timestamp > $${memberIds.length + 1}
           ORDER BY timestamp ASC`,
          [...memberIds, since]
        );
        events = r.rows;
      } else {
        events = [];
      }

      console.log(`[workspace-activity] 분석 대상 이벤트: ${events.length}`);

      const userSessions = {};
      members.forEach(m => {
        userSessions[m.user_id] = events.filter(e => e.user_id === m.user_id);
      });

      let savedCount = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const m1 = members[i], m2 = members[j];
          const overlap = calculateEventOverlap(
            userSessions[m1.user_id] || [],
            userSessions[m2.user_id] || [],
            60 * 60 * 1000
          );
          if (overlap > 0) {
            const strength = Math.min(overlap / 5, 1.0);
            const [id1, id2] = [m1.user_id, m2.user_id].sort();
            await Promise.resolve(dbRun(
              `INSERT INTO workspace_activity (workspace_id, user_id_1, user_id_2, activity_type, strength)
               VALUES (?, ?, ?, 'file_collab', ?)
               ON CONFLICT DO NOTHING`,
              [workspaceId, id1, id2, strength]
            ));
            savedCount++;
          }
        }
      }

      console.log(`[workspace-activity] 분석 완료: ${savedCount}개 협업 관계 저장`);
      return { analyzed: memberIds.length, saved: savedCount };
    } catch (e) {
      console.error('[workspace-activity] analyzeWorkspaceActivity error:', e);
      throw e;
    }
  }

  // ─── API 엔드포인트 ───────────────────────────────────────────────────────

  router.post('/workspace/:workspaceId/activity/analyze', async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const { hours = 24 } = req.body;
      const result = await analyzeWorkspaceActivity(workspaceId, hours);
      res.json({ ok: true, message: `협업 신호 분석 완료: ${result.saved}개 관계 저장`, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspace/:workspaceId/activity/all', async (req, res) => {
    try {
      const activities = await Promise.resolve(dbAll(
        'SELECT * FROM workspace_activity WHERE workspace_id = ? ORDER BY strength DESC',
        [req.params.workspaceId]
      ));
      res.json({ ok: true, workspaceId: req.params.workspaceId, total: activities.length, activities });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspace/:workspaceId/activity/user/:userId', async (req, res) => {
    try {
      const { workspaceId, userId } = req.params;
      const activities = await Promise.resolve(dbAll(
        `SELECT CASE WHEN user_id_1 = ? THEN user_id_2 ELSE user_id_1 END as collab_user,
                strength, activity_type, last_interaction
         FROM workspace_activity
         WHERE workspace_id = ? AND (user_id_1 = ? OR user_id_2 = ?)
         ORDER BY strength DESC`,
        [userId, workspaceId, userId, userId]
      ));
      res.json({ ok: true, workspaceId, userId, collaborations: activities, total: activities.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/workspace/:workspaceId/activity/strength/:userId1/:userId2', async (req, res) => {
    try {
      const { workspaceId, userId1, userId2 } = req.params;
      const { delta = 0.1 } = req.body;
      const [id1, id2] = [userId1, userId2].sort();
      await Promise.resolve(dbRun(
        `UPDATE workspace_activity SET strength = LEAST(1.0, strength + ?), last_interaction = NOW()
         WHERE workspace_id = ? AND user_id_1 = ? AND user_id_2 = ?`,
        [delta, workspaceId, id1, id2]
      ));
      res.json({ ok: true, message: `협업 강도 업데이트: +${delta}`, workspaceId, users: [userId1, userId2] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/workspace/:workspaceId/activity/:userId1/:userId2', async (req, res) => {
    try {
      const { workspaceId, userId1, userId2 } = req.params;
      const [id1, id2] = [userId1, userId2].sort();
      await Promise.resolve(dbRun(
        'DELETE FROM workspace_activity WHERE workspace_id = ? AND user_id_1 = ? AND user_id_2 = ?',
        [workspaceId, id1, id2]
      ));
      res.json({ ok: true, message: '협업 관계 삭제됨', workspaceId, users: [userId1, userId2] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
