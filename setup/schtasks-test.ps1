# Test schtasks /create for OrbitDaemon — capture actual error
$ErrorActionPreference = 'Continue'
$daemonScript = "$env:USERPROFILE\.orbit\start-daemon.ps1"
$action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonScript`""

Write-Host "--- 1. schtasks /create 실행 (출력 캡처) ---"
$out = & schtasks /create /tn "OrbitDaemon" /tr $action /sc ONLOGON /rl LIMITED /f 2>&1
Write-Host "exit=$LASTEXITCODE"
$out | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "--- 2. /query 확인 ---"
$q = & schtasks /query /tn "OrbitDaemon" /fo LIST 2>&1
Write-Host "exit=$LASTEXITCODE"
$q | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "--- 3. Register-ScheduledTask 대안 시도 ---"
try {
    Unregister-ScheduledTask -TaskName "OrbitDaemonTest" -Confirm:$false -ErrorAction SilentlyContinue
    $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemonScript`""
    $t = New-ScheduledTaskTrigger -AtLogOn
    $s = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "OrbitDaemonTest" -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
    Write-Host "Register-ScheduledTask 성공"
    $check = Get-ScheduledTask -TaskName "OrbitDaemonTest" -ErrorAction SilentlyContinue
    if ($check) { Write-Host "확인됨: state=$($check.State) hidden=$($check.Settings.Hidden)" }
    Unregister-ScheduledTask -TaskName "OrbitDaemonTest" -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "테스트 task 정리 완료"
} catch {
    Write-Host "Register-ScheduledTask 실패: $_"
}
