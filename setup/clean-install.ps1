# ═══════════════════════════════════════════════════════════════════════════
# Orbit AI — Clean Install (v10 — 모든 해결책 통합)
# ═══════════════════════════════════════════════════════════════════════════
# /install 배포웹 → install-clean.bat 다운로드 → 본 스크립트 실행
#
# v10 통합 사항 (이전 사고 모두 반영):
#   • 익명 hostname 등록 (토큰 박힘 X) → /api/daemon/register
#   • 자동 사용자 분류 (resolver: PC매핑 / 카톡 / 클립보드) — 서버측
#   • C# WinExe 런처 (conhost 창 자체 생성 0%) ← cmd 깜빡임 완전 제거
#   • VBS 래퍼 (C# 컴파일 실패 시 fallback)
#   • schtasks /create /f 만 사용 (delete 금지 — 영구 침묵 방지)
#   • OrbitWatchdog 30분 주기 (5분 → 30분, AV 알림 빈도 83% 감소)
#   • 파일 락 회피: kill 모든 자식 + 3초 대기 + 로그 rotate
#   • ORBIT_SAFE_MODE=1 잔재 자동 제거 (구버전 daemon-updater 버그)
#   • .safe-mode 빈파일만 삭제 (crash-reporter JSON 유지 — crash loop 차단)
#   • Out-File -Append (지속 핸들 X — 파일 사용중 에러 방지)
#   • 3중 안전망 — schtasks + Startup lnk + Registry Run
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Continue"

$REMOTE   = if ($env:ORBIT_REMOTE) { $env:ORBIT_REMOTE } else { "https://mindmap-viewer-production-adb2.up.railway.app" }
$REPO     = "https://github.com/Jayinsightfactory/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$LOG      = "$OrbitDir\clean-install.log"

New-Item -ItemType Directory -Force -Path $OrbitDir -ErrorAction SilentlyContinue | Out-Null

function Log($msg) {
    $line = "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') $msg`r`n"
    Write-Host "  $msg"
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::AppendAllText($LOG, $line, $utf8)
    } catch {}
}

function PauseExit([int]$Code = 0) {
    Write-Host ""
    if ($Code -ne 0) { Write-Host "  설치 실패. 로그: $LOG" -ForegroundColor Yellow }
    Write-Host "  아무 키나 누르면 닫힘..." -ForegroundColor Gray
    try { [Console]::ReadKey($true) | Out-Null } catch { try { Read-Host " " } catch {} }
    exit $Code
}

trap {
    Log "[FATAL] $_"
    PauseExit 1
}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] clean-install v10" | Out-File $LOG -Force

Write-Host ""
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Orbit AI Clean Install (v10)" -ForegroundColor Cyan
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  PC: $env:COMPUTERNAME | User: $env:USERNAME"
Write-Host "  Server: $REMOTE"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 1/8: 기존 설치 정리 — 파일 락 + 자식 프로세스 + 잔재 모두 정리
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [1/8] 기존 설치 정리..." -ForegroundColor Cyan

# (1) schtasks 일시 중단만 — /delete 금지 (영구 침묵 방지)
#     v8 교훈: /delete 후 재등록 실패 시 PC 재부팅해도 자동 기동 안 되는 사고
#     해결: /end 후 Step 7의 /create /f가 안전하게 덮어씀
foreach ($task in @("OrbitDaemon","OrbitWatchdog","OrbitTracker")) {
    schtasks /end /tn $task 2>$null | Out-Null
}
Log "schtasks 일시 중단 (delete 안 함 — 영구 침묵 방지)"

# (2) 모든 자식 프로세스 종료 — 파일 락 해제 + 이중 실행 방지
Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*personal-agent*" -or
    $_.CommandLine -like "*mindmap-viewer*" -or
    $_.CommandLine -like "*.orbit*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*orbit-tracker*" -or
    $_.CommandLine -like "*start-daemon*" -or
    $_.CommandLine -like "*watchdog*" -or
    $_.CommandLine -like "*\.orbit\*" -or
    $_.CommandLine -like "*OrbitTracker*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*ImageGrab*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-Process -Name "wscript","orbit-launcher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "conhost" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*orbit*" -or $_.MainWindowTitle -like "*daemon*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Log "프로세스 정리 완료"

# (3) 파일 핸들 해제 대기 — Windows는 프로세스 종료 후에도 잠시 락 유지
Start-Sleep -Milliseconds 3000

# (4) 로그 파일 락 확인 — 잠겨있으면 rotate
@("daemon.log","daemon-self.log","watchdog.log","install.log") | ForEach-Object {
    $f = "$OrbitDir\$_"
    if (Test-Path $f) {
        try {
            $fs = [IO.File]::Open($f, 'Open', 'ReadWrite', 'Read')
            $fs.Close()
            # 거대 로그 파일 정리 (10MB+)
            $size = (Get-Item $f).Length
            if ($size -gt 10MB) {
                Remove-Item $f -Force -ErrorAction SilentlyContinue
                Log "거대 로그 삭제: $_ ($([math]::Round($size/1MB, 1))MB)"
            }
        } catch {
            # 락 걸림 → rotate
            try { Move-Item $f "$f.old.$(Get-Date -Format yyyyMMddHHmmss)" -Force -ErrorAction SilentlyContinue } catch {}
            Log "로그 락 회피: $_ → .old"
        }
    }
}

# (5) Startup 바로가기 + Registry Run 정리 (구버전 잔재)
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
@(
    "$startupDir\orbit-daemon.bat","$startupDir\orbit-daemon.vbs","$startupDir\orbit-daemon.lnk",
    "$startupDir\OrbitDaemon.lnk","$startupDir\OrbitTracker.lnk","$startupDir\OrbitWatchdog.lnk"
) | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Force -ErrorAction SilentlyContinue }
}
foreach ($name in @("OrbitDaemon","OrbitTracker","OrbitWatchdog","OrbitRescue")) {
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v $name /f 2>$null | Out-Null
}
Log "Startup + Registry 정리"

# (6) ORBIT_SAFE_MODE=1 잔재 자동 제거 (구버전 daemon-updater 버그)
$sdExist = "$OrbitDir\start-daemon.ps1"
if (Test-Path $sdExist) {
    try {
        $sdTxt = Get-Content $sdExist -Raw -ErrorAction SilentlyContinue
        if ($sdTxt -match 'ORBIT_SAFE_MODE\s*=\s*[''"]1[''"]') {
            Log "구버전 ORBIT_SAFE_MODE=1 잔재 발견 → 파일 재생성 (Step 7에서)"
        }
    } catch {}
}

# (7) .safe-mode — 빈 파일만 삭제 (crash-reporter JSON은 유지)
$smPath = "$OrbitDir\.safe-mode"
if (Test-Path $smPath) {
    try {
        $smContent = (Get-Content $smPath -Raw -ErrorAction SilentlyContinue) -replace '\s',''
        if (-not $smContent -or -not $smContent.StartsWith('{')) {
            Remove-Item $smPath -Force -ErrorAction SilentlyContinue
            Log ".safe-mode 빈파일 삭제 (수집 활성화)"
        } else {
            Log ".safe-mode JSON 유지 (crash loop 차단)"
        }
    } catch {}
}

# (8) OrbitTracker 폴더 + .pending-upload 삭제
$trackerDir = "$env:LOCALAPPDATA\OrbitTracker"
if (Test-Path $trackerDir) { Remove-Item $trackerDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path "$OrbitDir\.pending-upload.jsonl") { Remove-Item "$OrbitDir\.pending-upload.jsonl" -Force -ErrorAction SilentlyContinue }

# ═══════════════════════════════════════════════════════════════════════════
# Step 2/8: Node.js
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [2/8] Node.js 확인..." -ForegroundColor Cyan
$nodeOk = $false
try { $nv = & node -v 2>$null; if ($nv -match "^v\d+") { $nodeOk = $true; Log "Node.js: $nv" } } catch {}
if (-not $nodeOk) {
    Log "Node.js 설치 중..."
    try {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
    } catch { Log "[ERROR] Node.js 설치 실패"; PauseExit 1 }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 3/8: Git
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [3/8] Git 확인..." -ForegroundColor Cyan
$gitOk = $false
try { $gv = & git --version 2>$null; if ($gv -match "git version") { $gitOk = $true; Log "Git OK" } } catch {}
if (-not $gitOk) {
    try {
        winget install --id Git.Git --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
    } catch { Log "[ERROR] Git 설치 실패"; PauseExit 1 }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 4/8: 소스 다운로드
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [4/8] 소스 다운로드..." -ForegroundColor Cyan
if (Test-Path "$DIR\.git") {
    Log "git pull"
    Push-Location $DIR
    git fetch --all 2>&1 | Out-Null
    git reset --hard origin/main 2>&1 | Out-Null
    Pop-Location
} else {
    if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
    Log "git clone"
    git clone --depth 1 $REPO $DIR 2>&1 | Out-Null
    if (-not (Test-Path "$DIR\.git")) { Log "[ERROR] clone 실패"; PauseExit 1 }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 5/8: npm install
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [5/8] 의존성 설치..." -ForegroundColor Cyan
Push-Location $DIR
try { cmd /c "npm install --production --no-audit --no-fund --prefer-offline 2>&1" | Out-Null }
catch { Log "[WARN] npm: $_" }
Pop-Location

# ═══════════════════════════════════════════════════════════════════════════
# Step 6/8: 익명 등록 (hostname만) + 자동 사용자 분류 + 학습값 복원
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [6/8] 서버 등록 + 학습값 복원..." -ForegroundColor Cyan

# (1) /api/daemon/register — 토큰 박힘 X. hostname만 보내고 서버가 분류
#     서버측 resolver:  orbit_pc_links → PC_USER_MAP → PC_NAME_MAP → 카톡 → 클립보드 → null
#     실패해도 익명 pc_HOSTNAME 으로 데이터 수집 시작 (50건마다 재추론)
$configPath = "$env:USERPROFILE\.orbit-config.json"
$matchedUserId = "pc_$env:COMPUTERNAME"
try {
    $regBody = @{
        hostname = $env:COMPUTERNAME
        platform = "win32"
        nodeVersion = (& node -v 2>$null)
    } | ConvertTo-Json
    $reg = Invoke-RestMethod -Uri "$REMOTE/api/daemon/register" -Method POST -Body $regBody -ContentType "application/json" -TimeoutSec 10
    if ($reg.userId) {
        $matchedUserId = $reg.userId
        if ($reg.matched) {
            Log "사용자 자동 매칭: $env:COMPUTERNAME → $matchedUserId"
        } else {
            Log "익명 등록 (50건 후 자동 추론): $matchedUserId"
        }
    }
} catch {
    Log "[WARN] 서버 등록 실패: $_ — 익명 ID 사용"
}

$config = @{
    serverUrl = $REMOTE
    hostname  = $env:COMPUTERNAME
    userId    = $matchedUserId
    installedAt = (Get-Date -f 'o')
} | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
Log "config 저장"

# (2) 학습값 복원
try {
    $learnedUrl = "$REMOTE/api/daemon/learned-config?userId=$matchedUserId&hostname=$env:COMPUTERNAME"
    $learnedPath = "$OrbitDir\capture-config.json"
    Invoke-WebRequest -Uri $learnedUrl -OutFile $learnedPath -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue
    if (Test-Path $learnedPath) {
        $size = (Get-Item $learnedPath).Length
        Log "학습값 복원: $size bytes"
    }
} catch { Log "[WARN] 학습값 복원 실패 (데몬 자체 학습 시작)" }

# ═══════════════════════════════════════════════════════════════════════════
# Step 7/8: 런처 + 데몬 스크립트 + 3중 안전망 + Watchdog
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [7/8] 런처 + 안전망 등록..." -ForegroundColor Cyan

# (1) C# WinExe 런처 — conhost 창 자체 생성 0% (cmd 깜빡임 완전 제거)
#     컴파일 가능시: orbit-launcher.exe (subsystem=Windows)
#     컴파일 실패시: VBS 래퍼 fallback → powershell 직접
$launcherExe = "$OrbitDir\orbit-launcher.exe"
$launcherCs  = "$OrbitDir\orbit-launcher.cs"
$launcherCompiled = $false

$cscPaths = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($csc) {
    $csCode = @"
using System;
using System.Diagnostics;
class OrbitLauncher {
    [STAThread]
    static int Main(string[] args) {
        if (args.Length < 1) return 1;
        try {
            var psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + args[0] + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
            return 0;
        } catch { return 2; }
    }
}
"@
    [IO.File]::WriteAllText($launcherCs, $csCode, $utf8NoBom)
    try {
        & $csc /nologo /target:winexe /out:"$launcherExe" "$launcherCs" 2>&1 | Out-Null
        if (Test-Path $launcherExe) {
            $launcherCompiled = $true
            Log "C# WinExe 런처 컴파일 완료 (cmd 깜빡임 0%)"
        }
    } catch { Log "[WARN] C# 컴파일 실패: $_" }
    Remove-Item $launcherCs -Force -ErrorAction SilentlyContinue
}

# (2) VBS 래퍼 — C# 실패 시 fallback. WSH 차단 PC도 powershell 직접 실행 가능
$vbsPath = "$OrbitDir\orbit-hidden.vbs"
$vbsBody = @"
Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count > 0 Then
  sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & args(0) & """", 0, False
End If
"@
[IO.File]::WriteAllText($vbsPath, $vbsBody, $utf8NoBom)

# (3) start-daemon.ps1 (데몬 메인 루프)
$daemonScript = "$OrbitDir\start-daemon.ps1"
$daemonContent = @"
# Auto-generated by clean-install v10. Do not edit.
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location '$DIR'

# 중복 실행 방지 — schtasks/lnk/Registry 3중 트리거 대응
`$me = `$PID
`$siblings = Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    `$_.ProcessId -ne `$me -and `$_.CommandLine -like '*start-daemon.ps1*'
}
if (`$siblings) { exit 0 }

while (`$true) {
    `$alive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -like '*personal-agent*' }
    if (`$alive) { Start-Sleep -Seconds 10; continue }

    try {
        # Out-File -Append: 호출마다 핸들 해제 (Add-Content 지속 락 회피)
        node daemon\personal-agent.js 2>&1 | ForEach-Object {
            try { `$_ | Out-File -Append -Encoding utf8 -FilePath '$OrbitDir\daemon.log' -ErrorAction SilentlyContinue } catch {}
        }
    } catch {
        try { "`$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [CRASH] `$_" | Out-File -Append -Encoding utf8 -FilePath '$OrbitDir\daemon.log' -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 5
}
"@
[IO.File]::WriteAllText($daemonScript, $daemonContent, $utf8NoBom)

# (4) watchdog.ps1 — 30분 주기로 데몬 alive 체크 + 살리기 (AV 친화)
$watchdogScript = "$OrbitDir\watchdog.ps1"
$watchdogContent = @"
# Auto-generated by clean-install v10. 30분 주기 데몬 alive 체크.
`$ErrorActionPreference = 'SilentlyContinue'

`$alive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -like '*personal-agent*' }
if (`$alive) { exit 0 }

# 데몬 죽음 — start-daemon.ps1 실행
"`$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') daemon dead — restart" | Out-File -Append -Encoding utf8 -FilePath '$OrbitDir\watchdog.log' -ErrorAction SilentlyContinue

`$launcher = '$launcherExe'
`$vbs = '$vbsPath'
`$ps1 = '$daemonScript'
if ((Test-Path `$launcher)) {
    Start-Process `$launcher -ArgumentList `$ps1 -WindowStyle Hidden
} elseif ((Test-Path `$vbs)) {
    Start-Process wscript.exe -ArgumentList "`"`$vbs`" `"`$ps1`""
} else {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`$ps1`"" -WindowStyle Hidden
}
"@
[IO.File]::WriteAllText($watchdogScript, $watchdogContent, $utf8NoBom)

# (5) 안전망 1/3: schtasks (OrbitDaemon ONLOGON + OrbitWatchdog 30분)
#     /create /f 만 사용 (delete 안 함)
$tr_daemon = if ($launcherCompiled) {
    "$launcherExe `"$daemonScript`""
} else {
    "wscript.exe `"$vbsPath`" `"$daemonScript`""
}
$tr_watch  = if ($launcherCompiled) {
    "$launcherExe `"$watchdogScript`""
} else {
    "wscript.exe `"$vbsPath`" `"$watchdogScript`""
}

try {
    schtasks /create /tn "OrbitDaemon" /tr "$tr_daemon" /sc onlogon /rl limited /f 2>&1 | Out-Null
    schtasks /create /tn "OrbitWatchdog" /tr "$tr_watch" /sc minute /mo 30 /rl limited /f 2>&1 | Out-Null
    Log "안전망 1/3: schtasks OrbitDaemon (logon) + OrbitWatchdog (30분)"
} catch {
    Log "[WARN] schtasks 등록 실패: $_"
}

# (6) 안전망 2/3: Startup 바로가기
try {
    $lnkPath = "$startupDir\OrbitDaemon.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($lnkPath)
    if ($launcherCompiled) {
        $lnk.TargetPath = $launcherExe
        $lnk.Arguments = "`"$daemonScript`""
    } else {
        $lnk.TargetPath = "wscript.exe"
        $lnk.Arguments = "`"$vbsPath`" `"$daemonScript`""
    }
    $lnk.WindowStyle = 7  # Minimized
    $lnk.Save()
    Log "안전망 2/3: Startup lnk"
} catch { Log "[WARN] Startup lnk 실패: $_" }

# (7) 안전망 3/3: Registry Run
try {
    $runValue = if ($launcherCompiled) {
        "`"$launcherExe`" `"$daemonScript`""
    } else {
        "wscript.exe `"$vbsPath`" `"$daemonScript`""
    }
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "OrbitDaemon" /t REG_SZ /d $runValue /f 2>&1 | Out-Null
    Log "안전망 3/3: Registry Run"
} catch { Log "[WARN] Registry 실패: $_" }

# ═══════════════════════════════════════════════════════════════════════════
# Step 8/8: 즉시 기동 + 검증
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [8/8] 데몬 기동 + 검증..." -ForegroundColor Cyan

# C# 런처 / VBS / powershell 순으로 시도 — cmd 깜빡임 0이 우선
if ($launcherCompiled) {
    Start-Process $launcherExe -ArgumentList "`"$daemonScript`"" -WindowStyle Hidden
} elseif (Test-Path $vbsPath) {
    Start-Process wscript.exe -ArgumentList "`"$vbsPath`" `"$daemonScript`""
} else {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonScript`"" -WindowStyle Hidden
}

# 10초 대기 후 검증
Start-Sleep -Seconds 10
$daemonAlive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*personal-agent*"
}

Write-Host ""
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
if ($daemonAlive) {
    $pids = ($daemonAlive | ForEach-Object { $_.ProcessId }) -join ','
    Write-Host "  ✅ 설치 완료 — 데이터 수집 시작" -ForegroundColor Green
    Log "설치 성공 — PID: $pids"
} else {
    Write-Host "  ⚠ 즉시 기동 실패 — 30분 후 watchdog 자동 살림" -ForegroundColor Yellow
    Log "[WARN] 즉시 기동 실패 — watchdog 의존"
}
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PC: $env:COMPUTERNAME → userId: $matchedUserId" -ForegroundColor Gray
Write-Host "  Server: $REMOTE" -ForegroundColor Gray
Write-Host "  로그: $LOG" -ForegroundColor Gray
Write-Host ""

# 서버에 설치 완료 알림
try {
    $body = @{
        event = "install.complete"
        userId = $matchedUserId
        hostname = $env:COMPUTERNAME
        version = "v10-clean"
        launcherCompiled = $launcherCompiled
        daemonAlive = [bool]$daemonAlive
        timestamp = (Get-Date -f 'o')
    } | ConvertTo-Json
    Invoke-WebRequest -Uri "$REMOTE/api/install/status" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
} catch {}

Write-Host "  이 창은 5초 후 자동으로 닫힙니다..." -ForegroundColor Gray
Start-Sleep -Seconds 5
exit 0
