import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { deriveSessionName } from '../sessions.js';
import {
  STARTING_GRACE_MS,
  FAILED_RETENTION_MS,
  HANDOFF_TIMEOUT_MS,
  REGISTRY_VERSION,
  isPidAlive,
  listSessions,
  findLiveSession,
  recordLaunch,
  clearPidFile,
  markSessionState,
  dropSession,
  discoverDeskSessions,
  resolveDeskSessionId,
  claimDeskSession,
} from '../registry.js';
import { listProjects } from '../projects.js';
import { testSessionDirs } from './helper-auth.js';

// One shared project fixture (read-only across tests): Pull Requests,
// email-lint, notes.txt. Each test gets its OWN registry file + pid dir
// under a fresh mkdtempSync directory, so tests never interfere and the
// owner's real profile is never touched.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-registry-base-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

// Every makeDataDirs() call creates a temp dir; without tracking them the
// suite leaked one per test (92 across a full run, measured 2026-08-25).
const perTestDirs = [];

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  for (const d of perTestDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeDataDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-registry-data-'));
  perTestDirs.push(dir);
  return {
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'session-pids'),
    sessionDirs: testSessionDirs(dir),
  };
}

function makeCtx(extra = {}) {
  const livePids = extra.livePids || new Set();
  return {
    baseDir: base,
    ...makeDataDirs(),
    isPidAlive: (pid) => livePids.has(pid),
    now: () => Date.now(),
    ...extra,
  };
}

function writeRaw(registryPath, contents) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, contents, 'utf8');
}

function writeSessions(registryPath, sessions, version = REGISTRY_VERSION) {
  writeRaw(registryPath, JSON.stringify({ version, sessions }));
}

function validEntry(project, startedAt = new Date().toISOString(), overrides = {}) {
  const resolved = path.resolve(base, project);
  return {
    session_name: deriveSessionName(resolved),
    project,
    original_path: resolved,
    started_at: startedAt,
    ...overrides,
  };
}

// --- isPidAlive --------------------------------------------------------------

test('isPidAlive - true for this process, never throws', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive - false for a bogus pid, never throws', () => {
  assert.equal(isPidAlive(999999999), false);
});

// --- 1-3: absent / truncated / empty ------------------------------------------

test('listSessions - registry file absent -> [], no throw', () => {
  const ctx = makeCtx();
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - truncated JSON -> [], no throw', () => {
  const ctx = makeCtx();
  writeRaw(ctx.registryPath, '{"sessions": [{"sess');
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - empty file -> []', () => {
  const ctx = makeCtx();
  writeRaw(ctx.registryPath, '');
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - whitespace-only file -> []', () => {
  const ctx = makeCtx();
  writeRaw(ctx.registryPath, '   \n  ');
  assert.deepEqual(listSessions(ctx), []);
});

// --- 4: valid JSON, wrong shape ------------------------------------------------

test('listSessions - valid JSON of the wrong shape -> [] for each', () => {
  const shapes = [
    '[]',
    'null',
    '5',
    '"x"',
    '{"sessions": "nope"}',
    '{"version": 2, "sessions": []}',
  ];
  for (const shape of shapes) {
    const ctx = makeCtx();
    writeRaw(ctx.registryPath, shape);
    assert.deepEqual(listSessions(ctx), [], `shape: ${shape}`);
  }
});

// --- 5: non-object members alongside one good entry ----------------------------

test('listSessions - non-object members dropped, one good entry survives', () => {
  const ctx = makeCtx();
  const good = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [null, 5, 'x', good]);
  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].session_name, 'pull-requests');
});

// --- 6-11: containment re-validation --------------------------------------------

test('listSessions - original_path pointing outside baseDir is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', new Date().toISOString(), { original_path: 'C:\\Windows' });
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - project escaping baseDir is dropped (.. / ..\\Windows / C:\\Windows / sub\\dir)', () => {
  const badProjects = ['..', '..\\Windows', 'C:\\Windows', 'sub\\dir'];
  for (const project of badProjects) {
    const ctx = makeCtx();
    const entry = {
      session_name: 'whatever',
      project,
      original_path: path.resolve(base, 'Pull Requests'),
      started_at: new Date().toISOString(),
    };
    writeSessions(ctx.registryPath, [entry]);
    assert.deepEqual(listSessions(ctx), [], `project: ${project}`);
  }
});

test('listSessions - project naming a folder that no longer exists is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('no-such-project', new Date().toISOString(), {
    session_name: 'no-such-project',
    original_path: path.resolve(base, 'no-such-project'),
  });
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - original_path tampered while project stays legitimate is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', new Date().toISOString(), {
    original_path: path.resolve(base, 'email-lint'), // right project, swapped path
  });
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - session_name disagreeing with deriveSessionName(original_path) is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', new Date().toISOString(), {
    session_name: 'not-the-right-name',
  });
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - started_at missing is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests');
  delete entry.started_at;
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - started_at unparseable is dropped', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', 'not-a-date');
  writeSessions(ctx.registryPath, [entry]);
  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - dropped entries are pruned from disk too', () => {
  const ctx = makeCtx();
  const bad = validEntry('Pull Requests', new Date().toISOString(), { original_path: 'C:\\Windows' });
  const good = validEntry('email-lint');
  writeSessions(ctx.registryPath, [bad, good]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].session_name, 'email-lint');

  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
  assert.equal(onDisk.sessions[0].session_name, 'email-lint');
});

// --- 13-17: liveness -----------------------------------------------------------

test('listSessions - pid file holds a live pid -> running, pid present', () => {
  const livePids = new Set([555]);
  const ctx = makeCtx({ livePids });
  const entry = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '555', 'ascii');

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].pid, 555);
});

test('listSessions - pid file holds a dead pid -> pruned, pid file removed', () => {
  const ctx = makeCtx({ livePids: new Set() });
  const entry = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  const pidFilePath = path.join(ctx.pidDir, 'pull-requests.pid');
  fs.writeFileSync(pidFilePath, '4242', 'ascii');

  assert.deepEqual(listSessions(ctx), []);
  assert.equal(fs.existsSync(pidFilePath), false);
});

test('listSessions - no pid file, started_at 5s ago -> starting, pid null', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 5000).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'starting');
  assert.equal(views[0].pid, null);
});

test('listSessions - no pid file, started_at 10 minutes ago -> failed', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 10 * 60 * 1000).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'failed');
  assert.equal(views[0].pid, null);
  assert.equal(views[0].source, 'launched');
  assert.equal(views[0].session_id, null);
});

test('listSessions - no pid file, started_at 60s ago (past grace, inside retention) -> failed, and retained on disk', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'failed');
  assert.equal(views[0].pid, null);

  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
});

test('listSessions - no pid file, started_at past FAILED_RETENTION_MS -> pruned', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - (FAILED_RETENTION_MS + 60_000)).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  assert.deepEqual(listSessions(ctx), []);
  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 0);
});

test('listSessions - started_at far in the future -> dropped, not pinned as starting', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now + 60_000).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  assert.deepEqual(listSessions(ctx), []);
});

// A small backward clock step must NOT delete a launch that is very likely
// running: the owner's next tap would then spawn a duplicate session with the
// same name, which is the outcome this status exists to prevent.
test('listSessions - started_at 500ms in the future -> still starting, kept on disk', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now + 500).toISOString());
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'starting');

  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
});

test('listSessions - a failed-aged entry that DOES have a live pid file -> running (evidence beats the verdict)', () => {
  const now = Date.now();
  const livePids = new Set([777]);
  const ctx = makeCtx({ now: () => now, livePids });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString());
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '777', 'ascii');

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].pid, 777);
});

test('findLiveSession - null for a failed-aged entry, still returns a starting one', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const failedEntry = validEntry('Pull Requests', new Date(now - 60_000).toISOString());
  writeSessions(ctx.registryPath, [failedEntry]);
  assert.equal(findLiveSession(ctx, 'pull-requests'), null);

  const ctx2 = makeCtx({ now: () => now });
  const startingEntry = validEntry('Pull Requests', new Date(now - 5000).toISOString());
  writeSessions(ctx2.registryPath, [startingEntry]);
  assert.ok(findLiveSession(ctx2, 'pull-requests'));
});

test('recordLaunch - over an existing entry with the same session_name replaces it, not appends', () => {
  const ctx = makeCtx();
  const existing = validEntry('Pull Requests', new Date(Date.now() - 60_000).toISOString());
  writeSessions(ctx.registryPath, [existing]);

  const fixedNow = Date.parse('2026-08-26T00:00:00.000Z');
  recordLaunch({ ...ctx, now: () => fixedNow }, {
    sessionName: 'pull-requests',
    project: 'Pull Requests',
    projectPath: path.resolve(base, 'Pull Requests'),
  });

  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
  assert.equal(onDisk.sessions[0].started_at, new Date(fixedNow).toISOString());
});

test('listSessions - dead pid beats a fresh started_at (definitive wins over the grace window)', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now, livePids: new Set() });
  const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString());
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '4242', 'ascii');

  assert.deepEqual(listSessions(ctx), []);
});

// --- 18: pid-file junk table -----------------------------------------------------

test('listSessions - pid-file junk table treated as no pid (falls back to grace window)', () => {
  const now = Date.now();
  const junkValues = ['', '   ', 'abc', '-1', '0', '1.5', '1e9999'];
  for (const junk of junkValues) {
    const ctx = makeCtx({ now: () => now });
    const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString());
    writeSessions(ctx.registryPath, [entry]);
    fs.mkdirSync(ctx.pidDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), junk, 'ascii');

    const views = listSessions(ctx);
    assert.equal(views.length, 1, `junk: ${JSON.stringify(junk)}`);
    assert.equal(views[0].status, 'starting', `junk: ${JSON.stringify(junk)}`);
    assert.equal(views[0].pid, null, `junk: ${JSON.stringify(junk)}`);
  }
});

test('listSessions - a BOM-prefixed pid file is parsed correctly', () => {
  const livePids = new Set([1234]);
  const ctx = makeCtx({ livePids });
  const entry = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '\uFEFF1234', 'utf8');

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].pid, 1234);
});

// --- findLiveSession -------------------------------------------------------------

test('findLiveSession - returns the matching live SessionView', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [entry]);
  const found = findLiveSession(ctx, 'pull-requests');
  assert.ok(found);
  assert.equal(found.session_name, 'pull-requests');
});

test('findLiveSession - null when no session matches', () => {
  const ctx = makeCtx();
  assert.equal(findLiveSession(ctx, 'pull-requests'), null);
});

// --- 19-22: writes -----------------------------------------------------------------

test('recordLaunch - creates the parent directory when absent, and the file parses', () => {
  const ctx = makeCtx();
  // makeDataDirs()'s mkdtempSync already creates the immediate parent, so
  // nest one level deeper to actually exercise the "absent" case.
  ctx.registryPath = path.join(path.dirname(ctx.registryPath), 'nested', 'sessions.json');
  assert.equal(fs.existsSync(path.dirname(ctx.registryPath)), false);
  recordLaunch(ctx, { sessionName: 'pull-requests', project: 'Pull Requests', projectPath: path.resolve(base, 'Pull Requests') });
  assert.equal(fs.existsSync(ctx.registryPath), true);
  const parsed = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(parsed.version, REGISTRY_VERSION);
  assert.equal(parsed.sessions.length, 1);
});

test('recordLaunch - preserves pre-existing valid entries and appends', () => {
  const ctx = makeCtx();
  const existing = validEntry('email-lint');
  writeSessions(ctx.registryPath, [existing]);

  recordLaunch(ctx, { sessionName: 'pull-requests', project: 'Pull Requests', projectPath: path.resolve(base, 'Pull Requests') });

  const parsed = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(parsed.sessions.length, 2);
  assert.ok(parsed.sessions.some((s) => s.session_name === 'email-lint'));
  assert.ok(parsed.sessions.some((s) => s.session_name === 'pull-requests'));
});

test('recordLaunch - output has status starting, pid null, ISO started_at from ctx.now()', () => {
  const fixedNow = Date.parse('2026-08-25T21:14:03.123Z');
  const ctx = makeCtx({ now: () => fixedNow });
  const view = recordLaunch(ctx, { sessionName: 'pull-requests', project: 'Pull Requests', projectPath: path.resolve(base, 'Pull Requests') });
  assert.deepEqual(view, {
    session_name: 'pull-requests',
    project: 'Pull Requests',
    path: path.resolve(base, 'Pull Requests'),
    status: 'starting',
    started_at: new Date(fixedNow).toISOString(),
    pid: null,
  });
});

test('recordLaunch - no orphan .tmp file is left behind', () => {
  const ctx = makeCtx();
  recordLaunch(ctx, { sessionName: 'pull-requests', project: 'Pull Requests', projectPath: path.resolve(base, 'Pull Requests') });
  assert.equal(fs.existsSync(`${ctx.registryPath}.tmp`), false);
});

// --- 23: clearPidFile ----------------------------------------------------------------

test('clearPidFile - removes an existing file', () => {
  const ctx = makeCtx();
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  const pidFilePath = path.join(ctx.pidDir, 'pull-requests.pid');
  fs.writeFileSync(pidFilePath, '4242', 'ascii');
  clearPidFile(ctx, 'pull-requests');
  assert.equal(fs.existsSync(pidFilePath), false);
});

test('clearPidFile - silent no-op when the file is absent', () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => clearPidFile(ctx, 'pull-requests'));
});

// --- containment of the pid-file path -----------------------------------------
// pidFilePathFor is the one security-load-bearing line in T29 and was
// untested. It IS reachable with a string that did not come from
// deriveSessionName: listSessions drops entries by passing the registry
// file's RAW session_name to clearPidFile, before the deriveSessionName
// equality check runs. A tampered registry file is therefore attacker-
// influenced input into a path join.

test('clearPidFile - a traversing session_name cannot delete a file outside pidDir', () => {
  const { registryPath, pidDir } = makeDataDirs();
  fs.mkdirSync(pidDir, { recursive: true });

  // A file that must survive, one level above the pid dir.
  const outsideDir = path.dirname(pidDir);
  const victim = path.join(outsideDir, 'victim.pid');
  fs.writeFileSync(victim, '1234');

  const ctx = { registryPath, pidDir, sessionDirs: testSessionDirs(path.dirname(registryPath)), isPidAlive: () => false, now: () => Date.now() };

  for (const evil of ['../victim', '..\\victim', '../../victim', 'sub/../../victim']) {
    clearPidFile(ctx, evil);
  }

  assert.equal(
    fs.existsSync(victim),
    true,
    'a session_name containing traversal must not reach outside pidDir - '
    + 'pidFilePathFor must return null and clearPidFile must no-op',
  );
});

test('clearPidFile - a plain session name inside pidDir is still removed', () => {
  const { registryPath, pidDir } = makeDataDirs();
  fs.mkdirSync(pidDir, { recursive: true });
  const real = path.join(pidDir, 'email-lint.pid');
  fs.writeFileSync(real, '4242');

  clearPidFile({ registryPath, pidDir, sessionDirs: testSessionDirs(path.dirname(registryPath)), isPidAlive: () => false, now: () => Date.now() }, 'email-lint');

  assert.equal(fs.existsSync(real), false, 'the guard must not break the normal case');
});

// --- R1-R15: handoff / ended registry states -----------------------------------

test('listSessions - handoff entry with no pid file -> status handoff, pid null', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date(now - 1000).toISOString(),
  });
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'handoff');
  assert.equal(views[0].pid, null);
  assert.equal(views[0].source, 'launched');
  assert.equal(views[0].session_id, null);
});

test('listSessions - ended entry -> view carries ended_at, handoff_ok, handoff_result', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString(), {
    status: 'ended',
    ended_at: new Date(now - 1000).toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  });
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'ended');
  assert.equal(views[0].ended_at, entry.ended_at);
  assert.equal(views[0].handoff_ok, true);
  assert.equal(views[0].handoff_result, 'written');
  assert.equal(views[0].source, 'launched');
  assert.equal(views[0].session_id, null);
});

test('listSessions - running/starting views still carry exactly the eight original+source keys, source:launched, session_id:null', () => {
  const now = Date.now();
  const livePids = new Set([555]);
  const ctx = makeCtx({ now: () => now, livePids });
  const running = validEntry('Pull Requests', new Date(now - 1000).toISOString());
  const starting = validEntry('email-lint', new Date(now - 1000).toISOString());
  writeSessions(ctx.registryPath, [running, starting]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '555', 'ascii');

  const views = listSessions(ctx);
  assert.equal(views.length, 2);
  for (const v of views) {
    assert.deepEqual(
      Object.keys(v).sort(),
      ['path', 'pid', 'project', 'session_id', 'session_name', 'source', 'started_at', 'status'].sort(),
      `unexpected keys on status ${v.status}`,
    );
    assert.equal(v.source, 'launched', `status ${v.status}`);
    assert.equal(v.session_id, null, `status ${v.status}`);
  }
});

test('listSessions - ended record inside FAILED_RETENTION_MS survives', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString(), {
    status: 'ended',
    ended_at: new Date(now - (FAILED_RETENTION_MS - 60_000)).toISOString(),
    handoff_ok: false,
    handoff_result: 'not_written',
  });
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
});

test('listSessions - ended record past FAILED_RETENTION_MS is pruned and written back', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString(), {
    status: 'ended',
    ended_at: new Date(now - (FAILED_RETENTION_MS + 1000)).toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  });
  writeSessions(ctx.registryPath, [entry]);

  assert.deepEqual(listSessions(ctx), []);
  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 0);
});

test('listSessions - handoff past HANDOFF_TIMEOUT_MS but inside 24h -> ended / interrupted', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const handoffStarted = new Date(now - (HANDOFF_TIMEOUT_MS + 60_000)).toISOString();
  const entry = validEntry('Pull Requests', new Date(now - (HANDOFF_TIMEOUT_MS + 120_000)).toISOString(), {
    status: 'handoff',
    handoff_started_at: handoffStarted,
  });
  writeSessions(ctx.registryPath, [entry]);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'ended');
  assert.equal(views[0].handoff_ok, false);
  assert.equal(views[0].handoff_result, 'interrupted');
  assert.equal(views[0].ended_at, handoffStarted);
});

test('listSessions - handoff entry past FAILED_RETENTION_MS is pruned', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - (FAILED_RETENTION_MS + 120_000)).toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date(now - (FAILED_RETENTION_MS + 60_000)).toISOString(),
  });
  writeSessions(ctx.registryPath, [entry]);

  assert.deepEqual(listSessions(ctx), []);
});

test('listSessions - drop table for malformed handoff/ended/unknown status entries', () => {
  const now = Date.now();
  const rows = [
    { status: 'handoff', handoff_started_at: 'not-a-date' },
    { status: 'ended', ended_at: 'not-a-date', handoff_ok: true, handoff_result: 'written' },
    { status: 'ended', ended_at: new Date(now).toISOString(), handoff_ok: 'yes', handoff_result: 'written' },
    { status: 'nonsense' },
  ];
  for (const overrides of rows) {
    const ctx = makeCtx({ now: () => now });
    const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString(), overrides);
    writeSessions(ctx.registryPath, [entry]);
    assert.deepEqual(listSessions(ctx), [], `overrides: ${JSON.stringify(overrides)}`);
  }
});

test('findLiveSession - returns a handoff entry (blocks relaunch)', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date(now - 1000).toISOString(),
  });
  writeSessions(ctx.registryPath, [entry]);

  const found = findLiveSession(ctx, 'pull-requests');
  assert.ok(found);
  assert.equal(found.status, 'handoff');
});

test('findLiveSession - null for an ended record (does not block relaunch)', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString(), {
    status: 'ended',
    ended_at: new Date(now - 1000).toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  });
  writeSessions(ctx.registryPath, [entry]);

  assert.equal(findLiveSession(ctx, 'pull-requests'), null);
});

test('recordLaunch - replaces an ended record with the same session_name rather than accumulating', () => {
  const ctx = makeCtx();
  const ended = validEntry('Pull Requests', new Date(Date.now() - 60_000).toISOString(), {
    status: 'ended',
    ended_at: new Date().toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  });
  writeSessions(ctx.registryPath, [ended]);

  recordLaunch(ctx, {
    sessionName: 'pull-requests',
    project: 'Pull Requests',
    projectPath: path.resolve(base, 'Pull Requests'),
  });

  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions.length, 1);
  assert.equal(onDisk.sessions[0].status, undefined);
});

test('markSessionState - patches when fromStatus matches, returns true', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', new Date().toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date().toISOString(),
  });
  writeSessions(ctx.registryPath, [entry]);

  const patched = markSessionState(ctx, 'pull-requests', 'handoff', {
    status: 'ended',
    ended_at: new Date().toISOString(),
    handoff_ok: true,
    handoff_result: 'written',
  });

  assert.equal(patched, true);
  const onDisk = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8'));
  assert.equal(onDisk.sessions[0].status, 'ended');
  assert.equal(onDisk.sessions[0].handoff_result, 'written');
});

test('markSessionState - returns false and leaves the file byte-identical when fromStatus does not match', () => {
  const ctx = makeCtx();
  const entry = validEntry('Pull Requests', new Date().toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date().toISOString(),
  });
  writeSessions(ctx.registryPath, [entry]);
  const before = fs.readFileSync(ctx.registryPath, 'utf8');

  const patched = markSessionState(ctx, 'pull-requests', null, { status: 'ended' });

  assert.equal(patched, false);
  const after = fs.readFileSync(ctx.registryPath, 'utf8');
  assert.equal(after, before);
});

test('dropSession - removes only the entry whose status matches fromStatus', () => {
  const ctx = makeCtx();
  const handoff = validEntry('Pull Requests', new Date().toISOString(), {
    status: 'handoff',
    handoff_started_at: new Date().toISOString(),
  });
  const other = validEntry('email-lint');
  writeSessions(ctx.registryPath, [handoff, other]);

  dropSession(ctx, 'pull-requests', 'handoff');

  const left = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf8')).sessions;
  assert.deepEqual(left.map((e) => e.session_name), ['email-lint']);
});

test('dropSession - leaves a same-name entry alone when its status is not fromStatus', () => {
  const ctx = makeCtx();
  // The shape a concurrent relaunch writes: same name, no status field.
  const relaunched = validEntry('Pull Requests');
  writeSessions(ctx.registryPath, [relaunched]);
  const before = fs.readFileSync(ctx.registryPath, 'utf8');

  dropSession(ctx, 'pull-requests', 'handoff');

  assert.equal(fs.readFileSync(ctx.registryPath, 'utf8'), before);
});

test('markSessionState - returns false and leaves the file byte-identical when the atomic write fails', () => {
  const ctx = makeCtx();
  writeSessions(ctx.registryPath, [validEntry('Pull Requests')]);
  const before = fs.readFileSync(ctx.registryPath, 'utf8');
  // A directory where the temp file goes makes writeFileSync(tmp) throw, so
  // the rename never happens - the same shape as a transient EPERM on
  // Windows. The claim must report that, not a success that never landed.
  fs.mkdirSync(`${ctx.registryPath}.tmp`);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const claimed = markSessionState(ctx, 'pull-requests', null, { status: 'handoff' });
    assert.equal(claimed, false);
    assert.equal(fs.readFileSync(ctx.registryPath, 'utf8'), before);
  } finally {
    console.warn = warn;
  }
});

test('markSessionState - never appends for a session name that is absent', () => {
  const ctx = makeCtx();

  const patched = markSessionState(ctx, 'no-such-session', null, { status: 'handoff' });

  assert.equal(patched, false);
  assert.equal(fs.existsSync(ctx.registryPath), false);
});

// --- desk-started session discovery --------------------------------------

/** Writes <dir>/<pid>.json in the shape Claude Code 2.1.246 writes it. */
function writeDeskFile(dir, { pid, sessionId, cwd, startedAt = new Date().toISOString(), kind = 'interactive' }) {
  fs.mkdirSync(dir, { recursive: true });
  const data = { pid, cwd, startedAt, kind, entrypoint: 'cli', status: 'idle', updatedAt: startedAt };
  if (sessionId !== undefined) data.sessionId = sessionId;
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(data), 'utf8');
}

test('discoverDeskSessions - startedAt as epoch milliseconds (what Claude Code really writes) is accepted', () => {
  const livePids = new Set([4243]);
  const ctx = makeCtx({ livePids });
  const cwd = path.join(base, 'Pull Requests');
  const startedAt = 1787768790707; // a real value copied from ~/.claude-max/sessions/<pid>.json
  writeDeskFile(ctx.sessionDirs[0], { pid: 4243, sessionId: 'abc-124', cwd, startedAt });

  const views = discoverDeskSessions(ctx, listProjects(base), new Set());
  assert.equal(views.length, 1);
  assert.equal(views[0].started_at, new Date(startedAt).toISOString());
});

test('discoverDeskSessions - alive pid + exact project cwd + no registry entry -> one desk view', () => {
  const livePids = new Set([4242]);
  const ctx = makeCtx({ livePids });
  const cwd = path.join(base, 'Pull Requests');
  writeDeskFile(ctx.sessionDirs[0], { pid: 4242, sessionId: 'abc-123', cwd });

  const views = discoverDeskSessions(ctx, listProjects(base), new Set());
  assert.equal(views.length, 1);
  assert.equal(views[0].source, 'desk');
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].pid, 4242);
  assert.equal(views[0].session_id, 'abc-123');
  assert.equal(views[0].session_name, 'pull-requests');
  assert.equal(views[0].project, 'Pull Requests');
  assert.equal(views[0].path, path.join(base, 'Pull Requests'));
  assert.equal(views[0].config_dir, path.dirname(ctx.sessionDirs[0]));
  assert.ok(Number.isFinite(Date.parse(views[0].started_at)));

  // Also reachable through the normal entry point, with NO registry file on
  // disk at all - the case desk-started session discovery exists for (a machine that has never
  // launched anything through the agent).
  assert.equal(fs.existsSync(ctx.registryPath), false);
  assert.equal(listSessions(ctx).length, 1);
});

test('discoverDeskSessions - dead pid -> not listed', () => {
  const ctx = makeCtx({ livePids: new Set() });
  writeDeskFile(ctx.sessionDirs[0], { pid: 4243, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests') });
  assert.deepEqual(listSessions(ctx), []);
});

test('discoverDeskSessions - kind !== interactive (the hidden `claude -p` handoff run) -> not listed', () => {
  const ctx = makeCtx({ livePids: new Set([4244]) });
  writeDeskFile(ctx.sessionDirs[0], {
    pid: 4244, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests'), kind: 'print',
  });
  assert.deepEqual(
    listSessions(ctx),
    [],
    'kind:print (the handoff run) must stay invisible - this is what keeps it from ever surfacing as a session',
  );
});

test('discoverDeskSessions - cwd is a subfolder of a project -> listed under that project (owner, 2026-08-27)', () => {
  const ctx = makeCtx({ livePids: new Set([4245]) });
  writeDeskFile(ctx.sessionDirs[0], {
    pid: 4245, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests', 'sub'),
  });
  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].project, 'Pull Requests');
  assert.equal(views[0].pid, 4245);
});

test('discoverDeskSessions - a sibling folder whose name merely starts with the project name is NOT inside it', () => {
  const ctx = makeCtx({ livePids: new Set([4247]) });
  writeDeskFile(ctx.sessionDirs[0], { pid: 4247, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests-2') });
  assert.deepEqual(listSessions(ctx), []);
});

test('discoverDeskSessions - cwd outside baseDir -> not listed', () => {
  const ctx = makeCtx({ livePids: new Set([4246]) });
  writeDeskFile(ctx.sessionDirs[0], { pid: 4246, sessionId: 'abc-123', cwd: os.tmpdir() });
  assert.deepEqual(listSessions(ctx), []);
});

test('discoverDeskSessions - a registry entry for the project wins over a live desk file', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now, livePids: new Set([555, 4247]) });
  const entry = validEntry('Pull Requests', new Date(now - 1000).toISOString());
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'pull-requests.pid'), '555', 'ascii');
  writeDeskFile(ctx.sessionDirs[0], { pid: 4247, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests') });

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].source, 'launched');
  assert.equal(views[0].status, 'running');
});

test('discoverDeskSessions - a registry entry still wins even when its status is ended', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now, livePids: new Set([4248]) });
  const entry = validEntry('Pull Requests', new Date(now - 60_000).toISOString(), {
    status: 'ended', ended_at: new Date(now - 1000).toISOString(), handoff_ok: true, handoff_result: 'written',
  });
  writeSessions(ctx.registryPath, [entry]);
  writeDeskFile(ctx.sessionDirs[0], { pid: 4248, sessionId: 'abc-123', cwd: path.join(base, 'Pull Requests') });

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].source, 'launched');
  assert.equal(views[0].status, 'ended');
});

test('discoverDeskSessions - two desk files, same cwd, different startedAt -> newest wins', () => {
  const ctx = makeCtx({ livePids: new Set([4249, 4250]) });
  const cwd = path.join(base, 'Pull Requests');
  writeDeskFile(ctx.sessionDirs[0], {
    pid: 4249, sessionId: 'older', cwd, startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  writeDeskFile(ctx.sessionDirs[0], {
    pid: 4250, sessionId: 'newer', cwd, startedAt: new Date().toISOString(),
  });

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].pid, 4250);
  assert.equal(views[0].session_id, 'newer');
});

test('discoverDeskSessions - two desk files in two different sessionDirs, same cwd -> newest wins across profiles', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-registry-data2-'));
  perTestDirs.push(dir2);
  const ctx = makeCtx({ livePids: new Set([4251, 4252]) });
  ctx.sessionDirs = [ctx.sessionDirs[0], path.join(dir2, 'claude-sessions-2')];
  const cwd = path.join(base, 'Pull Requests');
  writeDeskFile(ctx.sessionDirs[0], {
    pid: 4251, sessionId: 'profile-a', cwd, startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  writeDeskFile(ctx.sessionDirs[1], {
    pid: 4252, sessionId: 'profile-b', cwd, startedAt: new Date().toISOString(),
  });

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].session_id, 'profile-b');
});

test('discoverDeskSessions - sessionDirs pointing at a missing directory -> no throw, registry view unaffected', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now, livePids: new Set([555]) });
  ctx.sessionDirs = [path.join(base, 'does-not-exist')];
  const entry = validEntry('email-lint', new Date(now - 1000).toISOString());
  writeSessions(ctx.registryPath, [entry]);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, 'email-lint.pid'), '555', 'ascii');

  assert.doesNotThrow(() => listSessions(ctx));
  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].source, 'launched');
});

test('discoverDeskSessions - junk table: bad JSON / array / missing pid / missing cwd / unparseable startedAt all skipped, no throw', () => {
  const ctx = makeCtx({ livePids: new Set([4260]) });
  const dir = ctx.sessionDirs[0];
  const cwd = path.join(base, 'Pull Requests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notjson.json'), 'not json at all', 'utf8');
  fs.writeFileSync(path.join(dir, 'array.json'), '[]', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'nopid.json'),
    JSON.stringify({ sessionId: 'x', cwd, startedAt: new Date().toISOString(), kind: 'interactive' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'nocwd.json'),
    JSON.stringify({ pid: 4261, sessionId: 'x', startedAt: new Date().toISOString(), kind: 'interactive' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'badstart.json'),
    JSON.stringify({ pid: 4262, sessionId: 'x', cwd, startedAt: 'not-a-date', kind: 'interactive' }),
    'utf8',
  );
  writeDeskFile(dir, { pid: 4260, sessionId: 'good', cwd });

  assert.doesNotThrow(() => listSessions(ctx));
  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].pid, 4260);
});

test('discoverDeskSessions - sessionId missing or malformed -> still listed with session_id null', () => {
  const cwd = path.join(base, 'Pull Requests');
  const cases = [
    { sessionId: undefined, label: 'missing' },
    { sessionId: 'a b', label: 'contains a space' },
    { sessionId: '-x', label: 'leading hyphen' },
    { sessionId: 'x'.repeat(200), label: '200 chars' },
  ];
  for (const { sessionId, label } of cases) {
    const ctx = makeCtx({ livePids: new Set([9001]) });
    writeDeskFile(ctx.sessionDirs[0], { pid: 9001, sessionId, cwd });

    const views = listSessions(ctx);
    assert.equal(views.length, 1, label);
    assert.equal(views[0].session_id, null, label);
    assert.equal(views[0].pid, 9001, label);
  }
});

test('discoverDeskSessions - credential guard: only *.json is ever opened', () => {
  const ctx = makeCtx({ livePids: new Set([4280]) });
  const dir = ctx.sessionDirs[0];
  writeDeskFile(dir, { pid: 4280, sessionId: 'abc', cwd: path.join(base, 'Pull Requests') });
  fs.writeFileSync(path.join(dir, '.credentials.txt'), 'NEVER-OPEN-THIS', 'utf8');
  fs.writeFileSync(path.join(dir, 'token.pem'), 'NEVER-OPEN-THIS', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes'), 'NEVER-OPEN-THIS', 'utf8');

  // The node:fs default export is the same object registry.js calls
  // through, so wrapping it here is visible there too.
  const realReadFileSync = fs.readFileSync;
  const seen = [];
  fs.readFileSync = (p, ...rest) => {
    seen.push(p);
    return realReadFileSync(p, ...rest);
  };
  try {
    const views = listSessions(ctx);
    assert.equal(views.length, 1, 'the desk session must still be listed');
    assert.ok(seen.length > 0, 'the wrapper must have observed at least one read');
    for (const p of seen) {
      assert.ok(String(p).endsWith('.json'), `a non-.json path was opened: ${p}`);
    }
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test('resolveDeskSessionId - { sessionId, configDir } of the newest live match, subfolder counts, null when dead/dir missing', () => {
  const cwd = path.join(base, 'Pull Requests');

  {
    const ctx = makeCtx({ livePids: new Set([4290, 4291]) });
    writeDeskFile(ctx.sessionDirs[0], {
      pid: 4290, sessionId: 'older', cwd, startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    writeDeskFile(ctx.sessionDirs[0], {
      pid: 4291, sessionId: 'newer', cwd, startedAt: new Date().toISOString(),
    });
    assert.deepEqual(
      resolveDeskSessionId(ctx, cwd),
      { sessionId: 'newer', configDir: path.dirname(ctx.sessionDirs[0]) },
    );
  }

  {
    const ctx = makeCtx({ livePids: new Set() });
    writeDeskFile(ctx.sessionDirs[0], { pid: 4292, sessionId: 'dead', cwd });
    assert.deepEqual(resolveDeskSessionId(ctx, cwd), { sessionId: null, configDir: null });
  }

  {
    const ctx = makeCtx({ livePids: new Set([4293]) });
    writeDeskFile(ctx.sessionDirs[0], { pid: 4293, sessionId: 'sub', cwd: path.join(cwd, 'sub') });
    // A subfolder session belongs to the project (owner, 2026-08-27), so STOP resumes it.
    assert.deepEqual(resolveDeskSessionId(ctx, cwd), { sessionId: 'sub', configDir: path.dirname(ctx.sessionDirs[0]) });
  }

  {
    const ctx = makeCtx({ livePids: new Set() });
    ctx.sessionDirs = [path.join(base, 'no-such-dir')];
    assert.deepEqual(resolveDeskSessionId(ctx, cwd), { sessionId: null, configDir: null });
  }
});

test('claimDeskSession - writes a handoff entry listSessions then reports, and returns false when already claimed', () => {
  const now = Date.now();
  const ctx = makeCtx({ now: () => now });
  const projectPath = path.join(base, 'Pull Requests');
  const startedAt = new Date(now - 60_000).toISOString();
  const handoffStartedAt = new Date(now - 1000).toISOString();

  const claimed = claimDeskSession(ctx, {
    sessionName: 'pull-requests', project: 'Pull Requests', projectPath, startedAt, handoffStartedAt,
  });
  assert.equal(claimed, true);

  const views = listSessions(ctx);
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'handoff');
  assert.equal(views[0].session_name, 'pull-requests');

  const second = claimDeskSession(ctx, {
    sessionName: 'pull-requests', project: 'Pull Requests', projectPath, startedAt, handoffStartedAt,
  });
  assert.equal(second, false, 'a second claim on the same session_name must write nothing and return false');
});
