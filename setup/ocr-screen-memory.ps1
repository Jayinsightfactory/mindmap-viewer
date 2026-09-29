# ocr-screen-memory.ps1 — 전면 창을 메모리에서만 캡처 → Windows 내장 OCR → 텍스트를 stdout 으로.
# [2026-09-29 개인정보] 메신저 로컬 처리용. 이미지 파일을 디스크에 쓰지 않는다(Bitmap→MemoryStream→WinRT 스트림).
# ocr-extract.ps1 과 같은 WinRT 방식. powershell.exe(5.1) 전용(pwsh 7 은 WinRT 프로젝션 불안정).
# 출력: 인식 텍스트(실패/불가 시 빈 문자열, exit 0). 호출측(node)은 텍스트를 메모리에서만 쓰고 버린다.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  if (-not ('OrbitFgWin' -as [type])) {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class OrbitFgWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
  }
  $h = [OrbitFgWin]::GetForegroundWindow()
  $r = New-Object OrbitFgWin+RECT
  if (-not [OrbitFgWin]::GetWindowRect($h, [ref]$r)) { Write-Output ''; exit 0 }
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -lt 50 -or $hh -lt 50) { Write-Output ''; exit 0 }

  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $ms.Position = 0

  $null = [Windows.Media.Ocr.OcrEngine,           Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $asTaskDef = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($op, $t) { $m = $asTaskDef.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { $ms.Dispose(); Write-Output ''; exit 0 }
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sbmp    = Await ($decoder.GetSoftwareBitmapAsync())                         ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result  = Await ($engine.RecognizeAsync($sbmp))                             ([Windows.Media.Ocr.OcrResult])
  $ms.Dispose()
  if ($result -and $result.Text) { Write-Output $result.Text } else { Write-Output '' }
} catch {
  Write-Output ''
}
exit 0
