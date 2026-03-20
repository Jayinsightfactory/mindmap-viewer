# ═══════════════════════════════════════════════════════════════
# Orbit AI — Windows 삭제 스크립트
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Red
Write-Host "  ║   Orbit AI 삭제                       ║" -ForegroundColor Red
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Red
Write-Host ""

# ── 1. 현재 상태 확인 ────────────────────────────────────────
Write-Host "  [1/5] 현재 상태 확인 중..." -ForegroundColor Cyan
Write-Host "  사용자: $env:USERNAME" -ForegroundColor Gray
Write-Host "  홈 경로: $env:USERPROFILE" -ForegroundColor Gray

$orbitDir = "$env:USERPROFILE\.orbit"
$configFile = "$env:USERPROFILE\.orbit-config.json"
$projectDir = "$env:USERPROFILE\mindmap-viewer"
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"

$found = @()
if (Test-Path $orbitDir) { $found += ".orbit 폴더"; Write-Host "  [O] $orbitDir" -ForegroundColor Green }
else { Write-Host "  [X] $orbitDir (없음)" -ForegroundColor DarkGray }

if (Test-Path $configFile) { $found += "설정 파일"; Write-Host "  [O] $configFile" -ForegroundColor Green }
else { Write-Host "  [X] $configFile (없음)" -ForegroundColor DarkGray }

if (Test-Path $projectDir) { $found += "프로젝트 폴더"; Write-Host "  [O] $projectDir" -ForegroundColor Green }
else { Write-Host "  [X] $projectDir (없음)" -ForegroundColor DarkGray }

$startupBat = "$startupDir\orbit-daemon.bat"
$startupVbs = "$startupDir\orbit-daemon.vbs"
if (Test-Path $startupBat) { $found += "Startup bat"; Write-Host "  [O] $startupBat" -ForegroundColor Green }
if (Test-Path $startupVbs) { $found += "Startup vbs"; Write-Host "  [O] $startupVbs" -ForegroundColor Green }
if (-not (Test-Path $startupBat) -and -not (Test-Path $startupVbs)) {
  Write-Host "  [X] Startup 파일 (없음)" -ForegroundColor DarkGray
}

# 다른 사용자 폴더도 확인
$allUsers = Get-ChildItem "C:\Users" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Public|Default|All Users' }
$otherFound = @()
foreach ($u in $allUsers) {
  $uOrbit = Join-Path $u.FullName ".orbit"
  $uProject = Join-Path $u.FullName "mindmap-viewer"
  if ((Test-Path $uOrbit) -or (Test-Path $uProject)) {
    if ($u.FullName -ne $env:USERPROFILE) {
      $otherFound += $u.Name
      Write-Host "  [O] $($u.Name) 계정에도 설치됨" -ForegroundColor Yellow
    }
  }
}

Write-Host ""
if ($found.Count -eq 0 -and $otherFound.Count -eq 0) {
  Write-Host "  설치된 항목이 없습니다." -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

Write-Host "  발견: $($found -join ', ')" -ForegroundColor White
if ($otherFound.Count -gt 0) {
  Write-Host "  다른 계정: $($otherFound -join ', ')" -ForegroundColor Yellow
}
Write-Host ""

# ── 2. 확인 ──────────────────────────────────────────────────
$confirm = Read-Host "  삭제하시겠습니까? (y/n)"
if ($confirm -ne 'y' -and $confirm -ne 'Y') {
  Write-Host "  취소됨." -ForegroundColor Gray
  exit 0
}

# ── 3. 데몬 프로세스 종료 ────────────────────────────────────
Write-Host ""
Write-Host "  [2/5] 데몬 프로세스 종료..." -ForegroundColor Cyan
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($nodeProcs) {
  foreach ($p in $nodeProcs) {
    try {
      $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
      if ($cmdLine -match "personal-agent|orbit|daemon") {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  종료: PID $($p.Id)" -ForegroundColor Green
      }
    } catch {}
  }
} else {
  Write-Host "  실행 중인 데몬 없음" -ForegroundColor DarkGray
}

# ── 4. Startup 제거 ──────────────────────────────────────────
Write-Host "  [3/5] Startup 자동 실행 제거..." -ForegroundColor Cyan
@($startupBat, $startupVbs) | ForEach-Object {
  if (Test-Path $_) { Remove-Item $_ -Force; Write-Host "  삭제: $_" -ForegroundColor Green }
}

# ── 5. 폴더/파일 삭제 ────────────────────────────────────────
Write-Host "  [4/5] 파일 삭제..." -ForegroundColor Cyan

# 현재 사용자
if (Test-Path $orbitDir) { Remove-Item $orbitDir -Recurse -Force; Write-Host "  삭제: $orbitDir" -ForegroundColor Green }
if (Test-Path $configFile) { Remove-Item $configFile -Force; Write-Host "  삭제: $configFile" -ForegroundColor Green }
if (Test-Path $projectDir) { Remove-Item $projectDir -Recurse -Force; Write-Host "  삭제: $projectDir" -ForegroundColor Green }

# 다른 사용자 계정도 삭제 (관리자 권한 필요)
foreach ($u in $otherFound) {
  $uHome = "C:\Users\$u"
  $paths = @("$uHome\.orbit", "$uHome\.orbit-config.json", "$uHome\mindmap-viewer")
  foreach ($p in $paths) {
    if (Test-Path $p) {
      try { Remove-Item $p -Recurse -Force; Write-Host "  삭제: $p" -ForegroundColor Green }
      catch { Write-Host "  실패: $p (권한 부족)" -ForegroundColor Red }
    }
  }
  # 다른 사용자의 Startup도
  $uStartup = "$uHome\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
  @("$uStartup\orbit-daemon.bat", "$uStartup\orbit-daemon.vbs") | ForEach-Object {
    if (Test-Path $_) { try { Remove-Item $_ -Force; Write-Host "  삭제: $_" -ForegroundColor Green } catch {} }
  }
}

# ── 6. 완료 ──────────────────────────────────────────────────
Write-Host ""
Write-Host "  [5/5] 삭제 완료" -ForegroundColor Green
Write-Host ""
Write-Host "  ✅ Orbit AI가 완전히 제거되었습니다." -ForegroundColor Green
Write-Host ""
