/**
 * routes/annotations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 주석(Annotation) CRUD + 사용자 라벨/카테고리/도구 매핑 API 라우터
 *
 * 담당 엔드포인트:
 *   GET    /api/annotations          - 주석 목록
 *   POST   /api/annotations          - 주석 생성
 *   DELETE /api/annotations/:id      - 주석 삭제
 *   GET    /api/user-config          - 사용자 설정 전체 조회
 *   GET    /api/user-labels          - 노드별 커스텀 라벨 목록
 *   POST   /api/user-labels          - 커스텀 라벨 저장
 *   DELETE /api/user-labels/:eventId - 커스텀 라벨 삭제
 *   GET    /api/user-categories      - 사용자 카테고리 목록
 *   POST   /api/user-categories      - 카테고리 생성/수정
 *   DELETE /api/user-categories/:id  - 카테고리 삭제
 *   GET    /api/tool-mappings        - 도구 라벨 매핑 목록
 *   POST   /api/tool-mappings        - 도구 라벨 매핑 저장
 *   DELETE /api/tool-mappings/:name  - 도구 라벨 매핑 삭제
 *   GET    /api/suggest-label/:id    - AI 라벨 자동 제안
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {Function} deps.broadcastAll        - (msg) → void
 * @param {object}   deps.db                 - DB 모듈
 * @param {Function} deps.db.getAnnotations
 * @param {Function} deps.db.insertAnnotation
 * @param {Function} deps.db.deleteAnnotation
 * @param {Function} deps.db.insertEvent
 * @param {Function} deps.db.getAllEvents
 * @param {Function} deps.db.getUserConfig
 * @param {Function} deps.db.getUserLabels
 * @param {Function} deps.db.setUserLabel
 * @param {Function} deps.db.deleteUserLabel
 * @param {Function} deps.db.getUserCategories
 * @param {Function} deps.db.upsertUserCategory
 * @param {Function} deps.db.deleteUserCategory
 * @param {Function} deps.db.getToolLabelMappings
 * @param {Function} deps.db.setToolLabelMapping
 * @param {Function} deps.db.deleteToolLabelMapping
 * @param {object}   deps.eventNormalizer    - { createAnnotationEvent }
 * @param {object}   deps.graphEngine        - { suggestLabel }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { broadcastAll, db, eventNormalizer, graphEngine } = deps;

  const {
    getAnnotations, insertAnnotation, deleteAnnotation, insertEvent,
    getAllEvents, getUserConfig, getUserLabels, setUserLabel, deleteUserLabel,
    getUserCategories, upsertUserCategory, deleteUserCategory,
    getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping,
  } = db;

  const { createAnnotationEvent } = eventNormalizer;
  const { suggestLabel } = graphEngine;

  // ── 주석 CRUD ─────────────────────────────────────────────────────────────

  /**
   * GET /api/annotations
   * @returns {Annotation[]} 전체 주석 목록
   */
  router.get('/annotations', (req, res) => {
    res.json(getAnnotations());
  });

  /**
   * POST /api/annotations
   * 주석을 생성하고 이벤트로도 기록합니다.
   * @body {string}  [linkedEventId] - 연결할 이벤트 ID
   * @body {string}  [label]         - 라벨 텍스트 (기본값: 'Note')
   * @body {string}  [description]   - 설명
   * @body {string}  [color]         - 색상 HEX (기본값: '#f0c674')
   * @body {string}  [icon]          - 아이콘 문자
   * @returns {{ success: boolean, id: string }}
   */
  router.post('/annotations', (req, res) => {
    const event = createAnnotationEvent(req.body);
    insertEvent(event);
    insertAnnotation({
      id:          event.id,
      eventId:     req.body.linkedEventId || null,
      label:       req.body.label       || 'Note',
      description: req.body.description || '',
      color:       req.body.color       || '#f0c674',
      icon:        req.body.icon        || null,
    });
    res.json({ success: true, id: event.id });
  });

  /**
   * DELETE /api/annotations/:id
   * @param {string} id - 삭제할 주석 ID
   * @returns {{ success: boolean }}
   */
  router.delete('/annotations/:id', (req, res) => {
    deleteAnnotation(req.params.id);
    res.json({ success: true });
  });

  // ── 사용자 설정 전체 ──────────────────────────────────────────────────────

  /**
   * GET /api/user-config
   * 사용자 라벨, 카테고리, 도구 매핑을 하나의 객체로 반환합니다.
   * @returns {UserConfig} { labels, categories, toolMappings }
   */
  router.get('/user-config', (req, res) => {
    res.json(getUserConfig());
  });

  // ── 노드별 커스텀 라벨 ────────────────────────────────────────────────────

  /**
   * GET /api/user-labels
   * @returns {UserLabel[]} 노드별 커스텀 라벨 목록
   */
  router.get('/user-labels', (req, res) => {
    res.json(getUserLabels());
  });

  /**
   * POST /api/user-labels
   * @body {string} eventId      - 대상 이벤트 ID (필수)
   * @body {string} customHeader - 커스텀 헤더 텍스트
   * @body {string} customBody   - 커스텀 본문 텍스트
   * @returns {{ success: boolean }}
   */
  router.post('/user-labels', (req, res) => {
    const { eventId, customHeader, customBody } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    setUserLabel(eventId, customHeader, customBody);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  /**
   * DELETE /api/user-labels/:eventId
   * @param {string} eventId - 삭제할 라벨의 이벤트 ID
   * @returns {{ success: boolean }}
   */
  router.delete('/user-labels/:eventId', (req, res) => {
    deleteUserLabel(req.params.eventId);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  // ── 사용자 카테고리 ──────────────────────────────────────────────────────

  /**
   * GET /api/user-categories
   * @returns {UserCategory[]} 사용자 정의 카테고리 목록
   */
  router.get('/user-categories', (req, res) => {
    res.json(getUserCategories());
  });

  /**
   * POST /api/user-categories
   * 카테고리를 생성하거나 수정합니다 (upsert).
   * @body {string} id   - 카테고리 ID (필수)
   * @body {string} name - 카테고리 이름 (필수)
   * @returns {{ success: boolean }}
   */
  router.post('/user-categories', (req, res) => {
    const cat = req.body;
    if (!cat.id || !cat.name) return res.status(400).json({ error: 'id and name required' });
    upsertUserCategory(cat);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  /**
   * DELETE /api/user-categories/:id
   * @param {string} id - 삭제할 카테고리 ID
   * @returns {{ success: boolean }}
   */
  router.delete('/user-categories/:id', (req, res) => {
    deleteUserCategory(req.params.id);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  // ── 도구 라벨 매핑 ───────────────────────────────────────────────────────

  /**
   * GET /api/tool-mappings
   * @returns {ToolMapping[]} 도구 이름 → 커스텀 라벨 매핑 목록
   */
  router.get('/tool-mappings', (req, res) => {
    res.json(getToolLabelMappings());
  });

  /**
   * POST /api/tool-mappings
   * @body {string} toolName    - 원본 도구 이름 (필수)
   * @body {string} customLabel - 표시할 커스텀 라벨 (필수)
   * @body {string} [customHeader] - 커스텀 헤더
   * @returns {{ success: boolean }}
   */
  router.post('/tool-mappings', (req, res) => {
    const { toolName, customLabel, customHeader } = req.body;
    if (!toolName || !customLabel) return res.status(400).json({ error: 'toolName and customLabel required' });
    setToolLabelMapping(toolName, customLabel, customHeader);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  /**
   * DELETE /api/tool-mappings/:toolName
   * @param {string} toolName - 삭제할 도구 이름
   * @returns {{ success: boolean }}
   */
  router.delete('/tool-mappings/:toolName', (req, res) => {
    deleteToolLabelMapping(req.params.toolName);
    broadcastAll({ type: 'userConfigUpdate', userConfig: getUserConfig() });
    res.json({ success: true });
  });

  // ── AI 라벨 자동 제안 ────────────────────────────────────────────────────

  /**
   * GET /api/suggest-label/:eventId
   * 이벤트 내용을 분석해 적합한 라벨을 자동 제안합니다.
   * @param {string} eventId - 라벨을 제안할 이벤트 ID
   * @returns {{ label: string, confidence: number }}
   */
  router.get('/suggest-label/:eventId', (req, res) => {
    const events = getAllEvents();
    const event  = events.find(e => e.id === req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const suggestion = suggestLabel(event, events);
    res.json(suggestion);
  });

  return router;
}

module.exports = createRouter;
