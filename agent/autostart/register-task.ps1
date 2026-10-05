<#
.SYNOPSIS
Registers (or, with -RenderOnly, just renders and schema-validates) the
Scheduled Task that starts the claude-remote Local Agent at logon.
To undo it, see "Uninstall" in README.md.
To (re)start the agent, run update-agent.ps1 beside this file: it stops the
old one properly, registers, starts and checks the new one.
#>
[CmdletBinding()]
param(
    [switch]$RenderOnly,
    [string]$OutFile = (Join-Path $env:TEMP 'claude-remote-agent.xml'),
    [string]$TaskName = 'Claude Remote Agent',
    # Where hidelaunch.exe is built. Default below, because Windows PowerShell
    # 5.1 leaves $PSScriptRoot empty in a param default under -File.
    [string]$LauncherDir,
    # Smart App Control as this PC has it. Read from the registry when not
    # given; the tests pass it so both launchers are covered on any machine.
    [ValidateSet('', 'On', 'Off')]
    [string]$SmartAppControl = ''
)

$ErrorActionPreference = 'Stop'

$agentDir = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $agentDir 'server.js'
$templatePath = Join-Path $PSScriptRoot 'claude-remote-agent.task.xml'
$dataDir = Join-Path $env:USERPROFILE '.claude\plugins\data\claude-remote-claude-remote'
$logFile = Join-Path $dataDir 'agent.log'
if (-not $LauncherDir) { $LauncherDir = $dataDir }
# Absolute, always. A relative -LauncherDir would be created against the
# CALLER's working directory and then land verbatim in the task's <Command>,
# where the scheduler resolves it against WorkingDirectory instead - so the
# task would start nothing, silently, at every logon and every crash restart.
$LauncherDir = [IO.Path]::GetFullPath($LauncherDir)

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

# The launcher that starts node with no window: hidelaunch.exe, built here from
# hidelaunch.cs by the C# compiler that ships inside Windows with the .NET
# Framework. Nothing is downloaded and no binary lives in the repo.
#
# It is built into the DATA folder, deliberately NOT into the install folder:
# update-agent.ps1 swaps the install folder by renaming it, and a running .exe
# inside it would be locked and fail that rename. The data folder is never
# swapped, so an update never has to move this file.
#
# The name carries a hash of the source, so a changed hidelaunch.cs compiles to
# a NEW path instead of trying to overwrite a copy that a running agent still
# holds open. An unchanged source is not rebuilt at all.
#
# OLD BUILDS ARE LEFT BEHIND, DELIBERATELY. A sweep that deleted them was
# written and removed on review: it ran before the -RenderOnly return, so the
# documented read-only diagnostic could delete the 5KB exe the REGISTERED task
# still points at, leaving both triggers naming a missing file forever. It
# would also have made two task names registered from different sources evict
# each other's launcher. A few 5KB files is the cheaper failure.
#
# EXCEPT WHERE SMART APP CONTROL IS ON (owner 2026-09-27, "B plus A"). There
# Windows runs an unsigned program only while Microsoft's cloud rates it safe,
# and it re-rates: hidelaunch ran for nine days under SAC and was then blocked
# by hash (CodeIntegrity 3118, DefenderMadeCloudCall=false, TTLValid=false; an
# exact copy blocked too, a fresh build ran). So on those PCs the task uses
# conhost.exe --headless, which Microsoft signs and SAC always allows. Its costs
# (see the task template) are accepted there: SAC is off on enterprise-managed
# PCs, where EDR rules against that shape run, and crash recovery is the
# every-minute trigger, which does not need the exit code it loses.
if (-not $SmartAppControl) {
    $sac = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
    $SmartAppControl = if ($sac -eq 1) { 'On' } else { 'Off' }   # 0 off, 1 on, 2 evaluation
}
$useConhost = $SmartAppControl -eq 'On'

$launcherSrc = Join-Path $PSScriptRoot 'hidelaunch.cs'
if (-not (Test-Path -LiteralPath $launcherSrc)) {
    throw "Cannot find the launcher source at '$launcherSrc' - is this script still inside agent/autostart/?"
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not $useConhost -and -not (Test-Path -LiteralPath $csc)) {
    throw "the .NET Framework C# compiler (csc.exe) was not found under $env:WINDIR\Microsoft.NET - it ships with Windows, so this machine is missing the .NET Framework 4 runtime."
}

$null = New-Item -ItemType Directory -Path $LauncherDir -Force
# .NET, not Get-FileHash: Get-FileHash loads on demand from a module, and
# under a PowerShell 7 parent PSModulePath lists PowerShell 7's copy of that
# module first, which Windows PowerShell cannot load - "Get-FileHash is not
# recognized" (GitHub CI, and anyone who starts Claude Code from pwsh 7).
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $srcHash = -join ($sha.ComputeHash([System.IO.File]::ReadAllBytes($launcherSrc))[0..5] | ForEach-Object { $_.ToString('x2') }) }
finally { $sha.Dispose() }
$launcher = Join-Path $LauncherDir "hidelaunch-$srcHash.exe"
# A full path, like cmd.exe below: never resolved through the search order.
if ($useConhost) { $launcher = Join-Path $env:SystemRoot 'System32\conhost.exe' }

if (-not $useConhost -and -not (Test-Path -LiteralPath $launcher)) {
    # /target:winexe is the whole point: a GUI-subsystem process gets no
    # console of its own, so there is no window to hide and none to flash.
    #
    # Built to a temp name and MOVED into place, because csc writes its output
    # non-atomically: a build interrupted by a sleep, a Ctrl-C or a full disk
    # would leave a truncated hidelaunch-<hash>.exe, and the "already exists"
    # test above would then skip the rebuild forever. The failure that follows
    # names neither the stale file nor the remedy ("not a valid application
    # for this OS platform"), and no code path would ever replace it.
    $partial = "$launcher.$PID.partial"
    Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
    $build = & $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$partial" $launcherSrc 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $partial)) {
        Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
        throw "could not build the launcher from '$launcherSrc' (csc exit $LASTEXITCODE): $build"
    }
    Move-Item -LiteralPath $partial -Destination $launcher -Force
}

# The full path to cmd.exe, never the bare name. hidelaunch calls
# CreateProcess with a null application name, so Windows resolves the first
# token itself - searching the launcher's own directory and the CURRENT
# directory (the task's WorkingDirectory) before System32. A file named
# cmd.exe dropped in either folder would otherwise run as the owner at every
# logon. conhost.exe was passed as a full path before this change; the
# successor is too.
#
# From $env:SystemRoot, deliberately NOT from $env:ComSpec: ComSpec is an
# ordinary user environment variable, and the task inherits the user
# environment, so taking the path from there would put an env-controlled value
# on the one command line that runs at every logon. Nothing is lost by
# ignoring it - the arguments below are cmd syntax (/s /c, &, 2>nul, 1>>), so
# a ComSpec pointing at anything else would not work anyway.
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
if (-not (Test-Path -LiteralPath $cmdExe)) { throw "cmd.exe not found at '$cmdExe'." }

# Prove the built launcher actually runs its command on THIS machine before
# handing it to the scheduler. It waits for the child, so its own exit code is
# the child's: check the wait, the side effect AND the code, because any one
# alone could pass while the task silently starts nothing at every logon.
# Under conhost --headless (Smart App Control On) the code is always 0, so
# there the side effect - the probe file - is the check that proves it ran.
#
# The timeout result is captured rather than discarded: `> "$probe"` creates
# the redirect target the moment cmd STARTS, so Test-Path can pass while the
# launcher is still running, and reading .ExitCode on a live process throws an
# InvalidOperationException naming neither this script nor the timeout - which
# under update-agent.ps1 would drive a healthy update into rollback.
$probe = Join-Path $env:TEMP "claude-remote-launcher-probe-$PID"
Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
$headless = if ($useConhost) { '--headless ' } else { '' }
$p = Start-Process -FilePath $launcher -PassThru -ArgumentList "$headless`"$cmdExe`" /c type nul > `"$probe`""
$exited = $p.WaitForExit(10000)
if (-not $exited) {
    try { $p.Kill() } catch { }
    Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
    throw "'$launcher' did not finish its probe command within 10s - it was killed, and nothing was registered."
}
$ran = Test-Path -LiteralPath $probe
Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
if (-not $ran) {
    throw "'$launcher' did not run its command on this Windows - the agent cannot be started hidden here."
}
if ($p.ExitCode -ne 0) {
    throw "'$launcher' ran its command but reported exit code $($p.ExitCode) instead of the child's 0."
}

$userId = "$env:USERDOMAIN\$env:USERNAME"

# cmd /s /c "<...>": /s strips only the outer quotes and takes the rest
# verbatim, the one form that survives paths with spaces. md creates the
# data dir on a first-ever run (2>nul swallows "already exists").
$arguments = $headless + '"' + $cmdExe + '" /s /c "md "' + $dataDir + '" 2>nul & node.exe "' +
    $serverPath + '" 1>>"' + $logFile + '" 2>&1"'

# Every value is XML-escaped: the arguments carry & and ", and a path may too.
# .Replace() (literal, not -replace) so backslashes need no escaping.
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$rendered = Get-Content -LiteralPath $templatePath -Raw
$rendered = $rendered.Replace('{{USER_ID}}', (& $esc $userId))
$rendered = $rendered.Replace('{{LAUNCHER}}', (& $esc $launcher))
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
# unsupervised, holding the port. Stop-ScheduledTask cannot fix that - it ends
# the launcher the task started and node survives it (measured 2026-09-22 with
# conhost, and the chain still has that shape) - so refuse, and point at the
# script that stops it properly.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw "Task '$TaskName' is running. Use update-agent.ps1 (beside this script), which stops the agent before re-registering it."
}

Register-ScheduledTask -TaskName $TaskName -Xml $rendered -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "node.exe resolved to: $($nodeCmd.Source)"
Write-Output "Hidden launcher: $launcher"
Write-Output "Agent log file: $logFile"
Write-Output ''
Write-Output 'Registering does NOT start it. Start it, and check it came up, with:'
Write-Output "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\update-agent.ps1`""
Write-Output 'To remove it: README.md, "Uninstall".'
