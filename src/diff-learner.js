/**
 * diff-learner.js — 원본/변경 파일 diff 학습 엔진
 *
 * 역할:
 * 1. 파일 변경 시 before/after 내용을 캡처
 * 2. diff를 Ollama로 분석 → 패턴 추출
 * 3. 반복 패턴 감지 → 솔루션 제안 생성
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = (() => { try { return require('node-fetch'); } catch { return globalThis.fetch; } })();

// ── 학습 데이터 저장소 ─────────────────────────────────────────────────────
const LEARN_DB_PATH = path.join(__dirname, '../data/learn-db.json');
const MAX_ENTRIES   = 500;   // 최대 저장 항목
const OLLAMA_URL    = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL  = 'llama3.2';  // 또는 orbit-insight:v1

function loadDB() {
  try {
    if (fs.existsSync(LEARN_DB_PATH)) return JSON.parse(fs.readFileSync(LEARN_DB_PATH, 'utf-8'));
  } catch {}
  return { entries: [], patterns: [], suggestions: [], lastUpdated: null };
}

function saveDB(db) {
  try {
    const dir = path.dirname(LEARN_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEARN_DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) { console.error('[DiffLearner] DB 저장 실패:', e.message); }
}

// ── 파일 스냅샷 캐시 (before 상태 저장) ────────────────────────────────────
const _snapshots = new Map();  // filePath → { content, hash, mtime }

/**
 * 파일 변경 전 스냅샷 저장 (watcher가 변경 감지 직전에 호출)
 */
function snapshot(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash    = crypto.createHash('md5').update(content).digest('hex');
    const mtime   = fs.statSync(filePath).mtimeMs;
    _snapshots.set(filePath, { content, hash, mtime });
  } catch {}
}

/**
 * 파일 변경 후 diff 생성 + 학습 트리거
 */
async function learn(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;

    const afterContent  = fs.readFileSync(filePath, 'utf-8');
    const afterHash     = crypto.createHash('md5').update(afterContent).digest('hex');
    const before        = _snapshots.get(filePath);

    // 변경 없으면 스킵
    if (before?.hash === afterHash) return null;

    const beforeContent = before?.content || '';
    const ext           = path.extname(filePath);
    const fileName      = path.basename(filePath);

    // 간단한 diff 생성 (라인 기반)
    const diff = simpleDiff(beforeContent, afterContent);
    if (!diff.changed) return null;

    const entry = {
      id:          crypto.randomUUID(),
      filePath,
      fileName,
      ext,
      timestamp:   Date.now(),
      beforeLines: beforeContent.split('\n').length,
      afterLines:  afterContent.split('\n').length,
      addedLines:  diff.added,
      removedLines:diff.removed,
      changeRatio: diff.ratio,
      snippet:     diff.snippet,  // 변경된 부분 요약
    };

    // DB에 저장
    const db = loadDB();
    db.entries.unshift(entry);
    if (db.entries.length > MAX_ENTRIES) db.entries = db.entries.slice(0, MAX_ENTRIES);
    db.lastUpdated = new Date().toISOString();

    // 스냅샷 업데이트
    _snapshots.set(filePath, { content: afterContent, hash: afterHash });

    // 패턴 분석 (비동기, 실패해도 OK)
    analyzePattern(entry, db).catch(() => {});

    saveDB(db);
    return entry;

  } catch (e) {
    console.error('[DiffLearner] learn 오류:', e.message);
    return null;
  }
}

/**
 * 간단한 라인 기반 diff
 */
function simpleDiff(before, after) {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const bSet   = new Set(bLines);
  const aSet   = new Set(aLines);

  const added   = aLines.filter(l => l.trim() && !bSet.has(l));
  const removed = bLines.filter(l => l.trim() && !aSet.has(l));

  const changed = added.length > 0 || removed.length > 0;
  const total   = Math.max(bLines.length, aLines.length);
  const ratio   = total > 0 ? (added.length + removed.length) / total : 0;

  // 변경된 라인 샘플 (최대 5줄)
  const snippet = [
    ...added.slice(0, 3).map(l => `+ ${l.slice(0, 80)}`),
    ...removed.slice(0, 2).map(l => `- ${l.slice(0, 80)}`),
  ].join('\n');

  return { changed, added: added.length, removed: removed.length, ratio, snippet };
}

/**
 * Ollama로 패턴 분석 + 솔루션 제안 생성
 */
async function analyzePattern(entry, db) {
  // 같은 파일의 최근 변경 3개 모아서 패턴 분석
  const recentSameFile = db.entries
    .filter(e => e.fileName === entry.fileName)
    .slice(0, 3);

  if (recentSameFile.length < 2) return;  // 데이터 부족

  const prompt = `
당신은 개발자의 작업 패턴을 분석하는 AI입니다.
다음은 "${entry.fileName}" 파일의 최근 변경 내역입니다:

${recentSameFile.map((e, i) => `
[변경 ${i+1}] ${new Date(e.timestamp).toLocaleString('ko-KR')}
- 추가 줄: ${e.addedLines}개, 삭제 줄: ${e.removedLines}개
- 변경 내용:
${e.snippet}
`).join('\n')}

이 패턴을 보고:
1. 어떤 작업을 반복하고 있는지 한 문장으로 설명
2. 자동화할 수 있는 부분이 있다면 구체적인 솔루션 제안 (없으면 "없음")

JSON으로 응답: {"pattern": "...", "suggestion": "...", "automatable": true/false}
`.trim();

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return;
    const data = await res.json();
    const text = data.response || '';

    // JSON 추출
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const analysis = JSON.parse(match[0]);

    // 솔루션 저장
    if (analysis.suggestion && analysis.suggestion !== '없음') {
      db.suggestions.unshift({
        id:          crypto.randomUUID(),
        fileName:    entry.fileName,
        pattern:     analysis.pattern,
        suggestion:  analysis.suggestion,
        automatable: analysis.automatable,
        timestamp:   Date.now(),
        seen:        false,
      });
      db.suggestions = db.suggestions.slice(0, 50);
      saveDB(db);
      console.log(`[DiffLearner] 새 솔루션 제안: ${analysis.suggestion.slice(0, 60)}`);
    }

  } catch (e) {
    // Ollama 없으면 조용히 스킵
    if (!e.message?.includes('fetch')) {
      console.error('[DiffLearner] Ollama 분석 오류:', e.message);
    }
  }
}

/**
 * 현재 솔루션 제안 목록 반환 (안 읽은 것 먼저)
 */
function getSuggestions() {
  const db = loadDB();
  return db.suggestions.sort((a, b) => (a.seen ? 1 : 0) - (b.seen ? 1 : 0));
}

/**
 * 제안 읽음 처리
 */
function markSeen(id) {
  const db = loadDB();
  const s  = db.suggestions.find(s => s.id === id);
  if (s) { s.seen = true; saveDB(db); }
}

/**
 * 학습 통계
 */
function getStats() {
  const db = loadDB();
  const fileFreq = {};
  db.entries.forEach(e => { fileFreq[e.fileName] = (fileFreq[e.fileName] || 0) + 1; });
  const topFiles = Object.entries(fileFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    totalEntries:       db.entries.length,
    totalSuggestions:   db.suggestions.length,
    unseenSuggestions:  db.suggestions.filter(s => !s.seen).length,
    topFiles,
    lastUpdated:        db.lastUpdated,
  };
}

module.exports = { snapshot, learn, getSuggestions, markSeen, getStats };
