---
name: setup
description: One-time host setup for claude-remote. NOT IMPLEMENTED - the design it was written for was deleted. Reports its status and stops.
---

# Claude Remote - host setup

**Status: NOT IMPLEMENTED, and the steps it used to describe are gone.**

This skill described one-time setup for the SSH + WSL1 + tmux design: install
WSL1, install tmux/Node/ttyd inside it, install and configure Windows OpenSSH
Server, add a firewall rule, generate an SSH keypair. Steps 1 and 2 were real
and called `Test-TailscaleRunning` / `Get-DefaultShellPath` in
`src/ClaudeRemote/ClaudeRemote.psm1`.

**T53 deleted that whole path on 2026-09-05** (owner's call, 2026-08-27:
"A: delete"). WSL is not installed on the host and never was; the path had
never run end to end. So every step this skill described now points at code
that does not exist, and following any of it would be following a design the
project abandoned.

The shipped product is a **Node agent on native Windows serving a PWA on
8790**, exposed by `tailscale serve`. It needs no WSL, no tmux, no SSH server
and no keypair.

## What to do if a user runs this

Tell them plainly that automated host setup is not built, and that the setup
this skill described belongs to a design that was removed. Do not improvise it.
Specifically: **do not run `wsl`, `ssh-keygen` or `sshd`, do not add a firewall
rule, and do not edit any system configuration.**

The real remaining setup steps are Tailscale (`tailscale up`, then
`tailscale serve --bg --https=8790 8790`) and setting a passcode on first open
of the PWA. Both are in `README.md` and `docs/tailscale-https.md`.

## Why this file still exists

Rewriting it properly is T60's job, and doing it here would pre-empt that with
a guess. What is fixed now is only the actively harmful part: it no longer
tells a reader to import a module that was deleted.
