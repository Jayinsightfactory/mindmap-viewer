// 일회성: 이미 저장된 deepdive 리포트의 userName을 설치 원장(all-users) 실명으로 교체 (LLM 재실행 없음)
const https = require('https');
const BASE = 'mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = process.env.OPS_TOKEN || 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: BASE, path, method, headers: {
      'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN,
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const au = await req('GET', '/api/admin/all-users');
  const valid = n => n && !/�/.test(n) && n.trim();
  const nameById = {}; (au.users || []).forEach(u => { if (u.id && valid(u.name)) nameById[u.id] = u.name.trim(); });
  const ids = (au.users || []).map(u => u.id);
  let fixed = 0, skip = 0;
  for (const id of ids) {
    const got = await req('GET', `/api/flow/ops-report?kind=deepdive:${id}`);
    const rep = got && got.latest && got.latest.report;
    if (!rep) continue;
    const real = nameById[id];
    if (!real) { console.log(`  [${id.slice(0,10)}] 원장 이름 없음/깨짐 — 건너뜀`); skip++; continue; }
    if (rep.userName === real && rep.user === real) { continue; }
    rep.userName = real; if (rep.user) rep.user = real;
    await req('POST', '/api/flow/ops-report', { kind: 'deepdive:' + id, source: 'deep-dive', report: rep });
    console.log(`  [${id.slice(0,10)}] userName → ${real}`);
    fixed++;
  }
  console.log(`완료: ${fixed}건 실명화, ${skip}건 건너뜀`);
})();
