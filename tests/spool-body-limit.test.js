// 화면 스풀 업로드 경로만 큰 본문(8MB)을 받고, 나머지는 2MB 한도를 유지하는지 확인한다.
// server.js 와 같은 순서(경로 전용 파서 → 전역 파서)로 미들웨어를 쌓아 검증하고,
// server.js 에 그 순서가 실제로 있는지도 본다.
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

function post(port, urlPath, bytes) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ userId: 'T', imageBase64: 'A'.repeat(bytes) });
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

describe('스풀 업로드 본문 한도', () => {
  let server, port;
  beforeAll((done) => {
    const app = express();
    app.post('/api/vision/spool', express.json({ limit: '8mb' }));
    app.use(express.json({ limit: '2mb' }));
    app.post('/api/vision/spool', (req, res) => res.json({ n: req.body.imageBase64.length }));
    app.post('/api/other', (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => res.status(err.status || 500).end());
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(() => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); });

  test('스풀: 3MB·6.7MB(PNG 5MB 상당) 본문을 받는다', async () => {
    expect(await post(port, '/api/vision/spool', 3 * 1024 * 1024)).toBe(200);
    expect(await post(port, '/api/vision/spool', 6.7 * 1024 * 1024 | 0)).toBe(200);
  });
  test('스풀: 8MB 넘으면 거절한다', async () => {
    expect(await post(port, '/api/vision/spool', 9 * 1024 * 1024)).toBe(413);
  });
  test('다른 경로는 2MB 한도 그대로', async () => {
    expect(await post(port, '/api/other', 3 * 1024 * 1024)).toBe(413);
    expect(await post(port, '/api/other', 1024 * 1024)).toBe(200);
  });
  test('server.js: 스풀 전용 파서가 전역 파서보다 먼저 등록돼 있다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const spool = src.indexOf("app.post('/api/vision/spool', express.json({ limit: '8mb' }))");
    const global2 = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(spool).toBeGreaterThan(-1);
    expect(global2).toBeGreaterThan(spool);
  });
});
