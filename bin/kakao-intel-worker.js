'use strict';
/**
 * kakao-intel-worker.js — 카톡 대화 인텔리전스 워커 (골 자동디벨롭)
 *
 * owner PC의 Claude CLI(Max 구독, $0)로 카톡 "원문 대화"를 전량 딥분석:
 *   이슈/케이스 라이프사이클 + 거래처 성향신호 + 직원 역할 + 해결로직(자동화 후보 태깅).
 *
 * 소스 = 시트 '메시지분류' 원문 (서버 /api/mining/kakao-raw* 경유, _fetchKakaoSheetData 재사용).
 *   ※ 복호화 DB /api/kakao/messages 는 프로덕션 비어있음 → 시트가 유일 실소스.
 *   ※ 시각에 날짜 없음 → 시트 append 순서를 시퀀스로 사용(30분갭 스레드분할 불가).
 *   ※ 케이스는 품목+차수로 묶임. 발신자 대부분=우리 직원(거래처는 내용 안에 등장).
 *   ※ [AI분류|품목|차수] 태그가 메시지마다 있어 S5 교차검증 앵커로 사용.
 * 프라이버시: 원문은 워커 메모리에서만 쓰고, 서버엔 파생결과(type='kakao.intel')만 저장.
 *
 * 실행(owner PC, Claude CLI 설치됨):
 *   node bin/kakao-intel-worker.js               # 전 방 전량 처리 후 폴링 대기
 *   node bin/kakao-intel-worker.js --once         # 1회만
 *   node bin/kakao-intel-worker.js --room "방명"   # 특정 방만
 *   node bin/kakao-intel-worker.js --windows 1     # 검증용: 방당 윈도우 N개만
 *
 * 서버/토큰: ~/.orbit-config.json (serverUrl, token) 또는 env ORBIT_SERVER_URL/ORBIT_TOKEN.
 */
const { execFile, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const N = require('../src/intelligence/entity-resolution/korean-normalizer'); // levenshtein 재사용(방이름 깨짐 정규화)

// ── 설정 ────────────────────────────────────────────────────────────────────
let _cfg = {};
try { _cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); } catch {}
const SERVER = (_cfg.serverUrl || process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app').replace(/\/+$/, '');
const TOKEN = _cfg.token || process.env.ORBIT_TOKEN || '';
const STATE_FILE = path.join(os.homedir(), '.orbit', 'kakao-intel-state.json');
const ONCE = process.argv.includes('--once');
const argVal = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const ONLY_ROOM = argVal('--room');
const MAX_WINDOWS = parseInt(argVal('--windows')) || 0;     // 0 = 무제한
const WINDOW_SIZE = parseInt(argVal('--window-size')) || 90; // 윈도우당 메시지 수(append 순서)
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
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: 45000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (payload) r.write(payload); r.end();
  });
}
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const getRawRooms = () => req('GET', `/api/mining/kakao-raw-rooms?${q({ token: TOKEN })}`);
const getRaw = (room) => req('GET', `/api/mining/kakao-raw?${q({ token: TOKEN, room: room || '', limit: 5000 })}`);
const getRoster = () => req('GET', `/api/mining/kakao-roster?${q({ token: TOKEN })}`);
const postEvent = (ev) => req('POST', '/api/hook', { events: [ev] });

// ── 상태(처리한 윈도우) ───────────────────────────────────────────────────────
let _state = { processed: {} };
try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function saveState() { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(_state)); } catch {} }
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return String(h >>> 0); };

// ── 방이름 정규화: 깨진 글자(U+FFFD)로 쪼개진 변형을 대표명에 병합 ───────────
function buildRoomCanonizer(rooms) {
  // rooms: [{room, count}] — 많이 등장한 이름을 대표로 삼는다.
  const canon = [...rooms].sort((a, b) => b.count - a.count).map(r => r.room);
  const registry = new Map();
  const resolve = (raw) => {
    if (!raw) return raw;
    if (registry.has(raw)) return registry.get(raw);
    let best = raw, bestDist = Infinity;
    for (const c of canon) {
      if (c === raw) { best = c; bestDist = 0; break; }
      if (Math.abs(c.length - raw.length) > 4) continue;
      const d = N.levenshtein(raw, c);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    // 실측: 깨진 글자 1개가 U+FFFD 1~2개로 늘어 dist 최대 3. 짧은 이름 오탐은 비율(<20%)로 차단.
    const label = (bestDist <= 3 && bestDist / Math.max(raw.length, 1) < 0.2) ? best : raw;
    registry.set(raw, label);
    return label;
  };
  return resolve;
}

// ── Claude CLI 분석 (S1) ──────────────────────────────────────────────────────
function buildRosterLine(roster) {
  // 실명은 소스에 하드코딩하지 않는다(공개 저장소). 런타임에 /api/mining/kakao-roster 에서 주입.
  if (!roster || !roster.length) return '(직원 명단 미확보 — 문맥으로 추정)';
  return roster.map(r => `${r.name}(${(r.role || '').trim()}${r.domain ? '·' + r.domain.split(',')[0].trim() : ''})`).join(', ');
}
function buildPrompt(room, rosterLine, transcript) {
  return `당신은 화훼 도매회사의 업무대화 분석가다. 아래는 사내 업무방 "${room}"의 카카오톡 원문(시트 append 순서=시간순)이다.
발신자 대부분은 우리 직원이다. 직원 명단(아래에 있으면 직원):
${rosterLine}
표시명은 회사 접두어·직함·'친구'·'님' 등이 붙을 수 있다 — 그런 수식어를 떼면 위 명단의 실제 직원명과 매칭된다.
거래처(고객)는 발신자가 아니라 메시지 "내용 안에" 등장한다(꽃집·도매상·농장 등 상호).
각 메시지엔 이미 [AI분류|품목|차수] 태그가 붙어있다(참고·교차검증용, 틀릴 수 있음).

분석 단위 = 이슈/케이스(같은 품목+차수로 묶는다). 마크다운·설명 없이 순수 JSON 하나만 출력:
{
 "cases":[{"key":"차수+품목 예 11-1 카네이션","product":"","seq":"","type":"주문|주문변경추가|주문변경취소|주문변경교체|재고|불량클레임|정산|배차출고|문의|기타","raisedBy":"발신 직원명(로스터매칭)","customers":["내용에 언급된 거래처"],"resolved":true,"turns":1,"tone":"일상|급함|불만|정중|강경","evidence":"핵심 근거 원문 15자 이내 인용","summary":"한 줄"}],
 "roleMap":[{"raw":"발신 표시명","staff":"매칭된 직원명 또는 ''","isEmployee":true}],
 "decisionRules":[{"rule":"직원이 실제 업무처리에 적용한 규칙 한 줄","kind":"deterministic|judgment","evidence":"15자 이내"}],
 "resolutionSteps":["문제해결 절차 단계"],
 "humanJudgmentPoints":["사람 판단이 필요했던 지점(없으면 비움)"]
}
cases가 없으면 []. 반드시 유효한 JSON 하나만.
★decisionRules 규칙: '직원이 주문/재고/불량/출고를 처리하며 적용한 업무규칙'만 넣어라. 위에 준 분석지침(표시명 매칭·케이스 병합·발신자 직원판별)은 규칙이 아니므로 절대 넣지 마라.
대화:
${transcript}`;
}
function claudeCli(prompt) {
  return new Promise((resolve) => {
    if (!CLAUDE_CLI) return resolve(null);
    execFile(CLAUDE_CLI, ['-p', prompt], { timeout: 200000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
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

// ── S5 교차검증: LLM 케이스 product/seq vs 윈도우 메시지의 태그값 대조 ─────────
function crossCheck(cases, msgs) {
  const tagPairs = new Set();
  const products = new Set();
  for (const m of msgs) {
    if (m.product) products.add(String(m.product).trim());
    if (m.product && m.seq) tagPairs.add(String(m.product).trim() + '|' + String(m.seq).trim());
  }
  let matched = 0; const mismatches = [];
  for (const c of (cases || [])) {
    const p = (c.product || '').trim(), s = (c.seq || '').trim();
    const exact = p && s && tagPairs.has(p + '|' + s);
    const prodOnly = p && products.has(p);
    if (exact || prodOnly) matched++;
    else mismatches.push(c.key || (p + ' ' + s));
  }
  const total = (cases || []).length;
  return { score: total ? +(matched / total).toFixed(2) : 1, matched, total, mismatches: mismatches.slice(0, 8) };
}

// ── 윈도우 분할(append 순서) ──────────────────────────────────────────────────
function windowize(msgs, size) {
  const w = [];
  for (let i = 0; i < msgs.length; i += size) w.push(msgs.slice(i, i + size));
  return w;
}
function transcriptOf(msgs) {
  return msgs.map((m, i) => `${i + 1}. ${m.sender} [${m.aiClass || ''}|${m.product || ''}|${m.seq || ''}]: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function processRoom(room, allMsgs, rosterLine) {
  const windows = windowize(allMsgs, WINDOW_SIZE);
  let done = 0, processed = 0;
  for (let wi = 0; wi < windows.length; wi++) {
    if (MAX_WINDOWS && done >= MAX_WINDOWS) break;
    const win = windows[wi];
    if (win.length < 3) continue;
    const first = win[0], last = win[win.length - 1];
    const key = hash(room + '|w' + wi + '|' + win.length + '|' + String(first.text).slice(0, 40) + '|' + String(last.text).slice(0, 40));
    if (_state.processed[key]) { processed++; continue; }
    const out = await claudeCli(buildPrompt(room, rosterLine, transcriptOf(win)));
    if (out) {
      const cc = crossCheck(out.cases, win);
      await postEvent({
        id: 'kintel-' + key,
        type: 'kakao.intel', source: 'kakao-intel-worker', sessionId: 'kakao',
        timestamp: new Date().toISOString(),
        data: {
          room, windowIndex: wi, msgCount: win.length,
          firstTs: first.ts || '', lastTs: last.ts || '',
          cases: out.cases || [], roleMap: out.roleMap || [],
          decisionRules: out.decisionRules || [], resolutionSteps: out.resolutionSteps || [],
          humanJudgmentPoints: out.humanJudgmentPoints || [],
          crossCheck: cc,
        },
      }).catch(() => {});
      done++;
      console.log(`  [${room.slice(0, 20)}] w${wi} → 케이스 ${(out.cases || []).length} · 판단룰 ${(out.decisionRules || []).length} · 교차 ${cc.score}`);
    }
    _state.processed[key] = 1; saveState();
  }
  return { windows: windows.length, done, skipped: processed };
}

async function runAll() {
  if (!CLAUDE_CLI) { console.error('[kakao-intel] Claude CLI 없음 — Max 구독 claude 명령 설치 필요'); process.exit(1); }
  console.log(`[kakao-intel] 시작 · server=${SERVER} · CLI=${CLAUDE_CLI} · window=${WINDOW_SIZE}${MAX_WINDOWS ? ' · 최대윈도우 ' + MAX_WINDOWS : ''}`);

  const rosterRes = await getRoster().catch(() => ({}));
  const rosterLine = buildRosterLine(rosterRes.roster);
  console.log(`  로스터 ${(rosterRes.roster || []).length}명`);

  const roomsRes = await getRawRooms().catch(() => ({}));
  const rawRooms = roomsRes.rooms || [];
  if (!rawRooms.length) { console.warn('  방 없음(원문 소스 비어있음)'); return 0; }
  const canonize = buildRoomCanonizer(rawRooms);

  // 전체 원문 1회 fetch 후 방(정규화)별로 그룹 — 깨진 방이름 변형 자동 병합
  const rawAll = await getRaw('').catch(() => ({}));
  const msgs = rawAll.messages || [];
  const byRoom = new Map();
  for (const m of msgs) {
    const room = canonize(m.room || '');
    if (ONLY_ROOM && room !== ONLY_ROOM && (m.room || '') !== ONLY_ROOM) continue;
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push(m);
  }
  const rooms = [...byRoom.keys()].sort((a, b) => byRoom.get(b).length - byRoom.get(a).length);
  console.log(`  원문 ${msgs.length}건 · 방 ${rooms.length}개(정규화 후)`);

  let total = 0;
  for (const room of rooms) {
    try {
      const r = await processRoom(room, byRoom.get(room), rosterLine);
      total += r.done;
      console.log(`[${room.slice(0, 24)}] 윈도우 ${r.windows} · 신규 ${r.done} · 스킵 ${r.skipped}`);
      if (MAX_WINDOWS && total >= MAX_WINDOWS) break;
    } catch (e) { console.warn(`[${room.slice(0, 20)}] 실패:`, e.message); }
  }
  console.log(`[kakao-intel] 완료 · 신규 분석 ${total}건 (누적 처리 ${Object.keys(_state.processed).length})`);
  return total;
}

(async () => {
  await runAll();
  if (ONCE || MAX_WINDOWS) return;
  setInterval(() => { runAll().catch(e => console.warn('루프 오류:', e.message)); }, POLL_MS);
})();
