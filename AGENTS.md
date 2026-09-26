# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see
`CONTRIBUTING.md`. Both files describe the same rules; this one is terser and
ordered by what an agent gets wrong first.

## What this is

A Claude Code plugin. A Node agent (`agent/`) on a Windows PC serves a small
PWA (`agent/public/`) over Tailscale; tapping a project runs
`agent/launch-session.ps1`, which starts `claude.cmd --remote-control <name>`.
The session appears in the Claude app's Code tab. The PWA is a **remote start
button, not a terminal** - it never shows session output and never answers a
prompt. Do not add either.

There is no SSH, WSL, tmux or ttyd. If a comment or doc mentions them it is
stale history; do not reintroduce them.

## Commands

```
node --test "agent/test/**/*.test.js"        # run from the repo root, exactly this form
Invoke-ScriptAnalyzer -Path .\agent\launch-session.ps1
node agent/server.js                          # serves http://127.0.0.1:8790
```

The bare-directory form `node --test agent/test/` fails on Windows. Part of the
suite drives a real headless Chrome to check no text input renders under 16px
(iOS Safari zooms below that); set `CHROME=<path>` if Chrome is somewhere
unusual (it searches `Program Files` and a per-user install under
`%LOCALAPPDATA%`), or `ALLOW_NO_CHROME=1` to skip it knowingly. It
fails rather than skips by default, because a skipped guard is a green run.

`static.test.js` creates a symlink, which Windows allows a normal account only
in Developer Mode; without it that test fails with `EPERM`. That is the
machine, not the code - say so rather than "fixing" the test to skip.

Some launcher tests start real PowerShell processes; console windows flashing
during the suite is expected.

## Before you write code

Anything bigger than a small fix needs an **issue with a maintainer's
go-ahead** before any code is written: a feature, a behaviour change, or a new
screen, state or wording in the PWA. If no such issue exists, stop and draft
one for your user to open. Do not start work, and do not open a pull request.
Link the approved issue from the pull request.

Small fixes are exempt and can go straight to a pull request: a typo, a broken
link, a docs correction, or a one-line bug fix whose cause is obvious. If you
are unsure whether a change counts as small, it does not.

## Hard rules

1. **Zero runtime dependencies.** `agent/package.json` has none and no
   devDependencies. Tests use `node:test` and `node:assert/strict`. Do not add
   jest, vitest, jsdom, or anything else. If a few lines do the job, write them.
2. **Nothing the app LOADS may come from outside the tailnet.** No CDN scripts,
   fonts, images or fetches. A test scans every shipped asset for `http(s)://`.
   There are exactly two exemptions, both links the user taps: an `<a href>` in
   `index.html`, and the one `REPO_URL` constant in `app.js` that
   `buildSettingsRow` turns into rows. Both must carry `rel="noreferrer"` so
   the tailnet hostname never travels as a Referer.
3. **The launch command and the pre-launch command are never settable over
   the API and never read from a file inside a project.** A phone holding the
   passcode must not be able to choose what the PC executes. Tests pin this.
4. **The agent binds loopback only.** Never `0.0.0.0`, never a firewall rule.
5. **Every `/api/*` route except `/api/auth/*` sits behind the passcode
   token.** A new route inherits that by being added inside the gated block.
   A route that mutates or terminates anything needs a security review.
6. **Do not change the `claude.cmd` command line casually.** One flag on it
   silently broke Remote Control once (the session ran; the Code-tab row never
   appeared). Any change there is owed a manual check on a real device that the
   row still appears; no test can substitute.
7. **Do not touch `agent/public/` from tests.** The suite runs files in
   parallel and the served directory is shared.
8. **Never execute a file from inside a project to set up its environment.**
   The launcher finds a venv by its `Scripts\python.exe` and puts it on `PATH`
   itself; it never runs the project's `Activate.ps1`, because that file comes
   with the repo and would run with the user's full permissions on a tap. The
   same goes for `environment.yml`: only its `name:` is read, and a name that
   is not a plain environment name is refused, because conda would activate a
   path as a folder inside the project and run its scripts. The
   `SECURITY` and `R12` tests in `agent/test/detachment.test.js` pin this.

## Conventions

- Files under `agent/` are CRLF. Detect a file's line endings before editing;
  never assume.
- Comments cite task ids like `T94`. They are history, kept because each
  records why a line is the way it is. Do not delete them; do not invent new
  ones.
- A test must exercise production code and name a value that would make it
  fail. Source-text assertions (`includes(...)` over a file) are the weakest
  form and have pinned bugs in place before; prefer running the function under
  a stub, as `agent/test/app-executable.test.js` does.
- Comments that state a count, an order, or a lifetime must be true. Several
  bugs here were a comment that stopped being true.
- The PWA's screens, copy and states follow an approved design; do not add,
  remove or reword a user-visible surface as a side effect of a code change.

## Where things are

| Path | What |
|---|---|
| `agent/server.js` | HTTP routes, the token gate |
| `agent/sessions.js` | launch, end, session-name derivation |
| `agent/registry.js` | session registry, liveness from pid files |
| `agent/config.js` | config file paths and shape, shared-folder resolution |
| `agent/auth.js` | passcode hashing, tokens, rate limit |
| `agent/launch-session.ps1` | the launcher: environment activation, then `claude.cmd` |
| `agent/public/app.js` | the whole PWA state machine |
| `agent/public/sw.js` | service worker; its cache key is a hash over the shell files |
| `skills/setup/SKILL.md` | the plugin's setup skill (host setup, ordered) |
| `docs/` | autostart, Tailscale HTTPS |
