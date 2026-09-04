import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { DRIVE_QUERY_ARGS, listDrives } from '../drives.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

/** Fake driveExec seam: resolves to stdout, never shells out. */
function fakeExec(stdout, { calls } = {}) {
  return async (args) => {
    if (calls) calls.push(args);
    return stdout;
  };
}

// ============================================================
// Unit tests - listDrives() directly
// ============================================================

test('DriveType=3 filter keeps only fixed drives even if the exec ignores it', async () => {
  // RED WHEN: the DriveType=3 filter is dropped or altered in the query, so
  // the OS would hand back removable drives and the picker would offer a
  // USB stick as a root.
  const fixedRows = [{ DeviceID: 'C:', VolumeName: 'OS' }, { DeviceID: 'F:', VolumeName: 'Data' }];
  const withRemovable = [...fixedRows, { DeviceID: 'E:', VolumeName: 'USB' }];
  const driveExec = async (args) => JSON.stringify(args.join(' ').includes('DriveType=3') ? fixedRows : withRemovable);
  const result = await listDrives({ driveExec, systemDrive: 'Z:' });
  assert.deepEqual(result.drives.map((d) => d.letter), ['C:', 'F:']);
});

test('DRIVE_QUERY_ARGS is the frozen, fixed command', () => {
  // RED WHEN: someone edits the command to load a profile (slow, and runs
  // the owner's PS profile), makes it interactive (hangs with no TTY), or
  // mutates the shared constant at runtime.
  assert.ok(DRIVE_QUERY_ARGS.includes('-NoProfile'));
  assert.ok(DRIVE_QUERY_ARGS.includes('-NonInteractive'));
  assert.ok(DRIVE_QUERY_ARGS.includes('-Command'));
  const command = DRIVE_QUERY_ARGS.at(-1);
  assert.ok(command.includes('Win32_LogicalDisk'));
  assert.ok(command.includes('DriveType=3'));
  assert.ok(command.includes('ConvertTo-Json'));
  assert.ok(Object.isFrozen(DRIVE_QUERY_ARGS));
});

test('two fixed drives with SystemDrive C: -> full body deepEqual, no leaked reason key', async () => {
  // RED WHEN: the blocked flag, the reason key, an extra leaked key, or the
  // sort order regresses. F: has no reason key - deepEqual catches an
  // unconditional one.
  const stdout = JSON.stringify([{ DeviceID: 'C:', VolumeName: 'OS' }, { DeviceID: 'F:', VolumeName: 'Data' }]);
  const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'C:' });
  assert.deepEqual(result, {
    drives: [
      { letter: 'C:', label: 'OS', blocked: true, reason: 'system' },
      { letter: 'F:', label: 'Data', blocked: false },
    ],
  });
});

test('a non-C: systemDrive blocks that drive, not C:', async () => {
  // RED WHEN: someone hardcodes C:.
  const stdout = JSON.stringify([{ DeviceID: 'C:', VolumeName: 'OS' }, { DeviceID: 'D:', VolumeName: 'Games' }, { DeviceID: 'F:', VolumeName: 'Data' }]);
  const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'D:' });
  const byLetter = Object.fromEntries(result.drives.map((d) => [d.letter, d]));
  assert.equal(byLetter['D:'].blocked, true);
  assert.equal(byLetter['D:'].reason, 'system');
  assert.equal(byLetter['C:'].blocked, false);
  assert.equal(Object.hasOwn(byLetter['C:'], 'reason'), false);
});

test('driveExec rejecting resolves to { drives: [], error: unavailable }, never rejects', async () => {
  // RED WHEN: an exec failure escapes as a rejection (-> 500 -> white screen).
  const driveExec = async () => { throw new Error('boom'); };
  await assert.doesNotReject(async () => {
    const result = await listDrives({ driveExec, systemDrive: 'C:' });
    assert.deepEqual(result, { drives: [], error: 'unavailable' });
  });
});

test('single-drive bare object shape (not an array) parses to one entry', async () => {
  // RED WHEN: the parser assumes an array (parsed.map -> TypeError ->
  // unavailable, and a one-drive machine sees "could not read your drives").
  const stdout = '{"DeviceID":"C:","VolumeName":"OS"}';
  const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'C:' });
  assert.equal(result.drives.length, 1);
  assert.equal(result.drives[0].letter, 'C:');
});

test('zero-drive shapes: empty, whitespace, null, [] -> { drives: [] } with no error key', async () => {
  // RED WHEN: JSON.parse('') throws and the empty case is misreported as
  // unavailable; or an empty result grows an error key.
  for (const stdout of ['', '   ', 'null', '[]']) {
    const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'C:' });
    assert.deepEqual(result.drives, [], stdout);
    assert.equal(Object.hasOwn(result, 'error'), false, stdout);
  }
});

test('unparseable non-empty stdout -> unavailable', async () => {
  // RED WHEN: garbage is treated as empty and the failure is invisible.
  const result = await listDrives({ driveExec: fakeExec('not json'), systemDrive: 'C:' });
  assert.deepEqual(result, { drives: [], error: 'unavailable' });
});

test('unlabelled volumes fall back to the drive letter as label', async () => {
  // RED WHEN: label comes back undefined/null/"" and the picker renders a
  // blank or "undefined" row.
  const stdout = JSON.stringify([
    { DeviceID: 'C:', VolumeName: '' },
    { DeviceID: 'D:', VolumeName: null },
    { DeviceID: 'F:' },
  ]);
  const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'Z:' });
  const byLetter = Object.fromEntries(result.drives.map((d) => [d.letter, d]));
  for (const letter of ['C:', 'D:', 'F:']) {
    assert.equal(byLetter[letter].label, letter);
    assert.equal(typeof byLetter[letter].label, 'string');
    assert.ok(byLetter[letter].label.length > 0);
  }
});

test('a junk row beside a good one is skipped silently, not fatal', async () => {
  // RED WHEN: one malformed row throws or poisons the whole list.
  const stdout = JSON.stringify([{ DeviceID: 'C:', VolumeName: 'OS' }, null, { DeviceID: 'nonsense' }, { VolumeName: 'x' }]);
  const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'C:' });
  assert.deepEqual(result.drives, [{ letter: 'C:', label: 'OS', blocked: true, reason: 'system' }]);
});

test('drive-letter normal form: lowercase, padded, and trailing-separator forms all normalise to "F:"', async () => {
  // RED WHEN: T93/T94 compare against a lowercase or trailing-separator
  // letter and silently never match.
  for (const deviceId of ['f:', ' F: ', 'F:\\']) {
    const stdout = JSON.stringify([{ DeviceID: deviceId, VolumeName: 'Data' }]);
    const result = await listDrives({ driveExec: fakeExec(stdout), systemDrive: 'Z:' });
    assert.equal(result.drives[0].letter, 'F:', deviceId);
  }
});

test('systemDrive defaults from process.env.SystemDrive when the ctx key is absent', async () => {
  // RED WHEN: the env read is removed and systemDrive becomes ctx-only, so
  // the real agent blocks nothing (or blocks the wrong drive).
  const previous = process.env.SystemDrive;
  try {
    process.env.SystemDrive = 'D:';
    const stdout = JSON.stringify([{ DeviceID: 'C:', VolumeName: 'OS' }, { DeviceID: 'D:', VolumeName: 'Sys' }]);
    const result = await listDrives({ driveExec: fakeExec(stdout) });
    const byLetter = Object.fromEntries(result.drives.map((d) => [d.letter, d]));
    assert.equal(byLetter['D:'].blocked, true);
    assert.equal(byLetter['C:'].blocked, false);
  } finally {
    if (previous === undefined) delete process.env.SystemDrive;
    else process.env.SystemDrive = previous;
  }
});

// ============================================================
// Route tests - GET /api/drives, through the real HTTP server
// ============================================================

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-drives-'));

const authCtx = makeAuthCtx();
seedPasscode(authCtx, '481902');
const token = issueTestToken(authCtx);

const calls = [];
const stdout = JSON.stringify([{ DeviceID: 'C:', VolumeName: 'OS' }, { DeviceID: 'F:', VolumeName: 'Data' }]);
const server = fixtureServer({ baseDir: base, driveExec: fakeExec(stdout, { calls }), systemDrive: 'C:', ...authCtx });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const authedFetch = makeAuthedFetch(origin, token);

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  cleanupAuthCtx(authCtx);
  server.close();
});

test('GET /api/drives, authenticated -> 200 with the injected fake', async () => {
  // RED WHEN: the route is missing, wired to the wrong path, or does not use
  // sendJson.
  const res = await authedFetch('/api/drives');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), {
    drives: [
      { letter: 'C:', label: 'OS', blocked: true, reason: 'system' },
      { letter: 'F:', label: 'Data', blocked: false },
    ],
  });
});

test('GET /api/drives, no token, passcode set -> 401, no subprocess attempted', async () => {
  // RED WHEN: the route is placed above the passcode gate - the one mistake
  // that would expose the machine's drive layout to anything that can reach
  // the port.
  calls.length = 0;
  const res = await fetch(`${origin}/api/drives`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
  assert.equal(calls.length, 0);
});

test('GET /api/drives, no passcode configured -> 403 setup_required', async (t) => {
  // RED WHEN: the gate's pre-setup branch is bypassed for this route.
  const unconfiguredCtx = makeAuthCtx();
  const unconfiguredServer = fixtureServer({ baseDir: base, driveExec: fakeExec(stdout), ...unconfiguredCtx });
  await new Promise((resolve) => unconfiguredServer.listen(0, '127.0.0.1', resolve));
  const unconfiguredPort = unconfiguredServer.address().port;
  t.after(() => {
    unconfiguredServer.close();
    cleanupAuthCtx(unconfiguredCtx);
  });
  const res = await fetch(`http://127.0.0.1:${unconfiguredPort}/api/drives`);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'setup_required' });
});

test('surface not widened: trailing slash and POST both 404', async () => {
  // RED WHEN: a loose startsWith/prefix match, or a method-agnostic route.
  const trailing = await authedFetch('/api/drives/');
  assert.equal(trailing.status, 404);
  const posted = await authedFetch('/api/drives', { method: 'POST' });
  assert.equal(posted.status, 404);
});
