# ═══════════════════════════════════════════════════════════════
# Orbit AI — 작업 완료 후 백업 (Git + Google Drive)
# ───────────────────────────────────────────────────────────────
# PowerShell에 복붙:
#   irm https://raw.githubusercontent.com/Jayinsightfactory/mindmap-viewer/main/setup/orbit-backup.ps1 | iex
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Orbit AI -- 백업 (Git + Drive)" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ── 프로젝트 찾기 ──
$pd = $null
if ((Test-Path ".\server.js") -and (Test-Path ".\package.json")) {
  $pd = (Get-Location).Path
} elseif (Test-Path "$env:USERPROFILE\mindmap-viewer\server.js") {
  $pd = "$env:USERPROFILE\mindmap-viewer"
}
if (-not $pd) { Write-Host "프로젝트를 찾을 수 없습니다" -ForegroundColor Red; return }
Set-Location $pd
Write-Host "  프로젝트: $pd" -ForegroundColor Cyan

# ── [1/2] Git 백업 ──
Write-Host "`n[1/2] Git 백업..." -ForegroundColor Cyan

$status = & git status --porcelain 2>$null
if ($status) {
  & git add -A
  $msg = "backup: " + (Get-Date -Format "yyyy-MM-dd HH:mm")
  & git commit -m $msg 2>$null
  Write-Host "  커밋 완료: $msg" -ForegroundColor Green
} else {
  Write-Host "  변경사항 없음 (이미 최신)" -ForegroundColor Green
}

try { & git push origin main 2>$null; Write-Host "  Git push 완료" -ForegroundColor Green }
catch { Write-Host "  push 실패 (네트워크 확인)" -ForegroundColor Yellow }

# ── [2/2] Google Drive 백업 ──
Write-Host "`n[2/2] Google Drive 백업..." -ForegroundColor Cyan

$drive = $null
$candidates = @(
  "$env:USERPROFILE\Google Drive\mindmap-viewer",
  "$env:USERPROFILE\GoogleDrive\mindmap-viewer",
  "$env:USERPROFILE\내 드라이브\mindmap-viewer"
)
# Google Drive for Desktop 경로 탐색
$gd = Get-ChildItem "$env:USERPROFILE\AppData\Local\Google\DriveFS" -Dir -EA SilentlyContinue | Select -First 1
if ($gd) {
  $candidates += "$($gd.FullName)\root\mindmap-viewer"
}

foreach ($c in $candidates) {
  $parent = Split-Path $c
  if (Test-Path $parent) { $drive = $c; break }
}

if ($drive) {
  if (!(Test-Path $drive)) { New-Item -ItemType Directory $drive -Force | Out-Null }
  $exclude = @("node_modules", ".git", "mindmap.db", "mindmap.db-wal", "mindmap.db-shm", "conversation.jsonl", "hook.log", ".hook-state.json")
  $robocopyExclude = $exclude | ForEach-Object { "/XF"; $_ }
  & robocopy $pd $drive /MIR /XD node_modules .git /XF mindmap.db mindmap.db-wal mindmap.db-shm conversation.jsonl hook.log .hook-state.json /NFL /NDL /NJH /NJS /NC /NS /NP 2>$null
  Write-Host "  Drive 백업 완료: $drive" -ForegroundColor Green
} else {
  Write-Host "  Google Drive 경로를 찾을 수 없음 (건너뜀)" -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  백업 완료! (Git + Drive)" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
