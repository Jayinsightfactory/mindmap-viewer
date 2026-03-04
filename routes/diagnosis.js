'use strict';
/**
 * routes/diagnosis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 중소기업 진단 API + 부트캠프 + 시뮬레이션
 *
 * POST /api/diagnosis/:companyId/run           — 진단 실행
 * GET  /api/diagnosis/:companyId/history       — 진단 히스토리
 * GET  /api/diagnosis/:companyId/latest        — 최신 진단 결과
 * POST /api/diagnosis/:companyId/simulate      — 프로세스 자동화 시뮬레이션
 *
 * POST /api/bootcamp/start                     — 부트캠프 세션 시작
 * POST /api/bootcamp/:sessionId/upload         — 엑셀/문서 업로드 → 자동 분석
 * POST /api/bootcamp/:sessionId/analyze        — 업로드 데이터 분석 실행
 * GET  /api/bootcamp/:sessionId/status         — 세션 상태
 * GET  /api/bootcamp/:sessionId/report         — 즉석 리포트
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const { ulid } = require('ulid');
const path = require('path');
const fs = require('fs');

module.exports = function createDiagnosisRouter({ getDb, broadcastAll }) {
  const router = Router();
  const diagEngine = require('../src/diagnosis-engine');
  const ontology = require('../src/company-ontology');

  function db() { return getDb(); }

  // ── 진단 실행 ─────────────────────────────────────────────────────────────

  router.post('/diagnosis/:companyId/run', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { stage = 'bootcamp' } = req.body;
      const result = diagEngine.runDiagnosis(db(), req.params.companyId, stage);
      if (!result) return res.status(404).json({ error: 'company not found' });

      // 실시간 알림
      if (broadcastAll) {
        broadcastAll({
          type: 'diagnosis_complete',
          company: result.company,
          overall: result.overall,
          grade: result.grade,
          timestamp: new Date().toISOString(),
        });
      }

      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 진단 히스토리 ─────────────────────────────────────────────────────────

  router.get('/diagnosis/:companyId/history', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const history = diagEngine.getDiagnosisHistory(db(), req.params.companyId);
      res.json({ history, total: history.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/diagnosis/:companyId/latest', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const history = diagEngine.getDiagnosisHistory(db(), req.params.companyId);
      if (history.length === 0) return res.json({ diagnosis: null });
      res.json({ diagnosis: history[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 프로세스 자동화 시뮬레이션 ────────────────────────────────────────────

  router.post('/diagnosis/:companyId/simulate', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { processId, automationLevel = 0.8 } = req.body;
      if (!processId) return res.status(400).json({ error: 'processId required' });

      const result = diagEngine.simulateAutomation(db(), req.params.companyId, processId,
        parseFloat(automationLevel));
      if (!result) return res.status(404).json({ error: 'process not found' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 전체 시뮬레이션 (모든 프로세스) ───────────────────────────────────────

  router.get('/diagnosis/:companyId/simulate-all', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const processes = ontology.listProcesses(db(), req.params.companyId);
      const level = parseFloat(req.query.level || '0.8');

      const simulations = processes.map(p =>
        diagEngine.simulateAutomation(db(), req.params.companyId, p.id, level)
      ).filter(Boolean);

      const totalMonthlySavingsKrw = simulations.reduce((s, sim) => s + sim.savedMonthlyKrw, 0);
      const totalYearlySavingsKrw = totalMonthlySavingsKrw * 12;
      const totalImplCost = simulations.reduce((s, sim) => s + sim.implementationCost, 0);

      res.json({
        simulations,
        summary: {
          processCount: simulations.length,
          automationLevel: Math.round(level * 100),
          totalMonthlySavingsKrw,
          totalYearlySavingsKrw,
          totalImplementationCost: totalImplCost,
          overallBreakEvenMonths: totalMonthlySavingsKrw > 0
            ? Math.ceil(totalImplCost / totalMonthlySavingsKrw)
            : 0,
          threeYearROI: totalImplCost > 0
            ? Math.round(((totalYearlySavingsKrw * 3 - totalImplCost) / totalImplCost) * 100)
            : 0,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 부트캠프 세션 (2시간 현장 진단)
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/bootcamp/start', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { company_id, consultant_id } = req.body;
      if (!company_id) return res.status(400).json({ error: 'company_id required' });

      const sessionId = ulid();
      db().prepare(`
        INSERT INTO bootcamp_sessions (id, company_id, consultant_id, stage, status)
        VALUES (?, ?, ?, 'upload', 'active')
      `).run(sessionId, company_id, consultant_id || '');

      res.json({ ok: true, sessionId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/bootcamp/:sessionId/upload', (req, res) => {
    try {
      const session = db().prepare('SELECT * FROM bootcamp_sessions WHERE id = ?').get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      const { file_type, file_name, data, sheets } = req.body;

      // 엑셀 데이터 자동 분석
      let analysis = {};
      if (file_type === 'excel' && sheets) {
        analysis = analyzeExcelData(sheets);
      } else if (file_type === 'csv' && data) {
        analysis = { rows: data.length, columns: data[0] ? Object.keys(data[0]).length : 0 };
      }

      // 업로드 기록 추가
      const uploads = JSON.parse(session.uploads_json || '[]');
      uploads.push({
        id: ulid(),
        file_name,
        file_type,
        analysis,
        uploaded_at: new Date().toISOString(),
      });

      db().prepare('UPDATE bootcamp_sessions SET uploads_json = ?, stage = ? WHERE id = ?')
        .run(JSON.stringify(uploads), 'analyzing', req.params.sessionId);

      // 실시간 알림
      if (broadcastAll) {
        broadcastAll({
          type: 'bootcamp_upload',
          sessionId: req.params.sessionId,
          file_name,
          analysis,
        });
      }

      res.json({ ok: true, analysis, uploadCount: uploads.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/bootcamp/:sessionId/analyze', (req, res) => {
    try {
      const session = db().prepare('SELECT * FROM bootcamp_sessions WHERE id = ?').get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      // 진단 실행
      const diagResult = diagEngine.runDiagnosis(db(), session.company_id, 'bootcamp');

      // 세션 업데이트
      db().prepare(`
        UPDATE bootcamp_sessions SET stage = 'completed', analysis_json = ?,
          findings_json = ?, completed_at = datetime('now'), status = 'completed'
        WHERE id = ?
      `).run(
        JSON.stringify(diagResult?.scores || {}),
        JSON.stringify(diagResult?.findings || []),
        req.params.sessionId
      );

      if (broadcastAll) {
        broadcastAll({
          type: 'bootcamp_complete',
          sessionId: req.params.sessionId,
          grade: diagResult?.grade,
          overall: diagResult?.overall,
        });
      }

      res.json({ ok: true, diagnosis: diagResult });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/bootcamp/:sessionId/status', (req, res) => {
    try {
      const session = db().prepare('SELECT * FROM bootcamp_sessions WHERE id = ?').get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      res.json({
        ...session,
        uploads: tryParse(session.uploads_json),
        analysis: tryParse(session.analysis_json),
        findings: tryParse(session.findings_json),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/bootcamp/:sessionId/report', (req, res) => {
    try {
      const session = db().prepare('SELECT * FROM bootcamp_sessions WHERE id = ?').get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      const company = ontology.getCompany(db(), session.company_id);
      const history = diagEngine.getDiagnosisHistory(db(), session.company_id);
      const latest = history[0];

      if (!latest) return res.json({ report: null, message: '진단을 먼저 실행해주세요.' });

      // 마크다운 리포트 생성
      const report = generateBootcampReport(company, latest);

      if (req.query.format === 'html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(markdownToSimpleHtml(report));
      }

      res.json({ report, diagnosis: latest });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};

// ── 엑셀 데이터 분석 ────────────────────────────────────────────────────────

function analyzeExcelData(sheets) {
  const analysis = { sheetCount: sheets.length, sheets: [] };

  for (const sheet of sheets) {
    const rows = sheet.data || [];
    const cols = rows[0] ? Object.keys(rows[0]) : [];

    // 컬럼 타입 추론
    const colTypes = {};
    for (const col of cols) {
      const values = rows.slice(0, 50).map(r => r[col]).filter(v => v != null);
      const numCount = values.filter(v => !isNaN(v)).length;
      const dateCount = values.filter(v => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(String(v))).length;
      colTypes[col] = numCount > values.length * 0.7 ? 'number'
        : dateCount > values.length * 0.5 ? 'date' : 'text';
    }

    // 자동 발견
    const findings = [];
    if (rows.length > 100) findings.push(`대량 데이터 (${rows.length}행)`);
    const numCols = Object.values(colTypes).filter(t => t === 'number').length;
    if (numCols > 0) findings.push(`수치 컬럼 ${numCols}개 발견`);

    analysis.sheets.push({
      name: sheet.name || 'Sheet',
      rowCount: rows.length,
      colCount: cols.length,
      columns: cols,
      columnTypes: colTypes,
      findings,
    });
  }

  return analysis;
}

// ── 부트캠프 리포트 생성 ────────────────────────────────────────────────────

function generateBootcampReport(company, diagnosis) {
  if (!company || !diagnosis) return '# 진단 데이터 없음';

  const scores = tryParse(diagnosis.scores_json) || {};
  const findings = tryParse(diagnosis.findings_json) || [];
  const recs = tryParse(diagnosis.recommendations_json) || [];
  const roi = tryParse(diagnosis.roi_projection_json) || {};

  const areaNames = {
    digitalization: '업무 디지털화',
    processEfficiency: '프로세스 효율성',
    dataUtilization: '데이터 활용도',
    humanCapability: '인력 역량',
    costStructure: '비용 구조',
    growthPotential: '성장 잠재력',
  };

  let md = `# ${company.name} 진단 리포트\n\n`;
  md += `> 진단일: ${diagnosis.diagnosed_at || 'N/A'}\n`;
  md += `> 단계: ${diagnosis.stage} | 등급: **${diagnosis.overall_grade}** (${diagnosis.overall_score}점)\n\n`;

  md += `## 종합 점수: ${diagnosis.overall_score}/100 (${diagnosis.overall_grade}등급)\n\n`;

  md += `| 영역 | 점수 | 상태 |\n|------|------|------|\n`;
  for (const [key, name] of Object.entries(areaNames)) {
    const s = scores[key]?.score ?? scores[key] ?? '-';
    const bar = typeof s === 'number' ? '█'.repeat(Math.round(s / 10)) + '░'.repeat(10 - Math.round(s / 10)) : '';
    md += `| ${name} | ${s}/100 | ${bar} |\n`;
  }

  md += `\n## 주요 발견사항\n\n`;
  for (const f of findings.slice(0, 10)) {
    const icon = f.severity === 'high' ? '🔴' : f.severity === 'good' ? '🟢' : '🟡';
    md += `- ${icon} **[${areaNames[f.area] || f.area}]** ${f.msg}\n`;
  }

  md += `\n## 추천 조치\n\n`;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const pIcon = r.priority === 'high' ? '🔴' : r.priority === 'medium' ? '🟡' : '🟢';
    md += `### ${i + 1}. ${pIcon} ${r.title}\n`;
    md += `- ${r.description}\n`;
    md += `- 예상 효과: ${r.estimatedImpact}\n`;
    md += `- 난이도: ${r.difficulty}\n\n`;
  }

  if (roi.monthlyPotentialSavings) {
    md += `## ROI 예측\n\n`;
    md += `| 항목 | 금액 |\n|------|------|\n`;
    md += `| 월간 절감 가능액 | ${(roi.monthlyPotentialSavings / 10000).toFixed(0)}만원 |\n`;
    md += `| 연간 절감 가능액 | ${(roi.yearlyPotentialSavings / 10000).toFixed(0)}만원 |\n`;
    md += `| 구현 비용 (추정) | ${(roi.implementationCostEstimate / 10000).toFixed(0)}만원 |\n`;
    md += `| 손익분기 | ${roi.breakEvenMonths}개월 |\n`;
    md += `| 3년 ROI | ${roi.threeYearROI}% |\n`;
  }

  md += `\n---\n*Generated by Orbit AI — Palantir for SMEs*\n`;
  return md;
}

function markdownToSimpleHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\|(.+)\|/g, (m) => {
      const cells = m.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Orbit 진단 리포트</title>
<style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#0d1117;color:#c9d1d9}
h1,h2,h3{color:#58a6ff}table{border-collapse:collapse;width:100%}td{border:1px solid #30363d;padding:8px}
blockquote{border-left:3px solid #58a6ff;padding-left:12px;color:#8b949e}
li{margin:4px 0}strong{color:#ffa657}</style></head><body>${html}</body></html>`;
}

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}
