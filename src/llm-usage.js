'use strict';
/**
 * llm-usage.js — 모든 Anthropic API 호출의 토큰/비용을 호출자(caller)별로 기록.
 * "API 비용이 어디서 나가는지" 대시보드로 보이게 하는 계측 레이어.
 *
 * 사용:
 *   const llm = require('./llm-usage');
 *   const client = llm.wrap(new Anthropic(), 'insight-engine');  // messages.create 자동 기록
 *   llm.record('content-analyzer', model, { input_tokens, output_tokens });  // 수동 기록(gateway용)
 *   await llm.ensureTable(pool);  // 부팅 시
 *   await llm.summary(pool, 14);  // 조회
 */

let _pool = null;
const _mem = []; // 최근 메모리 버퍼 (DB 없을 때 폴백, 최대 2000)

// 모델별 단가 ($/1M tokens) — 2026 기준
const PRICE = {
  'claude-haiku-4-5':   { in: 1.00, out: 5.00 },
  'claude-3-5-haiku':   { in: 0.80, out: 4.00 },
  'claude-sonnet-4':    { in: 3.00, out: 15.00 },
  'claude-opus-4':      { in: 5.00, out: 25.00 },
  default:              { in: 1.00, out: 5.00 },
};
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku-4')) return PRICE['claude-haiku-4-5'];
  if (m.includes('haiku')) return PRICE['claude-3-5-haiku'];
  if (m.includes('sonnet')) return PRICE['claude-sonnet-4'];
  if (m.includes('opus')) return PRICE['claude-opus-4'];
  return PRICE.default;
}

async function ensureTable(pool) {
  _pool = pool || _pool;
  if (!_pool) return;
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS orbit_llm_usage (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      caller      TEXT NOT NULL,
      model       TEXT NOT NULL,
      in_tokens   INTEGER NOT NULL DEFAULT 0,
      out_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd    NUMERIC(10,6) NOT NULL DEFAULT 0
    )`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_llmusage_ts ON orbit_llm_usage(ts)`);
  await _pool.query(`CREATE INDEX IF NOT EXISTS idx_llmusage_caller ON orbit_llm_usage(caller)`);
}

function setPool(pool) { _pool = pool || _pool; }

// 호출 1건 기록 (caller=호출자 라벨, model, usage={input_tokens,output_tokens})
function record(caller, model, usage) {
  try {
    const inTok = (usage && (usage.input_tokens || usage.inputTokens)) || 0;
    const outTok = (usage && (usage.output_tokens || usage.outputTokens)) || 0;
    if (!inTok && !outTok) return;
    const p = priceFor(model);
    const cost = (inTok * p.in + outTok * p.out) / 1e6;
    _mem.push({ ts: Date.now(), caller, model, inTok, outTok, cost });
    if (_mem.length > 2000) _mem.splice(0, _mem.length - 2000);
    if (_pool) {
      _pool.query(
        `INSERT INTO orbit_llm_usage (caller, model, in_tokens, out_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5)`,
        [String(caller || 'unknown').slice(0, 60), String(model || '?').slice(0, 60), inTok, outTok, cost]
      ).catch(() => {});
    }
  } catch {}
}

// Anthropic SDK client.messages.create 를 감싸 자동 기록
function wrap(client, caller) {
  try {
    if (!client || !client.messages || client.__llmWrapped) return client;
    const orig = client.messages.create.bind(client.messages);
    client.messages.create = async function (body, ...rest) {
      const resp = await orig(body, ...rest);
      try { record(caller, body && body.model, resp && resp.usage); } catch {}
      return resp;
    };
    client.__llmWrapped = true;
  } catch {}
  return client;
}

// 집계 조회 (최근 N일): 호출자별 / 모델별 / 일자별
async function summary(pool, days = 14) {
  _pool = pool || _pool;
  if (!_pool) {
    // DB 없으면 메모리 폴백
    const byCaller = {};
    for (const r of _mem) { (byCaller[r.caller] = byCaller[r.caller] || { caller: r.caller, cost: 0, calls: 0 }); byCaller[r.caller].cost += r.cost; byCaller[r.caller].calls++; }
    return { source: 'memory', byCaller: Object.values(byCaller).sort((a, b) => b.cost - a.cost) };
  }
  const since = `NOW() - INTERVAL '${parseInt(days) || 14} days'`;
  const [byCaller, byModel, byDay, total] = await Promise.all([
    _pool.query(`SELECT caller, COUNT(*) calls, SUM(in_tokens) in_tok, SUM(out_tokens) out_tok, SUM(cost_usd) cost FROM orbit_llm_usage WHERE ts > ${since} GROUP BY caller ORDER BY cost DESC`),
    _pool.query(`SELECT model, COUNT(*) calls, SUM(cost_usd) cost FROM orbit_llm_usage WHERE ts > ${since} GROUP BY model ORDER BY cost DESC`),
    _pool.query(`SELECT to_char(ts AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS dt, SUM(cost_usd) cost, COUNT(*) calls FROM orbit_llm_usage WHERE ts > ${since} GROUP BY dt ORDER BY dt`),
    _pool.query(`SELECT SUM(cost_usd) cost, COUNT(*) calls FROM orbit_llm_usage WHERE ts > ${since}`),
  ]);
  const num = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;
  return {
    source: 'db', days: parseInt(days) || 14,
    total: { cost: num(total.rows[0]?.cost), calls: Number(total.rows[0]?.calls || 0) },
    byCaller: byCaller.rows.map(r => ({ caller: r.caller, calls: Number(r.calls), inTokens: Number(r.in_tok), outTokens: Number(r.out_tok), cost: num(r.cost) })),
    byModel: byModel.rows.map(r => ({ model: r.model, calls: Number(r.calls), cost: num(r.cost) })),
    byDay: byDay.rows.map(r => ({ day: r.dt, cost: num(r.cost), calls: Number(r.calls) })),
  };
}

module.exports = { ensureTable, setPool, record, wrap, summary, priceFor };
