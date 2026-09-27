// Lane 23 / R21.3 - the PC switches its own Tailscale sharing on, and tells
// the desk what address the phone should open.
//
// THE ORDER IS THE SAFETY RULE (skills/setup/SKILL.md, "THE ORDER IS
// LOAD-BEARING"): `tailscale serve` exposes the agent to every device on the
// tailnet, and an agent with no passcode lets whoever reaches it first set
// one. So serve runs only once a passcode exists - switchOnServe re-checks it
// rather than trusting its caller - and the automatic run is started from the
// one moment a passcode is FIRST set (server.js, POST /api/auth/passcode).
//
// NOTHING HERE RUNS A REAL tailscale UNLESS THE REAL SERVER ASKED FOR IT:
// `ctx.phoneServe === true` is set only in server.js's import.meta.main ctx,
// the same opt-in pattern as trustFolders and watchLaunches. Tests hand in
// `ctx.tailscaleRun` instead; with neither, every call answers 'unknown'.

import { execFile } from 'node:child_process';

import { tailscaleBinary, serveVerdict } from './alerts.js';
import { isConfigured } from './auth.js';

const SERVE_TIMEOUT_MS = 30_000;   // serve --bg returns in about a second; a tailnet without HTTPS waits forever
const STATUS_TIMEOUT_MS = 5_000;
export const WARM_TIMEOUT_MS = 120_000;   // the first request pays for the certificate - tens of seconds

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** execFile, no shell, fixed args -> { ok, stdout } | { ok: false, code }. Never rejects. */
export function runTailscale(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(tailscaleBinary(), args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (!err) { resolve({ ok: true, stdout }); return; }
      resolve({ ok: false, code: err.killed ? 'timeout' : String(err.code ?? 'error') });
    });
  });
}

function runnerFor(ctx) {
  if (typeof ctx.tailscaleRun === 'function') return ctx.tailscaleRun;
  return ctx.phoneServe === true ? runTailscale : null;
}

/**
 * This PC's tailnet address for `port`, from `tailscale status --json`, or
 * null. The DNS name arrives FQDN-style with a trailing dot, which must go
 * (new URL('https://x./').hostname keeps it). Anything that is not a plain
 * dotted hostname is refused: it ends up on screen and in a QR code.
 */
export function phoneUrl(statusStdout, port) {
  if (!validPort(port)) return null;
  let dns;
  try {
    dns = JSON.parse(statusStdout)?.Self?.DNSName;
  } catch {
    return null;
  }
  if (typeof dns !== 'string') return null;
  const host = dns.replace(/\.+$/, '').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return `https://${host}:${port}`;
}

// One request so the certificate is issued now, not while the phone waits
// (measured 2026-09-22: left to the phone it is a white screen, then "server
// stopped responding"). Its answer does not matter; only that it was asked.
function warm(ctx, url) {
  const get = ctx.warmFetch || fetch;
  Promise.resolve()
    .then(() => get(url, { signal: AbortSignal.timeout(WARM_TIMEOUT_MS) }))
    .then((res) => res?.body?.cancel?.())
    .catch((err) => {
      console.warn(`claude-remote agent: first request to the tailnet address failed: ${err?.cause?.code || err?.name || 'unknown'}`);
    });
}

/** Runs `tailscale serve --bg --https=<port> <port>`. -> 'on' | 'off' | 'unknown'. */
async function switchOnServe(ctx, port) {
  const run = runnerFor(ctx);
  if (!run) return 'unknown';
  if (!validPort(port) || !isConfigured(ctx)) return 'off';
  const res = await run(['serve', '--bg', `--https=${port}`, String(port)], SERVE_TIMEOUT_MS);
  if (!res.ok) {
    console.warn(`claude-remote agent: tailscale serve failed: ${res.code}`);
    return 'off';
  }
  const status = await run(['status', '--json'], STATUS_TIMEOUT_MS);
  const url = status.ok ? phoneUrl(status.stdout, port) : null;
  if (url) warm(ctx, url);
  else console.warn('claude-remote agent: tailscale serve is on, but this PC\'s tailnet name could not be read');
  return 'on';
}

/** One serve at a time: a second caller shares the run in flight. */
export function startServe(ctx, port) {
  if (!ctx.phoneServing) {
    ctx.phoneServing = switchOnServe(ctx, port).finally(() => { ctx.phoneServing = null; });
  }
  return ctx.phoneServing;
}

/**
 * What the phone screen shows: { url, serve: 'on' | 'off' | 'unknown' },
 * read from Tailscale each time (so a serve switched on by hand counts too).
 * Waits for a serve still in flight, so the desk never reports "off" for one
 * that is about to succeed.
 */
export async function phoneStatus(ctx, port) {
  if (ctx.phoneServing) await ctx.phoneServing;
  const run = runnerFor(ctx);
  if (!run || !validPort(port)) return { url: null, serve: 'unknown' };
  const [serve, status] = await Promise.all([
    run(['serve', 'status', '--json'], STATUS_TIMEOUT_MS),
    run(['status', '--json'], STATUS_TIMEOUT_MS),
  ]);
  const verdict = serve.ok ? serveVerdict(serve.stdout, port) : 'unknown';
  return {
    url: status.ok ? phoneUrl(status.stdout, port) : null,
    serve: { present: 'on', missing: 'off' }[verdict] || 'unknown',
  };
}
