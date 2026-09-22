'use strict';
/**
 * egress-monitor.js — 업무 파일이 "어디로 나갔는지" 이력만 남기는 감시기 (차단·알림 없음).
 *   중소기업 현실 보안: 유출을 막을 수는 없지만 히스토리는 남긴다. 관리자(사장·지정 계정)만 네노바웹 /work/drive '보안 이력'에서 본다.
 *
 * 감지 경로(관리자 권한 불필요, 전부 폴링):
 *   copy      — 이동식 드라이브(USB/외장)·클라우드 동기화 폴더(OneDrive/Google Drive/Dropbox/네이버 MYBOX/iCloud)·카톡 받은파일 폴더에 새 파일 → sha256 → 서버가 드라이브 색인과 대조
 *   print     — Windows 인쇄 큐(Win32_PrintJob) 5초 폴링: 문서명·프린터·페이지 (PDF 프린터 포함)
 *   email     — Outlook 보낸편지함(COM) 60초 폴링: 첨부가 있는 보낸 메일의 수신자·제목·첨부명
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
let _stats = { copy: 0, print: 0, email: 0, webupload: 0, kakao: 0, sent: 0, failed: 0, lastError: '', lastSentAt: '', watchRoots: [] };
let _timers = [];
const _seenCopy = new Map();  // fullPath → mtimeMs (같은 파일 반복 보고 방지)
const _seenJobs = new Set();  // 인쇄 JobId
const _seenMail = new Set();  // Outlook EntryID
let _lastMailCheck = null;
let _dialogSeen = { file: '', at: 0 };

function ps(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    child.on('error', () => resolve(''));
  });
}
function shaOf(fp) { try { const st = fs.statSync(fp); if (st.size > MAX_HASH_BYTES) return ''; return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); } catch { return ''; } }
function push(evt) { _stats[evt.kind] = (_stats[evt.kind] || 0) + 1; _queue.push({ ...evt, at: evt.at || new Date().toISOString(), hostname: os.hostname() }); if (_queue.length > 500) _queue.splice(0, _queue.length - 500); }

// ── ① 복사 유출: 이동식 드라이브 + 클라우드 동기화 폴더 ────────────────────────────────
async function removableRoots() {
  const out = await ps("Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 4 } | ForEach-Object { $_.DeviceID + '|' + $_.DriveType + '|' + $_.VolumeName }", 15000);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [dev, type, vol] = l.split('|'); return { root: dev + '\\', kind: type === '2' ? 'usb' : 'network', label: vol || '' }; });
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
    push({ kind: 'copy', filename: e.name, sha: shaOf(fp), size: st.size, destKind: r.kind, dest: fp, detail: r.label ? `볼륨 ${r.label}` : '', dedupKey: `copy|${fp}|${st.mtimeMs}` });
  }
}
async function pollCopy() {
  try { const roots = [...cloudRoots(), ...(await removableRoots())]; _stats.watchRoots = roots.map((r) => r.kind + ':' + r.root); for (const r of roots) scanRoot(r); } catch (e) { _stats.lastError = 'copy: ' + e.message; }
}

// ── ② 인쇄 ───────────────────────────────────────────────────────────────────
async function pollPrint() {
  const out = await ps("Get-CimInstance Win32_PrintJob | ForEach-Object { $_.JobId.ToString() + '|' + $_.Document + '|' + $_.Name + '|' + $_.TotalPages + '|' + $_.Owner }", 15000);
  for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const [id, doc, printer, pages, owner] = l.split('|'); if (!id || _seenJobs.has(id + '|' + doc)) continue; _seenJobs.add(id + '|' + doc); if (_seenJobs.size > 5000) _seenJobs.clear();
    const pr = String(printer || '').split(',')[0].trim();
    push({ kind: 'print', filename: String(doc || '').trim(), destKind: /pdf|xps|onenote/i.test(pr) ? 'print-to-file' : 'printer', dest: pr, detail: `${pages || '?'}쪽 · ${owner || ''}`, dedupKey: `print|${id}|${doc}|${new Date().toISOString().slice(0, 13)}` });
  }
}

// ── ③ Outlook 보낸편지함(첨부 있는 메일) ─────────────────────────────────────────
async function pollOutlook() {
  const since = _lastMailCheck || new Date(Date.now() - 6 * 3600e3); _lastMailCheck = new Date();
  const s = since.toISOString().replace('T', ' ').slice(0, 19);
  const out = await ps(`try { $o = New-Object -ComObject Outlook.Application; $ns = $o.GetNamespace('MAPI'); $f = $ns.GetDefaultFolder(5); $items = $f.Items; $items.Sort('[SentOn]', $true); $items = $items.Restrict("[SentOn] >= '${s}'"); foreach ($m in $items) { if ($m.Attachments.Count -gt 0) { $a = @(); foreach ($x in $m.Attachments) { $a += $x.FileName }; Write-Output ($m.EntryID + '|' + $m.SentOn.ToString('s') + '|' + $m.To + '|' + $m.Subject + '|' + ($a -join ';')) } } } catch {}`, 30000);
  for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const [id, sentOn, to, subject, atts] = l.split('|'); if (!id || _seenMail.has(id)) continue; _seenMail.add(id);
    for (const fn of String(atts || '').split(';').filter(Boolean)) push({ kind: 'email', filename: fn, destKind: 'outlook', dest: String(to || '').slice(0, 200), detail: `제목 ${String(subject || '').slice(0, 80)}`, at: sentOn ? new Date(sentOn).toISOString() : undefined, dedupKey: `email|${id}|${fn}` });
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

// ── 전송 ─────────────────────────────────────────────────────────────────────
async function flush() {
  if (!_queue.length || !_getCfg) return;
  let cfg = null; try { cfg = await _getCfg(); } catch {}
  if (!cfg || !cfg.enabled || !cfg.url || !cfg.token) return; // 드라이브 기능이 꺼진 PC는 이력도 보내지 않는다(같은 게이트)
  const batch = _queue.splice(0, 100).map((e) => ({ ...e, orbitUserId: cfg.userId || '', userName: cfg.userName || '' }));
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

module.exports = { start, stop, onWindow, getStats, flush, _test: { scanRoot, push, onWindow, queue: () => _queue } };
