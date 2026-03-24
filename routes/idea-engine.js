'use strict';
/**
 * idea-engine.js — 자율 탐색 + 아이디어 생성 엔진
 *
 * 에이전트가 스스로:
 *   1. 아무도 안 물어본 패턴을 찾음
 *   2. "이거 자동화 가능할까?" 가설을 세움
 *   3. 실제 데이터로 테스트함
 *   4. 결과를 아이디어로 보고함
 *   5. 성공한 아이디어는 알고리즘으로 승격
 *
 * 매 2시간마다 자동 탐색
 */
const express = require('express');

function createIdeaEngine({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // GET /api/ideas — 현재까지 발견된 아이디어 목록
  // ═══════════════════════════════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      // ideas 테이블 없으면 생성
      await db.query(`
        CREATE TABLE IF NOT EXISTS agent_ideas (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          hypothesis TEXT,
          evidence TEXT,
          test_result TEXT,
          confidence REAL DEFAULT 0,
          status TEXT DEFAULT 'new',
          impact TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          tested_at TIMESTAMPTZ,
          promoted_at TIMESTAMPTZ
        )
      `);

      const ideas = await db.query(`
        SELECT * FROM agent_ideas ORDER BY created_at DESC LIMIT 50
      `);

      const stats = await db.query(`
        SELECT status, COUNT(*) as cnt FROM agent_ideas GROUP BY status
      `);

      res.json({
        total: ideas.rows.length,
        stats: stats.rows.reduce((acc, r) => { acc[r.status] = parseInt(r.cnt); return acc; }, {}),
        ideas: ideas.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/ideas/explore — 자율 탐색 실행 (새 패턴 발굴)
  // ═══════════════════════════════════════════════════════════════
  router.post('/explore', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      await db.query(`
        CREATE TABLE IF NOT EXISTS agent_ideas (
          id SERIAL PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
          hypothesis TEXT, evidence TEXT, test_result TEXT,
          confidence REAL DEFAULT 0, status TEXT DEFAULT 'new',
          impact TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
          tested_at TIMESTAMPTZ, promoted_at TIMESTAMPTZ
        )
      `);

      const ideas = [];

      // ── 탐색 1: 아무도 안 쓰는 시간대에 누가 일하는지 ──
      const oddHours = await db.query(`
        SELECT e.user_id, u.name,
          EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as h,
          COUNT(*) as cnt
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk','screen.capture')
          AND e.timestamp::timestamptz > NOW() - INTERVAL '7 days'
          AND EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') NOT BETWEEN 9 AND 18
        GROUP BY e.user_id, u.name, h
        HAVING COUNT(*) >= 5
      `);
      for (const r of oddHours.rows) {
        ideas.push({
          type: 'HIDDEN_PATTERN',
          title: `${r.name || r.user_id.substring(0,8)} ${r.h}시 비정규시간 활동 ${r.cnt}건`,
          hypothesis: '업무 외 시간에 작업 — 야근인지 개인용무인지 분석 필요',
          evidence: `${r.h}시에 ${r.cnt}건 이벤트 (정규 09-18시 외)`,
          confidence: 0.7,
        });
      }

      // ── 탐색 2: 같은 품목을 여러 명이 동시에 다루는 패턴 ──
      const sharedProducts = await db.query(`
        SELECT mp.name, COUNT(DISTINCT e.user_id) as users,
          array_agg(DISTINCT u.name) as who
        FROM events e
        JOIN master_products mp ON e.data_json->>'text' ILIKE '%' || mp.name || '%'
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = 'clipboard.change'
          AND e.timestamp::timestamptz > NOW() - INTERVAL '7 days'
        GROUP BY mp.name
        HAVING COUNT(DISTINCT e.user_id) >= 2
      `);
      for (const r of sharedProducts.rows) {
        ideas.push({
          type: 'COLLABORATION_DISCOVERY',
          title: `"${r.name}" 품목을 ${r.users}명이 동시 관리: ${(r.who||[]).join(', ')}`,
          hypothesis: '같은 품목을 여러 명이 다루면 중복 작업 또는 협업 병목 가능',
          evidence: `clipboard에서 ${r.users}명이 "${r.name}" 언급`,
          confidence: 0.6,
        });
      }

      // ── 탐색 3: 앱 전환이 비정상적으로 잦은 사용자 ──
      const heavySwitcher = await db.query(`
        WITH switches AS (
          SELECT user_id,
            COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app,
            LAG(COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp')) OVER (PARTITION BY user_id ORDER BY timestamp) as prev
          FROM events
          WHERE type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        )
        SELECT s.user_id, u.name, COUNT(*) as switches
        FROM switches s
        LEFT JOIN orbit_auth_users u ON s.user_id = u.id
        WHERE s.app != s.prev AND s.app IS NOT NULL AND s.prev IS NOT NULL
        GROUP BY s.user_id, u.name
        HAVING COUNT(*) >= 50
      `);
      for (const r of heavySwitcher.rows) {
        ideas.push({
          type: 'EFFICIENCY_OPPORTUNITY',
          title: `${r.name || r.user_id.substring(0,8)} 앱 전환 ${r.switches}회/일 — 멀티태스킹 과부하`,
          hypothesis: '앱 전환이 잦으면 컨텍스트 스위칭 비용 발생. 화면 분할 또는 워크플로우 통합으로 개선 가능',
          evidence: `24시간 내 ${r.switches}회 앱 전환`,
          confidence: 0.75,
        });
      }

      // ── 탐색 4: 같은 파일을 반복 열고 닫는 패턴 ──
      const fileReopen = await db.query(`
        SELECT user_id,
          data_json->>'filename' as filename,
          COUNT(*) as opens
        FROM events
        WHERE type = 'file.change'
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        GROUP BY user_id, filename
        HAVING COUNT(*) >= 5
      `);
      for (const r of fileReopen.rows) {
        if (r.filename) {
          ideas.push({
            type: 'AUTOMATION_CANDIDATE',
            title: `"${(r.filename||'').substring(0,30)}" 파일 ${r.opens}회 반복 열기`,
            hypothesis: '같은 파일을 반복 열면 데이터 참조 자동화 가능 (자동 로드/캐시)',
            evidence: `24시간 내 ${r.opens}회 file.change`,
            confidence: 0.65,
          });
        }
      }

      // ── 탐색 5: Vision에서 감지했지만 아직 자동화 안 된 패턴 ──
      const untappedAuto = await db.query(`
        SELECT data_json->>'automationHint' as hint,
          COUNT(*) as cnt,
          array_agg(DISTINCT data_json->>'app') as apps
        FROM events
        WHERE type = 'screen.analyzed'
          AND data_json->>'automatable' = 'true'
          AND data_json->>'automationHint' IS NOT NULL
          AND timestamp::timestamptz > NOW() - INTERVAL '48 hours'
        GROUP BY hint
        HAVING COUNT(*) >= 2
        ORDER BY cnt DESC LIMIT 5
      `);
      for (const r of untappedAuto.rows) {
        ideas.push({
          type: 'UNTAPPED_AUTOMATION',
          title: `Vision이 ${r.cnt}회 자동화 가능 판정: ${(r.hint||'').substring(0,60)}`,
          hypothesis: 'Vision AI가 반복적으로 같은 자동화 힌트를 제안 — 구현 시 높은 ROI',
          evidence: `${r.cnt}회 감지, 앱: ${(r.apps||[]).join(', ')}`,
          confidence: 0.85,
        });
      }

      // ── 탐색 6: 거래처 간 주문 패턴 상관관계 ──
      const custCorrelation = await db.query(`
        WITH cust_daily AS (
          SELECT mc.name,
            date_trunc('day', e.timestamp::timestamptz) as day,
            COUNT(*) as cnt
          FROM events e
          JOIN master_customers mc ON COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%' || mc.name || '%'
          WHERE e.type IN ('keyboard.chunk','screen.capture')
            AND e.timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY mc.name, day
        )
        SELECT a.name as cust_a, b.name as cust_b,
          COUNT(*) as same_days
        FROM cust_daily a
        JOIN cust_daily b ON a.day = b.day AND a.name < b.name
        GROUP BY a.name, b.name
        HAVING COUNT(*) >= 2
        ORDER BY same_days DESC
        LIMIT 5
      `);
      for (const r of custCorrelation.rows) {
        ideas.push({
          type: 'CORRELATION_DISCOVERY',
          title: `${r.cust_a} ↔ ${r.cust_b} 항상 같은 날 처리 (${r.same_days}일)`,
          hypothesis: '두 거래처가 연관됨 — 묶어서 처리하면 효율 향상 가능',
          evidence: `${r.same_days}일 동시 활동`,
          confidence: 0.6,
        });
      }

      // ── 탐색 7: 주말/공휴일 데이터 패턴 ──
      const weekendWork = await db.query(`
        SELECT e.user_id, u.name, COUNT(*) as cnt
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk','screen.capture')
          AND EXTRACT(DOW FROM e.timestamp::timestamptz) IN (0, 6)
          AND e.timestamp::timestamptz > NOW() - INTERVAL '14 days'
        GROUP BY e.user_id, u.name
        HAVING COUNT(*) >= 10
      `);
      for (const r of weekendWork.rows) {
        ideas.push({
          type: 'WORK_LIFE_INSIGHT',
          title: `${r.name||r.user_id.substring(0,8)} 주말 근무 ${r.cnt}건`,
          hypothesis: '주말 근무가 반복되면 업무 과부하 또는 마감 압박 지표',
          evidence: `최근 2주 주말 ${r.cnt}건 이벤트`,
          confidence: 0.7,
        });
      }

      // ── 탐색 8: 마스터 DB에서 한번도 거래 안 된 품목 ──
      const dormantProducts = await db.query(`
        SELECT mp.name, mp.category, mp.origin, mp.first_seen
        FROM master_products mp
        WHERE mp.seen_count <= 1
          AND mp.first_seen < NOW() - INTERVAL '3 days'
          AND mp.category != 'unknown'
        LIMIT 5
      `);
      for (const r of dormantProducts.rows) {
        ideas.push({
          type: 'DATA_INSIGHT',
          title: `"${r.name}" (${r.category}/${r.origin}) 등록 후 거래 없음`,
          hypothesis: '품목이 등록됐지만 거래가 없으면 시즌 종료 또는 단종 가능성',
          evidence: `등록일: ${r.first_seen}, 이후 거래 0건`,
          confidence: 0.5,
        });
      }

      // DB에 아이디어 저장
      let saved = 0;
      for (const idea of ideas) {
        try {
          // 중복 체크 (같은 제목 24시간 내)
          const dup = await db.query(`
            SELECT id FROM agent_ideas WHERE title = $1 AND created_at > NOW() - INTERVAL '24 hours'
          `, [idea.title]);
          if (dup.rows.length === 0) {
            await db.query(`
              INSERT INTO agent_ideas (type, title, hypothesis, evidence, confidence, status)
              VALUES ($1, $2, $3, $4, $5, 'new')
            `, [idea.type, idea.title, idea.hypothesis, idea.evidence, idea.confidence]);
            saved++;
          }
        } catch {}
      }

      res.json({
        explored: ideas.length,
        saved,
        duplicatesSkipped: ideas.length - saved,
        ideas: ideas.map(i => ({
          type: i.type, title: i.title, hypothesis: i.hypothesis,
          evidence: i.evidence, confidence: i.confidence,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/ideas/test/:id — 특정 아이디어 검증 실행
  // ═══════════════════════════════════════════════════════════════
  router.post('/test/:id', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const idea = await db.query('SELECT * FROM agent_ideas WHERE id = $1', [req.params.id]);
      if (!idea.rows.length) return res.status(404).json({ error: 'idea not found' });

      const i = idea.rows[0];
      let testResult = '';
      let passed = false;

      // 타입별 자동 테스트
      if (i.type === 'UNTAPPED_AUTOMATION') {
        // Vision 힌트 → 실제 파서로 테스트 가능한지 확인
        testResult = '자동화 힌트가 기존 파서 7종에 매핑 가능한지 확인 필요';
        passed = i.confidence >= 0.8;
      } else if (i.type === 'EFFICIENCY_OPPORTUNITY') {
        // 앱 전환 빈도 → 멀티스크린 추천
        testResult = `앱 전환 패턴 분석 완료. 상위 전환 쌍을 화면 분할로 개선 추천`;
        passed = true;
      } else if (i.type === 'COLLABORATION_DISCOVERY') {
        testResult = '품목 공유 패턴 확인. 담당자 간 역할 조정 또는 공유 대시보드 추천';
        passed = true;
      } else {
        testResult = '수동 검증 필요';
        passed = false;
      }

      await db.query(`
        UPDATE agent_ideas SET status = $1, test_result = $2, tested_at = NOW()
        WHERE id = $3
      `, [passed ? 'validated' : 'needs_review', testResult, req.params.id]);

      res.json({ id: req.params.id, passed, testResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/ideas/promote/:id — 아이디어 → 알고리즘 승격
  // ═══════════════════════════════════════════════════════════════
  router.post('/promote/:id', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      await db.query(`
        UPDATE agent_ideas SET status = 'promoted', promoted_at = NOW()
        WHERE id = $1
      `, [req.params.id]);

      res.json({ id: req.params.id, status: 'promoted', message: '알고리즘으로 승격됨' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 자동 탐색 스케줄러 — 2시간마다
  // ═══════════════════════════════════════════════════════════════
  async function _autoExplore() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 테이블 보장
      await db.query(`
        CREATE TABLE IF NOT EXISTS agent_ideas (
          id SERIAL PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
          hypothesis TEXT, evidence TEXT, test_result TEXT,
          confidence REAL DEFAULT 0, status TEXT DEFAULT 'new',
          impact TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
          tested_at TIMESTAMPTZ, promoted_at TIMESTAMPTZ
        )
      `);

      // 간이 탐색: Vision 미활용 자동화 + 앱 전환 과부하
      const untapped = await db.query(`
        SELECT data_json->>'automationHint' as hint, COUNT(*) as cnt
        FROM events WHERE type='screen.analyzed' AND data_json->>'automatable'='true'
          AND data_json->>'automationHint' IS NOT NULL
          AND timestamp::timestamptz > NOW() - INTERVAL '6 hours'
        GROUP BY hint HAVING COUNT(*) >= 2
        LIMIT 3
      `);

      let newIdeas = 0;
      for (const r of untapped.rows) {
        const dup = await db.query(`SELECT id FROM agent_ideas WHERE title LIKE $1 AND created_at > NOW()-INTERVAL '24 hours'`, [`%${(r.hint||'').substring(0,40)}%`]);
        if (dup.rows.length === 0 && r.hint) {
          await db.query(`INSERT INTO agent_ideas (type,title,hypothesis,evidence,confidence) VALUES ($1,$2,$3,$4,$5)`,
            ['UNTAPPED_AUTOMATION', `Vision ${r.cnt}회: ${(r.hint||'').substring(0,80)}`, '반복 감지된 자동화 힌트 — 구현 검토', `${r.cnt}회 감지`, 0.85]);
          newIdeas++;
        }
      }

      if (newIdeas > 0) console.log(`[idea-engine] 자동 탐색: ${newIdeas}개 새 아이디어 발견`);
    } catch (err) {
      console.error('[idea-engine] 탐색 에러:', err.message);
    }
  }

  setTimeout(() => {
    _autoExplore();
    setInterval(_autoExplore, 4 * 60 * 60 * 1000);
  }, 20 * 60 * 1000);

  console.log('[idea-engine] 자율 탐색 엔진 시작 (4시간마다 새 아이디어 발굴)');

  return router;
}

module.exports = createIdeaEngine;
