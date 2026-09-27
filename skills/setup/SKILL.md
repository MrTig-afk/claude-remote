---
name: setup
description: One-time host setup for claude-remote - check the machine can run it, get the agent starting itself at logon, and hand over at the loopback URL so the owner sets a passcode before anything is exposed to the network. Use when someone installs this plugin, says "set up claude-remote", or asks how to get the PWA running on their phone.
---

# Claude Remote - host setup

Get a Node agent running on this Windows PC, serving a small PWA that starts
Claude Code sessions. The phone reaches it over Tailscale; the session it starts
appears in the Claude app's Code tab.

## THE ORDER IS LOAD-BEARING. Do not reorder it.

Step 4 hands over so the owner sets a passcode. Step 5 exposes the agent to the
tailnet. **Never do 5 before 4.**

`tailscale serve` is a PROXY, not a filter. The moment it is on, the agent's
loopback bind stops being a boundary and every device on the tailnet can reach
a service that launches Claude Code with the full permissions of this user
account. An agent with no passcode set answers `403 setup_required` on every
route except the one that SETS the passcode - so whoever reaches it first sets
it. On a single-user tailnet that is the owner. Exposed first, it is whoever
gets there first.

If you can only do part of this, stop after step 4. A machine that is set up
but not yet exposed is a working machine. A machine exposed but not configured
is an open door.

## How to talk to the person installing this

Most of this file is for you, not for them. They are setting up an app, not
reading its internals. Found on the install test, 2026-09-27: the step-4 message
was a wall of venv, conda, poetry, `-NoProfile` and `.err` files, and the one
thing to do was buried under it.

- **Lead with the one thing they have to do**, in a sentence or two. Then stop.
- Short sentences, plain words. No file names, flags or error internals unless
  they ask, or something failed and they need them to fix it.
- **Ask before explaining.** The environment question in step 3 is one yes/no
  question; only a "yes" earns the details.
- **Do not assume an iPhone.** Say "your phone or another device", and give the
  install steps for iPhone and Android both (step 5).
- When something fails: what failed, then the one command or action that fixes
  it.

---

## 1. Tailscale must be up. HALT if it is not.

```powershell
tailscale status
```

Non-zero exit, "Logged out", or the command not found -> **STOP and tell the
owner to run `tailscale up` first.** Do not continue to any later step, and do
not offer a workaround: the alternatives to Tailscale here are a port forward
or an unscoped firewall rule, and both are worse than not shipping.

## 2. Check the runtime

```powershell
node --version          # must be >= 24.2.0
Get-Command claude.cmd  # the Claude Code CLI must be on PATH
```

Either missing -> stop and say which. Node below 24.2.0 is a hard stop: the
agent uses the built-in test runner and modern Node APIs and has ZERO
dependencies, which is deliberate and is not going to be worked around with a
polyfill.

Note `claude.cmd`, not `claude`. On Windows the bare name resolves to
`claude.ps1` first, which Start-Process cannot execute and which fails silently.

## 3. Copy the agent to its permanent home, and make it start itself

The plugin's own folder is no place to run the agent from: it is named after
the version (`...\plugins\cache\claude-remote\claude-remote\<version>\`) and
moves on every plugin update, so a scheduled task pointing into it would
silently stop starting. Setup copies the agent to a folder that never moves,
`%LOCALAPPDATA%\claude-remote`, and autostart runs it from there. No git clone.

**This step is also the update.** A plugin update changes nothing on its own;
the copy keeps running until this step runs again. The plugin's SessionStart
hook compares the two and says "Claude Remote has an update" when they differ.
Decide which run this is BEFORE copying anything. It is an update only when
all three already hold:

```powershell
$port = if ($env:CLAUDE_REMOTE_AGENT_PORT) { $env:CLAUDE_REMOTE_AGENT_PORT } else { '8790' }
Test-Path "$env:LOCALAPPDATA\claude-remote\agent\server.js"
(Invoke-RestMethod "http://127.0.0.1:$port/api/auth/status").configured   # True = passcode set
tailscale serve status   # lists :$port
```

Then do this step, confirm step 4's URL answers, and stop - the passcode and
the tailnet exposure are already in place. If any one fails, it is a first run
(or one abandoned at step 4): do every step. Step 3 is safe to repeat.

Find the plugin's folder (`claude plugin details` does NOT print a path -
measured; `list --json` does):

```powershell
$src = $env:CLAUDE_PLUGIN_ROOT   # the copy Claude Code actually loaded, when set
if (-not $src) {
    $paths = @((claude.cmd plugin list --json | ConvertFrom-Json) |
               Where-Object id -eq 'claude-remote@claude-remote' |
               ForEach-Object installPath | Select-Object -Unique)
    if ($paths.Count -gt 1) {
        throw "claude-remote is installed at $($paths.Count) scopes - uninstall all but one, then re-run setup"
    }
    $src = $paths | Select-Object -First 1
}
if (-not $src -or -not (Test-Path "$src\agent\server.js")) {
    throw 'claude-remote plugin folder not found - is the plugin installed?'
}
```

The throw is load-bearing: with an empty `$src`, `"$src\agent"` is `\agent` at
the root of the current drive, and the install below would copy whatever is
there and register ITS script to run at every logon.

The brackets around `claude.cmd plugin list --json | ConvertFrom-Json` are
load-bearing too. Windows PowerShell 5.1's `ConvertFrom-Json` sends a JSON array
down the pipe as ONE object, so without them `Where-Object` never matches and
setup stops with "plugin folder not found" on a stock Windows PC (found on the
Dell install test, 2026-09-27; `agent/test/setup-skill.test.js` runs it).
`CLAUDE_PLUGIN_ROOT` is not set in your shell, so this is the path a real
install takes.

Then install it. One script does the whole update - run the copy that ships
with the NEW version, from the plugin folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$src\agent\autostart\update-agent.ps1" -Source $src -Target (Join-Path $env:LOCALAPPDATA 'claude-remote')
if ($LASTEXITCODE -ne 0) { throw "update-agent.ps1 failed ($LASTEXITCODE) - read its message above" }
```

What it does, so you can tell the owner: copies the new version beside the
old one first (a failed copy stops nothing), stops the agent, waits until it
is really gone, swaps the folders, registers the logon task from the new copy,
starts it, and checks that the process listening on 127.0.0.1 is the new
agent and answers. If the new version does not come up, it puts the previous
one back, starts that, and exits non-zero saying so - the phone keeps working.
The previous copy stays beside it as `claude-remote.prev`, a failed one as
`claude-remote.failed`. Your passcode and settings are NOT in these folders
(they live under `.claude\plugins\data\claude-remote-claude-remote`), so an
update never touches them. Open Claude Code sessions are not touched either:
they are not children of the agent.

If it says the task **was registered from an Administrator PowerShell**, an
older setup ran elevated and this user may not change that task. Tell the owner
to run the one command it prints in an Administrator PowerShell, then run the
block above again. Do not try to elevate yourself.

`CLAUDE_PLUGIN_ROOT` is preferred over `plugin list` because it names the copy
Claude Code actually loaded; a plugin installed at two scopes with different
folders is refused rather than guessed at.
`-ExecutionPolicy Bypass` because a stock Windows client blocks running a
`.ps1` by default, and this must not depend on the machine's policy. Its exit
code is checked because a native command's failure does not throw.

The agent listens on `http://127.0.0.1:8790` and nothing else. To change the
port set `CLAUDE_REMOTE_AGENT_PORT`; if you do, the serve command in step 5 has
to use the same number in both places. The known limit of the at-logon trigger
- a cold boot sitting at the lock screen has no agent - is in
`docs/agent-autostart.md`.

### Does anything need to run before Claude starts?

ASK THE OWNER THIS - do not assume, and do not skip it because their machine
happens to look like a plain Python project. But ask it as ONE short question
and nothing else, then wait:

```
Does your project need anything set up before Claude starts, like conda,
poetry or uv? If you're not sure, the answer is probably no.
```

"No" (or a plain venv / .venv folder): say it is handled automatically and move
on. Only a "yes" gets the details below, and then only the part that applies.

The details, for you. When a session launches, the
launcher `cd`s into the project and then activates an environment. Out of the
box it checks two things, in order: a `venv` or `.venv` folder holding
`Scripts\python.exe`, which it puts first on `PATH` itself (it never runs the
project's `Activate.ps1`); then an `environment.yml` with a `name:`, which it
activates through a conda found under `miniconda3` or `anaconda3` in the user
folder, `AppData\Local` or `C:\ProgramData` - refusing the launch, with the
reason, if conda is not there.

If they use poetry, uv, pipenv, a differently-named folder, conda installed
anywhere else, or a non-Python stack, that auto-detect finds nothing and the
session starts in the
wrong environment - silently, with no sign of it from the phone. Set
`pre_launch_command` in the config file for that case:

```json
{ "pre_launch_command": "& \"$env:USERPROFILE\\miniconda3\\shell\\condabin\\conda-hook.ps1\"; conda activate myenv" }
```

THREE CONSTRAINTS. Say all three - each one produces a silent failure, and the
first two make the obvious command the wrong one:

- **`-NoProfile`.** The launcher spawns PowerShell with `-NoProfile`, so
  nothing `conda init` (or nvm, or their own profile) defines exists. A bare
  `conda activate myenv` is NOT a command here - it falls through to
  `conda.exe`, errors with "Run 'conda init' before 'conda activate'", and the
  session lands in the base environment looking fine. Hence the hook above.
- **It must RETURN.** No timeout, and it runs before Claude Code starts, so
  anything that blocks hangs the launch and no session ever appears. Do NOT
  suggest `poetry shell` - it opens a nested interactive shell and waits
  forever. `Invoke-Expression (poetry env activate)` is the one that both returns AND
  actually activates - bare `poetry env activate` only PRINTS the line.
- **It REPLACES the auto-detect** for any project it applies to - `venv`/
  `.venv` is not tried as well. `pre_launch_command` is the fallback for every
  project; `pre_launch_commands` is a map keyed by project path that overrides
  it for one. Projects in neither keep the auto-detect. If their projects need
  different environments, that map is the answer - not a command that branches
  on `$PWD`. Map a project to `null` - and only `null` - to say "this one needs
  nothing" and keep the auto-detect despite a global. Keys need a DRIVE LETTER
  (`F:\...`): a `~` is never expanded, and anything else, `/Dev/x` included,
  resolves against whatever directory the agent was started in, so it usually
  matches nothing. The agent warns, but only in its own terminal.

Tell them where failures show up, because nowhere else does: the launcher
writes `<pid file>.err` beside the pid file in `session-pids\`.

Also:

- Leave it out and today's behaviour is unchanged.
- The value is executed. Anyone who can edit that file can already run
  anything as this user, which is why the setting lives in the file and NOT in
  the app - no route can write it, and the phone must never be able to decide
  what runs on the PC.

**Nothing about folders is configured here.** Which directories the app can see
is chosen by the owner IN THE APP on first run, on a screen that explains what
access is being granted before any of it is shared. Do not add a base-folder
prompt to this skill and do not write one into the config by hand.

## 4. Hand over. The owner sets the passcode. STOP HERE.

Print the loopback URL and stop:

```
http://127.0.0.1:8790
```

Tell the owner, in about this many words:

```
Open http://127.0.0.1:8790 in a browser on this PC. Set a six-digit passcode,
read the screen about what the app can see, and pick the folders your projects
are in. Tell me when that's done.
```

The passcode is asked every time the app opens; it is
stored only as a hash, and it is never typed into this session, never echoed,
never logged. **Do not ask the owner for the value and do not offer to set it
for them.**

Until this is done the agent answers `403 setup_required` everywhere else, which
is the state that makes step 5 unsafe.

## 5. ONLY NOW expose it to the tailnet

```powershell
tailscale serve --bg --https=8790 8790
```

`--bg` survives a reboot and the certificate renews itself. The app is then at
`https://<machine>.<tailnet>.ts.net:8790`, and the real certificate is what makes
the service worker register and the PWA installable on the phone.

**Then open that URL once yourself, before handing it over:**

```powershell
curl.exe -sS -m 120 -o NUL -w "%{http_code}`n" https://<machine>.<tailnet>.ts.net:8790/
```

Expect `200`. The certificate is issued on the FIRST connection after serve is
turned on, and that connection can take tens of seconds. Left to the phone, it
shows a white screen and then "server stopped responding" (measured 2026-09-22,
iPhone, both the Safari and the Chrome home-screen app). Let this request pay
that wait instead. `curl.exe`, not `curl`: in Windows PowerShell 5.1 `curl` is
an alias for `Invoke-WebRequest`.

Then hand it over. Do not assume an iPhone - say it about this plainly:

```
Done. On your phone, or any other device signed in to your Tailscale, open:
https://<machine>.<tailnet>.ts.net:8790

To keep it like an app:
- iPhone or iPad: open it in Safari, tap Share, then Add to Home Screen.
- Android: open it in Chrome, tap the three-dot menu, then Add to Home screen
  (or Install app).

Enter your passcode, tap a project, and the session shows up in the Claude
app's Code tab.
```

To take it down again:

```powershell
tailscale serve --https=8790 off
```

No firewall rule is needed and none should be added. Under serve the agent never
leaves loopback, and loopback traffic does not traverse the firewall at all.

---

## What this setup does NOT do, and must not improvise

There is no SSH, no WSL, no tmux and no `ttyd` in this design. An earlier
version of this project used them and it was deleted; if you are reading a note
that mentions them, it is out of date.

Specifically: **do not run `wsl`, `ssh-keygen` or `sshd`, do not install
OpenSSH Server, do not add a firewall rule, and do not edit any system
configuration.** None of it is required and every one of it widens the attack
surface of a machine this app already exposes to a network.

## Be honest about what the owner is agreeing to

If they ask what this gives them, do NOT summarise it from memory - point them
at the threat model at the top of `README.md` and let them read it. One copy on
purpose: a safety statement kept in two places drifts, and the drifted copy is
the dangerous one.
