'use strict';
/**
 * routes/privacy.js — 개인정보 정책·본인 열람·관리자 열람 기록 (사장님 결정 2026-09-29)
 *
 *   GET  /api/daemon/privacy-policy   데몬이 1시간마다 받는 차단 정책(config/privacy-policy.json)
 *   GET  /api/privacy/me              토큰 본인: 수집 건수(앱별)·차단 건수(사유별)·개인용무 시간·관리자 열람 기록
 *   GET  /api/privacy/pause           토큰 본인: 개인 용무 일시정지 상태(데몬이 1분마다 확인)
 *   POST /api/privacy/pause           {minutes: 30|60|0}  0=해제
 *   auditMiddleware                   관리자 열람(원문 조회 API) → orbit_access_audit 기록. 실패해도 본 요청 계속.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'privacy-policy.json');

// 관리자 열람 기록 대상 엔드포인트
const AUDITED = [
  { re: /^\/api\/learning\/logs\/?$/, name: '/api/learning/logs' },
  { re: /^\/api\/vision\/thumbnails\/?$/, name: '/api/vision/thumbnails' },
  { re: /^\/api\/vision\/thumbnail\/([^/]+)\/?$/, name: '/api/vision/thumbnail/:id', eventParam: 1 },
  { re: /^\/api\/kakao\/messages\/?$/, name: '/api/kakao/messages' },
  { re: /^\/api\/flow\/work-unified\/?$/, name: '/api/flow/work-unified' },
];

module.exports = function createPrivacyRouter({ getPool, verifyTokenAsync, env }) {
  const router = express.Router();
  const pool = () => { try { return getPool(); } catch { return null; } };

  function rawToken(req) {
    return ((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()) || String((req.query && req.query.token) || '').trim();
  }
  async function me(req) {
    const raw = rawToken(req);
    if (!raw) return null;
    try { return await verifyTokenAsync(raw); } catch { return null; }
  }

  let _tablesReady = false;
  async function ensureTables(p) {
    if (_tablesReady) return;
    await p.query(`CREATE TABLE IF NOT EXISTS orbit_access_audit (
      id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_user_id TEXT, actor_name TEXT, target_user_id TEXT, endpoint TEXT, detail TEXT)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_orbit_access_audit_target ON orbit_access_audit(target_user_id, ts DESC)`);
    await p.query(`CREATE TABLE IF NOT EXISTS orbit_privacy_pause (
      user_id TEXT PRIMARY KEY, pause_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    _tablesReady = true;
  }

  // ── 관리자 열람 기록 미들웨어 ──
  function auditMiddleware(req, res, next) {
    if (req.method !== 'GET') return next();
    const hit = AUDITED.find(a => a.re.test(req.path));
    if (!hit) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return; // 거부된 요청은 열람 아님
      (async () => {
        const p = pool(); if (!p || !p.query) return;
        const raw = rawToken(req);
        let actorId = '', actorName = '';
        if (env.isMasterToken && env.isMasterToken(raw)) { actorId = 'master-token'; actorName = '마스터 토큰(서버/워커)'; }
        else if (env.isAdminToken && env.isAdminToken(raw)) { actorId = 'admin-token'; actorName = '관리자 토큰'; }
        else { const u = await verifyTokenAsync(raw).catch(() => null); if (u) { actorId = u.id; actorName = u.name || u.email || u.id; } }
        let target = String(req.query.userId || req.query.user_id || '').slice(0, 80);
        if (actorId && target && actorId === target) return; // 본인 조회는 열람 기록 아님
        await ensureTables(p);
        const detail = JSON.stringify({ q: Object.fromEntries(Object.entries(req.query || {}).filter(([k]) => k !== 'token').slice(0, 8)) }).slice(0, 500);
        if (hit.eventParam) {
          const m = req.path.match(hit.re);
          await p.query(`INSERT INTO orbit_access_audit (actor_user_id, actor_name, target_user_id, endpoint, detail)
            SELECT $1, $2, COALESCE((SELECT user_id FROM events WHERE id=$3 LIMIT 1), 'ALL'), $4, $5`, [actorId || 'unknown', actorName, m[1], hit.name, detail]);
        } else {
          await p.query(`INSERT INTO orbit_access_audit (actor_user_id, actor_name, target_user_id, endpoint, detail) VALUES ($1,$2,$3,$4,$5)`,
            [actorId || 'unknown', actorName, target || 'ALL', hit.name, detail]);
        }
      })().catch(e => console.warn('[privacy-audit] 기록 실패(무시):', e.message));
    });
    next();
  }

  // ── 정책 ──
  let _polCache = null, _polAt = 0;
  router.get('/daemon/privacy-policy', (req, res) => {
    try {
      if (!_polCache || Date.now() - _polAt > 60 * 1000) {
        let r = fs.readFileSync(POLICY_PATH, 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1);
        const j = JSON.parse(r); delete j.candidates; // 제안 목록은 데몬에 안 보냄
        _polCache = j; _polAt = Date.now();
      }
      res.json({ ok: true, policy: _polCache });
    } catch (e) { res.status(500).json({ error: 'policy unavailable: ' + e.message }); }
  });

  // ── 메신저 로컬 추출용 업무 사전(B안) — config/work-dictionary.json + nenova 전산 품목/농장/거래처 이름. 6시간 캐시 ──
  // 사전은 이름 목록일 뿐 원문이 아님. 전산 조회는 자기 서버 /api/nenova 를 요청자 토큰으로 루프백(무인증 차단 유지).
  let _dictCache = null, _dictAt = 0;
  router.get('/daemon/work-dictionary', async (req, res) => {
    const u = await me(req); if (!u && !(env.isMasterToken && env.isMasterToken(rawToken(req)))) return res.status(401).json({ error: 'unauthorized' });
    try {
      if (!_dictCache || Date.now() - _dictAt > 6 * 3600 * 1000) {
        let base = {}; try { base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'work-dictionary.json'), 'utf8')); } catch {}
        const dict = { products: [...(base.products || [])], customers: [...(base.customers || [])], farms: [...(base.farms || [])], keywords: base.keywords || [], units: base.units || [] };
        const port = (env && env.PORT) || process.env.PORT || 4747;
        const get = async (p) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: 'Bearer ' + rawToken(req) }, signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() : null; } catch { return null; } };
        const [fl, fa] = await Promise.all([get('/api/nenova/flowers'), get('/api/nenova/farms')]);
        for (const x of (fl && fl.flowers) || []) if (!x.isDeleted && x.FlowerName) dict.products.push(String(x.FlowerName).trim());
        for (const x of (fa && fa.farms) || []) if (!x.isDeleted && x.FarmName) dict.farms.push(String(x.FarmName).trim());
        for (let off = 0; off < 3000; off += 500) {
          const c = await get(`/api/nenova/customers?limit=500&offset=${off}`);
          const items = (c && c.items) || [];
          for (const x of items) if (!x.isDeleted && x.CustName) dict.customers.push(String(x.CustName).trim());
          if (items.length < 500) break;
        }
        for (const k of ['products', 'customers', 'farms']) dict[k] = [...new Set(dict[k].filter(s => s && s.length >= 2))];
        _dictCache = dict; _dictAt = Date.now();
      }
      res.json({ ok: true, dictionary: _dictCache, counts: { products: _dictCache.products.length, customers: _dictCache.customers.length, farms: _dictCache.farms.length } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 개인 용무 일시정지 ──
  router.get('/privacy/pause', async (req, res) => {
    const u = await me(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
    try {
      const p = pool(); if (!p || !p.query) return res.json({ pauseUntil: null });
      await ensureTables(p);
      const { rows } = await p.query(`SELECT pause_until, updated_at FROM orbit_privacy_pause WHERE user_id=$1`, [u.id]);
      const r = rows[0];
      const active = r && r.pause_until && new Date(r.pause_until) > new Date();
      res.json({ pauseUntil: active ? new Date(r.pause_until).toISOString() : null,
        cleared: !!(r && !r.pause_until && Date.now() - new Date(r.updated_at).getTime() < 2 * 3600 * 1000) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/privacy/pause', async (req, res) => {
    const u = await me(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
    try {
      const minutes = Math.max(0, Math.min(240, parseInt((req.body || {}).minutes, 10) || 0));
      const until = minutes ? new Date(Date.now() + minutes * 60000) : null;
      const p = pool(); if (!p || !p.query) return res.status(503).json({ error: 'db not available' });
      await ensureTables(p);
      await p.query(`INSERT INTO orbit_privacy_pause (user_id, pause_until, updated_at) VALUES ($1,$2,NOW())
        ON CONFLICT (user_id) DO UPDATE SET pause_until=EXCLUDED.pause_until, updated_at=NOW()`, [u.id, until]);
      res.json({ ok: true, pauseUntil: until ? until.toISOString() : null, note: 'PC 반영까지 최대 1분' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 본인 열람 ──
  router.get('/privacy/me', async (req, res) => {
    const u = await me(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
    try {
      const p = pool(); if (!p || !p.query) return res.status(503).json({ error: 'db not available' });
      await ensureTables(p);
      const kstMidnight = new Date(Math.floor((Date.now() + 9 * 3600e3) / 86400e3) * 86400e3 - 9 * 3600e3);
      const since7 = new Date(kstMidnight.getTime() - 6 * 86400e3);
      const APP = `COALESCE(NULLIF(data_json->>'app',''), NULLIF(data_json->'appContext'->>'currentApp',''), NULLIF(data_json->>'sourceApp',''), NULLIF(data_json->>'browser',''), '(미상)')`;
      const [col, stats, audit, pause] = await Promise.all([
        p.query(`SELECT type, ${APP} AS app,
                        COUNT(*) FILTER (WHERE timestamp::timestamptz >= $2) AS today, COUNT(*) AS week
                   FROM events WHERE user_id=$1 AND timestamp::timestamptz >= $3 AND type <> 'privacy.stats'
                  GROUP BY 1,2 ORDER BY week DESC LIMIT 200`, [u.id, kstMidnight.toISOString(), since7.toISOString()]),
        p.query(`SELECT DISTINCT ON (data_json->>'date', data_json->>'hostname') data_json
                   FROM events WHERE user_id=$1 AND type='privacy.stats' AND timestamp::timestamptz >= $2
                  ORDER BY data_json->>'date', data_json->>'hostname', timestamp::timestamptz DESC`, [u.id, new Date(since7.getTime() - 86400e3).toISOString()]),
        p.query(`SELECT ts, actor_name, endpoint, target_user_id FROM orbit_access_audit
                  WHERE (target_user_id=$1 OR target_user_id='ALL') AND ts > NOW() - INTERVAL '30 days'
                  ORDER BY ts DESC LIMIT 200`, [u.id]),
        p.query(`SELECT pause_until FROM orbit_privacy_pause WHERE user_id=$1`, [u.id]),
      ]);
      const todayStr = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const since7Kst = new Date(since7.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
      const blocked = { today: {}, week: {} }, pausedMinutes = { today: 0, week: 0 }, minutes = { today: {}, week: {} };
      for (const r of stats.rows) {
        let d = r.data_json; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
        if (!d || !d.date || d.date < since7Kst) continue;
        for (const [k, n] of Object.entries(d.blocked || {})) {
          if (k.startsWith('personal_web')) continue; // 개인 웹은 수집·표시 안 함
          blocked.week[k] = (blocked.week[k] || 0) + (Number(n) || 0);
          if (d.date === todayStr) blocked.today[k] = (blocked.today[k] || 0) + (Number(n) || 0);
        }
        pausedMinutes.week += Number(d.pausedMinutes) || 0;
        for (const [k, m] of Object.entries(d.minutes || {})) { if (k === 'personal_web') continue; minutes.week[k] = (minutes.week[k] || 0) + (Number(m) || 0); if (d.date === todayStr) minutes.today[k] = (minutes.today[k] || 0) + (Number(m) || 0); }
        if (d.date === todayStr) pausedMinutes.today += Number(d.pausedMinutes) || 0;
      }
      const pu = pause.rows[0] && pause.rows[0].pause_until;
      res.json({
        ok: true, user: { id: u.id, name: u.name || '' },
        collected: col.rows.map(r => ({ type: r.type, app: r.app, today: Number(r.today), week: Number(r.week) })),
        blocked, pausedMinutes, minutes, personalWeb: '수집 안 함',
        adminAccess: audit.rows.map(r => ({ ts: r.ts, actor: r.actor_name, endpoint: r.endpoint, scope: r.target_user_id === 'ALL' ? '전체/미지정' : '본인' })),
        pauseUntil: pu && new Date(pu) > new Date() ? new Date(pu).toISOString() : null,
        retentionDays: 30,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.auditMiddleware = auditMiddleware;
  return router;
};
