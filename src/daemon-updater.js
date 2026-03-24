'use strict';
/**
 * daemon-updater.js — 데몬 자동 업데이트 + 원격 명령 수신
 *
 * 기능:
 *  1. 서버에서 최신 버전 확인 → 다르면 git pull + 자동 재시작
 *  2. 서버에서 대기 중인 명령 가져와서 실행 (restart, update, config 등)
 *  3. 업데이트 결과를 서버에 보고
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');

// ── 설정 ──────────────────────────────────────────────────────────────────────
// 업데이트 확인 시간: 평일 09:30, 13:00, 15:00, 17:00 (주말 제외)
const CHECK_HOURS = [{ h: 9, m: 30 }, { h: 13, m: 0 }, { h: 15, m: 0 }, { h: 17, m: 0 }];
const CHECK_POLL_INTERVAL = 60 * 1000; // 1분마다 시간 확인 (가벼운 로컬 체크)
let _timer = null;
let _running = false;
let _serverUrl = null;
let _token = null;
let _lastCheckDate = ''; // 'YYYY-MM-DD-HH:mm' 중복 방지

function _loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
    _serverUrl = cfg.serverUrl || process.env.ORBIT_SERVER_URL || null;
    _token = cfg.token || process.env.ORBIT_TOKEN || '';
  } catch {
    _serverUrl = process.env.ORBIT_SERVER_URL || null;
    _token = process.env.ORBIT_TOKEN || '';
  }
}

// ── 현재 로컬 커밋 해시 ───────────────────────────────────────────────────────
function getLocalVersion() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
  } catch { return 'unknown'; }
}

// ── 서버에 버전 확인 요청 ─────────────────────────────────────────────────────
function checkServerVersion() {
  return new Promise((resolve) => {
    if (!_serverUrl) return resolve(null);
    try {
      const url = new URL('/api/daemon/version', _serverUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {};
      if (_token) headers['Authorization'] = 'Bearer ' + _token;
      const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, headers, timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ── 서버에서 대기 명령 가져오기 ────────────────────────────────────────────────
function fetchCommands() {
  return new Promise((resolve) => {
    if (!_serverUrl) return resolve([]);
    try {
      const hostname = os.hostname();
      const url = new URL(`/api/daemon/commands?hostname=${encodeURIComponent(hostname)}`, _serverUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {};
      if (_token) headers['Authorization'] = 'Bearer ' + _token;
      const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, headers, timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.commands || []);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    } catch { resolve([]); }
  });
}

// ── 서버에 상태 보고 ──────────────────────────────────────────────────────────
function reportStatus(status, detail) {
  if (!_serverUrl) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id: 'updater-' + Date.now(),
        type: 'daemon.update',
        source: 'daemon-updater',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          status,  // 'update_start', 'update_success', 'update_fail', 'command_executed'
          detail,
          hostname: os.hostname(),
          platform: os.platform(),
          version: getLocalVersion(),
          nodeVersion: process.version,
        },
      }],
    });
    const url = new URL('/api/hook', _serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, r => r.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── Windows bat 파일 재생성 (node 경로 탐색 포함) ─────────────────────────────
function _regenerateBatFile() {
  if (process.platform !== 'win32') return;
  try {
    const orbitDir = path.join(os.homedir(), '.orbit');
    const logFile = path.join(orbitDir, 'daemon.log');
    const daemonScript = path.join(ROOT, 'daemon', 'personal-agent.js');
    const serverUrl = _serverUrl || process.env.ORBIT_SERVER_URL || '';
    const nodeExe = process.execPath; // 현재 실행 중인 node 경로

    const batContent = `@echo off\r\ncd /d "%USERPROFILE%\\.orbit"\r\nset ORBIT_SERVER_URL=${serverUrl}\r\n\r\n:: node.exe 경로 탐색\r\nset "NODE_EXE="\r\nwhere node >nul 2>&1 && for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"\r\nif not defined NODE_EXE if exist "${nodeExe}" set "NODE_EXE=${nodeExe}"\r\nif not defined NODE_EXE if exist "C:\\Program Files\\nodejs\\node.exe" set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"\r\nif not defined NODE_EXE if exist "%APPDATA%\\nvm\\current\\node.exe" set "NODE_EXE=%APPDATA%\\nvm\\current\\node.exe"\r\nif not defined NODE_EXE (\r\n  echo [%date% %time%] ERROR: node.exe not found >> "%USERPROFILE%\\.orbit\\daemon.log"\r\n  timeout /t 60 /nobreak >nul\r\n  exit /b 1\r\n)\r\n\r\nfor /f "usebackq tokens=*" %%a in (\`"%NODE_EXE%" -e "try{console.log(require('%USERPROFILE%\\\\.orbit-config.json').token||'')}catch(e){console.log('')}"\`) do set ORBIT_TOKEN=%%a\r\n:loop\r\necho [%date% %time%] daemon start >> "%USERPROFILE%\\.orbit\\daemon.log"\r\n"%NODE_EXE%" "%USERPROFILE%\\mindmap-viewer\\daemon\\personal-agent.js" >> "%USERPROFILE%\\.orbit\\daemon.log" 2>&1\r\necho [%date% %time%] daemon exit (restart in 10s) >> "%USERPROFILE%\\.orbit\\daemon.log"\r\ntimeout /t 10 /nobreak >nul\r\ngoto loop\r\n`;

    // ~/.orbit 폴더에 bat 저장
    const orbitBat = path.join(orbitDir, 'start-daemon.bat');
    fs.writeFileSync(orbitBat, batContent, { encoding: 'ascii' });

    // Startup 폴더에 VBS 래퍼 (cmd 창 숨김)
    const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (fs.existsSync(startupDir)) {
      const vbsContent = `CreateObject("WScript.Shell").Run "cmd /c ""${orbitBat}""", 0, False`;
      fs.writeFileSync(path.join(startupDir, 'orbit-daemon.vbs'), vbsContent, { encoding: 'ascii' });
      // 구버전 bat 정리
      const oldBat = path.join(startupDir, 'orbit-daemon.bat');
      try { if (fs.existsSync(oldBat)) fs.unlinkSync(oldBat); } catch {}
    }

    console.log('[daemon-updater] bat+vbs 파일 재생성 완료 (cmd 창 숨김)');
  } catch (e) {
    console.warn('[daemon-updater] bat 재생성 실패:', e.message);
  }
}

// ── git pull + 재시작 ─────────────────────────────────────────────────────────
function pullAndRestart(reason) {
  console.log(`[daemon-updater] 업데이트 시작: ${reason}`);
  reportStatus('update_start', reason);

  try {
    // git reset + pull (로컬 변경사항이 있어도 강제 업데이트)
    try { execSync('git reset --hard HEAD', { cwd: ROOT, timeout: 10000, windowsHide: true, stdio: 'pipe' }); } catch {}
    const pullResult = execSync('git pull origin main --ff-only', {
      cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe',
    }).toString().trim();
    console.log(`[daemon-updater] git pull: ${pullResult}`);

    if (pullResult.includes('Already up to date')) {
      console.log('[daemon-updater] 이미 최신 — 재시작 불필요');
      reportStatus('update_skip', 'Already up to date');
      return false;
    }

    // npm install (package.json 변경 시)
    try {
      const diffFiles = execSync('git diff HEAD~1 --name-only', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString();
      if (diffFiles.includes('package.json')) {
        console.log('[daemon-updater] package.json 변경 감지 → npm install');
        if (process.platform === 'win32') {
          execSync('cmd /c "npm install --production"', { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' });
        } else {
          execSync('npm install --production', { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' });
        }
      }
    } catch (e) {
      console.warn('[daemon-updater] npm install 실패:', e.message);
    }

    reportStatus('update_success', pullResult);

    // Windows bat 파일 재생성 (node 경로 탐색 로직 반영)
    _regenerateBatFile();

    // 자기 자신 재시작
    console.log('[daemon-updater] 3초 후 재시작...');
    setTimeout(() => {
      _restartSelf();
    }, 3000);

    return true;
  } catch (e) {
    console.error('[daemon-updater] 업데이트 실패:', e.message);
    reportStatus('update_fail', e.message);
    return false;
  }
}

// ── 자기 자신 재시작 ──────────────────────────────────────────────────────────
function _restartSelf() {
  const agentPath = path.join(ROOT, 'daemon', 'personal-agent.js');
  console.log('[daemon-updater] 재시작:', agentPath);

  // 새 프로세스 생성 (detached — 부모 종료돼도 살아남음)
  const child = spawn(process.execPath, [agentPath], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // 현재 프로세스 종료
  setTimeout(() => process.exit(0), 500);
}

// ── 명령 실행 ─────────────────────────────────────────────────────────────────
async function executeCommand(cmd) {
  console.log(`[daemon-updater] 명령 수신: ${cmd.action}`);

  switch (cmd.action) {
    case 'update':
      pullAndRestart('원격 명령: update');
      break;

    case 'restart':
      reportStatus('command_executed', 'restart');
      setTimeout(() => _restartSelf(), 1000);
      break;

    case 'config':
      // 설정 변경 (분석 주기, 캡처 설정 등)
      if (cmd.data) {
        try {
          const cfgPath = path.join(os.homedir(), '.orbit-config.json');
          const existing = (() => {
            try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; }
          })();
          const merged = { ...existing, ...cmd.data };
          fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2), 'utf8');
          console.log('[daemon-updater] 설정 업데이트:', Object.keys(cmd.data).join(', '));
          reportStatus('command_executed', `config: ${Object.keys(cmd.data).join(', ')}`);
        } catch (e) {
          reportStatus('command_fail', `config: ${e.message}`);
        }
      }
      break;

    case 'exec':
      // 임의 명령 실행 (관리자 전용 + auto-fixer 자동 수정)
      if (cmd.command) {
        try {
          let execCmd = cmd.command;
          // PowerShell 명령 감지: $env:, Test-Path, Get-Command 등
          if (process.platform === 'win32' && /\$env:|Test-Path|Get-Command|Write-Host|\bwinget\b|Set-ItemProperty|Add-MpPreference/i.test(execCmd)) {
            execCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${execCmd.replace(/"/g, '\\"')}"`;
          }
          const out = execSync(execCmd, { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' }).toString().trim();
          console.log(`[daemon-updater] exec 결과: ${out.slice(0, 200)}`);
          reportStatus(cmd._autoFix ? 'auto_fix_success' : 'command_executed',
            `${cmd._patternId || 'exec'}: ${out.slice(0, 200)}`);
        } catch (e) {
          console.error(`[daemon-updater] exec 실패: ${e.message.slice(0, 200)}`);
          reportStatus(cmd._autoFix ? 'auto_fix_fail' : 'command_fail',
            `${cmd._patternId || 'exec'}: ${e.message.slice(0, 200)}`);
        }
      }
      break;

    default:
      console.warn(`[daemon-updater] 알 수 없는 명령: ${cmd.action}`);
  }
}

// ── 시간 체크 (평일 09:30, 13:00만 실행) ──────────────────────────────────────
function _isCheckTime() {
  const now = new Date();
  const day = now.getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false; // 주말 제외

  const h = now.getHours();
  const m = now.getMinutes();
  const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

  for (const slot of CHECK_HOURS) {
    // 지정 시간의 ±2분 범위 내
    const diff = (h * 60 + m) - (slot.h * 60 + slot.m);
    if (diff >= 0 && diff <= 2) {
      const key = `${dateKey}-${slot.h}:${slot.m}`;
      if (_lastCheckDate === key) return false; // 이미 이 슬롯 실행함
      _lastCheckDate = key;
      return true;
    }
  }
  return false;
}

// ── 메인 체크 루프 ────────────────────────────────────────────────────────────
async function _checkCycle() {
  // 대기 명령은 항상 확인 (1분마다)
  try {
    const commands = await fetchCommands();
    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch {}

  // 버전 확인은 정해진 시간에만
  if (!_isCheckTime()) return;

  try {
    console.log('[daemon-updater] 정기 업데이트 확인 시작');
    const serverInfo = await checkServerVersion();
    if (serverInfo && serverInfo.version) {
      const local = getLocalVersion();
      if (local !== 'unknown' && serverInfo.version !== local) {
        console.log(`[daemon-updater] 버전 불일치: 로컬=${local} 서버=${serverInfo.version}`);
        pullAndRestart(`버전 불일치: ${local} → ${serverInfo.version}`);
        return;
      }
      console.log(`[daemon-updater] 최신 버전 확인됨: ${local}`);
    }
  } catch (e) {
    console.warn('[daemon-updater] 체크 사이클 오류:', e.message);
  }
}

// ── 시작/중지 ──────────────────────────────────────────────────────────────────
function start() {
  if (_running) return;
  _running = true;
  _loadConfig();

  console.log(`[daemon-updater] 시작 (평일 09:30/13:00/15:00/17:00 업데이트, 명령 1분 폴링, 버전: ${getLocalVersion()})`);

  // 첫 체크는 30초 후 (데몬 안정화 대기)
  setTimeout(() => {
    _checkCycle();
    _timer = setInterval(_checkCycle, CHECK_POLL_INTERVAL);
  }, 30000);
}

function stop() {
  _running = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, getLocalVersion, pullAndRestart, checkServerVersion, reportStatus };
