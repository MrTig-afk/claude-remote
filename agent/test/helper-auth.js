// Shared fixture for auth tests. Filename deliberately does not match
// *.test.js, so `node --test "test/**/*.test.js"` never runs it as a suite.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setPasscode, TOKEN_HEADER, TOKEN_TTL_MS } from '../auth.js';
import { createAgentServer } from '../server.js';

/**
 * [<dir>/claude-sessions] - the one sessionDirs value every test ctx that
 * can reach listSessions/readSessionFiles must carry, so a forgotten key
 * never falls back to config.js's real ~/.claude-max or ~/.claude-pro (the
 * exact bug found in tree-kill.test.js). Deliberately does
 * NOT create the directory - a missing one must be tolerated by the reader
 * (ENOENT = empty, per registry.js's readSessionFiles).
 */
export function testSessionDirs(dir) {
  return [path.join(dir, 'claude-sessions')];
}

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
    configPath: path.join(dir, 'config.json'),
    pushPath: path.join(dir, 'push.json'),
    sessionDirs: testSessionDirs(dir),
    // PUT /api/shared writes through ctx.configPath. Omitting it here
    // is the exact same bug class the comment below already warns about, one
    // key later: agent/config.js's real getConfigFilePath() would take over
    // and the suite would overwrite the owner's live config.json.
    configPath: path.join(dir, 'config.json'),
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
// configPath IS in this list. It was once briefly argued it should not be - on the
// grounds that readStatusFacts only reads it - but shared folders gave the agent routes
// that WRITE the config (PUT /api/shared, POST /api/acknowledge), so a
// fixture missing configPath would write the owner's real shared folders.
// That is the same class of accident registryPath and pidDir are here to
// prevent, and it is why that reasoning no longer applies.
const FIXTURE_PATH_KEYS = ['passcodePath', 'attemptsPath', 'registryPath', 'pidDir', 'configPath', 'pushPath'];

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

// The seam endSession() uses. Same reasoning as refuseSpawn above: a fixture
// without it would tree-kill a real pid on this machine.
function refuseKill() {
  throw new Error(
    'helper-auth: this fixture server has no killSpawner, so ending a session would run a REAL '
    + 'taskkill against a pid on this machine. Pass an explicit killSpawner to the ctx.',
  );
}
function refusePidImageName() {
  throw new Error(
    'helper-auth: this fixture server has no pidImageName, so ending a session would query a REAL '
    + "process's image name via tasklist on this machine. Pass an explicit pidImageName to the ctx.",
  );
}
function refuseDriveExec() {
  throw new Error(
    'helper-auth: this fixture server has no driveExec, so GET /api/drives would run a REAL '
    + "powershell.exe Get-CimInstance on this machine. Pass an explicit driveExec to the ctx.",
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
  // sessionDirs is read-only, but a ctx that omits it falls back to
  // config.js's getSessionDirPaths() - the owner's real ~/.claude-max and
  // ~/.claude-pro sessions directories - and the suite reads the owner's
  // real Claude Code session files.
  if (
    !Array.isArray(ctx.sessionDirs) || ctx.sessionDirs.length === 0
    || !ctx.sessionDirs.every((d) => typeof d === 'string' && path.resolve(d).startsWith(tmp))
  ) {
    throw new Error(
      `helper-auth: ctx.sessionDirs must be a non-empty array of strings each resolving under ${tmp} `
      + "or the suite reads the owner's real Claude Code session files",
    );
  }
  // Fill the seams IN PLACE rather than building `{ spawner, ...ctx }`. Two
  // reasons, both learned the hard way:
  //   - a copy breaks object identity, and auth.js hangs `attemptFloor` on the
  //     object the server holds - so callers asserting on their own ctx would
  //     silently be measuring a different object;
  //   - `{ spawner: refuseSpawn, ...ctx }` is defeated anyway by a ctx carrying
  //     an explicit `spawner: undefined`, which spreads over the stub and lets
  //     sessions.js's `spawner = spawn` default resolve to the REAL spawn.
  // A typeof check covers both the missing and the undefined case.
  if (typeof ctx.spawner !== 'function') ctx.spawner = refuseSpawn;
  if (typeof ctx.killSpawner !== 'function') ctx.killSpawner = refuseKill;
  if (typeof ctx.pidImageName !== 'function') ctx.pidImageName = refusePidImageName;
  if (typeof ctx.driveExec !== 'function') ctx.driveExec = refuseDriveExec;
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
