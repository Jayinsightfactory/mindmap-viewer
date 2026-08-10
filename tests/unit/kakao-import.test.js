'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const createKakaoRouter = require('../../routes/kakao-decrypt');

async function request(server, { token, body }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, path: '/api/kakao/import', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('Kakao import', () => {
  let server;
  let db;

  beforeEach(async () => {
    db = { query: jest.fn(async sql => ({ rowCount: sql.includes('INSERT INTO kakao_messages') ? 1 : 0, rows: [] })) };
    const app = express();
    app.use(express.json());
    app.use('/api/kakao', createKakaoRouter({
      getDb: () => db,
      importTokenSha256: crypto.createHash('sha256').update('test-import-token').digest('hex'),
    }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('rejects unauthenticated imports', async () => {
    const response = await request(server, { body: { messages: [] } });
    expect(response.status).toBe(401);
  });

  test('stores the external id and uses an idempotent conflict clause', async () => {
    const response = await request(server, {
      token: 'test-import-token',
      body: { messages: [{ external_message_id: 'kakao-1', message: '한글 원문', created_at: '2026-08-10T09:30:00+09:00' }] },
    });
    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);
    const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO kakao_messages'));
    expect(insert[0]).toContain('ON CONFLICT (external_message_id)');
    expect(insert[1][0]).toBe('kakao-1');
    expect(insert[1][5]).toBe('한글 원문');
  });
});
