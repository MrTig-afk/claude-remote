# Starting the Local Agent automatically at logon

This is the procedure for registering the agent as a logon-triggered scheduled
task, plus the ACL hardening it needs. The `-RenderOnly` output quoted below is
a real dry run (renders and schema-validates, registers nothing) - run it
yourself before registering anything.

Check whether the task already exists on your machine with
`Get-ScheduledTask -TaskName 'Claude Remote Agent'`.

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
  definition, as a template with placeholders filled in at register time. Its
  action is `conhost.exe --headless cmd.exe /s /c "... node.exe server.js >>
  agent.log"`: headless conhost gives node a console that is never shown, and
  cmd is there only for the log redirect. Two triggers: at logon (start now),
  and a clock trigger every minute (start again if it died - see "Crash
  recovery").
- `agent/autostart/register-task.ps1` — renders the template, proves this
  Windows honours `conhost --headless`, schema-validates the XML via the Task
  Scheduler COM API, and (unless `-RenderOnly`) registers it. It refuses while
  the task is running: use the next script.
- `agent/autostart/update-agent.ps1` — the ONE way to stop, update, restart
  and verify the agent (see "Stopping, restarting, updating").

The chain used to be `wscript.exe //B start-agent-hidden.vbs`. It was replaced
on 2026-09-23: Microsoft is disabling VBScript by default (~2027) and then
removing it, which would have silently stopped the agent starting at logon.

Not shipped, and not run by anyone but the owner: the actual
`Register-ScheduledTask` call. No JavaScript changed — the agent already
starts correctly under `node agent/server.js` regardless of what launched
`node`, binds only to `127.0.0.1:8790`, and handles the case where an agent is
already running (see "Already-running case" below) without any code change.

## Registering it

A plugin install does not do this by hand: `/claude-remote:setup` copies the
agent to `%LOCALAPPDATA%\claude-remote` and registers the task from that copy
(see `skills/setup/SKILL.md`, step 3). The steps below are for running the
agent from a checkout of this repo.

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

To start it immediately, without waiting for a reboot, and check it came up:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\agent\autostart\update-agent.ps1
```

Register from a NORMAL PowerShell. A task registered from an Administrator one
is owned by Administrators and read-only to you (measured 2026-09-22), so no
later update can pause or replace it; `update-agent.ps1` says so and prints the
one elevated command that removes it.

## Stopping, restarting, updating

Never with `Stop-ScheduledTask` alone. It ends the task's own process
(conhost) and node survives it, still holding the port (measured 2026-09-22:
the task went Ready, the node pid lived on). A new agent then dies on
EADDRINUSE while the old version keeps serving.

`update-agent.ps1` is the only supported way, and everything else calls it:

- no arguments: restart in place (a checkout; the repo's post-commit hook).
- `-Source <plugin folder> -Target <install folder>`: an update (setup step 3).

In order: stage the new copy beside the old one (a failed copy stops
nothing) -> disable the task, so the every-minute trigger cannot restart the
old copy mid-update -> kill this copy's node (and any agent `server.js` holding
the port) -> wait until they are gone AND 127.0.0.1:<port> is free, or stop
with nothing changed -> swap folders by rename (`<target>.prev` keeps the old
one) -> register from the new copy and start it -> wait until the listener on
127.0.0.1 (never "the first listener": `tailscale serve` holds the same port
number on the tailnet addresses) is node, from the target folder, started
after this step began, answering `/api/auth/status`. If not: put `.prev`
back, start it, check it the same way, keep the bad copy as `.failed`, and
exit non-zero.

Open Claude Code sessions survive all of this. They are started by a
PowerShell that exits, so they are not the agent's children (measured
2026-09-22: a session's parent chain ends at a dead pid, never at the agent's
node, and it stayed typeable through a 4-minute agent outage).

## Crash recovery

Measured 2026-09-22: the task's `RestartOnFailure` did NOT restart a killed
agent in 270 seconds. That setting covers a task that fails to START, not a
program that dies later. It is gone. Instead a clock trigger fires every
minute; with `MultipleInstancesPolicy IgnoreNew` that is a no-op while the
agent runs, and a restart once it has died. Measured 2026-09-23: killed agent
back in 58 seconds. It has to be a clock trigger: a repetition on the logon
trigger only starts counting at the next logon, so after an install it sat
unarmed (measured the same night).

## Verification — measured 2026-09-23, and "the register command exited 0" is not acceptance

Run on the owner's PC against the live task (each step a few seconds of PWA
downtime; open sessions untouched):

1. `register-task.ps1 -RenderOnly` — the headless probe passes, the XML
   schema-validates, nothing is registered.
2. A fresh `update-agent.ps1 -Source <repo> -Target "<temp>\cr install test"`
   (a path WITH SPACES) while the old checkout agent held the port: it killed
   that agent, installed, and the new one was serving in 3 seconds.
3. The same again: serving in 3 seconds, the previous copy kept as `.prev`.
4. The same with a deliberately broken `server.js`: it failed to come up,
   rolled back by itself, the good copy was serving again, the broken one kept
   as `.failed`, exit non-zero.
5. `update-agent.ps1` with no arguments from the repo: back on the checkout
   in 3 seconds.
6. Killed the agent's node by hand: back by itself in 58 seconds.
6a. A new version that dies at once while an unrelated process grabs
   127.0.0.1:8790 the moment the folders swap: the rollback cannot stop the
   squatter, so it cannot start the previous version - but it still puts the
   previous copy back in place, leaves the task ENABLED (Ready), and reports
   both reasons. The next minute's trigger starts the previous version once
   the port is free.
6b. A restart where registering fails early (node.exe off PATH): reports it,
   and the task is left enabled, not disabled.
6c. A leftover `.prev` held open by another process: refused before
   anything moved; the install stays intact and serving.
7. No window appeared when conhost --headless first launched node (owner,
   watching the desk, 2026-09-22).

The first run of step 2 found a real bug: for a path with spaces the command
line conhost hands on reads `...\cr" install "test\...`, so an exact-text
match called the new agent "not ours" and rolled back a good update. Quotes
are now ignored when comparing. Any Windows user name with a space would have
hit it on every update.

Still manual, only possible at a real logon:

1. Reboot or sign out/in; at the desk, before opening a terminal, no console
   window appeared.
2. `Invoke-RestMethod http://127.0.0.1:8790/api/auth/status` answers.
3. Launch check, do not skip: from the phone, start a session for a real
   project and confirm it appears in the Claude app's Code tab. This is the
   one check that would notice a scheduler environment where `claude.cmd` is
   not on PATH the way it is in an interactive terminal.
4. Once `tailscale serve --bg --https=8790 8790` is on:
   `https://<machine>.<tailnet>.ts.net:8790` loads after a reboot with
   nobody having started anything by hand.

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

If the owner already has an agent running from a terminal, the task's own
`node` hits `EADDRINUSE`, logs `port 8790 is already in use`, and exits - the
terminal agent keeps serving. The every-minute trigger then tries again each
minute, so the log gains a line a minute (about 1,400 a day) while it lasts;
when the terminal agent is closed, the task takes over within a minute. For a
long terminal session, pause it first and resume after:

```powershell
Disable-ScheduledTask -TaskName 'Claude Remote Agent'
Enable-ScheduledTask  -TaskName 'Claude Remote Agent'
```

## Removing it

Unregister first (so nothing restarts it), then end the agent yourself -
`Stop-ScheduledTask` would leave node running. The agent is whatever listens
on 127.0.0.1:8790 (your port, if you moved it):

```powershell
Unregister-ScheduledTask -TaskName 'Claude Remote Agent' -Confirm:$false
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-ScheduledTask    -TaskName 'Claude Remote Agent' -ErrorAction SilentlyContinue   # must return nothing
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue  # must return nothing
```

Nothing else is left behind except the log file, which is the owner's to
delete, and the install folder if setup made one. Removing the task
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
- **Startup-folder shortcut.** Simple, but nothing brings the agent back
  after a crash, which is required in the same breath as "no window."
- **A VBScript shim (`wscript //B`).** Used until 2026-09-23. Microsoft is
  disabling VBScript by default (~2027) and then removing it.
- **A Windows Service.** Services run in session 0: every Claude Code window
  the agent opens would be invisible on the owner's desktop, and the whole
  point is a session typeable at the desk as well as from the phone. Getting
  around that means running as SYSTEM and spawning into the user's session.
  It would also need an admin install, a stored password and a wrapper, since
  node cannot talk to the service manager itself.

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
access to `agent/server.js` (or anything it loads) is now logon
persistence as the owner: automatic, hidden, and re-established at every
sign-in.

**That write access is currently GRANTED, not hypothetical.** Measured on
this machine (2026-08-26, on the file the task then ran; every file in the
repo inherits the same entries):

```
> icacls agent\autostart\<file>
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

A plugin install does not need this: the copy setup makes lives under
`%LOCALAPPDATA%`, which by default grants only you, `SYSTEM` and
`Administrators` (measured 2026-09-22 with `icacls $env:LOCALAPPDATA`; check
yours). It applies to an agent run from a checkout on a drive like the one
above.

**Read the whole of this before running any of it — the obvious version of
these commands locks you out of your own repo.**

On a secondary data drive there is typically no explicit ACE for your own
account anywhere on the volume. `BUILTIN\Users` grants only `(RX)`, and
`BUILTIN\Administrators` is deny-only in a normal non-elevated token, so
`Authenticated Users:(M)` is often the ONLY thing granting you write access.
Remove it without granting yourself first and you can no longer write to your
own repo. Run the `icacls` inspection above on YOUR drive before assuming your
ACLs match.

Scope matters too: hardening `agent\autostart` alone is not enough, because
the task executes `agent\server.js`, which carries the same ACE.

Grant first, then remove, at the repo root:

```powershell
$repo = 'C:\path\to\claude-remote'   # a checkout; never the plugin cache

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
anywhere in the XML, the scripts, or the log. The agent's bind stays
`127.0.0.1:8790` — nothing here changes what the tailnet can reach directly.

## If the agent's bind ever changes

The XML comments and this document both hardcode `127.0.0.1:8790`. If
`HOST` or the default port in `agent/server.js` ever changes, this document
and the `tailscale serve` mapping both go stale until updated by hand.
