'use strict';
/**
 * routes/recommendations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 기업 분석 및 솔루션 추천 엔진
 *
 * 엔드포인트:
 *   POST /api/recommendations/analyze    - 회사 데이터 분석 및 솔루션 추천
 *   GET  /api/recommendations/:analysisId - 분석 결과 조회
 *   GET  /api/recommendations/history   - 분석 이력 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

const isPg = !!process.env.DATABASE_URL;

async function dbRun(db, sql, params = []) {
  if (isPg) {
    let i = 1;
    const pgSql = sql.replace(/\?/g, () => `$${i++}`);
    await db.query(pgSql, params);
  } else {
    db.prepare(sql).run(...params);
  }
}

async function dbGet(db, sql, params = []) {
  if (isPg) {
    let i = 1;
    const pgSql = sql.replace(/\?/g, () => `$${i++}`);
    const { rows } = await db.query(pgSql, params);
    return rows[0] || null;
  } else {
    return db.prepare(sql).get(...params);
  }
}

async function dbAll(db, sql, params = []) {
  if (isPg) {
    let i = 1;
    const pgSql = sql.replace(/\?/g, () => `$${i++}`);
    const { rows } = await db.query(pgSql, params);
    return rows;
  } else {
    return db.prepare(sql).all(...params);
  }
}

function createRecommendationsRouter({ verifyToken, dbModule }) {
  const router = express.Router();

  // ── 인증 미들웨어 ────────────────────────────────────────────────────────
  function authRequired(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });

    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });

    req.user = user;
    next();
  }

  // ── 분석 엔진 ────────────────────────────────────────────────────────────
  /**
   * 회사 데이터로부터 추천 생성
   */
  function analyzeCompanyData(companyData) {
    const {
      name,
      size,
      industry,
      programs = [],
      activities = {},
      recentProjects = []
    } = companyData;

    const findings = {
      bottlenecks: [],
      opportunities: [],
      currentCapabilities: [],
      riskFactors: []
    };

    // 병목 분석
    if (!programs.includes('Slack') && !programs.includes('Teams')) {
      findings.bottlenecks.push({
        issue: '팀 협업 도구 부재 → 소통 단절',
        impact: '월 10시간 낭비',
        severity: 'high',
        affectedTeams: ['영업', '마케팅', '개발']
      });
    }

    if (programs.filter(p => p.toLowerCase().includes('excel')).length > 0) {
      const excelUsage = activities['spreadsheet'] || 0;
      if (excelUsage > 20) {
        findings.bottlenecks.push({
          issue: '엑셀 수동 작업 과다 → 오류 및 시간 낭비',
          impact: '월 210분 낭비',
          severity: 'high',
          affectedTeams: ['회계', '기획']
        });
      }
    }

    if (size >= 30 && !programs.includes('Notion') && !programs.includes('Confluence')) {
      findings.bottlenecks.push({
        issue: '문서 관리 체계 부족 → 정보 분산',
        impact: '월 150분 낭비',
        severity: 'medium',
        affectedTeams: ['HR', '운영']
      });
    }

    // 기회 분석
    if (industry === 'manufacturing' || industry === 'production') {
      findings.opportunities.push({
        area: '품질 관리 자동화',
        automationPotential: 0.75,
        estimatedSavings: '월 $545',
        timeframe: '4개월',
        difficulty: 'medium'
      });
    }

    if (industry === 'sales' || industry === 'distribution') {
      findings.opportunities.push({
        area: '판매 프로세스 자동화',
        automationPotential: 0.65,
        estimatedSavings: '월 $300',
        timeframe: '2개월',
        difficulty: 'low'
      });
    }

    findings.opportunities.push({
      area: '데이터 분석 및 시각화',
      automationPotential: 0.6,
      estimatedSavings: '월 $200',
      timeframe: '3주',
      difficulty: 'low'
    });

    // 현재 역량 평가
    if (programs.length >= 5) {
      findings.currentCapabilities.push('기술 스택 다양성');
    }
    if (recentProjects.length >= 3) {
      findings.currentCapabilities.push('프로젝트 관리 경험');
    }
    if (size >= 20) {
      findings.currentCapabilities.push('팀 협업 문화');
    }

    return findings;
  }

  /**
   * 분석 결과로부터 솔루션 추천 생성
   */
  function generateRecommendations(findings, industry, size) {
    const recommendations = {
      phase1: [],
      phase2: [],
      phase3: []
    };

    // Phase 1: 즉시 실행 가능 (Low Cost, High Impact)
    if (findings.bottlenecks.some(b => b.issue.includes('협업'))) {
      recommendations.phase1.push({
        id: 'official-slack-integration',
        name: 'Slack 팀 협업 도입',
        category: 'Communication',
        provider: 'official',
        estimatedCost: 3000,
        estimatedSavings: 150,
        duration: '2개월',
        priority: 'high',
        reason: '팀 소통 효율화로 즉시 생산성 향상'
      });
    }

    if (findings.bottlenecks.some(b => b.issue.includes('엑셀'))) {
      recommendations.phase1.push({
        id: 'official-excel-automation',
        name: '엑셀 자동화 체계',
        category: 'Spreadsheet',
        provider: 'official',
        estimatedCost: 2500,
        estimatedSavings: 210,
        duration: '3주',
        priority: 'high',
        reason: '반복 작업 제거로 시간 절감'
      });
    }

    if (!recommendations.phase1.some(r => r.category === 'Documentation')) {
      recommendations.phase1.push({
        id: 'verified-notion',
        name: 'Notion 지식 관리',
        category: 'Documentation',
        provider: 'verified',
        estimatedCost: 500,
        estimatedSavings: 60,
        duration: '1개월',
        priority: 'medium',
        reason: '팀 지식 베이스 구축'
      });
    }

    // Phase 2: 중기 목표 (3개월)
    if (industry === 'manufacturing' || industry === 'production') {
      recommendations.phase2.push({
        id: 'official-quality-automation',
        name: '품질 관리 자동화',
        category: 'Quality',
        provider: 'official',
        estimatedCost: 8000,
        estimatedSavings: 545,
        duration: '4개월',
        priority: 'high',
        reason: '품질 개선 및 비용 절감'
      });
    }

    // 일반적인 Phase 2 솔루션
    if (size >= 15) {
      recommendations.phase2.push({
        id: 'verified-zapier',
        name: 'Zapier 자동화',
        category: 'Integration',
        provider: 'verified',
        estimatedCost: 1200,
        estimatedSavings: 80,
        duration: '2주',
        priority: 'medium',
        reason: '앱 간 통합으로 반복 작업 제거'
      });
    }

    // Phase 3: 장기 전략 (6개월+)
    recommendations.phase3.push({
      id: 'community-python-analysis',
      name: 'Python 데이터 분석',
      category: 'Analytics',
      provider: 'community',
      estimatedCost: 0,
      estimatedSavings: 100,
      duration: '무제한',
      priority: 'medium',
      reason: '데이터 기반 의사결정 체계 구축'
    });

    return recommendations;
  }

  // ── POST /api/recommendations/analyze ────────────────────────────────────
  /**
   * 회사 데이터 분석 및 솔루션 추천
   *
   * 요청 본문:
   * {
   *   "companyId": "company_123",
   *   "name": "Manufacturing Co",
   *   "size": 50,
   *   "industry": "manufacturing",
   *   "programs": ["Excel", "Word", "Teams"],
   *   "activities": {
   *     "spreadsheet": 25,
   *     "communication": 15,
   *     "documentation": 10
   *   },
   *   "recentProjects": ["Project A", "Project B"]
   * }
   */
  router.post('/recommendations/analyze', authRequired, async (req, res) => {
    try {
      const companyData = req.body;
      const { companyId, name, size, industry } = companyData;

      if (!name || !size || !industry) {
        return res.status(400).json({
          error: 'name, size, industry 필드가 필수입니다.'
        });
      }

      // 분석 수행
      const findings = analyzeCompanyData(companyData);
      const recommendations = generateRecommendations(findings, industry, size);

      const analysisId = `analysis_${Date.now()}_${req.user.id}`;

      // 분석 결과 저장
      const db = dbModule.getDb();
      if (db) {
        const nowExpr = isPg ? 'NOW()' : "datetime('now')";
        await dbRun(db, `
          INSERT INTO analysis_results (id, user_id, company_id, findings_json, recommendations_json, created_at)
          VALUES (?, ?, ?, ?, ?, ${nowExpr})
        `, [
          analysisId,
          req.user.id,
          companyId || name,
          JSON.stringify(findings),
          JSON.stringify(recommendations)
        ]);
      }

      res.json({
        ok: true,
        analysisId,
        company: {
          name,
          size,
          industry
        },
        findings,
        recommendations,
        summary: {
          totalBottlenecks: findings.bottlenecks.length,
          totalOpportunities: findings.opportunities.length,
          recommendedSolutions: (
            recommendations.phase1.length +
            recommendations.phase2.length +
            recommendations.phase3.length
          ),
          estimatedTotalInvestment: (
            (recommendations.phase1.reduce((sum, r) => sum + r.estimatedCost, 0)) +
            (recommendations.phase2.reduce((sum, r) => sum + r.estimatedCost, 0)) +
            (recommendations.phase3.reduce((sum, r) => sum + r.estimatedCost, 0))
          ),
          estimatedMonthlyBenefit: (
            (recommendations.phase1.reduce((sum, r) => sum + r.estimatedSavings, 0)) +
            (recommendations.phase2.reduce((sum, r) => sum + r.estimatedSavings, 0)) +
            (recommendations.phase3.reduce((sum, r) => sum + r.estimatedSavings, 0))
          )
        }
      });
    } catch (e) {
      console.error('[recommendations/analyze]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/recommendations/:analysisId ────────────────────────────────
  /**
   * 분석 결과 조회
   */
  router.get('/recommendations/:analysisId', authRequired, async (req, res) => {
    try {
      const db = dbModule.getDb();
      let result = null;

      if (db) {
        result = await dbGet(db, `
          SELECT * FROM analysis_results
          WHERE id = ? AND user_id = ?
        `, [req.params.analysisId, req.user.id]);
      }

      if (!result) {
        return res.status(404).json({ error: 'Analysis not found' });
      }

      res.json({
        ok: true,
        analysisId: result.id,
        findings: JSON.parse(result.findings_json),
        recommendations: JSON.parse(result.recommendations_json),
        createdAt: result.created_at
      });
    } catch (e) {
      console.error('[recommendations/:analysisId]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/recommendations/history ────────────────────────────────────
  /**
   * 분석 이력 조회 (최신 10개)
   */
  router.get('/recommendations/history', authRequired, async (req, res) => {
    try {
      const db = dbModule.getDb();
      let results = [];

      if (db) {
        results = await dbAll(db, `
          SELECT id, company_id, created_at FROM analysis_results
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 10
        `, [req.user.id]);
      }

      res.json({
        ok: true,
        count: results.length,
        history: results
      });
    } catch (e) {
      console.error('[recommendations/history]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRecommendationsRouter;
