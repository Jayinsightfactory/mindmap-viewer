/**
 * growth-engine.js
 * Orbit 성장 엔진 — 피드백 루프 + AI 제안 시스템
 *
 * 작동 방식:
 *   1. 반복 패턴 감지 → 자동화/개선 제안 생성
 *   2. 사용자 피드백 (👍/👎 + 이유)
 *   3. 피드백이 쌓이면 제안 품질 자동 향상
 *   4. 팀 공통 패턴 → 솔루션 마켓에 자동 등록 후보로
 */
const fs   = require('fs');
const path = require('path');

let db;
try {
  const Database = require('better-sqlite3');
  const dbPath   = path.join(__dirname, '..', 'data', 'growth.db');
  const dir      = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch { db = null; }

// ─── 테이블 초기화 ──────────────────────────────
if (db) {
  db.exec(`
    -- 감지된 패턴
    CREATE TABLE IF NOT EXISTS patterns (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      signature   TEXT NOT NULL,
      description TEXT,
      frequency   INTEGER DEFAULT 1,
      firstSeen   TEXT DEFAULT (datetime('now')),
      lastSeen    TEXT DEFAULT (datetime('now')),
      channelId   TEXT DEFAULT 'default',
      members     TEXT DEFAULT '[]'
    );

    -- AI 제안
    CREATE TABLE IF NOT EXISTS suggestions (
      id          TEXT PRIMARY KEY,
      patternId   TEXT,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      code        TEXT,
      toolType    TEXT,
      confidence  REAL DEFAULT 0.5,
      status      TEXT DEFAULT 'active',
      createdAt   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (patternId) REFERENCES patterns(id)
    );

    -- 사용자 피드백
    CREATE TABLE IF NOT EXISTS feedbacks (
      id           TEXT PRIMARY KEY,
      suggestionId TEXT NOT NULL,
      vote         TEXT NOT NULL CHECK(vote IN ('up','down')),
      reason       TEXT,
      alternativeIdea TEXT,
      userId       TEXT DEFAULT 'local',
      channelId    TEXT DEFAULT 'default',
      createdAt    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (suggestionId) REFERENCES suggestions(id)
    );

    -- 학습된 규칙 (피드백에서 추출)
    CREATE TABLE IF NOT EXISTS learned_rules (
      id          TEXT PRIMARY KEY,
      patternType TEXT NOT NULL,
      rule        TEXT NOT NULL,
      weight      REAL DEFAULT 1.0,
      upvotes     INTEGER DEFAULT 0,
      downvotes   INTEGER DEFAULT 0,
      createdAt   TEXT DEFAULT (datetime('now')),
      updatedAt   TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── 유틸 ────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── 패턴 감지기 ──────────────────────────────────

/**
 * PATTERN TYPE 1: 반복 파일 작업
 * 같은 파일을 매일/매주 열고 수정 → 자동화 제안
 */
function detectRepeatFilePatterns(events, channelId = 'default') {
  const fileOps = {};
  const now = Date.now();
  const DAY  = 86400000;

  for (const ev of events) {
    if (!['file.write', 'file.read', 'file.create'].includes(ev.type)) continue;
    const fp = ev.data?.filePath || ev.data?.fileName;
    if (!fp) continue;
    const ext = path.extname(fp).toLowerCase();
    if (!fileOps[fp]) fileOps[fp] = { count: 0, ext, sessions: new Set(), days: new Set() };
    fileOps[fp].count++;
    fileOps[fp].sessions.add(ev.sessionId);
    const dayKey = Math.floor(new Date(ev.timestamp).getTime() / DAY);
    fileOps[fp].days.add(dayKey);
  }

  const patterns = [];
  for (const [fp, info] of Object.entries(fileOps)) {
    if (info.count < 5 || info.days.size < 2) continue; // 최소 5번, 2일 이상

    // 엑셀/CSV 반복 → 자동화 제안
    if (['.xlsx', '.csv', '.xls'].includes(info.ext)) {
      patterns.push({
        type: 'repeat_spreadsheet',
        signature: `repeat:${info.ext}:${path.basename(fp)}`,
        description: `${path.basename(fp)} 파일을 ${info.days.size}일에 걸쳐 ${info.count}번 수정했습니다`,
        data: { filePath: fp, count: info.count, days: info.days.size, ext: info.ext },
        channelId,
      });
    }

    // 코드 파일 반복 수정 → 리팩토링 제안
    if (['.js', '.ts', '.py', '.java'].includes(info.ext) && info.count >= 10) {
      patterns.push({
        type: 'repeat_code_edit',
        signature: `repeat_code:${path.basename(fp)}`,
        description: `${path.basename(fp)}을 ${info.count}번 반복 수정. 리팩토링 필요할 수 있습니다`,
        data: { filePath: fp, count: info.count },
        channelId,
      });
    }
  }
  return patterns;
}

/**
 * PATTERN TYPE 2: 반복 명령 패턴
 * 같은 Bash 명령을 반복 실행 → 스크립트/alias 제안
 */
function detectRepeatCommandPatterns(events, channelId = 'default') {
  const cmds = {};
  for (const ev of events) {
    if (ev.type !== 'tool.end' && ev.type !== 'tool.start') continue;
    const tool = ev.data?.toolName;
    const input = ev.data?.inputPreview || ev.data?.input;
    if (tool !== 'Bash' || !input) continue;

    // 명령 정규화 (경로/값 제거)
    const normalized = String(input)
      .replace(/\/[^\s]*/g, 'PATH')
      .replace(/\d+/g, 'N')
      .trim()
      .slice(0, 80);

    if (!cmds[normalized]) cmds[normalized] = { count: 0, raw: String(input).slice(0, 200) };
    cmds[normalized].count++;
  }

  const patterns = [];
  for (const [cmd, info] of Object.entries(cmds)) {
    if (info.count < 3) continue;
    patterns.push({
      type: 'repeat_command',
      signature: `cmd:${cmd}`,
      description: `같은 명령을 ${info.count}번 반복 실행`,
      data: { command: info.raw, count: info.count },
      channelId,
    });
  }
  return patterns;
}

/**
 * PATTERN TYPE 3: 오류 반복
 * 같은 오류가 계속 발생 → 해결책 제안
 */
function detectRepeatErrorPatterns(events, channelId = 'default') {
  const errors = {};
  for (const ev of events) {
    if (ev.type !== 'tool.error' && ev.data?.success !== false) continue;
    const tool = ev.data?.toolName || 'unknown';
    const key  = `${tool}:error`;
    if (!errors[key]) errors[key] = { count: 0, tool, samples: [] };
    errors[key].count++;
    if (errors[key].samples.length < 3) {
      errors[key].samples.push(ev.data?.output || ev.data?.error || '');
    }
  }

  const patterns = [];
  for (const [key, info] of Object.entries(errors)) {
    if (info.count < 3) continue;
    patterns.push({
      type: 'repeat_error',
      signature: `error:${info.tool}`,
      description: `${info.tool} 도구에서 ${info.count}번 오류 발생`,
      data: { tool: info.tool, count: info.count, samples: info.samples },
      channelId,
    });
  }
  return patterns;
}

// ─── 제안 생성기 ─────────────────────────────────

function generateSuggestions(pattern) {
  const suggestions = [];

  if (pattern.type === 'repeat_spreadsheet') {
    const { filePath, ext } = pattern.data;
    suggestions.push({
      type: 'automation_script',
      title: '엑셀 작업 자동화 스크립트',
      description: `${path.basename(filePath)} 파일 처리를 Python으로 자동화할 수 있습니다`,
      toolType: 'python',
      code: `import openpyxl\nimport pandas as pd\n\n# ${path.basename(filePath)} 자동 처리\ndf = pd.read_excel("${filePath}")\n# TODO: 반복 작업 로직 추가\ndf.to_excel("${filePath.replace(ext, '_output' + ext)}", index=False)\nprint("완료!")`,
      confidence: 0.75,
    });
    suggestions.push({
      type: 'workflow_recipe',
      title: '파일 변경 감지 자동 실행',
      description: `${path.basename(filePath)} 변경 시 자동으로 처리 스크립트를 실행`,
      toolType: 'orbit_hook',
      code: `// orbit hook 설정 예시\n// 파일 변경 감지 → 자동 스크립트 실행`,
      confidence: 0.65,
    });
  }

  if (pattern.type === 'repeat_command') {
    const { command } = pattern.data;
    suggestions.push({
      type: 'alias_shortcut',
      title: '명령어 단축키(alias) 등록',
      description: '자주 쓰는 명령어를 alias로 등록하면 시간을 절약할 수 있습니다',
      toolType: 'shell',
      code: `# ~/.zshrc 또는 ~/.bashrc에 추가\nalias mycommand="${command.slice(0, 100)}"`,
      confidence: 0.80,
    });
    suggestions.push({
      type: 'automation_script',
      title: '반복 명령 스크립트화',
      description: '반복 실행 명령을 스크립트로 만들어 orbit에 등록',
      toolType: 'bash',
      code: `#!/bin/bash\n# 반복 작업 자동화\n${command.slice(0, 200)}`,
      confidence: 0.70,
    });
  }

  if (pattern.type === 'repeat_error') {
    const { tool } = pattern.data;
    suggestions.push({
      type: 'error_prevention',
      title: `${tool} 오류 예방 설정`,
      description: '반복 오류 패턴을 분석해 사전 체크리스트를 제안합니다',
      toolType: 'checklist',
      code: JSON.stringify([
        `${tool} 실행 전 의존성 확인`,
        '파일 경로 유효성 검사',
        '권한 설정 확인',
      ], null, 2),
      confidence: 0.60,
    });
  }

  if (pattern.type === 'repeat_code_edit') {
    suggestions.push({
      type: 'refactor_hint',
      title: '리팩토링 제안',
      description: `${pattern.data.filePath ? path.basename(pattern.data.filePath) : '이 파일'}을 반복 수정하고 있습니다. 구조 개선이 필요할 수 있습니다`,
      toolType: 'code_review',
      code: `// 제안: 함수 분리, 모듈화, 테스트 추가`,
      confidence: 0.55,
    });
  }

  return suggestions;
}

// ─── DB 저장/조회 ─────────────────────────────────

function savePattern(pattern) {
  if (!db) return pattern;
  const existing = db.prepare('SELECT * FROM patterns WHERE signature = ? AND channelId = ?')
    .get(pattern.signature, pattern.channelId || 'default');

  if (existing) {
    db.prepare(`UPDATE patterns SET frequency = frequency + 1, lastSeen = datetime('now') WHERE id = ?`)
      .run(existing.id);
    return { ...existing, frequency: existing.frequency + 1 };
  }

  const id = uid();
  db.prepare(`
    INSERT INTO patterns (id, type, signature, description, channelId)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, pattern.type, pattern.signature, pattern.description, pattern.channelId || 'default');
  return { id, ...pattern, frequency: 1 };
}

function saveSuggestion(suggestion, patternId) {
  if (!db) return suggestion;
  const existing = db.prepare('SELECT id FROM suggestions WHERE patternId = ? AND type = ?')
    .get(patternId, suggestion.type);
  if (existing) return existing;

  const id = uid();
  db.prepare(`
    INSERT INTO suggestions (id, patternId, type, title, description, code, toolType, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, patternId, suggestion.type, suggestion.title,
    suggestion.description, suggestion.code, suggestion.toolType, suggestion.confidence);
  return { id, patternId, ...suggestion };
}

// ─── 피드백 저장 ────────────────────────────────
function saveFeedback({ suggestionId, vote, reason, alternativeIdea, userId, channelId }) {
  if (!db) return { ok: false };

  const id = uid();
  db.prepare(`
    INSERT INTO feedbacks (id, suggestionId, vote, reason, alternativeIdea, userId, channelId)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, suggestionId, vote, reason || null, alternativeIdea || null,
    userId || 'local', channelId || 'default');

  // 피드백 반영: confidence 업데이트
  const fb = db.prepare(`
    SELECT
      SUM(CASE WHEN vote='up' THEN 1 ELSE 0 END) as ups,
      SUM(CASE WHEN vote='down' THEN 1 ELSE 0 END) as downs,
      COUNT(*) as total
    FROM feedbacks WHERE suggestionId = ?
  `).get(suggestionId);

  if (fb && fb.total > 0) {
    const newConf = Math.round((fb.ups / fb.total) * 10) / 10;
    db.prepare('UPDATE suggestions SET confidence = ? WHERE id = ?').run(newConf, suggestionId);
  }

  // 👎 + 대안 아이디어 → learned_rules에 저장
  if (vote === 'down' && alternativeIdea) {
    const sugg = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId);
    if (sugg) {
      const ruleId = uid();
      db.prepare(`
        INSERT OR REPLACE INTO learned_rules (id, patternType, rule, weight, downvotes)
        VALUES (?, ?, ?, 1.0, 1)
      `).run(ruleId, sugg.type, alternativeIdea);
    }
  }

  return { ok: true, id };
}

// ─── 제안 조회 ─────────────────────────────────
function getSuggestions({ channelId, status, limit } = {}) {
  if (!db) return [];
  const ch = channelId || 'default';
  const st = status || 'active';
  const lm = limit || 20;

  return db.prepare(`
    SELECT s.*, p.type as patternType, p.frequency, p.description as patternDesc,
      (SELECT COUNT(*) FROM feedbacks f WHERE f.suggestionId = s.id AND f.vote = 'up') as upvotes,
      (SELECT COUNT(*) FROM feedbacks f WHERE f.suggestionId = s.id AND f.vote = 'down') as downvotes
    FROM suggestions s
    LEFT JOIN patterns p ON s.patternId = p.id
    WHERE (p.channelId = ? OR p.channelId IS NULL)
    AND s.status = ?
    ORDER BY s.confidence DESC, p.frequency DESC
    LIMIT ?
  `).all(ch, st, lm);
}

function getPatterns({ channelId, limit } = {}) {
  if (!db) return [];
  return db.prepare(`
    SELECT p.*, COUNT(s.id) as suggestionCount
    FROM patterns p
    LEFT JOIN suggestions s ON s.patternId = p.id
    WHERE p.channelId = ?
    GROUP BY p.id
    ORDER BY p.frequency DESC, p.lastSeen DESC
    LIMIT ?
  `).all(channelId || 'default', limit || 50);
}

function getLearnedRules({ patternType } = {}) {
  if (!db) return [];
  const q = patternType
    ? db.prepare('SELECT * FROM learned_rules WHERE patternType = ? ORDER BY weight DESC').all(patternType)
    : db.prepare('SELECT * FROM learned_rules ORDER BY weight DESC').all();
  return q;
}

// ─── 전체 분석 실행 ─────────────────────────────
function analyzeAndSuggest(events, channelId = 'default') {
  const allPatterns = [
    ...detectRepeatFilePatterns(events, channelId),
    ...detectRepeatCommandPatterns(events, channelId),
    ...detectRepeatErrorPatterns(events, channelId),
  ];

  const results = [];
  for (const pattern of allPatterns) {
    const savedPattern  = savePattern(pattern);
    const suggestions   = generateSuggestions(pattern);
    const savedSuggestions = suggestions.map(s => saveSuggestion(s, savedPattern.id));
    results.push({ pattern: savedPattern, suggestions: savedSuggestions });
  }

  return results;
}

// ─── 마켓 승격 후보 ─────────────────────────────
// confidence >= 0.8 + upvotes >= 3 인 제안 → 솔루션 마켓 후보
function getMarketCandidates() {
  if (!db) return [];
  return db.prepare(`
    SELECT s.*, p.type as patternType, p.frequency,
      (SELECT COUNT(*) FROM feedbacks f WHERE f.suggestionId = s.id AND f.vote = 'up') as upvotes
    FROM suggestions s
    LEFT JOIN patterns p ON s.patternId = p.id
    WHERE s.confidence >= 0.8
    HAVING upvotes >= 3
    ORDER BY upvotes DESC, s.confidence DESC
  `).all();
}

module.exports = {
  analyzeAndSuggest,
  saveFeedback,
  getSuggestions,
  getPatterns,
  getLearnedRules,
  getMarketCandidates,
};
