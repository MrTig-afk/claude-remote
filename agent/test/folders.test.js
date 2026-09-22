import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  MAX_FOLDERS, validateFolderPath, parentOf, listFolders, realPathVerdict, resolveRealFolderPath,
} from '../folders.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

// The temp-drive problem: os.tmpdir() on this host is on C:, the real
// blocked system drive. The fixture makes the temp drive an ALLOWED fixed
// drive and blocks a letter nothing uses, so route tests never need to leave
// os.tmpdir() and never need to touch a real system folder.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-'));
// T92 normal form: path.parse().root is "C:\\" WITH the separator; strip it.
const tmpLetter = path.parse(path.resolve(tmpRoot)).root.replace(/[\\/]+$/, '').toUpperCase();
const [blockedLetter, unknownLetter] = ['Q:', 'Y:', 'X:', 'W:'].filter((l) => l !== tmpLetter);

const driveRows = [
  { DeviceID: tmpLetter, VolumeName: 'Test' },
  { DeviceID: blockedLetter, VolumeName: 'Sys' },
];
// The shape validateFolderPath itself takes: listDrives()'s normalised
// `drives` array. Used for pure unit tests that never touch a real server.
const DRIVES = [
  { letter: tmpLetter, label: 'Test', blocked: false },
  { letter: blockedLetter, label: 'Sys', blocked: true, reason: 'system' },
];

function fakeExec(rows, calls) {
  return async (args) => {
    if (calls) calls.push(args);
    return JSON.stringify(rows);
  };
}

/** Decodes a raw query value the same way handleRequest does: new URL(...).searchParams.get. */
function decodeQueryValue(rawQueryValue) {
  const url = new URL(`http://127.0.0.1/?path=${rawQueryValue}`);
  return url.searchParams.get('path');
}

// ============================================================
// Pure unit tests - validateFolderPath() and parentOf(), no server, no fs.
// ============================================================

test('10.2 - traversal past the drive root clamps at the root, same drive, never crosses it', () => {
  // RED WHEN: someone "fixes" traversal with a string check instead of the
  // root check, or a future change lets '..' cross a drive.
  const result = validateFolderPath(`${tmpLetter}\\..\\..\\..\\..\\Windows`, DRIVES);
  assert.equal(result.ok, true);
  assert.ok(result.resolved.toUpperCase().startsWith(`${tmpLetter}\\`), result.resolved);
});

test('10.3 - UNC paths are rejected (400 invalid_path)', () => {
  // RED WHEN: the UNC guard is dropped: the agent then reaches out over SMB
  // from a request parameter (forbidden egress) and can hang on an
  // unreachable host.
  for (const raw of ['\\\\server\\share', '\\\\server\\share\\sub', '//server/share']) {
    const result = validateFolderPath(raw, DRIVES);
    assert.equal(result.ok, false, raw);
    assert.equal(result.status, 400, raw);
    assert.equal(result.error, 'invalid_path', raw);
  }
});

test('10.4 - device-namespace prefixes are rejected (400 invalid_path)', () => {
  // RED WHEN: V3 is dropped: the device-namespace form bypasses Win32
  // normalisation, and its parsed root is not a plain drive root, so V5's
  // comparison no longer speaks about the path it is checking.
  for (const raw of ['\\\\?\\C:\\', '\\\\.\\C:\\', '//?/C:/', `\\\\?\\${tmpRoot}`]) {
    const result = validateFolderPath(raw, DRIVES);
    assert.equal(result.ok, false, raw);
    assert.equal(result.status, 400, raw);
    assert.equal(result.error, 'invalid_path', raw);
  }
});

test('10.5 - driveless-absolute paths are rejected (400 invalid_path)', () => {
  // RED WHEN: the check uses path.isAbsolute alone. path.isAbsolute('/etc')
  // is TRUE on win32 and path.resolve anchors it to the agent's CURRENT
  // drive, so the same string means different folders depending on where
  // the agent was started.
  const tmpRootNoDrive = tmpRoot.slice(2); // strip "C:" leaving "\Users\..."
  for (const raw of ['/etc', '\\etc', '/', '\\', tmpRootNoDrive]) {
    const result = validateFolderPath(raw, DRIVES);
    assert.equal(result.ok, false, raw);
    assert.equal(result.status, 400, raw);
    assert.equal(result.error, 'invalid_path', raw);
  }
});

test('10.6 - drive-relative paths (colon, no separator) are rejected (400 invalid_path)', () => {
  // RED WHEN: the regex loses its mandatory separator: a drive-relative path
  // reads the process's per-drive current directory, ambient state no
  // caller intended.
  for (const raw of ['C:foo', `${tmpLetter}foo`]) {
    const result = validateFolderPath(raw, DRIVES);
    assert.equal(result.ok, false, raw);
    assert.equal(result.status, 400, raw);
    assert.equal(result.error, 'invalid_path', raw);
  }
});

test('10.7b - a percent-encoded traversal that stays on the same drive is governed by the drive check, not the % rule', () => {
  // RED WHEN: the encoded form is treated differently from the decoded one.
  const decoded = decodeQueryValue(`${encodeURIComponent(tmpLetter)}%5C..%5CWindows`);
  assert.equal(decoded, `${tmpLetter}\\..\\Windows`);
  const result = validateFolderPath(decoded, DRIVES);
  assert.equal(result.ok, true);
  assert.ok(result.resolved.toUpperCase().startsWith(`${tmpLetter}\\`), result.resolved);
});

test('10.9 - blocked drive: an existing-looking path and a nonexistent one both 400 blocked_drive, identically', () => {
  // RED WHEN: the blocked check moves below the lstat, which makes the
  // response a probe for whether a folder exists on the system drive; or the
  // block is only advisory.
  const a = validateFolderPath(`${blockedLetter}\\Windows`, DRIVES);
  const b = validateFolderPath(`${blockedLetter}\\definitely-not-here`, DRIVES);
  assert.deepEqual(a, { ok: false, status: 400, error: 'blocked_drive' });
  assert.deepEqual(b, { ok: false, status: 400, error: 'blocked_drive' });
});

test('10.10 - a drive letter not in the injected drive list -> 404 not_found', () => {
  // RED WHEN: an unknown root falls through to a filesystem call and
  // surfaces an OS error, a 500, or a hang.
  const result = validateFolderPath(`${unknownLetter}\\anything`, DRIVES);
  assert.deepEqual(result, { ok: false, status: 404, error: 'not_found' });
});

test('10.18a - non-string path values -> 400 invalid_request', () => {
  // RED WHEN: the 255 ceiling or the empty check is dropped, or a missing
  // param reaches path.resolve(null) and throws into the 500 handler.
  for (const raw of [null, 123, {}]) {
    const result = validateFolderPath(raw, DRIVES);
    assert.deepEqual(result, { ok: false, status: 400, error: 'invalid_request' });
  }
});

test('10.18b - a 256-character path -> 400 invalid_request', () => {
  const raw = `${tmpLetter}\\${'a'.repeat(260)}`;
  assert.ok(raw.length > 255);
  const result = validateFolderPath(raw, DRIVES);
  assert.deepEqual(result, { ok: false, status: 400, error: 'invalid_request' });
});

test('10.17a - parentOf: null at a drive root, dirname everywhere else', () => {
  // RED WHEN: path.dirname is used bare - at a drive root it returns the
  // root itself, so the picker's back button navigates to the screen it is
  // already on and the owner is stuck.
  assert.equal(parentOf('F:\\'), null);
  assert.equal(parentOf('F:\\Dev'), 'F:\\');
  assert.equal(parentOf('F:\\Dev\\Projects'), 'F:\\Dev');
});

test('10.23 - realPathVerdict: pure matrix on a CANONICAL path, roots only, blocked target pinned deterministically', () => {
  // RED WHEN: the canonical re-check does not consult the drive list, or it
  // distinguishes a blocked target from a typo (which tells a caller their
  // planted junction resolved and where), or the \\?\ form is read as UNC so
  // legitimate deep browsing 404s, or a UNC realpath result is read as a
  // drive and a symlink to a network share becomes browsable.
  assert.equal(realPathVerdict(`${tmpLetter}\\x`, DRIVES), null);

  const blocked = realPathVerdict(`${blockedLetter}\\Windows\\x`, DRIVES);
  assert.deepEqual(blocked, { ok: false, status: 404, error: 'not_found' });
  assert.notEqual(blocked.error, 'blocked_drive'); // explicitly NOT blocked_drive

  assert.deepEqual(
    realPathVerdict(`${unknownLetter}\\x`, DRIVES),
    { ok: false, status: 404, error: 'not_found' },
  );
  assert.deepEqual(
    realPathVerdict('\\\\server\\share\\x', DRIVES),
    { ok: false, status: 404, error: 'not_found' },
  );
  assert.equal(realPathVerdict(`\\\\?\\${tmpLetter}\\x`, DRIVES), null);
  assert.deepEqual(
    realPathVerdict('\\\\?\\UNC\\server\\share\\x', DRIVES),
    { ok: false, status: 404, error: 'not_found' },
  );
  assert.equal(realPathVerdict(`${tmpLetter}\\`, DRIVES), null); // bare root
  assert.equal(realPathVerdict(`${tmpLetter.toLowerCase()}\\x`, DRIVES), null); // lowercase
});

test('10.27 - the 255 ceiling is pinned at its exact boundary', () => {
  // RED WHEN: the ceiling comparison flips from > to >= (or the reverse) and
  // nothing notices, which is what round 1's 263-character strings allowed.
  const prefix255 = `${tmpLetter}\\`;
  const exactly255 = prefix255 + 'a'.repeat(255 - prefix255.length);
  assert.equal(exactly255.length, 255);
  const okResult = validateFolderPath(exactly255, DRIVES);
  assert.equal(okResult.ok, true, JSON.stringify(okResult));

  const exactly256 = `${exactly255}a`;
  assert.equal(exactly256.length, 256);
  assert.deepEqual(
    validateFolderPath(exactly256, DRIVES),
    { ok: false, status: 400, error: 'invalid_request' },
  );
});

// ============================================================
// Route tests - GET /api/folders, through the real HTTP server, sharing one
// server where the request never touches a real filesystem outside tmpRoot
// (or is rejected before any filesystem call at all).
// ============================================================

fs.mkdirSync(path.join(tmpRoot, 'a'));
fs.mkdirSync(path.join(tmpRoot, 'b'));
fs.mkdirSync(path.join(tmpRoot, 'home'));
fs.mkdirSync(path.join(tmpRoot, 'outside'));
fs.mkdirSync(path.join(tmpRoot, 'outside', 'child'));
fs.mkdirSync(path.join(tmpRoot, 'outside', 'child', 'grandchild'));
fs.symlinkSync(path.join(tmpRoot, 'outside'), path.join(tmpRoot, 'home', 'link'), 'junction');
fs.writeFileSync(path.join(tmpRoot, 'a-file.txt'), 'x');

const mixedDir = path.join(tmpRoot, 'mixed');
fs.mkdirSync(mixedDir);
fs.mkdirSync(path.join(mixedDir, 'sub1'));
fs.mkdirSync(path.join(mixedDir, 'sub2'));
fs.mkdirSync(path.join(mixedDir, '.hidden'));
fs.writeFileSync(path.join(mixedDir, 'file1.txt'), 'x');
fs.writeFileSync(path.join(mixedDir, 'file2.txt'), 'x');
fs.writeFileSync(path.join(mixedDir, 'secret-file.txt'), 'x');

const sharedAuthCtx = makeAuthCtx();
seedPasscode(sharedAuthCtx, '481902');
const sharedToken = issueTestToken(sharedAuthCtx);
const sharedDriveCalls = [];
const sharedCtx = {
  baseDir: tmpRoot,
  driveExec: fakeExec(driveRows, sharedDriveCalls),
  systemDrive: blockedLetter,
  ...sharedAuthCtx,
};
const sharedServer = fixtureServer(sharedCtx);
await new Promise((resolve) => sharedServer.listen(0, '127.0.0.1', resolve));
const sharedPort = sharedServer.address().port;
const sharedOrigin = `http://127.0.0.1:${sharedPort}`;
const sharedFetch = makeAuthedFetch(sharedOrigin, sharedToken);

after(() => {
  sharedServer.close();
  cleanupAuthCtx(sharedAuthCtx);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('10.1 - .. in every position resolves inside the temp drive, path echoes the resolved value', async () => {
  // RED WHEN: resolve is dropped and the raw string is used, or a naive '..'
  // substring check rejects a legitimate normalised path.
  const base = path.basename(tmpRoot);
  const cases = [
    [`${tmpRoot}\\a\\..\\b`, path.join(tmpRoot, 'b')],
    [`${tmpRoot}\\..\\${base}\\a`, path.join(tmpRoot, 'a')],
    [`${tmpRoot}\\a\\..\\..\\${base}\\a`, path.join(tmpRoot, 'a')],
  ];
  for (const [raw, expected] of cases) {
    const res = await sharedFetch(`/api/folders?path=${raw}`);
    assert.equal(res.status, 200, raw);
    const body = await res.json();
    assert.equal(body.path, expected, raw);
    assert.ok(!body.path.includes('..'), raw);
  }
});

test('V4 note - forward slashes after the drive letter are accepted, not rejected, and normalise like a backslash path', async () => {
  // RED WHEN: someone tightens DRIVE_ROOT_RE to backslash-only, breaking a
  // legitimate F:/Dev-style path the spec explicitly requires accepting (V4,
  // "forward slashes after the drive letter are allowed - path.resolve
  // normalises them and nothing downstream sees a /").
  const fwdSlashPath = `${tmpRoot.replace(/\\/g, '/')}/a`;
  const pure = validateFolderPath(fwdSlashPath, DRIVES);
  assert.equal(pure.ok, true, fwdSlashPath);
  assert.equal(pure.resolved, path.join(tmpRoot, 'a'));
  assert.ok(!pure.resolved.includes('/'), pure.resolved);

  const res = await sharedFetch(`/api/folders?path=${fwdSlashPath}`);
  assert.equal(res.status, 200, fwdSlashPath);
  const body = await res.json();
  assert.equal(body.path, path.join(tmpRoot, 'a'));
});

test('10.3 route - UNC paths never reach the filesystem, 400 invalid_path', async () => {
  for (const raw of ['\\\\server\\share', '\\\\server\\share\\sub', '//server/share']) {
    const res = await sharedFetch(`/api/folders?path=${raw}`);
    assert.equal(res.status, 400, raw);
    assert.deepEqual(await res.json(), { error: 'invalid_path' }, raw);
  }
});

test('10.4 route - device-namespace prefixes -> 400 invalid_path', async () => {
  for (const raw of ['\\\\?\\C:\\', '\\\\.\\C:\\', '//?/C:/']) {
    const res = await sharedFetch(`/api/folders?path=${raw}`);
    assert.equal(res.status, 400, raw);
    assert.deepEqual(await res.json(), { error: 'invalid_path' }, raw);
  }
});

test('10.5 route - driveless-absolute paths -> 400 invalid_path', async () => {
  for (const raw of ['/etc', '\\etc', '/', '\\']) {
    const res = await sharedFetch(`/api/folders?path=${raw}`);
    assert.equal(res.status, 400, raw);
    assert.deepEqual(await res.json(), { error: 'invalid_path' }, raw);
  }
});

test('10.6 route - drive-relative paths -> 400 invalid_path', async () => {
  for (const raw of ['C:foo', `${tmpLetter}foo`]) {
    const res = await sharedFetch(`/api/folders?path=${raw}`);
    assert.equal(res.status, 400, raw);
    assert.deepEqual(await res.json(), { error: 'invalid_path' }, raw);
  }
});

test('10.7a - a percent-encoded traversal with no drive letter -> 400 invalid_path', async () => {
  // RED WHEN: the encoded form is treated differently from the decoded one.
  const res = await sharedFetch('/api/folders?path=%2E%2E%5CWindows');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_path' });
});

test('10.8 - a double-encoded traversal still contains a % after one decode -> 400 invalid_path', async () => {
  // RED WHEN: the % rule is dropped, OR the handler decodes a SECOND time -
  // which re-creates '..' from %2e%2e and is the exact bug static.js's
  // comment warns against. The spec's literal example
  // (%252e%252e%255CWindows) has no drive-letter prefix once decoded once,
  // so V4 alone would also reject it - that leaves this RED WHEN
  // structurally unprovable on its own, so the second case below places the
  // surviving '%' AFTER a legitimate drive-rooted prefix, where only V2
  // stands between it and a real lstat call.
  const res = await sharedFetch('/api/folders?path=%252e%252e%255CWindows');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_path' });

  const rawQuery = `${encodeURIComponent(tmpLetter)}%5C%252e%252e`;
  const decoded = decodeQueryValue(rawQuery);
  assert.equal(decoded, `${tmpLetter}\\%2e%2e`); // one decode only: %25 -> %, the rest stays literal
  const res2 = await sharedFetch(`/api/folders?path=${rawQuery}`);
  assert.equal(res2.status, 400);
  assert.deepEqual(await res2.json(), { error: 'invalid_path' });
});

test('10.9 route - blocked drive: identical 400 blocked_drive bodies for a real-looking and a fake path', async () => {
  const resA = await sharedFetch(`/api/folders?path=${blockedLetter}\\Windows`);
  const resB = await sharedFetch(`/api/folders?path=${blockedLetter}\\definitely-not-here`);
  assert.equal(resA.status, 400);
  assert.equal(resB.status, 400);
  const bodyA = await resA.json();
  const bodyB = await resB.json();
  assert.deepEqual(bodyA, { error: 'blocked_drive' });
  assert.deepEqual(bodyB, { error: 'blocked_drive' });
});

test('10.10 route - an unknown drive letter -> 404 not_found', async () => {
  const res = await sharedFetch(`/api/folders?path=${unknownLetter}\\anything`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('10.11 - a junction: browsing it directly is refused, and it is absent from its parent listing', async () => {
  // RED WHEN: statSync replaces lstatSync anywhere in the module - statSync
  // follows the junction and reports a directory, so a link planted on an
  // allowed drive becomes browsable as a real folder. This is the single
  // most important test in the file. EXTENDED: also red if V7 is used to
  // REPLACE V6 instead of running after it - V7 alone would accept a
  // final-component junction whose target is on the same allowed drive,
  // which this test forbids.
  const linkPath = path.join(tmpRoot, 'home', 'link');
  const st = fs.lstatSync(linkPath);
  assert.ok(st.isSymbolicLink(), 'junction creation did not produce a reparse point on this host - test cannot proceed');

  const direct = await sharedFetch(`/api/folders?path=${linkPath}`);
  assert.equal(direct.status, 404);
  assert.deepEqual(await direct.json(), { error: 'not_found' });

  const home = await sharedFetch(`/api/folders?path=${path.join(tmpRoot, 'home')}`);
  assert.equal(home.status, 200);
  const homeBody = await home.json();
  assert.ok(!homeBody.folders.some((f) => f.name === 'link'), JSON.stringify(homeBody.folders));
});

test('10.24 - resolveRealFolderPath: an INTERMEDIATE junction is canonicalised, not just the final component', () => {
  // RED WHEN: the realpath call is removed, or applied to something other
  // than the full resolved path. An intermediate reparse point then goes
  // uncanonicalised and the drive re-check inspects the lexical path - the
  // exact hole T93 shipped with in round 1.
  const linkPath = path.join(tmpRoot, 'home', 'link');
  const st = fs.lstatSync(linkPath);
  assert.ok(st.isSymbolicLink(), 'junction creation did not produce a reparse point on this host - test cannot proceed');

  const raw = path.join(tmpRoot, 'home', 'link', 'child');
  const result = resolveRealFolderPath(raw, DRIVES);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.resolved, raw);
  assert.equal(
    result.real.toUpperCase(),
    path.join(tmpRoot, 'outside', 'child').toUpperCase(),
  );
});

test('10.25 - positive control over HTTP: browsing THROUGH an intermediate junction succeeds, and the echo stays lexical', async () => {
  // RED WHEN: the re-check compares whole strings (real !== resolved)
  // instead of roots - 8.3 short names, NTFS case canonicalisation and every
  // legitimate same-drive junction then 404 and the picker breaks on a real
  // machine; or the echo contract silently changes to the canonical path and
  // the picker's back-button chain jumps.
  const raw = path.join(tmpRoot, 'home', 'link', 'child');
  const res = await sharedFetch(`/api/folders?path=${raw}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, raw); // echo is LEXICAL, never the canonical `real`
  assert.deepEqual(body.folders.map((f) => f.name), ['grandchild']);
});

test('10.26 - realpath failure paths collapse to 404, never a 500 or an unhandled throw', async () => {
  // RED WHEN: the realpath call sits outside the try (a dangling junction
  // then becomes a 500 through the outer backstop), or its failure falls
  // through to the readdir.
  const missing = await sharedFetch(`/api/folders?path=${path.join(tmpRoot, 'home', 'link', 'definitely-not-here')}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });

  // A DANGLING junction: the target existed at creation time, then was removed.
  const goneTarget = path.join(tmpRoot, 'gone');
  fs.mkdirSync(goneTarget);
  const deadLink = path.join(tmpRoot, 'home', 'dead');
  fs.symlinkSync(goneTarget, deadLink, 'junction');
  fs.rmdirSync(goneTarget);

  const dangling = await sharedFetch(`/api/folders?path=${path.join(deadLink, 'child')}`);
  assert.equal(dangling.status, 404);
  assert.deepEqual(await dangling.json(), { error: 'not_found' });
});

test('10.12 - a path pointing at a file -> 404 not_found', async () => {
  // RED WHEN: the isDirectory() check is dropped: readdir on a file then
  // throws and surfaces as a 500.
  const res = await sharedFetch(`/api/folders?path=${path.join(tmpRoot, 'a-file.txt')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('10.14 - files are filtered out entirely: never counted, never returned, never named', async () => {
  // RED WHEN: the dirent filter is dropped: the route then discloses FILE
  // names anywhere on the machine's drives, which is beyond anything the
  // accept screen tells the owner it does.
  const res = await sharedFetch(`/api/folders?path=${mixedDir}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.folders.map((f) => f.name).sort(), ['sub1', 'sub2']);
  assert.equal(body.total, 2);
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('secret-file.txt'));
  assert.ok(!serialised.includes('file1.txt'));
  assert.ok(!serialised.includes('file2.txt'));
});

test('10.15b - the DEFAULT dirProbe (no ctx.dirProbe) reports a real readable temp child as readable: true', async () => {
  // RED WHEN: the default probe is never exercised at all.
  const res = await sharedFetch(`/api/folders?path=${tmpRoot}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.folders.find((f) => f.name === 'a');
  assert.ok(row, JSON.stringify(body.folders));
  assert.equal(row.readable, true);
});

test('10.17b - parent on a route response is the real dirname, and null is signalled correctly at a drive root', async () => {
  const res = await sharedFetch(`/api/folders?path=${tmpRoot}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.parent, path.dirname(tmpRoot));
});

test('10.18c - missing ?path=, empty, and a space-only value -> 400 invalid_request', async () => {
  // RED WHEN: the 255 ceiling or the empty check is dropped, or a missing
  // param reaches path.resolve(null) and throws into the 500 handler.
  const noParam = await sharedFetch('/api/folders');
  assert.equal(noParam.status, 400);
  assert.deepEqual(await noParam.json(), { error: 'invalid_request' });

  const empty = await sharedFetch('/api/folders?path=');
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: 'invalid_request' });

  const space = await sharedFetch('/api/folders?path=%20');
  assert.equal(space.status, 400);
  assert.deepEqual(await space.json(), { error: 'invalid_request' });
});

test('10.18d - a 256-character path via the route -> 400 invalid_request', async () => {
  const raw = `${tmpLetter}\\${'a'.repeat(260)}`;
  const res = await sharedFetch(`/api/folders?path=${raw}`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_request' });
});

test('10.19 - control characters (NUL, LF) in the decoded value -> 400 invalid_path', async () => {
  // RED WHEN: the control-char rule is dropped: the value then reaches
  // console.warn and can inject terminal escapes into the owner's console,
  // and reaches the filesystem call.
  const nul = await sharedFetch(`/api/folders?path=${encodeURIComponent(tmpRoot)}%00x`);
  assert.equal(nul.status, 400);
  assert.deepEqual(await nul.json(), { error: 'invalid_path' });

  const lf = await sharedFetch(`/api/folders?path=${encodeURIComponent(tmpRoot)}%0A`);
  assert.equal(lf.status, 400);
  assert.deepEqual(await lf.json(), { error: 'invalid_path' });
});

test('10.21 - surface not widened: trailing slash and POST both 404', async () => {
  // RED WHEN: a loose prefix match or a method-agnostic route.
  const trailing = await sharedFetch(`/api/folders/?path=${tmpRoot}`);
  assert.equal(trailing.status, 404);
  const posted = await sharedFetch(`/api/folders?path=${tmpRoot}`, { method: 'POST' });
  assert.equal(posted.status, 404);
});

// ============================================================
// Dedicated-server tests - each changes drive-exec behaviour, wants a cold
// drive cache, or injects a custom dirProbe, so each gets its own ctx.
// ============================================================

test('10.13 - a directory of 600 subdirectories: total before the slice, sorted, capped at MAX_FOLDERS', async () => {
  // RED WHEN: the slice happens before the sort (the first 500 become
  // readdir-ordered and the banner's number stops matching what is shown),
  // or total is computed after the slice and T100's banner states 500 for a
  // folder of 812.
  assert.equal(MAX_FOLDERS, 500);

  const dir13 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-13-'));
  const manyDir = path.join(dir13, 'many');
  fs.mkdirSync(manyDir);
  for (let i = 0; i < MAX_FOLDERS + 100; i++) {
    fs.mkdirSync(path.join(manyDir, `dir-${String(i).padStart(3, '0')}`));
  }
  const smallDir = path.join(dir13, 'small');
  fs.mkdirSync(smallDir);
  fs.mkdirSync(path.join(smallDir, 'one'));
  fs.mkdirSync(path.join(smallDir, 'two'));

  const letter13 = path.parse(path.resolve(dir13)).root.replace(/[\\/]+$/, '').toUpperCase();
  const authCtx13 = makeAuthCtx();
  seedPasscode(authCtx13, '481902');
  const token13 = issueTestToken(authCtx13);
  const ctx13 = {
    baseDir: dir13,
    driveExec: fakeExec([{ DeviceID: letter13, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }]),
    systemDrive: blockedLetter,
    dirProbe: () => true, // kept fast; readability is not what this test checks
    ...authCtx13,
  };
  const server13 = fixtureServer(ctx13);
  await new Promise((resolve) => server13.listen(0, '127.0.0.1', resolve));
  const port13 = server13.address().port;
  const fetch13 = makeAuthedFetch(`http://127.0.0.1:${port13}`, token13);
  try {
    const res = await fetch13(`/api/folders?path=${manyDir}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folders.length, 500);
    assert.equal(body.total, 600);
    assert.equal(body.truncated, true);
    assert.equal(body.folders[0].name, 'dir-000');
    assert.equal(body.folders.at(-1).name, 'dir-499');

    const smallRes = await fetch13(`/api/folders?path=${smallDir}`);
    assert.equal(smallRes.status, 200);
    const smallBody = await smallRes.json();
    assert.equal(smallBody.truncated, false);
    assert.equal(smallBody.total, smallBody.folders.length);
  } finally {
    server13.close();
    cleanupAuthCtx(authCtx13);
    fs.rmSync(dir13, { recursive: true, force: true });
  }
});

test('10.15a - an unreadable child (per an injected dirProbe) is a row with readable: false, not a failed response', async () => {
  // RED WHEN: an unreadable child turns the whole response into a
  // 403/500 instead of a row (the owner would be unable to browse D: or F:
  // because one 'System Volume Information' sits in the listing).
  const dir15 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-15-'));
  const parentDir = path.join(dir15, 'readability');
  fs.mkdirSync(parentDir);
  fs.mkdirSync(path.join(parentDir, 'good1'));
  fs.mkdirSync(path.join(parentDir, 'good2'));
  fs.mkdirSync(path.join(parentDir, 'blocked-child'));

  const letter15 = path.parse(path.resolve(dir15)).root.replace(/[\\/]+$/, '').toUpperCase();
  const authCtx15 = makeAuthCtx();
  seedPasscode(authCtx15, '481902');
  const token15 = issueTestToken(authCtx15);
  const ctx15 = {
    baseDir: dir15,
    driveExec: fakeExec([{ DeviceID: letter15, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }]),
    systemDrive: blockedLetter,
    dirProbe: (childPath) => !childPath.endsWith('blocked-child'),
    ...authCtx15,
  };
  const server15 = fixtureServer(ctx15);
  await new Promise((resolve) => server15.listen(0, '127.0.0.1', resolve));
  const port15 = server15.address().port;
  const fetch15 = makeAuthedFetch(`http://127.0.0.1:${port15}`, token15);
  try {
    const res = await fetch15(`/api/folders?path=${parentDir}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const byName = Object.fromEntries(body.folders.map((f) => [f.name, f]));
    assert.equal(byName.good1.readable, true);
    assert.equal(byName.good2.readable, true);
    assert.equal(byName['blocked-child'].readable, false);
  } finally {
    server15.close();
    cleanupAuthCtx(authCtx15);
    fs.rmSync(dir15, { recursive: true, force: true });
  }
});

test('10.16 - auth: gated below the passcode, and //api/folders fails closed with no folder data', async () => {
  // RED WHEN: the route is placed ABOVE the passcode gate - the one mistake
  // that exposes the machine's folder layout to anything that can reach the
  // port; or the route match is loosened to a prefix/includes and the
  // //api gate-escape form starts routing ungated.
  const dir16 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-16-'));
  const letter16 = path.parse(path.resolve(dir16)).root.replace(/[\\/]+$/, '').toUpperCase();
  const calls16 = [];

  const authCtx16 = makeAuthCtx();
  seedPasscode(authCtx16, '481902');
  const token16 = issueTestToken(authCtx16);
  const ctx16 = {
    baseDir: dir16,
    driveExec: fakeExec([{ DeviceID: letter16, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }], calls16),
    systemDrive: blockedLetter,
    ...authCtx16,
  };
  const server16 = fixtureServer(ctx16);
  await new Promise((resolve) => server16.listen(0, '127.0.0.1', resolve));
  const port16 = server16.address().port;
  const origin16 = `http://127.0.0.1:${port16}`;
  try {
    // (a) no token, passcode set -> 401
    const noToken = await fetch(`${origin16}/api/folders?path=${dir16}`);
    assert.equal(noToken.status, 401);
    assert.deepEqual(await noToken.json(), { error: 'unauthorized' });

    // (c) confirm no drive read happened for the unauthenticated request.
    assert.equal(calls16.length, 0);

    // //api/folders - new URL treats '//api' as an authority, so pathname
    // becomes '/folders': neither the gate nor this route matches, and it
    // falls through to the final 404, with no folder data.
    const doubleSlash = await fetch(`${origin16}//api/folders?path=${dir16}`);
    assert.equal(doubleSlash.status, 404);
    const doubleSlashBody = await doubleSlash.json();
    assert.equal(Object.hasOwn(doubleSlashBody, 'folders'), false);
    assert.equal(calls16.length, 0);

    // (b) no passcode configured -> 403 setup_required
    const dir16b = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-16b-'));
    const authCtx16b = makeAuthCtx();
    const ctx16b = {
      baseDir: dir16b,
      driveExec: fakeExec([{ DeviceID: letter16, VolumeName: 'Test' }]),
      ...authCtx16b,
    };
    const server16b = fixtureServer(ctx16b);
    await new Promise((resolve) => server16b.listen(0, '127.0.0.1', resolve));
    const port16b = server16b.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port16b}/api/folders?path=${dir16b}`);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'setup_required' });
    } finally {
      server16b.close();
      cleanupAuthCtx(authCtx16b);
      fs.rmSync(dir16b, { recursive: true, force: true });
    }
  } finally {
    server16.close();
    cleanupAuthCtx(authCtx16);
    fs.rmSync(dir16, { recursive: true, force: true });
  }
});

test('10.20 - a failed drive read fails closed (503 drives_unavailable), and does not stay cached', async () => {
  // RED WHEN: a failure is cached and locks the picker out for 60s; or the
  // unavailable branch falls through to a filesystem call and browses with
  // an empty allow-list, semantics reversed.
  // NOTE: this used to also assert `probeCalls.length === 0`, presented as
  // proof no filesystem call happened. Deleted: `dirProbe` only runs after a
  // successful listing, so that assertion could not distinguish "no fs call"
  // from "listing failed" and proved nothing. See 10.28 for the provable
  // replacement (driveExec call count on a cold cache, below any validation).
  const dir20 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-20-'));
  const letter20 = path.parse(path.resolve(dir20)).root.replace(/[\\/]+$/, '').toUpperCase();
  let shouldFail = true;
  const authCtx20 = makeAuthCtx();
  seedPasscode(authCtx20, '481902');
  const token20 = issueTestToken(authCtx20);
  const ctx20 = {
    baseDir: dir20,
    driveExec: async () => {
      if (shouldFail) throw new Error('boom');
      return JSON.stringify([{ DeviceID: letter20, VolumeName: 'Test' }]);
    },
    systemDrive: blockedLetter,
    ...authCtx20,
  };
  const server20 = fixtureServer(ctx20);
  await new Promise((resolve) => server20.listen(0, '127.0.0.1', resolve));
  const port20 = server20.address().port;
  const fetch20 = makeAuthedFetch(`http://127.0.0.1:${port20}`, token20);
  try {
    const failed = await fetch20(`/api/folders?path=${dir20}`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'drives_unavailable' });

    shouldFail = false;
    const succeeded = await fetch20(`/api/folders?path=${dir20}`);
    assert.equal(succeeded.status, 200);
  } finally {
    server20.close();
    cleanupAuthCtx(authCtx20);
    fs.rmSync(dir20, { recursive: true, force: true });
  }
});

test('10.22 - the drive list is cached for 60s: two requests, one exec call; past 60s, a second call', async () => {
  // RED WHEN: the cache is removed (a PowerShell spawn per drill-in, the
  // thing DESIGN CALL 1 exists to prevent), or the TTL never expires (an
  // attached drive needs an agent restart).
  const dir22 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-22-'));
  const letter22 = path.parse(path.resolve(dir22)).root.replace(/[\\/]+$/, '').toUpperCase();
  const calls22 = [];
  let clock = 1_000_000;
  const authCtx22 = makeAuthCtx({ now: () => clock });
  seedPasscode(authCtx22, '481902');
  const token22 = issueTestToken(authCtx22);
  const ctx22 = {
    baseDir: dir22,
    driveExec: fakeExec([{ DeviceID: letter22, VolumeName: 'Test' }], calls22),
    systemDrive: blockedLetter,
    ...authCtx22,
  };
  const server22 = fixtureServer(ctx22);
  await new Promise((resolve) => server22.listen(0, '127.0.0.1', resolve));
  const port22 = server22.address().port;
  const fetch22 = makeAuthedFetch(`http://127.0.0.1:${port22}`, token22);
  try {
    const res1 = await fetch22(`/api/folders?path=${dir22}`);
    assert.equal(res1.status, 200);
    const res2 = await fetch22(`/api/folders?path=${dir22}`);
    assert.equal(res2.status, 200);
    assert.equal(calls22.length, 1);

    clock += 61_000;
    const res3 = await fetch22(`/api/folders?path=${dir22}`);
    assert.equal(res3.status, 200);
    assert.equal(calls22.length, 2);
  } finally {
    server22.close();
    cleanupAuthCtx(authCtx22);
    fs.rmSync(dir22, { recursive: true, force: true });
  }
});

test('10.28 - a malformed path against a COLD drive cache -> 400, driveExec never called', async () => {
  // RED WHEN: validation moves back below cachedDrives: a junk request then
  // spawns PowerShell on a memory-tight host and answers 503
  // drives_unavailable about a request that was never valid.
  const dir28 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-folders-28-'));
  const letter28 = path.parse(path.resolve(dir28)).root.replace(/[\\/]+$/, '').toUpperCase();
  const calls28 = [];
  const authCtx28 = makeAuthCtx();
  seedPasscode(authCtx28, '481902');
  const token28 = issueTestToken(authCtx28);
  const ctx28 = {
    baseDir: dir28,
    driveExec: fakeExec([{ DeviceID: letter28, VolumeName: 'Test' }], calls28),
    systemDrive: blockedLetter,
    ...authCtx28,
  };
  const server28 = fixtureServer(ctx28);
  await new Promise((resolve) => server28.listen(0, '127.0.0.1', resolve));
  const port28 = server28.address().port;
  const fetch28 = makeAuthedFetch(`http://127.0.0.1:${port28}`, token28);
  try {
    const noParam = await fetch28('/api/folders');
    assert.equal(noParam.status, 400);
    assert.equal(calls28.length, 0);

    const unc = await fetch28('/api/folders?path=\\\\server\\share');
    assert.equal(unc.status, 400);
    assert.equal(calls28.length, 0);
  } finally {
    server28.close();
    cleanupAuthCtx(authCtx28);
    fs.rmSync(dir28, { recursive: true, force: true });
  }
});

test('Lane 18 - each folder says whether it looks like ONE project: a .git (folder or file) or a CLAUDE.md', async () => {
  // RED WHEN: the flag is dropped, keyed on the wrong names, or computed
  // for an unreadable row. Existence only: the files hold nothing readable.
  const dir = path.join(tmpRoot, 'lane18');
  for (const n of ['repo', 'worktree', 'claude', 'plain']) fs.mkdirSync(path.join(dir, n), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo', '.git'));
  fs.writeFileSync(path.join(dir, 'worktree', '.git'), '');
  fs.writeFileSync(path.join(dir, 'claude', 'CLAUDE.md'), '');
  fs.writeFileSync(path.join(dir, 'plain', 'README.md'), '');
  const res = await sharedFetch(`/api/folders?path=${dir}`);
  assert.equal(res.status, 200);
  const flags = Object.fromEntries((await res.json()).folders.map((f) => [f.name, f.project]));
  assert.deepEqual(flags, { claude: true, plain: false, repo: true, worktree: true });
});
