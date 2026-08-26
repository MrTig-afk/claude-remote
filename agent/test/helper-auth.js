// Shared fixture for auth tests. Filename deliberately does not match
// *.test.js, so `node --test "test/**/*.test.js"` never runs it as a suite.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setPasscode, TOKEN_HEADER, TOKEN_TTL_MS } from '../auth.js';
import { createAgentServer } from '../server.js';

/**
 * A fresh mkdtemp-backed ctx carrying EVERY path an agent server writes:
 * passcodePath, attemptsPath, registryPath, pidDir - plus tokens and now.
 * All four live in one temp dir that cleanupAuthCtx removes.
 *
 * registryPath and pidDir belong here even though they are not "auth": a ctx
 * that omits them silently falls back to config.js's real paths, and the
 * server then overwrites the owner's live sessions.json. Keeping every path
 * in one fixture is what stops a caller forgetting one.
 */
export function makeAuthCtx({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-auth-'));
  return {
    dir,
    passcodePath: path.join(dir, 'passcode.json'),
    attemptsPath: path.join(dir, 'passcode-attempts.json'),
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'session-pids'),
    tokens: new Map(),
    now: now || Date.now,
  };
}

// Every path a fixture server can write must resolve under os.tmpdir().
// This is not hygiene, it is a real bug caught late: a ctx spread that
// dropped registryPath/pidDir made `node --test` overwrite the owner's
// ~/.claude/plugins/data/claude-remote-claude-remote/sessions.json on every
// run, silently, for two days. `undefined` is the dangerous value (it is what
// triggers the config.js fallback), so a missing key throws like a wrong one.
const FIXTURE_PATH_KEYS = ['passcodePath', 'attemptsPath', 'registryPath', 'pidDir'];

// The fifth key that falls back to the real world, and the only one that is
// not a path: sessions.js does `const { baseDir, spawner = spawn } = ctx`, so
// a fixture without a spawner launches a REAL detached PowerShell -> WSL ->
// tmux session and puts console windows on the owner's desktop. A test that
// wants a spawner passes one; one that does not gets this, which throws
// instead of defaulting to the real thing.
function refuseSpawn() {
  throw new Error(
    'helper-auth: this fixture server has no spawner, so a launch would start a REAL '
    + 'session on the owner\'s desktop. Pass an explicit spawner to the ctx.',
  );
}

/** createAgentServer, but it refuses a ctx that could write the owner's real data dir. */
export function fixtureServer(ctx) {
  const tmp = path.resolve(os.tmpdir()) + path.sep;
  for (const key of FIXTURE_PATH_KEYS) {
    const value = ctx[key];
    if (typeof value !== 'string' || !path.resolve(value).startsWith(tmp)) {
      throw new Error(
        `helper-auth: ctx.${key} is ${value === undefined ? 'missing' : `'${value}'`}; `
        + `a test server's paths must all live under ${tmp} or agent/config.js falls back `
        + "to the owner's real data directory and the suite writes it",
      );
    }
  }
  // Fill the spawner IN PLACE rather than building `{ spawner, ...ctx }`.
  // Two reasons, both learned the hard way:
  //   - a copy breaks object identity, and auth.js hangs `attemptFloor` on the
  //     object the server holds - so callers asserting on their own ctx would
  //     silently be measuring a different object;
  //   - `{ spawner: refuseSpawn, ...ctx }` is defeated anyway by a ctx carrying
  //     an explicit `spawner: undefined`, which spreads over the stub and lets
  //     sessions.js's `spawner = spawn` default resolve to the REAL spawn.
  // A typeof check covers both the missing and the undefined case.
  if (typeof ctx.spawner !== 'function') ctx.spawner = refuseSpawn;
  return createAgentServer(ctx);
}

/** Sets a passcode directly via auth.js. Returns setPasscode's own result. */
export function seedPasscode(ctx, code) {
  return setPasscode(ctx, code, code);
}

/**
 * Inserts a fresh, valid token straight into ctx.tokens (same digest scheme
 * auth.js itself uses) without needing to know or replay the passcode.
 * Returns the plaintext token string.
 */
export function issueTestToken(ctx) {
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const now = (ctx.now || Date.now)();
  ctx.tokens.set(digest, { expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/** { 'x-claude-remote-token': token } */
export function authHeaders(token) {
  return { [TOKEN_HEADER]: token };
}

/** (path, opts) => fetch against origin, merging the token header in. */
export function makeAuthedFetch(origin, token) {
  return (p, opts = {}) => fetch(`${origin}${p}`, {
    ...opts,
    headers: { ...authHeaders(token), ...(opts.headers || {}) },
  });
}

/** Best-effort rmSync of the ctx's temp dir. */
export function cleanupAuthCtx(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}
