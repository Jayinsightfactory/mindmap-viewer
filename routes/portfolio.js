/**
 * routes/portfolio.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AI 역량 포트폴리오 PDF 생성 라우터
 *
 * 엔드포인트:
 *   GET /api/portfolio/preview  — HTML 미리보기 (브라우저 확인용)
 *   GET /api/portfolio/pdf      — PDF 다운로드
 *
 * PDF 구성:
 *   1. 프로젝트 요약 (총 이벤트, 세션, 파일, 기간)
 *   2. AI 도구 사용 프로필 (aiSource별 비율 SVG 바)
 *   3. 생산성 패턴 (피크 시간대 SVG 막대그래프)
 *   4. 주요 작업 파일 Top 10
 *   5. 최근 인사이트 (최대 5개)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const path    = require('path');

// ─── SVG 차트 헬퍼 ──────────────────────────────────────────────────────────

/**
 * AI 소스별 비율을 SVG 가로 바 차트로 렌더링합니다.
 * @param {{ source: string, count: number }[]} data
 * @returns {string} SVG 문자열
 */
function renderBarChart(data) {
  if (!data || data.length === 0) return '<p style="color:#666">데이터 없음</p>';

  const total   = data.reduce((s, d) => s + d.count, 0) || 1;
  const colors  = ['#58a6ff','#3fb950','#bc8cff','#f778ba','#ffa657','#39d2c0','#ff9500'];
  const barH    = 22;
  const gap     = 6;
  const labelW  = 130;
  const barMaxW = 300;
  const height  = data.length * (barH + gap);

  const bars = data.map((d, i) => {
    const pct   = d.count / total;
    const w     = Math.max(4, Math.round(pct * barMaxW));
    const y     = i * (barH + gap);
    const color = colors[i % colors.length];
    const label = d.source || d.aiSource || 'unknown';
    const pctTxt = Math.round(pct * 100) + '%';

    return [
      `<text x="${labelW - 8}" y="${y + barH - 6}" text-anchor="end" font-size="12" fill="#cdd9e5">${label}</text>`,
      `<rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" opacity="0.85"/>`,
      `<text x="${labelW + w + 6}" y="${y + barH - 6}" font-size="11" fill="${color}">${pctTxt} (${d.count})</text>`,
    ].join('\n');
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW + barMaxW + 80}" height="${height}" style="overflow:visible">${bars}</svg>`;
}

/**
 * 24시간 활동 분포를 SVG 막대그래프로 렌더링합니다.
 * @param {number[]} hourCounts - 길이 24의 배열
 * @returns {string} SVG 문자열
 */
function renderHourChart(hourCounts) {
  const maxVal = Math.max(...hourCounts, 1);
  const barW   = 18;
  const gap    = 2;
  const maxH   = 60;
  const width  = 24 * (barW + gap);

  const bars = hourCounts.map((c, h) => {
    const bh    = Math.max(2, Math.round(c / maxVal * maxH));
    const x     = h * (barW + gap);
    const y     = maxH - bh;
    const color = (h >= 9 && h <= 18) ? '#3fb950' : (h >= 19 || h <= 5) ? '#f85149' : '#58a6ff';
    return [
      `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill="${color}" opacity="0.8"/>`,
      `<text x="${x + barW / 2}" y="${maxH + 14}" text-anchor="middle" font-size="9" fill="#8b949e">${h}</text>`,
    ].join('');
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${maxH + 20}">${bars}</svg>`;
}

// ─── 포트폴리오 HTML 빌더 ────────────────────────────────────────────────────

/**
 * 포트폴리오 HTML 문자열을 생성합니다.
 *
 * @param {object[]} events   - getAllEvents() 결과
 * @param {object[]} sessions - getSessions() 결과
 * @param {object}   stats    - getStats() 결과
 * @param {object[]} files    - getFiles() 결과
 * @returns {string} 완성된 HTML 문자열
 */
function buildPortfolioHtml(events, sessions, stats, files) {
  // ── 기간 계산 ───────────────────────────────────────────────────────────
  let dateFrom = '—', dateTo = '—', durationDays = 0;
  if (events.length > 0) {
    const ts    = events.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
    const minTs = Math.min(...ts);
    const maxTs = Math.max(...ts);
    dateFrom     = new Date(minTs).toLocaleDateString('ko-KR');
    dateTo       = new Date(maxTs).toLocaleDateString('ko-KR');
    durationDays = Math.ceil((maxTs - minTs) / 86400000) || 1;
  }

  // ── AI 소스 집계 ────────────────────────────────────────────────────────
  const sourceCounts = {};
  for (const e of events) {
    const src = e.aiSource || e.ai_source || e.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }
  const sourceData = Object.entries(sourceCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 7)
    .map(([source, count]) => ({ source, count }));

  // ── 시간대 분포 ──────────────────────────────────────────────────────────
  const hourCounts = new Array(24).fill(0);
  for (const e of events) {
    const h = new Date(e.timestamp).getHours();
    if (!isNaN(h)) hourCounts[h]++;
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  // ── 주요 파일 Top 10 ────────────────────────────────────────────────────
  const fileCounts = {};
  for (const e of events) {
    const f = e.data?.file_path || e.data?.filePath || e.data?.path;
    if (f) fileCounts[f] = (fileCounts[f] || 0) + 1;
  }
  const topFiles = Object.entries(fileCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([file, count]) => ({ file: path.basename(file), fullPath: file, count }));

  // ── 인사이트 로드 ────────────────────────────────────────────────────────
  let recentInsights = [];
  try {
    recentInsights = require('../src/insight-engine').getInsights(5);
  } catch { /* 없으면 생략 */ }

  // ── 이벤트 타입 분포 ─────────────────────────────────────────────────────
  const typeCounts = {};
  for (const e of events) {
    const t = (e.type || 'unknown').split('.')[0];
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const typeData = Object.entries(typeCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([source, count]) => ({ source, count }));

  const generatedAt = new Date().toLocaleString('ko-KR');
  const totalEvents = events.length;
  const totalSessions = Array.isArray(sessions) ? sessions.length : (stats?.sessionCount || 0);
  const totalFiles    = Array.isArray(files)    ? files.length    : (stats?.fileCount    || 0);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Orbit AI — AI 역량 포트폴리오</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      padding: 40px 48px; line-height: 1.6;
    }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding-bottom: 24px; border-bottom: 2px solid #30363d; margin-bottom: 32px;
    }
    .logo { font-size: 24px; font-weight: 700; color: #58a6ff; }
    .logo span { color: #3fb950; }
    .meta { font-size: 13px; color: #8b949e; text-align: right; }
    .section { margin-bottom: 36px; }
    .section-title {
      font-size: 16px; font-weight: 600; color: #58a6ff;
      padding-bottom: 8px; border-bottom: 1px solid #30363d; margin-bottom: 16px;
    }
    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .stat-card {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 8px; padding: 16px; text-align: center;
    }
    .stat-num { font-size: 32px; font-weight: 700; color: #58a6ff; }
    .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #161b22; color: #8b949e; padding: 8px 12px; text-align: left; border: 1px solid #30363d; }
    td { padding: 7px 12px; border: 1px solid #21262d; color: #cdd9e5; }
    tr:nth-child(even) td { background: #0d1117; }
    .insight-card {
      background: #161b22; border: 1px solid #30363d;
      border-left: 3px solid #3fb950;
      border-radius: 0 6px 6px 0; padding: 12px 16px; margin-bottom: 10px;
    }
    .insight-title { font-weight: 600; color: #3fb950; font-size: 14px; }
    .insight-body  { font-size: 13px; color: #cdd9e5; margin-top: 4px; }
    .chart-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .footer {
      margin-top: 48px; padding-top: 16px; border-top: 1px solid #30363d;
      font-size: 12px; color: #8b949e; text-align: center;
    }
    @media print {
      body { background: #fff; color: #000; }
      .stat-card { border: 1px solid #ccc; }
    }
  </style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo">Orbit<span> AI</span></div>
    <div style="font-size:13px;color:#8b949e;margin-top:4px">AI 역량 포트폴리오 리포트</div>
  </div>
  <div class="meta">
    생성일: ${generatedAt}<br>
    기간: ${dateFrom} ~ ${dateTo} (${durationDays}일)
  </div>
</div>

<!-- 섹션 1: 프로젝트 요약 -->
<div class="section">
  <div class="section-title">📊 프로젝트 요약</div>
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-num">${totalEvents.toLocaleString()}</div>
      <div class="stat-label">총 AI 이벤트</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${totalSessions.toLocaleString()}</div>
      <div class="stat-label">세션 수</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${totalFiles.toLocaleString()}</div>
      <div class="stat-label">작업 파일</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${durationDays}</div>
      <div class="stat-label">활동 기간(일)</div>
    </div>
  </div>
</div>

<!-- 섹션 2: AI 도구 사용 프로필 -->
<div class="section">
  <div class="section-title">🤖 AI 도구 사용 프로필</div>
  <div class="chart-wrap">
    ${renderBarChart(sourceData)}
  </div>
</div>

<!-- 섹션 3: 이벤트 유형 분포 -->
<div class="section">
  <div class="section-title">⚡ 이벤트 유형 분포</div>
  <div class="chart-wrap">
    ${renderBarChart(typeData)}
  </div>
</div>

<!-- 섹션 4: 생산성 패턴 (시간대) -->
<div class="section">
  <div class="section-title">🕐 시간대별 활동 패턴 (피크: ${peakHour}시)</div>
  <div class="chart-wrap" style="overflow-x:auto">
    ${renderHourChart(hourCounts)}
    <div style="margin-top:8px;font-size:12px;color:#8b949e">
      <span style="color:#3fb950">■</span> 업무시간(9-18시) &nbsp;
      <span style="color:#58a6ff">■</span> 저녁(19-22시) &nbsp;
      <span style="color:#f85149">■</span> 야간(23-5시)
    </div>
  </div>
</div>

<!-- 섹션 5: 주요 작업 파일 Top 10 -->
${topFiles.length > 0 ? `
<div class="section">
  <div class="section-title">📁 주요 작업 파일 Top ${topFiles.length}</div>
  <table>
    <tr><th>#</th><th>파일명</th><th>경로</th><th>수정 횟수</th></tr>
    ${topFiles.map((f, i) => `<tr>
      <td>${i + 1}</td>
      <td><strong>${f.file}</strong></td>
      <td style="font-size:11px;color:#8b949e">${f.fullPath}</td>
      <td style="text-align:right;color:#58a6ff">${f.count}회</td>
    </tr>`).join('')}
  </table>
</div>
` : ''}

<!-- 섹션 6: 인사이트 엔진 결과 -->
${recentInsights.length > 0 ? `
<div class="section">
  <div class="section-title">💡 AI 인사이트 (최근 ${recentInsights.length}개)</div>
  ${recentInsights.map(i => `
  <div class="insight-card">
    <div class="insight-title">${i.title || ''}</div>
    <div class="insight-body">${i.body || i.description || ''}</div>
  </div>`).join('')}
</div>
` : ''}

<div class="footer">
  Generated by <strong>Orbit AI</strong> · orbit-ai.dev · ${generatedAt}
</div>

</body>
</html>`;
}

// ─── 라우터 팩토리 ───────────────────────────────────────────────────────────

/**
 * @param {{ getAllEvents: Function, getSessions: Function, getStats: Function, getFiles: Function, optionalAuth: Function }} deps
 * @returns {express.Router}
 */
function createRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth }) {
  const router = express.Router();

  // ─── GET /api/portfolio/preview ────────────────────────────────────────────
  // HTML 미리보기 (브라우저 확인용)
  router.get('/portfolio/preview', optionalAuth, (req, res) => {
    try {
      const html = buildPortfolioHtml(
        getAllEvents(),
        getSessions(),
        getStats(),
        getFiles(),
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/portfolio/pdf ────────────────────────────────────────────────
  // PDF 다운로드
  router.get('/portfolio/pdf', optionalAuth, async (req, res) => {
    try {
      const html = buildPortfolioHtml(
        getAllEvents(),
        getSessions(),
        getStats(),
        getFiles(),
      );

      // html-pdf-node가 설치되어 있으면 PDF 생성, 없으면 HTML 다운로드로 폴백
      let htmlPdf;
      try {
        htmlPdf = require('html-pdf-node');
      } catch {
        // html-pdf-node 미설치 시 HTML 파일로 다운로드 폴백
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="orbit-portfolio-${Date.now()}.html"`);
        return res.send(html);
      }

      const buffer = await htmlPdf.generatePdf(
        { content: html },
        {
          format: 'A4',
          printBackground: true,
          margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
        },
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="orbit-portfolio-${Date.now()}.pdf"`);
      res.send(buffer);

    } catch (err) {
      console.error('[portfolio] PDF 생성 오류:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createRouter;
