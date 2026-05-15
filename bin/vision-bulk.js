#!/usr/bin/env node
'use strict';
/**
 * bin/vision-bulk.js — Drive 전체 캡처 일괄 Vision 분석
 *
 * 기존 vision-worker는 폴더당 10장/배치 5장 제한.
 * 이 스크립트는 Drive 전체 이미지를 페이지네이션으로 가져와 일괄 처리.
 *
 * 실행: GOOGLE_SERVICE_ACCOUNT_JSON=placeholder ORBIT_TOKEN=orbit_xxx node bin/vision-bulk.js
 * 옵션: --dry-run (다운로드 없이 개수만 확인)
 *       --limit=100 (최대 처리 건수)
 *       --hostname=NEONVA (특정 호스트만)
 *       --concurrency=3 (동시 처리 수, 기본 1)
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile, execSync } = require('child_process');

// ── 설정 ─────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).anthropicApiKey || ''; }
  catch { return ''; }
})();
const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).token || ''; }
  catch { return ''; }
})();

const CLAUDE_CLI = (() => {
  try { return execSync('which claude', { timeout: 3000 }).toString().trim().split('\n')[0]; }
  catch { return null; }
})();
const USE_CLI = !ANTHROPIC_KEY && !!CLAUDE_CLI;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1]) : Infinity;
})();
const FILTER_HOST = (() => {
  const a = process.argv.find(x => x.startsWith('--hostname='));
  return a ? a.split('=')[1] : null;
})();
const CONCURRENCY = (() => {
  const a = process.argv.find(x => x.startsWith('--concurrency='));
  return a ? parseInt(a.split('=')[1]) : 1;
})();
const DELAY_MS = 1500; // 분석 사이 딜레이 (API rate limit 방지)
const PAGE_SIZE = 100; // Drive API 페이지 크기

const TEMP_DIR = path.join(os.tmpdir(), 'orbit-vision-bulk');
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// ── Google 인증 ────────────────────────────────────────────────────────────────
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
          if (cfg.enabled) {
            let credStr = cfg.credentialsJson || '';
            try { _gCred = JSON.parse(credStr); }
            catch {
              credStr = credStr.replace(/\\\\n/g, '__ORBIT_NL__');
              credStr = credStr.replace(/\\n/g, '\n');
              credStr = credStr.replace(/__ORBIT_NL__/g, '\\n');
              _gCred = JSON.parse(credStr);
            }
            _gFolder = cfg.folderId;
          }
          resolve(cfg.enabled);
        } catch (e) { console.error('loadGoogleConfig 실패:', e.message); resolve(false); }
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
      headers:{ 'Authorization':`Bearer ${token}` }, timeout:60000 }, res => {
      const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('end', ()=>resolve(Buffer.concat(chunks).toString('base64')));
    }); req.on('error', reject); req.end();
  });
}

// ── Drive 전체 이미지 목록 (페이지네이션) ───────────────────────────────────────
async function findAllCaptures() {
  const token = await gToken();
  const allCaps = [];
  const hostFolderMap = {}; // folderId → hostname

  // 1단계: hostname 서브폴더 목록
  if (_gFolder) {
    console.log(`[bulk] Drive 폴더 스캔: ${_gFolder}`);
    try {
      const folders = await gApi('GET',
        `https://www.googleapis.com/drive/v3/files?q='${_gFolder}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&pageSize=50`,
        token);
      for (const f of (folders.files || [])) {
        if (FILTER_HOST && f.name !== FILTER_HOST) continue;
        hostFolderMap[f.id] = f.name;
        console.log(`  → 서브폴더: ${f.name} (${f.id})`);
      }
    } catch (e) { console.warn('서브폴더 스캔 실패:', e.message); }
  }

  // 2단계: 각 hostname 폴더에서 PNG 전체 수집 (페이지네이션)
  for (const [folderId, hostname] of Object.entries(hostFolderMap)) {
    let pageToken = null;
    let folderCount = 0;
    do {
      const pageParam = pageToken ? `&pageToken=${pageToken}` : '';
      const res = await gApi('GET',
        `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='image/png'+and+trashed=false&fields=files(id,name,description,createdTime),nextPageToken&orderBy=createdTime+asc&pageSize=${PAGE_SIZE}${pageParam}`,
        token);
      for (const img of (res.files || [])) {
        if (img.description?.includes('analyzed')) continue; // 이미 분석됨
        allCaps.push({ id:img.id, name:img.name, hostname, ts:img.createdTime });
        folderCount++;
      }
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    console.log(`  ${hostname}: 미분석 ${folderCount}건`);
  }

  // 3단계: 폴백 — 서브폴더 없으면 루트에서 검색
  if (!allCaps.length && !Object.keys(hostFolderMap).length) {
    console.log('[bulk] 폴백: 루트 Drive PNG 검색');
    let pageToken = null;
    do {
      const pageParam = pageToken ? `&pageToken=${pageToken}` : '';
      const res = await gApi('GET',
        `https://www.googleapis.com/drive/v3/files?q=mimeType='image/png'+and+trashed=false&fields=files(id,name,description,createdTime),nextPageToken&orderBy=createdTime+asc&pageSize=${PAGE_SIZE}${pageParam}`,
        token);
      for (const img of (res.files || [])) {
        if (img.description?.includes('analyzed')) continue;
        const m = img.name.match(/[-_]([A-Z][A-Z0-9\-]{4,})\.png$/i);
        const hostname = m?.[1] || 'unknown-host';
        if (FILTER_HOST && hostname !== FILTER_HOST) continue;
        allCaps.push({ id:img.id, name:img.name, hostname, ts:img.createdTime });
      }
      pageToken = res.nextPageToken || null;
    } while (pageToken);
  }

  return allCaps;
}

// ── 분석 프롬프트 ─────────────────────────────────────────────────────────────
function _buildPrompt(ctx) {
  return `스크린샷을 정밀 분석해주세요. 호스트: ${ctx.hostname}

다음 JSON 형식으로만 응답 (마크다운 없이 순수 JSON):
{
  "app": "실제 프로그램명",
  "screen": "현재 화면/메뉴명 (예: 신규주문등록, 카카오톡 호남소재 단톡방, ecount 매입/발주)",
  "activity": "사용자가 지금 하는 작업 1줄 (구체적으로)",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타",
  "visibleText": ["화면에 보이는 핵심 텍스트/숫자 최대 10개"],
  "url": "브라우저면 URL, 아니면 null",
  "excelSheet": "Excel이면 시트명, 아니면 null",
  "fields": [
    { "name": "필드명", "currentValue": "현재 값", "type": "input|button|dropdown|table|text" }
  ],
  "nenovaScreen": "nenova ERP 화면명 (해당없으면 null)",
  "ecountScreen": "ecount ERP 화면명 (해당없으면 null)",
  "automationScore": 0.0,
  "automatable": false,
  "automationHint": "자동화 방법 또는 null",
  "scriptType": "PAD|pyautogui|clipboard|none"
}`;
}

function _parseResult(text) {
  if (!text) return null;
  const block = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  let s = block ? block[1].trim() : text;
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  s = s
    .replace(/:\s*true\/false/g, ': true')
    .replace(/:\s*(\d+\.?\d*)~(\d+\.?\d*)/g, ': $1')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(s); } catch { return null; }
}

async function visionCli(base64, ctx) {
  const tmpFile = path.join(TEMP_DIR, `cap-${Date.now()}-${Math.random().toString(36).slice(2,6)}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
  const prompt = `${tmpFile} ${_buildPrompt(ctx)}`;
  return new Promise((resolve) => {
    execFile(CLAUDE_CLI, ['-p', prompt, '--allowedTools', 'Read', '--add-dir', TEMP_DIR],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) { console.warn(`  CLI 실패: ${err.message}`); resolve(null); return; }
      resolve(_parseResult(String(stdout)));
    });
  });
}

async function visionApi(base64, ctx) {
  const prompt = _buildPrompt(ctx);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
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

function _isValid(r) {
  return !!(r && (r.app || r.activity || r.screen));
}

async function visionAnalyze(base64, ctx) {
  const fn = USE_CLI ? visionCli : ANTHROPIC_KEY ? visionApi : null;
  if (!fn) throw new Error('Claude CLI 또는 ANTHROPIC_API_KEY 필요');
  let result = await fn(base64, ctx);
  if (_isValid(result)) return result;
  await new Promise(r => setTimeout(r, 3000));
  result = await fn(base64, ctx);
  return _isValid(result) ? result : null;
}

// ── 결과 서버 전송 ────────────────────────────────────────────────────────────
async function sendToServer(cap, analysis, base64) {
  const payload = JSON.stringify({ events:[{
    id: `bulk-${Date.now()}-${cap.id.substring(0,6)}`,
    type: 'screen.analyzed',
    source: 'vision-bulk',
    sessionId: `daemon-${cap.hostname}`,
    timestamp: cap.ts || new Date().toISOString(),
    data: {
      fileId: cap.id, filename: cap.name,
      hostname: cap.hostname,
      thumbnail: base64 ? base64.substring(0, 100000) : undefined,
      ...analysis,
    },
  }] });
  return new Promise(resolve => {
    const url = new URL('/api/hook', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) };
    if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.request({ hostname:url.hostname, port:url.port||443, path:url.pathname, method:'POST', headers:h, timeout:15000 }, res => {
      res.resume(); resolve(res.statusCode < 300);
    }); req.on('error', ()=>resolve(false)); req.write(payload); req.end();
  });
}

// ── Drive 파일 삭제 ───────────────────────────────────────────────────────────
async function deleteDriveFile(fileId, token) {
  try {
    await gApi('DELETE', `https://www.googleapis.com/drive/v3/files/${fileId}`, token, null);
    return true;
  } catch { return false; }
}

// ── 진행 상태 저장/로드 ────────────────────────────────────────────────────────
const PROGRESS_FILE = path.join(os.tmpdir(), 'orbit-vision-bulk-progress.json');

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { done: [], failed: [], total: 0, startedAt: new Date().toISOString() }; }
}

function saveProgress(p) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); } catch {}
}

// ── 단일 캡처 처리 ────────────────────────────────────────────────────────────
async function processOne(cap, token, stats) {
  try {
    const b64 = await gDownload(cap.id, token);
    if (!b64 || b64.length < 100) {
      console.warn(`  ✗ 빈파일 — 삭제: ${cap.name}`);
      await deleteDriveFile(cap.id, token);
      stats.skipped++;
      return false;
    }
    const result = await visionAnalyze(b64, cap);
    if (!result) {
      console.warn(`  ✗ 분석 실패: ${cap.name}`);
      stats.failed++;
      return false;
    }
    const ok = await sendToServer(cap, result, b64);
    if (!ok) {
      console.warn(`  ✗ 서버 전송 실패: ${cap.name}`);
      stats.failed++;
      return false;
    }
    // 분석 완료 → Drive 파일 삭제
    await deleteDriveFile(cap.id, token);
    stats.done++;
    return true;
  } catch (e) {
    console.warn(`  ✗ 오류: ${cap.name} — ${e.message}`);
    stats.failed++;
    return false;
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Orbit Vision Bulk Processor');
  console.log('═══════════════════════════════════════════════════════');

  if (!USE_CLI && !ANTHROPIC_KEY) {
    console.error('❌ Claude CLI 또는 ANTHROPIC_API_KEY 필요');
    process.exit(1);
  }
  console.log(`  분석 모드: ${USE_CLI ? 'Claude CLI (Max 구독)' : 'Anthropic API'}`);
  console.log(`  서버: ${ORBIT_SERVER}`);
  if (FILTER_HOST) console.log(`  호스트 필터: ${FILTER_HOST}`);
  if (LIMIT !== Infinity) console.log(`  최대 처리: ${LIMIT}건`);
  if (DRY_RUN) console.log('  ⚠️  DRY RUN 모드 (실제 처리 안 함)');
  console.log('');

  // Google Drive 설정 로드
  if (!(await loadGoogleConfig())) {
    console.error('❌ Google Drive 설정 실패 (GOOGLE_SERVICE_ACCOUNT_JSON 또는 서버 설정 확인)');
    process.exit(1);
  }
  console.log(`  Drive 폴더: ${_gFolder}`);

  // 전체 미분석 이미지 목록
  console.log('\n[1단계] Drive 전체 이미지 목록 조회 중...');
  const allCaps = await findAllCaptures();
  const caps = allCaps.slice(0, LIMIT === Infinity ? allCaps.length : LIMIT);

  console.log(`\n총 미분석: ${allCaps.length}건${LIMIT !== Infinity ? ` (처리 대상: ${caps.length}건)` : ''}`);

  // 호스트별 분포
  const byHost = {};
  for (const c of allCaps) { byHost[c.hostname] = (byHost[c.hostname] || 0) + 1; }
  for (const [h, cnt] of Object.entries(byHost)) {
    console.log(`  ${h}: ${cnt}건`);
  }

  if (DRY_RUN || !caps.length) {
    console.log('\nDRY RUN 완료 또는 처리 대상 없음.');
    return;
  }

  // 처리 시작
  console.log('\n[2단계] Vision 분석 시작...');
  const token = await gToken();
  const stats = { done: 0, failed: 0, skipped: 0, total: caps.length };
  const startAt = Date.now();

  // 순차 처리 (API rate limit 안전)
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    const eta = i > 0 ? Math.round((elapsed / i) * (caps.length - i)) : '?';
    process.stdout.write(`[${i+1}/${caps.length}] ${cap.hostname}/${cap.name.substring(0,30)} `);

    const ok = await processOne(cap, token, stats);
    const icon = ok ? '✓' : '✗';
    console.log(`${icon} (완료:${stats.done} 실패:${stats.failed} 경과:${elapsed}s ETA:${eta}s)`);

    if (ok) await new Promise(r => setTimeout(r, DELAY_MS));

    // 50건마다 토큰 갱신 확인
    if (i % 50 === 0 && i > 0) {
      await gToken(); // 자동 갱신 (만료 시)
    }
  }

  // 최종 리포트
  const totalSec = Math.round((Date.now() - startAt) / 1000);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  완료: ${stats.done}건 / 실패: ${stats.failed}건 / 스킵: ${stats.skipped}건`);
  console.log(`  소요 시간: ${Math.floor(totalSec/60)}분 ${totalSec%60}초`);
  console.log(`  평균: ${stats.done > 0 ? Math.round(totalSec/stats.done) : '-'}초/건`);
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
