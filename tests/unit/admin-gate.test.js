'use strict';

/**
 * admin-gate.test.js — 관리자 전용 주소의 자격 확인(src/admin-gate.js)
 *
 * 2026-11-28 보안 수정 검증: 카톡 조회 주소(/api/admin/kakao-intel, /api/kakao/chatrooms, /api/kakao/stats)가
 * 인증 없이 열려 있던 문제. 썸네일 보호와 같은 규칙을 쓰는지, 자격이 없으면 자료를 아예 읽지 않는지 본다.
 */

const express = require('express');
const http = require('http');
const createAdminGate = require('../../src/admin-gate');
const createKakaoRouter = require('../../routes/kakao-decrypt');

const MASTER = 'master-token';
const ADMIN_TOKEN = 'admin-api-token';
const ADMIN_USER = 'admin-user-token';
const EMPLOYEE_USER = 'employee-user-token';
const JUNK = 'junk-token';

function makeGate() {
  return createAdminGate({
    isMasterToken: (t) => t === MASTER,
    isAdminToken: (t) => t === ADMIN_TOKEN,
    isAdminReqAsync: async (req) => {
      const raw = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
      return raw === ADMIN_USER;
    },
  });
}

function request(server, { path = '/', headers = {} } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startApp(build) {
  const app = express();
  build(app);
  const server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

function stopApp(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('admin-gate.check', () => {
  let gate;
  beforeEach(() => { gate = makeGate(); });

  test('토큰이 없으면 401 (주소만 알면 못 들어간다)', async () => {
    expect(await gate.check({ headers: {}, query: {} })).toBe(401);
  });

  test('모르는 토큰은 403', async () => {
    expect(await gate.check({ headers: { authorization: 'Bearer ' + JUNK }, query: {} })).toBe(403);
  });

  test('관리자 API 토큰은 통과', async () => {
    expect(await gate.check({ headers: { authorization: 'Bearer ' + ADMIN_TOKEN }, query: {} })).toBe(0);
  });

  test('마스터 토큰은 통과', async () => {
    expect(await gate.check({ headers: { authorization: 'Bearer ' + MASTER }, query: {} })).toBe(0);
  });

  test('관리자 이메일 사용자 토큰은 통과', async () => {
    expect(await gate.check({ headers: { authorization: 'Bearer ' + ADMIN_USER }, query: {} })).toBe(0);
  });

  test('일반 직원 토큰은 403', async () => {
    expect(await gate.check({ headers: { authorization: 'Bearer ' + EMPLOYEE_USER }, query: {} })).toBe(403);
  });

  test('?token= 으로 온 토큰도 같은 규칙으로 본다(기존 <img>·링크 호출 유지)', async () => {
    expect(await gate.check({ headers: {}, query: { token: ADMIN_TOKEN } })).toBe(0);
    expect(await gate.check({ headers: {}, query: { token: EMPLOYEE_USER } })).toBe(403);
  });

  test('자격 판단이 예외로 깨져도 통과하지 않고 403', async () => {
    const broken = createAdminGate({
      isMasterToken: () => { throw new Error('boom'); },
      isAdminToken: () => { throw new Error('boom'); },
      isAdminReqAsync: async () => { throw new Error('boom'); },
    });
    expect(await broken.check({ headers: { authorization: 'Bearer anything' }, query: {} })).toBe(403);
  });

  test('Bearer 자리에 빈 값이 오면 401 (빈 토큰 통과 없음)', async () => {
    const empty = createAdminGate({ isMasterToken: () => true, isAdminToken: () => true, isAdminReqAsync: async () => true });
    expect(await empty.check({ headers: { authorization: 'Bearer   ' }, query: {} })).toBe(401);
  });
});

describe('카톡 조회 주소 잠금 (실제 라우터)', () => {
  let server;
  let queried;

  beforeEach(async () => {
    queried = [];
    const db = {
      query: async (sql) => {
        queried.push(sql);
        if (sql.includes('GROUP BY chatroom')) return { rows: [{ chatroom: '수입 1팀', message_count: '3' }] };
        return { rows: [] };
      },
    };
    const gate = makeGate();
    // server.js 와 같은 배치: 라우터를 붙이기 전에 같은 경로를 같은 자격으로 잠근다.
    server = await startApp((app) => {
      app.get(['/api/kakao/messages', '/api/kakao/chatrooms', '/api/kakao/stats'], gate.middleware);
      app.use('/api/kakao', createKakaoRouter({ getDb: () => db }));
    });
  });

  afterEach(async () => { await stopApp(server); });

  test('토큰 없이 /api/kakao/chatrooms 를 부르면 401 이고 DB 를 읽지 않는다', async () => {
    const res = await request(server, { path: '/api/kakao/chatrooms' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(queried).toHaveLength(0);
  });

  test('토큰 없이 /api/kakao/stats 를 부르면 403/401 로 막히고 DB 를 읽지 않는다', async () => {
    const res = await request(server, { path: '/api/kakao/stats' });
    expect([401, 403]).toContain(res.status);
    expect(queried).toHaveLength(0);
  });

  test('모르는 토큰은 403', async () => {
    const res = await request(server, { path: '/api/kakao/chatrooms', headers: { authorization: 'Bearer ' + JUNK } });
    expect(res.status).toBe(403);
    expect(queried).toHaveLength(0);
  });

  test('관리자 토큰이면 예전처럼 방 목록을 준다', async () => {
    const res = await request(server, { path: '/api/kakao/chatrooms', headers: { authorization: 'Bearer ' + ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.chatrooms).toHaveLength(1);
  });

  test('?token= 관리자 토큰으로도 방 목록을 준다(링크 방식 호출 유지)', async () => {
    const res = await request(server, { path: '/api/kakao/chatrooms?token=' + ADMIN_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('/api/admin/kakao-intel 자격 확인 위치', () => {
  let server;
  let handlerCalls;

  beforeEach(async () => {
    handlerCalls = 0;
    const gate = makeGate();
    server = await startApp((app) => {
      // server.js 안의 배치를 그대로 옮긴 것: 핸들러 첫 줄에서 자격을 보고, 통과할 때만 집계를 만든다.
      app.get('/api/admin/kakao-intel', async (req, res) => {
        const code = await gate.check(req);
        if (code) return res.status(code).json({ error: code === 401 ? 'unauthorized' : 'admin only' });
        handlerCalls += 1;
        res.json({ ok: true, customers: [] });
      });
    });
  });

  afterEach(async () => { await stopApp(server); });

  test('토큰이 없으면 401 (무인증 노출 차단)', async () => {
    const res = await request(server, { path: '/api/admin/kakao-intel?hours=720' });
    expect(res.status).toBe(401);
    expect(handlerCalls).toBe(0);
  });

  test('관리자 토큰이면 통과', async () => {
    const res = await request(server, { path: '/api/admin/kakao-intel?hours=720', headers: { authorization: 'Bearer ' + ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(handlerCalls).toBe(1);
  });
});
