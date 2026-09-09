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

## 3. Start the agent, and make it start itself

From the repo root. Every relative path in this skill is relative to it.

A marketplace install does not give you a stable one. `claude plugin list
--json` reports its `installPath` (`claude plugin details` does NOT print a
path - measured), but that path is VERSION-SCOPED,
`...\cache\<marketplace>\<plugin>\<version>\`, and moves on every `claude
plugin update`. A scheduled task registered from it would silently point at a
directory that no longer exists. So for the agent: `git clone` the repo to a
path you choose, and run it from there.

```powershell
node agent/server.js
```

It listens on `http://127.0.0.1:8790` and nothing else. To change the port set
`CLAUDE_REMOTE_AGENT_PORT`; if you do, the serve command in step 5 has to use
the same number in both places.

For it to survive a reboot, register the scheduled task - the full procedure,
including the known limitation that an at-logon trigger means a cold boot
sitting at the lock screen has no agent, is in `docs/agent-autostart.md`.

**Nothing about folders is configured here.** Which directories the app can see
is chosen by the owner IN THE APP on first run, on a screen that explains what
access is being granted before any of it is shared. Do not add a base-folder
prompt to this skill and do not write one into the config by hand.

## 4. Hand over. The owner sets the passcode. STOP HERE.

Print the loopback URL and stop:

```
http://127.0.0.1:8790
```

Tell the owner to open it **at the desk**, set a six-digit passcode, and accept
the folder-access screen. The passcode is asked every time the app opens; it is
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
