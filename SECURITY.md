# Security

Claude Remote starts Claude Code on your PC with **the full permissions of your
user account**, reachable from your tailnet behind one passcode. A hole in it
is a hole in your machine, so please report one privately.

## Reporting a vulnerability

**DO NOT OPEN** a public issue. Instead, either:

- Use GitHub's private reporting: the repository's **Security** tab, then
  **Report a vulnerability**.
- Email kaushiknaru2002@gmail.com with *claude-remote security* in the subject.

Include what you found, how to reproduce it, and what an attacker gains. You
will get a reply **within a week**. Please give a fix time to ship before you
publish anything.

## What counts

**In scope** - anything that:

- Gets past the passcode.
- Reaches the agent from outside the tailnet.
- Makes a tap run code the owner did not choose.
- Escapes the shared folders the picker allows.
- Leaks the passcode, its hash or a session token.

**Known and documented**, so not a report on its own:

- A launched session can reach everything your account can (no filesystem
  isolation).
- The passcode is six digits.
- Anyone on your tailnet can reach the agent.

The threat model is in `README.md`, under *Read this before you install it*.

Only the latest commit on `main` is supported.

## Thanks

The hidden launcher (`agent/autostart/hidelaunch.cs`) exists because
[@huntsman95](https://github.com/huntsman95) and [@Icolan](https://github.com/Icolan)
pointed out what was wrong with launching through `conhost --headless`.
