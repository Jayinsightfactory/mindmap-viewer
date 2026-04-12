'use strict';
/**
 * routes/issues.js — 이슈 태스킹 API
 *
 * 이슈 자동 생성 (파서 연동) + CRUD + 상태 관리 + KakaoWork 알림
 *
 * GET  /api/issues          — 이슈 목록 (filter: status, type, week_num)
 * POST /api/issues          — 이슈 수동 생성
 * GET  /api/issues/:id      — 이슈 상세
 * PATCH /api/issues/:id     — 상태/담당자 변경
 * POST /api/issues/:id/notify — 알림 재발송
 * POST /api/issues/auto     — 파서 결과 → 이슈 자동 생성 (내부 호출)
 */
const express = require('express');
const https = require('https');

const KAKAO_TOKEN   = () => process.env.KAKAOTALK_TOKEN || '';
const KAKAO_ADMIN   = () => process.env.KAKAO_ADMIN_CONV_ID || '';

// 담당자 이름 → KakaoWork user_id 매핑 (가입 후 채워짐)
const MANAGER_KW_MAP = {
  // '박성수': '12345678',
  // '정재훈': '12345679',
};

async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS issues (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      week_num    TEXT,
      cust_key    TEXT,
      manager     TEXT,
      kw_user_id  TEXT,
      kw_notified BOOLEAN DEFAULT FALSE,
      raw_text    TEXT,
      source      TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
}

async function sendKakaoWork(convId, text) {
  const token = KAKAO_TOKEN();
  if (!token || !convId) return false;
  const body = JSON.stringify({ conversation_id: convId, text });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.kakaowork.com',
      path: '/v1/messages.send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).success === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function notifyIssue(db, issue) {
  const adminConv = KAKAO_ADMIN();
  if (!adminConv) return;

  const statusLabel = { open: '🔴 신규', in_progress: '🟡 처리중', resolved: '🟢 완료' };
  const typeLabel = {
    delay: '입고 딜레이',
    qty_shortage: '수량 부족',
    defect: '불량 발생',
    order_change: '주문 변경',
    claim: '클레임',
  };

  const text = [
    `[${typeLabel[issue.type] || issue.type}] ${issue.title}`,
    issue.description || '',
    issue.week_num ? `차수: ${issue.week_num}` : '',
    issue.manager ? `담당: ${issue.manager}` : '',
    `상태: ${statusLabel[issue.status] || issue.status}`,
  ].filter(Boolean).join('\n');

  const sent = await sendKakaoWork(adminConv, text);

  // 개인 알림 (KakaoWork 가입 후)
  const kwId = issue.kw_user_id || MANAGER_KW_MAP[issue.manager];
  if (kwId && kwId !== '') {
    // open 1:1 DM then send
    const dmConv = await new Promise(resolve => {
      const b = JSON.stringify({ user_id: parseInt(kwId) });
      const r = https.request({
        hostname: 'api.kakaowork.com',
        path: '/v1/conversations.open',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${KAKAO_TOKEN()}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(b),
        },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d).conversation?.id); } catch { resolve(null); }
        });
      });
      r.on('error', () => resolve(null));
      r.setTimeout(5000, () => { r.destroy(); resolve(null); });
      r.write(b); r.end();
    });
    if (dmConv) await sendKakaoWork(dmConv, text);
  }

  if (sent) {
    await db.query(`UPDATE issues SET kw_notified=TRUE, updated_at=NOW() WHERE id=$1`, [issue.id]);
  }
}

function createIssuesRouter({ getDb }) {
  const router = express.Router();

  // 서버 시작 시 테이블 준비
  setTimeout(async () => {
    try { await ensureTable(getDb()); } catch (e) { console.error('[issues]', e.message); }
  }, 6000);

  // GET /api/issues
  router.get('/', async (req, res) => {
    try {
      const db = getDb();
      const { status, type, week_num, limit = 100 } = req.query;
      const conditions = [];
      const params = [];
      if (status)   { params.push(status);   conditions.push(`status=$${params.length}`); }
      if (type)     { params.push(type);     conditions.push(`type=$${params.length}`); }
      if (week_num) { params.push(week_num); conditions.push(`week_num=$${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(parseInt(limit));
      const result = await db.query(
        `SELECT * FROM issues ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      // 상태별 카운트
      const counts = await db.query(`SELECT status, COUNT(*) FROM issues GROUP BY status`);
      const summary = {};
      counts.rows.forEach(r => { summary[r.status] = parseInt(r.count); });
      res.json({ ok: true, total: result.rows.length, summary, issues: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/issues — 수동 생성
  router.post('/', async (req, res) => {
    try {
      const db = getDb();
      await ensureTable(db);
      const { type, title, description, week_num, cust_key, manager, raw_text, source } = req.body;
      if (!type || !title) return res.status(400).json({ error: 'type, title 필수' });
      const kwId = MANAGER_KW_MAP[manager] || null;
      const result = await db.query(
        `INSERT INTO issues (type, title, description, week_num, cust_key, manager, kw_user_id, raw_text, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [type, title, description || null, week_num || null, cust_key || null, manager || null, kwId, raw_text || null, source || 'manual']
      );
      const issue = result.rows[0];
      await notifyIssue(db, issue);
      res.json({ ok: true, issue });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/issues/:id
  router.get('/:id', async (req, res) => {
    try {
      const db = getDb();
      const result = await db.query(`SELECT * FROM issues WHERE id=$1`, [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, issue: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/issues/:id — 상태/담당자 변경
  router.patch('/:id', async (req, res) => {
    try {
      const db = getDb();
      const { status, manager, description } = req.body;
      const sets = [];
      const params = [];
      if (status) {
        params.push(status); sets.push(`status=$${params.length}`);
        if (status === 'resolved') sets.push(`resolved_at=NOW()`);
      }
      if (manager) { params.push(manager); sets.push(`manager=$${params.length}`); }
      if (description) { params.push(description); sets.push(`description=$${params.length}`); }
      if (!sets.length) return res.status(400).json({ error: '변경값 없음' });
      sets.push('updated_at=NOW()');
      params.push(req.params.id);
      const result = await db.query(
        `UPDATE issues SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`,
        params
      );
      if (!result.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, issue: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/issues/:id/notify — 알림 재발송
  router.post('/:id/notify', async (req, res) => {
    try {
      const db = getDb();
      const result = await db.query(`SELECT * FROM issues WHERE id=$1`, [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'not found' });
      await notifyIssue(db, result.rows[0]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/issues/auto — 파서 결과 → 이슈 자동 생성 (automation-engine에서 호출)
  router.post('/auto', async (req, res) => {
    try {
      const db = getDb();
      await ensureTable(db);
      const { formatType, orders, arrivalAlert, source, rawText } = req.body;
      const created = [];

      if (formatType === 'bill_arrival' && arrivalAlert?.type === 'changed') {
        const { weekNum, supplier, changes, alertText } = arrivalAlert;
        const hasDelay = changes.some(c => c.field === 'arrival_dt');
        const hasQty   = changes.some(c => c.field === 'boxes');
        const type  = hasDelay ? 'delay' : 'qty_shortage';
        const title = hasDelay
          ? `${weekNum}차 ${supplier} 입고 딜레이`
          : `${weekNum}차 ${supplier} 박스 수량 변경`;
        const r = await db.query(
          `INSERT INTO issues (type, title, description, week_num, source, raw_text)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [type, title, alertText, weekNum, source || '수입방', rawText || '']
        );
        const issue = r.rows[0];
        await notifyIssue(db, issue);
        created.push(issue);
      }

      if (formatType === 'change_order' && orders?.length) {
        // 취소/추가가 있을 때만 이슈 생성
        const weekNum = orders[0]?.weekNum;
        const changes = orders.map(o =>
          `${o.customer} ${o.product} ${o.quantity}박스 ${o.action === 'cancel' ? '취소' : '추가'}`
        ).join('\n');
        const r = await db.query(
          `INSERT INTO issues (type, title, description, week_num, source, raw_text)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          ['order_change', `${weekNum}차 주문 변경 (${orders.length}건)`, changes, weekNum, source || '영업방팀', rawText || '']
        );
        const issue = r.rows[0];
        await notifyIssue(db, issue);
        created.push(issue);
      }

      res.json({ ok: true, created: created.length, issues: created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createIssuesRouter };
