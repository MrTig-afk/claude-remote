import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { createAgentServer } from '../server.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-static-'));

const server = createAgentServer({ baseDir: base });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  server.close();
});

/**
 * Sends a raw, already-encoded request path verbatim - Node's global
 * fetch()/Request normalizes '..' and some percent-encodings away before
 * the request ever leaves the client, so the traversal block below uses
 * http.request({ path }) directly, which puts the string on the wire
 * unmodified.
 */
function rawGet(rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: rawPath,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Serving ---

test('GET / responds 200 with the app shell', async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const body = await res.text();
  assert.match(body, /<title>claude-remote/);
  assert.match(body, /id="projects"/);
});

test('GET /index.html responds 200 html', async () => {
  const res = await fetch(`${origin}/index.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('GET /app.css responds 200 css', async () => {
  const res = await fetch(`${origin}/app.css`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('GET /app.js responds 200 javascript', async () => {
  const res = await fetch(`${origin}/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('GET /api.js responds 200 javascript', async () => {
  const res = await fetch(`${origin}/api.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('GET /sw.js responds 200 javascript', async () => {
  const res = await fetch(`${origin}/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('GET /manifest.webmanifest responds 200 with parseable JSON', async () => {
  const res = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  const body = await res.text();
  assert.doesNotThrow(() => JSON.parse(body));
});

test('GET /icons/icon.svg responds 200 svg', async () => {
  const res = await fetch(`${origin}/icons/icon.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
});

test('GET /icons/icon-192.png responds 200 png with a valid PNG signature', async () => {
  const res = await fetch(`${origin}/icons/icon-192.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.byteLength > 100);
});

test('GET /icons/icon-512.png responds 200 png with a valid PNG signature', async () => {
  const res = await fetch(`${origin}/icons/icon-512.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.byteLength > 100);
});

test('every static 200 carries X-Content-Type-Options: nosniff and Cache-Control: no-cache', async () => {
  for (const p of ['/', '/app.css', '/app.js', '/icons/icon.svg']) {
    const res = await fetch(`${origin}${p}`);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('cache-control'), 'no-cache', p);
  }
});

// --- Regression: the T27/T28/T29 surface is untouched ---

test('GET /api/projects still 200 with a projects array (static did not shadow it)', async () => {
  const res = await fetch(`${origin}/api/projects`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.projects));
});

test('GET /nope still 404 with the exact not_found body', async () => {
  const res = await fetch(`${origin}/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('PUT /api/projects still 404 (only POST was added, in T31)', async () => {
  const res = await fetch(`${origin}/api/projects`, { method: 'PUT' });
  assert.equal(res.status, 404);
});

test('POST / responds 404 (static is GET-only)', async () => {
  const res = await fetch(`${origin}/`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('GET /api/index.html responds 404 (nothing under /api is ever read from disk)', async () => {
  const res = await fetch(`${origin}/api/index.html`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('GET /api/projects/ (trailing slash) still 404', async () => {
  const res = await fetch(`${origin}/api/projects/`);
  assert.equal(res.status, 404);
});

// --- Traversal: every case asserts 404, the exact not_found body, and the
// JSON content-type. Sent via raw http.request so nothing is normalized
// away before it reaches the server. ---

const TRAVERSAL_CASES = [
  '/../server.js',
  '/../../CLAUDE.md',
  '/../../../Windows/win.ini',
  '/..%2fserver.js',
  '/%2e%2e/server.js',
  '/%2e%2e%2fserver.js',
  '/%252e%252e/server.js',
  '/....//server.js',
  '/..\\server.js',
  '/..%5cserver.js',
  '/C:/Windows/win.ini',
  '/C:\\Windows\\win.ini',
  '//127.0.0.1/share/x.js',
  '/%5c%5cserver%5cshare%5cx.js',
  '/app.css/../../server.js',
  '/.env',
  '/.git/config',
  '/sw.js%00.png',
  '/index.html.',
  '/index.html%20',
];

for (const rawPath of TRAVERSAL_CASES) {
  test(`traversal rejected: ${rawPath}`, async () => {
    const res = await rawGet(rawPath);
    assert.equal(res.status, 404, rawPath);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', rawPath);
    assert.deepEqual(JSON.parse(res.text), { error: 'not_found' }, rawPath);
  });
}

test('leak check: a traversal response never contains a filesystem path or directory name', async () => {
  const res = await rawGet('/../server.js');
  assert.doesNotMatch(res.text, /[A-Za-z]:\\|\\\\|\/(Users|Dev)\/|public|agent\//);
});

// --- Other rejections ---

test('GET /icons (no trailing slash, no extension) -> 404', async () => {
  const res = await fetch(`${origin}/icons`);
  assert.equal(res.status, 404);
});

test('GET /icons/ (trailing slash) -> 404, no directory listing', async () => {
  const res = await fetch(`${origin}/icons/`);
  assert.equal(res.status, 404);
});

test('GET /notes.txt -> 404 (extension not on the allowlist)', async () => {
  const res = await fetch(`${origin}/notes.txt`);
  assert.equal(res.status, 404);
});

test('GET /a/b/c/d/e/f.js -> 404 (depth cap)', async () => {
  const res = await fetch(`${origin}/a/b/c/d/e/f.js`);
  assert.equal(res.status, 404);
});

test('GET / + a 300-character segment -> 404 (length cap)', async () => {
  const res = await fetch(`${origin}/${'a'.repeat(300)}.js`);
  assert.equal(res.status, 404);
});

test('GET /icon.svg (exists only under /icons/) -> 404, no path guessing', async () => {
  const res = await fetch(`${origin}/icon.svg`);
  assert.equal(res.status, 404);
});

test('GET /static.js (real file one level above public/) -> 404', async () => {
  const res = await fetch(`${origin}/static.js`);
  assert.equal(res.status, 404);
});

test('GET /package.json (real file one level above public/) -> 404', async () => {
  const res = await fetch(`${origin}/package.json`);
  assert.equal(res.status, 404);
});
