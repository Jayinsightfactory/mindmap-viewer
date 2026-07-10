# ============================================================================
# uia-probe.ps1 - nenova (DevExpress WinForms) UI Automation probe  [gold S0]
# ----------------------------------------------------------------------------
# Goal: can we read semantic data (control name / value / grid cell) via UIA?
#       If yes -> record/replay procedures by control identity, not coordinates.
#
# Run on OWNER PC (nenova visible), Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\uia-probe.ps1
#
# Result saved to %USERPROFILE%\uia-probe-result.txt  -> paste that file back.
# NOTE: source is pure-ASCII on purpose (5.1 reads non-BOM UTF-8 as ANSI).
# ============================================================================

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch {}
$OUT = "$env:USERPROFILE\uia-probe-result.txt"
"" | Out-File $OUT -Encoding utf8
function Log($m) { Write-Host $m; $m | Out-File $OUT -Append -Encoding utf8 }

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch { Log "[FATAL] UIAutomation assembly load failed: $($_.Exception.Message)"; exit 1 }

$A  = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$VP = [System.Windows.Automation.ValuePattern]

Log "===== nenova UIA probe  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="

# Korean match tokens built from char codes (ASCII source):
$K_HWAHWE = [string][char]0xD654 + [char]0xD6FC   # hwahwe
$K_CHULGO = [string][char]0xCD9C + [char]0xACE0   # chulgo
$K_GWANRI = [string][char]0xAD00 + [char]0xB9AC   # gwanri

# ---- 1) find nenova window ----
$root = $A::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Window)
$wins = $root.FindAll($TS::Children, $cond)
$target = $null
foreach ($w in $wins) {
  $n = ''
  try { $n = $w.Current.Name } catch {}
  if ($n -like "*$K_HWAHWE*" -or $n -like "*$K_CHULGO*" -or $n -like "*$K_GWANRI*" -or $n -match 'v1\.') {
    $target = $w; Log "[OK] window found: '$n'"; break
  }
}
if (-not $target) {
  Log "[WARN] title match failed - retry by process"
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -like "*$K_HWAHWE*" -or $_.MainWindowTitle -like "*$K_CHULGO*" -or $_.MainWindowTitle -match 'v1\.' })) {
    try { $target = $A::FromHandle($p.MainWindowHandle); Log "[OK] found by process: $($p.ProcessName)"; break } catch {}
  }
}
if (-not $target) {
  Log "[FAIL] nenova window not found. Open nenova and re-run. Open windows:"
  foreach ($w in $wins) { try { Log ("   - " + $w.Current.Name) } catch {} }
  exit 1
}

# ---- 2) tree scan (depth/count limited) + per-type tally ----
$script:byType = @{}
$script:total = 0
$script:withValue = 0
$script:samples = New-Object System.Collections.ArrayList
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Walk($el, $depth) {
  if ($script:total -ge 4000 -or $depth -gt 14) { return }
  $script:total++
  $ct=''; $nm=''; $aid=''; $val=$null
  try { $ct = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
  try { $nm = $el.Current.Name } catch {}
  try { $aid = $el.Current.AutomationId } catch {}
  if ($ct) { $script:byType[$ct] = 1 + ($script:byType[$ct]) }
  try {
    $vp = $el.GetCurrentPattern($VP::Pattern)
    if ($vp) { $val = $vp.Current.Value; if ($val -ne $null -and $val -ne '') { $script:withValue++ } }
  } catch {}
  if ($script:samples.Count -lt 60 -and ( ($val -ne $null -and $val -ne '') -or $ct -match 'Edit|Button|DataItem|Custom|Text|ComboBox|CheckBox' )) {
    $nmS = if ($nm.Length -gt 30) { $nm.Substring(0,30) } else { $nm }
    $vS  = if ($val -and $val.Length -gt 30) { $val.Substring(0,30) } else { $val }
    [void]$script:samples.Add(("  d{0} [{1}] name='{2}' id='{3}' val='{4}'" -f $depth,$ct,$nmS,$aid,$vS))
  }
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch {}
  while ($child -ne $null) {
    Walk $child ($depth+1)
    if ($script:total -ge 4000) { break }
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}

Log "`n--- scanning tree (max 4000 elements) ---"
Walk $target 0
Log "total elements: $script:total  |  with ValuePattern: $script:withValue"
Log "`n[count by ControlType]"
$script:byType.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Log ("  {0,-16} {1}" -f $_.Key, $_.Value) }
Log "`n[samples - are name / automationId / value readable?]"
$script:samples | ForEach-Object { Log $_ }

# ---- 3) verdict ----
$hasButtons = $script:byType['Button'] -gt 0
$hasEdits   = ($script:byType['Edit'] -gt 0) -or ($script:byType['ComboBox'] -gt 0)
$hasGrid    = ($script:byType['DataItem'] -gt 0) -or ($script:byType['Custom'] -gt 0) -or ($script:byType['Table'] -gt 0)
Log "`n[VERDICT]"
Log ("  buttons (ribbon/save)   : " + $(if($hasButtons){'YES'}else{'NO'}))
Log ("  edit fields / combo     : " + $(if($hasEdits){'YES'}else{'NO'}))
Log ("  grid cells / rows       : " + $(if($hasGrid){'YES (DataItem/Custom/Table present)'}else{'NO - DevExpress virtualization may hide from UIA'}))
Log ("  values (ValuePattern)   : " + $(if($script:withValue -gt 0){"YES ($script:withValue found)"}else{'NO'}))

# ---- 4) focus watch (20s) - do we read what the user clicks/types live? ----
Log "`n--- FOCUS WATCH 20s: NOW click a grid cell in nenova and type a number, hover/tab to Save ---"
Write-Host "   (interact with nenova now...)"
$seen = @{}
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try {
    $f = $A::FocusedElement
    $ct=''; $nm=''; $aid=''; $val=''
    try { $ct = $f.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
    try { $nm = $f.Current.Name } catch {}
    try { $aid = $f.Current.AutomationId } catch {}
    try { $vp = $f.GetCurrentPattern($VP::Pattern); if ($vp) { $val = $vp.Current.Value } } catch {}
    $key = "$ct|$nm|$aid|$val"
    if (-not $seen.ContainsKey($key) -and ($ct -or $nm)) {
      $seen[$key] = 1
      Log ("  focus-> [{0}] name='{1}' id='{2}' val='{3}'" -f $ct, $nm, $aid, $val)
    }
  } catch {}
  Start-Sleep -Milliseconds 400
}

Log "`n===== DONE. paste this file: $OUT ====="
Write-Host "`nresult file: $OUT"
