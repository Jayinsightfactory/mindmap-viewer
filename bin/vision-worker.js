#!/usr/bin/env node
'use strict';
/**
 * vision-worker.js — Google Drive 캡처 Vision 분석 워커
 *
 * Google Drive "Orbit AI Captures" 폴더의 스크린샷을
 * Claude Vision API로 분석하여 서버에 결과 전송.
 *
 * 실행: ANTHROPIC_API_KEY=sk-xxx node bin/vision-worker.js
 * 또는: ANTHROPIC_API_KEY 환경변수 설정 후 실행
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://sparkling-determination-production-c88b.up.railway.app';
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

// ── Claude Vision API 분석 ────────────────────────────────────────────────────
async function visionAnalyze(base64, ctx) {
  const prompt = `이 스크린샷을 분석해주세요. 호스트: ${ctx.hostname}, 파일: ${ctx.name}

JSON으로 응답:
{
  "app": "프로그램명",
  "screen": "화면명/메뉴명",
  "elements": [{"type":"input|button|menu|table","label":"이름","position":"위치설명"}],
  "activity": "사용자 작업 1줄 설명",
  "dataVisible": "화면 데이터 종류 (개인정보 제외)",
  "automatable": true/false,
  "automationHint": "자동화 가능 부분",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타"
}`;

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
        try {
          const text = JSON.parse(d).content?.[0]?.text || '';
          const m = text.match(/\{[\s\S]*\}/);
          resolve(m ? JSON.parse(m[0]) : { raw:text.substring(0,200) });
        } catch(e) { reject(e); }
      });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

// ── 결과 서버 전송 ────────────────────────────────────────────────────────────
function sendToServer(cap, analysis) {
  const payload = JSON.stringify({ events:[{
    id:`vision-${Date.now()}-${cap.id.substring(0,6)}`, type:'screen.analyzed', source:'vision-worker',
    sessionId:`daemon-${cap.hostname}`, timestamp:cap.ts || new Date().toISOString(),
    data:{ fileId:cap.id, filename:cap.name, hostname:cap.hostname, ...analysis },
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
        console.log(`  → ${result.app}: ${result.activity?.substring(0,50)}`);
        await sendToServer(cap, result);
        await gApi('PATCH', `https://www.googleapis.com/drive/v3/files/${cap.id}`, token, { description:`analyzed:${new Date().toISOString()}` });
        done++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) { console.warn(`  실패: ${e.message}`); }
    }
    return done;
  } catch (e) { console.error('[vision] 에러:', e.message); return 0; }
}

async function main() {
  console.log('[vision-worker] Google Drive → Claude Vision 분석 워커');
  if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY 필요'); process.exit(1); }
  if (!(await loadGoogleConfig())) { console.error('Google Drive 설정 실패'); process.exit(1); }
  console.log(`  서버: ${ORBIT_SERVER}`);
  console.log(`  폴링: ${POLL_INTERVAL/1000}초`);
  console.log(`  폴더: ${_gFolder}`);

  const first = await processBatch();
  console.log(`[vision] 첫 배치: ${first}건`);
  setInterval(processBatch, POLL_INTERVAL);
}

main().catch(e => { console.error(e.message); process.exit(1); });
