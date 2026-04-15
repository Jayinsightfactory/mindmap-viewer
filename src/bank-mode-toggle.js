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

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ── 한국 은행 보안 프로세스 목록 ──
const BANK_SECURITY_PROCESSES = [
  // 키보드 보안
  { name: 'TouchEnKey', process: 'TouchEnKey.exe', service: 'TouchEnKey' },
  { name: 'KeySharp', process: 'KeySharp.exe', service: null },
  { name: 'ASTx', process: 'astx.exe', service: 'ASTxSvc' },
  // 범용 보안
  { name: 'nProtect', process: 'nProtect.exe', service: 'nProtect' },
  { name: 'nProtect Online Security', process: 'npupdate.exe', service: null },
  { name: 'AhnLab Safe Transaction', process: 'ASDSvc.exe', service: 'AhnLabSafeTransaction' },
  { name: 'AhnLab V3', process: 'V3Lite.exe', service: null, critical: true }, // V3는 건드리면 안 됨
  // 인증/전자서명
  { name: 'INISAFEWeb', process: 'INISAFEWeb.exe', service: null },
  { name: 'INISAFE CrossWeb', process: 'INISAFECrossWebEX.exe', service: null },
  { name: 'XecureWeb', process: 'XecureWeb.exe', service: null },
  // IP/설치 관리
  { name: 'IPInside', process: 'IPInsideAgent.exe', service: 'IPInsideAgent' },
  { name: 'Veraport', process: 'veraport.exe', service: null },
  // 방화벽/기타
  { name: 'MarkAny', process: 'MaWebClient.exe', service: null },
  { name: 'Fasoo DRM', process: 'FSD.exe', service: null },
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
 * 현재 실행 중인 은행 보안 프로세스 확인
 */
function getRunningBankProcesses() {
  if (process.platform !== 'win32') return [];

  try {
    const output = execSync(
      'tasklist /FO CSV /NH',
      { windowsHide: true, stdio: 'pipe', timeout: 10000, encoding: 'utf-8' }
    );

    const running = [];
    for (const proc of BANK_SECURITY_PROCESSES) {
      if (proc.critical) continue; // V3 같은 건 건드리지 않음
      if (output.toLowerCase().includes(proc.process.toLowerCase())) {
        running.push(proc);
      }
    }
    return running;
  } catch {
    return [];
  }
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

/**
 * 은행 보안 프로세스 종료 (은행 작업 안 할 때)
 */
function killBankSecurity() {
  if (process.platform !== 'win32') return { killed: 0 };

  const running = getRunningBankProcesses();
  let killed = 0;

  for (const proc of running) {
    try {
      execSync(`taskkill /IM "${proc.process}" /F`, {
        windowsHide: true, stdio: 'pipe', timeout: 5000
      });
      console.log(`[bank-toggle] ${proc.name} 종료`);
      killed++;
    } catch {
      // 이미 종료됐거나 권한 부족
    }

    // 서비스도 중지
    if (proc.service) {
      try {
        execSync(`net stop "${proc.service}"`, {
          windowsHide: true, stdio: 'pipe', timeout: 10000
        });
      } catch {}
    }
  }

  _bankMode = false;
  return { killed, processes: running.map(p => p.name) };
}

/**
 * 은행 모드 활성화 (보안 프로그램 재시작 — 은행 사이트 접속 시 자동)
 */
function enableBankMode() {
  // 은행 사이트 접속하면 보안 프로그램이 자동으로 다시 설치/실행됨
  // 여기서는 상태만 전환하고, bank-safe-collector로 전환
  _bankMode = true;
  console.log('[bank-toggle] 은행 모드 활성화 — bank-safe-collector 전환');

  try {
    const bankSafe = require('./bank-safe-collector');
    if (!bankSafe.isRunning()) {
      bankSafe.start({ interval: 3 * 60 * 1000 });
    }
  } catch {}
}

/**
 * 자동 감지 루프 (5분마다)
 */
async function _autoCheck() {
  if (process.platform !== 'win32') return;

  const banking = await isBankingActive();
  const securityRunning = getRunningBankProcesses();

  _lastCheck = {
    timestamp: new Date().toISOString(),
    bankingActive: banking,
    securityProcesses: securityRunning.map(p => p.name),
    bankMode: _bankMode,
  };

  if (banking) {
    // 은행 작업 중 → 보안 유지
    if (!_bankMode) {
      enableBankMode();
      console.log('[bank-toggle] 은행 사이트 감지 → 보안 모드 유지');
    }
  } else if (securityRunning.length > 0 && !banking) {
    // 은행 작업 안 하는데 보안 프로그램 실행 중 → 종료
    console.log(`[bank-toggle] 은행 미사용 + 보안 ${securityRunning.length}개 실행 중 → 종료`);
    const result = killBankSecurity();
    console.log(`[bank-toggle] ${result.killed}개 종료: ${result.processes.join(', ')}`);

    // bank-safe-collector 중지, 정상 수집 재개
    try {
      const bankSafe = require('./bank-safe-collector');
      bankSafe.notifyActive();
    } catch {}
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

  // 시작 즉시 보안 종료 (은행 사이트 안 열려있으면)
  setTimeout(async () => {
    if (!(await isBankingActive())) {
      const running = getRunningBankProcesses();
      if (running.length > 0) {
        console.log(`[bank-toggle] 시작 시 은행 미사용 — 보안 ${running.length}개 즉시 종료`);
        killBankSecurity();
      }
    }
  }, 10 * 1000); // 10초 후 (데몬 안정화 대기)

  _timer = setInterval(_autoCheck, interval);
  console.log('[bank-toggle] 은행 보안 자동 종료 시작 (3분 간격, 은행 접속 시만 유지)');

  // bat 파일 생성 (수동 토글용)
  _createToggleBats();
}

/**
 * 수동 토글용 bat 파일 생성
 */
function _createToggleBats() {
  const orbitDir = path.join(os.homedir(), '.orbit');
  try { fs.mkdirSync(orbitDir, { recursive: true }); } catch {}

  // 은행 모드 OFF (보안 종료)
  const offBat = `@echo off
echo [Orbit] 은행 보안 프로그램을 종료합니다...
${BANK_SECURITY_PROCESSES.filter(p => !p.critical).map(p =>
  `taskkill /IM "${p.process}" /F 2>nul`
).join('\n')}
echo [Orbit] 정상 데이터 수집 모드로 전환되었습니다.
pause`;

  // 은행 모드 ON (안내)
  const onBat = `@echo off
echo [Orbit] 은행 사이트에 접속하면 보안 프로그램이 자동으로 실행됩니다.
echo [Orbit] 은행 작업이 끝나면 orbit-bank-off.bat을 실행해주세요.
echo.
echo 은행 사이트 목록:
echo   KB국민: kbstar.com
echo   신한: shinhan.com
echo   우리: wooribank.com
echo   하나: hanabank.com
echo   IBK기업: ibk.co.kr
echo   NH농협: nonghyup.com
echo.
pause`;

  try {
    fs.writeFileSync(path.join(orbitDir, 'orbit-bank-off.bat'), offBat, 'utf-8');
    fs.writeFileSync(path.join(orbitDir, 'orbit-bank-on.bat'), onBat, 'utf-8');
    console.log('[bank-toggle] ~/.orbit/orbit-bank-off.bat, orbit-bank-on.bat 생성 완료');
  } catch {}
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _running = false;
}

function isRunning() { return _running; }
function isBankMode() { return _bankMode; }
function getStatus() { return _lastCheck; }

module.exports = { start, stop, isRunning, isBankMode, getStatus, killBankSecurity, enableBankMode, getRunningBankProcesses, isBankingActive };
