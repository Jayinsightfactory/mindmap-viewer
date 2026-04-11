/**
 * sync-nenova-orders.js
 * 로컬 PC에서 실행: nenova SQL Server → Railway parsed_orders
 *
 * 실행: node scripts/sync-nenova-orders.js [days=30] [batch=200]
 */

const sql = require('mssql');
const https = require('https');

// ── 설정 ─────────────────────────────────────────────────────────────────────
const NENOVA_CONFIG = {
  server: 'sql16ssd-014.localnet.kr',
  port: 1433,
  database: 'nenova1_nenova',
  user: 'nenova1_nenova',
  password: 'nenova1257',
  options: { encrypt: false, trustServerCertificate: true, requestTimeout: 60000 },
};

const RAILWAY_URL = 'https://mindmap-viewer-production-adb2.up.railway.app';
const ADMIN_SECRET = '50d917748fb4e13871b70e69c3c1b98dde4ea34c5ba40f5d';
const BATCH_SIZE   = parseInt(process.argv[3]) || 200;
const DAYS         = parseInt(process.argv[2]) || 30;

// ── HTTP POST helper ──────────────────────────────────────────────────────────
function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(RAILWAY_URL + path);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(data),
        'X-Admin-Secret':  ADMIN_SECRET,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[sync-orders] nenova 주문 동기화 시작 (최근 ${DAYS}일, 배치 ${BATCH_SIZE}건)`);

  // 1. nenova 연결
  const pool = await sql.connect(NENOVA_CONFIG);
  console.log('[sync-orders] nenova SQL Server 연결 완료');

  // 2. 전체 건수 확인
  const countResult = await pool.request()
    .input('cutoff', sql.DateTime, new Date(Date.now() - DAYS * 86400000))
    .query(`
      SELECT COUNT(*) AS cnt
      FROM OrderDetail od
      JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
      WHERE ISNULL(om.isDeleted,0)=0 AND ISNULL(od.isDeleted,0)=0
        AND om.CreateDtm >= @cutoff
    `);
  const total = countResult.recordset[0].cnt;
  console.log(`[sync-orders] 대상 주문상세: ${total}건`);

  // 3. 페이지 단위로 가져와서 push
  let offset = 0, totalSynced = 0, totalSkipped = 0, totalErrors = 0;

  while (offset < total) {
    const result = await pool.request()
      .input('cutoff', sql.DateTime, new Date(Date.now() - DAYS * 86400000))
      .input('offset', sql.Int, offset)
      .input('batch',  sql.Int, BATCH_SIZE)
      .query(`
        SELECT
          om.OrderMasterKey, om.OrderDtm, om.OrderYear, om.OrderWeek, om.OrderCode,
          c.CustName,
          od.OrderDetailKey, od.ProdKey,
          p.ProdName, p.FlowerName, p.CounName,
          od.BoxQuantity, od.BunchQuantity, od.SteamQuantity, od.OutQuantity, od.EstQuantity
        FROM (
          SELECT od2.OrderDetailKey AS dk
          FROM OrderDetail od2
          JOIN OrderMaster om2 ON od2.OrderMasterKey = om2.OrderMasterKey
          WHERE ISNULL(om2.isDeleted,0)=0 AND ISNULL(od2.isDeleted,0)=0
            AND om2.CreateDtm >= @cutoff
          ORDER BY om2.CreateDtm DESC, od2.OrderDetailKey
          OFFSET @offset ROWS FETCH NEXT @batch ROWS ONLY
        ) paged
        JOIN OrderDetail od ON od.OrderDetailKey = paged.dk
        JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
        JOIN Product p      ON od.ProdKey = p.ProdKey
        LEFT JOIN Customer c ON om.CustKey = c.CustKey
      `);

    const orders = result.recordset;
    if (orders.length === 0) break;

    const resp = await postJSON('/api/nenova/import/orders', { orders });
    totalSynced  += resp.synced  || 0;
    totalSkipped += resp.skipped || 0;
    totalErrors  += resp.errors  || 0;

    offset += BATCH_SIZE;
    const pct = Math.min(100, Math.round(offset / total * 100));
    process.stdout.write(`\r[sync-orders] ${offset}/${total} (${pct}%) | 신규 ${totalSynced} 건너뜀 ${totalSkipped} 오류 ${totalErrors}  `);
  }

  console.log(`\n[sync-orders] 완료 → 신규: ${totalSynced}, 건너뜀: ${totalSkipped}, 오류: ${totalErrors}`);
  await sql.close();
}

main().catch(e => {
  console.error('[sync-orders] 오류:', e.message);
  process.exit(1);
});
