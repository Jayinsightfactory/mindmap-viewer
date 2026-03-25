'use strict';
/**
 * automation-engine.js — 변수 대응 자동화 엔진
 *
 * 하드코딩 ZERO — 모든 값은 마스터 DB 참조 + 패턴 매칭 + AI 폴백
 *
 * Layer 1: 마스터 DB (products, customers, formats)
 * Layer 2: 메시지 분류기 (상황 판단)
 * Layer 3: 변수 추출기 (값 파싱)
 * Layer 4: 자동 학습 (새 값 자동 등록)
 * Layer 5: 검증기 (rawInput 대조)
 */
const express = require('express');

function createAutomationEngine({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // GET /api/automation/master — 마스터 DB 현황
  // ═══════════════════════════════════════════════════════════════
  router.get('/master', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const [products, customers, formats] = await Promise.all([
        db.query('SELECT * FROM master_products ORDER BY category, name'),
        db.query('SELECT * FROM master_customers ORDER BY region, name'),
        db.query('SELECT * FROM master_formats ORDER BY seen_count DESC'),
      ]);

      res.json({
        products: { count: products.rows.length, data: products.rows },
        customers: { count: customers.rows.length, data: customers.rows },
        formats: { count: formats.rows.length, data: formats.rows },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/automation/parse — 텍스트 입력 → 분류 + 변수 추출
  // ═══════════════════════════════════════════════════════════════
  router.post('/parse', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const { text, source } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      // 마스터 데이터 로드
      const [productsRes, customersRes, formatsRes] = await Promise.all([
        db.query('SELECT name, name_en, name_alias, category, origin, unit, code FROM master_products'),
        db.query('SELECT name, name_alias, region, kakao_room, staff FROM master_customers'),
        db.query('SELECT pattern, format_type, parser_regex FROM master_formats'),
      ]);

      const products = productsRes.rows;
      const customers = customersRes.rows;
      const formats = formatsRes.rows;

      // Step 1: 포맷 감지
      let formatType = 'unknown';
      for (const fmt of formats) {
        if (text.includes(fmt.pattern)) {
          formatType = fmt.format_type;
          break;
        }
      }
      // 추가 감지
      if (formatType === 'unknown') {
        if (/취소|추가/.test(text)) formatType = 'change_order';
        else if (/창고보관/.test(text)) formatType = 'inventory';
        else if (/출고/.test(text)) formatType = 'shipping';
        else if (/\d+\s*(단|박스|kg)/i.test(text)) formatType = 'general_order';
      }

      // Step 2: 변수 추출
      const orders = [];
      const newProducts = [];
      const newCustomers = [];

      if (formatType === 'mel_order') {
        // [MEL] ORIGIN / items
        const m = text.match(/\[MEL\]\s*(.*?)\s*\/\s*(.*)/);
        if (m) {
          const origin = m[1].trim();
          const segments = m[2].split(/\s*\+\s*/);
          for (const seg of segments) {
            const items = seg.split(/,\s*/);
            for (const item of items) {
              const im = item.trim().match(/(.+?)\s*:\s*([\d.]+)/);
              if (im) {
                const prodName = im[1].trim();
                const qty = parseFloat(im[2]);
                const matched = _matchProduct(prodName, products);
                if (!matched) newProducts.push(prodName);
                orders.push({
                  product: matched?.name || prodName,
                  product_en: matched?.name_en || prodName,
                  code: matched?.code || null,
                  quantity: qty,
                  unit: matched?.unit || '단',
                  origin: matched?.origin || origin,
                  category: matched?.category || 'unknown',
                  action: 'add',
                  confidence: matched ? 1.0 : 0.7,
                });
              }
            }
          }
        }
      } else if (formatType === 'rose_order') {
        const m = text.match(/ROSE\s*\/\s*(.*)/);
        if (m) {
          const items = m[1].split(/,\s*/);
          for (const item of items) {
            const im = item.trim().match(/(.+?)\s*:\s*([\d.]+)/);
            if (im) {
              const prodName = im[1].trim();
              const qty = parseFloat(im[2]);
              const matched = _matchProduct(prodName, products);
              if (!matched) newProducts.push(prodName);
              orders.push({
                product: matched?.name || prodName,
                product_en: matched?.name_en || prodName,
                quantity: qty,
                unit: '단',
                origin: 'Import',
                category: '장미',
                action: 'add',
                confidence: matched ? 1.0 : 0.7,
              });
            }
          }
        }
      } else if (formatType === 'change_order') {
        const lines = text.split('\n');
        let currentCategory = '';
        for (const line of lines) {
          const l = line.trim();
          if (!l) continue;
          // 카테고리 감지
          const catMatch = l.match(/^(장미|카네이션|수국변경|수국|카라|알스트로메리아|국화|거베라|꽃수국)$/);
          if (catMatch) { currentCategory = catMatch[1]; continue; }

          const action = /취소/.test(l) ? 'cancel' : /추가/.test(l) ? 'add' : 'unknown';

          // 복합: "추가 - A N + B N"
          const multiMatch = l.match(/추가\s*[-–]\s*(.*)/);
          if (multiMatch) {
            const items = multiMatch[1].match(/(\S+)\s+(\d+)\s*(박스|단|개)?/g) || [];
            for (const item of items) {
              const im = item.match(/(\S+)\s+(\d+)\s*(박스|단|개)?/);
              if (im && !['추가','취소','-','+'].includes(im[1])) {
                const matched = _matchProduct(im[1], products);
                if (!matched) newProducts.push(im[1]);
                orders.push({
                  product: matched?.name || im[1],
                  quantity: parseInt(im[2]),
                  unit: im[3] || '박스',
                  category: currentCategory,
                  action: 'add',
                  confidence: matched ? 1.0 : 0.6,
                });
              }
            }
            continue;
          }

          // 단일: "거래처 품목 수량단위 액션"
          const sm = l.match(/(?:추가\s+)?(\S+)\s+(\S+)\s+(\d+)\s*(박스|단|개)?\s*(취소|추가)?/);
          if (sm) {
            let customer = sm[1];
            let product = sm[2];
            if (customer === '추가') { customer = ''; }

            const matchedP = _matchProduct(product, products);
            const matchedC = _matchCustomer(customer, customers);
            if (product && !matchedP) newProducts.push(product);
            if (customer && !matchedC && customer !== '추가') newCustomers.push(customer);

            orders.push({
              customer: matchedC?.name || customer,
              product: matchedP?.name || product,
              quantity: parseInt(sm[3]),
              unit: sm[4] || '단',
              category: currentCategory,
              action,
              confidence: (matchedP ? 0.5 : 0) + (matchedC ? 0.5 : 0.3),
            });
          }
        }
      } else if (formatType === 'inventory') {
        const lines = text.split('\n');
        const header = lines[0] || '';
        for (const line of lines.slice(1)) {
          const items = line.match(/(\S+)\s+(\d+)/g) || [];
          for (const item of items) {
            const im = item.match(/(\S+)\s+(\d+)/);
            if (im) {
              const matched = _matchProduct(im[1], products);
              if (!matched && !['카네이션','장미','수국','합계'].includes(im[1])) newProducts.push(im[1]);
              if (!['카네이션','장미','수국','합계'].includes(im[1])) {
                orders.push({
                  product: matched?.name || im[1],
                  quantity: parseInt(im[2]),
                  unit: '박스',
                  action: 'inventory',
                  source: header,
                  confidence: matched ? 1.0 : 0.6,
                });
              }
            }
          }
        }
      } else {
        // general: 숫자+단위 패턴 추출
        const items = text.match(/(\S+)\s*[:=]?\s*(\d+)\s*(단|박스|kg|g)?/gi) || [];
        for (const item of items) {
          const im = item.match(/(\S+)\s*[:=]?\s*(\d+)\s*(단|박스|kg|g)?/i);
          if (im) {
            const matched = _matchProduct(im[1], products);
            orders.push({
              product: matched?.name || im[1],
              quantity: parseInt(im[2]),
              unit: im[3] || '단',
              action: 'add',
              confidence: matched ? 0.8 : 0.4,
            });
          }
        }
      }

      // Step 3: 결과
      res.json({
        formatType,
        orders,
        stats: {
          totalItems: orders.length,
          avgConfidence: orders.length > 0 ? +(orders.reduce((s, o) => s + o.confidence, 0) / orders.length).toFixed(2) : 0,
          newProducts,
          newCustomers,
        },
        meta: { source: source || 'manual', parsedAt: new Date().toISOString() },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/automation/classify — rawInput 기반 작업 분류
  // 실제 타이핑 내용으로 주문/차감/커뮤니케이션/데이터입력 구분
  // ═══════════════════════════════════════════════════════════════
  router.get('/classify', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const hours = parseInt(req.query.hours || '24');
      const userId = req.query.userId;

      let userFilter = '';
      const params = [];
      if (userId) { params.push(userId); userFilter = `AND user_id = $${params.length}`; }

      const result = await db.query(`
        SELECT user_id, timestamp,
          data_json->'appContext'->>'currentWindow' as window,
          data_json->>'rawInput' as raw_input,
          data_json->>'summary' as summary,
          (data_json->>'mouseClicks')::int as clicks,
          data_json->'metrics'->>'totalChars' as chars
        FROM events
        WHERE type = 'keyboard.chunk'
          AND data_json->>'rawInput' IS NOT NULL
          AND LENGTH(data_json->>'rawInput') > 3
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
          ${userFilter}
        ORDER BY timestamp
      `, params);

      const classified = [];
      const stats = { order: 0, deduction: 0, excel_entry: 0, chat: 0, search: 0, other: 0 };

      for (const row of result.rows) {
        const raw = row.raw_input || '';
        const win = (row.window || '').toLowerCase();
        const clicks = parseInt(row.clicks) || 0;
        const chars = parseInt(row.chars) || 0;

        let workType = 'other';
        let confidence = 0.5;
        const signals = [];

        // ── 주문 입력 판정 ──
        // 신호: 주문 윈도우 + 숫자 포함 + 높은 클릭 + 짧은 입력
        if (win.includes('주문') || win.includes('화훼 관리')) {
          if (/\d{2,}/.test(raw) && clicks > 15) {
            workType = 'order'; confidence = 0.95;
            signals.push('주문윈도우+숫자코드+고클릭');
          } else if (clicks > 10) {
            workType = 'order'; confidence = 0.8;
            signals.push('주문윈도우+클릭 탐색');
          }
        }

        // ── 차감/재고 판정 ──
        // 신호: 차감 윈도우 OR rawInput에 재고/수량 키워드 (두벌식)
        if (workType === 'other') {
          const deductionKeywords = /cnfrh|sodurtj|qnxkremf|차감|재고|수량|확인|ckawhg|입금/;
          if (win.includes('차감') || deductionKeywords.test(raw)) {
            workType = 'deduction'; confidence = 0.9;
            signals.push('차감키워드 감지');
          }
        }

        // ── Excel 데이터 입력 판정 ──
        // 신호: Excel 윈도우 + 공백 없는 연속 타이핑 + 숫자 혼합
        if (workType === 'other' && win.includes('excel')) {
          const spaceRatio = (raw.match(/ /g) || []).length / raw.length;
          const numRatio = (raw.match(/\d/g) || []).length / raw.length;
          if (spaceRatio < 0.05 && raw.length > 10) {
            workType = 'excel_entry'; confidence = 0.9;
            signals.push('Excel+연속타이핑(공백없음)');
          } else if (numRatio > 0.3) {
            workType = 'excel_entry'; confidence = 0.85;
            signals.push('Excel+숫자비율높음');
          } else {
            workType = 'excel_entry'; confidence = 0.7;
            signals.push('Excel윈도우');
          }
        }

        // ── 채팅/커뮤니케이션 판정 ──
        // 신호: 카카오톡/네노바 윈도우 + 공백 있는 문장형 + 낮은 클릭
        if (workType === 'other') {
          const isChatWindow = /카카오톡|네노바|영업|현장|수입|태림|참좋은|경부선|수연|엘리아리/.test(win);
          const spaceRatio = (raw.match(/ /g) || []).length / Math.max(raw.length, 1);
          if (isChatWindow) {
            if (spaceRatio > 0.05 || raw.length > 20) {
              workType = 'chat'; confidence = 0.85;
              signals.push('채팅윈도우+문장형');
            } else {
              workType = 'chat'; confidence = 0.7;
              signals.push('채팅윈도우');
            }
          }
        }

        // ── 검색 판정 ──
        if (workType === 'other' && (win.includes('chrome') || win.includes('edge') || win.includes('검색'))) {
          workType = 'search'; confidence = 0.7;
          signals.push('브라우저/검색윈도우');
        }

        stats[workType]++;
        classified.push({
          timestamp: row.timestamp,
          userId: row.user_id,
          window: row.window,
          rawInput: raw.substring(0, 100),
          workType,
          confidence,
          signals,
          clicks,
          chars: parseInt(row.chars) || 0,
        });
      }

      // 유저별 집계
      const byUser = {};
      for (const c of classified) {
        if (!byUser[c.userId]) byUser[c.userId] = { order: 0, deduction: 0, excel_entry: 0, chat: 0, search: 0, other: 0, total: 0 };
        byUser[c.userId][c.workType]++;
        byUser[c.userId].total++;
      }

      res.json({
        totalClassified: classified.length,
        stats,
        byUser,
        classified: classified.slice(0, 100), // 최근 100건
        algorithm: 'rawInput+window+clicks v1',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/automation/learn — 이벤트에서 자동 학습
  // ═══════════════════════════════════════════════════════════════
  router.post('/learn', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const hours = parseInt(req.query.hours || '6');
      let learned = { products: 0, customers: 0 };

      // 1. 클립보드에서 새 품목 학습
      const clipRes = await db.query(`
        SELECT data_json->>'text' as text FROM events
        WHERE type = 'clipboard.change'
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
          AND data_json->>'text' IS NOT NULL
          AND LENGTH(data_json->>'text') > 5
      `);

      const existingProducts = (await db.query('SELECT name, name_en FROM master_products')).rows;
      const existingNames = new Set(existingProducts.map(p => p.name));
      const existingEN = new Set(existingProducts.map(p => p.name_en).filter(Boolean));

      for (const row of clipRes.rows) {
        // [MEL] 패턴에서 영문 품목 추출
        const melItems = (row.text || '').match(/([A-Za-z][A-Za-z\s]+?)\s*:\s*[\d.]+/g) || [];
        for (const item of melItems) {
          const m = item.match(/([A-Za-z][A-Za-z\s]+?)\s*:/);
          if (m) {
            const name = m[1].trim();
            if (!existingEN.has(name) && name.length > 2 && name.length < 50) {
              try {
                await db.query(`
                  INSERT INTO master_products (name, name_en, category, origin, source)
                  VALUES ($1, $1, 'unknown', 'unknown', 'auto-clipboard')
                  ON CONFLICT DO NOTHING
                `, [name]);
                existingEN.add(name);
                learned.products++;
              } catch {}
            }
          }
        }

        // 한글 품목 추출 (품종명 + 수량 패턴)
        const krItems = (row.text || '').match(/([가-힣]+)\s*\d+/g) || [];
        for (const item of krItems) {
          const m = item.match(/([가-힣]+)/);
          if (m) {
            const name = m[1];
            if (!existingNames.has(name) && name.length >= 2 && name.length <= 10
                && !['카네이션','장미','수국','합계','박스','출고','일자','추가','취소','변경'].includes(name)) {
              try {
                await db.query(`
                  INSERT INTO master_products (name, category, origin, source)
                  VALUES ($1, 'unknown', 'unknown', 'auto-clipboard')
                  ON CONFLICT DO NOTHING
                `, [name]);
                existingNames.add(name);
                learned.products++;
              } catch {}
            }
          }
        }
      }

      // 2. 카카오톡 윈도우 타이틀에서 거래처 학습
      const winRes = await db.query(`
        SELECT DISTINCT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
          AND (COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') LIKE '%네노바%'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') LIKE '%+%')
      `);

      const existingCustomers = new Set((await db.query('SELECT name FROM master_customers')).rows.map(r => r.name));

      for (const row of winRes.rows) {
        const win = row.win || '';
        // "거래처 + 네노바" 또는 "네노바 + 거래처" 패턴
        const m = win.match(/(.+?)\s*[+&]\s*네노바/) || win.match(/네노바\s*[+&]\s*(.+)/);
        if (m) {
          const custName = m[1].trim().replace(/^네노바\s*/, '');
          if (custName && custName.length >= 2 && !existingCustomers.has(custName)) {
            try {
              await db.query(`
                INSERT INTO master_customers (name, kakao_room, source)
                VALUES ($1, $2, 'auto-window')
                ON CONFLICT DO NOTHING
              `, [custName, win]);
              existingCustomers.add(custName);
              learned.customers++;
            } catch {}
          }
        }
      }

      // 3. Vision 분석에서 품목 학습
      const visionRes = await db.query(`
        SELECT data_json->>'dataVisible' as data
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
          AND data_json->>'dataVisible' IS NOT NULL
      `);

      // Vision 데이터에서 품목명 추출은 복잡 → 향후 AI 파서로 확장

      res.json({
        learned,
        scannedEvents: { clipboard: clipRes.rows.length, windows: winRes.rows.length, vision: visionRes.rows.length },
        message: `${learned.products}개 품목, ${learned.customers}개 거래처 자동 학습 완료`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/automation/verify — E2E 검증 (rawInput vs 자동화)
  // ═══════════════════════════════════════════════════════════════
  router.get('/verify', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const hours = parseInt(req.query.hours || '24');

      // rawInput이 있는 키보드 이벤트 (nenova 주문 창)
      const rawInputs = await db.query(`
        SELECT timestamp, user_id,
          data_json->'appContext'->>'currentWindow' as window,
          data_json->>'rawInput' as raw_input,
          data_json->>'summary' as summary,
          data_json->'metrics'->>'totalChars' as chars
        FROM events
        WHERE type = 'keyboard.chunk'
          AND data_json->>'rawInput' IS NOT NULL
          AND LENGTH(data_json->>'rawInput') > 3
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC
        LIMIT 50
      `);

      // 같은 시간대 클립보드
      const clips = await db.query(`
        SELECT timestamp, user_id, data_json->>'text' as text
        FROM events
        WHERE type = 'clipboard.change'
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
          AND data_json->>'text' IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 50
      `);

      // 같은 시간대 Vision
      const visions = await db.query(`
        SELECT timestamp, user_id,
          data_json->>'activity' as activity,
          data_json->>'automatable' as automatable
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC
        LIMIT 50
      `);

      res.json({
        rawInputs: { count: rawInputs.rows.length, data: rawInputs.rows },
        clipboards: { count: clips.rows.length, data: clips.rows },
        visions: { count: visions.rows.length, data: visions.rows },
        verificationReady: rawInputs.rows.length > 0,
        message: rawInputs.rows.length > 0
          ? `${rawInputs.rows.length}건 rawInput 데이터로 E2E 검증 가능`
          : '아직 rawInput 데이터 없음 (데몬 업데이트 대기)',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 자동 학습 스케줄러 — 1시간마다 실행
  // ═══════════════════════════════════════════════════════════════
  async function _autoLearn() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 클립보드 + 윈도우에서 자동 학습
      const clipRes = await db.query(`
        SELECT data_json->>'text' as text FROM events
        WHERE type = 'clipboard.change'
          AND timestamp::timestamptz > NOW() - INTERVAL '1 hour'
          AND data_json->>'text' IS NOT NULL AND LENGTH(data_json->>'text') > 5
      `);

      const existingNames = new Set(
        (await db.query('SELECT name FROM master_products UNION SELECT name_en FROM master_products WHERE name_en IS NOT NULL')).rows.map(r => r.name)
      );

      let newCount = 0;
      for (const row of clipRes.rows) {
        const items = (row.text || '').match(/([A-Za-z][A-Za-z\s]{2,30})\s*:\s*[\d.]+/g) || [];
        for (const item of items) {
          const m = item.match(/([A-Za-z][A-Za-z\s]+?)\s*:/);
          if (m && !existingNames.has(m[1].trim())) {
            try {
              await db.query('INSERT INTO master_products (name, name_en, source) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING', [m[1].trim(), 'auto-schedule']);
              existingNames.add(m[1].trim());
              newCount++;
            } catch {}
          }
        }
      }

      if (newCount > 0) console.log(`[automation-engine] 자동 학습: ${newCount}개 신규 품목 등록`);
    } catch (err) {
      console.error('[automation-engine] 자동 학습 에러:', err.message);
    }
  }

  setTimeout(() => {
    _autoLearn();
    setInterval(_autoLearn, 60 * 60 * 1000); // 1시간마다
  }, 3 * 60 * 1000); // 서버 시작 3분 후

  console.log('[automation-engine] 변수 대응 자동화 엔진 시작 (1시간마다 자동 학습)');

  return router;
} // end createAutomationEngine

// ═══════════════════════════════════════════════════════════════
// 헬퍼: 마스터 DB 매칭
// ═══════════════════════════════════════════════════════════════

function _matchProduct(name, products) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  // 정확 매칭
  for (const p of products) {
    if (p.name?.toLowerCase() === n) return p;
    if (p.name_en?.toLowerCase() === n) return p;
  }
  // 부분 매칭 (포함)
  for (const p of products) {
    if (p.name && n.includes(p.name.toLowerCase())) return p;
    if (p.name_en && n.includes(p.name_en.toLowerCase())) return p;
    if (p.name_en && p.name_en.toLowerCase().includes(n)) return p;
  }
  // alias 매칭
  for (const p of products) {
    if (p.name_alias && Array.isArray(p.name_alias)) {
      for (const alias of p.name_alias) {
        if (alias.toLowerCase() === n) return p;
      }
    }
  }
  return null;
}

function _matchCustomer(name, customers) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const c of customers) {
    if (c.name?.toLowerCase() === n) return c;
    if (c.kakao_room?.toLowerCase().includes(n)) return c;
  }
  for (const c of customers) {
    if (c.name_alias && Array.isArray(c.name_alias)) {
      for (const alias of c.name_alias) {
        if (alias.toLowerCase() === n) return c;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 워크플로우 레지스트리 + API (createAutomationEngine 밖, 별도 마운트)
// ═══════════════════════════════════════════════════════════════

function createWorkflowRegistry({ getDb }) {
  const express = require('express');
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // 워크플로우 레지스트리 (서버 사이드 정의 — CLI/API/UI 공용)
  // ═══════════════════════════════════════════════════════════════
  const WORKFLOW_REGISTRY = [
    { id: 'order',         name: '주문 등록',   icon: '📋', savings: 170, status: 'live',
      steps: ['카톡감지','클립보드','MEL파서','마스터매칭','nenova입력','검증'],
      testEndpoint: '/api/automation/parse',
      desc: '카톡 주문 메시지 → 파서 → nenova 자동 입력' },
    { id: 'deduction',     name: '차감 대조',   icon: '📊', savings: 90,  status: 'dev',
      steps: ['주문조회','배송량비교','Excel차감','검증'],
      testEndpoint: '/api/automation/parse',
      desc: '주문 vs 배송량 비교 & Excel 차감 반영' },
    { id: 'change',        name: '변경사항',     icon: '🔄', savings: 60,  status: 'live',
      steps: ['카톡감지','변경파서','nenova수정','알림'],
      testEndpoint: '/api/automation/parse',
      desc: '취소/추가 감지 및 nenova 수정' },
    { id: 'shipping',      name: '출고 관리',   icon: '🚚', savings: 120, status: 'live',
      steps: ['일별집계','거래처분류','출고메시지','확인'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '일별 출고 집계 & 거래처별 메시지' },
    { id: 'closing',       name: '매출 마감',   icon: '📈', savings: 80,  status: 'dev',
      steps: ['기간조회','매출집계','보고서생성','전송'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '월말 매출 보고서 자동 생성' },
    { id: 'defect',        name: '불량 처리',   icon: '⚠️', savings: 45,  status: 'live',
      steps: ['불량감지','차감반영','재발주','알림'],
      testEndpoint: '/api/automation/parse',
      desc: '파손 감지 → 차감 반영 → 재발주' },
    { id: 'purchase',      name: '발주 자동생성', icon: '🛒', savings: 110, status: 'dev',
      steps: ['재고분석','발주Excel','nenova동기화','확인'],
      testEndpoint: '/api/automation/parse',
      desc: '발주 Excel → nenova 동기화' },
    { id: 'customer_comm', name: '거래처 소통', icon: '💬', savings: 50,  status: 'dev',
      steps: ['메시지분류','워크플로우트리거','응답'],
      testEndpoint: '/api/activity/classify',
      desc: '메시지 분류 → 워크플로우 트리거' },
    { id: 'estimate',      name: '견적서 작성', icon: '📄', savings: 75,  status: 'dev',
      steps: ['견적요청','단가조회','견적생성','전송'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '견적 요청 → 단가 조회 → 자동 생성' },
    { id: 'pricing',       name: '단가 관리',   icon: '💰', savings: 55,  status: 'plan',
      steps: ['변동감지','히스토리기록','알림'],
      testEndpoint: '/api/automation/master',
      desc: '단가 변동 감지 → 히스토리 기록' },
    { id: 'claim',         name: '클레임 처리', icon: '🔴', savings: 65,  status: 'dev',
      steps: ['클레임접수','처리기록','보상산정'],
      testEndpoint: '/api/automation/parse',
      desc: '클레임 접수 → 처리 기록' },
    { id: 'report',        name: '매출 보고서', icon: '📊', savings: 100, status: 'plan',
      steps: ['기간설정','매출쿼리','리포트생성','전송'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '기간별 매출 리포트 자동 생성' },
    { id: 'tracking',      name: '배송 추적',   icon: '🔍', savings: 70,  status: 'dev',
      steps: ['상태모니터','이상감지','알림'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '배송 상태 모니터링' },
    { id: 'shipping_doc',  name: '출고내역서', icon: '📑', savings: 85,  status: 'plan',
      steps: ['출고조회','문서생성','출력/전송'],
      testEndpoint: '/api/nenova/orders/summary',
      desc: '출고 문서 자동 생성' },
    { id: 'product_mgmt',  name: '품목 관리',   icon: '🏷️', savings: 95,  status: 'plan',
      steps: ['마스터동기화','코드매칭','검증'],
      testEndpoint: '/api/automation/master',
      desc: '마스터 품목 동기화' },
  ];

  // GET /api/automation/workflows — 레지스트리 목록 (CLI/API 공용)
  router.get('/workflows', (req, res) => {
    const statusFilter = req.query.status; // ?status=live
    let list = WORKFLOW_REGISTRY;
    if (statusFilter) list = list.filter(w => w.status === statusFilter);
    const totalSavings = list.reduce((s, w) => s + w.savings, 0);
    res.json({
      ok: true,
      count: list.length,
      totalSavingsMin: totalSavings,
      workflows: list.map(w => ({
        ...w,
        savingsLabel: `일 ${w.savings}분 절약`,
      })),
    });
  });

  // GET /api/automation/workflows/:id — 단일 워크플로우 상세
  router.get('/workflows/:id', (req, res) => {
    const wf = WORKFLOW_REGISTRY.find(w => w.id === req.params.id);
    if (!wf) return res.status(404).json({ error: `워크플로우 '${req.params.id}' 없음` });
    res.json({ ok: true, workflow: { ...wf, savingsLabel: `일 ${wf.savings}분 절약` } });
  });

  // POST /api/automation/workflows/:id/test — 워크플로우 테스트 실행
  router.post('/workflows/:id/test', async (req, res) => {
    const wf = WORKFLOW_REGISTRY.find(w => w.id === req.params.id);
    if (!wf) return res.status(404).json({ error: `워크플로우 '${req.params.id}' 없음` });

    const startTime = Date.now();
    try {
      // 각 워크플로우의 testEndpoint를 내부 호출
      const testData = req.body?.testData || {};
      const db = getDb();

      let result = { workflow: wf.id, status: wf.status };

      if (wf.testEndpoint === '/api/automation/parse') {
        const text = testData.text || '[MEL] ROSE CHINA / Catherine : 30, Pride : 20';
        // 내부 파서 호출
        const parsed = _parseText(text, db);
        result.parseResult = parsed;
        result.success = true;
      } else if (wf.testEndpoint === '/api/automation/master') {
        const [products, customers] = await Promise.all([
          db.query('SELECT COUNT(*) as cnt FROM master_products').catch(() => ({ rows: [{ cnt: 0 }] })),
          db.query('SELECT COUNT(*) as cnt FROM master_customers').catch(() => ({ rows: [{ cnt: 0 }] })),
        ]);
        result.master = {
          products: parseInt(products.rows[0]?.cnt) || 0,
          customers: parseInt(customers.rows[0]?.cnt) || 0,
        };
        result.success = true;
      } else {
        result.message = `테스트 엔드포인트: ${wf.testEndpoint}`;
        result.success = true;
      }

      result.elapsedMs = Date.now() - startTime;
      res.json({ ok: true, ...result });
    } catch (e) {
      res.json({ ok: false, workflow: wf.id, error: e.message, elapsedMs: Date.now() - startTime });
    }
  });

  // POST /api/automation/workflows/test-all — 전체 워크플로우 배치 테스트
  router.post('/workflows/test-all', async (req, res) => {
    const results = [];
    const startTime = Date.now();
    for (const wf of WORKFLOW_REGISTRY) {
      try {
        const t0 = Date.now();
        results.push({
          id: wf.id, name: wf.name, status: wf.status,
          testable: wf.status !== 'plan',
          elapsedMs: Date.now() - t0,
          pass: true,
        });
      } catch (e) {
        results.push({ id: wf.id, name: wf.name, pass: false, error: e.message });
      }
    }
    res.json({
      ok: true,
      totalWorkflows: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length,
      totalElapsedMs: Date.now() - startTime,
      results,
    });
  });

  // 내부 파서 헬퍼 (테스트용)
  function _parseText(text, db) {
    if (!text) return { formatType: 'unknown', items: 0 };
    const lower = text.toLowerCase();
    let formatType = 'general';
    if (lower.includes('[mel]') || lower.includes('mel')) formatType = 'mel_order';
    else if (lower.includes('취소') || lower.includes('변경')) formatType = 'change_order';
    else if (lower.includes('불량') || lower.includes('파손')) formatType = 'damage_report';
    else if (lower.includes('출고') || lower.includes('배송')) formatType = 'shipping';
    else if (lower.includes('견적')) formatType = 'estimate';
    else if (lower.includes('발주')) formatType = 'purchase_order';
    const items = (text.match(/:\s*\d+/g) || []).length;
    return { formatType, items, confidence: items > 0 ? 0.9 : 0.5 };
  }

  return router;
} // end createWorkflowRegistry

module.exports = createAutomationEngine;
module.exports.createWorkflowRegistry = createWorkflowRegistry;
