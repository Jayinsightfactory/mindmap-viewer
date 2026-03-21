'use strict';
/**
 * self-evolve.js — 자가 진화 엔진
 *
 * 웹이 지속적으로 성능과 학습을 스스로 개선하는 알고리즘
 *
 * 1. 성능 모니터링 — 파서 성공률, API 에러, 커버리지
 * 2. 학습 효과 측정 — 마스터 DB 성장 → 파싱 정확도 변화
 * 3. 시계열 트렌드 — 일별 스냅샷 저장 → 비교
 * 4. 주문 완결성 추적 — 접수→등록→출고→차감 사이클
 * 5. 피드백 루프 — 분석 결과가 다음 분석을 개선
 * 6. 일일 자동 리포트 — 매일 18:00 KST 자동 생성
 * 7. parsed_orders 집계 — 일별/거래처별/품목별 주문 현황
 */
const express = require('express');

function createSelfEvolveRouter({ getDb }) {
  const router = express.Router();

  // ── 성능 메트릭 인메모리 저장 ──
  const _metrics = {
    apiCalls: 0,
    apiErrors: 0,
    parseAttempts: 0,
    parseSuccess: 0,
    parseFail: 0,
    learnedProducts: 0,
    learnedCustomers: 0,
    startTime: Date.now(),
  };

  // ═══════════════════════════════════════════════════════════════
  // GET /api/evolve/health — 시스템 자가 진단
  // ═══════════════════════════════════════════════════════════════
  router.get('/health', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const [
        masterRes, parsedRes, visionRes, eventRes, dailyRes, coverageRes
      ] = await Promise.all([
        // 마스터 DB 성장 추적
        db.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE category != 'unknown') as classified,
            COUNT(*) FILTER (WHERE first_seen > NOW() - INTERVAL '24 hours') as new_24h,
            COUNT(*) FILTER (WHERE first_seen > NOW() - INTERVAL '7 days') as new_7d
          FROM master_products
        `),
        // parsed_orders 현황
        db.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
            COUNT(DISTINCT customer) as unique_customers,
            COUNT(DISTINCT product) as unique_products,
            AVG(confidence) as avg_confidence
          FROM parsed_orders
        `),
        // Vision 커버리지
        db.query(`
          SELECT user_id,
            COUNT(*) FILTER (WHERE type = 'screen.capture') as captures,
            COUNT(*) FILTER (WHERE type = 'screen.analyzed') as analyzed
          FROM events
          WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours'
            AND type IN ('screen.capture', 'screen.analyzed')
          GROUP BY user_id
        `),
        // 전체 이벤트 현황
        db.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours') as last_24h,
            COUNT(*) FILTER (WHERE timestamp::timestamptz > NOW() - INTERVAL '1 hour') as last_1h
          FROM events
        `),
        // 일별 추이 (7일)
        db.query(`
          SELECT date_trunc('day', timestamp::timestamptz) as day,
            COUNT(*) as events,
            COUNT(*) FILTER (WHERE type = 'screen.analyzed') as visions,
            COUNT(*) FILTER (WHERE type = 'clipboard.change') as clips
          FROM events
          WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY day ORDER BY day
        `),
        // rawInput 커버리지
        db.query(`
          SELECT user_id,
            COUNT(*) as total_keyboard,
            COUNT(*) FILTER (WHERE data_json->>'rawInput' IS NOT NULL AND LENGTH(data_json->>'rawInput') > 3) as with_raw
          FROM events
          WHERE type = 'keyboard.chunk'
            AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          GROUP BY user_id
        `),
      ]);

      const master = masterRes.rows[0] || {};
      const parsed = parsedRes.rows[0] || {};
      const events = eventRes.rows[0] || {};

      // Vision 커버리지 계산
      const visionCoverage = {};
      for (const r of visionRes.rows) {
        const captures = parseInt(r.captures) || 0;
        const analyzed = parseInt(r.analyzed) || 0;
        visionCoverage[r.user_id] = {
          captures, analyzed,
          rate: captures > 0 ? Math.round(analyzed / captures * 100) : 0,
        };
      }

      // rawInput 커버리지
      const rawCoverage = {};
      for (const r of coverageRes.rows) {
        const total = parseInt(r.total_keyboard) || 0;
        const withRaw = parseInt(r.with_raw) || 0;
        rawCoverage[r.user_id] = {
          total, withRaw,
          rate: total > 0 ? Math.round(withRaw / total * 100) : 0,
        };
      }

      // 일별 성장률
      const daily = dailyRes.rows.map(r => ({
        day: r.day,
        events: parseInt(r.events),
        visions: parseInt(r.visions),
        clips: parseInt(r.clips),
      }));

      // 학습 효과 점수 (0-100)
      const classifiedRate = parseInt(master.total) > 0 ? parseInt(master.classified) / parseInt(master.total) : 0;
      const avgConfidence = parseFloat(parsed.avg_confidence) || 0;
      const visionAvgRate = Object.values(visionCoverage).length > 0
        ? Object.values(visionCoverage).reduce((s, v) => s + v.rate, 0) / Object.values(visionCoverage).length
        : 0;
      const rawAvgRate = Object.values(rawCoverage).length > 0
        ? Object.values(rawCoverage).reduce((s, v) => s + v.rate, 0) / Object.values(rawCoverage).length
        : 0;

      const learningScore = Math.round(
        classifiedRate * 25 +           // 품목 분류율 25%
        Math.min(avgConfidence, 1) * 25 + // 파싱 신뢰도 25%
        visionAvgRate / 100 * 25 +       // Vision 커버리지 25%
        rawAvgRate / 100 * 25             // rawInput 커버리지 25%
      );

      // 개선 제안 자동 생성
      const suggestions = [];
      if (classifiedRate < 0.5) suggestions.push({ area: 'master_db', action: '미분류 품목 정리 필요', priority: 'high', detail: `${parseInt(master.total) - parseInt(master.classified)}개 unknown` });
      if (visionAvgRate < 30) suggestions.push({ area: 'vision', action: 'Vision 워커 커버리지 확대', priority: 'high', detail: `평균 ${Math.round(visionAvgRate)}%` });
      if (rawAvgRate < 50) suggestions.push({ area: 'rawInput', action: '데몬 업데이트로 rawInput 확대', priority: 'medium', detail: `평균 ${Math.round(rawAvgRate)}%` });
      if (parseInt(parsed.total) === 0) suggestions.push({ area: 'parsed_orders', action: '클립보드 자동 파싱 활성화 확인', priority: 'high', detail: '저장된 파싱 결과 0건' });
      if (daily.length >= 2) {
        const last = daily[daily.length - 1];
        const prev = daily[daily.length - 2];
        if (last.events < prev.events * 0.5) suggestions.push({ area: 'data_collection', action: '데이터 수집량 급감 — 데몬 상태 확인', priority: 'critical' });
      }

      res.json({
        learningScore,
        scoreBand: learningScore >= 80 ? 'A' : learningScore >= 60 ? 'B' : learningScore >= 40 ? 'C' : 'D',
        breakdown: {
          masterClassified: Math.round(classifiedRate * 100),
          parseConfidence: Math.round(avgConfidence * 100),
          visionCoverage: Math.round(visionAvgRate),
          rawInputCoverage: Math.round(rawAvgRate),
        },
        master: {
          total: parseInt(master.total),
          classified: parseInt(master.classified),
          new24h: parseInt(master.new_24h),
          new7d: parseInt(master.new_7d),
        },
        parsedOrders: {
          total: parseInt(parsed.total),
          today: parseInt(parsed.today),
          uniqueCustomers: parseInt(parsed.unique_customers),
          uniqueProducts: parseInt(parsed.unique_products),
          avgConfidence: +avgConfidence.toFixed(2),
        },
        coverage: { vision: visionCoverage, rawInput: rawCoverage },
        daily,
        suggestions,
        uptime: Math.round((Date.now() - _metrics.startTime) / 60000) + '분',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/evolve/orders — parsed_orders 일별/거래처별/품목별 집계
  // ═══════════════════════════════════════════════════════════════
  router.get('/orders', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days || '7');

      const [dailyRes, custRes, prodRes, typeRes] = await Promise.all([
        db.query(`
          SELECT date_trunc('day', created_at) as day,
            COUNT(*) as orders, SUM(quantity) as total_qty
          FROM parsed_orders
          WHERE created_at > NOW() - INTERVAL '${days} days'
          GROUP BY day ORDER BY day
        `),
        db.query(`
          SELECT customer, COUNT(*) as orders, SUM(quantity) as total_qty,
            array_agg(DISTINCT product) as products
          FROM parsed_orders
          WHERE created_at > NOW() - INTERVAL '${days} days' AND customer != ''
          GROUP BY customer ORDER BY orders DESC LIMIT 20
        `),
        db.query(`
          SELECT product, SUM(quantity) as total_qty, COUNT(*) as mentions,
            array_agg(DISTINCT customer) FILTER (WHERE customer != '') as customers
          FROM parsed_orders
          WHERE created_at > NOW() - INTERVAL '${days} days'
          GROUP BY product ORDER BY total_qty DESC LIMIT 30
        `),
        db.query(`
          SELECT source_type, COUNT(*) as cnt
          FROM parsed_orders
          WHERE created_at > NOW() - INTERVAL '${days} days'
          GROUP BY source_type ORDER BY cnt DESC
        `),
      ]);

      res.json({
        days,
        daily: dailyRes.rows,
        byCustomer: custRes.rows,
        byProduct: prodRes.rows,
        bySourceType: typeRes.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/evolve/trend — 시계열 트렌드 (일별 비교)
  // ═══════════════════════════════════════════════════════════════
  router.get('/trend', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const [dailyRes, memberRes, autoRes] = await Promise.all([
        // 일별 이벤트 + Vision + 파싱
        db.query(`
          SELECT date_trunc('day', timestamp::timestamptz) as day,
            COUNT(*) as events,
            COUNT(DISTINCT user_id) as active_users,
            COUNT(*) FILTER (WHERE type = 'screen.analyzed') as visions,
            COUNT(*) FILTER (WHERE type = 'screen.analyzed' AND data_json->>'automatable' = 'true') as automatable,
            COUNT(*) FILTER (WHERE type = 'clipboard.change') as clips,
            COUNT(*) FILTER (WHERE type = 'keyboard.chunk' AND data_json->>'rawInput' IS NOT NULL) as raw_inputs
          FROM events
          WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY day ORDER BY day
        `),
        // 멤버별 일별 활동 (업무 이관 감지용)
        db.query(`
          SELECT e.user_id, u.name,
            date_trunc('day', e.timestamp::timestamptz) as day,
            COUNT(*) as events
          FROM events e
          LEFT JOIN orbit_auth_users u ON e.user_id = u.id
          WHERE e.type IN ('keyboard.chunk', 'screen.capture')
            AND e.timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY e.user_id, u.name, day
          ORDER BY e.user_id, day
        `),
        // 자동화율 일별 변화
        db.query(`
          SELECT date_trunc('day', timestamp::timestamptz) as day,
            COUNT(*) FILTER (WHERE data_json->>'automatable' = 'true') as auto_yes,
            COUNT(*) as total,
            CASE WHEN COUNT(*) > 0 THEN
              ROUND(COUNT(*) FILTER (WHERE data_json->>'automatable' = 'true')::numeric / COUNT(*) * 100)
            ELSE 0 END as rate
          FROM events
          WHERE type = 'screen.analyzed'
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY day ORDER BY day
        `),
      ]);

      // 업무 이관 감지
      const handoffs = [];
      const memberDaily = {};
      for (const r of memberRes.rows) {
        const key = r.user_id;
        if (!memberDaily[key]) memberDaily[key] = { name: r.name, days: {} };
        memberDaily[key].days[r.day] = parseInt(r.events);
      }

      // 급격한 변화 감지 (전일 대비 50% 이상 변화)
      for (const [uid, data] of Object.entries(memberDaily)) {
        const days = Object.entries(data.days).sort((a, b) => a[0].localeCompare(b[0]));
        for (let i = 1; i < days.length; i++) {
          const prev = days[i - 1][1];
          const curr = days[i][1];
          if (prev > 50 && curr < prev * 0.3) {
            handoffs.push({
              type: 'ACTIVITY_DROP',
              member: data.name || uid.substring(0, 8),
              from: prev, to: curr, day: days[i][0],
              change: Math.round((curr - prev) / prev * 100),
            });
          } else if (prev < 50 && curr > 200) {
            handoffs.push({
              type: 'ACTIVITY_SURGE',
              member: data.name || uid.substring(0, 8),
              from: prev, to: curr, day: days[i][0],
              change: Math.round((curr - prev) / Math.max(prev, 1) * 100),
            });
          }
        }
      }

      res.json({
        daily: dailyRes.rows.map(r => ({
          day: r.day,
          events: parseInt(r.events),
          activeUsers: parseInt(r.active_users),
          visions: parseInt(r.visions),
          automatable: parseInt(r.automatable),
          clips: parseInt(r.clips),
          rawInputs: parseInt(r.raw_inputs),
        })),
        automationRate: autoRes.rows.map(r => ({
          day: r.day, rate: parseInt(r.rate), total: parseInt(r.total),
        })),
        handoffs,
        memberDaily,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/evolve/improve — 자가 개선 실행
  // 미분류 품목 정리, 중복 거래처 병합, 파서 규칙 확장
  // ═══════════════════════════════════════════════════════════════
  router.post('/improve', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const improvements = [];

      // 1. 미분류 품목 자동 분류 (클립보드 컨텍스트 기반)
      const unknowns = await db.query(`
        SELECT mp.id, mp.name FROM master_products mp
        WHERE mp.category = 'unknown' AND mp.seen_count > 0
      `);

      const knownCategories = {
        '카네이션': ['돈셀','크리미아','노비아','헤르메스','마리포사','문라이트','폴림니아','메건','클리어워터','로다스','유카리체리','제플린','카오리','주리고','블랙잭','코스모'],
        '장미': ['캐더린','프라이드','크림컵','레드니스','뤄선','아이샤','코랄리프','프리덤','만달라','모멘텀','레드팬서','시머','하츠','몬디알'],
        '수국': ['화이트','피치','라벤더','블루','다크핑크','그린','스노그린','스노핑크','네추','레치'],
        '리시안셔스': ['유스토마','에스토마','리시안','Eustoma','Lisianthus'],
        '기타화훼': ['유칼립','시네시스','안스리움','카라','루스커스','에린지움','스키미아','알스트로','거베라','국화','튤립','히야신스','알리움','아마릴리스'],
      };

      let classified = 0;
      for (const row of unknowns.rows) {
        const name = (row.name || '').toLowerCase();
        for (const [cat, keywords] of Object.entries(knownCategories)) {
          if (keywords.some(kw => name.includes(kw.toLowerCase()))) {
            await db.query('UPDATE master_products SET category = $1 WHERE id = $2', [cat, row.id]);
            classified++;
            break;
          }
        }
      }
      if (classified > 0) improvements.push({ action: 'classify_products', count: classified, detail: `${classified}개 unknown → 카테고리 분류` });

      // 2. 비업무 단어 제거 (마스터에 잘못 등록된 일반 단어)
      const noiseWords = ['출고일자', '색상', '총', '합계', '박스', '참좋은원예', '수연', '출고', '일요일', '월요일', '화요일', '토요일', '금요일'];
      const deleteRes = await db.query(`
        DELETE FROM master_products
        WHERE name = ANY($1) AND source LIKE 'auto%'
        RETURNING name
      `, [noiseWords]);
      if (deleteRes.rowCount > 0) improvements.push({ action: 'remove_noise', count: deleteRes.rowCount, detail: `${deleteRes.rowCount}개 노이즈 단어 제거` });

      // 3. 거래처 중복 정리 (띄어쓰기 차이)
      const dupeRes = await db.query(`
        SELECT name FROM master_customers
        WHERE name LIKE '% %'
          AND REPLACE(name, ' ', '') IN (SELECT name FROM master_customers WHERE name NOT LIKE '% %')
      `);
      for (const r of dupeRes.rows) {
        await db.query('DELETE FROM master_customers WHERE name = $1', [r.name]);
      }
      if (dupeRes.rowCount > 0) improvements.push({ action: 'merge_customers', count: dupeRes.rowCount, detail: `${dupeRes.rowCount}개 중복 거래처 병합` });

      // 4. Vision 누락 사용자 감지
      const visionGap = await db.query(`
        SELECT user_id, COUNT(*) as captures
        FROM events
        WHERE type = 'screen.capture'
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          AND user_id NOT IN (
            SELECT DISTINCT user_id FROM events
            WHERE type = 'screen.analyzed'
              AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          )
        GROUP BY user_id
        HAVING COUNT(*) >= 10
      `);
      for (const r of visionGap.rows) {
        improvements.push({ action: 'vision_gap', count: parseInt(r.captures), detail: `${r.user_id.substring(0, 12)}: 캡처 ${r.captures}건인데 Vision 0건` });
      }

      // 5. 학습 점수 재계산
      const scoreRes = await db.query(`
        SELECT
          (SELECT COUNT(*) FILTER (WHERE category != 'unknown')::float / NULLIF(COUNT(*), 0) FROM master_products) as classified_rate,
          (SELECT AVG(confidence) FROM parsed_orders) as avg_conf
      `);
      const sr = scoreRes.rows[0] || {};
      const newScore = Math.round(
        (parseFloat(sr.classified_rate) || 0) * 50 +
        (parseFloat(sr.avg_conf) || 0) * 50
      );

      res.json({
        improvements,
        totalActions: improvements.reduce((s, i) => s + i.count, 0),
        learningScoreAfter: newScore,
        message: improvements.length > 0
          ? `${improvements.length}가지 개선 완료 (${improvements.reduce((s, i) => s + i.count, 0)}건 처리)`
          : '추가 개선 사항 없음 — 현재 상태 양호',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 자동 진화 스케줄러 — 6시간마다 자가 개선 실행
  // ═══════════════════════════════════════════════════════════════
  async function _autoEvolve() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 1. 미분류 품목 자동 분류
      const knownCats = {
        '카네이션': ['돈셀','크리미아','노비아','헤르메스','마리포사','문라이트','폴림니아','메건','클리어워터','로다스','코스모'],
        '장미': ['캐더린','프라이드','크림컵','코랄리프','프리덤','만달라','모멘텀','레드팬서','몬디알'],
        '수국': ['화이트','피치','라벤더','블루','스노그린','스노핑크'],
        '기타화훼': ['유칼립','시네시스','안스리움','카라','루스커스'],
      };
      const unknowns = await db.query("SELECT id, name FROM master_products WHERE category = 'unknown'");
      let fixed = 0;
      for (const row of unknowns.rows) {
        const n = (row.name || '').toLowerCase();
        for (const [cat, kws] of Object.entries(knownCats)) {
          if (kws.some(kw => n.includes(kw.toLowerCase()))) {
            await db.query('UPDATE master_products SET category = $1 WHERE id = $2', [cat, row.id]);
            fixed++;
            break;
          }
        }
      }

      // 2. 자동 학습 실행
      const clipRes = await db.query(`
        SELECT data_json->>'text' as text FROM events
        WHERE type = 'clipboard.change'
          AND timestamp::timestamptz > NOW() - INTERVAL '6 hours'
          AND data_json->>'text' IS NOT NULL AND LENGTH(data_json->>'text') > 5
      `);
      const existingNames = new Set(
        (await db.query('SELECT name FROM master_products UNION SELECT name_en FROM master_products WHERE name_en IS NOT NULL')).rows.map(r => r.name)
      );
      let learned = 0;
      for (const row of clipRes.rows) {
        const items = (row.text || '').match(/([A-Za-z][A-Za-z\s]{2,25})\s*:\s*[\d.]+/g) || [];
        for (const item of items) {
          const m = item.match(/([A-Za-z][A-Za-z\s]+?)\s*:/);
          if (m && !existingNames.has(m[1].trim())) {
            try {
              await db.query('INSERT INTO master_products (name, name_en, source) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING', [m[1].trim(), 'auto-evolve']);
              existingNames.add(m[1].trim());
              learned++;
            } catch {}
          }
        }
      }

      if (fixed > 0 || learned > 0) {
        console.log(`[self-evolve] 자가 진화: 분류 ${fixed}건, 학습 ${learned}건`);
      }
    } catch (err) {
      console.error('[self-evolve] 에러:', err.message);
    }
  }

  // 서버 시작 10분 후 첫 실행, 이후 6시간마다
  setTimeout(() => {
    _autoEvolve();
    setInterval(_autoEvolve, 6 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  console.log('[self-evolve] 자가 진화 엔진 시작 (6시간마다 자동 개선)');

  return router;
}

module.exports = createSelfEvolveRouter;
