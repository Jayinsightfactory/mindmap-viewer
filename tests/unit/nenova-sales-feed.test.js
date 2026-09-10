'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const createKakaoRouter = require('../../routes/kakao-decrypt');

const TOKEN = 'test-sales-read-token';
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const FROM = '2026-08-10T00:00:00+09:00';
const TO = '2026-08-11T00:00:00+09:00';

async function request(server, path, token = TOKEN) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function message(id, timestampApproximate = false) {
  return {
    id,
    external_message_id: `external-${id}`,
    chat_id: 'sales-room-id',
    chatroom: '영업방',
    sender: '영업 담당자',
    message: `원문 ${id}`,
    message_type: 'text',
    source: 'nenovakakao',
    created_at: '2026-08-10T00:00:00+09:00',
    imported_at: '2026-08-10T03:00:00+09:00',
    timestamp_approximate: timestampApproximate,
  };
}

describe('Nenova sales feed', () => {
  let server;
  let db;

  async function startRouter(options = {}) {
    const app = express();
    app.use('/api/kakao', createKakaoRouter({
      getDb: () => db,
      salesReadTokenSha256: TOKEN_HASH,
      salesRoomId: 'sales-room-id',
      ...options,
    }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
  }

  beforeEach(() => {
    db = { query: jest.fn(async () => ({ rows: [] })) };
  });

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null;
  });

  test('returns 503 before database access when dedicated configuration is missing', async () => {
    await startRouter({ salesReadTokenSha256: '', salesRoomId: '' });
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    expect(response.status).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('requires the dedicated read token', async () => {
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, 'wrong-token');
    expect(response.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('rejects room overrides, non-timezone dates, excessive periods, and unsafe cursors', async () => {
    await startRouter();
    const cases = [
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&chatroom=${encodeURIComponent('다른방')}`,
      `/api/kakao/nenova-sales-feed?from=2026-08-10T00:00:00&to=${encodeURIComponent(TO)}`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent('2026-08-18T00:00:01+09:00')}`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=-1`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=0%3BDROP%20TABLE%20kakao_messages`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=201`,
    ];
    for (const path of cases) {
      const response = await request(server, path);
      expect(response.status).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('uses fixed predicates and keyset paging while preserving contract fields', async () => {
    db.query.mockResolvedValueOnce({ rows: [message(10), message(11, true), message(12)] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ ok: true, hasMore: true, nextAfterId: 11 });
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[1].timestamp_approximate).toBe(true);
    expect(response.body.messages[0]).toEqual(message(10));
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('chat_id = $1');
    expect(sql).toContain('chatroom = $2');
    expect(sql).toContain('source = $3');
    expect(sql).toContain('created_at >= $4');
    expect(sql).toContain('created_at < $5');
    expect(sql).toContain('id > $6');
    expect(sql).toContain('ORDER BY id ASC');
    expect(params).toEqual(['sales-room-id', '영업방', 'nenovakakao', FROM, TO, 0, 3]);
  });

  test('passes the last returned id back as the next keyset cursor', async () => {
    db.query.mockResolvedValueOnce({ rows: [message(12)] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=11&limit=2`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ hasMore: false, nextAfterId: 12 });
    expect(db.query.mock.calls[0][1][5]).toBe(11);
  });
});
