// ============================================================================
// win-action-spy.cs — nenova.exe 행동순서(화면→버튼→순서→시각→결과대화상자) 캡쳐 사이드카
// ----------------------------------------------------------------------------
// 기존 uia-recorder.ps1 은 UIA FocusedElement 폴링(250ms)이라 "버튼 클릭 순서"와
// "성공/실패 대화상자 메시지"를 놓친다. 이 사이드카는 Win32 SetWinEventHook
// (OUTOFCONTEXT, 이벤트 구동)로 EXE/DB 무접촉 '읽기전용' 관찰만 한다.
//
// 반드시 x86 빌드 + [STAThread] + 수동 메시지펌프(PeekMessage/Translate/Dispatch).
//   (anycpu / Application.Run / late-bound InvokeMember 조합은 콜백 0건으로 실패 — 2026-11-04 검증)
//
// 개인정보 원칙(orbit 헌법): get_accName / get_accRole 만 호출한다. get_accValue 는
//   절대 호출하지 않는다 — 즉 '타이핑한 값/셀 내용'을 구조적으로 수집하지 못한다.
//   WinForms 에서 accName 은 컨트롤의 라벨/캡션이지 입력 내용이 아니다.
//   DevExpress 그리드 셀은 accName 이 'Editing control' 만 주므로 자동으로 걸러진다.
//
// 빌드:  csc /noconfig /platform:x86 /target:exe /reference:System.dll
//              /reference:<...>\Accessibility.dll /out:win-action-spy.exe win-action-spy.cs
// 실행:  win-action-spy.exe <jsonlPath> <controlPath> <parentPid> <procNamesCsv> <maxMinutes>
//   jsonlPath   : 캡쳐 이벤트를 append 할 UTF-8 JSONL 파일 (데몬이 tail 해서 업로드)
//   controlPath : "pause"/"run" 제어 파일 (데몬 perf-selfcheck 가 과부하 시 pause 기록)
//   parentPid   : 데몬 PID — 죽으면 사이드카도 종료 (고아 방지)
//   procNamesCsv: 관찰 대상 프로세스명 (확장자 제외, 기본 "nenova")
//   maxMinutes  : 0 = 무한, >0 = 테스트용 시간제한
// ============================================================================
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.IO;
using System.Diagnostics;
using Accessibility;

class WinActionSpy
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("oleacc.dll")] static extern uint AccessibleObjectFromEvent(IntPtr hwnd, uint idObj, uint idChild, out IAccessible acc, out object child);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint rm);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);

    static WinEventProc _cb;
    static StreamWriter _w;
    static long _events = 0;     // 캡쳐 시도(관심 이벤트 수)
    static long _emitted = 0;    // 노이즈 제거 후 기록된 수
    static HashSet<uint> _targetPids = new HashSet<uint>();
    static string[] _procNames;

    // 연속 중복 컷(같은 창+역할+이름+액션 300ms 내)
    static string _lastSig = "";
    static long _lastSigMs = 0;

    static string Win(IntPtr h)
    {
        StringBuilder s = new StringBuilder(256);
        GetWindowTextW(h, s, 256);
        return s.ToString();
    }

    static string EvName(uint e)
    {
        switch (e)
        {
            case 0x0003: return "FOREGROUND";
            case 0x0004: return "MENUSTART";
            case 0x0006: return "MENUPOPUP";
            case 0x8005: return "FOCUS";
            case 0x8006: return "SELECTION";
            case 0x8002: return "SHOW";
            case 0x800A: return "STATECHANGE";
            case 0x8013: return "INVOKED";
            default: return "0x" + e.ToString("X");
        }
    }

    static string RoleStr(int r)
    {
        switch (r)
        {
            case 43: return "btn";
            case 12: return "menuitem";
            case 37: return "tab";
            case 41: return "statictext";
            case 42: return "text";
            case 46: return "combo";
            case 9: return "window";
            case 10: return "client";
            case 34: return "list";
            case 36: return "listitem";
            default: return "r" + r;
        }
    }

    // 레이아웃/껍데기 창 — 의미 없는 FOREGROUND 노이즈
    static bool IsLayoutWindow(string win)
    {
        if (win == null) return true;
        string t = win.Trim();
        if (t.Length <= 1) return true;                 // 한 글자 제목
        switch (t)
        {
            case "Vertical":
            case "Horizontal":
            case "MainView":
            case "layoutControl2":
            case "Editing control":
            case "Form1":
                return true;
        }
        return false;
    }

    // 쓰레기 이벤트 판별(버림=true). name 은 컨트롤 캡션/라벨(입력값 아님).
    static bool IsNoise(uint ev, string role, string name, string win)
    {
        if (name == null || name.Length == 0) return true;          // 이름 없는 이벤트
        if (name.IndexOf("스크롤 화살표") >= 0) return true;        // 위/아래 스크롤 화살표 STATECHANGE
        if (name == "Editing control") return true;                 // DevExpress 그리드 편집기(값 없음)
        if (role == "text" && name == win) return true;             // 편집 컨트롤 자기이름 반복
        // FOREGROUND 는 명명된 '실제 화면'만 남긴다(레이아웃/껍데기 제외)
        if (ev == 0x0003 && IsLayoutWindow(win)) return true;
        return false;
    }

    static string JsonStr(string s)
    {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            switch (c)
            {
                case '\\': b.Append("\\\\"); break;
                case '"': b.Append("\\\""); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);        // 한글 등은 UTF-8 로 그대로 기록
                    break;
            }
        }
        return b.ToString();
    }

    static void Cb(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time)
    {
        // 관심 이벤트만
        if (!(ev == 0x0003 || ev == 0x0004 || ev == 0x0006 || ev == 0x8005 || ev == 0x8006 || ev == 0x8002 || ev == 0x800A || ev == 0x8013)) return;
        // 프로세스 필터: 이 hwnd 가 관찰대상(nenova) PID 가 아니면 버림 (전역 훅 → 재시작 자동대응)
        try
        {
            uint wpid = 0;
            GetWindowThreadProcessId(hwnd, out wpid);
            if (!_targetPids.Contains(wpid)) return;
        }
        catch { return; }

        string role = "", name = "";
        try
        {
            IAccessible acc; object child;
            uint hr = AccessibleObjectFromEvent(hwnd, (uint)idObj, (uint)idChild, out acc, out child);
            if (hr == 0 && acc != null)
            {
                // get_accName / get_accRole 만 — get_accValue 는 호출하지 않음(개인정보 원칙)
                try { name = acc.get_accName(child) ?? ""; } catch { }
                try { role = RoleStr(Convert.ToInt32(acc.get_accRole(child))); } catch { }
            }
        }
        catch { }

        _events++;
        string win = Win(hwnd);
        if (IsNoise(ev, role, name, win)) return;

        // 연속 중복 컷(같은 창+역할+이름+액션 300ms 내)
        string evn = EvName(ev);
        string sig = win + "|" + role + "|" + name + "|" + evn;
        long nowMs = DateTime.UtcNow.Ticks / 10000L;
        if (sig == _lastSig && (nowMs - _lastSigMs) < 300) { _lastSigMs = nowMs; return; }
        _lastSig = sig; _lastSigMs = nowMs;

        _emitted++;
        try
        {
            // win(GetWindowTextW)은 자식 컨트롤 hwnd 에선 깨진 문자열이라 기록하지 않는다.
            //   화면(폼) 맥락은 시간순 스트림의 직전 FOREGROUND(name=폼이름)로 복원한다.
            string line = "{\"t\":\"" + DateTime.UtcNow.ToString("o") + "\",\"ev\":\"" + evn
                + "\",\"role\":\"" + JsonStr(role) + "\",\"name\":\"" + JsonStr(name)
                + "\",\"seq\":" + _emitted + "}";
            _w.WriteLine(line);
            _w.Flush();
        }
        catch { }
    }

    static void RefreshTargetPids()
    {
        HashSet<uint> next = new HashSet<uint>();
        for (int i = 0; i < _procNames.Length; i++)
        {
            string pn = _procNames[i];
            if (pn == null || pn.Length == 0) continue;
            try
            {
                Process[] ps = Process.GetProcessesByName(pn);
                for (int j = 0; j < ps.Length; j++)
                {
                    try { next.Add((uint)ps[j].Id); } catch { }
                    try { ps[j].Dispose(); } catch { }
                }
            }
            catch { }
        }
        _targetPids = next;
    }

    static bool ParentAlive(int parentPid)
    {
        if (parentPid <= 0) return true;
        try { Process p = Process.GetProcessById(parentPid); bool ok = !p.HasExited; p.Dispose(); return ok; }
        catch { return false; }
    }

    static string ReadControl(string controlPath)
    {
        try { if (File.Exists(controlPath)) return File.ReadAllText(controlPath).Trim().ToLowerInvariant(); }
        catch { }
        return "run";
    }

    static void WritePerf(string jsonlPath, Process self, TimeSpan prevCpu, long prevMs, bool hooked)
    {
        try
        {
            TimeSpan cpu = self.TotalProcessorTime;
            long nowMs = DateTime.UtcNow.Ticks / 10000L;
            double wallMs = nowMs - prevMs;
            int cores = Environment.ProcessorCount; if (cores < 1) cores = 1;
            double pct = 0;
            if (wallMs > 0) pct = (cpu - prevCpu).TotalMilliseconds / (wallMs * cores) * 100.0;
            if (pct < 0) pct = 0;
            long wsMB = self.WorkingSet64 / 1024 / 1024;
            string line = "{\"kind\":\"__perf\",\"t\":\"" + DateTime.UtcNow.ToString("o")
                + "\",\"cpuPct\":" + Math.Round(pct, 2).ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ",\"wsMB\":" + wsMB + ",\"hooked\":" + (hooked ? "true" : "false")
                + ",\"events\":" + _events + ",\"emitted\":" + _emitted + ",\"targets\":" + _targetPids.Count + "}";
            // 공유 writer(_w)로 기록 — 같은 파일을 두 StreamWriter 로 동시에 열면 Windows 공유위반으로 조용히 실패한다.
            _w.WriteLine(line);
            _w.Flush();
        }
        catch { }
    }

    static IntPtr _h1 = IntPtr.Zero, _h2 = IntPtr.Zero;
    static bool _hooked = false;

    static void Hook()
    {
        if (_hooked) return;
        // OUTOFCONTEXT(0) 전역 훅 — pid 0 = 전 프로세스, 콜백에서 PID 필터
        _h1 = SetWinEventHook(0x0003, 0x0006, IntPtr.Zero, _cb, 0, 0, 0);
        _h2 = SetWinEventHook(0x8002, 0x8013, IntPtr.Zero, _cb, 0, 0, 0);
        _hooked = true;
    }
    static void Unhook()
    {
        if (!_hooked) return;
        try { UnhookWinEvent(_h1); } catch { }
        try { UnhookWinEvent(_h2); } catch { }
        _h1 = IntPtr.Zero; _h2 = IntPtr.Zero; _hooked = false;
    }

    [STAThread]
    static int Main(string[] a)
    {
        if (a.Length < 1) { Console.Error.WriteLine("usage: win-action-spy <jsonl> [control] [parentPid] [procNamesCsv] [maxMinutes]"); return 2; }
        string jsonlPath = a[0];
        string controlPath = a.Length > 1 ? a[1] : "";
        int parentPid = a.Length > 2 ? SafeInt(a[2], 0) : 0;
        string procCsv = a.Length > 3 ? a[3] : "nenova";
        int maxMinutes = a.Length > 4 ? SafeInt(a[4], 0) : 0;
        _procNames = procCsv.Split(',');

        // 단일 인스턴스(데몬 재기동 시 중복 훅 방지)
        bool createdNew;
        System.Threading.Mutex mtx = new System.Threading.Mutex(true, "OrbitWinActionSpy_" + Environment.UserName, out createdNew);
        if (!createdNew) { Console.Error.WriteLine("already running - exit"); return 0; }

        try { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(jsonlPath))); } catch { }
        _w = new StreamWriter(jsonlPath, true, new UTF8Encoding(false));
        _cb = Cb;
        RefreshTargetPids();
        Hook();

        Process self = Process.GetCurrentProcess();
        TimeSpan prevCpu = self.TotalProcessorTime;
        long prevPerfMs = DateTime.UtcNow.Ticks / 10000L;

        DateTime start = DateTime.UtcNow;
        long lastPidMs = 0, lastParentMs = 0, lastCtlMs = 0, lastPerfMs = 0;
        MSG m;
        while (true)
        {
            // 수동 메시지 펌프 — OUTOFCONTEXT 콜백이 이 펌프로 디스패치된다(없으면 콜백 0건)
            while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }

            long nowMs = DateTime.UtcNow.Ticks / 10000L;
            if (maxMinutes > 0 && (DateTime.UtcNow - start).TotalMinutes >= maxMinutes) break;

            // 관찰대상 PID 2초마다 갱신(nenova 재시작 자동대응)
            if (nowMs - lastPidMs >= 2000) { RefreshTargetPids(); lastPidMs = nowMs; }
            // 부모(데몬) 2초마다 생존 확인 — 죽으면 종료(고아 방지)
            if (nowMs - lastParentMs >= 2000) { if (!ParentAlive(parentPid)) break; lastParentMs = nowMs; }
            // 과부하 제어 1초마다: perf-selfcheck 가 "pause" 쓰면 훅 해제(스로틀)
            if (controlPath.Length > 0 && nowMs - lastCtlMs >= 1000)
            {
                string ctl = ReadControl(controlPath);
                if (ctl == "pause" && _hooked) Unhook();
                else if (ctl != "pause" && !_hooked) Hook();
                lastCtlMs = nowMs;
            }
            // CPU/메모리 자기측정 10초마다 기록(데몬이 읽어 '느림이 우리 탓이냐' 판정)
            if (nowMs - lastPerfMs >= 10000)
            {
                WritePerf(jsonlPath, self, prevCpu, prevPerfMs, _hooked);
                prevCpu = self.TotalProcessorTime; prevPerfMs = nowMs; lastPerfMs = nowMs;
            }

            System.Threading.Thread.Sleep(15);
        }

        Unhook();
        try { _w.WriteLine("{\"kind\":\"__end\",\"t\":\"" + DateTime.UtcNow.ToString("o") + "\",\"events\":" + _events + ",\"emitted\":" + _emitted + "}"); _w.Flush(); _w.Close(); } catch { }
        try { GC.KeepAlive(mtx); } catch { }
        return 0;
    }

    static int SafeInt(string s, int def) { int v; if (int.TryParse(s, out v)) return v; return def; }
}
