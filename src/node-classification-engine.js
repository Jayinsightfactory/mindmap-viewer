/**
 * 노드 분류 엔진
 * 추적 데이터(이벤트) → 비즈니스 도메인 자동 분류
 * 
 * 분류 체계:
 * - Operations (5개): 매출처리, 구매처리, 재고관리, 배송관리, 검품
 * - Analytics: 분석 및 보고
 * - Design/Engineering: 프로젝트 설계 및 개발
 * - Admin: 사무 및 회의
 */

const pattern_keywords = {
  'Sales': {      // 매출 처리
    keywords: ['invoice', 'order', '주문', '청구', 'payment', '결제', 'customer', '고객'],
    confidence: 0.85,
    color: '#10b981',
  },
  'Procurement': { // 구매 처리
    keywords: ['purchase', 'supplier', '공급', 'vendor', '구매', 'quote', 'quotation'],
    confidence: 0.85,
    color: '#f59e0b',
  },
  'Inventory': {   // 재고 관리
    keywords: ['stock', 'inventory', '재고', 'warehouse', '창고', 'sku', 'product'],
    confidence: 0.80,
    color: '#06b6d4',
  },
  'Logistics': {   // 배송 관리
    keywords: ['shipping', '배송', 'delivery', '배달', 'tracking', 'carrier', 'freight'],
    confidence: 0.80,
    color: '#8b5cf6',
  },
  'Quality': {     // 검품
    keywords: ['quality', '품질', 'inspection', '검사', 'defect', '결함', 'test'],
    confidence: 0.75,
    color: '#ec4899',
  },
  'Analytics': {
    keywords: ['analysis', '분석', 'report', '보고', 'dashboard', '대시보드', 'metric'],
    confidence: 0.80,
    color: '#3b82f6',
  },
  'Development': {
    keywords: ['code', '코드', 'git', 'commit', '커밋', 'bug', '버그', 'feature'],
    confidence: 0.85,
    color: '#ef4444',
  },
  'Admin': {
    keywords: ['meeting', '회의', 'email', '이메일', 'document', '문서', 'schedule'],
    confidence: 0.75,
    color: '#64748b',
  }
};

/**
 * 이벤트 데이터로부터 비즈니스 도메인 점수 계산
 * @param {Object} event - 데이터베이스 이벤트
 * @returns {Object} { domain: string, score: number, keywords_matched: [] }
 */
function classifyEvent(event) {
  const eventText = [
    event.type || '',
    event.data_json ? JSON.stringify(event.data_json) : '',
    event.metadata_json ? JSON.stringify(event.metadata_json) : ''
  ].join(' ').toLowerCase();

  let bestMatch = { domain: null, score: 0, matched: [] };

  for (const [domain, config] of Object.entries(pattern_keywords)) {
    let matchCount = 0;
    const matched = [];

    for (const kw of config.keywords) {
      if (eventText.includes(kw.toLowerCase())) {
        matchCount++;
        matched.push(kw);
      }
    }

    if (matchCount > 0) {
      const score = (matchCount / config.keywords.length) * config.confidence;
      if (score > bestMatch.score) {
        bestMatch = { domain, score, matched };
      }
    }
  }

  return bestMatch;
}

/**
 * 도메인별 이벤트 집계
 * @param {Object} db - SQLite 데이터베이스
 * @returns {Object} { Operations: {...}, Analytics: {...}, ... }
 */
function aggregateByDomain(db) {
  const sql = `SELECT * FROM events ORDER BY timestamp DESC LIMIT 10000`;
  const events = db.prepare(sql).all();

  const domainStats = {};
  const nodesByDomain = {};

  // 초기화
  for (const domain of Object.keys(pattern_keywords)) {
    domainStats[domain] = { count: 0, events: [], keywords: {} };
    nodesByDomain[domain] = [];
  }

  // 분류
  for (const event of events) {
    const classified = classifyEvent(event);
    if (classified.domain) {
      domainStats[classified.domain].count++;
      domainStats[classified.domain].events.push(event);
      
      // 키워드 빈도
      for (const kw of classified.matched) {
        domainStats[classified.domain].keywords[kw] = 
          (domainStats[classified.domain].keywords[kw] || 0) + 1;
      }
    }
  }

  return domainStats;
}

/**
 * 도메인별 통계를 3D 노드로 변환
 * @param {Object} domainStats - aggregateByDomain 결과
 * @returns {Array} 3D 노드 배열
 */
function generateNodesFromStats(domainStats) {
  const nodes = [];
  const domains = Object.entries(domainStats)
    .filter(([_, stats]) => stats.count > 0)
    .sort((a, b) => b[1].count - a[1].count);

  // 도메인별 위치 (원형 배치)
  const angle = (360 / domains.length) * (Math.PI / 180);
  let currentAngle = 0;

  for (const [domain, stats] of domains) {
    const config = pattern_keywords[domain];
    const x = Math.cos(currentAngle) * 80;
    const z = Math.sin(currentAngle) * 80;

    // 도메인 대표 노드
    nodes.push({
      id: `domain_${domain}`,
      type: 'domain',
      name: domain,
      label: `${domain} (${stats.count})`,
      position: { x, y: 0, z },
      color: config.color,
      size: Math.min(stats.count / 100, 3),
      category: domain,
      stats: {
        totalEvents: stats.count,
        topKeywords: Object.entries(stats.keywords)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([kw, cnt]) => ({ keyword: kw, count: cnt }))
      }
    });

    currentAngle += angle;
  }

  return nodes;
}

/**
 * 시간대별 활동 분석
 * @param {Object} db - SQLite 데이터베이스
 * @returns {Object} { hours: {...}, days: {...} }
 */
function analyzeTemporalPatterns(db) {
  const sql = `
    SELECT 
      strftime('%H', timestamp) as hour,
      strftime('%Y-%m-%d', timestamp) as day,
      COUNT(*) as cnt
    FROM events
    GROUP BY hour, day
  `;
  
  const results = db.prepare(sql).all();
  const hourlyDistribution = {};
  const dailyDistribution = {};

  for (const row of results) {
    hourlyDistribution[row.hour] = (hourlyDistribution[row.hour] || 0) + row.cnt;
    dailyDistribution[row.day] = (dailyDistribution[row.day] || 0) + row.cnt;
  }

  return { hourly: hourlyDistribution, daily: dailyDistribution };
}

module.exports = {
  classifyEvent,
  aggregateByDomain,
  generateNodesFromStats,
  analyzeTemporalPatterns,
  pattern_keywords
};
