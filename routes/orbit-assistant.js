'use strict';

/**
 * routes/orbit-assistant.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 어시스턴트 — 작업 데이터 기반 자동화 챗봇
 *
 * 기능:
 *   1. 사용자의 학습된 작업 그래프 기반 대화
 *   2. 반복 작업 → Python 자동화 스크립트 생성
 *   3. Excel/PPT 루틴 → 자동화 기획서 제공
 *   4. API/CLI 자동화 가능 영역 피드백
 *   5. 프로액티브 피드백 (미확인 피드백 알림)
 *
 * 엔드포인트:
 *   POST /api/assistant/chat     — AI 어시스턴트와 대화
 *   GET  /api/assistant/context   — 현재 작업 컨텍스트 요약
 *   GET  /api/assistant/scripts   — 생성된 자동화 스크립트 목록
 *   POST /api/assistant/generate  — 자동화 스크립트 생성 요청
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();

module.exports = function createAssistantRouter({ verifyToken, dbModule }) {
  const getDb = dbModule.getDb || (() => dbModule);

  function _isPg(db) { return db && !db.prepare; }
  function _pgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  async function dbAll(sql, params = []) {
    const db = getDb();
    if (_isPg(db)) {
      const r = await db.query(_pgSql(sql), params);
      return r.rows || [];
    }
    return db.prepare(sql).all(...params);
  }
  async function dbRun(sql, params = []) {
    const db = getDb();
    if (_isPg(db)) return db.query(_pgSql(sql), params);
    return db.prepare(sql).run(...params);
  }

  // ── 인증 미들웨어 ─────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: '인증 필요' });
    req.user = user;
    next();
  }

  // ── 스크립트 저장 테이블 ───────────────────────────────────
  async function ensureTables() {
    try {
      const db = getDb();
      const sql = `
        CREATE TABLE IF NOT EXISTS assistant_scripts (
          id ${_isPg(db) ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${_isPg(db) ? '' : 'AUTOINCREMENT'},
          user_id TEXT NOT NULL,
          task_name TEXT NOT NULL,
          language TEXT DEFAULT 'python',
          code TEXT NOT NULL,
          description TEXT DEFAULT '',
          category TEXT DEFAULT '',
          created_at ${_isPg(db) ? 'TIMESTAMPTZ DEFAULT NOW()' : "TEXT DEFAULT (datetime('now'))"}
        )`;
      const histSql = `
        CREATE TABLE IF NOT EXISTS assistant_history (
          id ${_isPg(db) ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${_isPg(db) ? '' : 'AUTOINCREMENT'},
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at ${_isPg(db) ? 'TIMESTAMPTZ DEFAULT NOW()' : "TEXT DEFAULT (datetime('now'))"}
        )`;
      if (_isPg(db)) {
        await db.query(sql);
        await db.query(histSql);
      } else {
        db.exec(sql);
        db.exec(histSql);
      }
    } catch (e) {
      console.error('[assistant] 테이블 생성:', e.message);
    }
  }
  ensureTables();

  // ── 사용자 작업 컨텍스트 수집 ──────────────────────────────
  async function getUserContext(userId) {
    // 학습된 작업 그래프
    const tasks = await dbAll(
      `SELECT task_name, category, steps_json, apps_json, frequency,
              avg_duration_min, automation_score, occurrence_count
       FROM agent_task_graphs WHERE user_id = ?
       ORDER BY automation_score DESC LIMIT 20`,
      [userId]
    ).catch(() => []);

    // 미확인 피드백
    const feedback = await dbAll(
      `SELECT message, priority FROM agent_feedback
       WHERE user_id = ? AND acknowledged = ${_isPg(getDb()) ? 'false' : '0'}
       ORDER BY created_at DESC LIMIT 5`,
      [userId]
    ).catch(() => []);

    // 최근 분석 결과
    const analyses = await dbAll(
      `SELECT work_pattern_json, feedback_json, analyzed_at
       FROM agent_analyses WHERE user_id = ?
       ORDER BY analyzed_at DESC LIMIT 3`,
      [userId]
    ).catch(() => []);

    // 생성된 스크립트 수
    const scripts = await dbAll(
      `SELECT COUNT(*) as cnt FROM assistant_scripts WHERE user_id = ?`,
      [userId]
    ).catch(() => [{ cnt: 0 }]);

    return { tasks, feedback, analyses, scriptCount: scripts[0]?.cnt || 0 };
  }

  // ── 시스템 프롬프트 생성 ───────────────────────────────────
  function buildSystemPrompt(context) {
    const { tasks, feedback, analyses } = context;

    let taskSummary = '학습된 작업 없음 (데스크톱 에이전트가 데이터 수집 중)';
    if (tasks.length > 0) {
      taskSummary = tasks.map(t => {
        const steps = JSON.parse(t.steps_json || '[]');
        const apps = JSON.parse(t.apps_json || '[]');
        return `- ${t.task_name} (${t.category || '기타'})
  앱: ${apps.join(', ') || '?'} | 빈도: ${t.frequency || '?'} | 소요: ${t.avg_duration_min || '?'}분
  자동화 점수: ${(t.automation_score * 100).toFixed(0)}% | 반복 횟수: ${t.occurrence_count}
  단계: ${steps.slice(0, 5).join(' → ')}`;
      }).join('\n');
    }

    let feedbackSummary = '';
    if (feedback.length > 0) {
      feedbackSummary = '\n\n## 미확인 피드백\n' +
        feedback.map(f => `- [${f.priority}] ${f.message}`).join('\n');
    }

    let patternSummary = '';
    if (analyses.length > 0) {
      try {
        const latest = JSON.parse(analyses[0].work_pattern_json || '{}');
        if (latest.primary_tools) {
          patternSummary = `\n\n## 업무 패턴\n- 주요 도구: ${latest.primary_tools?.join(', ') || '?'}` +
            `\n- 병목: ${latest.bottleneck || '?'}` +
            `\n- 빠른 개선: ${latest.quick_win || '?'}`;
        }
      } catch {}
    }

    return `당신은 Orbit AI 업무 자동화 어시스턴트입니다.

## 역할
사용자의 실제 업무 데이터를 분석하여:
1. 반복 작업을 찾아 자동화 방법을 제안
2. Excel/PPT 등 오피스 작업 → Python 자동화 스크립트 생성
3. API/CLI로 자동화 가능한 영역 피드백
4. 업무 효율 개선 방법 구체적 제안

## 사용자의 학습된 작업 데이터
${taskSummary}
${patternSummary}
${feedbackSummary}

## 응답 규칙
- 한국어로 답변
- 자동화 제안 시 구체적인 도구/코드 포함
- Python 스크립트 요청 시 실행 가능한 완전한 코드 제공
- Excel 작업: openpyxl 또는 pandas 사용
- PPT 작업: python-pptx 사용
- 웹 자동화: selenium 또는 playwright 사용
- 파일 작업: pathlib + shutil 사용
- 코드 블록은 \`\`\`python 으로 감싸기
- 자동화 점수가 높은 작업부터 우선 제안
- "이 작업은 현재 월 X시간 소요 → 자동화 시 Y분" 형태로 효과 제시`;
  }

  // ── Haiku API 호출 ─────────────────────────────────────────
  async function callHaiku(systemPrompt, messages) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return '죄송합니다. AI API 키가 설정되지 않았습니다. 관리자에게 문의하세요.';

    try {
      const { generate } = require('../src/llm-gateway');

      // 대화 이력을 프롬프트로 변환
      const conversationText = messages.map(m =>
        `${m.role === 'user' ? '사용자' : 'Orbit AI'}: ${m.content}`
      ).join('\n');

      const fullPrompt = `${systemPrompt}\n\n## 대화\n${conversationText}\nOrbit AI:`;

      const reply = await generate({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        prompt: fullPrompt,
        apiKey,
      });

      return reply || '죄송합니다, 응답을 생성하지 못했습니다.';
    } catch (e) {
      console.error('[assistant] Haiku 호출 실패:', e.message);
      return `오류가 발생했습니다: ${e.message}`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POST /api/assistant/chat — AI 어시스턴트 대화
  // ═══════════════════════════════════════════════════════════
  router.post('/chat', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const { message } = req.body;
      if (!message || !message.trim()) {
        return res.status(400).json({ error: '메시지를 입력하세요' });
      }

      // 사용자 메시지 저장
      await dbRun(
        'INSERT INTO assistant_history (user_id, role, content) VALUES (?, ?, ?)',
        [userId, 'user', message.trim()]
      );

      // 컨텍스트 수집
      const context = await getUserContext(userId);

      // 대화 이력 (최근 10개)
      const history = await dbAll(
        'SELECT role, content FROM assistant_history WHERE user_id = ? ORDER BY id DESC LIMIT 10',
        [userId]
      ).then(r => r.reverse());

      // AI 응답 생성
      const systemPrompt = buildSystemPrompt(context);
      const reply = await callHaiku(systemPrompt, history);

      // AI 응답 저장
      await dbRun(
        'INSERT INTO assistant_history (user_id, role, content) VALUES (?, ?, ?)',
        [userId, 'assistant', reply]
      );

      // 코드 블록 감지 → 자동 스크립트 저장
      const codeMatch = reply.match(/```python\n([\s\S]*?)```/);
      let savedScript = null;
      if (codeMatch) {
        const code = codeMatch[1].trim();
        // 코드 설명 추출 (코드 블록 앞 텍스트)
        const descMatch = reply.split('```python')[0].trim();
        const description = descMatch.slice(-200);

        await dbRun(
          `INSERT INTO assistant_scripts (user_id, task_name, code, description, category)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, message.trim().slice(0, 100), code, description, 'auto']
        );
        savedScript = { task_name: message.trim().slice(0, 100), language: 'python' };
      }

      res.json({
        reply,
        savedScript,
        context: {
          tasksCount: context.tasks.length,
          pendingFeedback: context.feedback.length,
          scriptsCount: context.scriptCount,
        },
      });

    } catch (e) {
      console.error('[assistant/chat]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /api/assistant/context — 작업 컨텍스트 요약
  // ═══════════════════════════════════════════════════════════
  router.get('/context', auth, async (req, res) => {
    try {
      const ctx = await getUserContext(req.user.id);

      // 자동화 추천 상위 5개
      const topAutomatable = ctx.tasks
        .filter(t => t.automation_score >= 0.5)
        .slice(0, 5)
        .map(t => ({
          name: t.task_name,
          score: t.automation_score,
          category: t.category,
          frequency: t.frequency,
          duration: t.avg_duration_min,
          apps: JSON.parse(t.apps_json || '[]'),
        }));

      res.json({
        tasks_total: ctx.tasks.length,
        automatable: topAutomatable,
        pending_feedback: ctx.feedback,
        scripts_generated: ctx.scriptCount,
        has_data: ctx.tasks.length > 0,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /api/assistant/scripts — 생성된 스크립트 목록
  // ═══════════════════════════════════════════════════════════
  router.get('/scripts', auth, async (req, res) => {
    try {
      const scripts = await dbAll(
        `SELECT id, task_name, language, code, description, category, created_at
         FROM assistant_scripts WHERE user_id = ?
         ORDER BY created_at DESC LIMIT 50`,
        [req.user.id]
      );
      res.json({ scripts, count: scripts.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // POST /api/assistant/generate — 특정 작업 자동화 스크립트 생성
  // ═══════════════════════════════════════════════════════════
  router.post('/generate', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const { task_name } = req.body;
      if (!task_name) return res.status(400).json({ error: 'task_name 필요' });

      // 해당 작업 데이터 조회
      const task = await dbAll(
        `SELECT * FROM agent_task_graphs WHERE user_id = ? AND task_name = ?`,
        [userId, task_name]
      ).then(r => r[0]);

      if (!task) return res.status(404).json({ error: '작업을 찾을 수 없습니다' });

      const steps = JSON.parse(task.steps_json || '[]');
      const apps = JSON.parse(task.apps_json || '[]');

      const prompt = `다음 반복 업무를 자동화하는 Python 스크립트를 작성하세요.

## 작업 정보
- 작업명: ${task.task_name}
- 카테고리: ${task.category}
- 사용 앱: ${apps.join(', ')}
- 빈도: ${task.frequency}
- 평균 소요: ${task.avg_duration_min}분
- 단계: ${steps.join(' → ')}

## 요구사항
1. 실행 가능한 완전한 Python 코드
2. 필요한 패키지 설치 명령어 포함
3. 사용법 주석 포함
4. 에러 처리 포함
5. Excel → openpyxl/pandas, PPT → python-pptx, 웹 → playwright 사용
6. 한국어 주석

코드만 출력하세요:`;

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'API 키 미설정' });

      const { generate } = require('../src/llm-gateway');
      const code = await generate({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        prompt,
        apiKey,
      });

      // 스크립트 저장
      await dbRun(
        `INSERT INTO assistant_scripts (user_id, task_name, code, description, category)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, task_name, code, `${task.category} 자동화`, task.category || '']
      );

      res.json({
        task_name,
        code,
        apps,
        steps,
        automation_score: task.automation_score,
        estimated_save_min: Math.round(task.avg_duration_min * task.automation_score * 0.8),
      });

    } catch (e) {
      console.error('[assistant/generate]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /api/assistant/history — 대화 이력
  // ═══════════════════════════════════════════════════════════
  router.get('/history', auth, async (req, res) => {
    try {
      const messages = await dbAll(
        'SELECT role, content, created_at FROM assistant_history WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [req.user.id]
      ).then(r => r.reverse());
      res.json({ messages });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DELETE /api/assistant/history — 대화 이력 초기화
  // ═══════════════════════════════════════════════════════════
  router.delete('/history', auth, async (req, res) => {
    try {
      await dbRun('DELETE FROM assistant_history WHERE user_id = ?', [req.user.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
