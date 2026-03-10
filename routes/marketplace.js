'use strict';
/**
 * routes/marketplace.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 마켓플레이스 솔루션 카탈로그 API
 *
 * 엔드포인트:
 *   GET  /api/marketplace/solutions              - 전체 솔루션 목록
 *   GET  /api/marketplace/solutions/:id          - 솔루션 상세정보
 *   GET  /api/marketplace/solutions/category/:category - 카테고리별 솔루션
 *   POST /api/marketplace/solutions/install/:id  - 솔루션 설치 요청
 *   GET  /api/marketplace/featured               - 추천 솔루션
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// 솔루션 카탈로그 (초기 데이터)
const SOLUTION_CATALOG = [
  // ══ Official Solutions (Darlene) ══════════════════════════════════════════
  {
    id: 'official-slack-integration',
    name: 'Slack 팀 협업 도입',
    provider: 'official',
    category: 'Communication',
    description: 'Slack 통합을 통한 팀 소통 효율화 및 정보 공유 개선',
    icon: '💬',
    rating: 4.8,
    reviews: 24,
    estimatedCost: 3000,
    estimatedSavings: 150,
    duration: '2개월',
    phase: 1,
    features: [
      '채널 기반 팀 소통',
      '메시지 검색 및 아카이빙',
      '통합 알림 관리',
      '파일 공유 및 버전 관리'
    ],
    requirements: ['기업 Slack 계정', '10인 이상 팀'],
    roiProjection: {
      investment: 3000,
      monthlyBenefit: 150,
      breakEven: '20개월',
      yearlyImpact: 1800
    }
  },
  {
    id: 'official-excel-automation',
    name: '엑셀 자동화 체계',
    provider: 'official',
    category: 'Spreadsheet',
    description: '반복적인 엑셀 작업 자동화 및 오류 감소',
    icon: '📊',
    rating: 4.7,
    reviews: 31,
    estimatedCost: 2500,
    estimatedSavings: 210,
    duration: '3주',
    phase: 1,
    features: [
      '자동 데이터 수집',
      '매크로 및 수식 최적화',
      '보고서 자동 생성',
      '데이터 검증 자동화'
    ],
    requirements: ['Excel 2019 이상'],
    roiProjection: {
      investment: 2500,
      monthlyBenefit: 210,
      breakEven: '12개월',
      yearlyImpact: 2520
    }
  },
  {
    id: 'official-quality-automation',
    name: '품질 관리 자동화',
    provider: 'official',
    category: 'Quality',
    description: '품질 검사 프로세스 자동화로 결함 감소',
    icon: '✅',
    rating: 4.9,
    reviews: 18,
    estimatedCost: 8000,
    estimatedSavings: 545,
    duration: '4개월',
    phase: 2,
    features: [
      '자동 품질 검사',
      '결함 추적 및 분석',
      '예측 기반 품질 관리',
      '리포팅 자동화'
    ],
    requirements: ['품질 관리 부서'],
    roiProjection: {
      investment: 8000,
      monthlyBenefit: 545,
      breakEven: '15개월',
      yearlyImpact: 6540
    }
  },

  // ══ Verified Solutions (Third-party) ═══════════════════════════════════════
  {
    id: 'verified-zapier',
    name: 'Zapier 자동화',
    provider: 'verified',
    category: 'Integration',
    description: '앱 간 자동화 연결로 반복 작업 제거',
    icon: '⚡',
    rating: 4.6,
    reviews: 156,
    estimatedCost: 1200,
    estimatedSavings: 80,
    duration: '2주',
    phase: 1,
    features: [
      '500+ 앱 통합',
      '노코드 워크플로우',
      '조건부 자동화',
      '에러 추적'
    ],
    requirements: ['Zapier 계정'],
    roiProjection: {
      investment: 1200,
      monthlyBenefit: 80,
      breakEven: '15개월',
      yearlyImpact: 960
    }
  },
  {
    id: 'verified-notion',
    name: 'Notion 지식 관리',
    provider: 'verified',
    category: 'Documentation',
    description: '팀 지식 베이스 및 문서화 시스템 구축',
    icon: '📝',
    rating: 4.5,
    reviews: 203,
    estimatedCost: 500,
    estimatedSavings: 60,
    duration: '1개월',
    phase: 1,
    features: [
      '공동 편집',
      '데이터베이스',
      '타임라인 관리',
      '권한 제어'
    ],
    requirements: ['인터넷 접근'],
    roiProjection: {
      investment: 500,
      monthlyBenefit: 60,
      breakEven: '9개월',
      yearlyImpact: 720
    }
  },

  // ══ Community Solutions (Open Source) ═════════════════════════════════════
  {
    id: 'community-python-analysis',
    name: 'Python 데이터 분석',
    provider: 'community',
    category: 'Analytics',
    description: '파이썬 기반 데이터 분석 및 시각화',
    icon: '🐍',
    rating: 4.3,
    reviews: 89,
    estimatedCost: 0,
    estimatedSavings: 100,
    duration: '무제한',
    phase: 3,
    features: [
      'Pandas/NumPy 분석',
      'Matplotlib 시각화',
      '통계 리포팅',
      '예측 분석'
    ],
    requirements: ['Python 3.8+', '개발 스킬'],
    roiProjection: {
      investment: 0,
      monthlyBenefit: 100,
      breakEven: '즉시',
      yearlyImpact: 1200
    }
  }
];

function createMarketplaceRouter({ verifyToken, dbModule }) {
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

  // ── GET /api/marketplace/solutions ──────────────────────────────────────
  /**
   * 전체 솔루션 목록 조회 (필터 가능)
   * 쿼리 파라미터:
   *   - category: 카테고리 필터
   *   - provider: official|verified|community 필터
   *   - phase: 1|2|3 필터
   *   - sort: rating|cost|savings 정렬
   */
  router.get('/marketplace/solutions', (req, res) => {
    try {
      const { category, provider, phase, sort } = req.query;
      let solutions = [...SOLUTION_CATALOG];

      // 필터링
      if (category) {
        solutions = solutions.filter(s => s.category === category);
      }
      if (provider) {
        solutions = solutions.filter(s => s.provider === provider);
      }
      if (phase) {
        solutions = solutions.filter(s => s.phase === parseInt(phase));
      }

      // 정렬
      if (sort === 'rating') {
        solutions.sort((a, b) => b.rating - a.rating);
      } else if (sort === 'cost') {
        solutions.sort((a, b) => a.estimatedCost - b.estimatedCost);
      } else if (sort === 'savings') {
        solutions.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
      }

      res.json({
        ok: true,
        count: solutions.length,
        solutions,
        filters: {
          category,
          provider,
          phase,
          sort
        }
      });
    } catch (e) {
      console.error('[marketplace/solutions]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/marketplace/solutions/:id ──────────────────────────────────
  /**
   * 솔루션 상세정보 조회
   */
  router.get('/marketplace/solutions/:id', (req, res) => {
    try {
      const solution = SOLUTION_CATALOG.find(s => s.id === req.params.id);
      if (!solution) {
        return res.status(404).json({ error: 'Solution not found' });
      }

      res.json({
        ok: true,
        solution,
        relatedSolutions: SOLUTION_CATALOG
          .filter(s => s.category === solution.category && s.id !== solution.id)
          .slice(0, 3)
      });
    } catch (e) {
      console.error('[marketplace/solutions/:id]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/marketplace/solutions/category/:category ──────────────────
  /**
   * 카테고리별 솔루션 목록
   */
  router.get('/marketplace/category/:category', (req, res) => {
    try {
      const solutions = SOLUTION_CATALOG.filter(s => s.category === req.params.category);
      res.json({
        ok: true,
        category: req.params.category,
        count: solutions.length,
        solutions
      });
    } catch (e) {
      console.error('[marketplace/category/:category]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/marketplace/featured ───────────────────────────────────────
  /**
   * 추천 솔루션 (별점 높은 순서)
   */
  router.get('/marketplace/featured', (req, res) => {
    try {
      const featured = [...SOLUTION_CATALOG]
        .sort((a, b) => (b.rating * b.reviews) - (a.rating * a.reviews))
        .slice(0, 6);

      res.json({
        ok: true,
        featured,
        totalCount: SOLUTION_CATALOG.length
      });
    } catch (e) {
      console.error('[marketplace/featured]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/marketplace/solutions/install/:id ─────────────────────────
  /**
   * 솔루션 설치 요청 (인증 필요)
   */
  router.post('/marketplace/solutions/install/:id', authRequired, (req, res) => {
    try {
      const solution = SOLUTION_CATALOG.find(s => s.id === req.params.id);
      if (!solution) {
        return res.status(404).json({ error: 'Solution not found' });
      }

      const installationId = `inst_${Date.now()}_${req.user.id}`;
      const db = dbModule.getDb();

      // 설치 기록 저장
      if (db) {
        db.prepare(`
          INSERT INTO solution_installations (id, user_id, solution_id, status, created_at)
          VALUES (?, ?, ?, 'pending', datetime('now'))
        `).run(installationId, req.user.id, req.params.id);
      }

      res.json({
        ok: true,
        installationId,
        solution: solution.name,
        status: 'pending',
        nextSteps: [
          `1. 구성 설정 (${solution.duration})`,
          '2. 팀 교육',
          '3. 데이터 마이그레이션',
          '4. 성과 모니터링'
        ]
      });
    } catch (e) {
      console.error('[marketplace/solutions/install]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/marketplace/categories ─────────────────────────────────────
  /**
   * 모든 카테고리 목록
   */
  router.get('/marketplace/categories', (req, res) => {
    try {
      const categories = [...new Set(SOLUTION_CATALOG.map(s => s.category))].sort();
      const categoryStats = categories.map(cat => ({
        name: cat,
        count: SOLUTION_CATALOG.filter(s => s.category === cat).length,
        avgRating: (
          SOLUTION_CATALOG
            .filter(s => s.category === cat)
            .reduce((sum, s) => sum + s.rating, 0) /
          SOLUTION_CATALOG.filter(s => s.category === cat).length
        ).toFixed(1)
      }));

      res.json({
        ok: true,
        categories: categoryStats
      });
    } catch (e) {
      console.error('[marketplace/categories]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/marketplace/stats ──────────────────────────────────────────
  /**
   * 마켓플레이스 통계
   */
  router.get('/marketplace/stats', (req, res) => {
    try {
      const stats = {
        totalSolutions: SOLUTION_CATALOG.length,
        byProvider: {
          official: SOLUTION_CATALOG.filter(s => s.provider === 'official').length,
          verified: SOLUTION_CATALOG.filter(s => s.provider === 'verified').length,
          community: SOLUTION_CATALOG.filter(s => s.provider === 'community').length
        },
        avgRating: (SOLUTION_CATALOG.reduce((sum, s) => sum + s.rating, 0) / SOLUTION_CATALOG.length).toFixed(2),
        totalReviews: SOLUTION_CATALOG.reduce((sum, s) => sum + s.reviews, 0),
        phases: {
          phase1: SOLUTION_CATALOG.filter(s => s.phase === 1).length,
          phase2: SOLUTION_CATALOG.filter(s => s.phase === 2).length,
          phase3: SOLUTION_CATALOG.filter(s => s.phase === 3).length
        }
      };

      res.json({ ok: true, ...stats });
    } catch (e) {
      console.error('[marketplace/stats]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createMarketplaceRouter;
