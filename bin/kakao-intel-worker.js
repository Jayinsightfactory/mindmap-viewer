'use strict';
/**
 * kakao-intel-worker.js — 카톡 대화 인텔리전스 워커 (골 자동디벨롭)
 *
 * owner PC의 Claude CLI(Max 구독, $0)로 카톡 대화를 "전량" 분석:
 *   이슈 라이프사이클 + 거래처 성향 + 직원 역량 + 해결방식/로직.
 * vision-worker.js와 동일 패턴(CLI 무과금). 결과는 서버에 type='kakao.intel' 이벤트로 저장.
 *
 * 실행(owner PC, Claude CLI 설치됨):
 *   node bin/kakao-intel-worker.js            # 미처리 스레드 전부 처리 후 대기(폴링)
 *   node bin/kakao-intel-worker.js --once      # 1회만
 *   node bin/kakao-intel-worker.js --room "네노바 영업방"   # 특정 방만
 *
 * 서버/토큰: ~/.orbit-config.json (serverUrl, token) 또는 env ORBIT_SERVER_URL/ORBIT_TOKEN.
 */
const { execFile, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

// ── 설정 ────────────────────────────────────────────────────────────────────
let _cfg = {};
try { _cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); } catch {}
const SERVER = (_cfg.serverUrl || process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app').replace(/\/+$/, '');
const TOKEN = _cfg.token || process.env.ORBIT_TOKEN || '';
const STATE_FILE = path.join(os.homedir(), '.orbit', 'kakao-intel-state.json');
const ONCE = process.argv.includes('--once');
const ONLY_ROOM = (() => { const i = process.argv.indexOf('--room'); return i >= 0 ? process.argv[i + 1] : null; })();
const THREAD_GAP_MS = 30 * 60 * 1000; // 30분 이상 공백 = 새 스레드
const MAX_MSGS_PER_THREAD = 80;
const POLL_MS = 10 * 60 * 1000;

const CLAUDE_CLI = (() => {
  try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split(/\r?\n/)[0]; }
  catch { return null; }
})();

// ── HTTP ────────────────────────────────────────────────────────────────────
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER + urlPath);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: 30000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (payload) r.write(payload); r.end();
  });
}
const getMessages = (room, offset, limit) => req('GET', `/api/kakao/messages?token=${encodeURIComponent(TOKEN)}&chatroom=${encodeURIComponent(room)}&limit=${limit}&offset=${offset}`);
const getRooms = () => req('GET', `/api/kakao/chatrooms?token=${encodeURIComponent(TOKEN)}`);
const postEvent = (ev) => req('POST', '/api/hook', { events: [ev] });

// ── 상태(처리한 스레드) ──────────────────────────────────────────────────────
let _state = { processed: {} };
try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function saveState() { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(_state)); } catch {} }
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return String(h); };

// ── 스레드 빌드: 방별 시간순 → 30분 공백으로 분할, 80건 상한 ──────────────────
function buildThreads(messages) {
  const sorted = messages.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const threads = []; let cur = null; let lastT = 0;
  for (const m of sorted) {
    const t = new Date(m.created_at).getTime();
    if (!cur || (t - lastT) > THREAD_GAP_MS || cur.length >= MAX_MSGS_PER_THREAD) { cur = []; threads.push(cur); }
    cur.push(m); lastT = t;
  }
  return threads.filter(t => t.length >= 3);
}

// ── Claude CLI 분석 ──────────────────────────────────────────────────────────
function buildPrompt(room, transcript) {
  return `당신은 화훼 도매회사(네노바)의 업무 대화 분석가입니다. 아래 카카오톡 대화(방: ${room})를 분석해 순수 JSON만 출력하세요(마크다운/설명 금지).
대화:
${transcript}

다음 JSON 형식:
{
  "room": "${room}",
  "customer": "이 대화의 거래처/고객명(추정, 없으면 '')",
  "issues": [
    {
      "type": "주문|주문변경|클레임|배송문의|가격협상|독촉|재고문의|기타",
      "raisedBy": "고객|직원",
      "assignee": "처리한 우리 직원 이름(추정, 없으면 '')",
      "resolved": true,
      "turns": 3,
      "tone": "정중|불만|급함|일상|강경",
      "summary": "이슈 한 줄 요약"
    }
  ],
  "customerTraits": ["까다로움|가격민감|급함|충성|신규|우호" 중 해당],
  "employees": [ { "name": "직원명", "handled": 1, "style": "신속|꼼꼼|에스컬레이션|친절|건조 중 추정" } ],
  "resolution": { "method": "이 대화에서 문제를 어떻게 해결했나 한 줄", "logic": "적용한 판단/규칙 한 줄(예: 재고확인 후 대체품 제안)", "humanJudgment": "사람 판단이 필요했던 지점 한 줄(없으면 '기계적처리 가능')" }
}
이슈가 없으면 issues: []. 반드시 유효한 JSON 하나만.`;
}
function claudeCli(prompt) {
  return new Promise((resolve) => {
    if (!CLAUDE_CLI) return resolve(null);
    execFile(CLAUDE_CLI, ['-p', prompt], { timeout: 150000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { console.warn('  CLI 실패:', err.message.split('\n')[0]); return resolve(null); }
      resolve(parseJson(String(stdout)));
    });
  });
}
function parseJson(text) {
  if (!text) return null;
  const b = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  let s = b ? b[1] : text;
  const m = s.match(/\{[\s\S]*\}/); if (m) s = m[0];
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function processRoom(room) {
  let offset = 0, all = [];
  for (;;) {
    const r = await getMessages(room, offset, 500);
    const msgs = r.messages || [];
    all = all.concat(msgs);
    if (msgs.length < 500) break;
    offset += 500;
    if (all.length >= 20000) break; // 방당 상한(안전)
  }
  const threads = buildThreads(all);
  let done = 0;
  for (const th of threads) {
    const key = hash(room + '|' + th[0].created_at + '|' + th.length + '|' + (th[th.length - 1].id || ''));
    if (_state.processed[key]) continue;
    const transcript = th.map(m => `${m.sender || m.user_id || '?'}: ${(m.message || '').slice(0, 300)}`).join('\n').slice(0, 12000);
    const out = await claudeCli(buildPrompt(room, transcript));
    if (out) {
      await postEvent({
        id: 'kintel-' + hash(key) + '-' + (th[0].created_at || ''),
        type: 'kakao.intel', source: 'kakao-intel-worker', sessionId: 'kakao',
        timestamp: th[th.length - 1].created_at || new Date().toISOString(),
        data: { room, threadKey: key, msgCount: th.length, spanFrom: th[0].created_at, spanTo: th[th.length - 1].created_at, ...out },
      }).catch(() => {});
      done++;
      console.log(`  [${room}] 스레드 분석 → 이슈 ${(out.issues || []).length} / 거래처 ${out.customer || '?'}`);
    }
    _state.processed[key] = 1; saveState();
  }
  return { threads: threads.length, done };
}

async function runAll() {
  if (!CLAUDE_CLI) { console.error('[kakao-intel] Claude CLI 없음 — Max 구독 claude 명령 설치 필요'); process.exit(1); }
  console.log(`[kakao-intel] 시작 · server=${SERVER} · CLI=${CLAUDE_CLI}`);
  let rooms = [];
  try { const r = await getRooms(); rooms = (r.chatrooms || r.rooms || []).map(x => x.chatroom || x.room || x.name || x).filter(Boolean); } catch (e) { console.error('방 조회 실패:', e.message); }
  if (ONLY_ROOM) rooms = [ONLY_ROOM];
  console.log(`  방 ${rooms.length}개 처리`);
  let total = 0;
  for (const room of rooms) {
    try { const r = await processRoom(room); total += r.done; console.log(`[${room}] 스레드 ${r.threads} · 신규분석 ${r.done}`); }
    catch (e) { console.warn(`[${room}] 실패:`, e.message); }
  }
  console.log(`[kakao-intel] 완료 · 신규 분석 ${total}건 (누적 처리 ${Object.keys(_state.processed).length})`);
  return total;
}

(async () => {
  await runAll();
  if (ONCE) return;
  setInterval(() => { runAll().catch(e => console.warn('루프 오류:', e.message)); }, POLL_MS);
})();
