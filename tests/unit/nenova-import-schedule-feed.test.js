'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const createKakaoRouter = require('../../routes/kakao-decrypt');

const TOKEN = 'test-sales-read-token';
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const FROM = '2026-08-10T00:00:00+09:00';
const TO = '2026-08-11T00:00:00+09:00';
const ROOMS = ['스케줄방', '빌번호방', '네노바&선율방'];
const PATH = '/api/kakao/nenova-import-schedule-feed';

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

function message(id, room = '스케줄방') {
  return {
    id,
    external_message_id: `external-${id}`,
    chat_id: 'schedule-room-id',
    chatroom: room,
    sender: '수입 담당자',
    message: `원문 ${id}`,
    message_type: 'text',
    source: 'nenovakakao',
    created_at: '2026-08-10T00:00:00+09:00',
    imported_at: '2026-08-10T03:00:00+09:00',
    timestamp_approximate: false,
  };
}

describe('Nenova import schedule feed', () => {
  let server;
  let db;
  let roomQuery;
  const q = (room, extra = '') => `${PATH}?room=${encodeURIComponent(room)}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}${extra}`;

  async function startRouter(options = {}) {
    const app = express();
    app.use('/api/kakao', createKakaoRouter({
      getDb: () => ({ query: (sql, params) => sql.startsWith('SELECT DISTINCT chat_id') ? roomQuery(sql, params) : db.query(sql, params) }),
      salesReadTokenSha256: TOKEN_HASH,
      ...options,
    }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
  }

  beforeEach(() => {
    db = { query: jest.fn(async () => ({ rows: [] })) };
    roomQuery = jest.fn(async () => ({ rows: [{ chat_id: 'schedule-room-id' }] }));
  });

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null;
  });

  test('503 when token hash is not configured', async () => {
    await startRouter({ salesReadTokenSha256: '' });
    const response = await request(server, q('스케줄방'));
    expect(response.status).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
    expect(roomQuery).not.toHaveBeenCalled();
  });

  test('401 for missing or wrong token', async () => {
    await startRouter();
    expect((await request(server, q('스케줄방'), 'wrong-token')).status).toBe(401);
    expect((await request(server, q('스케줄방'), '')).status).toBe(401);
    expect(roomQuery).not.toHaveBeenCalled();
  });

  test('400 when room is missing or not one of the three fixed rooms', async () => {
    await startRouter();
    const noRoom = await request(server, `${PATH}?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    expect(noRoom.status).toBe(400);
    expect(noRoom.body.error).toBe('room must be one of the fixed import schedule rooms');
    for (const room of ['현장 추가취소방', '다른방', '']) {
      const response = await request(server, q(room));
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('room must be one of the fixed import schedule rooms');
    }
    expect(roomQuery).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 Room selection is fixed for chat_id / chatroom / foreign source', async () => {
    await startRouter();
    for (const suffix of ['&chat_id=x', '&chatroom=x', '&source=other']) {
      const response = await request(server, q('스케줄방', suffix));
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Room selection is fixed');
    }
    expect((await request(server, q('스케줄방', '&source=nenovakakao'))).status).toBe(200);
  });

  test.each(ROOMS)('200 for room %s and passes that room name to SQL', async room => {
    db.query.mockResolvedValueOnce({ rows: [message(1, room)] });
    await startRouter();
    const response = await request(server, q(room));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ ok: true, hasMore: false, nextAfterKey: 'external-1', nextAfterId: null });
    expect(roomQuery).toHaveBeenCalledWith('SELECT DISTINCT chat_id FROM kakao_messages WHERE chatroom = $1 AND source = $2 LIMIT 2', [room, 'nenovakakao']);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('ORDER BY external_message_id COLLATE "C" ASC');
    expect(params).toEqual(['schedule-room-id', room, 'nenovakakao', FROM, TO, '', 101]);
  });

  test('503 when chat_id is missing, ambiguous, or malformed', async () => {
    await startRouter();
    for (const rows of [[], [{ chat_id: 'one' }, { chat_id: 'two' }], [{ chat_id: null }]]) {
      roomQuery.mockResolvedValueOnce({ rows });
      const response = await request(server, q('빌번호방'));
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Nenova import schedule room is unavailable or ambiguous');
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 for period over 7 days, limit 201, bad afterKey', async () => {
    await startRouter();
    const cases = [
      `${PATH}?room=${encodeURIComponent('스케줄방')}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent('2026-08-18T00:00:01+09:00')}`,
      q('스케줄방', '&limit=201'),
      q('스케줄방', '&afterKey=%00unsafe'),
    ];
    for (const path of cases) expect((await request(server, path)).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('pagination returns hasMore and nextAfterKey, passes cursor back', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [message(10), message(11), message(12)] })
      .mockResolvedValueOnce({ rows: [message(12)] });
    await startRouter();
    const first = await request(server, q('스케줄방', '&limit=2'));
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(2);
    expect(first.body).toMatchObject({ hasMore: true, nextAfterKey: 'external-11', nextAfterId: null });
    const second = await request(server, q('스케줄방', '&limit=2&afterKey=external-11'));
    expect(second.body).toMatchObject({ hasMore: false, nextAfterKey: 'external-12' });
    expect(db.query.mock.calls[1][1][5]).toBe('external-11');
  });

  test('500 when the database throws', async () => {
    db.query.mockRejectedValueOnce(new Error('boom'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await startRouter();
    const response = await request(server, q('스케줄방'));
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Internal server error');
    expect(spy).toHaveBeenCalledWith('[NenovaImportScheduleFeed] read failed');
    spy.mockRestore();
  });
});
