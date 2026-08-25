import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

function read(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

function existsUnderPublic(relPath) {
  // relPath is always origin-relative ('/foo/bar') in this app.
  const rel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
  return fs.existsSync(path.join(PUBLIC_DIR, rel));
}

// --- SW behaviour, via node:vm ---

function loadServiceWorker() {
  const source = read('sw.js');
  const listeners = {};
  const caches = new Map();

  const fakeSelf = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    skipWaiting() {},
    clients: { claim: async () => {} },
    location: { origin: 'http://127.0.0.1:8790' },
  };

  const fakeCaches = {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const store = caches.get(name);
      return {
        async addAll() {},
        async put() {},
        async match() { return undefined; },
      };
    },
    async keys() { return [...caches.keys()]; },
    async delete() { return true; },
    async match() { return undefined; },
  };

  const fakeFetch = async () => ({ ok: true, status: 200, type: 'basic', clone: () => ({}) });

  const context = {
    self: fakeSelf,
    caches: fakeCaches,
    fetch: fakeFetch,
    URL,
    Response,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });

  return listeners;
}

test('sw.js never intercepts /api/* - respondWith is never called for an API request', async () => {
  const listeners = loadServiceWorker();
  assert.ok(listeners.fetch, 'sw.js must register a fetch listener');

  for (const p of ['/api/projects', '/api/sessions']) {
    for (const method of ['GET', 'POST']) {
      let responded = false;
      const event = {
        request: { url: `http://127.0.0.1:8790${p}`, method, mode: 'same-origin' },
        respondWith() { responded = true; },
      };
      listeners.fetch(event);
      // Allow any microtask inside the handler to run before asserting.
      await new Promise((r) => setImmediate(r));
      assert.equal(responded, false, `${method} ${p} must never be intercepted`);
    }
  }
});

test('sw.js DOES intercept a same-origin GET asset request', async () => {
  const listeners = loadServiceWorker();
  let responded = false;
  const event = {
    request: { url: 'http://127.0.0.1:8790/app.css', method: 'GET', mode: 'same-origin' },
    respondWith() { responded = true; },
  };
  listeners.fetch(event);
  await new Promise((r) => setImmediate(r));
  assert.equal(responded, true);
});

test('PRECACHE contains no entry beginning /api', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  assert.ok(match, 'PRECACHE array literal not found');
  // eslint-disable-next-line no-eval
  const precache = new Function(`return ${match[1]};`)();
  assert.ok(Array.isArray(precache) && precache.length > 0);
  for (const entry of precache) {
    // Matches the server's own boundary (serveStatic): '/api/' or the bare
    // '/api' - not a plain string prefix, which would also flag a
    // legitimate asset like '/api.js'.
    assert.ok(
      !(entry.startsWith('/api/') || entry === '/api'),
      `PRECACHE entry ${entry} must not be under /api`,
    );
  }
});

test('every PRECACHE entry other than / maps to a file that exists under agent/public', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  const precache = new Function(`return ${match[1]};`)();
  for (const entry of precache) {
    if (entry === '/') continue;
    assert.ok(existsUnderPublic(entry), `PRECACHE entry ${entry} does not exist under agent/public`);
  }
});

test('sw.js contains skipWaiting and clients.claim', () => {
  const source = read('sw.js');
  assert.match(source, /skipWaiting/);
  assert.match(source, /clients\.claim/);
});

// --- Manifest ---

test('manifest.webmanifest parses and matches the required shape', () => {
  const source = read('manifest.webmanifest');
  const manifest = JSON.parse(source);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0a0d0a');
  assert.equal(manifest.background_color, '#0a0d0a');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.ok(existsUnderPublic(icon.src), `manifest icon ${icon.src} does not exist under agent/public`);
  }
  assert.ok(
    manifest.icons.some((icon) => typeof icon.purpose === 'string' && icon.purpose.includes('maskable')),
    'at least one icon must have purpose including maskable',
  );
});

// --- index.html ---

test('index.html links the manifest and an apple-touch-icon, and every local href/src resolves', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /apple-touch-icon/);

  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'expected at least one local href/src in index.html');
  for (const ref of refs) {
    assert.ok(existsUnderPublic(ref), `index.html references ${ref}, which does not exist under agent/public`);
  }
});

// --- Token compliance ---

const TOKEN_SET = new Set([
  '0a0d0a', '0f150f', 'eafbea', 'c9d1c9', '9aab9a', '4a5a4a',
  '3d4a3d', '2a332a', '7ee787', '5fae6f', '1b231b', '6b7a6b',
]);

function assertOnlyTokenColours(source, label) {
  const hexes = source.match(/#[0-9a-fA-F]{3,8}/g) || [];
  for (const hex of hexes) {
    const normalized = hex.slice(1).toLowerCase();
    assert.ok(TOKEN_SET.has(normalized), `${label} contains an untokenized colour: ${hex}`);
  }
}

test('app.css uses only tokenized colours', () => {
  assertOnlyTokenColours(read('app.css'), 'app.css');
});

test('index.html uses only tokenized colours', () => {
  assertOnlyTokenColours(read('index.html'), 'index.html');
});

test('app.js uses only tokenized colours', () => {
  assertOnlyTokenColours(read('app.js'), 'app.js');
});

test('icons/icon.svg uses only tokenized colours', () => {
  assertOnlyTokenColours(read('icons/icon.svg'), 'icons/icon.svg');
});

test('app.css contains the required literal values', () => {
  const css = read('app.css');
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /gap:\s*5px/);
  assert.match(css, /letter-spacing:\s*0\.08em/);
  assert.match(css, /border-radius:\s*4px/);
});

// --- Single API surface ---

test('app.js never calls fetch() directly; api.js does', () => {
  assert.ok(!read('app.js').includes('fetch('), 'app.js must not call fetch() directly');
  assert.ok(read('api.js').includes('fetch('), 'api.js must be the one place fetch() is called');
});

// --- No egress ---

test('no shipped asset embeds an absolute http(s) URL', () => {
  for (const f of ['index.html', 'app.css', 'app.js', 'api.js', 'sw.js']) {
    const source = read(f);
    assert.ok(!source.includes('http://'), `${f} must not contain http://`);
    assert.ok(!source.includes('https://'), `${f} must not contain https://`);
  }
});

// --- Zero dependencies ---

test('agent/package.json has neither dependencies nor devDependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

// --- No polling ---

test('app.js has no standing poll: no setInterval, one bounded sleep', () => {
  for (const f of ['app.js', 'api.js']) {
    assert.ok(!read(f).includes('setInterval'), `${f} must not use setInterval`);
  }
  assert.ok(!read('api.js').includes('setTimeout'), 'api.js must not use setTimeout');
  const hits = read('app.js').split('setTimeout').length - 1;
  assert.ok(hits <= 1, `app.js must have at most one setTimeout (the sleep helper), found ${hits}`);
});
