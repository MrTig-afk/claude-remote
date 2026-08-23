---
name: setup
description: One-time host setup for claude-remote - prepares this Windows machine so a persistent Claude Code session can be reached over Tailscale from any of your other devices. Not yet implemented; reports its status and stops.
---

# Claude Remote - host setup

**Status: not implemented yet.** This skill is a placeholder. The host-setup steps
below are specified in `docs/claude-remote-prd.md` section 5.0 and section 6, and land
in tasks T02-T07 (milestone M0). Until then, do not attempt any of them by hand from
this skill.

Tell the user, plainly, that setup is not built yet, list the steps it will perform,
and stop. Do not improvise the automation, do not run `tailscale`, `wsl`, `ssh-keygen`,
`sshd`, or any firewall command, and do not edit any system configuration.

## What this skill will do once T02-T07 land

1. Verify Tailscale is running (`tailscale status`). Halt with a clear error if it is
   not - never fall back to an unscoped firewall rule. (T02)
2. Detect PowerShell 7 (`pwsh.exe`), falling back to `powershell.exe`, for use as the
   SSH default shell. (T03)
3. Install WSL2 if absent, then tmux, Node, and the Claude Code CLI inside it. (M2)
4. Install and configure Windows OpenSSH Server: key-based auth only, password auth
   disabled. (T04)
5. Add a Windows Firewall rule scoped to the Tailscale interface/subnet only, never
   `0.0.0.0`. (T05)
6. Set the OpenSSH default shell to the PowerShell detected in step 2. (T06)
7. Generate the SSH keypair and print the connection string once - never logging or
   persisting the private key. (T07)
8. Ask one setup question, "Default folder when you're not inside a specific project?"
   (Desktop suggested), and persist it. (T19)

## Per-run use is a different thing

Starting or resuming a session is `claude-remote.ps1` at the repo root, not this skill.
This skill runs once per host.
