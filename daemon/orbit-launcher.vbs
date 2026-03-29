' Orbit AI - 백그라운드 실행 런처 (창 없음)
Dim shell, scriptDir, psPath
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
psPath = scriptDir & "\tray.ps1"
shell.Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File """ & psPath & """", 0, False
Set shell = Nothing
