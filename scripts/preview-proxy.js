/**
 * preview-proxy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude Code 프리뷰 패널용 리버스 프록시.
 *
 * launch.json의 프리뷰는 "로컬 서버 + 포트"만 지원하고 외부 URL을 직접
 * 가리킬 수 없다. 이 스크립트는 로컬 포트(기본 4747)에서 들어오는 모든 요청을
 * 배포된 Railway 사이트로 그대로 중계한다 → 프리뷰 패널에 "배포웹"이 보인다.
 *
 *   프리뷰 패널 → localhost:4747 → (이 프록시) → https://<RAILWAY_HOST>
 *
 * 의존성 없음(Node 코어 http/https만 사용). WebSocket 업그레이드도 중계한다.
 * 포트가 이미 사용 중이면(다른 인스턴스가 떠 있으면) 조용히 종료한다(멱등).
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const http  = require('http');
const https = require('https');

const TARGET_HOST = process.env.PREVIEW_TARGET_HOST
  || 'mindmap-viewer-production-adb2.up.railway.app';
const PORT = parseInt(process.env.PORT || '4747', 10);

function buildHeaders(src) {
  // host 헤더를 타깃으로 교체 — Railway가 올바른 서비스로 라우팅하도록
  const h = Object.assign({}, src, { host: TARGET_HOST });
  delete h['accept-encoding']; // 응답을 그대로 파이프하기 위해 압축 협상 제거
  return h;
}

const server = http.createServer((req, res) => {
  const proxyReq = https.request({
    hostname: TARGET_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: buildHeaders(req.headers),
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('preview-proxy 오류: ' + err.message);
  });
  req.pipe(proxyReq);
});

// WebSocket 업그레이드 중계 (orbit3d 실시간 그래프 등)
server.on('upgrade', (req, socket, head) => {
  const proxyReq = https.request({
    hostname: TARGET_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: buildHeaders(req.headers),
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    const statusLine = 'HTTP/1.1 101 Switching Protocols';
    const headerLines = Object.entries(proxyRes.headers)
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    socket.write(`${statusLine}\r\n${headerLines}\r\n\r\n`);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 이미 다른 인스턴스가 포트를 잡고 있음 — 정상으로 간주하고 종료
    console.log(`[preview-proxy] 포트 ${PORT} 이미 사용 중 — 기존 인스턴스 재사용, 종료`);
    process.exit(0);
  }
  console.error('[preview-proxy] 서버 오류:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[preview-proxy] localhost:${PORT} → https://${TARGET_HOST}`);
});
