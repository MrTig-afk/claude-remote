<#
.SYNOPSIS
Registers (or, with -RenderOnly, just renders and schema-validates) the
Scheduled Task that starts the claude-remote Local Agent at logon.
See docs/agent-autostart.md for what this does and how to undo it.
To (re)start the agent, run update-agent.ps1 beside this file: it stops the
old one properly, registers, starts and checks the new one.
#>
[CmdletBinding()]
param(
    [switch]$RenderOnly,
    [string]$OutFile = (Join-Path $env:TEMP 'claude-remote-agent.xml'),
    [string]$TaskName = 'Claude Remote Agent'
)

$ErrorActionPreference = 'Stop'

$agentDir = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $agentDir 'server.js'
$templatePath = Join-Path $PSScriptRoot 'claude-remote-agent.task.xml'
$dataDir = Join-Path $env:USERPROFILE '.claude\plugins\data\claude-remote-claude-remote'
$logFile = Join-Path $dataDir 'agent.log'

if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Cannot find the agent entry point at '$serverPath' - is this script still inside agent/autostart/?"
}

# node.exe must already be on PATH - the same way the owner runs the agent
# today. The resolved path below is reported only; the task itself
# resolves node.exe from its own PATH at run time.
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw 'node.exe is not on PATH - the task would start and immediately fail.'
}

$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (-not (Test-Path -LiteralPath $conhost)) {
    throw "conhost.exe not found at '$conhost'."
}

# --headless is undocumented, so prove this Windows honours it before
# handing it to the scheduler: it must run the command it is given. Without
# the flag's support the task would start nothing, silently, at every logon.
$probe = Join-Path $env:TEMP "claude-remote-headless-probe-$PID"
Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $conhost -PassThru -ArgumentList "--headless cmd.exe /c type nul > `"$probe`""
$null = $p.WaitForExit(10000)
if (-not (Test-Path -LiteralPath $probe)) {
    throw "conhost.exe --headless did not run its command on this Windows - the agent cannot be started hidden here."
}
Remove-Item -LiteralPath $probe

$userId = "$env:USERDOMAIN\$env:USERNAME"

# cmd /s /c "<...>": /s strips only the outer quotes and takes the rest
# verbatim, the one form that survives paths with spaces. md creates the
# data dir on a first-ever run (2>nul swallows "already exists").
$arguments = '--headless cmd.exe /s /c "md "' + $dataDir + '" 2>nul & node.exe "' +
    $serverPath + '" 1>>"' + $logFile + '" 2>&1"'

# Every value is XML-escaped: the arguments carry & and ", and a path may too.
# .Replace() (literal, not -replace) so backslashes need no escaping.
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$rendered = Get-Content -LiteralPath $templatePath -Raw
$rendered = $rendered.Replace('{{USER_ID}}', (& $esc $userId))
$rendered = $rendered.Replace('{{CONHOST}}', (& $esc $conhost))
$rendered = $rendered.Replace('{{ARGUMENTS}}', (& $esc $arguments))
$rendered = $rendered.Replace('{{AGENT_DIR}}', (& $esc $agentDir))
$rendered = $rendered.Replace('{{START}}', (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'))

if ($rendered -match '\{\{') {
    throw 'Template still contains an unsubstituted {{PLACEHOLDER}} after rendering - refusing to hand this to the scheduler.'
}

# Well-formedness check.
[xml]$rendered | Out-Null

# Schema dry-run: NewTask(0) + assigning XmlText validates the document
# against the Task Scheduler schema and throws on a violation. Nothing is
# registered by this call - the task definition only exists in memory.
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$def = $svc.NewTask(0)
$def.XmlText = $rendered

if ($env:CLAUDE_REMOTE_AGENT_PORT) {
    Write-Warning "CLAUDE_REMOTE_AGENT_PORT is set to '$($env:CLAUDE_REMOTE_AGENT_PORT)' in this environment. The task inherits the user environment, so a stale value here would move the agent off port 8790 and silently break the tailscale serve mapping."
}

if ($RenderOnly) {
    Set-Content -LiteralPath $OutFile -Value $rendered -Encoding Unicode
    Write-Output "Rendered and schema-validated task XML written to: $OutFile"
    Write-Output 'nothing was registered'
    return
}

# Re-registering over a running instance would leave the old agent alive and
# unsupervised, holding the port. Stop-ScheduledTask cannot fix that - it
# ends conhost and node survives it (measured 2026-09-22) - so refuse, and
# point at the script that stops it properly.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw "Task '$TaskName' is running. Use update-agent.ps1 (beside this script), which stops the agent before re-registering it."
}

Register-ScheduledTask -TaskName $TaskName -Xml $rendered -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "node.exe resolved to: $($nodeCmd.Source)"
Write-Output "Agent log file: $logFile"
Write-Output ''
Write-Output 'Registering does NOT start it. Start it, and check it came up, with:'
Write-Output "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\update-agent.ps1`""
Write-Output 'To remove it: docs/agent-autostart.md, "Removing it".'
