'use strict';
/**
 * src/certificate-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit Certificate & AI Score System
 *
 * AI 활용 역량을 정량화하여 디지털 인증서 발급
 * → 이력서/LinkedIn에 첨부 가능한 SVG/JSON 형태
 *
 * 점수 산정 기준 (총 1000점):
 *   - 사용량 (300pt):  이벤트 수, 세션 수, 활동 일수
 *   - 다양성 (200pt):  AI 도구 종류, 사용 케이스 다양성
 *   - 깊이   (200pt):  평균 세션 길이, 복잡한 작업 비율
 *   - 일관성 (150pt):  연속 사용, 규칙적 패턴
 *   - 기여   (150pt):  마켓 아이템 배포, 세션 공유, 커뮤니티 활동
 *
 * 등급:
 *   900+: Orbit AI Master (다이아몬드)
 *   750+: Orbit AI Expert (골드)
 *   600+: Orbit AI Proficient (실버)
 *   400+: Orbit AI Practitioner (브론즈)
 *   200+: Orbit AI Beginner (기본)
 *
 * API:
 *   GET  /api/certificate/:userId/score    — AI 점수 계산
 *   GET  /api/certificate/:userId/svg      — 인증서 SVG
 *   GET  /api/certificate/:userId/json     — 인증서 JSON (검증 가능)
 *   POST /api/certificate/:userId/issue    — 인증서 발급 (서명 포함)
 *   GET  /api/certificate/verify/:certId   — 인증서 진위 확인
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const crypto  = require('crypto');

// ─── 발급된 인증서 저장소 ────────────────────────────────────────────────────
const certStore = new Map(); // certId → certData
// [v2.3] 사람 라벨 루프 — 프록시 축(비판·메타/협업 質)을 사람 확인으로 measured 승격.
// userId → [{ kind:'verify'|'helpful', value:bool, instance, ts }]. 라벨 5개+면 해당 축 실측.
const labelStore = new Map();
const LABEL_MEASURED_MIN = 5; // 이 개수 이상 라벨이면 프록시→실측

// ─── 등급 정의 ────────────────────────────────────────────────────────────────
const GRADES = [
  { min: 900, tier: 'Master',      label: 'Orbit AI Master',      color: '#b9f2ff', borderColor: '#0ea5e9', emoji: '💎', badgeColor: '#0ea5e9' },
  { min: 750, tier: 'Expert',      label: 'Orbit AI Expert',      color: '#fef08a', borderColor: '#f59e0b', emoji: '🥇', badgeColor: '#d97706' },
  { min: 600, tier: 'Proficient',  label: 'Orbit AI Proficient',  color: '#d1fae5', borderColor: '#10b981', emoji: '🥈', badgeColor: '#059669' },
  { min: 400, tier: 'Practitioner',label: 'Orbit AI Practitioner',color: '#fce7f3', borderColor: '#ec4899', emoji: '🥉', badgeColor: '#db2777' },
  { min: 0,   tier: 'Beginner',    label: 'Orbit AI Beginner',    color: '#f3f4f6', borderColor: '#6b7280', emoji: '🌱', badgeColor: '#4b5563' },
];

function getGrade(score) {
  return GRADES.find(g => score >= g.min) || GRADES[GRADES.length - 1];
}

// ─── 점수 계산 엔진 ───────────────────────────────────────────────────────────

// AI 활용역량 평가기준 v2 — 활동량이 아니라 능력 6축. 근거: AI_CAPABILITY_CRITERIA.md
// (Long&Magerko 2020 · Worklytics/IDC 2025 · Collaborative AI Literacy+Metacognition)
// 각 축은 measured/proxy/unmeasured를 스스로 밝힘 → 거짓 정밀 금지.
function computeScore(events = [], sessions = [], labels = []) {
  // [v2.3] 사람 라벨: verify=AI출력을 검증/수정했다, helpful=AI활용이 실제 도움됐다
  const verifyLabels  = labels.filter(l => l.kind === 'verify');
  const helpfulLabels = labels.filter(l => l.kind === 'helpful');
  const ratio = (arr) => arr.length ? arr.filter(l => l.value).length / arr.length : 0;
  const verifiedRatio = ratio(verifyLabels), helpfulRatio = ratio(helpfulLabels);
  const evCount = events.length, sesCount = sessions.length;
  const dates = [...new Set(events.map(e => (e.timestamp || '').slice(0, 10)).filter(Boolean))];
  const dayCount = dates.length;
  const appOf = e => (e.data && (e.data.app || (e.data.appContext && e.data.appContext.currentApp))) || '';
  const appSet = new Set(events.map(appOf).filter(Boolean));
  // [v2.2] AI 도구는 별도 필드가 아니라 관측된 앱/활동 텍스트에서 감지(데이터에 이미 풍부히 존재)
  const AI_TOOLS = [[/claude/i, 'Claude'], [/chatgpt|openai|\bgpt\b/i, 'ChatGPT'], [/codex/i, 'Codex'], [/copilot/i, 'Copilot'], [/cursor/i, 'Cursor'], [/gemini|bard/i, 'Gemini'], [/perplexity/i, 'Perplexity'], [/grok/i, 'Grok'], [/midjourney|dall-?e|stable ?diffusion/i, 'ImageGen'], [/notion ?ai/i, 'Notion AI']];
  const aiToolOf = e => { const s = (appOf(e) + ' ' + ((e.data && (e.data.activity || e.data.windowTitle)) || '') + ' ' + (e.aiSource || (e.data && e.data.aiSource) || '')).toLowerCase();
    for (const [re, name] of AI_TOOLS) if (re.test(s)) return name; return ''; };
  const aiSet = new Set(events.map(aiToolOf).filter(Boolean));
  const aiEvents = events.filter(e => aiToolOf(e)).length;
  // 세션 길이(과업 진행 신호)
  const sMap = new Map();
  for (const ev of events) { if (!ev.sessionId) continue; sMap.set(ev.sessionId, (sMap.get(ev.sessionId) || 0) + 1); }
  const lens = [...sMap.values()];
  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const longSes = lens.filter(l => l >= 10).length;
  // automationScore(완결·가치 프록시): screen.analyzed data.automationScore
  const autoScores = events.map(e => e.data && parseFloat(e.data.automationScore)).filter(v => v > 0);
  const avgAuto = autoScores.length ? autoScores.reduce((a, b) => a + b, 0) / autoScores.length : 0;
  // [v2.2-B] 레버리지·책임성 실신호: 고가치(자동화가능) 작업량 · 민감맥락 처리량
  const highValue = events.filter(e => { const v = e.data && parseFloat(e.data.automationScore); return v >= 0.6; }).length;
  const sensitive = events.filter(e => e.data && (e.data.bankMode || /은행|금융|보안|계좌|주민|카드|급여|인사/.test(String(e.data.activity || '') + ' ' + appOf(e)))).length;
  // 일관성
  const sorted = dates.slice().sort();
  let streak = 0, cd = new Date().toISOString().slice(0, 10);
  for (let i = sorted.length - 1; i >= 0; i--) { if (sorted[i] === cd) { streak++; const d = new Date(cd); d.setDate(d.getDate() - 1); cd = d.toISOString().slice(0, 10); } else break; }
  const lastWeek = dates.filter(d => d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).length;
  const regular = lastWeek / 7;
  const clamp = (v, m) => Math.max(0, Math.min(m, Math.round(v)));
  const L = (n, cap) => Math.log10(Math.max(1, n)) / Math.log10(cap);

  // [v2.2-A] 비판·메타인지 프록시 — AI↔실제업무 왕복(교차). AI를 수동 소비만 하는 게 아니라
  // 보고→자기 작업에 반영·수정하는 행위. 데몬이 이미 캡처하는 앱전환/타이핑 시퀀스로 계산(설치코드 무관).
  const WORK_RE = /excel|nenova|ecount|이카운트|word|한글|hwp|메일|mail|works|erp|figma|photoshop|powerpnt|ppt/i;
  const timeline = events.filter(e => e.timestamp).slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  let alt = 0, prevKind = null;
  for (const e of timeline) {
    const ai = !!aiToolOf(e);
    const isWork = !ai && !!appOf(e) && ((e.data && ((e.data.typedChars | 0) > 0 || (e.data.clicks | 0) > 0)) || WORK_RE.test(appOf(e) + ' ' + ((e.data && e.data.activity) || '')));
    const kind = ai ? 'ai' : (isWork ? 'work' : null);
    if (kind) { if (prevKind && prevKind !== kind) alt++; prevKind = kind; }
  }

  const axes = {
    // 1) 통합도 (200) — 관측 강. AI가 실제 업무흐름에 얼마나 녹았나.
    integration: { max: 200, measurability: 'measured',
      score: clamp(Math.min(90, L(evCount, 10000) * 90) + Math.min(60, appSet.size / 12 * 60) + Math.min(50, regular * 50), 200),
      basis: `이벤트 ${evCount}·업무앱 ${appSet.size}종·주간활동 ${lastWeek}/7일` },
    // 2) 효과성 (200) — 관측 중. AI로 과업이 진행·완결되나.
    effectiveness: { max: 200, measurability: autoScores.length ? 'measured' : 'proxy',
      score: clamp(Math.min(110, avgLen / 25 * 110) + Math.min(90, avgAuto * 90), 200),
      basis: `평균 세션 ${avgLen.toFixed(1)}스텝·자동화가치 ${(avgAuto * 100).toFixed(0)}%(표본 ${autoScores.length})` },
    // 3) 레버리지 (150) — 실측. AI로 더 많고 고가치·복잡한 일을.
    leverage: { max: 150, measurability: 'measured',
      score: clamp(Math.min(70, L(evCount / Math.max(1, dayCount), 400) * 70) + Math.min(50, L(highValue, 200) * 50) + Math.min(30, longSes / Math.max(1, sesCount) * 30), 150),
      basis: `하루 처리 ${Math.round(evCount / Math.max(1, dayCount))}건·고가치작업 ${highValue}·복잡세션 ${longSes}` },
    // 4) 협업 품질 (150) — 관측 약(프록시). 프롬프트 質은 미측정.
    collaboration: { max: 150, measurability: aiEvents > 0 ? 'measured' : 'proxy',
      score: clamp(Math.min(90, aiSet.size / 5 * 90) + Math.min(60, L(aiEvents, 2000) * 60), 150),
      basis: `AI 도구 ${aiSet.size}종·AI 사용 ${aiEvents}회 (사용량 실측 · 프롬프트 質은 아직 미측정)` },
    // 5) 비판·메타인지 (150) — 사람 라벨 5+면 실측(검증율), 아니면 AI↔업무 왕복 프록시.
    critical: (verifyLabels.length >= LABEL_MEASURED_MIN)
      ? { max: 150, measurability: 'measured',
          score: clamp(verifiedRatio * 150, 150),
          basis: `본인 확인 검증율 ${Math.round(verifiedRatio * 100)}% (라벨 ${verifyLabels.length}건) · AI↔업무 교차 ${alt}` }
      : { max: 150, measurability: alt > 0 ? 'proxy' : 'unmeasured',
          score: alt > 0 ? clamp(Math.min(120, L(alt, 200) * 120) + 30, 150) : 30,
          basis: alt > 0 ? `AI↔업무 교차 ${alt}회 (프록시 — 검증 깊이는 사람 라벨 ${verifyLabels.length}/${LABEL_MEASURED_MIN}건)` : 'AI↔업무 교차 신호 없음 — 기준선' },
    // 6) 책임성 (150) — 프록시. 민감맥락 처리 존재 + 검증 왕복.
    responsibility: { max: 150, measurability: 'proxy',
      score: clamp(Math.min(70, L(sensitive + 1, 100) * 70) + Math.min(50, L(alt, 200) * 50) + 30, 150),
      basis: `민감맥락 ${sensitive}회·검증왕복 ${alt} (프록시 — 검증 적정성은 사람 라벨 필요)` },
  };

  const breakdown = {}; let total = 0;
  for (const k of Object.keys(axes)) { breakdown[k] = axes[k].score; total += axes[k].score; }
  total = Math.min(1000, total);
  const measuredMax = Object.values(axes).filter(a => a.measurability === 'measured').reduce((s, a) => s + a.max, 0);

  return {
    total: Math.round(total),
    breakdown,
    axes,
    measurementConfidence: Math.round(measuredMax / 1000 * 100), // 실측 축이 총점의 몇 %인가 = 이 점수를 얼마나 믿을지
    labels: { verify: verifyLabels.length, helpful: helpfulLabels.length, verifiedRatio: Math.round(verifiedRatio * 100), helpfulRatio: Math.round(helpfulRatio * 100), needed: LABEL_MEASURED_MIN },
    meta: { events: evCount, sessions: sesCount, daysActive: dayCount, streak, apps: appSet.size, aiTools: aiSet.size },
  };
}

// ─── 인증서 SVG 생성 ──────────────────────────────────────────────────────────

function makeCertSvg({ userId, score, grade, certId, issuedAt, breakdown }) {
  const w = 600, h = 400;
  const issuedDate = issuedAt ? new Date(issuedAt).toLocaleDateString('ko-KR') : new Date().toLocaleDateString('ko-KR');

  // 점수 바 (breakdown)
  const cats = [
    { name: '통합도',   score: breakdown.integration    || 0, max: 200, color: '#58a6ff' },
    { name: '효과성',   score: breakdown.effectiveness  || 0, max: 200, color: '#3fb950' },
    { name: '레버리지', score: breakdown.leverage       || 0, max: 150, color: '#bc8cff' },
    { name: '협업품질', score: breakdown.collaboration  || 0, max: 150, color: '#f778ba' },
    { name: '비판·메타', score: breakdown.critical       || 0, max: 150, color: '#ffa657' },
    { name: '책임성',   score: breakdown.responsibility || 0, max: 150, color: '#2bb3a3' },
  ];

  const bars = cats.map((cat, i) => {
    const pct     = cat.score / cat.max;
    const barW    = Math.round(pct * 200);
    const y       = 240 + i * 24;
    return `
  <text x="30"  y="${y + 10}" font-family="sans-serif" font-size="11" fill="#8b949e">${cat.name}</text>
  <rect x="100" y="${y}"      width="200" height="14" rx="3" fill="#21262d"/>
  <rect x="100" y="${y}"      width="${barW}" height="14" rx="3" fill="${cat.color}" opacity="0.9"/>
  <text x="308" y="${y + 10}" font-family="sans-serif" font-size="10" fill="#8b949e">${cat.score}/${cat.max}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#161b22"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${w}" height="${h}" fill="url(#bg)" rx="12"/>
  <rect x="2" y="2" width="${w-4}" height="${h-4}" rx="10" fill="none" stroke="${grade.borderColor}" stroke-width="2"/>

  <!-- Header -->
  <text x="30" y="45" font-family="sans-serif" font-size="22" font-weight="bold" fill="${grade.borderColor}">⬡ Orbit AI Certificate</text>
  <text x="30" y="68" font-family="sans-serif" font-size="13" fill="#8b949e">AI Engineering Proficiency</text>

  <!-- Grade Badge -->
  <rect x="400" y="20" width="170" height="60" rx="8" fill="${grade.borderColor}" opacity="0.15"/>
  <text x="485" y="45" font-family="sans-serif" font-size="24" text-anchor="middle">${grade.emoji}</text>
  <text x="485" y="68" font-family="sans-serif" font-size="11" font-weight="bold" fill="${grade.borderColor}" text-anchor="middle">${grade.tier}</text>

  <!-- Score -->
  <text x="30" y="115" font-family="sans-serif" font-size="13" fill="#8b949e">AI 활용 점수</text>
  <text x="30" y="160" font-family="sans-serif" font-size="64" font-weight="bold" fill="#e6edf3">${score}</text>
  <text x="120" y="160" font-family="sans-serif" font-size="24" fill="#8b949e">/1000</text>

  <!-- User & Cert Info -->
  <text x="350" y="115" font-family="sans-serif" font-size="12" fill="#8b949e">발급 대상</text>
  <text x="350" y="135" font-family="sans-serif" font-size="16" font-weight="bold" fill="#e6edf3">${userId}</text>
  <text x="350" y="158" font-family="sans-serif" font-size="11" fill="#8b949e">발급일: ${issuedDate}</text>
  <text x="350" y="175" font-family="sans-serif" font-size="10" fill="#484f58">ID: ${certId || '—'}</text>

  <!-- Divider -->
  <line x1="20" y1="200" x2="${w-20}" y2="200" stroke="#30363d" stroke-width="1"/>

  <!-- Score Breakdown -->
  <text x="30" y="225" font-family="sans-serif" font-size="12" font-weight="bold" fill="#8b949e">점수 세부 내역</text>
  ${bars}

  <!-- Footer -->
  <text x="${w/2}" y="${h-15}" font-family="sans-serif" font-size="10" fill="#484f58" text-anchor="middle">
    This certificate is issued by Orbit AI and can be verified at ${certId ? `/api/certificate/verify/${certId}` : 'orbit-ai.dev'}
  </text>
</svg>`;
}

// ─── 인증서 서명 ──────────────────────────────────────────────────────────────

function signCert(data) {
  const payload = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(payload + (process.env.CERT_SECRET || 'orbit-secret-2025')).digest('hex').slice(0, 32);
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createCertificateRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;
  const labelsOf = (userId) => labelStore.get(userId) || [];

  // [v2.3] 사람 라벨 제출/조회 — 프록시 축을 실측으로 승격하는 루프
  router.post('/certificate/:userId/label', auth, (req, res) => {
    const { userId } = req.params;
    const { kind, value, instance } = req.body || {};
    if (kind !== 'verify' && kind !== 'helpful') return res.status(400).json({ error: "kind는 'verify' 또는 'helpful'" });
    const arr = labelStore.get(userId) || [];
    arr.push({ kind, value: !!value, instance: instance || null, ts: new Date().toISOString() });
    labelStore.set(userId, arr.slice(-500));
    const verify = arr.filter(l => l.kind === 'verify').length, helpful = arr.filter(l => l.kind === 'helpful').length;
    res.json({ ok: true, total: arr.length, verify, helpful, needed: LABEL_MEASURED_MIN,
      note: verify >= LABEL_MEASURED_MIN ? '비판·메타인지 축이 실측(measured)으로 승격됨' : `검증 라벨 ${verify}/${LABEL_MEASURED_MIN} — ${LABEL_MEASURED_MIN - verify}건 더 필요` });
  });
  router.get('/certificate/:userId/labels', (req, res) => {
    const arr = labelsOf(req.params.userId);
    res.json({ total: arr.length, verify: arr.filter(l => l.kind === 'verify').length, helpful: arr.filter(l => l.kind === 'helpful').length, needed: LABEL_MEASURED_MIN, recent: arr.slice(-10) });
  });

  // ── AI 점수 계산 ──────────────────────────────────────────────────────
  // [2026-07-16] getEventsForUser/getSessions는 async(PG) — await 누락으로 500나던 것 수정
  router.get('/certificate/:userId/score', async (req, res) => {
   try {
    const { userId } = req.params;
    const events   = ((getEventsForUser ? await getEventsForUser(userId) : (getAllEvents ? await getAllEvents() : [])) || []).filter(e => userId === 'all' || (e.userId || 'local') === userId);
    const sessions = (getSessions ? await getSessions() : []) || [];
    const result   = computeScore(events, sessions, labelsOf(userId));
    const grade    = getGrade(result.total);

    res.json({
      userId,
      ...result,
      grade: { tier: grade.tier, label: grade.label, emoji: grade.emoji, color: grade.borderColor },
      description: `${userId}님은 AI 활용 역량 ${grade.label} 등급입니다.`,
    });
   } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 인증서 SVG ────────────────────────────────────────────────────────
  router.get('/certificate/:userId/svg', async (req, res) => {
   try {
    const { userId } = req.params;
    const events   = (getEventsForUser ? await getEventsForUser(userId) : (getAllEvents ? await getAllEvents() : [])) || [];
    const sessions = (getSessions ? await getSessions() : []) || [];
    const result   = computeScore(events, sessions, labelsOf(userId));
    const grade    = getGrade(result.total);

    const existingCert = [...certStore.values()].find(c => c.userId === userId);

    const svg = makeCertSvg({
      userId,
      score:     result.total,
      grade,
      certId:    existingCert?.certId || null,
      issuedAt:  existingCert?.issuedAt || new Date().toISOString(),
      breakdown: result.breakdown,
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(svg);
   } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 인증서 JSON ───────────────────────────────────────────────────────
  router.get('/certificate/:userId/json', async (req, res) => {
   try {
    const { userId } = req.params;
    const events   = (getEventsForUser ? await getEventsForUser(userId) : (getAllEvents ? await getAllEvents() : [])) || [];
    const sessions = (getSessions ? await getSessions() : []) || [];
    const result   = computeScore(events, sessions, labelsOf(userId));
    const grade    = getGrade(result.total);

    const cert = [...certStore.values()].find(c => c.userId === userId) || null;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      schema:     'orbit-ai-certificate-v1',
      certId:     cert?.certId || null,
      issued:     !!cert,
      userId,
      score:      result.total,
      breakdown:  result.breakdown,
      grade:      { tier: grade.tier, label: grade.label, emoji: grade.emoji },
      issuedAt:   cert?.issuedAt || null,
      expiresAt:  cert?.expiresAt || null,
      signature:  cert?.signature || null,
      verifyUrl:  cert ? `/api/certificate/verify/${cert.certId}` : null,
    });
   } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 인증서 발급 ───────────────────────────────────────────────────────
  router.post('/certificate/:userId/issue', auth, async (req, res) => {
   try {
    const { userId } = req.params;
    const events   = (getEventsForUser ? await getEventsForUser(userId) : (getAllEvents ? await getAllEvents() : [])) || [];
    const sessions = (getSessions ? await getSessions() : []) || [];
    const result   = computeScore(events, sessions, labelsOf(userId));
    const grade    = getGrade(result.total);

    if (result.total < 200) {
      return res.status(400).json({
        error: `점수가 부족합니다. (현재: ${result.total}/200 최소 필요)`,
        score: result.total,
      });
    }

    const certId   = crypto.randomBytes(12).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString(); // 1년 유효

    const certData = {
      certId,
      userId,
      score:      result.total,
      breakdown:  result.breakdown,
      grade:      { tier: grade.tier, label: grade.label },
      issuedAt,
      expiresAt,
      meta:       result.meta,
    };
    certData.signature = signCert(certData);

    certStore.set(certId, certData);

    res.json({
      success: true,
      certId,
      issuedAt,
      expiresAt,
      grade: { tier: grade.tier, label: grade.label, emoji: grade.emoji },
      score: result.total,
      svgUrl:     `/api/certificate/${userId}/svg`,
      jsonUrl:    `/api/certificate/${userId}/json`,
      verifyUrl:  `/api/certificate/verify/${certId}`,
      linkedinSnippet: `Orbit AI ${grade.label} | Score: ${result.total}/1000 | Verified: ${req.protocol}://${req.get('host')}/api/certificate/verify/${certId}`,
    });
   } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 인증서 검증 ───────────────────────────────────────────────────────
  router.get('/certificate/verify/:certId', (req, res) => {
    const cert = certStore.get(req.params.certId);
    if (!cert) return res.status(404).json({ valid: false, error: '인증서를 찾을 수 없습니다.' });

    // 만료 체크
    if (cert.expiresAt && new Date(cert.expiresAt) < new Date()) {
      return res.json({ valid: false, expired: true, certId: cert.certId, userId: cert.userId });
    }

    // 서명 검증
    const { signature, ...dataWithoutSig } = cert;
    const expectedSig = signCert(dataWithoutSig);
    const valid = signature === expectedSig;

    res.json({
      valid,
      certId:   cert.certId,
      userId:   cert.userId,
      score:    cert.score,
      grade:    cert.grade,
      issuedAt: cert.issuedAt,
      expiresAt: cert.expiresAt,
    });
  });

  // ── 인증서 목록 ───────────────────────────────────────────────────────
  router.get('/certificate', (req, res) => {
    const { limit = 20 } = req.query;
    const certs = [...certStore.values()]
      .sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt))
      .slice(0, Math.min(parseInt(limit) || 20, 100))
      .map(c => ({
        certId:   c.certId,
        userId:   c.userId,
        score:    c.score,
        grade:    c.grade,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
      }));
    res.json({ certificates: certs, total: certStore.size });
  });

  return router;
}

module.exports = {
  computeScore,
  getGrade,
  makeCertSvg,
  createCertificateRouter,
};
