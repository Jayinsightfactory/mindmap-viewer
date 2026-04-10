'use strict';
/**
 * report-sheet.js — Google Sheets 자동 분석 리포트
 *
 * 서비스 계정으로 Google Sheets 생성/업데이트.
 * 정해진 시간에 work-learner 분석 결과를 시트에 기록.
 * dlaww584@gmail.com에 자동 공유.
 */

const https = require('https');
const crypto = require('crypto');

let _credentials = null;
let _folderId = null;
let _spreadsheetId = null; // 한 번 생성 후 재사용
let _accessToken = null;
let _tokenExpiry = 0;

const SHARE_EMAIL = 'dlaww584@gmail.com';

// ── 초기화 ──────────────────────────────────────────────────────────────────
function init(config) {
  if (config.credentials) _credentials = config.credentials;
  else if (config.credentialsJson) {
    try { _credentials = JSON.parse(config.credentialsJson); } catch {}
  }
  _folderId = config.folderId || null;
  return !!(_credentials && _credentials.private_key);
}

// ── JWT → 액세스 토큰 ────────────────────────────────────────────────────────
function _createJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: _credentials.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(_credentials.private_key, 'base64url')}`;
}

async function _getToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
  const jwt = _createJwt('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          _accessToken = p.access_token; _tokenExpiry = Date.now() + (p.expires_in - 60) * 1000;
          resolve(_accessToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── HTTPS 유틸 ───────────────────────────────────────────────────────────────
function _httpsJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 15000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 스프레드시트 생성 ─────────────────────────────────────────────────────────
async function _createSpreadsheet(token) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await _httpsJson('POST', 'https://sheets.googleapis.com/v4/spreadsheets', token, {
    properties: { title: `Orbit AI 일일분석 — ${today}` },
    sheets: [
      { properties: { title: '멤버별 분석', index: 0 } },
      { properties: { title: '상세 세션', index: 1 } },
      { properties: { title: '인사이트', index: 2 } },
    ],
  });
  _spreadsheetId = result.spreadsheetId;

  // 폴더로 이동
  if (_folderId && _spreadsheetId) {
    try {
      await _httpsJson('PATCH', `https://www.googleapis.com/drive/v3/files/${_spreadsheetId}?addParents=${_folderId}&fields=id`, token);
    } catch {}
  }

  // dlaww584@gmail.com에 공유 (편집자)
  try {
    await _httpsJson('POST', `https://www.googleapis.com/drive/v3/files/${_spreadsheetId}/permissions`, token, {
      type: 'user', role: 'writer', emailAddress: SHARE_EMAIL,
    });
    console.log(`[report-sheet] ${SHARE_EMAIL}에 시트 공유 완료`);
  } catch (e) {
    console.warn('[report-sheet] 공유 실패:', e.message);
  }

  return _spreadsheetId;
}

// ── 시트 데이터 업데이트 ──────────────────────────────────────────────────────
async function _updateSheet(token, sheetName, values) {
  const range = encodeURIComponent(`${sheetName}!A1`);
  await _httpsJson('PUT',
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${range}?valueInputOption=RAW`,
    token, { range: `${sheetName}!A1`, majorDimension: 'ROWS', values });
}

// ── 분석 결과 → 시트 기록 ─────────────────────────────────────────────────────
async function writeReport(analysisResults, memberNames) {
  if (!_credentials) { console.warn('[report-sheet] 미초기화'); return null; }

  try {
    const token = await _getToken();

    // 매일 새 시트 생성 (또는 기존 시트 업데이트)
    const today = new Date().toISOString().slice(0, 10);
    if (!_spreadsheetId) {
      await _createSpreadsheet(token);
    } else {
      // 제목 업데이트
      try {
        await _httpsJson('POST', `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}:batchUpdate`, token, {
          requests: [{ updateSpreadsheetProperties: { properties: { title: `Orbit AI 일일분석 — ${today}` }, fields: 'title' } }],
        });
      } catch {}
    }

    // ── 시트1: 멤버별 분석 ──
    const members = analysisResults.members || [];
    const sheet1 = [
      ['Orbit AI 일일 분석 리포트', '', '', '', '', `생성: ${new Date().toLocaleString('ko-KR')}`],
      [],
      ['멤버', '이벤트', '세션', '주요앱', '업무분류', '업무시간(분)', '자동화점수', '피크시간', '인사이트'],
    ];
    for (const m of members) {
      const name = memberNames?.[m.userId] || m.userId?.substring(0, 10) || '?';
      if (m.status === 'insufficient') {
        sheet1.push([name, m.eventCount || 0, '-', '-', '-', '-', '-', '-', m.message || '데이터 부족']);
        continue;
      }
      const topApp = m.topApps?.[0]?.[0] || '-';
      const topCat = m.topCategories?.[0]?.[0] || '-';
      const peak = m.timeAnalysis?.peakHour != null ? `${m.timeAnalysis.peakHour}시` : '-';
      const insight = (m.insights || []).map(i => i.text).join(' | ');
      sheet1.push([name, m.eventCount, m.sessionCount, topApp, topCat, m.totalWorkMin, m.automationScore, peak, insight]);
    }
    sheet1.push([]);
    sheet1.push(['팀 인사이트']);
    for (const ti of (analysisResults.teamInsights || [])) {
      sheet1.push(['', ti.text]);
    }

    await _updateSheet(token, '멤버별 분석', sheet1);

    // ── 시트2: 상세 세션 ──
    const sheet2 = [['멤버', '시작시간', '종료시간', '시간(분)', '주요앱', '업무분류', '이벤트수', '클릭수', '캡처수', '윈도우타이틀']];
    for (const m of members) {
      if (m.status === 'insufficient') continue;
      const name = memberNames?.[m.userId] || m.userId?.substring(0, 10);
      for (const s of (m.sessions || [])) {
        const start = s.startTime ? new Date(s.startTime).toLocaleString('ko-KR') : '';
        const end = s.endTime ? new Date(s.endTime).toLocaleString('ko-KR') : '';
        const wins = (s.uniqueWindows || []).join(', ');
        sheet2.push([name, start, end, s.durationMin, s.primaryApp, s.primaryCategory, s.eventCount, s.totalClicks, s.captureCount, wins]);
      }
    }
    await _updateSheet(token, '상세 세션', sheet2);

    // ── 시트3: 인사이트 ──
    const sheet3 = [['유형', '멤버', '내용']];
    for (const m of members) {
      if (m.status === 'insufficient') continue;
      const name = memberNames?.[m.userId] || m.userId?.substring(0, 10);
      for (const i of (m.insights || [])) {
        sheet3.push([i.type, name, i.text]);
      }
      for (const p of (m.patterns || [])) {
        sheet3.push(['패턴', name, `${p.pattern} (${p.count}회)${p.automatable ? ' — 자동화 가능' : ''}`]);
      }
    }
    await _updateSheet(token, '인사이트', sheet3);

    const url = `https://docs.google.com/spreadsheets/d/${_spreadsheetId}`;
    console.log(`[report-sheet] 리포트 업데이트 완료: ${url}`);
    return url;
  } catch (e) {
    console.error('[report-sheet] 에러:', e.message);
    return null;
  }
}

function getSpreadsheetUrl() {
  return _spreadsheetId ? `https://docs.google.com/spreadsheets/d/${_spreadsheetId}` : null;
}

// ── 프로세스 마이닝 리포트 → 별도 시트에 기록 ────────────────────────────────
let _miningSheetId = null;

async function writeMiningReport(miningData) {
  if (!_credentials) { console.warn('[report-sheet] 미초기화'); return null; }

  try {
    const token = await _getToken();
    const today = new Date().toISOString().slice(0, 10);

    // 프로세스 마이닝 전용 스프레드시트 생성 (또는 기존 재사용)
    if (!_miningSheetId) {
      const result = await _httpsJson('POST', 'https://sheets.googleapis.com/v4/spreadsheets', token, {
        properties: { title: `Orbit 프로세스 마이닝 — ${today}` },
        sheets: [
          { properties: { title: '프로세스 요약', index: 0 } },
          { properties: { title: '업무 흐름 패턴', index: 1 } },
          { properties: { title: '병목 분석', index: 2 } },
          { properties: { title: '직원 비교', index: 3 } },
          { properties: { title: '의사결정 분기', index: 4 } },
          { properties: { title: '비정상 감지', index: 5 } },
        ],
      });
      _miningSheetId = result.spreadsheetId;

      if (_folderId) {
        try { await _httpsJson('PATCH', `https://www.googleapis.com/drive/v3/files/${_miningSheetId}?addParents=${_folderId}&fields=id`, token); } catch {}
      }
      try {
        await _httpsJson('POST', `https://www.googleapis.com/drive/v3/files/${_miningSheetId}/permissions`, token, {
          type: 'user', role: 'writer', emailAddress: SHARE_EMAIL,
        });
      } catch {}
      console.log(`[report-sheet] 프로세스 마이닝 시트 생성: ${_miningSheetId}`);
    } else {
      try {
        await _httpsJson('POST', `https://sheets.googleapis.com/v4/spreadsheets/${_miningSheetId}:batchUpdate`, token, {
          requests: [{ updateSpreadsheetProperties: { properties: { title: `Orbit 프로세스 마이닝 — ${today}` }, fields: 'title' } }],
        });
      } catch {}
    }

    const _updateMiningSheet = async (name, values) => {
      const range = encodeURIComponent(`${name}!A1`);
      await _httpsJson('PUT',
        `https://sheets.googleapis.com/v4/spreadsheets/${_miningSheetId}/values/${range}?valueInputOption=RAW`,
        token, { range: `${name}!A1`, majorDimension: 'ROWS', values });
    };

    // 시트1: 프로세스 요약
    const s1 = [
      [`Orbit 프로세스 마이닝 리포트`, '', '', `생성: ${new Date().toLocaleString('ko-KR')}`],
      [],
      ['기간', miningData.period || today],
      ['활성 사용자', miningData.activeUsers || 0],
      ['총 이벤트', miningData.totalEvents || 0],
      ['Vision 분석', miningData.visionAnalyzed || 0],
      [],
      ['=== 시간대별 활동 히트맵 ==='],
      ['시간(KST)', '이벤트 수', '그래프'],
    ];
    for (const h of (miningData.hourlyHeatmap || [])) {
      const bar = '█'.repeat(Math.min(Math.round(h.events / 10), 30));
      s1.push([`${h.hour}시`, h.events, bar]);
    }
    await _updateMiningSheet('프로세스 요약', s1);

    // 시트2: 업무 흐름 패턴
    const s2 = [
      ['업무 흐름 패턴 (반복 빈도순)', '', '', ''],
      [],
      ['패턴', '반복 횟수', '평균 소요(분)', '해석'],
    ];
    for (const p of (miningData.patterns || [])) {
      s2.push([p.flow || p.pattern, p.count, p.avgDurationMin || p.avgMin || '', p.interpretation || '']);
    }
    await _updateMiningSheet('업무 흐름 패턴', s2);

    // 시트3: 병목 분석
    const s3 = [
      ['병목 분석', '', '', '', ''],
      [],
      ['앱', '평균 소요(초)', '중간값(초)', '이상치 횟수', '최대(초)', '총 발생'],
    ];
    for (const b of (miningData.bottlenecks || [])) {
      s3.push([b.app, b.avgDurationSec, b.medianDurationSec, b.outlierCount, b.worstCaseSec, b.totalOccurrences]);
    }
    s3.push([]);
    s3.push(['=== 자동화 기회 ===']);
    s3.push(['앱', '소요(초)', '자동화 점수', '상세']);
    for (const a of (miningData.automationOpportunities || []).slice(0, 20)) {
      s3.push([a.app, a.durationSec, a.automationScore, (a.details || []).join('; ')]);
    }
    await _updateMiningSheet('병목 분석', s3);

    // 시트4: 직원 비교
    const s4 = [
      ['직원 비교 분석', '', '', '', '', ''],
      [],
      ['이름', '총 업무(분)', '세션 수', '블록 수', '평균 세션(분)', '주요 앱'],
    ];
    for (const u of (miningData.users || [])) {
      const topApps = (u.timeByApp || []).slice(0, 3).map(t => `${t.app}(${t.minutes}분)`).join(', ');
      s4.push([u.name, u.totalWorkMin, u.totalSessions, u.totalBlocks, u.avgSessionMin, topApps]);
    }
    s4.push([]);
    s4.push(['=== 베스트 프랙티스 비교 ===']);
    s4.push(['워크플로우', '최고 효율 직원', '시간(분)', '최저 효율 직원', '시간(분)', '차이(분)']);
    for (const bp of (miningData.bestPractices || [])) {
      s4.push([bp.flow, bp.fastest?.name, bp.fastest?.avgMin, bp.slowest?.name, bp.slowest?.avgMin, bp.gapMin]);
    }
    await _updateMiningSheet('직원 비교', s4);

    // 시트5: 의사결정 분기
    const s5 = [
      ['의사결정 분기점 분석', '', '', ''],
      [],
      ['출발 앱', '분기 수', '선택지', '인사이트'],
    ];
    for (const dp of (miningData.decisionPoints || [])) {
      const choices = (dp.choices || []).map(c => `${c.nextApp}(${c.totalTransitions})`).join(', ');
      s5.push([dp.fromApp, dp.choiceCount, choices, dp.insight || '']);
    }
    await _updateMiningSheet('의사결정 분기', s5);

    // 시트6: 비정상 감지
    const s6 = [
      ['비정상 패턴 감지', '', '', '', ''],
      [],
      ['심각도', '유형', '앱', '상세', '날짜'],
    ];
    for (const a of (miningData.anomalies || [])) {
      s6.push([a.severity, a.type, a.app || '', a.message, a.date || today]);
    }
    await _updateMiningSheet('비정상 감지', s6);

    const url = `https://docs.google.com/spreadsheets/d/${_miningSheetId}`;
    console.log(`[report-sheet] 프로세스 마이닝 리포트: ${url}`);
    return url;
  } catch (e) {
    console.error('[report-sheet] 마이닝 리포트 에러:', e.message);
    return null;
  }
}

function getMiningSheetUrl() {
  return _miningSheetId ? `https://docs.google.com/spreadsheets/d/${_miningSheetId}` : null;
}

module.exports = { init, writeReport, getSpreadsheetUrl, writeMiningReport, getMiningSheetUrl };
