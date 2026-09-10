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
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=1`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=0&afterKey=external-a`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterKey=%00unsafe`,
      `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=201`,
    ];
    for (const path of cases) {
      const response = await request(server, path);
      expect(response.status).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('uses fixed predicates and external-message keyset paging while preserving contract fields', async () => {
    db.query.mockResolvedValueOnce({ rows: [message(10), message(11, true), message(12)] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ ok: true, hasMore: true, nextAfterKey: 'external-11', nextAfterId: null });
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[1].timestamp_approximate).toBe(true);
    expect(response.body.messages[0]).toEqual(message(10));
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('chat_id = $1');
    expect(sql).toContain('chatroom = $2');
    expect(sql).toContain('source = $3');
    expect(sql).toContain('created_at >= $4');
    expect(sql).toContain('created_at < $5');
    expect(sql).toContain('external_message_id COLLATE "C" > $6::text COLLATE "C"');
    expect(sql).toContain('ORDER BY external_message_id COLLATE "C" ASC');
    expect(sql).not.toContain('id > $6');
    expect(params).toEqual(['sales-room-id', '영업방', 'nenovakakao', FROM, TO, '', 3]);
  });

  test('passes the last returned external message key back as the next keyset cursor', async () => {
    db.query.mockResolvedValueOnce({ rows: [message(12)] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterKey=external-11&limit=2`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ hasMore: false, nextAfterKey: 'external-12', nextAfterId: null });
    expect(db.query.mock.calls[0][1][5]).toBe('external-11');
  });

  test('paginates null legacy ids with same timestamps by external message key', async () => {
    const first = { ...message(null), external_message_id: 'external-a', created_at: '2026-08-10T09:30:00+09:00' };
    const second = { ...message(null), external_message_id: 'external-b', created_at: '2026-08-10T09:30:00+09:00' };
    db.query.mockResolvedValueOnce({ rows: [first, second] }).mockResolvedValueOnce({ rows: [second] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterId=0&limit=1`);

    expect(response.status).toBe(200);
    expect(response.body.messages).toEqual([first]);
    expect(response.body).toMatchObject({ hasMore: true, nextAfterKey: 'external-a', nextAfterId: null });
    expect(db.query.mock.calls[0][1][5]).toBe('');

    const secondPage = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&afterKey=external-a&limit=1`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.messages).toEqual([second]);
    expect(secondPage.body).toMatchObject({ hasMore: false, nextAfterKey: 'external-b', nextAfterId: null });
    expect(db.query.mock.calls[1][1][5]).toBe('external-a');
  });

  test('returns 500 instead of silently treating malformed external keys as an empty page', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...message(null), external_message_id: null }] });
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/invalid external message key/);
  });

  test('applies the same maximum length and control-character rules to returned keys', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...message(null), external_message_id: 'x'.repeat(513) }] })
      .mockResolvedValueOnce({ rows: [{ ...message(null), external_message_id: 'external\u0080key' }] });
    await startRouter();
    for (const suffix of ['', '&afterKey=external-a']) {
      const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}${suffix}`);
      expect(response.status).toBe(500);
      expect(response.body.error).toMatch(/invalid external message key/);
    }
  });

  test('returns 500 when the database adapter violates the result.rows contract', async () => {
    db.query.mockResolvedValueOnce([]);
    await startRouter();
    const response = await request(server, `/api/kakao/nenova-sales-feed?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/Internal server error/);
  });
});
