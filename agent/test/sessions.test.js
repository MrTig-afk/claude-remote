import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { deriveSessionName, resolveProjectPath, launchSession } from '../sessions.js';
import { STARTING_GRACE_MS } from '../registry.js';
import { seedPasscode, issueTestToken, authHeaders, fixtureServer } from './helper-auth.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-sessions-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, '-weird'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

// Every makeRegCtx() call creates a temp dir; without tracking them the
// suite leaked one per test (92 across a full run, measured 2026-08-25).
const perTestDirs = [];

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  for (const d of perTestDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeFakeSpawner() {
  const calls = [];
  function spawner(file, args, options) {
    const child = {
      pid: 4242,
      unrefCount: 0,
      handlers: {},
      unref() { this.unrefCount += 1; },
      on(event, fn) { this.handlers[event] = fn; return this; },
    };
    calls.push({ file, args, options, child });
    return child;
  }
  return { spawner, calls };
}

// Every test gets its own registry file + pid dir under a fresh mkdtempSync
// directory, so the owner's real profile (~/.claude/plugins/data/...) is
// never read or written by the suite. isPidAlive defaults to "nothing is
// alive" since the fake spawner never writes a pid file anyway.
//
// The passcode gate sits above every /api route (see server.js), so any ctx
// used to build a real HTTP server needs to already be configured and hold a
// valid token - folded in here so every one of the many fixtureServer
// call sites below needs no change of its own. ctx.now is one seam shared by
// both the registry and the token/attempts bookkeeping, so a caller that
// overrides `now` (time-travel tests) gets a token issued against that same
// clock, not the real one.
function makeRegCtx(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-registry-'));
  perTestDirs.push(dir);
  const ctx = {
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'session-pids'),
    isPidAlive: () => false,
    now: () => Date.now(),
    passcodePath: path.join(dir, 'passcode.json'),
    attemptsPath: path.join(dir, 'passcode-attempts.json'),
    tokens: new Map(),
    ...extra,
  };
  seedPasscode(ctx, '481902');
  ctx.token = issueTestToken(ctx);
  return ctx;
}

// Swaps a plain fetch(url, opts) call for one carrying regCtx's token -
// the mechanical step every /api/* fetch in this file needs now that the
// gate sits above those routes.
function authedFetch(regCtx, url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...authHeaders(regCtx.token), ...(opts.headers || {}) } });
}

// --- 6.3 deriveSessionName - the naming contract ---------------------------

test('deriveSessionName - naming contract', () => {
  const rows = [
    ['Pull Requests', 'pull-requests'],
    ['Video Editing', 'video-editing'],
    ['email-lint', 'email-lint'],
    ['F:\\Dev\\Projects\\Repos\\Pull Requests', 'pull-requests'],
    ['F:\\Dev\\Projects\\Repos\\email-lint', 'email-lint'],
    ['Backend Engineering', 'backend-engineering'],
    ['My.Project', 'my-project'],
    ['A  B', 'a-b'],
    ['Foo. .Bar', 'foo-bar'],
    ['Reactive-Resume', 'reactive-resume'],
    ['F:\\Dev\\Projects\\Repos\\Video Editing\\', 'video-editing'],
  ];
  for (const [input, expected] of rows) {
    assert.equal(deriveSessionName(input), expected, `input: ${input}`);
  }
});

// --- 6.4 Launch mechanics (unit level, launchSession directly) -------------

test('launchSession - one call spawns exactly one process', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.equal(calls.length, 1);
});

test('launchSession - spawns powershell.exe', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.equal(calls[0].file, 'powershell.exe');
});

test('launchSession - exact args array', () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  launchSession({ baseDir: base, spawner, ...regCtx }, 'Pull Requests');
  const LAUNCH_SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1');
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', path.join(base, 'Pull Requests'),
    '-SessionName', 'pull-requests',
    '-PidFile', path.join(regCtx.pidDir, 'pull-requests.pid'),
  ]);
});

test('launchSession - exact options (detachment contract)', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.deepEqual(calls[0].options, {
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.join(base, 'Pull Requests'),
  });
});

test('launchSession - child.unref() called exactly once', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.equal(calls[0].child.unrefCount, 1);
});

test('launchSession - error handler wired', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.equal(typeof calls[0].child.handlers.error, 'function');
});

test('launchSession - no shell string-building leaked into args', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.ok(!calls[0].args.includes('-Command'));
  assert.ok(!calls[0].args.some((a) => a.includes('&')));
  assert.ok(!calls[0].args.some((a) => a.includes(';')));
});

test('launchSession - clearPidFile genuinely fires BEFORE the spawn call, not merely before return', () => {
  const regCtx = makeRegCtx();
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  const pidFilePath = path.join(regCtx.pidDir, 'email-lint.pid');
  fs.writeFileSync(pidFilePath, '77777', 'ascii');

  // Instrumented spawner: records whether the stale pid file still exists
  // AT THE INSTANT spawner() is invoked, not after launchSession returns.
  // Since launchSession is fully synchronous, a test that only checks
  // fs.existsSync() after the call returns cannot distinguish
  // "cleared before spawn" from "cleared after spawn" - both leave the
  // file gone by the time control returns to the test. This one can.
  let pidFileExistedAtSpawnTime = 'never called';
  function spawner() {
    pidFileExistedAtSpawnTime = fs.existsSync(pidFilePath);
    return {
      pid: 4242,
      unref() {},
      on() { return this; },
    };
  }

  launchSession({ baseDir: base, spawner, ...regCtx }, 'email-lint');

  assert.equal(pidFileExistedAtSpawnTime, false,
    'stale pid file must already be gone by the time spawner() is called - '
    + 'otherwise a launch that silently writes nothing inherits it as a phantom "running" entry');
});

// --- 6.5 Rejection cases - each asserts calls.length === 0 ------------------

test('resolveProjectPath - rejection table (invalid_project / invalid_request)', () => {
  const rows = [
    ['..', 'invalid_project'],
    ['../..', 'invalid_project'],
    ['..\\Windows', 'invalid_project'],
    ['C:\\Windows', 'invalid_project'],
    ['\\\\server\\share', 'invalid_project'],
    ['Pull Requests/../..', 'invalid_project'],
    ['sub/dir', 'invalid_project'],
    ['sub\\dir', 'invalid_project'],
    ['foo:bar', 'invalid_project'],
    ['.hidden', 'invalid_project'],
    ['', 'invalid_request'],
    ['   ', 'invalid_request'],
    ['x'.repeat(300), 'invalid_request'],
    [42, 'invalid_request'],
    [null, 'invalid_request'],
    [undefined, 'invalid_request'],
  ];
  for (const [project, expectedError] of rows) {
    const { spawner, calls } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, project);
    assert.equal(result.ok, false, `project: ${project}`);
    assert.equal(result.error, expectedError, `project: ${project}`);
    assert.equal(calls.length, 0, `project: ${project}`);
  }
});

test('resolveProjectPath - leading hyphen rejected as invalid_project', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, '-weird');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_project');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - nonexistent project rejected as project_not_found', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'no-such-project');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - a file (not a directory) rejected as project_not_found', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'notes.txt');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - junction escaping base dir rejected as project_not_found', (t) => {
  const linkPath = path.join(base, 'linked');
  try {
    fs.symlinkSync(os.tmpdir(), linkPath, 'junction');
  } catch {
    t.skip('junction creation not permitted');
    return;
  }
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'linked');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

// --- (acceptance) rejection cases never touch the registry -----------------

test('resolveProjectPath - rejection cases leave sessions.json untouched', () => {
  const regCtx = makeRegCtx();
  const rows = ['..', 'C:\\Windows', 'notes.txt', 'no-such-project', 42, null];
  for (const project of rows) {
    const { spawner } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner, ...regCtx }, project);
    assert.equal(result.ok, false, `project: ${project}`);
  }
  assert.equal(fs.existsSync(regCtx.registryPath), false);
});

// --- 6.6 HTTP level ----------------------------------------------------------

test('HTTP - POST /api/sessions launches and returns the flat SessionView body', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const fixedNow = Date.parse('2026-08-25T21:14:03.123Z');
  const regCtx = makeRegCtx({ now: () => fixedNow });
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.deepEqual(body, {
      session_name: 'pull-requests',
      project: 'Pull Requests',
      path: path.join(base, 'Pull Requests'),
      status: 'starting',
      started_at: new Date(fixedNow).toISOString(),
      pid: null,
    });
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - 202 has JSON content-type', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  } finally {
    server.close();
  }
});

test('HTTP - 202 has Cache-Control: no-store', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('HTTP - body not JSON at all -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body a valid-JSON string (not object) -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('just a string'),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body [] -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body over 8 KB -> 413 payload_too_large, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const bigBody = JSON.stringify({ project: 'x'.repeat(9 * 1024) });
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.deepEqual(body, { error: 'payload_too_large' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions -> 200 { sessions: [] } with an empty registry', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, { sessions: [] });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions after a launch -> one entry, exactly the SessionView keys', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    const res = await authedFetch(regCtx, `${origin}/api/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(
      Object.keys(body.sessions[0]).sort(),
      ['path', 'pid', 'project', 'session_name', 'started_at', 'status'].sort(),
    );
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions/ (trailing slash) -> 404 not_found', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - DELETE /api/sessions -> 404 not_found (no kill surface in M7)', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/ (trailing slash) -> 404 not_found, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/nope -> 404 not_found', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/projects still 200 with fixture names (survives async rewrite)', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.projects.map((p) => p.name);
    assert.ok(names.includes('Pull Requests'));
    assert.ok(names.includes('Video Editing'));
    assert.ok(names.includes('email-lint'));
  } finally {
    server.close();
  }
});

// --- (acceptance) reuse: tapping the same project twice must not double-spawn --

test('HTTP - two POSTs, no pid file ever written, ctx.now fixed -> spawn stays at 1', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const fixedNow = Date.now();
  const regCtx = makeRegCtx({ now: () => fixedNow });
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const req = () => authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    const res1 = await req();
    const res2 = await req();
    assert.equal(res1.status, 202);
    assert.equal(res2.status, 200);
    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.equal(body1.started_at, body2.started_at);
    assert.equal(body2.status, 'starting');
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - two POSTs, ctx.now advanced past STARTING_GRACE_MS -> spawns again', async () => {
  const { spawner, calls } = makeFakeSpawner();
  let currentTime = Date.now();
  const regCtx = makeRegCtx({ now: () => currentTime });
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const req = () => authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    const res1 = await req();
    assert.equal(res1.status, 202);
    currentTime += STARTING_GRACE_MS + 1000;
    const res2 = await req();
    assert.equal(res2.status, 202);
    assert.equal(calls.length, 2);

    // Regression guard for findLiveSession excluding `failed` and
    // recordLaunch replacing same-name entries: if either broke, this would
    // hold two entries for 'email-lint' instead of one.
    const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
    const matching = onDisk.sessions.filter((s) => s.session_name === 'email-lint');
    assert.equal(matching.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - pid file written between two POSTs, pid alive -> reuse, running, pid echoed', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const livePids = new Set([555]);
  const regCtx = makeRegCtx({ isPidAlive: (pid) => livePids.has(pid) });
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const req = () => authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    const res1 = await req();
    assert.equal(res1.status, 202);

    fs.mkdirSync(regCtx.pidDir, { recursive: true });
    fs.writeFileSync(path.join(regCtx.pidDir, 'email-lint.pid'), '555', 'ascii');

    const res2 = await req();
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.status, 'running');
    assert.equal(body2.pid, 555);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - pid file written between two POSTs, pid dead -> spawns again', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const livePids = new Set(); // nothing alive
  const regCtx = makeRegCtx({ isPidAlive: (pid) => livePids.has(pid) });
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const req = () => authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    const res1 = await req();
    assert.equal(res1.status, 202);

    fs.mkdirSync(regCtx.pidDir, { recursive: true });
    fs.writeFileSync(path.join(regCtx.pidDir, 'email-lint.pid'), '999', 'ascii');

    const res2 = await req();
    assert.equal(res2.status, 202);
    assert.equal(calls.length, 2);
  } finally {
    server.close();
  }
});

test('HTTP - a stale pid file is deleted before the spawn, not inherited', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  const pidFilePath = path.join(regCtx.pidDir, 'email-lint.pid');
  fs.writeFileSync(pidFilePath, '77777', 'ascii');

  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res1 = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    assert.equal(res1.status, 202);
    assert.equal(fs.existsSync(pidFilePath), false);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - a corrupt sessions.json does not break the endpoints', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  fs.mkdirSync(path.dirname(regCtx.registryPath), { recursive: true });
  fs.writeFileSync(regCtx.registryPath, '{"sessions": [{"sess', 'utf8');

  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const getRes = await authedFetch(regCtx, `${origin}/api/sessions`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), { sessions: [] });

    const postRes = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(postRes.status, 202);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

// --- 6.7 Recipe-integrity test ----------------------------------------------

test('recipe-integrity - launch-session.ps1 preserves the proven launch recipe', () => {
  const script = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1'),
    'utf8',
  );
  assert.ok(script.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(script.includes('.claude-max'));
  assert.ok(script.includes('--channels'));
  assert.ok(script.includes('plugin:whatsapp-claude-channel@whatsapp-claude-plugin'));
  assert.ok(script.includes('--remote-control'));
  assert.ok(script.includes('Activate.ps1'));
  assert.ok(script.includes('Start-Process'));
  assert.ok(script.includes('-LiteralPath'));
  assert.ok(script.includes('-PassThru'));
  assert.ok(script.includes('$PidFile'));
  assert.ok(!/--rc/.test(script));
});

// --- Regression tests for the T29 review BLOCK ------------------------------
// The pid directory was never created by production code; only tests created
// it, so 98 green tests passed while the mechanism could never work. These two
// deliberately do NOT pre-create it.

test('launchSession CREATES the pid directory itself - production must not rely on tests making it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-nopiddir-'));
  perTestDirs.push(dir);
  const ctx = {
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'session-pids'),
    isPidAlive: () => false,
    now: () => Date.now(),
  };

  assert.equal(fs.existsSync(ctx.pidDir), false, 'precondition: pid dir must NOT exist yet');

  const { spawner, calls } = makeFakeSpawner();
  const r = launchSession({ baseDir: base, spawner, ...ctx }, 'email-lint');

  assert.equal(r.ok, true);
  assert.equal(
    fs.existsSync(ctx.pidDir),
    true,
    'launchSession must create the pid dir - without it Set-Content fails with '
    + 'DirectoryNotFoundException, the catch{} swallows it, and every session '
    + 'is pruned after the grace window so the next tap spawns a duplicate',
  );

  // and the -PidFile argument must point inside that directory
  const args = calls[0].args;
  const pidArg = args[args.indexOf('-PidFile') + 1];
  assert.equal(path.dirname(path.resolve(pidArg)), path.resolve(ctx.pidDir));
});

test('launchSession still succeeds when the pid dir cannot be created - fails toward a duplicate, never a blocked launch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-badpiddir-'));
  perTestDirs.push(dir);
  // A FILE where the directory should be: mkdirSync will throw, and the guard
  // must swallow it rather than failing the launch.
  const pidDir = path.join(dir, 'session-pids');
  fs.writeFileSync(pidDir, 'not a directory');

  const { spawner, calls } = makeFakeSpawner();
  const r = launchSession({
    baseDir: base,
    spawner,
    registryPath: path.join(dir, 'sessions.json'),
    pidDir,
    isPidAlive: () => false,
    now: () => Date.now(),
  }, 'email-lint');

  assert.equal(r.ok, true, 'a broken pid dir must NOT block the launch');
  assert.equal(calls.length, 1, 'the spawn must still happen');
});
