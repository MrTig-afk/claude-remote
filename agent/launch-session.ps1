[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingEmptyCatchBlock', '', Justification = 'Deliberate, at TWO sites with DIFFERENT reasons. (1) The pid-file write: by that point the session is already launched, so a failed write must not abort the script or surface an error with nowhere to go (NonInteractive, stdio ignored). (2) Write-LaunchRefusal: nothing is launched there and the swallowed failure is the REASON WRITE ITSELF - if Set-Content fails (pidDir removed, AV lock, read-only profile) the script still exits 1, and the owner gets a reasonless failed tile after the grace window. Throwing instead would replace a bad message with no message and no exit code, which is worse. Recorded rather than glossed: this is a known hole, not a covered case.')]
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

# THE ONE WAY THIS SCRIPT REFUSES TO LAUNCH. Write the reason where the
# agent can find it, then stop - no Start-Process, no pid file.
#
# The .err file is the ONLY place a failure can be seen. Write-Warning goes to
# a stream the agent spawns with stdio:'ignore', and this script runs
# -NonInteractive, so without this write a failure is indistinguishable from
# success at the agent, in the PWA, and in this terminal.
#
# `exit` inside a function ends the SCRIPT in PowerShell, not just the
# function. That is the intent and it is the reason this is a function at all:
# every refusal path writes the same file and stops the same way, so a new one
# cannot be added that forgets half of it.
function Write-LaunchRefusal([string]$Reason) {
    if ($PidFile) {
        try { Set-Content -LiteralPath "$PidFile.err" -Value $Reason -Encoding utf8 } catch { }
    }
    exit 1
}

# CLEAR LAST LAUNCH'S FAILURE FIRST. The .err file below is the only place a
# failed pre_launch_command is visible. Since 2026-09-12 clearPidFile
# (registry.js) deletes it too, on a deliberate stop and on launchSession's
# pre-spawn clear - this line is the second of the two clears its comment
# names - while clearPidFileOnly, on the already-gone paths, KEEPS it on
# purpose. Cleared here as well so the script is right when run by hand with
# no agent ahead of it, and unconditionally rather than inside the -PreLaunch
# branch, so a stale file does not survive by the owner simply removing the
# setting.
if ($PidFile) { Remove-Item -LiteralPath "$PidFile.err" -ErrorAction SilentlyContinue }

# This used to join $HOME to one specific personal profile name, hardcoded.
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

# WRAPPED, BUT READ THE LIMIT BEFORE TRUSTING IT. This catches a ProjectPath
# that vanishes, which under $ErrorActionPreference = 'Stop' otherwise kills the
# script with NO .err - the reasonless failure the refused launch exists to abolish.
#
# IT IS ALMOST UNREACHABLE IN PRODUCTION, and an earlier version of this comment
# claimed otherwise. sessions.js spawns this script with `cwd: r.path` - the
# SAME path - so a missing folder makes NODE fail with ENOENT and PowerShell
# never starts at all. The script's own guard only covers the window between
# node's cwd check and this line. A spawn that fails outright is reported by
# sessions.js's `error` handler, which writes this same .err (since 2266724).
try {
    Set-Location -LiteralPath $ProjectPath
} catch {
    Write-LaunchRefusal "could not open the project folder '$ProjectPath': $_"
}

# RESOLVED BEFORE THE VENV TOUCHES $env:PATH. This is the second half of the
# fix that removed the Activate.ps1 dot-source, and without it that fix was
# worth very little.
#
# AFTER -PreLaunch, DELIBERATELY. An earlier version resolved before it, which
# refused any pre_launch_command that PUTS claude.cmd on PATH - a version
# manager or toolchain shim - for no security gain: -PreLaunch is arbitrary
# owner-configured code running with full user permissions already (see the
# PSAvoidUsingInvokeExpression justification at the top). Only the venv
# auto-detect, which reads a path out of the PROJECT, needs resolution to come
# first.
#
# Activating a venv PREPENDS <project>\venv\Scripts to PATH. Launching by the
# bare name `claude.cmd` then resolves through that PATH - so a cloned repo
# carrying venv\Scripts\python.exe (to be detected) AND venv\Scripts\claude.cmd
# would have its own claude.cmd run instead of the real one, at full user
# permissions, the moment its tile is tapped. Exactly the attack that was just
# closed, one step further down the script.
#
# Resolving to an absolute Source here removes the name lookup from the launch
# entirely. MEASURED 2026-09-13, because an earlier version of this comment
# asserted an ordering the code does not have: `Get-Command <name>
# -CommandType Application` does NOT search the current directory, so running
# after Set-Location is harmless.
#
# WHAT THIS DOES NOT FIX, said plainly: Claude Code and every tool
# and hook it runs INHERIT the modified PATH, so any command they call by bare
# name - git, bash, python - resolves into the project's venv\Scripts first. A
# repo shipping its own venv\Scripts\git.exe runs it the first time Claude
# calls `git`. That is what activating a venv means, and it is why the README
# says a launched session is not a sandbox; the tap itself executes nothing
# from the project, but the session it starts works inside the project. What
# is fixed here is the part this launcher controls: which executable IT starts.
# A FUNCTION WITH TWO CALLERS, because the two environment branches need it at
# OPPOSITE moments and a single call site had to be wrong for one of them:
#   -PreLaunch      -> AFTER, so a pre_launch_command that PUTS claude.cmd on
#                      PATH (a version manager, a toolchain shim) still works.
#                      Resolving before it refused those for no security gain.
#   auto-detect     -> BEFORE, because the venv prepends a path read out of the
#                      PROJECT and that is the hijack being closed.
function Resolve-ClaudeExe {
    $exe = (Get-Command claude.cmd -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
    if (-not $exe) {
        Write-LaunchRefusal "claude.cmd is not on PATH, so there is no Claude Code to start."
    }
    return $exe
}

# CLEARED FOR BOTH BRANCHES, and it used to be cleared for only one.
# Start-Process inherits this process's environment - the same argument the
# CLAUDE_CONFIG_DIR block above makes - so an agent started by hand from an
# activated shell handed its own VIRTUAL_ENV to every project that has none.
# Hoisted above the branch so a -PreLaunch project is covered too; the venv
# branch sets it again when it actually activates one.
#
# The PATH half of that inheritance is NOT undone: unpicking one venv's entries
# out of an inherited PATH means parsing it, and getting that wrong breaks every
# launch rather than one. Stated rather than quietly skipped.
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue

# THE ENVIRONMENT. Two mutually exclusive paths; the default is the one that
# has always run. -PreLaunch REPLACES the auto-detect rather than preceding it,
# so a conda user gets no stray `.venv`. It runs IN THIS SESSION, not a child -
# a child exits and takes the environment with it - and after Set-Location, so
# a relative path resolves against the project. Why executing it is acceptable
# is in the PSAvoidUsingInvokeExpression justification at the top of this file.
if ($PreLaunch) {
    # THE LAUNCH STOPS HERE. Owner's decision, 2026-09-12.
    #
    # THIS REVERSES WHAT THIS BLOCK USED TO DO, and the old behaviour is worth
    # stating because the comment defending it stood here for weeks: the catch
    # used to write the .err and FALL THROUGH to Start-Process, on the argument
    # that "a broken environment step must cost the environment, not the
    # session". The cost of that argument was a session that is alive and
    # wrong at the same time - a CONDITION that persists, which had to be shown
    # on a surface that also carries transient news. FIVE user-visible designs
    # were refuted trying to draw it in two review cycles, and the approved design
    # deleted the state instead of drawing it a sixth time.
    #
    # So: write the reason, then EXIT. No Start-Process, no pid file. The agent
    # sees a .err beside a missing pid file, which is now a definite verdict
    # rather than a guess, and reports `could not start` with this text.
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
        Write-LaunchRefusal "pre_launch_command failed: $preLaunchFailure"
    }

    # AFTER the owner's command, on purpose - see Resolve-ClaudeExe.
    $claudeExe = Resolve-ClaudeExe
} else {
    # LOOK IN THE PROJECT. Nothing is configured and nothing is
    # remembered, so a folder made a minute ago behaves like one used for a
    # year. Two things are looked for, in this order, and the FIRST hit wins.
    #
    # BEFORE any of it - see Resolve-ClaudeExe. The venv is about to prepend a
    # directory read out of the project, and resolving by name after that is the
    # hijack this closes.
    $claudeExe = Resolve-ClaudeExe
    $activated = $false

    # THE PROJECT'S OWN SCRIPT IS NEVER EXECUTED, AND THAT IS THE WHOLE POINT
    # OF THIS BLOCK. It used to `. $activate` - dot-source
    # `<project>\venv\Scripts\Activate.ps1` - which is ARBITRARY CODE FROM THE
    # PROJECT FOLDER, run at full user permissions the moment a tile is tapped.
    # Clone someone's repository, tap it on your phone, run their code. That
    # predated the environment rules by a long way and was found by the security review of
    # c27ecc4 on 2026-09-13.
    #
    # It also contradicted this project's own rule, already written into the PRD:
    # the per-project command is deliberately NOT a file inside the
    # project, "because a cloned repository must never be able to run a command
    # when its tile is tapped". The venv path was violating that rule the whole
    # time.
    #
    # NOTHING IS LOST BY NOT RUNNING IT. Activating a venv is three environment
    # changes, and Activate.ps1's remaining work - setting a shell prompt and
    # defining `deactivate` - is meaningless to a launcher that starts one
    # process and exits. Start-Process inherits this environment, so Claude Code
    # and everything under it see the venv exactly as before.
    #
    # DETECTED BY THE INTERPRETER, NOT BY THE SCRIPT. `python.exe` is what makes
    # a venv usable; Activate.ps1 is now never read, never executed, and its
    # absence or corruption cannot affect a launch at all.
    foreach ($dir in @('venv', '.venv')) {
        $venvRoot = Join-Path $ProjectPath $dir
        $venvScripts = Join-Path $venvRoot 'Scripts'
        if (Test-Path -LiteralPath (Join-Path $venvScripts 'python.exe')) {
            # A `;` CANNOT BE PUT ON PATH AT ALL. It is the separator, it is a
            # legal filename character, and a folder name can come from a clone.
            # There is no escaping that PowerShell's resolver honours, so the
            # only honest options are refuse or silently half-activate - and
            # silently launching outside the venv is the failure this whole
            # block exists to remove.
            if ($venvScripts -like '*;*') {
                Write-LaunchRefusal "this project's path contains a ';', which cannot be placed on PATH, so its virtual environment cannot be activated. Rename the folder."
            }
            $env:VIRTUAL_ENV = $venvRoot
            # NOT QUOTED, AND THE QUOTED VERSION WAS TRIED AND MEASURED WRONG.
            # A review suggested quoting this segment so a `;` in the project
            # path could not split it. Quoting it does not work: PowerShell's
            # command resolution does NOT honour quotes inside a PATH entry, so
            # `python` kept resolving to the SYSTEM interpreter while
            # VIRTUAL_ENV claimed the venv was active - every venv project
            # launched outside its venv, silently. Measured against this repo's
            # own venv on 2026-09-13:
            #   quoted   -> C:\...\Python311\python.exe        (WRONG)
            #   unquoted -> ...\claude-remote\venv\Scripts\python.exe  (right)
            # The test suite could not see it: a synthetic venv only proves
            # `python.exe` EXISTS, never that it RESOLVES.
            #
            # The `;` problem is real, so it is REFUSED above rather than
            # quoted around.
            $env:PATH = "$venvScripts;$env:PATH"
            # venv's own activate clears this, and so must we: a PYTHONHOME
            # inherited from the agent's environment overrides the venv and
            # sends imports to the wrong interpreter's stdlib.
            Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
            $activated = $true
            break
        }
    }

    # A conda project says its environment's name inside environment.yml, which
    # is conda's own file and not something this tool invented. Read the NAME
    # only - it is handed to `conda activate` as an ARGUMENT and never executed,
    # which is what keeps a cloned repository from running anything here.
    $envYml = Join-Path $ProjectPath 'environment.yml'
    if (-not $activated -and (Test-Path -LiteralPath $envYml)) {
        # BOUNDED, and read errors are NOT laundered. -TotalCount stops this
        # materialising an arbitrarily large file from a possibly-cloned
        # project on a machine that commonly has ~1GB free; readErrFile bounds
        # its read for the same reason. And a file that cannot be READ is a
        # different fault from a file with no name in it - saying "no name:"
        # for a locked or unreadable file sends the owner to fix the wrong
        # thing.
        $head = $null
        try {
            $head = Get-Content -LiteralPath $envYml -TotalCount 200
        } catch {
            Write-LaunchRefusal "could not read this project's environment.yml: $_"
        }

        # ANCHORED AT COLUMN 0 and CASE-SENSITIVE (-cmatch, not -match).
        # PowerShell's -match is case-insensitive but YAML keys are not, so
        # `NAME:` matched; and an unanchored `^\s*name:` matched a `name:`
        # nested under another mapping in preference to the real top-level one.
        # Surrounding quotes are stripped and a trailing comment dropped,
        # because `name: "my env"` previously yielded `"my` - truncated at the
        # space, quote kept. This is NOT a YAML parser and does not try to be;
        # WHAT IT STILL GETS WRONG, said plainly rather than waved at: `#` is
        # treated as a comment even inside quotes, which YAML does not do, so
        # `name: "my # env"` parses as `my`. An earlier version of this comment
        # claimed the activation check below catches mis-parses. IT DOES NOT -
        # that check compares conda's result against the SAME mis-parsed value,
        # so it is a tautology with respect to parse errors and can only catch
        # "the parsed name does not exist". On a machine that happens to have a
        # short environment actually called `my`, such a launch would proceed
        # in the wrong one.
        $envName = $null
        foreach ($line in $head) {
            if ($line -cmatch '^name:(.*)$') {
                $value = $Matches[1]

                # A `#` IS ONLY A COMMENT WHEN IT STARTS THE VALUE OR FOLLOWS
                # WHITESPACE. The previous form was `\s*(.+?)\s*(?:#.*)?$`,
                # which got both ends of that wrong: `name: # todo pick one`
                # captured the whole COMMENT as the name, and `name: env#1` -
                # a perfectly ordinary YAML scalar - lost its suffix.
                if ($value -match '^\s*#') {
                    $value = ''
                } elseif ($value -cmatch '^(.*?)\s+#') {
                    $value = $Matches[1]
                }

                # TRIMMED BEFORE THE QUOTES COME OFF, AND AGAIN AFTER.
                # `(.*)` captures whitespace and a single space is TRUTHY in
                # PowerShell, so `name: ` and `name:<tab>` previously produced a
                # non-empty name and sailed past the guard below - the owner was
                # then told their machine had no conda, about an environment
                # called "".
                $envName = $value.Trim().Trim('"', "'").Trim()
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($envName)) {
            Write-LaunchRefusal "environment.yml has no top-level 'name:' in its first 200 lines, so there is no conda environment to activate. Add one, or remove the file."
        }

        # NEVER A PATH. conda activates a value holding / or \ as a
        # prefix INSIDE this project and runs its etc\conda\activate.d\*.ps1 -
        # a cloned repo's own script, on one tap. conda's names cannot hold
        # those or `:`; a leading - or . also rules out `.`, `..` and options.
        if ($envName -match '[\\/:]' -or $envName -match '^[-.]') {
            Write-LaunchRefusal "environment.yml names '$envName', which is a path, not a conda environment name. A path is refused on purpose: it would activate a folder inside the project."
        }

        # CONDA IS FOUND, NOT CONFIGURED. Under -NoProfile nothing `conda init`
        # wrote exists, so a bare `conda activate` is not a command here - it
        # falls through to conda.exe and errors with "Run 'conda init' first".
        # The hook script is what makes activation work in THIS session, and it
        # lives at a small number of standard roots.
        # BUILT DEFENSIVELY. The previous form was one @(...) literal, which
        # PowerShell evaluates ENTIRELY before the loop body runs - so a single
        # unset USERPROFILE or LOCALAPPDATA made Join-Path raise a terminating
        # ParameterBindingValidationException and killed the launcher with no
        # .err. The agent runs as a scheduled task, where neither variable is
        # guaranteed.
        $hook = $null
        $roots = @()
        foreach ($base in @($env:USERPROFILE, $env:LOCALAPPDATA, 'C:\ProgramData')) {
            if (-not $base) { continue }
            foreach ($name in @('miniconda3', 'anaconda3')) {
                $roots += (Join-Path $base $name)
            }
        }
        foreach ($root in $roots) {
            $candidate = Join-Path $root 'shell\condabin\conda-hook.ps1'
            if (Test-Path -LiteralPath $candidate) { $hook = $candidate; break }
        }
        if (-not $hook) {
            Write-LaunchRefusal "$envName is a conda environment (environment.yml), but no conda installation was found on this PC."
        }

        try {
            . $hook
        } catch {
            Write-LaunchRefusal "could not load conda's PowerShell hook at ${hook}: $_"
        }

        # BOTH GUARDS, AND ROUND 2 IS WHY. Removing the try/catch was the
        # wrong half of the round-1 fix: the post-condition is NECESSARY but
        # not SUFFICIENT. A command-RESOLUTION failure IS terminating even
        # though a non-zero exit is not - a hook that loads cleanly but defines
        # no `conda` (a partial install, or a conda whose CONDA_EXE is unset)
        # raises CommandNotFoundException here. Unguarded, that killed the
        # script with NO .err: measured, status 1, errExists false, and the
        # registry then showed `starting` for the full grace window and
        # `failed` with nothing to show.
        try {
            conda activate $envName
        } catch {
            Write-LaunchRefusal "could not run conda activate for '$envName': $_"
        }

        # CHECKED BY POST-CONDITION AS WELL, NEVER BY EXCEPTION ALONE. A try/catch around `conda activate` catches NOTHING useful:
        # a native command exiting non-zero does not raise a terminating error
        # even under $ErrorActionPreference = 'Stop' (MEASURED on this host
        # 2026-09-12: `& cmd /c "exit 1"` inside try/catch did not throw,
        # $LASTEXITCODE = 1). Conda's own activate function runs conda.exe,
        # captures what it prints and Invoke-Expressions it - so for a MISSING
        # environment, the most likely failure by far, conda.exe writes to
        # stderr, the captured string is empty, Invoke-Expression '' is a no-op
        # and nothing is raised at all.
        #
        # The wrapped version of this shipped for exactly one review round and
        # would have silently reinstated the state the approved design deleted:
        # a cloned repo naming an environment that does not exist here would
        # have launched a healthy-looking session sitting in `base`.
        #
        # CONDA_DEFAULT_ENV is what conda itself sets on success, so comparing
        # it is a claim about the environment this process is actually in
        # rather than about whether a command complained.
        if ($env:CONDA_DEFAULT_ENV -ne $envName) {
            Write-LaunchRefusal "could not enter the conda environment '$envName'. conda is installed, but that environment does not exist on this PC or could not be entered."
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
# A switch that only ever SUPPRESSES. The agent passes it unless the config
# says `opening_report: true` - OFF by default; resolveOpeningReport in
# config.js says why.
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
$proc = Start-Process -FilePath $claudeExe -WorkingDirectory $ProjectPath -PassThru -ArgumentList (@(
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
