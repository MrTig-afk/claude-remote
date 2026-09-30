# Contributing

Thanks for looking. This is a small personal tool, published because it might
be useful. Contributions are welcome where they keep it small.

## Before anything else

Read the threat model at the top of `README.md`. Most of the rules below exist
because this thing launches Claude Code with the full permissions of a user
account, reachable from every device on a tailnet, behind one six-digit
passcode. Changes that widen that surface will not be merged.

## Open an issue before you start

For anything bigger than a small fix, **open an issue first and wait for a
reply before writing code.** That covers new features, changes to how
something behaves, and any new screen, state or wording in the app. Say what
you want to change and why. Once the issue gets a go-ahead, start work and
link the issue from your pull request.

Small fixes can go straight to a pull request with no issue: a typo, a broken
link, a docs correction, or a one-line bug fix whose cause is obvious.

This is not gatekeeping. It stops you spending an evening on something that
clashes with a decision already made, which is the most likely way a
contribution here gets turned down.

## Running it locally

Windows, Tailscale, Node 24.2 or newer, and the Claude Code CLI on `PATH`.

```powershell
node agent/server.js          # http://127.0.0.1:8790, loopback only
```

Open it at the desk, set a passcode, share a folder. Do not run
`tailscale serve` on a development instance.

## Tests

```powershell
node --test "agent/test/**/*.test.js"
```

Run from the repo root, exactly that form. Two things the suite needs from
Windows:

- **Developer Mode on** (Settings > System > For developers). One security
  test plants a symlink to prove the server refuses to follow it, and Windows
  only lets a normal account create symlinks in Developer Mode. Without it that
  test fails with `EPERM`.
- **Chrome it can find.** Part of the suite drives a real headless Chrome. It
  looks in `Program Files` and in a per-user install under
  `%LOCALAPPDATA%\Google\Chrome\`; set `CHROME=<path to chrome.exe>` if yours
  is anywhere else. `ALLOW_NO_CHROME=1` skips the check knowingly.

Some launcher tests start real PowerShell processes, so console windows
flashing during a run is normal.

Lint the launcher with `Invoke-ScriptAnalyzer -Path .\agent\launch-session.ps1`.

## What a change needs

- **A test that fails without it.** Tests use the built-in `node:test` runner
  and `node:assert/strict`. Prefer running the real function under a stub over
  asserting on source text.
- **No new dependencies.** Runtime or dev. The agent has zero and that is a
  feature on the memory-tight machines this runs on.
- **Nothing loaded from outside the tailnet.** No CDN, no fonts, no analytics.
  A test enforces it.
- **No new way for the phone to decide what runs on the PC.** The launch
  command and the pre-launch command stay in the local config file, never in
  the API and never in a project.
- **The `claude.cmd` command line is sacred.** If you must change it, say in
  the PR that you checked, on a real device, that the session still appears in
  the Claude app's Code tab.
- **User-visible changes follow the approved design.** The PWA's surfaces were
  decided deliberately, and small "improvements" tend to undo one of those
  decisions. This is why a new screen, state or wording needs an issue first.
- **Keep comments true.** Many comments here state why a line exists, and
  several mark bugs that were expensive to find. If your change makes one
  false, fix the comment in the same commit.

## Commits and pull requests

- Short imperative subject, two or three lines at most, no trailers.
- One change per PR. A refactor and a behaviour change are two PRs.
- Files under `agent/` are CRLF; keep them that way.
- The PR description says what you ran and what you saw, not what should work.

## Reporting a problem

Open an issue with: Windows version, Node version, what you tapped, what the
row on the phone said, and the contents of `<pid file>.err` from
`%USERPROFILE%\.claude\plugins\data\claude-remote-claude-remote\session-pids\`
if a launch was refused. Never paste your passcode, tokens, or a
`pre_launch_command` that contains a credential.

## License

MIT. By contributing you agree your contribution is licensed the same way.
