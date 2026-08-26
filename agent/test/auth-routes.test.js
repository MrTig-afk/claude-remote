import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { HOST } from '../server.js';
import { readAttempts } from '../auth.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, authHeaders, fixtureServer } from './helper-auth.js';

const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

function makeSpawner() {
  const calls = [];
  return {
    calls,
    spawner(file, args, options) {
      calls.push({ file, args, options });
      return { pid: 1, unref() {}, on() { return this; } };
    },
  };
}

// Every fixture directory handed out and not yet removed. Each test cleans up
// its own in a finally, but setup can throw before that finally exists and a
// future test can forget it - either way a directory tree is left in the
// system temp folder on every run, on a machine that is short of disk.
const liveFixtureBases = new Set();

function makeFixtureBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-auth-routes-'));
  liveFixtureBases.add(base);
  fs.mkdirSync(path.join(base, 'Pull Requests'));
  fs.mkdirSync(path.join(base, 'Video Editing'));
  fs.mkdirSync(path.join(base, 'email-lint'));
  return base;
}

function removeFixtureBase(base) {
  fs.rmSync(base, { recursive: true, force: true });
  liveFixtureBases.delete(base);
}

after(() => {
  for (const base of liveFixtureBases) removeFixtureBase(base);
});

async function startServer(extraCtx = {}) {
  const base = makeFixtureBase();
  const { spawner, calls } = makeSpawner();
  const authCtx = makeAuthCtx();
  // The MERGED ctx is what the server actually holds, and it is the object
  // auth.js hangs attemptFloor on. Returning the bare makeAuthCtx() result
  // here would hand assertions a different object than the one under test -
  // readAttempts() would then see disk only and never the in-memory floor.
  const ctx = { baseDir: base, spawner, ...authCtx, ...extraCtx };
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return { server, origin, base, calls, authCtx: ctx };
}

function stop({ server, base }) {
  server.close();
  removeFixtureBase(base);
}

// ============================================================
// Unconfigured agent
// ============================================================

test('unconfigured: GET /api/projects -> 403 setup_required, exact body', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/projects`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'setup_required' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: GET /api/sessions -> 403 setup_required', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/sessions`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'setup_required' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: POST /api/sessions -> 403, spawner never called', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    assert.equal(res.status, 403);
    assert.equal(ctxState.calls.length, 0);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: GET /api/auth/status -> 200 exact body', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { configured: false, retry_after_ms: 0 });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: POST /api/auth/unlock -> 403 not_configured', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'not_configured' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: GET /api/whatever-nonexistent -> 403 setup_required, not 404 (no route enumeration)', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/whatever-nonexistent`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'setup_required' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: GET /nope -> 404 not_found (non-API paths unchanged)', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: static assets serve 200 with no token (the lock screen must render)', async () => {
  const ctxState = await startServer();
  try {
    const paths = ['/index.html', '/app.css', '/app.js', '/api.js', '/lock.js', '/sw.js', '/manifest.webmanifest', '/icons/icon.svg'];
    for (const p of paths) {
      const res = await fetch(`${ctxState.origin}${p}`);
      assert.equal(res.status, 200, p);
    }
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('unconfigured: the 403 body text leaks no fixture names, paths, or stack fragments', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/projects`);
    const text = await res.text();
    for (const forbidden of ['email-lint', 'Pull Requests', 'Video Editing', ':\\', '/', 'Error', 'at ']) {
      assert.ok(!text.includes(forbidden), `403 body must not contain "${forbidden}": ${text}`);
    }
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

// ============================================================
// Setting the passcode
// ============================================================

test('POST /api/auth/passcode -> 201, exact keys, expires_at ~12h ahead', async () => {
  const ctxState = await startServer();
  try {
    const before = Date.now();
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['expires_at', 'token'].sort());
    const expiresMs = Date.parse(body.expires_at);
    assert.ok(Number.isFinite(expiresMs));
    const twelveHours = 12 * 60 * 60 * 1000;
    assert.ok(Math.abs(expiresMs - (before + twelveHours)) < 60_000, 'expires_at should be ~12h ahead');
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('the 201 body does not contain the plaintext passcode', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    const text = await res.text();
    assert.ok(!text.includes('481902'));
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('immediately after setting, GET /api/projects with the token -> 200 and fixture names', async () => {
  const ctxState = await startServer();
  try {
    const setRes = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    const { token } = await setRes.json();
    const res = await fetch(`${ctxState.origin}/api/projects`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.projects.map((p) => p.name);
    assert.deepEqual(names, ['email-lint', 'Pull Requests', 'Video Editing']);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('setting the passcode again -> 409 already_configured', async () => {
  const ctxState = await startServer();
  try {
    await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '111222', confirm: '111222' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'already_configured' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('fresh agent: mismatched confirm -> 400 passcode_mismatch, status still unconfigured', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481903' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'passcode_mismatch' });
    const statusRes = await fetch(`${ctxState.origin}/api/auth/status`);
    assert.deepEqual(await statusRes.json(), { configured: false, retry_after_ms: 0 });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('fresh agent: weak passcode -> 400 passcode_too_weak, status still unconfigured', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '123456', confirm: '123456' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'passcode_too_weak' });
    const statusRes = await fetch(`${ctxState.origin}/api/auth/status`);
    assert.deepEqual(await statusRes.json(), { configured: false, retry_after_ms: 0 });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('body over 8 KB to /api/auth/passcode -> 413 payload_too_large', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902', pad: 'x'.repeat(9 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'payload_too_large' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

// ============================================================
// Configured agent
// ============================================================

async function startConfigured() {
  const ctxState = await startServer();
  seedPasscode(ctxState.authCtx, '481902');
  const token = issueTestToken(ctxState.authCtx);
  ctxState.token = token;
  ctxState.authedFetch = makeAuthedFetch(ctxState.origin, token);
  return ctxState;
}

test('configured: GET /api/projects with no header -> 401 unauthorized, exact body', async () => {
  const ctxState = await startConfigured();
  try {
    const res = await fetch(`${ctxState.origin}/api/projects`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: garbage token -> 401 unauthorized', async () => {
  const ctxState = await startConfigured();
  try {
    const res = await fetch(`${ctxState.origin}/api/projects`, { headers: authHeaders('garbage') });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: a token whose entry has an injected past expires_at -> 401 token_expired', async () => {
  const ctxState = await startConfigured();
  try {
    const digest = crypto.createHash('sha256').update(ctxState.token).digest('hex');
    ctxState.authCtx.tokens.set(digest, { expiresAt: Date.now() - 1000 });
    const res = await fetch(`${ctxState.origin}/api/projects`, { headers: authHeaders(ctxState.token) });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'token_expired' });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: GET /api/whatever-nonexistent -> 401 with no token, 404 with a valid token', async () => {
  const ctxState = await startConfigured();
  try {
    const noToken = await fetch(`${ctxState.origin}/api/whatever-nonexistent`);
    assert.equal(noToken.status, 401);
    const withToken = await ctxState.authedFetch('/api/whatever-nonexistent');
    assert.equal(withToken.status, 404);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: POST /api/sessions -> 401 + spawner count 0 with no token; 202 + count 1 with a token', async () => {
  const ctxState = await startConfigured();
  try {
    const noToken = await fetch(`${ctxState.origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    assert.equal(noToken.status, 401);
    assert.equal(ctxState.calls.length, 0);

    const withToken = await ctxState.authedFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    assert.equal(withToken.status, 202);
    assert.equal(ctxState.calls.length, 1);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: POST /api/auth/unlock with the right code -> 200 + a token that works on /api/projects', async () => {
  const ctxState = await startConfigured();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902' }),
    });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const projRes = await fetch(`${ctxState.origin}/api/projects`, { headers: authHeaders(token) });
    assert.equal(projRes.status, 200);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: wrong code x3 -> 401 passcode_incorrect each time, retry_after_ms 0', async () => {
  const ctxState = await startConfigured();
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: '111222' }),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'passcode_incorrect');
      assert.equal(body.retry_after_ms, 0);
    }
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: 4th wrong -> retry_after_ms >= 1000; 5th -> 429 with a Retry-After header', async () => {
  const ctxState = await startConfigured();
  try {
    const wrongUnlock = () => fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '111222' }),
    });
    for (let i = 0; i < 3; i++) await wrongUnlock();
    const fourth = await wrongUnlock();
    assert.equal(fourth.status, 401);
    const fourthBody = await fourth.json();
    assert.ok(fourthBody.retry_after_ms >= 1000);

    const fifth = await wrongUnlock();
    assert.equal(fifth.status, 429);
    const retryAfter = Number(fifth.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: while 429ing, GET /api/auth/status reports configured true, retry_after_ms > 0, exact keys', async () => {
  const ctxState = await startConfigured();
  try {
    const wrongUnlock = () => fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '111222' }),
    });
    for (let i = 0; i < 4; i++) await wrongUnlock();
    const res = await fetch(`${ctxState.origin}/api/auth/status`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['configured', 'retry_after_ms'].sort());
    assert.equal(body.configured, true);
    assert.ok(body.retry_after_ms > 0);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: over-8KB body to unlock -> 413, failures unchanged', async () => {
  const ctxState = await startConfigured();
  try {
    const before = readAttempts(ctxState.authCtx).failures;
    const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '481902', pad: 'x'.repeat(9 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal(readAttempts(ctxState.authCtx).failures, before);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: malformed passcode to unlock -> 400 malformed_passcode, failures unchanged', async () => {
  const ctxState = await startConfigured();
  try {
    const before = readAttempts(ctxState.authCtx).failures;
    const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '12345' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'malformed_passcode' });
    assert.equal(readAttempts(ctxState.authCtx).failures, before);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: every 401/403/429 response carries JSON content-type, never HTML', async () => {
  const ctxState = await startConfigured();
  try {
    const responses = await Promise.all([
      fetch(`${ctxState.origin}/api/projects`),
      fetch(`${ctxState.origin}/api/auth/unlock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: '111222' }),
      }),
    ]);
    for (const res of responses) {
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    }
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('configured: HOST is exactly 127.0.0.1 (guard against the superseded Tailscale-IP bind clause)', () => {
  assert.equal(HOST, '127.0.0.1');
});

// ============================================================
// Ordering / regression guards
// ============================================================

test('server.js source contains no Tailscale identity header and no x-forwarded-for', () => {
  const source = fs.readFileSync(path.join(AGENT_DIR, 'server.js'), 'utf8');
  assert.ok(!/Tailscale-User-Login/i.test(source));
  assert.ok(!/x-forwarded-for/i.test(source));
});

// The no-dependencies assertion lives in pwa-assets.test.js and is not
// duplicated here.

// The two unauthenticated auth POSTs are the only routes a cross-origin page
// can reach without a preflight: a text/plain POST is a CORS *simple*
// request, so before the Content-Type check these two landed. Both tests
// assert the side effect is gone, not just the status code.

test('cross-origin-shaped text/plain POST to /api/auth/unlock -> 415, and burns no attempt', async () => {
  const ctxState = await startConfigured();
  try {
    const before = readAttempts(ctxState.authCtx).failures;
    const res = await fetch(`${ctxState.origin}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ passcode: '111222' }),
    });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
    // Before the fix this was a counted 401, so a hostile page could force
    // the owner into a lockout it never had to authenticate for.
    assert.equal(readAttempts(ctxState.authCtx).failures, before);
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

test('cross-origin-shaped text/plain POST to /api/auth/passcode -> 415, agent stays unconfigured', async () => {
  const ctxState = await startServer();
  try {
    const res = await fetch(`${ctxState.origin}/api/auth/passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ passcode: '481902', confirm: '481902' }),
    });
    assert.equal(res.status, 415);
    // Before the fix this returned 201 - a drive-by page could claim the
    // passcode on a not-yet-configured agent.
    const statusRes = await fetch(`${ctxState.origin}/api/auth/status`);
    assert.deepEqual(await statusRes.json(), { configured: false, retry_after_ms: 0 });
  } finally {
    stop(ctxState);
    cleanupAuthCtx(ctxState.authCtx);
  }
});

// --------------------------------------------------------------------------
// The fixture guard itself. `registryPath` and `pidDir` were not the only keys
// that fall back to the real world: sessions.js does
// `const { baseDir, spawner = spawn } = ctx`, so a fixture server built without
// a spawner launches a REAL detached PowerShell -> WSL -> tmux session and puts
// console windows on the owner's desktop. These two tests are the reason
// fixtureServer substitutes a throwing stub; delete the stub and they fail.

test('fixtureServer: a ctx with no spawner never reaches the real spawn', async () => {
  const base = makeFixtureBase();
  const authCtx = makeAuthCtx();
  const ctx = { baseDir: base, ...authCtx }; // deliberately no spawner
  seedPasscode(ctx, '481902');
  const server = fixtureServer(ctx);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(issueTestToken(ctx)) },
      body: JSON.stringify({ project: 'email-lint' }), // a VALID project, so the route reaches the spawner
    });
    // The stub throws, so the launch fails loudly instead of starting a real
    // session. What matters is that it is NOT 202 - that would mean spawned.
    // Deliberately NOT asserting session-pids/ is absent: launchSession
    // mkdirSync's it BEFORE it spawns, which is exactly why pidDir falling
    // back to the real dir left no trace and went unnoticed.
    assert.equal(res.status, 500);
  } finally {
    server.close();
    removeFixtureBase(base);
    cleanupAuthCtx(authCtx);
  }
});

test('fixtureServer: an explicit spawner:undefined cannot reinstate the real spawn', async () => {
  const base = makeFixtureBase();
  const authCtx = makeAuthCtx();
  // The subtle case: a `{ spawner: stub, ...ctx }` form would spread this undefined straight
  // over the stub, and sessions.js's `spawner = spawn` default then resolves to
  // the real thing. fixtureServer's typeof check is what stops it.
  const ctx = { baseDir: base, spawner: undefined, ...authCtx };
  seedPasscode(ctx, '481902');
  const server = fixtureServer(ctx);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(issueTestToken(ctx)) },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    assert.equal(res.status, 500);
  } finally {
    server.close();
    removeFixtureBase(base);
    cleanupAuthCtx(authCtx);
  }
});
