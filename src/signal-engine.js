/**
 * src/signal-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tesla FSD 방식 원시 신호 감지 엔진
 *
 * 핵심 철학:
 *   기존 방식: 이벤트 → 텍스트 라벨 → 규칙 매칭 (번역 오류 발생)
 *   Tesla 방식: raw 신호 자체를 벡터로 → 패턴 직접 인식 (번역 없음)
 *
 *   Orbit 적용:
 *   - 파일 변경 빈도, 오류 반복 간격, 도구 호출 시퀀스를 raw 숫자 벡터로
 *   - "막힌 상태", "집중 상태", "복잡도 위기"를 신호 패턴 자체로 감지
 *
 * 출력 상태:
 *   - FOCUSED    : 집중 작업 중 (규칙적 간격, 낮은 오류율)
 *   - BLOCKED    : 막힌 상태   (반복 오류, 같은 파일 반복 편집)
 *   - CRISIS     : 복잡도 위기 (급격한 파일 수 증가, 오류 폭증)
 *   - IDLE       : 유휴 상태   (이벤트 없음)
 *   - PRODUCTIVE : 생산적 상태 (완료 이벤트 연속, 진행률 증가)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** 분석에 사용할 최근 이벤트 윈도우 크기 */
const WINDOW_SIZE = 50;

/** 상태 문자열 */
const STATE = {
  FOCUSED:    'FOCUSED',
  BLOCKED:    'BLOCKED',
  CRISIS:     'CRISIS',
  IDLE:       'IDLE',
  PRODUCTIVE: 'PRODUCTIVE',
};

// ─── 세션별 신호 버퍼 ─────────────────────────────────────────────────────────
// Map<sessionId, SignalBuffer>
const _buffers = new Map();

/**
 * 신호 버퍼 초기화 또는 반환
 * @param {string} sessionId
 * @returns {SignalBuffer}
 */
function getBuffer(sessionId) {
  if (!_buffers.has(sessionId)) {
    _buffers.set(sessionId, new SignalBuffer(sessionId));
  }
  return _buffers.get(sessionId);
}

// ─── SignalBuffer ─────────────────────────────────────────────────────────────

class SignalBuffer {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    this.sessionId   = sessionId;
    this.events      = [];          // 최근 N개 이벤트 (raw)
    this.lastAnalysis = null;       // 마지막 분석 결과 캐시
    this.lastTs      = 0;           // 마지막 이벤트 타임스탬프
  }

  /**
   * 이벤트 추가 (FIFO, 최대 WINDOW_SIZE 유지)
   * @param {{ type: string, timestamp: number, data?: object }} event
   */
  push(event) {
    this.events.push({
      type:      event.type || 'unknown',
      ts:        event.timestamp || Date.now(),
      isError:   /error|fail|exception/i.test(event.type || ''),
      isWrite:   /write|edit|create|save/i.test(event.type || ''),
      isRead:    /read|list|search/i.test(event.type || ''),
      isComplete:/complete|done|finish|success/i.test(event.type || ''),
      file:      event.data?.file || event.data?.path || null,
    });
    if (this.events.length > WINDOW_SIZE) this.events.shift();
    this.lastTs = event.timestamp || Date.now();
    this.lastAnalysis = null; // 캐시 무효화
  }

  /** 버퍼의 raw 신호 벡터 추출 (6차원) */
  toVector() {
    const events = this.events;
    if (events.length === 0) return null;

    const now   = Date.now();
    const n     = events.length;

    // ── 1. 이벤트 간격 규칙성 (낮을수록 규칙적 = 집중) ─────────────────
    const intervals = [];
    for (let i = 1; i < n; i++) {
      intervals.push(events[i].ts - events[i - 1].ts);
    }
    const avgInterval  = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const stdInterval  = intervals.length
      ? Math.sqrt(intervals.map(x => (x - avgInterval) ** 2).reduce((a, b) => a + b, 0) / intervals.length)
      : 0;
    const intervalCV   = avgInterval > 0 ? stdInterval / avgInterval : 0; // 변동계수 (낮을수록 규칙적)

    // ── 2. 오류율 (0~1) ────────────────────────────────────────────────
    const errorRate    = events.filter(e => e.isError).length / n;

    // ── 3. 파일 반복 편집율 (같은 파일 연속 편집 비율) ──────────────────
    const fileEdits    = events.filter(e => e.isWrite && e.file);
    const fileSet      = new Set(fileEdits.map(e => e.file));
    const fileRepeatR  = fileEdits.length > 0 && fileSet.size > 0
      ? 1 - (fileSet.size / fileEdits.length)  // 낮을수록 다양한 파일 편집
      : 0;

    // ── 4. 완료율 (0~1) ────────────────────────────────────────────────
    const completeRate = events.filter(e => e.isComplete).length / n;

    // ── 5. 유휴 시간 (마지막 이벤트 이후 경과, 초) ─────────────────────
    const idleSec      = (now - this.lastTs) / 1000;

    // ── 6. 이벤트 밀도 (최근 60초 내 이벤트 수 / 60) ───────────────────
    const recent60     = events.filter(e => (now - e.ts) < 60000).length;
    const density      = Math.min(recent60 / 60, 1);

    return {
      intervalCV,   // 간격 변동계수  (0~∞, 낮을수록 집중)
      errorRate,    // 오류율         (0~1)
      fileRepeatR,  // 파일 반복율    (0~1)
      completeRate, // 완료율         (0~1)
      idleSec,      // 유휴 시간 (초)
      density,      // 이벤트 밀도    (0~1)
      n,            // 샘플 수
    };
  }
}

// ─── 패턴 인식기 ──────────────────────────────────────────────────────────────

/**
 * raw 벡터 → 상태 분류 (규칙 기반 결정 트리, 번역 없음)
 *
 * @param {object} v — toVector() 결과
 * @returns {{ state: string, confidence: number, signals: object }}
 */
function classifyVector(v) {
  if (!v || v.n < 3) {
    return { state: STATE.IDLE, confidence: 1.0, signals: v };
  }

  // 유휴 우선 판단
  if (v.idleSec > 300) { // 5분 이상 이벤트 없음
    return { state: STATE.IDLE, confidence: 0.95, signals: v };
  }

  // 복잡도 위기: 오류율 높고 파일 반복 편집
  if (v.errorRate > 0.35 && v.fileRepeatR > 0.5) {
    const confidence = Math.min(v.errorRate * 1.5 + v.fileRepeatR * 0.5, 1.0);
    return { state: STATE.CRISIS, confidence, signals: v };
  }

  // 막힌 상태: 오류율 높거나 파일 반복 편집 (위기보다 약함)
  if (v.errorRate > 0.20 || (v.fileRepeatR > 0.6 && v.density > 0.1)) {
    const confidence = Math.min(v.errorRate * 2 + v.fileRepeatR * 0.8, 1.0);
    return { state: STATE.BLOCKED, confidence, signals: v };
  }

  // 생산적: 완료율 높고 밀도 있음
  if (v.completeRate > 0.25 && v.density > 0.15) {
    const confidence = Math.min(v.completeRate * 2 + v.density, 1.0);
    return { state: STATE.PRODUCTIVE, confidence, signals: v };
  }

  // 집중: 간격 규칙적이고 오류 낮고 밀도 있음
  if (v.intervalCV < 1.5 && v.errorRate < 0.15 && v.density > 0.05) {
    const confidence = Math.min((1 - v.intervalCV / 3) + (1 - v.errorRate) * 0.5, 1.0);
    return { state: STATE.FOCUSED, confidence, signals: v };
  }

  // 기본: 유휴
  return { state: STATE.IDLE, confidence: 0.6, signals: v };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 이벤트를 신호 버퍼에 기록합니다.
 *
 * @param {string} sessionId
 * @param {{ type: string, timestamp: number, data?: object }} event
 */
function record(sessionId, event) {
  getBuffer(sessionId).push(event);
}

/**
 * 세션의 현재 상태를 분석합니다.
 *
 * @param {string} sessionId
 * @returns {{ state: string, confidence: number, signals: object } | null}
 */
function analyze(sessionId) {
  const buf = _buffers.get(sessionId);
  if (!buf) return { state: STATE.IDLE, confidence: 1.0, signals: null };

  if (buf.lastAnalysis) return buf.lastAnalysis; // 캐시 활용

  const vector = buf.toVector();
  const result = classifyVector(vector);
  buf.lastAnalysis = result;
  return result;
}

/**
 * 모든 활성 세션을 분석합니다.
 *
 * @returns {Map<string, { state: string, confidence: number }>}
 */
function analyzeAll() {
  const results = new Map();
  for (const [sessionId] of _buffers) {
    results.set(sessionId, analyze(sessionId));
  }
  return results;
}

/**
 * 세션 버퍼를 초기화합니다.
 * @param {string} sessionId
 */
function clearSession(sessionId) {
  _buffers.delete(sessionId);
}

/**
 * 상태 코드를 UI 표시용 한국어 레이블로 변환합니다.
 * @param {string} state
 * @returns {{ label: string, color: string, emoji: string }}
 */
function stateLabel(state) {
  const map = {
    [STATE.FOCUSED]:    { label: '집중 중',     color: '#3fb950', emoji: '🎯' },
    [STATE.BLOCKED]:    { label: '막힌 상태',   color: '#f0883e', emoji: '🚧' },
    [STATE.CRISIS]:     { label: '위기',         color: '#f85149', emoji: '🔥' },
    [STATE.IDLE]:       { label: '대기',         color: '#6e7681', emoji: '💤' },
    [STATE.PRODUCTIVE]: { label: '생산적',       color: '#58a6ff', emoji: '⚡' },
  };
  return map[state] || { label: state, color: '#8b949e', emoji: '●' };
}

// ─── Express 라우터 헬퍼 ──────────────────────────────────────────────────────

/**
 * server.js에서 use할 Express 라우터를 반환합니다.
 * GET  /api/signal/:sessionId  → 단일 세션 분석
 * GET  /api/signal             → 전체 세션 분석
 * POST /api/signal/record      → 이벤트 기록 (외부에서 직접 호출 시)
 */
function createRouter() {
  const { Router } = require('express');
  const router = Router();

  router.get('/:sessionId', (req, res) => {
    const result = analyze(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, ...result, ui: stateLabel(result.state) });
  });

  router.get('/', (_req, res) => {
    const all = analyzeAll();
    const out = {};
    for (const [sid, r] of all) {
      out[sid] = { ...r, ui: stateLabel(r.state) };
    }
    res.json(out);
  });

  router.post('/record', (req, res) => {
    const { sessionId, event } = req.body || {};
    if (!sessionId || !event) {
      return res.status(400).json({ error: 'sessionId and event required' });
    }
    record(sessionId, event);
    res.json({ ok: true });
  });

  return router;
}

// ─── 내보내기 ─────────────────────────────────────────────────────────────────
module.exports = { record, analyze, analyzeAll, clearSession, stateLabel, STATE, createRouter };
