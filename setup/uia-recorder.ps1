# ============================================================================
# uia-recorder.ps1 - desktop work-step recorder (gold S1a)
# ----------------------------------------------------------------------------
# Desktop twin of the web extension. Reads controls the user interacts with in
# nenova(DevExpress)/Excel/Word via UIA focus-tracking, emits work-step events
# to the server (same schema as web content-work.js) so #2 stitching can join
# web + desktop into one procedure.
#
# Run on OWNER PC, Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\uia-recorder.ps1
#   (test: -Minutes 5 ; default 0 = run forever, Ctrl+C to stop)
#
# Source is pure-ASCII (5.1 reads non-BOM UTF-8 as ANSI and breaks).
# Captured Korean VALUES from apps are fine (sent UTF-8 at runtime).
# ============================================================================
param([int]$Minutes = 0, [int]$PollMs = 250, [int]$FlushSec = 5)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch {}
# 자기 콘솔창 숨김 (데몬이 -Hidden/windowsHide로 띄우지만, 만일의 깜빡임까지 차단)
try {
  Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
  [Native.Win]::ShowWindow([Native.Win]::GetConsoleWindow(), 0) | Out-Null  # 0 = SW_HIDE
} catch {}
try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes } catch { Write-Host "[FATAL] UIA load failed"; exit 1 }

# single-instance guard: daemon respawn shouldn't stack recorders (duplicate events)
$script:_mtx = New-Object System.Threading.Mutex($false, "OrbitUiaRecorder_$env:USERNAME")
if (-not $script:_mtx.WaitOne(0)) { Write-Host "already running - exit"; exit 0 }

$A  = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$VP = [System.Windows.Automation.ValuePattern]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# server config from .orbit-config.json (serverUrl + token), else default
$REMOTE = 'https://mindmap-viewer-production-adb2.up.railway.app'
$TOKEN  = ''
try {
  $cfg = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json
  if ($cfg.serverUrl) { $REMOTE = $cfg.serverUrl.TrimEnd('/') }
  if ($cfg.token)     { $TOKEN  = $cfg.token }
} catch {}
$HOST_NAME = $env:COMPUTERNAME

# nenova window markers (Korean via char codes so source stays ASCII)
$K1 = [string][char]0xD654 + [char]0xD6FC   # hwahwe
$K2 = [string][char]0xCD9C + [char]0xACE0   # chulgo
$K3 = [string][char]0xAD00 + [char]0xB9AC   # gwanri

$TARGET_PROC = @('excel','winword','powerpnt','hwp')
# 2026-10-13: browsers were left to the Chrome extension, but ExtensionInstallForcelist is ignored on
# non-domain PCs (all employee PCs) so the extension never installed -> 0 web work-steps since launch.
# Browser windows whose title matches ECOUNT / nenovaweb are now recorded here (app = ecount / nenovaweb).
$BROWSER_PROC = @('chrome','msedge','whale')
$SKIP_PROC   = @('firefox','brave','opera','powershell','pwsh','conhost','windowsterminal','cmd','explorer','searchhost','textinputhost','shellexperiencehost','startmenuexperiencehost')
# The web app is identified by the URL of the UIA Document ancestor (Chrome exposes it via ValuePattern),
# not by the window title (ECOUNT tab titles are just the menu name, e.g. "판매현황"). prgId is kept for ECOUNT.
$WEB_URL_RE = '(?i)https?://[^/]*(ecount\.com|nenovaweb\.com)'
# Address bar of the top-level browser window that contains $el (Chrome: AutomationId view_1012 / Edit in ToolBar). Cached per window for 2s.
$script:abCache = @{}
function AddressBarUrl($el) {
  # top-level browser element = last ancestor before the desktop root (employee Chrome reports its frame as Pane, not Window)
  $root = $A::RootElement; $win = $el; $top = $null
  for ($i=0; $i -lt 40 -and $win -ne $null; $i++) {
    $par = $null; try { $par = $walker.GetParent($win) } catch { break }
    if ($par -eq $null -or [System.Windows.Automation.Automation]::Compare($par, $root)) { $top = $win; break }
    $win = $par
  }
  if (-not $top) { return '' }
  $h = 0; try { $h = $top.Current.NativeWindowHandle } catch {}
  $c = $script:abCache[$h]; if ($c -and ((Get-Date) - $c.t).TotalSeconds -lt 2) { return $c.u }
  $u = ''
  try {
    $e = $top.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'view_1012')))
    if (-not $e) {
      $tb = $top.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::ToolBar)))
      if ($tb) { $e = $tb.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Edit))) }
    }
    if ($e) { $u = $e.GetCurrentPattern($VP::Pattern).Current.Value }
  } catch {}
  $u = NormUrl $u   # Chrome hides the scheme in the omnibox
  $script:abCache[$h] = @{ u = $u; t = Get-Date }
  return $u
}
function NormUrl($u) {
  $u = ('' + $u).Trim()
  if ($u -and $u -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $u = 'https://' + $u }
  return $u
}
function WebDoc($el) {
  $cur = $el
  for ($i=0; $i -lt 14 -and $cur -ne $null; $i++) {
    try {
      if ($cur.Current.ControlType -eq $CT::Document) {
        $u = ''; try { $u = $cur.GetCurrentPattern($VP::Pattern).Current.Value } catch {}
        # 2026-10-15 field diag: employee Chrome gives an empty or scheme-less Document value -> normalize, then fall back to the address bar,
        # then to the tab title ('... - nenova ERP', '... | ECOUNT') as a last resort
        $u = NormUrl $u
        if ($u -notmatch $WEB_URL_RE) { $u = NormUrl (AddressBarUrl $cur) }
        $ttl = ''; try { $ttl = $cur.Current.Name } catch {}
        if ($u -match $WEB_URL_RE) { return @{ url = $u; title = $ttl } }
        if ($ttl -match '(?i)nenova ERP') { return @{ url = 'https://nenovaweb.com/'; title = $ttl } }
        if ($ttl -match '(?i)\|\s*ECOUNT|ecount\.com') { return @{ url = 'https://logincc.ecount.com/'; title = $ttl } }
        return $null
      }
    } catch {}
    try { $cur = $walker.GetParent($cur) } catch { break }
  }
  return $null
}

function ParentInfo($el) {
  $parts = @(); $win = ''
  $cur = $el
  for ($i=0; $i -lt 8 -and $cur -ne $null; $i++) {
    try {
      $n = $cur.Current.Name
      $t = $cur.Current.ControlType
      if ($t -eq $CT::Window -and $n) { $win = $n }
      if ($i -lt 5) { if ($n) { $parts += $n } else { $parts += ($t.ProgrammaticName -replace 'ControlType\.','') } }
    } catch {}
    try { $cur = $walker.GetParent($cur) } catch { break }
  }
  [array]::Reverse($parts)
  return @{ window = $win; path = ($parts -join ' > ') }
}

# UI chrome(리본/백스테이지/메뉴/색선택/컨텍스트/편집기 포커스) = 업무데이터 아님 → 노이즈로 제외.
# ASCII 판별만 사용(controlType/id/'Backstage'). input(셀 데이터)·실 대화상자 Button·nenova 컨트롤은 유지.
$CHROME_CT = @('Menu','MenuItem','ListItem','RadioButton','SplitButton','TabItem','Window')
function IsChrome($action, $ct, $path, $id, $app) {
  if ($action -ne 'focus') { return $false }           # input(데이터)은 항상 유지
  if ($id -eq 'FormulaBar' -or $id -eq 'CellEdit') { return $true }   # 편집기 중간상태(값은 input으로)
  if ($CHROME_CT -contains $ct) { return $true }        # 메뉴/리본/리스트 탐색
  if ($path -like '*Backstage*') { return $true }       # 인쇄/파일 백스테이지 전체
  if ($app -eq 'excel' -and $ct -eq 'Pane') { return $true }  # 엑셀 워크북/창 포커스
  return $false
}

function IsCredential($name, $aid) {
  $h = (("" + $aid) + '|' + ("" + $name)).ToLower()
  return ($h -match 'password|passwd|(^|_)pw($|_)|(^|_)pwd($|_)')
}

Write-Host "===== UIA recorder start  server=$REMOTE host=$HOST_NAME token=$([bool]$TOKEN) ====="
Write-Host "  targets: nenova(window), Excel, Word, browser windows ECOUNT/nenovaweb / skip: other browsers+shells"
Write-Host "  interact with nenova now. Ctrl+C to stop.`n"

$buffer = New-Object System.Collections.ArrayList
$lastKey = ''; $lastId = ''; $lastVal = ''; $lastNm = ''; $seq = 0
# 2026-10-15 self-diagnosis: web work-steps stayed 0 on employee PCs -> report what the recorder actually sees in browsers (every 10 min, only when a browser had focus)
$dg = @{ browserFocus = 0; webHit = 0; samples = @() }; $lastDiag = Get-Date
$lastFlush = Get-Date
$deadline = if ($Minutes -gt 0) { (Get-Date).AddMinutes($Minutes) } else { $null }

function Flush {
  if ($buffer.Count -eq 0) { return }
  $events = @()
  foreach ($s in $buffer) {
    $events += @{ id = "uiaws-$HOST_NAME-$($s.seq)-$(Get-Random -Max 99999)"; type = 'work.step'; source = 'uia-recorder'; sessionId = "daemon-$HOST_NAME"; timestamp = $s.t; data = $s }
  }
  $body = @{ events = $events } | ConvertTo-Json -Depth 8 -Compress
  $headers = @{ 'X-Device-Id' = $HOST_NAME }
  if ($TOKEN) { $headers['Authorization'] = "Bearer $TOKEN" }
  try {
    Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType 'application/json; charset=utf-8' -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 -EA Stop | Out-Null
    Write-Host ("  -> sent {0}" -f $buffer.Count) -ForegroundColor DarkGray
  } catch { Write-Host ("  send failed: " + $_.Exception.Message.Split([char]10)[0]) -ForegroundColor DarkYellow }
  $buffer.Clear()
}

while ($true) {
  if ($deadline -and (Get-Date) -gt $deadline) { break }
  try {
    $f = $A::FocusedElement
    $ct=''; $nm=''; $aid=''; $procId=0; $rect=''
    try { $ct = $f.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
    try { $nm = $f.Current.Name } catch {}
    try { $aid = $f.Current.AutomationId } catch {}
    try { $procId = $f.Current.ProcessId } catch {}
    try { $r = $f.Current.BoundingRectangle; $rect = ("{0},{1} {2}x{3}" -f [int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height) } catch {}
    # value: ValuePattern(Excel 셀 내용/nenova는 없음) 우선, 없으면 Name
    $val = $nm
    try { $vp = $f.GetCurrentPattern($VP::Pattern); if ($vp) { $vv = $vp.Current.Value; if ($vv -ne $null -and $vv -ne '') { $val = $vv } } } catch {}
    $proc = ''
    try { $proc = (Get-Process -Id $procId -EA SilentlyContinue).ProcessName.ToLower() } catch {}

    if ($proc -and ($SKIP_PROC -contains $proc)) { Start-Sleep -Milliseconds $PollMs; continue }
    $info = ParentInfo $f
    $isNenova = ($info.window -match "$K1|$K2|$K3")
    $webDoc = $null
    if ($BROWSER_PROC -contains $proc) {
      $webDoc = WebDoc $f
      $dg.browserFocus++
      if ($webDoc) { $dg.webHit++ } elseif ($dg.samples.Count -lt 6) {
        # field diag v2: what the address-bar fallback returned for this element (empty = lookup failed)
        $abv = ''; try { $abv = (AddressBarUrl $f) -replace '(ec_req_sid=)[^&#]+', '$1x' } catch { $abv = 'ERR ' + $_.Exception.Message }
        $dv = ''; try { $dv = '' + $f.GetCurrentPattern($VP::Pattern).Current.Value } catch {}
        $dg.samples += ('AB=' + $abv.Substring(0, [Math]::Min(70, $abv.Length)) + ' DV=' + $dv.Substring(0, [Math]::Min(50, $dv.Length)))
        $dg.samples += ("{0}|{1}|{2}" -f $ct, ($nm -replace '[
]', ' ').Substring(0, [Math]::Min(30, $nm.Length)), ($info.path -replace '[
]', ' ').Substring(0, [Math]::Min(80, $info.path.Length))) }
    }
    $isWeb = ($webDoc -ne $null)
    $isTarget = ($TARGET_PROC -contains $proc) -or $isNenova -or $isWeb
    if (-not $isTarget) { Start-Sleep -Milliseconds $PollMs; continue }
    if (IsCredential $nm $aid) { Start-Sleep -Milliseconds $PollMs; continue }

    $key = "$aid|$val"
    if ($key -ne $lastKey -and ($aid -or $nm)) {
      # 같은 컨트롤(id)인데 값만 바뀜 = 편집(input), 새 컨트롤 = focus
      # web controls usually have no AutomationId -> same Name + changed value also counts as input
      $sameCtl = ($aid -ne '' -and $aid -eq $lastId) -or ($aid -eq '' -and $nm -ne '' -and $nm -eq $lastNm)
      $action = if ($sameCtl -and $val -ne $lastVal) { 'input' } else { 'focus' }
      $appName = if ($isNenova) { 'nenova' } elseif ($isWeb) { if ($webDoc.url -match '(?i)ecount') { 'ecount' } else { 'nenovaweb' } } else { $proc }
      $winLabel = $info.window
      if ($isWeb) {
        $prg = ''; if ($webDoc.url -match 'prgId=([A-Za-z0-9_]+)') { $prg = $Matches[1] }
        $pathPart = ''; try { $pathPart = ([Uri]$webDoc.url).AbsolutePath } catch {}
        $winLabel = $webDoc.title + $(if ($prg) { " [prgId=$prg]" } elseif ($pathPart) { " [$pathPart]" } else { '' })
      }
      # 노이즈 컷: ①Excel 셀 단순이동(focus) ②UI chrome(리본/백스테이지/메뉴/편집기) 제외.
      #   → 셀 입력(input)·실 대화상자 버튼·nenova 컨트롤만 남김. (input 판정 위해 last* 는 항상 갱신)
      $skipNav = ($appName -eq 'excel' -and $ct -eq 'DataItem' -and $action -eq 'focus') -or (IsChrome $action $ct $info.path $aid $appName)
      if (-not $skipNav) {
        $seq++
        $step = @{ seq = $seq; t = (Get-Date).ToUniversalTime().ToString('o'); app = $appName; window = $winLabel; action = $action; target = @{ id = $aid; name = $nm; controlType = $ct; path = $info.path; rect = $rect }; value = $val }
        [void]$buffer.Add($step)
        $shown = if ($val.Length -gt 34) { $val.Substring(0,34) } else { $val }
        Write-Host ("[{0}] {1} id={2} '{3}'" -f $seq, $action, $aid, $shown)
      }
      $lastKey = $key; $lastId = $aid; $lastVal = $val; $lastNm = $nm
    }
  } catch {}
  if (((Get-Date) - $lastFlush).TotalSeconds -ge $FlushSec) { Flush; $lastFlush = Get-Date }
  if (((Get-Date) - $lastDiag).TotalMinutes -ge 10) {
    if ($dg.browserFocus -gt 0) {
      try {
        $ev = @{ id = "uiadiag-$HOST_NAME-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"; type = 'daemon.diag'; source = 'uia-recorder'; sessionId = "daemon-$HOST_NAME"; timestamp = (Get-Date).ToUniversalTime().ToString('o'); data = @{ hostname = $HOST_NAME; kind = 'uia-web'; browserFocus = $dg.browserFocus; webHit = $dg.webHit; samples = ($dg.samples -join ' || ') } }
        $hd = @{ 'X-Device-Id' = $HOST_NAME }; if ($TOKEN) { $hd['Authorization'] = "Bearer $TOKEN" }
        Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType 'application/json; charset=utf-8' -Headers $hd -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ events = @($ev) } | ConvertTo-Json -Depth 6 -Compress))) -TimeoutSec 10 -EA Stop | Out-Null
      } catch {}
    }
    $dg = @{ browserFocus = 0; webHit = 0; samples = @() }; $lastDiag = Get-Date
  }
  Start-Sleep -Milliseconds $PollMs
}
Flush
Write-Host "`n===== stopped (total $seq steps) ====="
