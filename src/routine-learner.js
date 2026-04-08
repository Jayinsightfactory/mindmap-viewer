'use strict';
/**
 * routine-learner.js
 * 작업 루틴 패턴 학습 엔진
 *
 * 의도 기반 타임라인 데이터를 분석하여:
 * 1. 반복되는 작업 패턴 감지 (예: "안드로이드 앱 배포 = gradle 수정 → manifest 수정 → build → deploy")
 * 2. 작업 시간 패턴 (언제 어떤 작업을 많이 하는지)
 * 3. 도구 사용 패턴 (어떤 작업에 어떤 도구를 쓰는지)
 * 4. 개선 제안 (더 효율적인 순서, 빠진 단계 등)
 *
 * 저장: PostgreSQL daily_routines 테이블
 */

// ─── PostgreSQL 연동 ───────────────────────────────────
let _getDb = null;
try {
  const dbPg = require('./db-pg');
  _getDb = dbPg.getDb;
} catch {}

function _pool() {
  return _getDb ? _getDb() : null;
}

/** daily_routines 테이블 자동 생성 */
async function _ensureTables() {
  const pool = _pool();
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_routines (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        hour         SMALLINT NOT NULL,
        day_of_week  SMALLINT NOT NULL,
        app          TEXT NOT NULL,
        window_title TEXT NOT NULL DEFAULT '',
        frequency    INTEGER NOT NULL DEFAULT 1,
        avg_duration FLOAT NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, hour, day_of_week, app, window_title)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_routines_user ON daily_routines(user_id);
      CREATE INDEX IF NOT EXISTS idx_daily_routines_time ON daily_routines(user_id, hour, day_of_week);
    `);
  } catch (e) {
    console.warn('[routine-learner] 테이블 생성 경고:', e.message);
  }
}

_ensureTables();

// ─── 인메모리 이벤트 버킷 (세션 내 빠른 학습) ────────
// key: `${userId}:${hour}:${dow}:${app}:${windowTitle}`
const _buckets = {};

/**
 * 단일 이벤트를 시간대 버킷에 기록하고 DB upsert
 * @param {string} userId
 * @param {Object} event  { app, windowTitle, timestamp, duration }
 */
async function recordEvent(userId, event) {
  if (!userId || !event.app) return;

  const ts   = event.timestamp ? new Date(event.timestamp) : new Date();
  const hour = ts.getHours();          // 0~23
  const dow  = ts.getDay();            // 0(일)~6(토)
  const app  = (event.app || '').trim();
  const win  = (event.windowTitle || '').trim().slice(0, 120);
  const dur  = Number(event.duration) || 0;

  const key = `${userId}:${hour}:${dow}:${app}:${win}`;
  if (!_buckets[key]) _buckets[key] = { count: 0, totalDuration: 0 };
  _buckets[key].count++;
  _buckets[key].totalDuration += dur;

  // 3회 이상이면 루틴으로 DB upsert
  if (_buckets[key].count >= 3) {
    await _upsertRoutine(userId, hour, dow, app, win, _buckets[key]);
  }
}

async function _upsertRoutine(userId, hour, dow, app, windowTitle, bucket) {
  const pool = _pool();
  if (!pool) return;
  const avgDur = bucket.count > 0 ? bucket.totalDuration / bucket.count : 0;
  try {
    await pool.query(`
      INSERT INTO daily_routines (user_id, hour, day_of_week, app, window_title, frequency, avg_duration, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id, hour, day_of_week, app, window_title) DO UPDATE
        SET frequency    = daily_routines.frequency + EXCLUDED.frequency,
            avg_duration = (daily_routines.avg_duration + EXCLUDED.avg_duration) / 2,
            updated_at   = NOW()
    `, [userId, hour, dow, app, windowTitle, bucket.count, avgDur]);
    // 버킷 리셋 (중복 누적 방지)
    _buckets[`${userId}:${hour}:${dow}:${app}:${windowTitle}`] = { count: 0, totalDuration: 0 };
  } catch (e) {
    console.warn('[routine-learner] upsert 실패:', e.message);
  }
}

/**
 * Extract work units from events (same logic as frontend renderWorkUnits)
 */
function extractWorkUnits(events) {
  const CLI_NOISE = /^(dangerously[-\s]?skip|--?[\w-]+|y|n|yes|no|exit|quit)$/i;
  const units = [];
  let cur = null;

  for (const e of events) {
    if (e.type === 'user.message') {
      const msg = (e.data?.content || e.data?.contentPreview || '').replace(/[\n\r]/g, ' ').trim();
      if (msg.length > 2 && !CLI_NOISE.test(msg)) {
        if (cur && cur.intent !== msg.slice(0, 60)) units.push(cur);
        cur = { intent: msg.slice(0, 60), actions: [], result: '', files: [], startTime: e.timestamp };
      }
    } else if (cur) {
      if (e.type === 'assistant.message') {
        const msg = (e.data?.content || e.data?.contentPreview || '').trim();
        if (msg.length > 5) cur.result = msg.split(/[.!?]/)[0]?.slice(0, 60) || '';
      } else if (e.type === 'file.write' || e.type === 'file.create') {
        const fn = (e.data?.fileName || '').replace(/^[✏️📝📄\s]+/, '');
        if (fn) { cur.actions.push({ type: 'write', file: fn }); cur.files.push(fn); }
      } else if (e.type === 'tool.end') {
        const tn = e.data?.toolName || '';
        if (tn === 'Edit') {
          const fn = e.data?.filePath?.split('/').pop() || '';
          if (fn) { cur.actions.push({ type: 'edit', file: fn }); cur.files.push(fn); }
        } else if (tn === 'Bash') {
          cur.actions.push({ type: 'bash', file: (e.data?.inputPreview || '').slice(0, 30) });
        } else if (tn === 'WebSearch' || tn === 'WebFetch') {
          cur.actions.push({ type: 'research', file: 'web' });
        }
      }
    }
  }
  if (cur) units.push(cur);
  return units;
}

/**
 * File role inference (same as graph-engine)
 */
const FILE_ROLES = [
  [/auth|login|oauth|jwt|token/i, '인증'],
  [/route|router|api|endpoint|controller/i, 'API'],
  [/service|manager|provider/i, '서비스'],
  [/component|view|page|screen|activity/i, 'UI'],
  [/model|schema|entity/i, '모델'],
  [/test|spec|mock/i, '테스트'],
  [/config|setting|gradle|toml/i, '설정'],
  [/receiver|listener|handler/i, '이벤트처리'],
  [/deploy|docker|ci/i, '배포'],
];

function getFileRole(filename) {
  for (const [re, role] of FILE_ROLES) {
    if (re.test(filename)) return role;
  }
  return '코드';
}

/**
 * Analyze work patterns from multiple sessions
 * @param {Array}  allSessionEvents - array of { sessionId, events }
 * @param {string} [userId]         - DB에 시간대별 루틴 저장 시 사용
 * @returns {Object} patterns
 */
function analyzePatterns(allSessionEvents, userId) {
  const patterns = {
    routines: [],       // 반복되는 작업 순서
    timePatterns: {},   // 시간대별 작업 유형
    toolPatterns: {},   // 작업 유형별 도구 사용
    fileRolePatterns: {},// 파일 역할별 빈도
    suggestions: [],    // 개선 제안
    totalSessions: allSessionEvents.length,
    totalWorkUnits: 0,
  };

  const actionSequences = []; // All action sequences across sessions

  for (const { events } of allSessionEvents) {
    const units = extractWorkUnits(events);
    patterns.totalWorkUnits += units.length;

    for (const unit of units) {
      // Time patterns
      if (unit.startTime) {
        const ts   = new Date(unit.startTime);
        const hour = ts.getHours();
        const timeSlot = hour < 6 ? '새벽' : hour < 12 ? '오전' : hour < 18 ? '오후' : '저녁';
        patterns.timePatterns[timeSlot] = (patterns.timePatterns[timeSlot] || 0) + 1;

        // DB 시간대 버킷 기록 (userId가 있을 때)
        if (userId) {
          // 첫 번째 파일을 앱 대리값으로 사용 (없으면 intent 앞부분)
          const app = unit.files[0] || unit.intent.slice(0, 30);
          const windowTitle = unit.result || '';
          recordEvent(userId, {
            app,
            windowTitle,
            timestamp: unit.startTime,
            duration: 0,
          }).catch(() => {});
        }
      }

      // Tool patterns
      const actionTypes = [...new Set(unit.actions.map(a => a.type))];
      actionTypes.forEach(t => {
        patterns.toolPatterns[t] = (patterns.toolPatterns[t] || 0) + 1;
      });

      // File role patterns
      unit.files.forEach(f => {
        const role = getFileRole(f);
        patterns.fileRolePatterns[role] = (patterns.fileRolePatterns[role] || 0) + 1;
      });

      // Action sequences (for routine detection)
      if (unit.actions.length >= 2) {
        const seq = unit.actions.map(a => {
          if (a.type === 'write' || a.type === 'edit') return getFileRole(a.file);
          return a.type;
        });
        actionSequences.push(seq);
      }
    }
  }

  // Detect repeating routines (sequences that appear 2+ times)
  const seqCounts = {};
  actionSequences.forEach(seq => {
    // Use 2-4 item subsequences
    for (let len = 2; len <= Math.min(4, seq.length); len++) {
      for (let i = 0; i <= seq.length - len; i++) {
        const sub = seq.slice(i, i + len).join('\u2192');
        seqCounts[sub] = (seqCounts[sub] || 0) + 1;
      }
    }
  });

  patterns.routines = Object.entries(seqCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([seq, count]) => ({ sequence: seq, count, description: `${seq} (${count}회 반복)` }));

  // Generate suggestions
  if (patterns.routines.length > 0) {
    patterns.suggestions.push({
      type: 'routine',
      message: `자주 반복하는 작업 패턴: ${patterns.routines[0].sequence}. 이 순서를 템플릿으로 자동화할 수 있습니다.`,
    });
  }

  const topTime = Object.entries(patterns.timePatterns).sort((a, b) => b[1] - a[1])[0];
  if (topTime) {
    patterns.suggestions.push({
      type: 'time',
      message: `${topTime[0]}에 가장 많이 작업합니다 (${topTime[1]}건). 이 시간대에 집중 모드를 활성화하는 것을 추천합니다.`,
    });
  }

  // File role distribution suggestion
  const topRole = Object.entries(patterns.fileRolePatterns).sort((a, b) => b[1] - a[1])[0];
  if (topRole && topRole[1] >= 5) {
    patterns.suggestions.push({
      type: 'specialization',
      message: `${topRole[0]} 작업이 가장 많습니다 (${topRole[1]}건). 이 영역의 자동화 템플릿을 만들면 효율이 높아집니다.`,
    });
  }

  // Tool usage suggestion
  const toolEntries = Object.entries(patterns.toolPatterns).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length >= 2) {
    const topTool = toolEntries[0];
    const TOOL_KR = { edit: '편집', write: '파일 생성', bash: '터미널', research: '검색' };
    patterns.suggestions.push({
      type: 'tool',
      message: `가장 많이 사용하는 도구: ${TOOL_KR[topTool[0]] || topTool[0]} (${topTool[1]}회). 관련 단축키/매크로를 설정해보세요.`,
    });
  }

  return patterns;
}

/**
 * Generate routine report for a user
 */
function generateReport(patterns) {
  const lines = [];
  lines.push('작업 루틴 분석 리포트');
  lines.push(`총 ${patterns.totalSessions}개 세션, ${patterns.totalWorkUnits}개 작업 단위 분석`);
  lines.push('');

  if (patterns.routines.length > 0) {
    lines.push('반복 작업 패턴:');
    patterns.routines.slice(0, 5).forEach(r => {
      lines.push(`  ${r.sequence} — ${r.count}회`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.timePatterns).length > 0) {
    lines.push('시간대별 작업량:');
    Object.entries(patterns.timePatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${k}: ${v}건`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.fileRolePatterns).length > 0) {
    lines.push('파일 역할별 빈도:');
    Object.entries(patterns.fileRolePatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${k}: ${v}건`);
    });
    lines.push('');
  }

  if (Object.keys(patterns.toolPatterns).length > 0) {
    const TOOL_KR = { edit: '편집', write: '파일 생성', bash: '터미널', research: '검색' };
    lines.push('도구 사용 빈도:');
    Object.entries(patterns.toolPatterns).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      lines.push(`  ${TOOL_KR[k] || k}: ${v}회`);
    });
    lines.push('');
  }

  if (patterns.suggestions.length > 0) {
    lines.push('개선 제안:');
    patterns.suggestions.forEach(s => {
      lines.push(`  ${s.message}`);
    });
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 루틴 예측 API
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/routine/predict?userId=xxx&hour=14
 * 지정 시간대(hour)에 예상되는 루틴 반환
 * hour 미지정 시 현재 시각 사용
 */
async function handlePredictRoutine(req, res) {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const hour = req.query.hour !== undefined
    ? parseInt(req.query.hour, 10)
    : new Date().getHours();

  const pool = _pool();
  if (!pool) {
    return res.json({ userId, hour, routines: [], source: 'no-db' });
  }

  try {
    // 해당 시간대의 모든 요일 데이터 집계 (요일 무관 일반 예측)
    const { rows } = await pool.query(`
      SELECT app, window_title,
             SUM(frequency) AS total_freq,
             AVG(avg_duration) AS avg_dur
      FROM daily_routines
      WHERE user_id = $1 AND hour = $2 AND frequency >= 3
      GROUP BY app, window_title
      ORDER BY total_freq DESC
      LIMIT 10
    `, [userId, hour]);

    return res.json({
      userId,
      hour,
      routines: rows.map(r => ({
        app: r.app,
        windowTitle: r.window_title,
        frequency: parseInt(r.total_freq, 10),
        avgDurationSec: Math.round(parseFloat(r.avg_dur)),
      })),
      source: 'db',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Express 라우터 등록 헬퍼
 * 사용법 (server.js): app.use('/api/routine', routineLearner.createRouter())
 */
function createRouter() {
  const express = require('express');
  const router = express.Router();
  router.get('/predict', (req, res) =>
    handlePredictRoutine(req, res).catch(e => res.status(500).json({ error: e.message }))
  );
  return router;
}

module.exports = {
  extractWorkUnits,
  analyzePatterns,
  generateReport,
  getFileRole,
  recordEvent,
  createRouter,
};
