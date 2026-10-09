'use strict';
// CERT_SECRET fail-closed + 직원별 인증서/shadow-ai 접근 제한 회귀 테스트
const express = require('express');
const { createCertificateRouter, signCert, getCertSecret } = require('../../src/certificate-engine');
const createSecurityRouter = require('../../routes/security');

const EVENTS = Array.from({ length: 50 }, (_, i) => ({
  id: 'e' + i, userId: 'alice', type: 'tool.use', timestamp: new Date(Date.now() - i * 3600e3).toISOString(),
  data: { tool: 'claude' }, channelId: 'c1',
}));

async function serve(router, withUser) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const u = req.headers['x-test-user']; if (u) req.user = { id: u }; next(); });
  app.use('/api', router);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (path, { method = 'GET', user, body } = {}) => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { srv, call };
}

const canAccessUser = async (req, userId) =>
  req.user?.id === 'boss' || (!!userId && req.user?.id === userId);

describe('signCert fail-closed', () => {
  const saved = process.env.CERT_SECRET;
  afterEach(() => { if (saved === undefined) delete process.env.CERT_SECRET; else process.env.CERT_SECRET = saved; });

  test('CERT_SECRET 없으면 서명 null (기본키 사용 안 함)', () => {
    delete process.env.CERT_SECRET;
    expect(getCertSecret()).toBeNull();
    expect(signCert({ a: 1 })).toBeNull();
  });
  test('짧은 CERT_SECRET도 거부', () => {
    process.env.CERT_SECRET = 'short';
    expect(signCert({ a: 1 })).toBeNull();
  });
  test('설정되면 HMAC 서명, 키 바뀌면 서명 달라짐', () => {
    process.env.CERT_SECRET = 'x'.repeat(32);
    const a = signCert({ a: 1 });
    process.env.CERT_SECRET = 'y'.repeat(32);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(signCert({ a: 1 })).not.toBe(a);
  });
});

describe('certificate router', () => {
  let s; const saved = process.env.CERT_SECRET;
  beforeAll(async () => {
    s = await serve(createCertificateRouter({ getEventsForUser: async () => EVENTS, getSessions: async () => [], canAccessUser }));
  });
  afterAll(() => { s.srv.close(); if (saved === undefined) delete process.env.CERT_SECRET; else process.env.CERT_SECRET = saved; });

  test('비로그인/타인은 점수·JSON·SVG·라벨·목록 403', async () => {
    for (const p of ['/api/certificate/alice/score', '/api/certificate/alice/json', '/api/certificate/alice/svg', '/api/certificate/alice/labels', '/api/certificate']) {
      expect((await s.call(p)).status).toBe(403);
      expect((await s.call(p, { user: 'bob' })).status).toBe(403);
    }
  });
  test('본인·관리자는 점수 조회 가능', async () => {
    expect((await s.call('/api/certificate/alice/score', { user: 'alice' })).status).toBe(200);
    expect((await s.call('/api/certificate/alice/score', { user: 'boss' })).status).toBe(200);
    expect((await s.call('/api/certificate', { user: 'boss' })).status).toBe(200);
  });
  test('CERT_SECRET 없으면 발급·검증 503', async () => {
    delete process.env.CERT_SECRET;
    const r = await s.call('/api/certificate/alice/issue', { method: 'POST', user: 'alice' });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe('CERT_SECRET_MISSING');
    expect(JSON.stringify(body)).not.toMatch(/orbit-secret/);
    expect((await s.call('/api/certificate/verify/abc')).status).toBe(503);
  });
});

describe('/api/shadow-ai 접근 제한', () => {
  let s; const seen = [];
  beforeAll(async () => {
    s = await serve(createSecurityRouter({
      db: { getAllEvents: async () => [...EVENTS, { id: 'z', userId: 'carol', timestamp: new Date().toISOString() }] },
      shadowAiDetector: { detectShadowAI: (ev) => ev.map(e => ({ eventId: e.id })), getApprovedSources: () => [], addApprovedSource() {}, removeApprovedSource() {} },
      auditLog: { queryAuditLog: () => [], verifyIntegrity: () => ({}), renderAuditHtml: () => '' },
      getEventsForUser: async (uid) => { seen.push(uid); return EVENTS.filter(e => e.userId === uid); },
      resolveUserId: (req) => req.user?.id || 'local',
      isAdminReq: async (req) => req.user?.id === 'boss',
    }));
  });
  afterAll(() => s.srv.close());

  test('비로그인 401 (전 직원 이벤트 노출 차단)', async () => {
    expect((await s.call('/api/shadow-ai')).status).toBe(401);
  });
  test('로그인 사용자는 본인 이벤트만', async () => {
    const r = await s.call('/api/shadow-ai?hours=1000', { user: 'bob' });
    expect(r.status).toBe(200);
    expect((await r.json()).checkedEvents).toBe(0);
    expect(seen).toContain('bob');
  });
  test('관리자는 전체', async () => {
    const r = await s.call('/api/shadow-ai?hours=1000', { user: 'boss' });
    expect((await r.json()).checkedEvents).toBe(51);
  });
});
