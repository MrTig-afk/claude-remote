import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { isAcknowledged, acknowledge, resolveSharedFolders, writeConfig } from '../config.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

// ============================================================
// A - agent/config.js units: isAcknowledged() / acknowledge()
// ============================================================

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-accept-'));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function freshPath(contents) {
  seq += 1;
  const p = path.join(dir, `cfg-${seq}.json`);
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
}

test('A1 - config file absent -> isAcknowledged() is false', () => {
  const p = freshPath();
  assert.equal(isAcknowledged(p), false);
});

test('A2 - config with no acknowledged_at -> false', () => {
  const p = freshPath(JSON.stringify({ shared_folders: [] }));
  assert.equal(isAcknowledged(p), false);
});

test('A3 - acknowledged_at present as an ISO string -> true', () => {
  const p = freshPath(JSON.stringify({ acknowledged_at: '2026-01-01T00:00:00.000Z' }));
  assert.equal(isAcknowledged(p), true);
});

test('A4 - an empty/blank/non-string acknowledged_at reads as not acknowledged', () => {
  for (const value of ['', '   ', 123, null]) {
    const p = freshPath(JSON.stringify({ acknowledged_at: value }));
    assert.equal(isAcknowledged(p), false, JSON.stringify(value));
  }
});

test('A5 - invalid JSON -> isAcknowledged() returns false and does not throw', () => {
  const p = freshPath('{ not valid json');
  assert.doesNotThrow(() => {
    assert.equal(isAcknowledged(p), false);
  });
});

test('A6 - acknowledge() on an absent config writes the field, isAcknowledged() then reads true, and the value parses as a date', () => {
  const p = freshPath();
  const result = acknowledge(p);
  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(Date.parse(result.acknowledged_at)), 'acknowledged_at must be a parseable date');
  assert.equal(isAcknowledged(p), true);
});

test('A7 - acknowledge() twice returns the identical string both times, and the file is unchanged after the second', () => {
  const p = freshPath();
  const first = acknowledge(p);
  const onDiskAfterFirst = fs.readFileSync(p, 'utf8');
  const second = acknowledge(p);
  assert.equal(second.ok, true);
  assert.equal(second.acknowledged_at, first.acknowledged_at, 'the second call must not mint a new timestamp');
  assert.equal(fs.readFileSync(p, 'utf8'), onDiskAfterFirst, 'the file must not be rewritten on the second call');
});

test('A8 - unrelated config keys survive acknowledge() verbatim, alongside the new field', () => {
  const seeded = { shared_folders: [{ path: 'F:\\x', mode: 'container', excludes: [], new_folders: 'show' }], colour: 'green' };
  const p = freshPath(JSON.stringify(seeded));
  const result = acknowledge(p);
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.colour, 'green');
  assert.deepEqual(onDisk.shared_folders, seeded.shared_folders);
  assert.equal(onDisk.acknowledged_at, result.acknowledged_at);
});

test('A9 - acknowledge() on invalid-JSON config refuses to write, and the file is byte-identical', () => {
  const p = freshPath('{ not valid json');
  const before = fs.readFileSync(p);
  const result = acknowledge(p);
  assert.deepEqual(result, { ok: false, status: 500, error: 'config_unreadable' });
  assert.deepEqual(fs.readFileSync(p), before);
});

test('A10 - a write failure (parent path is a file, not a directory) surfaces as write_failed, never a throw', () => {
  const parentIsAFile = freshPath('');
  const target = path.join(parentIsAFile, 'config.json');
  assert.doesNotThrow(() => {
    const result = acknowledge(target);
    assert.deepEqual(result, { ok: false, status: 500, error: 'write_failed' });
  });
});

// ============================================================
// B - GET/POST /api/acknowledge, through the real HTTP server
// ============================================================

const mainCtx = makeAuthCtx();
seedPasscode(mainCtx, '481902');
const mainToken = issueTestToken(mainCtx);
const mainServer = fixtureServer(mainCtx);
await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
const mainOrigin = `http://127.0.0.1:${mainServer.address().port}`;
const mainFetch = makeAuthedFetch(mainOrigin, mainToken);

after(() => {
  mainServer.close();
  cleanupAuthCtx(mainCtx);
});

test('B1 - GET /api/acknowledge on a fresh ctx -> 200 { acknowledged: false, shared_folders: [] } (T100 OQ-A: re-pinned to include the new field, not loosened)', async () => {
  const res = await mainFetch('/api/acknowledge');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { acknowledged: false, shared_folders: [] });
});

let firstAcknowledgedAt;

test('B2 - POST /api/acknowledge -> 200, acknowledged:true and an ISO acknowledged_at; the config file on disk carries it', async () => {
  const res = await mainFetch('/api/acknowledge', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.acknowledged, true);
  assert.ok(Number.isFinite(Date.parse(body.acknowledged_at)));
  firstAcknowledgedAt = body.acknowledged_at;
  const onDisk = JSON.parse(fs.readFileSync(mainCtx.configPath, 'utf8'));
  assert.equal(onDisk.acknowledged_at, firstAcknowledgedAt);
});

test('B3 - GET after the POST -> { acknowledged: true, shared_folders: [] } (T100 OQ-A: re-pinned to include the new field, not loosened)', async () => {
  const res = await mainFetch('/api/acknowledge');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { acknowledged: true, shared_folders: [] });
});

test('B4 - two POSTs both 200, acknowledged_at identical in both bodies and on disk', async () => {
  const res = await mainFetch('/api/acknowledge', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.acknowledged_at, firstAcknowledgedAt);
  const onDisk = JSON.parse(fs.readFileSync(mainCtx.configPath, 'utf8'));
  assert.equal(onDisk.acknowledged_at, firstAcknowledgedAt);
});

test('B5 - POST with no request body at all -> 200', async () => {
  const res = await fetch(`${mainOrigin}/api/acknowledge`, {
    method: 'POST',
    headers: { 'x-claude-remote-token': mainToken },
  });
  assert.equal(res.status, 200);
});

test('B6 - GET and POST with no token -> 401 unauthorized', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await fetch(`${mainOrigin}/api/acknowledge`, { method });
    assert.equal(res.status, 401, method);
    assert.deepEqual(await res.json(), { error: 'unauthorized' }, method);
  }
});

test('B7 - GET and POST against a ctx with no passcode set -> 403 setup_required', async (t) => {
  const unconfiguredCtx = makeAuthCtx();
  const unconfiguredServer = fixtureServer(unconfiguredCtx);
  await new Promise((resolve) => unconfiguredServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${unconfiguredServer.address().port}`;
  t.after(() => {
    unconfiguredServer.close();
    cleanupAuthCtx(unconfiguredCtx);
  });
  for (const method of ['GET', 'POST']) {
    const res = await fetch(`${origin}/api/acknowledge`, { method });
    assert.equal(res.status, 403, method);
    assert.deepEqual(await res.json(), { error: 'setup_required' }, method);
  }
});

test('B8 - PUT and DELETE /api/acknowledge -> 404 not_found', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const res = await mainFetch('/api/acknowledge', { method });
    assert.equal(res.status, 404, method);
    assert.deepEqual(await res.json(), { error: 'not_found' }, method);
  }
});

test('no API route can introduce or change pre_launch_command', async () => {
  // THE SECURITY BOUNDARY FOR pre_launch_command, and the reason it is a
  // config-file setting rather than a dialog in the PWA. The launcher runs
  // that value through Invoke-Expression, so a route that let a request body
  // reach it would turn the six-digit passcode into arbitrary code execution
  // as this user - against exactly the threat the README names, an unlocked
  // phone in someone else's hand.
  //
  // PUT /api/shared is the one authenticated route that takes a client body
  // and writes config.json, so it is the boundary worth pinning. It assigns
  // only config.shared_folders onto the merged object; this proves a body
  // carrying the key changes nothing, and would fail the moment anyone
  // spread a request body into the config.
  const shareCtx = makeAuthCtx();
  seedPasscode(shareCtx, '481902');
  const token = issueTestToken(shareCtx);
  fs.writeFileSync(shareCtx.configPath, JSON.stringify({ pre_launch_command: 'conda activate mine' }));

  const sharedRoot = path.join(shareCtx.dir, 'shared-root-prelaunch');
  fs.mkdirSync(sharedRoot);
  const tmpLetter = path.parse(path.resolve(shareCtx.dir)).root.replace(/[\\/]+$/, '').toUpperCase();
  const blockedLetter = ['Q:', 'Y:', 'X:', 'W:'].find((l) => l !== tmpLetter);
  const server = fixtureServer({
    ...shareCtx,
    driveExec: async () => JSON.stringify([{ DeviceID: tmpLetter, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }]),
    systemDrive: blockedLetter,
    systemDirs: [],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);

  try {
    const res = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({
        shared_folders: [{ path: sharedRoot }],
        pre_launch_command: 'calc.exe',
      }),
    });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(shareCtx.configPath, 'utf8'));
    assert.equal(
      onDisk.pre_launch_command, 'conda activate mine',
      'a request body must never reach pre_launch_command - it is passed to Invoke-Expression',
    );
  } finally {
    server.close();
    cleanupAuthCtx(shareCtx);
  }
});

test('B9 - PUT /api/shared does not clear a previously-set acknowledged_at', async () => {
  const shareCtx = makeAuthCtx();
  seedPasscode(shareCtx, '481902');
  const token = issueTestToken(shareCtx);
  const seed = acknowledge(shareCtx.configPath);
  assert.equal(seed.ok, true);

  const sharedRoot = path.join(shareCtx.dir, 'shared-root');
  fs.mkdirSync(sharedRoot);
  const tmpLetter = path.parse(path.resolve(shareCtx.dir)).root.replace(/[\\/]+$/, '').toUpperCase();
  const blockedLetter = ['Q:', 'Y:', 'X:', 'W:'].find((l) => l !== tmpLetter);
  const driveRows = [{ DeviceID: tmpLetter, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }];
  const server = fixtureServer({
    ...shareCtx,
    driveExec: async () => JSON.stringify(driveRows),
    systemDrive: blockedLetter,
    // Real systemDirsFor(process.env) would flag %USERPROFILE%\AppData, and
    // os.tmpdir() on Windows lives under exactly that - same override
    // shared.test.js's own fixture uses, for the same reason.
    systemDirs: [],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);

  try {
    const res = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: sharedRoot }] }),
    });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(shareCtx.configPath, 'utf8'));
    assert.equal(onDisk.acknowledged_at, seed.acknowledged_at, 'PUT /api/shared must not touch acknowledged_at');
  } finally {
    server.close();
    cleanupAuthCtx(shareCtx);
  }
});

test('B10 - POST /api/acknowledge does not drop shared_folders (the HTTP twin of A8)', async () => {
  const seedCtx = makeAuthCtx();
  seedPasscode(seedCtx, '481902');
  const token = issueTestToken(seedCtx);
  const seeded = [{ path: 'F:\\Dev\\Projects\\Workspace', mode: 'container', excludes: [], new_folders: 'show' }];
  writeConfig(seedCtx.configPath, { shared_folders: seeded });

  const server = fixtureServer(seedCtx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);

  try {
    const res = await authedFetch('/api/acknowledge', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(resolveSharedFolders(seedCtx.configPath), seeded);
  } finally {
    server.close();
    cleanupAuthCtx(seedCtx);
  }
});

// ============================================================
// H - GET /api/acknowledge's shared_folders field (T100 OQ-A). Fixture
// recipe borrowed from folders-ui.test.js's makeShareServer: the temp dir's
// own drive letter as a fixed drive plus one other letter as the blocked
// system drive, systemDirs: [] because os.tmpdir() on Windows lives under
// %USERPROFILE%\AppData.
// ============================================================

function makeSharedGetServer() {
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

test('H1 - GET /api/acknowledge with nothing shared -> 200 { acknowledged:false, shared_folders: [] }', async () => {
  const { ctx, token, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const res = await authedFetch('/api/acknowledge');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { acknowledged: false, shared_folders: [] });
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H2 - two real temp dirs shared -> both echoed, ctx order preserved, each with mode/excludes/new_folders/missing:false', async () => {
  const { ctx, token, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const rootA = path.join(ctx.dir, 'root-a');
    const rootB = path.join(ctx.dir, 'root-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const put = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: rootA }, { path: rootB }] }),
    });
    assert.equal(put.status, 200);

    const res = await authedFetch('/api/acknowledge');
    const body = await res.json();
    assert.equal(body.shared_folders.length, 2);
    assert.equal(body.shared_folders[0].path, path.resolve(rootA));
    assert.equal(body.shared_folders[1].path, path.resolve(rootB));
    for (const entry of body.shared_folders) {
      assert.equal(entry.mode, 'container');
      assert.deepEqual(entry.excludes, []);
      assert.equal(entry.new_folders, 'show');
      assert.equal(entry.missing, false);
    }
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H3 - share two temp dirs, delete one on disk, GET -> that one missing:true, the other missing:false', async () => {
  const { ctx, token, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const rootA = path.join(ctx.dir, 'root-a');
    const rootB = path.join(ctx.dir, 'root-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const put = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: rootA }, { path: rootB }] }),
    });
    assert.equal(put.status, 200);

    fs.rmSync(rootA, { recursive: true, force: true });

    const res = await authedFetch('/api/acknowledge');
    const body = await res.json();
    const a = body.shared_folders.find((r) => r.path === path.resolve(rootA));
    const b = body.shared_folders.find((r) => r.path === path.resolve(rootB));
    assert.equal(a.missing, true, 'a deleted root must be reported gone');
    assert.equal(b.missing, false, 'the surviving root must not be caught up in it');
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H4 - GET with no token -> 401, and the body never leaks shared_folders', async () => {
  const { ctx, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/acknowledge`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.shared_folders, undefined, 'an unauthenticated caller must never see a filesystem path');
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H5 - a root whose lstat throws EACCES -> missing:false, 200, no throw', async (t) => {
  const { ctx, token, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);
    const put = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: root }] }),
    });
    assert.equal(put.status, 200);

    const real = fs.lstatSync;
    const resolvedRoot = path.resolve(root);
    t.mock.method(fs, 'lstatSync', (p, ...rest) => {
      if (path.resolve(String(p)) === resolvedRoot) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return real.call(fs, p, ...rest);
    });

    await assert.doesNotReject(async () => {
      const res = await authedFetch('/api/acknowledge');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.shared_folders[0].missing, false, 'a permissions blip must never be reported as deleted');
    });
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

test('H6 - PUT /api/shared then GET /api/acknowledge reflects the new set, from ctx, not the boot value', async () => {
  const { ctx, token, server } = makeSharedGetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authedFetch = makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token);
  try {
    const before = await authedFetch('/api/acknowledge');
    assert.deepEqual((await before.json()).shared_folders, []);

    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);
    const put = await authedFetch('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: root }] }),
    });
    assert.equal(put.status, 200);

    const after = await authedFetch('/api/acknowledge');
    const body = await after.json();
    assert.equal(body.shared_folders.length, 1);
    assert.equal(body.shared_folders[0].path, path.resolve(root));
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
});

// ============================================================
// C - agent/public/copy.js: the copy itself
// ============================================================

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const COPY_PATH = new URL('copy.js', PUBLIC_DIR);
const DESIGN_COPY_PATH = new URL('../../design/accept-screen-copy.txt', import.meta.url);

const copy = await import(COPY_PATH.href);

test('C1 - copy.js imports successfully under node (no DOM access at module top level)', () => {
  assert.ok(copy.TITLE);
  assert.ok(Array.isArray(copy.SECTIONS));
});

test('C2 - SECTIONS headings match the four reviewed literals, in order', () => {
  assert.deepEqual(copy.SECTIONS.map((s) => s.heading), [
    'WHAT IT CAN SEE', 'WHAT IT CANNOT SEE', 'WHO CAN REACH IT', 'WHAT LEAVES THIS MACHINE',
  ]);
});

test('C3 - every items line and every top-level string pins to its reviewed literal', () => {
  assert.equal(copy.TITLE, 'Read this before you continue.');
  assert.deepEqual(copy.LEDE, [
    'claude-remote starts Claude Code on this PC.',
    'Anything Claude Code can do on this machine, it can do from your phone.',
  ]);
  assert.deepEqual(copy.SECTIONS[0].items, [
    'The folders you pick, and the names of folders inside them.',
    'While you are choosing folders, folder names on your other drives.',
  ]);
  assert.deepEqual(copy.SECTIONS[1].items, [
    'The contents of your files. It never opens them.',
    'Your C: drive. It is blocked and cannot be shared.',
  ]);
  assert.deepEqual(copy.SECTIONS[2].items, [
    'Any device on your private network that knows your passcode.',
    'It is not on the public internet.',
  ]);
  assert.deepEqual(copy.SECTIONS[3].items, [
    'Nothing. There is no account and no server of ours.',
    'If you turn notifications on later, an encrypted ping goes out through Apple or Google. They can see that one was sent, not what it says.',
  ]);
  assert.equal(copy.CONSENT_LABEL, 'I understand what this can see');
  assert.equal(copy.SETTINGS_NOTE, 'You can change which folders are shared at any time in Settings.');
  assert.equal(copy.ACCEPT_BUTTON, 'CHOOSE FOLDERS');
});

test('C4 - LEDE[1] is the sentence the screen exists for, and it must not be softened', () => {
  assert.equal(copy.LEDE[1], 'Anything Claude Code can do on this machine, it can do from your phone.');
});

test('C5 - the joined copy contains none of the four banned phrases', () => {
  const joined = [copy.TITLE, ...copy.LEDE, copy.CONSENT_LABEL, copy.SETTINGS_NOTE, copy.ACCEPT_BUTTON, copy.SECTIONS_TOGGLE,
    ...copy.SECTIONS.flatMap((s) => [s.heading, ...s.items])].join(' ').toLowerCase();
  for (const banned of ['privacy seriously', 'secure', 'only you can access', 'by continuing you agree']) {
    assert.ok(!joined.includes(banned), `must not contain "${banned}"`);
  }
});

test('C6 - copy.js matches design/accept-screen-copy.txt verbatim, when that file exists (design/ is gitignored)', (t) => {
  if (!fs.existsSync(DESIGN_COPY_PATH)) {
    t.skip('design/ is gitignored - not present in this checkout');
    return;
  }
  // Whitespace-normalised: the .txt hand-wraps long lines (see the
  // notifications line), so a raw substring match would fail on wrapping
  // that carries no meaning.
  const design = fs.readFileSync(DESIGN_COPY_PATH, 'utf8').replace(/\s+/g, ' ');
  for (const section of copy.SECTIONS) {
    assert.ok(design.includes(section.heading), `design copy must contain heading "${section.heading}"`);
    for (const item of section.items) {
      assert.ok(design.includes(item.replace(/\s+/g, ' ')), `design copy must contain line "${item}"`);
    }
  }
});

test('C7 - index.html carries none of the four headings, either LEDE line, or SECTIONS_TOGGLE as literal text', () => {
  const html = fs.readFileSync(new URL('index.html', PUBLIC_DIR), 'utf8');
  const start = html.indexOf('<main id="accept"');
  const end = html.indexOf('<main id="gate"');
  const block = html.slice(start, end);
  for (const heading of copy.SECTIONS.map((s) => s.heading)) {
    assert.ok(!block.includes(heading), `index.html must not hardcode "${heading}"`);
  }
  for (const lede of copy.LEDE) {
    assert.ok(!block.includes(lede), `index.html must not hardcode "${lede}"`);
  }
  assert.ok(!block.includes(copy.SECTIONS_TOGGLE), 'index.html must not hardcode SECTIONS_TOGGLE - it would drift from copy.js');
});

test('C9 - SECTIONS_TOGGLE is exported, exact, and names all four sections\' subjects', () => {
  assert.equal(copy.SECTIONS_TOGGLE, 'What it can see, what it cannot, who can reach it, what leaves this machine');
  const lower = copy.SECTIONS_TOGGLE.toLowerCase();
  for (const subject of ['what it can see', 'what it cannot', 'who can reach it', 'what leaves this machine']) {
    assert.ok(lower.includes(subject), `SECTIONS_TOGGLE must mention "${subject}" - collapsing it to two of the four hides the other two entirely`);
  }
});

test('C8 - boot still CALLS showAccept(); the acknowledgement gate is wired, not merely present', () => {
  // RED WHEN: `if (screenAfterUnlock(res) === 'accept') await showAccept();` is
  // deleted, replaced, or made conditional on something else in ensureAccepted().
  // Every other test in this file checks what showAccept() DOES. None of them
  // checks that boot still reaches it - so the warning screen could be removed
  // from the boot path entirely and the whole suite would stay green. A review
  // found a comment instructing exactly that deletion, which is why this exists.
  // Normalised: the working tree can be CRLF even though the committed blob is LF.
  const src = fs.readFileSync(new URL('app.js', PUBLIC_DIR), 'utf8')
    .split(String.fromCharCode(13)).join('');
  const fn = src.slice(src.indexOf('async function ensureAccepted'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.ok(body.length > 0, 'ensureAccepted() not found in app.js');
  assert.match(
    body,
    /if\s*\(\s*screenAfterUnlock\(res\)\s*===\s*'accept'\s*\)\s*await\s+showAccept\(\)\s*;/,
    'ensureAccepted() must still gate on screenAfterUnlock and await showAccept()',
  );
  // And the reveal must come AFTER that gate, never before it.
  assert.ok(
    // 'await showAccept()' occurs exactly once and is the CALL. Matching the
    // bare 'showAccept()' would also hit this test's own comment above, which
    // sits before the call - so a picker revealed early would still pass.
    body.indexOf('await showAccept()') < body.indexOf('picker.hidden = false'),
    'the picker must be revealed only after the accept gate has run',
  );
});
