[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingEmptyCatchBlock', '', Justification = 'Deliberate: $ErrorActionPreference is Stop, and by this point the session is already launched - a failed pid-file write must not abort the script or surface an error with nowhere to go (NonInteractive, stdio ignored).')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingInvokeExpression', '', Justification = 'Running the string IS the feature. -PreLaunch carries the owner-configured pre_launch_command, and it must take effect in THIS session so environment changes reach claude.cmd - a child process would exit and undo them. The rule guards against executing untrusted input; this input comes only from config.json on the local disk, which no API route can write (pinned by a test in accept.test.js) and which already requires the desk access needed to run anything as this user. See resolvePreLaunchCommand in agent/config.js.')]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$SessionName,
    [string]$PidFile,                    # optional ON PURPOSE - see below
    [string]$ConfigDir,                  # optional: absent = Claude Code's own default
    [string]$PreLaunch,                  # optional: absent = auto-detect venv/.venv
    [switch]$NoOpeningReport             # optional: absent = report when HANDOFF.md exists
)

$ErrorActionPreference = 'Stop'

# CLEAR LAST LAUNCH'S FAILURE FIRST. The .err file below is the only place a
# failed pre_launch_command is visible, and nothing else ever deletes it -
# clearPidFile (registry.js) unlinks the .pid and knows nothing about this.
# Without this line a fixed config still shows the old failure for ever, and a
# second failure after a good run is indistinguishable from the first. Cleared
# unconditionally rather than inside the -PreLaunch branch, so a stale file
# does not survive by the owner simply removing the setting.
if ($PidFile) { Remove-Item -LiteralPath "$PidFile.err" -ErrorAction SilentlyContinue }

# T56. This used to join $HOME to one specific personal profile name, hardcoded.
# A stranger got every session launched against a profile directory that does
# not exist on their machine.
# ABSENT BY DEFAULT is the whole point: when no -ConfigDir is passed this leaves
# CLAUDE_CONFIG_DIR unset and Claude Code picks its own default (~/.claude).
# Do not reintroduce a fallback guess here - an unset variable is the correct
# behaviour, and a wrong guess fails in a way that is hard to see from a phone.
if ($ConfigDir) {
    $env:CLAUDE_CONFIG_DIR = $ConfigDir
} else {
    # CLEARED, not merely "not set". Start-Process inherits this process's
    # environment, so without this the launched session would pick up whatever
    # CLAUDE_CONFIG_DIR the AGENT happened to be started with - making the
    # default depend on how the agent was launched rather than on config.
    # That matters more than it looks: workspace trust is per-profile
    # (`hasTrustDialogAccepted`) and its dialog needs a real terminal, so a
    # session landing in an unexpected profile can hang on a modal nobody can
    # answer from a phone.
    Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
}

Set-Location -LiteralPath $ProjectPath

# THE ENVIRONMENT. Two mutually exclusive paths; the default is the one that
# has always run. -PreLaunch REPLACES the auto-detect rather than preceding it,
# so a conda user gets no stray `.venv`. It runs IN THIS SESSION, not a child -
# a child exits and takes the environment with it - and after Set-Location, so
# a relative path resolves against the project. Why executing it is acceptable
# is in the PSAvoidUsingInvokeExpression justification at the top of this file.
if ($PreLaunch) {
    # THE catch IS NOT OPTIONAL. $ErrorActionPreference is 'Stop', so a failure
    # here aborts the script BEFORE Start-Process: no session, no pid file, and
    # nothing visible - the agent still answers 202 and the tile ages into
    # `failed`. A broken environment step must cost the environment, not the
    # session.
    #
    # THE .err FILE IS THE ONLY PLACE A FAILURE CAN BE SEEN. Write-Warning goes
    # to a stream the agent spawns with stdio:'ignore', and this script is
    # -NonInteractive, so without it a failed command is indistinguishable from
    # success at the agent, in the PWA and in this terminal. Beside the pid
    # file: that directory already exists by now and the agent already knows
    # the path.
    #
    # WHAT IS STILL NOT GUARDED, stated because it bit the docs: a command that
    # never RETURNS. There is no timeout here and there cannot easily be one -
    # bounding it would mean a job, a job is a separate runspace, and a
    # separate runspace cannot change THIS session's environment, which is the
    # whole mechanism. A command that blocks (an interactive sub-shell, a
    # prompt) hangs the launcher for ever. The docs carry that constraint.
    try {
        Invoke-Expression $PreLaunch
    } catch { $preLaunchFailure = $_
        # The capture sits ON the catch line deliberately. The recipe test pins
        # this whole line, and it is the only form that works: `'} catch {'`
        # alone also matched the inner catch below, and pinning the assignment
        # on its own line survived a catch->finally mutation. Both were tried
        # and both stayed green. It also keeps the message the OUTER error if
        # the inner catch ever grows a body.
        if ($PidFile) {
            try { Set-Content -LiteralPath "$PidFile.err" -Value "pre_launch_command failed: $preLaunchFailure" -Encoding utf8 } catch { }
        }
    }
} else {
    foreach ($dir in @('venv', '.venv')) {
        $activate = Join-Path $ProjectPath "$dir\Scripts\Activate.ps1"
        if (Test-Path -LiteralPath $activate) {
            . $activate
            break
        }
    }
}

# THE OPENING REPORT. A SessionStart hook can only put text into the model's
# CONTEXT; it cannot make the model SPEAK, because a turn exists only when there
# is a prompt. A trailing positional IS the initial prompt - the very mechanism
# the --name and --remote-control notes below exist to stop happening BY
# ACCIDENT. Here it is deliberate, and it is the only way the report reaches the
# phone: the PWA is a start button, so nobody types the first message.
#
# The inner quotes are load-bearing for the same reason they are on those two
# flags: Start-Process joins ArgumentList with spaces and quotes nothing itself,
# so an unquoted sentence arrives as eight stray arguments.
#
# Guarded on the project HAVING a HANDOFF.md, so a project without one launches
# silent exactly as before. Empty array = nothing appended.
#
# MEASURED 2026-09-09, BOTH HALVES, and recorded here because the --channels
# note below is this file's record of what an unmeasured argument costs.
#   1. The prompt is delivered and processed - the session it launches opens by
#      reporting where the work stands.
#   2. REMOTE CONTROL STILL CONNECTS: the Code-tab row appears. Owner-confirmed
#      on his own device against a real PWA launch.
# Half two is the one that mattered and the one a passing test cannot give you:
# the --channels failure left the session working perfectly and removed only the
# row, so "it launched fine" is not evidence. It took a person looking at the
# app. If a positional is ever changed here, that check is owed again.
# A switch that only ever SUPPRESSES; absent means report. The default and why
# it fails in that direction live on resolveOpeningReport in config.js.
$openingReport = @()
if (-not $NoOpeningReport -and (Test-Path -LiteralPath (Join-Path $ProjectPath 'HANDOFF.md'))) {
    $openingReport = @('"Read HANDOFF.md and give the opening report."')
}

# 'claude.cmd', NOT 'claude'. On this host the bare name resolves to
# claude.ps1 (npm ships claude, claude.cmd and claude.ps1 side by side),
# and PATHEXT contains no .PS1 - so Start-Process ShellExecutes the .ps1
# and Windows pops a "Pick an app" dialog instead of running anything.
# It fails SILENTLY: no error is raised even under ErrorActionPreference
# 'Stop', so with stdio:'ignore' the agent reports 202 "starting" and
# nothing ever starts. Verified on this machine 2026-08-25.
$proc = Start-Process -FilePath 'claude.cmd' -WorkingDirectory $ProjectPath -PassThru -ArgumentList (@(
    # NO --channels HERE, and that is a deliberate reversal. Measured
    # 2026-09-05: with `--channels=plugin:whatsapp-channel@whatsapp-claude-plugin`
    # a PWA-launched session starts fine - correct window title, TUI drawn - and
    # then sits on `/rc connecting...` indefinitely; the Code-tab row never
    # appears. Removing ONLY that flag, with the same exe, quoting, --name and
    # --remote-control, connects quickly. Owner confirmed both arms on his own
    # machine. Channels is an experimental second input channel into the same
    # session that Remote Control also wants to own, and the two do not coexist.
    #
    # The cost, stated plainly: a session launched FROM THE PHONE can no longer
    # receive WhatsApp messages. That is the right trade here and only here -
    # a phone-launched session exists to become a Code-tab row, which is exactly
    # what the flag was preventing. The desk aliases (`claudemax`/`claudepro` in
    # ~/.bashrc and the PowerShell profile) still pass --channels, so WhatsApp
    # inbound is untouched where it is actually used.
    #
    # If it ever comes back, it must come back BEHIND a check that Remote
    # Control still connects, not on the assumption that adding a flag is free.

    # The terminal tab. `--remote-control <name>` names the REMOTE CONTROL
    # session (the Code-tab row) and does NOT touch the window title - a
    # PWA-launched tab read "Claude Code" until this was added, verified from
    # the owner's screenshot 2026-08-27. --name is the one that reaches the
    # title (its --help: "shown in the prompt box, /resume picker, and
    # terminal title"). The FOLDER LEAF, because that is what the owner
    # recognises in the picker - e.g. `Harbor`, not its full path.
    # CORRECTED 2026-09-04: this used to add "not $SessionName, which is the
    # sanitized lowercase-hyphen form" - true then, wrong now. $SessionName is
    # the folder leaf too since the Code-tab row was found reading
    # `f-dev-projects-workspace-8a320b.email-lint`. The two carry the same value by
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
    # 2026-09-04 while diagnosing an outage (a launched session opened a blank
    # console and never reached the Code tab) and did NOT fix it. The failure
    # reproduced with this file byte-identical to its last known-good version,
    # and the same file then succeeded seven launches in a row. The argument
    # form was never the cause; that outage has no proven root cause.
    #
    # The value FORM is pinned in sessions.test.js's recipe-integrity test and
    # in detachment.test.js's requiredTokens - it was the bare flag until
    # 2026-09-04, which is how a change here passed 992 green tests.
    "--remote-control=`"$SessionName`""
) + $openingReport)

# Liveness for the agent's session registry. The pid the agent's own
# spawn() returns is this PowerShell host, which exits in seconds - useless.
# This is the real one: claude.cmd CALLs claude.exe with no `start`, so the
# cmd.exe this pid belongs to lives exactly as long as the session.
# try/catch is load-bearing: $ErrorActionPreference is 'Stop', and a failed
# write here would abort the script AFTER the session is already up.
if ($PidFile -and $proc -and $proc.Id) {
    try { Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii } catch { }
}
