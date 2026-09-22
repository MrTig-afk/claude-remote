# Security

claude-remote starts Claude Code on your PC with the full permissions of your
user account, reachable from your tailnet behind one passcode. A hole in it is
a hole in your machine, so please report one privately.

## Reporting a vulnerability

**Do not open a public issue.** Instead, either:

- use GitHub's private reporting: the repository's **Security** tab, then
  **Report a vulnerability**, or
- email kaushiknaru2002@gmail.com with "claude-remote security" in the subject.

Include what you found, how to reproduce it, and what an attacker gains. You
will get a reply within a week. Please give a fix time to ship before you
publish anything.

## What counts

In scope: anything that gets past the passcode, reaches the agent from outside
the tailnet, makes a tap run code the owner did not choose, escapes the shared
folders the picker allows, or leaks the passcode, its hash or a session token.

Known and documented, so not a report on their own: a launched session can
reach everything your account can (no filesystem isolation), the passcode is
six digits, and anyone on your tailnet can reach the agent. The threat model is
in `README.md` under "Read this before you install it".

Only the latest commit on `main` is supported.
