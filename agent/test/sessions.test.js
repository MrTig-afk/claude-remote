import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { deriveSessionName, resolveProjectPath, launchSession, endSession } from '../sessions.js';
import {
  STARTING_GRACE_MS, recordLaunch, REGISTRY_VERSION, listSessions,
} from '../registry.js';
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

// A kill seam that behaves like the real taskkill from endSession's point of
// view: the pid it is asked to kill is reported alive right up until this
// spawner is actually called, then dead - the same order endSession itself
// checks in (findLiveSession, THEN the kill, THEN the poll).
function makeKillingSpawner(trackedPid) {
  const calls = [];
  let alive = true;
  function spawner(file, args, options) {
    const child = {
      pid: 5555,
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; return this; },
    };
    calls.push({ file, args, options, child });
    alive = false;
    return child;
  }
  return { spawner, calls, isPidAlive: (pid) => pid === trackedPid && alive };
}

// Seeds a `running` registry entry directly (recordLaunch + a pid file),
// bypassing launchSession entirely - endSession never launches anything.
function makeRunningEntry(regCtx, project, pid) {
  const projectPath = path.resolve(base, project);
  const sessionName = deriveSessionName(projectPath);
  recordLaunch(regCtx, { sessionName, project, projectPath });
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(regCtx.pidDir, `${sessionName}.pid`), String(pid), 'ascii');
  return { sessionName, projectPath };
}

// Seeds a `handoff` registry entry directly - this state is never reached
// through recordLaunch, so it is written raw, the same way registry.test.js
// seeds non-default states.
function seedHandoffEntry(regCtx, project, handoffStartedAt = new Date().toISOString()) {
  const projectPath = path.resolve(base, project);
  const sessionName = deriveSessionName(projectPath);
  const sessions = [{
    session_name: sessionName,
    project,
    original_path: projectPath,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'handoff',
    handoff_started_at: handoffStartedAt,
  }];
  fs.mkdirSync(path.dirname(regCtx.registryPath), { recursive: true });
  fs.writeFileSync(regCtx.registryPath, JSON.stringify({ version: REGISTRY_VERSION, sessions }), 'utf8');
  return sessionName;
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
  // The plugin is `whatsapp-channel`; the MARKETPLACE is
  // `whatsapp-claude-plugin`. An earlier release was `whatsapp-claude-channel`
  // and that name silently resolves to "plugin not installed" - the channel is
  // allowlisted, then fails to load, so outbound tools keep working while
  // inbound messages never arrive. Asserting the whole `--channels=<value>`
  // token, not just the flag, is what stops the stale name coming back.
  assert.ok(script.includes('--channels=plugin:whatsapp-channel@whatsapp-claude-plugin'));
  assert.ok(
    !script.includes('whatsapp-claude-channel'),
    'the pre-rename plugin name must not return',
  );
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

// --- POST /api/sessions/end - the gate, validation and Lane D1 -------------

test('HTTP - POST /api/sessions/end with no token -> 401, the route sits below the gate', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end unknown project -> 404 project_not_found', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'no-such-project' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'project_not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end with a traversing project -> 400 invalid_project', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '../evil' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_project' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end with project missing -> 400 invalid_request', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_request' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end malformed-body table (not JSON / array / over 8KB)', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const notJson = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert.equal(notJson.status, 400);
    assert.deepEqual(await notJson.json(), { error: 'invalid_request' });

    const arrayBody = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    assert.equal(arrayBody.status, 400);
    assert.deepEqual(await arrayBody.json(), { error: 'invalid_request' });

    const bigBody = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'x'.repeat(9 * 1024) }),
    });
    assert.equal(bigBody.status, 413);
    assert.deepEqual(await bigBody.json(), { error: 'payload_too_large' });
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions/end -> 404 not_found', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end/ (trailing slash) -> 404 not_found', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end with no live session -> 200 already_ended, nothing left in the registry', async () => {
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      result: 'already_ended',
      project: 'Pull Requests',
      session_name: 'pull-requests',
    });
    assert.equal(fs.existsSync(regCtx.registryPath), false);
  } finally {
    server.close();
  }
});

// --- POST /api/sessions/end - the kill and the handoff spawn ----------------

test('HTTP - POST /api/sessions/end on a running session: exact taskkill argv and options', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7777);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests', 7777);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 200);
    assert.equal(killer.calls.length, 1);
    assert.equal(killer.calls[0].file, 'taskkill');
    assert.deepEqual(killer.calls[0].args, ['/PID', '7777', '/T', '/F']);
    assert.deepEqual(killer.calls[0].options, { stdio: 'ignore', windowsHide: true });
    assert.ok(!killer.calls[0].args.some((a) => a.includes(' ')));
  } finally {
    // server.js never awaits endSession's handoff promise, so its internal
    // timer is still armed; settle it the same way the runner exiting would,
    // or this test leaves a real 10-minute timer running.
    handoffCalls[0].child.handlers.exit();
    server.close();
  }
});

test('HTTP - POST /api/sessions/end on a running session: response, pid file, registry state, handoff spawn count', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7778);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 7778);
  const pidFilePath = path.join(regCtx.pidDir, `${sessionName}.pid`);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      result: 'handoff_started',
      project: 'Pull Requests',
      session_name: sessionName,
    });

    assert.equal(fs.existsSync(pidFilePath), false);

    const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
    const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
    assert.ok(entry, 'the entry must still exist after the kill, not be pruned');
    assert.equal(entry.status, 'handoff');
    assert.ok(Number.isFinite(Date.parse(entry.handoff_started_at)));

    assert.equal(handoffCalls.length, 1);
  } finally {
    handoffCalls[0].child.handlers.exit();
    server.close();
  }
});

test('HTTP - handoff seam receives the exact recipe argv, cwd and options', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7779);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests', 7779);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(handoffCalls.length, 1);
    const call = handoffCalls[0];
    const HANDOFF_SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'handoff-session.ps1');
    const projectPath = path.join(base, 'Pull Requests');
    assert.equal(call.file, 'powershell.exe');
    assert.deepEqual(call.args, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', HANDOFF_SCRIPT,
      '-ProjectPath', projectPath,
    ]);
    assert.deepEqual(call.options, { stdio: 'ignore', windowsHide: true, cwd: projectPath });
  } finally {
    handoffCalls[0].child.handlers.exit();
    server.close();
  }
});

test('HTTP - POST /api/sessions/end when the pid survives the kill -> kill_failed, no handoff, session still running', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, killPollIntervalMs: 1, pidImageName: () => 'cmd.exe' });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 8888);
  const pidFilePath = path.join(regCtx.pidDir, `${sessionName}.pid`);
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      result: 'kill_failed',
      project: 'Pull Requests',
      session_name: sessionName,
    });
    assert.equal(killCalls.length, 1);
    assert.equal(handoffCalls.length, 0);
    assert.equal(fs.existsSync(pidFilePath), true);

    const listRes = await authedFetch(regCtx, `${origin}/api/sessions`);
    const listBody = await listRes.json();
    const entry = listBody.sessions.find((s) => s.session_name === sessionName);
    assert.ok(entry);
    assert.equal(entry.status, 'running');
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end while already in handoff -> 409, kill not called again', async () => {
  const regCtx = makeRegCtx();
  seedHandoffEntry(regCtx, 'Pull Requests');
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const { spawner: handoffSpawner } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'session_not_running' });
    assert.equal(killCalls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end on a starting session (no pid file) -> 409, no seam call', async () => {
  const regCtx = makeRegCtx();
  const projectPath = path.resolve(base, 'Pull Requests');
  const sessionName = deriveSessionName(projectPath);
  recordLaunch(regCtx, { sessionName, project: 'Pull Requests', projectPath });
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const { spawner: handoffSpawner } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner, handoffSpawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'session_not_running' });
    assert.equal(killCalls.length, 0);
  } finally {
    server.close();
  }
});

// --- endSession - F1 (pid reuse) and F2 (concurrent STOP/START) guards -----

test('endSession - pid equals the agent\'s own process.pid -> already_ended, no taskkill, entry dropped entirely', async () => {
  const regCtx = makeRegCtx({ isPidAlive: (pid) => pid === process.pid });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', process.pid);
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, handoffSpawner: makeFakeSpawner().spawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');

  assert.equal(result.ok, true);
  assert.equal(result.body.result, 'already_ended');
  assert.equal(killCalls.length, 0, 'taskkill must never be called against the agent\'s own pid');

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry, undefined, 'the entry must be dropped, not left status-less for listSessions to age into failed');
  assert.equal(listSessions(ctx).find((s) => s.session_name === sessionName), undefined);
});

test('endSession - pid image is not cmd.exe (reused pid) -> already_ended, no taskkill, entry dropped entirely', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, pidImageName: () => 'notepad.exe' });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 9991);
  const pidFilePath = path.join(regCtx.pidDir, `${sessionName}.pid`);
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, handoffSpawner: makeFakeSpawner().spawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');

  assert.equal(result.ok, true);
  assert.equal(result.body.result, 'already_ended');
  assert.equal(killCalls.length, 0, 'taskkill must never run against a pid whose image is not cmd.exe');
  assert.equal(fs.existsSync(pidFilePath), false, 'the stale pid file must be cleared');

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry, undefined, 'the entry must be dropped, not left status-less for listSessions to age into failed');
  assert.equal(listSessions(ctx).find((s) => s.session_name === sessionName), undefined);
});

test('source - defaultPidImageName\'s tasklist call hides its console window and is bounded by a timeout', () => {
  const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'sessions.js'), 'utf8');
  const fn = src.slice(
    src.indexOf('async function defaultPidImageName('),
    src.indexOf(' * Byte-for-byte port'),   // no newline in the marker: a CRLF checkout must not widen the slice
  );
  assert.ok(fn.length > 0 && fn.length < 2000, `slice must be the one function, got ${fn.length} chars`);
  assert.ok(fn.includes("'tasklist'"), 'must still call tasklist');
  assert.ok(
    fn.includes('windowsHide: true'),
    'the tasklist call must hide its console window, like every other child process in the agent',
  );
  assert.ok(
    fn.includes('timeout: 5000'),
    'the tasklist call must have a bounded timeout, or a wedged lookup hangs endSession with the handoff claim already written',
  );
});

test('endSession - two concurrent calls for the same project: exactly one runner spawned, the loser gets 409', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(9992);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests', 9992);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const [r1, r2] = await Promise.all([
    endSession(ctx, 'Pull Requests'),
    endSession(ctx, 'Pull Requests'),
  ]);

  const started = [r1, r2].filter((r) => r.ok && r.body && r.body.result === 'handoff_started');
  const rejected = [r1, r2].filter((r) => !r.ok && r.status === 409);
  assert.equal(started.length, 1, 'exactly one call must win the claim and spawn the runner');
  assert.equal(rejected.length, 1, 'the loser must get 409 session_not_running');
  assert.deepEqual(rejected[0], { ok: false, status: 409, error: 'session_not_running' });
  assert.equal(killer.calls.length, 1, 'taskkill must run exactly once');
  assert.equal(handoffCalls.length, 1, 'exactly one handoff runner must be spawned');

  handoffCalls[0].child.handlers.exit();
  await started[0].handoff;
});

test('endSession - a launch landing during the kill poll returns reused with the handoff entry', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(9993);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests', 9993);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const endPromise = endSession(ctx, 'Pull Requests');

  // The claim (status: 'handoff') is written synchronously before endSession
  // ever awaits, so a launch landing in this window - the exact T45 race the
  // comments in sessions.js worry about - sees it immediately.
  const launchResult = launchSession(ctx, 'Pull Requests');
  assert.equal(launchResult.ok, true);
  assert.equal(launchResult.reused, true);
  assert.equal(launchResult.session.status, 'handoff');

  const result = await endPromise;
  assert.equal(result.body.result, 'handoff_started');
  handoffCalls[0].child.handlers.exit();
  await result.handoff;
});

test('recipe-integrity - handoff-session.ps1 carries the proven handoff recipe', () => {
  const script = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'handoff-session.ps1'),
    'utf8',
  );
  for (const token of [
    'claude.cmd', '-p', '--continue', '/handoff', '--allowedTools', 'Write', 'Edit',
    'CLAUDE_CONFIG_DIR', '.claude-max',
  ]) {
    assert.ok(script.includes(token), `handoff-session.ps1 must include ${token}`);
  }
  assert.ok(!script.includes('--remote-control'));
  assert.ok(!script.includes('--dangerously-skip-permissions'));
  assert.ok(!script.includes('Start-Process'));
});

// --- endSession - the background handoff verdict (unit level) --------------

test('endSession - handoff exit with HANDOFF.md mtime moved -> ended record written/true', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(1111);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName, projectPath } = makeRunningEntry(regCtx, 'Pull Requests', 1111);
  const handoffPath = path.join(projectPath, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, 'old');
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(handoffPath, oldTime, oldTime);

  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');
  assert.equal(result.body.result, 'handoff_started');

  fs.writeFileSync(handoffPath, 'new');
  const newTime = new Date();
  fs.utimesSync(handoffPath, newTime, newTime);
  handoffCalls[0].child.handlers.exit();

  const verdict = await result.handoff;
  assert.deepEqual(verdict, { handoff_ok: true, handoff_result: 'written' });

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry.status, 'ended');
  assert.equal(entry.handoff_ok, true);
  assert.equal(entry.handoff_result, 'written');
  assert.ok(Number.isFinite(Date.parse(entry.ended_at)));
});

test('endSession - handoff exits 0 with mtime unchanged -> ended record not_written/false (exit code not consulted)', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(1112);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  // A project folder of its own, not 'Pull Requests' - other tests in this
  // file write a HANDOFF.md into that shared fixture folder, and this test
  // needs to control the file's presence itself.
  const { sessionName, projectPath } = makeRunningEntry(regCtx, 'Video Editing', 1112);
  const handoffPath = path.join(projectPath, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, 'unchanged');
  const fixedTime = new Date(Date.now() - 60_000);
  fs.utimesSync(handoffPath, fixedTime, fixedTime);

  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const result = await endSession(ctx, 'Video Editing');
  // Fire with an explicit exit code argument - the implementation must not
  // read it at all.
  handoffCalls[0].child.handlers.exit(0);

  const verdict = await result.handoff;
  assert.deepEqual(verdict, { handoff_ok: false, handoff_result: 'not_written' });

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry.handoff_ok, false);
  assert.equal(entry.handoff_result, 'not_written');
});

test('endSession - HANDOFF.md absent before, present after -> written/true', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(1113);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  // A third project folder of its own, same reason as the test above.
  const { projectPath } = makeRunningEntry(regCtx, 'email-lint', 1113);
  const handoffPath = path.join(projectPath, 'HANDOFF.md');
  assert.equal(fs.existsSync(handoffPath), false);

  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const result = await endSession(ctx, 'email-lint');
  fs.writeFileSync(handoffPath, 'brand new');
  handoffCalls[0].child.handlers.exit();

  const verdict = await result.handoff;
  assert.deepEqual(verdict, { handoff_ok: true, handoff_result: 'written' });
});

test('endSession - handoff timeout kills the runner via the same kill seam and records timeout', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(2222);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 2222);
  const { spawner: handoffSpawner } = makeFakeSpawner(); // never fires exit/error
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, handoffTimeoutMs: 10, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');
  const verdict = await result.handoff;

  assert.deepEqual(verdict, { handoff_ok: false, handoff_result: 'timeout' });
  assert.equal(killer.calls.length, 2);
  assert.equal(killer.calls[1].file, 'taskkill');
  assert.deepEqual(killer.calls[1].args, ['/PID', '4242', '/T', '/F']);

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry.status, 'ended');
  assert.equal(entry.handoff_result, 'timeout');
  assert.equal(entry.handoff_ok, false);
});

test('endSession - handoff spawn error -> ended record spawn_failed/false', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(3333);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 3333);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');
  handoffCalls[0].child.handlers.error(new Error('boom'));
  const verdict = await result.handoff;

  assert.deepEqual(verdict, { handoff_ok: false, handoff_result: 'spawn_failed' });
  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.equal(entry.handoff_result, 'spawn_failed');
});

test('endSession - a relaunch during the in-flight handoff is not overwritten when the run finishes', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(4444);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName, projectPath } = makeRunningEntry(regCtx, 'Pull Requests', 4444);
  const { spawner: handoffSpawner, calls: handoffCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner: killer.spawner, handoffSpawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');
  assert.equal(result.body.result, 'handoff_started');

  // The owner relaunches the same project from the phone while the handoff
  // is still running - recordLaunch replaces the entry with a fresh one.
  recordLaunch(regCtx, { sessionName, project: 'Pull Requests', projectPath });

  handoffCalls[0].child.handlers.exit();
  await result.handoff;

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
  assert.notEqual(entry.status, 'ended');
  assert.equal(entry.status, undefined);
});

// --- helper-auth.js's refusal property, exercised through the real route ---

test('HTTP - POST /api/sessions/end with no killSpawner in the fixture ctx -> 500, never touches a real process', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, pidImageName: () => 'cmd.exe' });
  makeRunningEntry(regCtx, 'Pull Requests', 6666);
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end with no handoffSpawner in the fixture ctx -> 500 after a real-shaped kill', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(6667);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests', 6667);
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  } finally {
    server.close();
  }
});

// --- POST /api/sessions/dismiss - the phone drops an announced ended record --

test('HTTP - POST /api/sessions/dismiss drops an ended record, leaves others', async () => {
  const regCtx = makeRegCtx();
  fs.mkdirSync(path.dirname(regCtx.registryPath), { recursive: true });
  const now = Date.now();
  const ended = {
    session_name: 'pullrequests',
    project: 'Pull Requests',
    original_path: path.join(base, 'Pull Requests'),
    started_at: new Date(now - 60_000).toISOString(),
    status: 'ended',
    ended_at: new Date(now - 1000).toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  };
  const handoff = { ...ended, session_name: 'email-lint', project: 'email-lint', original_path: path.join(base, 'email-lint'), status: 'handoff', handoff_started_at: ended.ended_at };
  fs.writeFileSync(regCtx.registryPath, JSON.stringify({ version: REGISTRY_VERSION, sessions: [ended, handoff] }));
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await authedFetch(regCtx, `${origin}/api/sessions/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    // A dismiss never touches a session that is still writing its handoff.
    const notEnded = await authedFetch(regCtx, `${origin}/api/sessions/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_name: 'email-lint' }),
    });
    assert.equal(notEnded.status, 204);

    const res = await authedFetch(regCtx, `${origin}/api/sessions/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_name: 'pullrequests' }),
    });
    assert.equal(res.status, 204);

    const left = (await (await authedFetch(regCtx, `${origin}/api/sessions`)).json()).sessions;
    assert.deepEqual(left.map((s) => [s.session_name, s.status]), [['email-lint', 'handoff']]);
  } finally {
    server.close();
  }
});
