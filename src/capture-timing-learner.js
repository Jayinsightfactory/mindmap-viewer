'use strict';
/**
 * capture-timing-learner.js — 캡처 타이밍 학습 에이전트
 *
 * 목표: 사용자 패턴을 학습해서 앱별 최적 캡처 간격을 도출 → PC로 전송
 *
 * 알고리즘:
 * 1. 최근 N일 screen.capture + screen.analyzed 이벤트 분석 (PG)
 * 2. 앱별로 캡처 간격 + "유용 비율" 계산
 * 3. 유용 캡처의 중앙값 간격 = 자연 발생 리듬 → 최적 쿨타임
 * 4. 결과를 daemon command queue에 전송 (PC가 폴링 시 수신 → 파일 저장)
 *
 * "유용한 캡처" 기준:
 * - trigger = app_switch | idle_result (사용자 행동 변화 시점)
 * - screen.analyzed 결과가 non-idle, non-empty activity
 * - automatable: true
 *
 * "불필요한 캡처" 기준:
 * - 이전 캡처와 windowTitle 동일 + 30초 이내 = 너무 빈번
 * - screen.analyzed 결과가 'idle' 또는 없음
 */

const MIN_COOLTIME     = 30  * 1000;  // 절대 하한: 30초
const MAX_COOLTIME     = 300 * 1000;  // 절대 상한: 5분
const DEFAULT_COOLTIME = 60  * 1000;  // 분석 데이터 부족 시 기본값
const MIN_SAMPLES      = 10;          // 최소 샘플 수 (미달 시 기본값 유지)
const ANALYSIS_DAYS    = 7;           // 분석 기간

// 유용한 트리거 (캡처 자체가 가치 있는 타이밍)
const USEFUL_TRIGGERS = new Set(['app_switch', 'idle_result', 'title_change']);

/**
 * 단일 userId + PC 조합의 캡처 이벤트를 분석해서 앱별 최적 쿨타임 반환
 * @param {Object} pool - PG pool
 * @param {string} userId
 * @param {string} hostname
 * @returns {{ byApp: Object, default: number, sampleCount: number, analyzedAt: string }}
 */
async function analyzeForUser(pool, userId, hostname) {
  const since = new Date(Date.now() - ANALYSIS_DAYS * 24 * 3600 * 1000).toISOString();

  // 1. 캡처 이벤트 로드
  const { rows: captures } = await pool.query(
    `SELECT id, timestamp, data_json
     FROM events
     WHERE type = 'screen.capture'
       AND user_id = $1
       AND data_json->>'hostname' = $2
       AND timestamp > $3
     ORDER BY timestamp ASC`,
    [userId, hostname, since]
  );

  if (captures.length < MIN_SAMPLES) {
    return { byApp: {}, default: DEFAULT_COOLTIME, sampleCount: captures.length, analyzedAt: new Date().toISOString() };
  }

  // 2. Vision 분석 결과 로드 (capture id → analyzed result 매핑)
  const { rows: analyzed } = await pool.query(
    `SELECT data_json
     FROM events
     WHERE type = 'screen.analyzed'
       AND user_id = $1
       AND data_json->>'hostname' = $2
       AND timestamp > $3`,
    [userId, hostname, since]
  );

  // filename → analysis 매핑 (screen.analyzed.data.filename = screen.capture의 filename)
  const analysisMap = new Map();
  for (const a of analyzed) {
    const d = a.data_json || {};
    const fn = d.filename || '';
    if (fn) analysisMap.set(fn, d);
  }

  // 3. 캡처 파싱 + 유용성 판별
  const parsed = captures.map(row => {
    const d = row.data_json || {};
    const ts = new Date(row.timestamp).getTime();
    const app = (d.app || d.appContext?.currentApp || 'unknown').toLowerCase().trim() || 'unknown';
    const title = d.windowTitle || d.appContext?.currentWindow || '';
    const trigger = d.trigger || '';
    const filename = d.filename || '';

    const analysis = analysisMap.get(filename) || null;
    const isUseful =
      USEFUL_TRIGGERS.has(trigger) ||
      (analysis && analysis.automatable) ||
      (analysis && analysis.activity && analysis.activity !== 'idle' && analysis.activity !== '');

    return { ts, app, title, trigger, isUseful };
  });

  // 4. 앱별 통계 계산
  const appStats = {};
  let prevByApp = {};

  for (const item of parsed) {
    const app = item.app;
    if (!appStats[app]) {
      appStats[app] = { total: 0, useful: 0, gaps: [], redundant: 0 };
    }
    const s = appStats[app];
    s.total++;

    // 이전 캡처와 같은 앱에서의 간격
    const prev = prevByApp[app];
    if (prev) {
      const gap = item.ts - prev.ts;

      // 불필요 판별: 30초 이내 + 동일 타이틀
      const sameTitle = item.title && prev.title && item.title === prev.title;
      if (gap < 30000 && sameTitle) {
        s.redundant++;
      }

      if (item.isUseful) {
        // 유용한 캡처들 사이의 간격만 기록
        if (prev.isUseful) s.gaps.push(gap);
        s.useful++;
      }
    } else if (item.isUseful) {
      s.useful++;
    }

    prevByApp[app] = item;
  }

  // 5. 앱별 최적 쿨타임 계산
  const byApp = {};

  for (const [app, s] of Object.entries(appStats)) {
    if (s.total < 5) continue; // 샘플 부족

    const usefulRatio = s.useful / s.total;
    const redundantRatio = s.redundant / s.total;

    let optimal;

    if (s.gaps.length >= 3) {
      // 유용한 캡처 간 중앙값 간격 = 자연 발생 리듬
      const sorted = [...s.gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      // 유용 비율이 높으면 조금 짧게 (더 자주 봐도 됨)
      // 유용 비율이 낮으면 길게 (현재보다 더 줄여야 함)
      if (usefulRatio > 0.6) {
        optimal = median * 0.9;
      } else if (usefulRatio > 0.3) {
        optimal = median;
      } else {
        optimal = median * 1.5;
      }

      // 중복 캡처가 많으면 쿨타임 늘리기
      if (redundantRatio > 0.3) optimal = Math.max(optimal, 60000);

    } else if (usefulRatio > 0.5) {
      // 유용한 데이터가 많지만 간격 샘플이 부족 → 기본값 유지
      optimal = DEFAULT_COOLTIME;
    } else {
      // 유용한 데이터가 적음 → 길게
      optimal = DEFAULT_COOLTIME * 1.5;
    }

    byApp[app] = Math.round(Math.max(MIN_COOLTIME, Math.min(MAX_COOLTIME, optimal)));
  }

  // 6. 전체 default 계산 (앱별 중앙값의 중앙값)
  const allCooltimes = Object.values(byApp);
  let defaultCooltime = DEFAULT_COOLTIME;
  if (allCooltimes.length > 0) {
    const sorted = [...allCooltimes].sort((a, b) => a - b);
    defaultCooltime = sorted[Math.floor(sorted.length / 2)];
  }

  return {
    byApp,
    default: defaultCooltime,
    sampleCount: captures.length,
    usefulCount: parsed.filter(p => p.isUseful).length,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * 모든 활성 PC에 대해 분석 실행 후 daemon command queue에 전송
 * @param {Object} pool - PG pool
 * @param {Function} sendCommand - (hostname, action, data) => void
 * @returns {Array} results
 */
async function runForAllPCs(pool, sendCommand) {
  const since = new Date(Date.now() - ANALYSIS_DAYS * 24 * 3600 * 1000).toISOString();

  // 최근 활동이 있는 PC 목록 (hostname + userId)
  const { rows: activePCs } = await pool.query(
    `SELECT DISTINCT
       data_json->>'hostname' AS hostname,
       user_id
     FROM events
     WHERE type = 'screen.capture'
       AND timestamp > $1
       AND data_json->>'hostname' IS NOT NULL
       AND user_id != 'local'
     ORDER BY hostname`,
    [since]
  );

  const results = [];

  for (const pc of activePCs) {
    const { hostname, user_id: userId } = pc;
    if (!hostname || !userId) continue;

    try {
      const config = await analyzeForUser(pool, userId, hostname);
      config.hostname = hostname;
      config.userId = userId;

      // PC로 전송 (daemon command queue)
      if (sendCommand && config.sampleCount >= MIN_SAMPLES) {
        await sendCommand(hostname, 'capture-config', config);
        console.log(`[capture-timing-learner] ${hostname}: ${JSON.stringify(config.byApp)} default=${config.default}ms`);
      }

      results.push(config);
    } catch (e) {
      console.warn(`[capture-timing-learner] ${hostname} 분석 실패: ${e.message}`);
      results.push({ hostname, userId, error: e.message });
    }
  }

  return results;
}

module.exports = { analyzeForUser, runForAllPCs, DEFAULT_COOLTIME, MIN_COOLTIME, MAX_COOLTIME };
