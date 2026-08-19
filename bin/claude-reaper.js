#!/usr/bin/env node
'use strict';
/**
 * claude-reaper.js — owner PC 전용 좀비 claude 프로세스 회수기
 * ─────────────────────────────────────────────────────────────────────────────
 * 문제: vision/kakao-intel/ops-agent/solution-miner 워커가 `claude -p`를 execFile로 스폰하고
 *       타임아웃(120~200s)도 걸지만, Windows는 TerminateProcess가 claude의 "자식 트리"를
 *       못 죽여 claude.exe가 안 죽고 쌓인다(13h+ 좀비 다수 = 메모리·CPU 잡아먹어 화면끊김).
 *
 * 해결: 주기적으로 claude.exe 중 "부모가 node.exe(=워커가 스폰한 것)" 이고 나이 REAP_MIN분 이상인
 *       프로세스를 트리 종료(taskkill /PID .. /T /F). 정상 분석은 <200s라 15분+는 확실히 스턱.
 *
 * 안전: 대화형 Claude Code 세션은 부모가 터미널/호스트(node 아님)라 절대 대상이 안 됨.
 *       부모가 node.exe인 것만 회수 → 워커 자식만 정확히 겨냥.
 *
 * 사용: node bin/claude-reaper.js   (owner PC 백그라운드 상시 실행)
 *   env: CLAUDE_REAP_MIN(기본 15분) · CLAUDE_REAP_INTERVAL_S(기본 120초)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { execSync } = require('child_process');

const REAP_MIN = parseInt(process.env.CLAUDE_REAP_MIN || '15', 10);
const INTERVAL = parseInt(process.env.CLAUDE_REAP_INTERVAL_S || '120', 10) * 1000;

if (process.platform !== 'win32') { console.error('[claude-reaper] Windows 전용 — 종료'); process.exit(0); }

function pwsh(cmd) {
  return execSync('powershell -NoProfile -NonInteractive -Command "' + cmd.replace(/"/g, '\\"') + '"',
    { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }).toString();
}

// 좀비의 실제 형태: 워커(node) → claudeA(parent=node) → claudeB(parent=claudeA).
// 타임아웃이 claudeA를 죽이면 claudeB는 부모 죽은 고아로 남는다. 그래서 "parent=node"만으론 부족.
// claude 조상 사슬을 타고 올라가 첫 non-claude 조상(=기원)을 찾는다:
//   node.exe → 워커기원(회수) · 부모 죽음 → 고아(회수) · explorer/pwsh/host → 세션기원(보호).
function originOf(pid, map) {
  let cur = map.get(pid), guard = 0;
  while (cur && String(cur.n).toLowerCase() === 'claude.exe' && guard++ < 25) {
    const par = map.get(cur.pp);
    if (!par) return 'orphan';                                   // 부모가 이미 죽음 → 스턱 손자
    if (String(par.n).toLowerCase() !== 'claude.exe') return String(par.n).toLowerCase(); // 첫 non-claude 기원
    cur = par;
  }
  return 'unknown';
}

function sweep() {
  let list;
  try {
    // 전체 프로세스 {pid, 부모pid, 이름, 나이(분)} — 조상 사슬 계산용
    const json = pwsh(
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ " +
      "p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; age=[int]((Get-Date)-$_.CreationDate).TotalMinutes } } | ConvertTo-Json -Compress"
    );
    list = JSON.parse(json || '[]');
    if (!Array.isArray(list)) list = list ? [list] : [];
  } catch (e) {
    console.warn('[claude-reaper] 목록 조회 실패:', String(e.message).split('\n')[0]);
    return;
  }

  const map = new Map();
  for (const x of list) if (x && x.p != null) map.set(x.p, x);

  let reaped = 0, claudeN = 0;
  for (const x of list) {
    if (!x || String(x.n).toLowerCase() !== 'claude.exe') continue;
    claudeN++;
    if (x.age < REAP_MIN) continue;                 // 정상 분석은 <200s → 15분+는 확실히 스턱
    const origin = originOf(x.p, map);
    if (origin === 'node.exe' || origin === 'orphan') {  // 워커기원·고아만. 세션기원(explorer 등)은 보호
      try { execSync('taskkill /PID ' + x.p + ' /T /F', { stdio: 'ignore', timeout: 10000 }); reaped++; }
      catch { /* 이미 종료·권한 — 무시 */ }
    }
  }
  if (reaped) console.log(`[claude-reaper] ${new Date().toISOString()} · 좀비 ${reaped}개 회수 (전체 claude ${claudeN})`);
}

console.log(`[claude-reaper] 시작 · ${REAP_MIN}분+ · parent=node(워커) 한정 · ${INTERVAL / 1000}s 주기`);
sweep();
setInterval(sweep, INTERVAL);
