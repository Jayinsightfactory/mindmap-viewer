'use strict';
/**
 * bank-mode-toggle.js — 은행 보안 프로그램 자동 on/off
 *
 * 은행 작업 안 할 때 → 보안 프로그램 종료 → 정상 데이터 수집
 * 은행 작업 시작 시 → 보안 프로그램 재시작 → bank-safe-collector 전환
 *
 * 원리:
 *   1. 5분마다 브라우저 URL/윈도우 타이틀에서 은행 사이트 감지
 *   2. 은행 사이트 아님 + 보안 프로그램 실행 중 → 종료
 *   3. 은행 사이트 감지 → 보안 프로그램 실행 확인 (자동 설치되므로 방치)
 *   4. 수동 토글: orbit-bank-on.bat / orbit-bank-off.bat
 *
 * ⚠️ Windows 전용 (process.platform === 'win32')
 */

// [2026-06-10] execSync/os/fs/path 제거 — 강제 종료(taskkill/net stop)와 bat 생성 로직을
// 없애면서 더는 쓰이지 않음. 프로세스 조회는 아래 win-shell 비동기 호출로만 한다.

// ── 한국 은행 보안 프로세스 목록 ──
//
// residentOnly: true  → 부팅 시 상주하지만 키보드 후킹을 실제로 막지 않는 에이전트.
//   이 프로세스만 감지되면 은행 사이트(URL/타이틀)가 함께 활성일 때만 bank-safe 전환.
//   은행 업무를 안 할 때는 정상 수집 유지.
// residentOnly 없음   → 키보드 보안 프로그램: 실행 중이면 키보드 후킹 자체가 막히므로
//   은행 사이트 여부와 무관하게 즉시 bank-safe 전환 (기존 동작 유지).
//
const BANK_SECURITY_PROCESSES = [
  // 키보드 보안 (후킹 차단 — 무조건 bank-safe)
  { name: 'TouchEnKey', process: 'TouchEnKey.exe', service: 'TouchEnKey' },
  { name: 'KeySharp', process: 'KeySharp.exe', service: null },
  { name: 'ASTx', process: 'astx.exe', service: 'ASTxSvc' },
  // 범용 보안 (키보드 후킹 차단 — 무조건 bank-safe)
  { name: 'nProtect', process: 'nProtect.exe', service: 'nProtect' },
  { name: 'AhnLab Safe Transaction', process: 'ASDSvc.exe', service: 'AhnLabSafeTransaction' },
  { name: 'AhnLab V3', process: 'V3Lite.exe', service: null, critical: true }, // V3는 건드리면 안 됨
  // 인증/전자서명 (키보드 후킹 차단 — 무조건 bank-safe)
  { name: 'INISAFEWeb', process: 'INISAFEWeb.exe', service: null },
  { name: 'INISAFE CrossWeb', process: 'INISAFECrossWebEX.exe', service: null },
  { name: 'XecureWeb', process: 'XecureWeb.exe', service: null },
  // 상주 에이전트 (키보드 후킹 안 막음 — 은행 사이트 병용 시에만 bank-safe)
  { name: 'nProtect Online Security', process: 'npupdate.exe', service: null, residentOnly: true },
  { name: 'IPInside', process: 'IPInsideAgent.exe', service: 'IPInsideAgent', residentOnly: true },
  { name: 'Veraport', process: 'veraport.exe', service: null, residentOnly: true },
  { name: 'MarkAny', process: 'MaWebClient.exe', service: null, residentOnly: true },
  { name: 'Fasoo DRM', process: 'FSD.exe', service: null, residentOnly: true },
];

// ── 은행 사이트 URL 패턴 ──
const BANK_URL_PATTERNS = [
  'kbstar.com', 'shinhan.com', 'wooribank.com', 'hanabank.com',
  'ibk.co.kr', 'keb.co.kr', 'standardchartered.co.kr', 'citibank.co.kr',
  'nonghyup.com', 'busanbank.co.kr', 'dgb.co.kr', 'kjbank.com',
  'suhyup-bank.com', 'jbbank.co.kr', 'kfcc.co.kr', 'epostbank.go.kr',
  'mybank.woori', 'banking', 'netbank', 'ebanking',
  // 카드
  'shinhancard.com', 'lottefinancial.com', 'samsungcard.com',
  // 증권
  'kiwoom.com', 'nhqv.com', 'samsungsecurities.com',
];

// ── 은행 윈도우 타이틀 패턴 ──
const BANK_TITLE_PATTERNS = [
  '인터넷뱅킹', '인터넷 뱅킹', '스마트뱅킹', '기업뱅킹',
  '공인인증', '공동인증', 'OTP', '보안카드',
  '계좌이체', '이체', '잔액조회',
];

let _running = false;
let _timer = null;
let _bankMode = false; // true = 은행 보안 활성 상태
let _lastCheck = null;

/**
 * 현재 실행 중인 은행 보안 프로세스 확인 (win-shell 통해 cmd 깜빡임 0)
 * 이전: execSync('tasklist') 매 3분 호출 → conhost 깜빡임 원인
 * 현재: long-running PowerShell의 Get-Process 1회 쿼리
 */
let _procListCache = '';
let _procListCacheAt = 0;
async function getRunningBankProcessesAsync() {
  if (process.platform !== 'win32') return [];

  // 30초 캐시 — 같은 사이클에서 isBankingActive + getRunningBankProcesses 둘 다 호출되는 경우 대비
  const now = Date.now();
  let output = (now - _procListCacheAt < 30000) ? _procListCache : '';

  if (!output) {
    const ws = _loadWinShell();
    if (!ws || !ws.isAvailable()) return []; // 폴백 X (cmd창 깜빡임 절대 회피)
    try {
      output = (await ws.exec('(Get-Process | Select-Object -ExpandProperty Name) -join \',\'', 5000) || '').toLowerCase();
      _procListCache = output;
      _procListCacheAt = now;
    } catch { return []; }
  }

  const running = [];
  for (const proc of BANK_SECURITY_PROCESSES) {
    if (proc.critical) continue;
    const name = proc.process.toLowerCase().replace(/\.exe$/, '');
    if (output.includes(name)) running.push(proc);
  }
  return running;
}

// 동기 호환용 — 호출자는 비어있는 배열 받음 (이전 호출 누적 캐시는 살아있음)
function getRunningBankProcesses() {
  if (process.platform !== 'win32') return [];
  // 캐시된 값으로 동기 응답 (없으면 빈 배열)
  if (!_procListCache) return [];
  const running = [];
  for (const proc of BANK_SECURITY_PROCESSES) {
    if (proc.critical) continue;
    const name = proc.process.toLowerCase().replace(/\.exe$/, '');
    if (_procListCache.includes(name)) running.push(proc);
  }
  return running;
}

// Windows: long-running PowerShell로 cmd창 깜빡임 방지
let _winShell = null, _winShellFailed = false;
function _loadWinShell() {
  if (_winShell || _winShellFailed) return _winShell;
  try { _winShell = require('./win-shell'); }
  catch (e) { _winShellFailed = true; }
  return _winShell;
}

/**
 * 은행 사이트 접속 중인지 확인
 */
async function isBankingActive() {
  if (process.platform !== 'win32') return false;

  try {
    const ws = _loadWinShell();
    if (!ws || !ws.isAvailable()) return false; // win-shell 없으면 skip (cmd창 폴백 금지)

    // 방법 1: 활성 윈도우 타이틀 확인
    let title = '';
    try {
      title = await ws.exec(
        '(Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | Select-Object MainWindowTitle | ConvertTo-Json)',
        5000
      ) || '';
    } catch { return false; }

    const titles = JSON.parse(title || '[]');
    const allTitles = (Array.isArray(titles) ? titles : [titles])
      .map(t => (t.MainWindowTitle || '').toLowerCase())
      .join(' ');

    // 은행 타이틀 패턴 매칭
    for (const pattern of BANK_TITLE_PATTERNS) {
      if (allTitles.includes(pattern.toLowerCase())) return true;
    }

    // 방법 2: 브라우저 URL에서 은행 사이트 감지 (Chrome History)
    // (가벼운 체크만 — 타이틀로 충분하면 스킵)
    for (const urlPattern of BANK_URL_PATTERNS) {
      if (allTitles.includes(urlPattern)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// [2026-06-10] 은행 보안 프로그램 강제 종료(killBankSecurity)·재시작(enableBankMode) 로직 제거.
// 정책 변경: 보안 프로그램은 절대 종료하지 않는다. 떠 있는 동안엔 키보드 후킹이 막히므로
// 최소 수집(bank-safe-collector)으로만 전환하고, 사라지면 풀 수집으로 복귀한다. (_autoCheck 참조)

/**
 * 자동 감지 루프 (5분마다)
 */
async function _autoCheck() {
  if (process.platform !== 'win32') return;

  // 은행 보안 프로세스가 떠 있는지만 본다 (은행 사이트 접속 여부와 무관 —
  // 보안 프로그램이 켜지면 키보드 후킹 자체가 막히므로 최소 수집으로 전환)
  const securityRunning = await getRunningBankProcessesAsync();

  // 키보드 후킹 차단 프로세스 vs 상주 에이전트(후킹 안 막음) 분리
  const hardProcs = securityRunning.filter(p => !p.residentOnly);
  const softProcs = securityRunning.filter(p => p.residentOnly);

  _lastCheck = {
    timestamp: new Date().toISOString(),
    securityProcesses: securityRunning.map(p => p.name),
    hardProcs: hardProcs.map(p => p.name),
    softProcs: softProcs.map(p => p.name),
    bankMode: _bankMode,
  };

  let bankSafe;
  try { bankSafe = require('./bank-safe-collector'); } catch { return; }

  // 키보드 차단 프로세스가 있으면 무조건 bank-safe
  // 상주 에이전트만 있으면 실제 은행 사이트 접속 여부도 함께 확인
  let shouldBankSafe = false;
  if (hardProcs.length > 0) {
    shouldBankSafe = true;
  } else if (softProcs.length > 0) {
    const bankingNow = await isBankingActive();
    if (bankingNow) {
      shouldBankSafe = true;
      console.log(`[bank-toggle] 상주 보안 프로그램(${softProcs.map(p=>p.name).join(',')}) + 은행 사이트 감지 → 최소 수집 전환`);
    } else {
      console.log(`[bank-toggle] 상주 보안 프로그램(${softProcs.map(p=>p.name).join(',')}) 감지 — 은행 사이트 없음 → 정상 수집 유지`);
    }
  }

  if (shouldBankSafe) {
    if (!bankSafe.isRunning()) {
      const trigger = hardProcs.length > 0 ? hardProcs.map(p=>p.name).join(',') : softProcs.map(p=>p.name).join(',');
      console.log(`[bank-toggle] 은행 보안 감지(${trigger}) → 최소 수집 모드 전환`);
      bankSafe.start({ interval: 3 * 60 * 1000 });
    }
    _bankMode = true;
  } else {
    if (bankSafe.isRunning()) {
      console.log('[bank-toggle] 은행 보안 없음 → 정상 풀 수집 재개');
      bankSafe.notifyActive();
    }
    _bankMode = false;
  }
}

/**
 * 시작
 */
function start(opts = {}) {
  if (process.platform !== 'win32') {
    console.log('[bank-toggle] Windows 전용 — 스킵');
    return;
  }
  if (_running) return;
  _running = true;

  const interval = opts.interval || 3 * 60 * 1000; // 3분

  // 부팅 직후엔 보안 프로그램이 아직 안 떠 있으면 풀 수집 그대로 유지.
  // 보안 프로그램이 감지되는 순간 _autoCheck가 최소 수집으로 전환한다 (강제 종료 없음).
  _autoCheck();
  _timer = setInterval(_autoCheck, interval);
  console.log('[bank-toggle] 은행 보안 감지 → 최소 수집 자동 전환 시작 (3분 간격, 강제 종료 없음)');
}

// [2026-06-10] 수동 토글 bat(_createToggleBats) 제거 — taskkill로 보안 프로그램을
// 종료하던 orbit-bank-off.bat을 더는 생성하지 않는다 (강제 종료 정책 폐기).

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _running = false;
}

function isRunning() { return _running; }
function isBankMode() { return _bankMode; }
function getStatus() { return _lastCheck; }

module.exports = { start, stop, isRunning, isBankMode, getStatus, getRunningBankProcesses, isBankingActive };
