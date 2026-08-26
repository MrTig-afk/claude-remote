# Claude Remote

Keep a Claude Code session running on your Windows desktop and reach it from
any other device on your Tailscale network - phone, laptop, tablet - without
losing state when you walk away, lock your phone, or switch networks.

Works from any device with an SSH client. Android and iOS setup (ConnectBot /
Blink Shell) is documented under `client/` once M5 lands; any SSH client
works in principle since the transport is plain SSH.

## Stack

- Host: Windows, Tailscale (assumed already installed), Windows OpenSSH
  Server, PowerShell.
- Session layer: WSL1 running tmux, Node, and the Claude Code CLI.
- Client: any SSH app - ConnectBot (Android) and Blink Shell (iOS)
  documented specifically.

## Status

Early scaffold. See `docs/claude-remote-prd.md` for the full spec,
including the milestone breakdown (section 12). `claude-remote.ps1` now
resolves the project folder, creates or reattaches the tmux session, and
starts `claude` inside it on first creation; connection-string printing and
`list-sessions` still land in later milestones.

## Local setup (current scaffold)

```powershell
git clone <this repo>
cd claude-remote
.\claude-remote.ps1 -ProjectPath .
```

Running it with no argument uses the saved default folder instead, which the
setup flow does not configure yet.

## Running the tests

```powershell
Invoke-Pester -Path .\tests
```
