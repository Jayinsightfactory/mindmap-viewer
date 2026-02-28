'use strict';
/**
 * routes/badge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit Badge — GitHub README용 SVG 배지 + 공개 프로필
 *
 * GET  /api/badge/:userId/svg          — SVG 배지 (이벤트 수, 절감 시간)
 * GET  /api/badge/:userId/json         — 배지 데이터 JSON
 * GET  /api/badge/:userId/shield       — shields.io 호환 JSON
 * POST /api/badge/:userId/publish      — 배지 공개 설정 ON/OFF
 * GET  /api/badge/stats                — 전체 배지 통계
 *
 * 사용법 (README.md):
 *   ![Orbit AI](https://your-server/api/badge/local/svg)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ─── 공개 배지 설정 저장소 (인메모리) ────────────────────────────────────────
const badgePublishMap = new Map(); // userId → { published, style, since }

// ─── SVG 생성 ────────────────────────────────────────────────────────────────

/**
 * shields.io 스타일 SVG 배지 생성
 */
function makeSvgBadge({ label, value, color = '#58a6ff', style = 'flat' }) {
  const FONT    = 'DejaVu Sans,Verdana,Geneva,sans-serif';
  const FS      = 11;
  const PAD     = 6;
  const SEP     = 1;

  // 텍스트 너비 추정 (ASCII 기준)
  const approxW = (str) => Math.ceil(str.length * 6.5 + PAD * 2);
  const lw = approxW(label);
  const vw = approxW(value);
  const tw = lw + vw + SEP;

  if (style === 'flat-square') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <mask id="m"><rect width="${tw}" height="20" rx="0" fill="#fff"/></mask>
  <g mask="url(#m)">
    <path fill="#555"       d="M0 0 h${lw} v20 H0 z"/>
    <path fill="${color}"   d="M${lw} 0 h${vw} v20 H${lw} z"/>
  </g>
  <g fill="#fff" font-family="${FONT}" font-size="${FS}" text-anchor="middle">
    <text x="${lw / 2}"      y="14" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${lw / 2}"      y="13">${label}</text>
    <text x="${lw + vw / 2}" y="14" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${lw + vw / 2}" y="13">${value}</text>
  </g>
</svg>`;
  }

  // default: flat (rounded)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${tw}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <path fill="#555"       d="M0 0 h${lw} v20 H0 z"/>
    <path fill="${color}"   d="M${lw} 0 h${vw} v20 H${lw} z"/>
    <path fill="url(#b)"    d="M0 0 h${tw} v20 H0 z"/>
  </g>
  <g fill="#fff" font-family="${FONT}" font-size="${FS}" text-anchor="middle">
    <text x="${lw / 2}"      y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${label}</text>
    <text x="${lw / 2}"      y="14">${label}</text>
    <text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${value}</text>
    <text x="${lw + vw / 2}" y="14">${value}</text>
  </g>
</svg>`;
}

/**
 * 멀티 스탯 카드 SVG (profile-style)
 */
function makeProfileCard({ username, events, sessions, savedHours, topTool, streak, color = '#58a6ff' }) {
  const w = 340, h = 140;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#161b22"/>
    </linearGradient>
    <linearGradient id="ac" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${color}"/>
      <stop offset="100%" stop-color="#bc8cff"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${w}" height="${h}" rx="10" fill="url(#bg)" stroke="#30363d" stroke-width="1"/>

  <!-- Accent bar -->
  <rect x="0" y="0" width="${w}" height="3" rx="2" fill="url(#ac)"/>

  <!-- Title -->
  <text x="18" y="28" font-family="DejaVu Sans,Verdana,sans-serif" font-size="14"
        font-weight="bold" fill="${color}">⬡ Orbit AI</text>
  <text x="18" y="46" font-family="DejaVu Sans,Verdana,sans-serif" font-size="11"
        fill="#8b949e">${username}</text>

  <!-- Stats grid -->
  <text x="18"  y="72" font-family="DejaVu Sans,Verdana,sans-serif" font-size="10" fill="#8b949e">Events</text>
  <text x="18"  y="86" font-family="DejaVu Sans,Verdana,sans-serif" font-size="16" font-weight="bold" fill="#e6edf3">${events.toLocaleString()}</text>

  <text x="110" y="72" font-family="DejaVu Sans,Verdana,sans-serif" font-size="10" fill="#8b949e">Sessions</text>
  <text x="110" y="86" font-family="DejaVu Sans,Verdana,sans-serif" font-size="16" font-weight="bold" fill="#e6edf3">${sessions}</text>

  <text x="200" y="72" font-family="DejaVu Sans,Verdana,sans-serif" font-size="10" fill="#8b949e">Saved</text>
  <text x="200" y="86" font-family="DejaVu Sans,Verdana,sans-serif" font-size="16" font-weight="bold" fill="#3fb950">${savedHours}h</text>

  <!-- Bottom row -->
  <text x="18"  y="112" font-family="DejaVu Sans,Verdana,sans-serif" font-size="10" fill="#8b949e">Top Tool</text>
  <text x="18"  y="126" font-family="DejaVu Sans,Verdana,sans-serif" font-size="11" fill="#e6edf3">${topTool || '—'}</text>

  <text x="200" y="112" font-family="DejaVu Sans,Verdana,sans-serif" font-size="10" fill="#8b949e">Streak</text>
  <text x="200" y="126" font-family="DejaVu Sans,Verdana,sans-serif" font-size="11" fill="#ffa657">${streak} days 🔥</text>
</svg>`;
}

// ─── 통계 계산 ────────────────────────────────────────────────────────────────

function computeBadgeData(getAllEvents, getSessions, userId) {
  const events   = getAllEvents ? getAllEvents() : [];
  const sessions = getSessions ? getSessions()  : [];

  // 이벤트 수
  const eventCount   = events.length;
  const sessionCount = sessions.length;

  // 절감 시간 추정 (이벤트당 평균 2.5분 절감)
  const savedMinutes = Math.round(eventCount * 2.5);
  const savedHours   = Math.round(savedMinutes / 60 * 10) / 10;

  // 가장 많이 쓴 도구
  const toolCounts = {};
  for (const ev of events) {
    const t = ev.type || ev.source || 'unknown';
    toolCounts[t] = (toolCounts[t] || 0) + 1;
  }
  const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  // 연속 사용 일수 (streak)
  const dates = [...new Set(events.map(e => (e.timestamp || '').slice(0, 10)).filter(Boolean))].sort();
  let streak = 0;
  if (dates.length > 0) {
    const today     = new Date().toISOString().slice(0, 10);
    let   checkDate = today;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] === checkDate) {
        streak++;
        const d = new Date(checkDate);
        d.setDate(d.getDate() - 1);
        checkDate = d.toISOString().slice(0, 10);
      } else if (dates[i] < checkDate) {
        break;
      }
    }
  }

  return { userId, eventCount, sessionCount, savedHours, topTool, streak };
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createBadgeRouter({ getAllEvents, getSessions, optionalAuth } = {}) {
  const router = express.Router();

  // ── SVG 배지 ──────────────────────────────────────────────────────────
  router.get('/badge/:userId/svg', (req, res) => {
    const { userId }  = req.params;
    const { style = 'flat', type = 'events', color } = req.query;

    // 공개 배지 체크 (local 사용자는 항상 공개)
    const pub = badgePublishMap.get(userId);
    if (userId !== 'local' && pub && !pub.published) {
      return res.status(403).type('image/svg+xml').send(
        makeSvgBadge({ label: 'Orbit AI', value: 'private', color: '#666', style })
      );
    }

    const data     = computeBadgeData(getAllEvents, getSessions, userId);
    const badgeColor = color || '#58a6ff';

    let label, value;
    switch (type) {
      case 'sessions': label = 'Orbit AI'; value = `${data.sessionCount} sessions`; break;
      case 'saved':    label = 'Orbit AI'; value = `${data.savedHours}h saved`;    break;
      case 'streak':   label = 'Orbit AI'; value = `${data.streak}d streak 🔥`;   break;
      default:         label = 'Orbit AI'; value = `${data.eventCount} events`;    break;
    }

    const svg = makeSvgBadge({ label, value, color: badgeColor, style });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(svg);
  });

  // ── 프로필 카드 SVG ───────────────────────────────────────────────────
  router.get('/badge/:userId/card', (req, res) => {
    const { userId } = req.params;
    const { color }  = req.query;
    const data  = computeBadgeData(getAllEvents, getSessions, userId);
    const svg   = makeProfileCard({
      username:   userId,
      events:     data.eventCount,
      sessions:   data.sessionCount,
      savedHours: data.savedHours,
      topTool:    data.topTool,
      streak:     data.streak,
      color:      color || '#58a6ff',
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(svg);
  });

  // ── JSON 데이터 ───────────────────────────────────────────────────────
  router.get('/badge/:userId/json', (req, res) => {
    const data = computeBadgeData(getAllEvents, getSessions, req.params.userId);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      ...data,
      badgeUrls: {
        events:   `/api/badge/${req.params.userId}/svg?type=events`,
        sessions: `/api/badge/${req.params.userId}/svg?type=sessions`,
        saved:    `/api/badge/${req.params.userId}/svg?type=saved`,
        streak:   `/api/badge/${req.params.userId}/svg?type=streak`,
        card:     `/api/badge/${req.params.userId}/card`,
      },
      readmeSnippet: `[![Orbit AI](${req.protocol}://${req.get('host')}/api/badge/${req.params.userId}/svg)](${req.protocol}://${req.get('host')})`,
    });
  });

  // ── shields.io 호환 ───────────────────────────────────────────────────
  router.get('/badge/:userId/shield', (req, res) => {
    const data = computeBadgeData(getAllEvents, getSessions, req.params.userId);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      schemaVersion: 1,
      label:         'Orbit AI',
      message:       `${data.eventCount} events`,
      color:         '58a6ff',
      namedLogo:     'data',
    });
  });

  // ── 배지 공개 설정 ────────────────────────────────────────────────────
  router.post('/badge/:userId/publish', optionalAuth || ((req, res, next) => next()), (req, res) => {
    const { userId }   = req.params;
    const { published = true, style = 'flat' } = req.body;

    badgePublishMap.set(userId, {
      published: !!published,
      style,
      since: new Date().toISOString(),
    });

    res.json({ success: true, userId, published: !!published });
  });

  // ── 전체 배지 통계 ────────────────────────────────────────────────────
  router.get('/badge/stats', (req, res) => {
    const data = computeBadgeData(getAllEvents, getSessions, 'all');
    res.json({
      ...data,
      publishedBadges: badgePublishMap.size,
      publicBadges:    [...badgePublishMap.values()].filter(b => b.published).length,
    });
  });

  return router;
}

module.exports = createBadgeRouter;
