// /api/scripts 승인 게이트: 401/403/409/정상 경로/감사로그
const express = require('express');
const createScriptGenerator = require('../../routes/script-generator');

function fakeDb() {
  const scripts = { 1: { id: 1, status: 'draft', script_type: 'pyautogui', script_content: 'x', action_type: 'a' } };
  const audit = [], commands = [];
  return {
    scripts, audit, commands,
    async query(sql, p = []) {
      if (/INSERT INTO script_audit_log/.test(sql)) { audit.push({ script_id: p[0], action: p[1], actor_email: p[3], from_status: p[4], to_status: p[5], ok: p[7] }); return { rows: [] }; }
      if (/INSERT INTO orbit_daemon_commands/.test(sql)) { commands.push(p); return { rows: [] }; }
      if (/^SELECT \* FROM generated_scripts WHERE id/.test(sql)) { const s = scripts[p[0]]; return { rows: s ? [{ ...s }] : [] }; }
      if (/UPDATE generated_scripts SET deploy_count/.test(sql)) { scripts[p[1]].status = p[0]; return { rows: [] }; }
      if (/UPDATE generated_scripts SET status/.test(sql)) { scripts[p[1]].status = p[0]; return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
  };
}

const USERS = { admin: { user: { id: 'admin', email: 'boss@x' }, isAdmin: true }, staff: { user: { id: 'u2', email: 'staff@x' }, isAdmin: false } };

let server, base, db;
beforeEach(async () => {
  db = fakeDb();
  const app = express();
  app.use(express.json());
  app.use('/api/scripts', createScriptGenerator({ getDb: () => db, authenticate: async (req) => USERS[(req.headers.authorization || '').replace('Bearer ', '')] || null }));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/scripts`;
});
afterEach(() => new Promise(r => server.close(r)));

const call = (path, tok, body) => fetch(base + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('비인증 401', async () => {
  expect((await call('/1/approve-run', null, { hostname: 'h' })).status).toBe(401);
  expect((await call('/list', null)).status).toBe(401);
  expect(db.commands).toHaveLength(0);
});

test('비승인자 403', async () => {
  for (const a of ['deploy', 'approve', 'reject', 'approve-run']) {
    expect((await call(`/1/${a}`, 'staff', { hostname: 'h' })).status).toBe(403);
  }
  expect(db.commands).toHaveLength(0);
  expect(db.scripts[1].status).toBe('draft');
});

test('순서 위반 409 + 감사로그(ok=false)', async () => {
  const r = await call('/1/approve-run', 'admin', { hostname: 'h' });
  expect(r.status).toBe(409);
  expect((await r.json()).reason).toMatch(/draft/);
  expect((await call('/1/approve', 'admin', {})).status).toBe(409);
  expect(db.commands).toHaveLength(0);
  expect(db.audit.every(a => a.ok === false)).toBe(true);
});

test('PUT 으로 status 직접 변경 409', async () => {
  const r = await fetch(base + '/1', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin' }, body: JSON.stringify({ status: 'approved' }) });
  expect(r.status).toBe(409);
  expect(db.scripts[1].status).toBe('draft');
});

test('승인자 정상 경로 draft→tested→approved→deployed + 감사로그', async () => {
  expect((await call('/1/deploy', 'admin', { hostname: 'h' })).status).toBe(200);
  expect((await call('/1/approve', 'admin', {})).status).toBe(200);
  expect((await call('/1/approve-run', 'admin', { hostname: 'h' })).status).toBe(200);
  expect(db.scripts[1].status).toBe('deployed');
  expect(db.audit.map(a => [a.action, a.to_status, a.actor_email, a.ok])).toEqual([
    ['deploy', 'tested', 'boss@x', true], ['approve', 'approved', 'boss@x', true], ['approve-run', 'deployed', 'boss@x', true],
  ]);
  const run = JSON.parse(db.commands[1][1]);
  expect(run.approvedBy).toBe('boss@x');
  expect((await call('/1/approve-run', 'admin', { hostname: 'h' })).status).toBe(409); // 재실행 불가
});

test('reject 후 실행 불가', async () => {
  expect((await call('/1/reject', 'admin', {})).status).toBe(200);
  expect((await call('/1/deploy', 'admin', { hostname: 'h' })).status).toBe(409);
});
