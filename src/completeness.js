// [2026-10-21 사장님 지시] 직원 작업데이터 완전성 게이트 — "받은 만큼"이 아니라 "받아야 할 양 대비 얼마나 받았는지".
//   설계 문서: docs/WORK_DATA_COMPLETENESS_DESIGN.md (감지 → 원인분류 → 자동복구 → 보고)
//   ① 집계: 직원·일자(KST)별 screen.capture(수신 캡처)·screen.analyzed(분석)·keyboard/mouse.chunk(활동)·daemon.heartbeat 수
//   ② 기대치: 최근 4주 같은 요일 캡처 수의 중앙값. 수신률 = 캡처/기대치. 50% 미만 = '유실'.
//   ③ 캡처 0 분류(heartbeat × 활동 × 캡처 교차): 데몬 다운 / PC 꺼짐 / 사람 미사용 / 큐 적체 / 장기 무응답(데몬 다운 의심)
//   ④ 자동복구: '데몬 다운'이면 그 PC 큐(orbit_daemon_commands, 데몬이 폴링하는 살아있는 hostname 키)에 restart 1건. 호스트당 하루 1회.
//      카나리: COMPLETENESS_AUTO_RESTART=off|canary|all (기본 canary), COMPLETENESS_CANARY_HOSTS=호스트1,호스트2 (소문자 비교).
//      10/12 사고(ALL 큐 미소비 재전달 루프) 재발 방지: ALL 큐 사용 금지, 개별 호스트 PG 큐만, ctid 소비(기존 GET /api/daemon/commands).
//   ⑤ 보고: GET /api/completeness/report-line → 카톡 일일보고(nenovakakao/send_report.py)에 한 줄.
//   메모리: 집계는 GROUP BY 결과(직원×일×타입 수백 행)만 들고 10분 캐시. 원본 행을 서버로 끌어오지 않는다(콜드부팅 OOM 주의).
'use strict';

const TYPES = ['screen.capture', 'screen.analyzed', 'keyboard.chunk', 'mouse.chunk', 'daemon.heartbeat'];
const LOOKBACK_DAYS = 35; // 7일 창 + 4주 기대치
const THRESHOLD = 0.5;
const CACHE_MS = 10 * 60 * 1000;
const KST = 9 * 3600e3;
const kstDate = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay(); // 0=일
const isWeekday = (d) => { const w = weekdayOf(d); return w >= 1 && w <= 5; };
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

let _cache = { at: 0, data: null };

async function aggregate(pool) {
  if (_cache.data && Date.now() - _cache.at < CACHE_MS) return _cache.data;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
  // timestamp 는 TEXT(ISO) — timestamptz 로 캐스팅 후 KST 일자로 묶는다(UTC/KST 혼용 함정)
  const { rows } = await pool.query(
    `SELECT user_id, type, to_char((timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
       FROM events
      WHERE type = ANY($1) AND timestamp >= $2 AND user_id NOT IN ('local','system')
      GROUP BY 1, 2, 3`, [TYPES, since]);
  // 직원별 최신 heartbeat(시각·hostname) — daemon-health 는 1시간 창이라 며칠 죽은 PC 는 아예 안 보이는 사각지대를 메운다
  const { rows: hb } = await pool.query(
    `SELECT DISTINCT ON (user_id) user_id, timestamp, data_json->>'hostname' AS hostname
       FROM events WHERE type = 'daemon.heartbeat' AND timestamp >= $1
      ORDER BY user_id, timestamp DESC`, [since]);
  // 데몬이 실제로 폴링하는 살아있는 hostname 키 = 최근 소비된 명령의 hostname (대소문자 분열 함정 대비)
  let liveKeys = [];
  try { liveKeys = (await pool.query(`SELECT DISTINCT ON (lower(hostname)) hostname, consumed_at FROM orbit_daemon_commands WHERE consumed_at IS NOT NULL AND consumed_at > NOW() - INTERVAL '14 days' ORDER BY lower(hostname), consumed_at DESC`)).rows; } catch {}
  let names = {};
  try { (await pool.query('SELECT id, name FROM orbit_auth_users')).rows.forEach((u) => { names[u.id] = u.name || ''; }); } catch {}
  const byUser = {};
  for (const r of rows) {
    const u = byUser[r.user_id] || (byUser[r.user_id] = {});
    const day = u[r.d] || (u[r.d] = { capture: 0, analyzed: 0, keyboard: 0, mouse: 0, heartbeat: 0 });
    day[{ 'screen.capture': 'capture', 'screen.analyzed': 'analyzed', 'keyboard.chunk': 'keyboard', 'mouse.chunk': 'mouse', 'daemon.heartbeat': 'heartbeat' }[r.type]] += r.n;
  }
  const lastHb = {}; for (const r of hb) lastHb[r.user_id] = { at: r.timestamp, hostname: r.hostname || null };
  _cache = { at: Date.now(), data: { byUser, lastHb, liveKeys: liveKeys.map((k) => k.hostname), names } };
  return _cache.data;
}

// 캡처 0건 날의 원인 분류. day = 그날 집계, ctx = { lastHbAt, silentWeekdays }
function classifyZero(day, ctx) {
  const input = (day.keyboard || 0) + (day.mouse || 0);
  if (day.heartbeat > 0 && input > 0) return { cause: 'daemon-down', label: '데몬 다운(캡처 모듈 죽음: PC 켜짐·입력 있음·캡처 0)', restart: true };
  if (day.heartbeat > 0 && input === 0) return { cause: 'unused', label: '사람 미사용(PC 켜짐·입력 0)', restart: false };
  if (day.heartbeat === 0 && input > 0) return { cause: 'daemon-down', label: '데몬 다운(heartbeat 모듈 죽음: 입력은 도착)', restart: true };
  if (ctx.silentWeekdays >= 2) return { cause: 'long-silent', label: `장기 무응답 ${ctx.silentWeekdays}평일(데몬 다운 의심 — restart 큐로 PC 꺼짐과 구분: 소비되면 켜져 있던 것)`, restart: true };
  return { cause: 'pc-off', label: 'PC 꺼짐(heartbeat·입력·캡처 모두 0)', restart: false };
}

function buildReport(agg, days) {
  const todayMs = Date.now();
  const today = kstDate(todayMs);
  const window = []; for (let i = days - 1; i >= 0; i--) window.push(kstDate(todayMs - i * 864e5));
  const employees = [];
  for (const [uid, byDay] of Object.entries(agg.byUser)) {
    const name = agg.names[uid] || uid;
    const dayRows = [];
    // 장기 무응답: 오늘부터 거슬러 heartbeat 0 인 평일 수
    let silentWeekdays = 0;
    for (let i = 0; i < 14; i++) { const d = kstDate(todayMs - i * 864e5); if (!isWeekday(d)) continue; if ((byDay[d]?.heartbeat || 0) > 0) break; silentWeekdays++; }
    for (const d of window) {
      const day = byDay[d] || { capture: 0, analyzed: 0, keyboard: 0, mouse: 0, heartbeat: 0 };
      const hist = []; for (let w = 1; w <= 4; w++) { const pd = kstDate(Date.parse(d + 'T00:00:00Z') - w * 7 * 864e5); hist.push(byDay[pd]?.capture || 0); }
      const expected = median(hist);
      const ratio = expected > 0 ? Math.round((day.capture / expected) * 1000) / 10 : null;
      let status, cause = null;
      if (day.capture === 0 && day.analyzed === 0) {
        if (!isWeekday(d) || expected === 0) { status = 'none'; }
        else { const c = classifyZero(day, { silentWeekdays }); status = 'lost'; cause = c; }
      } else if (day.capture > 0 && day.analyzed === 0 && d !== today) { status = 'lost'; cause = { cause: 'queue-backlog', label: `큐 적체(캡처 ${day.capture}건·분석 0)`, restart: false }; }
      else if (ratio !== null && ratio < THRESHOLD * 100) { status = 'lost'; cause = { cause: 'partial', label: `부분 유실(기대 ${expected}·수신 ${day.capture})`, restart: false }; }
      else status = 'ok';
      dayRows.push({ date: d, weekday: '일월화수목금토'[weekdayOf(d)], ...day, expected, receivedPct: ratio, status, cause });
    }
    const wk = dayRows.filter((r) => isWeekday(r.date) && r.expected > 0);
    const sumExp = wk.reduce((a, r) => a + r.expected, 0), sumGot = wk.reduce((a, r) => a + Math.min(r.capture, r.expected), 0);
    const overallPct = sumExp ? Math.round((sumGot / sumExp) * 1000) / 10 : null;
    const lostDays = dayRows.filter((r) => r.status === 'lost');
    employees.push({ userId: uid, name, hostname: agg.lastHb[uid]?.hostname || null, lastHeartbeatAt: agg.lastHb[uid]?.at || null, silentWeekdays,
      overallPct, lost: overallPct !== null && overallPct < THRESHOLD * 100, lostDays: lostDays.length,
      causes: lostDays.reduce((m, r) => { m[r.cause.cause] = (m[r.cause.cause] || 0) + 1; return m; }, {}), days: dayRows });
  }
  employees.sort((a, b) => (a.overallPct ?? 101) - (b.overallPct ?? 101));
  return { ok: true, generatedAt: new Date().toISOString(), today, days, threshold: THRESHOLD, rule: '기대치=최근 4주 같은 요일 캡처 수 중앙값. 수신률=캡처/기대치(일별 100% 상한으로 합산). 50% 미만=유실. 캡처 0 분류=heartbeat×입력(keyboard/mouse.chunk)×캡처 교차.', employees };
}

// 자동복구: '데몬 다운'(오늘 또는 어제) / '장기 무응답' 직원의 PC 에 restart 1건. 호스트당 하루 1회, 카나리 게이트.
async function autoRecover(pool, report, agg, opts = {}) {
  const mode = String(process.env.COMPLETENESS_AUTO_RESTART || 'canary').toLowerCase();
  const canary = String(process.env.COMPLETENESS_CANARY_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = { mode, canary, actions: [] };
  if (mode === 'off') return out;
  await pool.query(`CREATE TABLE IF NOT EXISTS orbit_completeness_actions (id SERIAL PRIMARY KEY, user_id TEXT, hostname TEXT, kst_date TEXT, cause TEXT, action TEXT, ts TIMESTAMPTZ DEFAULT NOW(), dry_run BOOLEAN DEFAULT FALSE)`);
  const today = report.today, yesterday = kstDate(Date.now() - 864e5);
  for (const e of report.employees) {
    const recent = e.days.filter((d) => (d.date === today || d.date === yesterday) && d.cause && d.cause.restart);
    if (!recent.length || !e.hostname) continue;
    const cause = recent[recent.length - 1].cause.cause;
    // 살아있는 폴링 키(최근 소비된 명령의 hostname 표기) 우선, 없으면 heartbeat 의 hostname
    const live = agg.liveKeys.find((k) => k.toLowerCase() === e.hostname.toLowerCase()) || e.hostname;
    const allowed = mode === 'all' || canary.includes(live.toLowerCase());
    const { rows: done } = await pool.query(`SELECT 1 FROM orbit_completeness_actions WHERE lower(hostname) = lower($1) AND kst_date = $2 AND dry_run = FALSE LIMIT 1`, [live, today]);
    if (done.length) { out.actions.push({ name: e.name, hostname: live, cause, action: 'skip', why: '오늘 이미 발송' }); continue; }
    if (!allowed || opts.dryRun) {
      await pool.query(`INSERT INTO orbit_completeness_actions (user_id, hostname, kst_date, cause, action, dry_run) VALUES ($1,$2,$3,$4,'restart',TRUE)`, [e.userId, live, today, cause]).catch(() => {});
      out.actions.push({ name: e.name, hostname: live, cause, action: 'dry-run', why: opts.dryRun ? 'dryRun 요청' : `카나리 밖(${mode})` }); continue;
    }
    // 대기 중 같은 호스트 restart 가 이미 있으면 중복 적재 금지
    const { rows: pend } = await pool.query(`SELECT 1 FROM orbit_daemon_commands WHERE hostname = $1 AND action = 'restart' AND consumed_at IS NULL LIMIT 1`, [live]);
    if (pend.length) { out.actions.push({ name: e.name, hostname: live, cause, action: 'skip', why: '미소비 restart 대기 중' }); continue; }
    await pool.query(`INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,'restart',NULL,$2,NOW())`, [live, JSON.stringify({ reason: 'completeness-auto', cause })]);
    await pool.query(`INSERT INTO orbit_completeness_actions (user_id, hostname, kst_date, cause, action) VALUES ($1,$2,$3,$4,'restart')`, [e.userId, live, today, cause]);
    console.log(`[completeness] auto restart 큐: ${e.name} ${live} (${cause})`);
    out.actions.push({ name: e.name, hostname: live, cause, action: 'restart-queued' });
  }
  return out;
}

function reportLine(report, actions) {
  const lost = report.employees.filter((e) => e.lost || e.lostDays > 0);
  const KO = { 'daemon-down': '데몬다운', 'pc-off': 'PC꺼짐', unused: '미사용', 'queue-backlog': '큐적체', 'long-silent': '장기무응답', partial: '부분' };
  const parts = lost.slice(0, 8).map((e) => `${e.name} ${e.overallPct === null ? '-' : e.overallPct + '%'}(${Object.entries(e.causes).map(([c, n]) => (KO[c] || c) + n).join('·')})`);
  const sent = (actions?.actions || []).filter((a) => a.action === 'restart-queued').map((a) => `${a.name}/${a.hostname}`);
  return `작업데이터 수신(최근 ${report.days}일, 50% 미만=유실): 유실 ${lost.length}명` + (parts.length ? ' — ' + parts.join(', ') : '') + (sent.length ? ` / 자동 restart 발송: ${sent.join(', ')}` : '');
}

function mount(app, { dbModule, adminOk }) {
  const guard = async (req, res) => { const code = await adminOk(req); if (code) { res.status(code).json({ error: code === 401 ? 'unauthorized' : 'admin only' }); return false; } return true; };
  const pool = () => (dbModule.getDb ? dbModule.getDb() : null);

  // GET /api/completeness?days=7 — 직원×일자 수신/분석/활동/heartbeat/기대치/수신률/원인
  app.get('/api/completeness', async (req, res) => {
    try {
      if (!(await guard(req, res))) return;
      const p = pool(); if (!p?.query) return res.status(503).json({ error: 'DB not available' });
      const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 28);
      const agg = await aggregate(p);
      const rep = buildReport(agg, days);
      try { const { rows } = await p.query(`SELECT user_id, hostname, kst_date, cause, action, ts, dry_run FROM orbit_completeness_actions WHERE ts > NOW() - INTERVAL '14 days' ORDER BY ts DESC LIMIT 100`); rep.actions = rows; } catch { rep.actions = []; }
      res.json(rep);
    } catch (e) { console.error('[completeness] error:', e.message); res.status(500).json({ error: e.message }); }
  });
  // POST /api/completeness/recover?dryRun=1 — 분류 결과대로 자동복구 1회 실행(관리자). 예약 실행과 같은 함수.
  app.post('/api/completeness/recover', async (req, res) => {
    try {
      if (!(await guard(req, res))) return;
      const p = pool(); if (!p?.query) return res.status(503).json({ error: 'DB not available' });
      const agg = await aggregate(p); const rep = buildReport(agg, 2);
      const out = await autoRecover(p, rep, agg, { dryRun: req.query.dryRun === '1' });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // GET /api/completeness/report-line — 카톡 일일 보고용 한 줄(텍스트)
  app.get('/api/completeness/report-line', async (req, res) => {
    try {
      if (!(await guard(req, res))) return;
      const p = pool(); if (!p?.query) return res.status(503).send('DB not available');
      const agg = await aggregate(p); const rep = buildReport(agg, Math.min(parseInt(req.query.days) || 7, 28));
      let acts = { actions: [] };
      try { const { rows } = await p.query(`SELECT user_id, hostname, cause, action FROM orbit_completeness_actions WHERE kst_date = $1 AND dry_run = FALSE`, [rep.today]); acts.actions = rows.map((r) => ({ name: agg.names[r.user_id] || r.user_id, hostname: r.hostname, action: 'restart-queued' })); } catch {}
      res.type('text/plain').send(reportLine(rep, acts));
    } catch (e) { res.status(500).send(e.message); }
  });

  // 예약: 1시간마다, 평일 09~19 KST 에만 자동복구 점검(사람이 쓰는 시간에 PC 켜짐·입력 있음·캡처 0 을 잡는다)
  setInterval(async () => {
    try {
      const h = new Date(Date.now() + KST).getUTCHours(), d = new Date(Date.now() + KST).getUTCDay();
      if (d === 0 || d === 6 || h < 9 || h > 19) return;
      const p = pool(); if (!p?.query) return;
      const agg = await aggregate(p); const rep = buildReport(agg, 2);
      const out = await autoRecover(p, rep, agg);
      const sent = out.actions.filter((a) => a.action === 'restart-queued');
      if (sent.length) console.log('[completeness] 자동복구', JSON.stringify(sent));
    } catch (e) { console.warn('[completeness] 예약 점검 실패:', e.message); }
  }, 60 * 60 * 1000).unref();
  console.log('[completeness] mounted: /api/completeness, /recover, /report-line (auto-restart=' + (process.env.COMPLETENESS_AUTO_RESTART || 'canary') + ')');
}

module.exports = { mount, buildReport, classifyZero, reportLine, median };
