import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { getRegistryFilePath, getServeStatePath, writeConfig } from './config.js';
import { listSessions, STARTING_GRACE_MS } from './registry.js';
import { notifyAll } from './push.js';

export const WATCH_INTERVAL_MS = 3_000;
// Must outlast STARTING_GRACE_MS: a launch that never writes its pid file is
// only derived `failed` once that grace expires.
export const WATCH_WINDOW_MS = STARTING_GRACE_MS + 2 * WATCH_INTERVAL_MS;
export const SERVE_TRIES = 6;
export const SERVE_RETRY_MS = 20_000;
const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;

// One watch per (registry, session name) at a time - see watchLaunch. Module-
// scope by design: production runs one agent process with one registry, and
// the key is scoped by registryPath so parallel tests never collide on it.
const inFlightWatches = new Set();

function watchKey(ctx, sessionName) {
  return `${ctx.registryPath || getRegistryFilePath()}\0${sessionName}`;
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Polls listSessions for sessionName every WATCH_INTERVAL_MS, up to
 * WATCH_WINDOW_MS, and pushes launch_failed (or launch_unconfirmed, when no
 * reason was written) the moment it sees `failed`.
 * -> 'running' | 'failed' | 'gone' | 'timeout' | 'already'. Never throws.
 */
export async function watchLaunch(ctx, sessionName) {
  const key = watchKey(ctx, sessionName);
  if (inFlightWatches.has(key)) return 'already';
  inFlightWatches.add(key);

  try {
    const sleep = ctx.alertSleep || (() => sleepMs(WATCH_INTERVAL_MS));
    const start = (ctx.now || Date.now)();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep();

      let view;
      try {
        view = listSessions(ctx).find((s) => s.session_name === sessionName);
      } catch {
        return 'gone';
      }
      if (!view || view.status === 'ending' || view.status === 'ended') return 'gone';
      if (view.status === 'running') return 'running';
      if (view.status === 'failed') {
        // No .err means "never confirmed", not "could not start" (registry.js):
        // the session may be running with only its pid write lost.
        // eslint-disable-next-line no-await-in-loop
        await notifyAll(ctx, view.env_error ? 'launch_failed' : 'launch_unconfirmed');
        return 'failed';
      }

      if ((ctx.now || Date.now)() - start >= WATCH_WINDOW_MS) return 'timeout';
    }
  } catch {
    return 'gone';
  } finally {
    inFlightWatches.delete(key);
  }
}

/**
 * 'present' | 'missing' | 'unknown' from a raw `tailscale serve status --json`
 * stdout string, for one port. {} and null are both no-config outputs
 * (Tailscale marshals a nil/empty ServeConfig as null over the CLI).
 */
export function serveVerdict(stdout, port) {
  if (typeof stdout !== 'string') return 'unknown';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'unknown';
  }
  if (parsed === null) return 'missing';
  if (Array.isArray(parsed) || typeof parsed !== 'object') return 'unknown';

  const target = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?:/|$)`, 'i');
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(walk);
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'Proxy' || key === 'TCPForward') && typeof value === 'string' && target.test(value)) return true;
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(parsed) ? 'present' : 'missing';
}

function tailscaleBinary() {
  const candidate = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  return fs.existsSync(candidate) ? candidate : 'tailscale';
}

/** Raw stdout of `tailscale serve status --json`, or null on any error/timeout/non-zero exit. */
export function runServeStatus(execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(tailscaleBinary(), ['serve', 'status', '--json'], {
      windowsHide: true,
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
    }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function readServeState(statePath) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (data && (data.serve === 'present' || data.serve === 'missing')) return data.serve;
  } catch {
    // absent or corrupt - no previous verdict on record
  }
  return null;
}

/**
 * One serve check per start, from the listen callback. Pushes
 * serve_missing ONLY on the present -> missing transition, recorded in one
 * persisted marker so a restart never re-sends the same alert while the
 * config stays missing. UNKNOWN never updates the marker and never pushes;
 * it is retried SERVE_TRIES times because at boot the agent can start before
 * the Tailscale service answers.
 * -> 'unknown' | 'present' | 'missing' | 'notified'.
 */
export async function checkServeOnce(ctx, port, run = runServeStatus) {
  const statePath = ctx.serveStatePath || getServeStatePath();
  const previous = readServeState(statePath);
  const wait = ctx.serveRetrySleep || (() => sleepMs(SERVE_RETRY_MS));
  let verdict = 'unknown';
  for (let i = 0; i < SERVE_TRIES && verdict === 'unknown'; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (i > 0) await wait();
    // eslint-disable-next-line no-await-in-loop
    verdict = serveVerdict(await run(), port);
  }
  if (verdict === 'unknown') return 'unknown';

  writeConfig(statePath, { serve: verdict });
  if (previous === 'present' && verdict === 'missing') {
    await notifyAll(ctx, 'serve_missing');
    return 'notified';
  }
  return verdict;
}
