import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  deriveSessionName, resolveProjectPath, launchSession, endSession, rootSlug, sessionNameFor, remoteControlName,
  MAX_PROJECT_SEGMENTS,
} from '../sessions.js';
import {
  STARTING_GRACE_MS, recordLaunch, REGISTRY_VERSION, listSessions, pidFileNameFor,
  deriveDeskSessionName,
} from '../registry.js';
// The heuristic itself, so the regression tests below can state their
// precondition instead of asserting it by proxy.
import { containerChildrenOf } from '../projects.js';
import { seedPasscode, issueTestToken, authHeaders, fixtureServer, testSessionDirs } from './helper-auth.js';
import { nameUnder } from './helper-names.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-sessions-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, '-weird'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

// T68 fixtures - container-folder nesting. The notes.md line is
// load-bearing, without it email-lint becomes all-directories-no-files and
// would classify as a container itself, making 'email-lint/sub' legal.
fs.mkdirSync(path.join(base, 'Pull Requests', 'Vercel'), { recursive: true });
fs.mkdirSync(path.join(base, 'Vercel'));                           // the collision partner
fs.mkdirSync(path.join(base, 'email-lint', 'sub'));                // ordinary project WITH a subfolder
fs.writeFileSync(path.join(base, 'email-lint', 'notes.md'), 'x');  // ...the file that keeps it a project
// A FILE-FREE folder inside a container. listProjects does not classify a
// container's children at all - it pushes them straight from
// containerChildrenOf - so the PWA draws this as an ordinary launchable
// project. containerChildrenOf(Nested) would nonetheless call it a container,
// which is exactly the divergence the launch guard must not reintroduce.
fs.mkdirSync(path.join(base, 'Pull Requests', 'Nested', 'inner'), { recursive: true });

// Rooted session names, computed once - `base` is a random mkdtemp path, so
// the root slug can never be a literal (see helper-names.js). Every child
// segment IS a literal the test author writes.
const PULL_REQUESTS = nameUnder(base, 'pull-requests');
const VIDEO_EDITING = nameUnder(base, 'video-editing');
const EMAIL_LINT = nameUnder(base, 'email-lint');
const VERCEL = nameUnder(base, 'vercel');
const PULL_REQUESTS_VERCEL = nameUnder(base, 'pull-requests', 'vercel');
// The launcher '-SessionName' argument collapses EVERY '/' to '.' - every
// rooted name now carries at least one '/' (the root prefix), so this
// collapse is exercised even for a depth-1 project, unlike before T95.
// What -SessionName carries: the Code-tab ROW name, which is the folder leaf.
// It was the derived session name collapsed on '/' until 2026-09-04, when the
// owner opened a session and found the row reading
// `f-dev-projects-workspace-8a320b.email-lint` - a label the hand-off banner was
// telling him to look for and which does not exist.
const argForm = (sessionName) => sessionName.replace(/\//g, '.');

// A SECOND root, for the T95 multi-root acceptance tests (AT-12/14/15/19).
// Its 'Vercel' shares a name with `base`'s own top-level 'Vercel' (the
// fixture behind the VERCEL constant above) deliberately - that is exactly
// the B2 shape the legacy (unprefixed) form must refuse as ambiguous, and
// the root-qualified form must still resolve.
const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-sessions2-'));
fs.mkdirSync(path.join(base2, 'Vercel'));
const TWO_ROOTS = [
  { path: base, mode: 'container', excludes: [], new_folders: 'show' },
  { path: base2, mode: 'container', excludes: [], new_folders: 'show' },
];
const VERCEL2 = nameUnder(base2, 'vercel');

// Every makeRegCtx() call creates a temp dir; without tracking them the
// suite leaked one per test (92 across a full run, measured 2026-08-25).
const perTestDirs = [];

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(base2, { recursive: true, force: true });
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
    sessionDirs: testSessionDirs(dir),
    isPidAlive: () => false,
    now: () => Date.now(),
    passcodePath: path.join(dir, 'passcode.json'),
    attemptsPath: path.join(dir, 'passcode-attempts.json'),
    configPath: path.join(dir, 'config.json'),
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
  const sessionName = deriveSessionName(projectPath, base);
  recordLaunch(regCtx, { sessionName, project, projectPath });
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(regCtx.pidDir, pidFileNameFor(sessionName)), String(pid), 'ascii');
  return { sessionName, projectPath };
}

// Writes a Claude Code 2.1.246 profile sessions file - <pid>.json under
// regCtx.sessionDirs[0] - the desk-session discovery fixture.
function writeDeskSessionFile(regCtx, { pid, sessionId, cwd, startedAt = new Date().toISOString(), kind = 'interactive' }) {
  const dir = regCtx.sessionDirs[0];
  fs.mkdirSync(dir, { recursive: true });
  const data = { pid, cwd, startedAt, kind, entrypoint: 'cli', status: 'idle', updatedAt: startedAt };
  if (sessionId !== undefined) data.sessionId = sessionId;
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(data), 'utf8');
}

// Seeds a `handoff` registry entry directly - this state is never reached
// through recordLaunch, so it is written raw, the same way registry.test.js
// seeds non-default states.
function seedHandoffEntry(regCtx, project, endingStartedAt = new Date().toISOString()) {
  const projectPath = path.resolve(base, project);
  const sessionName = deriveSessionName(projectPath, base);
  const sessions = [{
    session_name: sessionName,
    project,
    original_path: projectPath,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'ending',
    ending_started_at: endingStartedAt,
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
    ['F:\\Dev\\Projects\\Workspace\\Pull Requests', 'pull-requests'],
    ['F:\\Dev\\Projects\\Workspace\\email-lint', 'email-lint'],
    ['Backend Engineering', 'backend-engineering'],
    ['My.Project', 'my-project'],
    ['A  B', 'a-b'],
    ['Foo. .Bar', 'foo-bar'],
    ['Reactive-Resume', 'reactive-resume'],
    ['F:\\Dev\\Projects\\Workspace\\Video Editing\\', 'video-editing'],
  ];
  for (const [input, expected] of rows) {
    assert.equal(deriveSessionName(input), expected, `input: ${input}`);
  }
});

// --- T68: nested project naming and rejection -------------------------------

test('deriveSessionName - nested name carries the root AND the parent', () => {
  assert.equal(
    deriveSessionName(path.join(base, 'Pull Requests', 'Vercel'), base),
    PULL_REQUESTS_VERCEL,
  );
});

test('deriveSessionName - nested and top-level of the same leaf differ', () => {
  const nested = deriveSessionName(path.join(base, 'Pull Requests', 'Vercel'), base);
  const topLevel = deriveSessionName(path.join(base, 'Vercel'), base);
  assert.notEqual(nested, topLevel);
  assert.equal(topLevel, VERCEL);
});

test('deriveSessionName - the one-argument form is opt-in and unchanged', () => {
  assert.equal(deriveSessionName(path.join(base, 'Pull Requests', 'Vercel')), 'vercel');
});

// Owner decision 1, 2026-08-29: the root prefix is ALWAYS present and every
// segment between root and target is carried, at every depth - there is no
// longer a depth where the two-argument form falls back to the basename.
// This SUPERSEDES the pre-T95 "depth 3 falls back to basename" behaviour;
// deriveDeskSessionName (registry.js) already joined every segment, so the
// two now agree everywhere (see the invariant test below).
test('deriveSessionName - depth 1 and depth 3+ both carry the root and every segment', () => {
  assert.equal(deriveSessionName(path.join(base, 'email-lint'), base), EMAIL_LINT);
  assert.equal(
    deriveSessionName(path.join(base, 'Pull Requests', 'Vercel', 'deep'), base),
    nameUnder(base, 'pull-requests', 'vercel', 'deep'),
  );
});

test('deriveSessionName - a path outside baseDir never produces a nested name', () => {
  assert.equal(deriveSessionName('C:\\Windows\\System32', base), 'system32');
});

test('resolveProjectPath - accepts the two-segment identifier', () => {
  const result = resolveProjectPath([{ path: base, mode: 'container', excludes: [], new_folders: 'show' }], 'Pull Requests/Vercel');
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(base, 'Pull Requests', 'Vercel'));
});

test('deriveSessionName - the separator is unforgeable (a "-" join cannot be mistaken for it)', () => {
  assert.equal(deriveSessionName('Pull Requests-Vercel'), 'pull-requests-vercel');
  assert.notEqual(deriveSessionName('Pull Requests-Vercel'), 'pull-requests/vercel');
});

test('resolveProjectPath - nested rejection table', () => {
  const rows = [
    ['Pull Requests/..', 'invalid_project'],
    ['Pull Requests/../../Windows', 'invalid_project'],
    ['Pull Requests/Vercel/deep', 'invalid_project'],
    ['Pull Requests//Vercel', 'invalid_project'],
    ['Pull Requests/', 'invalid_project'],
    ['/Vercel', 'invalid_project'],
    ['Pull Requests/.', 'invalid_project'],
    ['Pull Requests/.hidden', 'invalid_project'],
    ['Pull Requests/C:\\Windows', 'invalid_project'],
    ['Pull Requests/\\\\server\\share', 'invalid_project'],
    ['Pull Requests/sub\\dir', 'invalid_project'],
    ['Pull Requests\\Vercel', 'invalid_project'],
    ['Pull Requests/%2e%2e', 'invalid_project'],
    ['Pull Requests/nope', 'invalid_project'],
    ['email-lint/sub', 'invalid_project'],
    ['Video Editing/anything', 'invalid_project'],
    ['notes.txt/x', 'invalid_project'],
    [`${'P'.repeat(200)}/${'V'.repeat(60)}`, 'invalid_request'],
  ];
  for (const [project, expectedError] of rows) {
    const { spawner, calls } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, project);
    assert.equal(result.ok, false, `project: ${project}`);
    assert.equal(result.error, expectedError, `project: ${project}`);
    assert.equal(calls.length, 0, `project: ${project}`);
  }
});

test('resolveProjectPath - a nested name slugging to "-" is refused, as it is at the top level', () => {
  // F16-C05. The nested check used a denylist ([\s.]+) while the session name
  // is built with slugSegment, so `Work/项目` passed and slugged to '-', and a
  // sibling `Work/工作` got the same session name. Its own root, so the shared
  // fixtures' child counts are untouched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-cjk-'));
  fs.mkdirSync(path.join(root, 'Work', '项目'), { recursive: true });
  const ok = ['ok-one', '_scratch', '(old) api', '#2'];
  for (const n of ok) fs.mkdirSync(path.join(root, 'Work', n));
  const { spawner, calls } = makeFakeSpawner();
  const ctx = { baseDir: root, spawner, ...makeRegCtx() };
  const bad = launchSession(ctx, 'Work/项目');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_project');
  assert.equal(calls.length, 0);
  // F16-D2-C02: a leading non-alphanumeric that is not a dot, dash or space
  // still names a real session - refusing it strands a running one's STOP.
  for (const n of ok) assert.equal(launchSession(ctx, `Work/${n}`).ok, true, `Work/${n} must still launch`);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- T70: the routes, end to end - nested-target pins ----------------------
// These sit here, above 'endSession - handoff exit with HANDOFF.md mtime
// moved -> ended record written/true', because that test writes a HANDOFF.md
// into the shared 'Pull Requests' fixture and never removes it. A FILE in
// that folder turns it into a NON-container for every test after that point
// (containerChildrenOf returns null once it sees a non-directory dirent - see
// projects.js), so a later test naming 'Pull Requests/Vercel' would fail with
// invalid_project for a reason that has nothing to do with what it asserts.
// T68's own nested tests above sit here for the same reason. TWO tests leak
// into that fixture, not one - 'endSession - desk session: claim/kill/handoff
// argv gets -SessionId, discovery stops seeing it, ended banner after exit'
// writes a HANDOFF.md there as well, twice, also without cleanup. A sweep
// that gives only the first a `finally` moves this boundary down rather than
// removing it; both need one before these tests can move freely. The junction
// test below ('resolveProjectPath - a
// junction child of a container cannot be named') used to leak a symlink into
// the same fixture with the same effect - it no longer does, its `finally`
// removes the link.

test('launchSession - nested identifier: exact args array, and the registry key keeps its slash', () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  // claudeConfigDir null for the same reason the flat exact-args test pins it:
  // an unpinned ctx reads the REAL config, so this argv would depend on whether
  // the machine running the suite has a profile configured (T56).
  const r = launchSession({ baseDir: base, spawner, claudeConfigDir: null, ...regCtx }, 'Pull Requests/Vercel');
  const LAUNCH_SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1');
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', path.join(base, 'Pull Requests', 'Vercel'),
    // The Code-tab row name. This fixture has BOTH 'Pull Requests/Vercel' and a
    // top-level 'Vercel' - the collision partner two lines from the mkdir - so
    // the leaf alone would put two identical rows in the Code tab.
    '-SessionName', 'Vercel (Pull Requests)',
    '-PidFile', path.join(regCtx.pidDir, pidFileNameFor(PULL_REQUESTS_VERCEL)),
  ]);
  // The registry key must NOT change - this is the pin that a future
  // mutation of the launcher-argument collapse cannot also change the key.
  assert.equal(r.session.session_name, PULL_REQUESTS_VERCEL);
});

test('HTTP - POST /api/sessions with a nested identifier -> 202', async () => {
  const { spawner } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests/Vercel' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.session_name, PULL_REQUESTS_VERCEL);
    assert.equal(body.project, 'Pull Requests/Vercel');
    assert.equal(body.path, path.join(base, 'Pull Requests', 'Vercel'));
    assert.equal(body.status, 'starting');
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions renders a nested running session exactly once', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true });
  const { sessionName, projectPath } = makeRunningEntry(regCtx, 'Pull Requests/Vercel', 7801);
  writeDeskSessionFile(regCtx, { pid: 9001, sessionId: 'nested-conv-1', cwd: projectPath });
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // The desk record must be deduped by `claimed`, not emitted as a second tile.
    assert.equal(body.sessions.length, 1);
    const s = body.sessions[0];
    assert.equal(s.session_name, sessionName);
    assert.equal(s.session_name, PULL_REQUESTS_VERCEL);
    assert.equal(s.project, 'Pull Requests/Vercel');
    assert.equal(s.path, projectPath);
    assert.equal(s.status, 'running');
    assert.equal(s.pid, 7801);
    assert.equal(s.source, 'launched');
    assert.equal(s.activity, 'idle');
    assert.ok(Number.isFinite(Date.parse(s.started_at)));
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end ends a nested LAUNCHED session by project', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7802);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Pull Requests/Vercel', 7802);
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests/Vercel' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      result: 'ended', project: 'Pull Requests/Vercel', session_name: PULL_REQUESTS_VERCEL,
    });
    assert.deepEqual(killer.calls[0].args, ['/PID', '7802', '/T', '/F']);
    // Proves the clear path also routes through pidFileNameFor.
    assert.equal(fs.existsSync(path.join(regCtx.pidDir, pidFileNameFor(PULL_REQUESTS_VERCEL))), false);
  } finally {
    server.close();
  }
});

test('endSession - a nested DESK session can now be ended by project (newly reachable since T68)', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7803);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'claude.exe';
  const projectPath = path.join(base, 'Pull Requests', 'Vercel');
  writeDeskSessionFile(regCtx, { pid: 7803, sessionId: 'nested-desk-1', cwd: projectPath });
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests/Vercel');

  // `project` is the client identifier here, not the basename - endSession's
  // project branch forwards `target` verbatim to endResolvedSession. Assert
  // what the code does, do not "correct" it.
  assert.deepEqual(result.body, {
    result: 'ended', project: 'Pull Requests/Vercel', session_name: PULL_REQUESTS_VERCEL,
  });
  assert.deepEqual(killer.calls[0].args, ['/PID', '7803', '/T', '/F']);
  // -SessionId and -ProjectPath were the handoff runner's arguments, and the
  // whole reason the conversation id was resolved before the kill. With the
  // handoff gone there is no second process: the kill above and the resolved
  // session_name in the body are the entire contract.
});

test('HTTP - POST /api/sessions/dismiss drops a NESTED ended record', async () => {
  const regCtx = makeRegCtx();
  fs.mkdirSync(path.dirname(regCtx.registryPath), { recursive: true });
  const now = Date.now();
  const ended = {
    session_name: PULL_REQUESTS_VERCEL,
    project: 'Pull Requests/Vercel',
    original_path: path.join(base, 'Pull Requests', 'Vercel'),
    started_at: new Date(now - 60_000).toISOString(),
    status: 'ended',
    ended_at: new Date(now - 1000).toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  };
  fs.writeFileSync(regCtx.registryPath, JSON.stringify({ version: REGISTRY_VERSION, sessions: [ended] }));
  const server = fixtureServer({ baseDir: base, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // The nested ended record must survive the prune and be listed.
    const before = (await (await authedFetch(regCtx, `${origin}/api/sessions`)).json()).sessions;
    assert.deepEqual(before.map((s) => [s.session_name, s.status]), [[PULL_REQUESTS_VERCEL, 'ended']]);

    const res = await authedFetch(regCtx, `${origin}/api/sessions/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_name: PULL_REQUESTS_VERCEL }),
    });
    assert.equal(res.status, 204);

    const after = (await (await authedFetch(regCtx, `${origin}/api/sessions`)).json()).sessions;
    assert.deepEqual(after, []);
  } finally {
    server.close();
  }
});

test('resolveProjectPath - a junction child of a container cannot be named', (t) => {
  const linkPath = path.join(base, 'Pull Requests', 'linked');
  try {
    fs.symlinkSync(os.tmpdir(), linkPath, 'junction');
  } catch {
    t.skip('junction creation not permitted');
    return;
  }
  // finally, because leaving this link behind turns 'Pull Requests' into a
  // NON-container for every test after it in this file - containerChildrenOf
  // sees a non-directory dirent and returns null - so a later nested test
  // fails 400 for a reason that has nothing to do with what it asserts. That
  // trap cost T70 an investigation; it is a leaked fixture, not a deliberate
  // one. Assertions unchanged.
  try {
    const { spawner, calls } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests/linked');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_project');
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
});

// The gap the other two junction tests left: one covers a junction CHILD of a
// container, one a junction as a FLAT project, but nothing covered a junction as the
// PARENT of a nested identifier - and that was a real escape. containerChildrenOf
// does a readdirSync that follows the reparse point and lists the TARGET's
// children, so 'Link/Secret' resolved ok with a realpath outside the base dir.
test('resolveProjectPath - a junction PARENT cannot be traversed out of the base dir', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-outside-'));
  fs.mkdirSync(path.join(outside, 'Secret'));
  const linkPath = path.join(base, 'Linked Container');
  try {
    fs.symlinkSync(outside, linkPath, 'junction');
  } catch {
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip('junction creation not permitted');
    return;
  }
  try {
    const { spawner, calls } = makeFakeSpawner();
    const result = launchSession(
      { baseDir: base, spawner, ...makeRegCtx() },
      'Linked Container/Secret',
    );
    assert.equal(result.ok, false, 'a junction parent must never resolve');
    assert.equal(result.error, 'invalid_project');
    assert.equal(calls.length, 0, 'nothing may be spawned');
  } finally {
    try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* junction */ }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveProjectPath - nested rejections leave sessions.json untouched', () => {
  const regCtx = makeRegCtx();
  const rows = ['Pull Requests/..', 'Pull Requests//Vercel', 'Pull Requests/nope', 'email-lint/sub'];
  for (const project of rows) {
    const { spawner } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner, ...regCtx }, project);
    assert.equal(result.ok, false, `project: ${project}`);
  }
  assert.equal(fs.existsSync(regCtx.registryPath), false);
});

test('pidFileNameFor - a nested session name stays a direct child of pidDir', () => {
  assert.equal(pidFileNameFor('pull-requests/vercel'), 'pull-requests.vercel.pid');
  assert.equal(pidFileNameFor('email-lint'), 'email-lint.pid');
});

// --- 6.4 Launch mechanics (unit level, launchSession directly) -------------

test('launchSession - one call spawns exactly one process', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.equal(calls.length, 1);
});

test('launchSession - spawns powershell.exe', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.equal(calls[0].file, 'powershell.exe');
});

test('launchSession - exact args array', () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  // claudeConfigDir null ON PURPOSE - it is the default (no profile
  // configured), and pinning it keeps this assertion off the real config file.
  // Without it the expected argv would depend on whether the machine running
  // the suite happens to have set claude_config_dir (T56).
  launchSession({ baseDir: base, spawner, claudeConfigDir: null, ...regCtx }, 'Video Editing');
  const LAUNCH_SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1');
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', path.join(base, 'Video Editing'),
    '-SessionName', 'Video Editing',   // leaf, spaces and all - the same form --name has always used
    '-PidFile', path.join(regCtx.pidDir, pidFileNameFor(VIDEO_EDITING)),
  ]);
});

test('launchSession - no -ConfigDir at all when no profile is configured (T56)', () => {
  // The stranger case, and the DEFAULT. An unset CLAUDE_CONFIG_DIR is what
  // makes Claude Code choose its own profile; passing the flag with an empty
  // value would bind it in PowerShell and defeat that.
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, claudeConfigDir: null, ...makeRegCtx() }, 'Video Editing');
  assert.ok(
    !calls[0].args.includes('-ConfigDir'),
    'an absent claude_config_dir must pass no -ConfigDir switch whatsoever',
  );
});

test('launchSession - no -PreLaunch at all when none is configured', () => {
  // The DEFAULT, and the one that must not regress: with no switch, the
  // launcher falls to the venv/.venv auto-detect that has always run. Passing
  // an empty value would bind in PowerShell and silently suppress it.
  const { spawner, calls } = makeFakeSpawner();
  launchSession({
    spawner, baseDir: base, claudeConfigDir: null, preLaunchCommand: null, ...makeRegCtx(),
  }, 'Video Editing');
  assert.ok(
    !calls[0].args.includes('-PreLaunch'),
    'an absent pre_launch_command must pass no -PreLaunch switch whatsoever',
  );
});

test('launchSession - passes -PreLaunch as ONE argument when configured', () => {
  // One argument, not two: the value carries spaces by definition, and the
  // `--name`/`--remote-control` history in launch-session.ps1 is what a split
  // argument costs - a stray word arriving as something else entirely.
  const { spawner, calls } = makeFakeSpawner();
  launchSession({
    spawner, baseDir: base, claudeConfigDir: null, preLaunchCommand: 'conda activate myenv', ...makeRegCtx(),
  }, 'Video Editing');
  const i = calls[0].args.indexOf('-PreLaunch');
  assert.ok(i !== -1, 'a configured pre_launch_command must reach the launcher');
  assert.equal(calls[0].args[i + 1], 'conda activate myenv');
});

test('launchSession - no -NoOpeningReport when the report is on (the default)', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({
    spawner, baseDir: base, claudeConfigDir: null, preLaunchCommand: null, openingReport: true, ...makeRegCtx(),
  }, 'Video Editing');
  assert.ok(
    !calls[0].args.includes('-NoOpeningReport'),
    'the switch must be ABSENT in the normal case - it only ever suppresses',
  );
});

test('launchSession - passes -NoOpeningReport when the owner switched the report off', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({
    spawner, baseDir: base, claudeConfigDir: null, preLaunchCommand: null, openingReport: false, ...makeRegCtx(),
  }, 'Video Editing');
  assert.ok(calls[0].args.includes('-NoOpeningReport'));
});

test('launchSession - passes -ConfigDir when a profile IS configured (T56)', () => {
  const { spawner, calls } = makeFakeSpawner();
  const dir = path.join(base, 'some-profile');
  launchSession({ baseDir: base, spawner, claudeConfigDir: dir, ...makeRegCtx() }, 'Video Editing');
  const at = calls[0].args.indexOf('-ConfigDir');
  assert.notEqual(at, -1, 'a configured profile must reach the launcher');
  assert.equal(calls[0].args[at + 1], dir, 'the switch must carry the configured path as its value');
});

test('remoteControlName - a unique leaf is the whole name', () => {
  // The daily case: `email-lint`, not `f-dev-projects-workspace-8a320b.email-lint`.
  const paths = [path.join(base, 'email-lint'), path.join(base, 'Video Editing')];
  assert.equal(remoteControlName(path.join(base, 'email-lint'), paths), 'email-lint');
  assert.equal(remoteControlName(path.join(base, 'Video Editing'), paths), 'Video Editing',
    'spaces survive - --name has always passed the raw leaf quoted');
});

test('remoteControlName - a collision qualifies BOTH sides, not just the second', () => {
  // Qualifying only the newcomer would make a row's name depend on which was
  // launched first, which is the kind of thing that is impossible to debug
  // months later. Format is the owner's, 2026-09-04: `email-lint (Work)`.
  const a = path.join(base, 'Work', 'email-lint');
  const b = path.join(base, 'Workspace', 'email-lint');
  assert.equal(remoteControlName(a, [a, b]), 'email-lint (Work)');
  assert.equal(remoteControlName(b, [a, b]), 'email-lint (Workspace)');
});

test('remoteControlName - the comparison is case-insensitive, because Windows is', () => {
  const a = path.join(base, 'Work', 'Email-Lint');
  const b = path.join(base, 'Workspace', 'email-lint');
  assert.equal(remoteControlName(a, [a, b]), 'Email-Lint (Work)', 'a case-only difference is still a collision');
});

test('launchSession - exact options (detachment contract)', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.deepEqual(calls[0].options, {
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.join(base, 'Video Editing'),
  });
});

test('launchSession - child.unref() called exactly once', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.equal(calls[0].child.unrefCount, 1);
});

test('launchSession - error handler wired', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.equal(typeof calls[0].child.handlers.error, 'function');
});

test('launchSession - no shell string-building leaked into args', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.ok(!calls[0].args.includes('-Command'));
  assert.ok(!calls[0].args.some((a) => a.includes('&')));
  assert.ok(!calls[0].args.some((a) => a.includes(';')));
});

test('launchSession - REFUSES a container folder, and spawns NOTHING', () => {
  // `Pull Requests` holds only directories and no file of its own, which is
  // exactly containerChildrenOf's definition of a container: a folder OF
  // projects, not a project. listProjects already marks it container:true and
  // the PWA draws it as a drill-in row, so a TAP can never reach here. This
  // covers everything that is not a tap - a stale saved name, a client bug, a
  // direct API call - on the one route that starts a process with the owner's
  // full account access.
  const { spawner, calls } = makeFakeSpawner();
  const res = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests');
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.error, 'project_is_container');
  assert.equal(calls.length, 0, 'nothing may be spawned for a container - that IS the rule');
});

test('launchSession - an ordinary project still launches (the guard is not a blanket refusal)', () => {
  // Control for the test above. Without it a guard that refused EVERYTHING
  // would pass, and so would a typo that broke launching outright.
  const { spawner, calls } = makeFakeSpawner();
  const res = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Video Editing');
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
});

test('launchSession - a project INSIDE a container still launches', () => {
  // The second control, and the one that matters most: a container exists to
  // hold projects, so refusing the container must not refuse what is in it.
  // `Pull Requests/Vercel` is the drill-in case the PWA actually offers.
  const { spawner, calls } = makeFakeSpawner();
  const res = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests/Vercel');
  assert.equal(res.ok, true, 'blocking a container must never block what is inside it');
  assert.equal(calls.length, 1);
});

test('launchSession - a FILE-FREE folder inside a container still launches', () => {
  // REGRESSION (code-review, 2026-09-05). The guard first asked
  // containerChildrenOf directly, which applies the heuristic at EVERY depth.
  // listProjects applies it at exactly one: top-level children of a container
  // root. So a file-free folder inside a container - which the PWA lists as a
  // perfectly ordinary project - was refused with 400 project_is_container.
  // The guard now reads listProjects, so the two cannot disagree.
  assert.ok(containerChildrenOf(path.join(base, 'Pull Requests', 'Nested')),
    'precondition: the heuristic alone DOES call this a container');
  const { spawner, calls } = makeFakeSpawner();
  const res = launchSession({ baseDir: base, spawner, ...makeRegCtx() }, 'Pull Requests/Nested');
  assert.equal(res.ok, true, 'the list offers it, so the launch must accept it');
  assert.equal(calls.length, 1);
});

test('launchSession - a file-free SINGLE-mode root still launches', () => {
  // The other half of the same finding: a `single` root is listed as one
  // project with no classification at all, so "this folder only" on a folder
  // whose top level holds no loose file must still launch. Same folder as the
  // container test above - which is the point: what it IS depends on how it
  // was shared, and only listProjects knows that.
  const { spawner, calls } = makeFakeSpawner();
  const ctx = {
    sharedFolders: [{ path: path.join(base, 'Pull Requests'), mode: 'single', excludes: [], new_folders: 'show' }],
    spawner,
    ...makeRegCtx(),
  };
  const res = launchSession(ctx, 'Pull Requests');
  assert.equal(res.ok, true, 'shared as "this folder only", it is a project, not a container');
  assert.equal(calls.length, 1);
});

test('launchSession - clearPidFile genuinely fires BEFORE the spawn call, not merely before return', () => {
  const regCtx = makeRegCtx();
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(EMAIL_LINT));
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
      body: JSON.stringify({ project: 'Video Editing' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.deepEqual(body, {
      session_name: VIDEO_EDITING,
      project: 'Video Editing',
      path: path.join(base, 'Video Editing'),
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
      body: JSON.stringify({ project: 'Video Editing' }),
    });
    const res = await authedFetch(regCtx, `${origin}/api/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(
      Object.keys(body.sessions[0]).sort(),
      ['path', 'pid', 'project', 'session_id', 'session_name', 'source', 'started_at', 'status'].sort(),
    );
    assert.equal(body.sessions[0].source, 'launched');
    assert.equal(body.sessions[0].session_id, null);
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

test('HTTP - two POSTs past STARTING_GRACE_MS, launcher already exited -> spawns again', async () => {
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
    // The launcher is gone and no pid file ever appeared - a launch that
    // really did fail. Only then may a second tap spawn anything.
    calls[0].child.handlers.exit();
    currentTime += STARTING_GRACE_MS + 1000;
    const res2 = await req();
    assert.equal(res2.status, 202);
    assert.equal(calls.length, 2);

    // Regression guard for findLiveSession excluding `failed` and
    // recordLaunch replacing same-name entries: if either broke, this would
    // hold two entries for 'email-lint' instead of one.
    const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
    const matching = onDisk.sessions.filter((s) => s.session_name === EMAIL_LINT);
    assert.equal(matching.length, 1);
  } finally {
    server.close();
  }
});

// THE COLD-BOOT DUPLICATE, 2026-08-28. The launcher is still running (a cold
// powershell.exe took ~45s to reach Start-Process), so no pid file exists and
// listSessions has aged the entry into `failed`, which findLiveSession does
// not count as live. Before inFlightLaunches this spawned a SECOND session
// for the same project: two rows in the Code tab, and only the second one in
// the registry, so the first could not be stopped from the app.
test('HTTP - second POST past STARTING_GRACE_MS while the launcher still runs -> reuses, never spawns twice', async () => {
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
    // The status the phone would have been shown at this point - the lie the
    // owner acted on.
    const aged = listSessions({ baseDir: base, ...regCtx }).find((s) => s.session_name === EMAIL_LINT);
    assert.equal(aged.status, 'failed');

    const res2 = await req();
    // 202, not 200: nothing is running to "reuse" - the launcher has not
    // reached Start-Process. 200 would put "is already running" on the phone
    // for a session that does not exist yet, and the client only re-arms its
    // confirm sequence on a 202, so a 200 here would also freeze the tile.
    assert.equal(res2.status, 202, 'a launch still in flight is starting, not already running');
    assert.equal(calls.length, 1, 'exactly one process for one project');

    const body = await res2.json();
    assert.equal(body.session_name, EMAIL_LINT);

    // Once the launcher exits without a pid file, the project is launchable
    // again - the guard must not outlive the process it is guarding.
    calls[0].child.handlers.exit();
    const res3 = await req();
    assert.equal(res3.status, 202);
    assert.equal(calls.length, 2);
  } finally {
    server.close();
  }
});

test("launchSession - a spawn that never happened still tells the phone WHY", () => {
  // F15-D2-C01: PowerShell itself failing to start (see the comment in sessions.js).
  const { spawner, calls } = makeFakeSpawner();
  let currentTime = Date.now();
  const regCtx = makeRegCtx({ now: () => currentTime });
  const ctx = { baseDir: base, spawner, ...regCtx };

  launchSession(ctx, 'email-lint');
  calls[0].child.handlers.error(Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));

  // PAST THE GRACE WINDOW, so the registry has made its verdict.
  currentTime += STARTING_GRACE_MS + 1000;

  // baseDir is what lets listSessions resolve projects - see the sibling
  // test above; regCtx alone carries no roots.
  const view = listSessions({ baseDir: base, ...regCtx }).find((s) => s.project === 'email-lint');
  assert.ok(view, 'the launch must still be recorded');
  assert.equal(view.status, 'failed');
  assert.match(
    view.env_error, /could not start: .*ENOENT/,
    'a failed tile with no reason is the whole failure mode this fixes',
  );
});

test("launchSession - a launcher that fails to spawn releases the guard on 'error' alone", () => {
  const { spawner, calls } = makeFakeSpawner();
  let currentTime = Date.now();
  const regCtx = makeRegCtx({ now: () => currentTime });
  const ctx = { baseDir: base, spawner, ...regCtx };

  const first = launchSession(ctx, 'email-lint');
  assert.equal(first.reused, false);

  // Past the grace window, so the registry entry is `failed` and no longer
  // live - leaving the in-flight guard as the only thing that could block
  // the retry, which is exactly what this test is about.
  currentTime += STARTING_GRACE_MS + 1000;

  // node guarantees only ONE of 'error'/'exit' fires. Without the release on
  // 'error' a project whose launcher never started would stay unlaunchable
  // for the life of the agent.
  calls[0].child.handlers.error(new Error('spawn ENOENT'));

  const second = launchSession(ctx, 'email-lint');
  assert.equal(second.reused, false, 'a spawn that never happened must not block the retry');
  assert.equal(calls.length, 2);
});

// launch-session.ps1 can wedge rather than exit - its own header records
// Start-Process popping a modal "Pick an app" dialog on this host, and with
// windowsHide and nobody at the desk that dialog is never dismissed. An
// in-flight entry that outlived its launcher would then block the project for
// the life of the agent: every tap answered "starting", nothing ever spawned,
// and no way out at all. Worse than the duplicate the guard exists to stop.
test('launchSession - a launcher that never exits stops blocking after IN_FLIGHT_CEILING_MS', () => {
  const { spawner, calls } = makeFakeSpawner();
  let currentTime = Date.now();
  const regCtx = makeRegCtx({ now: () => currentTime });
  const ctx = { baseDir: base, spawner, ...regCtx };

  launchSession(ctx, 'email-lint');
  assert.equal(calls.length, 1);

  // Well past the grace window, so the registry entry is `failed` and the
  // in-flight guard is the only thing answering. The launcher never exits.
  currentTime += STARTING_GRACE_MS + 1000;
  assert.equal(launchSession(ctx, 'email-lint').reused, false);
  assert.equal(calls.length, 1, 'still guarded - a slow launcher is not a wedged one');

  currentTime += 10 * 60 * 1000;
  launchSession(ctx, 'email-lint');
  assert.equal(calls.length, 2, 'past the ceiling the owner must be able to start it again');
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
    fs.writeFileSync(path.join(regCtx.pidDir, pidFileNameFor(EMAIL_LINT)), '555', 'ascii');

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

    // Writing the pid file is launch-session.ps1's LAST act, so the launcher
    // exiting is part of the same event in the real world - and it is what
    // releases the in-flight guard. Modelling only the file would test a
    // state the machine never reaches.
    fs.mkdirSync(regCtx.pidDir, { recursive: true });
    fs.writeFileSync(path.join(regCtx.pidDir, pidFileNameFor(EMAIL_LINT)), '999', 'ascii');
    calls[0].child.handlers.exit();

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
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(EMAIL_LINT));
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
      body: JSON.stringify({ project: 'Video Editing' }),
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
  // T56. This assertion used to be `script.includes('.claude-max')` - it PINNED
  // the owner's personal profile into the launch recipe, so a stranger got every
  // session launched against a profile directory that does not exist on their
  // machine. The profile is now a config value and the flag is ABSENT BY
  // DEFAULT, so the rule inverts: the recipe must carry no personal profile at
  // all, and must set the variable only when one was passed in.
  // Comments stripped first, for the same reason the --channels scan below
  // strips them: the explanation necessarily names the string it forbids.
  const noComments = script.replace(/^\s*#.*$/gm, '');
  assert.ok(
    !/\.claude-(max|pro)/.test(noComments),
    'launch-session.ps1 must not hardcode a personal Claude profile - it breaks anyone who is not the owner (T56)',
  );
  assert.match(
    noComments,
    /if \(\$ConfigDir\)\s*\{\s*\$env:CLAUDE_CONFIG_DIR = \$ConfigDir\s*\}/,
    'CLAUDE_CONFIG_DIR must be set ONLY when -ConfigDir was passed; unset is the correct default, so Claude Code picks its own profile',
  );
  // And the ELSE half must actively CLEAR it. "Not set" is not the same as
  // "unset" here: Start-Process inherits this process's environment, and the
  // owner's shell exports CLAUDE_CONFIG_DIR, so without the clear a launch with
  // no configured profile inherits the desk's profile rather than defaulting.
  assert.match(
    noComments,
    /else\s*\{\s*Remove-Item Env:CLAUDE_CONFIG_DIR/,
    'with no -ConfigDir the launcher must CLEAR CLAUDE_CONFIG_DIR, or it inherits whatever the agent was started with',
  );
  // --channels must NOT be passed by the PWA launcher. Measured 2026-09-05:
  // with it, a launched session renders fine and then sits on
  // `/rc connecting...` forever and never reaches the Code tab; without it,
  // and with nothing else changed, RC connects quickly. Owner confirmed both
  // arms. A phone-launched session exists to BECOME a Code-tab row, so the
  // flag that prevents that cannot be here - the desk aliases keep it, which
  // is where WhatsApp inbound is actually used.
  // Comments STRIPPED first. The comment above the ArgumentList explains this
  // rule and necessarily names the flag to do so; a raw source scan then trips
  // on the explanation and fails the rule it is explaining. Full-line `#`
  // comments only, which is every comment in this script.
  const psCode = script.replace(/^\s*#.*$/gm, '');
  assert.ok(
    !/--channels/.test(psCode),
    'passing --channels here stops Remote Control connecting, so the session never appears in the Code tab',
  );
  // THE WHOLE TOKEN, quoting included - not the bare flag. This assertion used
  // to read `script.includes('--remote-control')`, which every form satisfies:
  // `=`, space-separated, quoted, unquoted, even an empty value. On 2026-09-04
  // this line was changed from the two-argument form to the `=` form and 992
  // tests stayed green, because nothing here looked at the VALUE or its
  // PAIRING. That is the exact hole, and this closes it.
  //
  // Why the `=` form is the correct one: Start-Process joins ArgumentList with
  // spaces and quotes nothing itself, so `'--remote-control', $SessionName`
  // splits any name containing a space - `Video Editing` arrives as
  // `--remote-control Video` plus a stray `Editing` that claude reads as an
  // initial prompt and types into the session. Real folders hit this: Video
  // Editing, Backend Engineering, Whatsapp Plugin, Y Combinator-qm.
  //
  // HONEST LIMIT: this is a SOURCE assertion. It proves the recipe still says
  // what it should; it cannot prove claude ACTS on it. Only a live launch does
  // that, and on 2026-09-04 the owner confirmed one (Video Editing, correct
  // row name, no stray word typed).
  assert.ok(
    script.includes('"--remote-control=`"$SessionName`""'),
    'the Code-tab row name must be ONE argument with its value quoted, or a name with a space splits',
  );
  // Regex, not includes(): the ArgumentList is one entry per line with comments
  // interleaved, so a reintroduction would be written across TWO lines and the
  // single-line string this used to test for would never have matched it. A
  // guard that cannot fail is worse than no guard - it reads as protection.
  assert.ok(
    !/'--remote-control'\s*,/.test(script),
    'the two-argument form must not come back - it splits every name containing a space',
  );
  // --remote-control names the Code-tab row, NOT the terminal title: a
  // PWA-launched tab read "Claude Code" until --name was added (owner's
  // screenshot, 2026-08-27). The folder leaf, not $SessionName - the owner
  // wants `Harbor`, and $SessionName is the sanitized lowercase form.
  // The inner backtick-quotes are load-bearing: Start-Process joins
  // ArgumentList with spaces and quotes nothing itself, so a project named
  // `Pull Requests` would arrive as `--name=Pull` plus a stray `Requests`
  // that claude reads as an initial prompt.
  assert.ok(
    script.includes('"--name=`"$(Split-Path -Leaf $ProjectPath)`""'),
    'the launch must name the session after its FOLDER, quoted for spaces',
  );
  // THE OPENING REPORT. The PWA is a START BUTTON, so nobody types the first
  // message - and a SessionStart hook can only add CONTEXT, never produce a
  // turn, because a turn exists only when there is a prompt. A trailing
  // positional IS the initial prompt: the same mechanism the two flags above
  // are pinned to the `=` form to prevent happening BY ACCIDENT. This is the
  // deliberate version of it.
  // CHECKED AGAINST THE CODE, NOT THE RAW FILE. A whole-file includes() is
  // satisfied by a comment, and this change ships a 13-line comment block on
  // exactly this subject - so the assertions below could have passed while the
  // launcher had lost the behaviour entirely. detachment.test.js already
  // documents that failure for real: the `.claude-max` token once survived only
  // inside the comment explaining its own removal.
  // ponytail: second local copy of this one-line strip (detachment.test.js has
  // the other). Not extracted, deliberately - a shared PowerShell stripper is a
  // third file in a diff that has already been reviewed, and codeOnly() in
  // helper-source.js strips `//`, which is the wrong comment syntax. Upgrade
  // path: fold both into helper-source.js as its own task.
  const code = script.replace(/^\s*#.*$/gm, '');
  assert.ok(
    code.includes("Join-Path $ProjectPath 'HANDOFF.md'"),
    'the opening report must be guarded on the project HAVING a HANDOFF.md, or projects without one get a prompt about a file that is not there',
  );
  assert.ok(
    code.includes('Read HANDOFF.md and give the opening report.'),
    'the PWA launch must pass the opening-report prompt, or a phone-started session sits silent forever - the hook cannot speak on its own',
  );
  // The one that actually bites: building the array and never passing it looks
  // right in review and does nothing at all. Pin the APPEND, not the variable.
  assert.ok(
    code.includes(') + $openingReport)'),
    'the opening report must be APPENDED to ArgumentList, or it is built and thrown away',
  );
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
    sessionDirs: testSessionDirs(dir),
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
    sessionDirs: testSessionDirs(dir),
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
      session_name: PULL_REQUESTS,
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
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, ...regCtx });
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
    server.close();
  }
});

test('HTTP - POST /api/sessions/end with ONLY session_name for a subfolder desk session -> 200 ended, kill spawner called with its pid (review round 1, issue 3 - a mutation dropping session_name routing must fail this)', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7791);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'claude.exe';
  const subCwd = path.join(base, 'Pull Requests', 'Whatsapp Plugin');
  writeDeskSessionFile(regCtx, { pid: 7791, sessionId: 'sub-conv-2', cwd: subCwd });
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // No `project` key at all - the subfolder session has no name
    // resolveProjectPath would accept, so this is the ONLY body a real
    // synthetic-tile STOP ever sends for it.
    const res = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_name: nameUnder(base, 'pull-requests', 'whatsapp-plugin') }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      result: 'ended', project: 'Whatsapp Plugin', session_name: nameUnder(base, 'pull-requests', 'whatsapp-plugin'),
    });
    assert.equal(killer.calls.length, 1, 'the kill spawner must have been called exactly once');
    assert.deepEqual(killer.calls[0].args, ['/PID', '7791', '/T', '/F']);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/end on a running session: response, pid file, registry state', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7778);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 7778);
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  const server = fixtureServer({ baseDir: base, killSpawner: killer.spawner, ...regCtx });
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
      result: 'ended',
      project: 'Pull Requests',
      session_name: sessionName,
    });

    assert.equal(fs.existsSync(pidFilePath), false);

    const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
    const entry = onDisk.sessions.find((s) => s.session_name === sessionName);
    assert.ok(entry, 'the entry must still exist after the kill, not be pruned');
    // `ended` immediately now. It used to sit at `handoff` while a runner
    // wrote HANDOFF.md and only then become `ended`; there is no runner, so
    // there is no in-between state to observe.
    assert.equal(entry.status, 'ended');
    assert.ok(Number.isFinite(Date.parse(entry.ended_at)));

  } finally {
    server.close();
  }
});


test('HTTP - POST /api/sessions/end when the pid survives the kill -> kill_failed, no handoff, session still running', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, killPollIntervalMs: 1, pidImageName: () => 'cmd.exe' });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 8888);
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner, ...regCtx });
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
  const server = fixtureServer({ baseDir: base, killSpawner, ...regCtx });
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
  const sessionName = deriveSessionName(projectPath, base);
  recordLaunch(regCtx, { sessionName, project: 'Pull Requests', projectPath });
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, killSpawner, ...regCtx });
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

// --- endSession must not destroy a launch failure it never showed (F9) -----
//
// The prune goes out of its way to KEEP <pidfile>.err when it drops a dead
// entry, because nobody has read why the launch went wrong yet. Every
// endSession path that discovers the process was ALREADY GONE lands on the same
// state, and using the teardown form there deletes the reason by way of the one
// tap the owner makes when a launch has visibly failed. Three paths, one rule.

test('endSession - STOP on an already-pruned session keeps the .err it never got to show', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => false });
  // No registry entry at all: exactly what the owner's tap hits after
  // listSessions has pruned the tile they are still looking at.
  const sessionName = deriveSessionName(path.resolve(base, 'Pull Requests'), base);
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  // BOTH files. Written with only the .err first, and that version could not
  // fail: with no .pid on disk, clearPidFileOnly's single side effect was
  // unexercised and deleting the call outright still passed. The rule has two
  // halves and a test named for it has to pin both.
  fs.writeFileSync(pidFilePath, '4242', 'ascii');
  fs.writeFileSync(`${pidFilePath}.err`, 'pre_launch_command failed: boom', 'utf8');
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();

  const result = await endSession({ baseDir: base, killSpawner, ...regCtx }, 'Pull Requests');

  assert.equal(result.body.result, 'already_ended');
  assert.equal(killCalls.length, 0);
  assert.equal(fs.existsSync(pidFilePath), false, 'it still takes the pid file');
  assert.equal(
    fs.existsSync(`${pidFilePath}.err`), true,
    'the reason must survive a STOP on a session that had already gone',
  );
});

// The desk half of the same rule. A desk session and a launched one derive the
// SAME name for the same folder, so a desk teardown reaches the same .err - one
// it never wrote and does not own.
test('endSession - tearing down a DESK session leaves a launched session\'s .err alone', async () => {
  const killer = makeKillingSpawner(7795);
  const regCtx = makeRegCtx({ isPidAlive: killer.isPidAlive, pidImageName: () => 'claude.exe' });
  const projectPath = path.resolve(base, 'Pull Requests');
  const sessionName = deriveSessionName(projectPath, base);
  writeDeskSessionFile(regCtx, { pid: 7795, sessionId: 'desk-err-1', cwd: projectPath });
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  // Left behind by an EARLIER phone launch of the same folder that blew up.
  fs.writeFileSync(`${pidFilePath}.err`, 'pre_launch_command failed: boom', 'utf8');

  const result = await endSession({ baseDir: base, killSpawner: killer.spawner, ...regCtx }, 'Pull Requests');

  assert.equal(result.ok, true);
  assert.equal(
    fs.existsSync(`${pidFilePath}.err`), true,
    'a desk teardown must not delete a launch failure it never wrote',
  );
});

test('endSession - the agent\'s own pid (reuse guard) keeps the .err too', async () => {
  const regCtx = makeRegCtx({ isPidAlive: (pid) => pid === process.pid });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', process.pid);
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  fs.writeFileSync(`${pidFilePath}.err`, 'pre_launch_command failed: boom', 'utf8');
  const { spawner: killSpawner } = makeFakeSpawner();

  await endSession({ baseDir: base, killSpawner, ...regCtx }, 'Pull Requests');

  assert.equal(fs.existsSync(pidFilePath), false, 'the stale pid file still goes');
  assert.equal(fs.existsSync(`${pidFilePath}.err`), true, 'the reason still stays');
});

test('endSession - a reused pid whose image is not ours keeps the .err too', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, pidImageName: () => 'notepad.exe' });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 9991);
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  fs.writeFileSync(`${pidFilePath}.err`, 'pre_launch_command failed: boom', 'utf8');
  const { spawner: killSpawner } = makeFakeSpawner();

  await endSession({ baseDir: base, killSpawner, ...regCtx }, 'Pull Requests');

  assert.equal(fs.existsSync(pidFilePath), false, 'the stale pid file still goes');
  assert.equal(fs.existsSync(`${pidFilePath}.err`), true, 'the reason still stays');
});

// The negative control for all three: a DELIBERATE teardown of a live session
// is not the same event, and there the .err goes with the launch it belonged
// to. Without this, clearPidFileOnly everywhere would pass the three above.
test('endSession - a real kill DOES take the .err, because that is a teardown', async () => {
  // makeKillingSpawner, NOT makeFakeSpawner: the fake one never lets the pid
  // die, so endSession takes the kill_failed branch, which deliberately keeps
  // the pid file and never reaches the teardown clear. Written with the fake
  // first, and this control caught it.
  const killer = makeKillingSpawner(9992);
  const regCtx = makeRegCtx({ isPidAlive: killer.isPidAlive, pidImageName: () => 'cmd.exe' });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', 9992);
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  fs.writeFileSync(`${pidFilePath}.err`, 'pre_launch_command failed: boom', 'utf8');

  const result = await endSession({ baseDir: base, killSpawner: killer.spawner, ...regCtx }, 'Pull Requests');

  assert.equal(result.ok, true);
  assert.equal(result.body.result, 'ended', 'the kill must actually have succeeded, or this proves nothing');
  assert.equal(fs.existsSync(`${pidFilePath}.err`), false, 'a torn-down launch takes its reason with it');
});

// --- endSession - F1 (pid reuse) and F2 (concurrent STOP/START) guards -----

test('endSession - pid equals the agent\'s own process.pid -> already_ended, no taskkill, entry dropped entirely', async () => {
  const regCtx = makeRegCtx({ isPidAlive: (pid) => pid === process.pid });
  const { sessionName } = makeRunningEntry(regCtx, 'Pull Requests', process.pid);
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, ...regCtx };

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
  const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(sessionName));
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, ...regCtx };

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
  // Anchored on CODE, not on the next function's comment prose. It used to
  // end the slice at ' * Byte-for-byte port', the first line of
  // deriveSessionName's docblock - so T68's mandated rewrite of that docblock
  // (it had become untrue) broke this unrelated test. A test must not depend
  // on a neighbour's wording. '\n}' is the function's own closing brace at
  // column 0: every inner brace is indented, and it is CRLF-safe because the
  // '}' follows the '\n' directly.
  const start = src.indexOf('async function defaultPidImageName(');
  const fn = src.slice(start, src.indexOf('\n}', start) + 2);
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
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const [r1, r2] = await Promise.all([
    endSession(ctx, 'Pull Requests'),
    endSession(ctx, 'Pull Requests'),
  ]);

  const started = [r1, r2].filter((r) => r.ok && r.body && r.body.result === 'ended');
  const rejected = [r1, r2].filter((r) => !r.ok && r.status === 409);
  assert.equal(started.length, 1, 'exactly one call must win the claim and spawn the runner');
  assert.equal(rejected.length, 1, 'the loser must get 409 session_not_running');
  assert.deepEqual(rejected[0], { ok: false, status: 409, error: 'session_not_running' });
  assert.equal(killer.calls.length, 1, 'taskkill must run exactly once');

});

test('endSession - a launch landing during the kill poll returns reused with the handoff entry', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(9993);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'cmd.exe';
  makeRunningEntry(regCtx, 'Video Editing', 9993);
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const endPromise = endSession(ctx, 'Video Editing');

  // The claim (status: 'ending') is written synchronously before endSession
  // ever awaits, so a launch landing in this window - the exact race the
  // comments in sessions.js worry about - sees it immediately.
  const launchResult = launchSession(ctx, 'Video Editing');
  assert.equal(launchResult.ok, true);
  assert.equal(launchResult.reused, true);
  assert.equal(launchResult.session.status, 'ending');

  const result = await endPromise;
  assert.equal(result.body.result, 'ended');
});


// --- endSession - the background handoff verdict (unit level) --------------







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
  const handoff = { ...ended, session_name: EMAIL_LINT, project: 'email-lint', original_path: path.join(base, 'email-lint'), status: 'ending', ending_started_at: ended.ended_at };
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_name: EMAIL_LINT }),
    });
    assert.equal(notEnded.status, 204);

    const res = await authedFetch(regCtx, `${origin}/api/sessions/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_name: 'pullrequests' }),
    });
    assert.equal(res.status, 204);

    const left = (await (await authedFetch(regCtx, `${origin}/api/sessions`)).json()).sessions;
    assert.deepEqual(left.map((s) => [s.session_name, s.status]), [[EMAIL_LINT, 'ending']]);
  } finally {
    server.close();
  }
});

// --- desk-started sessions - STOP -----------------------------------------

test('endSession - desk session: claim/kill/handoff argv gets -SessionId, discovery stops seeing it, ended banner after exit', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7777);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'claude.exe';
  const projectPath = path.join(base, 'Pull Requests');
  writeDeskSessionFile(regCtx, { pid: 7777, sessionId: 'abc-123', cwd: projectPath });
  const handoffPath = path.join(projectPath, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, 'old');
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(handoffPath, oldTime, oldTime);
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');

  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { result: 'ended', project: 'Pull Requests', session_name: PULL_REQUESTS });
  assert.equal(killer.calls.length, 1);
  assert.equal(killer.calls[0].file, 'taskkill');
  assert.deepEqual(killer.calls[0].args, ['/PID', '7777', '/T', '/F']);

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
  assert.equal(onDisk.sessions[0].session_name, PULL_REQUESTS);
  // Straight to `ended` - the claim used to sit at `handoff` until a runner
  // finished. The claim itself still matters, and the two assertions below
  // are what it exists for: discovery must stop reporting the desk session
  // the moment it is claimed, or it is counted twice.
  assert.equal(onDisk.sessions[0].status, 'ended');
  assert.ok(Number.isFinite(Date.parse(onDisk.sessions[0].ended_at)));

  const listed = listSessions(ctx);
  assert.equal(listed.length, 1, 'reported once, not twice');
  assert.notEqual(listed[0].source, 'desk', 'discovery must have stopped seeing it once claimed');


  // The ended record is what reportEnded() announces, so it has to be on disk
  // - it just carries no handoff verdict any more, because nothing wrote one.
  const after = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  const afterEntry = after.sessions.find((s) => s.session_name === PULL_REQUESTS);
  assert.equal(afterEntry.status, 'ended');
  assert.equal(afterEntry.handoff_ok, undefined, 'no verdict, because there is no handoff');
});

test('endSession - desk session: the handoff registry entry is on disk BEFORE the kill spawner is ever called', async () => {
  const regCtx = makeRegCtx({ pidImageName: () => 'claude.exe' });
  const projectPath = path.join(base, 'Pull Requests');
  writeDeskSessionFile(regCtx, { pid: 7786, sessionId: 'abc-123', cwd: projectPath });
  let alive = true; // alive through discovery + the claim, then dead once the kill spawner fires
  regCtx.isPidAlive = (pid) => pid === 7786 && alive;
  let registryAtKillTime = null;
  const killSpawner = (file, args, options) => {
    // Read the registry file synchronously, inside the kill spawner call
    // itself, so this proves ORDER (the write landed before this call),
    // not merely that both things eventually happened.
    registryAtKillTime = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
    alive = false;
    const child = { pid: 5557, handlers: {}, on(event, fn) { this.handlers[event] = fn; return this; } };
    return child;
  };
  const ctx = { baseDir: base, killSpawner, ...regCtx };

  const result = await endSession(ctx, 'Pull Requests');

  assert.ok(registryAtKillTime, 'the kill spawner must have been called');
  assert.equal(registryAtKillTime.sessions.length, 1, 'the handoff entry must already be on disk when the kill spawner fires');
  assert.equal(registryAtKillTime.sessions[0].session_name, PULL_REQUESTS);
  assert.equal(registryAtKillTime.sessions[0].status, 'ending');

});

test('endSession - desk session whose pid image is cmd.exe (not claude.exe) -> already_ended, no taskkill, no registry entry left', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, pidImageName: () => 'cmd.exe' });
  const projectPath = path.join(base, 'Video Editing');
  writeDeskSessionFile(regCtx, { pid: 7780, sessionId: 'abc-123', cwd: projectPath });
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, ...regCtx };

  const result = await endSession(ctx, 'Video Editing');

  assert.equal(result.ok, true);
  assert.equal(result.body.result, 'already_ended');
  assert.equal(killCalls.length, 0, 'a mismatched image must never reach taskkill');

  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 0, 'the claim must be dropped, not left behind');
});

test('endSession - desk session where the kill does not take -> kill_failed, registry entry removed, rediscovered as desk again', async () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true, killPollIntervalMs: 1, pidImageName: () => 'claude.exe' });
  const projectPath = path.join(base, 'Video Editing');
  writeDeskSessionFile(regCtx, { pid: 7781, sessionId: 'abc-123', cwd: projectPath });
  const { spawner: killSpawner, calls: killCalls } = makeFakeSpawner();
  const ctx = { baseDir: base, killSpawner, ...regCtx };

  const result = await endSession(ctx, 'Video Editing');

  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { result: 'kill_failed', project: 'Video Editing', session_name: VIDEO_EDITING });
  assert.equal(killCalls.length, 1);

  const listed = listSessions(ctx);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, 'desk', 'dropping the claim must let discovery rediscover the still-live process');
  assert.equal(listed[0].status, 'running');
});

test('endSession - two concurrent desk STOPs for the same project -> one 200, one 409, killSpawner called exactly once', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7782);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'claude.exe';
  const projectPath = path.join(base, 'Video Editing');
  writeDeskSessionFile(regCtx, { pid: 7782, sessionId: 'abc-123', cwd: projectPath });
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const [r1, r2] = await Promise.all([
    endSession(ctx, 'Video Editing'),
    endSession(ctx, 'Video Editing'),
  ]);

  const started = [r1, r2].filter((r) => r.ok && r.body && r.body.result === 'ended');
  const rejected = [r1, r2].filter((r) => !r.ok && r.status === 409);
  assert.equal(started.length, 1);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], { ok: false, status: 409, error: 'session_not_running' });
  assert.equal(killer.calls.length, 1);

});




test('HTTP - POST /api/sessions for a project with a live desk session -> 200 reused, spawns nothing', async () => {
  const regCtx = makeRegCtx();
  const projectPath = path.join(base, 'Pull Requests');
  writeDeskSessionFile(regCtx, { pid: 7783, sessionId: 'abc-123', cwd: projectPath });
  regCtx.isPidAlive = (pid) => pid === 7783;
  const { spawner, calls } = makeFakeSpawner();
  const server = fixtureServer({ baseDir: base, spawner, ...regCtx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'desk');
    assert.equal(body.status, 'running');
    assert.equal(calls.length, 0, 'a reused desk session must spawn nothing');
  } finally {
    server.close();
  }
});

test('endSession - desk session: pidImageName is never called before a successful claim (the claim, not the image check, is the mutex)', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7785);
  regCtx.isPidAlive = killer.isPidAlive;
  let pidImageCalls = 0;
  regCtx.pidImageName = () => { pidImageCalls += 1; return 'claude.exe'; };
  const projectPath = path.join(base, 'Video Editing');
  writeDeskSessionFile(regCtx, { pid: 7785, sessionId: 'abc-123', cwd: projectPath });
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  const [r1, r2] = await Promise.all([
    endSession(ctx, 'Video Editing'),
    endSession(ctx, 'Video Editing'),
  ]);

  const rejected = [r1, r2].filter((r) => !r.ok && r.status === 409);
  assert.equal(rejected.length, 1, 'the loser must be rejected before ever reaching pidImageName');
  assert.equal(pidImageCalls, 1, 'pidImageName must be called exactly once - claiming impossible for the loser stops it earlier');

  const started = [r1, r2].find((r) => r.ok && r.body && r.body.result === 'ended');
  await started.handoff;
});

// --- T50: END by session_name for a desk session in a project subfolder ----

test('endSession - end by session_name for a subfolder desk session: registry claim survives the prune, handoff -> ended with the SUBFOLDER path (review round 1, issue 1)', async () => {
  const regCtx = makeRegCtx();
  const killer = makeKillingSpawner(7790);
  regCtx.isPidAlive = killer.isPidAlive;
  regCtx.pidImageName = () => 'claude.exe';
  const subCwd = path.join(base, 'Pull Requests', 'Whatsapp Plugin');
  writeDeskSessionFile(regCtx, { pid: 7790, sessionId: 'sub-conv-1', cwd: subCwd });
  const ctx = { baseDir: base, killSpawner: killer.spawner, ...regCtx };

  // Relative-to-baseDir, not the subfolder's bare basename (review round 1,
  // issue 2) - 'whatsapp-plugin' alone could collide with a real top-level
  // project of that name.
  const sessionName = nameUnder(base, 'pull-requests', 'whatsapp-plugin');
  const result = await endSession(ctx, { session_name: sessionName });

  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { result: 'ended', project: 'Whatsapp Plugin', session_name: sessionName });
  assert.equal(killer.calls.length, 1);
  assert.deepEqual(killer.calls[0].args, ['/PID', '7790', '/T', '/F']);


  // What runStop actually does next: poll listSessions() right after the
  // END response, before the handoff runner has exited. Pre-fix, the prune
  // loop ran resolveProjectPath(baseDir, 'Whatsapp Plugin') on this entry -
  // 404, not a direct child of baseDir - and silently dropped the claim, so
  // this poll returned [] and the tile never showed "writing handoff...".
  const duringHandoff = listSessions(ctx);
  // THE claim of this test, unchanged: the prune must not drop a claimed
  // subfolder entry. It used to be observed mid-handoff; the entry now
  // settles to `ended` in the same call, and the poll still has to find it
  // with the SUBFOLDER path or reportEnded() never fires.
  assert.equal(duringHandoff.length, 1, 'the claim must survive the very next poll, not be pruned');
  assert.equal(duringHandoff[0].session_name, sessionName);
  assert.equal(duringHandoff[0].status, 'ended');
  assert.equal(duringHandoff[0].path, subCwd);
  assert.equal(duringHandoff[0].handoff_ok, undefined, 'no verdict, because there is no handoff');
});

test('endSession - unknown session_name -> 404 session_not_found, never treated as already_ended', async () => {
  const regCtx = makeRegCtx();
  const ctx = { baseDir: base, ...regCtx };

  const result = await endSession(ctx, { session_name: 'no-such-session' });

  assert.deepEqual(result, { ok: false, status: 404, error: 'session_not_found' });
});

test('endSession - a body carrying neither project nor session_name -> 400 invalid_request', async () => {
  const regCtx = makeRegCtx();
  const ctx = { baseDir: base, ...regCtx };

  const result = await endSession(ctx, undefined);

  assert.deepEqual(result, { ok: false, status: 400, error: 'invalid_request' });
});

// --- T74 security fix: the session-name slug is an allowlist ----------------
// Regression tests for a real command-injection path, not hygiene tests.
// A session name reaches launch-session.ps1, which passes it to Start-Process
// for `claude.cmd`; a .cmd runs through cmd.exe, so a metacharacter that
// survives the slug is executed. The old slug collapsed whitespace and dots
// only, so a project named `x&calc` ran calc for anyone holding a token.

test('deriveSessionName - no shell metacharacter survives into a session name', () => {
  for (const ch of ['&', '^', '|', '!', '(', ')', ';', '$', '`', '"', "'", '<', '>', '%', ',', '=', '~', '{', '}', '[', ']', '+', '#', '@']) {
    const name = deriveSessionName(`x${ch}calc`);
    assert.ok(!name.includes(ch), `'${ch}' survived the slug: ${name}`);
    assert.match(name, /^[a-z0-9-]*$/, `slug produced something outside [a-z0-9-]: ${name}`);
  }
});

test('deriveSessionName - the canonical injection payload is defanged', () => {
  assert.equal(deriveSessionName('x&calc'), 'x-calc');
  assert.equal(deriveSessionName('a`whoami`b'), 'a-whoami-b');
  assert.equal(deriveSessionName('a$(id)b'), 'a-id-b');
});

test('deriveSessionName - the nested form slugs each segment, so every / is a real separator', () => {
  const nested = deriveSessionName(path.join(base, 'Pull&Requests', 'Ver|cel'), base);
  assert.equal(nested, nameUnder(base, 'pull-requests', 'ver-cel'));
  // root slug + 2 child segments = 3 parts; a metacharacter must not add one.
  assert.equal(nested.split('/').length, 3, 'a metacharacter must not add a segment');
});

// The zero-blast-radius claim, pinned rather than asserted: every real folder
// on this host slugs to exactly what it did before the allowlist landed.
test('deriveSessionName - every real project name is unchanged by the allowlist', () => {
  const rows = [
    ['claude-remote', 'claude-remote'],
    ['claude-config', 'claude-config'],
    ['Harbor', 'harbor'],
    ['Pull Requests', 'pull-requests'],
    ['Video Editing', 'video-editing'],
    ['Backend Engineering', 'backend-engineering'],
    ['Y Combinator-qm', 'y-combinator-qm'],
    ['Reactive-Resume', 'reactive-resume'],
    ['email-lint', 'email-lint'],
    ['Orchard', 'orchard'],
  ];
  for (const [input, expected] of rows) {
    assert.equal(deriveSessionName(input), expected, `input: ${input}`);
  }
});

// AT-16 - THE INVARIANT that would actually break if registry.js kept a
// second copy of the slug: deriveDeskSessionName and deriveSessionName must
// return the same string for the same path under the same root. Since T72
// that string is the identity a nested session's STOP resolves on, so a
// divergence ends the WRONG session. Behavioural, not a source scan - the
// first version of this test WAS a source scan, and its regex was subtly
// wrong, so it passed while a re-introduced duplicate slug sat in
// registry.js. SUPERSEDES the pre-T95 "depth 3+ disagree BY DESIGN" note:
// both now delegate to sessionNameFor (sessions.js), THE ONE
// IMPLEMENTATION, so they agree at every depth including 0 (the root
// itself) and 3 - there is no longer a depth where they may diverge.
// Two different roots, so a second copy of the rule keyed on "which root"
// cannot hide behind only ever exercising one.
test('deriveDeskSessionName and deriveSessionName cannot diverge', () => {
  const cases = [
    [],                        // depth 0 - the root itself
    ['email-lint'],
    ['Pull Requests'],
    ['Pull Requests', 'Vercel'],
    ['Y Combinator-qm'],
    ['x&calc'],
    ['Pull&Requests', 'Ver|cel'],
    ['a`whoami`b', 'c$(id)d'],
    ['My.Project', 'A  B'],
    ['Pull Requests', 'Vercel', 'deep'],   // depth 3
  ];
  for (const root of [base, base2]) {
    for (const segs of cases) {
      const full = path.join(root, ...segs);
      assert.equal(
        deriveDeskSessionName(root, full),
        deriveSessionName(full, root),
        `diverged for root ${root}, segs ${segs.join('/')}`,
      );
    }
  }
});

test('slugSegment - a name of only metacharacters cannot pass the launchability check', () => {
  // resolveProjectPath rejects a session name that is empty or starts with
  // '-', and under the allowlist that is exactly what such a name produces.
  for (const name of ['&&&', '!!', '$$$', '---']) {
    const slugged = deriveSessionName(name);
    assert.ok(slugged === '' || slugged.startsWith('-'), `'${name}' -> '${slugged}' would be accepted`);
  }
});

// --- T95 acceptance tests, continued (multi-root, HTTP-level) --------------

// R-1 - THE COLLISION TEST, the whole point of SB3. Two SIBLING roots whose
// only difference is a path separator vs a literal hyphen used to slug to
// the SAME rootSlug and therefore the SAME session name, before the digest
// existed: STOP would end the wrong root's session and the handoff would
// write into the wrong project's folder. Pure string functions, no temp dir:
// neither path needs to exist on disk. RED WHEN the digest is removed, moved
// off the root prefix, or made a function of anything other than the full
// path.
test('R-1 - two sibling roots differing only by separator-vs-hyphen get different identities', () => {
  const A = 'F:\\Dev\\Projects\\Workspace';
  const B = 'F:\\Dev\\Projects-Workspace';
  assert.notEqual(rootSlug(A), rootSlug(B));
  assert.notEqual(sessionNameFor(A, `${A}\\Vercel`), sessionNameFor(B, `${B}\\Vercel`));
  // The readable half is proven not to have been thrown away.
  assert.ok(rootSlug(A).startsWith('f-dev-projects-workspace'));
  assert.ok(rootSlug(B).startsWith('f-dev-projects-workspace'));
});

// R-2 - the rootSlug anchor: fixed literals, no helper, no temp dir - what
// stops the AT-16 invariant (which compares two production functions against
// each other) from being circular. Replaces AT-17: the literals below now
// include the hash digest, computed once with node and pasted as fixed
// strings. RED WHEN the root-slug rule changes at all (drive-letter
// handling, separator collapse, case-folding, digest input, digest length,
// a leading or trailing dash).
test('R-2 - rootSlug anchor: fixed literals including the digest, no helper', () => {
  assert.equal(rootSlug('F:\\Dev\\Projects\\Workspace'), 'f-dev-projects-workspace-8a320b');
  assert.equal(rootSlug('D:/Work'), 'd-work-d4b870');
});

// R-3 - normalisation is part of the identity: different case, different
// separators, a trailing separator all still hash to the same digest. THE
// "stable across a config rewrite" property - without it, re-saving
// config.json with different casing renames every live session and the
// prune deletes them all on the next poll.
test('R-3 - rootSlug is stable across case, separator and trailing-separator differences', () => {
  assert.equal(rootSlug('F:\\Dev\\Projects\\Workspace'), rootSlug('f:/dev/projects/workspace/'));
});

// R-5 - the 518 raw cap. A fabricated 254-character root's slug plus a
// 255-character remainder segment is a LEGAL identifier shape (form 1
// matches on the slug, then the lstat on the fabricated path fails) - it
// must clear the raw cap and fail on disk, not on length. One byte over the
// cap must still be invalid_request.
test('R-5 - the 518 raw cap accepts a maximal legal identifier and rejects one byte more', () => {
  const longRoot = path.join(base, 'z'.repeat(254 - (base.length + 1)));
  const roots = [{ path: longRoot, mode: 'container', excludes: [], new_folders: 'show' }];
  const longSlug = rootSlug(longRoot);
  const identifier = `${longSlug}/${'b'.repeat(255)}`;
  const withinCap = resolveProjectPath(roots, identifier);
  assert.equal(withinCap.ok, false);
  assert.equal(withinCap.error, 'project_not_found', 'a legal-shaped identifier must fail on disk, not on length');

  const overCap = resolveProjectPath(roots, 'x'.repeat(519));
  assert.equal(overCap.ok, false);
  assert.equal(overCap.error, 'invalid_request');
});

// Replaces the old 'MAX_PROJECT_SEGMENTS is exported as 3' test, which
// asserted a constant against its own literal and pinned no behaviour. This
// pins the cap behaviourally instead: a form-1 identifier with one segment
// too many is rejected, root slug and all.
test('resolveProjectPath - a four-segment root-qualified identifier -> 400 invalid_project', () => {
  assert.equal(MAX_PROJECT_SEGMENTS, 3);
  const roots = [{ path: base, mode: 'container', excludes: [], new_folders: 'show' }];
  const identifier = [rootSlug(base), 'a', 'b', 'c'].join('/');
  const result = resolveProjectPath(roots, identifier);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_project');
});

// AT-12 - launch + END round-trip in the SECOND root, via HTTP, using the
// form-1 ROOT-QUALIFIED identifier - so the new branch is what is exercised.
// RED WHEN: any single-root assumption in launch, END, the pid path, or the
// handoff cwd - this is the test that catches "STOP kills the other one".
test('AT-12 - launch + END round-trip in the second root, via the root-qualified form', async () => {
  const identifier = VERCEL2;   // form-1: '<rootB-slug>/vercel'
  // Windows is case-insensitive: resolveProjectPath resolves against the
  // CLIENT's casing ('vercel', the literal segment nameUnder was given), not
  // the disk's real 'Vercel' - same posture as every other flat-child match.
  const projectPath2 = path.join(base2, 'vercel');
  const { spawner: launchSpawner } = makeFakeSpawner();
  const killer = makeKillingSpawner(7901);
  const regCtx = makeRegCtx({ isPidAlive: killer.isPidAlive, pidImageName: () => 'cmd.exe' });
  const ctx = {
    sharedFolders: TWO_ROOTS, spawner: launchSpawner, killSpawner: killer.spawner, ...regCtx,
  };
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: identifier }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.session_name, VERCEL2);

    // Simulate launch-session.ps1's last act - the real launcher never runs
    // in this suite (standing repo rule).
    fs.mkdirSync(regCtx.pidDir, { recursive: true });
    fs.writeFileSync(path.join(regCtx.pidDir, pidFileNameFor(VERCEL2)), '7901', 'ascii');

    const endRes = await authedFetch(regCtx, `${origin}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: identifier }),
    });
    assert.equal(endRes.status, 200);
    assert.deepEqual(await endRes.json(), {
      result: 'ended', project: 'vercel', session_name: VERCEL2,
    });
    assert.deepEqual(killer.calls[0].args, ['/PID', '7901', '/T', '/F']);
  } finally {
    server.close();
  }
});

// AT-14 - the legacy identifier across two roots sharing a folder name ->
// 400 ambiguous_project, and NOTHING is launched. RED WHEN: first-match-wins
// silently launching the wrong root's project.
test('AT-14 - a legacy identifier ambiguous across two roots -> 400 ambiguous_project, nothing launched', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const regCtx = makeRegCtx();
  const ctx = { sharedFolders: TWO_ROOTS, spawner, ...regCtx };
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Vercel' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'ambiguous_project' });
    assert.equal(calls.length, 0, 'nothing may be spawned for an ambiguous identifier');
  } finally {
    server.close();
  }
});

// AT-15 - a desk session whose cwd is inside a project in the SECOND root is
// discovered, named under that root, and listSessions KEEPS it across a
// second poll (the prune agrees with discovery). RED WHEN: discoverDeskSessions
// naming from one root while the prune re-derives from another.
test('AT-15 - a desk session in the second root is discovered and survives a second poll', () => {
  const regCtx = makeRegCtx({ isPidAlive: () => true });
  const cwd = path.join(base2, 'Vercel');
  writeDeskSessionFile(regCtx, { pid: 9101, sessionId: 'root-b-desk', cwd });
  const ctx = { sharedFolders: TWO_ROOTS, ...regCtx };

  const first = listSessions(ctx);
  assert.equal(first.length, 1);
  assert.equal(first[0].session_name, VERCEL2);
  assert.equal(first[0].source, 'desk');

  const second = listSessions(ctx);
  assert.equal(second.length, 1, 'the prune must agree with discovery, not drop it a poll later');
  assert.equal(second[0].session_name, VERCEL2);
});

// AT-18 - POST /api/projects with no container root shared -> 400
// base_unavailable, and nothing is created. RED WHEN: the route falls
// through to createProject(undefined, name).
test('AT-18 - POST /api/projects with no container root shared -> 400 base_unavailable', async () => {
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at18-'));
  perTestDirs.push(single);
  const regCtx = makeRegCtx();
  const ctx = {
    sharedFolders: [{ path: single, mode: 'single', excludes: [], new_folders: 'show' }],
    ...regCtx,
  };
  const before = fs.readdirSync(single);
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authedFetch(regCtx, `${origin}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Project' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'base_unavailable' });
    assert.deepEqual(fs.readdirSync(single), before, 'nothing may be created');
  } finally {
    server.close();
  }
});

// AT-19 - the prune does NOT use the ambiguous scan: two roots sharing a
// folder name, one with a LIVE, running launched entry -> listSessions still
// reports it as running across two consecutive calls. RED WHEN: the prune
// calling resolveProjectPath(roots, project) instead of [owningRoot] - the
// "silently kills a running session on the poll" bug.
test('AT-19 - the prune resolves the owning root directly, never the ambiguous multi-root scan', () => {
  const livePids = new Set([9102]);
  const regCtx = makeRegCtx({ isPidAlive: (pid) => livePids.has(pid) });
  const projectPath2 = path.join(base2, 'Vercel');
  const sessionName = deriveSessionName(projectPath2, base2);
  recordLaunch(regCtx, { sessionName, project: 'Vercel', projectPath: projectPath2 });
  fs.mkdirSync(regCtx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(regCtx.pidDir, pidFileNameFor(sessionName)), '9102', 'ascii');
  const ctx = { sharedFolders: TWO_ROOTS, ...regCtx };

  for (let i = 0; i < 2; i += 1) {
    const views = listSessions(ctx);
    const view = views.find((v) => v.session_name === sessionName);
    assert.ok(view, `poll ${i}: the running entry must not be dropped by the ambiguous legacy scan`);
    assert.equal(view.status, 'running', `poll ${i}`);
  }
  const onDisk = JSON.parse(fs.readFileSync(regCtx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
});

// R-7 - SB1: a `single`-mode root launched by its own bare root slug used to
// record project: '' - listSessions' entry validator drops any entry whose
// project is '', and drop() unlinks the pid file, so the very next poll
// deleted a RUNNING session and its only handle, orphaning a live claude.cmd
// with no way to stop it from the app. No prior test launched a `single`
// root, which is why the suite stayed green with the bug in place. RED WHEN
// displayProject returns '' for the bare root slug.
test('R-7 - a single-mode root launched by its bare root slug survives two polls, project is never empty', () => {
  const singleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-r7-'));
  try {
    const rootS = rootSlug(singleRoot);
    const { spawner } = makeFakeSpawner();
    const regCtx = makeRegCtx({ isPidAlive: (pid) => pid === 4242 });
    const ctx = {
      sharedFolders: [{ path: singleRoot, mode: 'single', excludes: [], new_folders: 'show' }],
      spawner,
      ...regCtx,
    };

    const result = launchSession(ctx, rootS);
    assert.equal(result.ok, true);
    assert.equal(result.session.session_name, rootS);
    assert.equal(result.session.project, path.basename(singleRoot));
    assert.notEqual(result.session.project, '');

    // Simulate launch-session.ps1's last act, same fake pid-file pattern
    // used throughout this file.
    fs.mkdirSync(regCtx.pidDir, { recursive: true });
    const pidFilePath = path.join(regCtx.pidDir, pidFileNameFor(rootS));
    fs.writeFileSync(pidFilePath, '4242', 'ascii');

    for (let i = 0; i < 2; i += 1) {
      const views = listSessions(ctx);
      const view = views.find((v) => v.session_name === rootS);
      assert.ok(view, `poll ${i}: a running single-root entry must not be dropped`);
      assert.equal(view.status, 'running', `poll ${i}`);
      assert.ok(fs.existsSync(pidFilePath), `poll ${i}: the pid file must survive`);
    }
  } finally {
    fs.rmSync(singleRoot, { recursive: true, force: true });
  }
});
