/**
 * routes/workspace-activity.js
 * 워크스페이스 협업 신호 분석
 * - events 테이블에서 협업 패턴 추출
 * - workspace_activity에 저장
 */

const { Router } = require('express');
const { getDb, getWorkspaceActivityByUser, saveWorkspaceActivity } = require('../src/db');
const { verifyToken } = require('../src/auth');

module.exports = function createWorkspaceActivityRouter() {
  const router = Router();

  // ─── 유틸리티: 시간 겹침 감지 ──────────────────────────────────────────
  /**
   * 두 사용자의 이벤트 시간대 겹침 계산
   * @param {Array} events1 - 사용자1의 이벤트 배열
   * @param {Array} events2 - 사용자2의 이벤트 배열
   * @param {number} windowMs - 시간 윈도우 (기본 1시간)
   * @returns {number} - 겹친 이벤트 수
   */
  function calculateEventOverlap(events1, events2, windowMs = 60 * 60 * 1000) {
    let overlap = 0;

    events1.forEach(e1 => {
      const t1 = new Date(e1.timestamp).getTime();

      events2.forEach(e2 => {
        const t2 = new Date(e2.timestamp).getTime();
        const timeDiff = Math.abs(t1 - t2);

        if (timeDiff < windowMs) {
          overlap++;
        }
      });
    });

    return overlap;
  }

  // ─── 협업 신호 분석 엔진 ────────────────────────────────────────────────
  /**
   * 워크스페이스의 협업 신호 분석 및 저장
   * @param {string} workspaceId - 워크스페이스 ID
   * @param {number} timePeriodHours - 분석 시간 범위 (기본 24시간)
   */
  async function analyzeWorkspaceActivity(workspaceId, timePeriodHours = 24) {
    const db = getDb();

    try {
      console.log(`[workspace-activity] 분석 시작: ws=${workspaceId}, period=${timePeriodHours}h`);

      // 1. 워크스페이스 멤버 목록 조회
      const members = db.prepare(`
        SELECT DISTINCT user_id FROM workspace_members
        WHERE workspace_id = ?
      `).all(workspaceId);

      if (members.length === 0) {
        console.log('[workspace-activity] 분석 대상 멤버 없음');
        return { analyzed: 0, saved: 0 };
      }

      console.log(`[workspace-activity] 멤버 수: ${members.length}`);

      // 2. 시간 범위 내 이벤트 조회
      const since = new Date(Date.now() - timePeriodHours * 3600000).toISOString();
      const memberIds = members.map(m => m.user_id);

      const events = db.prepare(`
        SELECT user_id, type, timestamp, data_json
        FROM events
        WHERE user_id IN (${memberIds.map(() => '?').join(',')})
        AND timestamp > ?
        ORDER BY timestamp ASC
      `).all(...memberIds, since);

      console.log(`[workspace-activity] 분석 대상 이벤트: ${events.length}`);

      // 3. 사용자별 이벤트 그룹화
      const userSessions = {};
      members.forEach(m => {
        userSessions[m.user_id] = events.filter(e => e.user_id === m.user_id);
      });

      // 4. 협업 신호 계산 (멤버 쌍별)
      const collaborations = {};
      let savedCount = 0;

      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const m1 = members[i];
          const m2 = members[j];

          // 시간 겹침 계산
          const overlap = calculateEventOverlap(
            userSessions[m1.user_id] || [],
            userSessions[m2.user_id] || [],
            60 * 60 * 1000 // 1시간 윈도우
          );

          if (overlap > 0) {
            // 협업 강도 정규화 (0-1 범위)
            const strength = Math.min(overlap / 5, 1.0);

            // DB에 저장
            saveWorkspaceActivity(
              workspaceId,
              m1.user_id,
              m2.user_id,
              'file_collab',
              strength
            );

            collaborations[`${m1.user_id}:${m2.user_id}`] = {
              user1: m1.user_id,
              user2: m2.user_id,
              strength,
              overlapCount: overlap
            };

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

  /**
   * POST /api/workspace/:workspaceId/activity/analyze
   * 협업 신호 분석 및 저장
   */
  router.post('/workspace/:workspaceId/activity/analyze', async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const { hours = 24 } = req.body;

      const result = await analyzeWorkspaceActivity(workspaceId, hours);

      res.json({
        ok: true,
        message: `협업 신호 분석 완료: ${result.saved}개 관계 저장`,
        result
      });
    } catch (e) {
      console.error('[workspace-activity] analyze error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/workspace/:workspaceId/activity/all
   * 워크스페이스의 모든 협업 관계 조회
   */
  router.get('/workspace/:workspaceId/activity/all', (req, res) => {
    try {
      const { workspaceId } = req.params;
      const db = getDb();

      const activities = db.prepare(`
        SELECT * FROM workspace_activity
        WHERE workspace_id = ?
        ORDER BY strength DESC
      `).all(workspaceId);

      res.json({
        ok: true,
        workspaceId,
        total: activities.length,
        activities
      });
    } catch (e) {
      console.error('[workspace-activity] getAll error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/workspace/:workspaceId/activity/user/:userId
   * 특정 사용자의 협업 관계 조회
   */
  router.get('/workspace/:workspaceId/activity/user/:userId', (req, res) => {
    try {
      const { workspaceId, userId } = req.params;
      const db = getDb();

      const activities = db.prepare(`
        SELECT
          CASE
            WHEN user_id_1 = ? THEN user_id_2
            ELSE user_id_1
          END as collab_user,
          strength,
          activity_type,
          last_interaction
        FROM workspace_activity
        WHERE workspace_id = ? AND (user_id_1 = ? OR user_id_2 = ?)
        ORDER BY strength DESC
      `).all(userId, workspaceId, userId, userId);

      res.json({
        ok: true,
        workspaceId,
        userId,
        collaborations: activities,
        total: activities.length
      });
    } catch (e) {
      console.error('[workspace-activity] getByUser error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/workspace/:workspaceId/activity/strength/:userId1/:userId2
   * 두 사용자 간 협업 강도 업데이트
   */
  router.post('/workspace/:workspaceId/activity/strength/:userId1/:userId2', (req, res) => {
    try {
      const { workspaceId, userId1, userId2 } = req.params;
      const { delta = 0.1 } = req.body;
      const db = getDb();

      const [id1, id2] = [userId1, userId2].sort();

      db.prepare(`
        UPDATE workspace_activity
        SET strength = MIN(1.0, strength + ?),
            last_interaction = datetime('now')
        WHERE workspace_id = ? AND user_id_1 = ? AND user_id_2 = ?
      `).run(delta, workspaceId, id1, id2);

      res.json({
        ok: true,
        message: `협업 강도 업데이트: +${delta}`,
        workspaceId,
        users: [userId1, userId2]
      });
    } catch (e) {
      console.error('[workspace-activity] updateStrength error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/workspace/:workspaceId/activity/:userId1/:userId2
   * 협업 관계 삭제
   */
  router.delete('/workspace/:workspaceId/activity/:userId1/:userId2', (req, res) => {
    try {
      const { workspaceId, userId1, userId2 } = req.params;
      const db = getDb();

      const [id1, id2] = [userId1, userId2].sort();

      db.prepare(`
        DELETE FROM workspace_activity
        WHERE workspace_id = ? AND user_id_1 = ? AND user_id_2 = ?
      `).run(workspaceId, id1, id2);

      res.json({
        ok: true,
        message: '협업 관계 삭제됨',
        workspaceId,
        users: [userId1, userId2]
      });
    } catch (e) {
      console.error('[workspace-activity] delete error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
