import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, describe, before } from 'node:test';

import { serveStatic } from '../static.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-static-'));
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
  const res = await authedFetch('/api/projects');
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

test('PUT /api/projects still 404 (only GET and POST exist)', async () => {
  const res = await authedFetch('/api/projects', { method: 'PUT' });
  assert.equal(res.status, 404);
});

test('POST / responds 404 (static is GET-only)', async () => {
  const res = await fetch(`${origin}/`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('GET /api/index.html responds 404 (nothing under /api is ever read from disk)', async () => {
  const res = await authedFetch('/api/index.html');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'not_found' });
});

test('GET /api/projects/ (trailing slash) still 404', async () => {
  const res = await authedFetch('/api/projects/');
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

// serveStatic called DIRECTLY, unit-style, with un-normalised pathname
// strings pointing at files that
// REALLY EXIST. The traversal block above drives everything through the
// HTTP server, and new URL() in server.js normalises '..' away before
// serveStatic is ever reached - and its surviving targets don't exist on
// disk either - so that block cannot tell a working guard from a deleted
// one. These tests bypass new URL() entirely and target real files, so a
// deleted guard actually serves the file (res.writeHead gets called)
// instead of just returning false for an unrelated reason. Every case here
// asserts both the return value AND that nothing was written to the fake
// response - a guard that returns false but only after already writing
// would still be a bug. ---

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function fakeRes() {
  const res = { headWritten: false, wrote: false };
  res.writeHead = () => { res.headWritten = true; };
  res.write = () => { res.wrote = true; };
  res.end = () => { res.wrote = true; };
  res.destroy = () => {};
  return res;
}

function assertRefused(pathname) {
  const res = fakeRes();
  const result = serveStatic(res, pathname);
  assert.equal(result, false, pathname);
  assert.equal(res.headWritten, false, `${pathname}: a header was written`);
  assert.equal(res.wrote, false, `${pathname}: a body was written`);
}

describe('serveStatic() called directly: traversal targets that really exist on disk', () => {
  // Literal backslash built at runtime, not typed into this source file:
  // writing one through a shell heredoc has silently corrupted regexes in
  // this repo before, baking in a byte that could then never match.
  const BACKSLASH = String.fromCharCode(92);

  const DIRECT_TRAVERSAL_CASES = [
    '/../static.js', // agent/static.js - one level above public/
    `/..${BACKSLASH}static.js`, // same target, backslash separator
    '/%2e%2e/static.js', // same target, percent-encoded
    '/a/../../package.json', // agent/package.json, via a real subsegment first
    '/C:/Windows/win.ini', // Windows drive-letter form, not on disk regardless
    '/../../CLAUDE.md', // repo-root CLAUDE.md - two levels above public/
  ];

  for (const p of DIRECT_TRAVERSAL_CASES) {
    test(`serveStatic() refuses: ${p}`, () => assertRefused(p));
  }

  test('sanity: the real target files this block relies on actually exist', () => {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, '..', 'static.js')));
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, '..', 'package.json')));
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, '..', '..', 'CLAUDE.md')));
  });
});

describe('serveStatic() called directly: per-segment regex, with a real file the regex - but nothing else - rejects', () => {
  // A leading dot is disallowed by FILE (`^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$`,
  // which requires the name part before the extension's one dot to be
  // alnum/dash/underscore) but is NOT one of the BAD_CHARS (% \ : //) and
  // does not escape PUBLIC_DIR, so this is the one probe that isolates the
  // per-segment regex from the containment check and from BAD_CHARS: both
  // of those pass a leading-dot filename straight through.
  const dotFilePath = path.join(PUBLIC_DIR, '.hidden.js');

  before(() => {
    fs.writeFileSync(dotFilePath, '// regex probe\n');
  });

  after(() => {
    fs.rmSync(dotFilePath, { force: true });
  });

  test('serveStatic() refuses a real dot-leading filename (fails FILE, passes containment)', () => {
    assertRefused('/.hidden.js');
  });
});

describe('serveStatic() called directly: extension allowlist, with a real file', () => {
  const probePath = path.join(PUBLIC_DIR, 'probe.txt');

  before(() => {
    fs.writeFileSync(probePath, 'not an allowlisted extension\n');
  });

  after(() => {
    fs.rmSync(probePath, { force: true });
  });

  test('serveStatic() refuses a real .txt file (extension not on the allowlist)', () => {
    assertRefused('/probe.txt');
  });
});

describe('serveStatic() called directly: depth cap, with real files past it', () => {
  const deepDir = path.join(PUBLIC_DIR, 'd1', 'd2', 'd3', 'd4');
  const deepFile = path.join(deepDir, 'deep.js');

  before(() => {
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(deepFile, '// depth-cap probe\n');
  });

  after(() => {
    fs.rmSync(path.join(PUBLIC_DIR, 'd1'), { recursive: true, force: true });
  });

  test('serveStatic() refuses a real file 5 segments deep (over the 4-segment cap)', () => {
    assertRefused('/d1/d2/d3/d4/deep.js');
  });
});

describe('serveStatic() called directly: symlink refusal (lstat, not stat)', () => {
  const linkPath = path.join(PUBLIC_DIR, 'symlink-escape.js');

  before(() => {
    // Points OUTSIDE public/ at a real file - if the guard swapped lstat
    // for stat, this would resolve through the link and get served.
    fs.symlinkSync(path.join(PUBLIC_DIR, '..', 'static.js'), linkPath, 'file');
  });

  after(() => {
    fs.rmSync(linkPath, { force: true });
  });

  test('serveStatic() refuses a symlink planted in public/ pointing outside it', () => {
    assertRefused('/symlink-escape.js');
  });
});
