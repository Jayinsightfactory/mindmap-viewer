/**
 * routes/data-intelligence.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터 수집 전략 자가발전 에이전트
 *
 * 목적:
 *   "어떤 데이터를 어떻게 모아야 가장 정확한 업무 인사이트가 나오는지"를
 *   스스로 분석·학습하여 데이터 파이프라인 품질을 평가하고
 *   개선 방향을 제시 + 일부는 자동 적용하는 메타 학습 에이전트.
 *
 * 핵심 분석:
 *   1. 캡처 품질 점수 (trigger별 0~100점)
 *   2. 커버리지 분석 (업무시간 Vision 비율, 앱별 밀도)
 *   3. 낭비된 캡처 탐지 (Vision 미처리 / 중복 / 유휴)
 *   4. 교차검증 신뢰도 (keyboard.chunk ↔ screen.analyzed 앱 일치율)
 *   5. 미수집 업무 갭 (화훼도매 기준 하드코딩 + 동적 감지)
 *   6. 개선 권고 생성 (분석 결과 기반 자동 계산)
 *   7. 자동 적용 (품질점수 차이 30점 이상 → capture-config 업데이트)
 *
 * API:
 *   GET  /api/data-intel/quality?days=7       — trigger별 캡처 품질 점수
 *   GET  /api/data-intel/coverage?days=7      — 앱/시간대별 커버리지 분석
 *   GET  /api/data-intel/gaps                 — 미수집 업무 갭 목록
 *   GET  /api/data-intel/recommendations      — 개선 권고 (자동계산)
 *   POST /api/data-intel/evolve               — 분석 실행 + 권고 저장 (수동 트리거)
 *   GET  /api/data-intel/evolution-log        — 자가발전 이력 (PG events 조회)
 *
 * 스케줄러:
 *   서버 시작 1시간 후 첫 실행 → 이후 24시간 주기 자동 실행
 *   품질점수 차이 30점 이상인 trigger → capture-config 자동 업데이트
 *
 * Export: module.exports = ({ pool }) => router
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** 업무시간 (KST 09~18시) */
const WORK_HOURS = new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]);

/** 기본 분석 기간 */
const DEFAULT_DAYS = 7;

/** 자동 적용 품질점수 임계값 — 이 점수 미만이면 cooltime 증가 자동 적용 */
const AUTO_APPLY_THRESHOLD = 30;

/** cooltime 조정 배율 */
const COOLTIME_REDUCE_FACTOR = 0.7;  // 고품질 trigger: cooltime 줄이기
const COOLTIME_EXPAND_FACTOR = 1.5;  // 저품질 trigger: cooltime 늘리기

/** 화훼도매 업무 미수집 갭 정의 */
const KNOWN_GAPS = [
  {
    id: 'phone_call',
    name: '전화 통화',
    description: '공급업체/고객과의 전화 주문/확인',
    currentData: '없음',
    impact: 'HIGH',
    solution: '통화 앱(통화녹음) 또는 CRM 시스템 연동',
    detectionHint: '현재 입력 없이 5분+ 경과 = 전화 중일 가능성',
  },
  {
    id: 'paper_work',
    name: '수기 메모/발주서',
    description: '종이 발주서, 수기 메모',
    currentData: '없음',
    impact: 'MEDIUM',
    solution: '스캔 또는 사진 첨부 기능 추가',
    detectionHint: null,
  },
  {
    id: 'nenova_print',
    name: '청구서/발주서 출력',
    description: 'nenova에서 청구서 PDF 출력',
    currentData: '부분 (Vision으로 감지 가능)',
    impact: 'MEDIUM',
    solution: '인쇄 이벤트 감지 (Ctrl+P 감지)',
    detectionHint: 'keyboard.chunk에서 ctrl+p 패턴 감지',
  },
  {
    id: 'supplier_web',
    name: '공급업체 웹사이트',
    description: '인터넷에서 공급업체 가격표/재고 확인',
    currentData: '브라우저 URL 미수집',
    impact: 'HIGH',
    solution: 'Chrome URL 수집 활성화 (현재 비활성)',
    detectionHint: 'Chrome 앱 Vision 캡처에서 URL바 패턴',
  },
  {
    id: 'excel_formula',
    name: 'Excel 수식/함수 작업',
    description: '엑셀 수식 입력 중인 화면',
    currentData: '키보드는 있으나 Vision 캡처 미흡',
    impact: 'MEDIUM',
    solution: 'Ctrl+Enter (수식 확정) 시 즉시 캡처',
    detectionHint: 'keyboard.chunk에서 ctrl+enter 패턴',
  },
];

// ─── 팩토리 ──────────────────────────────────────────────────────────────────

module.exports = function createDataIntelligenceRouter({ pool }) {
  const router = express.Router();

  // pool 유효성 확인 헬퍼
  function hasPool() {
    return pool && typeof pool.query === 'function';
  }

  // ── 1. trigger별 캡처 품질 계산 ────────────────────────────────────────────

  /**
   * trigger별 캡처 품질 점수 집계 (0~100점)
   * 각 screen.capture 이벤트에 대해:
   *   +40: Vision 분석(screen.analyzed) 매칭
   *   +20: activity 필드 의미 있음
   *   +10: automatable 필드 설정됨
   *   +15: ±60초 내 keyboard.chunk 존재
   *   +10: ±30초 내 mouse.click 존재
   *   +5 : data_json에 order/주문/invoice 키워드
   *
   * @param {number} days
   * @returns {Promise<Array>}
   */
  async function calcTriggerQuality(days = DEFAULT_DAYS) {
    if (!hasPool()) return [];

    try {
      // 1단계: 기간 내 screen.capture 이벤트 조회 (LIMIT 2000)
      const { rows: captures } = await pool.query(`
        SELECT
          id,
          user_id,
          data_json,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'screen.capture'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
        ORDER BY timestamp DESC
        LIMIT 2000
      `, [days]);

      if (!captures.length) return [];

      // 2단계: 같은 기간 screen.analyzed 이벤트 (±60초 매칭용)
      const { rows: analyzed } = await pool.query(`
        SELECT
          user_id,
          data_json,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
        ORDER BY timestamp DESC
        LIMIT 5000
      `, [days]);

      // 3단계: keyboard.chunk 이벤트 (±60초 매칭용)
      const { rows: kbChunks } = await pool.query(`
        SELECT
          user_id,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'keyboard.chunk'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
        ORDER BY timestamp DESC
        LIMIT 10000
      `, [days]);

      // 4단계: mouse.click 이벤트 (±30초 매칭용)
      const { rows: clicks } = await pool.query(`
        SELECT
          user_id,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'mouse.click'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
        ORDER BY timestamp DESC
        LIMIT 10000
      `, [days]);

      // trigger별 점수 누적
      const triggerMap = {};

      for (const cap of captures) {
        let data = {};
        try { data = typeof cap.data_json === 'string' ? JSON.parse(cap.data_json) : (cap.data_json || {}); } catch {}

        const trigger = data.trigger || 'unknown';
        const capTs = new Date(cap.ts).getTime();
        const uid = cap.user_id;

        let score = 0;

        // +40: Vision 분석 매칭 (같은 user_id, ±60초 내)
        const hasAnalyzed = analyzed.some(a =>
          a.user_id === uid &&
          Math.abs(new Date(a.ts).getTime() - capTs) <= 60000
        );
        if (hasAnalyzed) score += 40;

        // +20: activity 필드 의미 있음
        const activity = data.activity || data.currentActivity || '';
        if (activity && activity !== 'idle' && activity.length > 2) score += 20;

        // +10: automatable 필드 설정됨
        if (data.automatable !== undefined && data.automatable !== null) score += 10;

        // +15: ±60초 내 keyboard.chunk
        const hasKb = kbChunks.some(k =>
          k.user_id === uid &&
          Math.abs(new Date(k.ts).getTime() - capTs) <= 60000
        );
        if (hasKb) score += 15;

        // +10: ±30초 내 mouse.click
        const hasMouse = clicks.some(m =>
          m.user_id === uid &&
          Math.abs(new Date(m.ts).getTime() - capTs) <= 30000
        );
        if (hasMouse) score += 10;

        // +5: 비즈니스 키워드 (order/주문/invoice)
        const raw = JSON.stringify(data).toLowerCase();
        if (/order|주문|invoice/.test(raw)) score += 5;

        // 최대 100점 캡
        score = Math.min(100, score);

        if (!triggerMap[trigger]) {
          triggerMap[trigger] = { trigger, totalScore: 0, count: 0, avgCooltime: 0 };
        }
        triggerMap[trigger].totalScore += score;
        triggerMap[trigger].count += 1;

        // cooltime 수집 (data.cooltime 있으면)
        if (data.cooltime) {
          triggerMap[trigger].avgCooltime =
            (triggerMap[trigger].avgCooltime * (triggerMap[trigger].count - 1) + data.cooltime) /
            triggerMap[trigger].count;
        }
      }

      return Object.values(triggerMap).map(t => ({
        trigger: t.trigger,
        avgScore: Math.round(t.totalScore / t.count),
        count: t.count,
        avgCooltime: Math.round(t.avgCooltime),
      })).sort((a, b) => b.avgScore - a.avgScore);

    } catch (e) {
      console.warn('[data-intel] calcTriggerQuality 오류:', e.message);
      return [];
    }
  }

  // ── 2. 앱/시간대별 커버리지 분석 ────────────────────────────────────────────

  /**
   * 커버리지 분석
   *   - 업무시간(09~18시 KST) 중 Vision 분석 있는 시간대 비율
   *   - keyboard.chunk 대비 Vision 캡처 존재 비율
   *   - 앱별 데이터 밀도 (events_per_hour per app)
   *
   * @param {number} days
   * @returns {Promise<Object>}
   */
  async function calcCoverage(days = DEFAULT_DAYS) {
    if (!hasPool()) return { workHourCoverage: 0, kbToCaptureRatio: 0, appDensity: [] };

    try {
      // 업무시간 Vision 분석 시간대 비율
      // KST = UTC+9 → EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Seoul')
      const { rows: hourRows } = await pool.query(`
        SELECT
          EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') AS hour,
          COUNT(*) AS cnt
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
        GROUP BY 1
        ORDER BY 1
      `, [days]);

      const workHourAnalyzed = hourRows.filter(r => WORK_HOURS.has(Number(r.hour)));
      const workHourCoverage = workHourAnalyzed.length / WORK_HOURS.size;

      // keyboard.chunk 대비 Vision 캡처 비율
      const { rows: kbTotal } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM events
        WHERE type = 'keyboard.chunk'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
      `, [days]);

      const { rows: capTotal } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
      `, [days]);

      const kbCount = Number(kbTotal[0]?.cnt || 0);
      const capCount = Number(capTotal[0]?.cnt || 0);
      const kbToCaptureRatio = kbCount > 0 ? Math.round((capCount / kbCount) * 100) : 0;

      // 앱별 데이터 밀도 (events per hour)
      // data_json->>'app' 또는 data_json->>'appContext'->>'app'
      const { rows: appRows } = await pool.query(`
        SELECT
          COALESCE(
            data_json::jsonb->>'app',
            data_json::jsonb->'appContext'->>'app',
            'unknown'
          ) AS app,
          COUNT(*) AS event_count,
          ROUND(
            COUNT(*)::numeric /
            GREATEST(($1)::numeric * 24, 1),
            2
          ) AS events_per_hour
        FROM events
        WHERE type IN ('screen.analyzed', 'keyboard.chunk', 'mouse.click')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
          AND data_json IS NOT NULL
        GROUP BY 1
        ORDER BY event_count DESC
        LIMIT 30
      `, [days]);

      // browser.navigation 이벤트 수 (Chrome URL 수집 여부 판단)
      const { rows: navRows } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM events
        WHERE type = 'browser.navigation'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
      `, [days]);
      const browserNavCount = Number(navRows[0]?.cnt || 0);

      return {
        workHourCoverage: Math.round(workHourCoverage * 100),
        workHourDistribution: hourRows.map(r => ({ hour: Number(r.hour), count: Number(r.cnt) })),
        kbToCaptureRatio,
        kbCount,
        capCount,
        browserNavCount,
        appDensity: appRows.map(r => ({
          app: r.app,
          eventCount: Number(r.event_count),
          eventsPerHour: Number(r.events_per_hour),
        })),
      };

    } catch (e) {
      console.warn('[data-intel] calcCoverage 오류:', e.message);
      return { workHourCoverage: 0, kbToCaptureRatio: 0, appDensity: [], browserNavCount: 0 };
    }
  }

  // ── 3. 낭비된 캡처 탐지 ─────────────────────────────────────────────────────

  /**
   * 낭비된 캡처 탐지
   *   - Vision 처리 실패/미처리 캡처
   *   - 연속 동일 화면 캡처 (같은 windowTitle, 60초 내)
   *   - 유휴 상태 캡처 (activity='idle')
   *
   * @param {number} days
   * @returns {Promise<Object>}
   */
  async function calcWastedCaptures(days = DEFAULT_DAYS) {
    if (!hasPool()) return { unanalyzedCount: 0, duplicateCount: 0, idleCount: 0 };

    try {
      // 1) Vision 미처리 캡처 수
      const { rows: unanalyzedRows } = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM events cap
        WHERE cap.type = 'screen.capture'
          AND cap.timestamp::timestamptz > NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM events an
            WHERE an.type = 'screen.analyzed'
              AND an.user_id = cap.user_id
              AND an.timestamp::timestamptz BETWEEN
                cap.timestamp::timestamptz - interval '60 seconds'
                AND cap.timestamp::timestamptz + interval '60 seconds'
          )
      `, [days]);

      // 2) 유휴 상태 캡처 (data_json->activity = 'idle')
      const { rows: idleRows } = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM events
        WHERE type = 'screen.capture'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
          AND (
            data_json::jsonb->>'activity' = 'idle'
            OR data_json::jsonb->>'trigger' = 'idle_result'
          )
      `, [days]);

      // 3) 연속 중복 캡처 (같은 windowTitle, 60초 내)
      // 같은 user_id + 같은 windowTitle이 60초 간격으로 반복
      const { rows: dupRows } = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM (
          SELECT
            user_id,
            data_json::jsonb->>'windowTitle' AS wt,
            timestamp::timestamptz AS ts,
            LAG(timestamp::timestamptz) OVER (
              PARTITION BY user_id, data_json::jsonb->>'windowTitle'
              ORDER BY timestamp::timestamptz
            ) AS prev_ts
          FROM events
          WHERE type = 'screen.capture'
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
            AND data_json::jsonb->>'windowTitle' IS NOT NULL
        ) sub
        WHERE EXTRACT(EPOCH FROM (ts - prev_ts)) < 60
      `, [days]);

      return {
        unanalyzedCount: Number(unanalyzedRows[0]?.cnt || 0),
        idleCount: Number(idleRows[0]?.cnt || 0),
        duplicateCount: Number(dupRows[0]?.cnt || 0),
      };

    } catch (e) {
      console.warn('[data-intel] calcWastedCaptures 오류:', e.message);
      return { unanalyzedCount: 0, duplicateCount: 0, idleCount: 0 };
    }
  }

  // ── 4. 교차검증 신뢰도 ──────────────────────────────────────────────────────

  /**
   * keyboard.chunk의 appContext.app 과 screen.analyzed의 app 일치율
   * → 높을수록 trigger 타이밍 동기화 양호
   *
   * @param {number} days
   * @returns {Promise<Object>}
   */
  async function calcCrossValidation(days = DEFAULT_DAYS) {
    if (!hasPool()) return { matchRate: 0, total: 0, matched: 0 };

    try {
      // keyboard.chunk와 가장 가까운 screen.analyzed 앱 비교
      // (±30초 이내 매칭)
      const { rows: kbRows } = await pool.query(`
        SELECT
          user_id,
          data_json::jsonb->'appContext'->>'app' AS kb_app,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'keyboard.chunk'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
          AND data_json::jsonb->'appContext'->>'app' IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 2000
      `, [days]);

      if (!kbRows.length) return { matchRate: 0, total: 0, matched: 0 };

      // screen.analyzed 최근 N일치 (매칭 검색용)
      const { rows: anRows } = await pool.query(`
        SELECT
          user_id,
          data_json::jsonb->>'app' AS an_app,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::interval
          AND data_json::jsonb->>'app' IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 5000
      `, [days]);

      let matched = 0;
      let total = 0;

      for (const kb of kbRows) {
        const kbTs = new Date(kb.ts).getTime();
        const kbApp = (kb.kb_app || '').toLowerCase().trim();
        if (!kbApp) continue;

        const nearest = anRows.find(a =>
          a.user_id === kb.user_id &&
          Math.abs(new Date(a.ts).getTime() - kbTs) <= 30000
        );

        if (nearest) {
          total++;
          const anApp = (nearest.an_app || '').toLowerCase().trim();
          if (anApp && (anApp.includes(kbApp) || kbApp.includes(anApp))) {
            matched++;
          }
        }
      }

      const matchRate = total > 0 ? Math.round((matched / total) * 100) : 0;

      return { matchRate, total, matched };

    } catch (e) {
      console.warn('[data-intel] calcCrossValidation 오류:', e.message);
      return { matchRate: 0, total: 0, matched: 0 };
    }
  }

  // ── 5. 미수집 갭 (하드코딩 + 동적 감지) ─────────────────────────────────────

  /**
   * 미수집 업무 갭 목록 반환
   * KNOWN_GAPS + 커버리지 데이터 기반 동적 갭 추가
   *
   * @param {Object} coverageData
   * @returns {Array}
   */
  function calcGaps(coverageData = {}) {
    const gaps = [...KNOWN_GAPS];

    // 동적 갭: browser.navigation 이벤트 수집 여부 확인
    const appDensity = coverageData.appDensity || [];
    const chromeData = appDensity.find(a =>
      (a.app || '').toLowerCase().includes('chrome') ||
      (a.app || '').toLowerCase().includes('browser')
    );
    const browserNavCount = coverageData.browserNavCount || 0;
    if (browserNavCount > 0) {
      // browser.navigation 이벤트가 있으면 supplier_web 갭 해결됨
      const existing = gaps.find(g => g.id === 'supplier_web');
      if (existing) {
        existing.detectedGap = false;
        existing.currentData = `browser.navigation ${browserNavCount}건 수집 중`;
        existing.impact = 'LOW';
      }
    } else if (!chromeData || chromeData.eventsPerHour < 1) {
      const existing = gaps.find(g => g.id === 'supplier_web');
      if (existing) {
        existing.detectedGap = true;
        existing.currentEventsPerHour = chromeData?.eventsPerHour || 0;
      }
    }

    // 동적 갭: 업무시간 커버리지가 50% 미만이면 심각도 표시
    if (coverageData.workHourCoverage < 50) {
      gaps.push({
        id: 'low_work_hour_coverage',
        name: '업무시간 Vision 커버리지 부족',
        description: `업무시간(09~18시) 중 Vision 분석 시간대 ${coverageData.workHourCoverage}% — 절반 이상 누락`,
        currentData: `${coverageData.workHourCoverage}% 커버`,
        impact: 'HIGH',
        solution: 'keyboard_flush / active_window 트리거 빈도 증가',
        detectionHint: '동적 감지',
        dynamic: true,
      });
    }

    return gaps;
  }

  // ── 6. 권고 생성 ─────────────────────────────────────────────────────────────

  /**
   * 분석 결과 기반 개선 권고 생성
   *
   * @param {Array}  quality   — calcTriggerQuality 결과
   * @param {Object} coverage  — calcCoverage 결과
   * @param {Object} crossVal  — calcCrossValidation 결과
   * @param {Object} wasted    — calcWastedCaptures 결과
   * @returns {Array}
   */
  function generateRecommendations(quality = [], coverage = {}, crossVal = {}, wasted = {}) {
    const recs = [];

    // trigger 품질 기반 권고
    quality.forEach(q => {
      if (q.avgScore < 40) {
        recs.push({
          type: 'REDUCE_TRIGGER',
          trigger: q.trigger,
          reason: `품질점수 ${q.avgScore}점 — 의미없는 캡처 많음`,
          action: q.avgCooltime > 0
            ? `cooltime ${q.avgCooltime}ms → ${Math.round(q.avgCooltime * COOLTIME_EXPAND_FACTOR)}ms`
            : 'trigger 빈도 50% 감소 권고',
          autoApply: q.avgScore < AUTO_APPLY_THRESHOLD,
          priority: q.avgScore < AUTO_APPLY_THRESHOLD ? 'CRITICAL' : 'HIGH',
          newCooltime: q.avgCooltime > 0 ? Math.round(q.avgCooltime * COOLTIME_EXPAND_FACTOR) : null,
        });
      }

      if (q.avgScore > 75 && q.count < 10) {
        recs.push({
          type: 'INCREASE_TRIGGER',
          trigger: q.trigger,
          reason: `품질점수 ${q.avgScore}점 — 의미있는 캡처, 더 자주 해도 됨`,
          action: q.avgCooltime > 0
            ? `cooltime ${q.avgCooltime}ms → ${Math.round(q.avgCooltime * COOLTIME_REDUCE_FACTOR)}ms`
            : 'trigger 빈도 30% 증가 권고',
          autoApply: false,
          priority: 'MEDIUM',
          newCooltime: q.avgCooltime > 0 ? Math.round(q.avgCooltime * COOLTIME_REDUCE_FACTOR) : null,
        });
      }
    });

    // 교차검증 낮으면 타이밍 이슈 권고
    if (crossVal.matchRate < 60 && crossVal.total > 10) {
      recs.push({
        type: 'TIMING_ISSUE',
        reason: `Vision-키보드 교차검증 ${crossVal.matchRate}% (${crossVal.matched}/${crossVal.total}) — trigger 타이밍 불일치`,
        action: 'keyboard_flush 딜레이 1.5s → 3s (화면 렌더링 대기 필요)',
        autoApply: false,
        priority: 'HIGH',
        newCooltime: null,
      });
    }

    // 낭비 캡처 많으면 권고
    if (wasted.unanalyzedCount > 50) {
      recs.push({
        type: 'VISION_WORKER_LAG',
        reason: `Vision 미처리 캡처 ${wasted.unanalyzedCount}건 — Vision 워커 지연 또는 누락`,
        action: 'Vision 워커 상태 확인 + bin/vision-worker.js 재시작',
        autoApply: false,
        priority: 'HIGH',
        newCooltime: null,
      });
    }

    if (wasted.duplicateCount > 30) {
      recs.push({
        type: 'DUPLICATE_CAPTURES',
        reason: `연속 중복 캡처 ${wasted.duplicateCount}건 — 동일 화면 60초 내 반복 캡처`,
        action: 'screen.capture cooltime 최소값 90s → 120s 권고',
        autoApply: false,
        priority: 'MEDIUM',
        newCooltime: null,
      });
    }

    if (wasted.idleCount > 100) {
      recs.push({
        type: 'IDLE_WASTE',
        reason: `유휴 상태 캡처 ${wasted.idleCount}건 — idle_result trigger 과다`,
        action: 'idle_result trigger cooltime 증가 또는 완전 비활성화 검토',
        autoApply: false,
        priority: 'LOW',
        newCooltime: null,
      });
    }

    // 업무시간 커버리지 낮으면 권고
    if ((coverage.workHourCoverage || 0) < 60) {
      recs.push({
        type: 'LOW_WORK_COVERAGE',
        reason: `업무시간 Vision 커버리지 ${coverage.workHourCoverage}% — 업무 데이터 절반 이상 누락`,
        action: 'keyboard_flush / active_window 트리거 활성화 또는 cooltime 단축',
        autoApply: false,
        priority: 'CRITICAL',
        newCooltime: null,
      });
    }

    return recs;
  }

  // ── 7. 자동 적용 (capture-config 업데이트 명령 전송) ─────────────────────────

  /**
   * 자동 적용 가능한 권고를 orbit_daemon_commands에 INSERT
   * (품질점수 AUTO_APPLY_THRESHOLD 미만 trigger의 cooltime 증가)
   *
   * @param {Array} recs  — generateRecommendations 결과
   * @param {Array} quality — calcTriggerQuality 결과 (hostname 조회용)
   * @returns {Promise<number>} 적용된 명령 수
   */
  async function applyAutoRecommendations(recs, quality) {
    if (!hasPool()) return 0;

    const autoRecs = recs.filter(r => r.autoApply && r.newCooltime);
    if (!autoRecs.length) return 0;

    // 활성 사용자 hostname 조회 (최근 7일 내 이벤트가 있는 고유 hostname)
    let hostnames = [];
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT
          data_json::jsonb->>'hostname' AS hostname
        FROM events
        WHERE timestamp::timestamptz > NOW() - interval '7 days'
          AND data_json::jsonb->>'hostname' IS NOT NULL
        LIMIT 50
      `);
      hostnames = rows.map(r => r.hostname).filter(Boolean);
    } catch (e) {
      console.warn('[data-intel] hostname 조회 실패:', e.message);
    }

    if (!hostnames.length) return 0;

    let applied = 0;

    for (const rec of autoRecs) {
      const configPatch = {
        triggerAdjustments: {
          [rec.trigger]: { cooltime: rec.newCooltime },
        },
        reason: rec.reason,
        appliedBy: 'data-intel-auto',
        appliedAt: new Date().toISOString(),
      };

      for (const hostname of hostnames) {
        try {
          await pool.query(
            `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
             VALUES ($1, 'capture-config', 'update-trigger-cooltime', $2, NOW())`,
            [hostname, JSON.stringify(configPatch)]
          );
          applied++;
        } catch (e) {
          console.warn('[data-intel] capture-config INSERT 실패:', hostname, e.message);
        }
      }
    }

    return applied;
  }

  // ── 8. 자동 발전 실행 (분석 + 저장 + 선택적 적용) ────────────────────────────

  /**
   * 전체 분석 실행 → events 테이블에 'data.intel.report' 타입으로 저장
   * → autoApply 권고 자동 적용
   *
   * @param {number} days
   * @returns {Promise<Object>} 분석 결과 요약
   */
  async function runEvolution(days = DEFAULT_DAYS) {
    console.log('[data-intel] 자가발전 분석 시작...');

    const [quality, coverage, crossVal, wasted] = await Promise.all([
      calcTriggerQuality(days),
      calcCoverage(days),
      calcCrossValidation(days),
      calcWastedCaptures(days),
    ]);

    const gaps = calcGaps(coverage);
    const recommendations = generateRecommendations(quality, coverage, crossVal, wasted);

    const report = {
      generatedAt: new Date().toISOString(),
      analyzedDays: days,
      quality,
      coverage,
      crossValidation: crossVal,
      wastedCaptures: wasted,
      gaps,
      recommendations,
      summary: {
        triggerCount: quality.length,
        avgQuality: quality.length > 0
          ? Math.round(quality.reduce((s, q) => s + q.avgScore, 0) / quality.length)
          : 0,
        workHourCoverage: coverage.workHourCoverage,
        crossValMatchRate: crossVal.matchRate,
        totalRecommendations: recommendations.length,
        autoApplyCount: recommendations.filter(r => r.autoApply).length,
        highPriorityCount: recommendations.filter(r => r.priority === 'CRITICAL' || r.priority === 'HIGH').length,
      },
    };

    // events 테이블에 저장 (data.intel.report 타입)
    if (hasPool()) {
      try {
        await pool.query(
          `INSERT INTO events (type, user_id, data_json, timestamp)
           VALUES ('data.intel.report', 'system', $1, NOW())`,
          [JSON.stringify(report)]
        );
      } catch (e) {
        console.warn('[data-intel] report 저장 실패:', e.message);
      }
    }

    // 자동 적용
    let autoApplied = 0;
    try {
      autoApplied = await applyAutoRecommendations(recommendations, quality);
    } catch (e) {
      console.warn('[data-intel] 자동 적용 실패:', e.message);
    }

    report.autoApplied = autoApplied;

    console.log(
      `[data-intel] 자가발전 완료 — 트리거 ${quality.length}개 분석, ` +
      `평균품질 ${report.summary.avgQuality}점, ` +
      `권고 ${recommendations.length}건, ` +
      `자동적용 ${autoApplied}건`
    );

    return report;
  }

  // ── 24시간 스케줄러 ──────────────────────────────────────────────────────────
  // 서버 시작 후 1시간 뒤 첫 실행, 이후 24시간 주기
  setTimeout(async () => {
    try {
      await runEvolution();
    } catch (e) {
      console.warn('[data-intel] 초기 실행 실패:', e.message);
    }
    setInterval(async () => {
      try {
        await runEvolution();
      } catch (e) {
        console.warn('[data-intel] 스케줄 실패:', e.message);
      }
    }, 24 * 60 * 60 * 1000);
  }, 60 * 60 * 1000);

  // ── 엔드포인트 ───────────────────────────────────────────────────────────────

  /**
   * GET /api/data-intel/quality?days=7
   * trigger별 캡처 품질 점수 목록
   */
  router.get('/quality', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || DEFAULT_DAYS, 90);
      const quality = await calcTriggerQuality(days);
      res.json({ ok: true, days, quality });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * GET /api/data-intel/coverage?days=7
   * 앱/시간대별 커버리지 분석
   */
  router.get('/coverage', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || DEFAULT_DAYS, 90);
      const coverage = await calcCoverage(days);
      res.json({ ok: true, days, coverage });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * GET /api/data-intel/gaps
   * 미수집 업무 갭 목록 (화훼도매 기준)
   */
  router.get('/gaps', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || DEFAULT_DAYS, 90);
      const coverage = await calcCoverage(days);
      const gaps = calcGaps(coverage);
      res.json({ ok: true, gaps });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * GET /api/data-intel/recommendations?days=7
   * 개선 권고 (전체 분석 후 자동 계산)
   */
  router.get('/recommendations', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || DEFAULT_DAYS, 90);
      const [quality, coverage, crossVal, wasted] = await Promise.all([
        calcTriggerQuality(days),
        calcCoverage(days),
        calcCrossValidation(days),
        calcWastedCaptures(days),
      ]);
      const recommendations = generateRecommendations(quality, coverage, crossVal, wasted);
      res.json({
        ok: true,
        days,
        recommendations,
        meta: {
          total: recommendations.length,
          autoApplyCount: recommendations.filter(r => r.autoApply).length,
          highPriorityCount: recommendations.filter(r => r.priority === 'CRITICAL' || r.priority === 'HIGH').length,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/data-intel/evolve
   * 분석 실행 + 권고 저장 (수동 트리거)
   * body: { days: 7 }
   */
  router.post('/evolve', async (req, res) => {
    try {
      const days = Math.min(parseInt(req.body?.days, 10) || DEFAULT_DAYS, 90);
      const report = await runEvolution(days);
      res.json({ ok: true, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * GET /api/data-intel/evolution-log?limit=20
   * 자가발전 이력 (events 테이블의 data.intel.report 타입)
   */
  router.get('/evolution-log', async (req, res) => {
    if (!hasPool()) {
      return res.json({ ok: true, logs: [] });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const { rows } = await pool.query(`
        SELECT
          id,
          data_json,
          timestamp::timestamptz AS ts
        FROM events
        WHERE type = 'data.intel.report'
        ORDER BY timestamp DESC
        LIMIT $1
      `, [limit]);

      const logs = rows.map(r => {
        let data = {};
        try { data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
        return {
          id: r.id,
          ts: r.ts,
          summary: data.summary || null,
          autoApplied: data.autoApplied || 0,
          analyzedDays: data.analyzedDays || DEFAULT_DAYS,
        };
      });

      res.json({ ok: true, logs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
