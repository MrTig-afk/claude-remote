import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { HOST, DEFAULT_PORT, AGENT_VERSION } from '../server.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, authHeaders, fixtureServer } from './helper-auth.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-server-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, 'Pull Requests', 'Vercel'));   // makes 'Pull Requests' a container

const authCtx = makeAuthCtx();
seedPasscode(authCtx, '481902');
const token = issueTestToken(authCtx);

const server = fixtureServer({ baseDir: base, ...authCtx });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const authedFetch = makeAuthedFetch(origin, token);

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  cleanupAuthCtx(authCtx);
  server.close();
});

test('HOST is exactly 127.0.0.1', () => {
  assert.equal(HOST, '127.0.0.1');
});

test('DEFAULT_PORT is exactly 8790', () => {
  assert.equal(DEFAULT_PORT, 8790);
});

test('GET /api/projects responds 200 with the expected content-type', async () => {
  const res = await authedFetch('/api/projects');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('GET /api/projects body has a projects array matching the fixture directories', async () => {
  const res = await authedFetch('/api/projects');
  const body = await res.json();
  const names = body.projects.map((p) => p.name);
  assert.deepEqual(names, ['email-lint', 'Pull Requests', 'Video Editing']);
});

test('GET /api/projects?foo=1 still responds 200 (query string ignored)', async () => {
  const res = await authedFetch('/api/projects?foo=1');
  assert.equal(res.status, 200);
});

test('GET /nope responds 404 with the exact not_found body', async () => {
  const res = await fetch(`${origin}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('GET /nope responds with JSON content-type, not an HTML error page', async () => {
  const res = await fetch(`${origin}/nope`);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('GET /api/projects/ (trailing slash) responds 404 (surface not widened)', async () => {
  const res = await authedFetch('/api/projects/');
  assert.equal(res.status, 404);
});

test('PUT /api/projects responds 404 (only GET and POST exist)', async () => {
  const res = await authedFetch('/api/projects', { method: 'PUT' });
  assert.equal(res.status, 404);
});

test('GET /api/projects serializes the container shape', async () => {
  const res = await authedFetch('/api/projects');
  const body = await res.json();
  const entry = body.projects.find((p) => p.name === 'Pull Requests');
  assert.equal(entry.container, true);
  assert.deepEqual(entry.children, [{ name: 'Vercel', path: path.join(base, 'Pull Requests', 'Vercel') }]);
});

test('GET /api/projects leaves an ordinary project undecorated', async () => {
  const res = await authedFetch('/api/projects');
  const body = await res.json();
  for (const name of ['email-lint', 'Video Editing']) {
    const entry = body.projects.find((p) => p.name === name);
    assert.equal(Object.hasOwn(entry, 'container'), false);
    assert.equal(Object.hasOwn(entry, 'children'), false);
  }
});

test('GET /api/projects against a missing base directory responds 200 with an empty list', async () => {
  const missingBaseServer = fixtureServer({ baseDir: path.join(base, 'does-not-exist'), ...authCtx });
  await new Promise((resolve) => missingBaseServer.listen(0, '127.0.0.1', resolve));
  const missingPort = missingBaseServer.address().port;
  try {
    const res = await makeAuthedFetch(`http://127.0.0.1:${missingPort}`, token)('/api/projects');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { projects: [] });
  } finally {
    missingBaseServer.close();
  }
});

// ============================================================
// GET /api/status - own local server per test (module server above is
// shared, so a test writing a config into authCtx.dir would leak into its
// neighbours).
// ============================================================

/**
 * A fresh authCtx pointed at its own config/release-notes files, so each
 * test's write cannot leak into another test sharing the module-scope
 * server. `config`/`releaseNotes` may be a plain object (stringified) or a
 * raw string (written as-is, for malformed-JSON cases). Omitting
 * `releaseNotes` points ctx.releaseNotesPath at a path that does not exist,
 * rather than leaving it undefined, so the test never depends on whatever
 * release-notes.json happens to sit at the repo root. `useRealNotes` is the
 * single deliberate exception to that rule: it leaves ctx.releaseNotesPath
 * undefined so readLatestRelease falls back to the real repo-root file; if
 * both `releaseNotes` and `useRealNotes` are passed, `releaseNotes` wins.
 */
async function startStatusServer(t, { config, releaseNotes, useRealNotes = false, passcode = '481902' } = {}) {
  const ctx = makeAuthCtx();

  if (config !== undefined) {
    fs.writeFileSync(ctx.configPath, typeof config === 'string' ? config : JSON.stringify(config));
  }

  if (releaseNotes !== undefined) {
    ctx.releaseNotesPath = path.join(ctx.dir, 'release-notes.json');
    fs.writeFileSync(ctx.releaseNotesPath, typeof releaseNotes === 'string' ? releaseNotes : JSON.stringify(releaseNotes));
  } else if (!useRealNotes) {
    ctx.releaseNotesPath = path.join(ctx.dir, 'no-release-notes.json');
  }

  if (passcode !== null) seedPasscode(ctx, passcode);
  const token = passcode !== null ? issueTestToken(ctx) : undefined;

  let server;
  t.after(() => {
    server?.close();
    cleanupAuthCtx(ctx);
  });
  server = fixtureServer({ baseDir: ctx.dir, ...ctx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, token, ctx };
}

// --- Placement / auth - the security pins ---

test('GET /api/status: no passcode configured, no token -> 403 setup_required, exact body', async (t) => {
  const { origin } = await startStatusServer(t, { passcode: null });
  const res = await fetch(`${origin}/api/status`);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'setup_required' });
});

test('GET /api/status: passcode configured, no token -> 401 unauthorized, exact body', async (t) => {
  const { origin } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('GET /api/status: passcode configured, garbage token -> 401 (behind authorize, not just isConfigured)', async (t) => {
  const { origin } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders('garbage-token') });
  assert.equal(res.status, 401);
});

test('GET /api/auth/status on a fully configured agent never gains a version field', async (t) => {
  const { origin } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/auth/status`);
  assert.deepEqual(await res.json(), { configured: true, retry_after_ms: 0 });
});

// --- Happy path ---

test('GET /api/status: authenticated -> 200 with the exact JSON content-type', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('GET /api/status: body.version is AGENT_VERSION, a non-empty string', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.version, AGENT_VERSION);
  assert.equal(typeof body.version, 'string');
  assert.notEqual(body.version, '');
});

// --- acknowledged ---

test('GET /api/status: no config file at all -> acknowledged false', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.acknowledged, false);
});

test('GET /api/status: config {} -> acknowledged false', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: {} });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.acknowledged, false);
});

test('GET /api/status: config with a non-empty acknowledged_at -> acknowledged true', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: { acknowledged_at: '2026-08-29T13:04:11.882Z' } });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.acknowledged, true);
});

test('GET /api/status: config with acknowledged_at "" -> acknowledged false', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: { acknowledged_at: '' } });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.acknowledged, false);
});

// --- shared_count ---

test('GET /api/status: no config file -> shared_count 0', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.shared_count, 0);
});

test('GET /api/status: default_base_folder only -> shared_count 1', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: { default_base_folder: 'F:\\Dev\\Projects\\Repos' } });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.shared_count, 1);
});

test('GET /api/status: shared_folders with two entries -> shared_count 2', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: { shared_folders: ['a', 'b'] } });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.shared_count, 2);
});

test('GET /api/status: empty shared_folders beside a default_base_folder -> shared_count 0 (shared_folders wins)', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: { shared_folders: [], default_base_folder: 'F:\\x' } });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  const body = await res.json();
  assert.equal(body.shared_count, 0);
});

// --- never throws ---

test('GET /api/status: malformed config JSON -> 200, not 500, zero facts', async (t) => {
  const { origin, token } = await startStatusServer(t, { config: '{ not valid json' });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.acknowledged, false);
  assert.equal(body.shared_count, 0);
});

test('GET /api/status: ctx.configPath pointing at a directory -> 200, zero facts', async (t) => {
  const ctx = makeAuthCtx();
  fs.mkdirSync(ctx.configPath);
  ctx.releaseNotesPath = path.join(ctx.dir, 'no-release-notes.json');
  seedPasscode(ctx, '481902');
  const token = issueTestToken(ctx);
  let server;
  t.after(() => {
    server?.close();
    cleanupAuthCtx(ctx);
  });
  server = fixtureServer({ baseDir: ctx.dir, ...ctx });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.acknowledged, false);
  assert.equal(body.shared_count, 0);
});

// --- release ---

test('GET /api/status: missing release-notes file -> 200, no release key', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.hasOwn(body, 'release'), false);
});

test('GET /api/status: malformed release-notes JSON -> 200, no release key', async (t) => {
  const { origin, token } = await startStatusServer(t, { releaseNotes: '{ not valid json' });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.hasOwn(body, 'release'), false);
});

test('GET /api/status: empty-array release-notes -> 200, no release key', async (t) => {
  const { origin, token } = await startStatusServer(t, { releaseNotes: '[]' });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.hasOwn(body, 'release'), false);
});

test('GET /api/status: well-formed release-notes -> body.release deepEqual the newest entry', async (t) => {
  const entry = { version: '9.9.9', date: '2026-01-01', notes: ['x'] };
  const { origin, token } = await startStatusServer(t, { releaseNotes: [entry] });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.release, entry);
});

test('GET /api/status: release-notes entry missing notes -> 200, no release key', async (t) => {
  const { origin, token } = await startStatusServer(t, { releaseNotes: [{ version: '9.9.9' }] });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.hasOwn(body, 'release'), false);
});

test('GET /api/status serves the newest entry from the repo-root release-notes.json', async (t) => {
  const { origin, token } = await startStatusServer(t, { useRealNotes: true });
  const res = await fetch(`${origin}/api/status`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const expected = JSON.parse(fs.readFileSync(new URL('../../release-notes.json', import.meta.url), 'utf8'))[0];
  assert.deepEqual((await res.json()).release, expected);
});

// --- method / surface ---

test('PUT /api/status responds 404', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status`, { method: 'PUT', headers: authHeaders(token) });
  assert.equal(res.status, 404);
});

test('GET /api/status/ (trailing slash) responds 404', async (t) => {
  const { origin, token } = await startStatusServer(t);
  const res = await fetch(`${origin}/api/status/`, { headers: authHeaders(token) });
  assert.equal(res.status, 404);
});
