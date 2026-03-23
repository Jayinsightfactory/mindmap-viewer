'use strict';
/**
 * routes/data-digitizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터 디지타이저 에이전트 — 비구조화 데이터를 발견하고 디지털화 방안을 제안
 *
 * 문제 해결:
 *   회사에는 데이터가 곳곳에 흩어져 있다:
 *   - 직원 머릿속 (기록되지 않은 노하우)
 *   - 카카오톡 대화 (주문, 의사결정, 클레임)
 *   - PC에 흩어진 엑셀 파일들
 *   - 종이/화이트보드 메모
 *   - 구두 합의
 *   - 이메일 스레드
 *   - 전화 통화
 *
 *   이 에이전트는 볼 수 있는 것을 스캔하고, 없는 것을 식별한다.
 *
 * ⚠️ 절대 규칙: nenova SQL Server에는 SELECT만 실행한다.
 *
 * 엔드포인트:
 *   GET  /api/digitize/scan              — 전체 데이터 소스 스캔 (구조화 vs 비구조화)
 *   GET  /api/digitize/gaps              — 데이터 갭 식별 (있어야 하는데 없는 것)
 *   GET  /api/digitize/opportunities     — 원시 데이터 활용 기회
 *   GET  /api/digitize/recommendations   — 디지털화 구체 액션
 *   GET  /api/digitize/progress          — 디지털화 진행률 추적
 *   POST /api/digitize/classify-source   — 수동 데이터 소스 분류 등록
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
  console.warn('[data-digitizer] mssql 패키지 미설치 — npm install mssql 필요');
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
      console.log('[data-digitizer] SQL Server 연결 성공');
      _pool.on('error', (err) => {
        console.error('[data-digitizer] 풀 에러:', err.message);
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
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createDataDigitizerRouter({ getDb }) {
  const router = express.Router();

  // ── Orbit PostgreSQL 헬퍼 ──
  function getOrbitDb() {
    const db = getDb();
    if (!db || !db.query) throw new Error('Orbit PostgreSQL DB를 사용할 수 없습니다');
    return db;
  }

  // ── 공통 에러 핸들러 ──
  function handleError(res, err, context) {
    console.error(`[data-digitizer] ${context}:`, err.message);
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

  // ── 안전한 카운트 쿼리 (테이블 없을 수 있으므로) ──
  async function safeCount(db, query, params = []) {
    try {
      const result = await db.query(query, params);
      return parseInt(result.rows[0]?.count || result.rows[0]?.cnt || 0);
    } catch {
      return 0;
    }
  }

  // ── nenova 안전 카운트 ──
  async function nenovaSafeCount(queryStr) {
    try {
      const result = await safeQuery(async (pool) => {
        return pool.request().query(queryStr);
      });
      return parseInt(result.recordset?.[0]?.cnt || 0);
    } catch {
      return 0;
    }
  }

  // ── 디지타이저 테이블 초기화 ──
  async function ensureDigitizerTables() {
    const db = getOrbitDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS digitize_sources (
        id SERIAL PRIMARY KEY,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT DEFAULT 'identified',
        data_format TEXT,
        volume_estimate TEXT,
        digitize_method TEXT,
        priority TEXT DEFAULT 'medium',
        notes TEXT,
        registered_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_name, source_type)
      );

      CREATE TABLE IF NOT EXISTS digitize_progress (
        id SERIAL PRIMARY KEY,
        scan_date DATE NOT NULL DEFAULT CURRENT_DATE,
        total_sources INT DEFAULT 0,
        digitized_count INT DEFAULT 0,
        partial_count INT DEFAULT 0,
        gap_count INT DEFAULT 0,
        score REAL DEFAULT 0,
        details_json JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(scan_date)
      );

      CREATE INDEX IF NOT EXISTS idx_ds_category ON digitize_sources(category);
      CREATE INDEX IF NOT EXISTS idx_ds_status ON digitize_sources(status);
      CREATE INDEX IF NOT EXISTS idx_dp_date ON digitize_progress(scan_date);
    `);
  }

  // 초기화
  try {
    const db = getDb();
    if (db && db.query) {
      ensureDigitizerTables().catch(e => console.warn('[data-digitizer] 테이블 초기화 실패:', e.message));
    }
  } catch (_) { /* DB 미연결 시 무시 */ }

  // ═══════════════════════════════════════════════════════════════════════════
  // 데이터 소스 분류 체계
  // ═══════════════════════════════════════════════════════════════════════════

  const DATA_CATEGORIES = {
    structured_live: {
      label: '실시간 구조화 데이터',
      description: '실시간 수집되며 DB에 정형화된 데이터',
    },
    structured_batch: {
      label: '배치 구조화 데이터',
      description: '주기적으로 처리되어 구조화된 데이터',
    },
    semi_structured: {
      label: '반구조화 데이터',
      description: '일부 구조화되었으나 완전하지 않은 데이터',
    },
    unstructured_known: {
      label: '비구조화 (존재 확인)',
      description: '존재하지만 읽을 수 없는/읽지 않는 데이터',
    },
    unknown_gaps: {
      label: '데이터 갭',
      description: '있어야 하지만 소스 자체가 없는 데이터',
    },
  };

  // 화훼 수입/유통 회사가 추적해야 할 데이터 체계
  const EXPECTED_DATA = [
    {
      category: '매출/회계',
      items: ['일별 매출', '거래처별 미수금', '월별 손익', '세금계산서', '카드매출'],
      source: 'nenova DB + 이카운트',
      status: 'check',
    },
    {
      category: '재고',
      items: ['실시간 재고', '입고 예정', '유통기한/품질', '창고별 재고', '안전재고'],
      source: 'nenova StockMaster',
      status: 'check',
    },
    {
      category: '주문',
      items: ['일별 주문량', '거래처별 주문 패턴', '주문→출하 리드타임', '취소율', '변경률'],
      source: 'nenova OrderMaster',
      status: 'check',
    },
    {
      category: '고객',
      items: ['거래처 신용도', '결제 주기', '거래 빈도', '불만/클레임', '거래처별 수익률'],
      source: 'nenova Customer + Estimate',
      status: 'check',
    },
    {
      category: '공급망',
      items: ['농장별 품질', '운송 리드타임', '관세/통관', '환율 영향', '시즌 수요 예측'],
      source: 'nenova Farm + ShipmentDate',
      status: 'check',
    },
    {
      category: '인력',
      items: ['직원별 업무량', '야근 빈도', '업무 효율', '교육 필요도', '이직 리스크'],
      source: 'Orbit events',
      status: 'check',
    },
    {
      category: '커뮤니케이션',
      items: ['주문 소통 기록', '내부 의사결정', '클레임 기록', '거래처 피드백'],
      source: 'KakaoTalk',
      status: 'check',
    },
  ];

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     1. 전체 데이터 스캔
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/digitize/scan
   * 모든 데이터 소스를 스캔하고 구조화 수준별로 분류
   */
  router.get('/scan', async (req, res) => {
    try {
      const db = getOrbitDb();

      const result = {
        structured_live: [],
        structured_batch: [],
        semi_structured: [],
        unstructured_known: [],
        unknown_gaps: [],
      };

      // ── 1) Orbit 이벤트 데이터 (실시간 구조화) ──
      const eventCount = await safeCount(db, 'SELECT COUNT(*) as count FROM events');
      const eventTypes = await db.query(`
        SELECT type, COUNT(*) as cnt
        FROM events
        GROUP BY type
        ORDER BY cnt DESC
        LIMIT 20
      `).catch(() => ({ rows: [] }));

      result.structured_live.push({
        name: 'Orbit 이벤트',
        source: 'events 테이블',
        count: eventCount,
        types: eventTypes.rows.map(r => ({ type: r.type, count: parseInt(r.cnt) })),
        quality: eventCount > 10000 ? 'good' : eventCount > 1000 ? 'moderate' : 'low',
        freshness: '실시간',
      });

      // ── 2) nenova 전산 데이터 (실시간 구조화) ──
      let nenovaConnected = false;
      try {
        const nenovaProducts = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM Product');
        const nenovaCustomers = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM Customer');
        const nenovaOrders = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM OrderMaster');
        const nenovaOrderDetails = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM OrderDetail');
        const nenovaShipments = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM ShipmentDate');
        const nenovaEstimates = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM Estimate');
        const nenovaStocks = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM StockMaster');

        nenovaConnected = true;

        result.structured_live.push({
          name: 'nenova 전산 (상품)',
          source: 'nenova SQL Server — Product',
          count: nenovaProducts,
          quality: nenovaProducts > 2000 ? 'good' : 'moderate',
          freshness: '실시간 (전산 프로그램 직접)',
        });
        result.structured_live.push({
          name: 'nenova 전산 (거래처)',
          source: 'nenova SQL Server — Customer',
          count: nenovaCustomers,
          quality: nenovaCustomers > 500 ? 'good' : 'moderate',
          freshness: '실시간',
        });
        result.structured_live.push({
          name: 'nenova 전산 (주문)',
          source: 'nenova SQL Server — OrderMaster + OrderDetail',
          count: nenovaOrders,
          detail_count: nenovaOrderDetails,
          quality: nenovaOrders > 3000 ? 'good' : 'moderate',
          freshness: '실시간',
        });
        result.structured_live.push({
          name: 'nenova 전산 (출하)',
          source: 'nenova SQL Server — ShipmentDate',
          count: nenovaShipments,
          quality: nenovaShipments > 3000 ? 'good' : 'moderate',
          freshness: '실시간',
        });
        result.structured_live.push({
          name: 'nenova 전산 (견적)',
          source: 'nenova SQL Server — Estimate',
          count: nenovaEstimates,
          quality: 'moderate',
          freshness: '실시간',
        });
        result.structured_live.push({
          name: 'nenova 전산 (재고)',
          source: 'nenova SQL Server — StockMaster',
          count: nenovaStocks,
          quality: nenovaStocks > 0 ? 'moderate' : 'low',
          freshness: '실시간',
        });
      } catch (err) {
        result.structured_live.push({
          name: 'nenova 전산',
          source: 'nenova SQL Server',
          count: 0,
          quality: 'unavailable',
          error: err.message,
          freshness: '연결 불가',
        });
      }

      // ── 3) Orbit 동기화 데이터 (배치 구조화) ──
      const masterProducts = await safeCount(db, 'SELECT COUNT(*) as count FROM master_products');
      const masterCustomers = await safeCount(db, 'SELECT COUNT(*) as count FROM master_customers');
      const parsedOrders = await safeCount(db, 'SELECT COUNT(*) as count FROM parsed_orders');

      result.structured_batch.push({
        name: 'Orbit 동기화 상품',
        source: 'master_products (nenova → Orbit 동기화)',
        count: masterProducts,
        quality: masterProducts > 2000 ? 'good' : 'moderate',
        freshness: '주기적 동기화',
      });
      result.structured_batch.push({
        name: 'Orbit 동기화 거래처',
        source: 'master_customers (nenova → Orbit 동기화)',
        count: masterCustomers,
        quality: masterCustomers > 500 ? 'good' : 'moderate',
        freshness: '주기적 동기화',
      });
      result.structured_batch.push({
        name: 'Orbit 파싱 주문',
        source: 'parsed_orders (클립보드 자동 파싱)',
        count: parsedOrders,
        quality: parsedOrders > 100 ? 'moderate' : 'low',
        freshness: '이벤트 기반',
      });

      // Vision 학습 데이터
      const uiElements = await safeCount(db, 'SELECT COUNT(*) as count FROM ui_elements');
      const uiScreens = await safeCount(db, 'SELECT COUNT(*) as count FROM ui_screen_fingerprints');

      result.structured_batch.push({
        name: 'Vision UI 학습',
        source: 'ui_elements + ui_screen_fingerprints',
        count: uiElements,
        screens: uiScreens,
        quality: uiElements > 1000 ? 'good' : uiElements > 100 ? 'moderate' : 'low',
        freshness: 'Vision 분석 시 갱신',
      });

      // 활동 분류 규칙
      const activityRules = await safeCount(db, 'SELECT COUNT(*) as count FROM activity_rules');
      result.structured_batch.push({
        name: '활동 분류 규칙',
        source: 'activity_rules',
        count: activityRules,
        quality: activityRules > 50 ? 'good' : 'moderate',
        freshness: '학습 기반',
      });

      // ── 4) 반구조화 데이터 ──
      // 카카오톡 메시지 (이벤트에서 추출)
      const kakaoEvents = await safeCount(db,
        `SELECT COUNT(*) as count FROM events WHERE type IN ('keyboard.activity', 'app.switch')
         AND data_json->>'appName' ILIKE '%kakao%'`
      );
      result.semi_structured.push({
        name: 'KakaoTalk 활동 기록',
        source: 'events (appName=KakaoTalk)',
        count: kakaoEvents,
        detail: '앱 전환/활동만 기록 — 대화 내용 미수집',
        quality: kakaoEvents > 500 ? 'moderate' : 'low',
        digitize_potential: '주문 패턴, 거래처 소통 빈도, 클레임 감지 가능',
      });

      // 클립보드 데이터
      const clipboardEvents = await safeCount(db,
        `SELECT COUNT(*) as count FROM events WHERE type = 'clipboard.copy'`
      );
      result.semi_structured.push({
        name: '클립보드 복사 기록',
        source: 'events (type=clipboard.copy)',
        count: clipboardEvents,
        detail: '복사된 텍스트 일부 기록 — 발주서 파싱에 활용 중',
        quality: clipboardEvents > 100 ? 'moderate' : 'low',
        digitize_potential: '발주서 자동 파싱 (parsed_orders)',
      });

      // 스크린 캡처
      const captureEvents = await safeCount(db,
        `SELECT COUNT(*) as count FROM events WHERE type IN ('screen.capture', 'screen.analyzed')`
      );
      result.semi_structured.push({
        name: '스크린 캡처 (Vision)',
        source: 'events (type=screen.capture/screen.analyzed)',
        count: captureEvents,
        detail: '화면 캡처 → Claude Vision 분석 → UI 요소 학습',
        quality: captureEvents > 500 ? 'good' : captureEvents > 100 ? 'moderate' : 'low',
        digitize_potential: 'UI 병목, 반복 작업, 화면 전이 패턴',
      });

      // 엑셀 파일 사용 기록
      const excelEvents = await safeCount(db,
        `SELECT COUNT(*) as count FROM events WHERE type IN ('keyboard.activity', 'app.switch')
         AND (data_json->>'appName' ILIKE '%excel%' OR data_json->>'windowTitle' ILIKE '%.xls%')`
      );
      result.semi_structured.push({
        name: 'Excel 사용 기록',
        source: 'events (Excel 관련 활동)',
        count: excelEvents,
        detail: '어떤 엑셀 파일을 열었는지는 보이지만 내용은 미수집',
        quality: excelEvents > 200 ? 'moderate' : 'low',
        digitize_potential: '물량표/차감표/발주표 파일 구조화',
      });

      // 브라우저 사용 기록
      const browserEvents = await safeCount(db,
        `SELECT COUNT(*) as count FROM events WHERE type IN ('keyboard.activity', 'app.switch')
         AND (data_json->>'appName' ILIKE '%chrome%' OR data_json->>'appName' ILIKE '%edge%'
              OR data_json->>'appName' ILIKE '%whale%')`
      );
      result.semi_structured.push({
        name: '브라우저 사용 기록',
        source: 'events (Browser 활동)',
        count: browserEvents,
        detail: '어떤 사이트를 방문했는지 윈도우 타이틀 기록',
        quality: browserEvents > 200 ? 'moderate' : 'low',
        digitize_potential: '거래처 리서치, 시장 조사 패턴',
      });

      // ── 5) 비구조화 (존재는 아는데 디지털화 안 된 것) ──
      result.unstructured_known.push({
        name: '은행/금융 데이터',
        description: '입출금 내역, 미수금 현황',
        location: '은행 앱/사이트, 이카운트',
        blocker: 'API 연동 또는 수동 입력 필요',
        importance: 'critical',
      });
      result.unstructured_known.push({
        name: '전화 통화 내용',
        description: '거래처/농장 전화 협의 내용',
        location: '직원 기억, 메모장',
        blocker: '통화 기록/요약 시스템 없음',
        importance: 'high',
      });
      result.unstructured_known.push({
        name: '종이 서류',
        description: '세금계산서 원본, 수기 메모, 검품표',
        location: '사무실 서류함',
        blocker: 'OCR 스캔 후 디지털화 필요',
        importance: 'medium',
      });
      result.unstructured_known.push({
        name: '이메일 스레드',
        description: '해외 농장/물류 이메일 소통',
        location: '직원 이메일 계정',
        blocker: '이메일 API 연동 필요',
        importance: 'medium',
      });
      result.unstructured_known.push({
        name: '거래처 신용 정보',
        description: '결제 이력, 부도 리스크, 담보',
        location: '사장님 머릿속 + 경험',
        blocker: '체계적 기록 없음',
        importance: 'high',
      });
      result.unstructured_known.push({
        name: '농장별 품질 이력',
        description: '어떤 농장 꽃이 좋았는지/불량이었는지',
        location: '직원 경험, 불량 공유방 카톡',
        blocker: '체계적 품질 DB 없음',
        importance: 'high',
      });

      // ── 6) 데이터 갭 (소스 자체가 없는 것) ──
      result.unknown_gaps.push({
        name: '경쟁사 가격 정보',
        why_needed: '가격 경쟁력 파악, 마진 전략',
        possible_source: '시장 조사, 화훼 경매 데이터',
        importance: 'medium',
      });
      result.unknown_gaps.push({
        name: '고객 만족도',
        why_needed: '서비스 품질 개선, 이탈 방지',
        possible_source: '설문, 클레임 트래킹',
        importance: 'high',
      });
      result.unknown_gaps.push({
        name: '날씨/시즌 데이터 연동',
        why_needed: '수요 예측 정확도 향상',
        possible_source: '기상청 API, 공휴일 DB',
        importance: 'medium',
      });
      result.unknown_gaps.push({
        name: '물류 실시간 추적',
        why_needed: '입고 예정 시간 정확도, 고객 안내',
        possible_source: '항공/해운 트래킹 API',
        importance: 'high',
      });

      // ── 요약 통계 ──
      const summary = {
        total_sources: 0,
        by_category: {},
      };
      for (const [cat, items] of Object.entries(result)) {
        summary.by_category[cat] = {
          label: DATA_CATEGORIES[cat]?.label || cat,
          count: items.length,
        };
        summary.total_sources += items.length;
      }

      // 디지털화 점수 (0~100)
      const structuredCount = result.structured_live.length + result.structured_batch.length;
      const totalAll = summary.total_sources;
      summary.digitization_score = totalAll > 0 ? Math.round((structuredCount / totalAll) * 100) : 0;
      summary.nenova_connected = nenovaConnected;
      summary.scanned_at = new Date().toISOString();

      res.json({
        ok: true,
        summary,
        categories: DATA_CATEGORIES,
        data: result,
      });
    } catch (err) {
      handleError(res, err, 'scan');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     2. 데이터 갭 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/digitize/gaps
   * 화훼 수입/유통 회사가 추적해야 하는데 추적하지 않는 데이터 식별
   */
  router.get('/gaps', async (req, res) => {
    try {
      const db = getOrbitDb();
      const gaps = [];

      for (const expected of EXPECTED_DATA) {
        const itemResults = [];

        for (const item of expected.items) {
          const status = await checkDataExists(db, expected.category, item);
          itemResults.push({
            item,
            ...status,
          });
        }

        const existCount = itemResults.filter(r => r.exists).length;
        const partialCount = itemResults.filter(r => r.partial).length;
        const missingCount = itemResults.filter(r => !r.exists && !r.partial).length;

        gaps.push({
          category: expected.category,
          expected_source: expected.source,
          total_items: expected.items.length,
          exists: existCount,
          partial: partialCount,
          missing: missingCount,
          coverage: Math.round(((existCount + partialCount * 0.5) / expected.items.length) * 100),
          items: itemResults,
        });
      }

      // 전체 갭 요약
      const totalItems = gaps.reduce((s, g) => s + g.total_items, 0);
      const totalExists = gaps.reduce((s, g) => s + g.exists, 0);
      const totalPartial = gaps.reduce((s, g) => s + g.partial, 0);
      const totalMissing = gaps.reduce((s, g) => s + g.missing, 0);

      res.json({
        ok: true,
        summary: {
          total_data_points: totalItems,
          fully_digitized: totalExists,
          partially_digitized: totalPartial,
          missing: totalMissing,
          overall_coverage: Math.round(((totalExists + totalPartial * 0.5) / totalItems) * 100),
          analyzed_at: new Date().toISOString(),
        },
        gaps,
      });
    } catch (err) {
      handleError(res, err, 'gaps');
    }
  });

  /**
   * 특정 데이터 항목이 실제로 존재하는지 확인하는 내부 함수
   */
  async function checkDataExists(db, category, item) {
    try {
      switch (category) {
        case '매출/회계': {
          if (item === '일별 매출') {
            // nenova에서 주문 데이터가 매출 역할
            const cnt = await nenovaSafeCount(
              `SELECT COUNT(*) as cnt FROM OrderMaster WHERE DATEDIFF(DAY, OrderDate, GETDATE()) < 30`
            );
            return { exists: cnt > 0, count: cnt, source: 'nenova OrderMaster', note: '주문 기준 매출 (실제 정산 데이터 아님)' };
          }
          if (item === '거래처별 미수금') {
            return { exists: false, partial: false, source: '없음', note: '미수금 추적 시스템 없음 — 은행/이카운트 연동 필요', gap_severity: 'critical' };
          }
          if (item === '월별 손익') {
            return { exists: false, partial: false, source: '없음', note: '손익 계산 시스템 없음 — 매입가+운영비 데이터 필요', gap_severity: 'high' };
          }
          if (item === '세금계산서') {
            return { exists: false, partial: true, source: '이카운트 (별도 시스템)', note: '연동 안 됨' };
          }
          if (item === '카드매출') {
            return { exists: false, partial: false, source: '없음', note: '카드단말기 데이터 미연동' };
          }
          break;
        }
        case '재고': {
          if (item === '실시간 재고') {
            const cnt = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM StockMaster WHERE Qty > 0');
            return { exists: cnt > 0, count: cnt, source: 'nenova StockMaster', note: cnt > 0 ? '재고 데이터 존재' : '재고 데이터 미입력' };
          }
          if (item === '입고 예정') {
            const cnt = await nenovaSafeCount(
              `SELECT COUNT(*) as cnt FROM ShipmentDate WHERE ShipDate > GETDATE()`
            );
            return { exists: cnt > 0, count: cnt, source: 'nenova ShipmentDate', note: '출하 예정일 기반' };
          }
          if (item === '유통기한/품질') {
            return { exists: false, partial: false, source: '없음', note: '생화 특성상 품질 변화 빠름 — 실시간 품질 추적 없음', gap_severity: 'high' };
          }
          if (item === '창고별 재고') {
            return { exists: false, partial: false, source: '없음', note: '창고 구분 없이 통합 관리', gap_severity: 'low' };
          }
          if (item === '안전재고') {
            return { exists: false, partial: false, source: '없음', note: '안전재고 설정 기능 없음 — 경험 의존', gap_severity: 'medium' };
          }
          break;
        }
        case '주문': {
          if (item === '일별 주문량') {
            const cnt = await nenovaSafeCount(
              `SELECT COUNT(*) as cnt FROM OrderMaster WHERE DATEDIFF(DAY, OrderDate, GETDATE()) < 7`
            );
            return { exists: cnt > 0, count: cnt, source: 'nenova OrderMaster' };
          }
          if (item === '거래처별 주문 패턴') {
            const cnt = await nenovaSafeCount('SELECT COUNT(DISTINCT CustKey) as cnt FROM OrderDetail');
            return { exists: cnt > 0, count: cnt, source: 'nenova OrderDetail', note: '패턴 분석은 Orbit BI에서' };
          }
          if (item === '주문→출하 리드타임') {
            return { exists: false, partial: true, source: 'nenova OrderMaster + ShipmentDate', note: '데이터는 있으나 리드타임 계산 미구현' };
          }
          if (item === '취소율') {
            return { exists: false, partial: false, source: '없음', note: '취소/변경 이력 추적 안 됨', gap_severity: 'medium' };
          }
          if (item === '변경률') {
            return { exists: false, partial: false, source: '없음', note: '주문 변경 로그 없음', gap_severity: 'medium' };
          }
          break;
        }
        case '고객': {
          if (item === '거래처 신용도') {
            return { exists: false, partial: false, source: '없음', note: '신용 평가 체계 없음 — 사장님 경험 의존', gap_severity: 'critical' };
          }
          if (item === '결제 주기') {
            return { exists: false, partial: false, source: '없음', note: '결제/입금 데이터 미연동', gap_severity: 'high' };
          }
          if (item === '거래 빈도') {
            const cnt = await nenovaSafeCount('SELECT COUNT(DISTINCT CustKey) as cnt FROM OrderDetail');
            return { exists: cnt > 0, count: cnt, source: 'nenova OrderDetail' };
          }
          if (item === '불만/클레임') {
            return { exists: false, partial: true, source: '카톡 불량공유방', note: '카톡에 기록되나 구조화 안 됨', gap_severity: 'high' };
          }
          if (item === '거래처별 수익률') {
            return { exists: false, partial: false, source: '없음', note: '매입가 데이터 부족으로 수익률 계산 불가', gap_severity: 'critical' };
          }
          break;
        }
        case '공급망': {
          if (item === '농장별 품질') {
            return { exists: false, partial: true, source: 'nenova Farm + 카톡 불량공유방', note: '농장 데이터는 있으나 품질 이력 체계 없음', gap_severity: 'high' };
          }
          if (item === '운송 리드타임') {
            return { exists: false, partial: true, source: 'nenova ShipmentDate', note: '출하일만 있고 실제 도착일 미기록' };
          }
          if (item === '관세/통관') {
            return { exists: false, partial: false, source: '없음', note: '통관 비용 데이터 없음', gap_severity: 'medium' };
          }
          if (item === '환율 영향') {
            return { exists: false, partial: false, source: '없음', note: '환율 변동 영향 분석 없음', gap_severity: 'medium' };
          }
          if (item === '시즌 수요 예측') {
            return { exists: false, partial: true, source: 'nenova 주문 이력', note: '과거 데이터는 있으나 예측 모델 없음' };
          }
          break;
        }
        case '인력': {
          if (item === '직원별 업무량') {
            const cnt = await safeCount(db,
              `SELECT COUNT(DISTINCT user_id) as count FROM events
               WHERE created_at > NOW() - INTERVAL '7 days'`
            );
            return { exists: cnt > 0, count: cnt, source: 'Orbit events' };
          }
          if (item === '야근 빈도') {
            const cnt = await safeCount(db,
              `SELECT COUNT(*) as count FROM events
               WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 19
               AND created_at > NOW() - INTERVAL '30 days'`
            );
            return { exists: cnt > 0, count: cnt, source: 'Orbit events (19시 이후 활동)' };
          }
          if (item === '업무 효율') {
            return { exists: true, partial: false, source: 'Orbit events + activity_classifier', note: '활동 분류 기반 효율 분석 가능' };
          }
          if (item === '교육 필요도') {
            return { exists: false, partial: true, source: 'Orbit events', note: '특정 도구 반복 사용 패턴으로 추론 가능' };
          }
          if (item === '이직 리스크') {
            return { exists: false, partial: true, source: 'Orbit events', note: '야근 빈도 + 업무량 변화로 간접 추론', gap_severity: 'medium' };
          }
          break;
        }
        case '커뮤니케이션': {
          if (item === '주문 소통 기록') {
            return { exists: false, partial: true, source: 'KakaoTalk 활동 기록', note: '앱 전환만 기록 — 대화 내용 미수집', gap_severity: 'high' };
          }
          if (item === '내부 의사결정') {
            return { exists: false, partial: false, source: '없음', note: '의사결정 과정 기록 안 됨', gap_severity: 'high' };
          }
          if (item === '클레임 기록') {
            return { exists: false, partial: true, source: '카톡 불량공유방', note: '비구조화 상태', gap_severity: 'high' };
          }
          if (item === '거래처 피드백') {
            return { exists: false, partial: false, source: '없음', note: '피드백 수집 체계 없음', gap_severity: 'medium' };
          }
          break;
        }
      }
      return { exists: false, partial: false, source: '확인 불가', note: '검증 로직 미구현' };
    } catch (err) {
      return { exists: false, partial: false, source: '에러', note: err.message };
    }
  }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     3. 활용 기회
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/digitize/opportunities
   * 원시 데이터가 존재하지만 아직 활용되지 않는 기회 식별
   */
  router.get('/opportunities', async (req, res) => {
    try {
      const db = getOrbitDb();
      const opportunities = [];

      // 1. KakaoTalk 메시지 → 주문/감정/클레임 패턴
      const kakaoCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE (data_json->>'appName' ILIKE '%kakao%' OR data_json->>'windowTitle' ILIKE '%카카오%')
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      if (kakaoCount > 0) {
        // 거래처방 활동 빈도
        const custRoomCount = await safeCount(db,
          `SELECT COUNT(DISTINCT data_json->>'windowTitle') as count FROM events
           WHERE data_json->>'appName' ILIKE '%kakao%'
           AND created_at > NOW() - INTERVAL '30 days'`
        );
        opportunities.push({
          id: 'kakao-order-pattern',
          name: 'KakaoTalk → 주문 패턴 추출',
          raw_data: `최근 30일 카카오톡 활동 ${kakaoCount}건, ${custRoomCount}개 대화방`,
          current_use: '앱 전환 기록만 (대화 내용 미수집)',
          potential: [
            '거래처별 소통 빈도 → 관계 건강도',
            '주문 시간대 패턴 → 수요 예측',
            '급증하는 대화 → 클레임/이슈 조기 감지',
          ],
          method: '대화방별 전환 빈도 분석 + 시간대 패턴',
          impact: 'high',
          effort: 'low',
        });
      }

      // 2. 스크린 캡처 → UI 병목 감지
      const captureCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE type IN ('screen.capture', 'screen.analyzed')
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      const analyzedCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE type = 'screen.analyzed'
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      opportunities.push({
        id: 'capture-bottleneck',
        name: '스크린 캡처 → UI 병목 지점 발견',
        raw_data: `캡처 ${captureCount}건, Vision 분석 ${analyzedCount}건`,
        current_use: 'UI 요소 학습에 활용 중',
        potential: [
          '같은 화면 반복 캡처 → 작업 병목',
          '에러 화면 감지 → 시스템 이슈',
          '화면 전이 순서 → 비효율 동선 발견',
        ],
        method: 'Vision 분석 결과 + ui_click_map 교차 분석',
        impact: 'high',
        effort: 'medium',
      });

      // 3. 키보드 패턴 → 반복 작업
      const kbCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE type = 'keyboard.activity'
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      opportunities.push({
        id: 'keyboard-repetitive',
        name: '키보드 패턴 → 반복 작업 자동화 후보',
        raw_data: `최근 30일 키보드 활동 ${kbCount}건`,
        current_use: '활동 분류에 부분 활용',
        potential: [
          '동일 입력 반복 → 매크로/자동화 대상',
          '특정 시간대 집중 입력 → 업무 피크 파악',
          '입력 속도 변화 → 피로도/업무 난이도',
        ],
        method: '키스트로크 패턴 클러스터링',
        impact: 'high',
        effort: 'medium',
      });

      // 4. 파일 탐색기 활동 → 문서 조직 분석
      const explorerCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE (data_json->>'appName' ILIKE '%explorer%' OR data_json->>'appName' ILIKE '%탐색기%')
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      if (explorerCount > 0) {
        opportunities.push({
          id: 'explorer-docs',
          name: '파일 탐색기 → 문서 조직 분석',
          raw_data: `최근 30일 탐색기 활동 ${explorerCount}건`,
          current_use: '미활용',
          potential: [
            '자주 열리는 폴더/파일 → 핵심 문서 식별',
            '파일명 패턴 → 업무별 문서 분류',
            '공유 폴더 접근 → 팀간 협업 파악',
          ],
          method: '윈도우 타이틀에서 파일 경로 추출',
          impact: 'medium',
          effort: 'low',
        });
      }

      // 5. nenova 주문 이력 → 수요 예측
      const orderHistoryCount = await nenovaSafeCount(
        `SELECT COUNT(*) as cnt FROM OrderMaster`
      );
      if (orderHistoryCount > 0) {
        opportunities.push({
          id: 'nenova-demand-forecast',
          name: 'nenova 주문 이력 → 수요 예측 모델',
          raw_data: `전체 주문 ${orderHistoryCount}건 (nenova)`,
          current_use: '현황 조회만 (대시보드)',
          potential: [
            '주차별 주문 패턴 → 다음 주 수요 예측',
            '거래처별 주기성 → 재주문 시기 예측',
            '품목별 계절성 → 재고 사전 확보',
          ],
          method: '시계열 분석 (이동 평균 + 계절 보정)',
          impact: 'critical',
          effort: 'medium',
        });
      }

      // 6. nenova 거래처 + 주문 → 고객 세그먼트
      const custCount = await nenovaSafeCount('SELECT COUNT(*) as cnt FROM Customer');
      if (custCount > 0) {
        opportunities.push({
          id: 'customer-segmentation',
          name: '거래처 데이터 → 고객 세그먼트/RFM 분석',
          raw_data: `거래처 ${custCount}개 (nenova)`,
          current_use: '목록 조회만',
          potential: [
            'RFM 분석 (최근성/빈도/금액) → VIP/일반/이탈 위험',
            '거래처 성장률 → 집중 영업 대상',
            '거래처 집중도 → 리스크 분산 전략',
          ],
          method: 'OrderDetail 집계 + 거래처 분류',
          impact: 'high',
          effort: 'low',
        });
      }

      // 7. idle/break 패턴 → 직원 웰빙
      const idleCount = await safeCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE type = 'idle.detected'
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      opportunities.push({
        id: 'idle-wellness',
        name: 'Idle/Break 패턴 → 직원 웰빙 지표',
        raw_data: `최근 30일 idle 감지 ${idleCount}건`,
        current_use: '미활용',
        potential: [
          '연속 근무 시간 → 휴식 부족 감지',
          '점심/퇴근 패턴 → 야근 빈도 파악',
          '갑작스러운 패턴 변화 → 이슈 조기 감지',
        ],
        method: 'idle.detected + app.switch 시간대 분석',
        impact: 'medium',
        effort: 'low',
      });

      // 정렬: impact 높은 순
      const impactOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      opportunities.sort((a, b) => (impactOrder[a.impact] || 99) - (impactOrder[b.impact] || 99));

      res.json({
        ok: true,
        total: opportunities.length,
        opportunities,
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'opportunities');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     4. 디지털화 추천
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/digitize/recommendations
   * 우선순위별 구체적 디지털화 액션
   */
  router.get('/recommendations', async (req, res) => {
    try {
      const db = getOrbitDb();
      const recommendations = [];

      // 1. 미수금 추적 (critical)
      recommendations.push({
        id: 'rec-ar-tracking',
        priority: 'critical',
        category: '매출/회계',
        action: '거래처별 미수금 데이터 수집 체계 구축',
        reason: '현재 미수금 추적 불가 — 매출은 기록되지만 입금 확인이 안 됨',
        method: '이카운트 ERP 연동 또는 은행 거래내역 CSV 일괄 업로드',
        impact: '자금 흐름 파악, 부실 거래처 조기 발견, 현금 흐름 예측',
        effort: 'medium',
        steps: [
          '1. 이카운트 API 또는 CSV 내보내기 확인',
          '2. Orbit에 미수금 테이블 설계',
          '3. 일별 동기화 스크립트 개발',
          '4. 미수금 알림 기능 추가',
        ],
        estimated_time: '2~3주',
      });

      // 2. 거래처 신용 평가 (critical)
      recommendations.push({
        id: 'rec-credit-score',
        priority: 'critical',
        category: '고객',
        action: '거래처 신용도 데이터베이스 구축',
        reason: '거래처 신용 정보가 사장님 머릿속에만 존재 — 체계적 리스크 관리 불가',
        method: '주문 이력 기반 자동 신용 점수 + 수동 평가 병합',
        impact: '부실 거래 예방, 여신 한도 관리, 신규 거래처 리스크 사전 평가',
        effort: 'medium',
        steps: [
          '1. nenova 주문 이력으로 기본 신용 점수 자동 산출 (거래 빈도, 규모, 기간)',
          '2. 관리자 수동 평가 입력 UI 추가',
          '3. 미수금 데이터 연동 시 가중치 반영',
          '4. 신용 등급별 거래처 분류 대시보드',
        ],
        estimated_time: '1~2주 (미수금 연동 제외)',
      });

      // 3. 거래처별 수익률 (critical)
      recommendations.push({
        id: 'rec-customer-profit',
        priority: 'critical',
        category: '고객',
        action: '거래처별 수익률 산출 체계',
        reason: '매입가 데이터 부족으로 거래처별 실제 수익률 파악 불가',
        method: 'nenova Estimate(견적) + OrderDetail(주문) + 매입 원가 입력',
        impact: '적자 거래처 발견, 가격 전략 최적화, 집중 영업 대상 선정',
        effort: 'high',
        steps: [
          '1. nenova 견적 데이터에서 단가 추출',
          '2. 매입 원가 입력 기능 개발 (수동 + 엑셀 업로드)',
          '3. 거래처별 (매출-매입)/매출 수익률 계산',
          '4. 마이너스 수익률 거래처 알림',
        ],
        estimated_time: '3~4주',
      });

      // 4. 주문 자동화 (high)
      const orderVolume = await nenovaSafeCount(
        `SELECT COUNT(*) as cnt FROM OrderDetail WHERE DATEDIFF(DAY, InputDate, GETDATE()) < 7`
      );
      recommendations.push({
        id: 'rec-order-auto',
        priority: 'high',
        category: '주문',
        action: '카카오톡 발주서 → 전산 자동 입력',
        reason: `주 ${orderVolume || '약 1000'}건 주문을 수동 입력 — 하루 7~8시간 소요`,
        method: '클립보드 파싱 확장 + nenova PAD/pyautogui 자동 입력',
        impact: '연 2,000시간+ 절감, 입력 오류 제거, 직원 업무 부담 감소',
        effort: 'high',
        steps: [
          '1. 클립보드 발주서 파싱 정확도 95%+ 달성 (현재 parsed_orders)',
          '2. PAD(Power Automate Desktop) nenova 자동 입력 스크립트',
          '3. 테스트: 1주일 병행 운영 (수동 + 자동 대조)',
          '4. 점진적 전환: 특정 거래처부터 시작',
        ],
        estimated_time: '4~6주',
      });

      // 5. 품질 이력 DB (high)
      recommendations.push({
        id: 'rec-quality-db',
        priority: 'high',
        category: '공급망',
        action: '농장별 품질 이력 데이터베이스 구축',
        reason: '품질 정보가 카톡 불량공유방에만 존재 — 농장 평가/선별 불가',
        method: '불량공유방 메시지 구조화 + 품질 평가 입력 기능',
        impact: '품질 좋은 농장 선별, 불량률 감소, 클레임 대응 근거',
        effort: 'medium',
        steps: [
          '1. 품질 이력 테이블 설계 (농장, 품목, 등급, 사진, 코멘트)',
          '2. 모바일 입력 UI (현장에서 사진+등급 즉시 입력)',
          '3. 카톡 불량 키워드 자동 감지 시 품질 이벤트 생성',
          '4. 농장별 품질 점수 자동 산출',
        ],
        estimated_time: '2~3주',
      });

      // 6. 리드타임 추적 (high)
      recommendations.push({
        id: 'rec-leadtime',
        priority: 'high',
        category: '공급망',
        action: '주문→출하→도착 리드타임 추적 자동화',
        reason: '출하일은 있으나 실제 도착일/리드타임 미기록',
        method: 'nenova ShipmentDate + 도착 확인 입력',
        impact: '입고 예정 정확도 향상, 고객 납기 안내, 물류 최적화',
        effort: 'medium',
        steps: [
          '1. 도착 확인 기능 추가 (출하→도착 시간 기록)',
          '2. 국가/농장별 평균 리드타임 자동 산출',
          '3. 예상 도착일 알림 (고객에게 안내 가능)',
          '4. 리드타임 이상 시 자동 알림',
        ],
        estimated_time: '1~2주',
      });

      // 7. 클레임 구조화 (high)
      recommendations.push({
        id: 'rec-claim-tracking',
        priority: 'high',
        category: '커뮤니케이션',
        action: '클레임/불만 구조화 추적 시스템',
        reason: '클레임이 카톡에 흩어져 있어 체계적 관리/분석 불가',
        method: '클레임 입력 폼 + 카톡 키워드 자동 감지',
        impact: '반복 클레임 패턴 발견, 원인 분석, 거래처 만족도 개선',
        effort: 'medium',
        steps: [
          '1. 클레임 테이블 설계 (거래처, 품목, 유형, 원인, 조치, 결과)',
          '2. 간단한 입력 UI (5초 내 등록 가능)',
          '3. 카톡에서 "불량", "교환", "반품" 키워드 감지 시 알림',
          '4. 월별 클레임 리포트 자동 생성',
        ],
        estimated_time: '1~2주',
      });

      // 8. 엑셀 파일 자동 수집 (medium)
      recommendations.push({
        id: 'rec-excel-collect',
        priority: 'medium',
        category: '매출/회계',
        action: 'PC 엑셀 파일 자동 인덱싱 + 구조 파악',
        reason: '물량표/차감표/매출표 등이 PC에 흩어져 관리 안 됨',
        method: '데몬에서 .xlsx 파일 목록 수집 + 시트 구조 분석',
        impact: '중요 데이터 발견, 중복 파일 정리, 자동 집계',
        effort: 'low',
        steps: [
          '1. 데몬에 엑셀 파일 스캔 기능 추가',
          '2. 파일명 패턴으로 용도 자동 분류',
          '3. openpyxl로 시트 구조/헤더 추출',
          '4. 주요 엑셀 데이터를 DB로 자동 집계',
        ],
        estimated_time: '1주',
      });

      // 9. 안전재고 알림 (medium)
      recommendations.push({
        id: 'rec-safety-stock',
        priority: 'medium',
        category: '재고',
        action: '안전재고 기준 설정 + 자동 알림',
        reason: '안전재고 기준이 없어 재고 부족/과다를 경험으로만 판단',
        method: '주문 이력 기반 안전재고 자동 산출 + 알림',
        impact: '재고 부족으로 인한 출하 지연 방지, 과다 재고 비용 절감',
        effort: 'low',
        steps: [
          '1. 품목별 최근 4주 평균 주문량 산출',
          '2. 안전재고 = 평균 주문량 * 리드타임 * 1.5',
          '3. 현재 재고 < 안전재고 시 알림',
          '4. 관리자 수동 조정 기능',
        ],
        estimated_time: '3~5일',
      });

      // 10. 의사결정 기록 (medium)
      recommendations.push({
        id: 'rec-decision-log',
        priority: 'medium',
        category: '커뮤니케이션',
        action: '주요 의사결정 기록 시스템',
        reason: '가격 변경, 거래처 추가/중단 등 중요 결정이 기록 안 됨',
        method: '간단한 의사결정 로그 입력 (카톡 봇 또는 웹 폼)',
        impact: '결정 이력 추적, 결과 분석, 조직 학습',
        effort: 'low',
        steps: [
          '1. 의사결정 로그 테이블 설계 (일시, 유형, 내용, 관련자, 결과)',
          '2. 10초 내 입력 가능한 초경량 UI',
          '3. 카테고리별 자동 분류 (가격, 인사, 거래처, 물류 등)',
          '4. 의사결정 타임라인 대시보드',
        ],
        estimated_time: '3~5일',
      });

      // 우선순위 정렬
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      recommendations.sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));

      // 요약
      const summary = {
        total: recommendations.length,
        by_priority: {},
        estimated_total_time: '약 3~4개월 (순차적)',
      };
      for (const rec of recommendations) {
        summary.by_priority[rec.priority] = (summary.by_priority[rec.priority] || 0) + 1;
      }

      res.json({
        ok: true,
        summary,
        recommendations,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'recommendations');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     5. 진행률 추적
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/digitize/progress
   * 디지털화 진행률 추적 (히스토리)
   */
  router.get('/progress', async (req, res) => {
    try {
      const db = getOrbitDb();

      // 현재 상태 계산
      const currentState = await calculateDigitizationScore(db);

      // 히스토리 조회
      const history = await db.query(`
        SELECT scan_date, total_sources, digitized_count, partial_count, gap_count, score
        FROM digitize_progress
        ORDER BY scan_date DESC
        LIMIT 30
      `).catch(() => ({ rows: [] }));

      // 현재 스냅샷 저장 (하루 1회)
      try {
        await db.query(`
          INSERT INTO digitize_progress (scan_date, total_sources, digitized_count, partial_count, gap_count, score, details_json)
          VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6)
          ON CONFLICT (scan_date) DO UPDATE SET
            total_sources = $1, digitized_count = $2, partial_count = $3, gap_count = $4, score = $5, details_json = $6
        `, [
          currentState.total_sources,
          currentState.digitized_count,
          currentState.partial_count,
          currentState.gap_count,
          currentState.score,
          JSON.stringify(currentState.details),
        ]);
      } catch (saveErr) {
        console.warn('[data-digitizer] 진행률 저장 실패:', saveErr.message);
      }

      // 트렌드 계산
      let trend = 'stable';
      if (history.rows.length >= 2) {
        const latest = history.rows[0]?.score || 0;
        const previous = history.rows[1]?.score || 0;
        if (latest > previous + 2) trend = 'improving';
        else if (latest < previous - 2) trend = 'declining';
      }

      res.json({
        ok: true,
        current: currentState,
        trend,
        history: history.rows,
        measured_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'progress');
    }
  });

  /**
   * 디지털화 점수 산출 내부 함수
   */
  async function calculateDigitizationScore(db) {
    const details = {};
    let digitized = 0;
    let partial = 0;
    let gaps = 0;
    let total = 0;

    // 각 EXPECTED_DATA 카테고리별 확인
    for (const expected of EXPECTED_DATA) {
      for (const item of expected.items) {
        total++;
        const status = await checkDataExists(db, expected.category, item);
        if (status.exists) {
          digitized++;
          details[`${expected.category}/${item}`] = 'digitized';
        } else if (status.partial) {
          partial++;
          details[`${expected.category}/${item}`] = 'partial';
        } else {
          gaps++;
          details[`${expected.category}/${item}`] = 'missing';
        }
      }
    }

    const score = total > 0 ? Math.round(((digitized + partial * 0.5) / total) * 100) : 0;

    return {
      score,
      grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F',
      total_sources: total,
      digitized_count: digitized,
      partial_count: partial,
      gap_count: gaps,
      details,
    };
  }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     6. 수동 데이터 소스 분류
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * POST /api/digitize/classify-source
   * 새로운 데이터 소스를 수동으로 등록/분류
   *
   * body: {
   *   source_name: "거래처 월별 정산 엑셀",
   *   source_type: "excel",
   *   category: "매출/회계",
   *   data_format: "xlsx",
   *   volume_estimate: "월 1파일, 약 200행",
   *   digitize_method: "openpyxl 자동 파싱",
   *   priority: "high",
   *   notes: "경리 김씨가 월말에 작성"
   * }
   */
  router.post('/classify-source', async (req, res) => {
    try {
      const db = getOrbitDb();
      const {
        source_name, source_type, category,
        data_format, volume_estimate, digitize_method,
        priority, notes, registered_by,
      } = req.body;

      if (!source_name || !source_type || !category) {
        return res.status(400).json({
          ok: false,
          error: 'source_name, source_type, category 필수',
        });
      }

      await db.query(`
        INSERT INTO digitize_sources (source_name, source_type, category, data_format, volume_estimate, digitize_method, priority, notes, registered_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (source_name, source_type) DO UPDATE SET
          category = $3, data_format = $4, volume_estimate = $5,
          digitize_method = $6, priority = $7, notes = $8, updated_at = NOW()
      `, [source_name, source_type, category, data_format || null, volume_estimate || null, digitize_method || null, priority || 'medium', notes || null, registered_by || null]);

      // 등록된 소스 목록 반환
      const sources = await db.query('SELECT * FROM digitize_sources ORDER BY created_at DESC');

      res.json({
        ok: true,
        message: `데이터 소스 "${source_name}" 등록 완료`,
        total_sources: sources.rows.length,
        sources: sources.rows,
      });
    } catch (err) {
      handleError(res, err, 'classify-source');
    }
  });

  return router;
};
