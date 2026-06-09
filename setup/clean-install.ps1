# ═══════════════════════════════════════════════════════════════════════════
# Orbit AI — Clean Install (v12 = 2-program Guardian + Worker)
# ═══════════════════════════════════════════════════════════════════════════
# v12: Guardian(절대 안 죽음) + Worker(명령·수집) 분리
#   Guardian: start-daemon.ps1 + watchdog.ps1 + OrbitWatchdog + OrbitCodeSync
#   Worker: personal-agent.js (죽어도 Guardian이 재시작)
#   reinstall → git pull만 (install.ps1 spawn 금지)
#
# 원칙:
#   1. 수집 연속성 제1원칙 — 학습값(capture-config.json)은 서버에서 복원
#   2. Guardian 3종 — OrbitDaemon + OrbitWatchdog + OrbitCodeSync
#   3. TTL 없는 영구 플래그 금지 (.safe-mode 등 생성 안 함)
#   4. 4중 안전망 — schtasks + Startup lnk + Registry Run + watchdog-loop
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

function Write-GuardianScript {
    param([string]$TemplateName, [string]$OutPath, [hashtable]$Replace)
    $candidates = @(
        (Join-Path $DIR "setup\$TemplateName"),
        (if ($PSScriptRoot) { Join-Path $PSScriptRoot $TemplateName } else { $null })
    ) | Where-Object { $_ -and (Test-Path $_) }
    $content = $null
    foreach ($p in $candidates) {
        try { $content = [IO.File]::ReadAllText($p); break } catch {}
    }
    if (-not $content) {
        try {
            $content = (Invoke-WebRequest -Uri "$REMOTE/setup/$TemplateName" -UseBasicParsing -TimeoutSec 30).Content
        } catch {
            Log "[ERROR] Guardian template missing: $TemplateName"
            return $false
        }
    }
    foreach ($key in $Replace.Keys) {
        $content = $content.Replace([string]$key, [string]$Replace[$key])
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutPath, $content, $utf8)
    return $true
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

# 로그 파일 초기화 (UTF-8 NoBOM — Log 함수와 인코딩 일치, cmd 깨짐 방지)
$_initLine = "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] clean-install v11`r`n"
[IO.File]::WriteAllText($LOG, $_initLine, (New-Object System.Text.UTF8Encoding($false)))

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
foreach ($task in @("OrbitDaemon","OrbitWatchdog","OrbitCodeSync","OrbitTracker")) {
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

# (1) userId: ORBIT_USER_ID env → hostname 서버 매칭 → 임시값
#     token: ORBIT_TOKEN env (bat/설치 UI에서 주입) → config 저장 + link-pc
$configPath = "$env:USERPROFILE\.orbit-config.json"
$cfgToken = if ($env:ORBIT_TOKEN -and $env:ORBIT_TOKEN.Length -gt 5) { $env:ORBIT_TOKEN } else { "" }
$matchedUserId = if ($env:ORBIT_USER_ID -and $env:ORBIT_USER_ID.Length -gt 5) { $env:ORBIT_USER_ID } else { "pc_$env:COMPUTERNAME" }

if (-not ($env:ORBIT_USER_ID -and $env:ORBIT_USER_ID.Length -gt 5)) {
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
} else {
    Log "ORBIT_USER_ID 사용: $matchedUserId"
}

$configObj = @{
    serverUrl = $REMOTE
    hostname  = $env:COMPUTERNAME
    userId    = $matchedUserId
    installedAt = (Get-Date -f 'o')
}
if ($cfgToken) { $configObj.token = $cfgToken }
$config = $configObj | ConvertTo-Json

if ($cfgToken -and $env:COMPUTERNAME) {
    try {
        $linkBody = @{ hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
        $linkRes = Invoke-RestMethod -Uri "$REMOTE/api/daemon/link-pc" -Method Post `
            -Headers @{ Authorization = "Bearer $cfgToken"; 'Content-Type' = 'application/json' } `
            -Body $linkBody -TimeoutSec 10 -ErrorAction Stop
        Log "link-pc 성공: $($linkRes.name)"
    } catch {
        Log "[WARN] link-pc 실패: $($_.Exception.Message)"
    }
}

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
# Step 7/7: Guardian 등록 + Worker 기동
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "  [7/7] Guardian 등록 + Worker 기동..." -ForegroundColor Cyan

$daemonScript = "$OrbitDir\start-daemon.ps1"
$watchdogScript = "$OrbitDir\watchdog.ps1"
$nodePathForTpl = try { (Get-Command node -ErrorAction Stop).Source } catch { '' }
$sdOk = Write-GuardianScript 'guardian-start-daemon.ps1' $daemonScript @{
    '__ORBIT_REMOTE__' = $REMOTE
    '__ORBIT_DIR__'    = $DIR
    '__NODE_EXE__'     = $nodePathForTpl
}
$wdOk = Write-GuardianScript 'guardian-watchdog.ps1' $watchdogScript @{
    '__ORBIT_REMOTE__' = $REMOTE
}
if (-not ($sdOk -and $wdOk)) {
    Log "[ERROR] Guardian script generation failed"
    PauseExit 1
}
Log "Guardian scripts: start-daemon + watchdog"

# watchdog-loop: Registry Run 백업용 (schtasks 실패 시에도 30분 polling)
$wdLoopPath = "$OrbitDir\watchdog-loop.ps1"
$wdLoopBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
while (`$true) {
  try { & '$watchdogScript' } catch {}
  Start-Sleep -Seconds 1800
}
"@
[IO.File]::WriteAllText($wdLoopPath, $wdLoopBody, (New-Object System.Text.UTF8Encoding($false)))

$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }
$taskSettings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# OrbitDaemon — Worker supervisor loop
try {
    $actDaemon = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonScript`""
    $trigDaemon = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "OrbitDaemon" -Action $actDaemon -Trigger $trigDaemon -Settings $taskSettings -Principal $taskPrincipal -Force -ErrorAction Stop | Out-Null
    Log "schtasks OrbitDaemon (Guardian worker loop)"
} catch {
    Log "[WARN] OrbitDaemon schtasks 실패: $_"
}

# OrbitWatchdog — immortal supervisor (commands + crash recovery)
try {
    $actWatch = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogScript`""
    $trigWatch = @(
        (New-ScheduledTaskTrigger -AtLogOn),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue))
    )
    Register-ScheduledTask -TaskName "OrbitWatchdog" -Action $actWatch -Trigger $trigWatch -Settings $taskSettings -Principal $taskPrincipal -Force -ErrorAction Stop | Out-Null
    Log "schtasks OrbitWatchdog (30min + logon)"
} catch {
    Log "[WARN] OrbitWatchdog schtasks 실패: $_"
}

# OrbitCodeSync — git pull even if Worker + Guardian loop both dead
try {
    $codeSyncCmd = "cd `"$DIR`"; git remote set-url origin '$REPO' 2>`$null; git fetch origin 2>`$null; git reset --hard origin/main 2>`$null"
    $actSync = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$codeSyncCmd`""
    $trigSync = @(
        (New-ScheduledTaskTrigger -AtLogOn),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue))
    )
    Register-ScheduledTask -TaskName "OrbitCodeSync" -Action $actSync -Trigger $trigSync -Settings $taskSettings -Principal $taskPrincipal -Force -ErrorAction Stop | Out-Null
    Log "schtasks OrbitCodeSync (30min git pull)"
} catch {
    Log "[WARN] OrbitCodeSync schtasks 실패: $_"
}

# Startup lnk — OrbitDaemon
try {
    $lnkPath = "$startupDir\OrbitDaemon.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = $psExe
    $lnk.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`""
    $lnk.WindowStyle = 7
    $lnk.Save()
    Log "Startup lnk OrbitDaemon"
} catch {
    Log "[WARN] Startup lnk 실패: $_"
}

# Registry Run — Daemon + Watchdog loop
try {
    $runDaemon = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`""
    $runWatch  = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$wdLoopPath`""
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "OrbitDaemon" /t REG_SZ /d $runDaemon /f 2>&1 | Out-Null
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "OrbitWatchdog" /t REG_SZ /d $runWatch /f 2>&1 | Out-Null
    Log "Registry Run OrbitDaemon + OrbitWatchdog"
} catch {
    Log "[WARN] Registry 실패: $_"
}

# 즉시 기동 — Guardian loop + Watchdog 1회 실행
Log "Guardian + Worker 기동..."
Start-Process -FilePath $psExe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`"" -WindowStyle Hidden
Start-Process -FilePath $psExe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$watchdogScript`"" -WindowStyle Hidden

# 10초 대기 + 기동 확인
Start-Sleep -Seconds 10
$daemonAlive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*personal-agent*"
}

# 가이드 검증 — 데몬 데이터 서버 수신 확인될 때까지 반복 (통과 시에만 설치 종료)
$guidedVerified = $false
if ($daemonAlive) {
    $guidedPath = Join-Path $PSScriptRoot "install-guided-verify.ps1"
    if (-not (Test-Path $guidedPath)) {
        $guidedPath = Join-Path $DIR "setup\install-guided-verify.ps1"
    }
    if (-not (Test-Path $guidedPath)) {
        try {
            $gc = (Invoke-WebRequest -Uri "$REMOTE/setup/install-guided-verify.ps1" -UseBasicParsing -TimeoutSec 30).Content
            New-Item -ItemType Directory -Force -Path (Split-Path $guidedPath) | Out-Null
            [System.IO.File]::WriteAllText($guidedPath, $gc, [System.Text.UTF8Encoding]::new($false))
        } catch {}
    }
    if (Test-Path $guidedPath) {
        try {
            . $guidedPath
            $verifyAttempt = 0
            while (-not $guidedVerified) {
                $verifyAttempt++
                if ($verifyAttempt -gt 1) {
                    Write-Host "  검증 재시도 ($verifyAttempt회차)..." -ForegroundColor Yellow
                }
                $g = Invoke-OrbitGuidedInstallVerify -Remote $REMOTE
                $guidedVerified = $g.verified
                if (-not $guidedVerified) {
                    Write-Host "  서버에 데몬 데이터 미확인 — Enter=재시도 / Q=중단" -ForegroundColor Yellow
                    $ans = Read-Host "  "
                    if ($ans -match '^[qQ]') { break }
                }
            }
            if ($guidedVerified) { Log "가이드 검증 통과" } else { Log "[WARN] 가이드 검증 실패" }
        } catch {
            Log "[WARN] 가이드 검증 오류: $_"
        }
    }
}

Write-Host ""
if ($daemonAlive -and $guidedVerified) {
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ 설치 + 검증 완료 — 실제 chunk 수신 확인됨" -ForegroundColor Green
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Log "설치+검증 성공 — 데몬 PID: $($daemonAlive.ProcessId -join ',')"
} elseif ($daemonAlive) {
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  ⚠ 데몬 기동됨 — 가이드 검증 미완료 (클릭→붙여넣기→Enter 다시 시도)" -ForegroundColor Yellow
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Yellow
    Log "데몬 OK, 가이드 검증 미완료"
} else {
    Write-Host "  ⚠ 데몬 기동 확인 실패 — 다음 로그인 시 3중 안전망으로 자동 기동" -ForegroundColor Yellow
    Log "[WARN] 즉시 기동 확인 실패 — 안전망 의존"
}

# 서버에 설치 완료 알림 — 검증 통과 시에만
if ($guidedVerified) {
    try {
        $body = @{
            event = "install.complete"
            userId = $matchedUserId
            hostname = $env:COMPUTERNAME
            version = "v12-guardian"
            verified = $true
            verifyMode = "guided"
            timestamp = (Get-Date -f 'o')
        } | ConvertTo-Json
        Invoke-WebRequest -Uri "$REMOTE/api/install/status" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
    } catch {}
    Write-Host ""
    Write-Host "  이 창은 5초 후 자동으로 닫힙니다..." -ForegroundColor Gray
    Start-Sleep -Seconds 5
    exit 0
}

Write-Host ""
Write-Host "  설치 미완료 — 데몬 데이터 검증 후 자동 종료됩니다." -ForegroundColor Red
Write-Host "  Enter를 누르면 닫습니다." -ForegroundColor Gray
try { Read-Host } catch {}
exit 1
