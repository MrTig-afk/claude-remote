import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  MAX_SHARED_ROOTS, crumbSegments, sharedBody, coverageOf, driveRowState,
  truncatedNote, shareErrorMessage, applySaveResult,
  listZoneState, missingRoots, withoutRoot, sharedToTicks, withRootExcludes,
} from '../public/folders-ui.js';
import { emptyDayOneTitle } from '../public/copy.js';
import { MAX_SHARED_ROOTS as SERVER_MAX_SHARED_ROOTS } from '../shared.js';
import { resolveSharedFolders } from '../config.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

// ============================================================
// P - pure, imported directly from agent/public/folders-ui.js. No server,
// no DOM - the whole point is that this file can import it like any other
// module.
// ============================================================

test('P1 - crumbSegments splits a nested path into DRIVES/drive/.../leaf with cumulative paths', () => {
  assert.deepEqual(crumbSegments('F:\\Dev\\Projects'), [
    { label: 'DRIVES', path: null },
    { label: 'F:', path: 'F:\\' },
    { label: 'Dev', path: 'F:\\Dev' },
    { label: 'Projects', path: 'F:\\Dev\\Projects' },
  ]);
});

test('P2 - a bare drive root is 2 entries, null is the DRIVES entry alone, and a trailing separator / a forward-slash spelling are both tolerated', () => {
  assert.equal(crumbSegments('F:\\').length, 2);
  assert.deepEqual(crumbSegments('F:\\')[1], { label: 'F:', path: 'F:\\' });
  assert.deepEqual(crumbSegments(null), [{ label: 'DRIVES', path: null }]);
  assert.deepEqual(crumbSegments('F:\\Dev\\'), crumbSegments('F:\\Dev'));
  assert.deepEqual(crumbSegments('F:/Dev'), crumbSegments('F:\\Dev'));
});

test('P3 - sharedBody maps ticks to one root each, in the order they were sent', () => {
  const ticks = [
    { path: 'F:\\A', name: 'A', newFolders: 'show' },
    { path: 'F:\\B', name: 'B', newFolders: 'hide' },
  ];
  assert.deepEqual(sharedBody(ticks), {
    shared_folders: [
      { path: 'F:\\A', mode: 'container', excludes: [], new_folders: 'show' },
      { path: 'F:\\B', mode: 'container', excludes: [], new_folders: 'hide' },
    ],
  });
});

test('P4 - sharedBody([]) is { shared_folders: [] }, never undefined', () => {
  assert.deepEqual(sharedBody([]), { shared_folders: [] });
});

test('P5 - coverageOf is segment-aware and case-folded; F:\\Dev must not cover F:\\Development', () => {
  const ticked = ['F:\\Dev'];
  assert.equal(coverageOf('F:\\Dev', ticked), 'ticked');
  assert.equal(coverageOf('f:\\dev', ticked), 'ticked', 'case-insensitive');
  assert.equal(coverageOf('F:\\Dev\\Projects', ticked), 'covered');
  assert.equal(coverageOf('F:\\', ticked), 'covers');
  assert.equal(coverageOf('F:\\Other', ticked), null, 'sibling');
  assert.equal(coverageOf('F:\\Development', ticked), null, 'the classic prefix bug');
});

test('P6 - MAX_SHARED_ROOTS mirrors the server cap in agent/shared.js', () => {
  assert.equal(MAX_SHARED_ROOTS, SERVER_MAX_SHARED_ROOTS);
});

test('P7 - driveRowState disables a blocked drive with a reason; a normal drive is enabled', () => {
  const blocked = driveRowState({
    letter: 'C:', label: 'OS', blocked: true, reason: 'system',
  });
  assert.equal(blocked.enabled, false);
  assert.ok(blocked.note && blocked.note.length > 0);
  const normal = driveRowState({ letter: 'F:', label: 'Data', blocked: false });
  assert.equal(normal.enabled, true);
});

test('P8 - truncatedNote states the real total, and is null when nothing was truncated', () => {
  const note = truncatedNote(812, 500);
  assert.ok(note.includes('812'));
  assert.ok(note.includes('500'));
  assert.ok(!note.includes('!'));
  assert.equal(truncatedNote(12, 12), null);
});

test('P9 - shareErrorMessage names the row for overlapping_root, states 32 for too_many_roots, and an unknown code still carries the status', () => {
  const ticks = [{ path: 'F:\\A', name: 'A' }, { path: 'F:\\B', name: 'B' }];

  const overlap = shareErrorMessage('overlapping_root', 409, 1, ticks);
  assert.ok(overlap.text.includes('B'), 'must name the row the index points at');
  assert.equal(overlap.index, 1);

  const tooMany = shareErrorMessage('too_many_roots', 400, null, ticks);
  assert.ok(tooMany.text.includes('32'));

  const unknown = shareErrorMessage('a_code_nobody_wrote_yet', 418, null, ticks);
  assert.ok(unknown.text.length > 0, 'an unknown code must not render blank');
  assert.ok(unknown.text.includes('418'));
});

test('P10 - applySaveResult on a failed SAVE leaves the tick set untouched and marks the named row', () => {
  const share = { ticks: [{ path: 'F:\\A', name: 'A' }, { path: 'F:\\B', name: 'B' }] };
  const result = applySaveResult(share, {
    ok: false, status: 409, code: 'overlapping_root', data: { index: 1 },
  });
  assert.equal(result.done, false);
  assert.deepEqual(result.ticks, share.ticks, 'a failed SAVE must not lose the picks');
  assert.equal(result.errorIndex, 1);
  assert.ok(result.message && result.message.length > 0);
});

test('P11 - applySaveResult on a successful SAVE resolves with no message and no error row', () => {
  const share = { ticks: [{ path: 'F:\\A', name: 'A' }] };
  const result = applySaveResult(share, { ok: true, status: 200, data: { shared_folders: [] } });
  assert.equal(result.done, true);
  assert.equal(result.message, null);
  assert.equal(result.errorIndex, null);
});

// ============================================================
// S - T100's pure state selection: listZoneState / missingRoots /
// withoutRoot / sharedToTicks / emptyDayOneTitle. No server, no DOM.
// ============================================================

const LIVE_ROOT = {
  path: 'F:\\Dev\\Projects\\Repos', mode: 'container', excludes: [], new_folders: 'show', missing: false,
};
const GONE_ROOT = {
  path: 'F:\\Dev\\Old', mode: 'container', excludes: [], new_folders: 'show', missing: true,
};

test('S1 - reachable:\'waiting\' with shared:[], 0 projects -> \'waiting\'', () => {
  const zone = listZoneState({
    reachable: 'waiting', openFolderEmpty: false, projectCount: 0, shared: [],
  });
  assert.equal(zone.kind, 'waiting');
});

test('S2 - reachable:false with shared:[], 0 projects -> \'unreachable\'', () => {
  const zone = listZoneState({
    reachable: false, openFolderEmpty: false, projectCount: 0, shared: [],
  });
  assert.equal(zone.kind, 'unreachable');
});

test('S3 - reachable:true, shared:[], 0 projects -> \'nothing-shared\'', () => {
  const zone = listZoneState({
    reachable: true, openFolderEmpty: false, projectCount: 0, shared: [],
  });
  assert.equal(zone.kind, 'nothing-shared');
});

test('S4 - reachable:true, one live root, 0 projects -> \'empty-day-one\', roots = that root', () => {
  const zone = listZoneState({
    reachable: true, openFolderEmpty: false, projectCount: 0, shared: [LIVE_ROOT],
  });
  assert.equal(zone.kind, 'empty-day-one');
  assert.deepEqual(zone.roots, [LIVE_ROOT]);
});

test('S5 - S3 and S4 inputs differ ONLY in shared; the two kinds must differ', () => {
  const base = { reachable: true, openFolderEmpty: false, projectCount: 0 };
  const nothing = listZoneState({ ...base, shared: [] });
  const dayOne = listZoneState({ ...base, shared: [LIVE_ROOT] });
  assert.notEqual(nothing.kind, dayOne.kind, 'the client must be able to tell state 1 from state 4');
});

test('S6 - one root, missing:true, 0 projects -> \'all-gone\'', () => {
  const zone = listZoneState({
    reachable: true, openFolderEmpty: false, projectCount: 0, shared: [GONE_ROOT],
  });
  assert.equal(zone.kind, 'all-gone');
});

test('S7 - roots [missing, live], 3 projects -> \'rows\'; missingRoots returns exactly the missing one', () => {
  const shared = [GONE_ROOT, LIVE_ROOT];
  const zone = listZoneState({
    reachable: true, openFolderEmpty: false, projectCount: 3, shared,
  });
  assert.equal(zone.kind, 'rows');
  assert.deepEqual(missingRoots(shared), [GONE_ROOT]);
});

test('S8 - shared: null and shared: undefined, 0 projects -> both \'unknown-shared\', never \'nothing-shared\'', () => {
  const base = { reachable: true, openFolderEmpty: false, projectCount: 0 };
  assert.equal(listZoneState({ ...base, shared: null }).kind, 'unknown-shared');
  assert.equal(listZoneState({ ...base, shared: undefined }).kind, 'unknown-shared');
});

test('S9 - openFolderEmpty:true with shared:[] -> \'folder-empty\'', () => {
  const zone = listZoneState({
    reachable: true, openFolderEmpty: true, projectCount: 0, shared: [],
  });
  assert.equal(zone.kind, 'folder-empty');
});

test('S10 - withoutRoot preserves the survivors\' mode/excludes/new_folders, strips missing, matches case-insensitively and with a trailing separator', () => {
  const survivor = {
    path: 'F:\\Dev\\Projects\\Solo', mode: 'single', excludes: ['node_modules'], new_folders: 'hide', missing: false,
  };
  const shared = [GONE_ROOT, survivor];
  const body = withoutRoot(shared, 'f:\\dev\\old\\');
  assert.deepEqual(body, {
    shared_folders: [
      { path: survivor.path, mode: 'single', excludes: ['node_modules'], new_folders: 'hide' },
    ],
  });
});

test('S11 - withoutRoot(oneRoot, thatPath) -> { shared_folders: [] }', () => {
  assert.deepEqual(withoutRoot([LIVE_ROOT], LIVE_ROOT.path), { shared_folders: [] });
});

test('S12 - sharedToTicks -> path, name = last segment, newFolders, mode, excludes', () => {
  const ticks = sharedToTicks([LIVE_ROOT, { ...GONE_ROOT, mode: 'single', excludes: ['x'], new_folders: 'hide' }]);
  assert.deepEqual(ticks, [
    {
      path: 'F:\\Dev\\Projects\\Repos', name: 'Repos', newFolders: 'show', mode: 'container', excludes: [],
    },
    {
      path: 'F:\\Dev\\Old', name: 'Old', newFolders: 'hide', mode: 'single', excludes: ['x'],
    },
  ]);
});

test('S13 - sharedBody carries a tick\'s mode/excludes through, defaults to container/[] for a tick that has neither', () => {
  const withFields = sharedBody([{
    path: 'F:\\A', name: 'A', newFolders: 'show', mode: 'single', excludes: ['y'],
  }]);
  assert.deepEqual(withFields.shared_folders[0], {
    path: 'F:\\A', mode: 'single', excludes: ['y'], new_folders: 'show',
  });
  const bare = sharedBody([{ path: 'F:\\B', name: 'B', newFolders: 'show' }]);
  assert.deepEqual(bare.shared_folders[0], {
    path: 'F:\\B', mode: 'container', excludes: [], new_folders: 'show',
  });
});

test('S14 - emptyDayOneTitle(["Repos"]) names the folder; two names -> the generic line', () => {
  assert.equal(emptyDayOneTitle(['Repos']), 'Nothing in Repos yet.');
  assert.equal(emptyDayOneTitle(['Repos', 'Sherlock']), 'Nothing in your shared folders yet.');
});

// ============================================================
// H - HTTP round trip, real server via helper-auth.js. Fixture recipe from
// accept.test.js's B9: the temp dir's own drive letter as a fixed drive plus
// one other letter as the blocked system drive, systemDirs: [] because
// os.tmpdir() on Windows lives under %USERPROFILE%\AppData.
// ============================================================

function makeShareServer() {
  const authCtx = makeAuthCtx();
  seedPasscode(authCtx, '481902');
  const token = issueTestToken(authCtx);
  const tmpLetter = path.parse(path.resolve(authCtx.dir)).root.replace(/[\\/]+$/, '').toUpperCase();
  const blockedLetter = ['Q:', 'Y:', 'X:', 'W:'].find((l) => l !== tmpLetter);
  const driveRows = [
    { DeviceID: tmpLetter, VolumeName: 'Test' },
    { DeviceID: blockedLetter, VolumeName: 'Sys' },
  ];
  const ctx = {
    ...authCtx,
    driveExec: async () => JSON.stringify(driveRows),
    systemDrive: blockedLetter,
    systemDirs: [],
  };
  const server = fixtureServer(ctx);
  return { ctx, token, server };
}

test('H1 - two real temp dirs PUT through and round-trip through resolveSharedFolders', async () => {
  const { ctx, token, server } = makeShareServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const rootA = path.join(ctx.dir, 'root-a');
    const rootB = path.join(ctx.dir, 'root-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const ticks = [
      { path: rootA, name: 'root-a', newFolders: 'show' },
      { path: rootB, name: 'root-b', newFolders: 'hide' },
    ];
    const res = await authedFetch('/api/shared', { method: 'PUT', body: JSON.stringify(sharedBody(ticks)) });
    assert.equal(res.status, 200);
    const resolved = resolveSharedFolders(ctx.configPath);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].mode, 'container');
    assert.equal(resolved[0].new_folders, 'show');
    assert.equal(resolved[1].new_folders, 'hide');
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H2 - an overlapping pair rejects 409 {error, index} mapping to the second row, and the config is byte-identical', async () => {
  const { ctx, token, server } = makeShareServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const parent = path.join(ctx.dir, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    const before = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath) : null;

    const ticks = [
      { path: parent, name: 'parent', newFolders: 'show' },
      { path: child, name: 'child', newFolders: 'show' },
    ];
    const res = await authedFetch('/api/shared', { method: 'PUT', body: JSON.stringify(sharedBody(ticks)) });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'overlapping_root');
    assert.equal(body.index, 1);

    const mapped = shareErrorMessage(body.error, res.status, body.index, ticks);
    assert.ok(mapped.text.includes('child'), 'the client must be able to map the index back to a row');
    assert.equal(mapped.index, 1);

    const after = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath) : null;
    assert.deepEqual(after, before, 'a rejected write must not touch the file');
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H3 - PUT /api/shared with no token -> 401 unauthorized', async () => {
  const { ctx, server } = makeShareServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/shared`, {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [] }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H4 (OQ1) - GET /api/projects reflects a PUT /api/shared write on the SAME server, with no restart', async () => {
  const { ctx, token, server } = makeShareServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const before = await authedFetch('/api/projects');
    assert.deepEqual(await before.json(), { projects: [] });

    const root = path.join(ctx.dir, 'shared-root');
    const child = path.join(root, 'child-project');
    fs.mkdirSync(child, { recursive: true });

    const put = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify(sharedBody([{ path: root, name: 'shared-root', newFolders: 'show' }])),
    });
    assert.equal(put.status, 200);

    const after = await authedFetch('/api/projects');
    const body = await after.json();
    assert.ok(
      body.projects.some((p) => p.name === 'child-project'),
      'the write updates the file and not the running set, so SAVE never brings the list back',
    );
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

// --- The unshare-everything bug (whole-repo review, 2026-09-05) --------------
// `(shared || [])` turned "this app does not currently know the shared set"
// into "the shared set is EMPTY", and PUT /api/shared accepts an empty array as
// a valid set - so the write wiped every shared root from config.json.
// state.shared is nulled by load() whenever GET /api/acknowledge fails, and
// load() runs on every visibilitychange: backgrounding the app on the folder
// editor during a network blip and then tapping SAVE was enough.

test('withoutRoot(null, path) returns NULL, never an empty set', () => {
  assert.equal(withoutRoot(null, String.raw`F:\Dev`), null);
  assert.equal(withoutRoot(undefined, String.raw`F:\Dev`), null);
});

test('withRootExcludes(null, ...) returns NULL, never an empty set', () => {
  assert.equal(withRootExcludes(null, String.raw`F:\Dev`, ['x']), null);
  assert.equal(withRootExcludes(undefined, String.raw`F:\Dev`, ['x']), null);
});

test('a non-array shared set is refused too, not coerced', () => {
  // The failure mode is a WRITE built from a value that is not a known set.
  // Anything that is not an array qualifies, however it got there.
  for (const bad of [{}, 'nope', 0, false]) {
    assert.equal(withoutRoot(bad, String.raw`F:\Dev`), null, `withoutRoot(${JSON.stringify(bad)})`);
    assert.equal(withRootExcludes(bad, String.raw`F:\Dev`, []), null, `withRootExcludes(${JSON.stringify(bad)})`);
  }
});

test('an EMPTY array is still a known set, and removing from it is a no-op', () => {
  // The null guard must not over-fire: [] means "nothing is shared", which is a
  // real answer the app can act on, unlike null. Removing a root from an empty
  // set is idempotent and legitimate.
  assert.deepEqual(withoutRoot([], String.raw`F:\Dev`), { shared_folders: [] });
});

test('editing excludes on a root that is NOT in a known set returns null', () => {
  // A different question from the null guard, added in review pass 7. The set
  // is KNOWN here; the root simply is not in it. Returning an identical body
  // made the PUT succeed and saveRootEdit report a clean save while discarding
  // the owner's edit. An empty set is the simplest case of "not there".
  assert.equal(withRootExcludes([], String.raw`F:\Dev`, ['x']), null);
});
