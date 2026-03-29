# Orbit AI 설치 파일 빌드 스크립트
# Inno Setup 6 컴파일러로 EXE 인스톨러 생성

# Inno Setup 컴파일러 경로 자동 감지
$iscc = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe",
  "$env:USERPROFILE\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
  Write-Host "Inno Setup 6이 없습니다. 다운로드: https://jrsoftware.org/isdl.php" -ForegroundColor Yellow
  # Try to download and install silently
  $url = "https://jrsoftware.org/download.php/is.exe"
  $tmp = "$env:TEMP\is.exe"
  Invoke-WebRequest $url -OutFile $tmp
  Start-Process $tmp -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES" -Wait
  $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$issFile = Join-Path $scriptDir "orbit-setup.iss"
$outputDir = Join-Path $scriptDir ".." "dist"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Write-Host "빌드 중: $issFile" -ForegroundColor Cyan
& $iscc /O"$outputDir" $issFile

if ($LASTEXITCODE -eq 0) {
  $exe = Get-ChildItem $outputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Write-Host "✅ 빌드 완료: $($exe.FullName)" -ForegroundColor Green
} else {
  Write-Host "❌ 빌드 실패" -ForegroundColor Red
}
