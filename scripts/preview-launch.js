/**
 * preview-launch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude Code 프리뷰 디스패처 — 포트 4747에서 무엇을 띄울지 자동 결정.
 *
 *   배포웹(Railway)에 도달 가능  → preview-proxy.js  (배포 사이트 중계)
 *   도달 불가(허용목록 미설정)   → server.js         (현재 브랜치 로컬 서버)
 *
 * 이렇게 하면 사용자는 launch.json 구성을 고를 필요 없이, claude.ai 환경설정에서
 * Railway 도메인을 네트워크 허용목록에 추가하고 세션을 재시작하기만 하면
 * 프리뷰가 자동으로 "배포웹"으로 전환된다. 그 전까지는 로컬 프리뷰가 동작한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const TARGET_HOST = process.env.PREVIEW_TARGET_HOST
  || 'mindmap-viewer-production-adb2.up.railway.app';

// 배포웹에 실제로 도달 가능한지 확인 (샌드박스 허용목록은 403 "Host not in allowlist")
function checkDeployedReachable() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: TARGET_HOST, port: 443, path: '/health', method: 'GET', timeout: 6000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const blocked = res.statusCode === 403 && /allowlist/i.test(body);
        resolve(!blocked);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

(async () => {
  const reachable = await checkDeployedReachable();
  const script = reachable
    ? path.join(__dirname, 'preview-proxy.js')
    : path.join(__dirname, '..', 'server.js');

  if (reachable) {
    console.log(`[preview-launch] 배포웹(${TARGET_HOST}) 도달 가능 → 프록시 모드`);
  } else {
    console.log('[preview-launch] 배포웹 차단됨(네트워크 허용목록 미설정) → 로컬 서버 모드');
    process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  }

  const child = spawn(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
})();
