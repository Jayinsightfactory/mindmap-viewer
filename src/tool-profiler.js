'use strict';
/**
 * tool-profiler.js — 앱별 사용 패턴 학습 + 데이터 수집 전략 설계
 *
 * 사용자가 프로그램/웹을 실행하면:
 * 1. 앱 프로필 생성 (첫 사용 시)
 * 2. 사용 패턴 축적 (키보드/마우스/시간/윈도우)
 * 3. 수집 전략 자동 설계 (뭘 더 캡처할지)
 * 4. 피드백 생성 (반복/비효율/자동화 기회)
 *
 * 저장: ~/.orbit/tool-profiles.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILES_PATH = path.join(os.homedir(), '.orbit', 'tool-profiles.json');

// ── 앱 프로필 DB ──
let _profiles = {};

function _load() {
  try { _profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); } catch { _profiles = {}; }
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(_profiles, null, 2));
  } catch {}
}

// 초기 로드
_load();

/**
 * 앱 프로필 가져오기/생성
 */
function getProfile(appName) {
  const key = (appName || '').toLowerCase();
  if (!key) return null;

  if (!_profiles[key]) {
    _profiles[key] = {
      app: key,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      totalSessions: 0,
      totalMinutes: 0,

      // 사용 패턴
      patterns: {
        avgKeysPerMin: 0,        // 분당 키 입력
        avgClicksPerMin: 0,      // 분당 클릭
        avgSessionMin: 0,        // 평균 세션 시간
        keyboardHeavy: false,    // 키보드 집중형
        mouseHeavy: false,       // 마우스 집중형
        mixedInput: false,       // 혼합형
      },

      // 자주 보는 윈도우 타이틀 (상위 10개)
      commonWindows: {},

      // 시간대별 사용량
      hourlyUsage: new Array(24).fill(0),

      // 연관 앱 (같이 쓰는 앱)
      relatedApps: {},

      // 수집 전략 (자동 설계)
      strategy: {
        captureInterval: 180,    // 기본 3분
        visionAnalysis: false,   // Vision 분석 필요 여부
        keylogDetail: 'basic',   // basic / detailed / keywords
        priority: 'normal',      // low / normal / high / critical
        automationCandidate: false,
      },

      // 피드백 이력
      feedback: [],

      // Vision 분석 결과 축적
      visionInsights: [],
    };
    _save();
  }

  return _profiles[key];
}

/**
 * 앱 활동 기록 업데이트
 */
function recordActivity(appName, data) {
  const p = getProfile(appName);
  if (!p) return;

  const now = new Date();
  p.lastSeen = now.toISOString();
  p.totalSessions++;
  p.hourlyUsage[now.getHours()]++;

  // 키보드/마우스 패턴 업데이트
  const keys = data.keyCount || 0;
  const clicks = data.mouseClicks || 0;
  const minutes = data.durationMin || 5;

  p.totalMinutes += minutes;
  const kpm = keys / Math.max(minutes, 1);
  const cpm = clicks / Math.max(minutes, 1);

  // 이동 평균
  p.patterns.avgKeysPerMin = p.patterns.avgKeysPerMin * 0.7 + kpm * 0.3;
  p.patterns.avgClicksPerMin = p.patterns.avgClicksPerMin * 0.7 + cpm * 0.3;
  p.patterns.avgSessionMin = p.totalMinutes / p.totalSessions;

  p.patterns.keyboardHeavy = p.patterns.avgKeysPerMin > 30;
  p.patterns.mouseHeavy = p.patterns.avgClicksPerMin > 15;
  p.patterns.mixedInput = p.patterns.avgKeysPerMin > 10 && p.patterns.avgClicksPerMin > 5;

  // 윈도우 타이틀 기록
  if (data.windowTitle) {
    const title = _normalizeTitle(data.windowTitle);
    p.commonWindows[title] = (p.commonWindows[title] || 0) + 1;
    // 상위 20개만 유지
    const sorted = Object.entries(p.commonWindows).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 20) {
      p.commonWindows = Object.fromEntries(sorted.slice(0, 20));
    }
  }

  // 연관 앱 기록
  if (data.previousApp) {
    const prev = data.previousApp.toLowerCase();
    p.relatedApps[prev] = (p.relatedApps[prev] || 0) + 1;
  }

  // ── 수집 전략 자동 재설계 ──
  _redesignStrategy(p);

  // ── 피드백 생성 ──
  const feedback = _generateFeedback(p);
  if (feedback) {
    p.feedback.push({ ...feedback, ts: now.toISOString() });
    if (p.feedback.length > 20) p.feedback = p.feedback.slice(-20);
  }

  _save();
  return p;
}

/**
 * Vision 분석 결과 축적
 */
function recordVisionInsight(appName, insight) {
  const p = getProfile(appName);
  if (!p || !insight) return;

  p.visionInsights.push({
    ts: new Date().toISOString(),
    activity: insight.activity,
    description: insight.description,
    details: insight.details,
  });
  // 최근 50개만
  if (p.visionInsights.length > 50) p.visionInsights = p.visionInsights.slice(-50);

  // Vision 인사이트 기반 전략 보강
  if (insight.activity === '스프레드시트' || insight.activity === '데이터분석') {
    p.strategy.visionAnalysis = true;
    p.strategy.captureInterval = Math.min(p.strategy.captureInterval, 90);
    p.strategy.priority = 'high';
  }
  if (insight.details && /반복|같은 작업|동일|매번/i.test(insight.details)) {
    p.strategy.automationCandidate = true;
  }

  _save();
}

/**
 * 수집 전략 자동 설계
 */
function _redesignStrategy(p) {
  const s = p.strategy;

  // 사용 빈도 기반
  if (p.totalSessions > 20) {
    s.priority = 'high';
    s.captureInterval = 90;
  } else if (p.totalSessions > 5) {
    s.priority = 'normal';
    s.captureInterval = 180;
  } else {
    s.priority = 'low';
    s.captureInterval = 300;
  }

  // 키보드 집중형 → 키로그 상세 수집
  if (p.patterns.keyboardHeavy) {
    s.keylogDetail = 'detailed';
  }

  // 마우스 집중형 → 스크린 캡처 중요
  if (p.patterns.mouseHeavy) {
    s.visionAnalysis = true;
    s.captureInterval = Math.min(s.captureInterval, 120);
  }

  // 혼합형 → 모든 데이터 수집
  if (p.patterns.mixedInput) {
    s.keylogDetail = 'detailed';
    s.visionAnalysis = true;
  }

  // 연관 앱 2개 번갈아 사용 → 자동화 후보
  const topRelated = Object.entries(p.relatedApps).sort((a, b) => b[1] - a[1]);
  if (topRelated.length > 0 && topRelated[0][1] > 10) {
    s.automationCandidate = true;
  }
}

/**
 * 피드백 생성
 */
function _generateFeedback(p) {
  // 반복 패턴 감지
  if (p.totalSessions > 10 && p.totalSessions % 5 === 0) {
    const topWindow = Object.entries(p.commonWindows).sort((a, b) => b[1] - a[1])[0];
    if (topWindow && topWindow[1] > p.totalSessions * 0.5) {
      return {
        type: 'routine',
        message: `"${topWindow[0]}"를 ${topWindow[1]}회 반복 사용합니다. 자동화할 수 있습니다.`,
        severity: 'suggestion',
      };
    }
  }

  // 피크 시간 감지
  if (p.totalSessions > 15 && p.totalSessions % 10 === 0) {
    const peakHour = p.hourlyUsage.indexOf(Math.max(...p.hourlyUsage));
    return {
      type: 'time_pattern',
      message: `${p.app}을 ${peakHour}시에 가장 많이 사용합니다 (${p.hourlyUsage[peakHour]}회).`,
      severity: 'info',
    };
  }

  // 자동화 제안
  if (p.strategy.automationCandidate && p.totalSessions % 7 === 0) {
    const topRelated = Object.entries(p.relatedApps).sort((a, b) => b[1] - a[1])[0];
    if (topRelated) {
      return {
        type: 'automation',
        message: `${p.app}과 ${topRelated[0]}을 자주 번갈아 사용합니다. 데이터 연동을 자동화하면 효율이 높아집니다.`,
        severity: 'action',
      };
    }
  }

  return null;
}

/**
 * 윈도우 타이틀 정규화 (숫자/타임스탬프 제거)
 */
function _normalizeTitle(title) {
  return (title || '')
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '') // 날짜
    .replace(/\d{2}:\d{2}/g, '')              // 시간
    .replace(/\(\d+\)/g, '')                  // (숫자)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

/**
 * 모든 프로필 요약
 */
function getAllProfiles() {
  return Object.values(_profiles)
    .sort((a, b) => b.totalSessions - a.totalSessions);
}

/**
 * 특정 앱의 수집 전략 반환
 */
function getStrategy(appName) {
  const p = getProfile(appName);
  return p ? p.strategy : { captureInterval: 180, visionAnalysis: false, keylogDetail: 'basic', priority: 'normal' };
}

/**
 * 최근 피드백 반환 (전체)
 */
function getRecentFeedback(limit = 10) {
  const all = [];
  for (const p of Object.values(_profiles)) {
    for (const f of p.feedback) {
      all.push({ app: p.app, ...f });
    }
  }
  return all.sort((a, b) => b.ts > a.ts ? 1 : -1).slice(0, limit);
}

module.exports = {
  getProfile,
  recordActivity,
  recordVisionInsight,
  getStrategy,
  getAllProfiles,
  getRecentFeedback,
};
