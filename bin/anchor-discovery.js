#!/usr/bin/env node
/**
 * anchor-discovery.js — 검증 앵커 자동 발견 엔진 (읽기 전용)
 *
 * 목적: 사람이 공식을 알려주지 않아도, 수집된 표에서 "항상 성립하는 산술 관계"를 스스로 찾는다.
 *       설연주/김원빈/가브리엘 앵커를 각각 손으로 적는 방식은 직원 수만큼 코드가 늘어 확장이 안 된다.
 *       엔진이 관계를 발견하면 같은 코드가 전 직원·전 양식에 적용된다.
 *
 * 원리: 앵커 = "서로 독립인 두 경로가 같은 값을 지목한다".
 *       표의 한 열(C)이 다른 열들(A,B)로부터 산술로 도출되는지 전 행에 걸쳐 검사한다.
 *       n행 중 몇 행에서 성립하는지(n/N)를 그대로 보고한다 — 통과율을 꾸미지 않는다.
 *
 * 사용: node _agent/anchor-discovery.js [--min-rows 5] [--user <uid>] [--out out.json]
 */
const fs = require('fs');
const path = require('path');
const V = JSON.parse(fs.readFileSync(process.env.TEMP + '/pgvars.json', 'utf8'));
const { Client } = require('C:/Users/USER/mindmap-viewer/node_modules/pg');

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MIN_ROWS = parseInt(argv('--min-rows', '5'), 10);
const ONLY_USER = argv('--user', null);
const OUT = argv('--out', null);

const NAME = {
  MNIAFICB3DC88DCB34: '설연주', MNMRX6SR07F5FF7C0C: '강현우',
  MNMR52IIBE1A1E37A2: '박성수', MN9B6750A0A37D561D: '박성수',
  MN506C7A6A710A046E: '조현욱', MNMSAQJD78E544A631: '강명훈',
  MNMRVD11EDCCF6E7CE: '김원빈', MNC78F666A0ADDE30E: '김원빈',
  MN8232D542A97C0862: '가브리엘', MNH03H73690BB2CD82: '임재용(사장)',
};

// ── 수치 파싱 ────────────────────────────────────────────────────────────────
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[,\s₩$]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
// 오차 허용.
// 금액(100 이상)은 원단위 반올림이 있으니 절대 1원까지 봐주고,
// 이익율 같은 소수는 절대허용을 쓰면 "이익율 = 매입액 × 0" 같은 헛것이 통과하므로 상대허용만 쓴다.
function close(a, b) {
  if (a == null || b == null) return false;
  const m = Math.abs(b);
  const tol = m >= 100 ? Math.max(1.0, m * 0.002) : m * 0.01;
  return Math.abs(a - b) <= tol;
}
const isInt = n => Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9;

// ── 표 만들기: rows[][] → {header, cols, data} ───────────────────────────────
function buildTable(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const width = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
  if (width < 3) return null;

  // 헤더 행 = 위쪽 행 중 "문자열이 많고 숫자가 적은" 행
  let hIdx = 0, best = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const r = rows[i] || [];
    let txt = 0, nums = 0;
    for (const c of r) {
      if (c == null || c === '') continue;
      if (num(c) != null) nums++; else txt++;
    }
    const score = txt - nums * 2;
    if (txt >= 2 && score > best) { best = score; hIdx = i; }
  }
  const header = [];
  for (let c = 0; c < width; c++) {
    const h = (rows[hIdx] || [])[c];
    header.push(h == null ? '' : String(h).trim());
  }
  const data = rows.slice(hIdx + 1).filter(r => Array.isArray(r) && r.some(c => c != null && c !== ''));
  if (data.length < MIN_ROWS) return null;

  // 숫자 열 = 데이터의 절반 이상이 숫자로 파싱되는 열.
  // ★ 단, 파일 안에서 값이 거의 안 변하는 열(순번·거래처코드·거래유형 같은 ID/상수)은 제외한다.
  //    고정값끼리는 아무 비율이나 갖다 붙여도 100% "성립"해서 가짜 앵커를 쏟아낸다.
  //    (실제로 "순번 = 거래유형 × 567.09  8/8" 같은 무의미한 결과가 나왔다.)
  const cols = [];
  for (let c = 0; c < width; c++) {
    let ok = 0, tot = 0;
    const distinct = new Set();
    for (const r of data) {
      const v = (r || [])[c];
      if (v == null || v === '') continue;
      tot++;
      const n = num(v);
      if (n != null) { ok++; distinct.add(n); }
    }
    if (tot >= MIN_ROWS && ok / tot >= 0.5 && distinct.size >= 3) cols.push(c);
  }
  return cols.length >= 2 ? { header, cols, data, hIdx } : null;
}

const cname = (t, c) => (t.header[c] && t.header[c] !== '' ? t.header[c] : `열${c + 1}`);

// ── 후보 관계 검사 ───────────────────────────────────────────────────────────
// 각 관계는 {label, test(rowValsByCol) -> 예측값} 형태. 전 행에 적용해 n/N 집계.
function evalRelation(t, targetCol, predict) {
  let hit = 0, n = 0;
  for (const r of t.data) {
    const actual = num((r || [])[targetCol]);
    if (actual == null) continue;
    const pred = predict(r);
    if (pred == null || !Number.isFinite(pred)) continue;
    n++;
    if (close(pred, actual)) hit++;
  }
  return { hit, n };
}

function discover(t) {
  const found = [];
  const C = t.cols;

  for (const z of C) {
    // (1) z = x * y      (2) z = x + y      (3) z = x - y
    for (const x of C) {
      if (x === z) continue;
      for (const y of C) {
        if (y === z || y === x) continue;
        // 곱·합은 순서를 바꿔도 같은 관계다(A×B == B×A). 한쪽만 보고 거울쌍 중복을 없앤다.
        const sameBoth = y > x;
        if (sameBoth) {
          const mul = evalRelation(t, z, r => { const a = num(r[x]), b = num(r[y]); return a == null || b == null ? null : a * b; });
          if (mul.n >= MIN_ROWS && mul.hit / mul.n >= 0.9)
            found.push({ kind: '곱', expr: `${cname(t, z)} = ${cname(t, x)} × ${cname(t, y)}`, ...mul });

          const add = evalRelation(t, z, r => { const a = num(r[x]), b = num(r[y]); return a == null || b == null ? null : a + b; });
          if (add.n >= MIN_ROWS && add.hit / add.n >= 0.9)
            found.push({ kind: '합', expr: `${cname(t, z)} = ${cname(t, x)} + ${cname(t, y)}`, ...add });
        }

        const sub = evalRelation(t, z, r => { const a = num(r[x]), b = num(r[y]); return a == null || b == null ? null : a - b; });
        if (sub.n >= MIN_ROWS && sub.hit / sub.n >= 0.9)
          found.push({ kind: '차', expr: `${cname(t, z)} = ${cname(t, x)} − ${cname(t, y)}`, ...sub });
      }

      // (4) z = x × k  — 비율 k 를 데이터에서 스스로 찾아낸다(0.1, 1.1, 0.8 등이 여기서 나온다)
      const ratios = [];
      for (const r of t.data) {
        const a = num(r[x]), b = num(r[z]);
        if (a == null || b == null || a === 0) continue;
        ratios.push(b / a);
      }
      if (ratios.length >= MIN_ROWS) {
        ratios.sort((p, q) => p - q);
        const k = ratios[Math.floor(ratios.length / 2)];   // 중앙값 = 이상치에 강함
        if (Number.isFinite(k) && Math.abs(k) > 1e-9 && Math.abs(k - 1) > 1e-9) {
          const kr = Math.round(k * 10000) / 10000;
          const res = evalRelation(t, z, r => { const a = num(r[x]); return a == null ? null : a * kr; });
          if (res.n >= MIN_ROWS && res.hit / res.n >= 0.9)
            found.push({ kind: '비율', expr: `${cname(t, z)} = ${cname(t, x)} × ${kr}`, ...res, k: kr });
        }
      }

      // (5) z = x × y ÷ k  — 부가세 포함/별도 같은 3항 관계 (곱이므로 거울쌍 제거)
      for (const y of C) {
        if (y === z || y <= x) continue;
        const ks = [];
        for (const r of t.data) {
          const a = num(r[x]), b = num(r[y]), c = num(r[z]);
          if (a == null || b == null || c == null || c === 0) continue;
          ks.push((a * b) / c);
        }
        if (ks.length >= MIN_ROWS) {
          ks.sort((p, q) => p - q);
          const k = Math.round(ks[Math.floor(ks.length / 2)] * 10000) / 10000;
          if (Number.isFinite(k) && Math.abs(k - 1) > 1e-6 && Math.abs(k) > 1e-9) {
            const res = evalRelation(t, z, r => { const a = num(r[x]), b = num(r[y]); return a == null || b == null ? null : (a * b) / k; });
            if (res.n >= MIN_ROWS && res.hit / res.n >= 0.9)
              found.push({ kind: '곱÷비율', expr: `${cname(t, z)} = ${cname(t, x)} × ${cname(t, y)} ÷ ${k}`, ...res, k });
          }
        }
      }
    }

    // (6) z = 여러 열의 합 — 합계/총계 열 찾기(연속 구간)
    for (let s = 0; s < C.length; s++) {
      for (let e = s + 2; e <= C.length; e++) {           // 최소 2개 이상 더함
        const grp = C.slice(s, e).filter(c => c !== z);
        if (grp.length < 2) continue;
        if (grp.some(c => c === z)) continue;
        // 스프레드시트의 빈칸은 합계에서 0으로 취급된다(발주 매트릭스는 대부분 칸이 비어 있다).
        // 빈칸을 null로 보고 건너뛰면 희소한 표에서 합계 열을 영영 못 찾는다.
        const res = evalRelation(t, z, r => {
          let sum = 0, got = 0;
          for (const c of grp) { const v = num(r[c]); if (v != null) { sum += v; got++; } }
          return got >= 1 ? sum : null;
        });
        if (res.n >= MIN_ROWS && res.hit / res.n >= 0.95) {
          found.push({
            kind: '합계열',
            expr: `${cname(t, z)} = Σ(${grp.map(c => cname(t, c)).join(' + ')})`.slice(0, 190),
            ...res, span: grp.length,
          });
        }
      }
    }
  }

  // 중복/포함관계 정리: 같은 대상 열에서 가장 많이 맞고, 더 단순한 것 우선
  const byTarget = new Map();
  for (const f of found) {
    const tgt = f.expr.split('=')[0].trim();
    const cur = byTarget.get(tgt) || [];
    cur.push(f);
    byTarget.set(tgt, cur);
  }
  const out = [];
  for (const [, list] of byTarget) {
    list.sort((a, b) => (b.hit / b.n) - (a.hit / a.n) || b.n - a.n || (a.span || 0) - (b.span || 0));
    const seenExpr = new Set();
    for (const f of list) {
      if (seenExpr.has(f.expr)) continue;   // 같은 식이 두 번 잡히는 경우 제거
      seenExpr.add(f.expr);
      out.push(f);
      if (seenExpr.size >= 2) break;        // 대상 열당 최대 2개
    }
  }
  return out.sort((a, b) => b.n - a.n);
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
(async () => {
  const c = new Client({ connectionString: V.DATABASE_PUBLIC_URL || V.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const where = ONLY_USER ? `AND user_id = '${ONLY_USER.replace(/'/g, '')}'` : '';
  const r = await c.query(`
    SELECT user_id, data_json->>'file' f, data_json->>'sheet' s, data_json->'rows' rows
    FROM events WHERE type='excel.sheet' AND jsonb_typeof(data_json->'rows')='array' ${where}
    ORDER BY timestamp DESC`);
  await c.end();

  // 같은 (사람,파일,시트)는 최신 1건만
  const seen = new Set(), tables = [];
  for (const row of r.rows) {
    const key = `${row.user_id}|${row.f}|${row.s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push(row);
  }

  const byUser = new Map();
  let scanned = 0, withAnchor = 0;
  for (const row of tables) {
    const t = buildTable(row.rows);
    if (!t) continue;
    scanned++;
    const anchors = discover(t);
    if (!anchors.length) continue;
    withAnchor++;
    const who = NAME[row.user_id] || row.user_id;
    if (!byUser.has(who)) byUser.set(who, []);
    byUser.get(who).push({ file: row.f, sheet: row.s, rows: t.data.length, anchors });
  }

  console.log(`표 ${tables.length}개 중 분석가능 ${scanned}개 · 앵커 발견 ${withAnchor}개`);
  console.log(`(공식을 하나도 알려주지 않고 데이터에서만 찾은 결과)\n`);

  const order = ['설연주', '김원빈', '가브리엘', '조현욱', '박성수', '강현우', '강명훈', '임재용(사장)'];
  const users = [...byUser.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const who of users) {
    const files = byUser.get(who);
    const total = files.reduce((s, f) => s + f.anchors.length, 0);
    console.log(`━━ ${who} — 파일 ${files.length}개 · 앵커 ${total}개 ━━`);
    files.sort((a, b) => b.anchors.length - a.anchors.length);
    for (const f of files.slice(0, 4)) {
      console.log(`  📄 ${f.file}${f.sheet ? ' [' + f.sheet + ']' : ''}  (${f.rows}행)`);
      for (const a of f.anchors.slice(0, 5)) {
        const pct = (a.hit / a.n * 100).toFixed(1);
        const mark = a.hit === a.n ? '✔' : (a.hit / a.n >= 0.95 ? '·' : '△');
        console.log(`     ${mark} ${a.expr}`);
        console.log(`        ${a.hit}/${a.n} (${pct}%) · ${a.kind}`);
      }
    }
    console.log();
  }

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify([...byUser].map(([who, files]) => ({ who, files })), null, 1), 'utf8');
    console.log('저장: ' + path.resolve(OUT));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
