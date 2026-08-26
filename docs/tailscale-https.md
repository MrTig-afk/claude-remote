# HTTPS for the Local Agent over Tailscale

Status: research, 2026-08-26. Nothing in here has been APPLIED — no Tailscale
setting was changed, no `serve` or `cert` command was run for real. Every
"verified" line below came from a read-only command whose output is quoted.

## The problem, in two sentences

Service workers and PWA install require a **secure context**. The browser treats
`http://127.0.0.1` as secure but `http://100.x.y.z:8790` as insecure, so the
moment the phone reaches the Local Agent by Tailscale IP over plain HTTP the
service worker refuses to register and the PWA will not install.

`tailscale serve` fixes this by terminating TLS inside the Tailscale daemon with
a real, publicly-trusted Let's Encrypt certificate issued for this machine's
MagicDNS name, and proxying the decrypted request to the agent on loopback.

**ELI5.** The phone's browser only trusts a padlock. Right now the agent hands it
a plain page, so the browser refuses to install it. `tailscale serve` is a
doorman who already owns a real padlock: the phone talks to the doorman over
HTTPS, and the doorman walks the request the last few inches to the agent.

## What has to be true (tailnet settings) — ALL ALREADY TRUE

Both of these are tailnet-wide settings that are OFF by default. On this tailnet
they are already ON, so **there is nothing for the owner to click in the admin
console.** Verified:

| Requirement | State | Evidence |
|---|---|---|
| MagicDNS enabled tailnet-wide | ON | `tailscale dns status` → `MagicDNS: enabled tailnet-wide (suffix = <tailnet>.ts.net)`; `tailscale status --json` → `"MagicDNSEnabled": true` |
| HTTPS certificates enabled tailnet-wide | ON | `tailscale status --json` → `"CertDomains": ["<machine>.<tailnet>.ts.net"]` (this array is empty when HTTPS is off) plus node capability `"https"` present |
| A cert actually issues and validates | YES | `curl -w '%{ssl_verify_result}' https://<machine>.<tailnet>.ts.net/` → `http_code=200`, `ssl_verify_result=0` (0 = chain validated against the system trust store) |

If they are ever turned off, the place to turn them back on is the DNS page of
the admin console — <https://console.tailscale.com/admin/dns> — MagicDNS first,
then **HTTPS Certificates → Enable HTTPS**, acknowledging that machine names and
the tailnet DNS name go onto a public certificate-transparency ledger.

### This machine's identity

- Tailnet DNS suffix: `<tailnet>.ts.net`
- Tailnet name: `<you>.github`
- **MagicDNS name (what the cert is for, and what the phone navigates to):
  `<machine>.<tailnet>.ts.net`**
- Tailscale IPs: `100.x.y.z`, `fd7a:115c:a1e0::xxxx`
- Phone already in the tailnet: `<phone>.<tailnet>.ts.net` (`100.p.q.r`, iOS)
- Tailscale version: **1.102.2** — `serve` and `funnel` are both present and
  modern. `--bg`, `--https`, `--set-path`, `serve status --json` and
  `serve reset` were all confirmed against `tailscale serve --help` on this
  exact build, not recalled. The 2023 CLI rewrite in 1.52 is long behind us; no
  legacy syntax applies.

### `tailscale serve` is already in use on this machine

`tailscale serve status` currently reports two live entries:

```
https://<machine>.<tailnet>.ts.net       → proxy http://127.0.0.1:4173
https://<machine>.<tailnet>.ts.net:8443  → proxy http://127.0.0.1:8010
```

Two consequences. First, this is proof the whole mechanism already works here —
TLS terminates, the cert validates, the proxy reaches loopback. Second, **ports
443 and 8443 are taken**, so the agent needs a port of its own. Nothing below
touches those two entries; `tailscale serve` config is per-port and additive.

Also confirmed: `tailscale funnel status` shows every entry as `(tailnet only)`.
Nothing is exposed to the public internet today, and **nothing below changes
that** — Funnel is explicitly not wanted here.

## The commands, in order

Only one command is actually needed. Run it in a **normal, non-elevated
PowerShell** — see the elevation note below it.

```powershell
# 1. Start the agent as usual. It stays on loopback — do NOT change its bind.
node agent/server.js          # listening on http://127.0.0.1:8790

# 2. Put it behind HTTPS on the MagicDNS name, persistently.  NOT elevated.
tailscale serve --bg --https=8790 8790
```

That is it. The phone then goes to:

```
https://<machine>.<tailnet>.ts.net:8790
```

which is a secure context, so the service worker registers and the PWA installs.

`tailscale cert` is **not** needed as a separate step. `serve` provisions and
renews the certificate itself inside the daemon. `tailscale cert` exists only to
write cert files to disk for some *other* server to read, and those files are
yours to renew every 90 days. Do not run it here.

Useful neighbours — same elevation, all reversible:

```powershell
tailscale serve status               # read-only, shows all entries
tailscale serve --https=8790 off     # remove just this entry, leaves 443/8443 alone
tailscale serve reset                # NUKES ALL serve config incl. 443 and 8443 — avoid
```

### Elevation

- **Verified:** this session ran `tailscale version`, `tailscale status`,
  `tailscale status --json`, `tailscale dns status`, `tailscale serve status`
  and `tailscale serve status --json` from a shell where
  `WindowsPrincipal.IsInRole(Administrator)` returned **False**. The CLI's named
  pipe is reachable unelevated on this machine.
- **UNVERIFIED:** whether the *write* path (`tailscale serve --bg ...`) also
  succeeds unelevated was not tested, because running it for real was out of
  scope for this research. Tailscale on Windows has a documented history of
  `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled: Access is
  denied` on some installs. **If that error appears, re-run the same command
  verbatim in an elevated PowerShell — the flags do not change.**
- Either way, nothing here hits the elevated-shell wall that blocks T04–T07.
  There is no installer, no service change, no firewall change.

### One PWA-side caveat

The origin changes from `http://127.0.0.1:8790` to
`https://<machine>.<tailnet>.ts.net:8790`. Every URL the PWA emits —
`manifest.json`, the service-worker registration path, `start_url`, `scope`, and
the `/api/*` fetches — must be **relative**, never hardcoded to `127.0.0.1`, or
it will work at the desk and break on the phone. Worth an explicit check when
T30 lands.

## What persists across reboot

- **`tailscale serve --bg` persists.** The `--bg` flag writes the mapping into
  the daemon's own config; Tailscale's docs state Serve "runs persistently in the
  background until you disable it" and resumes automatically after a reboot or a
  `tailscale down` / `tailscale up`. No scheduled task and no Windows service
  wrapper is needed for the serve layer. Corroborated on this machine: the two
  existing entries stand as persistent config.
- **Without `--bg` it does NOT persist** — foreground serve dies with the
  terminal and has to be re-run after every reboot. Always pass `--bg`.
- **The certificate renews itself** while `serve` is the thing that owns it.
  (The opposite of the `tailscale cert`-to-disk route, which is a manual 90-day
  renewal — another reason not to use it.)
- **The agent does NOT persist.** `tailscale serve` will happily keep listening
  on 8790 with nothing behind it and return a proxy error. Getting
  `node agent/server.js` to come back after a reboot is a separate, still-open
  problem that nothing in this document solves. Solved by starting the agent
  automatically at logon - see `docs/agent-autostart.md`.

## Consequence for T34 (the Windows Firewall rule)

**T34's rule as planned is unnecessary, and was arguably already unnecessary.
Recommend dropping it and recording why.**

Read-only inspection of the live firewall found:

```
Tailscale-In   prof=Domain,Private  proto=Any  lport=Any  local=100.x.y.z               Allow
Tailscale-In   prof=Domain,Private  proto=Any  lport=Any  local=fd7a:115c:a1e0::xxxx   Allow
Tailscale-Process  prof=Any  proto=UDP  lport=Any  program=tailscaled.exe                   Allow
Claude Remote SSH (Tailscale only)  prof=Any  proto=TCP  lport=22  iface=Tailscale          Allow   ← T05
```

and the Tailscale interface's network category is **Private**, so those
`Tailscale-In` rules are in force.

Three reasons T34 no longer earns its place:

1. **With `tailscale serve`, the agent never listens on a network interface at
   all.** It stays on `127.0.0.1:8790`. Loopback traffic does not traverse the
   Windows Firewall, so an inbound allow rule for the agent's port permits
   nothing and protects nothing. The listener that faces the tailnet lives inside
   `tailscaled.exe`.
2. **Tailscale's own installer rules already cover the serve listener.**
   `Tailscale-In` is a blanket allow for **any protocol on any local port** whose
   local address is `100.x.y.z`. Port 8790 on the Tailscale IP is already
   permitted by it. That is exactly why the two existing serve entries (443→4173,
   8443→8010) work with **no per-port rule of their own** — a sweep of every
   enabled inbound rule for ports 4173, 8010, 8443 and 8790 returned nothing.
3. T05's rule was genuinely needed because **sshd binds `0.0.0.0`** and had to be
   narrowed to the Tailscale interface. That reasoning does not transfer to a
   process bound to loopback.

If the owner wants T34 kept anyway as belt-and-braces, the honest version mirrors
T05's shape:

```powershell
# NOT recommended — redundant with Tailscale-In. Elevated shell required.
New-NetFirewallRule -DisplayName "Claude Remote Agent (Tailscale only)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8790 -InterfaceAlias Tailscale
```

but understand it would be documentation, not enforcement: it adds an allow on
top of an existing allow, which changes nothing. **A firewall rule is not what
keeps the agent private** — the next section covers what actually does.

**Suggested T34 rewrite:** replace the rule with a one-line note in the setup doc
saying the agent is reachable only via `tailscale serve` on loopback and that
`Tailscale-In` already governs tailnet ingress. Do not spend an elevated shell
on it.

**UNVERIFIED:** none of the above was tested *from the phone*. It is inference
from the rule table plus the observed fact that the existing serve entries work
without per-port rules. Loading the existing
`https://<machine>.<tailnet>.ts.net/` once from the phone would settle it
in ten seconds and is worth doing before T30.

## Consequence for T33 (the passcode gate) — THE ORDERING MATTERS

**Yes. The moment `tailscale serve --bg --https=8790 8790` runs, the agent is
reachable by every device on the tailnet.** Serve is a proxy, not a filter. The
agent's `127.0.0.1` bind stops being a boundary and becomes an implementation
detail, because what sits on the far side of the proxy is the whole tailnet.

Today that means an agent with **no authentication at all** — one that can create
folders and launch Claude Code sessions with full access to the machine — becomes
reachable from any tailnet device, and from any device the tailnet is ever shared
with. Right now the tailnet holds exactly two nodes, both the owner's, so the
practical exposure is small. It is still an unlocked door.

### The rule

> **T33 ships before `tailscale serve` is turned on. Not the same day — before.**

Do them in the other order and there is a real window, as long as the PWA work
takes, in which the agent is reachable and unlocked. That window is precisely the
thing T33 exists to close, so opening it in order to build T33 is self-defeating.

If the serve command has to be run early to develop the PWA against a secure
context, the safe shape is:

```powershell
tailscale serve --bg --https=8790 8790     # while actively working
tailscale serve --https=8790 off           # every time you step away, until T33 lands
```

### Two knock-on effects on T33's own text

1. **T33's "bind to the Tailscale interface IP (100.x.y.z), never `0.0.0.0`"
   clause is now obsolete and should be dropped.** With serve in front, the agent
   should **stay on `127.0.0.1`** — strictly safer, because it means the only
   path in is through the proxy. `agent/server.js` line 9 pins
   `HOST = '127.0.0.1'` and `agent/test/server.test.js` has a test asserting it
   exactly; both are correct as they stand and should not be changed. The
   passcode half of T33 is untouched and still fully required.
2. **T33's "accepted window" during first-run gets slightly wider.** The task
   already states that the set-passcode endpoint is reachable from the tailnet
   before a passcode exists. That stays true and stays acceptable on a two-node
   single-owner tailnet — but with serve on, "reachable from the tailnet" is now
   literal rather than theoretical. Set the passcode immediately after first
   launch, not tomorrow.

### Rollout order that closes the first-run window completely

Better than "set it quickly": done in this order, the set-passcode route is
never reachable from the tailnet at all, so the accepted window above shrinks
to nothing.

1. Land the passcode gate.
2. Start the agent on loopback only: `node agent/server.js`.
3. **At the desk**, open `http://127.0.0.1:8790` and set the passcode. The
   set-passcode route closes permanently at that point — it answers 409 from
   then on.
4. **Only then** run `tailscale serve --bg --https=8790 8790`.

Step 4 before step 3 is the whole exposure. The proxy cannot forward a route
that has already closed, so setting the passcode first means no tailnet device
ever had a chance to claim it.

### One thing serve gives for free that does NOT replace T33

`tailscale serve` injects identity headers (`Tailscale-User-Login`,
`Tailscale-User-Name`) naming the tailnet user who made the request. Tempting as
a free auth layer — **it is not a substitute here.** T33's stated threat is *an
unlocked phone in someone else's hand*, and that phone carries the owner's own
Tailscale identity, so the headers would say "owner" and wave the attacker
straight through. The passcode defends exactly the case the headers cannot see.
Build T33 as written.

## Explicitly not verified

Stated plainly rather than guessed:

- Whether `tailscale serve --bg` succeeds from a **non-elevated** shell on this
  machine. Read commands do; the write path was not run. Fallback is an elevated
  shell, same command.
- Whether the **iPhone** resolves `<machine>.<tailnet>.ts.net` — that
  needs "Use Tailscale DNS" enabled in the iOS Tailscale app, which cannot be
  read from here. If the name fails to resolve on the phone while the tailnet is
  up, that toggle is the first thing to check.
- Whether an inbound tailnet request to a served port really passes the firewall
  untouched. Inferred from the rule table and from the two existing serve entries
  working without per-port rules; not tested from a second device.
- Whether **Safari on iOS** will install this as a home-screen PWA on a
  **non-standard port** (`:8790`). HTTPS on a non-default port is a valid secure
  context per spec and the origin is well-formed, but iOS home-screen install has
  its own quirks and this was not tested on a device. If it misbehaves, the
  fallback is to mount the agent on the standard port under a path
  (`tailscale serve --bg --set-path=/agent 8790`, giving
  `https://<machine>.<tailnet>.ts.net/agent/`) — at the cost of the
  service worker's scope and every asset URL having to live under that prefix.
- Nothing here was tested end-to-end with an actual PWA, because T30 does not
  exist yet.
