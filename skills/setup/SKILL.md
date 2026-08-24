---
name: setup
description: One-time host setup for claude-remote - prepares this Windows machine so a persistent Claude Code session can be reached over Tailscale from any of your other devices. Not yet implemented; reports its status and stops.
---

# Claude Remote - host setup

**Status: not implemented yet, except step 1.** This skill is a placeholder. The
host-setup steps below are specified in `docs/claude-remote-prd.md` section 5.0 and
section 6, and land as this project's milestone M0 work completes. Step 1 is
implemented as `Test-TailscaleRunning` in `src/ClaudeRemote/ClaudeRemote.psm1`. Until
the rest lands, do not attempt any of the other steps by hand from this skill.

Tell the user, plainly, that setup is not built yet, list the steps it will perform,
and stop. Do not improvise the automation, do not run `wsl`, `ssh-keygen`,
`sshd`, or any firewall command, and do not edit any system configuration.

## What this skill will do once implemented

1. Import `src/ClaudeRemote/ClaudeRemote.psm1` and call `Test-TailscaleRunning`. On
   `$false`, stop the whole setup, tell the user Tailscale is not running and to start
   it (`tailscale up`) then re-run setup - never continue to a firewall step or fall
   back to an unscoped rule.
2. Detect PowerShell 7 (`pwsh.exe`), falling back to `powershell.exe`, for use as the
   SSH default shell.
3. Install WSL1 if absent, then tmux, Node, ttyd, and the Claude Code CLI inside it.
4. Install and configure Windows OpenSSH Server: key-based auth only, password auth
   disabled.
5. Add a Windows Firewall rule scoped to the Tailscale interface/subnet only, never
   `0.0.0.0`.
6. Set the OpenSSH default shell to the PowerShell detected in step 2.
7. Generate the SSH keypair and print the connection string once - never logging or
   persisting the private key.
8. Ask one setup question, "Default folder when you're not inside a specific project?"
   (Desktop suggested), and persist it.

## Per-run use is a different thing

Starting or resuming a session is `claude-remote.ps1` at the repo root, not this skill.
This skill runs once per host.
