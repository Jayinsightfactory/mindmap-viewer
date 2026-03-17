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

/**
 * Google Sheets로 학습 데이터 내보내기
 *
 * Sheet 1: "작업 루틴" — 작업 단위별 타임라인
 * Sheet 2: "반복 패턴" — 반복되는 작업 시퀀스
 * Sheet 3: "시간대별 작업" — 시간대별 작업 수
 * Sheet 4: "AI 제안" — 개선 제안 목록
 */
async function exportLearningSheet(userId, accessToken, dbModule) {
  const { extractWorkUnits, analyzePatterns } = require('./routine-learner');

  // ── 1. 사용자 이벤트 가져오기 ─────────────────────────────────────────────
  const events = dbModule.getEventsByUser
    ? await Promise.resolve(dbModule.getEventsByUser(userId))
    : await Promise.resolve(dbModule.getAllEvents()).then(all => all.filter(e => e.userId === userId));

  // 세션별로 그룹핑
  const sessionMap = {};
  events.forEach(e => {
    const sid = e.sessionId || 'default';
    if (!sessionMap[sid]) sessionMap[sid] = [];
    sessionMap[sid].push(e);
  });

  const sessionData = Object.entries(sessionMap).map(([id, evts]) => ({ sessionId: id, events: evts }));
  const patterns = analyzePatterns(sessionData);

  // ── 2. Sheet 1: 작업 루틴 (work units per session) ────────────────────────
  const sheet1Rows = [['날짜', '세션', '의도(WHY)', '행동(WHAT)', '결과(RESULT)', '시간', '프로젝트']];

  for (const { sessionId, events: sessEvents } of sessionData) {
    const units = extractWorkUnits(sessEvents);
    for (const unit of units) {
      const dt = unit.startTime ? new Date(unit.startTime) : null;
      const dateStr = dt ? dt.toISOString().slice(0, 10) : '';
      const timeStr = dt ? dt.toTimeString().slice(0, 5) : '';
      const actions = unit.actions.map(a => {
        if (a.type === 'edit' || a.type === 'write') return `${a.type}: ${a.file}`;
        if (a.type === 'bash') return `bash: ${a.file}`;
        return a.type;
      }).join(', ');
      const project = unit.files.length > 0 ? unit.files[0].split('/').slice(-2, -1)[0] || '' : '';
      sheet1Rows.push([dateStr, sessionId.slice(0, 12), unit.intent || '', actions, unit.result || '', timeStr, project]);
    }
  }

  // ── 3. Sheet 2: 반복 패턴 ─────────────────────────────────────────────────
  const sheet2Rows = [['패턴', '반복 횟수', '설명']];
  for (const r of (patterns.routines || [])) {
    sheet2Rows.push([r.sequence, r.count, r.description || '']);
  }
  if (sheet2Rows.length === 1) sheet2Rows.push(['(패턴 없음)', 0, '더 많은 작업 데이터가 필요합니다']);

  // ── 4. Sheet 3: 시간대별 작업 ─────────────────────────────────────────────
  const sheet3Rows = [['시간대', '작업 수']];
  const timeOrder = ['새벽', '오전', '오후', '저녁'];
  for (const slot of timeOrder) {
    if (patterns.timePatterns[slot] !== undefined) {
      sheet3Rows.push([slot, patterns.timePatterns[slot]]);
    }
  }
  if (sheet3Rows.length === 1) sheet3Rows.push(['(데이터 없음)', 0]);

  // ── 5. Sheet 4: AI 제안 ───────────────────────────────────────────────────
  const sheet4Rows = [['유형', '제안 내용']];
  const TYPE_KR = { routine: '루틴', time: '시간', specialization: '전문화', tool: '도구' };
  for (const s of (patterns.suggestions || [])) {
    sheet4Rows.push([TYPE_KR[s.type] || s.type, s.message]);
  }
  if (sheet4Rows.length === 1) sheet4Rows.push(['(제안 없음)', '더 많은 작업 데이터가 필요합니다']);

  // ── 6. Orbit AI 폴더 확보 ──────────────────────────────────────────────────
  const folderId = await ensureOrbitFolder(accessToken);

  // ── 7. 기존 시트 검색 (있으면 업데이트, 없으면 생성) ───────────────────────
  const SHEET_NAME = 'Orbit AI 학습 데이터';
  let spreadsheetId = null;

  // Drive에서 기존 시트 검색
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `name='${SHEET_NAME}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
  )}&fields=files(id,name)`;

  const searchRes = await fetch(searchUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const searchData = await searchRes.json();

  if (searchData.files?.length > 0) {
    spreadsheetId = searchData.files[0].id;
  }

  // ── 8. 시트 생성 또는 기존 시트 클리어 ─────────────────────────────────────
  if (!spreadsheetId) {
    // 새 스프레드시트 생성
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: { title: SHEET_NAME },
        sheets: [
          { properties: { title: '작업 루틴', index: 0 } },
          { properties: { title: '반복 패턴', index: 1 } },
          { properties: { title: '시간대별 작업', index: 2 } },
          { properties: { title: 'AI 제안', index: 3 } },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Sheets create failed: ${createRes.status} ${errText}`);
    }

    const created = await createRes.json();
    spreadsheetId = created.spreadsheetId;

    // 생성된 시트를 Orbit AI 폴더로 이동
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${folderId}&removeParents=root&fields=id`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
  } else {
    // 기존 시트의 탭 구조 확인 및 데이터 클리어
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    const meta = await metaRes.json();
    const existingSheets = (meta.sheets || []).map(s => s.properties.title);
    const requiredSheets = ['작업 루틴', '반복 패턴', '시간대별 작업', 'AI 제안'];

    // 부족한 탭 추가
    const requests = [];
    for (const title of requiredSheets) {
      if (!existingSheets.includes(title)) {
        requests.push({ addSheet: { properties: { title } } });
      }
    }
    if (requests.length > 0) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(15000),
      });
    }

    // 기존 데이터 클리어
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ranges: requiredSheets.map(s => `'${s}'`),
      }),
      signal: AbortSignal.timeout(15000),
    });
  }

  // ── 9. 데이터 쓰기 (batchUpdate) ──────────────────────────────────────────
  const updateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: "'작업 루틴'!A1", values: sheet1Rows },
          { range: "'반복 패턴'!A1", values: sheet2Rows },
          { range: "'시간대별 작업'!A1", values: sheet3Rows },
          { range: "'AI 제안'!A1", values: sheet4Rows },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    throw new Error(`Sheets update failed: ${updateRes.status} ${errText}`);
  }

  // ── 10. 헤더 행 서식 (볼드 + 배경색) ──────────────────────────────────────
  try {
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    const meta = await metaRes.json();
    const sheetIds = {};
    for (const s of (meta.sheets || [])) {
      sheetIds[s.properties.title] = s.properties.sheetId;
    }

    const formatRequests = [];
    for (const title of ['작업 루틴', '반복 패턴', '시간대별 작업', 'AI 제안']) {
      const sid = sheetIds[title];
      if (sid === undefined) continue;
      formatRequests.push({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.16, green: 0.38, blue: 0.87 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
      // 열 자동 너비
      formatRequests.push({
        autoResizeDimensions: {
          dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: 10 },
        },
      });
    }

    if (formatRequests.length > 0) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: formatRequests }),
        signal: AbortSignal.timeout(15000),
      });
    }
  } catch (fmtErr) {
    // 서식 적용 실패는 무시 (데이터는 이미 기록됨)
    console.warn('[exportLearningSheet] 서식 적용 실패:', fmtErr.message);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  console.log(`[gdrive-user-backup] Sheets export ${userId} → ${SHEET_NAME} (${sheet1Rows.length - 1} work units)`);

  return {
    spreadsheetId,
    sheetUrl,
    sheetName: SHEET_NAME,
    stats: {
      workUnits: sheet1Rows.length - 1,
      routines: sheet2Rows.length - 1,
      timeSlots: sheet3Rows.length - 1,
      suggestions: sheet4Rows.length - 1,
    },
  };
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
  exportLearningSheet,
};
