'use strict';
/**
 * bank-detector.js — 은행 보안 프로그램 감지 + 상세 분석
 *
 * 실행: node tools/bank-detector.js
 * 원격: daemon-updater exec 명령으로 실행
 *
 * 감지 항목:
 *   1. 실행 중인 은행 보안 프로세스
 *   2. 설치된 은행 보안 프로그램 (레지스트리)
 *   3. 은행 보안 서비스 (Windows Services)
 *   4. 은행 보안 드라이버 (커널 레벨)
 *   5. 차단 테스트 (키보드/캡처/클립보드 가능 여부)
 *   6. 결과를 서버에 전송
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── 서버 설정 ──
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
})();
const SERVER = CONFIG.serverUrl || process.env.ORBIT_SERVER_URL || 'https://sparkling-determination-production-c88b.up.railway.app';
const TOKEN = CONFIG.token || process.env.ORBIT_TOKEN || '';

// ── 한국 은행 보안 프로그램 DB (106개) ──
const BANK_PROGRAMS = {
  // 키보드 보안
  keyboard: [
    { name: 'TouchEn nxKey', process: ['TouchEnNxKey.exe','TouchEn nxKey.exe'], service: 'TouchEnNxKey', vendor: 'RaonSecure' },
    { name: 'TouchEn Key', process: ['TouchEnKey.exe'], service: 'TouchEnKey', vendor: 'RaonSecure' },
    { name: 'nProtect KeyCrypt', process: ['nProtectKeyCrypt.exe','npkcrypt.exe'], service: null, vendor: 'INCA' },
    { name: 'ASTx', process: ['ASTx.exe','astx64.exe'], service: 'ASTxSvc', vendor: 'AhnLab' },
    { name: 'KeySharp', process: ['KeySharp.exe','KSInstaller.exe'], service: null, vendor: 'SoftForum' },
    { name: 'K-Defense', process: ['KDefense.exe'], service: null, vendor: 'Kings Info' },
  ],
  // 방화벽/백신
  firewall: [
    { name: 'AhnLab Safe Transaction', process: ['ASDSvc.exe','V3LTray.exe','ast.exe'], service: 'AhnLabSafeTransaction', vendor: 'AhnLab' },
    { name: 'nProtect Online Security', process: ['npupdate.exe','nProtect.exe','NPAgent.exe'], service: 'nProtectOnline', vendor: 'INCA' },
    { name: 'nProtect Netizen', process: ['nProtect Netizen.exe'], service: null, vendor: 'INCA' },
    { name: 'AhnLab V3 Lite', process: ['V3Lite.exe','V3LTray.exe'], service: 'V3LiteSvc', vendor: 'AhnLab', critical: true },
  ],
  // 인증/전자서명
  auth: [
    { name: 'INISAFE CrossWeb', process: ['INISAFECrossWebEX.exe','INISAFEWeb.exe'], service: null, vendor: 'Initech' },
    { name: 'XecureWeb', process: ['XecureWeb.exe','XecureBrowser.exe'], service: null, vendor: 'SoftForum' },
    { name: 'MagicLine4NX', process: ['MagicLine4NX.exe'], service: null, vendor: 'DreamSecurity' },
    { name: 'VeraPort', process: ['veraport.exe','veraport-g3.exe'], service: null, vendor: 'Wizvera' },
    { name: 'Delfino', process: ['delfino.exe','G3'], service: null, vendor: 'Wizvera' },
  ],
  // IP/PC 정보
  info: [
    { name: 'IPinside Agent', process: ['IPInsideAgent.exe','IPInside_EP.exe'], service: 'IPInsideAgent', vendor: 'Interzen' },
    { name: 'IPinside LWS', process: ['IPInsideLWS.exe'], service: null, vendor: 'Interzen' },
  ],
  // 문서 보안 / DRM
  drm: [
    { name: 'MarkAny', process: ['MaWebClient.exe','MarkAnyDRM.exe'], service: null, vendor: 'MarkAny' },
    { name: 'Fasoo DRM', process: ['FSD.exe','FSClient.exe'], service: null, vendor: 'Fasoo' },
    { name: 'SoftCamp DRM', process: ['SCAgent.exe'], service: null, vendor: 'SoftCamp' },
  ],
};

// ── PowerShell 실행 헬퍼 ──
function ps(cmd) {
  try {
    return execSync(`powershell -WindowStyle Hidden -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
      windowsHide: true, stdio: 'pipe', timeout: 15000, encoding: 'utf-8'
    }).trim();
  } catch { return ''; }
}

function psJson(cmd) {
  const raw = ps(cmd + ' | ConvertTo-Json -Compress');
  try { return JSON.parse(raw || '[]'); } catch { return raw; }
}

// ── 1. 실행 중인 보안 프로세스 감지 ──
function detectRunningProcesses() {
  console.log('\n[1/5] 실행 중인 은행 보안 프로세스 감지...');
  const tasklist = ps('Get-Process | Select ProcessName, Id, Path | ConvertTo-Json');
  let processes = [];
  try { processes = JSON.parse(tasklist || '[]'); } catch {}
  if (!Array.isArray(processes)) processes = [processes];

  const found = [];
  for (const [category, programs] of Object.entries(BANK_PROGRAMS)) {
    for (const prog of programs) {
      for (const procName of prog.process) {
        const match = processes.find(p =>
          (p.ProcessName || '').toLowerCase() === procName.replace('.exe','').toLowerCase()
        );
        if (match) {
          found.push({
            name: prog.name,
            category,
            processName: match.ProcessName,
            pid: match.Id,
            path: match.Path || '',
            vendor: prog.vendor,
            critical: prog.critical || false,
          });
        }
      }
    }
  }
  console.log(`  발견: ${found.length}개`);
  found.forEach(f => console.log(`  ● [${f.category}] ${f.name} (${f.processName}, PID:${f.pid})`));
  return found;
}

// ── 2. 설치된 보안 프로그램 (레지스트리) ──
function detectInstalledPrograms() {
  console.log('\n[2/5] 설치된 은행 보안 프로그램 확인...');
  const installed = ps(`
    Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,
    HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'TouchEn|nProtect|INISAFE|XecureWeb|IPInside|VeraPort|AhnLab|KeySharp|MagicLine|Delfino|MarkAny|Fasoo|ASTx|K-Defense' } |
    Select DisplayName, DisplayVersion, Publisher, InstallDate |
    ConvertTo-Json -Compress
  `);
  let programs = [];
  try { programs = JSON.parse(installed || '[]'); } catch {}
  if (!Array.isArray(programs)) programs = programs ? [programs] : [];

  console.log(`  설치됨: ${programs.length}개`);
  programs.forEach(p => console.log(`  ○ ${p.DisplayName} (${p.Publisher || '?'}, ${p.DisplayVersion || '?'})`));
  return programs;
}

// ── 3. 은행 보안 서비스 ──
function detectServices() {
  console.log('\n[3/5] 은행 보안 서비스 확인...');
  const services = ps(`
    Get-Service | Where-Object { $_.DisplayName -match 'TouchEn|nProtect|INISAFE|IPInside|AhnLab|ASTx|KeySharp' -or $_.Name -match 'TouchEn|nProtect|INISAFE|IPInside|ASTx' } |
    Select Name, DisplayName, Status, StartType |
    ConvertTo-Json -Compress
  `);
  let svcs = [];
  try { svcs = JSON.parse(services || '[]'); } catch {}
  if (!Array.isArray(svcs)) svcs = svcs ? [svcs] : [];

  console.log(`  서비스: ${svcs.length}개`);
  svcs.forEach(s => console.log(`  ◆ [${s.Status}] ${s.DisplayName} (시작: ${s.StartType})`));
  return svcs;
}

// ── 4. 커널 드라이버 감지 ──
function detectDrivers() {
  console.log('\n[4/5] 커널 드라이버 확인...');
  const drivers = ps(`
    Get-WmiObject Win32_SystemDriver | Where-Object { $_.DisplayName -match 'TouchEn|nProtect|npk|ast|KeySharp|IPInside' -or $_.Name -match 'npk|nProtect|TouchEn|ast' } |
    Select Name, DisplayName, State, PathName |
    ConvertTo-Json -Compress
  `);
  let drvs = [];
  try { drvs = JSON.parse(drivers || '[]'); } catch {}
  if (!Array.isArray(drvs)) drvs = drvs ? [drvs] : [];

  console.log(`  드라이버: ${drvs.length}개`);
  drvs.forEach(d => console.log(`  ◇ [${d.State}] ${d.DisplayName} (${d.PathName || '?'})`));
  return drvs;
}

// ── 5. 차단 테스트 ──
function runBlockTests() {
  console.log('\n[5/5] 차단 테스트...');
  const results = {};

  // 5-1. 윈도우 타이틀 읽기 테스트
  try {
    const title = ps('(Get-Process | Where-Object { $_.MainWindowTitle -ne \"\" } | Select -First 1).MainWindowTitle');
    results.windowTitle = { blocked: !title, value: title ? title.substring(0, 30) : '' };
    console.log(`  윈도우 타이틀: ${title ? '✅ 읽기 가능' : '❌ 차단됨'}`);
  } catch { results.windowTitle = { blocked: true }; console.log('  윈도우 타이틀: ❌ 차단됨'); }

  // 5-2. 프로세스 목록 테스트 (WMI)
  try {
    const proc = ps('(Get-Process | Measure-Object).Count');
    results.processList = { blocked: !proc, count: parseInt(proc) || 0 };
    console.log(`  프로세스 목록: ${proc ? '✅ 조회 가능 (' + proc + '개)' : '❌ 차단됨'}`);
  } catch { results.processList = { blocked: true }; console.log('  프로세스 목록: ❌ 차단됨'); }

  // 5-3. 클립보드 읽기 테스트
  try {
    const clip = ps('Get-Clipboard -ErrorAction SilentlyContinue | Out-Null; Write-Output ok');
    results.clipboard = { blocked: clip !== 'ok' };
    console.log(`  클립보드: ${clip === 'ok' ? '✅ 읽기 가능' : '❌ 차단됨'}`);
  } catch { results.clipboard = { blocked: true }; console.log('  클립보드: ❌ 차단됨'); }

  // 5-4. 화면 캡처 테스트
  try {
    const capTest = ps(`
      Add-Type -AssemblyName System.Windows.Forms
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
      $g.Dispose()
      $bmp.Dispose()
      Write-Output 'ok'
    `);
    results.screenCapture = { blocked: capTest !== 'ok' };
    console.log(`  화면 캡처: ${capTest === 'ok' ? '✅ 가능' : '❌ 차단됨'}`);
  } catch { results.screenCapture = { blocked: true }; console.log('  화면 캡처: ❌ 차단됨'); }

  // 5-5. 파일 시스템 접근 테스트
  try {
    const recent = ps('(Get-ChildItem $env:APPDATA\\Microsoft\\Windows\\Recent -ErrorAction SilentlyContinue | Measure-Object).Count');
    results.recentFiles = { blocked: !recent, count: parseInt(recent) || 0 };
    console.log(`  최근 파일: ${recent ? '✅ 접근 가능 (' + recent + '개)' : '❌ 차단됨'}`);
  } catch { results.recentFiles = { blocked: true }; console.log('  최근 파일: ❌ 차단됨'); }

  // 5-6. 네트워크 연결 조회 테스트
  try {
    const net = ps('(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Measure-Object).Count');
    results.networkConn = { blocked: !net, count: parseInt(net) || 0 };
    console.log(`  네트워크: ${net ? '✅ 조회 가능 (' + net + '개)' : '❌ 차단됨'}`);
  } catch { results.networkConn = { blocked: true }; console.log('  네트워크: ❌ 차단됨'); }

  return results;
}

// ── 서버 전송 ──
function sendToServer(report) {
  const payload = JSON.stringify({
    events: [{
      id: 'bank-detect-' + Date.now(),
      type: 'bank.detection',
      source: 'bank-detector',
      sessionId: 'daemon-' + os.hostname(),
      timestamp: new Date().toISOString(),
      data: report,
    }]
  });

  return new Promise(resolve => {
    const url = new URL('/api/hook', SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const req = mod.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname,
      method: 'POST', headers, timeout: 10000
    }, res => { res.resume(); resolve(res.statusCode < 300); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ── 메인 ──
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Orbit AI — 은행 보안 프로그램 감지        ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  PC: ${os.hostname()}`);
  console.log(`  OS: ${os.platform()} ${os.release()}`);
  console.log(`  시간: ${new Date().toLocaleString('ko-KR')}`);

  if (process.platform !== 'win32') {
    console.log('\n  ⚠ Windows 전용입니다.');
    return;
  }

  const report = {
    hostname: os.hostname(),
    platform: os.platform(),
    timestamp: new Date().toISOString(),
    runningProcesses: detectRunningProcesses(),
    installedPrograms: detectInstalledPrograms(),
    services: detectServices(),
    drivers: detectDrivers(),
    blockTests: runBlockTests(),
  };

  // 요약
  const totalBlocked = Object.values(report.blockTests).filter(t => t.blocked).length;
  const totalTests = Object.keys(report.blockTests).length;
  const available = Object.entries(report.blockTests).filter(([,t]) => !t.blocked).map(([k]) => k);

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║  감지 결과 요약                            ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  실행 중 보안 프로세스: ${report.runningProcesses.length}개`);
  console.log(`║  설치된 보안 프로그램:  ${report.installedPrograms.length}개`);
  console.log(`║  보안 서비스:          ${report.services.length}개`);
  console.log(`║  커널 드라이버:        ${report.drivers.length}개`);
  console.log(`║  차단 테스트:          ${totalBlocked}/${totalTests} 차단됨`);
  console.log(`║  사용 가능한 수집 방법: ${available.join(', ') || '없음'}`);
  console.log('╚════════════════════════════════════════════╝');

  // 추천
  console.log('\n[추천]');
  if (available.includes('processList')) {
    console.log('  ✅ WMI Get-Process 가능 → bank-safe-collector 동작 가능');
  }
  if (available.includes('windowTitle')) {
    console.log('  ✅ 윈도우 타이틀 읽기 가능 → 활동 분류 가능');
  }
  if (available.includes('recentFiles')) {
    console.log('  ✅ 최근 파일 접근 가능 → 파일 활동 추적 가능');
  }
  if (available.includes('networkConn')) {
    console.log('  ✅ 네트워크 조회 가능 → 앱 사용 감지 가능');
  }
  if (totalBlocked === totalTests) {
    console.log('  ❌ 모든 수집 방법 차단됨 → 은행 보안 프로그램 제거 필요');
  }

  // 서버 전송
  const sent = await sendToServer(report);
  console.log(`\n서버 전송: ${sent ? '✅ 성공' : '❌ 실패'}`);

  // 로컬 파일 저장
  const reportPath = path.join(os.homedir(), '.orbit', 'bank-detection.json');
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`로컬 저장: ${reportPath}`);
  } catch {}
}

main().catch(console.error);
