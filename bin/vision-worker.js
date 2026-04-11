#!/usr/bin/env node
'use strict';
/**
 * vision-worker.js — Google Drive 캡처 Vision 분석 워커
 *
 * Google Drive "Orbit AI Captures" 폴더의 스크린샷을
 * Claude로 분석하여 서버에 결과 전송.
 *
 * 모드 1 (CLI — Claude Max 구독자): node bin/vision-worker.js
 * 모드 2 (API):                    ANTHROPIC_API_KEY=sk-xxx node bin/vision-worker.js
 *
 * CLI 모드는 API 키 없이 claude 명령어로 분석 (구독 포함)
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { execFile, execSync } = require('child_process');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).anthropicApiKey || ''; }
  catch { return ''; }
})();
const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';

// Claude CLI 경로 감지
const CLAUDE_CLI = (() => {
  try {
    return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 })
      .toString().trim().split('\n')[0];
  } catch { return null; }
})();
const USE_CLI = !ANTHROPIC_KEY && !!CLAUDE_CLI;
const TEMP_DIR = path.join(os.tmpdir(), 'orbit-vision');
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).token || ''; }
  catch { return ''; }
})();
const POLL_INTERVAL = 3 * 60 * 1000; // 3분

// ── Google 서비스 계정 ────────────────────────────────────────────────────────
let _gCred = null, _gFolder = null, _gToken = null, _gTokenExp = 0;

async function loadGoogleConfig() {
  return new Promise((resolve) => {
    const url = new URL('/api/daemon/drive-config', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = {}; if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.get({ hostname: url.hostname, port: url.port || 443, path: url.pathname, headers: h, timeout: 10000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const cfg = JSON.parse(d);
          if (cfg.enabled) { _gCred = JSON.parse(cfg.credentialsJson); _gFolder = cfg.folderId; }
          resolve(cfg.enabled);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function gToken() {
  if (_gToken && Date.now() < _gTokenExp) return _gToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg:'RS256', typ:'JWT' })}.${b64({ iss:_gCred.client_email, scope:'https://www.googleapis.com/auth/drive', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600 })}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(_gCred.private_key, 'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{ const p=JSON.parse(d); _gToken=p.access_token; _gTokenExp=Date.now()+3500000; resolve(_gToken); });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

function gApi(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const h = { 'Authorization': `Bearer ${token}` };
    if (payload) { h['Content-Type']='application/json'; h['Content-Length']=Buffer.byteLength(payload); }
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method, headers:h, timeout:30000 }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{ try { resolve(JSON.parse(d)); } catch { resolve({ raw:d }); } });
    }); req.on('error', reject); if(payload) req.write(payload); req.end();
  });
}

function gDownload(fileId, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'www.googleapis.com', path:`/drive/v3/files/${fileId}?alt=media`, method:'GET',
      headers:{ 'Authorization':`Bearer ${token}` }, timeout:30000 }, res => {
      const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('end', ()=>resolve(Buffer.concat(chunks).toString('base64')));
    }); req.on('error', reject); req.end();
  });
}

// ── 미분석 캡처 찾기 ──────────────────────────────────────────────────────────
async function findCaptures() {
  const token = await gToken();
  const folders = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q='${_gFolder}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`, token);
  const caps = [];
  for (const f of (folders.files || [])) {
    const files = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q='${f.id}'+in+parents+and+mimeType='image/png'+and+trashed=false&fields=files(id,name,description,createdTime)&orderBy=createdTime+desc&pageSize=10`, token);
    for (const img of (files.files || [])) {
      if (img.description?.includes('analyzed')) continue;
      caps.push({ id:img.id, name:img.name, hostname:f.name, ts:img.createdTime });
    }
  }
  return caps;
}

// ── 분석 프롬프트 ─────────────────────────────────────────────────────────────
function _buildPrompt(ctx) {
  return `스크린샷을 정밀 분석해주세요. 호스트: ${ctx.hostname}

다음 JSON 형식으로만 응답 (마크다운 없이 순수 JSON):
{
  "app": "실제 프로그램명",
  "screen": "현재 화면/메뉴명 (예: 신규주문등록, 카카오톡 호남소재 단톡방)",
  "activity": "사용자가 지금 하는 작업 1줄 (구체적으로)",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타",

  "fields": [
    {
      "name": "필드/항목명",
      "type": "input|button|dropdown|table|text|checkbox",
      "currentValue": "현재 입력된 값 (보이는 경우)",
      "position": "화면 위치 (상단/중앙/하단 + 좌/우)",
      "dataSource": "kakao|manual|erp|clipboard|unknown",
      "humanRequired": true/false,
      "humanReason": "사람 판단 필요한 이유 (humanRequired가 true일 때만)"
    }
  ],

  "autoAreas": ["자동화 가능한 작업 목록 — 데이터 출처가 명확한 것"],
  "humanAreas": ["반드시 사람이 판단해야 하는 영역 — 의사결정/확인/예외처리"],

  "nenovaAction": "nenova ERP에서 해당하는 화면명 (해당없으면 null)",
  "nenovaInputMap": [
    {
      "field": "nenova 입력 필드명",
      "value": "입력할 값 또는 데이터 출처",
      "source": "kakao_parse|clipboard|manual|formula",
      "automatable": true/false
    }
  ],

  "automationScore": 0.0~1.0,
  "automatable": true/false,
  "automationHint": "자동화 구현 방법 (PAD UI셀렉터 or pyautogui 좌표 or 클립보드)",
  "padPossible": true/false,
  "scriptType": "PAD|pyautogui|clipboard|none"
}`;
}

function _parseResult(text) {
  if (!text) return { raw: '' };

  let jsonStr = null;

  // Strategy 1: ```json ... ``` 코드블록에서 추출
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();

  // Strategy 2: 가장 바깥 { ... } 추출
  if (!jsonStr) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
  }

  if (jsonStr) {
    // Claude가 프롬프트 템플릿 힌트를 그대로 넣는 문제 수정
    const cleaned = jsonStr
      .replace(/:\s*true\/false/g, ': true')              // "true/false" → true
      .replace(/:\s*(\d+\.?\d*)~(\d+\.?\d*)/g, ': $1')   // "0.0~1.0" → 0.0
      .replace(/,\s*([}\]])/g, '$1')                       // trailing comma
      .replace(/\/\/[^\n]*/g, '')                           // line comment
      .replace(/\/\*[\s\S]*?\*\//g, '');                    // block comment

    try { return JSON.parse(cleaned); } catch {}
    try { return JSON.parse(jsonStr); } catch {}
  }

  // Strategy 3: 전체 텍스트를 JSON으로 시도
  try { return JSON.parse(text.trim()); } catch {}

  // 실패 — 디버깅용 원본 2000자 보존
  return { raw: text.substring(0, 2000) };
}

// ── Claude CLI 분석 (Max 구독 — API 키 불필요) ───────────────────────────────
async function visionCli(base64, ctx) {
  const tmpFile = path.join(TEMP_DIR, `cap-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
  // CLI는 프롬프트에 파일 경로를 포함하면 Read 도구로 이미지 인식
  const prompt = `${tmpFile} ${_buildPrompt(ctx)}`;

  return new Promise((resolve) => {
    execFile(CLAUDE_CLI, ['-p', prompt, '--allowedTools', 'Read', '--add-dir', TEMP_DIR],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) { console.warn(`  CLI 분석 실패: ${err.message}`); resolve(null); return; }
      resolve(_parseResult(String(stdout)));
    });
  });
}

// ── Claude API 분석 (API 키 사용) ─────────────────────────────────────────────
async function visionApi(base64, ctx) {
  const prompt = _buildPrompt(ctx);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1024,
      messages: [{ role:'user', content:[
        { type:'image', source:{ type:'base64', media_type:'image/png', data:base64 } },
        { type:'text', text:prompt },
      ]}],
    });
    const req = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', timeout:60000,
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Length':Buffer.byteLength(body) },
    }, res => {
      let d=''; res.on('data', c=>d+=c);
      res.on('end', ()=>{
        try { resolve(_parseResult(JSON.parse(d).content?.[0]?.text)); }
        catch(e) { reject(e); }
      });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

// ── 결과 유효성 검사 ─────────────────────────────────────────────────────────
function _isValidResult(result) {
  if (!result) return false;
  if (result.raw !== undefined && !result.app) return false; // 파싱 실패
  return !!(result.app || result.activity || result.screen);
}

// ── 통합 분석 함수 (1회 재시도 포함) ─────────────────────────────────────────
async function visionAnalyze(base64, ctx) {
  const analyze = USE_CLI ? visionCli : ANTHROPIC_KEY ? visionApi : null;
  if (!analyze) throw new Error('Claude CLI 또는 ANTHROPIC_API_KEY 필요');

  let result = await analyze(base64, ctx);
  if (_isValidResult(result)) return result;

  // 1회 재시도
  console.log('  ⟳ 빈 결과 — 1회 재시도');
  await new Promise(r => setTimeout(r, 3000));
  result = await analyze(base64, ctx);
  if (_isValidResult(result)) return result;

  console.warn(`  ✗ 재시도 후에도 빈 결과 (${ctx.hostname}/${ctx.name})`);
  return null;
}

// ── 결과 서버 전송 ────────────────────────────────────────────────────────────
function sendToServer(cap, analysis, base64Thumbnail) {
  const eventData = { fileId:cap.id, filename:cap.name, hostname:cap.hostname, ...analysis };
  // 썸네일 포함 (100KB 이하로 리사이즈 — 원본의 처음 부분)
  if (base64Thumbnail) {
    // base64 이미지의 앞 100KB만 전송 (썸네일 용도)
    eventData.thumbnail = base64Thumbnail.substring(0, 100000);
  }
  const payload = JSON.stringify({ events:[{
    id:`vision-${Date.now()}-${cap.id.substring(0,6)}`, type:'screen.analyzed', source:'vision-worker',
    sessionId:`daemon-${cap.hostname}`, timestamp:cap.ts || new Date().toISOString(),
    data: eventData,
  }] });
  return new Promise(resolve => {
    const url = new URL('/api/hook', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) };
    if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.request({ hostname:url.hostname, port:url.port||443, path:url.pathname, method:'POST', headers:h, timeout:10000 }, res => {
      res.resume(); resolve(res.statusCode < 300);
    }); req.on('error', ()=>resolve(false)); req.write(payload); req.end();
  });
}

// ── Google Sheets 저장 ──────────────────────────────────────────────────────
let _sheetsId = null;

async function _ensureVisionSheet(token) {
  if (_sheetsId) return _sheetsId;

  // 기존 "Vision 분석" 시트 검색
  try {
    const q = encodeURIComponent("name='Orbit AI Vision 분석' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    const search = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=modifiedTime+desc&pageSize=1`, token);
    if (search.files && search.files.length > 0) {
      _sheetsId = search.files[0].id;
      console.log(`[vision] 기존 Sheets 발견: ${_sheetsId}`);
      return _sheetsId;
    }
  } catch {}

  // 새 스프레드시트 생성 (Sheets API 스코프 토큰 필요)
  const sheetsToken = await _getSheetsToken();
  const result = await gApi('POST', 'https://sheets.googleapis.com/v4/spreadsheets', sheetsToken, {
    properties: { title: 'Orbit AI Vision 분석' },
    sheets: [{ properties: { title: 'Vision 분석', index: 0 } }],
  });
  _sheetsId = result.spreadsheetId;
  console.log(`[vision] 새 Sheets 생성: ${_sheetsId}`);

  // 폴더로 이동
  if (_gFolder) {
    try { await gApi('PATCH', `https://www.googleapis.com/drive/v3/files/${_sheetsId}?addParents=${_gFolder}&fields=id`, token); } catch {}
  }

  // dlaww584@gmail.com에 공유
  try {
    await gApi('POST', `https://www.googleapis.com/drive/v3/files/${_sheetsId}/permissions`, sheetsToken, {
      type: 'user', role: 'writer', emailAddress: 'dlaww584@gmail.com',
    });
    console.log('[vision] Sheets 공유 완료: dlaww584@gmail.com');
  } catch (e) { console.warn('[vision] Sheets 공유 실패:', e.message); }

  // 헤더 행 추가
  try {
    const hUrl = `https://sheets.googleapis.com/v4/spreadsheets/${_sheetsId}/values/${encodeURIComponent('Vision 분석!A1')}?valueInputOption=RAW`;
    await gApi('PUT', hUrl, sheetsToken, {
      range: 'Vision 분석!A1', majorDimension: 'ROWS',
      values: [['시간', '호스트', '파일명', '앱', '화면', '활동', '자동화가능', '자동화힌트', '카테고리']],
    });
  } catch (e) { console.warn('[vision] 헤더 기록 실패:', e.message); }

  return _sheetsId;
}

let _sheetsToken = null, _sheetsTokenExp = 0;

async function _getSheetsToken() {
  if (_sheetsToken && Date.now() < _sheetsTokenExp) return _sheetsToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg:'RS256', typ:'JWT' })}.${b64({
    iss: _gCred.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(_gCred.private_key, 'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{
        const p = JSON.parse(d); _sheetsToken = p.access_token; _sheetsTokenExp = Date.now() + 3500000; resolve(_sheetsToken);
      });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

async function saveToSheets(cap, analysis) {
  try {
    const driveToken = await gToken();
    const sheetId = await _ensureVisionSheet(driveToken);
    const sheetsToken = await _getSheetsToken();

    const ts = cap.ts ? new Date(cap.ts).toLocaleString('ko-KR') : new Date().toLocaleString('ko-KR');
    const row = [
      ts,
      cap.hostname || '',
      cap.name || '',
      analysis.app || '',
      analysis.screen || '',
      analysis.activity || '',
      analysis.automatable ? '가능' : '불가',
      analysis.automationHint || '',
      analysis.workCategory || '',
    ];

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Vision 분석!A:I')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await gApi('POST', appendUrl, sheetsToken, {
      range: 'Vision 분석!A:I', majorDimension: 'ROWS', values: [row],
    });
    console.log(`  → Sheets 저장 완료`);
    return true;
  } catch (e) {
    console.warn(`  → Sheets 저장 실패: ${e.message}`);
    return false;
  }
}

// ── 메인 루프 ─────────────────────────────────────────────────────────────────
async function processBatch() {
  try {
    const caps = await findCaptures();
    if (!caps.length) return 0;
    console.log(`[vision] 미분석: ${caps.length}건`);
    const token = await gToken();
    let done = 0;
    for (const cap of caps.slice(0, 5)) {
      try {
        console.log(`[vision] ${cap.hostname}/${cap.name}`);
        const b64 = await gDownload(cap.id, token);
        const result = await visionAnalyze(b64, cap);
        if (!result) { console.warn(`  ✗ 분석 실패 — 스킵: ${cap.name}`); continue; }
        console.log(`  → ${result.app}: ${result.activity?.substring(0,50)}`);
        await sendToServer(cap, result, b64);
        await saveToSheets(cap, result);
        // 분석 완료 마킹 후 Drive에서 파일 삭제
        await gApi('DELETE', `https://www.googleapis.com/drive/v3/files/${cap.id}`, token, null);
        console.log(`  → Drive 파일 삭제 완료: ${cap.name}`);
        done++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) { console.warn(`  실패: ${e.message}`); }
    }
    return done;
  } catch (e) { console.error('[vision] 에러:', e.message); return 0; }
}

// ── 서버 큐 모드: /api/vision/queue에서 이미지 가져와 CLI 분석 ───────────────
async function processServerQueue() {
  try {
    const url = new URL('/api/vision/queue', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = {}; if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;

    const queueData = await new Promise((resolve) => {
      const req = mod.get({ hostname: url.hostname, port: url.port || 443, path: url.pathname, headers: h, timeout: 15000 }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ batch: [] }); } });
      });
      req.on('error', () => resolve({ batch: [] }));
      req.end();
    });

    const batch = queueData.batch || [];
    if (!batch.length) return 0;
    console.log(`[vision-queue] 서버 큐에서 ${batch.length}건 수신 (대기: ${queueData.pending}건)`);

    let done = 0;
    for (const item of batch) {
      try {
        if (!item.imageBase64) { console.warn('  이미지 없음, 스킵'); continue; }
        console.log(`[vision-queue] ${item.hostname}/${item.app}: ${item.windowTitle || ''}`);

        const result = await visionAnalyze(item.imageBase64, {
          hostname: item.hostname, name: item.app || 'capture',
        });
        if (!result) continue;

        console.log(`  → ${result.app}: ${(result.activity || '').substring(0, 50)}`);

        // screen.analyzed 이벤트로 서버에 전송 (분석 결과 전체 포함)
        const payload = JSON.stringify({ events: [{
          id: `vision-cli-${Date.now()}-${done}`, type: 'screen.analyzed', source: 'vision-cli-worker',
          sessionId: item.sessionId, userId: item.userId,
          timestamp: item.ts || new Date().toISOString(),
          data: {
            hostname: item.hostname,
            originalCaptureId: item.id,
            ...result,
            app: result.app || item.app || '',
          },
        }] });

        await new Promise(resolve => {
          const sUrl = new URL('/api/hook', ORBIT_SERVER);
          const sMod = sUrl.protocol === 'https:' ? https : http;
          const sh = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
          if (ORBIT_TOKEN) sh['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
          const sr = sMod.request({ hostname: sUrl.hostname, port: sUrl.port || 443, path: sUrl.pathname, method: 'POST', headers: sh, timeout: 10000 },
            r => { r.resume(); resolve(r.statusCode < 300); });
          sr.on('error', () => resolve(false)); sr.write(payload); sr.end();
        });

        done++;
        await new Promise(r => setTimeout(r, 2000)); // CLI 쿨다운
      } catch (e) { console.warn(`  분석 실패: ${e.message}`); }
    }
    return done;
  } catch (e) { console.error('[vision-queue] 에러:', e.message); return 0; }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
const SERVER_QUEUE_MODE = process.argv.includes('--server-queue') || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

async function main() {
  console.log('[vision-worker] Claude Vision 분석 워커');
  if (!ANTHROPIC_KEY && !CLAUDE_CLI) {
    console.error('Claude CLI 또는 ANTHROPIC_API_KEY 필요');
    console.error('  방법 1: Claude Max 구독 → claude 명령어 설치');
    console.error('  방법 2: ANTHROPIC_API_KEY=sk-xxx node bin/vision-worker.js');
    process.exit(1);
  }
  console.log(`  모드: ${USE_CLI ? 'Claude CLI (Max 구독)' : 'API 키'}`);
  console.log(`  소스: ${SERVER_QUEUE_MODE ? '서버 큐 (/api/vision/queue)' : 'Google Drive'}`);
  if (CLAUDE_CLI) console.log(`  CLI: ${CLAUDE_CLI}`);
  console.log(`  서버: ${ORBIT_SERVER}`);
  console.log(`  폴링: ${(SERVER_QUEUE_MODE ? 30 : POLL_INTERVAL / 1000)}초`);

  if (SERVER_QUEUE_MODE) {
    // 서버 큐 모드: 30초마다 서버에서 이미지 가져와 CLI 분석
    const first = await processServerQueue();
    console.log(`[vision] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processServerQueue, 30 * 1000);
  } else {
    // Google Drive 모드
    if (!(await loadGoogleConfig())) { console.error('Google Drive 설정 실패'); process.exit(1); }
    console.log(`  폴더: ${_gFolder}`);
    const first = await processBatch();
    console.log(`[vision] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processBatch, POLL_INTERVAL);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
