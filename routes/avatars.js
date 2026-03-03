/**
 * routes/avatars.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 아바타/캐릭터 마켓 API
 *
 * 엔드포인트:
 *   GET  /api/avatars/market         — 공개 아바타 목록 (마켓)
 *   GET  /api/avatars/mine           — 내 아바타 목록 (인증 필요)
 *   GET  /api/avatars/active/:userId — 특정 사용자 활성 아바타
 *   POST /api/avatars                — 새 아바타 등록
 *   POST /api/avatars/:id/activate   — 활성 아바타 변경 (인증 필요)
 *   POST /api/avatars/:id/download   — 다운로드 카운트 증가
 *   POST /api/avatars/:id/rate       — 평점 등록
 *   DELETE /api/avatars/:id          — 아바타 삭제 (본인만)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express     = require('express');
const avatarStore = require('../src/avatar-store');

/**
 * @param {{ optionalAuth, authMiddleware }} deps
 * @returns {express.Router}
 */
function createRouter({ optionalAuth, authMiddleware }) {
  const router = express.Router();

  // ── 마켓 목록 ────────────────────────────────────────────────────────────
  router.get('/avatars/market', (req, res) => {
    const { type, tags, userId, limit, offset } = req.query;
    const list = avatarStore.listMarketAvatars({
      type,
      tags:   tags ? tags.split(',') : undefined,
      userId,
      limit:  parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
    });
    res.json(list);
  });

  // ── 내 아바타 목록 ────────────────────────────────────────────────────────
  router.get('/avatars/mine', authMiddleware, (req, res) => {
    res.json(avatarStore.getUserAvatars(req.user.id));
  });

  // ── 특정 사용자 활성 아바타 ────────────────────────────────────────────────
  router.get('/avatars/active/:userId', (req, res) => {
    const avatar = avatarStore.getActiveAvatar(req.params.userId);
    if (!avatar) return res.status(404).json({ error: 'No active avatar' });
    res.json(avatar);
  });

  // ── 아바타 등록 ────────────────────────────────────────────────────────────
  router.post('/avatars', authMiddleware, (req, res) => {
    const { type, url, name, isPublic, price, tags, thumbnail } = req.body;
    const result = avatarStore.registerAvatar({
      userId: req.user.id,
      type, url, name, isPublic, price, tags, thumbnail,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // ── 활성 아바타 변경 ────────────────────────────────────────────────────────
  router.post('/avatars/:id/activate', authMiddleware, (req, res) => {
    const result = avatarStore.setActiveAvatar(req.user.id, req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // ── 다운로드 카운트 ────────────────────────────────────────────────────────
  router.post('/avatars/:id/download', optionalAuth, (req, res) => {
    res.json(avatarStore.recordAvatarDownload(req.params.id));
  });

  // ── 평점 ──────────────────────────────────────────────────────────────────
  router.post('/avatars/:id/rate', optionalAuth, (req, res) => {
    const { rating } = req.body;
    if (!rating) return res.status(400).json({ error: 'rating required (1-5)' });
    const result = avatarStore.rateAvatar(req.params.id, Number(rating));
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // ── 삭제 ──────────────────────────────────────────────────────────────────
  router.delete('/avatars/:id', authMiddleware, (req, res) => {
    const result = avatarStore.deleteAvatar(req.user.id, req.params.id);
    if (result.error) return res.status(403).json(result);
    res.json(result);
  });

  return router;
}

module.exports = createRouter;
