/**
 * routes/agent-data.js
 * 데스크톱 에이전트 데이터 수신 API
 *
 * POST /api/agent-data — 분석 결과 수신 (작업 그래프, 피드백 등)
 * GET  /api/agent-data/tasks — 학습된 작업 목록
 * GET  /api/agent-data/feedback — 미확인 피드백
 */
const express = require('express');
const router = express.Router();

module.exports = function agentDataRoutes(dbModule) {
  const db = dbModule;

  // ── 테이블 생성 ─────────────────────────────────────────
  async function ensureTables() {
    try {
      if (db.raw) {
        // PostgreSQL
        await db.raw(`
          CREATE TABLE IF NOT EXISTS agent_task_graphs (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            task_name TEXT NOT NULL,
            category TEXT DEFAULT '',
            steps_json TEXT DEFAULT '[]',
            apps_json TEXT DEFAULT '[]',
            frequency TEXT DEFAULT '',
            avg_duration_min REAL DEFAULT 0,
            automation_score REAL DEFAULT 0,
            data_flow TEXT DEFAULT '',
            automation_method TEXT DEFAULT '',
            is_repetitive BOOLEAN DEFAULT false,
            first_seen TIMESTAMPTZ DEFAULT NOW(),
            last_seen TIMESTAMPTZ DEFAULT NOW(),
            occurrence_count INT DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS agent_analyses (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            analyzed_at TIMESTAMPTZ DEFAULT NOW(),
            events_count INT DEFAULT 0,
            work_pattern_json TEXT DEFAULT '{}',
            feedback_json TEXT DEFAULT '{}',
            tasks_count INT DEFAULT 0,
            input_tokens INT DEFAULT 0,
            output_tokens INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS agent_feedback (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'medium',
            actionable BOOLEAN DEFAULT true,
            acknowledged BOOLEAN DEFAULT false,
            source_analysis_id INT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_atg_user ON agent_task_graphs(user_id);
          CREATE INDEX IF NOT EXISTS idx_aa_user ON agent_analyses(user_id);
          CREATE INDEX IF NOT EXISTS idx_af_user ON agent_feedback(user_id, acknowledged);
        `);
      } else {
        // SQLite
        const d = db.getDb ? db.getDb() : db;
        d.exec(`
          CREATE TABLE IF NOT EXISTS agent_task_graphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            task_name TEXT NOT NULL,
            category TEXT DEFAULT '',
            steps_json TEXT DEFAULT '[]',
            apps_json TEXT DEFAULT '[]',
            frequency TEXT DEFAULT '',
            avg_duration_min REAL DEFAULT 0,
            automation_score REAL DEFAULT 0,
            data_flow TEXT DEFAULT '',
            automation_method TEXT DEFAULT '',
            is_repetitive INTEGER DEFAULT 0,
            first_seen TEXT DEFAULT (datetime('now')),
            last_seen TEXT DEFAULT (datetime('now')),
            occurrence_count INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS agent_analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            analyzed_at TEXT DEFAULT (datetime('now')),
            events_count INTEGER DEFAULT 0,
            work_pattern_json TEXT DEFAULT '{}',
            feedback_json TEXT DEFAULT '{}',
            tasks_count INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS agent_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'medium',
            actionable INTEGER DEFAULT 1,
            acknowledged INTEGER DEFAULT 0,
            source_analysis_id INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
      }
    } catch (err) {
      console.error('[agent-data] 테이블 생성 오류:', err.message);
    }
  }

  // 서버 시작 시 테이블 생성
  ensureTables();

  // ── POST /api/agent-data ───────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const userId = req.body.user_id || req.userId;
      if (!userId) {
        return res.status(401).json({ error: '사용자 인증 필요' });
      }

      const { type, data, timestamp } = req.body;

      if (type === 'agent.analysis') {
        // 분석 결과 저장
        const tasks = data.tasks || [];
        const workPattern = data.work_pattern || {};
        const feedback = data.feedback || {};

        if (db.raw) {
          // PostgreSQL
          const result = await db.raw(`
            INSERT INTO agent_analyses (user_id, analyzed_at, events_count, work_pattern_json, feedback_json, tasks_count)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
          `, [userId, timestamp || new Date().toISOString(), data.events_count || 0,
              JSON.stringify(workPattern), JSON.stringify(feedback), tasks.length]);

          const analysisId = result.rows?.[0]?.id;

          // 작업 그래프 upsert
          for (const task of tasks) {
            await db.raw(`
              INSERT INTO agent_task_graphs
                (user_id, task_name, category, steps_json, apps_json, frequency,
                 avg_duration_min, automation_score, data_flow, automation_method, is_repetitive)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (user_id, task_name)
                DO UPDATE SET
                  steps_json = EXCLUDED.steps_json,
                  apps_json = EXCLUDED.apps_json,
                  avg_duration_min = EXCLUDED.avg_duration_min,
                  automation_score = EXCLUDED.automation_score,
                  last_seen = NOW(),
                  occurrence_count = agent_task_graphs.occurrence_count + 1
            `, [userId, task.task_name, task.category || '',
                JSON.stringify(task.steps || []), JSON.stringify(task.apps_used || []),
                task.frequency_guess || '', task.duration_min || 0,
                task.automation_score || 0, task.data_flow || '',
                task.automation_method || '', task.is_repetitive || false]);
          }

          // 피드백 저장 (actionable만)
          if (feedback.actionable && feedback.message) {
            await db.raw(`
              INSERT INTO agent_feedback (user_id, message, priority, source_analysis_id)
              VALUES ($1, $2, $3, $4)
            `, [userId, feedback.message, feedback.priority || 'medium', analysisId]);
          }

        } else {
          // SQLite
          const d = db.getDb ? db.getDb() : db;
          const stmt = d.prepare(`
            INSERT INTO agent_analyses (user_id, analyzed_at, events_count, work_pattern_json, feedback_json, tasks_count)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          const info = stmt.run(userId, timestamp || new Date().toISOString(),
            data.events_count || 0, JSON.stringify(workPattern),
            JSON.stringify(feedback), tasks.length);

          for (const task of tasks) {
            d.prepare(`
              INSERT OR REPLACE INTO agent_task_graphs
                (user_id, task_name, category, steps_json, apps_json, frequency,
                 avg_duration_min, automation_score, data_flow, automation_method, is_repetitive)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, task.task_name, task.category || '',
              JSON.stringify(task.steps || []), JSON.stringify(task.apps_used || []),
              task.frequency_guess || '', task.duration_min || 0,
              task.automation_score || 0, task.data_flow || '',
              task.automation_method || '', task.is_repetitive ? 1 : 0);
          }

          if (feedback.actionable && feedback.message) {
            d.prepare(`
              INSERT INTO agent_feedback (user_id, message, priority, source_analysis_id)
              VALUES (?, ?, ?, ?)
            `).run(userId, feedback.message, feedback.priority || 'medium', info.lastInsertRowid);
          }
        }

        return res.json({ ok: true, tasks_saved: tasks.length });

      } else if (type === 'agent.task_graph') {
        // 개별 작업 그래프
        const task = data;
        if (db.raw) {
          await db.raw(`
            INSERT INTO agent_task_graphs
              (user_id, task_name, category, steps_json, apps_json, frequency,
               avg_duration_min, automation_score)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (user_id, task_name)
              DO UPDATE SET last_seen = NOW(), occurrence_count = agent_task_graphs.occurrence_count + 1
          `, [userId, task.task_name, task.category || '',
              JSON.stringify(task.steps || []), JSON.stringify(task.apps_used || []),
              task.frequency_guess || '', task.duration_min || 0, task.automation_score || 0]);
        }
        return res.json({ ok: true });
      }

      return res.status(400).json({ error: `알 수 없는 타입: ${type}` });

    } catch (err) {
      console.error('[agent-data] 오류:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/agent-data/tasks ──────────────────────────
  router.get('/tasks', async (req, res) => {
    try {
      const userId = req.userId || req.query.user_id;
      if (!userId) return res.status(401).json({ error: '인증 필요' });

      let tasks;
      if (db.raw) {
        const result = await db.raw(`
          SELECT * FROM agent_task_graphs
          WHERE user_id = $1
          ORDER BY automation_score DESC, occurrence_count DESC
        `, [userId]);
        tasks = result.rows || [];
      } else {
        const d = db.getDb ? db.getDb() : db;
        tasks = d.prepare(`
          SELECT * FROM agent_task_graphs WHERE user_id = ? ORDER BY automation_score DESC
        `).all(userId);
      }

      // JSON 파싱
      tasks = tasks.map(t => ({
        ...t,
        steps: JSON.parse(t.steps_json || '[]'),
        apps: JSON.parse(t.apps_json || '[]'),
      }));

      return res.json({ tasks, count: tasks.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/agent-data/feedback ───────────────────────
  router.get('/feedback', async (req, res) => {
    try {
      const userId = req.userId || req.query.user_id;
      if (!userId) return res.status(401).json({ error: '인증 필요' });

      let feedbacks;
      if (db.raw) {
        const result = await db.raw(`
          SELECT * FROM agent_feedback
          WHERE user_id = $1 AND acknowledged = false
          ORDER BY created_at DESC LIMIT 20
        `, [userId]);
        feedbacks = result.rows || [];
      } else {
        const d = db.getDb ? db.getDb() : db;
        feedbacks = d.prepare(`
          SELECT * FROM agent_feedback WHERE user_id = ? AND acknowledged = 0
          ORDER BY created_at DESC LIMIT 20
        `).all(userId);
      }

      return res.json({ feedbacks, count: feedbacks.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/agent-data/feedback/:id/ack ──────────────
  router.post('/feedback/:id/ack', async (req, res) => {
    try {
      const { id } = req.params;
      if (db.raw) {
        await db.raw('UPDATE agent_feedback SET acknowledged = true WHERE id = $1', [id]);
      } else {
        const d = db.getDb ? db.getDb() : db;
        d.prepare('UPDATE agent_feedback SET acknowledged = 1 WHERE id = ?').run(id);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
