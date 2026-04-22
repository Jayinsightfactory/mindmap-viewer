$ErrorActionPreference = 'SilentlyContinue'
Write-Host "=== node.exe 프로세스 ==="
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cmd = [string]$_.CommandLine
    if ($cmd.Length -gt 100) { $cmd = $cmd.Substring(0,100) + '...' }
    [PSCustomObject]@{
        PID      = $_.ProcessId
        MemMB    = [math]::Round($_.WorkingSetSize/1MB, 1)
        CmdLine  = $cmd
    }
} | Format-Table -AutoSize

Write-Host "=== 가시적 창 (깜빡임/팝업 원흉) ==="
Get-Process | Where-Object {
    $_.MainWindowTitle -and ($_.ProcessName -in @('powershell','cmd','wscript','conhost','node'))
} | Select-Object Id, ProcessName, MainWindowTitle, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize

Write-Host "=== schtasks OrbitDaemon ==="
$r = & schtasks /query /tn OrbitDaemon /fo LIST 2>&1
$r | Select-Object -First 10

Write-Host ""
Write-Host "=== Registry Run OrbitDaemon ==="
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
if ($reg.OrbitDaemon) { Write-Host "OK: $($reg.OrbitDaemon)" } else { Write-Host "MISSING" }

Write-Host ""
Write-Host "=== Startup lnk ==="
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\OrbitDaemon.lnk"
if (Test-Path $lnk) { Write-Host "OK: $lnk ($((Get-Item $lnk).Length) bytes)" } else { Write-Host "MISSING" }

Write-Host ""
Write-Host "=== 리소스 소비 상위 5 ==="
Get-WmiObject Win32_Process | Sort-Object WorkingSetSize -Descending | Select-Object -First 5 |
    ForEach-Object { [PSCustomObject]@{
        Name=$_.Name
        PID=$_.ProcessId
        MemMB=[math]::Round($_.WorkingSetSize/1MB,1)
    }} | Format-Table -AutoSize

Write-Host "=== daemon.log 크기 + 최근 3줄 ==="
$log = "$env:USERPROFILE\.orbit\daemon.log"
if (Test-Path $log) {
    $size = (Get-Item $log).Length
    Write-Host "size: $([math]::Round($size/1KB,1)) KB"
    Get-Content $log -Tail 3 | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "=== captures 폴더 파일 수 ==="
$capDir = "$env:USERPROFILE\.orbit\captures"
if (Test-Path $capDir) {
    $count = (Get-ChildItem $capDir -File).Count
    Write-Host "count: $count"
}

Write-Host ""
Write-Host "=== 파일 락 체크 (수정 가능한지) ==="
foreach ($f in @("$env:USERPROFILE\.orbit\capture-config.json", "$env:USERPROFILE\.orbit-config.json", "$env:USERPROFILE\.orbit\start-daemon.ps1")) {
    if (Test-Path $f) {
        try {
            $fs = [IO.File]::Open($f, 'Open', 'ReadWrite', 'Read')
            $fs.Close()
            Write-Host "OK (수정 가능): $f"
        } catch {
            Write-Host "LOCKED: $f — $_"
        }
    }
}
