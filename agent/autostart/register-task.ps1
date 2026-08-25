<#
.SYNOPSIS
Registers (or, with -RenderOnly, just renders and schema-validates) the
Scheduled Task that starts the claude-remote Local Agent at logon.
See docs/agent-autostart.md for what this does and how to undo it.
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
$shimPath = Join-Path $PSScriptRoot 'start-agent-hidden.vbs'
$templatePath = Join-Path $PSScriptRoot 'claude-remote-agent.task.xml'

if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Cannot find the agent entry point at '$serverPath' - is this script still inside agent/autostart/?"
}
if (-not (Test-Path -LiteralPath $shimPath)) {
    throw "Cannot find the hidden-launch shim at '$shimPath'."
}

# node.exe must already be on PATH - the same way the owner runs the agent
# today. The resolved path below is reported only; the task itself
# resolves node.exe from its own PATH at run time (see start-agent-hidden.vbs).
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw 'node.exe is not on PATH - the task would start and immediately fail.'
}

# VBScript hosting is a Feature-on-Demand on current Windows and is on a
# deprecation path - fail with a clear message now rather than a mystery
# "file not found" from Task Scheduler in a year.
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "wscript.exe not found at '$wscript' - VBScript hosting may be disabled on this machine."
}

$userId = "$env:USERDOMAIN\$env:USERNAME"

# .Replace() (literal string replace, not -replace/regex) so backslashes in
# the Windows paths are substituted verbatim with no escaping needed.
$rendered = Get-Content -LiteralPath $templatePath -Raw
$rendered = $rendered.Replace('{{USER_ID}}', $userId)
$rendered = $rendered.Replace('{{WSCRIPT}}', $wscript)
$rendered = $rendered.Replace('{{SHIM}}', $shimPath)
$rendered = $rendered.Replace('{{AGENT_DIR}}', $agentDir)

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

$logFile = Join-Path $env:USERPROFILE '.claude\plugins\data\claude-remote-claude-remote\agent.log'

if ($env:CLAUDE_REMOTE_AGENT_PORT) {
    Write-Warning "CLAUDE_REMOTE_AGENT_PORT is set to '$($env:CLAUDE_REMOTE_AGENT_PORT)' in this environment. The task inherits the user environment, so a stale value here would move the agent off port 8790 and silently break the tailscale serve mapping."
}

if ($RenderOnly) {
    Set-Content -LiteralPath $OutFile -Value $rendered -Encoding Unicode
    Write-Output "Rendered and schema-validated task XML written to: $OutFile"
    Write-Output 'nothing was registered'
    return
}

# Re-registering while an instance is running leaves the OLD agent process
# alive and unsupervised - the new definition does not adopt it, and it keeps
# the port, so the next start fails with EADDRINUSE for a reason nobody can
# see. Stop it first, deliberately, rather than letting -Force paper over it.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "Task '$TaskName' already exists - stopping it before re-registering."
    if ($existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        Write-Output '  stopped the running instance.'
    }
}

Register-ScheduledTask -TaskName $TaskName -Xml $rendered -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "node.exe resolved to: $($nodeCmd.Source)"
Write-Output "Agent log file: $logFile"
Write-Output ''
Write-Output 'Registering does NOT start it - the trigger is at logon. Start it now:'
Write-Output "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Output ''
Write-Output 'Verify (docs/agent-autostart.md has the full manual check):'
Write-Output "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Output "  Get-Content `"$logFile`" -Tail 5"
Write-Output ''
Write-Output 'LastTaskResult 267009 means RUNNING, which is what you want here.'
Write-Output 'A 0 means the agent EXITED - that is a failure dressed as success.'
Write-Output ''
Write-Output 'To remove it:'
Write-Output "  Stop-ScheduledTask       -TaskName '$TaskName'"
Write-Output "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Output "  Get-ScheduledTask        -TaskName '$TaskName' -ErrorAction SilentlyContinue  # must return nothing"
