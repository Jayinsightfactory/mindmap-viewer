'use strict';
/**
 * routes/company.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Company Ontology CRUD + Graph + Tracker Data Ingest
 *
 * --- Company ---
 * POST   /api/company                    — 회사 생성
 * GET    /api/company                    — 회사 목록
 * GET    /api/company/:id                — 회사 상세
 * PUT    /api/company/:id                — 회사 수정
 * DELETE /api/company/:id                — 회사 삭제
 * GET    /api/company/:id/graph          — 온톨로지 그래프
 * GET    /api/company/:id/stats          — 활동 통계
 *
 * --- Department ---
 * POST   /api/company/:id/department
 * GET    /api/company/:id/departments
 * PUT    /api/department/:id
 * DELETE /api/department/:id
 *
 * --- Employee ---
 * POST   /api/company/:id/employee
 * GET    /api/company/:id/employees
 * PUT    /api/employee/:id
 * GET    /api/employee/:id/activities
 *
 * --- Process ---
 * POST   /api/company/:id/process
 * GET    /api/company/:id/processes
 * PUT    /api/process/:id
 *
 * --- System ---
 * POST   /api/company/:id/system
 * GET    /api/company/:id/systems
 *
 * --- Tracker Data Ingest (NO AUTH — token-based) ---
 * POST   /api/tracker/heartbeat          — 직원 트래커 하트비트
 * POST   /api/tracker/activities         — 활동 데이터 벌크 전송
 * GET    /api/tracker/config             — 트래커 설정 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');

module.exports = function createCompanyRouter({ getDb, broadcastAll }) {
  const router = Router();
  const ontology = require('../src/company-ontology');

  function db() { return getDb(); }

  // ══════════════════════════════════════════════════════════════════════════
  // Company CRUD
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/company', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const result = ontology.createCompany(db(), req.body);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const list = ontology.listCompanies(db(), {
        status: req.query.status, consultant_id: req.query.consultant_id,
        company_type: req.query.type, limit: parseInt(req.query.limit) || 50,
      });
      res.json({ companies: list, total: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const company = ontology.getCompany(db(), req.params.id);
      if (!company) return res.status(404).json({ error: 'not found' });

      const departments = ontology.listDepartments(db(), req.params.id);
      const employees = ontology.listEmployees(db(), req.params.id);
      const processes = ontology.listProcesses(db(), req.params.id);
      const systems = ontology.listSystems(db(), req.params.id);

      res.json({ company, departments, employees, processes, systems });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/company/:id', (req, res) => {
    try {
      ontology.updateCompany(db(), req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/company/:id', (req, res) => {
    try {
      ontology.deleteCompany(db(), req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/graph', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const graph = ontology.buildCompanyGraph(db(), req.params.id);
      if (!graph) return res.status(404).json({ error: 'company not found' });
      res.json(graph);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/stats', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const since = req.query.since || new Date(Date.now() - 86400_000).toISOString();
      const stats = ontology.getActivityStats(db(), req.params.id, since);
      res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Department
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/company/:id/department', (req, res) => {
    try {
      const result = ontology.createDepartment(db(), { ...req.body, company_id: req.params.id });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/departments', (req, res) => {
    try {
      const list = ontology.listDepartments(db(), req.params.id);
      res.json({ departments: list, total: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/department/:id', (req, res) => {
    try {
      ontology.updateDepartment(db(), req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/department/:id', (req, res) => {
    try {
      ontology.deleteDepartment(db(), req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Employee
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/company/:id/employee', (req, res) => {
    try {
      const result = ontology.createEmployee(db(), { ...req.body, company_id: req.params.id });
      // tracker_token 반환 — 이 토큰으로 트래커 설치 시 자동 연결
      res.json({ ok: true, ...result, installUrl: `/api/tracker/install-bat?token=${result.tracker_token}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/employees', (req, res) => {
    try {
      const list = ontology.listEmployees(db(), req.params.id, req.query.department_id);
      res.json({ employees: list, total: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/employee/:id', (req, res) => {
    try {
      ontology.updateEmployee(db(), req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/employee/:id/activities', (req, res) => {
    try {
      const activities = ontology.getActivities(db(), {
        employee_id: req.params.id,
        since: req.query.since,
        limit: req.query.limit,
      });
      res.json({ activities, total: activities.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Process
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/company/:id/process', (req, res) => {
    try {
      const result = ontology.createProcess(db(), { ...req.body, company_id: req.params.id });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/processes', (req, res) => {
    try {
      const list = ontology.listProcesses(db(), req.params.id, req.query.department_id);
      res.json({ processes: list, total: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/process/:id', (req, res) => {
    try {
      ontology.updateProcess(db(), req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // System
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/company/:id/system', (req, res) => {
    try {
      const result = ontology.createSystem(db(), { ...req.body, company_id: req.params.id });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/company/:id/systems', (req, res) => {
    try {
      const list = ontology.listSystems(db(), req.params.id);
      res.json({ systems: list, total: list.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tracker Data Ingest — NO AUTH (token-based)
  // 직원 PC에 설치된 트래커가 토큰만으로 데이터 전송
  // ══════════════════════════════════════════════════════════════════════════

  router.post('/tracker/heartbeat', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { token, hostname, os_info, uptime } = req.body;
      if (!token) return res.status(400).json({ error: 'token required' });

      const emp = ontology.getEmployeeByToken(db(), token);
      if (!emp) return res.status(404).json({ error: 'invalid token' });

      // 마지막 확인 시간 업데이트
      ontology.updateEmployee(db(), emp.id, {
        tracker_active: 1,
        last_seen_at: new Date().toISOString(),
      });

      res.json({ ok: true, employee_id: emp.id, name: emp.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tracker/activities', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { token, activities = [] } = req.body;
      if (!token) return res.status(400).json({ error: 'token required' });
      if (!activities.length) return res.json({ ok: true, count: 0 });

      const emp = ontology.getEmployeeByToken(db(), token);
      if (!emp) return res.status(404).json({ error: 'invalid token' });

      // 모든 활동에 employee_id, company_id 주입
      const enriched = activities.map(a => ({
        ...a,
        employee_id: emp.id,
        company_id: emp.company_id,
        tracker_token: token,
      }));

      const result = ontology.insertActivitiesBatch(db(), enriched);

      // 마지막 확인 시간 업데이트
      ontology.updateEmployee(db(), emp.id, {
        tracker_active: 1,
        last_seen_at: new Date().toISOString(),
      });

      // 실시간 브로드캐스트 (마인드맵에 표시)
      if (broadcastAll && activities.length > 0) {
        const latest = activities[activities.length - 1];
        broadcastAll({
          type: 'employee_activity',
          employee: { id: emp.id, name: emp.name },
          activity: {
            type: latest.activity_type,
            app: latest.app_name,
            title: latest.window_title,
            category: latest.category,
          },
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ ok: true, count: result.count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 트래커 버전 — 이 숫자를 올리면 모든 직원 PC가 자동 업데이트 ──────
  const TRACKER_VERSION = 1;

  router.get('/tracker/config', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const token = req.query.token;
      if (!token) return res.status(400).json({ error: 'token required' });

      const emp = ontology.getEmployeeByToken(db(), token);
      if (!emp) return res.status(404).json({ error: 'invalid token' });

      res.json({
        ok: true,
        employee_id: emp.id,
        name: emp.name,
        company_id: emp.company_id,
        tracker_version: TRACKER_VERSION,
        config: {
          heartbeat_interval_sec: 60,
          activity_send_interval_sec: 30,
          capture_urls: true,
          capture_window_titles: true,
          capture_keystrokes: true,
          capture_mouse: true,
          idle_threshold_sec: 300,
          excluded_apps: ['lockscreen', 'screensaver'],
          excluded_urls: [],
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/tracker/version — 최신 트래커 버전 조회 (업데이트 체크용)
  router.get('/tracker/version', (_req, res) => {
    res.json({ version: TRACKER_VERSION });
  });

  // ── 트래커 설치 스크립트 (Windows PowerShell) ──────────────────────────

  // GET /api/tracker/install — 순수 트래커 PS1 (실행 루프만, 설치 로직 없음)
  // .bat가 이 파일을 다운로드 → 저장 → 등록 → 실행
  router.get('/tracker/install', (req, res) => {
    const token = req.query.token || '';
    const serverUrl = `${req.protocol}://${req.get('host')}`;

    const ps1Script = `# Orbit Tracker Agent (PowerShell)
# 이 파일은 자동 생성됩니다. 직접 수정하지 마세요.
$ErrorActionPreference = "SilentlyContinue"
$TOKEN = "${token}"
$SERVER = "${serverUrl}"
$INTERVAL = 30
$IDLE_THRESHOLD = 300
$SCRIPT_VERSION = ${TRACKER_VERSION}
$UPDATE_CHECK_SEC = 3600

# ── 자동 업데이트 함수 ───────────────────────────────────────────────
# 서버에서 최신 버전을 확인하고, 새 버전이면 스크립트 교체 후 자동 재시작
function Check-Update {
    try {
        $resp = Invoke-RestMethod -Uri "$SERVER/api/tracker/version" -TimeoutSec 5
        if ($resp.version -and [int]$resp.version -gt $SCRIPT_VERSION) {
            $myPath = $MyInvocation.ScriptName
            if (-not $myPath) { $myPath = "$env:LOCALAPPDATA\\OrbitTracker\\orbit-tracker.ps1" }
            # 새 스크립트 다운로드
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $newScript = (New-Object Net.WebClient).DownloadString("$SERVER/api/tracker/install?token=$TOKEN")
            if ($newScript -and $newScript.Length -gt 100) {
                Set-Content -Path $myPath -Value $newScript -Encoding UTF8
                # 새 프로세스로 재시작
                Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File \`"$myPath\`"" -WindowStyle Hidden
                exit
            }
        }
    } catch {}
}

# ── Win32 유휴 시간 감지 ──────────────────────────────────────────────
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleTime {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint Get() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref lii);
        return ((uint)Environment.TickCount - lii.dwTime) / 1000;
    }
}
"@

# ── 활성 윈도우 감지 (Win32 API) ─────────────────────────────────────
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Window {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

function Get-ActiveWindow {
    $hwnd = [Win32Window]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 256
    [Win32Window]::GetWindowText($hwnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    $pid = 0
    [Win32Window]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    return @{ Title = $title; App = if($proc){$proc.ProcessName}else{"unknown"}; Pid = $pid }
}

# ── 메인 루프 ─────────────────────────────────────────────────────────
$buffer = @()
$sessionStart = Get-Date
$lastUpdateCheck = Get-Date

while ($true) {
    try {
        # ── 자동 업데이트 체크 (1시간마다) ──
        if (((Get-Date) - $lastUpdateCheck).TotalSeconds -ge $UPDATE_CHECK_SEC) {
            Check-Update
            $lastUpdateCheck = Get-Date
        }

        $idle = [IdleTime]::Get()
        $win = Get-ActiveWindow
        $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

        # 앱 카테고리 자동 분류
        $cat = "other"
        switch -Regex ($win.App) {
            "chrome|firefox|edge|brave|whale"              { $cat = "browser" }
            "code|rider|pycharm|intellij|cursor|windsurf"  { $cat = "development" }
            "excel|sheets|calc"                            { $cat = "spreadsheet" }
            "word|hwp|docs|hanword"                        { $cat = "document" }
            "powerpnt|powerpoint"                          { $cat = "presentation" }
            "outlook|thunderbird"                          { $cat = "email" }
            "slack|teams|kakaotalk|discord|zoom|line"      { $cat = "communication" }
            "explorer"                                     { $cat = "file_manager" }
        }

        # URL 캡처 (브라우저 활성 시)
        $url = ""
        if ($cat -eq "browser") {
            try {
                $url = (New-Object -ComObject Shell.Application).Windows() |
                    Where-Object { $_.LocationURL } |
                    Select-Object -First 1 -ExpandProperty LocationURL
            } catch {}
        }

        $titleSafe = $win.Title
        if ($titleSafe.Length -gt 200) { $titleSafe = $titleSafe.Substring(0, 200) }

        $activity = @{
            activity_type = if ($idle -gt $IDLE_THRESHOLD) { "idle" } else { "active" }
            app_name      = $win.App
            window_title  = $titleSafe
            url           = $url
            category      = $cat
            duration_sec  = $INTERVAL
            idle_sec      = [int]$idle
            timestamp     = $now
        }

        $buffer += $activity

        # 5건 모이면 서버로 전송
        if ($buffer.Count -ge 5) {
            $body = @{ token = $TOKEN; activities = $buffer } | ConvertTo-Json -Depth 5
            try {
                Invoke-RestMethod -Uri "$SERVER/api/tracker/activities" -Method POST ` + "`" + `
                    -Body $body -ContentType "application/json; charset=utf-8" -TimeoutSec 10 | Out-Null
            } catch {}
            $buffer = @()
        }

        # 하트비트 (5분마다)
        $elapsed = ((Get-Date) - $sessionStart).TotalSeconds
        if ([math]::Floor($elapsed) % 300 -lt $INTERVAL) {
            $hb = @{
                token    = $TOKEN
                hostname = $env:COMPUTERNAME
                username = $env:USERNAME
                os_info  = "Windows $([System.Environment]::OSVersion.Version)"
                uptime   = [int]$elapsed
            } | ConvertTo-Json
            try {
                Invoke-RestMethod -Uri "$SERVER/api/tracker/heartbeat" -Method POST ` + "`" + `
                    -Body $hb -ContentType "application/json; charset=utf-8" -TimeoutSec 5 | Out-Null
            } catch {}
        }

    } catch {}
    Start-Sleep -Seconds $INTERVAL
}`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(ps1Script);
  });

  // ── .BAT 원클릭 설치 (직원용) ─────────────────────────────────────────────
  // 더블클릭 한 번이면 끝 — ExecutionPolicy, 디렉토리, 트래커, 자동시작 전부
  // .bat가 서버에서 PS1을 받아서 저장+등록+실행
  router.get('/tracker/install-bat', (req, res) => {
    const token = req.query.token || '';
    if (!token) return res.status(400).send('token required');
    const serverUrl = `${req.protocol}://${req.get('host')}`;

    const batContent = [
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'title Orbit Tracker - 자동 설치',
      'echo.',
      'echo =========================================',
      'echo   Orbit Tracker 자동 설치',
      'echo =========================================',
      'echo.',
      'echo   설치가 자동으로 진행됩니다.',
      'echo   잠시 기다려주세요...',
      'echo.',
      '',
      'REM --- 설치 폴더 생성 ---',
      'set "DIR=%LOCALAPPDATA%\\OrbitTracker"',
      'if not exist "%DIR%" mkdir "%DIR%"',
      'echo   [1/4] 설치 폴더 준비 완료',
      '',
      'REM --- 서버에서 트래커 스크립트 다운로드 ---',
      `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('${serverUrl}/api/tracker/install?token=${token}', \\"$env:LOCALAPPDATA\\OrbitTracker\\orbit-tracker.ps1\\"); Write-Host '  [2/4] 트래커 다운로드 완료' } catch { Write-Host '  [!] 다운로드 실패:' $_.Exception.Message; pause; exit 1 }"`,
      '',
      'REM --- 다운로드 확인 ---',
      'if not exist "%DIR%\\orbit-tracker.ps1" (',
      '    echo.',
      '    echo   [오류] 트래커 스크립트 다운로드에 실패했습니다.',
      '    echo   서버 주소를 확인해주세요: ' + serverUrl,
      '    echo.',
      '    pause',
      '    exit /b 1',
      ')',
      '',
      'REM --- 작업 스케줄러 등록 (로그인시 자동 실행) ---',
      'schtasks /Create /TN "OrbitTracker" /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File \\"%DIR%\\orbit-tracker.ps1\\"" /SC ONLOGON /RL HIGHEST /F >nul 2>&1',
      'if %errorlevel% equ 0 (',
      '    echo   [3/4] 자동 시작 등록 완료 (PC 켜면 자동 실행^)',
      ') else (',
      '    REM 스케줄러 실패시 시작프로그램 폴더에 바로가기',
      '    powershell -ExecutionPolicy Bypass -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut(\\"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OrbitTracker.lnk\\"); $s.TargetPath=\\"powershell.exe\\"; $s.Arguments=\\"-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `\\"$env:LOCALAPPDATA\\OrbitTracker\\orbit-tracker.ps1`\\"\\"; $s.WindowStyle=7; $s.Save()"',
      '    echo   [3/4] 시작프로그램에 등록 완료',
      ')',
      '',
      'REM --- 즉시 실행 ---',
      'start "" /B powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "%DIR%\\orbit-tracker.ps1"',
      'echo   [4/4] 트래커 실행 시작!',
      'echo.',
      'echo =========================================',
      'echo   설치 완료!',
      'echo =========================================',
      'echo.',
      'echo   - PC를 껐다 켜도 자동으로 추적됩니다',
      'echo   - 아무것도 안 해도 됩니다',
      'echo.',
      'echo   이 창은 5초 후 자동으로 닫힙니다...',
      'timeout /t 5 >nul',
      'exit',
    ].join('\r\n');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="orbit-tracker-setup.bat"`);
    res.send(batContent);
  });

  // ── 벤치마크 API ──────────────────────────────────────────────────────────

  router.get('/benchmark/:industry', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const benchmarks = ontology.getBenchmarks(db(), req.params.industry, req.query.type || 'B');
      res.json({ benchmarks, total: benchmarks.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
