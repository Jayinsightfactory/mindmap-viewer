'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const createKakaoRouter = require('../../routes/kakao-decrypt');

async function request(server, { method = 'POST', path = '/api/kakao/import', token, body }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const headers = {
      ...(body !== undefined
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(payload);
    else req.end();
  });
}

describe('Kakao import & incremental order_parsed API', () => {
  let server;
  let db;

  beforeEach(async () => {
    db = {
      query: jest.fn(async sql => {
        if (sql.includes('INSERT INTO kakao_messages')) return { rowCount: 1, rows: [] };
        if (sql.includes('UPDATE kakao_messages')) return { rowCount: 1, rows: [] };
        if (sql.includes('SELECT COUNT(*) as total FROM kakao_messages')) return { rowCount: 1, rows: [{ total: '1' }] };
        if (sql.includes('SELECT COUNT(*) AS remaining')) return { rowCount: 1, rows: [{ remaining: '1' }] };
        return { rowCount: 0, rows: [] };
      }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/kakao', createKakaoRouter({
      getDb: () => db,
      importTokenSha256: crypto.createHash('sha256').update('test-import-token').digest('hex'),
      authenticateAdmin: async rawToken => {
        if (rawToken === 'test-admin-token') return { ok: true, status: 200 };
        if (rawToken === 'employee-daemon-token') return { ok: false, status: 403 };
        return { ok: false, status: 401 };
      },
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
    const alterCalls = db.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(alterCalls).toContain('ADD COLUMN IF NOT EXISTS order_parsed JSONB DEFAULT NULL');
    expect(alterCalls).toContain('ADD COLUMN IF NOT EXISTS order_parsed_at TIMESTAMPTZ DEFAULT NULL');
    expect(alterCalls).toContain('ADD COLUMN IF NOT EXISTS order_parser_version SMALLINT DEFAULT NULL');
  });

  test('GET /api/kakao/messages includes order_parsed columns while preserving existing fields', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('SELECT COUNT(*) as total')) return { rows: [{ total: '1' }] };
      if (sql.includes('SELECT id, external_message_id')) {
        return {
          rows: [{
            id: 42,
            external_message_id: 'ext-42',
            chat_id: 'room-1',
            chatroom: '수입방',
            user_id: null,
            sender: '담당자',
            message: '49차 수국 버건디 10박스 추가',
            message_type: 'text',
            source: 'nenovakakao',
            created_at: '2026-11-25T05:00:00.000Z',
            timestamp_approximate: false,
            order_parsed: { kind: 'addition', provider: 'claude-sub', items: [{ product: '버건디', quantity: 10, unit: '박스' }] },
            order_parsed_at: '2026-11-25T05:01:00.000Z',
            order_parser_version: 1,
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await request(server, {
      method: 'GET',
      path: '/api/kakao/messages?chatroom=%EC%88%98%EC%9E%85%EB%B0%A9&limit=5',
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.messages).toHaveLength(1);
    expect(response.body.messages[0].order_parsed).toEqual({
      kind: 'addition',
      provider: 'claude-sub',
      items: [{ product: '버건디', quantity: 10, unit: '박스' }],
    });
    expect(response.body.messages[0].order_parser_version).toBe(1);
    const selectCall = db.query.mock.calls.find(([sql]) => sql.includes('ORDER BY created_at DESC'));
    expect(selectCall[0]).toContain('order_parsed, order_parsed_at, order_parser_version');
  });

  test('GET /api/kakao/messages/unparsed-orders enforces admin/worker auth and omits sender/user_id', async () => {
    const unauth = await request(server, { method: 'GET', path: '/api/kakao/messages/unparsed-orders' });
    expect(unauth.status).toBe(401);

    const nonAdmin = await request(server, {
      method: 'GET',
      path: '/api/kakao/messages/unparsed-orders',
      token: 'employee-daemon-token',
    });
    expect(nonAdmin.status).toBe(403);

    const badRoom = await request(server, {
      method: 'GET',
      path: '/api/kakao/messages/unparsed-orders?chatroom=%EC%98%81%EC%97%85%EB%B0%A9',
      token: 'test-admin-token',
    });
    expect(badRoom.status).toBe(400);

    db.query.mockImplementation(async sql => {
      if (sql.includes('ORDER BY created_at ASC, id ASC')) {
        return {
          rows: [{
            id: 101,
            external_message_id: 'ext-101',
            chatroom: '수입방',
            sender: '비노출발신자',
            user_id: 'secret-user',
            message: '[콜롬비아] 안티오퀴아 버건디 10박스 추가',
            message_type: 'text',
            source: 'nenovakakao',
            created_at: '2026-11-25T05:10:00.000Z',
            timestamp_approximate: false,
            order_parser_version: null,
          }],
        };
      }
      if (sql.includes('SELECT COUNT(*) AS remaining')) return { rows: [{ remaining: '3' }] };
      if (sql.includes('AND NOT (id = ANY(')) {
        return {
          rows: [{
            id: 100,
            external_message_id: 'ext-100',
            chatroom: '수입방',
            sender: '이전발신자',
            message: '49차 콜롬비아 수국 발주 시작합니다',
            message_type: 'text',
            source: 'nenovakakao',
            created_at: '2026-11-25T05:05:00.000Z',
            order_parsed: { kind: 'cleaned', cleanReason: '안내 문구' },
            order_parser_version: 1,
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const okRes = await request(server, {
      method: 'GET',
      path: '/api/kakao/messages/unparsed-orders?days=14&limit=15&parserVersion=1&contextCount=5',
      token: 'test-admin-token',
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    expect(okRes.body.remainingTotal).toBe(3);
    expect(okRes.body.messages).toHaveLength(1);
    expect(okRes.body.messages[0].sender).toBeUndefined();
    expect(okRes.body.messages[0].user_id).toBeUndefined();
    expect(okRes.body.contextMessages).toHaveLength(1);
    expect(okRes.body.contextMessages[0].sender).toBeUndefined();
  });

  test('POST /api/kakao/messages/order-parsed validates payload, strips NUL, and saves batch', async () => {
    const forbidden = await request(server, {
      method: 'POST',
      path: '/api/kakao/messages/order-parsed',
      token: 'employee-daemon-token',
      body: [{ id: 101, order_parsed: { kind: 'cleaned' }, parser_version: 1 }],
    });
    expect(forbidden.status).toBe(403);

    const saved = await request(server, {
      method: 'POST',
      path: '/api/kakao/messages/order-parsed',
      token: 'test-admin-token',
      body: [
        {
          id: 101,
          parser_version: 1,
          order_parsed: {
            kind: 'addition',
            provider: 'claude-sub',
            country: '콜롬비아',
            week: '49',
            farm: '안티오퀴아',
            items: [{ product: '버건디\u0000', quantity: 10, unit: '박스' }],
          },
        },
        {
          id: 102,
          order_parsed: { kind: 'invalid_kind' },
        },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, updated: 1, skipped: 1, total: 2 });

    const updateCall = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE kakao_messages'));
    expect(updateCall[1][0]).not.toContain('\u0000');
    expect(updateCall[1][1]).toBe(1);
    expect(updateCall[1][2]).toBe(101);
  });
});
