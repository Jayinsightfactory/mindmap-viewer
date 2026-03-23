'use strict';
/**
 * log-server.js — 실시간 활동 로그 로컬 전용 서버
 *
 * 대시보드(Railway)에는 표시하지 않고, 관리자 맥에서만 확인
 * 실행: node tools/log-server.js
 * 접속: http://localhost:4848
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.LOG_PORT || 4848;
const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://sparkling-determination-production-c88b.up.railway.app';

// ── 토큰 로드 ──
function loadToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.orbit-config.json'), 'utf8'));
    return cfg.token || '';
  } catch { return ''; }
}

// ── Railway API 호출 ──
function apiGet(endpoint) {
  return new Promise((resolve) => {
    const token = loadToken();
    const url = new URL(endpoint, ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Authorization': 'Bearer ' + token };
    const req = mod.get({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers, timeout: 15000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ── HTML 페이지 ──
const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>Orbit AI — 실시간 활동 로그 (로컬)</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--green:#3fb950;--blue:#58a6ff;--red:#f85149;--orange:#ffa657;--purple:#bc8cff;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:13px;padding:20px;}
h1{font-size:16px;margin-bottom:16px;color:var(--green);}
.controls{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;}
select,button{font-size:12px;padding:5px 10px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;}
button:hover{border-color:var(--blue);}
.btn-primary{background:var(--blue);color:#fff;border-color:var(--blue);}
.auto-label{font-size:11px;color:var(--muted);}
table{width:100%;border-collapse:collapse;}
th{background:var(--card);color:var(--muted);font-size:11px;padding:8px;text-align:left;border-bottom:1px solid var(--border);position:sticky;top:0;}
td{padding:6px 8px;border-bottom:1px solid rgba(48,54,61,.3);font-size:12px;vertical-align:top;}
tr:hover td{background:rgba(88,166,255,.04);}
.type-kb{color:var(--blue);} .type-cap{color:var(--purple);} .type-idle{color:var(--muted);} .type-clip{color:var(--orange);} .type-vision{color:var(--green);}
.app-tag{background:var(--card);padding:2px 6px;border-radius:4px;font-size:11px;}
.status{position:fixed;bottom:10px;right:10px;font-size:10px;color:var(--muted);background:var(--card);padding:4px 10px;border-radius:6px;border:1px solid var(--border);}
</style>
</head>
<body>
<h1>Orbit AI — 실시간 활동 로그 (로컬 전용)</h1>
<div class="controls">
  <select id="userFilter"><option value="">전체 멤버</option></select>
  <select id="typeFilter">
    <option value="">전체 타입</option>
    <option value="keyboard.chunk">키보드</option>
    <option value="screen.capture">캡처</option>
    <option value="screen.analyzed">Vision</option>
    <option value="clipboard.change">클립보드</option>
    <option value="idle">대기</option>
  </select>
  <button class="btn-primary" onclick="loadLogs()">새로고침</button>
  <label class="auto-label"><input type="checkbox" id="autoRefresh" checked> 30초 자동 갱신</label>
  <span id="count" style="margin-left:auto;color:var(--muted);font-size:11px;"></span>
</div>
<div id="logs" style="max-height:calc(100vh - 120px);overflow-y:auto;"></div>
<div class="status" id="status">대기 중</div>

<script>
const API = '/api';
let refreshTimer = null;

async function api(path) {
  const r = await fetch(API + path);
  return r.json();
}

async function loadLogs() {
  document.getElementById('status').textContent = '로딩...';
  const user = document.getElementById('userFilter').value;
  const type = document.getElementById('typeFilter').value;
  let url = '/logs?limit=100';
  if (user) url += '&userId=' + user;
  if (type) url += '&type=' + type;

  const data = await api(url);
  const logs = data.logs || data.events || [];

  document.getElementById('count').textContent = logs.length + '건';
  document.getElementById('status').textContent = new Date().toLocaleTimeString() + ' 갱신';

  const icons = {'keyboard.chunk':'⌨️','screen.capture':'📸','screen.analyzed':'🔍','idle':'💤','clipboard.change':'📋','bank-safe.activity':'🏦'};
  const cls = {'keyboard.chunk':'type-kb','screen.capture':'type-cap','screen.analyzed':'type-vision','idle':'type-idle','clipboard.change':'type-clip'};

  document.getElementById('logs').innerHTML = '<table><thead><tr><th></th><th>시간</th><th>멤버</th><th>타입</th><th>앱</th><th>윈도우 / 활동</th></tr></thead><tbody>' +
    logs.map(l => {
      const t = l.type || '';
      const time = l.timestamp ? new Date(l.timestamp).toLocaleTimeString('ko-KR') : '-';
      const name = l.userName || (l.user_id||'').substring(0,8);
      const app = l.app || '-';
      const title = l.windowTitle || l.visionActivity || l.trigger || (t==='idle'?'대기':'');
      return '<tr><td>' + (icons[t]||'📄') + '</td><td style="white-space:nowrap;color:var(--muted)">' + time +
        '</td><td class="' + (cls[t]||'') + '" style="font-weight:600">' + name +
        '</td><td style="color:var(--muted);font-size:11px">' + t.split('.')[1] +
        '</td><td><span class="app-tag">' + app +
        '</span></td><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis">' + (title||'').substring(0,80) + '</td></tr>';
    }).join('') + '</tbody></table>';

  // 자동 갱신
  if (refreshTimer) clearInterval(refreshTimer);
  if (document.getElementById('autoRefresh').checked) {
    refreshTimer = setInterval(loadLogs, 30000);
  }
}

async function loadMembers() {
  const data = await api('/members');
  const members = data.members || data || [];
  const sel = document.getElementById('userFilter');
  if (Array.isArray(members)) {
    members.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id || m.userId || '';
      opt.textContent = m.name || m.userName || opt.value.substring(0,8);
      sel.appendChild(opt);
    });
  }
}

loadMembers();
loadLogs();
</script>
</body>
</html>`;

// ── 서버 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/logs.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/api/logs') {
    const limit = url.searchParams.get('limit') || '100';
    const userId = url.searchParams.get('userId') || '';
    const type = url.searchParams.get('type') || '';
    let endpoint = `/api/learning/logs?limit=${limit}`;
    if (userId) endpoint += `&userId=${userId}`;
    if (type) endpoint += `&type=${type}`;
    const data = await apiGet(endpoint);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/members') {
    const data = await apiGet('/api/os/status');
    const members = (data.company?.members || []).map(m => ({ id: m.id, name: m.name, status: m.status }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ members }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n  📋 실시간 활동 로그 서버`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Railway: ${ORBIT_SERVER}`);
  console.log(`  30초마다 자동 갱신\n`);
});
