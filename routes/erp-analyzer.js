'use strict';
/**
 * routes/erp-analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ERP 분석 에이전트 — 화훼 관리 프로그램 v1.0.13 기능 분석 + Orbit OS 통합 계획
 *
 * 목적:
 *   1. 전산 프로그램의 모든 기능 목록화 + 실제 사용 빈도 분석
 *   2. 사용하지 않는 기능 / 수동으로 하는 업무 갭 발견
 *   3. Orbit OS로 마이그레이션할 기능 우선순위 결정
 *   4. 실시간 직원 작업 vs DB 변화 대조
 *
 * 데이터 소스:
 *   - Vision UI Learning: ui_elements (2,468개), ui_screen_fingerprints (310 화면)
 *   - nenova SQL Server: OrderMaster, OrderDetail, ShipmentMaster, Product, Customer, Estimate 등
 *   - Orbit events (42,982건): 직원 활동 이벤트 (windowTitle, currentApp)
 *   - transition_model (670+건): 앱 전환 패턴
 *
 * ⚠️ 절대 규칙: nenova SQL Server에는 SELECT만 실행한다.
 *   INSERT / UPDATE / DELETE / ALTER / DROP 절대 금지!
 *
 * 엔드포인트:
 *   # 전산 기능 분석
 *   GET /api/erp/features              — 전산 프로그램의 모든 기능 목록 + 사용 빈도
 *   GET /api/erp/unused-features       — 있지만 사용 안 하는 기능
 *   GET /api/erp/manual-gaps           — 전산에 없어서 수동으로 하는 업무
 *   GET /api/erp/data-vs-screen        — 캡처 화면 데이터 vs DB 실제 데이터 대조
 *
 *   # Orbit OS 통합 계획
 *   GET /api/erp/orbit-migration       — 전산 → Orbit OS 마이그레이션 계획
 *   GET /api/erp/feature-priority      — Orbit OS에 먼저 구현할 기능 우선순위
 *   GET /api/erp/automation-gaps       — 전산과 연동 안 되서 수작업인 부분
 *
 *   # 실시간 대조
 *   GET /api/erp/live-comparison       — 지금 직원이 전산에서 하는 작업 vs DB 변화
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// SQL Server 연결 설정 (nenova-db.js와 동일 패턴, 자체 포함)
// ═══════════════════════════════════════════════════════════════════════════

let sql;
try {
  sql = require('mssql');
} catch (e) {
  console.warn('[erp-analyzer] mssql 패키지 미설치 — npm install mssql 필요');
  sql = null;
}

const MSSQL_CONFIG = {
  server: 'sql16ssd-014.localnet.kr',
  port: 1433,
  database: 'nenova1_nenova',
  user: 'nenova1_nenova',
  password: process.env.NENOVA_DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// ── 커넥션 풀 싱글톤 ──
let _pool = null;
let _poolPromise = null;
let _lastError = null;

function validateReadOnly(query) {
  const normalized = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'MERGE'];
  for (const keyword of forbidden) {
    if (normalized.startsWith(keyword)) {
      throw new Error(`[보안] nenova DB에 ${keyword} 쿼리 실행 금지! 읽기 전용입니다.`);
    }
  }
}

async function getPool() {
  if (!sql) throw new Error('mssql 패키지가 설치되지 않았습니다. npm install mssql');
  if (!process.env.NENOVA_DB_PASSWORD) {
    throw new Error('NENOVA_DB_PASSWORD 환경변수가 설정되지 않았습니다');
  }
  if (_pool && _pool.connected) return _pool;
  if (_poolPromise) return _poolPromise;

  _poolPromise = (async () => {
    try {
      _pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
      _lastError = null;
      console.log('[erp-analyzer] SQL Server 연결 성공');
      _pool.on('error', (err) => {
        console.error('[erp-analyzer] 풀 에러:', err.message);
        _lastError = err.message;
        _pool = null;
      });
      return _pool;
    } catch (err) {
      _lastError = err.message;
      _pool = null;
      throw err;
    } finally {
      _poolPromise = null;
    }
  })();

  return _poolPromise;
}

async function safeQuery(queryFn) {
  try {
    const pool = await getPool();
    const originalRequest = pool.request.bind(pool);
    const safePool = Object.create(pool);
    safePool.request = function() {
      const req = originalRequest();
      const originalQuery = req.query.bind(req);
      req.query = function(queryStr) {
        validateReadOnly(queryStr);
        return originalQuery(queryStr);
      };
      return req;
    };
    return await queryFn(safePool);
  } catch (err) {
    _lastError = err.message;
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 전산 프로그램 기능 정의 (Vision 학습 + 실제 DB 테이블 매핑)
// ═══════════════════════════════════════════════════════════════════════════

const KNOWN_FEATURES = [
  { id: 'order_entry',    name: '신규 주문 등록',       screen: '신규 주문 등록',       dbTable: 'OrderMaster + OrderDetail',       status: 'active',  category: '주문' },
  { id: 'order_mgmt',     name: '주문 관리',           screen: '주문관리',             dbTable: 'OrderMaster',                    status: 'active',  category: '주문' },
  { id: 'shipment_dist',  name: '출고 분배',           screen: '출고분배',             dbTable: 'ShipmentDetail',                 status: 'active',  category: '출고' },
  { id: 'shipment_query', name: '출고 조회',           screen: '출고조회',             dbTable: 'ShipmentMaster',                 status: 'active',  category: '출고' },
  { id: 'shipment_history', name: '출고 내역 조회',     screen: '출고내역조회',          dbTable: 'ShipmentHistory',                status: 'active',  category: '출고' },
  { id: 'inventory',      name: '재고 관리',           screen: '재고관리',             dbTable: 'ProductStock',                   status: 'active',  category: '재고' },
  { id: 'purchase',       name: '발주 관리',           screen: '발주관리',             dbTable: 'OrderMaster (발주)',              status: 'active',  category: '발주' },
  { id: 'receiving',      name: '입고 관리',           screen: '입고관리',             dbTable: 'WarehouseDetail',                status: 'unknown', category: '입고' },
  { id: 'estimate',       name: '견적서 관리',          screen: '견적서관리',            dbTable: 'Estimate',                       status: 'active',  category: '매출' },
  { id: 'pivot',          name: 'Pivot 통계',          screen: 'Pivot통계',            dbTable: 'all (cross-tab)',                status: 'active',  category: '분석' },
  { id: 'monthly_sales',  name: '월별 판매 현황',       screen: '월별판매현황',          dbTable: 'Estimate',                       status: 'active',  category: '분석' },
  { id: 'customer_mgmt',  name: '거래처 관리',          screen: '거래처관리',            dbTable: 'Customer',                       status: 'active',  category: '마스터' },
  { id: 'user_mgmt',      name: '사용자 관리',          screen: '사용자관리',            dbTable: 'UserInfo',                       status: 'unknown', category: '관리' },
  { id: 'product_mgmt',   name: '품목 관리',           screen: '품목관리',             dbTable: 'Product',                        status: 'active',  category: '마스터' },
  { id: 'code_mgmt',      name: '코드 관리',           screen: '코드관리',             dbTable: 'CodeInfo',                       status: 'unknown', category: '관리' },
  { id: 'region_sales',   name: '지역별 판매 비교',     screen: '지역별판매비교',        dbTable: 'Estimate + Customer',            status: 'unknown', category: '분석' },
  { id: 'sales_analysis', name: '매출/물량 분석',       screen: '매출/물량분석',         dbTable: 'Estimate',                       status: 'active',  category: '분석' },
  { id: 'salesperson',    name: '영업사원 실적',        screen: '영업사원실적',          dbTable: 'OrderMaster + UserInfo',          status: 'unknown', category: '분석' },
  { id: 'cust_prod_cost', name: '업체별 품목 단가',     screen: '업체별품목단가관리',     dbTable: 'CustomerProdCost',               status: 'unknown', category: '마스터' },
];

/**
 * 화면 키워드 → feature ID 매핑 (windowTitle에서 기능 추출)
 */
const SCREEN_KEYWORD_MAP = {
  order_entry:      ['신규 주문', '주문 등록', '주문등록', 'new order', 'order entry'],
  order_mgmt:       ['주문 관리', '주문관리', '주문 조회', '주문조회', 'order manage'],
  shipment_dist:    ['출고 분배', '출고분배', 'shipment dist'],
  shipment_query:   ['출고 조회', '출고조회', 'shipment query'],
  shipment_history: ['출고 내역', '출고내역', 'shipment history'],
  inventory:        ['재고 관리', '재고관리', '재고 조회', '재고조회', 'stock', 'inventory'],
  purchase:         ['발주 관리', '발주관리', '발주 조회', '발주조회', 'purchase'],
  receiving:        ['입고 관리', '입고관리', '입고 조회', '입고조회', 'receiving'],
  estimate:         ['견적서', '견적 관리', '견적관리', 'estimate', 'quotation'],
  pivot:            ['pivot', '피벗', 'Pivot'],
  monthly_sales:    ['월별 판매', '월별판매', 'monthly sales'],
  customer_mgmt:    ['거래처 관리', '거래처관리', '고객 관리', '고객관리', 'customer'],
  user_mgmt:        ['사용자 관리', '사용자관리', 'user manage'],
  product_mgmt:     ['품목 관리', '품목관리', '상품 관리', '상품관리', 'product'],
  code_mgmt:        ['코드 관리', '코드관리', 'code manage'],
  region_sales:     ['지역별 판매', '지역별판매', 'region sales'],
  sales_analysis:   ['매출 분석', '매출분석', '물량 분석', '물량분석', 'sales analysis'],
  salesperson:      ['영업사원', '영업 사원', 'salesperson'],
  cust_prod_cost:   ['업체별 품목', '업체별품목', '품목 단가', '품목단가', 'customer prod cost'],
};

/**
 * 수동 업무 갭 — 전산에 없어서 Excel/수기로 하는 업무 목록
 * (활동 분류 + transition rules 분석에서 발견된 것들)
 */
const KNOWN_MANUAL_GAPS = [
  {
    id: 'deduction_check',
    process: '차감 대조',
    manualTool: 'Excel',
    description: '주문 데이터와 실제 출고/정산 차감 내역을 Excel에서 수동 대조',
    estimatedMinutes: 40,
    frequency: '일 1회',
    keywords: ['차감내역', '차감대조', '차감', 'deduction'],
    nenovaHas: false,
    relatedDbTables: ['OrderDetail', 'Estimate'],
  },
  {
    id: 'volume_report',
    process: '물량표 작업',
    manualTool: 'Excel',
    description: '일일/주간 물량을 Excel에서 수동 집계하여 보고서 작성',
    estimatedMinutes: 193,
    frequency: '일 1회',
    keywords: ['물량표', '물량 작업', '물량보고', 'volume report'],
    nenovaHas: false,
    relatedDbTables: ['OrderDetail', 'ShipmentDetail'],
  },
  {
    id: 'sales_report',
    process: '매출 보고',
    manualTool: 'Excel',
    description: '전산에 매출 데이터 있지만 보고 양식이 Excel이라 수동 복사',
    estimatedMinutes: 30,
    frequency: '주 1회',
    keywords: ['매출보고', '매출 보고', '매출리포트', 'sales report'],
    nenovaHas: true,
    relatedDbTables: ['Estimate'],
  },
  {
    id: 'kakao_order',
    process: '카톡 주문 → 전산 입력',
    manualTool: 'KakaoTalk + nenova',
    description: '카카오톡으로 받은 주문을 읽고 전산에 수동 타이핑',
    estimatedMinutes: 120,
    frequency: '일 다수',
    keywords: ['카톡', '카카오톡', 'kakao', 'kakaotalk'],
    nenovaHas: false,
    relatedDbTables: ['OrderMaster', 'OrderDetail'],
  },
  {
    id: 'purchase_order',
    process: '발주 작업 (Excel)',
    manualTool: 'Excel',
    description: '전산에 발주 기능이 있지만 일부 발주는 Excel에서 작업 후 전산에 재입력',
    estimatedMinutes: 61,
    frequency: '일 1회',
    keywords: ['발주 작업', '발주작업', '발주 Excel', 'purchase order'],
    nenovaHas: true,
    relatedDbTables: ['OrderMaster'],
  },
  {
    id: 'customer_price',
    process: '거래처별 단가 관리',
    manualTool: 'Excel',
    description: '거래처별 품목 단가를 Excel에서 관리 — 전산 단가표와 별도로 유지',
    estimatedMinutes: 25,
    frequency: '주 2~3회',
    keywords: ['단가 관리', '단가관리', '업체별 단가', 'customer price'],
    nenovaHas: true,
    relatedDbTables: ['CustomerProdCost'],
  },
  {
    id: 'claim_process',
    process: '클레임 처리',
    manualTool: 'Excel + 전화',
    description: '품질 클레임 접수/처리를 별도 Excel로 관리 — 전산에 클레임 모듈 없음',
    estimatedMinutes: 15,
    frequency: '주 3~5건',
    keywords: ['클레임', '반품', 'claim', '품질 문제'],
    nenovaHas: false,
    relatedDbTables: [],
  },
  {
    id: 'delivery_tracking',
    process: '배송 추적',
    manualTool: '전화 + 메모',
    description: '출고 후 배송 상태를 전화로 확인 — 전산에 배송 추적 기능 없음',
    estimatedMinutes: 20,
    frequency: '일 다수',
    keywords: ['배송', '배달', '운송', 'delivery', 'tracking'],
    nenovaHas: false,
    relatedDbTables: ['ShipmentMaster'],
  },
];

/**
 * 자동화 갭 정의 — 전산+수작업 사이의 비효율 구간
 */
const AUTOMATION_GAPS = [
  {
    process: '카톡 주문 → 전산 입력',
    manualStep: '카톡에서 품목/수량 읽기 → 전산에 수동 타이핑',
    why: '전산 프로그램에 카톡 연동 없음',
    orbitSolution: '파서가 카톡 텍스트 자동 파싱 → API로 전산 DB 직접 입력',
    readiness: 85,
    blocker: 'nenova DB 쓰기 권한 (현재 읽기만)',
    dailySavings: 120,
    priority: 1,
  },
  {
    process: '주문 → 차감 대조',
    manualStep: '주문 데이터를 기억에 의존해 Excel에서 대조',
    why: '전산에 차감 자동 연동 기능 없음',
    orbitSolution: 'OrderDetail + Estimate 자동 비교 → 불일치 알림',
    readiness: 90,
    blocker: '없음 (읽기만으로 가능)',
    dailySavings: 40,
    priority: 2,
  },
  {
    process: '물량표 작성',
    manualStep: '전산 데이터를 Excel에 수동 복사해서 물량표 포맷 만들기',
    why: '전산에 물량표 리포트 출력 기능 없음 (조회만 가능)',
    orbitSolution: 'Orbit에서 OrderDetail + ShipmentDetail 자동 집계 → 웹 리포트',
    readiness: 95,
    blocker: '없음 (읽기만으로 가능)',
    dailySavings: 193,
    priority: 3,
  },
  {
    process: '매출 보고서 작성',
    manualStep: '전산 매출 데이터 → Excel로 내보내기 → 양식 맞추기 → 보고',
    why: '전산 보고서 양식이 고정이라 경영진 요구 양식과 불일치',
    orbitSolution: 'Estimate 데이터로 커스텀 보고서 자동 생성 (Google Sheets 연동)',
    readiness: 80,
    blocker: 'Google Sheets API 연동 (이미 구현됨)',
    dailySavings: 30,
    priority: 4,
  },
  {
    process: '발주 → 주문 매칭',
    manualStep: '발주한 물량과 실제 주문 물량 Excel에서 수동 비교',
    why: '전산에서 발주-주문 자동 매칭 기능 없음',
    orbitSolution: 'OrderMaster (발주) vs OrderDetail (주문) 자동 비교 대시보드',
    readiness: 85,
    blocker: '없음',
    dailySavings: 61,
    priority: 5,
  },
  {
    process: '거래처별 단가 변동 추적',
    manualStep: '단가 변동 시 Excel에서 수동 히스토리 관리',
    why: '전산에 단가 변경 이력 기능 부족',
    orbitSolution: 'CustomerProdCost 변동 감지 → 자동 알림 + 히스토리 DB',
    readiness: 70,
    blocker: 'nenova DB 단가 변경 시점 추적 쿼리 필요',
    dailySavings: 25,
    priority: 6,
  },
  {
    process: '클레임 접수 및 처리',
    manualStep: '전화/카톡으로 접수 → Excel에 기록 → 담당자 지정 → 처리 결과 기록',
    why: '전산에 클레임 모듈 자체가 없음',
    orbitSolution: 'Orbit에 클레임 관리 모듈 신규 구현 (접수→처리→완료 워크플로)',
    readiness: 40,
    blocker: '클레임 DB 스키마 설계 + UI 필요',
    dailySavings: 15,
    priority: 7,
  },
  {
    process: '배송 상태 확인',
    manualStep: '출고 후 운송기사에게 전화로 상태 확인',
    why: '전산에 배송 추적 기능 없음',
    orbitSolution: '배송 상태 입력 앱 (운송기사용) → Orbit 실시간 추적 대시보드',
    readiness: 30,
    blocker: '운송기사용 모바일 앱 필요',
    dailySavings: 20,
    priority: 8,
  },
];


// ═══════════════════════════════════════════════════════════════════════════
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createErpAnalyzerRouter({ getDb }) {
  const router = express.Router();

  // ── Orbit PostgreSQL 헬퍼 ──
  function getOrbitDb() {
    const db = getDb();
    if (!db || !db.query) throw new Error('Orbit PostgreSQL DB를 사용할 수 없습니다');
    return db;
  }

  // ── 공통 에러 핸들러 ──
  function handleError(res, err, context) {
    console.error(`[erp-analyzer] ${context}:`, err.message);
    if (err.message.includes('NENOVA_DB_PASSWORD') || err.message.includes('mssql')) {
      return res.status(503).json({
        ok: false,
        error: err.message,
        hint: 'nenova DB 연결 설정을 확인하세요',
      });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }

  // ── 날짜 헬퍼 ──
  function todayKST() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().split('T')[0];
  }

  /**
   * windowTitle에서 feature ID를 추출
   */
  function matchFeature(windowTitle) {
    if (!windowTitle) return null;
    const lower = windowTitle.toLowerCase();

    for (const [featureId, keywords] of Object.entries(SCREEN_KEYWORD_MAP)) {
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          return featureId;
        }
      }
    }

    // nenova 앱 자체인 것은 감지하지만 특정 기능 불명
    if (lower.includes('nenova') || lower.includes('화훼') || lower.includes('네노바')) {
      return 'nenova_general';
    }

    return null;
  }

  /**
   * nenova DB에서 각 테이블의 레코드 수를 조회
   */
  async function getNenovaTableCounts() {
    return safeQuery(async (pool) => {
      const results = await Promise.all([
        pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderMaster WHERE ISNULL(isDeleted,0)=0`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderDetail WHERE ISNULL(isDeleted,0)=0`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM ShipmentMaster WHERE ISNULL(isDeleted,0)=0`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM ShipmentDetail WHERE ISNULL(isDeleted,0)=0`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM Product`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM Customer`),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM Estimate`).catch(() => ({ recordset: [{ cnt: 0 }] })),
        pool.request().query(`SELECT COUNT(*) AS cnt FROM ProductStock`).catch(() => ({ recordset: [{ cnt: 0 }] })),
      ]);

      return {
        OrderMaster: results[0].recordset[0].cnt,
        OrderDetail: results[1].recordset[0].cnt,
        ShipmentMaster: results[2].recordset[0].cnt,
        ShipmentDetail: results[3].recordset[0].cnt,
        Product: results[4].recordset[0].cnt,
        Customer: results[5].recordset[0].cnt,
        Estimate: results[6].recordset[0].cnt,
        ProductStock: results[7].recordset[0].cnt,
      };
    });
  }

  /**
   * nenova DB에서 오늘/최근 7일 활동 데이터
   */
  async function getNenovaRecentActivity(days = 7) {
    return safeQuery(async (pool) => {
      const [orders, shipments, estimates] = await Promise.all([
        pool.request().query(`
          SELECT
            COUNT(*) AS cnt,
            COUNT(DISTINCT CustKey) AS custCount,
            COUNT(DISTINCT CreateID) AS userCount,
            MAX(CreateDtm) AS lastCreate,
            SUM(CASE WHEN CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS todayCount
          FROM OrderMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
        `),
        pool.request().query(`
          SELECT
            COUNT(*) AS cnt,
            COUNT(DISTINCT CustKey) AS custCount,
            MAX(CreateDtm) AS lastCreate,
            SUM(CASE WHEN CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS todayCount
          FROM ShipmentMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
        `),
        pool.request().query(`
          SELECT
            COUNT(*) AS cnt,
            MAX(CreateDtm) AS lastCreate,
            SUM(CASE WHEN CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS todayCount
          FROM Estimate
          WHERE CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
        `).catch(() => ({ recordset: [{ cnt: 0, lastCreate: null, todayCount: 0 }] })),
      ]);

      return {
        orders: orders.recordset[0],
        shipments: shipments.recordset[0],
        estimates: estimates.recordset[0],
      };
    });
  }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     1. 전산 기능 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/erp/features
   * 전산 프로그램의 모든 기능 목록 + Vision 학습 수 + 사용 빈도 + DB 데이터 수
   * ?days=30
   */
  router.get('/features', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // ── 1) Vision UI 학습 현황 (화면별 UI 요소 수) ──
      const visionStats = await orbitDb.query(`
        SELECT
          screen_name,
          COUNT(*) AS element_count,
          SUM(seen_count) AS total_seen,
          AVG(confidence) AS avg_confidence
        FROM ui_elements
        WHERE app_name ILIKE '%nenova%' OR app_name ILIKE '%화훼%' OR app_name ILIKE '%네노바%'
        GROUP BY screen_name
        ORDER BY element_count DESC
      `).catch(() => ({ rows: [] }));

      // ── 2) 화면 fingerprints (학습된 화면 수) ──
      const screenFingerprints = await orbitDb.query(`
        SELECT
          screen_name,
          COUNT(*) AS fingerprint_count
        FROM ui_screen_fingerprints
        WHERE app_name ILIKE '%nenova%' OR app_name ILIKE '%화훼%' OR app_name ILIKE '%네노바%'
        GROUP BY screen_name
      `).catch(() => ({ rows: [] }));

      // ── 3) Orbit events에서 기능별 사용 빈도 ──
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          user_id,
          type,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            data_json->>'windowTitle' IS NOT NULL
            OR data_json->>'currentApp' IS NOT NULL
          )
        ORDER BY timestamp DESC
        LIMIT 20000
      `, [days]);

      // 기능별 이벤트 집계
      const featureEvents = {};
      for (const e of events.rows) {
        const title = e.window_title || e.current_app || '';
        const featureId = matchFeature(title);
        if (!featureId || featureId === 'nenova_general') continue;

        if (!featureEvents[featureId]) {
          featureEvents[featureId] = { count: 0, users: new Set(), lastSeen: null };
        }
        featureEvents[featureId].count++;
        featureEvents[featureId].users.add(e.user_id);
        if (!featureEvents[featureId].lastSeen) {
          featureEvents[featureId].lastSeen = e.timestamp;
        }
      }

      // ── 4) transition_model에서 기능 전이 횟수 ──
      const transitions = await orbitDb.query(`
        SELECT from_state, to_state, count, probability
        FROM transition_model
        WHERE probability > 0.05
        ORDER BY count DESC
        LIMIT 500
      `).catch(() => ({ rows: [] }));

      // nenova 관련 전이 집계
      const transitionCounts = {};
      for (const t of transitions.rows) {
        const fromMatch = matchFeature(t.from_state);
        const toMatch = matchFeature(t.to_state);
        if (fromMatch && fromMatch !== 'nenova_general') {
          transitionCounts[fromMatch] = (transitionCounts[fromMatch] || 0) + (t.count || 1);
        }
        if (toMatch && toMatch !== 'nenova_general') {
          transitionCounts[toMatch] = (transitionCounts[toMatch] || 0) + (t.count || 1);
        }
      }

      // ── 5) nenova DB 테이블별 데이터 건수 ──
      let tableCounts = {};
      try {
        tableCounts = await getNenovaTableCounts();
      } catch (e) {
        console.warn('[erp-analyzer] nenova DB 연결 실패:', e.message);
      }

      // ── 6) Vision 스크린 맵 구성 ──
      const visionMap = {};
      for (const v of visionStats.rows) {
        visionMap[v.screen_name] = {
          elementCount: parseInt(v.element_count) || 0,
          totalSeen: parseInt(v.total_seen) || 0,
          avgConfidence: parseFloat(v.avg_confidence) || 0,
        };
      }

      const fingerprintMap = {};
      for (const f of screenFingerprints.rows) {
        fingerprintMap[f.screen_name] = parseInt(f.fingerprint_count) || 0;
      }

      // ── 결과 조합 ──
      const features = KNOWN_FEATURES.map(f => {
        const ev = featureEvents[f.id] || { count: 0, users: new Set(), lastSeen: null };
        const trans = transitionCounts[f.id] || 0;

        // Vision 데이터 매칭 (fuzzy: screen_name에 기능 키워드 포함 여부)
        let visionData = null;
        let fingerprints = 0;
        for (const [screenName, data] of Object.entries(visionMap)) {
          const kws = SCREEN_KEYWORD_MAP[f.id] || [];
          for (const kw of kws) {
            if (screenName.toLowerCase().includes(kw.toLowerCase())) {
              visionData = data;
              break;
            }
          }
          if (visionData) break;
        }
        for (const [screenName, cnt] of Object.entries(fingerprintMap)) {
          const kws = SCREEN_KEYWORD_MAP[f.id] || [];
          for (const kw of kws) {
            if (screenName.toLowerCase().includes(kw.toLowerCase())) {
              fingerprints = cnt;
              break;
            }
          }
          if (fingerprints > 0) break;
        }

        // DB 테이블 데이터 건수
        let dbRecords = 0;
        const mainTable = f.dbTable.split(/[+(]/)[0].trim();
        if (tableCounts[mainTable] !== undefined) {
          dbRecords = tableCounts[mainTable];
        }

        return {
          id: f.id,
          name: f.name,
          screen: f.screen,
          category: f.category,
          status: f.status,
          dbTable: f.dbTable,
          // 사용 빈도
          usage: {
            eventCount: ev.count,
            uniqueUsers: ev.users.size,
            userList: [...ev.users],
            transitionCount: trans,
            lastSeen: ev.lastSeen,
            dailyAvg: days > 0 ? Math.round((ev.count / days) * 10) / 10 : 0,
          },
          // Vision 학습 현황
          vision: {
            learnedElements: visionData ? visionData.elementCount : 0,
            screenFingerprints: fingerprints,
            avgConfidence: visionData ? Math.round(visionData.avgConfidence * 100) / 100 : 0,
          },
          // DB 데이터
          dbRecords,
        };
      });

      // 사용 빈도 순 정렬
      features.sort((a, b) => b.usage.eventCount - a.usage.eventCount);

      // 전체 요약
      const totalNenovaEvents = events.rows.filter(e => {
        const title = e.window_title || e.current_app || '';
        return matchFeature(title) !== null;
      }).length;

      res.json({
        ok: true,
        program: '화훼 관리 프로그램 v1.0.13',
        period: `${days}일`,
        summary: {
          totalFeatures: KNOWN_FEATURES.length,
          activeFeatures: features.filter(f => f.usage.eventCount > 0).length,
          dormantFeatures: features.filter(f => f.usage.eventCount === 0).length,
          totalNenovaEvents,
          totalVisionElements: visionStats.rows.reduce((sum, v) => sum + parseInt(v.element_count || 0), 0),
          totalScreensLearned: screenFingerprints.rows.length,
          nenovaDbConnected: Object.keys(tableCounts).length > 0,
        },
        features,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'features');
    }
  });


  /**
   * GET /api/erp/unused-features
   * 프로그램에 있지만 사용하지 않는 기능 목록
   * ?days=30
   */
  router.get('/unused-features', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // Orbit events에서 기능별 이벤트 수 집계
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            data_json->>'windowTitle' IS NOT NULL
            OR data_json->>'currentApp' IS NOT NULL
          )
        LIMIT 20000
      `, [days]);

      const featureCounts = {};
      for (const e of events.rows) {
        const title = e.window_title || e.current_app || '';
        const featureId = matchFeature(title);
        if (featureId && featureId !== 'nenova_general') {
          featureCounts[featureId] = (featureCounts[featureId] || 0) + 1;
        }
      }

      // transition_model에서 전이 패턴
      const transitions = await orbitDb.query(`
        SELECT from_state, to_state, count
        FROM transition_model
        WHERE count > 0
        LIMIT 500
      `).catch(() => ({ rows: [] }));

      const transFeatures = new Set();
      for (const t of transitions.rows) {
        const f = matchFeature(t.from_state);
        const to = matchFeature(t.to_state);
        if (f && f !== 'nenova_general') transFeatures.add(f);
        if (to && to !== 'nenova_general') transFeatures.add(to);
      }

      // DB 테이블 데이터 확인 (기능은 있는데 안 쓰는 건지, 데이터 자체가 없는 건지)
      let tableCounts = {};
      try {
        tableCounts = await getNenovaTableCounts();
      } catch (e) {
        console.warn('[erp-analyzer] nenova DB 미연결');
      }

      // 미사용 기능 분류
      const unused = [];
      const rarelyUsed = [];

      for (const f of KNOWN_FEATURES) {
        const evCount = featureCounts[f.id] || 0;
        const hasTransitions = transFeatures.has(f.id);
        const mainTable = f.dbTable.split(/[+(]/)[0].trim();
        const dbCount = tableCounts[mainTable] || 0;

        if (evCount === 0 && !hasTransitions) {
          unused.push({
            id: f.id,
            name: f.name,
            screen: f.screen,
            category: f.category,
            status: f.status,
            eventCount: 0,
            transitionFound: false,
            dbRecords: dbCount,
            assessment: dbCount > 0
              ? '기능과 데이터가 있지만 최근 사용 안 함 — 사용 교육 또는 기능 통합 필요'
              : '기능은 있지만 데이터도 없음 — 사용 안 하는 기능일 가능성',
          });
        } else if (evCount > 0 && evCount < 5) {
          rarelyUsed.push({
            id: f.id,
            name: f.name,
            screen: f.screen,
            category: f.category,
            eventCount: evCount,
            dailyAvg: Math.round((evCount / days) * 100) / 100,
            dbRecords: dbCount,
            assessment: '사용 빈도가 매우 낮음 — 특정 시기에만 사용하거나 다른 방법으로 대체 중',
          });
        }
      }

      res.json({
        ok: true,
        period: `${days}일`,
        summary: {
          totalFeatures: KNOWN_FEATURES.length,
          unusedCount: unused.length,
          rarelyUsedCount: rarelyUsed.length,
          activeCount: KNOWN_FEATURES.length - unused.length - rarelyUsed.length,
        },
        unused,
        rarelyUsed,
        recommendations: [
          ...(unused.filter(u => u.dbRecords > 0).length > 0
            ? ['데이터가 있지만 안 쓰는 기능 발견 — 직원 교육 또는 Orbit에 통합하여 접근성 향상']
            : []),
          ...(unused.filter(u => u.dbRecords === 0).length > 0
            ? ['데이터도 없는 기능 발견 — Orbit 마이그레이션 시 제외 가능']
            : []),
          ...(rarelyUsed.length > 0
            ? ['가끔 쓰는 기능은 Orbit에서 더 쉽게 접근 가능하도록 설계']
            : []),
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'unused-features');
    }
  });


  /**
   * GET /api/erp/manual-gaps
   * 전산에 없어서 수동으로 하는 업무 — Excel/수기 작업 분석
   * ?days=30
   */
  router.get('/manual-gaps', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // ── 1) Excel 관련 이벤트 조회 (windowTitle에서 Excel 파일명 추출) ──
      const excelEvents = await orbitDb.query(`
        SELECT
          user_id,
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          data_json->>'rawInput' AS raw_input,
          type,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            LOWER(data_json->>'windowTitle') LIKE '%excel%'
            OR LOWER(data_json->>'windowTitle') LIKE '%.xlsx%'
            OR LOWER(data_json->>'windowTitle') LIKE '%.xls%'
            OR LOWER(data_json->>'currentApp') LIKE '%excel%'
          )
        ORDER BY timestamp DESC
        LIMIT 5000
      `, [days]);

      // Excel 파일명별 집계
      const excelFiles = {};
      for (const e of excelEvents.rows) {
        const title = e.window_title || '';
        // Excel 파일명 추출 (보통 "파일명.xlsx - Excel" 형태)
        const match = title.match(/(.+?\.xlsx?)/i) || title.match(/(.+?)\s*[-–]\s*(?:Microsoft\s+)?Excel/i);
        const fileName = match ? match[1].trim() : title.replace(/\s*[-–]\s*(?:Microsoft\s+)?Excel.*$/i, '').trim();
        if (!fileName) continue;

        if (!excelFiles[fileName]) {
          excelFiles[fileName] = { count: 0, users: new Set(), types: new Set(), timestamps: [] };
        }
        excelFiles[fileName].count++;
        excelFiles[fileName].users.add(e.user_id);
        excelFiles[fileName].types.add(e.type);
        excelFiles[fileName].timestamps.push(e.timestamp);
      }

      // ── 2) 각 Excel 파일이 KNOWN_MANUAL_GAPS의 어디에 해당하는지 매칭 ──
      const detectedGaps = [];

      for (const gap of KNOWN_MANUAL_GAPS) {
        let matchedFiles = [];
        let totalEvents = 0;
        let users = new Set();

        for (const [fileName, data] of Object.entries(excelFiles)) {
          const lower = fileName.toLowerCase();
          for (const kw of gap.keywords) {
            if (lower.includes(kw.toLowerCase())) {
              matchedFiles.push({
                fileName,
                eventCount: data.count,
                users: [...data.users],
              });
              totalEvents += data.count;
              for (const u of data.users) users.add(u);
              break;
            }
          }
        }

        // 키워드 매칭 없으면 전체 이벤트에서 검색
        if (matchedFiles.length === 0) {
          const keywordEvents = await orbitDb.query(`
            SELECT COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS users
            FROM events
            WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
              AND (
                ${gap.keywords.map((_, i) => `LOWER(data_json->>'windowTitle') LIKE $${i + 2}`).join(' OR ')}
              )
          `, [days, ...gap.keywords.map(k => `%${k.toLowerCase()}%`)]).catch(() => ({ rows: [{ cnt: 0, users: 0 }] }));

          if (parseInt(keywordEvents.rows[0].cnt) > 0) {
            totalEvents = parseInt(keywordEvents.rows[0].cnt);
          }
        }

        detectedGaps.push({
          id: gap.id,
          process: gap.process,
          manualTool: gap.manualTool,
          description: gap.description,
          estimatedMinutesPerDay: gap.estimatedMinutes,
          frequency: gap.frequency,
          nenovaHas: gap.nenovaHas,
          relatedDbTables: gap.relatedDbTables,
          // 실제 관측 데이터
          detected: {
            matchedExcelFiles: matchedFiles,
            totalEvents,
            uniqueUsers: users.size > 0 ? users.size : parseInt(totalEvents > 0 ? 1 : 0),
          },
          // 분석
          assessment: gap.nenovaHas
            ? '전산에 기능이 있지만 Excel을 병행 → UX 문제 (전산 기능이 불편하거나 양식이 안 맞음)'
            : '전산에 기능 자체가 없음 → Orbit에서 신규 개발 필요',
          orbitAction: gap.nenovaHas
            ? `Orbit에서 ${gap.relatedDbTables.join(',')} 데이터를 원하는 양식으로 자동 제공`
            : `Orbit에서 신규 기능 개발 (${gap.relatedDbTables.length > 0 ? gap.relatedDbTables.join(',') + ' 활용' : '별도 DB 필요'})`,
        });
      }

      // ── 3) 매칭 안 된 Excel 파일 (미지의 수동 업무) ──
      const matchedFileNames = new Set();
      for (const gap of detectedGaps) {
        for (const f of gap.detected.matchedExcelFiles) {
          matchedFileNames.add(f.fileName);
        }
      }

      const unknownExcelWork = Object.entries(excelFiles)
        .filter(([name]) => !matchedFileNames.has(name))
        .map(([name, data]) => ({
          fileName: name,
          eventCount: data.count,
          users: [...data.users],
          eventTypes: [...data.types],
          note: '분류 미완료 — 수동 업무일 수 있음',
        }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, 20);

      // 총 수동 작업 시간 추정
      const totalManualMinutes = detectedGaps.reduce((sum, g) => sum + g.estimatedMinutesPerDay, 0);

      res.json({
        ok: true,
        period: `${days}일`,
        summary: {
          knownGaps: detectedGaps.length,
          gapsWithData: detectedGaps.filter(g => g.detected.totalEvents > 0).length,
          gapsNenovaHas: detectedGaps.filter(g => g.nenovaHas).length,
          gapsMissing: detectedGaps.filter(g => !g.nenovaHas).length,
          totalExcelFiles: Object.keys(excelFiles).length,
          unknownExcelFiles: unknownExcelWork.length,
          estimatedDailyManualMinutes: totalManualMinutes,
          estimatedDailyManualHours: Math.round(totalManualMinutes / 60 * 10) / 10,
        },
        gaps: detectedGaps,
        unknownExcelWork,
        topInsights: [
          `일 추정 ${Math.round(totalManualMinutes / 60 * 10) / 10}시간 수동 작업 발견`,
          `전산에 있는데 Excel 병행: ${detectedGaps.filter(g => g.nenovaHas).map(g => g.process).join(', ')}`,
          `전산에 기능 자체 없음: ${detectedGaps.filter(g => !g.nenovaHas).map(g => g.process).join(', ')}`,
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'manual-gaps');
    }
  });


  /**
   * GET /api/erp/data-vs-screen
   * 캡처 화면 데이터 vs DB 실제 데이터 대조
   * Vision이 학습한 화면의 데이터와 nenova DB 실제 데이터 비교
   */
  router.get('/data-vs-screen', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // ── 1) Vision에서 학습한 nenova 화면 목록 ──
      const visionScreens = await orbitDb.query(`
        SELECT
          screen_name,
          COUNT(*) AS element_count,
          SUM(seen_count) AS total_interactions,
          AVG(confidence) AS avg_confidence,
          array_agg(DISTINCT element_type) AS element_types
        FROM ui_elements
        WHERE app_name ILIKE '%nenova%' OR app_name ILIKE '%화훼%' OR app_name ILIKE '%네노바%'
        GROUP BY screen_name
        ORDER BY element_count DESC
      `).catch(() => ({ rows: [] }));

      // ── 2) screen.analyzed 이벤트에서 화면별 분석 데이터 ──
      const analyzedScreens = await orbitDb.query(`
        SELECT
          data_json->>'screenName' AS screen_name,
          data_json->>'appName' AS app_name,
          data_json->>'analysis' AS analysis,
          data_json->'elements' AS elements,
          timestamp
        FROM events
        WHERE type = 'screen.analyzed'
          AND (
            data_json->>'appName' ILIKE '%nenova%'
            OR data_json->>'appName' ILIKE '%화훼%'
            OR data_json->>'appName' ILIKE '%네노바%'
          )
        ORDER BY timestamp DESC
        LIMIT 100
      `).catch(() => ({ rows: [] }));

      // ── 3) nenova DB 실제 데이터 현황 ──
      let dbStatus = {};
      try {
        const tableCounts = await getNenovaTableCounts();
        const recentActivity = await getNenovaRecentActivity(7);

        dbStatus = {
          tables: tableCounts,
          recent7days: recentActivity,
          connected: true,
        };
      } catch (e) {
        dbStatus = { connected: false, error: e.message };
      }

      // ── 4) 대조 결과 ──
      const comparisons = KNOWN_FEATURES.map(f => {
        // 이 기능에 대한 Vision 학습 데이터
        const matchedScreens = visionScreens.rows.filter(s => {
          const kws = SCREEN_KEYWORD_MAP[f.id] || [];
          return kws.some(kw => s.screen_name.toLowerCase().includes(kw.toLowerCase()));
        });

        const visionElementCount = matchedScreens.reduce((sum, s) => sum + parseInt(s.element_count || 0), 0);
        const visionInteractions = matchedScreens.reduce((sum, s) => sum + parseInt(s.total_interactions || 0), 0);

        // DB 데이터
        const mainTable = f.dbTable.split(/[+(]/)[0].trim();
        const dbCount = dbStatus.tables?.[mainTable] || 0;

        // 상태 판단
        let syncStatus;
        if (visionElementCount > 0 && dbCount > 0) {
          syncStatus = 'both_have_data';
        } else if (visionElementCount > 0 && dbCount === 0) {
          syncStatus = 'screen_only';
        } else if (visionElementCount === 0 && dbCount > 0) {
          syncStatus = 'db_only';
        } else {
          syncStatus = 'no_data';
        }

        return {
          feature: f.name,
          featureId: f.id,
          dbTable: f.dbTable,
          // Vision 측
          visionData: {
            learnedElements: visionElementCount,
            totalInteractions: visionInteractions,
            screensMatched: matchedScreens.length,
            screenNames: matchedScreens.map(s => s.screen_name),
          },
          // DB 측
          dbData: {
            recordCount: dbCount,
            tableName: mainTable,
          },
          // 대조 결과
          syncStatus,
          assessment: syncStatus === 'both_have_data'
            ? 'Vision 화면과 DB 데이터 모두 확인됨 — 정상'
            : syncStatus === 'screen_only'
            ? 'Vision이 화면을 학습했지만 DB에 데이터 없음 — 테이블명 확인 필요'
            : syncStatus === 'db_only'
            ? 'DB에 데이터가 있지만 Vision이 화면을 학습하지 않음 — 캡처 추가 필요'
            : '데이터 없음 — 사용하지 않는 기능이거나 학습 미완료',
        };
      });

      res.json({
        ok: true,
        summary: {
          totalFeatures: comparisons.length,
          bothHaveData: comparisons.filter(c => c.syncStatus === 'both_have_data').length,
          screenOnly: comparisons.filter(c => c.syncStatus === 'screen_only').length,
          dbOnly: comparisons.filter(c => c.syncStatus === 'db_only').length,
          noData: comparisons.filter(c => c.syncStatus === 'no_data').length,
          visionTotalScreens: visionScreens.rows.length,
          analyzedScreenEvents: analyzedScreens.rows.length,
          nenovaDbConnected: dbStatus.connected,
        },
        comparisons,
        visionScreenList: visionScreens.rows.map(s => ({
          screenName: s.screen_name,
          elementCount: parseInt(s.element_count) || 0,
          interactions: parseInt(s.total_interactions) || 0,
          confidence: Math.round(parseFloat(s.avg_confidence || 0) * 100) / 100,
          elementTypes: s.element_types,
        })),
        dbStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'data-vs-screen');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     2. Orbit OS 통합 계획
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/erp/orbit-migration
   * 전산 → Orbit OS 마이그레이션 계획
   * 각 기능별 이전 준비 상태, 난이도, 선행 조건 평가
   */
  router.get('/orbit-migration', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // 기능별 사용 빈도 조회
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          user_id,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '30 days')::TEXT
          AND (data_json->>'windowTitle' IS NOT NULL OR data_json->>'currentApp' IS NOT NULL)
        LIMIT 20000
      `);

      const featureUsage = {};
      for (const e of events.rows) {
        const fid = matchFeature(e.window_title || e.current_app || '');
        if (fid && fid !== 'nenova_general') {
          if (!featureUsage[fid]) featureUsage[fid] = { count: 0, users: new Set() };
          featureUsage[fid].count++;
          featureUsage[fid].users.add(e.user_id);
        }
      }

      // nenova DB 데이터 현황
      let recentActivity = { orders: {}, shipments: {}, estimates: {} };
      try {
        recentActivity = await getNenovaRecentActivity(30);
      } catch (_) {}

      // Orbit API 준비 상태 체크 (실제 라우트 존재 여부)
      const ORBIT_API_STATUS = {
        order_entry:      { api: '/api/nenova/orders',            readReady: true,  writeReady: false, webUI: false },
        order_mgmt:       { api: '/api/nenova/orders',            readReady: true,  writeReady: false, webUI: false },
        shipment_dist:    { api: '/api/nenova/shipments',         readReady: true,  writeReady: false, webUI: false },
        shipment_query:   { api: '/api/nenova/shipments',         readReady: true,  writeReady: false, webUI: false },
        shipment_history: { api: '/api/nenova/shipments',         readReady: true,  writeReady: false, webUI: false },
        inventory:        { api: '/api/nenova/products/stock',    readReady: true,  writeReady: false, webUI: false },
        purchase:         { api: '/api/nenova/orders',            readReady: true,  writeReady: false, webUI: false },
        receiving:        { api: null,                            readReady: false, writeReady: false, webUI: false },
        estimate:         { api: '/api/nenova/estimates',         readReady: true,  writeReady: false, webUI: false },
        pivot:            { api: '/api/nenova/orders/pivot',      readReady: true,  writeReady: false, webUI: false },
        monthly_sales:    { api: '/api/nenova/analysis/sales',    readReady: true,  writeReady: false, webUI: false },
        customer_mgmt:    { api: '/api/nenova/customers',         readReady: true,  writeReady: false, webUI: false },
        user_mgmt:        { api: null,                            readReady: false, writeReady: false, webUI: false },
        product_mgmt:     { api: '/api/nenova/products',          readReady: true,  writeReady: false, webUI: false },
        code_mgmt:        { api: null,                            readReady: false, writeReady: false, webUI: false },
        region_sales:     { api: '/api/nenova/analysis/sales',    readReady: true,  writeReady: false, webUI: false },
        sales_analysis:   { api: '/api/nenova/analysis/sales',    readReady: true,  writeReady: false, webUI: false },
        salesperson:      { api: null,                            readReady: false, writeReady: false, webUI: false },
        cust_prod_cost:   { api: '/api/nenova/customers/:key/products', readReady: true, writeReady: false, webUI: false },
      };

      // 마이그레이션 계획 생성
      const migrationPlan = KNOWN_FEATURES.map(f => {
        const usage = featureUsage[f.id] || { count: 0, users: new Set() };
        const orbit = ORBIT_API_STATUS[f.id] || { readReady: false, writeReady: false, webUI: false };
        const dailyAvg = Math.round((usage.count / 30) * 10) / 10;

        // 난이도 평가
        let difficulty;
        if (orbit.readReady && !orbit.writeReady) {
          difficulty = 'medium'; // API 읽기 가능, 쓰기 + UI 필요
        } else if (orbit.readReady && orbit.writeReady) {
          difficulty = 'easy'; // API 모두 준비, UI만 필요
        } else {
          difficulty = 'hard'; // API부터 개발 필요
        }

        // 선행 조건
        const prerequisites = [];
        if (!orbit.readReady) prerequisites.push('nenova DB 읽기 API 개발');
        if (!orbit.writeReady) prerequisites.push('nenova DB 쓰기 권한 또는 Orbit 자체 DB 저장');
        if (!orbit.webUI) prerequisites.push('웹 UI 개발 (입력 폼 + 목록 뷰)');
        if (f.id === 'order_entry') prerequisites.push('ProdKey 자동완성 UI', '거래처 선택 컴포넌트');
        if (f.id === 'shipment_dist') prerequisites.push('분배 알고리즘 구현');
        if (f.id === 'pivot') prerequisites.push('피벗 테이블 웹 컴포넌트');

        // 자동화 준비도
        let automationReadiness;
        if (orbit.readReady && usage.count > 50) {
          automationReadiness = 'high'; // 데이터 접근 가능 + 사용 빈도 높음
        } else if (orbit.readReady) {
          automationReadiness = 'medium';
        } else {
          automationReadiness = 'low';
        }

        // 예상 시간 절약
        const minutesPerUse = f.id === 'order_entry' ? 2 :
                              f.id === 'shipment_dist' ? 3 :
                              f.id === 'estimate' ? 5 :
                              f.id === 'inventory' ? 1 :
                              f.id === 'pivot' ? 2 : 1;
        const dailySavingsMinutes = dailyAvg * minutesPerUse * 0.7; // 70% 자동화 가정
        const dailySavingsHours = Math.round(dailySavingsMinutes / 60 * 10) / 10;

        return {
          feature: f.name,
          featureId: f.id,
          category: f.category,
          // 현재 상태
          nenovaStatus: usage.count > 0
            ? `active (${dailyAvg > 0 ? '일 ' + dailyAvg + '회' : '사용 중'})`
            : (f.status === 'unknown' ? 'unknown' : 'dormant'),
          // Orbit 준비 상태
          orbitStatus: {
            api: orbit.api,
            readReady: orbit.readReady,
            writeReady: orbit.writeReady,
            webUI: orbit.webUI,
          },
          // 마이그레이션 평가
          migration: {
            difficulty,
            prerequisites,
            automationReadiness,
            dataReady: orbit.readReady,
            estimatedDailySavingsHours: dailySavingsHours,
          },
          // 사용 통계
          usage: {
            last30days: usage.count,
            dailyAvg,
            uniqueUsers: usage.users.size,
          },
        };
      });

      // 우선순위 정렬: 사용 빈도 높고 + 자동화 쉬운 것 먼저
      migrationPlan.sort((a, b) => {
        const scoreA = a.usage.last30days * (a.migration.difficulty === 'easy' ? 3 : a.migration.difficulty === 'medium' ? 2 : 1);
        const scoreB = b.usage.last30days * (b.migration.difficulty === 'easy' ? 3 : b.migration.difficulty === 'medium' ? 2 : 1);
        return scoreB - scoreA;
      });

      // 전체 절약 가능 시간
      const totalDailySavings = migrationPlan.reduce((sum, p) => sum + p.migration.estimatedDailySavingsHours, 0);

      res.json({
        ok: true,
        summary: {
          totalFeatures: migrationPlan.length,
          readyToMigrate: migrationPlan.filter(p => p.orbitStatus.readReady).length,
          needsApiDev: migrationPlan.filter(p => !p.orbitStatus.readReady).length,
          activeInNenova: migrationPlan.filter(p => p.usage.last30days > 0).length,
          estimatedTotalDailySavingsHours: Math.round(totalDailySavings * 10) / 10,
        },
        plan: migrationPlan,
        phases: [
          {
            phase: 1,
            name: '조회 기능 Orbit 이전 (읽기만)',
            features: migrationPlan.filter(p => p.orbitStatus.readReady && p.usage.last30days > 0).map(p => p.feature),
            effort: '웹 UI 개발만 필요',
            timeline: '2~4주',
          },
          {
            phase: 2,
            name: '입력 기능 Orbit 이전 (쓰기 포함)',
            features: ['신규 주문 등록', '출고 분배', '견적서 관리'],
            effort: 'nenova DB 쓰기 권한 + 입력 폼 UI',
            timeline: '4~8주',
            blocker: 'nenova DB 쓰기 권한 필요',
          },
          {
            phase: 3,
            name: '전산 완전 대체',
            features: ['전체 기능'],
            effort: '미구현 API + 모든 웹 UI + 기존 데이터 마이그레이션',
            timeline: '3~6개월',
          },
        ],
        nenovaActivity: recentActivity,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'orbit-migration');
    }
  });


  /**
   * GET /api/erp/feature-priority
   * Orbit OS에 먼저 구현할 기능 우선순위
   * Score = 사용빈도 x 수동작업시간 x 자동화가능성
   */
  router.get('/feature-priority', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // 기능별 사용 빈도
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          user_id
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '30 days')::TEXT
          AND (data_json->>'windowTitle' IS NOT NULL OR data_json->>'currentApp' IS NOT NULL)
        LIMIT 20000
      `);

      const featureUsage = {};
      for (const e of events.rows) {
        const fid = matchFeature(e.window_title || e.current_app || '');
        if (fid && fid !== 'nenova_general') {
          if (!featureUsage[fid]) featureUsage[fid] = { count: 0, users: new Set() };
          featureUsage[fid].count++;
          featureUsage[fid].users.add(e.user_id);
        }
      }

      // nenova DB 활동 데이터 (최근 30일)
      let nenovaDaily = {};
      try {
        const activity = await getNenovaRecentActivity(30);
        nenovaDaily = {
          order_entry: Math.round((activity.orders.cnt || 0) / 30),
          shipment_dist: Math.round((activity.shipments.cnt || 0) / 30),
          estimate: Math.round((activity.estimates.cnt || 0) / 30),
        };
      } catch (_) {}

      // 각 기능의 우선순위 스코어 계산
      const priorities = KNOWN_FEATURES.map(f => {
        const usage = featureUsage[f.id] || { count: 0, users: new Set() };
        const dailyUsage = Math.round((usage.count / 30) * 10) / 10;

        // 수동 작업 시간 (건당 분)
        const minutesPerUse = {
          order_entry: 2, order_mgmt: 1, shipment_dist: 3, shipment_query: 1,
          shipment_history: 0.5, inventory: 1, purchase: 3, receiving: 2,
          estimate: 5, pivot: 2, monthly_sales: 3, customer_mgmt: 2,
          user_mgmt: 1, product_mgmt: 2, code_mgmt: 1, region_sales: 3,
          sales_analysis: 3, salesperson: 2, cust_prod_cost: 2,
        }[f.id] || 1;

        // 자동화 가능성 (0~1)
        const automationPotential = {
          order_entry: 0.85, order_mgmt: 0.60, shipment_dist: 0.70, shipment_query: 0.90,
          shipment_history: 0.95, inventory: 0.80, purchase: 0.65, receiving: 0.60,
          estimate: 0.50, pivot: 0.95, monthly_sales: 0.95, customer_mgmt: 0.40,
          user_mgmt: 0.30, product_mgmt: 0.40, code_mgmt: 0.30, region_sales: 0.90,
          sales_analysis: 0.90, salesperson: 0.85, cust_prod_cost: 0.50,
        }[f.id] || 0.50;

        // DB에서 확인된 일 평균 (nenova DB 기준)
        const nenovaDailyCount = nenovaDaily[f.id] || 0;
        const effectiveDailyUsage = Math.max(dailyUsage, nenovaDailyCount);

        // 스코어 = 사용빈도 x 건당 시간 x 자동화 가능성
        const dailyManualMinutes = effectiveDailyUsage * minutesPerUse;
        const savableMinutes = dailyManualMinutes * automationPotential;
        const score = Math.round(savableMinutes * 100) / 100;

        return {
          rank: 0, // 나중에 설정
          featureId: f.id,
          name: f.name,
          category: f.category,
          // 지표
          metrics: {
            dailyUsage: effectiveDailyUsage,
            nenovaDailyInserts: nenovaDailyCount,
            minutesPerUse,
            automationPotential: `${Math.round(automationPotential * 100)}%`,
            dailyManualMinutes: Math.round(dailyManualMinutes * 10) / 10,
            savableMinutesPerDay: Math.round(savableMinutes * 10) / 10,
          },
          score,
          // Orbit 상태
          orbitApiReady: f.id !== 'receiving' && f.id !== 'user_mgmt' &&
                         f.id !== 'code_mgmt' && f.id !== 'salesperson',
          // 권장 사항
          recommendation:
            score > 50 ? '즉시 구현 권장 — ROI 최대'
            : score > 20 ? '조기 구현 권장 — 시간 절약 효과 큼'
            : score > 5 ? '중기 구현 — 여유 있을 때'
            : '하위 우선순위 — 사용 빈도 낮음',
        };
      });

      // 스코어 순 정렬 + 순위 부여
      priorities.sort((a, b) => b.score - a.score);
      priorities.forEach((p, i) => { p.rank = i + 1; });

      // 수동 갭도 포함 (기존 기능 외에 신규 필요 기능)
      const manualGapPriorities = KNOWN_MANUAL_GAPS
        .filter(g => !g.nenovaHas) // 전산에 없는 것만
        .map(g => ({
          rank: 0,
          featureId: g.id,
          name: g.process,
          category: '신규 개발',
          metrics: {
            dailyUsage: 1,
            minutesPerUse: g.estimatedMinutes,
            automationPotential: '80%',
            dailyManualMinutes: g.estimatedMinutes,
            savableMinutesPerDay: g.estimatedMinutes * 0.8,
          },
          score: g.estimatedMinutes * 0.8,
          orbitApiReady: false,
          recommendation: '전산에 없는 기능 — Orbit에서 신규 개발 필요',
        }));

      // 통합 정렬
      const allPriorities = [...priorities, ...manualGapPriorities]
        .sort((a, b) => b.score - a.score);
      allPriorities.forEach((p, i) => { p.rank = i + 1; });

      const totalSavableMinutes = allPriorities.reduce((sum, p) => sum + (p.metrics.savableMinutesPerDay || 0), 0);

      res.json({
        ok: true,
        summary: {
          totalFeaturesRanked: allPriorities.length,
          topPriority: allPriorities[0]?.name || 'N/A',
          totalSavableMinutesPerDay: Math.round(totalSavableMinutes),
          totalSavableHoursPerDay: Math.round(totalSavableMinutes / 60 * 10) / 10,
          immediateActionItems: allPriorities.filter(p => p.score > 50).length,
          earlyActionItems: allPriorities.filter(p => p.score > 20 && p.score <= 50).length,
        },
        priorities: allPriorities,
        scoringFormula: 'score = dailyUsage x minutesPerUse x automationPotential',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'feature-priority');
    }
  });


  /**
   * GET /api/erp/automation-gaps
   * 전산과 연동 안 되서 수작업인 부분 — 가장 실행 가능한 산출물
   */
  router.get('/automation-gaps', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // transition_model에서 nenova ↔ 다른 앱 전환 패턴 조회
      const transitions = await orbitDb.query(`
        SELECT from_state, to_state, count, probability, avg_seconds
        FROM transition_model
        WHERE count > 2
        ORDER BY count DESC
        LIMIT 300
      `).catch(() => ({ rows: [] }));

      // nenova 관련 전환 패턴 분석
      const nenovaTransitions = [];
      for (const t of transitions.rows) {
        const fromNenova = (t.from_state || '').toLowerCase().includes('nenova') ||
                           (t.from_state || '').toLowerCase().includes('화훼');
        const toNenova = (t.to_state || '').toLowerCase().includes('nenova') ||
                         (t.to_state || '').toLowerCase().includes('화훼');
        const toExcel = (t.to_state || '').toLowerCase().includes('excel');
        const fromExcel = (t.from_state || '').toLowerCase().includes('excel');
        const toKakao = (t.to_state || '').toLowerCase().includes('kakao');
        const fromKakao = (t.from_state || '').toLowerCase().includes('kakao');

        if (fromNenova || toNenova) {
          nenovaTransitions.push({
            from: t.from_state,
            to: t.to_state,
            count: t.count,
            probability: Math.round(t.probability * 100) / 100,
            avgSeconds: Math.round(t.avg_seconds || 0),
            pattern:
              (fromNenova && toExcel) ? 'nenova→Excel (데이터 내보내기/수작업)'
              : (fromExcel && toNenova) ? 'Excel→nenova (데이터 입력)'
              : (fromKakao && toNenova) ? 'KakaoTalk→nenova (주문 입력)'
              : (fromNenova && toKakao) ? 'nenova→KakaoTalk (확인/알림)'
              : (fromNenova && !toNenova) ? `nenova→${t.to_state} (데이터 이동)`
              : (!fromNenova && toNenova) ? `${t.from_state}→nenova (데이터 입력)`
              : 'nenova 내부 전환',
          });
        }
      }

      // 자동화 갭 + 실제 전이 데이터 결합
      const enrichedGaps = AUTOMATION_GAPS.map(gap => {
        // 이 갭과 관련된 전이 패턴 찾기
        const relatedTransitions = nenovaTransitions.filter(t => {
          const lower = `${t.from} ${t.to}`.toLowerCase();
          if (gap.process.includes('카톡') && lower.includes('kakao')) return true;
          if (gap.process.includes('차감') && lower.includes('excel')) return true;
          if (gap.process.includes('물량표') && lower.includes('excel')) return true;
          if (gap.process.includes('매출') && lower.includes('excel')) return true;
          if (gap.process.includes('발주') && lower.includes('excel')) return true;
          return false;
        });

        const transitionCount = relatedTransitions.reduce((sum, t) => sum + (t.count || 0), 0);
        const avgTransitionSeconds = relatedTransitions.length > 0
          ? Math.round(relatedTransitions.reduce((sum, t) => sum + t.avgSeconds, 0) / relatedTransitions.length)
          : 0;

        return {
          ...gap,
          // 실제 관측 데이터
          observed: {
            relatedTransitions: relatedTransitions.length,
            totalTransitionCount: transitionCount,
            avgTransitionSeconds,
            topTransitions: relatedTransitions.slice(0, 5),
          },
          // ROI 계산
          roi: {
            dailySavingsMinutes: gap.dailySavings,
            dailySavingsHours: Math.round(gap.dailySavings / 60 * 10) / 10,
            monthlySavingsHours: Math.round(gap.dailySavings * 22 / 60 * 10) / 10, // 22 영업일
            readiness: `${gap.readiness}%`,
            estimatedDevDays: gap.readiness > 80 ? '3~5일' :
                              gap.readiness > 50 ? '1~2주' :
                              gap.readiness > 30 ? '2~4주' : '1~2개월',
          },
        };
      });

      // 우선순위 순 정렬 (priority 필드)
      enrichedGaps.sort((a, b) => a.priority - b.priority);

      const totalDailySavings = enrichedGaps.reduce((sum, g) => sum + g.dailySavings, 0);
      const immediateGaps = enrichedGaps.filter(g => g.readiness >= 80);

      res.json({
        ok: true,
        summary: {
          totalGaps: enrichedGaps.length,
          immediatelyActionable: immediateGaps.length,
          totalDailySavingsMinutes: totalDailySavings,
          totalDailySavingsHours: Math.round(totalDailySavings / 60 * 10) / 10,
          totalMonthlySavingsHours: Math.round(totalDailySavings * 22 / 60),
          nenovaTransitionsFound: nenovaTransitions.length,
        },
        gaps: enrichedGaps,
        // nenova 전환 패턴 전체 (디버그/분석용)
        nenovaTransitionPatterns: nenovaTransitions.slice(0, 30),
        quickWins: immediateGaps.map(g => ({
          process: g.process,
          solution: g.orbitSolution,
          readiness: `${g.readiness}%`,
          blocker: g.blocker,
          dailySavings: `${g.dailySavings}분`,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'automation-gaps');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     3. 실시간 대조
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/erp/live-comparison
   * 지금 직원이 전산에서 하는 작업 vs DB 변화 실시간 대조
   * ?minutes=60
   */
  router.get('/live-comparison', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const minutes = Math.min(parseInt(req.query.minutes) || 60, 480);

      // ── 1) Orbit events: 최근 N분간 nenova 관련 이벤트 ──
      const recentEvents = await orbitDb.query(`
        SELECT
          user_id,
          type,
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          data_json->>'rawInput' AS raw_input,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 minute' * $1)::TEXT
          AND (
            data_json->>'windowTitle' IS NOT NULL
            OR data_json->>'currentApp' IS NOT NULL
          )
        ORDER BY timestamp DESC
        LIMIT 1000
      `, [minutes]);

      // nenova 관련 이벤트만 필터
      const nenovaEvents = [];
      const userActivity = {};

      for (const e of recentEvents.rows) {
        const title = e.window_title || e.current_app || '';
        const featureId = matchFeature(title);
        if (!featureId) continue;

        nenovaEvents.push({
          userId: e.user_id,
          feature: featureId,
          windowTitle: title,
          type: e.type,
          hasInput: !!e.raw_input,
          timestamp: e.timestamp,
        });

        // 직원별 최근 활동
        if (!userActivity[e.user_id]) {
          userActivity[e.user_id] = {
            lastFeature: featureId,
            lastTitle: title,
            lastSeen: e.timestamp,
            eventCount: 0,
            features: new Set(),
          };
        }
        userActivity[e.user_id].eventCount++;
        userActivity[e.user_id].features.add(featureId);
      }

      // ── 2) nenova DB: 최근 변화 감지 ──
      let dbChanges = {};
      try {
        dbChanges = await safeQuery(async (pool) => {
          // KeyNumbering으로 최근 키 번호 변화 추적
          const keyNumbers = await pool.request().query(`
            SELECT Category, LastKeyNo
            FROM KeyNumbering
          `).catch(() => ({ recordset: [] }));

          // 오늘 생성된 주문
          const todayOrders = await pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              MAX(OrderMasterKey) AS lastKey,
              MAX(CreateDtm) AS lastCreate,
              COUNT(DISTINCT CustKey) AS customers,
              COUNT(DISTINCT CreateID) AS creators
            FROM OrderMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE)
          `);

          // 오늘 생성된 주문 디테일
          const todayDetails = await pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              MAX(OrderDetailKey) AS lastKey
            FROM OrderDetail
            WHERE ISNULL(isDeleted, 0) = 0
              AND CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE)
          `);

          // 오늘 생성된 출하
          const todayShipments = await pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              MAX(ShipmentMasterKey) AS lastKey,
              MAX(CreateDtm) AS lastCreate
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE)
          `);

          // 최근 1시간 내 변동 (ModifyDtm 기반)
          const recentModifications = await pool.request().query(`
            SELECT 'OrderMaster' AS tableName, COUNT(*) AS cnt
            FROM OrderMaster
            WHERE ModifyDtm >= DATEADD(MINUTE, -${minutes}, GETDATE())
            UNION ALL
            SELECT 'OrderDetail', COUNT(*)
            FROM OrderDetail
            WHERE ModifyDtm >= DATEADD(MINUTE, -${minutes}, GETDATE())
            UNION ALL
            SELECT 'ShipmentMaster', COUNT(*)
            FROM ShipmentMaster
            WHERE ModifyDtm >= DATEADD(MINUTE, -${minutes}, GETDATE())
            UNION ALL
            SELECT 'ShipmentDetail', COUNT(*)
            FROM ShipmentDetail
            WHERE ModifyDtm >= DATEADD(MINUTE, -${minutes}, GETDATE())
          `).catch(() => ({ recordset: [] }));

          return {
            keyNumbers: keyNumbers.recordset,
            todayOrders: todayOrders.recordset[0],
            todayDetails: todayDetails.recordset[0],
            todayShipments: todayShipments.recordset[0],
            recentModifications: recentModifications.recordset,
          };
        });
      } catch (e) {
        dbChanges = { error: e.message };
      }

      // ── 3) 대조 결과 — 직원 행동 vs DB 변화 매칭 ──
      const correlations = [];

      // 주문 등록 화면 사용 vs OrderDetail INSERT
      const orderEntryUsers = Object.entries(userActivity)
        .filter(([_, a]) => a.features.has('order_entry'))
        .map(([uid, a]) => ({ userId: uid, lastSeen: a.lastSeen, events: a.eventCount }));

      if (orderEntryUsers.length > 0 && dbChanges.todayOrders) {
        correlations.push({
          type: 'order_entry',
          description: '주문 등록 화면 사용 vs DB 주문 생성',
          screenActivity: orderEntryUsers,
          dbActivity: {
            todayOrderCount: dbChanges.todayOrders.cnt,
            todayDetailCount: dbChanges.todayDetails?.cnt || 0,
            lastOrderKey: dbChanges.todayOrders.lastKey,
            lastCreate: dbChanges.todayOrders.lastCreate,
          },
          correlation: orderEntryUsers.length > 0 && dbChanges.todayOrders.cnt > 0
            ? '일치 — 화면 사용과 DB INSERT가 같은 시간대에 발생'
            : '불일치 — 화면은 사용 중이지만 DB 변화 미감지 (아직 저장 안 한 상태일 수 있음)',
        });
      }

      // 출고 관련 화면 vs ShipmentMaster
      const shipmentUsers = Object.entries(userActivity)
        .filter(([_, a]) => a.features.has('shipment_dist') || a.features.has('shipment_query'))
        .map(([uid, a]) => ({ userId: uid, lastSeen: a.lastSeen }));

      if (shipmentUsers.length > 0 && dbChanges.todayShipments) {
        correlations.push({
          type: 'shipment',
          description: '출고 화면 사용 vs DB 출하 생성',
          screenActivity: shipmentUsers,
          dbActivity: {
            todayShipmentCount: dbChanges.todayShipments.cnt,
            lastCreate: dbChanges.todayShipments.lastCreate,
          },
          correlation: dbChanges.todayShipments.cnt > 0
            ? '일치 — 출고 작업 확인됨'
            : '미확인 — 출고 화면 조회만 한 상태일 수 있음',
        });
      }

      res.json({
        ok: true,
        period: `최근 ${minutes}분`,
        summary: {
          totalRecentEvents: recentEvents.rows.length,
          nenovaRelatedEvents: nenovaEvents.length,
          activeUsers: Object.keys(userActivity).length,
          dbChangesDetected: !dbChanges.error,
          correlationsFound: correlations.length,
        },
        // 직원별 현재 활동
        userActivity: Object.entries(userActivity).map(([uid, a]) => ({
          userId: uid,
          currentFeature: a.lastFeature,
          currentWindow: a.lastTitle,
          lastSeen: a.lastSeen,
          eventCount: a.eventCount,
          featuresUsed: [...a.features],
        })),
        // DB 변화
        dbChanges: dbChanges.error ? { error: dbChanges.error } : {
          todayOrders: dbChanges.todayOrders,
          todayOrderDetails: dbChanges.todayDetails,
          todayShipments: dbChanges.todayShipments,
          recentModifications: dbChanges.recentModifications,
          keyNumbers: dbChanges.keyNumbers?.slice(0, 10),
        },
        // 화면 활동 vs DB 변화 대조
        correlations,
        // 최근 nenova 이벤트 (타임라인)
        recentTimeline: nenovaEvents.slice(0, 30),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'live-comparison');
    }
  });


  // ── 라우터 반환 ──
  return router;
};
