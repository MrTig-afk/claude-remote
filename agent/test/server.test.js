import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { HOST, DEFAULT_PORT } from '../server.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-server-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));

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
