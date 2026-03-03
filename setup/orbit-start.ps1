# ═══════════════════════════════════════════════════════════════
# Orbit AI — 원클릭 시작 (Windows PowerShell)
# ───────────────────────────────────────────────────────────────
# PowerShell에 아래 전체를 복붙하세요. 외부 URL 불필요.
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Orbit AI -- 원클릭 시작" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ── Node.js 확인 ──
$n = $null
try { $n = (Get-Command node -EA SilentlyContinue).Source } catch {}
if (-not $n) {
  $nvm = "$env:APPDATA\nvm"
  if (Test-Path $nvm) {
    $v = Get-ChildItem $nvm -Dir -EA SilentlyContinue | Sort Name -Desc | Select -First 1
    if ($v) { $n = "$($v.FullName)\node.exe" }
  }
}
if (-not $n) { Write-Host "Node.js 없음. https://nodejs.org 설치 필요" -ForegroundColor Red; return }
Write-Host "Node.js: $(& $n --version)" -ForegroundColor Green

# ── [1/4] 퍼미션 ──
Write-Host "`n[1/4] 퍼미션 설정..." -ForegroundColor Cyan
$cd = "$env:USERPROFILE\.claude"
if (!(Test-Path $cd)) { New-Item -ItemType Directory $cd -Force | Out-Null }
@'
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Task", "NotebookEdit",
      "mcp__Claude_in_Chrome__*", "mcp__Claude_Preview__*", "mcp__mcp-registry__*"
    ]
  }
}
'@ | Set-Content "$cd\settings.local.json" -Encoding UTF8
Write-Host "  퍼미션 완료" -ForegroundColor Green

# ── [2/4] 프로젝트 ──
Write-Host "`n[2/4] 프로젝트 준비..." -ForegroundColor Cyan
$pd = "$env:USERPROFILE\mindmap-viewer"
if ((Test-Path ".\server.js") -and (Test-Path ".\save-turn.js")) {
  $pd = (Get-Location).Path
} elseif (Test-Path "$pd\server.js") {
  Set-Location $pd; try { & git pull --quiet 2>$null } catch {}
} else {
  & git clone "https://github.com/dlaww-wq/mindmap-viewer.git" $pd; Set-Location $pd
}
Set-Location $pd
if (!(Test-Path "node_modules")) { Write-Host "  npm install..."; & npm install --silent }
"data","snapshots" | % { New-Item -ItemType Directory -Force $_ | Out-Null }
Write-Host "  프로젝트 준비 완료: $pd" -ForegroundColor Green

# ── [3/4] 훅 등록 ──
Write-Host "`n[3/4] 훅 등록..." -ForegroundColor Cyan
$st = (Join-Path $pd "save-turn.js") -replace "\\","/"
$hc = "node `"$st`""
$he = @{ type = "command"; command = $hc }
$ha = @(@{ hooks = @($he) })
$hm = @(@{ matcher = "*"; hooks = @($he) })
$s = @{
  autoUpdatesChannel = "latest"
  hooks = @{
    UserPromptSubmit = $ha; PreToolUse = $hm; PostToolUse = $hm
    Stop = $ha; SessionStart = $ha; SessionEnd = $ha
    SubagentStart = $ha; SubagentStop = $ha
    Notification = $ha; TaskCompleted = $ha
  }
}
if (Test-Path "$cd\settings.json") {
  $bk = "settings.json.bak." + (Get-Date -Format "yyyyMMdd-HHmmss")
  Copy-Item "$cd\settings.json" "$cd\$bk" -EA SilentlyContinue
}
$s | ConvertTo-Json -Depth 5 | Set-Content "$cd\settings.json" -Encoding UTF8
Write-Host "  10개 훅 등록 완료" -ForegroundColor Green

# ── [4/4] 서버 시작 ──
Write-Host "`n[4/4] 서버 시작..." -ForegroundColor Cyan
$up = $false
try { Invoke-WebRequest "http://localhost:4747/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true } catch {}
if ($up) { Write-Host "  이미 실행 중" -ForegroundColor Green }
else { Start-Process $n "server.js" -WorkingDirectory $pd -WindowStyle Hidden; Start-Sleep 2; Write-Host "  서버 시작됨" -ForegroundColor Green }
Start-Process "http://localhost:4747"

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  완료! http://localhost:4747" -ForegroundColor Green
Write-Host "  이제 claude 실행하면 퍼미션 없이 진행됩니다" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
