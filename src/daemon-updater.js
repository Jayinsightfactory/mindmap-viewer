'use strict';
/**
 * daemon-updater.js - daemon auto-update + remote commands
 *
 * Features:
 *  1. Server version check -> git pull + auto-restart if different
 *  2. Fetch pending commands from server (restart, update, config, etc.)
 *  3. Report update status to server
 *  4. Idle-aware updates with toast notifications (Part 2)
 *  5. Multi-fallback update chain (Part 2)
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');

// -- Canonical values (embedded in code -> auto-updated via git pull)
const CANONICAL_SERVER_URL = 'https://mindmap-viewer-production-adb2.up.railway.app';
const CANONICAL_GIT_REPO   = 'https://github.com/Jayinsightfactory/mindmap-viewer.git';

// -- Settings
const CHECK_POLL_INTERVAL = 60 * 1000; // 1min command poll
const GIT_CHECK_INTERVAL  = 60 * 60 * 1000; // 1hr version check
const IDLE_THRESHOLD_MS   = 5 * 60 * 1000; // 5min idle
const MAX_IDLE_WAIT_MS    = 30 * 60 * 1000; // 30min max wait then force

let _timer = null;
let _gitCheckTimer = null;
let _running = false;
let _serverUrl = null;
let _token = null;
let _lastCheckDate = '';
let _pendingUpdate = null; // { reason, since } - queued update waiting for idle

function _loadConfig() {
  try {
    let _raw = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8');
    if (_raw.charCodeAt(0) === 0xFEFF) _raw = _raw.slice(1);
    const cfg = JSON.parse(_raw.trim());
    _serverUrl = cfg.serverUrl || process.env.ORBIT_SERVER_URL || null;
    _token = cfg.token || process.env.ORBIT_TOKEN || '';
  } catch {
    _serverUrl = process.env.ORBIT_SERVER_URL || null;
    _token = process.env.ORBIT_TOKEN || '';
  }
}

// -- Self-repair #1: Git remote URL
function _repairGitRemote() {
  try {
    const currentUrl = execSync('git remote get-url origin', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim();
    if (currentUrl !== CANONICAL_GIT_REPO) {
      console.log(`[daemon-updater] git remote repair: ${currentUrl} -> ${CANONICAL_GIT_REPO}`);
      execSync(`git remote set-url origin "${CANONICAL_GIT_REPO}"`, { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' });
      return true;
    }
  } catch (e) {
    console.warn('[daemon-updater] git remote repair failed:', e.message);
  }
  return false;
}

// -- Self-repair #2: config serverUrl
function _repairConfigServerUrl() {
  try {
    const cfgPath = path.join(os.homedir(), '.orbit-config.json');
    let raw = '';
    try { raw = fs.readFileSync(cfgPath, 'utf8'); } catch { return false; }
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(raw.trim()); } catch { return false; }

    if (cfg.serverUrl !== CANONICAL_SERVER_URL) {
      const oldUrl = cfg.serverUrl || '(none)';
      cfg.serverUrl = CANONICAL_SERVER_URL;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      _serverUrl = CANONICAL_SERVER_URL;
      console.log(`[daemon-updater] config serverUrl repair: ${oldUrl} -> ${CANONICAL_SERVER_URL}`);
      return true;
    }
  } catch (e) {
    console.warn('[daemon-updater] config repair failed:', e.message);
  }
  return false;
}

function getLocalVersion() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
  } catch { return 'unknown'; }
}

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
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function fetchCommands() {
  return new Promise((resolve) => {
    if (!_serverUrl) return resolve([]);
    try {
      const hostname = encodeURIComponent(os.hostname());
      const url = new URL(`/api/daemon/commands?hostname=${hostname}`, _serverUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {};
      if (_token) headers['Authorization'] = 'Bearer ' + _token;
      const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, headers, timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data).commands || []); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    } catch { resolve([]); }
  });
}

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
        data: { status, detail, hostname: os.hostname(), platform: os.platform(), version: getLocalVersion() },
      }],
    });
    const url = new URL('/api/hook', _serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      'X-Device-Id': encodeURIComponent(os.hostname()) };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, r => r.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// -- Toast notification (Windows system tray)
function _showToast(title, message) {
  if (os.platform() !== 'win32') return;
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
      `$n=New-Object System.Windows.Forms.NotifyIcon;` +
      `$n.Icon=[System.Drawing.SystemIcons]::Information;` +
      `$n.BalloonTipTitle='${title.replace(/'/g, "''")}';` +
      `$n.BalloonTipText='${message.replace(/'/g, "''")}';` +
      `$n.Visible=$true;$n.ShowBalloonTip(5000);` +
      `Start-Sleep -Seconds 6;$n.Dispose()`;
    spawn('powershell.exe', ['-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch {}
}

// -- Idle check (uses personal-agent's isIdle or fallback)
function _isIdle() {
  try {
    const pa = require(path.join(ROOT, 'daemon', 'personal-agent.js'));
    if (typeof pa.isIdle === 'function') return pa.isIdle(IDLE_THRESHOLD_MS);
  } catch {}
  // Fallback: always consider idle (for update purposes)
  return true;
}

// -- Regenerate bat/ps1 files
function _regenerateBatFile() {
  if (process.platform !== 'win32') return;
  try {
    const orbitDir = path.join(os.homedir(), '.orbit');
    const serverUrl = _serverUrl || process.env.ORBIT_SERVER_URL || '';
    const nodeExe = process.execPath;
    const hardToken = _token || process.env.ORBIT_TOKEN || '';

    const ps1Content = `$ErrorActionPreference = 'SilentlyContinue'
Set-Location "$env:USERPROFILE\\.orbit"
$env:ORBIT_SERVER_URL = '${serverUrl}'
$env:ORBIT_TOKEN = '${hardToken}'
$env:ORBIT_SAFE_MODE = '1'
$nodeExe = $null
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $nodeExe = $found.Source }
if (-not $nodeExe -and (Test-Path '${nodeExe.replace(/\\/g, '\\\\')}')) { $nodeExe = '${nodeExe.replace(/\\/g, '\\\\')}' }
if (-not $nodeExe -and (Test-Path 'C:\\Program Files\\nodejs\\node.exe')) { $nodeExe = 'C:\\Program Files\\nodejs\\node.exe' }
if (-not $nodeExe) { exit 1 }
try { $cfg = Get-Content "$env:USERPROFILE\\.orbit-config.json" -Raw | ConvertFrom-Json; if ($cfg.token) { $env:ORBIT_TOKEN = $cfg.token } } catch {}
while ($true) {
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[$ts] daemon start" | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  & $nodeExe "$env:USERPROFILE\\mindmap-viewer\\daemon\\personal-agent.js" 2>&1 | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  "[$ts] daemon exit (restart in 10s)" | Add-Content "$env:USERPROFILE\\.orbit\\daemon.log"
  Start-Sleep -Seconds 10
}`;
    const orbitPs1 = path.join(orbitDir, 'start-daemon.ps1');
    fs.writeFileSync(orbitPs1, ps1Content, { encoding: 'utf8' });

    // Update Task Scheduler
    try {
      const ps1Escaped = orbitPs1.replace(/'/g, "''");
      execSync(`schtasks /create /tn OrbitDaemon /tr "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File '${ps1Escaped}'" /sc onlogon /rl limited /f`,
        { timeout: 15000, windowsHide: true, stdio: 'pipe' });
    } catch {}

    // Clean old startup files
    const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    ['orbit-daemon.vbs', 'orbit-daemon.bat'].forEach(f => {
      try { const fp = path.join(startupDir, f); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    });
  } catch (e) {
    console.warn('[daemon-updater] ps1 regen failed:', e.message);
  }
}

// == PART 2: Multi-fallback update chain ==
// Step 1: git fetch + reset --hard
// Step 2: repair remote + retry
// Step 3: rm + clone (full re-download)
// Step 4: irm install.ps1 (re-install)
function pullAndRestart(reason) {
  console.log(`[daemon-updater] update start: ${reason}`);
  reportStatus('update_start', reason);
  _showToast('Orbit AI', 'Updating...');

  // Step 1: normal git fetch + reset
  try {
    execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    const localVer = getLocalVersion();
    const remoteVer = (() => {
      try { return execSync('git rev-parse origin/main', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8); } catch { return null; }
    })();
    if (remoteVer && localVer === remoteVer) {
      console.log('[daemon-updater] already up to date');
      reportStatus('update_skip', 'Already up to date');
      return false;
    }
    execSync('git reset --hard origin/main', { cwd: ROOT, timeout: 15000, windowsHide: true, stdio: 'pipe' });
    return _postUpdate('step1: git reset');
  } catch (e1) {
    console.warn('[daemon-updater] step1 failed:', e1.message);
  }

  // Step 2: repair remote + retry
  try {
    _repairGitRemote();
    execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    execSync('git reset --hard origin/main', { cwd: ROOT, timeout: 15000, windowsHide: true, stdio: 'pipe' });
    return _postUpdate('step2: remote repair + reset');
  } catch (e2) {
    console.warn('[daemon-updater] step2 failed:', e2.message);
  }

  // Step 3: full re-clone
  try {
    const backupDir = ROOT + '-backup-' + Date.now();
    fs.renameSync(ROOT, backupDir);
    execSync(`git clone "${CANONICAL_GIT_REPO}" "${ROOT}"`, { timeout: 60000, windowsHide: true, stdio: 'pipe' });
    // Copy node_modules from backup
    const nmSrc = path.join(backupDir, 'node_modules');
    if (fs.existsSync(nmSrc)) {
      try { fs.renameSync(nmSrc, path.join(ROOT, 'node_modules')); } catch {}
    }
    // Clean backup after success
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    return _postUpdate('step3: full re-clone');
  } catch (e3) {
    console.warn('[daemon-updater] step3 failed:', e3.message);
    reportStatus('update_fail', `all steps failed: ${e3.message}`);
    return false;
  }
}

function _postUpdate(step) {
  // npm install if package.json changed
  try {
    const diffFiles = execSync('git diff HEAD~1 --name-only', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString();
    if (diffFiles.includes('package.json')) {
      if (process.platform === 'win32') {
        spawn('powershell.exe', ['-WindowStyle', 'Hidden', '-Command', `cd '${ROOT}'; npm install --production 2>&1 | Out-Null`], {
          detached: true, stdio: 'ignore', windowsHide: true,
        }).unref();
      } else {
        execSync('npm install --production', { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' });
      }
    }
  } catch {}

  _repairConfigServerUrl();
  _loadConfig();
  reportStatus('update_success', step);
  _regenerateBatFile();
  _showToast('Orbit AI', 'Update complete. Restarting...');

  setTimeout(() => {
    if (os.platform() === 'win32') {
      process.exit(0); // ps1 loop restarts
    } else {
      const child = spawn(process.execPath, [path.join(ROOT, 'daemon', 'personal-agent.js')], {
        cwd: ROOT, detached: true, stdio: 'ignore',
      });
      child.unref();
      process.exit(0);
    }
  }, 3000);
  return true;
}

// -- Command execution
async function executeCommand(cmd) {
  switch (cmd.action) {
    case 'update':
      // Queue update - wait for idle
      _pendingUpdate = { reason: 'server command: update', since: Date.now() };
      console.log('[daemon-updater] update queued, waiting for idle...');
      break;

    case 'restart':
      reportStatus('command_executed', 'restart');
      setTimeout(() => process.exit(0), 1000); // ps1 loop restarts
      break;

    case 'config':
      if (cmd.data) {
        try {
          const cfgPath = path.join(os.homedir(), '.orbit-config.json');
          let existing = {};
          try {
            let raw = fs.readFileSync(cfgPath, 'utf8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            existing = JSON.parse(raw.trim());
          } catch {}
          const merged = { ...existing, ...cmd.data };
          fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2), 'utf8');
          if (merged.token) _token = merged.token;
          if (merged.serverUrl) _serverUrl = merged.serverUrl;
          reportStatus('command_executed', `config: ${Object.keys(cmd.data).join(', ')}`);
        } catch (e) {
          reportStatus('command_fail', `config: ${e.message}`);
        }
      }
      break;

    case 'exec':
      if (cmd.command) {
        try {
          let execCmd = cmd.command;
          if (process.platform === 'win32' && /\$env:|Test-Path|Get-Command/i.test(execCmd)) {
            execCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${execCmd.replace(/"/g, '\\"')}"`;
          }
          const out = execSync(execCmd, { cwd: ROOT, timeout: 60000, windowsHide: true, stdio: 'pipe' }).toString().trim();
          reportStatus('command_executed', `exec: ${out.slice(0, 200)}`);
        } catch (e) {
          reportStatus('command_fail', `exec: ${e.message.slice(0, 200)}`);
        }
      }
      break;

    case 'capture-config':
      if (cmd.data) {
        try {
          const orbitDir = path.join(os.homedir(), '.orbit');
          fs.mkdirSync(orbitDir, { recursive: true });
          const cfgPath = path.join(orbitDir, 'capture-config.json');
          fs.writeFileSync(cfgPath, JSON.stringify({
            byApp: cmd.data.byApp || {}, default: cmd.data.default || 60000,
            sampleCount: cmd.data.sampleCount || 0, suggestedBy: 'capture-timing-learner',
            updatedAt: new Date().toISOString(),
          }, null, 2), 'utf8');
          reportStatus('command_executed', `capture-config updated`);
        } catch (e) {
          reportStatus('command_fail', `capture-config: ${e.message}`);
        }
      }
      break;

    case 'drive-upload':
      try {
        const driveUploader = require(path.join(ROOT, 'src/drive-uploader'));
        if (driveUploader.isEnabled && driveUploader.isEnabled()) {
          driveUploader.uploadPending().then(() => reportStatus('command_executed', 'drive-upload done'))
            .catch(e => reportStatus('command_fail', `drive-upload: ${e.message}`));
        }
      } catch (e) {
        reportStatus('command_fail', `drive-upload: ${e.message}`);
      }
      break;

    default:
      console.warn(`[daemon-updater] unknown command: ${cmd.action}`);
  }
}

// -- Git direct check (server-independent)
let _serverFailCount = 0;
const SERVER_FAIL_THRESHOLD = 5;

function _gitDirectCheck() {
  try {
    try {
      execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    } catch {
      _repairGitRemote();
      execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    }
    const local = execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
    const remote = execSync('git rev-parse origin/main', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8);
    if (local !== remote) {
      console.log(`[daemon-updater] git mismatch: local=${local} remote=${remote}`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[daemon-updater] git check failed:', e.message);
    return false;
  }
}

// -- Main check cycle (1min interval)
async function _checkCycle() {
  // 1) Fetch + execute pending commands
  try {
    const commands = await fetchCommands();
    if (commands.length > 0) _serverFailCount = 0;
    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch {
    _serverFailCount++;
  }

  // 2) Process pending update (idle-aware)
  if (_pendingUpdate) {
    const elapsed = Date.now() - _pendingUpdate.since;
    if (_isIdle() || elapsed > MAX_IDLE_WAIT_MS) {
      const reason = _pendingUpdate.reason + (elapsed > MAX_IDLE_WAIT_MS ? ' (forced after 30min)' : ' (idle)');
      _pendingUpdate = null;
      pullAndRestart(reason);
      return;
    }
  }
}

// -- Periodic git check (1hr interval, independent of server)
function _periodicGitCheck() {
  try {
    if (_gitDirectCheck()) {
      // Queue update, wait for idle
      _pendingUpdate = { reason: 'periodic git check: version mismatch', since: Date.now() };
      console.log('[daemon-updater] version mismatch detected, update queued');
    }
  } catch {}
}

// -- start-daemon.ps1 / watchdog.ps1 의 Add-Content 를 Out-File -Append 로 자동 교체
// + schtasks를 VBS 래퍼로 변경 (cmd창 깜빡임 제거)
// (구버전 install.ps1로 설치된 PC 원격 fix)
function _repairStartDaemonPs1() {
  if (process.platform !== 'win32') return;
  try {
    const orbitDir = path.join(os.homedir(), '.orbit');
    const targets = ['start-daemon.ps1', 'watchdog.ps1'];
    let repaired = 0;
    for (const t of targets) {
      const p = path.join(orbitDir, t);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw.includes('Add-Content')) continue;
      const fixed = raw.replace(/Add-Content/g, 'Out-File -Append -Encoding utf8 -FilePath');
      fs.writeFileSync(p, fixed, 'utf8');
      repaired++;
    }

    // VBS 래퍼 파일 생성
    const vbsPath = path.join(orbitDir, 'orbit-hidden.vbs');
    const vbsBody = `Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count > 0 Then
  sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & args(0) & """", 0, False
End If
`;
    try { fs.writeFileSync(vbsPath, vbsBody, 'utf8'); } catch {}

    // OrbitWatchdog 미등록 PC 자동 등록 (구버전 설치 PC 원격 fix)
    try {
      execSync('schtasks /query /tn OrbitWatchdog', { timeout: 5000, windowsHide: true, stdio: 'pipe' });
    } catch {
      // OrbitWatchdog 없음 → 등록
      const wdPath = path.join(orbitDir, 'watchdog.ps1');
      if (fs.existsSync(wdPath) && fs.existsSync(vbsPath)) {
        try {
          execSync(
            `schtasks /create /tn "OrbitWatchdog" /tr "wscript.exe \\"${vbsPath}\\" \\"${wdPath}\\"" /sc minute /mo 5 /rl limited /f`,
            { timeout: 10000, windowsHide: true, stdio: 'pipe' }
          );
          console.log('[daemon-updater] OrbitWatchdog registered (was missing on this PC)');
        } catch (e2) {
          console.warn('[daemon-updater] OrbitWatchdog register failed:', e2.message);
        }
      }
    }

    if (repaired > 0) {
      console.log(`[daemon-updater] repaired ${repaired} ps1 file(s) with Out-File -Append`);
      try {
        execSync(
          `powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \\"Name='powershell.exe'\\" | Where-Object {$_.CommandLine -match 'start-daemon|watchdog'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -EA 0}"`,
          { timeout: 10000, windowsHide: true, stdio: 'pipe' }
        );
      } catch {}
    }

    // ── .safe-mode 플래그 파일 생성: uiohook native crash 루프 완전 차단 ──────
    // 파일 기반 플래그 → env var 방식과 달리 이미 실행 중인 ps1 루프도 커버
    // keyboard-watcher가 매 시작 시 이 파일 존재 여부 체크 → uiohook 완전 스킵
    // 이 함수는 daemon startup 1~2초 내 실행 → native crash(~22s) 전에 완료
    const safeModeFlag = path.join(orbitDir, '.safe-mode');
    if (!fs.existsSync(safeModeFlag)) {
      try {
        fs.writeFileSync(safeModeFlag, new Date().toISOString() + '\n', 'utf8');
        console.log('[daemon-updater] ✅ .safe-mode 플래그 생성 — keyboard-watcher uiohook 완전 스킵 (crash 루프 차단)');
      } catch (eSafe) {
        console.warn('[daemon-updater] .safe-mode 생성 실패:', eSafe.message);
      }
    }

    // ── start-daemon.ps1 ORBIT_SAFE_MODE=1 주입 (신규 ps1 루프용 추가 방어) ───
    const ps1SafePath = path.join(orbitDir, 'start-daemon.ps1');
    if (fs.existsSync(ps1SafePath)) {
      try {
        let ps1Txt = fs.readFileSync(ps1SafePath, 'utf8');
        if (!ps1Txt.includes('ORBIT_SAFE_MODE')) {
          const tokenMatch = ps1Txt.match(/(\$env:ORBIT_TOKEN\s*=\s*'[^']*')/);
          if (tokenMatch) {
            ps1Txt = ps1Txt.replace(tokenMatch[1], tokenMatch[1] + "\r\n$env:ORBIT_SAFE_MODE = '1'");
          } else {
            ps1Txt = ps1Txt.replace(/^(Set-Location[^\r\n]*[\r\n]+)/m, "$1\$env:ORBIT_SAFE_MODE = '1'\r\n");
          }
          if (ps1Txt.includes('ORBIT_SAFE_MODE')) {
            fs.writeFileSync(ps1SafePath, ps1Txt, 'utf8');
            console.log('[daemon-updater] start-daemon.ps1 ORBIT_SAFE_MODE=1 주입 완료');
          }
        }
      } catch (eSafe) {
        console.warn('[daemon-updater] ORBIT_SAFE_MODE 주입 실패:', eSafe.message);
      }
    }
  } catch (e) {
    console.warn('[daemon-updater] _repairStartDaemonPs1 warn:', e.message);
  }
}

// -- Start/Stop
function start() {
  if (_running) return;
  _running = true;
  _loadConfig();

  // ── CRITICAL: .safe-mode 즉시 생성 (start() 첫 번째 동작) ──────────────
  // keyboard-watcher.start()는 이 함수 반환 후에 호출됨 (personal-agent.js 순서)
  // uiohook-napi native crash(~22s)가 발생하기 수십 초 전에 이미 생성 완료
  // 파일 기반 → 이미 실행 중인 ps1 while 루프의 다음 재시작에도 적용됨
  if (process.platform === 'win32') {
    try {
      const _smDir  = path.join(os.homedir(), '.orbit');
      const _smFlag = path.join(_smDir, '.safe-mode');
      if (!fs.existsSync(_smFlag)) {
        fs.mkdirSync(_smDir, { recursive: true });
        fs.writeFileSync(_smFlag, new Date().toISOString() + '\n', 'utf8');
        console.log('[daemon-updater] ✅ .safe-mode 즉시 생성 (start 최우선) — uiohook 완전 차단');
      }
    } catch (_smE) {
      console.warn('[daemon-updater] .safe-mode 즉시 생성 실패:', _smE.message);
    }
  }

  _repairGitRemote();
  _repairConfigServerUrl();
  _loadConfig();

  // ── 동기 버전 체크 + 즉시 git pull (keyboard-watcher 로드 전 실행 — crash 중단 불가) ─
  // 문제: 비동기 pullAndRestart()는 uiohook SIGSEGV(~22s)에 의해 중단될 수 있음
  // 해결: start() 내 동기 실행 → keyboardWatcher.start() 전에 완료 보장
  if (process.platform === 'win32') {
    try {
      // PowerShell로 서버 버전 동기 조회 (15s timeout)
      const _svrUrl = (_serverUrl || CANONICAL_SERVER_URL) + '/api/daemon/version';
      const _svHash = (() => {
        try {
          const _out = execSync(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "(Invoke-WebRequest -Uri '${_svrUrl}' -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop).Content"`,
            { timeout: 15000, windowsHide: true, stdio: 'pipe' }
          ).toString().trim();
          return JSON.parse(_out).version || null;
        } catch { return null; }
      })();
      const _lcHash = (() => {
        try { return execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true, stdio: 'pipe' }).toString().trim().slice(0, 8); } catch { return null; }
      })();
      if (_svHash && _lcHash && _svHash !== _lcHash) {
        console.log(`[daemon-updater] 동기 버전 불일치: ${_lcHash} -> ${_svHash} → 즉시 git pull (crash 전)`);
        try {
          execSync('git fetch origin', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'pipe' });
          execSync('git reset --hard origin/main', { cwd: ROOT, timeout: 15000, windowsHide: true, stdio: 'pipe' });
          console.log('[daemon-updater] ✅ 동기 git pull 완료 → 재시작');
          setTimeout(() => process.exit(0), 1000);
          return; // start() 종료 — 재시작 대기 중
        } catch (_gitE) {
          console.warn('[daemon-updater] 동기 git pull 실패 (비동기 fallback 사용):', _gitE.message);
        }
      } else if (_svHash && _lcHash) {
        console.log(`[daemon-updater] 동기 버전 체크: 최신 (${_lcHash})`);
      }
    } catch (_syncE) {
      console.warn('[daemon-updater] 동기 버전 체크 오류:', _syncE.message);
    }
  }

  // ── v8 install 버전 마커 확인 — 없으면 local install.ps1 자동 실행 ──
  // 월요일 PC 켜질 때 이재만/강명훈 PC가 자동으로 v8 재설치되도록 하는 메커니즘
  // install.ps1은 local 파일 실행 → remote download 없음 → AV 친화
  if (process.platform === 'win32') {
    try {
      const _verFile = path.join(os.homedir(), '.orbit', 'install-version.txt');
      let _currVer = '';
      try { _currVer = fs.readFileSync(_verFile, 'utf8').trim(); } catch {}
      const _needsInstall = (_currVer !== 'v8');
      const _installPs1 = path.join(ROOT, 'setup', 'install.ps1');
      if (_needsInstall && fs.existsSync(_installPs1)) {
        console.log(`[daemon-updater] v8 install 마커 없음 (current="${_currVer}") → local install.ps1 자동 실행`);
        try {
          // detach spawn — install.ps1의 Step 0에서 현재 node.exe 프로세스 kill할 것
          const _child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', _installPs1
          ], { detached: true, stdio: 'ignore', windowsHide: true });
          _child.unref();
          console.log('[daemon-updater] install.ps1 detach 완료 → 1초 후 self-exit');
          // 0.5초 후 자진 종료 (install.ps1이 kill하기 전에 깨끗하게 나감)
          setTimeout(() => process.exit(0), 500);
          return; // start() 종료
        } catch (_eI) {
          console.warn('[daemon-updater] install.ps1 spawn 실패:', _eI.message);
        }
      }
    } catch (_ev) {
      console.warn('[daemon-updater] install-version 체크 오류:', _ev.message);
    }
  }

  _repairStartDaemonPs1();  // start-daemon.ps1/watchdog.ps1 Add-Content lock 자동 복구

  // First check after 3s — waitForServer(18s) 이전에 실행 (daemon-updater가 main()에서 최우선 시작됨)
  // 크래시 루프 탈출: 버전 체크 → git pull → exit 0 이 크래시(~20s) 전에 완료됨
  setTimeout(async () => {
    // Startup: check server + git
    const serverInfo = await checkServerVersion();
    if (!serverInfo || !serverInfo.version) {
      console.log('[daemon-updater] server unreachable at startup -> git direct check');
      if (_gitDirectCheck()) {
        pullAndRestart('startup: server unreachable + git update found');
        return;
      }
    } else {
      const local = getLocalVersion();
      if (local !== 'unknown' && serverInfo.version !== local) {
        // 크래시 루프 탈출 최우선: idle 대기 없이 즉시 업데이트
        // 이유: 크래시 루프(~22s 주기)에서는 30분 타임아웃이 영원히 도달하지 못함
        // (매 32s 재시작 시 _pendingUpdate 메모리 초기화됨)
        console.log(`[daemon-updater] startup version mismatch: ${local} -> ${serverInfo.version} → 즉시 업데이트`);
        pullAndRestart(`startup version mismatch: ${local} -> ${serverInfo.version}`);
        return;
      }
    }

    _checkCycle();
    _timer = setInterval(_checkCycle, CHECK_POLL_INTERVAL);
    _gitCheckTimer = setInterval(_periodicGitCheck, GIT_CHECK_INTERVAL);
  }, 3000);
}

function stop() {
  _running = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_gitCheckTimer) { clearInterval(_gitCheckTimer); _gitCheckTimer = null; }
}

module.exports = { start, stop, getLocalVersion, pullAndRestart, checkServerVersion, reportStatus };
