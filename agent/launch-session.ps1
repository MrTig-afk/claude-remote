[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingEmptyCatchBlock', '', Justification = 'Deliberate: $ErrorActionPreference is Stop, and by this point the session is already launched - a failed pid-file write must not abort the script or surface an error with nowhere to go (NonInteractive, stdio ignored).')]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$SessionName,
    [string]$PidFile                     # optional ON PURPOSE - see below
)

$ErrorActionPreference = 'Stop'

$env:CLAUDE_CONFIG_DIR = Join-Path $HOME '.claude-max'

Set-Location -LiteralPath $ProjectPath

foreach ($dir in @('venv', '.venv')) {
    $activate = Join-Path $ProjectPath "$dir\Scripts\Activate.ps1"
    if (Test-Path -LiteralPath $activate) {
        . $activate
        break
    }
}

# 'claude.cmd', NOT 'claude'. On this host the bare name resolves to
# claude.ps1 (npm ships claude, claude.cmd and claude.ps1 side by side),
# and PATHEXT contains no .PS1 - so Start-Process ShellExecutes the .ps1
# and Windows pops a "Pick an app" dialog instead of running anything.
# It fails SILENTLY: no error is raised even under ErrorActionPreference
# 'Stop', so with stdio:'ignore' the agent reports 202 "starting" and
# nothing ever starts. Verified on this machine 2026-08-25.
$proc = Start-Process -FilePath 'claude.cmd' -WorkingDirectory $ProjectPath -PassThru -ArgumentList @(
    '--channels', 'plugin:whatsapp-claude-channel@whatsapp-claude-plugin',
    '--remote-control', $SessionName
)

# Liveness for the agent's session registry (T29). The pid the agent's own
# spawn() returns is this PowerShell host, which exits in seconds - useless.
# This is the real one: claude.cmd CALLs claude.exe with no `start`, so the
# cmd.exe this pid belongs to lives exactly as long as the session.
# try/catch is load-bearing: $ErrorActionPreference is 'Stop', and a failed
# write here would abort the script AFTER the session is already up.
if ($PidFile -and $proc -and $proc.Id) {
    try { Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii } catch { }
}
