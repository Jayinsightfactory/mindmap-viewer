'use strict';
/**
 * src/gdrive-user-backup.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용자별 Google Drive 백업/복원
 *
 * 기존 gdrive-backup.js는 Service Account 기반 회사 DB 백업.
 * 이 모듈은 사용자의 OAuth 토큰으로 개인 Drive에 백업.
 *
 * Drive 구조:
 *   My Drive / Orbit AI / orbit-backup-{userId}-{timestamp}.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// PC 식별자 생성
function getPcId() {
  return crypto.createHash('sha256')
    .update(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`)
    .digest('hex').slice(0, 16);
}

/**
 * "Orbit AI" 폴더 찾기 또는 생성
 */
async function ensureOrbitFolder(accessToken) {
  // 기존 폴더 검색
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    "name='Orbit AI' and mimeType='application/vnd.google-apps.folder' and trashed=false"
  )}&fields=files(id,name)`;

  const searchRes = await fetch(searchUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const searchData = await searchRes.json();

  if (searchData.files?.length > 0) {
    return searchData.files[0].id;
  }

  // 폴더 생성
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Orbit AI',
      mimeType: 'application/vnd.google-apps.folder',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const folder = await createRes.json();
  return folder.id;
}

/**
 * 사용자 이벤트를 JSON으로 내보내 Drive에 업로드
 */
async function backupUserDataToDrive(userId, accessToken, dbModule) {
  const pcId = getPcId();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 이벤트 데이터 가져오기
  const events = dbModule.getEventsByUser
    ? dbModule.getEventsByUser(userId)
    : dbModule.getAllEvents().filter(e => e.userId === userId);

  const sessions = dbModule.getSessionsByUser
    ? dbModule.getSessionsByUser(userId)
    : dbModule.getSessions().filter(s => s.user_id === userId);

  const backupData = {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    userId,
    pcId,
    hostname: os.hostname(),
    platform: os.platform(),
    eventCount: events.length,
    sessionCount: sessions.length,
    events,
    sessions,
  };

  const jsonStr = JSON.stringify(backupData);
  const fileName = `orbit-backup-${pcId}-${timestamp}.json`;

  // Drive 폴더 확인/생성
  const folderId = await ensureOrbitFolder(accessToken);

  // 업로드
  const boundary = '-------' + Date.now();
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from(jsonStr),
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload failed: ${res.status} ${errText}`);
  }

  const result = await res.json();
  console.log(`[gdrive-user-backup] ${userId} → ${fileName} (${events.length} events)`);

  return {
    fileId: result.id,
    fileName,
    eventCount: events.length,
    sessionCount: sessions.length,
    pcId,
  };
}

/**
 * Drive에서 최근 백업 목록 조회
 */
async function listBackups(accessToken) {
  const folderId = await ensureOrbitFolder(accessToken);

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${folderId}' in parents and name contains 'orbit-backup-' and trashed=false`
  )}&orderBy=createdTime desc&fields=files(id,name,size,createdTime)&pageSize=20`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return (data.files || []).map(f => ({
    fileId: f.id,
    fileName: f.name,
    size: parseInt(f.size || '0'),
    createdAt: f.createdTime,
    // pcId 추출: orbit-backup-{pcId}-{timestamp}.json
    pcId: f.name.match(/orbit-backup-([a-f0-9]+)-/)?.[1] || '',
  }));
}

/**
 * Drive에서 백업 JSON 다운로드
 */
async function downloadBackup(fileId, accessToken) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.json();
}

/**
 * 백업 데이터를 DB에 병합 (ULID 중복 방지)
 */
function importBackupData(backupData, userId, dbModule) {
  const events = backupData.events || [];
  let imported = 0;

  for (const event of events) {
    try {
      // userId를 현재 사용자로 설정
      event.userId = userId;
      dbModule.insertEvent(event);
      imported++;
    } catch {
      // INSERT OR IGNORE — 중복 ULID는 무시
    }
  }

  return { imported, total: events.length, skipped: events.length - imported };
}

/**
 * 학습 데이터를 수집하여 Drive에 백업
 *
 * 수집 대상:
 *   - insights.jsonl (인사이트 엔진)
 *   - growth.db: patterns, suggestions, feedbacks, learned_rules
 *   - trigger_patterns (트리거 엔진)
 *   - signals 테이블 (신호 엔진)
 *   - 학습 프로필 (이벤트 기반 계산)
 */
async function backupLearningData(userId, accessToken, dbModule) {
  const pcId = getPcId();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // ── 1. 인사이트 수집 (insights.jsonl) ──────────────────
  let insights = [];
  try {
    const insightEngine = require('./insight-engine');
    insights = insightEngine.getInsights(200);
  } catch {
    // insights.jsonl 또는 모듈 없으면 빈 배열
    try {
      const insightFile = path.join(__dirname, '..', 'data', 'insights.jsonl');
      if (fs.existsSync(insightFile)) {
        const lines = fs.readFileSync(insightFile, 'utf8').split('\n').filter(Boolean);
        insights = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
    } catch {}
  }

  // ── 2. Growth DB 데이터 수집 ───────────────────────────
  let patterns = [];
  let suggestions = [];
  let feedbacks = [];
  let learnedRules = [];
  try {
    const growthEngine = require('./growth-engine');
    patterns = growthEngine.getPatterns({ limit: 200 });
    suggestions = growthEngine.getSuggestions({ limit: 200 });
    learnedRules = growthEngine.getLearnedRules({});
  } catch {}

  // feedbacks: growth.db에서 직접 쿼리
  try {
    const Database = require('better-sqlite3');
    const growthDbPath = path.join(__dirname, '..', 'data', 'growth.db');
    if (fs.existsSync(growthDbPath)) {
      const gdb = new Database(growthDbPath, { readonly: true });
      try {
        feedbacks = gdb.prepare('SELECT * FROM feedbacks ORDER BY createdAt DESC LIMIT 500').all();
      } catch {}
      gdb.close();
    }
  } catch {}

  // ── 3. 트리거 패턴 수집 ─────────────────────────────────
  let triggers = [];
  try {
    const triggerEngine = require('./trigger-engine');
    const db = dbModule.getDb ? dbModule.getDb() : null;
    if (db) {
      triggers = triggerEngine.getTopTriggers(db, 100);
    }
  } catch {}

  // ── 4. 신호 데이터 수집 ─────────────────────────────────
  let signals = [];
  try {
    const db = dbModule.getDb ? dbModule.getDb() : null;
    if (db) {
      try {
        signals = db.prepare(
          'SELECT * FROM signals ORDER BY detected_at DESC LIMIT 200'
        ).all();
      } catch {}
    }
  } catch {}

  // ── 5. 학습 프로필 계산 ─────────────────────────────────
  let profile = {};
  try {
    const learningEngine = require('./learning-engine');
    const events = dbModule.getEventsByUser
      ? dbModule.getEventsByUser(userId)
      : dbModule.getAllEvents().filter(e => e.userId === userId);

    if (events && events.length > 0) {
      profile = learningEngine.buildLearningProfile(events);
    }
  } catch (e) {
    // learning-engine 또는 의존 모듈 없으면 빈 프로필
    profile = { error: e.message };
  }

  // ── 6. suggestions 테이블 (mindmap.db) ──────────────────
  let dbSuggestions = [];
  try {
    const db = dbModule.getDb ? dbModule.getDb() : null;
    if (db) {
      dbSuggestions = db.prepare(
        'SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 200'
      ).all();
    }
  } catch {}

  // ── JSON 구성 ──────────────────────────────────────────
  const learningData = {
    version: '1.0',
    type: 'learning-data',
    exportedAt: new Date().toISOString(),
    userId,
    pcId,
    hostname: os.hostname(),
    platform: os.platform(),
    learning: {
      insights,
      suggestions: [...suggestions, ...dbSuggestions],
      patterns,
      triggers,
      signals,
      feedbacks,
      learnedRules,
      profile,
    },
  };

  const jsonStr = JSON.stringify(learningData);
  const fileName = `orbit-learning-${pcId}-${timestamp}.json`;

  // ── Drive 업로드 ───────────────────────────────────────
  const folderId = await ensureOrbitFolder(accessToken);

  const boundary = '-------' + Date.now();
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from(jsonStr),
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload failed: ${res.status} ${errText}`);
  }

  const result = await res.json();
  const dataSize = {
    insights: insights.length,
    suggestions: suggestions.length + dbSuggestions.length,
    patterns: patterns.length,
    triggers: triggers.length,
    signals: signals.length,
    feedbacks: feedbacks.length,
    learnedRules: learnedRules.length,
  };

  console.log(`[gdrive-user-backup] Learning data ${userId} → ${fileName} (${JSON.stringify(dataSize)})`);

  return {
    fileId: result.id,
    fileName,
    dataSize,
    pcId,
  };
}

/**
 * Drive에서 학습 데이터 백업 목록 조회
 */
async function listLearningBackups(accessToken) {
  const folderId = await ensureOrbitFolder(accessToken);

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${folderId}' in parents and name contains 'orbit-learning-' and trashed=false`
  )}&orderBy=createdTime desc&fields=files(id,name,size,createdTime)&pageSize=20`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return (data.files || []).map(f => ({
    fileId: f.id,
    fileName: f.name,
    size: parseInt(f.size || '0'),
    createdAt: f.createdTime,
    pcId: f.name.match(/orbit-learning-([a-f0-9]+)-/)?.[1] || '',
  }));
}

module.exports = {
  getPcId,
  ensureOrbitFolder,
  backupUserDataToDrive,
  listBackups,
  downloadBackup,
  importBackupData,
  backupLearningData,
  listLearningBackups,
};
