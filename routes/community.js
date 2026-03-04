/**
 * routes/community.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 커뮤니티 게시판 API 라우터
 *
 * 담당 엔드포인트:
 *   GET  /api/community/posts    - 게시물 목록 조회
 *   POST /api/community/posts    - 새 게시물 등록
 *   POST /api/community/answers  - 게시물에 답변 등록
 *   POST /api/community/accept   - 답변 채택
 *   POST /api/community/vote     - 게시물/답변 추천/비추천
 *   GET  /api/community/similar  - 중복 게시물 검색 (태그 기반)
 *
 * 중복 감지 기능:
 *   새 게시물 작성 전 /api/community/similar?tags=X,Y 를 호출하면
 *   태그가 2개 이상 겹치는 기존 답변 완료 게시물을 최대 3개 반환합니다.
 *   프론트엔드에서 "비슷한 질문에 이미 답변이 있어요" 배너를 표시합니다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.communityStore - src/community-store.js 의 모든 함수
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { communityStore } = deps;
  const { getPosts, addPost, addAnswer, acceptAnswer, votePost, voteAnswer, findSimilar } = communityStore;

  // ── 게시물 목록 ──────────────────────────────────────────────────────────

  /**
   * GET /api/community/posts
   * 전체 게시물 목록을 반환합니다 (최신순).
   * 각 게시물에는 답변 배열(answers)이 포함됩니다.
   * @returns {Post[]}
   */
  router.get('/community/posts', (req, res) => {
    res.json(getPosts());
  });

  /**
   * POST /api/community/posts
   * 새 게시물을 등록합니다.
   * @body {string}   title    - 게시물 제목 (필수)
   * @body {string}   body     - 내용 (Markdown 허용)
   * @body {string}   category - 'question' | 'insight' | 'showcase' | 'feedback'
   * @body {string}   author   - 작성자 이름/ID
   * @body {string[]} [tags]   - 태그 목록
   * @returns {Post}
   */
  router.post('/community/posts', (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title required' });
    res.json(addPost(req.body));
  });

  // ── 답변 ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/community/answers
   * 기존 게시물에 답변을 등록합니다.
   * @body {string} postId - 대상 게시물 ID (필수)
   * @body {string} body   - 답변 내용 (Markdown 허용, 필수)
   * @body {string} author - 작성자 이름/ID
   * @returns {Answer | { error: string }}
   */
  router.post('/community/answers', (req, res) => {
    const { postId, body } = req.body;
    if (!postId || !body) return res.status(400).json({ error: 'postId and body required' });

    const ans = addAnswer(postId, req.body);
    if (!ans) return res.status(404).json({ error: 'post not found' });
    res.json(ans);
  });

  /**
   * POST /api/community/accept
   * 답변을 '채택된 답변'으로 표시합니다.
   * 게시물 작성자만 채택할 수 있도록 프론트엔드에서 권한 검증 필요.
   * @body {string} postId   - 게시물 ID (필수)
   * @body {string} answerId - 채택할 답변 ID (필수)
   * @returns {{ ok: boolean }}
   */
  router.post('/community/accept', (req, res) => {
    const { postId, answerId } = req.body;
    if (!postId || !answerId) return res.status(400).json({ error: 'postId and answerId required' });

    const ok = acceptAnswer(postId, answerId);
    if (!ok) return res.status(404).json({ error: 'post or answer not found' });
    res.json({ ok: true });
  });

  // ── 투표 ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/community/vote
   * 게시물 또는 답변에 추천/비추천을 적용합니다.
   * answerId 가 있으면 답변 투표, 없으면 게시물 투표입니다.
   *
   * @body {string}         postId    - 게시물 ID (필수)
   * @body {'up'|'down'}    direction - 투표 방향 (필수)
   * @body {string}         [answerId] - 답변 ID (답변 투표 시)
   * @returns {{ ok: boolean }}
   */
  router.post('/community/vote', (req, res) => {
    const { postId, answerId, direction } = req.body;
    if (!postId || !direction) return res.status(400).json({ error: 'postId and direction required' });

    if (answerId) {
      voteAnswer(postId, answerId, direction);
    } else {
      votePost(postId, direction);
    }
    res.json({ ok: true });
  });

  // ── 중복 감지 ────────────────────────────────────────────────────────────

  /**
   * GET /api/community/similar?tags=태그1,태그2
   * 태그가 2개 이상 겹치는 기존 답변 완료 게시물을 최대 3개 반환합니다.
   * 게시물 작성 전 중복 게시물 여부를 확인하는 UX 개선 기능입니다.
   *
   * @query {string} tags - 쉼표 구분 태그 목록
   * @returns {Post[]} 유사 게시물 (최대 3개, 추천 수 내림차순)
   */
  router.get('/community/similar', (req, res) => {
    const tags = (req.query.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    res.json(findSimilar(tags));
  });

  return router;
}

module.exports = createRouter;
