'use strict';
/**
 * kakao-decrypt.js — 카카오톡 채팅 복호화 + 메시지 분석
 *
 * KakaoTalk PC 버전 채팅 DB 복호화 연구 및 메시지 추출/분석
 *
 * 연구 배경:
 *   - KakaoTalk PC: %LOCALAPPDATA%/Kakao/KakaoTalk/users/{user_hash}/chat_logs.db
 *   - chat_logs 테이블: id, chat_id, user_id, message(encrypted), type, created_at
 *   - 암호화: AES-256-ECB (PBKDF2 키 파생) 또는 XOR (구버전)
 *   - chat_id → chat_room / open_chat 테이블로 채팅방 이름 매핑
 *
 * 엔드포인트:
 *   POST /api/kakao/decrypt    — 암호화된 메시지 배치 복호화
 *   POST /api/kakao/import     — 복호화된 메시지 DB 저장
 *   GET  /api/kakao/messages   — 메시지 조회 (필터: chatroom, userId, dateRange, keyword)
 *   GET  /api/kakao/chatrooms  — 채팅방 목록 + 메시지 수
 *   GET  /api/kakao/stats      — 통계 (총 메시지, 사용자별, 채팅방별, 일별 추이)
 *   POST /api/kakao/analyze    — 주문 패턴 분석 (주문 키워드 감지)
 *   GET  /api/kakao/research   — 복호화 연구 현황
 */
const express = require('express');
const crypto = require('crypto');

function createKakaoDecryptRouter({ getDb }) {
  const router = express.Router();

  // ── 테이블 초기화 ──
  async function _ensureTables(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS kakao_messages (
        id SERIAL PRIMARY KEY,
        chat_id TEXT,
        chatroom TEXT,
        user_id TEXT,
        sender TEXT,
        message TEXT,
        message_type TEXT DEFAULT 'text',
        decryption_method TEXT,
        original_encrypted TEXT,
        source TEXT DEFAULT 'import',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        imported_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS kakao_decrypt_log (
        id SERIAL PRIMARY KEY,
        batch_id TEXT,
        total_count INT DEFAULT 0,
        success_count INT DEFAULT 0,
        fail_count INT DEFAULT 0,
        method TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_kakao_messages_chatroom ON kakao_messages(chatroom)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_kakao_messages_user_id ON kakao_messages(user_id)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_kakao_messages_created_at ON kakao_messages(created_at)
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  // 복호화 함수들
  // ═══════════════════════════════════════════════════════════════

  /**
   * Method 1: AES-256-ECB (PC KakaoTalk 최신 버전)
   * PBKDF2로 userId 기반 키 파생 → AES-256-ECB 복호화
   */
  function decryptAES(encryptedBase64, userId) {
    try {
      const key = crypto.pbkdf2Sync(String(userId), 'salt', 2, 32, 'sha256');
      const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
      decipher.setAutoPadding(true);
      let decrypted = decipher.update(encryptedBuffer);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return { success: true, text: decrypted.toString('utf8'), method: 'aes-256-ecb' };
    } catch (err) {
      return { success: false, error: err.message, method: 'aes-256-ecb' };
    }
  }

  /**
   * Method 2: XOR 기반 (구버전 KakaoTalk)
   * userId 바이트를 반복 XOR
   */
  function decryptXOR(encryptedBase64, userId) {
    try {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyBytes = Buffer.from(String(userId));
      const decryptedBytes = Buffer.from(
        encryptedBytes.map((b, i) => b ^ keyBytes[i % keyBytes.length])
      );
      const text = decryptedBytes.toString('utf8');
      // 유효한 UTF-8 텍스트인지 간단 검증
      if (/[\x00-\x08\x0E-\x1F]/.test(text.substring(0, 50))) {
        return { success: false, error: 'Invalid UTF-8 output (likely wrong method)', method: 'xor' };
      }
      return { success: true, text, method: 'xor' };
    } catch (err) {
      return { success: false, error: err.message, method: 'xor' };
    }
  }

  /**
   * 자동 복호화 — AES 먼저 시도, 실패 시 XOR 시도
   */
  function autoDecrypt(encryptedBase64, userId) {
    const aesResult = decryptAES(encryptedBase64, userId);
    if (aesResult.success) return aesResult;
    const xorResult = decryptXOR(encryptedBase64, userId);
    if (xorResult.success) return xorResult;
    return { success: false, error: 'Both AES and XOR failed', method: 'none', details: { aes: aesResult.error, xor: xorResult.error } };
  }

  // ═══════════════════════════════════════════════════════════════
  // POST /api/kakao/decrypt — 암호화된 메시지 배치 복호화
  // ═══════════════════════════════════════════════════════════════
  router.post('/decrypt', async (req, res) => {
    try {
      const { messages, userId, method } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array required' });
      }
      if (!userId) {
        return res.status(400).json({ error: 'userId required for key derivation' });
      }

      const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const results = [];
      let successCount = 0;
      let failCount = 0;

      for (const msg of messages) {
        const encrypted = typeof msg === 'string' ? msg : msg.encrypted || msg.message;
        if (!encrypted) {
          results.push({ success: false, error: 'empty message', index: results.length });
          failCount++;
          continue;
        }

        let result;
        if (method === 'aes') {
          result = decryptAES(encrypted, userId);
        } else if (method === 'xor') {
          result = decryptXOR(encrypted, userId);
        } else {
          result = autoDecrypt(encrypted, userId);
        }

        result.index = results.length;
        result.originalLength = encrypted.length;
        if (typeof msg === 'object') {
          result.chat_id = msg.chat_id;
          result.sender = msg.sender;
          result.created_at = msg.created_at;
        }
        results.push(result);

        if (result.success) successCount++;
        else failCount++;
      }

      // 복호화 로그 기록
      const db = getDb();
      if (db?.query) {
        try {
          await _ensureTables(db);
          await db.query(
            `INSERT INTO kakao_decrypt_log (batch_id, total_count, success_count, fail_count, method)
             VALUES ($1, $2, $3, $4, $5)`,
            [batchId, messages.length, successCount, failCount, method || 'auto']
          );
        } catch (logErr) {
          console.error('[KakaoDecrypt] log write error:', logErr.message);
        }
      }

      res.json({
        ok: true,
        batchId,
        total: messages.length,
        success: successCount,
        failed: failCount,
        results,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] decrypt error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/kakao/import — 복호화된 메시지 DB 저장
  // ═══════════════════════════════════════════════════════════════
  router.post('/import', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { messages, chatroom, source } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array required' });
      }

      let imported = 0;
      let skipped = 0;

      for (const msg of messages) {
        try {
          const text = msg.message || msg.text || msg.decrypted;
          if (!text) { skipped++; continue; }

          await db.query(
            `INSERT INTO kakao_messages (chat_id, chatroom, user_id, sender, message, message_type, decryption_method, original_encrypted, source, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              msg.chat_id || null,
              msg.chatroom || chatroom || 'unknown',
              msg.user_id || null,
              msg.sender || null,
              text,
              msg.type || 'text',
              msg.decryption_method || null,
              msg.original_encrypted || null,
              source || 'import',
              msg.created_at || new Date().toISOString(),
            ]
          );
          imported++;
        } catch (insertErr) {
          console.error('[KakaoDecrypt] import row error:', insertErr.message);
          skipped++;
        }
      }

      res.json({ ok: true, imported, skipped, total: messages.length });
    } catch (err) {
      console.error('[KakaoDecrypt] import error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/kakao/messages — 메시지 조회 (필터 지원)
  // ═══════════════════════════════════════════════════════════════
  router.get('/messages', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { chatroom, userId, startDate, endDate, keyword, limit, offset } = req.query;
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (chatroom) {
        conditions.push(`chatroom = $${paramIdx++}`);
        params.push(chatroom);
      }
      if (userId) {
        conditions.push(`user_id = $${paramIdx++}`);
        params.push(userId);
      }
      if (startDate) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(startDate);
      }
      if (endDate) {
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(endDate);
      }
      if (keyword) {
        conditions.push(`message ILIKE $${paramIdx++}`);
        params.push(`%${keyword}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const queryLimit = Math.min(parseInt(limit) || 100, 1000);
      const queryOffset = parseInt(offset) || 0;

      const countRes = await db.query(`SELECT COUNT(*) as total FROM kakao_messages ${where}`, params);
      const total = parseInt(countRes.rows[0].total);

      const dataRes = await db.query(
        `SELECT id, chat_id, chatroom, user_id, sender, message, message_type, source, created_at
         FROM kakao_messages ${where}
         ORDER BY created_at DESC
         LIMIT ${queryLimit} OFFSET ${queryOffset}`,
        params
      );

      res.json({
        ok: true,
        total,
        limit: queryLimit,
        offset: queryOffset,
        messages: dataRes.rows,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] messages error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/kakao/chatrooms — 채팅방 목록 + 메시지 수
  // ═══════════════════════════════════════════════════════════════
  router.get('/chatrooms', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const result = await db.query(`
        SELECT
          chatroom,
          COUNT(*) as message_count,
          COUNT(DISTINCT sender) as sender_count,
          COUNT(DISTINCT user_id) as user_count,
          MIN(created_at) as first_message,
          MAX(created_at) as last_message
        FROM kakao_messages
        GROUP BY chatroom
        ORDER BY message_count DESC
      `);

      res.json({
        ok: true,
        count: result.rows.length,
        chatrooms: result.rows,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] chatrooms error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/kakao/stats — 통계 (총 메시지, 사용자별, 채팅방별, 일별 추이)
  // ═══════════════════════════════════════════════════════════════
  router.get('/stats', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const [totalRes, perUserRes, perRoomRes, dailyRes, decryptLogRes] = await Promise.all([
        // 총 메시지 수
        db.query(`SELECT COUNT(*) as total, COUNT(DISTINCT chatroom) as rooms, COUNT(DISTINCT sender) as senders FROM kakao_messages`),
        // 사용자(sender)별 메시지 수
        db.query(`
          SELECT sender, COUNT(*) as message_count, COUNT(DISTINCT chatroom) as room_count
          FROM kakao_messages
          WHERE sender IS NOT NULL
          GROUP BY sender
          ORDER BY message_count DESC
          LIMIT 50
        `),
        // 채팅방별 메시지 수
        db.query(`
          SELECT chatroom, COUNT(*) as message_count
          FROM kakao_messages
          GROUP BY chatroom
          ORDER BY message_count DESC
          LIMIT 50
        `),
        // 일별 메시지 추이 (최근 30일)
        db.query(`
          SELECT DATE(created_at) as date, COUNT(*) as count
          FROM kakao_messages
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `),
        // 복호화 로그
        db.query(`
          SELECT method, SUM(total_count) as total, SUM(success_count) as success, SUM(fail_count) as failed
          FROM kakao_decrypt_log
          GROUP BY method
        `),
      ]);

      res.json({
        ok: true,
        summary: totalRes.rows[0],
        perUser: perUserRes.rows,
        perChatroom: perRoomRes.rows,
        dailyTrend: dailyRes.rows,
        decryptionStats: decryptLogRes.rows,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] stats error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/kakao/analyze — 주문 패턴 분석
  // ═══════════════════════════════════════════════════════════════
  router.post('/analyze', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { chatroom, startDate, endDate, limit: queryLimit } = req.body;

      // 주문 관련 키워드
      const ORDER_KEYWORDS = ['주문', '발주', '보내주세요', '부탁', '추가', '취소', '변경'];
      // 수량 패턴: 숫자 + 단위
      const QUANTITY_REGEX = /(\d+(?:\.\d+)?)\s*(단|박스|개|EA|ea|kg|KG|톤|팩|봉|병|캔|케이스)/g;

      // 메시지 조회
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (chatroom) {
        conditions.push(`chatroom = $${paramIdx++}`);
        params.push(chatroom);
      }
      if (startDate) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(startDate);
      }
      if (endDate) {
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(endDate);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const maxRows = Math.min(parseInt(queryLimit) || 5000, 10000);

      const msgRes = await db.query(
        `SELECT id, chatroom, sender, message, created_at
         FROM kakao_messages ${where}
         ORDER BY created_at DESC
         LIMIT ${maxRows}`,
        params
      );

      // master_products 로드 (있으면)
      let masterProducts = [];
      try {
        const prodRes = await db.query('SELECT name, name_en, name_alias, code, unit FROM master_products');
        masterProducts = prodRes.rows;
      } catch {
        // 마스터 테이블 없으면 무시
      }

      // 주문 후보 추출
      const orderCandidates = [];
      let scanned = 0;

      for (const row of msgRes.rows) {
        scanned++;
        const text = row.message || '';

        // 키워드 매칭
        const matchedKeywords = ORDER_KEYWORDS.filter(kw => text.includes(kw));
        if (matchedKeywords.length === 0) continue;

        // 수량 추출
        const quantities = [];
        let qMatch;
        const qRegex = new RegExp(QUANTITY_REGEX.source, 'g');
        while ((qMatch = qRegex.exec(text)) !== null) {
          quantities.push({ amount: parseFloat(qMatch[1]), unit: qMatch[2] });
        }

        // 마스터 제품 매칭
        const matchedProducts = [];
        for (const prod of masterProducts) {
          const names = [prod.name, prod.name_en, ...(Array.isArray(prod.name_alias) ? prod.name_alias : [])].filter(Boolean);
          for (const name of names) {
            if (text.includes(name)) {
              matchedProducts.push({ name: prod.name, code: prod.code, unit: prod.unit, matchedBy: name });
              break;
            }
          }
        }

        orderCandidates.push({
          messageId: row.id,
          chatroom: row.chatroom,
          sender: row.sender,
          message: text.length > 200 ? text.substring(0, 200) + '...' : text,
          keywords: matchedKeywords,
          quantities,
          products: matchedProducts,
          confidence: _calcOrderConfidence(matchedKeywords, quantities, matchedProducts),
          created_at: row.created_at,
        });
      }

      // 신뢰도 순 정렬
      orderCandidates.sort((a, b) => b.confidence - a.confidence);

      res.json({
        ok: true,
        scanned,
        totalCandidates: orderCandidates.length,
        candidates: orderCandidates.slice(0, 100),
        keywords: ORDER_KEYWORDS,
        masterProductCount: masterProducts.length,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] analyze error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 주문 신뢰도 계산
   */
  function _calcOrderConfidence(keywords, quantities, products) {
    let score = 0;
    // 키워드 점수
    if (keywords.includes('주문') || keywords.includes('발주')) score += 40;
    if (keywords.includes('보내주세요') || keywords.includes('부탁')) score += 30;
    if (keywords.includes('추가') || keywords.includes('변경') || keywords.includes('취소')) score += 20;
    // 수량이 있으면 높은 신뢰도
    if (quantities.length > 0) score += 30;
    // 마스터 제품 매칭
    if (products.length > 0) score += 30;
    return Math.min(score, 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // GET /api/kakao/research — 복호화 연구 현황
  // ═══════════════════════════════════════════════════════════════
  router.get('/research', async (req, res) => {
    try {
      const db = getDb();
      let dbStats = null;

      if (db?.query) {
        try {
          await _ensureTables(db);
          const logRes = await db.query(`
            SELECT method, SUM(total_count) as attempts, SUM(success_count) as successes,
                   ROUND(SUM(success_count)::numeric / NULLIF(SUM(total_count), 0) * 100, 1) as success_rate
            FROM kakao_decrypt_log
            GROUP BY method
          `);
          const msgCount = await db.query('SELECT COUNT(*) as total FROM kakao_messages');
          dbStats = {
            decryptionAttempts: logRes.rows,
            storedMessages: parseInt(msgCount.rows[0].total),
          };
        } catch {
          // DB 에러 무시
        }
      }

      res.json({
        ok: true,
        research: {
          status: 'in_progress',
          lastUpdated: '2026-03-22',
          dbPath: '%LOCALAPPDATA%/Kakao/KakaoTalk/users/{user_hash}/chat_logs.db',
          dbFormat: 'SQLite (encrypted)',
          tableStructure: {
            chat_logs: {
              columns: ['id', 'chat_id', 'user_id', 'message (encrypted)', 'type', 'created_at'],
              encryption: 'AES-256-ECB on message column',
            },
            chat_room: {
              columns: ['id', 'name', 'type', 'member_count'],
              note: 'chat_id maps to chatroom name',
            },
            open_chat: {
              columns: ['id', 'name', 'link', 'member_count'],
              note: 'Open chat rooms (if used)',
            },
          },
          decryptionMethods: [
            {
              name: 'AES-256-ECB',
              version: 'PC KakaoTalk (최신)',
              keyDerivation: 'PBKDF2(userId, "salt", iterations=2, keylen=32, digest=sha256)',
              status: 'implemented',
              notes: 'Most common on recent PC KakaoTalk versions. ECB mode, PKCS padding.',
            },
            {
              name: 'XOR',
              version: 'PC KakaoTalk (구버전)',
              keyDerivation: 'userId bytes repeated as XOR key',
              status: 'implemented',
              notes: 'Simple XOR cipher found in older versions. Less reliable.',
            },
            {
              name: 'AES-256-CBC',
              version: 'Mobile (참고용)',
              keyDerivation: 'Not yet researched for mobile',
              status: 'not_started',
              notes: 'Mobile version may use different encryption. Lower priority.',
            },
          ],
          knownChallenges: [
            'user_hash 폴더명 → userId 매핑 필요',
            'KakaoTalk 버전별 암호화 방식 차이',
            'salt 값이 버전마다 다를 수 있음',
            'PBKDF2 iteration 횟수 정확한 값 확인 필요',
            'DB 파일 접근 시 KakaoTalk 프로세스 종료 필요 (lock)',
          ],
          nextSteps: [
            '직원 PC에서 chat_logs.db 파일 수집',
            'userId 확인 방법 정립',
            '암호화 방식 자동 감지 로직 개선',
            'Vision OCR 결과와 교차 검증',
            '복호화 성공 시 자동 import 파이프라인 구축',
          ],
        },
        dbStats,
      });
    } catch (err) {
      console.error('[KakaoDecrypt] research error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createKakaoDecryptRouter;
