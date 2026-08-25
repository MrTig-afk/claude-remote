[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$SessionName
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
Start-Process -FilePath 'claude.cmd' -WorkingDirectory $ProjectPath -ArgumentList @(
    '--channels', 'plugin:whatsapp-claude-channel@whatsapp-claude-plugin',
    '--remote-control', $SessionName
)
