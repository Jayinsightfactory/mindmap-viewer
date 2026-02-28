'use strict';
/**
 * routes/share.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Share My Session — 세션 공개 공유 (read-only viewer)
 *
 * POST /api/share/session/:sessionId   — 공유 링크 생성
 * GET  /api/share/:shareId             — 공유 데이터 조회 (공개)
 * GET  /api/share/:shareId/viewer      — HTML viewer 리다이렉트
 * DELETE /api/share/:shareId           — 공유 취소
 * GET  /api/share/my                   — 내 공유 목록
 * GET  /api/share/featured             — 추천 공유 세션
 * POST /api/share/:shareId/like        — 좋아요
 * POST /api/share/:shareId/comment     — 댓글
 * GET  /api/share/:shareId/comments    — 댓글 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const crypto  = require('crypto');

// ─── 인메모리 공유 스토어 ─────────────────────────────────────────────────────
const shareStore    = new Map();  // shareId → shareEntry
const likeStore     = new Map();  // shareId → Set<ip>
const commentStore  = new Map();  // shareId → comment[]

// ─── 공유 ID 생성 ─────────────────────────────────────────────────────────────
function generateShareId() {
  return crypto.randomBytes(8).toString('base64url');
}

// ─── 공유 데이터 필터링 (민감 정보 제거) ─────────────────────────────────────

function sanitizeEvents(events = [], opts = {}) {
  const { redactFilePaths = true, maxEvents = 200 } = opts;
  return events.slice(0, maxEvents).map(ev => {
    const sanitized = {
      id:        ev.id,
      type:      ev.type,
      source:    ev.source,
      timestamp: ev.timestamp,
      sessionId: ev.sessionId,
    };

    // data 필드에서 경로, 토큰 제거
    if (ev.data) {
      let dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
      if (redactFilePaths) {
        // 절대 경로 마스킹
        dataStr = dataStr.replace(/\/Users\/[^/\s"]+/g,  '~/...');
        dataStr = dataStr.replace(/\/home\/[^/\s"]+/g,   '~/...');
        dataStr = dataStr.replace(/C:\\Users\\[^\\"\s]+/g, 'C:\\...');
      }
      // 토큰/키 마스킹
      dataStr = dataStr.replace(/(sk-[A-Za-z0-9]{10})[A-Za-z0-9-]*/g, '$1***');
      dataStr = dataStr.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
      sanitized.data = dataStr.slice(0, 500);
    }

    return sanitized;
  });
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createShareRouter({ getAllEvents, getSessions, getEventsBySession, insertEvent, broadcastAll, optionalAuth } = {}) {
  const router = express.Router();

  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── 공유 링크 생성 ────────────────────────────────────────────────────
  router.post('/share/session/:sessionId', auth, (req, res) => {
    const { sessionId }     = req.params;
    const {
      title         = '',
      description   = '',
      expiresIn     = 7,       // days, 0 = never
      redactPaths   = true,
      maxEvents     = 200,
      allowComments = true,
      featured      = false,
    } = req.body;

    try {
      // 세션 이벤트 조회
      const sessionEvents = getEventsBySession
        ? getEventsBySession(sessionId)
        : (getAllEvents?.() || []).filter(e => e.sessionId === sessionId);

      if (sessionEvents.length === 0) {
        return res.status(404).json({ error: '세션을 찾을 수 없거나 이벤트가 없습니다.' });
      }

      const shareId = generateShareId();
      const now     = new Date();
      const expiresAt = expiresIn > 0
        ? new Date(now.getTime() + expiresIn * 86400000).toISOString()
        : null;

      // 세션 메타데이터
      const sessionMeta = {
        sessionId,
        eventCount:  sessionEvents.length,
        firstEvent:  sessionEvents[0]?.timestamp,
        lastEvent:   sessionEvents[sessionEvents.length - 1]?.timestamp,
        sources:     [...new Set(sessionEvents.map(e => e.source).filter(Boolean))],
        toolTypes:   [...new Set(sessionEvents.map(e => e.type).filter(Boolean))].slice(0, 10),
      };

      const entry = {
        shareId,
        sessionId,
        createdBy:    req.user?.id || req.ip || 'anonymous',
        title:        title.slice(0, 100) || `Session ${sessionId.slice(0, 8)}`,
        description:  description.slice(0, 500),
        events:       sanitizeEvents(sessionEvents, { redactFilePaths: redactPaths, maxEvents }),
        sessionMeta,
        allowComments,
        featured:     !!featured,
        views:        0,
        likes:        0,
        createdAt:    now.toISOString(),
        expiresAt,
      };

      shareStore.set(shareId, entry);
      commentStore.set(shareId, []);
      likeStore.set(shareId, new Set());

      // 공유 이벤트 기록
      if (insertEvent) {
        insertEvent({
          id:        `share_${shareId}`,
          type:      'share.session.created',
          source:    'orbit-share',
          sessionId: 'share',
          userId:    entry.createdBy,
          channelId: 'default',
          timestamp: now.toISOString(),
          data:      JSON.stringify({ shareId, sessionId, title: entry.title }),
          metadata:  '{}',
        });
      }

      if (broadcastAll) broadcastAll({ type: 'session_shared', shareId, title: entry.title });

      res.json({
        success:   true,
        shareId,
        shareUrl:  `/api/share/${shareId}`,
        viewerUrl: `/orbit-share.html?id=${shareId}`,
        expiresAt,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 공유 데이터 조회 (공개) ───────────────────────────────────────────
  router.get('/share/:shareId', (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).json({ error: '공유 링크를 찾을 수 없습니다.' });

    // 만료 체크
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      shareStore.delete(req.params.shareId);
      return res.status(410).json({ error: '공유 링크가 만료되었습니다.' });
    }

    // 조회수 증가
    entry.views++;
    const { events, ...meta } = entry;
    res.json({ ...meta, events, comments: commentStore.get(req.params.shareId)?.length || 0 });
  });

  // ── HTML 뷰어 리다이렉트 ──────────────────────────────────────────────
  router.get('/share/:shareId/viewer', (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).send('공유 링크를 찾을 수 없습니다.');
    // orbit-timeline.html이 ?share= 파라미터로 공유 데이터를 직접 렌더링
    res.redirect(`/orbit-timeline.html?share=${req.params.shareId}`);
  });

  // ── 공유 취소 ─────────────────────────────────────────────────────────
  router.delete('/share/:shareId', auth, (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).json({ error: '공유 링크를 찾을 수 없습니다.' });

    // 본인 확인 (로컬 모드에서는 스킵)
    const requesterId = req.user?.id || req.ip || 'anonymous';
    if (entry.createdBy !== 'anonymous' && entry.createdBy !== requesterId && requesterId !== req.ip) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    shareStore.delete(req.params.shareId);
    commentStore.delete(req.params.shareId);
    likeStore.delete(req.params.shareId);
    res.json({ success: true });
  });

  // ── 내 공유 목록 ──────────────────────────────────────────────────────
  router.get('/share/my', auth, (req, res) => {
    const userId = req.user?.id || req.ip || 'anonymous';
    const mine   = [...shareStore.values()]
      .filter(e => e.createdBy === userId)
      .map(({ events: _, ...rest }) => ({
        ...rest,
        comments: commentStore.get(rest.shareId)?.length || 0,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ shares: mine, total: mine.length });
  });

  // ── 추천 공유 세션 ────────────────────────────────────────────────────
  router.get('/share/featured', (req, res) => {
    const { limit = 10 } = req.query;
    const featured = [...shareStore.values()]
      .filter(e => {
        if (e.expiresAt && new Date(e.expiresAt) < new Date()) return false;
        return true;
      })
      .map(({ events: _, ...rest }) => ({
        ...rest,
        comments: commentStore.get(rest.shareId)?.length || 0,
      }))
      .sort((a, b) => (b.likes * 3 + b.views) - (a.likes * 3 + a.views))
      .slice(0, Math.min(parseInt(limit) || 10, 50));
    res.json({ featured, total: featured.length });
  });

  // ── 좋아요 ────────────────────────────────────────────────────────────
  router.post('/share/:shareId/like', (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).json({ error: '찾을 수 없습니다.' });

    const likerIp  = req.ip || 'unknown';
    const likers   = likeStore.get(req.params.shareId) || new Set();
    const wasLiked = likers.has(likerIp);

    if (wasLiked) {
      likers.delete(likerIp);
      entry.likes = Math.max(0, entry.likes - 1);
    } else {
      likers.add(likerIp);
      entry.likes++;
    }
    likeStore.set(req.params.shareId, likers);
    res.json({ likes: entry.likes, liked: !wasLiked });
  });

  // ── 댓글 작성 ─────────────────────────────────────────────────────────
  router.post('/share/:shareId/comment', (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).json({ error: '찾을 수 없습니다.' });
    if (!entry.allowComments) return res.status(403).json({ error: '댓글이 비활성화되어 있습니다.' });

    const { text, author = 'Anonymous' } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text 필드가 필요합니다.' });

    const comment = {
      id:        `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      author:    author.slice(0, 30),
      text:      text.slice(0, 300),
      createdAt: new Date().toISOString(),
    };

    const comments = commentStore.get(req.params.shareId) || [];
    comments.push(comment);
    commentStore.set(req.params.shareId, comments);
    res.json({ success: true, comment });
  });

  // ── 댓글 조회 ─────────────────────────────────────────────────────────
  router.get('/share/:shareId/comments', (req, res) => {
    const entry = shareStore.get(req.params.shareId);
    if (!entry) return res.status(404).json({ error: '찾을 수 없습니다.' });
    const comments = commentStore.get(req.params.shareId) || [];
    res.json({ comments, total: comments.length });
  });

  // ── 전체 공유 통계 ────────────────────────────────────────────────────
  router.get('/share', (req, res) => {
    const { limit = 20 } = req.query;
    const all = [...shareStore.values()]
      .filter(e => !e.expiresAt || new Date(e.expiresAt) > new Date())
      .map(({ events: _, ...rest }) => ({
        ...rest,
        comments: commentStore.get(rest.shareId)?.length || 0,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, Math.min(parseInt(limit) || 20, 100));
    res.json({
      shares:    all,
      total:     shareStore.size,
      totalViews: [...shareStore.values()].reduce((s, e) => s + e.views, 0),
      totalLikes: [...shareStore.values()].reduce((s, e) => s + e.likes, 0),
    });
  });

  return router;
}

module.exports = createShareRouter;
