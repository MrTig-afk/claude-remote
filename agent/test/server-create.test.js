import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-server-create-'));
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

function postJson(body) {
  return authedFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /api/projects with a valid name -> 201, exact body', async () => {
  const res = await postJson({ name: 'new-thing' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.deepEqual(body, { project: { name: 'new-thing' } });
});

test('201 response carries Cache-Control: no-store', async () => {
  const res = await postJson({ name: 'cache-check' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('no path leak: base path never appears in a 201, a 4xx, or the 500 base_unavailable body', async () => {
  const res201 = await postJson({ name: 'leak-check' });
  const body201 = await res201.json();
  assert.equal(JSON.stringify(body201).includes(base), false);

  const res400 = await postJson({ name: '..' });
  const body400 = await res400.json();
  assert.equal(JSON.stringify(body400).includes(base), false);

  // Same authCtx (same tokens Map) so the one token above authorizes here too.
  const missingBaseServer = fixtureServer({ baseDir: path.join(base, 'does-not-exist'), ...authCtx });
  await new Promise((resolve) => missingBaseServer.listen(0, '127.0.0.1', resolve));
  const missingPort = missingBaseServer.address().port;
  try {
    const res500 = await makeAuthedFetch(`http://127.0.0.1:${missingPort}`, token)('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'anything' }),
    });
    const body500 = await res500.json();
    assert.equal(JSON.stringify(body500).includes(base), false);
  } finally {
    missingBaseServer.close();
  }
});

test('{"name":".."} -> 400, body deepEqual { error: "name_has_traversal" }', async () => {
  const res = await postJson({ name: '..' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'name_has_traversal' });
});

test('malformed JSON body -> 400 invalid_request', async () => {
  const res = await postJson('{not json');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid_request' });
});

test('{} (no name) -> 400 invalid_request', async () => {
  const res = await postJson({});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid_request' });
});

test('{"name":123} -> 400 invalid_request', async () => {
  const res = await postJson({ name: 123 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid_request' });
});

test('a JSON array body -> 400 invalid_request', async () => {
  const res = await postJson([1, 2, 3]);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid_request' });
});

test('body > 8 KiB -> 413 payload_too_large', async () => {
  const res = await authedFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(9000) }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.deepEqual(body, { error: 'payload_too_large' });
});

test('duplicate create over HTTP -> 409, body deepEqual { error: "project_exists" }', async () => {
  await postJson({ name: 'dup-http' });
  const res = await postJson({ name: 'dup-http' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body, { error: 'project_exists' });
});

test('a name with a space round-trips intact', async () => {
  const res = await postJson({ name: 'Pull Requests 2' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body, { project: { name: 'Pull Requests 2' } });
});

test('a created project appears in the very next GET /api/projects, sorted into place', async () => {
  await postJson({ name: 'Zebra Project' });
  const res = await authedFetch('/api/projects');
  const body = await res.json();
  const names = body.projects.map((p) => p.name);
  assert.ok(names.includes('Zebra Project'));
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  assert.deepEqual(names, sorted);
});

test('missing base dir server -> 500, body deepEqual { error: "base_unavailable" }', async () => {
  const missingBaseServer = fixtureServer({ baseDir: path.join(base, 'does-not-exist-2'), ...authCtx });
  await new Promise((resolve) => missingBaseServer.listen(0, '127.0.0.1', resolve));
  const missingPort = missingBaseServer.address().port;
  try {
    const res = await makeAuthedFetch(`http://127.0.0.1:${missingPort}`, token)('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'anything' }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'base_unavailable' });
  } finally {
    missingBaseServer.close();
  }
});

test('PUT /api/projects -> 404 not_found', async () => {
  const res = await authedFetch('/api/projects', { method: 'PUT' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('DELETE /api/projects -> 404 not_found', async () => {
  const res = await authedFetch('/api/projects', { method: 'DELETE' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('POST /api/projects/ (trailing slash) -> 404 not_found', async () => {
  const res = await authedFetch('/api/projects/', { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('POST /api/sessions still behaves exactly as before (server edit was additive)', async () => {
  const res = await authedFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: '../nope' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_project');
});
