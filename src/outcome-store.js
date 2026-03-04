/**
 * src/outcome-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 세션 목표 + 결과 저장소
 *
 * 역할:
 *   사용자가 작업 시작 전 "목표"를 기록하고, 완료 후 "결과"를 저장한다.
 *   MCP 서버가 이 데이터를 Claude에게 컨텍스트로 공급한다.
 *
 * DB:
 *   기존 src/db.js의 getDb()로 mindmap.db에 outcomes 테이블 추가 (새 파일 없음)
 *
 * 사용:
 *   const outcomeStore = require('./outcome-store');
 *   outcomeStore.initOutcomeTable();
 *   outcomeStore.saveOutcome({ goal: '로그인 버그 수정', result: 'success', ... });
 *   outcomeStore.getOutcomes({ limit: 10 });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

// ─── 테이블 초기화 ────────────────────────────────────────────────────────────
function initOutcomeTable() {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id           TEXT PRIMARY KEY,
      session_id   TEXT,
      user_id      TEXT DEFAULT 'local',
      goal         TEXT,
      result       TEXT,
      summary      TEXT,
      tools_used   TEXT,
      duration_min INTEGER,
      tags         TEXT,
      created_at   TEXT NOT NULL
    )
  `).run();
}

// ─── 저장 ─────────────────────────────────────────────────────────────────────

/**
 * 세션 결과를 저장합니다.
 * @param {object} params
 * @param {string} [params.sessionId]   - 연결할 세션 ID
 * @param {string} [params.userId]      - 사용자 ID (기본: 'local')
 * @param {string} params.goal          - 작업 목표 (자유 텍스트)
 * @param {'success'|'partial'|'abandoned'} params.result - 결과
 * @param {string} [params.summary]     - 자유 형식 메모
 * @param {string[]} [params.toolsUsed] - 사용한 도구 이름 목록
 * @param {number} [params.durationMin] - 소요 시간 (분)
 * @param {string[]} [params.tags]      - 태그 목록
 * @returns {{ id: string }}
 */
function saveOutcome({ sessionId, userId = 'local', goal, result, summary, toolsUsed = [], durationMin, tags = [] }) {
  const db = getDb();
  if (!db) return { id: null };

  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO outcomes (id, session_id, user_id, goal, result, summary, tools_used, duration_min, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId || null,
    userId,
    goal || null,
    result || null,
    summary || null,
    JSON.stringify(toolsUsed),
    durationMin || null,
    JSON.stringify(tags),
    new Date().toISOString()
  );

  return { id };
}

// ─── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * outcome 목록을 조회합니다.
 * @param {object} [opts]
 * @param {string} [opts.userId]    - 사용자 ID 필터
 * @param {number} [opts.limit]     - 최대 반환 수 (기본 20)
 * @param {string} [opts.fromDate]  - ISO 날짜 이후 것만 (예: '2026-02-01T00:00:00Z')
 * @returns {object[]}
 */
function getOutcomes({ userId, limit = 20, fromDate } = {}) {
  const db = getDb();
  if (!db) return [];

  let sql = 'SELECT * FROM outcomes WHERE 1=1';
  const params = [];

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (fromDate) {
    sql += ' AND created_at >= ?';
    params.push(fromDate);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rows.map(deserializeOutcome);
}

/**
 * 특정 세션의 outcome을 조회합니다.
 * @param {string} sessionId
 * @returns {object|null}
 */
function getOutcomeBySession(sessionId) {
  const db = getDb();
  if (!db) return null;

  const row = db.prepare('SELECT * FROM outcomes WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
  return row ? deserializeOutcome(row) : null;
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────
function deserializeOutcome(row) {
  return {
    id:          row.id,
    sessionId:   row.session_id,
    userId:      row.user_id,
    goal:        row.goal,
    result:      row.result,
    summary:     row.summary,
    toolsUsed:   JSON.parse(row.tools_used || '[]'),
    durationMin: row.duration_min,
    tags:        JSON.parse(row.tags || '[]'),
    createdAt:   row.created_at,
  };
}

module.exports = { initOutcomeTable, saveOutcome, getOutcomes, getOutcomeBySession };
