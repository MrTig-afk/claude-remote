# Starting the Local Agent automatically at logon

Status: written and validated tonight, NOT applied. `register-task.ps1
-RenderOnly` was run (renders + schema-validates, registers nothing) and its
output is quoted below. No `Register-ScheduledTask`, no `schtasks /Create`, no
Scheduled Task of any kind exists on this machine as a result of this work.
`Get-ScheduledTask -TaskName 'Claude Remote Agent'` returns nothing, verified.

## The problem, in two sentences

`tailscale serve --bg` survives a reboot on its own, but the Node Local Agent
behind it does not, so after any restart `tailscale serve` keeps answering with
a proxy error and the phone has no way to say why. This document makes the
agent start itself back up the moment the owner logs in, instead of the owner
discovering the outage from a cafe.

## ELI5

`tailscale serve` is the doorman: after a power cut he comes back to his post on
his own. The Local Agent is the shop behind him, and the shop does not reopen
itself just because the doorman is back. This work makes the shop open itself
the moment someone unlocks the front door (logs in) — the doorman was never the
part that was broken.

## What ships vs what the owner runs

Shipped, in the repo, doing nothing until run:
- `agent/autostart/claude-remote-agent.task.xml` — the Scheduled Task
  definition, as a template with four placeholders filled in at register time.
- `agent/autostart/start-agent-hidden.vbs` — a 12-line VBScript shim. A
  Scheduled Task action cannot point straight at `node.exe` and stay hidden
  and restart-supervised at the same time (see "Rejected alternatives"); this
  shim is what makes both true together. It waits on node and returns node's
  exit code, so a crash is visible to the task's own restart policy.
- `agent/autostart/register-task.ps1` — renders the template, schema-validates
  it via the Task Scheduler COM API, and (unless `-RenderOnly`) registers it.

Not shipped, and not run by anyone but the owner: the actual
`Register-ScheduledTask` call. No JavaScript changed — the agent already
starts correctly under `node agent/server.js` regardless of what launched
`node`, binds only to `127.0.0.1:8790`, and handles the case where an agent is
already running (see "Already-running case" below) without any code change.

## Registering it

From the repo root, in a normal (non-elevated) PowerShell window:

```powershell
powershell -NoProfile -File .\agent\autostart\register-task.ps1
```

Actual output from tonight's dry run (`-RenderOnly`, nothing registered):

```
Rendered and schema-validated task XML written to: C:\Users\<user>\AppData\Local\Temp\claude-remote-agent.xml
nothing was registered
```

If `Register-ScheduledTask` ever refuses the XML on some future Windows
build, the fallback is the same document via the classic tool
(`-RenderOnly` already wrote it as UTF-16):

```powershell
powershell -NoProfile -File .\agent\autostart\register-task.ps1 -RenderOnly
schtasks /Create /TN "Claude Remote Agent" /XML "$env:TEMP\claude-remote-agent.xml" /F
```

To try it immediately, without waiting for a reboot:

```powershell
Start-ScheduledTask -TaskName 'Claude Remote Agent'
```

## Verification — PARTLY MANUAL, and "the register command exited 0" is not acceptance

Automated tonight, without registering anything (all passed):

1. `Invoke-ScriptAnalyzer -Path .\agent\autostart\register-task.ps1` — clean,
   no errors or warnings.
2. `register-task.ps1 -RenderOnly` — exits 0, prints the rendered path and
   `nothing was registered`.
3. `Get-ScheduledTask -TaskName 'Claude Remote Agent' -ErrorAction
   SilentlyContinue` — returns nothing.
4. The rendered XML has no leftover `{{` placeholder, and contains
   `ExecutionTimeLimit>PT0S`.
5. (Not part of this check.) Autostart adds no JavaScript, so the JS test
   suite says nothing about whether it works — a green run would only mean
   nothing else broke. It was deliberately not run as autostart verification
   and no claim about it is made here.
6. Shim smoke test — started `wscript.exe start-agent-hidden.vbs` directly
   (no task involved), confirmed no window appeared, confirmed
   `agent.log`'s last line was `Local Agent listening on
   http://127.0.0.1:8790 (base: ...)`, confirmed by process id and
   `Get-NetTCPConnection` that it was genuinely listening on 8790, then
   killed it and confirmed with `tasklist` and `Get-NetTCPConnection` that
   nothing was left behind.

Still manual, only possible once the owner actually registers the task and
reboots or signs out and back in:

1. Register, then reboot or sign out/in.
2. At the desk, without opening a terminal first: no console window appeared
   at logon.
3. `Invoke-RestMethod http://127.0.0.1:8790/api/projects` returns the project
   list (or a `401` once the passcode ships — either proves the agent is
   answering).
4. `Get-ScheduledTaskInfo -TaskName 'Claude Remote Agent'` shows
   `LastTaskResult 267009` (0x41301, "still running"). A plain `0` means the
   task started and already exited — a FAIL dressed as success.
5. Tail `agent.log`; the newest `listening` line is from this logon.
6. Launch check, do not skip: from the phone (or `POST /api/sessions`
   locally), start a session for a real project and confirm it appears in the
   Claude app's Code tab. This is the one check that would notice a
   scheduler environment where `claude.cmd` is not on PATH the way it is in
   an interactive terminal.
7. Once `tailscale serve --bg --https=8790 8790` is on:
   `https://<machine>.<tailnet>.ts.net:8790` loads after a reboot with
   nobody having started anything by hand.
8. Restart check: `Stop-Process` the agent's `node.exe` and confirm it is
   back within about a minute (repeat step 3). **This is the ONLY proof that
   restart-on-failure actually works.** Nothing in this repo can verify it —
   it needs a registered task, which is why it is your step. If the agent is
   not back in roughly two minutes, restart-on-failure is NOT working, no
   matter what the task's status column says.

## KNOWN LIMITATION

A logon trigger only fires on a logon. A cold boot that stops at the Windows
lock screen leaves the agent down until someone actually signs in — the PWA
is dead exactly during that window. Running the task at boot as SYSTEM would
close this gap, but it would also run the agent (and therefore every Claude
Code session it launches) as SYSTEM instead of the owner, which is the wrong
trade and is not made here.

Second limitation, in the same breath: this only restores the *ability to
start* a session. Sessions themselves — tmux, the Claude Code process inside
them — do not survive a reboot either. This work brings back the doorman's
shop, not the customers who were inside it when the power went out.

## Already-running case

If the owner already has an agent running from a terminal when the task
fires, the task's own `node` hits `EADDRINUSE`, logs it, and exits 1. Task
Scheduler retries up to three times one minute apart and then stops — the
manually-started agent keeps serving throughout. That is the correct
outcome; nothing needs to notice or work around it.

One consequence worth knowing, because it is silent: after those three
retries the task has GIVEN UP and will not try again until the next logon.
So if you later close the terminal agent, nothing takes over — the PWA goes
dead even though the task exists and looks fine. Recover without logging out:

```powershell
Start-ScheduledTask -TaskName 'Claude Remote Agent'
```

## Removing it

```powershell
Stop-ScheduledTask       -TaskName 'Claude Remote Agent'
Unregister-ScheduledTask -TaskName 'Claude Remote Agent' -Confirm:$false
Get-ScheduledTask        -TaskName 'Claude Remote Agent' -ErrorAction SilentlyContinue  # must return nothing
```

`Stop-ScheduledTask` ends the running agent process too; nothing else is left
behind except the log file, which is the owner's to delete. Removing the task
does not touch `tailscale serve` — that is a separate command
(`tailscale serve --https=8790 off`) and a separate decision.

## Rejected alternatives

- **Task at boot, as SYSTEM.** Closes the lock-screen gap but runs the agent
  under the wrong account entirely — wrong or absent user profile, and it
  hands a full-machine session launcher to SYSTEM.
- **`LogonType` S4U ("run whether user is logged on or not").** No stored
  password and no shim file needed, but it moves the agent — and therefore
  every `claude` session the PWA launches — into a non-interactive logon
  session, a different runtime environment than the one already verified to
  work. Not worth the risk for a saved file.
- **`powershell.exe -WindowStyle Hidden`.** Still flashes a console window for
  a fraction of a second at every logon.
- **Startup-folder shortcut.** Simple, but has no restart-on-failure at all,
  which is required in the same breath as "no window."

## Where the log is, and its one known ceiling

`%USERPROFILE%\.claude\plugins\data\claude-remote-claude-remote\agent.log`,
next to `config.json`, `sessions.json` and `session-pids\` — the same
plugin-data folder the rest of the agent's local state already lives in.
Nothing was added to `.gitignore`; this file has never been inside the repo.

The log appends forever and nothing rotates it. At roughly one line per start
plus genuine errors this is a slow leak, not a fire — delete the file by hand
to reset it, and only add rotation if it ever actually grows into a problem.

## Security note

A Scheduled Task that runs a file from this repo at every logon means write
access to `start-agent-hidden.vbs` or `agent/server.js` is now logon
persistence as the owner: automatic, hidden, and re-established at every
sign-in.

**That write access is currently GRANTED, not hypothetical.** Measured on
this machine:

```
> icacls agent\autostart\start-agent-hidden.vbs
    BUILTIN\Administrators:(I)(F)
    NT AUTHORITY\SYSTEM:(I)(F)
    NT AUTHORITY\Authenticated Users:(I)(M)      <-- Modify
    BUILTIN\Users:(I)(RX)
```

`(I)` means inherited — this comes from the `F:\` root, not from anything
this task did, and it applies to the whole repo. But autostart is what converts
"any authenticated principal can edit a file" into "any authenticated
principal can run code as the owner at every logon, with no window and no
prompt". Worth closing:

**Read the whole of this before running any of it — the obvious version of
these commands locks you out of your own repo.**

There is no explicit ACE for your account anywhere on `F:\`. `BUILTIN\Users`
grants only `(RX)`, and `BUILTIN\Administrators` is deny-only in a normal
non-elevated token. So `Authenticated Users:(M)` is the ONLY thing granting
you write access here. Remove it without granting yourself first and you can
no longer write to your own repo.

Scope matters too: hardening `agent\autostart` alone is not enough, because
the shim executes `agent\server.js`, which carries the same ACE.

Grant first, then remove, at the repo root:

```powershell
$repo = 'F:\Dev\Projects\Repos\claude-remote'

# 1. Explicit ACE for yourself FIRST. Without this, step 3 removes your
#    only write access to the repo.
icacls $repo /grant "$env:USERNAME:(OI)(CI)M"

# 2. Stop inheriting the F:\ ACL (converts inherited entries to explicit).
icacls $repo /inheritance:d

# 3. Now drop the broad grant, recursively.
icacls $repo /remove:g "Authenticated Users" /T

# 4. Confirm you still have Modify, and that the broad grant is gone.
icacls $repo
```

To undo, re-enable inheritance from the parent:

```powershell
icacls $repo /inheritance:e
```

Priority: do this before registering the task if this machine is ever shared
or joined to a domain. On a single-user personal machine it is lower priority
— but the ACL above is the measured state, not a theoretical one.

The task runs with `LogonType InteractiveToken` and `RunLevel
LeastPrivilege`, never elevated. No secret, token or passcode appears
anywhere in the XML, the shim, the script, or the log. The agent's bind stays
`127.0.0.1:8790` — nothing here changes what the tailnet can reach directly.

## If the agent's bind ever changes

The XML comments and this document both hardcode `127.0.0.1:8790`. If
`HOST` or the default port in `agent/server.js` ever changes, this document
and the `tailscale serve` mapping both go stale until updated by hand.
