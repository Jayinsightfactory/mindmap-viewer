'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const createRouter = require('../../routes/messenger-intake');

function call(server, { method = 'POST', path = '/api/messenger/import', token, body }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, path, method,
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

const good = (over = {}) => ({
  external_message_id: 'wa-1', chatroom: '연습 농장 방', sender: '연습 발신자', message: 'practice text',
  created_at: '2026-11-23T09:30:00+09:00', ...over,
});

describe('Messenger intake (WeChat · WhatsApp)', () => {
  let server;
  let db;
  let seen;

  beforeEach(async () => {
    seen = new Set();
    db = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes('INSERT INTO messenger_messages')) {
          const key = `${params[0]}|${params[1]}`;
          if (seen.has(key)) return { rowCount: 0, rows: [] };
          seen.add(key);
          return { rowCount: 1, rows: [{ id: seen.size }] };
        }
        if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '0' }] };
        return { rowCount: 0, rows: [] };
      }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/messenger', createRouter({
      getDb: () => db,
      importTokenSha256: crypto.createHash('sha256').update('test-token').digest('hex'),
      adminOk: async req => (String(req.headers.authorization || '') === 'Bearer admin-token' ? 0 : 403),
    }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const inserts = () => db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messenger_messages'));

  test('rejects imports without the import token', async () => {
    const response = await call(server, { body: { channel: 'whatsapp', messages: [] } });
    expect(response.status).toBe(401);
    expect(inserts()).toHaveLength(0);
  });

  test('rejects unknown channels and oversized batches', async () => {
    const bad = await call(server, { token: 'test-token', body: { channel: 'kakao', messages: [] } });
    expect(bad.status).toBe(400);
    const big = await call(server, { token: 'test-token', body: { channel: 'wechat', messages: new Array(501).fill(good()) } });
    expect(big.status).toBe(413);
  });

  test('stores one message with the channel and an idempotent conflict clause', async () => {
    const response = await call(server, { token: 'test-token', body: { channel: 'whatsapp', messages: [good({ direction: 'in', collector: 'export-file' })] } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ imported: 1, skipped: 0, total: 1 });
    const [sql, row] = inserts()[0];
    expect(sql).toContain('ON CONFLICT (channel, external_message_id) DO NOTHING');
    expect(row[0]).toBe('whatsapp');
    expect(row[1]).toBe('wa-1');
    expect(row[5]).toBe('in');
    expect(row[9]).toBe('export-file');
    expect(row[10]).toBe('2026-11-23T00:30:00.000Z');
  });

  test('sending the same batch twice does not add rows, and imported + skipped always equals total', async () => {
    const body = { channel: 'wechat', messages: [good({ external_message_id: 'a' }), good({ external_message_id: 'b' })] };
    const first = await call(server, { token: 'test-token', body });
    const second = await call(server, { token: 'test-token', body });
    expect(first.body).toMatchObject({ imported: 2, skipped: 0 });
    expect(second.body).toMatchObject({ imported: 0, skipped: 2 });
    expect(second.body.imported + second.body.skipped).toBe(second.body.total);
  });

  test('the same id on another channel is a different message', async () => {
    await call(server, { token: 'test-token', body: { channel: 'wechat', messages: [good({ external_message_id: 'same' })] } });
    const other = await call(server, { token: 'test-token', body: { channel: 'whatsapp', messages: [good({ external_message_id: 'same' })] } });
    expect(other.body.imported).toBe(1);
  });

  test('skips rows without id, room, text or a time with an offset, and says why', async () => {
    const response = await call(server, {
      token: 'test-token',
      body: { channel: 'whatsapp', messages: [
        good({ external_message_id: '' }), good({ chatroom: ' ' }), good({ message: '' }),
        good({ created_at: '2026-11-23 09:30' }), good({ external_message_id: 'ok' }),
      ] },
    });
    expect(response.body).toMatchObject({ imported: 1, skipped: 4, total: 5 });
    expect(response.body.rejected).toEqual({ 'no-id': 1, 'no-room': 1, empty: 1, 'bad-time': 1 });
  });

  test('keeps only the last four digits when the sender is a phone number', async () => {
    await call(server, { token: 'test-token', body: { channel: 'whatsapp', messages: [good({ sender: '+00 123 456 7890' })] } });
    expect(inserts()[0][1][4]).toBe('번호끝7890');
    expect(createRouter.maskSender('Farm Practice 2')).toBe('Farm Practice 2');
  });

  test('an attachment without text is stored as an attachment line', async () => {
    await call(server, { token: 'test-token', body: { channel: 'wechat', messages: [good({ message: '', type: 'file', attachment_name: 'practice-invoice.pdf' })] } });
    const row = inserts()[0][1];
    expect(row[6]).toBe('[첨부] practice-invoice.pdf');
    expect(row[7]).toBe('file');
  });

  test('an admin token may import, a non-admin token may not', async () => {
    const admin = await call(server, { token: 'admin-token', body: { channel: 'whatsapp', messages: [good({ chatroom: 'TEST-practice' })] } });
    expect(admin.status).toBe(200);
    expect(admin.body.imported).toBe(1);
    const staff = await call(server, { token: 'orbit_staff-token', body: { channel: 'whatsapp', messages: [good()] } });
    expect(staff.status).toBe(401);
  });

  test('test-row cleanup is admin only and can only match rooms starting with TEST-', async () => {
    const denied = await call(server, { method: 'DELETE', path: '/api/messenger/test-rows', token: 'test-token' });
    expect(denied.status).toBe(401);
    const ok = await call(server, { method: 'DELETE', path: '/api/messenger/test-rows', token: 'admin-token' });
    expect(ok.status).toBe(200);
    const del = db.query.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM messenger_messages'));
    expect(del[0]).toBe("DELETE FROM messenger_messages WHERE chatroom LIKE 'TEST-%'");
    expect(del[1]).toBeUndefined();
  });

  test('the read endpoint validates channel and dates', async () => {
    const bad = await call(server, { method: 'GET', path: '/api/messenger/messages?channel=kakao' });
    expect(bad.status).toBe(400);
    const badDate = await call(server, { method: 'GET', path: '/api/messenger/messages?startDate=yesterday' });
    expect(badDate.status).toBe(400);
    const ok = await call(server, { method: 'GET', path: '/api/messenger/messages?channel=wechat&limit=5000' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, total: 0, limit: 1000, messages: [] });
  });
});
