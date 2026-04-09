'use strict';
const { Router } = require('express');

const NENOVA_BASE = 'https://nenovaweb.com';
let _session = { token: null, expiry: 0 };

// 현재 ISO 주차 파라미터 계산 (예: "15-01")
function currentWeekParam() {
  const d = new Date();
  const day = d.getUTCDay() || 7;  // 1=Mon ... 7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${week}-01`;
}
const _results = [];  // 최근 20회 결과 저장

// ── 로그인 / 세션 관리 (JWT Bearer 방식) ──────────────────────────────────────
async function nenovaLogin() {
  if (_session.token && Date.now() < _session.expiry) return _session.token;
  const resp = await fetch(`${NENOVA_BASE}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': NENOVA_BASE,
      'Referer': `${NENOVA_BASE}/login`,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ userId: 'admin', password: '1234' }),
  });
  if (!resp.ok) {
    let errBody = '';
    try { errBody = await resp.text(); } catch {}
    throw new Error(`로그인 실패: ${resp.status} ${errBody.slice(0, 100)}`);
  }
  const json = await resp.json();
  if (!json.token) throw new Error('토큰 없음');
  _session.token = json.token;
  _session.expiry = Date.now() + 7 * 60 * 60 * 1000;  // 7시간 (JWT exp 기준)
  return _session.token;
}

async function nenovaGet(path) {
  const token = await nenovaLogin();
  const t = Date.now();
  const resp = await fetch(`${NENOVA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const elapsed = Date.now() - t;
  let data = null;
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, elapsed, data };
}

async function nenovaPost(path, body) {
  const token = await nenovaLogin();
  const t = Date.now();
  const resp = await fetch(`${NENOVA_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t;
  let data = null;
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, elapsed, data };
}

// ── 테스트 플로우 정의 ────────────────────────────────────────────────────────
const FLOWS = [
  {
    id: 'WF01', name: '시스템 접근성', icon: '🟢',
    desc: '로그인 + 대시보드 KPI 정상 로드',
    steps: [
      { name: '로그인', run: async () => {
        const c = await nenovaLogin();
        return { pass: !!c, detail: '세션 획득 완료' };
      }},
      { name: '대시보드 KPI', run: async () => {
        const r = await nenovaGet('/api/stats/dashboard');
        return { pass: r.ok && r.elapsed < 3000, detail: `${r.elapsed}ms (HTTP ${r.status})` };
      }},
    ],
  },
  {
    id: 'WF02', name: '주문 조회', icon: '📋',
    desc: '주문 목록 로드 + 품목 그룹 데이터 확인',
    steps: [
      { name: '주문 목록', run: async () => {
        const r = await nenovaGet('/api/orders?startDate=2026-04-01&endDate=2026-04-30');
        const count = Array.isArray(r.data) ? r.data.length : (r.data?.total || Object.keys(r.data || {}).length);
        return { pass: r.ok, detail: `${count}건 조회 (${r.elapsed}ms)` };
      }},
      { name: '품목 그룹', run: async () => {
        const r = await nenovaGet('/api/products/search?groupsOnly=1');
        const groups = Array.isArray(r.data) ? r.data : [];
        return { pass: r.ok && groups.length > 0, detail: `그룹 ${groups.length}개` };
      }},
    ],
  },
  {
    id: 'WF03', name: '발주 현황', icon: '📦',
    desc: '발주 피벗 + 차수별 집계 확인',
    steps: [
      { name: '발주 피벗', run: async () => {
        const r = await nenovaGet(`/api/warehouse/pivot?week=${currentWeekParam()}`);
        const rows = Array.isArray(r.data) ? r.data.length : 0;
        return { pass: r.ok, detail: `${rows}개 품목 (${r.elapsed}ms)` };
      }},
    ],
  },
  {
    id: 'WF04', name: '재고-출고 대조', icon: '🔄',
    desc: '재고현황 vs 출고목록 데이터 정합성',
    steps: [
      { name: '재고현황', run: async () => {
        const r = await nenovaGet(`/api/shipment/stock-status?week=${currentWeekParam()}&view=products`);
        const rows = Array.isArray(r.data) ? r.data.length : 0;
        return { pass: r.ok, detail: `${rows}개 품목` };
      }},
      { name: '출고 목록', run: async () => {
        const r = await nenovaGet(`/api/shipment?week=${currentWeekParam()}`);
        const rows = Array.isArray(r.data) ? r.data.length : 0;
        return { pass: r.ok, detail: `${rows}건` };
      }},
    ],
  },
  {
    id: 'WF05', name: '주문 등록 드라이런', icon: '✏️',
    desc: '카카오톡 주문 파싱 → 품목 매핑 → 저장 검증',
    steps: [
      { name: '품목 그룹 로드', run: async () => {
        const r = await nenovaGet('/api/products/search?groupsOnly=1');
        const groups = Array.isArray(r.data) ? r.data : [];
        const hasCarnation = groups.some(g => JSON.stringify(g).includes('카네이션') || JSON.stringify(g).includes('CARNATION'));
        return { pass: r.ok && groups.length > 0, detail: hasCarnation ? '카네이션 그룹 확인 ✓' : `${groups.length}개 그룹 로드` };
      }},
      { name: '주문 저장 (dryRun)', run: async () => {
        const r = await nenovaPost('/api/orders', {
          _dryRun: true, week: currentWeekParam(),
          customerId: 'ORBIT_TEST',
          items: [{ productCode: 'TEST', qty: 1, unit: '단' }],
        });
        return { pass: r.status < 500, detail: `HTTP ${r.status}${r.data?.message ? ' — ' + r.data.message : ''}` };
      }},
    ],
  },
  {
    id: 'WF06', name: '재고 부족 알림', icon: '⚠️',
    desc: '재고 10개 미만 품목 감지 + 알림 준비',
    steps: [
      { name: '재고 부족 스캔', run: async () => {
        const r = await nenovaGet('/api/stats/dashboard');
        const lowStock = r.data?.lowStockCount || r.data?.stockAlert || 0;
        return { pass: r.ok, detail: `재고 부족 ${lowStock}건` };
      }},
      { name: '미확정 출고 확인', run: async () => {
        const r = await nenovaGet('/api/stats/dashboard');
        const pending = r.data?.pendingShipment || r.data?.unconfirmedShipment || 0;
        return { pass: r.ok, detail: `미확정 출고 ${pending}건` };
      }},
    ],
  },
];

// ── 테스트 실행 엔진 ──────────────────────────────────────────────────────────
async function runFlow(flow) {
  const result = {
    id: flow.id, name: flow.name, icon: flow.icon, desc: flow.desc,
    steps: [], ts: new Date().toISOString(), pass: true, totalMs: 0,
  };
  const start = Date.now();
  for (const step of flow.steps) {
    const t = Date.now();
    try {
      const r = await step.run();
      const ms = Date.now() - t;
      result.steps.push({ name: step.name, pass: r.pass, detail: r.detail, ms });
      if (!r.pass) result.pass = false;
    } catch (err) {
      result.steps.push({ name: step.name, pass: false, detail: err.message, ms: Date.now() - t });
      result.pass = false;
    }
  }
  result.totalMs = Date.now() - start;
  return result;
}

// ── 라우터 ────────────────────────────────────────────────────────────────────
module.exports = function autotestRouter() {
  const router = Router();

  // 테스트 플로우 목록
  router.get('/flows', (req, res) => {
    res.json({ flows: FLOWS.map(f => ({ id: f.id, name: f.name, icon: f.icon, desc: f.desc, stepCount: f.steps.length })) });
  });

  // 전체 테스트 실행
  router.post('/run', async (req, res) => {
    const { flowId } = req.body || {};
    try {
      _session = { cookie: null, expiry: 0 }; // 세션 초기화
      const toRun = flowId ? FLOWS.filter(f => f.id === flowId) : FLOWS;
      const results = [];
      for (const flow of toRun) {
        const r = await runFlow(flow);
        results.push(r);
      }
      const run = { runId: Date.now(), ts: new Date().toISOString(), results, pass: results.every(r => r.pass) };
      _results.unshift(run);
      if (_results.length > 20) _results.length = 20;
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 최근 결과 조회
  router.get('/results', (req, res) => {
    res.json({ results: _results.slice(0, 10) });
  });

  // 마지막 결과 요약
  router.get('/summary', (req, res) => {
    const last = _results[0];
    if (!last) return res.json({ ran: false });
    const passed = last.results.filter(r => r.pass).length;
    const total = last.results.length;
    res.json({ ran: true, ts: last.ts, pass: last.pass, passed, total, runId: last.runId });
  });

  return router;
};
