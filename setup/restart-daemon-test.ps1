$ErrorActionPreference = 'Continue'
Write-Host "=== 1. node.exe(daemon) 강제 종료 ==="
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*personal-agent*" } | ForEach-Object {
    Write-Host "  killing PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

Write-Host "=== 2. start-daemon.ps1 재시작 (watchdog 없이 직접 기동) ==="
Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:USERPROFILE\.orbit\start-daemon.ps1`"" -WindowStyle Hidden

Write-Host "=== 3. 30초 대기 (데몬 완전 기동 + keyboard-watcher 초기화 관찰) ==="
for ($i=1; $i -le 6; $i++) {
    Start-Sleep -Seconds 5
    $n = @(Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*personal-agent*" }).Count
    $sm = Test-Path "$env:USERPROFILE\.orbit\.safe-mode"
    Write-Host "  t=$($i*5)s node=$n .safe-mode=$sm"
}

Write-Host "=== 4. 결과 ==="
$p = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*personal-agent*" } | Select-Object -First 1
if ($p) {
    Write-Host "  daemon PID: $($p.ProcessId) / MemMB: $([math]::Round($p.WorkingSetSize/1MB,1))"
}
Write-Host ""
Write-Host "--- daemon.log 최근 30줄 (uiohook/keyboard/crash 필터) ---"
Get-Content "$env:USERPROFILE\.orbit\daemon.log" -Tail 50 -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'uiohook|keyboard|crash|safe-mode|installed|personal-agent' } |
    Select-Object -Last 15

Write-Host ""
Write-Host "--- crash-history.jsonl ---"
if (Test-Path "$env:USERPROFILE\.orbit\crash-history.jsonl") {
    Get-Content "$env:USERPROFILE\.orbit\crash-history.jsonl" -Tail 5 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (없음 - crash 발생 안 함)"
}
