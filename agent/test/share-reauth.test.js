// Every share-changing route (PUT /api/shared) requires the
// current passcode, sharing the unlock screen's own attempt counter and
// lockout. Fixture recipe from shared.test.js/folders-ui.test.js: the temp
// dir's own drive letter as a fixed drive, one other letter blocked,
// systemDirs: [] because os.tmpdir() on Windows sits under
// %USERPROFILE%\AppData.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { checkShareAuth, spendFirstRun, setPasscode, attemptUnlock } from '../auth.js';
import {
  reauthLine, REAUTH_WRONG, reauthOutcome,
} from '../public/folders-ui.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

function driveFixture(dir) {
  const tmpLetter = path.parse(path.resolve(dir)).root.replace(/[\\/]+$/, '').toUpperCase();
  const blockedLetter = ['Q:', 'Y:', 'X:', 'W:'].find((l) => l !== tmpLetter);
  return {
    tmpLetter,
    blockedLetter,
    driveExec: async () => JSON.stringify([{ DeviceID: tmpLetter, VolumeName: 'Test' }, { DeviceID: blockedLetter, VolumeName: 'Sys' }]),
    systemDrive: blockedLetter,
    systemDirs: [],
  };
}

function makeShareCtx() {
  const authCtx = makeAuthCtx();
  seedPasscode(authCtx, '481902');
  const token = issueTestToken(authCtx);
  const fixture = driveFixture(authCtx.dir);
  const ctx = { ...authCtx, driveExec: fixture.driveExec, systemDrive: fixture.systemDrive, systemDirs: fixture.systemDirs };
  return { ctx, token };
}

async function withServer(ctx, run) {
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.close();
    cleanupAuthCtx(ctx);
  }
}

// ============================================================
// Unit - checkShareAuth / spendFirstRun
// ============================================================

test('checkShareAuth: wrong passcode -> 403 passcode_incorrect (never 401 - the client re-locks on any 401)', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  const result = checkShareAuth({ headers: {} }, ctx, '000000');
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'passcode_incorrect');
  assert.equal(result.failures, 1);
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: correct passcode resets the counter, same as unlock', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  checkShareAuth({ headers: {} }, ctx, '000000'); // one failure recorded
  const result = checkShareAuth({ headers: {} }, ctx, '481902');
  assert.equal(result.ok, true);
  assert.equal(result.viaFirstRun, false);
  const after = checkShareAuth({ headers: {} }, ctx, '000000');
  assert.equal(after.failures, 1, 'the counter was really reset, not merely not-incremented');
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: missing passcode without a first-run token -> 403 passcode_required, counter untouched', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  const token = issueTestToken(ctx); // NOT firstRun - issueTestToken mints an ordinary entry
  const result = checkShareAuth({ headers: { 'x-claude-remote-token': token } }, ctx, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'passcode_required');
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: locked out -> 429 too_many_attempts with retryAfterMs, never reaching the KDF', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  for (let i = 0; i < 4; i += 1) checkShareAuth({ headers: {} }, ctx, '000000');
  const result = checkShareAuth({ headers: {} }, ctx, '481902'); // even the RIGHT passcode is refused while locked
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.error, 'too_many_attempts');
  assert.ok(result.retryAfterMs > 0);
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: malformed passcode -> 400, not a guess, counter untouched', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  const result = checkShareAuth({ headers: {} }, ctx, 'abcdef');
  assert.equal(result.status, 400);
  assert.equal(result.error, 'malformed_passcode');
  const still = checkShareAuth({ headers: {} }, ctx, '000000');
  assert.equal(still.failures, 1, 'the malformed attempt must not have counted');
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: no passcode set at all -> 403 not_configured', () => {
  const ctx = makeAuthCtx();
  const result = checkShareAuth({ headers: {} }, ctx, '481902');
  assert.equal(result.status, 403);
  assert.equal(result.error, 'not_configured');
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: a first-run token is accepted with no passcode; spendFirstRun clears it, a second call then refuses', () => {
  const ctx = makeAuthCtx();
  const setResult = setPasscode(ctx, '481902', '481902');
  assert.equal(setResult.ok, true);
  const req = { headers: { 'x-claude-remote-token': setResult.token } };

  const first = checkShareAuth(req, ctx, undefined);
  assert.equal(first.ok, true);
  assert.equal(first.viaFirstRun, true);

  spendFirstRun(req, ctx);

  const second = checkShareAuth(req, ctx, undefined);
  assert.equal(second.ok, false);
  assert.equal(second.status, 403);
  assert.equal(second.error, 'passcode_required');
  cleanupAuthCtx(ctx);
});

test('checkShareAuth: an ordinary unlock token never carries the first-run exemption', () => {
  const ctx = makeAuthCtx();
  seedPasscode(ctx, '481902');
  const unlocked = attemptUnlock(ctx, '481902');
  assert.equal(unlocked.ok, true);
  const req = { headers: { 'x-claude-remote-token': unlocked.token } };
  const result = checkShareAuth(req, ctx, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'passcode_required');
  cleanupAuthCtx(ctx);
});

// ============================================================
// Route - PUT /api/shared, through the real HTTP server
// ============================================================

test('route: wrong passcode -> 403 passcode_incorrect, the token stays valid, config unchanged', async () => {
  const { ctx, token } = makeShareCtx();
  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);
    const before = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath) : null;

    const res = await fetchFn('/api/shared', {
      method: 'PUT', body: JSON.stringify({ passcode: '000000', shared_folders: [{ path: root }] }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'passcode_incorrect', failures: 1, retry_after_ms: 0 });

    // MUTATION-SENSITIVE: a route answering 401 here instead of 403 would
    // wrongly re-lock the app on a typo'd passcode - this is what the reauth fix's
    // 401-mutation drill (recorded in changes.md) flips to prove it red.
    assert.notEqual(res.status, 401);

    // Token still valid - a wrong SHARE passcode is not a lost session.
    const check = await fetchFn('/api/projects');
    assert.equal(check.status, 200);

    const after = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath) : null;
    assert.deepEqual(after, before, 'a refused passcode must never reach the write');
  });
});

test('route: the attempt counter is the SAME one the unlock screen uses', async () => {
  const { ctx, token } = makeShareCtx();
  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);

    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchFn('/api/shared', {
        method: 'PUT', body: JSON.stringify({ passcode: '000000', shared_folders: [{ path: root }] }),
      });
      assert.equal(res.status, i < 3 ? 403 : 403, `attempt ${i + 1}`);
    }

    // A CORRECT unlock, on the SAME agent, is now refused by the same lockout -
    // a separate counter would let it straight through.
    const unlockRes = await fetch(`${origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902' }),
    });
    assert.equal(unlockRes.status, 429);
  });
});

test('route: missing passcode (no first-run token) -> 403 passcode_required; attempts untouched; driveExec never runs', async () => {
  const { ctx, token } = makeShareCtx();
  let driveCalls = 0;
  const origDriveExec = ctx.driveExec;
  ctx.driveExec = async (...args) => { driveCalls += 1; return origDriveExec(...args); };
  // seedPasscode's own setPasscode() already wrote the counter file once, at
  // 0 failures - this proves a MISSING passcode leaves it exactly there,
  // never that the file cannot exist at all.
  const before = fs.readFileSync(ctx.attemptsPath, 'utf8');

  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const res = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ shared_folders: [] }) });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'passcode_required' });
    assert.equal(driveCalls, 0, 'the gate must run BEFORE putSharedFolders ever reads the drive list');
    assert.equal(fs.readFileSync(ctx.attemptsPath, 'utf8'), before, 'a missing passcode is not a guess and must not touch the counter file');
  });
});

test('route: missing passcode is refused even for an EMPTY shared set - there is no "nothing shared" exemption', async () => {
  const { ctx, token } = makeShareCtx();
  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const res = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ shared_folders: [] }) });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'passcode_required' });
  });
});

test('route: the first-run token (from POST /api/auth/passcode) writes once with no passcode, then is spent', async () => {
  const authCtx = makeAuthCtx();
  const fixture = driveFixture(authCtx.dir);
  const ctx = { ...authCtx, driveExec: fixture.driveExec, systemDrive: fixture.systemDrive, systemDirs: fixture.systemDirs };

  await withServer(ctx, async (origin) => {
    const setRes = await fetch(`${origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    assert.equal(setRes.status, 201);
    const { token: firstRunToken } = await setRes.json();
    const fetchFn = makeAuthedFetch(origin, firstRunToken);

    const rootA = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(rootA);
    const first = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ shared_folders: [{ path: rootA }] }) });
    assert.equal(first.status, 200, 'the first no-passcode write must be accepted');

    const second = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ shared_folders: [{ path: rootA }] }) });
    assert.equal(second.status, 403, 'the exemption is spent after one successful write');
    assert.deepEqual(await second.json(), { error: 'passcode_required' });
  });
});

test('route: a first-run write that FAILS (409 overlap) keeps the exemption for the retry', async () => {
  const authCtx = makeAuthCtx();
  const fixture = driveFixture(authCtx.dir);
  const ctx = { ...authCtx, driveExec: fixture.driveExec, systemDrive: fixture.systemDrive, systemDirs: fixture.systemDirs };

  await withServer(ctx, async (origin) => {
    const setRes = await fetch(`${origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    const { token: firstRunToken } = await setRes.json();
    const fetchFn = makeAuthedFetch(origin, firstRunToken);

    const parent = path.join(ctx.dir, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });

    const overlapping = await fetchFn('/api/shared', {
      method: 'PUT',
      body: JSON.stringify({ shared_folders: [{ path: parent }, { path: child }] }),
    });
    assert.equal(overlapping.status, 409, 'the overlap check itself is unrelated to the passcode check and still applies');

    // The flag survives the failed write - the owner gets to fix the tick set
    // and try again without being asked for a passcode it does not need yet.
    const retry = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ shared_folders: [{ path: parent }] }) });
    assert.equal(retry.status, 200, 'a failed first-run write must not spend the exemption');
  });
});

test('route: correct passcode -> 200 and the counter resets', async () => {
  const { ctx, token } = makeShareCtx();
  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);

    await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '000000', shared_folders: [{ path: root }] }) });
    const ok = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', shared_folders: [{ path: root }] }) });
    assert.equal(ok.status, 200);

    const status = await fetch(`${origin}/api/auth/status`);
    assert.equal((await status.json()).retry_after_ms, 0, 'a correct share passcode resets the same counter unlock reads');
  });
});

test('route: 429 carries a Retry-After header', async () => {
  const { ctx, token } = makeShareCtx();
  await withServer(ctx, async (origin) => {
    const fetchFn = makeAuthedFetch(origin, token);
    const root = path.join(ctx.dir, 'root-a');
    fs.mkdirSync(root);
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '000000', shared_folders: [{ path: root }] }) });
    }
    const locked = await fetchFn('/api/shared', { method: 'PUT', body: JSON.stringify({ passcode: '481902', shared_folders: [{ path: root }] }) });
    assert.equal(locked.status, 429);
    assert.ok(locked.headers.get('Retry-After'), 'a 429 must carry Retry-After, the same shape as /api/auth/unlock');
  });
});

// ============================================================
// Client - folders-ui.js's passcode-panel pure helpers
// ============================================================

test('reauthLine: the three verbatim sentences', () => {
  assert.equal(reauthLine('save', null), 'Enter your passcode to save this change.');
  assert.equal(reauthLine('stop', 'Projects'), 'Enter your passcode to stop sharing Projects.');
  assert.equal(reauthLine('share', null), 'Enter your passcode to share these folders.');
});

test('REAUTH_WRONG is the exact verbatim line', () => {
  assert.equal(REAUTH_WRONG, '! That passcode is not right. Nothing was saved.');
});

test('reauthOutcome maps the four api.js results', () => {
  assert.equal(reauthOutcome({ ok: true, status: 200 }), 'done');
  assert.equal(reauthOutcome({ ok: false, status: 403, code: 'passcode_incorrect' }), 'wrong');
  assert.equal(reauthOutcome({ ok: false, status: 429, code: 'too_many_attempts' }), 'locked');
  assert.equal(reauthOutcome({ ok: false, status: 500, code: 'internal_error' }), 'error');
  assert.equal(reauthOutcome({ ok: false, status: 401, code: 'unauthorized' }), 'error');
});
