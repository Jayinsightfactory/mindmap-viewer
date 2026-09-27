'use strict';
/**
 * egress-monitor.js — 업무 파일이 "어디로 나갔는지" 이력만 남기는 감시기 (차단·알림 없음).
 *   중소기업 현실 보안: 유출을 막을 수는 없지만 히스토리는 남긴다. 관리자(사장·지정 계정)만 네노바웹 /work/drive '보안 이력'에서 본다.
 *
 * 감지 경로(관리자 권한 불필요, 전부 폴링):
 *   copy      — 이동식 드라이브(USB/외장)·클라우드 동기화 폴더(OneDrive/Google Drive/Dropbox/네이버 MYBOX/iCloud)·카톡 받은파일 폴더에 새 파일 → sha256 → 서버가 드라이브 색인과 대조
 *   print     — Windows 인쇄 큐(Win32_PrintJob) 5초 폴링: 문서명·프린터·페이지 (PDF 프린터 포함)
 *   email     — Outlook 보낸편지함(COM) 60초 폴링: 첨부가 있는 보낸 메일의 수신자·제목·첨부명 (Outlook이 이미 실행 중일 때만 GetActiveObject — 절대 새로 띄우지 않음)
 *   webupload — 파일 선택 대화상자("열기"/"Open") 뒤에 크롬/엣지 활성 + 파일명 캡션 (파일명만, 신뢰도 낮음)
 *   kakao     — 파일 선택 대화상자 뒤 카카오톡 활성 → 창 제목(방 이름) + 파일명
 * 못 잡는 것: 화면 촬영, 내용 복사-붙여넣기, 1:1 카톡의 상대 이름(창 제목에 없을 때).
 *
 * 전송: POST {nenovaweb}/api/work/drive-egress {events:[…]} — work-file-uploader와 같은 설정(url/token/userName). 실패는 큐에 두고 재시도.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const EXT_OK = /\.(xlsx|xlsm|xls|csv|pdf|docx|doc|hwp|pptx|ppt|txt|zip)$/i;
const MAX_HASH_BYTES = 200 * 1024 * 1024;
let _getCfg = null;           // () => Promise<{enabled,url,token,userName,userId}|null>  (work-file-uploader._config 재사용)
let _queue = [];              // 보낼 이벤트
let _stats = { copy: 0, print: 0, email: 0, webupload: 0, kakao: 0, sent: 0, failed: 0, snapshots: 0, resolved: 0, unresolved: 0, lastError: '', lastSentAt: '', watchRoots: [] };
let _timers = [];
const _seenCopy = new Map();  // fullPath → mtimeMs (같은 파일 반복 보고 방지)
const _seenJobs = new Set();  // 인쇄 JobId
const _seenMail = new Set();  // Outlook EntryID
let _lastMailCheck = null;
let _dialogSeen = { file: '', at: 0 };

function ps(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // 한글 프린터명·사용자명이 '????'로 깨지던 것(2026-09-28 실측) → 출력 인코딩을 UTF-8로 고정
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    child.on('error', () => resolve(''));
  });
}
function shaOf(fp) { try { const st = fs.statSync(fp); if (st.size > MAX_HASH_BYTES) return ''; return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); } catch { return ''; } }
function push(evt) { _stats[evt.kind] = (_stats[evt.kind] || 0) + 1; _queue.push({ ...evt, at: evt.at || new Date().toISOString(), hostname: os.hostname() }); if (_queue.length > 500) _queue.splice(0, _queue.length - 500); }

// ── ① 복사 유출: 이동식 드라이브 + 클라우드 동기화 폴더 ────────────────────────────────
// 드라이브 문자 → 물리 장치(모델·시리얼·인터페이스). "볼륨 USB Drive"만으로는 어떤 장치인지 알 수 없어서(2026-09-28) 추가. 5분 캐시.
let _devMap = { at: 0, map: {} };
async function deviceMap() {
  if (Date.now() - _devMap.at < 5 * 60e3) return _devMap.map;
  const out = await ps("Get-CimInstance Win32_DiskDrive | ForEach-Object { $d = $_; Get-CimInstance -Query \"ASSOCIATORS OF {Win32_DiskDrive.DeviceID='$($d.DeviceID)'} WHERE AssocClass=Win32_DiskDriveToDiskPartition\" | ForEach-Object { Get-CimInstance -Query \"ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($_.DeviceID)'} WHERE AssocClass=Win32_LogicalDiskToPartition\" | ForEach-Object { $_.DeviceID + '|' + $d.InterfaceType + '|' + $d.Model + '|' + $d.SerialNumber } } }", 20000);
  const map = {}; for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) { const [letter, iface, model, sn] = l.split('|'); if (letter) map[letter.toUpperCase()] = { iface: iface || '', model: (model || '').trim(), sn: (sn || '').trim() }; }
  _devMap = { at: Date.now(), map }; return map;
}
async function removableRoots() {
  const out = await ps("Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 4 } | ForEach-Object { $_.DeviceID + '|' + $_.DriveType + '|' + $_.VolumeName + '|' + $_.ProviderName }", 15000);
  const dev = await deviceMap().catch(() => ({}));
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [devId, type, vol, provider] = l.split('|'); const d = dev[String(devId || '').toUpperCase()] || null;
    const label = type === '2' ? ['이동식 장치', d && d.model, d && d.sn && `S/N ${d.sn}`, vol && `볼륨 ${vol}`].filter(Boolean).join(' · ') : ['네트워크 드라이브', provider, vol].filter(Boolean).join(' · ');
    return { root: devId + '\\', kind: type === '2' ? 'usb' : 'network', label };
  });
}
function cloudRoots() {
  const home = os.homedir(); const cands = [
    ['onedrive', process.env.OneDrive], ['onedrive', process.env.OneDriveCommercial], ['onedrive', path.join(home, 'OneDrive')],
    ['googledrive', path.join(home, 'Google Drive')], ['googledrive', path.join(home, '내 드라이브')], ['googledrive', 'G:\\내 드라이브'], ['googledrive', 'G:\\My Drive'],
    ['dropbox', path.join(home, 'Dropbox')], ['mybox', path.join(home, 'MYBOX')], ['mybox', path.join(home, '네이버 MYBOX')], ['icloud', path.join(home, 'iCloudDrive')],
    ['kakao', path.join(home, 'Documents', '카카오톡 받은 파일')], ['kakao', path.join(home, 'Downloads', 'KakaoTalk Downloads')],
  ];
  const seen = new Set(); return cands.filter(([, p]) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()) && fs.existsSync(p)).map(([kind, root]) => ({ root, kind, label: '' }));
}
function scanRoot(r, depth = 0) {
  let ents = []; try { ents = fs.readdirSync(r.root, { withFileTypes: true }); } catch { return; }
  for (const e of ents.slice(0, 2000)) {
    const fp = path.join(r.root, e.name);
    if (e.isDirectory()) { if (depth < 2 && !/^(\$|\.|node_modules|System Volume|Windows|Program)/i.test(e.name)) scanRoot({ ...r, root: fp }, depth + 1); continue; }
    if (!EXT_OK.test(e.name) || e.name.startsWith('~$')) continue;
    let st; try { st = fs.statSync(fp); } catch { continue; }
    const prev = _seenCopy.get(fp); if (prev === st.mtimeMs) continue; _seenCopy.set(fp, st.mtimeMs);
    if (prev === undefined && Date.now() - st.mtimeMs > 6 * 3600e3) continue; // 감시 시작 전부터 있던 옛 파일은 이력 대상 아님
    // 카톡 '받은 파일' 폴더는 밖으로 나간 게 아니라 들어온 것(수신) — destKind 'kakao-in' 으로 구분해 유출로 읽히지 않게 한다(2026-09-28 실측 17건 전부 수신)
    const inbound = r.kind === 'kakao';
    push({ kind: 'copy', filename: e.name, sha: shaOf(fp), size: st.size, destKind: inbound ? 'kakao-in' : r.kind, dest: fp, detail: inbound ? '카카오톡으로 받은 파일(외부→PC)' : (r.label ? (r.kind === 'usb' || r.kind === 'network' ? r.label : `볼륨 ${r.label}`) : (r.kind === 'onedrive' || r.kind === 'googledrive' || r.kind === 'dropbox' || r.kind === 'mybox' || r.kind === 'icloud' ? '클라우드 동기화 폴더 → 외부 저장' : '')), dedupKey: `copy|${fp}|${st.mtimeMs}` });
  }
}
async function pollCopy() {
  try { const roots = [...cloudRoots(), ...(await removableRoots())]; _stats.watchRoots = roots.map((r) => r.kind + ':' + r.root); for (const r of roots) scanRoot(r); } catch (e) { _stats.lastError = 'copy: ' + e.message; }
}

// ── ② 인쇄 ───────────────────────────────────────────────────────────────────
// 프린터 이름 → 포트(IP)·위치·드라이버. "어느 프린터"인지(사무실 복합기 IP / 집 프린터 / PDF) 보이게(2026-09-28). 10분 캐시.
let _printers = { at: 0, map: {} };
async function printerMap() {
  if (Date.now() - _printers.at < 10 * 60e3) return _printers.map;
  const out = await ps("Get-CimInstance Win32_Printer | ForEach-Object { $_.Name + '|' + $_.PortName + '|' + $_.Location + '|' + $_.DriverName + '|' + $_.Network + '|' + $_.Shared }", 15000);
  const map = {}; for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) { const [name, port, loc, drv, net] = l.split('|'); if (name) map[name] = { port: port || '', loc: loc || '', drv: drv || '', net: /true/i.test(net || '') }; }
  _printers = { at: Date.now(), map }; return map;
}
async function pollPrint() {
  const out = await ps("Get-CimInstance Win32_PrintJob | ForEach-Object { $_.JobId.ToString() + '|' + $_.Document + '|' + $_.Name + '|' + $_.TotalPages + '|' + $_.Owner + '|' + $_.Size + '|' + $_.Color + '|' + $_.Copies }", 15000);
  const lines = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); if (!lines.length) return;
  const pm = await printerMap().catch(() => ({}));
  for (const l of lines) {
    const [id, doc, printer, pages, owner, size, color, copies] = l.split('|'); if (!id || _seenJobs.has(id + '|' + doc)) continue; _seenJobs.add(id + '|' + doc); if (_seenJobs.size > 5000) _seenJobs.clear();
    const pr = String(printer || '').split(',')[0].trim(); const p = pm[pr] || {};
    const toFile = /pdf|xps|onenote|fax/i.test(pr + ' ' + (p.drv || '') + ' ' + (p.port || ''));
    const ip = (String(p.port || '').replace(/^IP_(\d+)_(\d+)_(\d+)_(\d+)$/, '$1.$2.$3.$4').match(/\d{1,3}(?:\.\d{1,3}){3}/) || [])[0]; // 표준 TCP/IP 포트는 'IP_192_168_0_200' 꼴
    const where = toFile ? `파일로 출력(${pr})` : [`프린터 ${pr}`, ip ? `IP ${ip}` : (p.port && !/^(USB|LPT|COM)/i.test(p.port) ? `포트 ${p.port}` : (p.port ? '직접연결 ' + p.port : '')), p.loc && `위치 ${p.loc}`, p.net && '네트워크 프린터'].filter(Boolean).join(' · ');
    const app = (String(doc || '').match(/^(Microsoft\s+\w+|한글|Adobe\s+\w+|Chrome|Edge|Excel|Word|PowerPoint)/i) || [])[1] || '';
    push({ kind: 'print', filename: String(doc || '').trim(), destKind: toFile ? 'print-to-file' : 'printer', dest: pr, app, detail: [`${pages || '?'}쪽`, copies && Number(copies) > 1 ? `${copies}부` : '', /true/i.test(color || '') ? '컬러' : '', where, owner ? `사용자 ${owner}` : ''].filter(Boolean).join(' · '), dedupKey: `print|${id}|${doc}|${new Date().toISOString().slice(0, 13)}` });
  }
}

// ── ③ Outlook 보낸편지함(첨부 있는 메일) ─────────────────────────────────────────
async function pollOutlook() {
  const since = _lastMailCheck || new Date(Date.now() - 6 * 3600e3); _lastMailCheck = new Date();
  const s = since.toISOString().replace('T', ' ').slice(0, 19);
  // ⚠ New-Object -ComObject 는 Outlook을 '실행'시킨다(2026-09-22 직원 PC에서 Outlook이 저절로 켜지는 사고). 이미 떠 있는 Outlook에만 GetActiveObject로 붙고, 없으면 아무것도 안 한다.
  const running = await ps("if (Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }", 8000);
  if (!/yes/.test(running)) return;
  const out = await ps(`try { $o = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application'); $ns = $o.GetNamespace('MAPI'); $f = $ns.GetDefaultFolder(5); $items = $f.Items; $items.Sort('[SentOn]', $true); $items = $items.Restrict("[SentOn] >= '${s}'"); foreach ($m in $items) { if ($m.Attachments.Count -gt 0) { $a = @(); foreach ($x in $m.Attachments) { $a += $x.FileName }; Write-Output ($m.EntryID + '|' + $m.SentOn.ToString('s') + '|' + $m.To + '|' + $m.Subject + '|' + ($a -join ';') + '|' + $m.CC + '|' + $m.SenderEmailAddress) } } } catch {}`, 30000);
  for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const [id, sentOn, to, subject, atts, cc, from] = l.split('|'); if (!id || _seenMail.has(id)) continue; _seenMail.add(id);
    const detail = [`제목 ${String(subject || '').slice(0, 80)}`, cc && `참조 ${String(cc).slice(0, 120)}`, from && `보낸 계정 ${String(from).slice(0, 80)}`].filter(Boolean).join(' · ');
    for (const fn of String(atts || '').split(';').filter(Boolean)) push({ kind: 'email', filename: fn, destKind: 'outlook', dest: String(to || '').slice(0, 200), detail, at: sentOn ? new Date(sentOn).toISOString() : undefined, dedupKey: `email|${id}|${fn}` });
  }
}

// ── ④ 파일 선택 대화상자 → 웹 업로드 / 카톡 전송 (활성 창 감시기에서 창 제목을 넘겨받음) ───────────
// 호출: onWindow({ app, title }) — 파일 대화상자("열기"/"Open"/"파일 열기")가 닫힌 직후의 활성 창으로 목적지를 추정한다. 파일명은 대화상자 캡션에 없으므로
// 직전 5초 내 키보드 캡처/클립보드 텍스트 중 파일명 패턴이 있으면 쓴다(없으면 '(파일명 미상)').
function onWindow({ app = '', title = '', typedText = '' } = {}) {
  const t = String(title || ''); const now = Date.now();
  if (/^(열기|Open|파일 열기|파일 선택|업로드할 파일 선택)$/i.test(t.trim())) { const m = String(typedText || '').match(/[\w가-힣 .()\-]+\.(xlsx|xls|pdf|docx|hwp|pptx|csv|zip)/i); _dialogSeen = { file: m ? m[0] : '', at: now }; return; }
  if (!_dialogSeen.at || now - _dialogSeen.at > 15000) return;
  const a = String(app || '').toLowerCase();
  if (/kakao|카카오/.test(a) || /카카오톡/.test(t)) { push({ kind: 'kakao', filename: _dialogSeen.file || '(파일명 미상)', destKind: 'kakao', dest: t.replace(/\s*-\s*카카오톡.*$/, '').slice(0, 120), dedupKey: `kakao|${t}|${_dialogSeen.file}|${Math.floor(now / 60000)}` }); _dialogSeen = { file: '', at: 0 }; }
  else if (/chrome|edge|whale|firefox/.test(a)) { const site = (t.match(/(gmail|naver|daum|google drive|drive\.google|dropbox|wetransfer|notion|slack|works)/i) || [])[1] || t.slice(0, 60); push({ kind: 'webupload', filename: _dialogSeen.file || '(파일명 미상)', destKind: 'browser', dest: site, detail: t.slice(0, 120), dedupKey: `web|${t}|${_dialogSeen.file}|${Math.floor(now / 60000)}` }); _dialogSeen = { file: '', at: 0 }; }
}

// ── ⑤ 원본 파일 찾기 + 스냅샷 업로드 ──────────────────────────────────────────────
// 인쇄·메일·카톡·웹 이벤트는 "문서명"만 있어서 서버가 어떤 파일인지·무슨 내용인지 못 본다(2026-09-27 사장 지시: 어떤 파일의 어떤 내용이
// 나갔는지 명확해야 하고 파일을 볼 수 있어야 함). 여기서 원본 경로를 찾아 sha·path를 붙이고, 파일을 드라이브에 '유출 스냅샷'으로 올린다.
//   경로 탐색: ① 열린 Office 문서(Excel/Word/PowerPoint — 실행 중일 때만 GetActiveObject, New-Object 금지) ② Desktop/Documents/Downloads/클라우드 루트 깊이 3
const SNAP_EXT = /\.(xlsx|xlsm|xls|csv|pdf|docx|doc|hwp|pptx)$/i;
const SNAP_MAX = 25 * 1024 * 1024;
const SNAP_SENT = path.join(os.homedir(), '.orbit', 'egress-snap-sent.json');
const _pathCache = new Map();  // 문서명(lower) → { fp, at }
let _snapSent = null;
function loadSnapSent() { if (_snapSent) return _snapSent; try { _snapSent = new Set(JSON.parse(fs.readFileSync(SNAP_SENT, 'utf8'))); } catch { _snapSent = new Set(); } return _snapSent; }
function saveSnapSent() { try { fs.mkdirSync(path.dirname(SNAP_SENT), { recursive: true }); fs.writeFileSync(SNAP_SENT, JSON.stringify([...loadSnapSent()].slice(-5000))); } catch {} }
// 인쇄 큐 문서명 정규화: "Microsoft Excel - 22차 AWB.xlsx" / "22차 AWB.xlsx - Excel" / "22차 AWB" → "22차 awb"
function docKey(name) { return String(name || '').replace(/^(microsoft\s+)?(excel|word|powerpoint)\s*-\s*/i, '').replace(/\s*-\s*(excel|word|powerpoint|한글|hancom.*)$/i, '').replace(/\.(xlsx|xlsm|xls|csv|pdf|docx|doc|hwp|pptx|txt)$/i, '').trim().toLowerCase(); }
async function openOfficeDocs() {
  const out = await ps("$o=@(); foreach ($p in @(@('EXCEL','Excel.Application','Workbooks'),@('WINWORD','Word.Application','Documents'),@('POWERPNT','PowerPoint.Application','Presentations'))) { if (Get-Process -Name $p[0] -ErrorAction SilentlyContinue) { try { $a=[System.Runtime.InteropServices.Marshal]::GetActiveObject($p[1]); foreach ($d in $a.($p[2])) { $o += $d.FullName }; if ($p[0] -eq 'EXCEL') { try { $o += ('SHEET|' + $a.ActiveSheet.Name) } catch {} } } catch {} } }; $o", 15000);
  const docs = [], meta = {};
  for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) { if (l.startsWith('SHEET|')) meta.sheet = l.slice(6); else docs.push(l); }
  return { docs, meta };
}
function searchByName(key) {
  const home = os.homedir(); const roots = [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), ...cloudRoots().map((r) => r.root)];
  const walk = (dir, depth) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents.slice(0, 3000)) { if (e.isFile() && SNAP_EXT.test(e.name) && !e.name.startsWith('~$') && docKey(e.name) === key) return path.join(dir, e.name); }
    if (depth >= 3) return null;
    for (const e of ents) if (e.isDirectory() && !/^(\.|\$|node_modules|AppData)/i.test(e.name)) { const r = walk(path.join(dir, e.name), depth + 1); if (r) return r; }
    return null;
  };
  for (const r of roots) { const hit = walk(r, 0); if (hit) return hit; }
  return null;
}
async function resolveSourceFile(evt) {
  if (evt.kind === 'copy' && evt.dest && fs.existsSync(evt.dest)) return { fp: evt.dest, meta: {} };
  const key = docKey(evt.filename); if (!key || key.length < 2) return null;
  const c = _pathCache.get(key); if (c && Date.now() - c.at < 10 * 60e3) return c;
  let fp = null, meta = {};
  if (evt.kind === 'print') { try { const o = await openOfficeDocs(); meta = o.meta; fp = o.docs.find((d) => docKey(path.basename(d)) === key) || null; } catch {} }
  if (!fp) { try { fp = searchByName(key); } catch {} }
  const r = fp ? { fp, meta, at: Date.now() } : null; if (r) _pathCache.set(key, r); return r;
}
async function snapshot(fp, evt, cfg) {
  if (!SNAP_EXT.test(fp)) return { snapshot: false, why: 'ext' };
  let st; try { st = fs.statSync(fp); } catch { return { snapshot: false, why: 'stat' }; }
  if (st.size > SNAP_MAX || st.size < 16) return { snapshot: false, why: 'size' };
  let buf; try { buf = fs.readFileSync(fp); } catch { return { snapshot: false, why: 'locked' }; }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const base = { sha, size: st.size, path: fp.slice(0, 400) };
  if (loadSnapSent().has(sha)) return { ...base, snapshot: true, why: 'already' };
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(fp)); form.append('filename', path.basename(fp));
  form.append('orbitUserId', cfg.userId || ''); form.append('userName', cfg.userName || ''); form.append('hostname', os.hostname());
  form.append('dir', path.basename(path.dirname(fp))); form.append('mtime', new Date(st.mtimeMs).toISOString()); form.append('eventType', 'egress');
  form.append('egressSnapshot', '1'); form.append('egressKind', evt.kind); form.append('egressDedupKey', evt.dedupKey || '');
  try {
    const r = await fetch(`${cfg.url}/api/work/drive-ingest`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token }, body: form, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) { loadSnapSent().add(sha); saveSnapSent(); _stats.snapshots++; return { ...base, snapshot: true, why: j.duplicate ? 'dup' : 'uploaded' }; }
    return { ...base, snapshot: false, why: 'http ' + r.status + ' ' + (j.error || '') };
  } catch (e) { return { ...base, snapshot: false, why: 'network ' + e.message }; }
}
async function enrich(e, cfg) {
  let r = null; try { r = await resolveSourceFile(e); } catch {}
  if (!r || !r.fp) { _stats.unresolved++; return { ...e, snapshot: false }; }
  _stats.resolved++;
  const s = await snapshot(r.fp, e, cfg);
  const detail = r.meta && r.meta.sheet && e.kind === 'print' ? `${e.detail || ''} · 시트 ${r.meta.sheet}` : e.detail;
  return { ...e, path: r.fp.slice(0, 400), sha: s.sha || e.sha || '', size: s.size || e.size || 0, snapshot: !!s.snapshot, snapshotWhy: s.why, detail };
}

// ── 전송 ─────────────────────────────────────────────────────────────────────
async function flush() {
  if (!_queue.length || !_getCfg) return;
  let cfg = null; try { cfg = await _getCfg(); } catch {}
  if (!cfg || !cfg.enabled || !cfg.url || !cfg.token) return; // 드라이브 기능이 꺼진 PC는 이력도 보내지 않는다(같은 게이트)
  const raw = _queue.splice(0, 100).map((e) => ({ ...e, orbitUserId: cfg.userId || '', userName: cfg.userName || '' }));
  const batch = []; for (const e of raw) batch.push(await enrich(e, cfg));
  try {
    const r = await fetch(`${cfg.url}/api/work/drive-egress`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('http ' + r.status);
    _stats.sent += batch.length; _stats.lastSentAt = new Date().toISOString();
  } catch (e) { _stats.failed += batch.length; _stats.lastError = 'send: ' + e.message; _queue.unshift(...batch.slice(0, 100)); }
}

function start({ getConfig }) {
  _getCfg = getConfig; stop();
  if (process.platform !== 'win32') return;
  _timers.push(setInterval(() => pollPrint().catch(() => {}), 5000));
  _timers.push(setInterval(() => pollCopy().catch(() => {}), 30000));
  _timers.push(setInterval(() => pollOutlook().catch(() => {}), 60000));
  _timers.push(setInterval(() => flush().catch(() => {}), 20000));
  setTimeout(() => { pollCopy().catch(() => {}); }, 10000);
  _timers.forEach((t) => t.unref?.());
}
function stop() { _timers.forEach((t) => clearInterval(t)); _timers = []; }
function getStats() { return { ..._stats, queued: _queue.length }; }

module.exports = { start, stop, onWindow, getStats, flush, _test: { scanRoot, push, onWindow, queue: () => _queue, docKey, resolveSourceFile, searchByName, openOfficeDocs } };
