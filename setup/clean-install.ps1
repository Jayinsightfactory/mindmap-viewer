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

function Ensure-OrbitPs1Bom([string]$Path) {
    if (-not (Test-Path $Path)) { return $false }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return $true }
    $text = if ($bytes.Length -gt 0) { [Text.Encoding]::UTF8.GetString($bytes) } else { '' }
    [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding $true))
    return $true
}

function Read-OrbitScriptUtf8([string]$Path) {
    $raw = [IO.File]::ReadAllBytes($Path)
    if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
        return [Text.Encoding]::UTF8.GetString($raw, 3, $raw.Length - 3)
    }
    return [Text.Encoding]::UTF8.GetString($raw)
}

function Test-OrbitScriptContent([string]$Content) {
    if (-not $Content) { return $false }
    $t = $Content.TrimStart()
    if ($t.StartsWith('<') -or $t.StartsWith('{')) { return $false }
    return ($t.StartsWith('#') -or $t.StartsWith('$'))
}

function Write-GuardianScript {
    param([string]$TemplateName, [string]$OutPath, [hashtable]$Replace)
    $candidates = @()
    $p1 = Join-Path $DIR "setup\$TemplateName"
    if (Test-Path $p1) { $candidates += $p1 }
    if ($PSScriptRoot) {
        $p2 = Join-Path $PSScriptRoot $TemplateName
        if (Test-Path $p2) { $candidates += $p2 }
    }
    $content = $null
    foreach ($p in $candidates) {
        try {
            $content = Read-OrbitScriptUtf8 $p
            if (Test-OrbitScriptContent $content) { break }
            $content = $null
        } catch {}
    }
    if (-not $content) {
        try {
            $tmpTpl = Join-Path $env:TEMP ("orbit-tpl-" + $TemplateName)
            Invoke-WebRequest -Uri "$REMOTE/setup/$TemplateName" -OutFile $tmpTpl -UseBasicParsing -TimeoutSec 30 | Out-Null
            Ensure-OrbitPs1Bom $tmpTpl | Out-Null
            $content = Read-OrbitScriptUtf8 $tmpTpl
            if (-not (Test-OrbitScriptContent $content)) {
                Log "[ERROR] Invalid template download: $TemplateName"
                return $false
            }
        } catch {
            Log "[ERROR] Guardian template missing: $TemplateName — $($_.Exception.Message)"
            return $false
        }
    }
    foreach ($key in $Replace.Keys) {
        $content = $content.Replace([string]$key, [string]$Replace[$key])
    }
    $utf8 = New-Object System.Text.UTF8Encoding($true)
    [IO.File]::WriteAllText($OutPath, $content, $utf8)
    Log "Guardian script written: $OutPath"
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

function Register-OrbitSchTask {
    param([string]$Name, [string]$ScriptPath, [string]$Schedule = 'ONLOGON', [int]$MinuteInterval = 0)
    $tr = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
    schtasks /Delete /TN $Name /F 2>$null | Out-Null
    if ($Schedule -eq 'MINUTE' -and $MinuteInterval -gt 0) {
        schtasks /Create /TN $Name /TR $tr /SC MINUTE /MO $MinuteInterval /RL LIMITED /F 2>&1 | Out-Null
    } else {
        schtasks /Create /TN $Name /TR $tr /SC $Schedule /RL LIMITED /F 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -eq 0) { Log "schtasks $Name OK" } else { Log "[WARN] schtasks $Name fail code=$LASTEXITCODE" }
}

Register-OrbitSchTask -Name 'OrbitDaemon' -ScriptPath $daemonScript
Register-OrbitSchTask -Name 'OrbitWatchdog' -ScriptPath $watchdogScript
Register-OrbitSchTask -Name 'OrbitWatchdog30' -ScriptPath $watchdogScript -Schedule 'MINUTE' -MinuteInterval 30

$codeSyncPs1 = "$OrbitDir\code-sync.ps1"
$codeSyncBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location '$DIR'
git remote set-url origin '$REPO' 2>`$null
git fetch origin 2>`$null
git reset --hard origin/main 2>`$null
"@
[IO.File]::WriteAllText($codeSyncPs1, $codeSyncBody, (New-Object System.Text.UTF8Encoding($true)))
Register-OrbitSchTask -Name 'OrbitCodeSync' -ScriptPath $codeSyncPs1 -Schedule 'MINUTE' -MinuteInterval 30

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

# 데몬 기동 대기 (최대 60초, 5초마다 재시도)
function Test-DaemonAlive {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*personal-agent*' }
}
$daemonAlive = $null
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    $daemonAlive = Test-DaemonAlive
    if ($daemonAlive) {
        Log "데몬 기동 확인 (${i}회차) PID: $($daemonAlive.ProcessId -join ',')"
        break
    }
    if ($i -le 3) {
        Log "데몬 미감지 — Guardian 재기동 (${i}/12)"
        Start-Process -FilePath $psExe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`"" -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
}

# 웹 UI 검증 모드 — PowerShell 가이드 스킵
if ($env:ORBIT_WEB_GUIDED -eq '1') {
    Log "Guardian 설치 완료 — 브라우저 검증으로 이동"
    Write-Host ""
    Write-Host "  Guardian 설치 완료. 곧 브라우저 검증 창이 열립니다." -ForegroundColor Green
    exit 0
}

# 가이드 검증 — 데몬 여부와 무관하게 항상 실행 (클릭/키보드/화면 chunk 확인)
$guidedVerified = $false
$guidedPath = Join-Path $DIR "setup\install-guided-verify.ps1"
if (-not (Test-Path $guidedPath)) {
    $guidedPath = Join-Path $env:TEMP "orbit-install-guided-verify.ps1"
    try {
        Invoke-WebRequest -Uri "$REMOTE/setup/install-guided-verify.ps1" -OutFile $guidedPath -UseBasicParsing -TimeoutSec 30 | Out-Null
        Ensure-OrbitPs1Bom $guidedPath | Out-Null
    } catch {
        Log "[WARN] 가이드 스크립트 다운로드 실패: $_"
    }
}
if (Test-Path $guidedPath) {
    try {
        Ensure-OrbitPs1Bom $guidedPath | Out-Null
        . $guidedPath
        if (-not $daemonAlive) {
            Write-Host '  데몬이 아직 안 떴습니다. 가이드 검증을 진행하면서 Guardian이 기동합니다.' -ForegroundColor Yellow
        }
        $verifyAttempt = 0
        while (-not $guidedVerified) {
            $verifyAttempt++
            if ($verifyAttempt -gt 1) {
                Write-Host "  검증 재시도 ($verifyAttempt회차)..." -ForegroundColor Yellow
                if (-not (Test-DaemonAlive)) {
                    Start-Process -FilePath $psExe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$daemonScript`"" -WindowStyle Hidden -ErrorAction SilentlyContinue
                }
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
} else {
    Log "[WARN] 가이드 스크립트 없음"
}
$daemonAlive = Test-DaemonAlive

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
