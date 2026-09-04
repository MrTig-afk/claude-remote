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
    # `--channels=<value>` as ONE argument. The plugin is `whatsapp-channel`;
    # the MARKETPLACE is `whatsapp-claude-plugin`, which is the easy thing to
    # confuse it with. An earlier release carried the marketplace's wording in
    # the plugin half of the spec, and that stale form resolves to "plugin not
    # installed": the channel is allowlisted, then fails to load, so outbound
    # tools keep working while inbound messages never arrive. A test asserts
    # this whole token and that the stale form is absent.
    '--channels=plugin:whatsapp-channel@whatsapp-claude-plugin',
    # The terminal tab. `--remote-control <name>` names the REMOTE CONTROL
    # session (the Code-tab row) and does NOT touch the window title - a
    # PWA-launched tab read "Claude Code" until this was added, verified from
    # the owner's screenshot 2026-08-27. --name is the one that reaches the
    # title (its --help: "shown in the prompt box, /resume picker, and
    # terminal title"). The FOLDER leaf, because the owner wants `MingleHub`.
    # CORRECTED 2026-09-04: this used to add "not $SessionName, which is the
    # sanitized lowercase-hyphen form" - true then, wrong now. $SessionName is
    # the folder leaf too since the Code-tab row was found reading
    # `f-dev-projects-repos-02b052.email-lint`. The two carry the same value by
    # different routes; only the internal session name is still slugged.
    # The inner quotes are load-bearing - Start-Process joins ArgumentList
    # with spaces and adds no quoting of its own, so a project like
    # `Pull Requests` would otherwise arrive as `--name=Pull` plus a stray
    # `Requests` that claude reads as an initial prompt.
    "--name=`"$(Split-Path -Leaf $ProjectPath)`"",
    # ONE ARGUMENT, and the `=` matters. Start-Process joins ArgumentList with
    # spaces and adds no quoting of its own, so passing the flag and the value
    # as two separate array entries splits any name containing a space:
    # `Video Editing` arrives as the flag plus `Video`, and then a stray
    # `Editing`, which claude reads as an INITIAL PROMPT and types into the
    # session. Any project whose folder name contains a space hits this, as
    # does the collision form `email-lint (Work)`.
    #
    # HISTORY, so nobody re-runs it: the two-argument form was reverted to on
    # 2026-09-04 as a diagnostic for an outage and did NOT fix it - the form
    # was never the cause. Full account in .pipeline/spec.md.
    #
    # The value FORM is pinned in sessions.test.js's recipe-integrity test and
    # in detachment.test.js's requiredTokens - it was the bare flag until
    # 2026-09-04, which is how a change here passed 992 green tests.
    "--remote-control=`"$SessionName`""
)

# Liveness for the agent's session registry. The pid the agent's own
# spawn() returns is this PowerShell host, which exits in seconds - useless.
# This is the real one: claude.cmd CALLs claude.exe with no `start`, so the
# cmd.exe this pid belongs to lives exactly as long as the session.
# try/catch is load-bearing: $ErrorActionPreference is 'Stop', and a failed
# write here would abort the script AFTER the session is already up.
if ($PidFile -and $proc -and $proc.Id) {
    try { Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii } catch { }
}
