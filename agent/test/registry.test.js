import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { deriveSessionName } from '../sessions.js';
import {
  STARTING_GRACE_MS,
  FAILED_RETENTION_MS,
  REGISTRY_VERSION,
  isPidAlive,
  listSessions,
  findLiveSession,
  recordLaunch,
  clearPidFile,
} from '../registry.js';

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

  const ctx = { registryPath, pidDir, isPidAlive: () => false, now: () => Date.now() };

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

  clearPidFile({ registryPath, pidDir, isPidAlive: () => false, now: () => Date.now() }, 'email-lint');

  assert.equal(fs.existsSync(real), false, 'the guard must not break the normal case');
});
