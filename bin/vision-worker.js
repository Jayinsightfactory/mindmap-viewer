#!/usr/bin/env node
'use strict';
/**
 * vision-worker.js — 관리자 PC에서 실행하는 Vision 분석 워커
 *
 * 서버에서 대기 중인 캡처를 가져와서 Claude CLI(구독)로 분석 후 결과 전송.
 * API 키 불필요 — Claude Code 구독 세션 사용.
 *
 * 실행: node bin/vision-worker.js
 * 중지: Ctrl+C
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const SERVER = process.env.ORBIT_SERVER_URL || 'https://sparkling-determination-production-c88b.up.railway.app';
const TOKEN = process.env.ORBIT_TOKEN || (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).token || '';
  } catch { return ''; }
})();

const POLL_INTERVAL = 15000; // 15초마다 큐 확인
const TEMP_DIR = path.join(os.tmpdir(), 'orbit-vision');

// Claude CLI 찾기
function findClaude() {
  try {
    const { execSync } = require('child_process');
    return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 })
      .toString().trim().split('\n')[0];
  } catch { return null; }
}

const CLAUDE = findClaude();
if (!CLAUDE) {
  console.error('[vision-worker] Claude CLI를 찾을 수 없습니다. Claude Code를 먼저 설치하세요.');
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log(`[vision-worker] 시작`);
console.log(`  서버: ${SERVER}`);
console.log(`  Claude: ${CLAUDE}`);
console.log(`  폴링: ${POLL_INTERVAL / 1000}초`);
console.log('');

function fetchJson(urlPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers,
      timeout: 30000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function analyzeCapture(item) {
  // base64 → 임시 PNG
  const tmpFile = path.join(TEMP_DIR, `capture-${item.id}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(item.imageBase64, 'base64'));

  const prompt = `스크린샷 분석. 앱:${item.app || '?'} 윈도우:${item.windowTitle || '?'}
호스트: ${item.hostname || '?'}
JSON: {"activity":"작업유형(코딩/문서작성/스프레드시트/프레젠테이션/웹검색/디자인/커뮤니케이션/데이터분석/ERP/전산/기타)","app":"앱이름","description":"뭘 하고 있는지 1줄 (구체적으로)","details":"상세 2줄 (셀주소/메뉴/입력내용 등)","changeType":"변경유형","automatable":true/false,"automatableReason":"자동화 가능 이유"}`;

  return new Promise((resolve) => {
    execFile(CLAUDE, ['-p', prompt, tmpFile], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      // 임시 파일 삭제
      try { fs.unlinkSync(tmpFile); } catch {}

      if (err) { console.warn(`  분석 실패: ${err.message}`); resolve(null); return; }
      try {
        const text = String(stdout);
        const m = text.match(/\{[\s\S]*\}/);
        resolve(m ? JSON.parse(m[0]) : null);
      } catch { resolve(null); }
    });
  });
}

async function pollAndProcess() {
  try {
    const data = await fetchJson('/api/vision/queue');
    if (!data?.batch?.length) return;

    console.log(`[vision-worker] ${data.batch.length}건 분석 시작 (대기: ${data.pending}건)`);

    for (const item of data.batch) {
      console.log(`  분석 중: ${item.hostname} / ${item.app} / ${item.windowTitle?.slice(0, 30)}`);
      const analysis = await analyzeCapture(item);

      if (analysis) {
        console.log(`  결과: ${analysis.activity} — ${analysis.description}`);
        // 서버로 결과 전송
        await fetchJson('/api/vision/result', 'POST', JSON.stringify({
          captureId: item.id,
          sessionId: item.sessionId,
          userId: item.userId,
          analysis: {
            ...analysis,
            trigger: item.trigger,
            hostname: item.hostname,
            app: item.app,
            windowTitle: item.windowTitle,
          },
        }));
      } else {
        console.log(`  분석 실패 — 건너뜀`);
      }
    }
  } catch (e) {
    console.warn(`[vision-worker] 에러: ${e.message}`);
  }
}

// 폴링 루프
setInterval(pollAndProcess, POLL_INTERVAL);
pollAndProcess(); // 즉시 첫 실행

console.log('[vision-worker] 실행 중 (Ctrl+C로 중지)');
