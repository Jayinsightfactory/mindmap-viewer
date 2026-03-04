/**
 * routes/themes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 테마 마켓 API 라우터
 *
 * 담당 엔드포인트:
 *   GET    /api/themes          - 전체 테마 목록
 *   GET    /api/themes/:id      - 특정 테마 조회
 *   POST   /api/themes          - 테마 등록
 *   POST   /api/themes/:id/download - 다운로드 수 카운트
 *   POST   /api/themes/:id/rate     - 테마 평점 등록 (1-5)
 *   DELETE /api/themes/:id          - 테마 삭제
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.themeStore - { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { themeStore } = deps;
  const { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme } = themeStore;

  // ── 테마 목록 ────────────────────────────────────────────────────────────

  /**
   * GET /api/themes
   * 마켓에 등록된 전체 테마를 반환합니다 (내장 테마 + 사용자 등록 테마).
   * @returns {Theme[]}
   */
  router.get('/themes', (req, res) => {
    res.json(getAllThemes());
  });

  /**
   * GET /api/themes/:id
   * 특정 테마의 상세 정보를 반환합니다.
   * @param {string} id - 테마 ID
   * @returns {Theme}
   */
  router.get('/themes/:id', (req, res) => {
    const theme = getThemeById(req.params.id);
    if (!theme) return res.status(404).json({ error: 'not found' });
    res.json(theme);
  });

  // ── 테마 등록 ────────────────────────────────────────────────────────────

  /**
   * POST /api/themes
   * 새 테마를 등록합니다. 테마 구조는 theme-store.js 의 스키마를 따릅니다.
   * @body {Theme} 테마 객체 (name, author, colors, fonts 등)
   * @returns {Theme} 등록된 테마 (id, createdAt 포함)
   */
  router.post('/themes', (req, res) => {
    try {
      const theme = registerTheme(req.body);
      res.json(theme);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── 다운로드 / 평점 ──────────────────────────────────────────────────────

  /**
   * POST /api/themes/:id/download
   * 테마 다운로드 수를 1 증가시킵니다.
   * @param {string} id - 테마 ID
   * @returns {{ ok: boolean }}
   */
  router.post('/themes/:id/download', (req, res) => {
    recordDownload(req.params.id);
    res.json({ ok: true });
  });

  /**
   * POST /api/themes/:id/rate
   * 테마에 평점을 등록합니다. 평점은 1.0~5.0 사이 숫자입니다.
   * 내부적으로 누적 평점의 평균을 업데이트합니다.
   * @param {string} id - 테마 ID
   * @body {number} rating - 평점 (1~5)
   * @returns {Theme}
   */
  router.post('/themes/:id/rate', (req, res) => {
    const rating = parseFloat(req.body.rating);
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating 1-5 사이 숫자 필요' });
    }
    const theme = rateTheme(req.params.id, rating);
    res.json(theme || { error: 'not found' });
  });

  // ── 테마 삭제 ────────────────────────────────────────────────────────────

  /**
   * DELETE /api/themes/:id
   * 사용자 등록 테마를 삭제합니다. 내장 테마는 삭제되지 않습니다.
   * @param {string} id - 테마 ID
   * @returns {{ ok: boolean }}
   */
  router.delete('/themes/:id', (req, res) => {
    deleteUserTheme(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = createRouter;
