<#
.SYNOPSIS
Stops the claude-remote Local Agent, optionally installs a new version,
re-registers the logon task, starts it, and proves the new process is the one
serving - rolling back to the previous copy if it is not.

.DESCRIPTION
Without -Source: restart in place (a checkout, or after editing the task).
With -Source: install the agent from -Source (a plugin folder holding agent\
and release-notes.json) into -Target. Setup runs the copy of this script that
ships with the NEW version, so the new version's rules do the update.

Order, and why:
  1. Stage the new copy beside the old one BEFORE stopping anything, so a
     failed copy costs nothing.
  2. Disable the task (its once-a-minute trigger would restart the old copy),
     then kill node directly: Stop-ScheduledTask ends conhost only and node
     survives it (measured 2026-09-22). Wait until node is gone and the port
     is free; if it will not go, stop here with nothing changed.
  3. Swap folders by rename: instant, never half-copied.
  4. Register, start, and wait for the 127.0.0.1 listener to be node, from
     this folder, started after step 4 began, answering HTTP.
  5. Any failure: put the previous folder back, start it, check it the same
     way, and exit non-zero.
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string]$Target,    # default: the folder this script ships in (set below)
    [string]$TaskName = 'Claude Remote Agent',
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
# Here, not as a param default: Windows PowerShell 5.1 leaves $PSScriptRoot
# empty in a param default under -File (measured 2026-09-23).
if (-not $Target) { $Target = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$port = if ($env:CLAUDE_REMOTE_AGENT_PORT) { [int]$env:CLAUDE_REMOTE_AGENT_PORT } else { 8790 }
$Target = [IO.Path]::GetFullPath($Target).TrimEnd('\')
$server = "$Target\agent\server.js"
$new = "$Target.new"
$prev = "$Target.prev"
$failed = "$Target.failed"
$log = Join-Path $env:USERPROFILE '.claude\plugins\data\claude-remote-claude-remote\agent.log'

# 127.0.0.1 ONLY. tailscale serve listens on the same port number on the
# tailnet addresses, and on this PC the first listener returned was tailscaled.
function Get-PortOwner {
    @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess |
        Select-Object -First 1
}

# Quotes are dropped before comparing: the command line conhost hands on for
# a path with spaces reads `C:\...\cr" install "test\agent\server.js` (measured
# 2026-09-22) - the same path to node, but not the same text.
function Test-Contains([string]$Text, [string]$Part) {
    $Text -and $Text.Replace('"', '').IndexOf($Part, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

# This copy's node, plus an agent server.js from an older setup that holds the
# port (it would keep the port while ours dies on EADDRINUSE). No other node.
function Get-AgentProcess {
    $holder = Get-PortOwner
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        (Test-Contains $_.CommandLine $server) -or
        ($_.ProcessId -eq $holder -and $_.CommandLine -match '\\agent\\server\.js')
    }
}

function Wait-Until([scriptblock]$Condition) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return [bool](& $Condition)
}

function Stop-Agent {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        # A task registered from an Administrator PowerShell is owned by
        # Administrators and read-only to this user (measured 2026-09-22);
        # one registered normally is fully the user's.
        try { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
        catch {
            throw "cannot change the task '$TaskName' ($_). It was registered from an Administrator PowerShell, so a normal one may not touch it. Once, in an Administrator PowerShell: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false - then run this again"
        }
        Stop-ScheduledTask -TaskName $TaskName
    }
    $ids = @(Get-AgentProcess | ForEach-Object ProcessId)
    foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    $gone = Wait-Until {
        -not ($ids.Count -and (Get-Process -Id $ids -ErrorAction SilentlyContinue)) -and -not (Get-PortOwner)
    }
    if (-not $gone) {
        throw "the old agent did not stop within ${TimeoutSeconds}s (127.0.0.1:$port is held by pid $(Get-PortOwner))"
    }
}

function Start-Agent {
    # Re-registers from THIS folder's XML, enabled - so a changed task
    # definition ships with the version that needs it.
    & "$Target\agent\autostart\register-task.ps1" -TaskName $TaskName | Out-Null
    $since = Get-Date
    Start-ScheduledTask -TaskName $TaskName
    $serving = Wait-Until {
        $owner = Get-PortOwner
        if (-not $owner) { return $false }
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
        $p.Name -eq 'node.exe' -and (Test-Contains $p.CommandLine $server) -and $p.CreationDate -ge $since
    }
    if (-not $serving) {
        throw "no agent from '$Target' is listening on 127.0.0.1:$port after ${TimeoutSeconds}s - see $log"
    }
    $status = (Invoke-WebRequest "http://127.0.0.1:$port/api/auth/status" -UseBasicParsing -TimeoutSec 10).StatusCode
    if ($status -ne 200) { throw "the agent is listening but /api/auth/status answered $status - see $log" }
    "agent running from '$Target' (pid $(Get-PortOwner))"
}

# The one way out of a failed swap or a failed start: set the bad copy aside
# (when it is in place), put the previous copy back, start it. It never throws:
# whatever happens, the task ends ENABLED, so the every-minute trigger keeps
# trying even when this attempt could not.
function Restore-Previous([string]$Reason, [switch]$SetAsideTarget) {
    $problem = $null
    try { Stop-Agent } catch { $problem = $_ }
    # The folders go back even when the stop failed (say, something else holds
    # the port): whatever the task starts next, now or a minute from now,
    # must be the previous version, never the one that just failed.
    try {
        if ($SetAsideTarget) {
            # Move-Item INTO a leftover folder nests instead of replacing, so
            # a .failed that would not delete gets a fresh name instead.
            $aside = $failed
            Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $aside) { $aside = "$failed-$(Get-Date -Format yyyyMMdd-HHmmss)" }
            Move-Item -LiteralPath $Target -Destination $aside
        }
        if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $prev)) {
            Move-Item -LiteralPath $prev -Destination $Target
        }
        if (-not $problem) {
            Start-Agent | Out-Null
            return "$Reason - the previous version is running again"
        }
    } catch { $problem = $_ }
    try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null } catch { }
    "$Reason - and starting the previous version failed too ($problem). The task is enabled and retries every minute; see $log"
}

if ($Source) {
    $Source = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    if (-not (Test-Path -LiteralPath "$Source\agent\server.js")) { throw "no agent at '$Source'" }
    if ($Source -eq $Target) { throw '-Source and -Target are the same folder' }
    Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
    robocopy "$Source\agent" "$new\agent" /MIR /XD "$Source\agent\test" /NFL /NDL /NJH /NJS /NP | Out-Null
    # robocopy: 0-7 is success of some kind, 8 and up is a failure.
    if ($LASTEXITCODE -ge 8) { throw "copying the new version failed (robocopy $LASTEXITCODE) - nothing was stopped" }
    Copy-Item -LiteralPath "$Source\release-notes.json" -Destination $new
}

try { Stop-Agent }
catch {
    # Nothing was swapped: let the old agent (or the task) carry on.
    $why = $_
    try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null } catch { }
    throw "$why - nothing was changed"
}

if ($Source) {
    try {
        Remove-Item -LiteralPath $prev -Recurse -Force -ErrorAction SilentlyContinue
        # A leftover .prev (a window open inside it) would swallow the install
        # as a subfolder, and a later rollback would restore an empty shell.
        if (Test-Path -LiteralPath $prev) { throw "could not remove '$prev' - close any window or terminal open inside it" }
        if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $prev }
        Move-Item -LiteralPath $new -Destination $Target
    } catch {
        # Neither move leaves the NEW copy at $Target, so nothing is set aside.
        throw (Restore-Previous "could not swap in the new version ($_)")
    }
}

try { Start-Agent }
catch {
    $why = $_
    if (-not $Source -or -not (Test-Path -LiteralPath $prev)) {
        # Nothing to roll back to. Stop-Agent disabled the task and a
        # register-task.ps1 that threw early never re-enabled it: do it here,
        # so the every-minute trigger and the next logon still try.
        try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null } catch { }
        throw "the agent did not come back: $why"
    }
    Write-Warning "the new version did not come up ($why) - rolling back"
    throw (Restore-Previous "update failed ($why); the failed copy is at '$failed'" -SetAsideTarget)
}
