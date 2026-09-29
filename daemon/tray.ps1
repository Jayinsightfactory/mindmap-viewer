# Orbit AI - 시스템 트레이 애플리케이션
# .NET Windows Forms 기반, npm 패키지 불필요

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 설정 로드 ──────────────────────────────────────────────────────────────────
$defaultDashboardUrl = "https://mindmap-viewer-production-adb2.up.railway.app"
$configPath = Join-Path $env:USERPROFILE ".orbit-config.json"
$dashboardUrl = $defaultDashboardUrl

if (Test-Path $configPath) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.serverUrl) {
      $dashboardUrl = $config.serverUrl
    }
    if ($config.token) { $script:orbitToken = $config.token }
  } catch {
    # config 파싱 실패 시 기본값 사용
  }
}

# ── 트레이 아이콘 생성 ─────────────────────────────────────────────────────────
function New-OrbitIcon {
  # 32x32 비트맵에 파란색 육각형 스타일 아이콘 생성
  $bmp = New-Object System.Drawing.Bitmap(32, 32)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)

  # 파란색 원 배경
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 100, 210))
  $g.FillEllipse($brush, 2, 2, 28, 28)

  # "O" 텍스트 (육각형 대신 가독성 있는 O)
  $font = New-Object System.Drawing.Font("Arial", 14, [System.Drawing.FontStyle]::Bold)
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString("O", $font, $textBrush, [System.Drawing.RectangleF]::new(0, 0, 32, 32), $sf)

  $g.Dispose()
  $brush.Dispose()
  $font.Dispose()
  $textBrush.Dispose()
  $sf.Dispose()

  # Bitmap → Icon 변환
  $iconHandle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  return $icon
}

# ── 데몬 프로세스 관리 ─────────────────────────────────────────────────────────
$script:daemonProcess = $null
$script:isExiting = $false

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentPath = Join-Path $scriptDir "personal-agent.js"

# node.exe 경로 탐색 (설치된 node 또는 로컬 portable node)
function Get-NodePath {
  $localNode = Join-Path (Split-Path -Parent $scriptDir) "node\node.exe"
  if (Test-Path $localNode) { return $localNode }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue   # PS 5.1 호환 (?. 는 PS7 전용)
  if ($nodeCmd) { return $nodeCmd.Source }
  return "node"
}

function Start-Daemon {
  if ($script:isExiting) { return }
  $nodePath = Get-NodePath
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodePath
  $psi.Arguments = "`"$agentPath`""
  $psi.WorkingDirectory = Split-Path -Parent $scriptDir
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.UseShellExecute = $false

  try {
    $script:daemonProcess = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[orbit-tray] 데몬 시작됨 PID=$($script:daemonProcess.Id)"
  } catch {
    Write-Host "[orbit-tray] 데몬 시작 실패: $_"
  }
}

function Stop-Daemon {
  if ($script:daemonProcess -and -not $script:daemonProcess.HasExited) {
    try {
      $script:daemonProcess.Kill()
      $script:daemonProcess.WaitForExit(3000) | Out-Null
    } catch {}
  }
  $script:daemonProcess = $null
}

# ── NotifyIcon 생성 ────────────────────────────────────────────────────────────
$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = New-OrbitIcon
$trayIcon.Text = "Orbit AI"
$trayIcon.Visible = $true

# ── 컨텍스트 메뉴 ─────────────────────────────────────────────────────────────
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# 헤더 (비활성)
$headerItem = New-Object System.Windows.Forms.ToolStripMenuItem
$headerItem.Text = "⬡ Orbit AI"
$headerItem.Enabled = $false
$contextMenu.Items.Add($headerItem) | Out-Null

# 구분선
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$contextMenu.Items.Add($sep1) | Out-Null

# 대시보드 열기
$dashItem = New-Object System.Windows.Forms.ToolStripMenuItem
$dashItem.Text = "대시보드 열기"
$dashItem.Add_Click({
  Start-Process $dashboardUrl
})
$contextMenu.Items.Add($dashItem) | Out-Null

# [2026-09-29] 개인 용무 중 — ~/.orbit/personal-pause-until (ISO) 에 기록. 데몬 privacy-gate 가 그 시각까지 수집 차단
$pauseFile = Join-Path $env:USERPROFILE ".orbit\personal-pause-until"
function Set-PersonalPause([int]$minutes) {
  try {
    New-Item -ItemType Directory -Force (Split-Path -Parent $pauseFile) | Out-Null
    if ($minutes -le 0) {
      Remove-Item $pauseFile -Force -ErrorAction SilentlyContinue
      $trayIcon.ShowBalloonTip(3000, "Orbit AI", "개인 용무 해제 - 업무 기록 재개", [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
      $until = (Get-Date).ToUniversalTime().AddMinutes($minutes).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      [System.IO.File]::WriteAllText($pauseFile, $until)
      $trayIcon.ShowBalloonTip(3000, "Orbit AI", "개인 용무 중 - $minutes 분 동안 수집 멈춤", [System.Windows.Forms.ToolTipIcon]::Info)
    }
  } catch {}
}
$pauseMenu = New-Object System.Windows.Forms.ToolStripMenuItem
$pauseMenu.Text = "개인 용무 중"
$p30 = New-Object System.Windows.Forms.ToolStripMenuItem; $p30.Text = "30분 멈춤"; $p30.Add_Click({ Set-PersonalPause 30 })
$p60 = New-Object System.Windows.Forms.ToolStripMenuItem; $p60.Text = "1시간 멈춤"; $p60.Add_Click({ Set-PersonalPause 60 })
$p0 = New-Object System.Windows.Forms.ToolStripMenuItem; $p0.Text = "해제"; $p0.Add_Click({ Set-PersonalPause 0 })
$pauseMenu.DropDownItems.Add($p30) | Out-Null
$pauseMenu.DropDownItems.Add($p60) | Out-Null
$pauseMenu.DropDownItems.Add($p0) | Out-Null
$contextMenu.Items.Add($pauseMenu) | Out-Null

# 내 수집 내역 보기 — 대시보드 열기와 같은 방식(Start-Process) + 본인 토큰
$privItem = New-Object System.Windows.Forms.ToolStripMenuItem
$privItem.Text = "내 수집 내역 보기"
$privItem.Add_Click({
  $u = $dashboardUrl.TrimEnd('/') + "/my-privacy.html"
  if ($script:orbitToken) { $u = $u + "?token=" + [uri]::EscapeDataString($script:orbitToken) }
  Start-Process $u
})
$contextMenu.Items.Add($privItem) | Out-Null

# 재시작
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "재시작"
$restartItem.Add_Click({
  Stop-Daemon
  Start-Sleep -Milliseconds 500
  Start-Daemon
  $trayIcon.ShowBalloonTip(3000, "Orbit AI", "Orbit AI 재시작됨", [System.Windows.Forms.ToolTipIcon]::Info)
})
$contextMenu.Items.Add($restartItem) | Out-Null

# 구분선
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$contextMenu.Items.Add($sep2) | Out-Null

# 종료
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "종료"
$exitItem.Add_Click({
  $script:isExiting = $true
  Stop-Daemon
  $trayIcon.Visible = $false
  $trayIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($exitItem) | Out-Null

$trayIcon.ContextMenuStrip = $contextMenu

# ── 더블클릭 = 대시보드 열기 ──────────────────────────────────────────────────
$trayIcon.Add_DoubleClick({
  Start-Process $dashboardUrl
})

# ── 데몬 모니터링 타이머 ───────────────────────────────────────────────────────
$monitorTimer = New-Object System.Windows.Forms.Timer
$monitorTimer.Interval = 5000  # 5초마다 체크

$script:deadCount = 0
$monitorTimer.Add_Tick({
  if ($script:isExiting) { return }
  if ($script:daemonProcess -eq $null -or $script:daemonProcess.HasExited) {
    $script:deadCount++
    # 2번 연속 체크 후 재시작 (5초 * 2 = 10초 대기 — UI 스레드 블록 없음)
    if ($script:deadCount -ge 2) {
      $script:deadCount = 0
      Write-Host "[orbit-tray] 데몬 재시작..."
      Start-Daemon
      $trayIcon.ShowBalloonTip(3000, "Orbit AI", "Orbit AI 재시작됨", [System.Windows.Forms.ToolTipIcon]::Info)
    }
  } else {
    $script:deadCount = 0
  }
})
$monitorTimer.Start()

# ── 데몬 시작 ─────────────────────────────────────────────────────────────────
Start-Daemon

# ── 시작 알림 ─────────────────────────────────────────────────────────────────
$trayIcon.ShowBalloonTip(3000, "Orbit AI", "Orbit AI 백그라운드 실행 중", [System.Windows.Forms.ToolTipIcon]::Info)

# ── 메시지 루프 ───────────────────────────────────────────────────────────────
[System.Windows.Forms.Application]::Run()
