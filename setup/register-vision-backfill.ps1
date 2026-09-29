# register-vision-backfill.ps1 -- nightly vision backfill (workflow tagging merge into existing screen.analyzed)
# NOT auto-run. Owner PC only, after main session approval:
#   powershell -ExecutionPolicy Bypass -File setup\register-vision-backfill.ps1            (register, daily 01:30, --max 150)
#   powershell -ExecutionPolicy Bypass -File setup\register-vision-backfill.ps1 -Remove    (unregister)
# Requires: server endpoints /api/vision/backfill-candidates + backfill-merge deployed, claude CLI logged in.
param([string]$Time = '01:30', [int]$Max = 150, [string]$Repo = "$env:USERPROFILE\mindmap-viewer", [switch]$Remove)
$name = 'OrbitVisionBackfill'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; Write-Host "removed $name"; exit 0 }
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $Repo 'bin\vision-backfill.js'
if (-not (Test-Path $script)) { Write-Error "missing $script (merge/deploy first)"; exit 1 }
$log = Join-Path $env:USERPROFILE '.orbit\vision-backfill.out.log'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" `"$script`" --max $Max >> `"$log`" 2>&1`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 5) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Orbit vision backfill: re-decode thumbnails 09-17..09-28 and merge workflow tags' -Force | Out-Null
Write-Host "registered $name daily $Time --max $Max (log $log)"
