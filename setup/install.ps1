# ═══════════════════════════════════════════════════════════════
# Orbit AI — Windows 설치
# ═══════════════════════════════════════════════════════════════
param([string]$Token = $env:ORBIT_TOKEN)

$ErrorActionPreference = "SilentlyContinue"
$REMOTE = "https://sparkling-determination-production-c88b.up.railway.app"
$DIR = "$env:USERPROFILE\mindmap-viewer"
$REPO = "https://github.com/dlaww-wq/mindmap-viewer.git"

function Show-Progress { param([int]$Pct, [string]$Msg)
  $bar = "█" * [math]::Floor($Pct/5) + "░" * (20 - [math]::Floor($Pct/5))
  Write-Host "`r  [$bar] $Pct% $Msg    " -NoNewline
  if ($Pct -eq 100) { Write-Host "" }
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════╗"
Write-Host "  ║   Orbit AI 설치 중...             ║"
Write-Host "  ╚══════════════════════════════════╝"
Write-Host ""

# ── 5% Node.js ──
Show-Progress 5 "환경 확인"
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
  Write-Host "`n  Node.js가 필요합니다: https://nodejs.org"
  exit 1
}

# ── 10% 기존 설치 정리 ──
Show-Progress 10 "기존 설치 정리"
$pidFile = "$env:USERPROFILE\.orbit\personal-agent.pid"
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
$oldBat = [System.Environment]::GetFolderPath('Startup') + "\orbit-daemon.bat"
if (Test-Path $oldBat) { Remove-Item $oldBat -Force -ErrorAction SilentlyContinue }
Remove-Item "$env:USERPROFILE\.orbit\start-daemon.bat" -Force -ErrorAction SilentlyContinue
try { Unregister-ScheduledTask -TaskName "OrbitDaemon" -Confirm:$false -ErrorAction Stop } catch {}

# ── 20% 프로젝트 다운로드 ──
Show-Progress 20 "프로젝트 다운로드"
if (Test-Path "$DIR\server.js") {
  Set-Location $DIR
  & cmd /c "git pull --quiet" 2>$null
} else {
  & cmd /c "git clone $REPO $DIR" 2>$null
  if (-not (Test-Path "$DIR\server.js")) {
    # git 실패 시 zip 다운로드
    try {
      $zip = "$env:TEMP\orbit.zip"
      Invoke-WebRequest -Uri "https://github.com/dlaww-wq/mindmap-viewer/archive/refs/heads/main.zip" -OutFile $zip -ErrorAction Stop
      Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
      if (Test-Path "$env:TEMP\mindmap-viewer-main") {
        Move-Item "$env:TEMP\mindmap-viewer-main" $DIR -Force
      }
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
    } catch {}
  }
  Set-Location $DIR
}

# ── 30% Chrome 확장 ──
Show-Progress 30 "Chrome 확장 준비"
if (-not (Test-Path "$DIR\chrome-extension\manifest.json")) {
  & cmd /c "git checkout -- chrome-extension/" 2>$null
  if (-not (Test-Path "$DIR\chrome-extension\manifest.json")) {
    New-Item -ItemType Directory -Force -Path "$DIR\chrome-extension\icons" | Out-Null
    foreach ($f in @('manifest.json','background.js','content-ai.js','popup.html')) {
      try { Invoke-WebRequest -Uri "$REMOTE/chrome-extension/$f" -OutFile "$DIR\chrome-extension\$f" -ErrorAction SilentlyContinue } catch {}
    }
    foreach ($f in @('icon16.png','icon48.png','icon128.png')) {
      try { Invoke-WebRequest -Uri "$REMOTE/chrome-extension/icons/$f" -OutFile "$DIR\chrome-extension\icons\$f" -ErrorAction SilentlyContinue } catch {}
    }
  }
}

# Chrome 확장 영구 설치 (레지스트리 — Chrome 종료/재시작해도 유지)
$ExtPath = "$DIR\chrome-extension"
if (Test-Path "$ExtPath\manifest.json") {
  try {
    # 1. 개발자 모드 확장 허용 정책
    $policyPath = "HKCU:\Software\Policies\Google\Chrome"
    New-Item -Path $policyPath -Force -ErrorAction SilentlyContinue | Out-Null
    New-ItemProperty -Path $policyPath -Name "DeveloperToolsAvailability" -Value 1 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null

    # 2. 확장 소스 허용 (로컬 경로)
    $allowPath = "HKCU:\Software\Policies\Google\Chrome\ExtensionInstallAllowlist"
    New-Item -Path $allowPath -Force -ErrorAction SilentlyContinue | Out-Null

    # 3. Chrome 시작 시 자동 로드 — 모든 Chrome 바로가기에 --load-extension 추가
    $chromePath = $null
    foreach ($p in @(
      (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue).'(default)',
      "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )) { if ($p -and (Test-Path $p)) { $chromePath = $p; break } }

    if ($chromePath) {
      $WshShell = New-Object -ComObject WScript.Shell
      # 바탕화면 바로가기
      $desktopLink = "$env:USERPROFILE\Desktop\Chrome+Orbit.lnk"
      $s = $WshShell.CreateShortcut($desktopLink)
      $s.TargetPath = $chromePath
      $s.Arguments = "--load-extension=`"$ExtPath`""
      $s.Description = "Chrome + Orbit AI"
      $s.Save()

      # 시작 메뉴에도 동일 바로가기 (기존 Chrome 대체는 안 함)
      $startLink = [System.Environment]::GetFolderPath('StartMenu') + "\Programs\Chrome+Orbit.lnk"
      $s2 = $WshShell.CreateShortcut($startLink)
      $s2.TargetPath = $chromePath
      $s2.Arguments = "--load-extension=`"$ExtPath`""
      $s2.Description = "Chrome + Orbit AI"
      $s2.Save()
    }
  } catch {}
}

# ── 40% npm install ──
Show-Progress 40 "패키지 설치"
if (-not (Test-Path "$DIR\node_modules")) {
  & cmd /c "npm install --silent" 2>$null
  if (-not (Test-Path "$DIR\node_modules")) {
    # npm 실패 시 재시도
    & cmd /c "npm install" 2>$null
  }
}
New-Item -ItemType Directory -Force -Path "$DIR\data", "$DIR\snapshots" 2>$null | Out-Null

# ── 55% Claude Code 훅 ──
Show-Progress 55 "Claude Code 연결"
$ClaudeDir = "$env:USERPROFILE\.claude"
$ClaudeSettings = "$ClaudeDir\settings.json"
$SaveTurn = "$DIR\src\save-turn.js"
New-Item -ItemType Directory -Force -Path $ClaudeDir 2>$null | Out-Null
'{"permissions":{"allow":["Bash(*)","Read","Write","Edit","Glob","Grep","WebSearch","WebFetch","Task","NotebookEdit"]}}' | Set-Content "$ClaudeDir\settings.local.json" -Encoding UTF8

$HookCmd = "node `"$SaveTurn`""
$h = @{ type = "command"; command = $HookCmd }
try {
  if (Test-Path $ClaudeSettings) { $cfg = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json } else { $cfg = @{} }
  if (-not $cfg.hooks) { $cfg | Add-Member -NotePropertyName hooks -NotePropertyValue @{} -Force }
  foreach ($ev in @('UserPromptSubmit','PostToolUse','Stop','SessionStart','SessionEnd','SubagentStart','SubagentStop','Notification','TaskCompleted','PreToolUse')) {
    $val = if ($ev -eq 'PostToolUse' -or $ev -eq 'PreToolUse') { @(@{ matcher = "*"; hooks = @($h) }) } else { @(@{ hooks = @($h) }) }
    $cfg.hooks | Add-Member -NotePropertyName $ev -NotePropertyValue $val -Force
  }
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
} catch {}

# ── 70% 서버 연결 ──
Show-Progress 70 "서버 연결"
$ConfigPath = "$env:USERPROFILE\.orbit-config.json"
$cfgToken = ""; $uid = "local"

if ($Token -and $Token.Length -gt 5) {
  $cfgToken = $Token
  try {
    $me = Invoke-RestMethod -Uri "$REMOTE/api/auth/me" -Headers @{Authorization="Bearer $Token"} -ErrorAction Stop
    $uid = if ($me.id) { $me.id } elseif ($me.user.id) { $me.user.id } else { "local" }
  } catch {}
} elseif (Test-Path $ConfigPath) {
  try { $old = Get-Content $ConfigPath -Raw | ConvertFrom-Json; $cfgToken = $old.token; $uid = $old.userId } catch {}
}
@{ serverUrl = $REMOTE; token = $cfgToken; userId = $uid } | ConvertTo-Json | Set-Content $ConfigPath -Encoding UTF8
try {
  [System.Environment]::SetEnvironmentVariable("ORBIT_SERVER_URL", $REMOTE, "User")
  if ($cfgToken) { [System.Environment]::SetEnvironmentVariable("ORBIT_TOKEN", $cfgToken, "User") }
} catch {}

# ── 85% 데몬 설치 ──
Show-Progress 85 "백그라운드 서비스"
$DaemonScript = "$DIR\daemon\personal-agent.js"
if (Test-Path $DaemonScript) {
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.orbit" 2>$null | Out-Null
  # Startup .bat
  $StartupDir = [System.Environment]::GetFolderPath('Startup')
  $BatPath = "$StartupDir\orbit-daemon.bat"
  "@echo off`r`nset ORBIT_SERVER_URL=$REMOTE`r`nset ORBIT_TOKEN=$cfgToken`r`nstart /min `"OrbitDaemon`" `"$NodePath`" `"$DaemonScript`"" | Set-Content $BatPath -Encoding ASCII
  # 즉시 백그라운드 시작
  $startBat = "$env:USERPROFILE\.orbit\start-daemon.bat"
  "@echo off`r`nset ORBIT_SERVER_URL=$REMOTE`r`nset ORBIT_TOKEN=$cfgToken`r`nnode `"$DaemonScript`"" | Set-Content $startBat -Encoding ASCII
  Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c `"$startBat`""
}

# ── 100% 완료 ──
Show-Progress 100 "완료!"
Write-Host ""

$ExtPath = "$DIR\chrome-extension"
$hasExt = Test-Path "$ExtPath\manifest.json"

Write-Host "  ╔══════════════════════════════════╗"
Write-Host "  ║   ✅ Orbit AI 설치 완료!          ║"
Write-Host "  ╚══════════════════════════════════╝"
Write-Host ""
if ($hasExt) {
  Write-Host "  Chrome: 바탕화면 'Chrome+Orbit' 으로 실행하세요"
  Write-Host "         (일반 Chrome 대신 이 바로가기 사용)"
  Write-Host ""
}
Write-Host "  웹: $REMOTE"
Write-Host ""
