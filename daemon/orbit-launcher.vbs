' Orbit AI - 백그라운드 실행 런처 (창 없음)
Dim shell, scriptDir, agentPath
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
agentPath = scriptDir & "\personal-agent.js"
shell.Run "node """ & agentPath & """", 0, False
Set shell = Nothing
