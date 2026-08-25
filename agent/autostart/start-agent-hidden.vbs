' Starts the claude-remote Local Agent with no console window, and WAITS for it
' so Task Scheduler can see it fail and restart it.
' Window style 0 = hidden; True = wait and return node's exit code.
Option Explicit
Dim sh, fso, agentDir, dataDir, logFile, q, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
agentDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
dataDir  = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\plugins\data\claude-remote-claude-remote"
logFile  = dataDir & "\agent.log"
' cmd /s /c "<...>" : /s makes cmd strip only the outer quotes and take the
' rest verbatim, which is the one form that survives paths with spaces.
' md creates the data dir on a first-ever run (2>nul swallows "already
' exists"); & then runs node whatever md said. The chain's exit code is
' node's, which is what RestartOnFailure keys on.
cmd = "cmd /s /c " & q & _
      "md " & q & dataDir & q & " 2>nul & " & _
      "node.exe " & q & agentDir & "\server.js" & q & _
      " 1>>" & q & logFile & q & " 2>&1" & q
WScript.Quit sh.Run(cmd, 0, True)
