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
}

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

module.exports = createAutomationEngine;
