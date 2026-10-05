---
name: setup
description: One-time host setup for claude-remote - check the machine can run it, get the agent starting itself at logon, and hand over at the loopback URL so the owner sets a passcode before anything is exposed to the network. Use when someone installs this plugin, says "set up claude-remote", or asks how to get the PWA running on their phone.
---

# Claude Remote - host setup

Get a Node agent running on this Windows PC, serving a small PWA that starts
Claude Code sessions. The phone reaches it over Tailscale; the session it starts
appears in the Claude app's Code tab.

**A Claude start never sets this PC up by itself** (since sequence 35,
2026-10-02). While it is not set up, each Claude start prints a short message
that points here. **This skill is the normal way to set it up**, and the repair
path. An update of a copy that is already set up still installs itself, hidden,
at a Claude start.

## Start here: the same command as the one-line install

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

Clear an old failure record, so this run tries again instead of repeating the
old failure line. Remove ONLY that record; the rest of the file is the hook's
own state.

```powershell
$f = "$env:USERPROFILE\.claude\plugins\data\claude-remote-claude-remote\auto-setup.json"
if (Test-Path $f) {
    $s = Get-Content $f -Raw | ConvertFrom-Json
    $s.PSObject.Properties.Remove('last')
    # ascii, not utf8: Windows PowerShell 5.1 writes utf8 with a BOM, which JSON.parse rejects
    $s | ConvertTo-Json | Set-Content $f -Encoding ascii
}
```

Then run the plugin's own setup, exactly what the one-line install runs:

```powershell
node "$src\hooks\check-update.mjs" --now
```

If it printed "Claude Remote is setting itself up on this PC.", the install is
running in the background. Wait for it in a SEPARATE command, with a 10-minute
timeout (600000 ms) - usually under a minute, at most nine. A separate command
means a timeout here can never kill the install:

```powershell
node "$src\hooks\check-update.mjs" --wait
```

Either way you now have one line. Say it to the person as it is, then:

- **"...is set up on this PC. Open http://127.0.0.1:8790..."**: give them that
  link with step 4's words (set a passcode, read the screen, pick folders).
  Nothing opens by itself; open the link for them only if they ask. The app
  switches Tailscale sharing on once the passcode is set and shows the phone
  code right after. STOP here.
- **"...already installed and up to date..."**: the agent is copied, which is
  not yet set up. Run step 3's three checks (copy, passcode, sharing). No
  passcode: it was abandoned at the passcode screen, so give step 4's words
  (open http://127.0.0.1:8790 and set it; the app switches sharing on itself).
  All three hold: give step 5's hand-over, the address, the Home Screen steps
  and the phone code.
- **"...still setting itself up..."**: the install is slow. Say the line;
  running `/claude-remote:setup` again in a few minutes gives the link. STOP.
- **"...updating itself..."** or **"...already setting itself up..."**: a
  hidden job is running right now. STOP: running the steps below by hand would
  race it (step 3 does not take its lock). Say the line; the next Claude start
  reports how it went.
- **"...runs its agent another way..."**: this PC is set up another way (a
  logon task or an agent from a checkout). STOP and leave it alone: the steps
  below would stop that agent and re-point its task.
- **Anything else** (needs Tailscale or Node, couldn't set itself up, not
  Windows): do steps 0 to 5 below by hand, which show the details.

Every step below stays valid on a machine that is already set up - step 3
keeps the previous version if the new one fails, and `tailscale serve` is
idempotent.

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
- **Ask before explaining.** Only a question the owner raises earns the details.
- **Do not assume an iPhone.** Say "your phone or another device", and give the
  install steps for iPhone and Android both (step 5).
- When something fails: what failed, then the one command or action that fixes
  it.

---

## 0. This must be a Windows PC. HALT if it is not.

Your environment names the platform; Windows is `win32`. Anything else
(`darwin`, `linux`) -> **STOP before running any command** and say:

"Claude Remote runs on Windows PCs for now, so setup can't continue on this
machine. Your phone can be anything - it's only the PC that has to be Windows.
You can remove the plugin with `/plugin uninstall claude-remote@claude-remote`."

Every later step calls PowerShell or a Windows-only tool, so continuing only
trades this message for a confusing error.

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
hook compares the two at a Claude start and installs the new version by itself
when they differ (an update only; a first setup is never started by itself).
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

Use `$src` from **Start here** at the top: the plugin's folder.

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
to use the same number in both places. The known limit of the at-logon trigger:
a cold boot sitting at the lock screen has no agent until someone signs in.

### Environments before Claude starts

Nothing to ask here. The launcher finds a `venv`/`.venv` or a conda
`environment.yml` by itself; anything else is the `pre_launch_command`
setting, which is file-only and documented in README.md ("What launching a
session does to your environment"). Point the owner there only if they ask.

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

With it, give the phone code. The plugin's hook prints it (`$src` is the
plugin folder from **Start here**; find it again the same way in a new shell):

```powershell
node "$src\hooks\check-update.mjs" --print-qr https://<machine>.<tailnet>.ts.net:8790
```

Put what it prints in your reply exactly as printed, inside a code block, right
under the address, and say "Scan this with your phone's camera to open it." The
tool's own output is folded away in the terminal, so the owner does not see it
there. Do not redraw or retype it: one wrong character and the code does not
scan.

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
