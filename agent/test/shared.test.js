import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  MAX_SHARED_ROOTS, systemDirsFor, isInsideOrEqual, validateSharedEntry,
} from '../shared.js';
import { resolveSharedFolders, writeConfig } from '../config.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

// The temp-drive problem, same fixture technique as folders.test.js: make
// the temp drive an ALLOWED fixed drive and block a letter nothing uses, so
// route tests never need to leave os.tmpdir() and never need to touch a real
// system folder.
// Canonical from the start: a TEMP given as an 8.3 short path (CI's RUNNER~1)
// would otherwise never equal the long-name `real` the junction tests expect.
const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-shared-')));
const tmpLetter = path.parse(path.resolve(tmpRoot)).root.replace(/[\\/]+$/, '').toUpperCase();
const [blockedLetter, unknownLetter] = ['Q:', 'Y:', 'X:', 'W:'].filter((l) => l !== tmpLetter);
void unknownLetter; // unused in this file; kept for parity with folders.test.js's fixture block

const driveRows = [
  { DeviceID: tmpLetter, VolumeName: 'Test' },
  { DeviceID: blockedLetter, VolumeName: 'Sys' },
];
// The shape listDrives()'s `drives` array takes. Used for pure unit tests
// that never touch a real server.
const DRIVES = [
  { letter: tmpLetter, label: 'Test', blocked: false },
  { letter: blockedLetter, label: 'Sys', blocked: true, reason: 'system' },
];
const DRIVES_WITH_TMP_BLOCKED = [
  { letter: tmpLetter, label: 'Test', blocked: true, reason: 'system' },
  { letter: blockedLetter, label: 'Sys', blocked: false },
];

function fakeExec(rows) {
  return async () => JSON.stringify(rows);
}

function p(...parts) {
  return path.join(tmpRoot, ...parts);
}

// Directories the spec's fixture (10.0) asks for.
fs.mkdirSync(p('one'));
fs.mkdirSync(p('two'));
fs.mkdirSync(p('one', 'inner'));
fs.mkdirSync(p('onetwo')); // for test 19 - 'one' must not be an ancestor of this
fs.mkdirSync(p('outside'));
fs.mkdirSync(p('outside', 'child'));
fs.mkdirSync(p('home'));
fs.mkdirSync(p('fake-system'));
fs.mkdirSync(p('fake-system', 'deep'));
fs.writeFileSync(p('a-file.txt'), 'x');
fs.symlinkSync(p('outside'), p('home', 'link'), 'junction');
{
  const st = fs.lstatSync(p('home', 'link'));
  if (!st.isSymbolicLink()) {
    throw new Error('junction creation did not produce a reparse point on this host - test cannot proceed');
  }
}

// 33 sibling, non-overlapping directories for the cap test (row 6).
const capDirs = [];
for (let i = 0; i < MAX_SHARED_ROOTS + 1; i += 1) {
  const d = p(`cap-${i}`);
  fs.mkdirSync(d);
  capDirs.push(d);
}

// ============================================================
// Route tests - PUT /api/shared, through the real HTTP server, sharing one
// server where the request never touches a real filesystem outside tmpRoot.
// ============================================================

const authCtx = makeAuthCtx();
seedPasscode(authCtx, '481902');
const token = issueTestToken(authCtx);
const ctx = {
  baseDir: tmpRoot,
  driveExec: fakeExec(driveRows),
  systemDrive: blockedLetter,
  systemDirs: [p('fake-system')],
  ...authCtx,
};
const server = fixtureServer(ctx);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const authedFetch = makeAuthedFetch(origin, token);

// Every authenticated PUT in this file carries the current passcode -
// seeded '481902' above - so the new gate never intercepts a test written
// before it existed. Merged in, never overridden: a call testing a specific
// passcode value passes its own.
function putShared(body) {
  return authedFetch('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', ...body }) });
}

after(() => {
  server.close();
  cleanupAuthCtx(authCtx);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('1 - valid single root round-trips through resolveSharedFolders with exactly the four-key entry', async () => {
  // RED WHEN: the write does not round-trip through the config reader - wrong key
  // names, a fifth key, or a path form the reader re-normalises.
  const expected = { path: p('one'), mode: 'container', excludes: ['Archive'], new_folders: 'show' };
  const res = await putShared({ shared_folders: [expected] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.shared_folders, [expected]);
  assert.deepEqual(resolveSharedFolders(ctx.configPath), [expected]);
});

test('2 - two-root valid write, non-overlapping, stores both in order', async () => {
  // RED WHEN: the route stores only the first, or sorts/dedupes silently.
  const res = await putShared({ shared_folders: [{ path: p('two') }, { path: p('outside') }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.shared_folders.map((e) => e.path), [p('two'), p('outside')]);
});

test('3 - a rejected write leaves the config file byte-identical, directory listing included', async () => {
  // RED WHEN: any validation moves after the write, or a .tmp file is left behind.
  const seeded = await putShared({ shared_folders: [{ path: p('one') }] });
  assert.equal(seeded.status, 200);
  const before = fs.readFileSync(ctx.configPath);
  const beforeDir = fs.readdirSync(path.dirname(ctx.configPath)).sort();

  const res = await putShared({ shared_folders: [{ path: p('one') }, { path: 12345 }] });
  assert.equal(res.status, 400);

  assert.deepEqual(fs.readFileSync(ctx.configPath), before);
  assert.deepEqual(fs.readdirSync(path.dirname(ctx.configPath)).sort(), beforeDir);
});

test('4 - a write PRESERVES acknowledged_at and an unrelated key seeded in the config first', async () => {
  // RED WHEN: the write replaces the whole object instead of merging.
  writeConfig(ctx.configPath, { acknowledged_at: '2026-01-01T00:00:00.000Z', colour: 'green', shared_folders: [] });
  const res = await putShared({ shared_folders: [{ path: p('two') }] });
  assert.equal(res.status, 200);
  const config = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
  assert.equal(config.acknowledged_at, '2026-01-01T00:00:00.000Z');
  assert.equal(config.colour, 'green');
  assert.deepEqual(config.shared_folders, [{ path: p('two'), mode: 'container', excludes: [], new_folders: 'show' }]);
});

test('5 - empty array unshares everything and is NOT re-migrated from default_base_folder', async () => {
  // RED WHEN: someone adds a minimum-length guard, or the reader's
  // presence-not-truthiness rule is broken from the write side.
  writeConfig(ctx.configPath, { default_base_folder: p('one') });
  const res = await putShared({ shared_folders: [] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.shared_folders, []);
  const config = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
  assert.deepEqual(config.shared_folders, []);
  assert.deepEqual(resolveSharedFolders(ctx.configPath), []);
});

test('6 - 32 roots succeed; 33 roots -> 400 too_many_roots, no index', async () => {
  // RED WHEN: the cap is off by one, or is checked after the per-entry loop.
  const ok32 = await putShared({ shared_folders: capDirs.slice(0, MAX_SHARED_ROOTS).map((d) => ({ path: d })) });
  assert.equal(ok32.status, 200);
  const bad33 = await putShared({ shared_folders: capDirs.map((d) => ({ path: d })) });
  assert.equal(bad33.status, 400);
  assert.deepEqual(await bad33.json(), { error: 'too_many_roots' });
});

test('7 - non-array shared_folders -> 400 invalid_request, no index', async () => {
  // RED WHEN: the array check is dropped and .length throws into a 500.
  for (const value of ['x', 5, null, {}]) {
    const res = await putShared({ shared_folders: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.deepEqual(await res.json(), { error: 'invalid_request' }, JSON.stringify(value));
  }
  const absent = await putShared({});
  assert.equal(absent.status, 400);
  assert.deepEqual(await absent.json(), { error: 'invalid_request' });
});

test('8 - path on the blocked drive -> 400 blocked_drive, index 0', async () => {
  // RED WHEN: the blocked check is taken from a client-supplied flag instead
  // of re-derived.
  const res = await putShared({ shared_folders: [{ path: `${blockedLetter}\\Windows` }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'blocked_drive', index: 0 });
});

test('9 - a whole drive root -> 400 drive_root', async () => {
  // RED WHEN: the root comparison is written against a stripped form and never matches.
  const res = await putShared({ shared_folders: [{ path: `${tmpLetter}\\` }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'drive_root', index: 0 });
});

test('10 - inside the injected system dir, and the system dir itself, both -> 400 system_directory', async () => {
  // RED WHEN: "or anything inside them" is implemented as equality only.
  const inside = await putShared({ shared_folders: [{ path: p('fake-system', 'deep') }] });
  assert.equal(inside.status, 400);
  assert.deepEqual(await inside.json(), { error: 'system_directory', index: 0 });

  const itself = await putShared({ shared_folders: [{ path: p('fake-system') }] });
  assert.equal(itself.status, 400);
  assert.deepEqual(await itself.json(), { error: 'system_directory', index: 0 });
});

test('11 - V1-V4 shape rejections carry the matching error string and index', async () => {
  // RED WHEN: any of V1-V4 is skipped because "the picker would never send that".
  const longPath = `${tmpLetter}\\${'a'.repeat(260)}`;
  const cases = [
    ['\\\\server\\share', 'invalid_path'],
    ['\\\\?\\C:\\', 'invalid_path'],
    ['/etc', 'invalid_path'],
    ['C:foo', 'invalid_path'],
    [`${p('one')}%2e`, 'invalid_path'],
    [`${p('one')}\u0007`, 'invalid_path'],
    [longPath, 'invalid_request'],
  ];
  for (const [raw, error] of cases) {
    const res = await putShared({ shared_folders: [{ path: raw }] });
    assert.equal(res.status, 400, raw);
    assert.deepEqual(await res.json(), { error, index: 0 }, raw);
  }
});

test('12 - a path that does not exist -> 400 not_found', async () => {
  // RED WHEN: the sharing write calls validateFolderPath instead of resolveRealFolderPath
  // - the pure validator makes no filesystem call, so a nonexistent path
  // passes it.
  const res = await putShared({ shared_folders: [{ path: p('does-not-exist') }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'not_found', index: 0 });
});

test('13 - a FILE path -> 400 not_found', async () => {
  // RED WHEN: same as 12, plus statSync replacing lstatSync.
  const res = await putShared({ shared_folders: [{ path: p('a-file.txt') }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'not_found', index: 0 });
});

test('14 - the junction itself -> 400 not_found', async () => {
  // RED WHEN: V6 is dropped or V7 is used to replace it rather than run after it.
  const res = await putShared({ shared_folders: [{ path: p('home', 'link') }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'not_found', index: 0 });
});

test('15 - invalid mode values rejected; absent defaults to container', async () => {
  // RED WHEN: a bad value is silently coerced to the default (sanitizing at
  // the boundary).
  for (const mode of ['SINGLE', 'nope', 5, null]) {
    const res = await putShared({ shared_folders: [{ path: p('one'), mode }] });
    assert.equal(res.status, 400, String(mode));
    assert.deepEqual(await res.json(), { error: 'invalid_mode', index: 0 }, String(mode));
  }
  const ok = await putShared({ shared_folders: [{ path: p('one') }] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).shared_folders[0].mode, 'container');
});

test('16 - invalid new_folders values rejected; absent -> show; hide -> stored', async () => {
  // RED WHEN: a bad value is silently coerced to the default.
  for (const newFolders of ['HIDE', 'maybe']) {
    const res = await putShared({ shared_folders: [{ path: p('one'), new_folders: newFolders }] });
    assert.equal(res.status, 400, newFolders);
    assert.deepEqual(await res.json(), { error: 'invalid_new_folders', index: 0 }, newFolders);
  }
  const absent = await putShared({ shared_folders: [{ path: p('one') }] });
  assert.equal((await absent.json()).shared_folders[0].new_folders, 'show');
  const hide = await putShared({ shared_folders: [{ path: p('one'), new_folders: 'hide' }] });
  assert.equal((await hide.json()).shared_folders[0].new_folders, 'hide');
});

test('17 - excludes must be plain names; legitimate names pass verbatim', async () => {
  // RED WHEN: separators or '..' are allowed through (an exclude then stops
  // being a NAME), or the check is over-tightened by reusing
  // validateProjectName and a legitimate '.git' / '50% done' exclude becomes
  // impossible.
  const badExcludeLists = ['x', 5, ['a\\b'], ['a/b'], ['..'], ['.'], [''], ['C:'], ['\u0007'], [5]];
  for (const excludes of badExcludeLists) {
    const res = await putShared({ shared_folders: [{ path: p('one'), excludes }] });
    assert.equal(res.status, 400, JSON.stringify(excludes));
    assert.deepEqual(await res.json(), { error: 'invalid_excludes', index: 0 }, JSON.stringify(excludes));
  }
  const good = ['Archive', 'old stuff', '50% done', '.git'];
  const res = await putShared({ shared_folders: [{ path: p('one'), excludes: good }] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).shared_folders[0].excludes, good);
});

test('18 - overlap: ancestor/descendant pair rejected either order, index is the later row', async () => {
  // RED WHEN: the check only looks one direction (ancestor but not descendant).
  const a = await putShared({ shared_folders: [{ path: p('one') }, { path: p('one', 'inner') }] });
  assert.equal(a.status, 409);
  assert.deepEqual(await a.json(), { error: 'overlapping_root', index: 1 });

  const b = await putShared({ shared_folders: [{ path: p('one', 'inner') }, { path: p('one') }] });
  assert.equal(b.status, 409);
  assert.deepEqual(await b.json(), { error: 'overlapping_root', index: 1 });
});

test('19 - "one" is NOT an ancestor of "onetwo" - no false-positive overlap', async () => {
  // RED WHEN: the comparer is a bare startsWith without the separator.
  const res = await putShared({ shared_folders: [{ path: p('one') }, { path: p('onetwo') }] });
  assert.equal(res.status, 200);
});

test('20 - duplicates in every form (exact, case-different, trailing separator) -> 409 overlapping_root', async () => {
  // RED WHEN: the comparer does not fold case, or duplicates are silently deduped.
  const exact = await putShared({ shared_folders: [{ path: p('one') }, { path: p('one') }] });
  assert.equal(exact.status, 409);
  assert.deepEqual(await exact.json(), { error: 'overlapping_root', index: 1 });

  const caseDiff = await putShared({ shared_folders: [{ path: p('one') }, { path: p('one').toUpperCase() }] });
  assert.equal(caseDiff.status, 409);
  assert.deepEqual(await caseDiff.json(), { error: 'overlapping_root', index: 1 });

  const trailing = await putShared({ shared_folders: [{ path: p('one') }, { path: `${p('one')}\\` }] });
  assert.equal(trailing.status, 409);
  assert.deepEqual(await trailing.json(), { error: 'overlapping_root', index: 1 });
});

test('21 - overlap is computed on the CANONICAL path: an intermediate-junction root and its lexical target-parent overlap', async () => {
  // RED WHEN: the overlap check runs on the lexical `resolved` - the junction-vs-lexical
  // hole class at a new site.
  const res = await putShared({ shared_folders: [{ path: p('home', 'link', 'child') }, { path: p('outside') }] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'overlapping_root', index: 1 });
});

test('22 - system-dir check is computed on the CANONICAL path: an intermediate junction into a forbidden dir -> 400 system_directory', async () => {
  // RED WHEN: the system-dir check runs on `resolved` only, so an
  // intermediate junction smuggles a root into a forbidden location.
  const authCtx22 = makeAuthCtx();
  seedPasscode(authCtx22, '481902');
  const token22 = issueTestToken(authCtx22);
  const ctx22 = {
    baseDir: tmpRoot,
    driveExec: fakeExec(driveRows),
    systemDrive: blockedLetter,
    systemDirs: [p('outside')],
    ...authCtx22,
  };
  const server22 = fixtureServer(ctx22);
  await new Promise((resolve) => server22.listen(0, '127.0.0.1', resolve));
  try {
    const fetch22 = makeAuthedFetch(`http://127.0.0.1:${server22.address().port}`, token22);
    const res = await fetch22('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', shared_folders: [{ path: p('home', 'link', 'child') }] }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'system_directory', index: 0 });
  } finally {
    server22.close();
    cleanupAuthCtx(authCtx22);
  }
});

test('23 - validateSharedEntry canonicalises an intermediate junction (asserts the VALUE, not a status)', () => {
  // RED WHEN: the realpath call is removed or applied to something other
  // than the full resolved path.
  const result = validateSharedEntry({ path: p('home', 'link', 'child') }, DRIVES, []);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.real.toUpperCase(), path.join(tmpRoot, 'outside', 'child').toUpperCase());
});

test('24 - blocked drive is re-checked on the canonical path', () => {
  // RED WHEN: the drive re-check is dropped.
  const result = validateSharedEntry({ path: p('home', 'link', 'child') }, DRIVES_WITH_TMP_BLOCKED, []);
  assert.equal(result.ok, false);
  assert.ok(['blocked_drive', 'not_found'].includes(result.error), result.error);
});

test('25 - listDrives failing -> 503 drives_unavailable, config byte-identical, no write', async () => {
  // RED WHEN: the route falls back to an empty or assumed drive list and writes anyway.
  const seeded = await putShared({ shared_folders: [{ path: p('one') }] });
  assert.equal(seeded.status, 200);
  const before = fs.readFileSync(ctx.configPath);
  const beforeDir = fs.readdirSync(path.dirname(ctx.configPath)).sort();

  const authCtx25 = makeAuthCtx();
  seedPasscode(authCtx25, '481902');
  const token25 = issueTestToken(authCtx25);
  const ctx25 = {
    baseDir: tmpRoot,
    driveExec: async () => { throw new Error('boom'); },
    systemDrive: blockedLetter,
    ...authCtx25,
    configPath: ctx.configPath, // reuse the main config so before/after is comparable
  };
  const server25 = fixtureServer(ctx25);
  await new Promise((resolve) => server25.listen(0, '127.0.0.1', resolve));
  try {
    const fetch25 = makeAuthedFetch(`http://127.0.0.1:${server25.address().port}`, token25);
    const res = await fetch25('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', shared_folders: [{ path: p('two') }] }) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'drives_unavailable' });
    assert.deepEqual(fs.readFileSync(ctx.configPath), before);
    assert.deepEqual(fs.readdirSync(path.dirname(ctx.configPath)).sort(), beforeDir);
  } finally {
    server25.close();
    cleanupAuthCtx(authCtx25);
  }
});

test('26 - invalid JSON in the existing config -> 500 config_unreadable, file byte-identical', async () => {
  // RED WHEN: the throw is uncaught (bare internal_error) or, worse, a fresh
  // object is written over it.
  fs.writeFileSync(ctx.configPath, '{not valid json', 'utf8');
  const before = fs.readFileSync(ctx.configPath);
  const res = await putShared({ shared_folders: [{ path: p('two') }] });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'config_unreadable' });
  assert.deepEqual(fs.readFileSync(ctx.configPath), before);
  // Restore, so later tests in this file see a sane config again.
  writeConfig(ctx.configPath, { shared_folders: [] });
});

test('27 - unauthenticated: no passcode -> 403 setup_required; passcode set, no token -> 401 unauthorized; config byte-identical both times', async () => {
  // RED WHEN: the route is placed above the gate.
  const authCtxNoPass = makeAuthCtx();
  const ctxNoPass = { baseDir: tmpRoot, driveExec: fakeExec(driveRows), systemDrive: blockedLetter, ...authCtxNoPass };
  const serverNoPass = fixtureServer(ctxNoPass);
  await new Promise((resolve) => serverNoPass.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${serverNoPass.address().port}/api/shared`, {
      method: 'PUT', body: JSON.stringify({ shared_folders: [{ path: p('two') }] }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'setup_required' });
    assert.equal(fs.existsSync(ctxNoPass.configPath), false);
  } finally {
    serverNoPass.close();
    cleanupAuthCtx(authCtxNoPass);
  }

  const authCtxNoToken = makeAuthCtx();
  seedPasscode(authCtxNoToken, '481902');
  const ctxNoToken = { baseDir: tmpRoot, driveExec: fakeExec(driveRows), systemDrive: blockedLetter, ...authCtxNoToken };
  const serverNoToken = fixtureServer(ctxNoToken);
  await new Promise((resolve) => serverNoToken.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${serverNoToken.address().port}/api/shared`, {
      method: 'PUT', body: JSON.stringify({ shared_folders: [{ path: p('two') }] }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    assert.equal(fs.existsSync(ctxNoToken.configPath), false);
  } finally {
    serverNoToken.close();
    cleanupAuthCtx(authCtxNoToken);
  }
});

test('28 - PUT to a route that does not take PUT -> 404; GET /api/shared -> 404', async () => {
  // RED WHEN: someone adds a method-agnostic route or a permissive dispatcher.
  for (const routePath of ['/api/projects', '/api/folders', '/api/drives', '/api/sessions']) {
    const res = await authedFetch(routePath, { method: 'PUT' });
    assert.equal(res.status, 404, routePath);
    assert.deepEqual(await res.json(), { error: 'not_found' }, routePath);
  }
  const getRes = await authedFetch('/api/shared', { method: 'GET' });
  assert.equal(getRes.status, 404);
  assert.deepEqual(await getRes.json(), { error: 'not_found' });
});

test('29 - an unknown key on an entry is dropped; the stored entry has exactly four keys', async () => {
  // RED WHEN: the entry is built by spreading the input.
  const res = await putShared({
    shared_folders: [{
      path: p('one'), mode: 'container', excludes: [], new_folders: 'show', evil: 1,
    }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.shared_folders, [{ path: p('one'), mode: 'container', excludes: [], new_folders: 'show' }]);
});

test('32 - an entry that is not a plain object -> 400 invalid_entry, with the right index', async () => {
  // RED WHEN: the "entry is a plain object" check (spec 4.4.1) is dropped,
  // so a non-object entry either throws into a 500 or is read for .path/
  // .mode/etc and silently coerced.
  for (const bad of [null, [], 'x', 5, true]) {
    const res = await putShared({ shared_folders: [{ path: p('one') }, bad] });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: 'invalid_entry', index: 1 }, JSON.stringify(bad));
  }
});

// ============================================================
// Pure unit tests - systemDirsFor() and isInsideOrEqual(), no server, no fs
// (systemDirsFor's own best-effort realpath probe is the only filesystem
// touch, and it degrades silently when a candidate does not exist).
// ============================================================

test('30 - systemDirsFor resolves each env var and skips a relative/empty/missing one', () => {
  // RED WHEN: an env var is dropped from the list, or a relative value is
  // anchored to the process's current drive.
  const env = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\x',
  };
  const dirs = systemDirsFor(env);
  for (const expected of [
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users\\x\\AppData',
  ]) {
    assert.ok(dirs.includes(expected), `${expected} missing from ${JSON.stringify(dirs)}`);
  }

  const sparse = systemDirsFor({ SystemRoot: 'relative\\path', ProgramFiles: '', USERPROFILE: undefined });
  assert.deepEqual(sparse, []);
});

test('31 - isInsideOrEqual truth table: equal, child, grandchild, sibling, Foo/Foobar, case, trailing separator, drive root as ancestor', () => {
  // RED WHEN: the helper is rewritten as a naive prefix or case-sensitive compare.
  assert.equal(isInsideOrEqual('C:\\Foo', 'C:\\Foo'), true);
  assert.equal(isInsideOrEqual('C:\\Foo\\Bar', 'C:\\Foo'), true);
  assert.equal(isInsideOrEqual('C:\\Foo\\Bar\\Baz', 'C:\\Foo'), true);
  assert.equal(isInsideOrEqual('C:\\Bar', 'C:\\Foo'), false);
  assert.equal(isInsideOrEqual('C:\\Foobar', 'C:\\Foo'), false);
  assert.equal(isInsideOrEqual('c:\\foo\\bar', 'C:\\Foo'), true);
  assert.equal(isInsideOrEqual('C:\\Foo\\', 'C:\\Foo'), true);
  assert.equal(isInsideOrEqual('C:\\Foo\\Bar', 'C:\\'), true);
});

test('32b - the PRODUCTION systemDirs fallback fires when ctx carries no systemDirs', async () => {
  // RED WHEN: `ctx.systemDirs || systemDirsFor(process.env)` is reduced to
  // `ctx.systemDirs || []`. Every other test in this file INJECTS systemDirs,
  // so that change deletes the system-directory rule in production while
  // leaving the whole suite green - a silent hole on the trust boundary.
  // This is the only test that exercises the real env-derived list.
  const saved = process.env.ProgramData;
  process.env.ProgramData = p('two');
  const authCtx32b = makeAuthCtx();
  seedPasscode(authCtx32b, '481902');
  const token32b = issueTestToken(authCtx32b);
  const ctx32b = {
    baseDir: tmpRoot,
    driveExec: fakeExec(driveRows),
    systemDrive: blockedLetter,
    // systemDirs deliberately ABSENT - that is the whole point of this test.
    ...authCtx32b,
  };
  const server32b = fixtureServer(ctx32b);
  await new Promise((resolve) => server32b.listen(0, '127.0.0.1', resolve));
  try {
    const fetch32b = makeAuthedFetch(`http://127.0.0.1:${server32b.address().port}`, token32b);
    const res = await fetch32b('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', shared_folders: [{ path: p('two') }] }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'system_directory', index: 0 });
  } finally {
    server32b.close();
    cleanupAuthCtx(authCtx32b);
    if (saved === undefined) delete process.env.ProgramData; else process.env.ProgramData = saved;
  }
});
