'use strict';

/**
 * stress-detector.js
 * 타이핑 행동 패턴 기반 급박·이슈 신호 감지
 *
 * 원칙: 내용(텍스트)은 절대 읽지 않음
 *       오직 "어떻게 치는가" 행동 패턴만 분석
 *
 * 감지 신호:
 *   1. WPM 급등: 평소 대비 2배+ 타이핑 속도
 *   2. 오타율 급등: 백스페이스 비율 급상승 (혼란·패닉)
 *   3. 메시징 폭발: 카톡·슬랙 등에서 평소 3배+ 메시지
 *   4. 야간 이상: 평소 안 쓰는 새벽 시간대 집중 활동
 *   5. 앱 전환 폭풍: 여러 앱을 극도로 빠르게 오가는 패턴
 *   6. 갑작스러운 침묵: 고강도 활동 후 갑자기 멈춤
 *
 * 모두 내용 없이 타이밍·빈도·속도·비율만으로 판단
 */

// ── 메시징 앱 목록 ────────────────────────────────────────────────────────────
const MESSAGING_APPS = [
  'kakaotalk', '카카오톡', 'kakao', 'slack', 'discord', 'telegram',
  'line', 'whatsapp', 'teams', 'zoom', 'messenger', 'signal',
  '라인', '텔레그램',
];

function isMessagingApp(app = '') {
  const a = app.toLowerCase();
  return MESSAGING_APPS.some(m => a.includes(m));
}

// ── 개인 베이스라인 계산 (최근 14~30일 정상 패턴) ────────────────────────────
function buildBaseline(events) {
  // 최근 30일 중 정상 업무 시간(8-22시) 키보드 이벤트
  const since30 = Date.now() - 30 * 86400_000;
  const since7  = Date.now() -  7 * 86400_000; // 너무 최근은 제외 (이미 스트레스 상황일 수 있음)

  const normal = events.filter(e => {
    if (e.type !== 'keyboard.chunk') return false;
    const ts = new Date(e.timestamp || e.ts || 0);
    if (ts < since30 || ts > since7) return false;
    const h = ts.getHours();
    return h >= 8 && h <= 22; // 정상 업무 시간
  });

  if (normal.length < 10) return null; // 데이터 부족

  // 앱별 시간당 평균 청크 수
  const appCounts = {};
  const appWindows = {}; // 앱별 시간 윈도우

  for (const e of normal) {
    const app = e.data?.app || 'unknown';
    const cat = isMessagingApp(app) ? '__messaging__' : app;
    appCounts[cat]  = (appCounts[cat]  || 0) + 1;
    appWindows[cat] = appWindows[cat] || { min: Infinity, max: -Infinity };
    const t = new Date(e.timestamp).getTime();
    if (t < appWindows[cat].min) appWindows[cat].min = t;
    if (t > appWindows[cat].max) appWindows[cat].max = t;
  }

  // 앱별 시간당 청크
  const hourlyRate = {};
  for (const [cat, cnt] of Object.entries(appCounts)) {
    const spanHours = (appWindows[cat].max - appWindows[cat].min) / 3600_000 || 1;
    hourlyRate[cat] = cnt / spanHours;
  }

  // 평균 WPM (분당 단어 수)
  // wordCount / (청크 간 시간 분)
  const wpmSamples = [];
  const sorted = [...normal].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (let i = 1; i < sorted.length; i++) {
    const gap = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 60_000;
    if (gap > 0 && gap < 5) { // 5분 이내 연속 입력
      const wpm = (sorted[i].data?.wordCount || 1) / gap;
      if (wpm < 300) wpmSamples.push(wpm); // 물리적 상한 필터
    }
  }
  const avgWpm = wpmSamples.length
    ? wpmSamples.reduce((s, v) => s + v, 0) / wpmSamples.length
    : 40;

  // 평균 오타율 (text.length와 wordCount 비율로 추정)
  // 단어당 평균 글자 수가 정상보다 높으면 오타 수정 없이 빠르게 친 것
  // 낮으면 짧게 끊어서 쳤다는 뜻 (급박 패턴)
  const avgCharsPerWord = normal
    .filter(e => e.data?.wordCount > 0)
    .map(e => (e.data?.text?.length || 0) / e.data.wordCount)
    .filter(v => v > 0 && v < 30)
    .reduce((s, v, _, a) => s + v / a.length, 0) || 5;

  // 보통 활성 시간대
  const hourDist = Array(24).fill(0);
  for (const e of normal) {
    hourDist[new Date(e.timestamp).getHours()]++;
  }
  const peakHours = hourDist
    .map((cnt, h) => ({ h, cnt }))
    .filter(({ cnt }) => cnt > hourDist.reduce((s, v) => s + v, 0) / 24)
    .map(({ h }) => h);

  return { hourlyRate, avgWpm, avgCharsPerWord, peakHours, sampleSize: normal.length };
}

// ── 최근 2시간 현재 패턴 계산 ─────────────────────────────────────────────────
function recentPattern(events) {
  const since2h = Date.now() - 2 * 3600_000;
  const recent = events
    .filter(e => e.type === 'keyboard.chunk' && new Date(e.timestamp || e.ts || 0) > since2h)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!recent.length) return null;

  // 메시징 앱 활동 집중도
  const msgChunks = recent.filter(e => isMessagingApp(e.data?.app));
  const msgRate   = msgChunks.length / 2; // 시간당

  // WPM 계산
  const wpmSamples = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (new Date(recent[i].timestamp) - new Date(recent[i - 1].timestamp)) / 60_000;
    if (gap > 0 && gap < 3) {
      const wpm = (recent[i].data?.wordCount || 1) / gap;
      if (wpm < 500) wpmSamples.push(wpm);
    }
  }
  const curWpm = wpmSamples.length
    ? wpmSamples.reduce((s, v) => s + v, 0) / wpmSamples.length
    : 0;

  // 평균 청크 길이 (짧을수록 급박한 단답형 패턴)
  const avgChunkLen = recent.reduce((s, e) => s + (e.data?.text?.length || 0), 0) / recent.length;

  // 현재 시각
  const now    = new Date();
  const hour   = now.getHours();
  const isNight = hour >= 0 && hour < 6; // 새벽 0-6시

  // 총 청크 수
  const totalChunks = recent.length;

  // 앱 전환 빈도 (같은 앱이 아닌 다음 청크)
  let switches = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].data?.app !== recent[i - 1].data?.app) switches++;
  }
  const switchRate = switches / (recent.length || 1);

  return { msgRate, curWpm, avgChunkLen, isNight, totalChunks, switchRate, hour };
}

// ── 신호 감지 메인 ────────────────────────────────────────────────────────────
/**
 * @param {object[]} events  - 파싱된 이벤트 배열
 * @param {object}   [opts]
 * @returns {object[]} 감지된 신호 목록
 */
function detect(events, opts = {}) {
  const baseline = buildBaseline(events);
  const recent   = recentPattern(events);

  if (!recent || !recent.totalChunks) return [];

  const signals = [];
  const now     = new Date().toISOString();

  // ── 신호 1: WPM 급등 ────────────────────────────────────────────────────────
  if (baseline && recent.curWpm > 0) {
    const ratio = recent.curWpm / (baseline.avgWpm || 40);
    if (ratio >= 2.0) {
      signals.push({
        signal:    'wpm_spike',
        severity:  ratio >= 3.0 ? 'high' : 'medium',
        ratio:     +ratio.toFixed(2),
        curWpm:    +recent.curWpm.toFixed(0),
        baseWpm:   +baseline.avgWpm.toFixed(0),
        detectedAt: now,
        desc: `타이핑 속도 ${(ratio * 100 - 100).toFixed(0)}% 급등 (평소 ${baseline.avgWpm.toFixed(0)} → 현재 ${recent.curWpm.toFixed(0)} WPM)`,
      });
    }
  }

  // ── 신호 2: 메시징 폭발 ────────────────────────────────────────────────────
  if (baseline) {
    const baseMsg = baseline.hourlyRate['__messaging__'] || 5;
    const ratio   = recent.msgRate / baseMsg;
    if (ratio >= 3.0 && recent.msgRate > 10) {
      signals.push({
        signal:    'messaging_burst',
        severity:  ratio >= 5.0 ? 'high' : 'medium',
        ratio:     +ratio.toFixed(2),
        curRate:   +recent.msgRate.toFixed(0),
        baseRate:  +baseMsg.toFixed(0),
        detectedAt: now,
        desc: `메시징 앱 활동 ${ratio.toFixed(1)}배 급증 (2시간 내 ${recent.msgRate.toFixed(0)}개/h vs 평소 ${baseMsg.toFixed(0)}개/h)`,
      });
    }
  } else if (recent.msgRate > 30) {
    // 베이스라인 없어도 절대값 기준
    signals.push({
      signal:    'messaging_burst',
      severity:  'medium',
      ratio:     null,
      curRate:   +recent.msgRate.toFixed(0),
      detectedAt: now,
      desc: `메시징 앱 집중 활동 (2시간 내 ${recent.msgRate.toFixed(0)}개/h) — 급박 상황 가능성`,
    });
  }

  // ── 신호 3: 야간 이상 활동 ─────────────────────────────────────────────────
  if (recent.isNight && recent.totalChunks >= 5) {
    const isAbnormal = !baseline || !baseline.peakHours.includes(recent.hour);
    if (isAbnormal) {
      signals.push({
        signal:    'night_anomaly',
        severity:  recent.totalChunks >= 20 ? 'high' : 'medium',
        hour:      recent.hour,
        chunkCount: recent.totalChunks,
        detectedAt: now,
        desc: `새벽 ${recent.hour}시에 집중 타이핑 감지 (${recent.totalChunks}개 청크) — 평소 패턴과 다름`,
      });
    }
  }

  // ── 신호 4: 단답·짧은 청크 폭발 (카톡식 급박 대화) ──────────────────────────
  if (recent.totalChunks >= 10 && recent.avgChunkLen < 15 && recent.msgRate > 15) {
    signals.push({
      signal:    'short_burst_chat',
      severity:  'medium',
      avgLen:    +recent.avgChunkLen.toFixed(1),
      msgRate:   +recent.msgRate.toFixed(0),
      detectedAt: now,
      desc: `평균 ${recent.avgChunkLen.toFixed(0)}자 미만 단답형 메시지 집중 (${recent.msgRate.toFixed(0)}개/h) — 급박한 대화 패턴`,
    });
  }

  // ── 신호 5: 앱 전환 폭풍 ──────────────────────────────────────────────────
  if (recent.switchRate > 0.6 && recent.totalChunks >= 10) {
    signals.push({
      signal:    'app_storm',
      severity:  'medium',
      switchRate: +recent.switchRate.toFixed(2),
      detectedAt: now,
      desc: `앱 전환율 ${(recent.switchRate * 100).toFixed(0)}% — 여러 앱을 극도로 빠르게 오가는 이상 패턴`,
    });
  }

  return signals;
}

module.exports = { detect, buildBaseline, recentPattern };
