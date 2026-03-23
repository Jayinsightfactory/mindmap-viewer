'use strict';
/**
 * deep-investigator.js — 깊은 조사 에이전트 ("궁금해하는 에이전트")
 * ─────────────────────────────────────────────────────────────────────────────
 * 표면 패턴을 넘어 실제 맥락을 파악하는 에이전트
 *
 * 핵심 철학:
 *   1. 표면 분류를 그대로 믿지 않는다 — 더 깊이 조사한다
 *   2. 모든 이벤트의 전후(BEFORE/AFTER) 맥락을 본다
 *   3. 매 패턴마다 "왜?" 를 묻는다
 *   4. 여러 데이터 소스를 교차 검증한다
 *   5. 모르는 건 모른다고 솔직히 말한다
 *   6. 불확실성 해소에 필요한 데이터를 제안한다
 *
 * 엔드포인트:
 *   GET /api/investigate/context/:eventId    — 특정 이벤트 전후 맥락 분석
 *   GET /api/investigate/reclassify          — 오분류 활동 재분석 (개인→업무 등)
 *   GET /api/investigate/hidden-workflows    — 숨겨진 업무 흐름 발견
 *   GET /api/investigate/automation-reality  — 현실적 자동화 가능성 판단
 *   GET /api/investigate/questions           — 에이전트가 궁금한 것 목록
 *   GET /api/investigate/hypotheses          — 현재 가설 + 검증 상태
 *   GET /api/investigate/decision-patterns   — 직원 판단 기준 분석
 *   GET /api/investigate/work-sequences      — 실제 업무 시퀀스 (전체 흐름)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// 업무 앱 판별 키워드
// ═══════════════════════════════════════════════════════════════════════════
const WORK_APP_KEYWORDS = [
  'nenova', '네노바', '화훼관리',
  '불량', '주문', '발주', '차감', '매출', '견적', '출고', '재고',
  'excel', 'holex', '물량',
  '공유방', '업무',
];

const PERSONAL_APP_PATTERNS = [
  /youtube/i, /netflix/i, /게임/i, /game/i,
  /instagram/i, /facebook/i, /tiktok/i,
  /쇼핑/i, /coupang/i, /naver.*blog/i,
];

// ═══════════════════════════════════════════════════════════════════════════
// 인메모리 캐시 — 조사 결과 + 가설 저장
// ═══════════════════════════════════════════════════════════════════════════
let _investigationCache = {
  lastRun: null,
  reclassified: [],
  workflows: [],
  questions: [],
  hypotheses: [],
  automationAssessments: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// 헬퍼 함수
// ═══════════════════════════════════════════════════════════════════════════

/** 윈도우 타이틀이 업무 관련인지 판별 */
function isWorkWindow(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return WORK_APP_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

/** 윈도우 타이틀이 개인 활동인지 판별 */
function isPersonalWindow(title) {
  if (!title) return false;
  return PERSONAL_APP_PATTERNS.some(pat => pat.test(title));
}

/** 윈도우 타이틀에서 앱명 추출 */
function extractAppName(title) {
  if (!title) return 'unknown';
  const lower = title.toLowerCase();
  if (lower.includes('kakao') || lower.includes('카카오')) return 'kakaotalk';
  if (lower.includes('nenova') || lower.includes('네노바') || lower.includes('화훼관리')) return 'nenova';
  if (lower.includes('excel') || lower.includes('.xlsx') || lower.includes('.xls')) return 'excel';
  if (lower.includes('chrome') || lower.includes('edge') || lower.includes('firefox')) return 'browser';
  if (lower.includes('explorer') || lower.includes('탐색기')) return 'explorer';
  if (lower.includes('메모장') || lower.includes('notepad')) return 'notepad';
  if (lower.includes('powershell') || lower.includes('cmd') || lower.includes('터미널')) return 'terminal';
  return 'other';
}

/** 이벤트에서 windowTitle 추출 (data_json 구조 대응) */
function getWindowTitle(row) {
  // DB row에서 직접 컬럼으로 올 수도 있고, data_json 파싱이 필요할 수도 있음
  if (row.window_title) return row.window_title;
  if (row.win_title) return row.win_title;
  if (row.personal_window) return row.personal_window;
  if (row.next_window) return row.next_window;
  return null;
}

/** 두 이벤트 사이 초 단위 간격 */
function secondsBetween(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return Math.abs((d2 - d1) / 1000);
}

/** 업무 카테고리 추론 */
function inferWorkCategory(windowTitle) {
  if (!windowTitle) return '미분류';
  const t = windowTitle.toLowerCase();
  if (t.includes('불량') || t.includes('클레임')) return '업무-불량처리';
  if (t.includes('주문') || t.includes('신규')) return '업무-주문처리';
  if (t.includes('발주')) return '업무-발주';
  if (t.includes('차감') || t.includes('재고')) return '업무-재고관리';
  if (t.includes('매출') || t.includes('견적')) return '업무-매출관리';
  if (t.includes('출고')) return '업무-출고';
  if (t.includes('물량')) return '업무-물량관리';
  if (t.includes('거래처') || t.includes('공유방')) return '업무-거래처관리';
  if (t.includes('nenova') || t.includes('네노바') || t.includes('화훼관리')) return '업무-전산';
  if (t.includes('excel')) return '업무-엑셀';
  if (t.includes('holex')) return '업무-홀렉스';
  return '업무-기타';
}

/** confidence 계산: 전후 맥락 기반 */
function calcReclassifyConfidence(gapSeconds, nextIsWork) {
  if (!nextIsWork) return 0.3;
  // 전환이 빠를수록 높은 신뢰도
  if (gapSeconds < 30) return 0.95;
  if (gapSeconds < 60) return 0.90;
  if (gapSeconds < 120) return 0.85;
  if (gapSeconds < 180) return 0.75;
  if (gapSeconds < 300) return 0.65;
  return 0.50;
}


function createDeepInvestigator({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════════════
  // 1. GET /context/:eventId — 특정 이벤트 전후 맥락 분석
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/context/:eventId', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const { eventId } = req.params;
      const windowMinutes = parseInt(req.query.window) || 5;

      // 대상 이벤트 조회
      const targetResult = await db.query(`
        SELECT id, type, user_id, timestamp,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as window_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app_name,
          data_json
        FROM events
        WHERE id = $1
      `, [eventId]);

      if (!targetResult.rows.length) {
        return res.status(404).json({ error: 'Event not found', eventId });
      }

      const target = targetResult.rows[0];

      // 전후 이벤트 조회 (N분 윈도우)
      const contextResult = await db.query(`
        SELECT id, type, user_id, timestamp,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as window_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app_name,
          data_json
        FROM events
        WHERE user_id = $1
          AND type IN ('keyboard.chunk', 'screen.capture', 'screen.analyzed')
          AND timestamp::timestamptz BETWEEN
            ($2::timestamptz - $3 * INTERVAL '1 minute')
            AND ($2::timestamptz + $3 * INTERVAL '1 minute')
        ORDER BY timestamp ASC
      `, [target.user_id, target.timestamp, windowMinutes]);

      const before = [];
      const after = [];
      let foundTarget = false;

      for (const row of contextResult.rows) {
        if (row.id === eventId) {
          foundTarget = true;
          continue;
        }
        if (!foundTarget) {
          before.push({
            id: row.id,
            timestamp: row.timestamp,
            window: row.window_title,
            app: extractAppName(row.window_title || row.app_name),
            isWork: isWorkWindow(row.window_title),
            gap: secondsBetween(row.timestamp, target.timestamp),
          });
        } else {
          after.push({
            id: row.id,
            timestamp: row.timestamp,
            window: row.window_title,
            app: extractAppName(row.window_title || row.app_name),
            isWork: isWorkWindow(row.window_title),
            gap: secondsBetween(target.timestamp, row.timestamp),
          });
        }
      }

      // 맥락 분석
      const afterWorkEvents = after.filter(e => e.isWork);
      const beforeWorkEvents = before.filter(e => e.isWork);
      const targetIsWork = isWorkWindow(target.window_title);
      const targetIsPersonal = isPersonalWindow(target.window_title);

      let contextAnalysis = {
        surfaceClassification: targetIsWork ? '업무' : (targetIsPersonal ? '개인' : '불분명'),
        deepClassification: targetIsWork ? '업무' : '개인',
        confidence: 0.5,
        reason: '',
        hypothesis: null,
      };

      // "개인"으로 보이지만 전후에 업무 이벤트 → 재분류
      if (!targetIsWork && (afterWorkEvents.length > 0 || beforeWorkEvents.length > 0)) {
        const nearestWorkAfter = afterWorkEvents[0];
        const nearestWorkBefore = beforeWorkEvents[beforeWorkEvents.length - 1];

        if (nearestWorkAfter && nearestWorkAfter.gap < 180) {
          contextAnalysis.deepClassification = inferWorkCategory(nearestWorkAfter.window);
          contextAnalysis.confidence = calcReclassifyConfidence(nearestWorkAfter.gap, true);
          contextAnalysis.reason = `"${target.window_title}" 직후 ${Math.round(nearestWorkAfter.gap)}초 만에 "${nearestWorkAfter.window}" (업무)로 이동`;
          contextAnalysis.hypothesis = `개인 앱에서 업무 관련 정보(사진/메시지 등)를 확인하고 바로 업무 처리로 넘어간 것으로 추정`;
        } else if (nearestWorkBefore && nearestWorkBefore.gap < 180) {
          contextAnalysis.deepClassification = inferWorkCategory(nearestWorkBefore.window);
          contextAnalysis.confidence = calcReclassifyConfidence(nearestWorkBefore.gap, true) * 0.9;
          contextAnalysis.reason = `업무 "${nearestWorkBefore.window}" 직후 ${Math.round(nearestWorkBefore.gap)}초 만에 "${target.window_title}" 접근 — 업무 연장선`;
          contextAnalysis.hypothesis = `업무 중 필요한 정보를 개인 앱에서 찾아보는 것으로 추정`;
        }
      }

      res.json({
        ok: true,
        event: {
          id: target.id,
          type: target.type,
          userId: target.user_id,
          timestamp: target.timestamp,
          window: target.window_title,
          app: extractAppName(target.window_title || target.app_name),
        },
        context: {
          before: before.slice(-10), // 직전 10개
          after: after.slice(0, 10),  // 직후 10개
          windowMinutes,
        },
        analysis: contextAnalysis,
      });
    } catch (e) {
      console.error('[deep-investigator] context error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 2. GET /reclassify — 오분류된 활동 재분석
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/reclassify', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const userId = req.query.userId || null;

      // 1) "개인 카톡" 직후 5분 이내에 업무 앱으로 전환한 이벤트 쌍 조회
      const reclassifyResult = await db.query(`
        SELECT
          e1.id as personal_id,
          e1.user_id,
          e1.timestamp as personal_ts,
          COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') as personal_window,
          COALESCE(e1.data_json->>'app', e1.data_json->'appContext'->>'currentApp') as personal_app,
          e2.id as work_id,
          e2.timestamp as work_ts,
          COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') as work_window,
          COALESCE(e2.data_json->>'app', e2.data_json->'appContext'->>'currentApp') as work_app,
          EXTRACT(EPOCH FROM (e2.timestamp::timestamptz - e1.timestamp::timestamptz)) as gap_seconds
        FROM events e1
        JOIN events e2 ON e1.user_id = e2.user_id
          AND e2.timestamp::timestamptz > e1.timestamp::timestamptz
          AND e2.timestamp::timestamptz < e1.timestamp::timestamptz + INTERVAL '5 minutes'
        WHERE e1.type IN ('keyboard.chunk', 'screen.capture')
          AND e1.timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            e1.data_json->>'app' ILIKE '%kakao%'
            OR e1.data_json->'appContext'->>'currentApp' ILIKE '%kakao%'
            OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%카카오톡%'
          )
          -- 개인 카톡 (업무 키워드 없는 것)
          AND NOT (
            COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
            OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
            OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
          )
          -- 직후 이벤트가 업무 앱
          AND (
            COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%nenova%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%네노바%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%Excel%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%발주%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%차감%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%재고%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%출고%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%화훼관리%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
          )
          ${userId ? 'AND e1.user_id = $2' : ''}
        ORDER BY e1.timestamp DESC
        LIMIT 100
      `, userId ? [days, userId] : [days]);

      // 2) 전체 "개인" 카톡 이벤트 수 조회
      const totalPersonalResult = await db.query(`
        SELECT COUNT(*) as cnt
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            data_json->>'app' ILIKE '%kakao%'
            OR data_json->'appContext'->>'currentApp' ILIKE '%kakao%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%카카오톡%'
          )
          AND NOT (
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
          )
          ${userId ? 'AND user_id = $2' : ''}
      `, userId ? [days, userId] : [days]);

      // 3) 전체 업무 카톡 이벤트 수 (처음부터 업무로 분류된 것)
      const totalWorkKakaoResult = await db.query(`
        SELECT COUNT(*) as cnt
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            data_json->>'app' ILIKE '%kakao%'
            OR data_json->'appContext'->>'currentApp' ILIKE '%kakao%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%카카오톡%'
          )
          AND (
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
          )
          ${userId ? 'AND user_id = $2' : ''}
      `, userId ? [days, userId] : [days]);

      const totalPersonal = parseInt(totalPersonalResult.rows[0]?.cnt || 0);
      const totalWorkKakao = parseInt(totalWorkKakaoResult.rows[0]?.cnt || 0);

      // 중복 제거 (같은 personal_id가 여러 work 이벤트에 매칭될 수 있음)
      const seen = new Set();
      const reclassified = [];
      for (const row of reclassifyResult.rows) {
        if (seen.has(row.personal_id)) continue;
        seen.add(row.personal_id);

        const gapSec = parseFloat(row.gap_seconds) || 0;
        const workCategory = inferWorkCategory(row.work_window);

        // 같은 유저의 전후 시퀀스 추출 (이미 조회한 데이터에서)
        const sequence = [row.personal_window || '카톡 개인'];
        if (row.work_window) sequence.push(row.work_window);

        reclassified.push({
          eventId: row.personal_id,
          userId: row.user_id,
          originalClass: '개인',
          newClass: workCategory,
          confidence: calcReclassifyConfidence(gapSec, true),
          reason: `개인 카톡 직후 ${Math.round(gapSec)}초 만에 "${row.work_window}"로 이동`,
          sequence,
          hypothesis: _generateHypothesis(row.personal_window, row.work_window),
          timestamps: {
            personal: row.personal_ts,
            work: row.work_ts,
            gapSeconds: Math.round(gapSec),
          },
        });
      }

      const reclassifiedCount = reclassified.length;
      // 아직 확인 안 된 개인 이벤트 (재분류되지 않은 것)
      const stillUncertain = Math.max(0, totalPersonal - reclassifiedCount);
      const totalKakao = totalPersonal + totalWorkKakao;
      const adjustedWorkCount = totalWorkKakao + reclassifiedCount;
      const adjustedWorkRate = totalKakao > 0
        ? Math.round((adjustedWorkCount / totalKakao) * 100) + '%'
        : '0%';
      const originalWorkRate = totalKakao > 0
        ? Math.round((totalWorkKakao / totalKakao) * 100) + '%'
        : '0%';

      // 캐시 업데이트
      _investigationCache.reclassified = reclassified;

      res.json({
        ok: true,
        reclassified,
        stats: {
          period: `${days}일`,
          totalKakaoEvents: totalKakao,
          totalPersonal,
          totalWorkKakao,
          reclassifiedToWork: reclassifiedCount,
          stillUncertain,
          originalWorkRate,
          adjustedWorkRate,
          impact: `개인으로 분류된 ${totalPersonal}건 중 ${reclassifiedCount}건이 실제 업무 관련 — 업무 비율 ${originalWorkRate} → ${adjustedWorkRate}`,
        },
      });
    } catch (e) {
      console.error('[deep-investigator] reclassify error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 3. GET /hidden-workflows — 숨겨진 업무 흐름 발견
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/hidden-workflows', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const userId = req.query.userId || null;
      const minChainLength = parseInt(req.query.minSteps) || 3;

      // 5분 윈도우로 연속 이벤트 체인 추출
      const chainsResult = await db.query(`
        WITH ordered_events AS (
          SELECT
            id, user_id, timestamp,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
            COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app,
            LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_ts,
            LAG(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as prev_win
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            ${userId ? 'AND user_id = $2' : ''}
        ),
        with_chain_flag AS (
          SELECT *,
            CASE
              WHEN prev_ts IS NULL THEN 1
              WHEN EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz)) > 300 THEN 1
              ELSE 0
            END as new_chain
          FROM ordered_events
        ),
        with_chain_id AS (
          SELECT *,
            SUM(new_chain) OVER (PARTITION BY user_id ORDER BY timestamp) as chain_id
          FROM with_chain_flag
        )
        SELECT
          user_id,
          chain_id,
          array_agg(win ORDER BY timestamp) as windows,
          array_agg(app ORDER BY timestamp) as apps,
          array_agg(timestamp ORDER BY timestamp) as timestamps,
          COUNT(*) as chain_length,
          MIN(timestamp) as chain_start,
          MAX(timestamp) as chain_end,
          EXTRACT(EPOCH FROM (MAX(timestamp::timestamptz) - MIN(timestamp::timestamptz))) as duration_seconds
        FROM with_chain_id
        WHERE win IS NOT NULL
        GROUP BY user_id, chain_id
        HAVING COUNT(*) >= $${userId ? 3 : 2}
        ORDER BY chain_length DESC
        LIMIT 200
      `, userId ? [days, userId, minChainLength] : [days, minChainLength]);

      // 체인 분석: 반복 패턴 감지
      const patternMap = new Map(); // key: 앱 시퀀스 해시 → value: 발생 횟수 + 상세

      for (const chain of chainsResult.rows) {
        const windows = chain.windows || [];
        const apps = chain.apps || [];
        const timestamps = chain.timestamps || [];

        // 연속 중복 제거 (같은 앱에서 계속 작업하는 건 하나로)
        const dedupedSteps = [];
        let lastApp = null;
        for (let i = 0; i < windows.length; i++) {
          const appName = extractAppName(windows[i] || apps[i]);
          if (appName !== lastApp) {
            dedupedSteps.push({
              app: appName,
              window: windows[i],
              isWork: isWorkWindow(windows[i]),
              classified: isWorkWindow(windows[i]) ? '업무' : (isPersonalWindow(windows[i]) ? '개인' : '불분명'),
            });
            lastApp = appName;
          }
        }

        if (dedupedSteps.length < minChainLength) continue;

        // 패턴 키: 앱 순서
        const patternKey = dedupedSteps.map(s => s.app).join(' → ');

        if (!patternMap.has(patternKey)) {
          patternMap.set(patternKey, {
            steps: dedupedSteps,
            frequency: 0,
            totalDuration: 0,
            instances: [],
            hasPersonalInChain: false,
            userId: chain.user_id,
          });
        }

        const pattern = patternMap.get(patternKey);
        pattern.frequency++;
        pattern.totalDuration += parseFloat(chain.duration_seconds) || 0;
        pattern.instances.push({
          chainId: chain.chain_id,
          start: chain.chain_start,
          end: chain.chain_end,
          duration: Math.round(parseFloat(chain.duration_seconds) || 0),
        });

        // 체인 안에 "개인"이 끼어있으면 재분류 대상
        if (dedupedSteps.some(s => s.classified === '개인')) {
          pattern.hasPersonalInChain = true;
        }
      }

      // 반복되는 패턴만 추출 (2회+)
      const workflows = [];
      for (const [patternKey, pattern] of patternMap) {
        if (pattern.frequency < 2) continue;

        const avgDuration = Math.round(pattern.totalDuration / pattern.frequency);
        const steps = pattern.steps.map(s => ({
          ...s,
          reclassified: s.classified === '개인' && pattern.hasPersonalInChain
            ? '개인 → 실제 업무 가능성'
            : undefined,
        }));

        // 자동화 가능성 평가
        const automatable = _assessWorkflowAutomation(steps, pattern.frequency);

        workflows.push({
          name: _generateWorkflowName(steps),
          pattern: patternKey,
          userId: pattern.userId,
          frequency: pattern.frequency,
          avgDuration: avgDuration > 60 ? `${Math.round(avgDuration / 60)}분` : `${avgDuration}초`,
          steps,
          hasHiddenWork: pattern.hasPersonalInChain,
          automatable,
          recentInstances: pattern.instances.slice(-5),
        });
      }

      // 빈도 내림차순 정렬
      workflows.sort((a, b) => b.frequency - a.frequency);

      // 캐시 업데이트
      _investigationCache.workflows = workflows.slice(0, 50);

      res.json({
        ok: true,
        period: `${days}일`,
        totalChainsAnalyzed: chainsResult.rows.length,
        uniquePatterns: patternMap.size,
        workflows: workflows.slice(0, 30),
        summary: {
          totalWorkflows: workflows.length,
          withHiddenWork: workflows.filter(w => w.hasHiddenWork).length,
          automatable: workflows.filter(w => w.automatable.feasible).length,
          topWorkflow: workflows[0]?.name || 'none',
        },
      });
    } catch (e) {
      console.error('[deep-investigator] hidden-workflows error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 4. GET /automation-reality — 현실적 자동화 가능성 판단
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/automation-reality', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;

      // 반복 업무 패턴 조회 (자동화 후보)
      const repetitiveResult = await db.query(`
        SELECT
          user_id,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app_name,
          COUNT(*) as frequency,
          COUNT(DISTINCT DATE(timestamp::timestamptz)) as active_days,
          AVG(EXTRACT(EPOCH FROM
            (LEAD(timestamp::timestamptz) OVER (PARTITION BY user_id ORDER BY timestamp) - timestamp::timestamptz)
          )) as avg_duration_seconds
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY user_id, win_title, app_name
        HAVING COUNT(*) >= 10
        ORDER BY frequency DESC
        LIMIT 50
      `, [days]);

      // 마스터 DB 현황 (파서/매칭 준비도)
      let parserReady = { products: 0, customers: 0, parsedOrders: 0, avgConfidence: 0 };
      try {
        const [prodRes, custRes, parsedRes] = await Promise.all([
          db.query(`SELECT COUNT(*) as cnt FROM master_products`).catch(() => ({ rows: [{ cnt: 0 }] })),
          db.query(`SELECT COUNT(*) as cnt FROM master_customers`).catch(() => ({ rows: [{ cnt: 0 }] })),
          db.query(`SELECT COUNT(*) as cnt, AVG(confidence) as avg_conf FROM parsed_orders`).catch(() => ({ rows: [{ cnt: 0, avg_conf: 0 }] })),
        ]);
        parserReady = {
          products: parseInt(prodRes.rows[0]?.cnt || 0),
          customers: parseInt(custRes.rows[0]?.cnt || 0),
          parsedOrders: parseInt(parsedRes.rows[0]?.cnt || 0),
          avgConfidence: parseFloat(parsedRes.rows[0]?.avg_conf || 0),
        };
      } catch { /* 테이블 미존재 시 무시 */ }

      // Vision 분석 현황
      let visionReady = { totalCaptures: 0, analyzed: 0, coverageRate: 0 };
      try {
        const visionRes = await db.query(`
          SELECT
            COUNT(*) FILTER (WHERE type = 'screen.capture') as captures,
            COUNT(*) FILTER (WHERE type = 'screen.analyzed') as analyzed
          FROM events
          WHERE timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            AND type IN ('screen.capture', 'screen.analyzed')
        `, [days]);
        const row = visionRes.rows[0] || {};
        visionReady = {
          totalCaptures: parseInt(row.captures || 0),
          analyzed: parseInt(row.analyzed || 0),
          coverageRate: parseInt(row.captures || 0) > 0
            ? Math.round((parseInt(row.analyzed || 0) / parseInt(row.captures || 0)) * 100)
            : 0,
        };
      } catch { /* 무시 */ }

      // 자동화 평가 생성
      const assessments = [];

      // 업무별 그룹핑
      const taskGroups = {};
      for (const row of repetitiveResult.rows) {
        const category = inferWorkCategory(row.win_title);
        if (category === '미분류') continue;

        if (!taskGroups[category]) {
          taskGroups[category] = {
            category,
            totalFrequency: 0,
            activeDays: 0,
            windows: [],
            users: new Set(),
            avgDuration: 0,
            durationSamples: 0,
          };
        }
        const group = taskGroups[category];
        group.totalFrequency += parseInt(row.frequency);
        group.activeDays = Math.max(group.activeDays, parseInt(row.active_days));
        group.windows.push(row.win_title);
        group.users.add(row.user_id);
        if (row.avg_duration_seconds && !isNaN(parseFloat(row.avg_duration_seconds))) {
          group.avgDuration += parseFloat(row.avg_duration_seconds);
          group.durationSamples++;
        }
      }

      for (const [category, group] of Object.entries(taskGroups)) {
        const assessment = _buildAutomationAssessment(category, group, parserReady, visionReady, days);
        assessments.push(assessment);
      }

      // realism 내림차순 정렬
      assessments.sort((a, b) => b.realism - a.realism);

      // 캐시 업데이트
      _investigationCache.automationAssessments = assessments;

      res.json({
        ok: true,
        period: `${days}일`,
        assessments,
        infrastructure: {
          parser: parserReady,
          vision: visionReady,
          tools: {
            pad: 'PAD 설계됨 — nenova ERP 자동 입력용',
            pyautogui: '좌표 기반 자동화 — 좌표 확정 필요',
            autohotkey: '매크로 — 반복 키입력 자동화',
            powershell: 'COM 연동 — Excel/시스템 자동화',
          },
        },
        summary: {
          totalTasks: assessments.length,
          fullyAutomatable: assessments.filter(a => a.realism >= 80).length,
          partiallyAutomatable: assessments.filter(a => a.realism >= 50 && a.realism < 80).length,
          needsMoreData: assessments.filter(a => a.realism < 50).length,
          honestSummary: _generateHonestSummary(assessments, parserReady, visionReady),
        },
      });
    } catch (e) {
      console.error('[deep-investigator] automation-reality error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 5. GET /questions — 에이전트가 궁금한 것 목록
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/questions', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const questions = [];

      // Q1: 개인 카톡 → 업무 전환 패턴
      const q1Result = await db.query(`
        SELECT e1.user_id, COUNT(*) as cnt
        FROM events e1
        JOIN events e2 ON e1.user_id = e2.user_id
          AND e2.timestamp::timestamptz > e1.timestamp::timestamptz
          AND e2.timestamp::timestamptz < e1.timestamp::timestamptz + INTERVAL '3 minutes'
        WHERE e1.type IN ('keyboard.chunk', 'screen.capture')
          AND e1.timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            e1.data_json->>'app' ILIKE '%kakao%'
            OR e1.data_json->'appContext'->>'currentApp' ILIKE '%kakao%'
          )
          AND NOT (
            COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
            OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
          )
          AND (
            COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
            OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
          )
        GROUP BY e1.user_id
      `, [days]);

      for (const row of q1Result.rows) {
        if (parseInt(row.cnt) >= 3) {
          questions.push({
            priority: 'high',
            category: '오분류',
            question: `${row.user_id}가 개인 카톡 후 바로 불량 공유방으로 가는 패턴이 ${row.cnt}회 있다. 개인 채팅으로 불량 사진을 먼저 받는 건가?`,
            dataNeeded: '카톡 대화 내용 (현재 수집 불가)',
            alternativeCheck: 'Vision OCR로 카톡 화면 캡처 분석하면 이미지/텍스트 구분 가능',
            impact: '개인 활동 비율이 실제보다 20%+ 높게 집계되고 있을 수 있음',
          });
        }
      }

      // Q2: 거래처별 처리 시간 차이
      const q2Result = await db.query(`
        SELECT user_id,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
          COUNT(*) as visits,
          AVG(EXTRACT(EPOCH FROM
            (LEAD(timestamp::timestamptz) OVER (PARTITION BY user_id ORDER BY timestamp) - timestamp::timestamptz)
          )) as avg_stay
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%신규%'
          )
        GROUP BY user_id, win
        HAVING COUNT(*) >= 5
        ORDER BY avg_stay DESC NULLS LAST
        LIMIT 10
      `, [days]);

      if (q2Result.rows.length >= 2) {
        const fastest = q2Result.rows[q2Result.rows.length - 1];
        const slowest = q2Result.rows[0];
        if (fastest && slowest && parseFloat(slowest.avg_stay) > parseFloat(fastest.avg_stay) * 2) {
          questions.push({
            priority: 'high',
            category: '효율성',
            question: `주문 입력 시 화면별로 처리 시간이 크게 다르다. "${slowest.win}" 평균 ${Math.round(parseFloat(slowest.avg_stay))}초 vs "${fastest.win}" 평균 ${Math.round(parseFloat(fastest.avg_stay))}초 — 특정 거래처가 유독 오래 걸리는 이유는?`,
            dataNeeded: 'nenova 화면 체류시간 + 거래처 매칭',
            impact: '자동화 대상 거래처 우선순위 결정 가능',
          });
        }
      }

      // Q3: 야근 시간대 활동 (19~21시)
      const q3Result = await db.query(`
        SELECT user_id, COUNT(*) as cnt,
          COUNT(*) FILTER (WHERE
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%nenova%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%excel%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
          ) as work_cnt
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') BETWEEN 19 AND 21
        GROUP BY user_id
        HAVING COUNT(*) >= 50
      `, [days]);

      for (const row of q3Result.rows) {
        const workRatio = parseInt(row.work_cnt) / parseInt(row.cnt);
        questions.push({
          priority: 'medium',
          category: '근무패턴',
          question: `${row.user_id}이(가) 19~21시에 활동 ${row.cnt}건인데, ${workRatio > 0.5 ? '업무 비율이 높아 야근으로 보인다' : '개인 사용 비율이 높은데 야근인가 개인 사용인가'}?`,
          dataNeeded: '해당 시간대 앱 사용 패턴 상세 분석',
          alternativeCheck: `19~21시 이벤트의 windowTitle 분류하면 업무/개인 구분 가능 (현재 업무 비율: ${Math.round(workRatio * 100)}%)`,
          impact: '야근 현황 파악 + 업무량 적정성 판단',
        });
      }

      // Q4: AI 도구 사용 맥락
      const q4Result = await db.query(`
        SELECT user_id, COUNT(*) as cnt
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%claude%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%chatgpt%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%copilot%'
          )
        GROUP BY user_id
        HAVING COUNT(*) >= 20
      `, [days]);

      for (const row of q4Result.rows) {
        questions.push({
          priority: 'medium',
          category: 'AI 활용',
          question: `${row.user_id}이(가) AI 도구를 ${row.cnt}회 사용하는데, 어떤 업무에 활용하는 건가? 매출 마감용인가 다른 업무도 있나?`,
          dataNeeded: 'AI 사용 전후 앱 전환 패턴',
          alternativeCheck: 'AI 사용 직전/직후 windowTitle 분석으로 업무 맥락 추론 가능',
          impact: 'AI 활용 업무 자동화 기회 발견',
        });
      }

      // Q5: "받은 파일" 폴더 반복 접근
      const q5Result = await db.query(`
        SELECT user_id, COUNT(*) as cnt
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND (
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%받은 파일%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%received%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%카카오톡 받은%'
          )
        GROUP BY user_id
        HAVING COUNT(*) >= 20
      `, [days]);

      for (const row of q5Result.rows) {
        questions.push({
          priority: 'low',
          category: '파일 활동',
          question: `${row.user_id}이(가) "받은 파일" 폴더를 ${row.cnt}회 열었는데, 어떤 파일을 여는 건가? 같은 파일 반복인가 매번 다른 파일인가?`,
          dataNeeded: '파일명 추적 (workflow-learner 파일 활동 감지로 해결 예정)',
          impact: '파일 처리 자동화 기회 — 동일 파일 반복이면 워크플로우 자동화 가능',
        });
      }

      // Q6: 같은 화면 반복 접근 (비효율 또는 확인 습관)
      const q6Result = await db.query(`
        WITH bounce AS (
          SELECT user_id,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
            LEAD(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as next_win,
            LEAD(LEAD(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp))
              OVER (PARTITION BY user_id ORDER BY timestamp) as after_next_win
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
        )
        SELECT user_id, win, COUNT(*) as bounces
        FROM bounce
        WHERE win = after_next_win AND win != next_win
        GROUP BY user_id, win
        HAVING COUNT(*) >= 10
        ORDER BY bounces DESC
        LIMIT 10
      `, [days]);

      for (const row of q6Result.rows) {
        questions.push({
          priority: 'medium',
          category: '반복 확인',
          question: `${row.user_id}이(가) "${row.win}" 화면을 다른 화면 갔다가 ${row.bounces}회 돌아온다. 정보 확인 후 다른 곳에 입력하는 패턴인가?`,
          dataNeeded: '중간에 방문하는 화면이 무엇인지 분석',
          impact: '두 화면 간 데이터 복사 패턴이면 자동 연동으로 해결 가능',
        });
      }

      // 우선순위 정렬
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      questions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

      // 캐시 업데이트
      _investigationCache.questions = questions;

      res.json({
        ok: true,
        period: `${days}일`,
        totalQuestions: questions.length,
        questions,
        byPriority: {
          high: questions.filter(q => q.priority === 'high').length,
          medium: questions.filter(q => q.priority === 'medium').length,
          low: questions.filter(q => q.priority === 'low').length,
        },
        philosophy: '에이전트는 데이터에서 "왜?" 를 묻고, 모르는 건 모른다고 말하며, 해결에 필요한 데이터를 제안한다.',
      });
    } catch (e) {
      console.error('[deep-investigator] questions error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 6. GET /hypotheses — 현재 가설 + 검증 상태
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/hypotheses', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const hypotheses = [];

      // H1: "개인 카톡은 실제로 업무 연장선이다" 가설 검증
      const h1Result = await db.query(`
        WITH kakao_events AS (
          SELECT id, user_id, timestamp,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            AND (
              data_json->>'app' ILIKE '%kakao%'
              OR data_json->'appContext'->>'currentApp' ILIKE '%kakao%'
            )
            AND NOT (
              COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
              OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
            )
        ),
        with_next AS (
          SELECT k.id, k.user_id, k.timestamp, k.win,
            (
              SELECT COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow')
              FROM events e2
              WHERE e2.user_id = k.user_id
                AND e2.timestamp::timestamptz > k.timestamp::timestamptz
                AND e2.timestamp::timestamptz < k.timestamp::timestamptz + INTERVAL '5 minutes'
                AND e2.type IN ('keyboard.chunk', 'screen.capture')
              ORDER BY e2.timestamp ASC
              LIMIT 1
            ) as next_window
          FROM kakao_events k
        )
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE next_window IS NOT NULL AND (
            next_window ILIKE '%nenova%' OR next_window ILIKE '%불량%'
            OR next_window ILIKE '%주문%' OR next_window ILIKE '%excel%'
            OR next_window ILIKE '%발주%' OR next_window ILIKE '%차감%'
            OR next_window ILIKE '%공유방%' OR next_window ILIKE '%재고%'
          )) as followed_by_work,
          COUNT(*) FILTER (WHERE next_window IS NOT NULL AND NOT (
            next_window ILIKE '%nenova%' OR next_window ILIKE '%불량%'
            OR next_window ILIKE '%주문%' OR next_window ILIKE '%excel%'
            OR next_window ILIKE '%발주%' OR next_window ILIKE '%차감%'
            OR next_window ILIKE '%공유방%' OR next_window ILIKE '%재고%'
          )) as followed_by_non_work,
          COUNT(*) FILTER (WHERE next_window IS NULL) as no_follow
        FROM with_next
      `, [days]);

      const h1 = h1Result.rows[0] || {};
      const h1Total = parseInt(h1.total || 0);
      const h1WorkFollow = parseInt(h1.followed_by_work || 0);
      const h1WorkRate = h1Total > 0 ? Math.round((h1WorkFollow / h1Total) * 100) : 0;

      hypotheses.push({
        id: 'H1',
        hypothesis: '개인 카톡의 상당수는 실제 업무 플로우의 시작점이다',
        status: h1WorkRate >= 30 ? 'supported' : (h1WorkRate >= 15 ? 'partially_supported' : 'not_supported'),
        evidence: {
          totalPersonalKakao: h1Total,
          followedByWork: h1WorkFollow,
          followedByNonWork: parseInt(h1.followed_by_non_work || 0),
          noFollowUp: parseInt(h1.no_follow || 0),
          workFollowRate: `${h1WorkRate}%`,
        },
        conclusion: h1WorkRate >= 30
          ? `지지됨 — 개인 카톡 ${h1Total}건 중 ${h1WorkFollow}건(${h1WorkRate}%)이 5분 이내 업무 앱으로 이어짐. 현재 "개인" 분류가 과다 계상되고 있을 가능성 높음.`
          : h1WorkRate >= 15
            ? `부분 지지 — ${h1WorkRate}%만 업무로 이어짐. 일부는 실제 개인이지만 확인 필요.`
            : `미지지 — 대부분의 개인 카톡은 실제 개인 활동인 것으로 보임.`,
        nextStep: '카톡 화면 Vision OCR 분석으로 이미지/텍스트 내용 구분 필요',
      });

      // H2: "반복 작업은 표준 프로세스다" 가설 검증
      const h2Result = await db.query(`
        WITH ordered AS (
          SELECT user_id, timestamp,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
            LAG(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as prev_win,
            EXTRACT(EPOCH FROM (timestamp::timestamptz - LAG(timestamp::timestamptz) OVER (PARTITION BY user_id ORDER BY timestamp))) as gap
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
        )
        SELECT
          prev_win || ' → ' || win as transition,
          COUNT(*) as cnt,
          AVG(gap) as avg_gap,
          STDDEV(gap) as stddev_gap
        FROM ordered
        WHERE prev_win IS NOT NULL AND win IS NOT NULL
          AND gap > 0 AND gap < 300
          AND prev_win != win
        GROUP BY prev_win, win
        HAVING COUNT(*) >= 5
        ORDER BY cnt DESC
        LIMIT 20
      `, [days]);

      const consistentTransitions = h2Result.rows.filter(r => {
        const stddev = parseFloat(r.stddev_gap || 0);
        const avg = parseFloat(r.avg_gap || 1);
        return stddev < avg; // 표준편차가 평균보다 작으면 일관된 패턴
      });

      hypotheses.push({
        id: 'H2',
        hypothesis: '자주 반복되는 앱 전환 패턴은 표준 업무 프로세스의 일부다',
        status: consistentTransitions.length >= 3 ? 'supported' : 'partially_supported',
        evidence: {
          totalTransitionPatterns: h2Result.rows.length,
          consistentPatterns: consistentTransitions.length,
          topPatterns: h2Result.rows.slice(0, 5).map(r => ({
            transition: r.transition,
            frequency: parseInt(r.cnt),
            avgGapSeconds: Math.round(parseFloat(r.avg_gap || 0)),
            consistency: parseFloat(r.stddev_gap || 0) < parseFloat(r.avg_gap || 1) ? 'high' : 'low',
          })),
        },
        conclusion: `${consistentTransitions.length}개의 일관된 전환 패턴 발견 — 이들은 자동화 가능한 표준 프로세스일 가능성이 높다.`,
        nextStep: '각 전환 패턴의 실제 데이터 입력 내용을 Vision으로 확인',
      });

      // H3: "야근 시간 활동은 업무다" 가설 검증
      const h3Result = await db.query(`
        SELECT
          COUNT(*) as total_overtime,
          COUNT(*) FILTER (WHERE
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%nenova%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%excel%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%발주%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
          ) as work_overtime,
          COUNT(*) FILTER (WHERE
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%youtube%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%게임%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%쇼핑%'
          ) as personal_overtime
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') >= 19
      `, [days]);

      const h3 = h3Result.rows[0] || {};
      const h3Total = parseInt(h3.total_overtime || 0);
      const h3Work = parseInt(h3.work_overtime || 0);
      const h3Personal = parseInt(h3.personal_overtime || 0);
      const h3WorkRate = h3Total > 0 ? Math.round((h3Work / h3Total) * 100) : 0;

      hypotheses.push({
        id: 'H3',
        hypothesis: '야근 시간(19시+) 활동은 대부분 실제 업무다',
        status: h3WorkRate >= 50 ? 'supported' : (h3WorkRate >= 25 ? 'partially_supported' : 'not_supported'),
        evidence: {
          totalOvertimeEvents: h3Total,
          workEvents: h3Work,
          personalEvents: h3Personal,
          unclassified: h3Total - h3Work - h3Personal,
          workRate: `${h3WorkRate}%`,
        },
        conclusion: h3WorkRate >= 50
          ? `지지됨 — 야근 활동의 ${h3WorkRate}%가 업무 앱 사용. 야근이 실제 업무 처리임.`
          : `불분명 — 업무 비율 ${h3WorkRate}%로 개인 사용이 혼재. 더 세밀한 분석 필요.`,
        nextStep: '야근 시간대 windowTitle 전수 분류로 정확한 업무/개인 비율 확인',
      });

      // 캐시 업데이트
      _investigationCache.hypotheses = hypotheses;

      res.json({
        ok: true,
        period: `${days}일`,
        hypotheses,
        summary: {
          total: hypotheses.length,
          supported: hypotheses.filter(h => h.status === 'supported').length,
          partial: hypotheses.filter(h => h.status === 'partially_supported').length,
          notSupported: hypotheses.filter(h => h.status === 'not_supported').length,
        },
      });
    } catch (e) {
      console.error('[deep-investigator] hypotheses error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 7. GET /decision-patterns — 직원 판단 기준 분석
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/decision-patterns', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const userId = req.query.userId || null;

      // 같은 시작점에서 다른 경로로 분기하는 패턴 감지
      const branchResult = await db.query(`
        WITH ordered AS (
          SELECT user_id, timestamp,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
            LEAD(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow'))
              OVER (PARTITION BY user_id ORDER BY timestamp) as next_win,
            EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as hour_kst,
            EXTRACT(DOW FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as dow
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            ${userId ? 'AND user_id = $2' : ''}
        )
        SELECT
          win as from_window,
          next_win as to_window,
          COUNT(*) as frequency,
          AVG(hour_kst) as avg_hour,
          array_agg(DISTINCT dow::int) as days_of_week
        FROM ordered
        WHERE win IS NOT NULL AND next_win IS NOT NULL
          AND win != next_win
        GROUP BY win, next_win
        HAVING COUNT(*) >= 3
        ORDER BY win, frequency DESC
      `, userId ? [days, userId] : [days]);

      // 같은 시작점에서 여러 목적지로 분기하는 지점 감지
      const branchPoints = {};
      for (const row of branchResult.rows) {
        const from = row.from_window;
        if (!branchPoints[from]) {
          branchPoints[from] = {
            fromWindow: from,
            fromApp: extractAppName(from),
            options: [],
            totalTransitions: 0,
          };
        }
        branchPoints[from].options.push({
          action: row.to_window,
          app: extractAppName(row.to_window),
          frequency: parseInt(row.frequency),
          avgHour: Math.round(parseFloat(row.avg_hour || 0)),
          daysOfWeek: row.days_of_week || [],
        });
        branchPoints[from].totalTransitions += parseInt(row.frequency);
      }

      // 2개 이상 선택지가 있는 분기점만 추출
      const patterns = [];
      for (const [from, bp] of Object.entries(branchPoints)) {
        if (bp.options.length < 2) continue;

        // 비율 계산
        const options = bp.options
          .sort((a, b) => b.frequency - a.frequency)
          .slice(0, 5)
          .map(opt => ({
            action: opt.action,
            app: opt.app,
            frequency: `${Math.round((opt.frequency / bp.totalTransitions) * 100)}%`,
            count: opt.frequency,
            condition: _inferCondition(opt, bp),
          }));

        patterns.push({
          task: _inferTaskName(from),
          decisionPoint: from,
          app: bp.fromApp,
          totalTransitions: bp.totalTransitions,
          options,
          insight: _generateDecisionInsight(options, bp),
        });
      }

      // 전환 횟수 기준 정렬
      patterns.sort((a, b) => b.totalTransitions - a.totalTransitions);

      res.json({
        ok: true,
        period: `${days}일`,
        patterns: patterns.slice(0, 20),
        summary: {
          totalDecisionPoints: patterns.length,
          topDecisionPoint: patterns[0]?.decisionPoint || 'none',
          avgOptionsPerPoint: patterns.length > 0
            ? (patterns.reduce((s, p) => s + p.options.length, 0) / patterns.length).toFixed(1)
            : 0,
        },
        philosophy: '같은 화면에서 다른 행동을 선택하는 분기점을 감지하면, 그 판단 기준을 이해해야 자동화할 수 있다.',
      });
    } catch (e) {
      console.error('[deep-investigator] decision-patterns error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 8. GET /work-sequences — 실제 업무 시퀀스 (전체 흐름)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/work-sequences', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days) || 7;
      const userId = req.query.userId || null;
      const minLength = parseInt(req.query.minLength) || 3;

      // 5분 윈도우로 연속 이벤트 체인 추출 → 실제 업무 시퀀스
      const seqResult = await db.query(`
        WITH ordered_events AS (
          SELECT
            user_id, timestamp, type,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
            COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app,
            LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_ts
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            ${userId ? 'AND user_id = $2' : ''}
        ),
        with_chain AS (
          SELECT *,
            SUM(CASE
              WHEN prev_ts IS NULL THEN 1
              WHEN EXTRACT(EPOCH FROM (timestamp::timestamptz - prev_ts::timestamptz)) > 300 THEN 1
              ELSE 0
            END) OVER (PARTITION BY user_id ORDER BY timestamp) as chain_id
          FROM ordered_events
        )
        SELECT
          user_id,
          chain_id,
          MIN(timestamp) as start_time,
          MAX(timestamp) as end_time,
          EXTRACT(EPOCH FROM (MAX(timestamp::timestamptz) - MIN(timestamp::timestamptz))) as duration_seconds,
          COUNT(*) as event_count,
          array_agg(DISTINCT COALESCE(win, 'unknown') ORDER BY COALESCE(win, 'unknown')) as unique_windows,
          array_agg(win ORDER BY timestamp) as window_sequence
        FROM with_chain
        WHERE win IS NOT NULL
        GROUP BY user_id, chain_id
        HAVING COUNT(*) >= $${userId ? 3 : 2}
        ORDER BY MIN(timestamp) DESC
        LIMIT 100
      `, userId ? [days, userId, minLength] : [days, minLength]);

      const sequences = [];
      for (const row of seqResult.rows) {
        const windowSeq = row.window_sequence || [];
        const duration = parseFloat(row.duration_seconds || 0);

        // 연속 중복 제거하여 실제 스텝 추출
        const steps = [];
        let lastWin = null;
        let lastCount = 0;
        for (const win of windowSeq) {
          if (win === lastWin) {
            lastCount++;
            continue;
          }
          if (lastWin !== null) {
            steps.push({
              window: lastWin,
              app: extractAppName(lastWin),
              isWork: isWorkWindow(lastWin),
              repeats: lastCount,
            });
          }
          lastWin = win;
          lastCount = 1;
        }
        if (lastWin) {
          steps.push({
            window: lastWin,
            app: extractAppName(lastWin),
            isWork: isWorkWindow(lastWin),
            repeats: lastCount,
          });
        }

        if (steps.length < minLength) continue;

        const workSteps = steps.filter(s => s.isWork);
        const personalSteps = steps.filter(s => !s.isWork);
        const hasHiddenWork = personalSteps.length > 0 && workSteps.length > personalSteps.length;

        sequences.push({
          userId: row.user_id,
          chainId: row.chain_id,
          startTime: row.start_time,
          endTime: row.end_time,
          duration: duration > 60 ? `${Math.round(duration / 60)}분` : `${Math.round(duration)}초`,
          durationSeconds: Math.round(duration),
          eventCount: parseInt(row.event_count),
          stepCount: steps.length,
          steps,
          classification: {
            workSteps: workSteps.length,
            personalSteps: personalSteps.length,
            hasHiddenWork,
            overallType: workSteps.length >= personalSteps.length ? '업무 시퀀스' : '혼합 시퀀스',
          },
          uniqueApps: [...new Set(steps.map(s => s.app))],
        });
      }

      // 시퀀스 패턴 요약
      const patternSummary = {};
      for (const seq of sequences) {
        const appPattern = seq.uniqueApps.sort().join('+');
        if (!patternSummary[appPattern]) {
          patternSummary[appPattern] = { pattern: appPattern, count: 0, avgDuration: 0 };
        }
        patternSummary[appPattern].count++;
        patternSummary[appPattern].avgDuration += seq.durationSeconds;
      }
      for (const p of Object.values(patternSummary)) {
        p.avgDuration = Math.round(p.avgDuration / p.count);
      }

      const topPatterns = Object.values(patternSummary)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      res.json({
        ok: true,
        period: `${days}일`,
        totalSequences: sequences.length,
        sequences: sequences.slice(0, 50),
        topPatterns,
        summary: {
          avgSequenceLength: sequences.length > 0
            ? (sequences.reduce((s, seq) => s + seq.stepCount, 0) / sequences.length).toFixed(1)
            : 0,
          avgDuration: sequences.length > 0
            ? Math.round(sequences.reduce((s, seq) => s + seq.durationSeconds, 0) / sequences.length) + '초'
            : '0초',
          withHiddenWork: sequences.filter(s => s.classification.hasHiddenWork).length,
          workSequences: sequences.filter(s => s.classification.overallType === '업무 시퀀스').length,
          mixedSequences: sequences.filter(s => s.classification.overallType === '혼합 시퀀스').length,
        },
      });
    } catch (e) {
      console.error('[deep-investigator] work-sequences error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ═══════════════════════════════════════════════════════════════════════
  // 자동 조사 스케줄 (4시간마다)
  // ═══════════════════════════════════════════════════════════════════════
  let _investigationTimer = null;

  async function _runInvestigation() {
    try {
      const db = getDb();
      if (!db?.query) return;

      console.log('[deep-investigator] 자동 조사 시작...');
      const startTime = Date.now();

      // 1. 오분류 재분석
      try {
        const reclassifyResult = await db.query(`
          SELECT COUNT(*) as cnt
          FROM events e1
          JOIN events e2 ON e1.user_id = e2.user_id
            AND e2.timestamp::timestamptz > e1.timestamp::timestamptz
            AND e2.timestamp::timestamptz < e1.timestamp::timestamptz + INTERVAL '5 minutes'
          WHERE e1.type IN ('keyboard.chunk', 'screen.capture')
            AND e1.timestamp::timestamptz > NOW() - INTERVAL '7 days'
            AND (e1.data_json->>'app' ILIKE '%kakao%' OR e1.data_json->'appContext'->>'currentApp' ILIKE '%kakao%')
            AND NOT (
              COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%공유방%'
              OR COALESCE(e1.data_json->>'windowTitle', e1.data_json->'appContext'->>'currentWindow') ILIKE '%거래처%'
            )
            AND (
              COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%nenova%'
              OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%불량%'
              OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%주문%'
              OR COALESCE(e2.data_json->>'windowTitle', e2.data_json->'appContext'->>'currentWindow') ILIKE '%excel%'
            )
          LIMIT 1
        `);
        _investigationCache.reclassified = [{ count: parseInt(reclassifyResult.rows[0]?.cnt || 0) }];
      } catch (e) {
        console.warn('[deep-investigator] 오분류 재분석 실패:', e.message);
      }

      // 2. 질문 목록 갱신
      try {
        const questionCount = await db.query(`
          SELECT
            COUNT(*) FILTER (WHERE data_json->>'app' ILIKE '%kakao%') as kakao_events,
            COUNT(*) FILTER (WHERE
              EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') >= 19
            ) as overtime_events,
            COUNT(*) FILTER (WHERE
              COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%claude%'
              OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%chatgpt%'
            ) as ai_events
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
        `);
        const qr = questionCount.rows[0] || {};
        // 캐시에 간단 요약만 저장
        if (parseInt(qr.kakao_events || 0) > 0 && _investigationCache.questions.length === 0) {
          _investigationCache.questions.push({
            priority: 'high',
            category: '오분류',
            question: `카카오톡 이벤트 ${qr.kakao_events}건 중 업무 관련 건 재분류 필요`,
            autoGenerated: true,
          });
        }
      } catch (e) {
        console.warn('[deep-investigator] 질문 생성 실패:', e.message);
      }

      _investigationCache.lastRun = new Date().toISOString();
      const elapsed = Date.now() - startTime;
      console.log(`[deep-investigator] 자동 조사 완료 (${elapsed}ms)`);
    } catch (e) {
      console.error('[deep-investigator] 자동 조사 에러:', e.message);
    }
  }

  // 서버 시작 15분 후 첫 실행, 이후 4시간마다
  setTimeout(() => {
    _runInvestigation();
    _investigationTimer = setInterval(_runInvestigation, 4 * 60 * 60 * 1000);
  }, 15 * 60 * 1000);


  // ═══════════════════════════════════════════════════════════════════════
  // 헬퍼 함수들 (모듈 내부)
  // ═══════════════════════════════════════════════════════════════════════

  /** 가설 생성: 개인 카톡 → 업무 앱 전환 시 */
  function _generateHypothesis(personalWindow, workWindow) {
    const pw = (personalWindow || '').toLowerCase();
    const ww = (workWindow || '').toLowerCase();

    if (ww.includes('불량') || ww.includes('공유방')) {
      return '개인 카톡으로 불량 사진을 받고, 불량 공유방에 보고, 전산에서 처리하는 흐름으로 추정';
    }
    if (ww.includes('주문') || ww.includes('nenova') || ww.includes('네노바')) {
      return '거래처에서 카톡으로 주문을 받고 바로 전산 입력하는 흐름으로 추정';
    }
    if (ww.includes('excel') || ww.includes('차감')) {
      return '카톡으로 받은 정보를 엑셀에 기록하는 업무 흐름으로 추정';
    }
    if (ww.includes('재고') || ww.includes('발주')) {
      return '카톡으로 재고/발주 관련 정보를 받아 처리하는 흐름으로 추정';
    }
    return '개인 앱에서 업무 관련 정보를 확인한 후 업무 처리로 이동한 것으로 추정';
  }

  /** 워크플로우 자동화 가능성 평가 */
  function _assessWorkflowAutomation(steps, frequency) {
    const totalSteps = steps.length;
    const hasNenova = steps.some(s => s.app === 'nenova');
    const hasExcel = steps.some(s => s.app === 'excel');
    const hasKakao = steps.some(s => s.app === 'kakaotalk');
    const hasBrowser = steps.some(s => s.app === 'browser');

    // 자동화 가능한 스텝 판별
    const automatableSteps = [];
    const manualSteps = [];

    for (const step of steps) {
      if (step.app === 'kakaotalk') {
        if (step.window && (step.window.includes('공유방') || step.window.includes('거래처'))) {
          automatableSteps.push(`${step.window} 메시지 전달`);
        } else {
          manualSteps.push(`${step.window || '카톡'} 내용 확인 + 판단`);
        }
      } else if (step.app === 'nenova') {
        // nenova 입력은 PAD로 자동화 가능하지만 좌표 확정 필요
        automatableSteps.push(`${step.window || 'nenova'} 전산 입력`);
      } else if (step.app === 'excel') {
        automatableSteps.push(`${step.window || 'Excel'} 기록 업데이트`);
      } else {
        manualSteps.push(`${step.window || step.app} 확인/판단`);
      }
    }

    const percentage = totalSteps > 0
      ? Math.round((automatableSteps.length / totalSteps) * 100)
      : 0;

    // 빈도가 높을수록 자동화 가치 높음
    const feasible = percentage >= 40 && frequency >= 5;

    let reason = '';
    if (manualSteps.length > 0 && automatableSteps.length > 0) {
      reason = `${manualSteps.join(', ')}은(는) 사람이 해야 하지만, ${automatableSteps.join(', ')}은(는) 자동화 가능`;
    } else if (automatableSteps.length > 0) {
      reason = '전체 스텝이 자동화 가능한 작업으로 구성';
    } else {
      reason = '사람의 판단이 필요한 스텝이 대부분';
    }

    const prerequisite = [];
    if (hasNenova) prerequisite.push('pyautogui 좌표 확정', 'Vision 클릭 매칭');
    if (hasKakao) prerequisite.push('카톡 메시지 파싱 정확도 확인');
    if (hasExcel) prerequisite.push('엑셀 COM 자동화 또는 openpyxl 스크립트');

    return {
      feasible,
      percentage,
      reason,
      manualSteps,
      automatableSteps,
      prerequisite: prerequisite.length > 0 ? prerequisite : undefined,
    };
  }

  /** 워크플로우 이름 자동 생성 */
  function _generateWorkflowName(steps) {
    const apps = [...new Set(steps.map(s => s.app))];

    // 특정 패턴 감지
    const hasKakao = apps.includes('kakaotalk');
    const hasNenova = apps.includes('nenova');
    const hasExcel = apps.includes('excel');

    const workWindows = steps.filter(s => s.isWork).map(s => s.window || '');
    const has불량 = workWindows.some(w => w.includes('불량'));
    const has주문 = workWindows.some(w => w.includes('주문') || w.includes('신규'));
    const has차감 = workWindows.some(w => w.includes('차감'));
    const has발주 = workWindows.some(w => w.includes('발주'));

    if (hasKakao && has불량) return '불량 접수 → 처리 플로우';
    if (hasKakao && has주문 && hasNenova) return '카톡 주문 → 전산 입력 플로우';
    if (has발주) return '발주 처리 플로우';
    if (has차감 && hasExcel) return '재고 차감 + 기록 플로우';
    if (hasKakao && hasNenova) return '카톡 수신 → 전산 처리 플로우';
    if (hasNenova && hasExcel) return '전산 → 엑셀 기록 플로우';
    if (hasKakao && hasExcel) return '카톡 → 엑셀 정리 플로우';

    return `${apps.slice(0, 3).join(' → ')} 업무 플로우`;
  }

  /** 자동화 평가 빌드 */
  function _buildAutomationAssessment(category, group, parserReady, visionReady, days) {
    const users = [...group.users];
    const avgDuration = group.durationSamples > 0
      ? Math.round(group.avgDuration / group.durationSamples)
      : 0;
    const dailyFreq = group.activeDays > 0
      ? Math.round(group.totalFrequency / group.activeDays)
      : group.totalFrequency;

    // 카테고리별 자동화 기준
    let technical = 50, data = 50, exceptions = 50, humanJudgment = 50, errorImpact = 50;
    const whatWeKnow = [];
    const whatWeDontKnow = [];
    const nextSteps = [];

    if (category.includes('주문')) {
      technical = parserReady.products > 1000 ? 85 : 60;
      data = parserReady.parsedOrders > 100 ? 70 : 40;
      exceptions = 30;
      humanJudgment = 20;
      errorImpact = 40;

      if (parserReady.products > 0) whatWeKnow.push(`마스터 품목 ${parserReady.products}개 등록됨`);
      if (parserReady.customers > 0) whatWeKnow.push(`마스터 거래처 ${parserReady.customers}개 등록됨`);
      if (parserReady.avgConfidence > 0) whatWeKnow.push(`파서 평균 신뢰도 ${Math.round(parserReady.avgConfidence * 100)}%`);
      whatWeKnow.push(`일 ${dailyFreq}건 주문 패턴 확인`);

      whatWeDontKnow.push('nenova 화면에서 정확히 어디를 클릭하는지');
      whatWeDontKnow.push('입력 후 에러 발생 시 어떻게 처리하는지');
      whatWeDontKnow.push('변경/취소 주문은 어떤 플로우를 따르는지');

      nextSteps.push('주문 입력 과정을 Vision OCR로 1주일 관찰');
      nextSteps.push('입력 실패/재시도 패턴 수집');
      nextSteps.push('변경 주문 플로우 별도 매핑');
    } else if (category.includes('불량')) {
      technical = 60;
      data = visionReady.coverageRate > 30 ? 55 : 35;
      exceptions = 40;
      humanJudgment = 70; // 불량 판단은 사람 필요
      errorImpact = 60;

      whatWeKnow.push('불량 접수 → 공유방 → 전산 처리 패턴 확인됨');
      whatWeKnow.push(`일 ${dailyFreq}건 불량 처리 확인`);

      whatWeDontKnow.push('불량 판단 기준 (사진만? 육안?');
      whatWeDontKnow.push('불량 유형별 다른 처리 플로우가 있는지');

      nextSteps.push('불량 사진 Vision 분석으로 불량 유형 자동 분류 시도');
      nextSteps.push('불량 판단 후 후속 처리는 자동화 가능 여부 확인');
    } else if (category.includes('재고') || category.includes('차감')) {
      technical = 70;
      data = 55;
      exceptions = 25;
      humanJudgment = 15;
      errorImpact = 50;

      whatWeKnow.push('재고 차감은 주문/불량 처리의 후속 작업');
      whatWeKnow.push('Excel + nenova 연동 패턴 확인됨');

      whatWeDontKnow.push('차감 계산 로직 (자동 계산? 수동 입력?)');
      whatWeDontKnow.push('예외 처리 (마이너스 재고 등)');

      nextSteps.push('차감 입력 화면 Vision 분석');
      nextSteps.push('nenova ↔ Excel 데이터 동기화 자동화 가능성 확인');
    } else if (category.includes('발주')) {
      technical = 65;
      data = 45;
      exceptions = 35;
      humanJudgment = 30;
      errorImpact = 55;

      whatWeKnow.push('발주는 재고 부족 시 발생');
      whatWeDontKnow.push('발주 결정 기준 (최소 재고? 주문량 예측?)');
      whatWeDontKnow.push('발주처 선택 기준');
      nextSteps.push('발주 패턴과 재고 수준의 상관관계 분석');
    } else {
      whatWeKnow.push(`${category} 관련 활동 일 ${dailyFreq}건 확인`);
      whatWeDontKnow.push('상세 업무 내용 파악 필요 (Vision 분석)');
      nextSteps.push(`Vision OCR로 ${category} 화면 캡처 분석 시작`);
    }

    const breakdown = { technical, data, exceptions: 100 - exceptions, humanJudgment: 100 - humanJudgment, errorImpact: 100 - errorImpact };
    const realism = Math.round(
      (breakdown.technical * 0.25) +
      (breakdown.data * 0.25) +
      (breakdown.exceptions * 0.15) +
      (breakdown.humanJudgment * 0.20) +
      (breakdown.errorImpact * 0.15)
    );

    let verdict = '자동화 불가';
    if (realism >= 80) verdict = '완전 자동화 가능';
    else if (realism >= 60) verdict = '부분 자동화 가능';
    else if (realism >= 40) verdict = '반자동화 (사람 확인 필요)';
    else verdict = '데이터 부족 — 추가 관찰 필요';

    const honestAssessment = _generateTaskHonestAssessment(category, realism, whatWeDontKnow, parserReady, visionReady);

    return {
      task: `${category} 자동화`,
      verdict,
      realism,
      breakdown,
      frequency: { total: group.totalFrequency, daily: dailyFreq, activeDays: group.activeDays },
      users,
      whatWeKnow,
      whatWeDontKnow,
      nextSteps,
      honestAssessment,
    };
  }

  /** 정직한 평가 문구 생성 */
  function _generateTaskHonestAssessment(category, realism, unknowns, parserReady, visionReady) {
    if (realism >= 70) {
      return `${category}의 기본 데이터는 확보됐지만, ${unknowns[0] || '세부 플로우 확인'}이 선행되어야 한다. Vision 분석 1~2주 관찰 후 드라이런, 1개월 후 실운영 가능 예상.`;
    }
    if (realism >= 50) {
      return `${category}은(는) 부분적으로 자동화 가능하나, 사람 판단이 필요한 단계가 있다. 완전 자동화보다 반자동(알림+원클릭 처리)이 현실적이다.`;
    }
    return `${category}은(는) 현재 데이터만으로 자동화 판단이 어렵다. ${unknowns.length > 0 ? unknowns[0] : '추가 데이터 수집'}부터 시작해야 한다.`;
  }

  /** 정직한 전체 요약 */
  function _generateHonestSummary(assessments, parserReady, visionReady) {
    const total = assessments.length;
    const doable = assessments.filter(a => a.realism >= 60).length;

    if (total === 0) return '분석 대상 업무가 아직 충분하지 않다. 더 많은 데이터 수집이 필요하다.';

    let summary = `${total}개 업무 중 ${doable}개가 자동화 가능 범위. `;

    if (parserReady.products > 1000) {
      summary += `파서(품목 ${parserReady.products}개)는 준비됐지만, `;
    } else {
      summary += '마스터 데이터가 부족하고, ';
    }

    if (visionReady.coverageRate > 50) {
      summary += `Vision 분석(커버리지 ${visionReady.coverageRate}%)도 진행 중. `;
    } else {
      summary += `Vision 분석 커버리지(${visionReady.coverageRate}%)가 낮아 화면 세부 파악이 부족. `;
    }

    summary += '가장 현실적인 접근: 데이터 충분한 업무부터 반자동화(알림+원클릭) → 검증 → 완전 자동화 순서.';

    return summary;
  }

  /** 분기 조건 추론 */
  function _inferCondition(option, branchPoint) {
    const hour = option.avgHour;
    const dow = option.daysOfWeek || [];

    const conditions = [];
    if (hour < 10) conditions.push('오전 초반 (09시 전후)');
    else if (hour >= 10 && hour < 12) conditions.push('오전 (10~12시)');
    else if (hour >= 12 && hour < 14) conditions.push('점심 전후 (12~14시)');
    else if (hour >= 14 && hour < 17) conditions.push('오후 (14~17시)');
    else if (hour >= 17) conditions.push('퇴근 전후 (17시+)');

    // 특정 요일에만 나타나는 패턴
    if (dow.length > 0 && dow.length <= 3) {
      const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
      conditions.push(`주로 ${dow.map(d => dayNames[d]).join('/')}요일`);
    }

    return conditions.length > 0 ? conditions.join(', ') : '조건 미확인 — 추가 분석 필요';
  }

  /** 분기 인사이트 생성 */
  function _generateDecisionInsight(options, branchPoint) {
    const topOption = options[0];
    const topPercentStr = topOption?.frequency || '0%';

    if (options.length === 2) {
      return `${topPercentStr} 확률로 "${topOption.action}"을(를) 선택. 나머지는 "${options[1].action}". 분기 조건 파악 필요.`;
    }
    if (options.length >= 3) {
      return `${options.length}가지 선택지 중 "${topOption.action}" (${topPercentStr})이 가장 빈번. 다양한 분기 조건이 있을 수 있어 Vision 분석 필요.`;
    }
    return '분기 패턴 분석 중';
  }

  /** 작업명 추론 */
  function _inferTaskName(windowTitle) {
    if (!windowTitle) return '미확인 작업';
    const category = inferWorkCategory(windowTitle);
    if (category !== '미분류') return category;
    const app = extractAppName(windowTitle);
    return `${app} 작업`;
  }


  return router;
}

module.exports = createDeepInvestigator;
