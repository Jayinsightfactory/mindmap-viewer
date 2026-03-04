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

function computeScore(events = [], sessions = []) {
  const scores = {};

  // ── 1. 사용량 점수 (300pt max) ──
  const evCount   = events.length;
  const sesCount  = sessions.length;
  const dates     = [...new Set(events.map(e => (e.timestamp || '').slice(0, 10)).filter(Boolean))];
  const dayCount  = dates.length;

  const evScore  = Math.min(150, Math.log10(Math.max(1, evCount)) / Math.log10(10000) * 150);
  const sesScore = Math.min(75,  Math.log10(Math.max(1, sesCount)) / Math.log10(500)  * 75);
  const dayScore = Math.min(75,  Math.log10(Math.max(1, dayCount)) / Math.log10(365)  * 75);

  scores.volume = Math.round(evScore + sesScore + dayScore);

  // ── 2. 다양성 점수 (200pt max) ──
  const toolTypes   = new Set(events.map(e => e.type).filter(Boolean)).size;
  const sources     = new Set(events.map(e => e.source).filter(Boolean)).size;
  const channels    = new Set(events.map(e => e.channelId).filter(Boolean)).size;

  const toolScore   = Math.min(80, toolTypes / 15 * 80);
  const srcScore    = Math.min(80, sources   / 5  * 80);
  const chanScore   = Math.min(40, channels  / 5  * 40);

  scores.diversity = Math.round(toolScore + srcScore + chanScore);

  // ── 3. 깊이 점수 (200pt max) ──
  const sessionEventMap = new Map();
  for (const ev of events) {
    if (!ev.sessionId) continue;
    if (!sessionEventMap.has(ev.sessionId)) sessionEventMap.set(ev.sessionId, []);
    sessionEventMap.get(ev.sessionId).push(ev);
  }

  const sessionLengths = [...sessionEventMap.values()].map(evs => evs.length);
  const avgSessionLen  = sessionLengths.length > 0
    ? sessionLengths.reduce((a, b) => a + b, 0) / sessionLengths.length
    : 0;

  const longSessions = sessionLengths.filter(l => l >= 10).length;
  const depthScore   = Math.min(100, avgSessionLen / 30 * 100);
  const complexScore = Math.min(100, longSessions  / Math.max(1, sesCount) * 100);

  scores.depth = Math.round(depthScore + complexScore);

  // ── 4. 일관성 점수 (150pt max) ──
  // 연속 사용일
  const sortedDates = dates.sort();
  let streak = 0;
  if (sortedDates.length > 0) {
    let checkDate = new Date().toISOString().slice(0, 10);
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      if (sortedDates[i] === checkDate) {
        streak++;
        const d = new Date(checkDate);
        d.setDate(d.getDate() - 1);
        checkDate = d.toISOString().slice(0, 10);
      } else { break; }
    }
  }

  // 7일 중 활동일 비율
  const lastWeekDates = dates.filter(d => d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const regularityPct = lastWeekDates.length / 7;

  const streakScore    = Math.min(75, streak / 30 * 75);
  const regularScore   = Math.min(75, regularityPct * 75);

  scores.consistency = Math.round(streakScore + regularScore);

  // ── 5. 기여 점수 (150pt max) — 기본값 추정 ──
  // (실제로는 market/share/community 데이터 필요 → 기본 10pt)
  scores.contribution = 10;

  // ── 총점 ──
  const total = Math.min(1000, scores.volume + scores.diversity + scores.depth + scores.consistency + scores.contribution);

  return {
    total:    Math.round(total),
    breakdown: scores,
    meta: {
      events:     evCount,
      sessions:   sesCount,
      daysActive: dayCount,
      streak,
      toolTypes,
      sources,
    },
  };
}

// ─── 인증서 SVG 생성 ──────────────────────────────────────────────────────────

function makeCertSvg({ userId, score, grade, certId, issuedAt, breakdown }) {
  const w = 600, h = 400;
  const issuedDate = issuedAt ? new Date(issuedAt).toLocaleDateString('ko-KR') : new Date().toLocaleDateString('ko-KR');

  // 점수 바 (breakdown)
  const cats = [
    { name: '사용량',  score: breakdown.volume       || 0, max: 300, color: '#58a6ff' },
    { name: '다양성',  score: breakdown.diversity    || 0, max: 200, color: '#3fb950' },
    { name: '깊이',    score: breakdown.depth        || 0, max: 200, color: '#bc8cff' },
    { name: '일관성',  score: breakdown.consistency  || 0, max: 150, color: '#f778ba' },
    { name: '기여',    score: breakdown.contribution || 0, max: 150, color: '#ffa657' },
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

function createCertificateRouter({ getAllEvents, getSessions, optionalAuth } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── AI 점수 계산 ──────────────────────────────────────────────────────
  router.get('/certificate/:userId/score', (req, res) => {
    const { userId } = req.params;
    const events   = (getAllEvents ? getAllEvents() : []).filter(e => userId === 'all' || (e.userId || 'local') === userId);
    const sessions = getSessions ? getSessions() : [];
    const result   = computeScore(events, sessions);
    const grade    = getGrade(result.total);

    res.json({
      userId,
      ...result,
      grade: { tier: grade.tier, label: grade.label, emoji: grade.emoji, color: grade.borderColor },
      description: `${userId}님은 AI 활용 역량 ${grade.label} 등급입니다.`,
    });
  });

  // ── 인증서 SVG ────────────────────────────────────────────────────────
  router.get('/certificate/:userId/svg', (req, res) => {
    const { userId } = req.params;
    const events   = (getAllEvents ? getAllEvents() : []).filter(e => (e.userId || 'local') === userId);
    const sessions = getSessions ? getSessions() : [];
    const result   = computeScore(events, sessions);
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
  });

  // ── 인증서 JSON ───────────────────────────────────────────────────────
  router.get('/certificate/:userId/json', (req, res) => {
    const { userId } = req.params;
    const events   = (getAllEvents ? getAllEvents() : []).filter(e => (e.userId || 'local') === userId);
    const sessions = getSessions ? getSessions() : [];
    const result   = computeScore(events, sessions);
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
  });

  // ── 인증서 발급 ───────────────────────────────────────────────────────
  router.post('/certificate/:userId/issue', auth, (req, res) => {
    const { userId } = req.params;
    const events   = (getAllEvents ? getAllEvents() : []).filter(e => (e.userId || 'local') === userId);
    const sessions = getSessions ? getSessions() : [];
    const result   = computeScore(events, sessions);
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
