# ============================================================================
# uia-probe2.ps1 - nenova UIA recorder prototype (gold S0.2)
# ----------------------------------------------------------------------------
# v1 proved: focused controls expose AutomationId + Name(=value). Good.
# v2 tests: can we record a FULL mini-procedure as clean work-steps,
#           and does a GRID CELL edit get captured?
#
# Run on OWNER PC (nenova visible), Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\uia-probe2.ps1
#
# During the 40s window, do a REAL mini-procedure in nenova:
#   1) click a ribbon/toolbar button (e.g. 출고분배 or 조회)
#   2) pick an item in the 품목 dropdown
#   3) DOUBLE-CLICK a grid cell (출고수량), type a number, press Enter
#   4) click 저장 (or hover/tab to it)
#
# Result -> %USERPROFILE%\uia-probe2-result.txt  (paste it back)
# ============================================================================

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch {}
$OUT = "$env:USERPROFILE\uia-probe2-result.txt"
"" | Out-File $OUT -Encoding utf8
function Log($m) { Write-Host $m; $m | Out-File $OUT -Append -Encoding utf8 }

try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes }
catch { Log "[FATAL] UIA load failed: $($_.Exception.Message)"; exit 1 }

$A  = [System.Windows.Automation.AutomationElement]
$VP = [System.Windows.Automation.ValuePattern]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

Log "===== nenova UIA recorder prototype  $(Get-Date -Format 'HH:mm:ss') ====="

# parent path (up to 5 ancestors) -> gives the control's location context
function ParentPath($el) {
  $parts = @()
  $cur = $el
  for ($i=0; $i -lt 5 -and $cur -ne $null; $i++) {
    try {
      $n = $cur.Current.Name
      $t = $cur.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
      if ($n) { $parts += "$t($n)" } else { $parts += "$t" }
    } catch {}
    try { $cur = $walker.GetParent($cur) } catch { break }
  }
  [array]::Reverse($parts)
  return ($parts -join ' > ')
}

Log "`n--- RECORDING 40s: do the mini-procedure in nenova NOW ---"
Log "    (button click -> item dropdown -> DOUBLE-CLICK grid cell + type number + Enter -> Save)"
Write-Host "`n>>> interact with nenova now (40s) <<<`n"

$seq = 0
$last = ''
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  try {
    $f = $A::FocusedElement
    $ct=''; $nm=''; $aid=''; $val=''; $rect=''
    try { $ct = $f.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
    try { $nm = $f.Current.Name } catch {}
    try { $aid = $f.Current.AutomationId } catch {}
    try { $vp = $f.GetCurrentPattern($VP::Pattern); if ($vp) { $val = $vp.Current.Value } } catch {}
    try { $r = $f.Current.BoundingRectangle; $rect = ("{0},{1} {2}x{3}" -f [int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height) } catch {}
    # skip our own PowerShell window
    if ($nm -match 'PowerShell|Windows Terminal|Command Prompt') { Start-Sleep -Milliseconds 250; continue }
    $key = "$ct|$nm|$aid|$val"
    if ($key -ne $last -and ($ct -or $nm)) {
      $last = $key
      $seq++
      $vShow = if ($val) { $val } else { $nm }   # value: prefer ValuePattern, else Name
      Log ("STEP {0}: id={1} type={2} value='{3}' rect=[{4}]" -f $seq, $aid, $ct, $vShow, $rect)
      Log ("        path: " + (ParentPath $f))
    }
  } catch {}
  Start-Sleep -Milliseconds 250
}

# after recording: inspect the element under the mouse cursor (grid cell test)
Log "`n--- element under cursor (move mouse over a GRID CELL, keep it there) ---"
Start-Sleep -Seconds 3
try {
  Add-Type -AssemblyName System.Windows.Forms
  $pt = [System.Windows.Forms.Cursor]::Position
  $under = $A::FromPoint([System.Windows.Point]::new($pt.X, $pt.Y))
  $uct=''; $unm=''; $uaid=''
  try { $uct = $under.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
  try { $unm = $under.Current.Name } catch {}
  try { $uaid = $under.Current.AutomationId } catch {}
  Log ("  under-cursor: id={0} type={1} name='{2}'" -f $uaid, $uct, $unm)
  Log ("        path: " + (ParentPath $under))
} catch { Log "  FromPoint failed: $($_.Exception.Message)" }

Log "`n===== DONE. paste this file: $OUT ====="
Write-Host "`nresult file: $OUT"
