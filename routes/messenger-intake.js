'use strict';
/**
 * routes/messenger-intake.js — 해외 메신저(위챗·왓츠앱) 대화방 글 수신 (2026-11-23 사장님 지시, g01·g03)
 *
 * 카톡 통로(routes/kakao-decrypt.js, kakao_messages)는 그대로 두고 옆에 따로 둔다.
 *   → 기존 카톡 읽는 쪽(kakao-intel-worker · orderflow-agent · 교차 분석 SQL)에 해외 메신저 글이 섞이지 않는다.
 * 한 건의 모양은 kakao_messages 와 같은 칸 이름 + channel(어느 앱) · direction(받은 글/보낸 글) · collector(가져온 방법).
 *
 *   POST /api/messenger/import    운영 PC 수집기가 보냄. 인증 = 카톡 수신과 같은 수신 토큰(새 비밀값 없음).
 *        { channel: 'wechat'|'whatsapp', messages: [{ external_message_id, chatroom, sender, message, created_at, ... }] }
 *        중복 제거 = (channel, external_message_id) 유일. 같은 묶음을 다시 보내도 건수가 늘지 않는다.
 *        응답 imported + skipped = total (수집기는 이 합이 맞을 때만 보낸 묶음을 지운다 — 카톡과 같은 약속).
 *   GET  /api/messenger/messages  관리자만(server.js 에서 잠금). 카톡 조회와 같은 모양 + channel.
 *   GET  /api/messenger/rooms     관리자만. 방별 건수·처음/마지막 시각만(글 내용 없음) — 들어오는지 확인용.
 *
 * 수신은 저장일 뿐이다. 전산 등록·발송·승인을 뜻하지 않는다.
 */
const express = require('express');
const crypto = require('crypto');

const CHANNELS = ['wechat', 'whatsapp'];
const TYPES = ['text', 'image', 'file', 'audio', 'video', 'system', 'other'];
const COLLECTORS = ['export-file', 'local-db', 'linked-device', 'ui-read', 'official-api', 'manual'];
const MAX_BATCH = 500;
const MAX_TEXT = 8000;

const IMPORT_TOKEN_SHA256 = process.env.MESSENGER_IMPORT_TOKEN_SHA256
  || process.env.KAKAO_IMPORT_TOKEN_SHA256
  || '996dbe719828cdc0d926df282b256d5d8e7d7734a489384907493532a1e93b17';

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const isIso = (v) => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  && !Number.isNaN(Date.parse(v));

// 발신자 칸이 전화번호로 온 경우(왓츠앱에서 주소록에 없는 사람) 끝 4자리만 남긴다. 같은 사람인지는 구분되고 번호는 저장하지 않는다.
function maskSender(v) {
  const s = clean(v, 120);
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && /^[+\d\s().\-‪‬ ]+$/.test(s)) return `번호끝${digits.slice(-4)}`;
  return s;
}

function normalize(msg, channel) {
  if (!msg || typeof msg !== 'object') return { error: 'not-object' };
  const externalId = clean(msg.external_message_id || msg.id, 200);
  const chatroom = clean(msg.chatroom, 200);
  const text = clean(msg.message != null ? msg.message : msg.text, MAX_TEXT);
  const attachment = clean(msg.attachment_name, 200);
  if (!externalId) return { error: 'no-id' };
  if (!chatroom) return { error: 'no-room' };
  if (!text && !attachment) return { error: 'empty' };
  if (!isIso(msg.created_at)) return { error: 'bad-time' };
  const type = TYPES.includes(msg.type) ? msg.type : 'text';
  const direction = msg.direction === 'in' || msg.direction === 'out' ? msg.direction : null;
  const collector = COLLECTORS.includes(msg.collector) ? msg.collector : 'manual';
  return {
    row: [
      channel,
      externalId,
      clean(msg.chat_id, 200) || null,
      chatroom,
      maskSender(msg.sender) || null,
      direction,
      text || `[첨부] ${attachment}`,
      type,
      attachment || null,
      collector,
      new Date(msg.created_at).toISOString(),
      Boolean(msg.timestamp_approximate),
    ],
  };
}

function createMessengerIntakeRouter({ getDb, importTokenSha256 = IMPORT_TOKEN_SHA256, adminOk = null }) {
  const router = express.Router();

  // 관리자 판정은 server.js 가 넘겨 준 함수(_visionThumbAdminOk: 마스터·관리자 토큰만 0)를 쓴다. 접두사 검사가 아니다.
  async function isAdmin(req) {
    if (typeof adminOk !== 'function') return false;
    try { return (await adminOk(req)) === 0; } catch { return false; }
  }

  // 수신 토큰(운영 PC 수집기) 또는 관리자 토큰(사장님 PC에서 내보내기 파일을 직접 올릴 때·시험)만 받는다.
  async function requireImportToken(req, res, next) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = bearer || String(req.headers['x-messenger-import-token'] || '');
    const providedBytes = crypto.createHash('sha256').update(provided).digest();
    const expectedBytes = Buffer.from(String(importTokenSha256 || ''), 'hex');
    if (provided && expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes)) return next();
    if (bearer && await isAdmin(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let ready = false;
  async function ensureTables(db) {
    if (ready) return;
    await db.query(`
      CREATE TABLE IF NOT EXISTS messenger_messages (
        id BIGSERIAL PRIMARY KEY,
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        chat_id TEXT,
        chatroom TEXT NOT NULL,
        sender TEXT,
        direction TEXT,
        message TEXT,
        message_type TEXT DEFAULT 'text',
        attachment_name TEXT,
        collector TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        timestamp_approximate BOOLEAN DEFAULT FALSE,
        imported_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_messenger_messages_channel_ext ON messenger_messages(channel, external_message_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_messenger_messages_created_at ON messenger_messages(created_at)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_messenger_messages_room ON messenger_messages(channel, chatroom)');
    ready = true;
  }

  router.post('/import', requireImportToken, async (req, res) => {
    try {
      const body = req.body || {};
      const channel = String(body.channel || '');
      if (!CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(', ')}` });
      if (!Array.isArray(body.messages)) return res.status(400).json({ error: 'messages array required' });
      if (body.messages.length > MAX_BATCH) return res.status(413).json({ error: `at most ${MAX_BATCH} messages per request` });

      const db = getDb();
      if (!db || !db.query) return res.status(503).json({ error: 'DB not available' });
      await ensureTables(db);

      let imported = 0;
      let skipped = 0;
      const rejected = {};
      for (const msg of body.messages) {
        const n = normalize(msg, channel);
        if (n.error) { skipped++; rejected[n.error] = (rejected[n.error] || 0) + 1; continue; }
        try {
          const result = await db.query(
            `INSERT INTO messenger_messages
               (channel, external_message_id, chat_id, chatroom, sender, direction, message, message_type, attachment_name, collector, created_at, timestamp_approximate)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (channel, external_message_id) DO NOTHING
             RETURNING id`,
            n.row
          );
          if (result && result.rowCount > 0) imported++;
          else skipped++;
        } catch (rowErr) {
          console.error('[MessengerIntake] import row error:', rowErr.message);
          skipped++;
          rejected['db-error'] = (rejected['db-error'] || 0) + 1;
        }
      }
      res.json({ ok: true, channel, imported, skipped, rejected, total: body.messages.length });
    } catch (err) {
      console.error('[MessengerIntake] import error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/messages', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const db = getDb();
      if (!db || !db.query) return res.status(503).json({ error: 'DB not available' });
      await ensureTables(db);

      const { channel, chatroom, startDate, endDate, limit, offset } = req.query;
      const conditions = [];
      const params = [];
      if (channel !== undefined) {
        if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'unknown channel' });
        params.push(channel); conditions.push(`channel = $${params.length}`);
      }
      if (chatroom) { params.push(String(chatroom)); conditions.push(`chatroom = $${params.length}`); }
      for (const [value, op] of [[startDate, '>='], [endDate, '<=']]) {
        if (value === undefined) continue;
        if (Number.isNaN(Date.parse(String(value)))) return res.status(400).json({ error: 'bad date' });
        params.push(new Date(String(value)).toISOString()); conditions.push(`created_at ${op} $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const queryLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
      const queryOffset = Math.max(parseInt(offset, 10) || 0, 0);

      const count = await db.query(`SELECT COUNT(*) AS total FROM messenger_messages ${where}`, params);
      const data = await db.query(
        `SELECT id, channel, external_message_id, chat_id, chatroom, sender, direction, message, message_type,
                attachment_name, collector AS source, created_at, timestamp_approximate
         FROM messenger_messages ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${queryLimit} OFFSET ${queryOffset}`,
        params
      );
      res.json({ ok: true, total: parseInt((count.rows[0] || {}).total, 10) || 0, limit: queryLimit, offset: queryOffset, messages: data.rows });
    } catch (err) {
      console.error('[MessengerIntake] messages error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 시험 방 글 지우기 — 관리자만. 방 이름이 'TEST-' 로 시작하는 글만 지운다(조건이 코드에 박혀 있어 실제 방은 지울 수 없다).
  router.delete('/test-rows', async (req, res) => {
    try {
      if (!(await isAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
      const db = getDb();
      if (!db || !db.query) return res.status(503).json({ error: 'DB not available' });
      await ensureTables(db);
      const result = await db.query("DELETE FROM messenger_messages WHERE chatroom LIKE 'TEST-%'");
      res.json({ ok: true, deleted: result.rowCount || 0 });
    } catch (err) {
      console.error('[MessengerIntake] test-rows delete error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/rooms', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const db = getDb();
      if (!db || !db.query) return res.status(503).json({ error: 'DB not available' });
      await ensureTables(db);
      const result = await db.query(`
        SELECT channel, chatroom, COUNT(*) AS message_count, COUNT(DISTINCT sender) AS sender_count,
               MIN(created_at) AS first_message, MAX(created_at) AS last_message, MAX(imported_at) AS last_imported
        FROM messenger_messages
        GROUP BY channel, chatroom
        ORDER BY MAX(created_at) DESC
      `);
      res.json({ ok: true, count: result.rows.length, rooms: result.rows });
    } catch (err) {
      console.error('[MessengerIntake] rooms error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createMessengerIntakeRouter;
module.exports.normalize = normalize;
module.exports.maskSender = maskSender;
module.exports.CHANNELS = CHANNELS;
