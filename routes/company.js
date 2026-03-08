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
 * POST   /api/tracker/activities         — 분석된 활동 데이터 수신 (원본 X)
 * POST   /api/tracker/analyzed           — 로컬 학습 분석 결과 수신
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

  // POST /api/tracker/activities — 분석된 활동 데이터 수신
  // 로컬에서 분석된 결과만 수신 (원본 키스트로크 절대 포함 안 됨)
  router.post('/tracker/activities', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { token, activities = [], analyzed } = req.body;
      if (!token) return res.status(400).json({ error: 'token required' });

      const emp = ontology.getEmployeeByToken(db(), token);
      if (!emp) return res.status(404).json({ error: 'invalid token' });

      // ── 분석된 데이터 형식으로 수신 (로컬 학습 결과) ──
      // 활동 데이터에서 원본 키스트로크 필드 제거 (안전장치)
      const sanitized = activities.map(a => {
        const { raw_keystrokes, keystroke_content, raw_buffer, ...safe } = a;
        return {
          ...safe,
          employee_id: emp.id,
          company_id: emp.company_id,
          tracker_token: token,
        };
      });

      let count = 0;
      if (sanitized.length > 0) {
        const result = ontology.insertActivitiesBatch(db(), sanitized);
        count = result.count;
      }

      // 분석 결과가 함께 전송된 경우 저장
      if (analyzed) {
        try {
          const analysisRecord = {
            employee_id: emp.id,
            company_id: emp.company_id,
            period_start: analyzed.period?.start || new Date().toISOString(),
            period_end: analyzed.period?.end || new Date().toISOString(),
            activity_type: analyzed.activityType || 'unknown',
            metrics: JSON.stringify(analyzed.metrics || {}),
            patterns: JSON.stringify(analyzed.patterns || {}),
            insights: JSON.stringify(analyzed.insights || {}),
            summary: analyzed.summary || '',
            timestamp: new Date().toISOString(),
          };
          ontology.insertActivitiesBatch(db(), [analysisRecord]);
        } catch (analysisErr) {
          console.warn('[tracker/activities] 분석 결과 저장 실패:', analysisErr.message);
        }
      }

      // 마지막 확인 시간 업데이트
      ontology.updateEmployee(db(), emp.id, {
        tracker_active: 1,
        last_seen_at: new Date().toISOString(),
      });

      // 실시간 브로드캐스트 (마인드맵에 표시 — 분석 결과 기반)
      if (broadcastAll && (activities.length > 0 || analyzed)) {
        const latest = activities[activities.length - 1] || {};
        broadcastAll({
          type: 'employee_activity',
          employee: { id: emp.id, name: emp.name },
          activity: {
            type: analyzed?.activityType || latest.activity_type || 'unknown',
            app: latest.app_name || analyzed?.appContext?.app || 'unknown',
            category: latest.category || analyzed?.activityType || 'other',
            // 원본 윈도우 제목 대신 분석된 앱 컨텍스트 전송
            context: analyzed?.appContext || {},
            metrics: analyzed?.metrics || {},
            summary: analyzed?.summary || '',
          },
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ ok: true, count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/tracker/analyzed — 로컬 학습 분석 결과 전용 엔드포인트 ──
  // 트래커가 5분마다 로컬 분석 후 이 엔드포인트로 결과만 전송
  // 구조: { period, activities, patterns, metrics, insights, summary }
  // 원본 키스트로크 내용은 절대 포함되지 않음
  router.post('/tracker/analyzed', (req, res) => {
    try {
      ontology.ensureCompanyTables(db());
      const { token, period, activities, patterns, metrics, insights, summary } = req.body;
      if (!token) return res.status(400).json({ error: 'token required' });

      const emp = ontology.getEmployeeByToken(db(), token);
      if (!emp) return res.status(404).json({ error: 'invalid token' });

      // ── 분석 결과 저장 (원본 데이터 없음, 요약만) ──
      const analysisRecord = {
        employee_id: emp.id,
        company_id: emp.company_id,
        activity_type: 'analyzed_session',
        category: 'analysis',
        period_start: period?.start || new Date().toISOString(),
        period_end: period?.end || new Date().toISOString(),
        // 분석 결과를 JSON으로 직렬화하여 저장
        app_name: 'local-learning-engine',
        window_title: summary || '',
        extra_data: JSON.stringify({
          activities: (activities || []).map(a => ({
            type: a.type,
            app: a.app,
            duration: a.duration,
            category: a.category,
            confidence: a.confidence,
          })),
          patterns: {
            repetitive: patterns?.repetitive || [],
            automation_opportunities: patterns?.automation_opportunities || [],
          },
          metrics: {
            typingSpeed: metrics?.typingSpeed || 0,
            activeTime: metrics?.activeTime || 0,
            idleTime: metrics?.idleTime || 0,
            contextSwitches: metrics?.contextSwitches || 0,
            totalKeystrokes: metrics?.totalKeystrokes || 0,
            copyPasteCount: metrics?.copyPasteCount || 0,
          },
          insights: {
            topApps: insights?.topApps || [],
            workflowSteps: insights?.workflowSteps || [],
            efficiency_score: insights?.efficiency_score || 0,
            categoryDistribution: insights?.categoryDistribution || {},
          },
        }),
        timestamp: new Date().toISOString(),
      };

      ontology.insertActivitiesBatch(db(), [analysisRecord]);

      // 마지막 확인 시간 업데이트
      ontology.updateEmployee(db(), emp.id, {
        tracker_active: 1,
        last_seen_at: new Date().toISOString(),
      });

      // 실시간 브로드캐스트 — 분석 결과 기반
      if (broadcastAll) {
        broadcastAll({
          type: 'employee_analysis',
          employee: { id: emp.id, name: emp.name },
          analysis: {
            period,
            summary: summary || '',
            efficiency_score: insights?.efficiency_score || 0,
            topApps: (insights?.topApps || []).slice(0, 3),
            patterns: {
              repetitive_count: (patterns?.repetitive || []).length,
              automation_count: (patterns?.automation_opportunities || []).length,
            },
            metrics: {
              typingSpeed: metrics?.typingSpeed || 0,
              activeTime: metrics?.activeTime || 0,
              contextSwitches: metrics?.contextSwitches || 0,
            },
          },
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ ok: true, employee_id: emp.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 트래커 버전 — 이 숫자를 올리면 모든 직원 PC가 자동 업데이트 ──────
  // v2: 로컬 학습 아키텍처 — 원본 데이터 전송 안 함
  const TRACKER_VERSION = 2;

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
          // 로컬 학습 설정 — 분석 주기 5분
          local_analysis_interval_sec: 300,
          activity_collect_interval_sec: 30,
          capture_urls: true,
          capture_window_titles: true,
          // 키스트로크 내용은 로컬에서만 수집/분석, 서버에 원본 전송 안 함
          capture_keystrokes_locally: true,
          send_raw_keystrokes: false,
          capture_mouse: true,
          idle_threshold_sec: 300,
          excluded_apps: ['lockscreen', 'screensaver'],
          excluded_urls: [],
          // 로컬 학습 엔진 설정
          local_learning: {
            enabled: true,
            analysis_interval_sec: 300,
            pattern_detection: true,
            activity_classification: true,
            efficiency_scoring: true,
            model_update_interval: 5,
          },
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

    const ps1Script = `# Orbit Tracker Agent v2 (PowerShell) — 로컬 학습 아키텍처
# 이 파일은 자동 생성됩니다. 직접 수정하지 마세요.
# ═══════════════════════════════════════════════════════════════════════
# 핵심 원칙: "로컬에서 학습 → 분석 결과만 전송"
# - 키스트로크 내용은 로컬 메모리에만 존재 (절대 서버 전송 안 함)
# - 5분마다 로컬 분석 실행 후 원본 버퍼 삭제
# - 서버에는 활동 분류, 패턴, 메트릭 요약만 전송
# ═══════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "SilentlyContinue"
$TOKEN = "${token}"
$SERVER = "${serverUrl}"
$INTERVAL = 30
$IDLE_THRESHOLD = 300
$SCRIPT_VERSION = ${TRACKER_VERSION}
$UPDATE_CHECK_SEC = 3600
$ANALYSIS_INTERVAL_SEC = 300  # 5분마다 로컬 분석

# ── 로컬 데이터 버퍼 (절대 서버 전송 안 함) ────────────────────────────
$script:rawKeystrokeBuffer = ""     # 원본 키스트로크 (로컬 전용)
$script:activityBuffer = @()         # 활동 기록 (분석 대기)
$script:analysisHistory = @()        # 분석 이력 (로컬 모델용)
$script:lastAnalysisTime = Get-Date  # 마지막 분석 시간
$script:keystrokeCount = 0           # 키스트로크 카운트
$script:backspaceCount = 0           # 백스페이스 카운트 (정확도 측정)
$script:copyPasteCount = 0           # 복사-붙여넣기 카운트
$script:contextSwitchCount = 0       # 앱 전환 카운트
$script:lastApp = ""                 # 이전 앱 (전환 감지용)

# ── 자동 업데이트 함수 ───────────────────────────────────────────────
function Check-Update {
    try {
        $resp = Invoke-RestMethod -Uri "$SERVER/api/tracker/version" -TimeoutSec 5
        if ($resp.version -and [int]$resp.version -gt $SCRIPT_VERSION) {
            $myPath = $MyInvocation.ScriptName
            if (-not $myPath) { $myPath = "$env:LOCALAPPDATA\\OrbitTracker\\orbit-tracker.ps1" }
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $newScript = (New-Object Net.WebClient).DownloadString("$SERVER/api/tracker/install?token=$TOKEN")
            if ($newScript -and $newScript.Length -gt 100) {
                Set-Content -Path $myPath -Value $newScript -Encoding UTF8
                Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File \\\`"$myPath\\\`"" -WindowStyle Hidden
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

# ── 키보드 후킹 (로컬 버퍼에만 저장) ─────────────────────────────────
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class KeyboardHook {
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);

    private static IntPtr hookId = IntPtr.Zero;
    private static LowLevelKeyboardProc proc;
    public static int KeyCount = 0;
    public static int BackspaceCount = 0;
    public static int SymbolCount = 0;
    public static int NumberCount = 0;
    public static int SpaceCount = 0;
    public static int EnterCount = 0;
    public static int TabCount = 0;
    public static bool CtrlCPressed = false;
    public static bool CtrlVPressed = false;
    public static int CopyPasteCount = 0;

    public static void ResetCounters() {
        KeyCount = 0; BackspaceCount = 0; SymbolCount = 0;
        NumberCount = 0; SpaceCount = 0; EnterCount = 0;
        TabCount = 0; CopyPasteCount = 0;
        CtrlCPressed = false; CtrlVPressed = false;
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (int)wParam == 0x0100) {
            int vkCode = Marshal.ReadInt32(lParam);
            bool ctrlDown = (GetAsyncKeyState(0x11) & 0x8000) != 0;

            if (ctrlDown && vkCode == 0x43) { CtrlCPressed = true; CopyPasteCount++; }
            else if (ctrlDown && vkCode == 0x56) { CtrlVPressed = true; CopyPasteCount++; }
            else if (vkCode == 0x08) { BackspaceCount++; KeyCount++; }
            else if (vkCode == 0x0D) { EnterCount++; KeyCount++; }
            else if (vkCode == 0x09) { TabCount++; KeyCount++; }
            else if (vkCode == 0x20) { SpaceCount++; KeyCount++; }
            else if (vkCode >= 0x30 && vkCode <= 0x39) { NumberCount++; KeyCount++; }
            else if (vkCode >= 0x41 && vkCode <= 0x5A) { KeyCount++; }
            else if ((vkCode >= 0xBA && vkCode <= 0xC0) || (vkCode >= 0xDB && vkCode <= 0xDF)) {
                SymbolCount++; KeyCount++;
            }
            else { KeyCount++; }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Start() {
        proc = HookCallback;
        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            hookId = SetWindowsHookEx(13, proc, GetModuleHandle(curModule.ModuleName), 0);
        }
    }

    public static void Stop() {
        if (hookId != IntPtr.Zero) { UnhookWindowsHookEx(hookId); hookId = IntPtr.Zero; }
    }
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

# ── 앱 카테고리 분류 ──────────────────────────────────────────────────
function Get-AppCategory($appName, $windowTitle) {
    $cat = "other"
    switch -Regex ($appName) {
        "chrome|firefox|edge|brave|whale"              { $cat = "browser" }
        "code|rider|pycharm|intellij|cursor|windsurf"  { $cat = "coding" }
        "excel|sheets|calc"                            { $cat = "data-entry" }
        "word|hwp|docs|hanword"                        { $cat = "document" }
        "powerpnt|powerpoint"                          { $cat = "presentation" }
        "outlook|thunderbird"                          { $cat = "email" }
        "slack|teams|kakaotalk|discord|zoom|line"      { $cat = "chat" }
        "explorer"                                     { $cat = "file_manager" }
        "terminal|cmd|powershell|iterm|warp"           { $cat = "coding" }
    }
    # 브라우저인 경우 제목으로 세분화
    if ($cat -eq "browser" -and $windowTitle) {
        $t = $windowTitle.ToLower()
        if ($t -match "gmail|mail|inbox|outlook") { $cat = "email" }
        elseif ($t -match "slack|teams|discord|messenger") { $cat = "chat" }
        elseif ($t -match "docs.google|notion|confluence") { $cat = "document" }
        elseif ($t -match "github|gitlab|stackoverflow") { $cat = "coding" }
        elseif ($t -match "sheets.google|airtable") { $cat = "data-entry" }
        elseif ($t -match "google|bing|naver|daum|search") { $cat = "search" }
    }
    return $cat
}

# ── 키스트로크 패턴 기반 활동 유형 보강 ───────────────────────────────
function Get-KeystrokeActivityType($keyCount, $symbolCount, $numberCount, $tabCount, $enterCount, $spaceCount) {
    if ($keyCount -lt 5) { return $null }
    $symbolRatio = if ($keyCount -gt 0) { $symbolCount / $keyCount } else { 0 }
    $numberRatio = if ($keyCount -gt 0) { $numberCount / $keyCount } else { 0 }
    $tabRatio = if ($keyCount -gt 0) { $tabCount / $keyCount } else { 0 }
    $enterRatio = if ($keyCount -gt 0) { $enterCount / $keyCount } else { 0 }

    if ($symbolRatio -gt 0.15) { return "coding" }
    if ($numberRatio -gt 0.3 -and $tabRatio -gt 0.05) { return "data-entry" }
    if ($enterRatio -gt 0.05 -and $spaceCount -gt 0) { return "chat" }
    return $null
}

# ── 윈도우 제목 정제 (민감 정보 제거) ─────────────────────────────────
function Sanitize-WindowTitle($title) {
    if (-not $title) { return "" }
    $s = $title -replace '[\\w.-]+@[\\w.-]+', '[email]'
    $s = $s -replace '\\?[^\\s]*', '?[params]'
    $s = $s -replace 'C:\\\\Users\\\\[\\w.-]+\\\\', 'C:\\Users\\[user]\\'
    if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
    return $s
}

# ═══════════════════════════════════════════════════════════════════════
# 로컬 분석 함수 — 5분마다 실행, 결과만 서버 전송
# ═══════════════════════════════════════════════════════════════════════

function Run-LocalAnalysis {
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $periodStart = $script:lastAnalysisTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

    # 분석할 데이터 확인
    if ($script:activityBuffer.Count -eq 0) { return }

    # ── 1. 활동 분류 집계 ──
    $activityTypes = @{}
    $appDurations = @{}
    $totalDuration = 0
    $activeTime = 0
    $idleTime = 0

    foreach ($a in $script:activityBuffer) {
        $type = $a.category
        if (-not $activityTypes[$type]) { $activityTypes[$type] = 0 }
        $activityTypes[$type] += $a.duration_sec

        $app = $a.app_name
        if (-not $appDurations[$app]) { $appDurations[$app] = 0 }
        $appDurations[$app] += $a.duration_sec

        $totalDuration += $a.duration_sec
        if ($a.activity_type -eq "idle") { $idleTime += $a.duration_sec }
        else { $activeTime += $a.duration_sec }
    }

    # ── 2. 상위 앱 추출 ──
    $topApps = @()
    $sortedApps = $appDurations.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5
    foreach ($entry in $sortedApps) {
        $topApps += @{ app = $entry.Name; duration_sec = $entry.Value }
    }

    # ── 3. 타이핑 메트릭 (카운트 기반, 내용 없음) ──
    $totalKeys = [KeyboardHook]::KeyCount
    $backspaces = [KeyboardHook]::BackspaceCount
    $symbols = [KeyboardHook]::SymbolCount
    $numbers = [KeyboardHook]::NumberCount
    $spaces = [KeyboardHook]::SpaceCount
    $enters = [KeyboardHook]::EnterCount
    $tabs = [KeyboardHook]::TabCount
    $copyPaste = [KeyboardHook]::CopyPasteCount

    $activeMin = $activeTime / 60
    $wordsEstimate = if ($spaces -gt 0) { $spaces + 1 } else { 0 }
    $typingSpeed = if ($activeMin -gt 0) { [math]::Round($wordsEstimate / $activeMin) } else { 0 }
    $accuracy = if ($totalKeys -gt 0) { [math]::Round((1 - $backspaces / $totalKeys) * 100) } else { 100 }

    # ── 4. 키스트로크 패턴으로 주요 활동 유형 판별 ──
    $keystrokeType = Get-KeystrokeActivityType $totalKeys $symbols $numbers $tabs $enters $spaces
    $primaryType = if ($keystrokeType) { $keystrokeType } else {
        $maxType = "other"; $maxDur = 0
        foreach ($entry in $activityTypes.GetEnumerator()) {
            if ($entry.Value -gt $maxDur) { $maxType = $entry.Name; $maxDur = $entry.Value }
        }
        $maxType
    }

    # ── 5. 반복 패턴 감지 ──
    $repetitive = @()
    $appSequence = $script:activityBuffer | ForEach-Object { $_.app_name }
    $seqCounts = @{}
    for ($i = 0; $i -lt $appSequence.Count - 1; $i++) {
        $pair = "$($appSequence[$i]) > $($appSequence[$i+1])"
        if (-not $seqCounts[$pair]) { $seqCounts[$pair] = 0 }
        $seqCounts[$pair]++
    }
    foreach ($entry in $seqCounts.GetEnumerator()) {
        if ($entry.Value -ge 3) {
            $repetitive += @{ sequence = $entry.Name; count = $entry.Value; type = "app_switch_loop" }
        }
    }

    # ── 6. 자동화 기회 감지 ──
    $automationOpps = @()
    if ($copyPaste -ge 5) {
        $automationOpps += @{
            type = "copy_paste_automation"
            frequency = $copyPaste
            suggestion = "copy-paste automation recommended"
            priority = if ($copyPaste -ge 10) { "high" } else { "medium" }
        }
    }
    $switchRate = if ($script:activityBuffer.Count -gt 1) {
        $script:contextSwitchCount / ($script:activityBuffer.Count - 1)
    } else { 0 }
    if ($switchRate -gt 0.7) {
        $automationOpps += @{
            type = "context_switch_reduction"
            rate = [math]::Round($switchRate * 100)
            suggestion = "high context switching detected"
            priority = "medium"
        }
    }

    # ── 7. 효율성 점수 계산 ──
    $activeRatio = if ($totalDuration -gt 0) { $activeTime / $totalDuration } else { 0 }
    $switchPenalty = [math]::Min($script:contextSwitchCount * 0.5, 20)
    $efficiencyScore = [math]::Max(0, [math]::Min(100, [math]::Round($activeRatio * 100 - $switchPenalty)))

    # ── 8. 활동 요약 텍스트 생성 (내용 없이 메트릭만) ──
    $totalMin = [math]::Round($totalDuration / 60)
    $activeMinR = [math]::Round($activeTime / 60)
    $topAppName = if ($topApps.Count -gt 0) { $topApps[0].app } else { "none" }
    $summaryText = "Total $($totalMin)min, Active $($activeMinR)min | Top: $topAppName | Speed: $($typingSpeed) WPM | Switches: $($script:contextSwitchCount) | Score: $efficiencyScore/100"

    # ── 9. 분류된 활동 목록 (원본 제목/내용 없음) ──
    $classifiedActivities = @()
    foreach ($a in $script:activityBuffer) {
        $classifiedActivities += @{
            type = $a.category
            app = $a.app_name
            duration = $a.duration_sec
            category = $a.category
        }
    }

    # ═══ 분석 결과 구성 — 원본 키스트로크 내용 절대 포함 안 함 ═══
    $analysisResult = @{
        token = $TOKEN
        period = @{ start = $periodStart; end = $now }
        activities = $classifiedActivities
        patterns = @{
            repetitive = $repetitive
            automation_opportunities = $automationOpps
        }
        metrics = @{
            typingSpeed = $typingSpeed
            activeTime = $activeTime
            idleTime = $idleTime
            contextSwitches = $script:contextSwitchCount
            totalKeystrokes = $totalKeys
            copyPasteCount = $copyPaste
            accuracy = $accuracy
            symbolRatio = if ($totalKeys -gt 0) { [math]::Round($symbols / $totalKeys, 2) } else { 0 }
            numberRatio = if ($totalKeys -gt 0) { [math]::Round($numbers / $totalKeys, 2) } else { 0 }
        }
        insights = @{
            topApps = $topApps
            efficiency_score = $efficiencyScore
            categoryDistribution = $activityTypes
        }
        summary = $summaryText
        # 원본 키스트로크 내용 없음 — 절대 전송하지 않음
    }

    # ── 서버로 분석 결과만 전송 ──
    $body = $analysisResult | ConvertTo-Json -Depth 10
    try {
        Invoke-RestMethod -Uri "$SERVER/api/tracker/analyzed" -Method POST ` + "`" + `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) ` + "`" + `
            -ContentType "application/json; charset=utf-8" -TimeoutSec 10 | Out-Null
    } catch {}

    # ═══ 핵심: 분석 후 원본 데이터 삭제 ═══
    $script:rawKeystrokeBuffer = ""
    $script:activityBuffer = @()
    $script:contextSwitchCount = 0
    $script:lastAnalysisTime = Get-Date
    [KeyboardHook]::ResetCounters()
}

# ── 메인 루프 ─────────────────────────────────────────────────────────
$sessionStart = Get-Date
$lastUpdateCheck = Get-Date
$script:lastAnalysisTime = Get-Date

# 키보드 후킹 시작 (카운트만, 내용은 메모리에만)
try { [KeyboardHook]::Start() } catch {}

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

        # 앱 카테고리 분류 (세분화)
        $cat = Get-AppCategory $win.App $win.Title

        # 앱 전환 감지
        if ($script:lastApp -and $script:lastApp -ne $win.App) {
            $script:contextSwitchCount++
        }
        $script:lastApp = $win.App

        # URL 캡처 (브라우저 활성 시)
        $url = ""
        if ($cat -eq "browser" -or $cat -eq "search") {
            try {
                $url = (New-Object -ComObject Shell.Application).Windows() |
                    Where-Object { ` + "$" + `_.LocationURL } |
                    Select-Object -First 1 -ExpandProperty LocationURL
            } catch {}
        }

        # 윈도우 제목 정제 (민감 정보 제거)
        $titleSafe = Sanitize-WindowTitle $win.Title

        # 활동 기록 (로컬 버퍼에 추가 — 서버 직접 전송 안 함)
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

        $script:activityBuffer += $activity

        # ═══ 5분마다 로컬 분석 실행 ═══
        $timeSinceAnalysis = ((Get-Date) - $script:lastAnalysisTime).TotalSeconds
        if ($timeSinceAnalysis -ge $ANALYSIS_INTERVAL_SEC) {
            Run-LocalAnalysis
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
