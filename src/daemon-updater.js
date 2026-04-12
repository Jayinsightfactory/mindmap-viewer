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

    // Bug #2 fix: 토큰을 bat에 하드코딩 fallback + config 파일 동적 읽기
    const hardToken = _token || process.env.ORBIT_TOKEN || '';
    const batContent = `@echo off\r\ncd /d "%USERPROFILE%\\.orbit"\r\nset ORBIT_SERVER_URL=${serverUrl}\r\nset "ORBIT_TOKEN=${hardToken}"\r\n\r\n:: node.exe 경로 탐색\r\nset "NODE_EXE="\r\nwhere node >nul 2>&1 && for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"\r\nif not defined NODE_EXE if exist "${nodeExe}" set "NODE_EXE=${nodeExe}"\r\nif not defined NODE_EXE if exist "C:\\Program Files\\nodejs\\node.exe" set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"\r\nif not defined NODE_EXE if exist "%APPDATA%\\nvm\\current\\node.exe" set "NODE_EXE=%APPDATA%\\nvm\\current\\node.exe"\r\nif not defined NODE_EXE (\r\n  echo [%date% %time%] ERROR: node.exe not found >> "%USERPROFILE%\\.orbit\\daemon.log"\r\n  timeout /t 60 /nobreak >nul\r\n  exit /b 1\r\n)\r\n\r\n:: config 파일에서 토큰 읽기 (있으면 하드코딩 토큰 덮어씀)\r\nfor /f "usebackq tokens=*" %%a in (\`"%NODE_EXE%" -e "try{var t=require('%USERPROFILE%\\\\.orbit-config.json').token;if(t)console.log(t)}catch(e){}"\`) do set ORBIT_TOKEN=%%a\r\n:loop\r\necho [%date% %time%] daemon start (token=%ORBIT_TOKEN:~0,12%...) >> "%USERPROFILE%\\.orbit\\daemon.log"\r\n"%NODE_EXE%" "%USERPROFILE%\\mindmap-viewer\\daemon\\personal-agent.js" >> "%USERPROFILE%\\.orbit\\daemon.log" 2>&1\r\necho [%date% %time%] daemon exit (restart in 10s) >> "%USERPROFILE%\\.orbit\\daemon.log"\r\ntimeout /t 10 /nobreak >nul\r\ngoto loop\r\n`;

    // ~/.orbit 폴더에 bat 저장 (fallback)
    const orbitBat = path.join(orbitDir, 'start-daemon.bat');
    fs.writeFileSync(orbitBat, batContent, { encoding: 'ascii' });

    // ~/.orbit 폴더에 ps1 저장 (PowerShell — CMD 창 번쩍임 완전 방지)
    const ps1Content = `$ErrorActionPreference = 'SilentlyContinue'
Set-Location "$env:USERPROFILE\\.orbit"
$env:ORBIT_SERVER_URL = '${serverUrl}'
$env:ORBIT_TOKEN = '${hardToken}'

# node.exe 경로 탐색
$nodeExe = $null
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $nodeExe = $found.Source }
if (-not $nodeExe -and (Test-Path '${nodeExe.replace(/\\/g, '\\\\')}')) { $nodeExe = '${nodeExe.replace(/\\/g, '\\\\')}' }
if (-not $nodeExe -and (Test-Path 'C:\\Program Files\\nodejs\\node.exe')) { $nodeExe = 'C:\\Program Files\\nodejs\\node.exe' }
if (-not $nodeExe -and (Test-Path "$env:APPDATA\\nvm\\current\\node.exe")) { $nodeExe = "$env:APPDATA\\nvm\\current\\node.exe" }
if (-not $nodeExe) {
  "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] ERROR: node.exe not found" | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  Start-Sleep -Seconds 60; exit 1
}

# config 파일에서 토큰 읽기
try {
  $cfg = Get-Content "$env:USERPROFILE\\.orbit-config.json" -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($cfg.token) { $env:ORBIT_TOKEN = $cfg.token }
} catch {}

# 데몬 루프
while ($true) {
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $tokenPreview = if ($env:ORBIT_TOKEN.Length -gt 12) { $env:ORBIT_TOKEN.Substring(0,12) + '...' } else { $env:ORBIT_TOKEN }
  "[$ts] daemon start (token=$tokenPreview)" | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  & $nodeExe "$env:USERPROFILE\\mindmap-viewer\\daemon\\personal-agent.js" 2>&1 | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  "[$ts] daemon exit (restart in 10s)" | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  Start-Sleep -Seconds 10
}
`;
    const orbitPs1 = path.join(orbitDir, 'start-daemon.ps1');
    fs.writeFileSync(orbitPs1, ps1Content, { encoding: 'utf8' });

    // Task Scheduler 갱신 (primary — VBS보다 안정적, ps1 경로가 같으므로 재등록만 하면 됨)
    if (os.platform() === 'win32') {
      try {
        const ps1Escaped = orbitPs1.replace(/'/g, "''");
        const registerCmd = `powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "` +
          `$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File \\'${ps1Escaped}\\'';` +
          `$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;` +
          `$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable $true;` +
          `Register-ScheduledTask -TaskName OrbitDaemon -Action $a -Trigger $t -Settings $s -Force -RunLevel Highest -ErrorAction SilentlyContinue | Out-Null"`;
        execSync(registerCmd, { timeout: 15000, windowsHide: true, stdio: 'pipe' });
        console.log('[daemon-updater] Task Scheduler 갱신 완료');
        // 기존 VBS 정리 (Task Scheduler 성공 시 불필요)
        const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        ['orbit-daemon.vbs', 'orbit-daemon.bat'].forEach(f => {
          try { const fp = path.join(startupDir, f); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
        });
      } catch (e) {
        console.warn('[daemon-updater] Task Scheduler 갱신 실패, VBS fallback:', e.message);
        // Fallback: Startup 폴더 VBS
        const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        if (fs.existsSync(startupDir)) {
          const vbsContent = `CreateObject("WScript.Shell").Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File ""${orbitPs1}""", 0, False`;
          fs.writeFileSync(path.join(startupDir, 'orbit-daemon.vbs'), vbsContent, { encoding: 'ascii' });
        }
      }
    }

    console.log('[daemon-updater] ps1 재생성 + startup 갱신 완료');
  } catch (e) {
    console.warn('[daemon-updater] bat 재생성 실패:', e.message);
  }
}

// ── git pull + 재시작 ─────────────────────────────────────────────────────────
function pullAndRestart(reason) {
  console.log(`[daemon-updater] 업데이트 시작: ${reason}`);
  reportStatus('update_start', reason);

  try {
    // git fetch + reset --hard (ff-only 실패 / history diverge 상황에서도 강제 업데이트)
    execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    const localVer = getLocalVersion();
    const remoteVer = (() => {
      try { return execSync('git rev-parse origin/main', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8); } catch { return null; }
    })();

    if (remoteVer && localVer === remoteVer) {
      console.log('[daemon-updater] 이미 최신 — 재시작 불필요');
      reportStatus('update_skip', 'Already up to date');
      return false;
    }

    const pullResult = execSync('git reset --hard origin/main', {
      cwd: ROOT, timeout: 15000, windowsHide: true, stdio: 'pipe',
    }).toString().trim();
    console.log(`[daemon-updater] git reset --hard origin/main: ${pullResult}`);

    // npm install (package.json 변경 시)
    try {
      const diffFiles = execSync('git diff HEAD~1 --name-only', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString();
      if (diffFiles.includes('package.json')) {
        console.log('[daemon-updater] package.json 변경 감지 → npm install');
        if (process.platform === 'win32') {
          // PowerShell -WindowStyle Hidden으로 실행 (cmd /c는 창 번쩍임 발생)
          execSync('powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "npm install --production 2>&1 | Out-Null"',
            { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' });
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
  // Windows: start-daemon.ps1 while 루프가 10초 후 자동 재기동 → exit(0)만
  // non-Windows: spawn 후 즉시 exit(0) — spawn 전 exit 지연 없애서 중복 방지
  if (os.platform() !== 'win32') {
    const agentPath = path.join(ROOT, 'daemon', 'personal-agent.js');
    const spawnEnv = { ...process.env };
    if (_token) spawnEnv.ORBIT_TOKEN = _token;
    if (_serverUrl) spawnEnv.ORBIT_SERVER_URL = _serverUrl;
    const child = spawn(process.execPath, [agentPath], {
      cwd: ROOT, detached: true, stdio: 'ignore', env: spawnEnv,
    });
    child.unref();
    // spawn 직후 바로 exit — 500ms 지연 제거 (지연 중 중복 실행 방지)
    process.exit(0);
  } else {
    // Windows: ps1 루프가 재시작하므로 바로 종료
    console.log('[daemon-updater] 재시작: process.exit(0) → ps1 루프 10초 후 재기동');
    process.exit(0);
  }
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
          // Bug #3 fix: 파일 저장 후 메모리 변수도 갱신 (특히 token 변경 시)
          if (merged.token) _token = merged.token;
          if (merged.serverUrl) _serverUrl = merged.serverUrl;
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

    case 'capture-config':
      // 캡처 타이밍 학습 에이전트가 제안한 최적 간격 수신 → capture-config.json 저장
      if (cmd.data) {
        try {
          const orbitDir = path.join(os.homedir(), '.orbit');
          fs.mkdirSync(orbitDir, { recursive: true });
          const cfgPath = path.join(orbitDir, 'capture-config.json');
          const config = {
            byApp:       cmd.data.byApp       || {},
            default:     cmd.data.default     || 60000,
            sampleCount: cmd.data.sampleCount || 0,
            suggestedBy: 'capture-timing-learner',
            updatedAt:   new Date().toISOString(),
          };
          fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
          console.log('[daemon-updater] 캡처 타이밍 업데이트:', JSON.stringify(config.byApp));
          reportStatus('command_executed', `capture-config: default=${config.default}ms apps=${Object.keys(config.byApp).join(',')}`);
        } catch (e) {
          reportStatus('command_fail', `capture-config: ${e.message}`);
        }
      }
      break;

    case 'drive-upload':
      // Drive 업로드 즉시 실행
      try {
        const driveUploader = require(path.join(ROOT, 'src/drive-uploader'));
        if (driveUploader.isEnabled && driveUploader.isEnabled()) {
          driveUploader.uploadPending().then(() => {
            reportStatus('command_executed', 'drive-upload: 완료');
          }).catch(e => reportStatus('command_fail', `drive-upload: ${e.message}`));
        } else {
          console.warn('[daemon-updater] drive-uploader 비활성 상태 — 스킵');
          reportStatus('command_executed', 'drive-upload: uploader not enabled');
        }
      } catch (e) {
        reportStatus('command_fail', `drive-upload: ${e.message}`);
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

// ── Git 직접 비교 (서버 무관) ─────────────────────────────────────────────────
let _serverFailCount = 0;
const SERVER_FAIL_THRESHOLD = 5; // 서버 5회 연속 실패 → git 직접 비교 fallback

function _gitDirectCheck() {
  try {
    execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    const local = execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
    const remote = execSync('git rev-parse origin/main', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
    if (local !== remote) {
      console.log(`[daemon-updater] [git-fallback] 버전 불일치: 로컬=${local} 리모트=${remote}`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[daemon-updater] [git-fallback] fetch 실패:', e.message);
    return false;
  }
}

// ── 메인 체크 루프 ────────────────────────────────────────────────────────────
async function _checkCycle() {
  // 대기 명령은 항상 확인 (1분마다)
  try {
    const commands = await fetchCommands();
    if (commands.length > 0) _serverFailCount = 0; // 서버 통신 성공
    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch {
    _serverFailCount++;
  }

  // 버전 확인은 정해진 시간에만
  if (!_isCheckTime()) return;

  try {
    console.log('[daemon-updater] 정기 업데이트 확인 시작');
    const serverInfo = await checkServerVersion();

    if (serverInfo && serverInfo.version) {
      _serverFailCount = 0; // 서버 통신 성공
      const local = getLocalVersion();
      if (local !== 'unknown' && serverInfo.version !== local) {
        console.log(`[daemon-updater] 버전 불일치: 로컬=${local} 서버=${serverInfo.version}`);
        pullAndRestart(`버전 불일치: ${local} → ${serverInfo.version}`);
        return;
      }
      console.log(`[daemon-updater] 최신 버전 확인됨: ${local}`);
    } else {
      // 서버 응답 없음 → 실패 카운트 증가
      _serverFailCount++;
      console.warn(`[daemon-updater] 서버 응답 없음 (연속 ${_serverFailCount}회)`);

      // 서버 N회 연속 실패 → GitHub에서 직접 비교 (서버 URL 바뀌어도 업데이트 가능)
      if (_serverFailCount >= SERVER_FAIL_THRESHOLD) {
        console.log('[daemon-updater] 서버 장기 미응답 → git 직접 비교 fallback');
        if (_gitDirectCheck()) {
          pullAndRestart('서버 미응답 + git 직접 비교 업데이트');
          return;
        }
      }
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

  // 업데이터 시작

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
