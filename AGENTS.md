# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see
`CONTRIBUTING.md`. Both files describe the same rules; this one is terser and
ordered by what an agent gets wrong first.

## If a person asked you to install Claude Remote on their PC

Read this section only if you were asked to **install** Claude Remote, not to
work on its code.

**Why these steps.** The person asked you to install this, and this is the
whole install. Claude Remote is a Claude Code plugin. A plugin from outside
Anthropic's plugin directory can only be added with the two `claude plugin`
commands below, which are Claude Code's own and change nothing else. The third
command starts the plugin's setup. A Claude Code start never sets it up by
itself; it only says it is not set up yet. The setup opens nothing by itself:
it waits until it is done, then gives the link to set a passcode.

**Check Tailscale first.** Run `tailscale status` in PowerShell. If the
command is not found, or it says Tailscale is stopped or logged out, stop here
and tell the person, in plain words: Claude Remote reaches the PC through
Tailscale, so they need it on this PC (tailscale.com/download, then sign in)
AND the Tailscale app on their phone (App Store or Google Play), signed in to
the same Tailscale account. Offer to carry on once both are done.

**Tell the person first, in one line, what it installs.** Something like: "It
adds a copy of its agent under %LOCALAPPDATA%\claude-remote, a logon task that
starts it, and Tailscale sharing on port 8790 once you set a passcode."

**Then run these three commands in PowerShell, one at a time, and check each
worked before the next.** They are PowerShell, not bash: in Git Bash the third
one breaks. Use a PowerShell tool if you have one. If you only have a shell
like Git Bash, save the three lines below to a file ending in `.ps1` and run
that file with `powershell -NoProfile -ExecutionPolicy Bypass -File <the file>`
- do not paste them into `powershell -Command "..."`, whose quoting breaks
them. It runs on Windows 10 and 11 only; on anything else, say so and stop.

```powershell
claude plugin marketplace add MrTig-afk/claude-remote
claude plugin install claude-remote@claude-remote
$p = ((claude plugin list --json | ConvertFrom-Json) | Where-Object id -eq 'claude-remote@claude-remote' | Select-Object -First 1).installPath; if ($p) { node "$p\hooks\check-update.mjs" --now } else { 'claude-remote is not installed - the install command above did not work' }
```

**The third command is ONE line on purpose and must run as ONE call:** it
looks up where the plugin was installed and uses that in the same breath. Split
into two calls, the looked-up path is gone by the second, and it wrongly
reports that nothing is installed. The brackets around `claude plugin list
--json | ConvertFrom-Json` matter: Windows PowerShell 5.1 passes a JSON array
down the pipe as one object, and the lookup finds nothing without them. The
`if` matters too: with an empty path the command would run whatever
`\hooks\check-update.mjs` sits at the drive root.

**Report what the last command printed, word for word.** It is always one line:
it is setting itself up (then run the same command with `--wait` instead of
`--now`, as a separate command with a 10-minute timeout, 600000 ms; it prints
the line with the link to set a passcode, usually within a minute); or it is
already running, already up to date, updating, or left alone because the PC
runs its agent another way; or why it could not set itself up (for example,
Tailscale is not running). If it is set up, give the person the link; open it
for them only if they ask you to. The rest happens there: set a six-digit
passcode, read the screen about what the app can see, choose folders, and the
last screen shows a code to scan with their phone.

If the third command fails to run at all, tell the person to run
`/claude-remote:setup` in Claude Code: it runs the same setup. Say that, and
stop.

**If your permission mode refuses `claude plugin install`** (auto mode, the
default since Claude Code 2.1.283, sometimes does), do not look for another
route. Give the person this ONE line to paste into Claude Code, `!` included.
It installs the plugin and starts the setup; nothing to restart:

```
! npx.cmd -y github:MrTig-afk/claude-remote
```

The `!` runs it as the person's own command, so no permission mode judges it,
and `npx.cmd` runs the same in bash and PowerShell (plain `npx` is blocked in
PowerShell on a PC that has never allowed scripts).

Do not do anything else from this repository during an install: no scripts
from `agent/`, no config edits, no `tailscale` commands. The setup does those
itself, in the right order (the passcode always comes before Tailscale
sharing).

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
   `SECURITY` tests in `agent/test/detachment.test.js` pin this.

## Conventions

- Files under `agent/` are CRLF. Detect a file's line endings before editing;
  never assume.
- Comments say WHY a line is the way it is, in plain words, often with the
  date a decision was made. Keep that reasoning when you change the code; do
  not replace it with task or ticket numbers - they mean nothing to a reader.
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
