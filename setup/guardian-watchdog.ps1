# Orbit Guardian Watchdog — generated to %USERPROFILE%\.orbit\watchdog.ps1
# Placeholder __ORBIT_REMOTE__ replaced at install time.
# Role: immortal supervisor — polls server commands, restarts Worker (personal-agent) only.
# NEVER spawns install.ps1 / install-open.ps1 (kills Guardian + Worker together).

$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\mindmap-viewer"
$logFile = "$env:USERPROFILE\.orbit\watchdog.log"
$server = '__ORBIT_REMOTE__'
$hn = [Uri]::EscapeDataString($env:COMPUTERNAME)
$startDaemon = "$env:USERPROFILE\.orbit\start-daemon.ps1"
$gitRepo = 'https://github.com/Jayinsightfactory/mindmap-viewer.git'

function Log-Wd([string]$msg) {
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[$ts] $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

function Guardian-GitSync {
  try {
    Set-Location $dir
    git remote set-url origin $gitRepo 2>$null
    # git fetch 30초 타임아웃 — 네트워크 지연 시 watchdog 행 방지
    $j = Start-Job -ScriptBlock {
      param($d, $g); Set-Location $d; git remote set-url origin $g 2>$null; git fetch origin 2>$null
    } -ArgumentList $dir, $gitRepo
    $null = Wait-Job $j -Timeout 30
    Remove-Job $j -Force -ErrorAction SilentlyContinue
    git reset --hard origin/main 2>$null
    Log-Wd 'git sync OK'
    return $true
  } catch {
    Log-Wd "git sync fail: $_"
    return $false
  }
}

function Guardian-EnsureStartDaemon {
  $me = $PID
  $sd = Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $me -and $_.CommandLine -like '*start-daemon.ps1*'
  }
  if ($sd) { return $true }
  if (-not (Test-Path $startDaemon)) {
    Log-Wd 'start-daemon.ps1 missing'
    return $false
  }
  Start-Process powershell.exe -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', "`"$startDaemon`""
  ) -WindowStyle Hidden
  Log-Wd 'start-daemon.ps1 spawned'
  return $true
}

function Guardian-RestartWorker {
  $killed = $false
  Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*personal-agent*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0; $killed = $true }
  # [2026-06-18 라이프라인] WMI CommandLine이 안 보일 때(권한/null) 폴백: orbit 경로의 node 종료
  if (-not $killed) {
    Get-Process node -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -like '*mindmap-viewer*' } catch { $false }
    } | ForEach-Object { Stop-Process -Id $_.Id -Force -EA 0 }
  }
  Log-Wd 'worker (personal-agent) stopped — start-daemon will respawn'
  Guardian-EnsureStartDaemon | Out-Null
}

# [2026-06-18 라이프라인] AV 자가예외 — LocalSystem(NSSM)이라 admin 권한, Add-MpPreference 가능.
# AV가 데몬을 죽이는 문제(김빛나 사고) 예방: orbit 폴더·node/python을 매 사이클 예외 재등록(idempotent).
function Guardian-AVExclude {
  try {
    Add-MpPreference -ExclusionPath $dir -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionPath "$env:USERPROFILE\.orbit" -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess 'python.exe' -ErrorAction SilentlyContinue
  } catch {}
}

function Guardian-Report([string]$status, [string]$detail) {
  if (-not $script:pollHdrs) { return }
  try {
    $detailEsc = ($detail -replace '[\x22\\]', ' ').Substring(0, [Math]::Min(200, ($detail -replace '[\x22\\]', ' ').Length))
    $body = "{`"events`":[{`"id`":`"wd-$env:COMPUTERNAME-$([DateTimeOffset]::Now.ToUnixTimeSeconds())`",`"type`":`"daemon.update`",`"source`":`"watchdog`",`"sessionId`":`"watchdog`",`"timestamp`":`"$((Get-Date).ToString('o'))`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`",`"status`":`"$status`",`"detail`":`"$detailEsc`"}}]}"
    Invoke-RestMethod -Uri "$server/api/hook" -Method POST -ContentType 'application/json' -Body $body -Headers $script:pollHdrs -TimeoutSec 5 | Out-Null
  } catch {}
}

# Token for API polling
$cfgTok = ''
try { $cfgTok = (Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json).token } catch {}
$script:pollHdrs = @{'X-Device-Id' = $hn }
if ($cfgTok) { $script:pollHdrs['Authorization'] = "Bearer $cfgTok" }

# [2026-06-18 라이프라인] 매 사이클 AV 자가예외 (AV가 데몬 죽이는 것 예방)
Guardian-AVExclude

# ── Server command polling (Guardian handles dangerous commands) ─────────────
try {
  $cmdUrl = "$server/api/daemon/commands?hostname=$hn"
  $cmdResp = Invoke-RestMethod -Uri $cmdUrl -Headers $script:pollHdrs -TimeoutSec 10 -ErrorAction Stop
  $cmds = @()
  if ($cmdResp.commands) { $cmds = $cmdResp.commands }
  foreach ($cmd in $cmds) {
    try {
      $act = "$($cmd.action)"
      if ($act -eq 'exec' -and $cmd.command) {
        # Block install.ps1 / reinstall spawn from remote exec
        $c = $cmd.command
        if ($c -match 'install-open|setup\\install|orbit-reinstall') {
          Log-Wd "exec blocked (install pattern): $($c.Substring(0, [Math]::Min(80, $c.Length)))"
          Guardian-Report 'guardian-exec-blocked' 'install pattern blocked'
          continue
        }
        $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $c 2>&1 | Out-String
        Log-Wd "exec: $($c.Substring(0, [Math]::Min(100, $c.Length)))"
        Guardian-Report 'guardian-exec' ($out.Substring(0, [Math]::Min(150, $out.Length)))
      } elseif ($act -eq 'restart') {
        Guardian-RestartWorker
        Guardian-Report 'guardian-restart' 'worker restarted via guardian'
      } elseif ($act -eq 'update') {
        Guardian-GitSync | Out-Null
        Guardian-RestartWorker
        Guardian-Report 'guardian-update' 'git pull + worker restart'
      } elseif ($act -eq 'reinstall') {
        # Safe reinstall = git sync only. NEVER spawn install.ps1.
        Guardian-GitSync | Out-Null
        Guardian-RestartWorker
        Guardian-Report 'guardian-reinstall' 'git pull + worker restart (no install.ps1)'
      } elseif ($act -eq 'config' -and $cmd.data) {
        try {
          $cfgPath = "$env:USERPROFILE\.orbit-config.json"
          $existing = @{}
          try { $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {}
          $cmd.data.PSObject.Properties | ForEach-Object {
            $existing | Add-Member -MemberType NoteProperty -Name $_.Name -Value $_.Value -Force
          }
          [System.IO.File]::WriteAllText($cfgPath, ($existing | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
          Log-Wd 'config updated'
          Guardian-Report 'guardian-config' 'config merged'
        } catch {
          Log-Wd "config error: $_"
        }
      }
    } catch {
      Log-Wd "command error: $_"
    }
  }
} catch {}

# ── Worker alive check ───────────────────────────────────────────────────────
$alive = $false
try {
  $nodeProcs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*personal-agent*' }
  if ($nodeProcs) { $alive = $true }
} catch {}

$deadFlag = "$env:USERPROFILE\.orbit\.dead-cycles"

if (-not $alive) {
  Log-Wd 'worker dead — recovering'

  $crashInfo = ''
  try {
    $dlog = "$env:USERPROFILE\.orbit\daemon.log"
    if (Test-Path $dlog) {
      $crashInfo = (Get-Content $dlog -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
    }
  } catch {}

  try {
    $body = "{`"events`":[{`"id`":`"crash-$env:COMPUTERNAME-$([DateTimeOffset]::Now.ToUnixTimeSeconds())`",`"type`":`"daemon.crash`",`"source`":`"watchdog`",`"sessionId`":`"watchdog`",`"timestamp`":`"$((Get-Date).ToString('o'))`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`",`"crashLog`":`"$($crashInfo -replace '[\x22\\]',' ')`"}}]}"
    Invoke-RestMethod -Uri "$server/api/hook" -Method POST -ContentType 'application/json' -Body $body -Headers $script:pollHdrs -TimeoutSec 5 | Out-Null
  } catch {}

  Guardian-AVExclude          # 죽었으면 AV예외 재확인 후
  # start-daemon.ps1 루프가 데몬 사망 시 이미 git pull 담당 — 중복 제거 (hang 방지)
  Guardian-EnsureStartDaemon | Out-Null

  # [2026-06-18 라이프라인] 자가재설치 — 일반 재시작이 계속 실패하면 최후수단.
  # 연속 dead 카운트(파일). 15사이클(약 30분) 연속이면 install.ps1 자동 재실행(비대화식).
  $dc = 0; try { $dc = [int](Get-Content $deadFlag -ErrorAction SilentlyContinue) } catch {}
  $dc++
  try { Set-Content -Path $deadFlag -Value $dc -ErrorAction SilentlyContinue } catch {}
  if ($dc -ge 15) {
    Log-Wd "self-heal reinstall trigger (dead $dc cycles)"
    Guardian-Report 'guardian-selfheal-reinstall' "dead $dc cycles -> auto reinstall"
    try { Set-Content -Path $deadFlag -Value 0 -ErrorAction SilentlyContinue } catch {}
    try {
      # [2026-06-18] iex는 AMSI가 긴 스크립트를 차단 + BOM 깨짐 → install-open과 동일하게
      # -OutFile로 받아 -File 실행. ORBIT_AUTO_REINSTALL는 env 상속으로 전달(Pause 안 멈춤).
      $tmpInst = "$env:TEMP\orbit-selfheal-install.ps1"
      Invoke-WebRequest -Uri "$server/setup/install.ps1" -OutFile $tmpInst -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      $ps51 = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
      $psExe2 = if (Test-Path $ps51) { $ps51 } else { 'powershell.exe' }
      $env:ORBIT_AUTO_REINSTALL = '1'
      Start-Process $psExe2 -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"$tmpInst") -WindowStyle Hidden
    } catch { Log-Wd "self-heal reinstall spawn fail: $_" }
  }
} else {
  # 살아있음 — 카운터 리셋 + 라이프라인 생존신호
  try { Set-Content -Path $deadFlag -Value 0 -ErrorAction SilentlyContinue } catch {}
  Guardian-Report 'guardian-alive' 'lifeline ok'
}
