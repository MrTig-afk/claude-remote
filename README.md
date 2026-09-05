# Claude Remote

Start, watch, and stop a Claude Code session running on this Windows PC from
your phone, anywhere, over Tailscale. Open the PWA, tap a project, and the
session appears live in the Claude Code app - the same session whether you
drive it from the phone or sit down at the desk. When you are done, STOP ends
it and writes a handoff summary for next time.

## Architecture

```
phone (PWA) --https(Tailscale)--> tailscale serve --http--> Local Agent
                                                              (Node,
                                                          127.0.0.1:8790)
                                                                 |
                                                                 v
                                                      agent/launch-session.ps1
                                                                 |
                                                                 v
                                                  claude.cmd --remote-control
                                                    (Claude Code app, Code tab)

STOP --> taskkill on the session's process --> agent/handoff-session.ps1
         (hidden `claude -p ... /handoff`, writes the handoff, no
         --remote-control so it never registers a session of its own)
```

`tailscale serve` terminates HTTPS on this machine's MagicDNS name and proxies
to the agent on loopback; see `docs/tailscale-https.md` for why that step is
required. The agent never binds to anything but `127.0.0.1`.

## Daily use

1. Open the PWA on your phone.
2. Enter the passcode (set once at the desk - see Setup below).
3. Tap a project in the list. It moves up into the RUNNING tiles as the
   session launches and shows up in the Claude Code app's Code tab; work
   there as normal.
4. A session started at the desk (not from the phone) shows up in the picker
   too, its tile marked "desktop" - you can end it from the phone the same
   way.
5. When finished, tap STOP, then confirm END & WRITE HANDOFF (shown as
   END & WRITE HANDOFF (DESKTOP) for a desk-started session). The agent kills
   the session's process and runs a hidden `claude -p ... /handoff` in the
   project to write a handoff summary, then shows a banner once it is done.

## Setup on this machine

Prerequisites: Windows, Tailscale already installed and up, Node >= 24.2.0,
the Claude Code CLI on PATH.

```powershell
node agent/server.js
```

This listens on `http://127.0.0.1:8790` only. On first run it has no
passcode and every `/api` route except the passcode routes themselves
answers 403 - open
`http://127.0.0.1:8790` at the desk and set one before doing anything
else, and before turning on `tailscale serve` (see
`docs/tailscale-https.md` for why the order matters).

To have the agent start itself at logon, register the scheduled task -
see `docs/agent-autostart.md`.

To expose the agent to your phone over HTTPS via Tailscale, follow
`docs/tailscale-https.md` (in short: `tailscale serve --bg --https=8790
8790`, run only after the passcode is set).

## Tests

```
node --test "agent/test/**/*.test.js"
```

Run it from the repo root; the bare-directory form (`node --test agent/test/`)
fails on this host.

Some of the suite drives a real headless Chrome to check that no text input
renders under 16px, because below that iOS Safari zooms the page and does not
zoom back out. If Chrome is not installed where the check looks, set
`CHROME=<path>`, or `ALLOW_NO_CHROME=1` to skip that check knowingly.

## License

MIT. See `LICENSE`.
