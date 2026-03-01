'use strict';

/**
 * trigger-engine.js
 * "이슈 발생" 이벤트를 기점으로 역추적하여
 * 어떤 대화 패턴이 이슈 트리거였는지 학습
 *
 * 핵심 원리:
 *   이슈 발생 시각(T) 기준 → T-72h ~ T 사이 content_tags 분석
 *   → 이슈 직전에 공통으로 나타나는 패턴 추출
 *   → trigger_patterns 테이블에 누적
 *
 * 클라우드 전송 (Level 1):
 *   {
 *     trigger_type: "업무압박+책임전가",
 *     avg_hours_before_issue: 24,
 *     correlation: 0.82,
 *     frequency: 7,  ← 이 패턴이 이슈 전에 나타난 횟수
 *   }
 *   → 텍스트 없음. 오직 패턴 메타데이터만
 */

const { ulid } = require('ulid');

// ── 이슈 이벤트 테이블 보장 ───────────────────────────────────────────────────
function ensureTables(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS issue_events (
      id           TEXT PRIMARY KEY,
      occurred_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      source       TEXT,      -- 'auto_signal' | 'user_marked' | 'stress_detector'
      severity     TEXT DEFAULT 'medium',
      issue_type   TEXT,      -- 업무이슈 | 인간관계 | 기술문제 | 불명확
      note         TEXT,
      analyzed     INTEGER DEFAULT 0
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS trigger_patterns (
      id              TEXT PRIMARY KEY,
      issue_event_id  TEXT,
      -- 트리거 패턴 (텍스트 없음, 태그만)
      dominant_topic      TEXT,
      dominant_sentiment  TEXT,
      dominant_urgency    TEXT,
      dominant_style      TEXT,
      avg_risk_score      REAL,
      high_risk_count     INTEGER,
      -- 시간 정보
      hours_before_issue  REAL,   -- 이슈까지 평균 시간
      tag_count           INTEGER, -- 해당 패턴의 이벤트 수
      -- 학습 통계
      pattern_key         TEXT,   -- 중복 집계용 복합키
      frequency           INTEGER DEFAULT 1,
      correlation         REAL DEFAULT 0.5,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_tp_pattern_key
    ON trigger_patterns(pattern_key)
  `).run();
}

// ── 이슈 역추적: 이슈 발생 전 N시간 태그 분석 ────────────────────────────────
function analyzeIssuePrecursor(db, issueEvent, lookbackHours = 72) {
  ensureTables(db);

  const issueTime  = new Date(issueEvent.occurred_at).getTime();
  const windowStart = new Date(issueTime - lookbackHours * 3600_000).toISOString();
  const windowEnd   = issueEvent.occurred_at;

  // 해당 시간대 content_tags 가져오기
  let tags = [];
  try {
    tags = db.prepare(`
      SELECT sentiment, urgency, topic, style, risk_score, timestamp
      FROM content_tags
      WHERE timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `).all(windowStart, windowEnd);
  } catch { return null; }

  if (tags.length < 3) return null; // 데이터 부족

  // 최빈값 계산
  const freq = (key) => {
    const counts = {};
    tags.forEach(r => { counts[r[key]] = (counts[r[key]] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  };

  const avgRisk  = tags.reduce((s, r) => s + (r.risk_score || 0), 0) / tags.length;
  const highRisk = tags.filter(r => r.risk_score > 0.6).length;

  // 이슈까지 남은 시간 계산 (고위험 태그 → 이슈 발생까지)
  const firstHighRiskTs = tags.find(r => r.risk_score > 0.6)?.timestamp;
  const hoursBeforeIssue = firstHighRiskTs
    ? (issueTime - new Date(firstHighRiskTs).getTime()) / 3600_000
    : lookbackHours;

  const dominantTopic     = freq('topic');
  const dominantSentiment = freq('sentiment');
  const dominantUrgency   = freq('urgency');
  const dominantStyle     = freq('style');

  // 패턴 복합키 (중복 집계용)
  const patternKey = [dominantTopic, dominantSentiment, dominantUrgency].join('|');

  return {
    issueEventId:      issueEvent.id,
    dominantTopic,
    dominantSentiment,
    dominantUrgency,
    dominantStyle,
    avgRiskScore:      +avgRisk.toFixed(3),
    highRiskCount:     highRisk,
    hoursBeforeIssue:  +hoursBeforeIssue.toFixed(1),
    tagCount:          tags.length,
    patternKey,
  };
}

// ── 패턴 저장 및 빈도 업데이트 ───────────────────────────────────────────────
function saveTriggerPattern(db, pattern) {
  ensureTables(db);

  // 동일 패턴 키가 있으면 frequency 누적
  const existing = db.prepare(
    `SELECT id, frequency, correlation FROM trigger_patterns WHERE pattern_key = ?`
  ).get(pattern.patternKey);

  if (existing) {
    // 빈도 증가 + 상관관계 점진적 업데이트
    const newFreq = (existing.frequency || 1) + 1;
    const newCorr = Math.min(0.5 + newFreq * 0.05, 0.95);
    db.prepare(
      `UPDATE trigger_patterns SET frequency=?, correlation=? WHERE id=?`
    ).run(newFreq, newCorr, existing.id);
    console.log(`[trigger-engine] 패턴 빈도 업데이트: "${pattern.patternKey}" → ${newFreq}회 (상관도 ${newCorr.toFixed(2)})`);
    return existing.id;
  }

  const id = ulid();
  db.prepare(`
    INSERT OR IGNORE INTO trigger_patterns
      (id, issue_event_id, dominant_topic, dominant_sentiment, dominant_urgency,
       dominant_style, avg_risk_score, high_risk_count, hours_before_issue,
       tag_count, pattern_key, frequency, correlation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0.5)
  `).run(
    id, pattern.issueEventId, pattern.dominantTopic, pattern.dominantSentiment,
    pattern.dominantUrgency, pattern.dominantStyle, pattern.avgRiskScore,
    pattern.highRiskCount, pattern.hoursBeforeIssue, pattern.tagCount, pattern.patternKey
  );

  console.log(`[trigger-engine] 새 트리거 패턴 학습: ${pattern.dominantTopic} + ${pattern.dominantSentiment} → 이슈까지 약 ${pattern.hoursBeforeIssue.toFixed(0)}h`);
  return id;
}

// ── 전체 미분석 이슈 처리 ─────────────────────────────────────────────────────
function processUnanalyzedIssues(db) {
  ensureTables(db);

  let issues = [];
  try {
    issues = db.prepare(
      `SELECT * FROM issue_events WHERE analyzed=0 ORDER BY occurred_at ASC`
    ).all();
  } catch { return []; }

  const learned = [];

  for (const issue of issues) {
    const pattern = analyzeIssuePrecursor(db, issue);
    if (pattern) {
      saveTriggerPattern(db, pattern);
      learned.push(pattern);
    }
    // 분석 완료 마킹
    db.prepare(`UPDATE issue_events SET analyzed=1 WHERE id=?`).run(issue.id);
  }

  return learned;
}

// ── 학습된 트리거 패턴 조회 ───────────────────────────────────────────────────
function getTopTriggers(db, limit = 10) {
  ensureTables(db);
  try {
    return db.prepare(`
      SELECT pattern_key, dominant_topic, dominant_sentiment, dominant_urgency,
             dominant_style, avg_risk_score, hours_before_issue, frequency, correlation
      FROM trigger_patterns
      ORDER BY correlation DESC, frequency DESC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

// ── 현재 위험도 평가: 지금 대화가 알려진 트리거 패턴과 유사한가 ───────────────
function assessCurrentRisk(db, currentSummary) {
  if (!currentSummary) return { riskLevel: 'unknown', matchedPattern: null };

  const triggers = getTopTriggers(db, 20);
  if (!triggers.length) return { riskLevel: 'none', matchedPattern: null };

  // 현재 요약과 가장 유사한 트리거 패턴 찾기
  let bestMatch = null;
  let bestScore = 0;

  for (const t of triggers) {
    let score = 0;
    if (t.dominant_topic     === currentSummary.dominantTopic)     score += 0.4;
    if (t.dominant_sentiment === currentSummary.dominantSentiment) score += 0.3;
    if (t.dominant_urgency   === currentSummary.dominantUrgency)   score += 0.2;
    if (t.dominant_style     === currentSummary.dominantStyle)     score += 0.1;

    const weighted = score * t.correlation;
    if (weighted > bestScore) {
      bestScore = weighted;
      bestMatch = { ...t, matchScore: +weighted.toFixed(3) };
    }
  }

  const riskLevel =
    bestScore >= 0.6 ? 'high' :
    bestScore >= 0.35 ? 'medium' : 'low';

  return { riskLevel, matchedPattern: bestMatch, score: +bestScore.toFixed(3) };
}

// ── 클라우드 전송용 패턴 직렬화 (텍스트 없음) ────────────────────────────────
function serializeForSync(db, limit = 50) {
  const triggers = getTopTriggers(db, limit);
  return triggers.map(t => ({
    patternKey:         t.pattern_key,
    triggerType:        `${t.dominant_topic}+${t.dominant_sentiment}`,
    avgHoursBeforeIssue: t.hours_before_issue,
    correlation:        t.correlation,
    frequency:          t.frequency,
    // 원본 텍스트 없음 — 오직 분류 태그 + 통계만
  }));
}

module.exports = {
  processUnanalyzedIssues,
  getTopTriggers,
  assessCurrentRisk,
  serializeForSync,
  saveTriggerPattern,
  analyzeIssuePrecursor,
  ensureTables,
};
