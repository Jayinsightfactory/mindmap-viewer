#!/usr/bin/env node
/**
 * bin/po-pull.js — 온디맨드 발주서(PO) xlsx 업로더 (데몬 exec로 실행)
 * excel-collector 와 동일 정책(발주 키워드 파일만)이나, file-change 없이 "지금" 선별해
 * 기존 /api/daemon/excel-ingest 로 올린다. 결과 셀값은 서버 excel.sheet 이벤트로 저장됨.
 * 안전: PO 키워드 파일만, 1.2MB 이하, 업로드 외 아무 것도 안 함(원본 미변경).
 *   node bin/po-pull.js --list                       # 후보만 출력, 업로드 안 함
 *   node bin/po-pull.js [--name 초이문] [--max N]     # 매칭 최신 N개(기본1) 업로드
 */
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), http = require('http');
const PO_KEYWORDS = ['발주', '라움', '주광', '초이문'];
const EXCEL_EXT = /\.xlsx?$/i, MAX = 1.2 * 1024 * 1024;
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const _ni = args.indexOf('--name');
const nameKw = (_ni >= 0 && args[_ni + 1] && !args[_ni + 1].startsWith('--')) ? args[_ni + 1] : null;
const _mi = args.indexOf('--max');
const maxN = parseInt((_mi >= 0 && args[_mi + 1]) || '1', 10) || 1;

let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); } catch {}
const BASE = cfg.serverUrl || 'https://mindmap-viewer-production-adb2.up.railway.app';
const TOKEN = (cfg.token || '').trim();
const HOST = os.hostname();

const roots = [
  path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Documents', '카카오톡 받은 파일'),
  'C:\\Users\\Public\\Documents',
];
function walk(dir, depth, out) {
  if (depth < 0) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(fp, depth - 1, out); }
    else if (EXCEL_EXT.test(e.name) && !e.name.startsWith('~$')) out.push(fp);
  }
}
function isPO(name) { return PO_KEYWORDS.some(k => name.includes(k)) && (!nameKw || name.includes(nameKw)); }

const found = [];
for (const r of roots) walk(r, 3, found);
let cand = [...new Set(found)].filter(fp => isPO(path.basename(fp)))
  .map(fp => { try { const st = fs.statSync(fp); return { fp, name: path.basename(fp), size: st.size, mtime: st.mtimeMs }; } catch { return null; } })
  .filter(Boolean).sort((a, b) => b.mtime - a.mtime);

if (listOnly) {
  console.log('[po-pull] 후보 ' + cand.length + '개 (host=' + HOST + '):');
  cand.slice(0, 15).forEach(c => console.log('  ' + (c.size / 1024).toFixed(0) + 'KB  ' + new Date(c.mtime).toISOString().slice(0, 16) + '  ' + c.name));
  process.exit(0);
}
cand = cand.filter(c => c.size <= MAX).slice(0, maxN);
if (!cand.length) { console.log('[po-pull] 업로드 대상 없음(키워드/용량 필터)'); process.exit(0); }

function upload(c) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ filename: c.name, fileBase64: fs.readFileSync(c.fp).toString('base64'), hostname: HOST, mtime: new Date(c.mtime).toISOString(), sizeBytes: c.size });
    const u = new URL(BASE); const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: '/api/daemon/excel-ingest', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN, 'x-device-id': encodeURIComponent(HOST), 'Content-Length': Buffer.byteLength(body) }, timeout: 60000 },
      res => { let d = ''; res.on('data', x => d += x); res.on('end', () => { console.log('[po-pull] ' + c.name + ' -> HTTP ' + res.statusCode + ' ' + d.slice(0, 120)); resolve(); }); });
    req.on('error', e => { console.log('[po-pull] ' + c.name + ' ERR ' + e.message); resolve(); });
    req.on('timeout', () => { req.destroy(); console.log('[po-pull] ' + c.name + ' TIMEOUT'); resolve(); });
    req.write(body); req.end();
  });
}
(async () => { for (const c of cand) await upload(c); })();
