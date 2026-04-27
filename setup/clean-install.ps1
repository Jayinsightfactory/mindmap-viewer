# ═══════════════════════════════════════════════════════════════════════════
# Orbit AI — Clean Install (v9 clean-slate)
# ═══════════════════════════════════════════════════════════════════════════
# One-click: 기존 전부 삭제 + 새로 설치
#
# 원칙:
#   1. 수집 연속성 제1원칙 — 학습값(capture-config.json)은 서버에서 복원
#   2. 이름 통일 — OrbitDaemon 하나만. OrbitTracker/OrbitWatchdog 제거.
#   3. TTL 없는 영구 플래그 금지 (.safe-mode 등 생성 안 함)
#   4. 자동 재실행 메커니즘 없음 (유저 수동 .bat 실행만)
#   5. 3중 안전망 — schtasks + Startup lnk + Registry Run
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

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] clean-install v9" | Out-File $LOG -Force

Write-Host ""
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Orbit AI Clean Install (v9)" -ForegroundColor Cyan
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  PC: $env:COMPUTERNAME | User: $env:USERNAME"
Write-Host "  Server: $REMOTE"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 1/7: 기존 설치 전부 삭제 (OrbitDaemon + OrbitTracker + OrbitWatchdog)
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [1/7] 기존 설치 정리..." -ForegroundColor Cyan

# (1) schtasks 전부 종료 + 삭제
#     clean-install은 유저 수동 실행 경로이므로 /delete 허용 (다음 Step에서 즉시 재등록)
foreach ($task in @("OrbitDaemon","OrbitWatchdog","OrbitTracker")) {
    schtasks /end    /tn $task 2>$null | Out-Null
    schtasks /delete /tn $task /f 2>$null | Out-Null
}
Log "schtasks 정리 완료"

# (2) 모든 관련 프로세스 종료
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
    $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-Process -Name "wscript","orbit-launcher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Log "프로세스 종료 완료"

# (3) 파일 핸들 해제 대기
Start-Sleep -Milliseconds 2000

# (4) Startup 바로가기 삭제
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
@(
    "$startupDir\orbit-daemon.bat",
    "$startupDir\orbit-daemon.vbs",
    "$startupDir\orbit-daemon.lnk",
    "$startupDir\OrbitDaemon.lnk",
    "$startupDir\OrbitTracker.lnk",
    "$startupDir\OrbitWatchdog.lnk"
) | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Force -ErrorAction SilentlyContinue }
}
Log "Startup 바로가기 정리 완료"

# (5) Registry Run 엔트리 삭제
foreach ($name in @("OrbitDaemon","OrbitTracker","OrbitWatchdog","OrbitRescue")) {
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v $name /f 2>$null | Out-Null
}
Log "Registry Run 정리 완료"

# (6) .safe-mode 같은 영구 플래그 삭제
@(
    "$OrbitDir\.safe-mode",
    "$OrbitDir\.pending-upload.jsonl"
) | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Force -ErrorAction SilentlyContinue }
}

# (7) OrbitTracker 폴더 완전 삭제
$trackerDir = "$env:LOCALAPPDATA\OrbitTracker"
if (Test-Path $trackerDir) {
    Remove-Item $trackerDir -Recurse -Force -ErrorAction SilentlyContinue
    Log "OrbitTracker 폴더 삭제: $trackerDir"
}

# (8) 거대 로그 파일 정리 (140MB daemon-self.log 같은)
@("daemon.log","daemon-self.log","watchdog.log","install.log") | ForEach-Object {
    $f = "$OrbitDir\$_"
    if (Test-Path $f) {
        $size = (Get-Item $f).Length
        if ($size -gt 10MB) {
            Remove-Item $f -Force -ErrorAction SilentlyContinue
            Log "거대 로그 삭제: $_ ($([math]::Round($size/1MB, 1))MB)"
        }
    }
}

# .orbit 폴더는 유지 (captures/, config 등은 학습 자산). 단 clean-install 로그만 보존.

# ═══════════════════════════════════════════════════════════════════════════
# Step 2/7: Node.js (없으면 설치)
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [2/7] Node.js 확인..." -ForegroundColor Cyan

$nodeOk = $false
try {
    $nv = & node -v 2>$null
    if ($nv -match "^v\d+") { $nodeOk = $true; Log "Node.js 이미 설치됨: $nv" }
} catch {}

if (-not $nodeOk) {
    Log "Node.js 설치 중..."
    try {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        Log "[ERROR] Node.js 설치 실패 — https://nodejs.org 에서 수동 설치 필요"
        PauseExit 1
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 3/7: Git (없으면 설치)
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [3/7] Git 확인..." -ForegroundColor Cyan

$gitOk = $false
try {
    $gv = & git --version 2>$null
    if ($gv -match "git version") { $gitOk = $true; Log "Git 이미 설치됨" }
} catch {}

if (-not $gitOk) {
    Log "Git 설치 중..."
    try {
        winget install --id Git.Git --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        Log "[ERROR] Git 설치 실패"
        PauseExit 1
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 4/7: 소스 다운로드 / 업데이트
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [4/7] 소스 다운로드..." -ForegroundColor Cyan

if (Test-Path "$DIR\.git") {
    Log "git pull: $DIR"
    Push-Location $DIR
    git fetch --all 2>&1 | Out-Null
    git reset --hard origin/main 2>&1 | Out-Null
    Pop-Location
} else {
    if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
    Log "git clone: $REPO"
    git clone --depth 1 $REPO $DIR 2>&1 | Out-Null
    if (-not (Test-Path "$DIR\.git")) {
        Log "[ERROR] git clone 실패"
        PauseExit 1
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 5/7: npm install
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [5/7] 의존성 설치..." -ForegroundColor Cyan
Push-Location $DIR
try {
    cmd /c "npm install --production --no-audit --no-fund --prefer-offline 2>&1" | Out-Null
} catch {
    Log "[WARN] npm install 경고: $_"
}
Pop-Location

# ═══════════════════════════════════════════════════════════════════════════
# Step 6/7: 설정 + 학습값 복원
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [6/7] 설정 + 학습값 복원..." -ForegroundColor Cyan

# (1) hostname 기반 서버 자동매칭 — userId는 서버가 결정
#     유저 이름·토큰은 PC에 저장 안 함. hostname(COMPUTERNAME)만 기준.
$configPath = "$env:USERPROFILE\.orbit-config.json"
$matchedUserId = "pc_$env:COMPUTERNAME"   # fallback: 서버 매칭 실패 시 임시값

try {
    $regBody = @{
        hostname = $env:COMPUTERNAME
        platform = "win32"
        nodeVersion = (& node -v 2>$null)
    } | ConvertTo-Json
    $reg = Invoke-RestMethod -Uri "$REMOTE/api/daemon/register" -Method POST -Body $regBody -ContentType "application/json" -TimeoutSec 10
    if ($reg.matchedUserId) {
        $matchedUserId = $reg.matchedUserId
        Log "hostname 매칭 성공: $env:COMPUTERNAME → $matchedUserId"
    } else {
        Log "hostname 매칭 없음 — 임시 ID 사용 (서버에서 사후 매핑)"
    }
} catch {
    Log "[WARN] 서버 매칭 호출 실패: $_ — 임시 ID 사용"
}

$config = @{
    serverUrl = $REMOTE
    hostname  = $env:COMPUTERNAME
    userId    = $matchedUserId
    installedAt = (Get-Date -f 'o')
} | ConvertTo-Json

# UTF8 no BOM
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
Log "config 저장: $configPath"

# (2) 서버에서 학습값(capture-config.json) 다운로드
try {
    $learnedUrl = "$REMOTE/api/daemon/learned-config?userId=$matchedUserId&hostname=$env:COMPUTERNAME"
    $learnedPath = "$OrbitDir\capture-config.json"
    Invoke-WebRequest -Uri $learnedUrl -OutFile $learnedPath -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue
    if (Test-Path $learnedPath) {
        $size = (Get-Item $learnedPath).Length
        Log "학습값 복원 완료: $learnedPath ($size bytes)"
    }
} catch {
    Log "[WARN] 학습값 복원 실패 — 기본값으로 시작 (데몬이 자체 학습 재개)"
}

# ═══════════════════════════════════════════════════════════════════════════
# Step 7/7: 3중 안전망 등록 + 즉시 기동
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [7/7] 3중 안전망 등록 + 기동..." -ForegroundColor Cyan

$daemonScript = "$OrbitDir\start-daemon.ps1"
$daemonContent = @"
# Auto-generated by clean-install v9. Do not edit.
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location '$DIR'

# 중복 실행 방지 — 다른 start-daemon.ps1 이미 돌면 exit (schtasks/lnk/Registry 3중 트리거 대응)
`$me = `$PID
`$siblings = Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    `$_.ProcessId -ne `$me -and `$_.CommandLine -like '*start-daemon.ps1*'
}
if (`$siblings) { exit 0 }

while (`$true) {
    # 이미 personal-agent 실행 중이면 스킵 (PID 락 있지만 이중 방어)
    `$alive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -like '*personal-agent*' }
    if (`$alive) { Start-Sleep -Seconds 10; continue }

    try {
        node daemon\personal-agent.js 2>&1 | ForEach-Object {
            try { `$_ | Out-File -Append -Encoding utf8 -FilePath '$OrbitDir\daemon.log' -ErrorAction SilentlyContinue } catch {}
        }
    } catch {
        try { "`$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [CRASH] `$_" | Out-File -Append -Encoding utf8 -FilePath '$OrbitDir\daemon.log' -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 5
}
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($daemonScript, $daemonContent, $utf8NoBom)

# 안전망 1: Scheduled Task (ONLOGON, Hidden)
# 관리자 권한 필수. Register-ScheduledTask cmdlet 사용 (더 안정적).
try {
    $a = New-ScheduledTaskAction -Execute "powershell.exe" `
         -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonScript`""
    $t = New-ScheduledTaskTrigger -AtLogOn
    $s = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
         -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "OrbitDaemon" -Action $a -Trigger $t -Settings $s -Principal $p -Force -ErrorAction Stop | Out-Null

    # 등록 확인
    $verify = Get-ScheduledTask -TaskName "OrbitDaemon" -ErrorAction SilentlyContinue
    if ($verify) {
        Log "안전망 1/3: schtasks OrbitDaemon 등록 (state=$($verify.State))"
    } else {
        Log "[WARN] 안전망 1/3: schtasks 등록 후 조회 실패 — Registry Run + Startup lnk로 커버"
    }
} catch {
    Log "[WARN] 안전망 1/3 실패 (관리자 권한 필요): $_"
    Log "       Registry Run + Startup lnk 2중으로 자동 기동 보장"
}

# 안전망 2: Startup 바로가기
try {
    $lnkPath = "$startupDir\OrbitDaemon.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = "powershell.exe"
    $lnk.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`""
    $lnk.WindowStyle = 7  # Minimized
    $lnk.Save()
    Log "안전망 2/3: Startup lnk 등록"
} catch {
    Log "[WARN] Startup lnk 실패: $_"
}

# 안전망 3: Registry Run
try {
    $runValue = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`""
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "OrbitDaemon" /t REG_SZ /d $runValue /f 2>&1 | Out-Null
    Log "안전망 3/3: Registry Run 등록"
} catch {
    Log "[WARN] Registry 실패: $_"
}

# 즉시 기동
Log "데몬 기동..."
Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`"" -WindowStyle Hidden

# 10초 대기 + 기동 확인
Start-Sleep -Seconds 10
$daemonAlive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*personal-agent*"
}

Write-Host ""
if ($daemonAlive) {
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ 설치 완료 — 데이터 수집 시작됨" -ForegroundColor Green
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Log "설치 성공 — 데몬 PID: $($daemonAlive.ProcessId -join ',')"
} else {
    Write-Host "  ⚠ 데몬 기동 확인 실패 — 다음 로그인 시 3중 안전망으로 자동 기동" -ForegroundColor Yellow
    Log "[WARN] 즉시 기동 확인 실패 — 안전망 의존"
}

# 서버에 설치 완료 알림 (실패해도 무시)
try {
    $body = @{
        event = "install.complete"
        userId = $userId
        hostname = $env:COMPUTERNAME
        version = "v9-clean"
        timestamp = (Get-Date -f 'o')
    } | ConvertTo-Json
    Invoke-WebRequest -Uri "$REMOTE/api/install/status" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
} catch {}

Write-Host ""
Write-Host "  이 창은 5초 후 자동으로 닫힙니다..." -ForegroundColor Gray
Start-Sleep -Seconds 5
exit 0
