'use strict';
/**
 * work-flow.js — 작업 흐름(클릭→클릭→입력 순서) API (2026-09-15)
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET /api/work-flow/day?userId=&date=YYYY-MM-DD
 *       그 날(KST) 한 직원의 작업을 세션으로 나누고, 세션마다 순서대로 단계를 준다:
 *       ① 클릭 [저장] 버튼  ② 입력 A1 = "HORTENSIAS"  ③ 타이핑 "청화꽃집" …
 *
 * 새 수집 없음 — 이미 저장 중인 네 가지를 시간순으로 꿴다:
 *   keyboard.chunk.mousePositions  클릭 {x,y,t,app,win}  (좌표만, 무엇을 눌렀는지는 없음)
 *   work.step (uia-recorder.ps1)   포커스/입력한 컨트롤 {name,controlType,rect,value} — excel/word/ppt/hwp/nenova
 *   keyboard.chunk.inputText       타이핑 원문 (smartQwertyToHangul로 한/영 판별)
 *   screen.analyzed                화면 이름·하던 일·Vision 필드 clickXY
 * 클릭 라벨: ①클릭 직후 UIA 포커스(=그 컨트롤을 누른 것) → 'uia'  ②Vision 필드 clickXY 근접 → 'vision'(추정)
 *
 * 인증: isAdminReq 관리자 전용 (직원 화면·입력 데이터 — 접두사 토큰 검사만으로 열지 말 것)
 * 프론트: /work-flow.html (my-work.html '작업 흐름' 탭)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const { smartQwertyToHangul } = require('../src/hangul');

const ms = (ts) => new Date(ts).getTime();
const obj = (x) => { if (!x) return {}; if (typeof x === 'object') return x; try { return JSON.parse(x); } catch { return {}; } };
const appKey = (a) => String(a || '').toLowerCase().replace(/\.exe$/, '').trim();

const SESSION_GAP_MS = 5 * 60 * 1000;      // 5분 넘게 조용하면 새 세션
const APP_SWITCH_GAP_MS = 90 * 1000;       // 앱이 바뀌고 90초 넘게 비면 새 세션 (짧은 카톡↔엑셀 전환은 한 세션)
const UIA_AFTER_CLICK_MS = 2000;           // 클릭 후 이 안에 온 UIA 포커스 = 그 클릭의 대상
const VISION_WINDOW_MS = 3 * 60 * 1000;    // Vision 필드 좌표를 찾을 화면 분석 시간창
const VISION_RADIUS_PX = 40;               // vision-worker는 받은 클릭 좌표를 그대로 clickXY로 옮겨 적는다
const DOC_STICK = 5;                       // 새 문서에서 활동 5단계 이상 이어져야 문서 전환으로 인정

function parseXY(v) {
  if (Array.isArray(v)) { const x = +v[0], y = +v[1]; return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null; }
  if (typeof v === 'string') { const m = v.match(/-?\d+(?:\.\d+)?/g); if (m && m.length >= 2) return [+m[0], +m[1]]; }
  return null;
}

/**
 * 순수 함수 — DB 없이 실데이터로 검증 가능.
 * @param {{chunks:Array, uia:Array, screens:Array}} src  각 원소 {ts, data}
 * @returns {Array} sessions
 */
function buildFlow({ chunks = [], uia = [], screens = [] }) {
  const ev = [];
  const seenClick = new Set();
  for (const c of chunks) {
    const d = obj(c.data);
    for (const p of d.mousePositions || []) {
      if (!p || !p.t || !Number.isFinite(+p.x)) continue;
      const k = `${Math.floor(p.t / 1000)}:${p.x}:${p.y}`;          // 같은 초·좌표 중복 기록 제거
      if (seenClick.has(k)) continue; seenClick.add(k);
      ev.push({ t: +p.t, kind: 'click', app: p.app || d.app || '', win: p.win || '', x: +p.x, y: +p.y });
    }
    const raw = String(d.inputText || '').trim();
    if (raw) ev.push({ t: ms(c.ts), kind: 'type', app: d.app || '', win: d.windowTitle || '', text: smartQwertyToHangul(raw).slice(0, 300) });
  }
  for (const u of uia) {
    const d = obj(u.data), tg = d.target || {};
    // 두 종류의 work.step: uia-recorder(데스크톱 Office/nenova, action=focus|input, target.name/controlType)
    // + 크롬 확장 content-work.js(웹 ERP, action=click|input|navigate, target.label/selector/text, url/title 보유)
    const isWeb = !!(d.url || tg.selector);
    let kind;
    if (isWeb) kind = d.action === 'input' ? 'input' : d.action === 'navigate' ? 'nav' : 'click';
    else kind = d.action === 'input' ? 'input' : 'focus';
    const label = tg.label || tg.name || tg.text || tg.id || '';
    const e = { t: +d.t || ms(u.ts), kind, app: isWeb ? 'web' : (d.app || ''), win: d.window || d.title || '',
      name: label, ctl: tg.controlType || (isWeb ? 'web' : ''), cellId: tg.id || tg.selector || '',
      value: String(d.value || '').slice(0, 200), url: d.url || '' };
    if (isWeb && kind === 'click') { e.label = label; e.conf = 'web'; } // 웹 클릭은 확장이 이미 라벨을 안다
    ev.push(e);
  }
  const shots = [];
  for (const s of screens) {
    const d = obj(s.data);
    const e = { t: ms(s.ts), kind: 'screen', app: d.app || '', screen: d.screen || '', activity: d.activity || '',
      action: d.nenovaAction || '', id: s.id, hasThumb: !!s.hasThumb,
      fields: (Array.isArray(d.fields) ? d.fields : []).map((f) => ({ name: f.name || f.label || '', xy: parseXY(f.clickXY), value: f.currentValue || f.value || '' })).filter((f) => f.xy && f.name) };
    ev.push(e); shots.push(e);
  }
  ev.sort((a, b) => a.t - b.t);

  // 클릭에 라벨 붙이기
  const usedFocus = new Set();
  for (let i = 0; i < ev.length; i++) {
    const c = ev[i]; if (c.kind !== 'click') continue;
    if (c.label) continue;                                             // 웹 클릭은 이미 라벨 보유 → 좌표 매칭 생략
    for (let j = i + 1; j < ev.length && ev[j].t - c.t <= UIA_AFTER_CLICK_MS; j++) {
      const f = ev[j];
      if ((f.kind === 'focus' || f.kind === 'input') && !usedFocus.has(j) && f.name) {
        c.label = f.name; c.ctl = f.ctl; c.conf = 'uia';
        if (f.kind === 'focus') usedFocus.add(j);                      // 포커스는 클릭과 합쳐서 한 단계로
        break;
      }
    }
    if (c.label) continue;
    let best = null;
    for (const s of shots) {
      if (Math.abs(s.t - c.t) > VISION_WINDOW_MS) continue;
      for (const f of s.fields) {
        const dist = Math.hypot(f.xy[0] - c.x, f.xy[1] - c.y);
        if (dist <= VISION_RADIUS_PX && (!best || dist < best.dist)) best = { dist, name: f.name };
      }
    }
    if (best) { c.label = best.name; c.conf = 'vision'; }
  }

  // 단계 정리: 클릭에 흡수된 포커스 제거, 같은 칸 연속 입력은 마지막 값만, 같은 대상 연속 클릭은 횟수로
  const steps = [];
  ev.forEach((e, i) => {
    if (e.kind === 'focus' && usedFocus.has(i)) return;
    const prev = steps[steps.length - 1];
    if (prev && e.kind === 'input' && prev.kind === 'input' && prev.name === e.name && prev.win === e.win && e.t - prev.t < 60000) {
      prev.value = e.value; prev.tEnd = e.t; return;
    }
    if (prev && e.kind === 'click' && prev.kind === 'click' && e.t - prev.t < 1500 &&
        (e.label ? prev.label === e.label : Math.hypot(prev.x - e.x, prev.y - e.y) < 6)) {
      prev.count = (prev.count || 1) + 1; return;
    }
    steps.push({ ...e });
  });

  // 세션 나누기 — 경계: ①5분 무활동 ②앱 전환+90초 ③문서(창 제목) 전환이 DOC_STICK 단계 이상 이어질 때.
  // 실측(설연주 9/15): 하루 종일 엑셀·최대간격 153초라 ①②만으론 1,500단계가 세션 1개로 뭉침.
  // 창 제목이 곧 작업 단위('라움 발주서'→'7월 지출사용내역'). 카톡 잠깐 확인 후 복귀 같은 짧은 전환은 ③에 안 걸림.
  const docOf = (s) => (s.kind === 'screen' ? '' : String(s.win || s.app || '').replace(/\s+-\s+(Excel|Word|PowerPoint|Chrome|Google Chrome|Microsoft Edge)$/i, '').trim());
  const sticks = (i, doc) => {                                        // i부터 DOC_STICK개 활동 단계가 같은 문서인가
    let n = 0;
    for (let j = i; j < steps.length && n < DOC_STICK; j++) { const d = docOf(steps[j]); if (!d) continue; if (d !== doc) return false; n++; }
    return n >= DOC_STICK;
  };
  const sessions = [];
  let cur = null;
  steps.forEach((s, i) => {
    const gap = cur ? s.t - cur.end : Infinity;
    const appChanged = cur && s.app && cur.lastApp && appKey(s.app) !== appKey(cur.lastApp);
    const doc = docOf(s);
    const docChanged = cur && doc && cur.doc && doc !== cur.doc && sticks(i, doc);
    if (!cur || gap > SESSION_GAP_MS || (appChanged && gap > APP_SWITCH_GAP_MS) || docChanged) {
      if (cur) sessions.push(cur);
      cur = { start: s.t, end: s.t, steps: [], lastApp: '', doc: '' };
    }
    cur.steps.push(s); cur.end = s.tEnd || s.t; if (s.app) cur.lastApp = s.app;
    if (doc && (!cur.doc || sticks(i, doc))) cur.doc = doc;           // 세션의 대표 문서 = 자리잡은 문서
  });
  if (cur) sessions.push(cur);

  const top = (arr) => { const m = {}; for (const v of arr) if (v) m[v] = (m[v] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };
  return sessions
    .filter((s) => s.steps.some((x) => x.kind !== 'screen'))            // 화면 분석만 있는 세션은 흐름이 아님
    .map((s) => {
      const sc = s.steps.filter((x) => x.kind === 'screen');
      const act = s.steps.filter((x) => x.kind !== 'screen');
      const clicks = act.filter((x) => x.kind === 'click');
      return {
        start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(),
        durationSec: Math.round((s.end - s.start) / 1000),
        // 제목: 전산 동작 > 문서명 > 화면분석 한 줄 (문서명이 화면분석 요약보다 작업 단위를 더 정확히 가리킴)
        title: top(sc.map((x) => x.action)) || s.doc || top(sc.map((x) => x.activity)) || top(act.map((x) => x.app)) || '작업',
        apps: [...new Set(act.map((x) => x.app).filter(Boolean))].slice(0, 5),
        stats: { clicks: clicks.length, labeled: clicks.filter((x) => x.label).length,
          inputs: act.filter((x) => x.kind === 'input').length, typing: act.filter((x) => x.kind === 'type').length, screens: sc.length },
        steps: s.steps.map((x) => {
          const o = { t: new Date(x.t).toISOString(), kind: x.kind, app: x.app, win: String(x.win || '').slice(0, 80) };
          if (x.kind === 'click') Object.assign(o, { label: x.label || '', ctl: x.ctl || '', conf: x.conf || 'none', x: x.x, y: x.y, count: x.count || 1 });
          if (x.kind === 'focus' || x.kind === 'input') Object.assign(o, { label: x.name, ctl: x.ctl, value: x.value });
          if (x.kind === 'nav') Object.assign(o, { label: x.name || x.url || '', url: x.url || '' });
          if (x.kind === 'type') o.text = x.text;
          if (x.kind === 'screen') Object.assign(o, { screen: x.screen, activity: x.activity, action: x.action,
            thumbnailUrl: x.hasThumb ? `/api/vision/thumbnail/${x.id}` : null });
          return o;
        }),
      };
    });
}

function createWorkFlowRouter(deps = {}) {
  const getPool = deps.getPool;
  const isAdminReq = deps.isAdminReq || (async () => false);
  const router = express.Router();
  const pool = () => (getPool ? getPool() : null);

  router.use(async (req, res, next) => {
    try { if (await isAdminReq(req)) return next(); } catch { /* fallthrough */ }
    res.status(403).json({ error: 'admin only' });
  });

  router.get('/day', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(503).json({ error: 'db unavailable' });
      const userId = String(req.query.userId || '');
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
        ? String(req.query.date) : new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
      const from = new Date(`${date}T00:00:00+09:00`).toISOString();
      const to = new Date(ms(from) + 86400000).toISOString();
      // timestamp는 TEXT·UTC/KST 혼용 → timestamptz 캐스팅 필수 (orbit-hostname-case-queue-split 교훈)
      const { rows } = await p.query(
        `SELECT id, type, timestamp AS ts,
                CASE WHEN type='keyboard.chunk' THEN jsonb_build_object('inputText', data_json->'inputText', 'mousePositions', data_json->'mousePositions',
                                                                        'app', data_json->'app', 'windowTitle', data_json->'windowTitle')
                     WHEN type='screen.analyzed' THEN jsonb_build_object('app', data_json->'app', 'screen', data_json->'screen', 'activity', data_json->'activity',
                                                                         'nenovaAction', data_json->'nenovaAction', 'fields', data_json->'fields')
                     ELSE data_json::jsonb END AS data,
                (type='screen.analyzed' AND data_json->>'thumbnail' IS NOT NULL) AS has_thumb
           FROM events
          WHERE user_id = $1 AND type IN ('keyboard.chunk','work.step','screen.analyzed')
            AND timestamp::timestamptz >= $2::timestamptz AND timestamp::timestamptz < $3::timestamptz
          ORDER BY timestamp::timestamptz ASC`,
        [userId, from, to]
      );
      const src = { chunks: [], uia: [], screens: [] };
      for (const r of rows) {
        const e = { id: r.id, ts: r.ts, data: r.data, hasThumb: r.has_thumb };
        if (r.type === 'keyboard.chunk') src.chunks.push(e);
        else if (r.type === 'work.step') src.uia.push(e);
        else src.screens.push(e);
      }
      const sessions = buildFlow(src);
      res.json({ ok: true, userId, date, counts: { chunks: src.chunks.length, uiaSteps: src.uia.length, screens: src.screens.length },
        sessionCount: sessions.length, sessions });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createWorkFlowRouter;
module.exports.buildFlow = buildFlow;
