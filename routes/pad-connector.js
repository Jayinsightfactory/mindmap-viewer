'use strict';
/**
 * pad-connector.js — Power Automate Desktop (PAD) 커넥터 + nenova ERP 자동화
 *
 * nenova 데스크톱 앱 자동화를 위한 PAD 플로우 생성, 실행 큐, 결과 수집
 * PAD 불가 시 pyautogui 스크립트 대안 제공
 *
 * 엔드포인트:
 *   GET  /api/pad/status           — PAD 연결 상태
 *   POST /api/pad/flow/generate    — PAD 플로우 JSON 생성
 *   GET  /api/pad/selectors        — nenova UI 셀렉터 정의
 *   POST /api/pad/execute          — 자동화 액션 큐잉
 *   GET  /api/pad/queue            — 대기 중 액션 목록
 *   POST /api/pad/result           — 실행 결과 보고 (직원 PC → 서버)
 *   GET  /api/pad/scripts          — 자동화 스크립트 목록
 *   POST /api/pad/scripts/generate — pyautogui 스크립트 생성
 *   GET  /api/pad/mouse-map        — 학습된 마우스 좌표 맵
 */
const express = require('express');

function createPadConnectorRouter({ getDb }) {
  const router = express.Router();

  // ── 테이블 초기화 ──
  async function _ensureTables(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS pad_queue (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        params JSONB DEFAULT '{}',
        target_pc TEXT,
        status TEXT DEFAULT 'pending',
        priority INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        executed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        result JSONB,
        error_message TEXT
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS pad_scripts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        action TEXT NOT NULL,
        script_type TEXT DEFAULT 'pyautogui',
        script_content TEXT,
        description TEXT,
        target_app TEXT DEFAULT 'nenova',
        mouse_coords JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS pad_mouse_map (
        id SERIAL PRIMARY KEY,
        element_name TEXT NOT NULL,
        window_title TEXT,
        x INT,
        y INT,
        width INT,
        height INT,
        confidence REAL DEFAULT 0,
        source TEXT DEFAULT 'learned',
        sample_count INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(element_name, window_title)
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_pad_queue_status ON pad_queue(status)
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  // nenova UI 셀렉터 정의
  // ═══════════════════════════════════════════════════════════════
  const NENOVA_SELECTORS = {
    order_new_button: {
      name: '신규 주문 등록 버튼',
      selector: "button[name='신규주문']",
      fallback_text: '신규주문',
      description: '새 주문 등록 화면 오픈',
    },
    customer_name_input: {
      name: '고객명 입력 필드',
      selector: "input[name='고객명']",
      fallback_text: '고객명',
      description: '거래처 이름 입력',
    },
    product_search_input: {
      name: '품목 검색 필드',
      selector: "input[name='품목']",
      fallback_text: '품목',
      description: '제품 검색 및 선택',
    },
    quantity_input: {
      name: '수량 입력 필드',
      selector: "input[name='수량']",
      fallback_text: '수량',
      description: '주문 수량 입력',
    },
    save_button: {
      name: '저장 버튼',
      selector: "button[name='저장']",
      fallback_text: '저장',
      description: '주문 저장',
    },
    order_list_table: {
      name: '주문 목록 테이블',
      selector: "table[name='주문목록']",
      fallback_text: '주문목록',
      description: '등록된 주문 리스트',
    },
    cancel_button: {
      name: '취소 버튼',
      selector: "button[name='취소']",
      fallback_text: '취소',
      description: '현재 작업 취소',
    },
    search_button: {
      name: '조회 버튼',
      selector: "button[name='조회']",
      fallback_text: '조회',
      description: '데이터 조회/검색 실행',
    },
    print_button: {
      name: '인쇄 버튼',
      selector: "button[name='인쇄']",
      fallback_text: '인쇄',
      description: '문서 인쇄',
    },
    date_input: {
      name: '날짜 입력 필드',
      selector: "input[name='날짜']",
      fallback_text: '날짜',
      description: '주문 날짜 입력',
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // PAD 플로우 템플릿
  // ═══════════════════════════════════════════════════════════════
  const PAD_FLOW_TEMPLATES = {
    order_entry: {
      flowName: 'nenova_order_entry',
      description: 'nenova 신규 주문 등록',
      variables: ['customer', 'product', 'quantity', 'date'],
      steps: [
        { action: 'FocusWindow', params: { title: '*nenova*' } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.order_new_button.selector } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'SetText', params: { selector: NENOVA_SELECTORS.customer_name_input.selector, value: '{{customer}}' } },
        { action: 'Press', params: { key: 'Tab' } },
        { action: 'Wait', params: { seconds: 0.3 } },
        { action: 'SetText', params: { selector: NENOVA_SELECTORS.product_search_input.selector, value: '{{product}}' } },
        { action: 'Press', params: { key: 'Tab' } },
        { action: 'Wait', params: { seconds: 0.3 } },
        { action: 'SetText', params: { selector: NENOVA_SELECTORS.quantity_input.selector, value: '{{quantity}}' } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.save_button.selector } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'Screenshot', params: { purpose: 'verification' } },
      ],
    },
    order_modify: {
      flowName: 'nenova_order_modify',
      description: 'nenova 주문 수정',
      variables: ['orderId', 'field', 'newValue'],
      steps: [
        { action: 'FocusWindow', params: { title: '*nenova*' } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.search_button.selector } },
        { action: 'SetText', params: { selector: "input[name='주문번호']", value: '{{orderId}}' } },
        { action: 'Press', params: { key: 'Enter' } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'DoubleClick', params: { selector: "row[contains='{{orderId}}']" } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'SetText', params: { selector: "input[name='{{field}}']", value: '{{newValue}}' } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.save_button.selector } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'Screenshot', params: { purpose: 'verification' } },
      ],
    },
    order_cancel: {
      flowName: 'nenova_order_cancel',
      description: 'nenova 주문 취소',
      variables: ['orderId'],
      steps: [
        { action: 'FocusWindow', params: { title: '*nenova*' } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.search_button.selector } },
        { action: 'SetText', params: { selector: "input[name='주문번호']", value: '{{orderId}}' } },
        { action: 'Press', params: { key: 'Enter' } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'DoubleClick', params: { selector: "row[contains='{{orderId}}']" } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.cancel_button.selector } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: "button[name='확인']" } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'Screenshot', params: { purpose: 'verification' } },
      ],
    },
    order_print: {
      flowName: 'nenova_order_print',
      description: 'nenova 주문서 인쇄',
      variables: ['orderId'],
      steps: [
        { action: 'FocusWindow', params: { title: '*nenova*' } },
        { action: 'Wait', params: { seconds: 0.5 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.search_button.selector } },
        { action: 'SetText', params: { selector: "input[name='주문번호']", value: '{{orderId}}' } },
        { action: 'Press', params: { key: 'Enter' } },
        { action: 'Wait', params: { seconds: 1 } },
        { action: 'Click', params: { selector: NENOVA_SELECTORS.print_button.selector } },
        { action: 'Wait', params: { seconds: 2 } },
        { action: 'Screenshot', params: { purpose: 'print_confirmation' } },
      ],
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // GET /api/pad/status — PAD 연결 상태
  // ═══════════════════════════════════════════════════════════════
  router.get('/status', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      // 최근 결과 보고에서 활성 PC 확인
      const activeRes = await db.query(`
        SELECT DISTINCT target_pc, MAX(completed_at) as last_active
        FROM pad_queue
        WHERE status IN ('completed', 'failed')
          AND completed_at >= NOW() - INTERVAL '10 minutes'
        GROUP BY target_pc
      `);

      // 큐 현황
      const queueRes = await db.query(`
        SELECT status, COUNT(*) as count
        FROM pad_queue
        GROUP BY status
      `);

      const queueSummary = {};
      for (const row of queueRes.rows) {
        queueSummary[row.status] = parseInt(row.count);
      }

      res.json({
        ok: true,
        padAvailable: activeRes.rows.length > 0,
        activePCs: activeRes.rows.map(r => ({
          pc: r.target_pc,
          lastActive: r.last_active,
        })),
        queue: queueSummary,
        supportedActions: Object.keys(PAD_FLOW_TEMPLATES),
        selectorCount: Object.keys(NENOVA_SELECTORS).length,
      });
    } catch (err) {
      console.error('[PADConnector] status error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/pad/flow/generate — PAD 플로우 JSON 생성
  // ═══════════════════════════════════════════════════════════════
  router.post('/flow/generate', async (req, res) => {
    try {
      const { action, variables } = req.body;
      if (!action) return res.status(400).json({ error: 'action required' });

      const template = PAD_FLOW_TEMPLATES[action];
      if (!template) {
        return res.status(404).json({
          error: `Unknown action: ${action}`,
          availableActions: Object.keys(PAD_FLOW_TEMPLATES),
        });
      }

      // 변수 치환
      let steps = JSON.parse(JSON.stringify(template.steps));
      if (variables && typeof variables === 'object') {
        const stepsJson = JSON.stringify(steps);
        let replaced = stepsJson;
        for (const [key, value] of Object.entries(variables)) {
          replaced = replaced.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
        }
        steps = JSON.parse(replaced);
      }

      // 마우스 좌표 보강 (학습된 좌표가 있으면 추가)
      const db = getDb();
      if (db?.query) {
        try {
          await _ensureTables(db);
          const coordsRes = await db.query('SELECT element_name, x, y, confidence FROM pad_mouse_map WHERE confidence >= 0.5');
          const coordMap = {};
          for (const c of coordsRes.rows) coordMap[c.element_name] = c;

          for (const step of steps) {
            if (step.action === 'Click' || step.action === 'DoubleClick') {
              // 셀렉터에서 요소 이름 추출 시도
              const selectorMatch = step.params?.selector?.match(/name='([^']+)'/);
              if (selectorMatch) {
                const coord = coordMap[selectorMatch[1]];
                if (coord) {
                  step.params.fallbackCoords = { x: coord.x, y: coord.y, confidence: coord.confidence };
                }
              }
            }
          }
        } catch {
          // 좌표 보강 실패 시 무시
        }
      }

      // 미치환 변수 경고
      const unreplaced = [];
      const unreplacedRegex = /\{\{(\w+)\}\}/g;
      const finalJson = JSON.stringify(steps);
      let match;
      while ((match = unreplacedRegex.exec(finalJson)) !== null) {
        if (!unreplaced.includes(match[1])) unreplaced.push(match[1]);
      }

      res.json({
        ok: true,
        flow: {
          flowName: template.flowName,
          description: template.description,
          requiredVariables: template.variables,
          steps,
        },
        warnings: unreplaced.length > 0 ? { unreplacedVariables: unreplaced } : undefined,
      });
    } catch (err) {
      console.error('[PADConnector] flow/generate error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/pad/selectors — nenova UI 셀렉터 정의
  // ═══════════════════════════════════════════════════════════════
  router.get('/selectors', async (req, res) => {
    try {
      // 학습된 좌표도 함께 반환
      let mouseCoords = {};
      const db = getDb();
      if (db?.query) {
        try {
          await _ensureTables(db);
          const coordsRes = await db.query('SELECT element_name, x, y, confidence, sample_count FROM pad_mouse_map');
          for (const c of coordsRes.rows) {
            mouseCoords[c.element_name] = { x: c.x, y: c.y, confidence: c.confidence, samples: c.sample_count };
          }
        } catch {
          // 좌표 조회 실패 시 무시
        }
      }

      const selectors = {};
      for (const [key, def] of Object.entries(NENOVA_SELECTORS)) {
        selectors[key] = {
          ...def,
          learnedCoords: mouseCoords[def.fallback_text] || mouseCoords[def.name] || null,
        };
      }

      res.json({
        ok: true,
        targetApp: 'nenova',
        count: Object.keys(selectors).length,
        selectors,
      });
    } catch (err) {
      console.error('[PADConnector] selectors error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/pad/execute — 자동화 액션 큐잉
  // ═══════════════════════════════════════════════════════════════
  router.post('/execute', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { action, params, targetPc, priority } = req.body;
      if (!action) return res.status(400).json({ error: 'action required' });

      // 유효한 액션인지 확인
      if (!PAD_FLOW_TEMPLATES[action]) {
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          availableActions: Object.keys(PAD_FLOW_TEMPLATES),
        });
      }

      const result = await db.query(
        `INSERT INTO pad_queue (action, params, target_pc, priority, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id, action, params, target_pc, priority, status, created_at`,
        [
          action,
          JSON.stringify(params || {}),
          targetPc || null,
          priority || 0,
        ]
      );

      res.json({
        ok: true,
        queued: result.rows[0],
        message: `Action '${action}' queued for execution`,
      });
    } catch (err) {
      console.error('[PADConnector] execute error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/pad/queue — 대기 중 액션 목록
  // ═══════════════════════════════════════════════════════════════
  router.get('/queue', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { status, limit, targetPc } = req.query;
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (status) {
        conditions.push(`status = $${paramIdx++}`);
        params.push(status);
      }
      if (targetPc) {
        conditions.push(`target_pc = $${paramIdx++}`);
        params.push(targetPc);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const queryLimit = Math.min(parseInt(limit) || 50, 200);

      const result = await db.query(
        `SELECT id, action, params, target_pc, status, priority, created_at, executed_at, completed_at, result, error_message
         FROM pad_queue ${where}
         ORDER BY priority DESC, created_at ASC
         LIMIT ${queryLimit}`,
        params
      );

      // 요약 통계
      const statsRes = await db.query(`
        SELECT status, COUNT(*) as count
        FROM pad_queue
        GROUP BY status
      `);
      const summary = {};
      for (const row of statsRes.rows) summary[row.status] = parseInt(row.count);

      res.json({
        ok: true,
        summary,
        count: result.rows.length,
        queue: result.rows,
      });
    } catch (err) {
      console.error('[PADConnector] queue error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/pad/result — 실행 결과 보고 (직원 PC → 서버)
  // ═══════════════════════════════════════════════════════════════
  router.post('/result', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { queueId, status, result, errorMessage, targetPc } = req.body;
      if (!queueId) return res.status(400).json({ error: 'queueId required' });
      if (!status || !['completed', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'status must be "completed" or "failed"' });
      }

      const updateRes = await db.query(
        `UPDATE pad_queue
         SET status = $1,
             result = $2,
             error_message = $3,
             completed_at = NOW(),
             target_pc = COALESCE($4, target_pc)
         WHERE id = $5
         RETURNING *`,
        [
          status,
          result ? JSON.stringify(result) : null,
          errorMessage || null,
          targetPc || null,
          queueId,
        ]
      );

      if (updateRes.rows.length === 0) {
        return res.status(404).json({ error: `Queue item ${queueId} not found` });
      }

      // 마우스 좌표 학습 (결과에 좌표 정보가 있으면 업데이트)
      if (result?.mouseCoords && Array.isArray(result.mouseCoords)) {
        for (const coord of result.mouseCoords) {
          if (coord.element && coord.x != null && coord.y != null) {
            try {
              await db.query(
                `INSERT INTO pad_mouse_map (element_name, window_title, x, y, confidence, source, sample_count)
                 VALUES ($1, $2, $3, $4, $5, 'execution_result', 1)
                 ON CONFLICT (element_name, window_title)
                 DO UPDATE SET
                   x = ROUND((pad_mouse_map.x * pad_mouse_map.sample_count + $3) / (pad_mouse_map.sample_count + 1)),
                   y = ROUND((pad_mouse_map.y * pad_mouse_map.sample_count + $4) / (pad_mouse_map.sample_count + 1)),
                   sample_count = pad_mouse_map.sample_count + 1,
                   confidence = LEAST(1.0, pad_mouse_map.confidence + 0.05),
                   updated_at = NOW()`,
                [coord.element, coord.windowTitle || 'nenova', coord.x, coord.y, coord.confidence || 0.5]
              );
            } catch {
              // 좌표 학습 실패 무시
            }
          }
        }
      }

      res.json({
        ok: true,
        updated: updateRes.rows[0],
      });
    } catch (err) {
      console.error('[PADConnector] result error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/pad/scripts — 자동화 스크립트 목록
  // ═══════════════════════════════════════════════════════════════
  router.get('/scripts', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { action, scriptType } = req.query;
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (action) {
        conditions.push(`action = $${paramIdx++}`);
        params.push(action);
      }
      if (scriptType) {
        conditions.push(`script_type = $${paramIdx++}`);
        params.push(scriptType);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await db.query(
        `SELECT id, name, action, script_type, description, target_app, mouse_coords, created_at, updated_at
         FROM pad_scripts ${where}
         ORDER BY updated_at DESC`,
        params
      );

      // 내장 스크립트 템플릿도 포함
      const builtinScripts = Object.entries(PAD_FLOW_TEMPLATES).map(([key, tmpl]) => ({
        name: tmpl.flowName,
        action: key,
        script_type: 'pad_flow',
        description: tmpl.description,
        target_app: 'nenova',
        builtin: true,
      }));

      res.json({
        ok: true,
        builtin: builtinScripts,
        custom: result.rows,
        totalCount: builtinScripts.length + result.rows.length,
      });
    } catch (err) {
      console.error('[PADConnector] scripts error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/pad/scripts/generate — pyautogui 스크립트 생성
  // ═══════════════════════════════════════════════════════════════
  router.post('/scripts/generate', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { action, variables, saveName } = req.body;
      if (!action) return res.status(400).json({ error: 'action required' });

      const template = PAD_FLOW_TEMPLATES[action];
      if (!template) {
        return res.status(404).json({
          error: `Unknown action: ${action}`,
          availableActions: Object.keys(PAD_FLOW_TEMPLATES),
        });
      }

      // 학습된 좌표 로드
      const coordsRes = await db.query('SELECT element_name, x, y, confidence FROM pad_mouse_map WHERE confidence >= 0.3');
      const coordMap = {};
      for (const c of coordsRes.rows) coordMap[c.element_name] = c;

      // 기본 좌표 (학습된 좌표가 없을 때 사용)
      const defaultCoords = {
        '신규주문': { x: 532, y: 312 },
        '고객명': { x: 420, y: 385 },
        '품목': { x: 420, y: 425 },
        '수량': { x: 620, y: 425 },
        '저장': { x: 750, y: 580 },
        '취소': { x: 650, y: 580 },
        '조회': { x: 850, y: 312 },
        '인쇄': { x: 950, y: 312 },
        '날짜': { x: 420, y: 345 },
      };

      // pyautogui 스크립트 생성
      const lines = [
        '# -*- coding: utf-8 -*-',
        `"""`,
        `nenova ${template.description}`,
        `생성: ${new Date().toISOString()}`,
        `액션: ${action}`,
        `"""`,
        'import pyautogui',
        'import time',
        '',
        '# 안전 설정',
        'pyautogui.FAILSAFE = True',
        'pyautogui.PAUSE = 0.3',
        '',
      ];

      for (const step of template.steps) {
        const selectorMatch = step.params?.selector?.match(/name='([^']+)'/);
        const elementName = selectorMatch ? selectorMatch[1] : null;
        const coord = (elementName && coordMap[elementName]) || (elementName && defaultCoords[elementName]);

        switch (step.action) {
          case 'FocusWindow': {
            const title = step.params.title.replace(/\*/g, '');
            lines.push(`# 창 포커스: ${title}`);
            lines.push(`import subprocess`);
            lines.push(`subprocess.run(['powershell', '-Command', "Get-Process | Where-Object {$_.MainWindowTitle -like '${step.params.title}'} | ForEach-Object { $_.Id } | ForEach-Object { [void][System.Runtime.InteropServices.Marshal]::GetActiveObject('') }"], capture_output=True)`);
            lines.push(`# 대안: pyautogui 방식`);
            lines.push(`try:`);
            lines.push(`    import pygetwindow as gw`);
            lines.push(`    wins = gw.getWindowsWithTitle('${title}')`);
            lines.push(`    if wins: wins[0].activate()`);
            lines.push(`except: pass`);
            lines.push('');
            break;
          }
          case 'Wait':
            lines.push(`time.sleep(${step.params.seconds})`);
            lines.push('');
            break;
          case 'Click':
          case 'DoubleClick': {
            const clickFn = step.action === 'DoubleClick' ? 'pyautogui.doubleClick' : 'pyautogui.click';
            if (coord) {
              const source = coordMap[elementName] ? '학습된 좌표' : '기본 좌표';
              lines.push(`# ${elementName || step.params.selector} (${source})`);
              lines.push(`${clickFn}(x=${coord.x}, y=${coord.y})`);
            } else {
              lines.push(`# ${elementName || step.params.selector} — 좌표 미확인, 이미지 탐색 사용`);
              lines.push(`try:`);
              lines.push(`    loc = pyautogui.locateOnScreen('${elementName || 'element'}.png', confidence=0.8)`);
              lines.push(`    if loc: ${clickFn}(pyautogui.center(loc))`);
              lines.push(`    else: print('WARNING: ${elementName || "element"} not found')`);
              lines.push(`except: print('WARNING: ${elementName || "element"} locate failed')`);
            }
            lines.push('');
            break;
          }
          case 'SetText': {
            let value = step.params.value;
            // 변수 치환
            if (variables && typeof variables === 'object') {
              const varMatch = value.match(/\{\{(\w+)\}\}/);
              if (varMatch && variables[varMatch[1]] !== undefined) {
                value = variables[varMatch[1]];
              }
            }
            if (coord) {
              lines.push(`# ${elementName} 입력`);
              lines.push(`pyautogui.click(x=${coord.x}, y=${coord.y})`);
              lines.push(`time.sleep(0.2)`);
              lines.push(`pyautogui.hotkey('ctrl', 'a')  # 기존 텍스트 선택`);
            } else {
              lines.push(`# ${elementName || step.params.selector} 입력 — 좌표 미확인`);
            }
            // 한글 입력은 clipboard 방식 사용
            lines.push(`# 한글 입력: clipboard 방식`);
            lines.push(`import subprocess`);
            lines.push(`subprocess.run(['powershell', '-Command', "Set-Clipboard -Value '${value}'"], capture_output=True)`);
            lines.push(`pyautogui.hotkey('ctrl', 'v')`);
            lines.push('');
            break;
          }
          case 'Press':
            lines.push(`pyautogui.press('${step.params.key.toLowerCase()}')`);
            lines.push('');
            break;
          case 'Screenshot':
            lines.push(`# 스크린샷: ${step.params.purpose}`);
            lines.push(`screenshot = pyautogui.screenshot()`);
            lines.push(`screenshot.save(f'nenova_${action}_{int(time.time())}.png')`);
            lines.push('');
            break;
          default:
            lines.push(`# ${step.action}: ${JSON.stringify(step.params)}`);
            lines.push('');
        }
      }

      lines.push("print('완료')");

      const script = lines.join('\n');

      // 저장 옵션
      if (saveName) {
        await db.query(
          `INSERT INTO pad_scripts (name, action, script_type, script_content, description, target_app)
           VALUES ($1, $2, 'pyautogui', $3, $4, 'nenova')`,
          [saveName, action, script, template.description]
        );
      }

      res.json({
        ok: true,
        action,
        scriptType: 'pyautogui',
        language: 'python',
        description: template.description,
        script,
        saved: !!saveName,
        coordSources: {
          learned: Object.keys(coordMap).length,
          default: Object.keys(defaultCoords).length,
        },
      });
    } catch (err) {
      console.error('[PADConnector] scripts/generate error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/pad/mouse-map — 학습된 마우스 좌표 맵
  // ═══════════════════════════════════════════════════════════════
  router.get('/mouse-map', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { windowTitle, minConfidence } = req.query;

      // pad_mouse_map에서 저장된 좌표
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (windowTitle) {
        conditions.push(`window_title ILIKE $${paramIdx++}`);
        params.push(`%${windowTitle}%`);
      }
      if (minConfidence) {
        conditions.push(`confidence >= $${paramIdx++}`);
        params.push(parseFloat(minConfidence));
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const mapRes = await db.query(
        `SELECT element_name, window_title, x, y, width, height, confidence, source, sample_count, updated_at
         FROM pad_mouse_map ${where}
         ORDER BY confidence DESC, sample_count DESC`,
        params
      );

      // events 테이블에서 마우스 좌표 클러스터링 (있으면)
      let eventClusters = [];
      try {
        const eventsRes = await db.query(`
          SELECT
            (data->>'mouseX')::int as mx,
            (data->>'mouseY')::int as my,
            data->>'windowTitle' as win_title,
            COUNT(*) as click_count
          FROM events
          WHERE type = 'mouse.click'
            AND data->>'mouseX' IS NOT NULL
            AND data->>'windowTitle' ILIKE '%nenova%'
          GROUP BY (data->>'mouseX')::int / 20 * 20,
                   (data->>'mouseY')::int / 20 * 20,
                   data->>'windowTitle'
          HAVING COUNT(*) >= 3
          ORDER BY click_count DESC
          LIMIT 50
        `);

        // 클러스터 → UI 요소 매핑 추론
        for (const cluster of eventsRes.rows) {
          eventClusters.push({
            x: cluster.mx,
            y: cluster.my,
            windowTitle: cluster.win_title,
            clickCount: parseInt(cluster.click_count),
            inferredElement: _inferElement(cluster.mx, cluster.my),
          });
        }
      } catch {
        // events 테이블 없거나 형식 다르면 무시
      }

      res.json({
        ok: true,
        learnedMap: {
          count: mapRes.rows.length,
          elements: mapRes.rows,
        },
        eventClusters: {
          count: eventClusters.length,
          clusters: eventClusters,
          note: 'Inferred from mouse click event data (20px grid clustering)',
        },
      });
    } catch (err) {
      console.error('[PADConnector] mouse-map error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 좌표 → UI 요소 추론 (대략적 영역 매핑)
   */
  function _inferElement(x, y) {
    // nenova 화면 기본 레이아웃 기반 추론
    if (y < 100) return 'menu_bar';
    if (y >= 280 && y <= 340 && x >= 480 && x <= 600) return '신규주문';
    if (y >= 280 && y <= 340 && x >= 800 && x <= 900) return '조회';
    if (y >= 280 && y <= 340 && x >= 900 && x <= 1000) return '인쇄';
    if (y >= 350 && y <= 400) return 'input_fields_row1';
    if (y >= 400 && y <= 450) return 'input_fields_row2';
    if (y >= 450 && y <= 550) return 'data_table';
    if (y >= 560 && y <= 600 && x >= 700 && x <= 800) return '저장';
    if (y >= 560 && y <= 600 && x >= 600 && x <= 700) return '취소';
    return 'unknown';
  }

  return router;
}

module.exports = createPadConnectorRouter;
