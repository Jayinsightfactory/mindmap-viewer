/**
 * src/insight-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 자동 인사이트 생성 엔진
 *
 * 역할:
 *   1. Orbit 이벤트 DB를 주기적으로 분석 (크론 방식)
 *   2. 반복 패턴 감지 → 자동화 제안 생성
 *   3. 성장 엔진과 연동해 새 제안을 growth DB에 저장
 *   4. Claude API 사용 가능 시 자연어 인사이트 생성
 *      (ANTHROPIC_API_KEY 없으면 규칙 기반 로직으로 폴백)
 *
 * 사용:
 *   const engine = require('./insight-engine');
 *   engine.start({ db, broadcastAll, saveSuggestion });   // 크론 시작
 *   engine.runOnce({ db, saveSuggestion });               // 즉시 1회 실행
 *   engine.stop();                                        // 크론 중지
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── 크론 타이머 ──────────────────────────────────────────────────────────────
let _cronInterval = null;
const CRON_INTERVAL_MS = parseInt(process.env.INSIGHT_INTERVAL_MS || String(24 * 60 * 60 * 1000)); // 기본 24시간 (하루 1번)

// ─── 인사이트 데이터 저장 경로 ────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, '..', 'data');
const INSIGHT_FILE = path.join(DATA_DIR, 'insights.jsonl');

// ─── 저장 유틸 ────────────────────────────────────────────────────────────────
function appendInsight(insight) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(INSIGHT_FILE, JSON.stringify(insight) + '\n', 'utf8');
}

function loadRecentInsights(limit = 50) {
  if (!fs.existsSync(INSIGHT_FILE)) return [];
  const lines = fs.readFileSync(INSIGHT_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─── 패턴 분석 (규칙 기반) ───────────────────────────────────────────────────

/**
 * 이벤트 배열을 분석해 인사이트 목록을 반환합니다.
 * @param {object[]} events
 * @returns {object[]} insights
 */
function analyzeEvents(events) {
  const insights = [];

  if (!events || events.length === 0) return insights;

  // ── 1. 시간대별 활동 패턴 ─────────────────────────────────────────────────
  const hourCounts = new Array(24).fill(0);
  events.forEach(e => {
    const h = new Date(e.timestamp).getHours();
    if (!isNaN(h)) hourCounts[h]++;
  });
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  if (hourCounts[peakHour] > 5) {
    insights.push({
      type:       'peak_hour',
      title:      `주요 작업 시간대: ${peakHour}시`,
      body:       `가장 활발한 작업이 ${peakHour}시~${peakHour + 1}시에 집중됩니다 (${hourCounts[peakHour]}건). 이 시간대에 중요한 작업을 배치하세요.`,
      confidence: Math.min(0.5 + hourCounts[peakHour] / events.length, 0.95),
      data:       { peakHour, hourCounts },
    });
  }

  // ── 2. 반복 파일 수정 패턴 ────────────────────────────────────────────────
  const fileCounts = {};
  events
    .filter(e => e.type === 'file.write' || e.type === 'tool.end')
    .forEach(e => {
      const file = e.data?.file_path || e.data?.filePath || e.data?.path;
      if (file) fileCounts[file] = (fileCounts[file] || 0) + 1;
    });

  const hotFiles = Object.entries(fileCounts)
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  if (hotFiles.length > 0) {
    insights.push({
      type:       'hot_files',
      title:      `반복 수정 파일 감지: ${hotFiles.length}개`,
      body:       `${hotFiles[0][0]} 파일이 ${hotFiles[0][1]}회 수정됐습니다. 잦은 수정은 리팩토링 또는 자동화 기회를 의미할 수 있습니다.`,
      confidence: 0.8,
      data:       { hotFiles },
    });
  }

  // ── 3. 오류 비율 분석 ─────────────────────────────────────────────────────
  const toolEvents  = events.filter(e => e.type?.startsWith('tool.'));
  const errorEvents = events.filter(e => e.type === 'tool.error');
  if (toolEvents.length > 10) {
    const errorRate = errorEvents.length / toolEvents.length;
    if (errorRate > 0.15) {
      insights.push({
        type:       'high_error_rate',
        title:      `오류율 경고: ${Math.round(errorRate * 100)}%`,
        body:       `지난 기간 도구 호출 중 ${Math.round(errorRate * 100)}%가 오류로 종료됐습니다. 자주 실패하는 도구를 점검하세요.`,
        confidence: 0.9,
        data:       { errorRate, errorCount: errorEvents.length, totalTools: toolEvents.length },
      });
    }
  }

  // ── 4. 세션 간격 패턴 (번아웃 위험 감지) ──────────────────────────────────
  const recentDays = {};
  const now = Date.now();
  events.forEach(e => {
    const dayKey = new Date(e.timestamp).toISOString().slice(0, 10);
    recentDays[dayKey] = (recentDays[dayKey] || 0) + 1;
  });
  const dayList = Object.entries(recentDays).sort(([a], [b]) => a.localeCompare(b));

  if (dayList.length >= 7) {
    const last7 = dayList.slice(-7).map(([, c]) => c);
    const avg   = last7.reduce((s, c) => s + c, 0) / 7;
    const today = last7[last7.length - 1];
    if (today > avg * 2.5 && today > 50) {
      insights.push({
        type:       'activity_spike',
        title:      '오늘 활동량 급증 감지',
        body:       `오늘 이벤트 수(${today})가 주간 평균(${Math.round(avg)})의 ${Math.round(today / avg)}배입니다. 집중 작업 중이신가요?`,
        confidence: 0.75,
        data:       { today, weeklyAvg: Math.round(avg) },
      });
    }
  }

  // ── 5. 채널 다양성 체크 ───────────────────────────────────────────────────
  const channels = new Set(events.map(e => e.channelId || e.channel_id).filter(Boolean));
  if (channels.size === 1 && events.length > 100) {
    insights.push({
      type:       'single_channel',
      title:      '채널 분리 추천',
      body:       `모든 이벤트가 채널 하나에 집중됩니다. 프로젝트/팀별로 채널을 분리하면 맥락이 명확해집니다.`,
      confidence: 0.7,
      data:       { channelCount: 1, eventCount: events.length },
    });
  }

  // ── 6. 야간 작업 감지 ─────────────────────────────────────────────────────
  const nightEvents = events.filter(e => {
    const h = new Date(e.timestamp).getHours();
    return h >= 23 || h <= 4;
  });
  if (nightEvents.length / events.length > 0.3) {
    insights.push({
      type:       'night_work',
      title:      '야간 작업 비율 높음',
      body:       `전체 작업의 ${Math.round(nightEvents.length / events.length * 100)}%가 밤 11시~새벽 5시에 발생합니다. 지속 가능한 작업 패턴을 위해 일정 조정을 고려하세요.`,
      confidence: 0.85,
      data:       { nightRatio: (nightEvents.length / events.length).toFixed(2) },
    });
  }

  return insights;
}

// ─── Ollama 인사이트 (로컬 LLM) ──────────────────────────────────────────────

/**
 * Ollama 로컬 모델로 인사이트를 보강합니다.
 * INSIGHT_ENGINE=ollama 또는 직접 호출 시 사용됩니다.
 *
 * 활성 모델 우선순위:
 *   1. data/model-config.json activeModel (커스텀 학습 모델)
 *   2. OLLAMA_MODEL 환경변수
 *   3. 기본값 'llama3.2'
 *
 * @param {object[]} ruleInsights - 규칙 기반 인사이트 배열
 * @param {object}   stats        - 통계 요약
 * @returns {Promise<object[]>}
 */
async function enrichWithOllama(ruleInsights, stats) {
  const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

  // 활성 모델 조회 (model-config.json → env → 기본값)
  let model;
  try {
    const configPath = path.join(DATA_DIR, 'model-config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    model = cfg.activeModel;
  } catch { /* 파일 없으면 폴백 */ }
  model = model || process.env.OLLAMA_MODEL || 'llama3.2';

  try {
    const prompt = [
      `개발 데이터 요약:`,
      JSON.stringify(stats, null, 2),
      ``,
      `규칙 기반 분석 결과:`,
      ruleInsights.map(i => `- ${i.title}: ${i.body}`).join('\n'),
      ``,
      `위 데이터를 바탕으로 추가 인사이트 2개를 JSON 배열로 반환하세요:`,
      `[{"title":"...","body":"...","type":"ollama_insight","confidence":0.7}]`,
      `한국어로 작성하고 구체적인 수치를 포함하세요.`,
    ].join('\n');

    const res = await fetch(`${baseUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model,
        stream: false,
        prompt,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const data  = await res.json();
    const match = (data.response || '').match(/\[[\s\S]*?\]/);

    if (match) {
      const ollamaInsights = JSON.parse(match[0]);
      if (Array.isArray(ollamaInsights) && ollamaInsights.length > 0) {
        return [...ruleInsights, ...ollamaInsights];
      }
    }
  } catch (err) {
    console.warn('[insight-engine] Ollama 폴백:', err.message);
  }

  return ruleInsights;
}

// ─── LLM 선택 래퍼 ──────────────────────────────────────────────────────────

/**
 * INSIGHT_ENGINE 환경변수에 따라 적절한 LLM 인사이트 엔진을 선택합니다.
 *
 * 선택 우선순위:
 *   1. INSIGHT_ENGINE=ollama  → enrichWithOllama
 *   2. ANTHROPIC_API_KEY 있음 → enrichWithClaude
 *   3. 없음                  → 규칙 기반 인사이트만 반환
 *
 * @param {object[]} ruleInsights
 * @param {object}   stats
 * @returns {Promise<object[]>}
 */
async function enrichWithLLM(ruleInsights, stats) {
  if (process.env.ANTHROPIC_API_KEY) {
    return enrichWithClaude(ruleInsights, stats);
  }
  return ruleInsights;
}

// ─── Claude API 인사이트 (옵셔널) ────────────────────────────────────────────

/**
 * ANTHROPIC_API_KEY가 있으면 Claude로 자연어 인사이트를 생성합니다.
 * 없으면 규칙 기반 인사이트만 반환합니다.
 *
 * @param {object[]} ruleInsights - 규칙 기반 인사이트 배열
 * @param {object}   stats        - 통계 요약
 * @returns {Promise<object[]>}
 */
async function enrichWithClaude(ruleInsights, stats) {
  if (!process.env.ANTHROPIC_API_KEY) return ruleInsights;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.Anthropic();

    const prompt = `당신은 AI 개발 도구 사용 패턴 분석 전문가입니다.

다음은 개발자의 AI 도구 사용 통계입니다:
${JSON.stringify(stats, null, 2)}

규칙 기반 분석 결과:
${ruleInsights.map(i => `- ${i.title}: ${i.body}`).join('\n')}

위 데이터를 바탕으로 개발자에게 실용적인 조언 2가지를 추가로 생성하세요.
JSON 배열 형식: [{"title":"...", "body":"...", "type":"claude_insight", "confidence":0.8}]
한국어로 작성하고 구체적인 수치를 포함하세요.`;

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const claudeInsights = JSON.parse(match[0]);
      return [...ruleInsights, ...claudeInsights];
    }
  } catch (err) {
    // Claude API 실패 시 규칙 기반 인사이트만 반환 (조용히 폴백)
    console.warn('[insight-engine] Claude API 폴백:', err.message);
  }

  return ruleInsights;
}

// ─── 메인 실행 함수 ─────────────────────────────────────────────────────────

/**
 * 인사이트 분석을 1회 실행합니다.
 *
 * @param {{ getAllEvents, saveSuggestion, broadcastAll }} deps
 * @returns {Promise<object[]>} 생성된 인사이트 배열
 */
async function runOnce({ getAllEvents, saveSuggestion, broadcastAll }) {
  try {
    const events = getAllEvents();
    if (!events || events.length < 10) {
      return [];
    }

    // 통계 집계
    const stats = {
      totalEvents:  events.length,
      dateRange: {
        from: events[0]?.timestamp,
        to:   events[events.length - 1]?.timestamp,
      },
      typeBreakdown: events.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      }, {}),
      sessionCount: new Set(events.map(e => e.sessionId || e.session_id)).size,
      channelCount: new Set(events.map(e => e.channelId || e.channel_id)).size,
    };

    // 규칙 기반 분석
    const ruleInsights = analyzeEvents(events);

    // LLM 보강 (Ollama / Claude / 규칙 기반 자동 선택)
    const insights = await enrichWithLLM(ruleInsights, stats);

    const timestamp = new Date().toISOString();

    // 인사이트를 growth suggestion으로 저장
    insights.forEach(insight => {
      const record = {
        ...insight,
        timestamp,
        runAt: timestamp,
      };

      appendInsight(record);

      // 성장 엔진 DB에도 저장 (있으면)
      if (saveSuggestion) {
        try {
          saveSuggestion({
            type:        insight.type,
            title:       insight.title,
            description: insight.body,
            confidence:  insight.confidence || 0.7,
            metadata:    JSON.stringify(insight.data || {}),
          });
        } catch {}
      }
    });

    // WebSocket으로 실시간 알림
    if (broadcastAll && insights.length > 0) {
      broadcastAll({
        type:     'new_insights',
        insights: insights.map(i => ({ title: i.title, type: i.type, confidence: i.confidence })),
        count:    insights.length,
        timestamp,
      });
    }

    console.log(`[insight-engine] ${insights.length}개 인사이트 생성 (이벤트 ${events.length}개 분석)`);
    return insights;

  } catch (err) {
    console.error('[insight-engine] 분석 오류:', err.message);
    return [];
  }
}

// ─── 크론 시작/중지 ──────────────────────────────────────────────────────────

/**
 * 주기적 인사이트 생성을 시작합니다.
 *
 * @param {{ getAllEvents, saveSuggestion, broadcastAll, intervalMs? }} deps
 */
function start({ getAllEvents, saveSuggestion, broadcastAll, intervalMs }) {
  if (_cronInterval) {
    console.warn('[insight-engine] 이미 실행 중입니다.');
    return;
  }
  const interval = intervalMs || CRON_INTERVAL_MS;
  console.log(`[insight-engine] 시작 — ${interval / 1000 / 60}분 주기`);

  // 즉시 1회 실행 후 주기 반복
  runOnce({ getAllEvents, saveSuggestion, broadcastAll });
  _cronInterval = setInterval(() => {
    runOnce({ getAllEvents, saveSuggestion, broadcastAll });
  }, interval);
}

function stop() {
  if (_cronInterval) {
    clearInterval(_cronInterval);
    _cronInterval = null;
    console.log('[insight-engine] 중지됨');
  }
}

// ─── 인사이트 조회 ───────────────────────────────────────────────────────────
function getInsights(limit = 50) {
  return loadRecentInsights(limit);
}

module.exports = { start, stop, runOnce, getInsights, analyzeEvents };
