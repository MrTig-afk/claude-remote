// agent/alerts.js: the launch-watch push and the tailscale-serve check.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { watchLaunch, serveVerdict, checkServeOnce, runServeStatus, WATCH_WINDOW_MS, WATCH_INTERVAL_MS, SERVE_TRIES } from '../alerts.js';
import { recordLaunch, pidFileNameFor, STARTING_GRACE_MS } from '../registry.js';
import { deriveSessionName } from '../sessions.js';
import { ensureVapid, writePushState, readPushState, deriveContentKeys } from '../push.js';
import { codeOnly } from './helper-source.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

const SERVER_JS_PATH = fileURLToPath(new URL('../server.js', import.meta.url));

function b64u(s) {
  return Buffer.from(s, 'base64url');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-alerts-'));
}

// A ctx whose fake clock and sleep are the SAME clock listSessions and
// watchLaunch both read, so a controlled step count is deterministic instead
// of racing a real timer.
function watchCtx(dir, { fetchImpl } = {}) {
  let fakeNow = Date.now();
  return {
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'session-pids'),
    sharedFolders: [{ path: path.join(dir, 'projects'), mode: 'container', excludes: [], new_folders: 'show' }],
    sessionDirs: [path.join(dir, 'claude-sessions')],
    pushPath: path.join(dir, 'push.json'),
    isPidAlive: () => false,
    now: () => fakeNow,
    advance(ms) { fakeNow += ms; },
    alertSleep: () => Promise.resolve(),
    fetch: fetchImpl || (async () => ({ status: 201 })),
  };
}

function seedOneSubscriber(ctx) {
  const ensured = ensureVapid(ctx);
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = crypto.randomBytes(16);
  writePushState(ctx, {
    ...ensured.state,
    subscriptions: [{
      endpoint: 'https://web.push.apple.com/watch-test',
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
      createdAt: new Date().toISOString(),
    }],
  });
  return receiver;
}

// The push type a watch sent, decrypted the way the phone would.
function pushedType(ctx, receiver, body) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const asPublic = buf.subarray(21, 21 + 65);
  const state = readPushState(ctx);
  const { cek, nonce } = deriveContentKeys({
    ecdhSecret: receiver.computeSecret(asPublic), authSecret: b64u(state.subscriptions[0].keys.auth),
    uaPublic: receiver.getPublicKey(), asPublic, salt,
  });
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([dec.update(buf.subarray(21 + 65, buf.length - 16)), dec.final()]);
  return JSON.parse(plain.subarray(0, -1).toString()).type;
}

function launchEntry(dir, ctx, name = 'beacon') {
  const projectRoot = path.join(dir, 'projects');
  const projectPath = path.join(projectRoot, 'Beacon');
  fs.mkdirSync(projectPath, { recursive: true });
  const sessionName = deriveSessionName(projectPath, projectRoot);
  recordLaunch(ctx, { sessionName, project: 'Beacon', projectPath });
  return sessionName;
}

test('watchLaunch: starting -> failed sends exactly one launch_failed push', async () => {
  const dir = tmpDir();
  const ctx = watchCtx(dir);
  const receiver = seedOneSubscriber(ctx);
  const sessionName = launchEntry(dir, ctx);

  // A .err beside a MISSING pid file is reported AT ONCE (registry.js) - no
  // pid file is ever written here, so the very first poll already reads
  // `failed`.
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, `${pidFileNameFor(sessionName)}.err`), 'could not start: simulated', 'utf8');

  const calls = [];
  ctx.fetch = async (url, opts) => { calls.push({ url, opts }); return { status: 201 }; };

  let iterations = 0;
  const boundedSleep = () => { iterations += 1; if (iterations > 50) throw new Error('watchLaunch did not converge'); return Promise.resolve(); };
  ctx.alertSleep = boundedSleep;

  const result = await watchLaunch(ctx, sessionName);
  assert.equal(result, 'failed');
  assert.equal(calls.length, 1);

  assert.equal(pushedType(ctx, receiver, calls[0].opts.body), 'launch_failed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchLaunch: running -> no push', async () => {
  const dir = tmpDir();
  const ctx = watchCtx(dir);
  seedOneSubscriber(ctx);
  const sessionName = launchEntry(dir, ctx);

  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, pidFileNameFor(sessionName)), '4242', 'utf8');
  ctx.isPidAlive = () => true;

  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };
  let iterations = 0;
  ctx.alertSleep = () => { iterations += 1; if (iterations > 50) throw new Error('did not converge'); return Promise.resolve(); };

  const result = await watchLaunch(ctx, sessionName);
  assert.equal(result, 'running');
  assert.equal(calls.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchLaunch: a launch that hangs with no pid file and no .err pushes launch_unconfirmed once its grace expires', async () => {
  // The watch must outlast STARTING_GRACE_MS, because a launch that
  // never writes its pid file is only derived `failed` when that grace ends.
  assert.ok(WATCH_WINDOW_MS > STARTING_GRACE_MS);
  const dir = tmpDir();
  const ctx = watchCtx(dir);
  const receiver = seedOneSubscriber(ctx);
  const sessionName = launchEntry(dir, ctx);

  const calls = [];
  ctx.fetch = async (url, opts) => { calls.push(opts.body); return { status: 201 }; };
  let iterations = 0;
  ctx.alertSleep = () => {
    iterations += 1;
    if (iterations > 100) throw new Error('did not converge');
    ctx.advance(WATCH_INTERVAL_MS);
    return Promise.resolve();
  };

  const result = await watchLaunch(ctx, sessionName);
  assert.equal(result, 'failed');
  assert.equal(calls.length, 1);
  // Owner 2026-09-25: never confirmed is not "couldn't start" - its own text.
  assert.equal(pushedType(ctx, receiver, calls[0]), 'launch_unconfirmed');
  assert.ok(iterations * WATCH_INTERVAL_MS >= STARTING_GRACE_MS);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchLaunch: an entry that never existed -> gone, no push', async () => {
  const dir = tmpDir();
  const ctx = watchCtx(dir);
  seedOneSubscriber(ctx);

  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };
  let iterations = 0;
  ctx.alertSleep = () => { iterations += 1; if (iterations > 50) throw new Error('did not converge'); return Promise.resolve(); };

  const result = await watchLaunch(ctx, 'nothing-ever-launched-here');
  assert.equal(result, 'gone');
  assert.equal(calls.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchLaunch: a second call during the first returns already, and still only one push', async () => {
  const dir = tmpDir();
  const ctx = watchCtx(dir);
  seedOneSubscriber(ctx);
  const sessionName = launchEntry(dir, ctx);
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.pidDir, `${pidFileNameFor(sessionName)}.err`), 'could not start: simulated', 'utf8');

  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };
  let iterations = 0;
  ctx.alertSleep = () => { iterations += 1; if (iterations > 50) throw new Error('did not converge'); return Promise.resolve(); };

  const first = watchLaunch(ctx, sessionName);
  const already = await watchLaunch(ctx, sessionName);
  assert.equal(already, 'already');
  assert.equal(await first, 'failed');
  assert.equal(calls.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- serveVerdict / runServeStatus / checkServeOnce ---

const PRESENT_JSON = JSON.stringify({
  TCP: { 8790: { HTTPS: true } },
  Web: { 'machine.tailnet.ts.net:8790': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } } },
});

test('serveVerdict fixtures', () => {
  assert.equal(serveVerdict(PRESENT_JSON, 8790), 'present');
  assert.equal(serveVerdict('{}', 8790), 'missing');
  assert.equal(serveVerdict('null', 8790), 'missing');
  assert.equal(serveVerdict('No serve config', 8790), 'unknown');
  assert.equal(serveVerdict('', 8790), 'unknown');
  assert.equal(serveVerdict('[]', 8790), 'unknown');
  assert.equal(serveVerdict(null, 8790), 'unknown');
  assert.equal(serveVerdict(JSON.stringify({ Web: { a: { Handlers: { '/': { Proxy: 'http://127.0.0.1:87901' } } } } }), 8790), 'missing');
  assert.equal(serveVerdict(JSON.stringify({ Web: { a: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8791' } } } } }), 8790), 'missing');
});

test('serveVerdict: mutation drill - notifying on every missing instead of only on the transition', () => {
  // This documents the invariant checkServeOnce below actually tests; the
  // mutation proof itself (flip the transition guard, watch it go red,
  // restore) is recorded in .pipeline/changes.md.
  assert.equal(serveVerdict('{}', 8790), 'missing');
});

test('runServeStatus: ENOENT, timeout, non-zero exit -> null; success returns stdout', async () => {
  const enoent = (bin, args, opts, cb) => cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(await runServeStatus(enoent), null);

  const timedOut = (bin, args, opts, cb) => cb(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }));
  assert.equal(await runServeStatus(timedOut), null);

  const nonZero = (bin, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }));
  assert.equal(await runServeStatus(nonZero), null);

  const ok = (bin, args, opts, cb) => cb(null, PRESENT_JSON, '');
  assert.equal(await runServeStatus(ok), PRESENT_JSON);
});

function serveCtx(dir) {
  return {
    serveStatePath: path.join(dir, 'serve-state.json'),
    pushPath: path.join(dir, 'push.json'),
    fetch: async () => ({ status: 201 }),
    serveRetrySleep: () => Promise.resolve(),
  };
}

test('checkServeOnce: present -> missing notifies once and records missing', async () => {
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  fs.writeFileSync(ctx.serveStatePath, JSON.stringify({ serve: 'present' }));
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  const result = await checkServeOnce(ctx, 8790, async () => '{}');
  assert.equal(result, 'notified');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.serveStatePath, 'utf8')), { serve: 'missing' });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkServeOnce: missing -> missing stays silent', async () => {
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  fs.writeFileSync(ctx.serveStatePath, JSON.stringify({ serve: 'missing' }));
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  const result = await checkServeOnce(ctx, 8790, async () => '{}');
  assert.equal(result, 'missing');
  assert.equal(calls.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkServeOnce: no marker (fresh install) starting missing -> silent, records missing', async () => {
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  const result = await checkServeOnce(ctx, 8790, async () => '{}');
  assert.equal(result, 'missing');
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.serveStatePath, 'utf8')), { serve: 'missing' });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkServeOnce: unknown stays silent and leaves the marker untouched', async () => {
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  fs.writeFileSync(ctx.serveStatePath, JSON.stringify({ serve: 'present' }));
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  let runs = 0;
  const result = await checkServeOnce(ctx, 8790, async () => { runs += 1; return null; });
  assert.equal(result, 'unknown');
  assert.equal(runs, SERVE_TRIES);
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.serveStatePath, 'utf8')), { serve: 'present' });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkServeOnce: tailscale not answering at boot is retried, so a later missing still notifies', async () => {
  // At boot the agent can start before the Tailscale service; the
  // one check per start must not be lost to that race.
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  fs.writeFileSync(ctx.serveStatePath, JSON.stringify({ serve: 'present' }));
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };
  let waits = 0;
  ctx.serveRetrySleep = () => { waits += 1; return Promise.resolve(); };

  const outputs = [null, null, '{}'];
  const result = await checkServeOnce(ctx, 8790, async () => outputs.shift());
  assert.equal(result, 'notified');
  assert.equal(waits, 2);
  assert.equal(calls.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkServeOnce: present records present', async () => {
  const dir = tmpDir();
  const ctx = serveCtx(dir);
  seedOneSubscriber(ctx);
  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  const result = await checkServeOnce(ctx, 8790, async () => PRESENT_JSON);
  assert.equal(result, 'present');
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.serveStatePath, 'utf8')), { serve: 'present' });

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- route wiring: POST /api/sessions -> watchLaunch -> notifyAll ---

function fakeFailingSpawner() {
  return (cmd, args) => {
    const pidFileArgIndex = args.indexOf('-PidFile');
    const pidFilePath = args[pidFileArgIndex + 1];
    const handlers = {};
    setImmediate(() => {
      fs.writeFileSync(`${pidFilePath}.err`, 'could not start: simulated', 'utf8');
      if (handlers.exit) handlers.exit();
    });
    return { on(event, cb) { handlers[event] = cb; }, unref() {} };
  };
}

async function decryptPush(opts, receiver, authSecret) {
  const bodyBuf = Buffer.from(opts.body);
  const salt = bodyBuf.subarray(0, 16);
  const asPublic = bodyBuf.subarray(21, 21 + 65);
  const ciphertext = bodyBuf.subarray(21 + 65, bodyBuf.length - 16);
  const tag = bodyBuf.subarray(bodyBuf.length - 16);
  const ecdhSecret = receiver.computeSecret(asPublic);
  const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret, uaPublic: receiver.getPublicKey(), asPublic, salt });
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(ciphertext), dec.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never became true');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('route wiring: a launch that fails within the window fires exactly one launch_failed push', async (t) => {
  const ctx = makeAuthCtx();
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '481902');
  fs.mkdirSync(path.join(ctx.dir, 'projects', 'Beacon'), { recursive: true });
  ctx.sharedFolders = [{ path: path.join(ctx.dir, 'projects'), mode: 'container', excludes: [], new_folders: 'show' }];
  ctx.watchLaunches = true;
  ctx.alertSleep = () => new Promise((r) => setTimeout(r, 10));
  ctx.spawner = fakeFailingSpawner();
  ctx.killSpawner = () => { throw new Error('not used'); };
  ctx.pidImageName = async () => 'cmd.exe';
  ctx.driveExec = async () => { throw new Error('not used'); };

  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const ensured = ensureVapid(ctx);
  writePushState(ctx, {
    ...ensured.state,
    subscriptions: [{
      endpoint: 'https://web.push.apple.com/route-wiring',
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
      createdAt: new Date().toISOString(),
    }],
  });

  const calls = [];
  ctx.fetch = async (url, opts) => { calls.push({ url, opts }); return { status: 201 }; };

  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authed = makeAuthedFetch(origin, issueTestToken(ctx));

  const launchRes = await authed('/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Beacon' }),
  });
  assert.equal(launchRes.status, 202);

  await waitUntil(() => calls.length > 0);
  assert.equal(calls.length, 1);
  const decrypted = await decryptPush(calls[0].opts, receiver, authSecret);
  assert.deepEqual(decrypted, { type: 'launch_failed' });
});

test('route wiring: without watchLaunches, a failed launch sends no push', async (t) => {
  const ctx = makeAuthCtx();
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '481902');
  fs.mkdirSync(path.join(ctx.dir, 'projects', 'Beacon'), { recursive: true });
  ctx.sharedFolders = [{ path: path.join(ctx.dir, 'projects'), mode: 'container', excludes: [], new_folders: 'show' }];
  // watchLaunches deliberately omitted (falsy).
  ctx.spawner = fakeFailingSpawner();
  ctx.killSpawner = () => { throw new Error('not used'); };
  ctx.pidImageName = async () => 'cmd.exe';
  ctx.driveExec = async () => { throw new Error('not used'); };

  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const ensured = ensureVapid(ctx);
  writePushState(ctx, {
    ...ensured.state,
    subscriptions: [{
      endpoint: 'https://web.push.apple.com/route-wiring-off',
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
      createdAt: new Date().toISOString(),
    }],
  });

  const calls = [];
  ctx.fetch = async () => { calls.push(1); return { status: 201 }; };

  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authed = makeAuthedFetch(origin, issueTestToken(ctx));

  const launchRes = await authed('/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Beacon' }),
  });
  assert.equal(launchRes.status, 202);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 0);
});

test('the import.meta.main block passes watchLaunches: true', () => {
  const source = codeOnly(fs.readFileSync(SERVER_JS_PATH, 'utf8'));
  const block = source.slice(source.indexOf('if (import.meta.main)'));
  assert.match(block, /watchLaunches:\s*true/);
  assert.match(block, /ensureVapid\(ctx\)/);
  assert.match(block, /checkServeOnce\(ctx, port\)/);
});
