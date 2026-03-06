'use strict';

/**
 * routes/chat.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 메신저 API
 *
 * 채팅방 유형: 'dm' | 'team' | 'company'
 *
 * 엔드포인트:
 *   POST   /api/chat/dm/:userId             - DM방 생성 또는 조회
 *   POST   /api/chat/channel                - 팀/회사 채널 생성
 *   GET    /api/chat/rooms                  - 내 채팅방 목록
 *   GET    /api/chat/:roomId/messages       - 메시지 목록 (최근 50개)
 *   POST   /api/chat/:roomId/messages       - 메시지 전송 (@orbit → AI 봇)
 *   PUT    /api/chat/:roomId/read           - 읽음 처리
 *   DELETE /api/chat/:roomId/messages/:id   - 메시지 삭제 (본인)
 *   GET    /api/chat/quota                  - 스토리지 사용량 / 한도
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const http    = require('http');

// 플랜별 메시지 한도 (무료 → 유료)
const PLAN_LIMITS = {
  free:       500,
  pro:      10000,
  team:     50000,
  enterprise: Infinity,
};

function createRouter({ getDb, verifyToken, broadcastToRoom }) {

  // ── DB 초기화 ───────────────────────────────────────────────────────────────
  function initChatTables() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL DEFAULT 'dm',
        name        TEXT,
        created_by  TEXT,
        meta        TEXT DEFAULT '{}',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT NOT NULL,
        sender_id   TEXT NOT NULL,
        sender_name TEXT,
        content     TEXT NOT NULL,
        type        TEXT DEFAULT 'text',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_participants (
        room_id     TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        last_read   DATETIME,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cm_room ON chat_messages(room_id);
      CREATE INDEX IF NOT EXISTS idx_cm_sender ON chat_messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_cp_user ON chat_participants(user_id);
    `);
  }

  try { initChatTables(); } catch (e) { console.warn('[chat] DB init warn:', e.message); }

  // ── 인증 미들웨어 ────────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  }

  // ── 유틸: 방 ID 생성 ─────────────────────────────────────────────────────────
  function dmRoomId(a, b) {
    return 'dm_' + [a, b].sort().join('__');
  }

  // ── 유틸: 플랜 조회 ──────────────────────────────────────────────────────────
  function getUserPlan(userId) {
    try {
      const db  = getDb();
      const row = db.prepare(
        "SELECT plan FROM users WHERE id = ? OR email = ? LIMIT 1"
      ).get(userId, userId);
      return row?.plan || 'free';
    } catch { return 'free'; }
  }

  // ── 유틸: 메시지 카운트 ──────────────────────────────────────────────────────
  function getMessageCount(userId) {
    const db  = getDb();
    const row = db.prepare(
      'SELECT COUNT(*) AS cnt FROM chat_messages WHERE sender_id = ?'
    ).get(userId);
    return row?.cnt || 0;
  }

  // ── 유틸: AI 봇 응답 (Cloud Haiku) ──────────────────────────────────────────
  async function getAIReply(userMsg, history = []) {
    const { generate } = require('../src/llm-gateway');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 'AI API 키가 설정되지 않았습니다.';

    const prompt = history.slice(-6).map(m =>
      `${m.sender_name || '사용자'}: ${m.content}`
    ).join('\n') + `\n사용자: ${userMsg}\nOrbit AI:`;

    try {
      const reply = await generate({
        provider: 'anthropic',
        model:    'claude-haiku-3-5',
        prompt,
        apiKey,
      });
      return reply || '죄송해요, 지금 답변하기 어려워요.';
    } catch {
      return 'AI 응답 생성 중 오류가 발생했습니다.';
    }
  }

  // ── POST /api/chat/dm/:userId ────────────────────────────────────────────────
  router.post('/chat/dm/:userId', auth, (req, res) => {
    try {
      const db     = getDb();
      const myId   = req.user.id;
      const peerId = req.params.userId;
      if (peerId === myId) return res.status(400).json({ error: 'cannot DM yourself' });

      const roomId = dmRoomId(myId, peerId);

      // 방이 없으면 생성
      const existing = db.prepare('SELECT id FROM chat_rooms WHERE id = ?').get(roomId);
      if (!existing) {
        db.prepare(
          'INSERT INTO chat_rooms (id, type, created_by) VALUES (?, ?, ?)'
        ).run(roomId, 'dm', myId);
        db.prepare(
          'INSERT OR IGNORE INTO chat_participants (room_id, user_id) VALUES (?, ?)'
        ).run(roomId, myId);
        db.prepare(
          'INSERT OR IGNORE INTO chat_participants (room_id, user_id) VALUES (?, ?)'
        ).run(roomId, peerId);
      }

      // 상대방 프로필
      const peer = db.prepare(
        'SELECT name, headline, avatar_url FROM user_profiles WHERE user_id = ?'
      ).get(peerId);

      res.json({ roomId, peerId, peerName: peer?.name || peerId, peerAvatar: peer?.avatar_url || null });
    } catch (e) {
      console.error('[chat/dm]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/chat/channel ───────────────────────────────────────────────────
  router.post('/chat/channel', auth, (req, res) => {
    try {
      const db   = getDb();
      const { name, type = 'team', memberIds = [] } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });

      const roomId  = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(
        'INSERT INTO chat_rooms (id, type, name, created_by) VALUES (?, ?, ?, ?)'
      ).run(roomId, type, name, req.user.id);

      // 생성자 참여
      db.prepare('INSERT OR IGNORE INTO chat_participants (room_id, user_id) VALUES (?, ?)')
        .run(roomId, req.user.id);

      // 초대된 멤버들
      const addMember = db.prepare(
        'INSERT OR IGNORE INTO chat_participants (room_id, user_id) VALUES (?, ?)'
      );
      for (const uid of memberIds) addMember.run(roomId, uid);

      res.json({ roomId, name, type });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/chat/rooms ──────────────────────────────────────────────────────
  router.get('/chat/rooms', auth, (req, res) => {
    try {
      const db    = getDb();
      const rooms = db.prepare(`
        SELECT r.id, r.type, r.name, r.created_at,
               MAX(m.created_at) AS last_msg_at,
               (SELECT content FROM chat_messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_msg,
               (SELECT COUNT(*) FROM chat_messages m2
                WHERE m2.room_id = r.id
                  AND m2.created_at > COALESCE(p.last_read, '1970-01-01')) AS unread
        FROM chat_rooms r
        JOIN chat_participants p ON p.room_id = r.id AND p.user_id = ?
        LEFT JOIN chat_messages m ON m.room_id = r.id
        GROUP BY r.id
        ORDER BY last_msg_at DESC NULLS LAST
        LIMIT 100
      `).all(req.user.id);

      // DM의 경우 상대방 정보 보강
      const result = rooms.map(room => {
        if (room.type === 'dm') {
          const parts = db.prepare(
            'SELECT user_id FROM chat_participants WHERE room_id = ? AND user_id != ?'
          ).all(room.id, req.user.id);
          const peerId = parts[0]?.user_id;
          const peer   = peerId ? db.prepare(
            'SELECT name, avatar_url FROM user_profiles WHERE user_id = ?'
          ).get(peerId) : null;
          return { ...room, peerName: peer?.name || peerId, peerAvatar: peer?.avatar_url };
        }
        return room;
      });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/chat/:roomId/messages ───────────────────────────────────────────
  router.get('/chat/:roomId/messages', auth, (req, res) => {
    try {
      const db = getDb();
      // 참여자 확인
      const isParticipant = db.prepare(
        'SELECT 1 FROM chat_participants WHERE room_id = ? AND user_id = ?'
      ).get(req.params.roomId, req.user.id);
      if (!isParticipant) return res.status(403).json({ error: 'not a participant' });

      const before = req.query.before ? parseInt(req.query.before) : null;
      const limit  = Math.min(parseInt(req.query.limit) || 50, 100);

      const msgs = before
        ? db.prepare('SELECT * FROM chat_messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(req.params.roomId, before, limit)
        : db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?')
            .all(req.params.roomId, limit);

      res.json(msgs.reverse()); // 오래된 것부터
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/chat/:roomId/messages ─────────────────────────────────────────
  router.post('/chat/:roomId/messages', auth, async (req, res) => {
    try {
      const db      = getDb();
      const roomId  = req.params.roomId;
      const { content, type = 'text' } = req.body || {};
      if (!content?.trim()) return res.status(400).json({ error: 'content required' });

      // 참여자 확인
      const isParticipant = db.prepare(
        'SELECT 1 FROM chat_participants WHERE room_id = ? AND user_id = ?'
      ).get(roomId, req.user.id);
      if (!isParticipant) return res.status(403).json({ error: 'not a participant' });

      // 스토리지 한도 체크
      const plan  = getUserPlan(req.user.id);
      const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
      if (limit !== Infinity) {
        const count = getMessageCount(req.user.id);
        if (count >= limit) {
          return res.status(402).json({
            error: 'quota_exceeded',
            message: `메시지 한도(${limit}개)를 초과했습니다. 플랜을 업그레이드해주세요.`,
            currentPlan: plan,
            count,
            limit,
          });
        }
      }

      // 메시지 저장
      const sender = db.prepare(
        'SELECT name FROM user_profiles WHERE user_id = ?'
      ).get(req.user.id);
      const senderName = sender?.name || req.user.email || req.user.id;

      const result = db.prepare(
        'INSERT INTO chat_messages (room_id, sender_id, sender_name, content, type) VALUES (?, ?, ?, ?, ?)'
      ).run(roomId, req.user.id, senderName, content.slice(0, 2000), type);

      const newMsg = {
        id: result.lastInsertRowid,
        room_id: roomId,
        sender_id: req.user.id,
        sender_name: senderName,
        content: content.slice(0, 2000),
        type,
        created_at: new Date().toISOString(),
      };

      // WebSocket 브로드캐스트
      if (typeof broadcastToRoom === 'function') {
        broadcastToRoom(roomId, { type: 'chat_message', message: newMsg });
      }

      res.json(newMsg);

      // @orbit 멘션 → AI 봇 응답 (비동기)
      if (content.includes('@orbit') || content.startsWith('/ai ')) {
        const query    = content.replace('@orbit', '').replace('/ai ', '').trim();
        const history  = db.prepare(
          'SELECT sender_name, content FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 10'
        ).all(roomId).reverse();

        getAIReply(query, history).then(aiReply => {
          const aiMsg = db.prepare(
            'INSERT INTO chat_messages (room_id, sender_id, sender_name, content, type) VALUES (?, ?, ?, ?, ?)'
          ).run(roomId, 'orbit-bot', '🤖 Orbit AI', aiReply, 'ai');

          const botMessage = {
            id: aiMsg.lastInsertRowid,
            room_id: roomId,
            sender_id: 'orbit-bot',
            sender_name: '🤖 Orbit AI',
            content: aiReply,
            type: 'ai',
            created_at: new Date().toISOString(),
          };
          if (typeof broadcastToRoom === 'function') {
            broadcastToRoom(roomId, { type: 'chat_message', message: botMessage });
          }
        }).catch(e => console.warn('[chat/ai]', e.message));
      }
    } catch (e) {
      console.error('[chat/send]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/chat/:roomId/read ───────────────────────────────────────────────
  router.put('/chat/:roomId/read', auth, (req, res) => {
    try {
      const db = getDb();
      db.prepare(
        "UPDATE chat_participants SET last_read = datetime('now') WHERE room_id = ? AND user_id = ?"
      ).run(req.params.roomId, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/chat/:roomId/messages/:msgId ─────────────────────────────────
  router.delete('/chat/:roomId/messages/:msgId', auth, (req, res) => {
    try {
      const db = getDb();
      const msg = db.prepare(
        'SELECT sender_id FROM chat_messages WHERE id = ? AND room_id = ?'
      ).get(req.params.msgId, req.params.roomId);
      if (!msg) return res.status(404).json({ error: 'not found' });
      if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'not your message' });
      db.prepare('DELETE FROM chat_messages WHERE id = ?').run(req.params.msgId);
      if (typeof broadcastToRoom === 'function') {
        broadcastToRoom(req.params.roomId, {
          type: 'chat_delete', messageId: parseInt(req.params.msgId), room_id: req.params.roomId
        });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/chat/quota ──────────────────────────────────────────────────────
  router.get('/chat/quota', auth, (req, res) => {
    try {
      const plan  = getUserPlan(req.user.id);
      const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
      const count = getMessageCount(req.user.id);
      res.json({
        plan,
        count,
        limit: limit === Infinity ? null : limit,
        percent: limit === Infinity ? 0 : Math.round((count / limit) * 100),
        ok: limit === Infinity || count < limit,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
