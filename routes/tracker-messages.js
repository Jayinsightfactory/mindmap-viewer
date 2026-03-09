/**
 * routes/tracker-messages.js
 * ─────────────────────────────────────────────────────────────────
 * 메시지 추적 API 라우터
 *
 * 엔드포인트:
 *   POST /api/tracker/messages/sync         - 수동 메시지 동기화
 *   GET  /api/tracker/messages/summary      - 메시지 통계
 *   GET  /api/tracker/messages/status       - 메시지 서비스 연결 상태
 *   POST /api/tracker/messages/connect/:service    - 서비스 토큰 저장
 *   DELETE /api/tracker/messages/disconnect/:service - 서비스 토큰 삭제
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router = express.Router();
const { trackAllServices, getMessageTrackingStatus } = require('../src/tracker/message-tracker');
const { getServiceToken, saveServiceToken, deleteServiceToken, getUserTokenStatus, getUserServiceTokens } = require('../src/db');

function createRouter({ verifyToken, getValidGoogleTokenForService }) {
  // ── 인증 미들웨어 ────────────────────────────────────────────────
  function authRequired(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });

    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });

    req.user = user;
    next();
  }

  // ── POST /api/tracker/messages/connect/:service ──────────────────
  /**
   * 메시지 서비스 토큰 저장/연결
   */
  router.post('/messages/connect/:service', authRequired, (req, res) => {
    try {
      const { service } = req.params;
      const { accessToken, refreshToken, expiresAt } = req.body;

      if (!accessToken) {
        return res.status(400).json({ error: 'accessToken required' });
      }

      saveServiceToken(req.user.id, service, { accessToken, refreshToken, expiresAt });

      res.json({
        ok: true,
        message: `${service} 서비스 연결됨`,
        service,
        connectedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[tracker-messages/connect]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/tracker/messages/disconnect/:service ──────────────
  /**
   * 메시지 서비스 토큰 삭제/연결 해제
   */
  router.delete('/messages/disconnect/:service', authRequired, (req, res) => {
    try {
      const { service } = req.params;
      deleteServiceToken(req.user.id, service);

      res.json({
        ok: true,
        message: `${service} 연결 해제됨`,
        service,
      });
    } catch (e) {
      console.error('[tracker-messages/disconnect]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/tracker/messages/sync ──────────────────────────────
  /**
   * 수동 메시지 동기화
   * 사용자가 명시적으로 메시지 서비스 데이터를 동기화할 때
   */
  router.post('/messages/sync', authRequired, async (req, res) => {
    try {
      // DB에서 사용자의 메시지 서비스 토큰 조회
      const tokens = getUserServiceTokens(req.user.id);

      // 모든 서비스에서 데이터 수집
      const result = await trackAllServices(tokens);

      res.json({
        ok: true,
        message: 'Message sync completed',
        data: {
          timestamp: result.timestamp,
          totalMessages: result.summary.totalMessages,
          activeServices: result.summary.activeServices,
          services: result.services,
        },
      });
    } catch (e) {
      console.error('[tracker-messages/sync]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/messages/summary ───────────────────────────
  /**
   * 메시지 통계 조회
   */
  router.get('/messages/summary', authRequired, async (req, res) => {
    try {
      // DB에서 사용자의 메시지 서비스 토큰 조회
      const tokens = getUserServiceTokens(req.user.id);

      if (Object.keys(tokens).length === 0) {
        return res.json({
          message: '연결된 메시지 서비스가 없습니다',
          timestamp: new Date().toISOString(),
          services: {},
        });
      }

      // 모든 서비스에서 데이터 수집
      const result = await trackAllServices(tokens);

      res.json({
        timestamp: result.timestamp,
        totalMessages: result.summary.totalMessages,
        activeServices: result.summary.activeServices,
        byService: result.summary.byService,
        services: {
          slack: {
            available: result.services.slack?.available || false,
            channels: result.services.slack?.channels?.length || 0,
            totalMessages: result.services.slack?.totalMessages || 0,
          },
          gmail: {
            available: result.services.gmail?.available || false,
            labels: result.services.gmail?.labels?.length || 0,
            totalMessages: result.services.gmail?.totalMessages || 0,
          },
          teams: {
            available: result.services.teams?.available || false,
            chats: result.services.teams?.chats?.length || 0,
            totalMessages: result.services.teams?.totalMessages || 0,
          },
          discord: {
            available: result.services.discord?.available || false,
            servers: result.services.discord?.servers?.length || 0,
            totalMessages: result.services.discord?.totalMessages || 0,
          },
          kakao: {
            available: result.services.kakao?.available || false,
            chats: result.services.kakao?.chats?.length || 0,
            totalMessages: result.services.kakao?.totalMessages || 0,
          },
        },
      });
    } catch (e) {
      console.error('[tracker-messages/summary]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/messages/status ────────────────────────────
  /**
   * 메시지 서비스 연결 상태 조회
   */
  router.get('/messages/status', authRequired, (req, res) => {
    try {
      // DB에서 사용자의 토큰 상태 조회
      const status = getUserTokenStatus(req.user.id);

      const connectedCount = status.filter(s => s.connected).length;

      res.json({
        connectedServices: connectedCount,
        services: status,
        message: connectedCount > 0
          ? `${connectedCount}개 메시지 서비스 연결됨`
          : '연결된 메시지 서비스가 없습니다',
      });
    } catch (e) {
      console.error('[tracker-messages/status]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
