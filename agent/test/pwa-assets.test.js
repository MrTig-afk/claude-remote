import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { readServiceWorker } from '../static.js';
import { codeOnly } from './helper-source.js';
import * as folders from '../public/folders-ui.js';
import * as copy from '../public/copy.js';
import * as update from '../public/update-ui.js';
import { handoffReady } from '../public/handoff-ui.js';
import * as pushUi from '../public/push-ui.js';
import { setMsg } from '../public/lock.js';

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

// overrides lets a test replace `fetch` and the top-level caches.match, which
// is the only way to observe what the shell handler does when the agent is
// not answering - the case the whole cache strategy exists for.
function loadServiceWorker(overrides = {}) {
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
      // Storage blocked in a private window, or quota exhausted.
      if (overrides.cacheOpenFails) throw new Error('QuotaExceededError');
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
    // opts is threaded through DELIBERATELY. sw.js passes { cacheName: CACHE }
    // and the whole point of that argument is which caches get searched, so a
    // fake that swallowed it could not tell the scoped call from the bare one.
    async match(req, opts) {
      return overrides.cacheMatch ? overrides.cacheMatch(req, opts) : undefined;
    },
  };

  const fakeFetch = overrides.fetch
    || (async () => ({ ok: true, status: 200, type: 'basic', clone: () => ({}) }));

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

// --- Both cache lookups are SCOPED to this worker's own cache ---
//
// Bare caches.match searches EVERY cache in the origin, oldest first. activate()
// does delete the old ones, but its Promise.all sits in a waitUntil whose
// rejection is swallowed, so ONE failed delete - quota, storage pressure, an
// eviction race - leaves a stale cache in place. It then shadows the new shell
// on every launch, permanently, because install's addAll and the revalidate
// write both target CACHE only and nothing ever refreshes the old one. Settings
// > Reset is the only escape.
//
// Written after a mutation audit: both `{ cacheName: CACHE }` arguments could be
// deleted and all 1027 tests stayed green. `grep cacheName` over this file
// returned nothing, in a file that DOES execute sw.js - a file being executed is
// not the same as a fix being covered.

/**
 * A caches.match with the real multi-cache semantics: a named lookup searches
 * that cache alone, an unnamed one searches every cache in the origin, oldest
 * first. Insertion order into the Map IS the age order.
 */
function matchAcross(stores) {
  return (req, opts) => {
    const key = typeof req === 'string' ? `http://127.0.0.1:8790${req}` : req.url;
    if (opts && opts.cacheName) {
      const store = stores.get(opts.cacheName);
      return store ? store.get(key) : undefined;
    }
    for (const store of stores.values()) {
      const hit = store.get(key);
      if (hit) return hit;
    }
    return undefined;
  };
}

/** sw.js's own CACHE name, read from the source rather than restated here.
 *  Read once: nothing varies between calls, and `read` is a hoisted function
 *  declaration, so evaluating this at module scope is safe. */
const CURRENT_CACHE = (() => {
  const m = read('sw.js').match(/const CACHE = '([^']+)';/);
  assert.ok(m, "sw.js's CACHE literal not found - this test cannot be trusted without it");
  return m[1];
})();

/** Drives one GET through the fetch listener and returns what it answered. */
async function servedFor(listeners, url, mode) {
  let served;
  listeners.fetch({
    request: { url, method: 'GET', mode },
    respondWith(p) { served = p; },
  });
  assert.ok(served !== undefined, `${url} was not intercepted`);
  return served;
}

test('a stale cache that outlived its delete cannot shadow the current shell', async () => {
  // RED WHEN: `{ cacheName: CACHE }` is dropped from the asset lookup. The bare
  // call then finds the OLD cache first and serves the old app.js for ever.
  const stores = new Map([
    ['claude-remote-shell-stale', new Map([['http://127.0.0.1:8790/app.js', 'OLD SHELL']])],
    [CURRENT_CACHE, new Map([['http://127.0.0.1:8790/app.js', 'CURRENT SHELL']])],
  ]);
  const listeners = loadServiceWorker({
    cacheMatch: matchAcross(stores),
    fetch: async () => { throw new Error('agent not up'); },
  });
  assert.equal(
    await servedFor(listeners, 'http://127.0.0.1:8790/app.js', 'same-origin'),
    'CURRENT SHELL',
  );
});

test('the offline navigate fallback reads /index.html from THIS cache, not the oldest one', async () => {
  // RED WHEN: `{ cacheName: CACHE }` is dropped from the '/index.html' lookup.
  // A separate assertion from the one above because it is a separate call site:
  // reached only when the network is down AND the request itself is uncached,
  // which is the offline cold-open path. The requested URL is deliberately
  // absent from both stores so the fallback is what answers.
  const stores = new Map([
    ['claude-remote-shell-stale', new Map([['http://127.0.0.1:8790/index.html', 'OLD INDEX']])],
    [CURRENT_CACHE, new Map([['http://127.0.0.1:8790/index.html', 'CURRENT INDEX']])],
  ]);
  const listeners = loadServiceWorker({
    cacheMatch: matchAcross(stores),
    fetch: async () => { throw new Error('agent not up'); },
  });
  assert.equal(
    await servedFor(listeners, 'http://127.0.0.1:8790/deep/link', 'navigate'),
    'CURRENT INDEX',
  );
});

test('a named cache lookup that REJECTS falls through instead of failing the request', async () => {
  // RED WHEN: either `.catch(() => undefined)` is dropped from sw.js. Under the
  // older Service Worker spec a named caches.match rejects with NotFoundError
  // once that cache is gone; matchAcross above models only the modern
  // resolve-undefined behaviour, so this fake rejects on purpose.
  const notFound = async () => { throw new Error('NotFoundError'); };
  const net = { ok: true, status: 200, type: 'basic', clone: () => ({}) };
  const online = loadServiceWorker({ cacheMatch: notFound, fetch: async () => net });
  assert.equal(await servedFor(online, 'http://127.0.0.1:8790/app.js', 'same-origin'), net);

  const offline = loadServiceWorker({
    cacheMatch: notFound,
    fetch: async () => { throw new Error('agent not up'); },
  });
  const res = await servedFor(offline, 'http://127.0.0.1:8790/deep/link', 'navigate');
  assert.equal(res.status, 503);
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
  'ff7b72', 'e5534b',
  // Added with the "Reset the app" screen, which needs a CAUTION colour.
  // design/tokens.md had none - it has an accent and a danger and nothing
  // between them - so this is the userflow artifact's own amber, now recorded
  // in tokens.md as well. Caution is not danger: --danger stays reserved for
  // "this ends something", which clearing a cache is not.
  'e3b341',
  // Text drawn ON an accent fill. Not a background and not a text colour in
  // its own right - it exists only so the solid button has legible ink.
  '08170c',
  // A QR code's light modules: pure white, never the tinted text token
  // (owner 2026-10-02, it read as coloured). Used for nothing else.
  'ffffff',
]);

function assertOnlyTokenColours(source, label) {
  // A CSS/DOM id selector that happens to start with hex-valid letters
  // (#accept, #accept-go: a,c,c,e all parse as hex) is not a colour literal -
  // the regex below stops at the first non-hex character, so `#accept` yields
  // a false-positive match of `#acce`. A real hex colour is always followed
  // by a delimiter (`;`, `)`, `,`, whitespace, end of string), never by
  // another letter - so a match immediately followed by [a-zA-Z] is an
  // identifier, not a colour, and is excluded.
  const hexes = [...source.matchAll(/#[0-9a-fA-F]{3,8}/g)]
    .filter((m) => !/[a-zA-Z]/.test(source[m.index + m[0].length] || ''))
    .map((m) => m[0]);
  for (const hex of hexes) {
    const normalized = hex.slice(1).toLowerCase();
    assert.ok(TOKEN_SET.has(normalized), `${label} contains an untokenized colour: ${hex}`);
  }
}

// app.css is held to a STRICTER rule than the other three: not merely "every
// hex is a token" but "no hex outside the :root block at all". The weaker
// rule let a correct-but-hard-coded colour spread through 128 declarations,
// so changing one meant finding all of them. These two tests are what make
// the token block the single point of change rather than a convention.
test('app.css declares every colour ONCE, in :root', () => {
  const css = read('app.css');
  const rootEnd = css.indexOf('}', css.indexOf(':root {'));
  assert.ok(rootEnd > 0, 'app.css must open with a :root token block');
  const body = css.slice(rootEnd);
  const strays = [...body.matchAll(/#[0-9a-fA-F]{3,8}/g)]
    .filter((m) => !/[a-zA-Z]/.test(body[m.index + m[0].length] || ''))
    .map((m) => m[0]);
  assert.deepEqual(strays, [], 'colours below :root must be var(--token), not hex literals');
});

test('every colour in app.css :root is a design token', () => {
  const css = read('app.css');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  assertOnlyTokenColours(root, 'app.css :root');
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

// No tokenized-colour test for lock.js: it writes text, never style, so it
// holds no colour literal for the assertion to look at.

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

test('folders-ui.js never calls fetch() directly - it is a pure shell module', () => {
  assert.ok(!read('folders-ui.js').includes('fetch('), 'folders-ui.js must not call fetch() directly');
});

test('lock.js never calls fetch() directly - it only calls into api.js', () => {
  assert.ok(!read('lock.js').includes('fetch('), 'lock.js must not call fetch() directly');
});

// --- No egress ---

// Two exemptions, both for links the owner TAPS rather than anything the
// app LOADS: an <a href> in index.html, and app.js's one REPO_URL constant,
// which buildSettingsRow turns into rows. Each must carry rel="noreferrer" so
// the tailnet hostname never travels as a Referer - asserted below.
const NAV_LINK = /<a\b[^>]*\bhref="https?:\/\/[^"]*"[^>]*>/g;
const REPO_CONST = /^const REPO_URL = 'https:\/\/github\.com\/[^']+';\r?$/m;  // \r: app.js is CRLF

test('no shipped asset embeds an absolute http(s) URL', () => {
  for (const f of ['index.html', 'app.css', 'app.js', 'api.js', 'sw.js', 'lock.js', 'copy.js', 'push-ui.js']) {
    let source = read(f);
    if (f === 'app.js') {
      assert.match(source, REPO_CONST, 'app.js may carry the repo URL only as the REPO_URL constant');
      assert.match(source, /el\.rel = 'noopener noreferrer';/, 'buildSettingsRow must set noreferrer on href rows');
      source = source.replace(REPO_CONST, '');
    }
    if (f === 'index.html') {
      source = source.replace(NAV_LINK, (tag) => {
        assert.match(tag, /\brel="[^"]*\bnoreferrer\b[^"]*"/, `${tag} must carry rel="noreferrer" - the tailnet hostname must not travel as a Referer`);
        return '<a>';
      });
    }
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

// --- Passcode gate ---

test('PRECACHE includes /lock.js', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  const precache = new Function(`return ${match[1]};`)();
  assert.ok(precache.includes('/lock.js'));
});

test('PRECACHE includes /copy.js', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  const precache = new Function(`return ${match[1]};`)();
  assert.ok(precache.includes('/copy.js'), 'the accept screen cannot render offline without its words');
});

test('PRECACHE includes /folders-ui.js, and the file exists', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  const precache = new Function(`return ${match[1]};`)();
  assert.ok(precache.includes('/folders-ui.js'), 'the picker cannot render offline without its shell module');
  assert.ok(existsUnderPublic('/folders-ui.js'));
});

test('api.js carries the token header and never persists the token to the device', () => {
  const source = read('api.js');
  assert.ok(source.includes('X-Claude-Remote-Token'));
  assert.ok(!source.includes('localStorage'), 'api.js must never touch localStorage - the token must not survive a reload');
  assert.ok(!source.includes('sessionStorage'), 'api.js must never touch sessionStorage - the token must not survive a reload');
});

// `hidden` is only a user-agent `display: none`, so any author rule that sets
// `display` overrides it - that is how the picker once rendered BEHIND the
// lock screen while a source-string check stayed green. Assert the
// `!important` guard exists, and assert the pairing that makes it necessary,
// so deleting either side fails here.
test('app.css force-hides [hidden] - the picker must not render behind the lock screen', () => {
  const css = read('app.css');
  const html = read('index.html');

  const guard = css.match(/\[hidden\]\s*\{[^}]*\}/);
  assert.ok(guard, 'app.css must carry a [hidden] rule');
  assert.match(
    guard[0],
    /display:\s*none\s*!important/,
    '[hidden] must use !important - an id selector setting display would otherwise win',
  );

  // Every element shipping the hidden attribute that our CSS also gives a
  // display to is a candidate for this bug. Prove at least the two wrappers
  // are in that state, so the guard is not silently protecting nothing.
  const hiddenIds = [...html.matchAll(/id="([A-Za-z0-9_-]+)"[^>]*\shidden[\s>]/g)].map((m) => m[1]);
  assert.ok(
    hiddenIds.includes('picker') && hiddenIds.includes('gate') && hiddenIds.includes('accept') && hiddenIds.includes('folders'),
    'all four wrappers must ship hidden',
  );
  for (const id of ['picker', 'gate', 'accept', 'folders']) {
    const rule = css.match(new RegExp(`#${id}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `#${id} should have a rule`);
    assert.match(rule[0], /display:/, `#${id} sets display, which is what makes the guard load-bearing`);
  }
});

// The type="password" half of this is an ATTRIBUTE assertion only. It proves
// the markup asks for masking; it cannot prove the field renders as dots,
// which needs a real browser. autocomplete="off" is the load-bearing one: a
// manager that autofills on an unlocked phone hands over the passcode, which
// is the exact threat the passcode exists to stop. one-time-code is banned
// for the same reason - it summons SMS-code autofill.
test('every passcode input in index.html is masked, numeric, and opted out of autofill', () => {
  const html = read('index.html');
  const pinTags = [...html.matchAll(/<input class="pin"[^>]*>/g)].map((m) => m[0]);
  assert.ok(pinTags.length > 0, 'expected at least one class="pin" input in index.html');
  for (const tag of pinTags) {
    assert.match(tag, /autocomplete="off"/, tag);
    assert.match(tag, /inputmode="numeric"/, tag);
    assert.match(tag, /type="password"/, tag);
    assert.ok(!/one-time-code/.test(tag), `${tag} must not use one-time-code autocomplete`);
    assert.ok(!/\sname=/.test(tag), `${tag} must carry no name attribute - it is one more signal that this is a saveable credential`);
  }
});

// --- The app mark ---

function headerBlock(html) {
  const start = html.indexOf('<header');
  const end = html.indexOf('</header>');
  assert.ok(start !== -1 && end > start, 'index.html must contain a header');
  return html.slice(start, end);
}

test('the mark is declared exactly once and drawn by reference, never copied per screen', () => {
  const html = read('index.html');
  const symbols = [...html.matchAll(/<symbol id="mark"[^>]*>/g)];
  assert.equal(symbols.length, 1, 'the mark must be declared exactly once');

  // The three shapes are the mark. Each must exist once, in the one symbol -
  // a second copy means someone pasted the mark into another screen instead
  // of referencing it.
  for (const shape of [/<rect x="100" y="120"/g, /<rect x="286" y="290"/g, /<path d="M 214 226 L 298 290"/g]) {
    assert.equal([...html.matchAll(shape)].length, 1, `${shape} must appear exactly once`);
  }

  // The whole block, so a stroke set on a child shape counts too.
  const symbol = html.slice(html.indexOf('<symbol id="mark"'), html.indexOf('</symbol>'));
  assert.match(symbol, /stroke="#7ee787"/, 'the mark is always the accent, never currentColor');
});

test('the mark is decorative everywhere it is drawn - no screen reader says the app name twice', () => {
  const html = read('index.html');
  const uses = [...html.matchAll(/<svg[^>]*>\s*<use href="#mark"\/>/g)].map((m) => m[0]);
  assert.ok(uses.length >= 2, 'expected the mark in at least the header and the splash');
  for (const tag of uses) {
    assert.match(tag, /aria-hidden="true"/, tag);
    assert.ok(!/role="img"/.test(tag), `${tag} must not be exposed as an image`);
  }
  const symbol = html.slice(html.indexOf('<symbol id="mark"'), html.indexOf('</symbol>'));
  assert.ok(!symbol.includes('<title'), 'the mark must carry no <title> - the wordmark beside it already names the app');
});

test('one header is shared by every screen - it sits outside both wrappers and carries the mark', () => {
  const html = read('index.html');
  assert.equal([...html.matchAll(/<header/g)].length, 1, 'there must be exactly one header');
  assert.ok(
    html.indexOf('</header>') < html.indexOf('<main id="picker"'),
    'the header must close before the picker opens, or it is inside one screen instead of shared',
  );
  assert.ok(
    html.indexOf('</header>') < html.indexOf('<main id="gate"'),
    'the header must close before the gate opens - the lock screen is where the mark matters most',
  );
  assert.match(headerBlock(html), /<use href="#mark"\/>/, 'the shared header must draw the mark');
});

test('the mark is 22px in the header - it must cost the header no extra height', () => {
  const header = headerBlock(read('index.html'));
  const tag = header.match(/<svg class="mark"[^>]*>/);
  assert.ok(tag, 'the header mark must carry class="mark"');
  assert.match(tag[0], /width="22"/);
  assert.match(tag[0], /height="22"/);
  // The negative block margins are what make the zero-height claim true; a
  // browser is the only thing that can confirm the rendered result.
  const css = read('app.css');
  assert.match(css, /\.mark\s*\{[^}]*margin-block:\s*-11px[^}]*\}/);
});

// --- The splash ---

test('#splash ships VISIBLE - a splash that needs JavaScript cannot cover the window before JavaScript runs', () => {
  const html = read('index.html');
  const tag = html.match(/<div id="splash"[^>]*>/);
  assert.ok(tag, 'index.html must contain #splash');
  assert.ok(!/\shidden[\s>]/.test(tag[0]), '#splash must not ship hidden');
  const block = html.slice(html.indexOf('<div id="splash"'), html.indexOf('<div class="app">'));
  assert.match(block, /<use href="#mark"\/>/, 'the splash must draw the mark');
  assert.match(block, /width="72" height="72"/, 'the splash mark is 72px');
});

// SOURCE ASSERTION, stated plainly: this repo has no DOM runner, so this
// reads app.js's control flow as text rather than executing it. It fails if
// either hide is deleted, which is what it is for; it does not prove the
// splash actually disappears in a browser.
test('app.js drops the splash on both the success and the failure path', () => {
  const js = read('app.js');
  const boot = js.slice(js.indexOf('async function boot()'));
  assert.match(boot, /hideSplash\(\);/, 'boot() must drop the splash on the normal path');
  assert.ok(
    boot.indexOf('hideSplash();') < boot.indexOf('await unlocked'),
    'the splash must be dropped BEFORE awaiting the unlock, or it covers the passcode screen while the owner types',
  );
  assert.match(js, /boot\(\)\.finally\(hideSplash\)/, 'a boot that throws must not strand the owner on a logo');
});

// --- Status line belongs to the picker only ---

test('the status line ships hidden and app.css gives .conn a display, so the force-hide rule is what holds it', () => {
  const html = read('index.html');
  const css = read('app.css');
  const tag = html.match(/<div class="conn" id="conn"[^>]*>/);
  assert.ok(tag, 'index.html must contain the status line');
  assert.match(tag[0], /\shidden[\s>]/, 'the status line must ship hidden - it says nothing true on a passcode screen');
  const rule = css.match(/\.conn\s*\{[^}]*\}/);
  assert.ok(rule, '.conn should have a rule');
  assert.match(rule[0], /display:/, '.conn sets display, which is what makes the force-hide rule load-bearing here');
});

test('app.js ties the status line to the project list, so a late render cannot light it on a passcode screen', () => {
  const js = read('app.js');

  // Nothing may reveal the line unconditionally: a render that resolves after
  // the passcode screen is back would put it on that screen. The second check
  // closes the form no `= false` pattern can see - dropping the attribute
  // outright reveals the line just as effectively.
  const reveals = [...js.matchAll(/conn(?:'\))?\.hidden\s*=\s*false/g)];
  assert.equal(reveals.length, 0, 'nothing may reveal the status line unconditionally');
  assert.ok(
    !/removeAttribute\(['"]hidden['"]\)/.test(js),
    'the hidden attribute is the mechanism that holds the line down - no reveal may go around it',
  );

  const renderConn = js.slice(js.indexOf('function renderConn()'), js.indexOf('function renderProjects()'));

  // Lift the real decision out of the source and RUN it, rather than pinning
  // its spelling: what has to hold is the mapping in both directions, and an
  // inverted or mis-targeted condition must fail here. The stub answers for
  // #picker only, so keying off any other element throws.
  const decision = renderConn.match(/conn\.hidden\s*=\s*([^;]+);/);
  assert.ok(decision, 'renderConn must decide whether the status line is on screen');
  const decide = new Function('document', 'conn', `conn.hidden = ${decision[1]}; return conn.hidden;`);
  const doc = (pickerHidden) => ({
    getElementById(id) {
      assert.equal(id, 'picker', 'the status line follows the project list, not any other screen');
      return { hidden: pickerHidden };
    },
  });
  assert.equal(decide(doc(true), {}), true, 'the picker is away, so the line must be too');
  assert.equal(decide(doc(false), {}), false, 'the line comes back with the project list');

  const hideConn = js.slice(js.indexOf('function hideConn()'), js.indexOf('function renderConn()'));
  assert.match(hideConn, /conn'\)\.hidden\s*=\s*true/, 'hideConn must actually hide it');

  assert.match(js, /onAuthLost\(async \(\) => \{ hideConn\(\);/, 'losing auth must put the status line away before the gate returns');
});

// --- Copy ---

// Executes the message function lifted out of lock.js rather than grepping
// for the string, so a broken plural fails here.
test('the wrong-passcode count reads "1 try" and "2 tries"', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'lock.js'), 'utf8');
  const match = src.match(/passcode_incorrect:\s*(\(data\) => `[^`]*`)/);
  assert.ok(match, 'lock.js must carry a passcode_incorrect message');
  const message = new Function(`return ${match[1]};`)();
  assert.equal(message({ failures: 1 }), '! Wrong passcode. 1 try so far.');
  assert.equal(message({ failures: 2 }), '! Wrong passcode. 2 tries so far.');
  assert.equal(message({ failures: 5 }), '! Wrong passcode. 5 tries so far.');
});

test('app.css keeps #picker as a flex column with flex-grow, or .spacer stops pushing the footer down', () => {
  const css = read('app.css');
  assert.match(css, /#picker\s*\{[^}]*flex-grow:\s*1[^}]*\}/);
});

// --- Picker layout on a phone ---

// The mechanism, not the pixel count. This app bundles no font file, so every
// device resolves the monospace stack to its own face at its own advance
// width - a status line that measures one row in a desktop browser really did
// render as two on the phone, above two more rows of wrapped hostname. nowrap
// is what makes the height independent of that; a measurement in one browser
// is not.
test('the connection line is one line on any device, and names no host', () => {
  const css = read('app.css');
  const rule = css.match(/\.conn\s*\{[^}]*\}/);
  assert.ok(rule, 'app.css must carry a .conn rule');
  assert.match(
    rule[0],
    /white-space:\s*nowrap/,
    'the status line must not be allowed to wrap - a wider fallback font is what put it on four rows',
  );

  // One agent, one machine, and the app can only have been installed from
  // that machine's origin: the hostname is a constant, not state, and it is
  // what wrapped.
  assert.ok(!read('index.html').includes('conn-host'), 'the header must not carry a hostname element');
  assert.ok(!read('app.js').includes('location.host'), 'app.js must not put the hostname in the header');
});

// The standing decision this replaces: while the + floated 100px up, .list
// reserved 46px so the button could not cover the last project row. The
// button now sits in the bottom corner, so the reserve has to be below the
// footer instead. Both halves are one decision - this checks the arithmetic
// that ties them, so moving either alone fails here.
test('the + button is anchored to the bottom corner and the page reserves the band it occupies', () => {
  const css = read('app.css');
  const btn = css.match(/\.newproj\s*\{[^}]*\}/);
  assert.ok(btn, 'app.css must carry a .newproj rule');

  const inset = Number(btn[0].match(/bottom:\s*calc\((\d+)px/)[1]);
  const height = Number(btn[0].match(/height:\s*(\d+)px/)[1]);
  assert.ok(
    inset <= 24,
    `the + must sit in the corner, not over the list: bottom inset is ${inset}px`,
  );

  const footer = css.match(/\.footer\s*\{[^}]*\}/);
  assert.ok(footer, 'app.css must carry a .footer rule');
  const calc = footer[0].match(/padding:\s*[^;]*calc\(([^)]*)\)/);
  assert.ok(calc, '.footer must reserve its bottom band in a calc()');
  const reserve = [...calc[1].matchAll(/(\d+)px/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.ok(
    reserve >= inset + height,
    `scrolled to the end the + occupies the bottom ${inset + height}px, so .footer must reserve at least that; it reserves ${reserve}px`,
  );
});

// The + menu, the parts a static read can prove: the label, the two
// choices in their drawn order with the Artifact's icons, same width, 44px.
test('the + is "Add" with aria-expanded, and its menu is Share folder over New project, equal width, 44px', () => {
  const html = read('index.html');
  const btn = html.match(/<button class="newproj"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /aria-label="Add"/);
  assert.match(btn[0], /aria-expanded="false"/);
  assert.match(html, /<span class="newproj-g"[^>]*>\+<\/span>/, 'the GLYPH rotates, so it needs its own element');
  const menu = html.slice(html.indexOf('id="plusmenu"'), html.indexOf('</div>', html.indexOf('id="plusmenu"')));
  const share = menu.indexOf('Share folder');
  const neu = menu.indexOf('New project');
  assert.ok(share !== -1 && neu > share, 'top Share folder, bottom (nearest the thumb) New project');
  assert.match(menu.slice(0, share), /#i-folder/);
  assert.match(menu.slice(share, neu), /#i-plus/);
  assert.match(html, /<symbol id="i-plus"/);

  const css = read('app.css');
  const rule = css.match(/\n\.plusmenu \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /align-items: stretch;/, 'both choices take the width of the longer one');
  const item = css.match(/\n\.plusmenu-item \{([^}]*)\}/);
  assert.match(item[1], /height: 44px;/);
  assert.match(css, /\.newproj\[aria-expanded="true"\] \.newproj-g \{ transform: rotate\(45deg\); \}/);
  assert.match(css, /filter: blur\(4px\);/);
});

// The account menu's buttons are built on every open. Built inside a
// visibility: hidden menu, iPhone Safari never painted their text once it was
// shown (owner's iPhone, 2026-10-01), so the menu hides by opacity and is kept
// out of reach by inert - from the markup until setAcctMenu opens it.
test('the account menu hides by opacity and inert, never by visibility', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');   // its comment names visibility
  const rule = css.match(/\n\.acctmenu \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /opacity: 0;/);
  assert.doesNotMatch(css, /\.acctmenu \{[^}]*visibility/, 'visibility: hidden leaves its new buttons blank on iPhone');
  assert.match(rule[1], /pointer-events: none;/, 'untappable even where inert is missing');
  assert.match(css, /#picker\.acct-open \.acctmenu \{ opacity: 1; pointer-events: auto;/);
  assert.match(read('index.html'), /<div class="acctmenu" id="acctmenu"[^>]* inert>/, 'unreachable before the first open');
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function setAcctMenu('), js.indexOf('function lastAccountFor('));
  assert.match(fn, /getElementById\('acctmenu'\)\.inert = !open;/, 'reachable only while open');
});

// Executed, not grepped: the literal is lifted out of rowState and evaluated,
// so a status quietly put back fails here rather than passing on a string
// match. It cannot prove what a browser paints - it proves the two halves
// that decide it.
test('a project with no session renders as its name alone - the hollow dot is the state', () => {
  const js = read('app.js');
  const rowState = js.slice(js.indexOf('function rowState('), js.indexOf('function setDot('));
  const returns = [...rowState.matchAll(/return (\{[^}]*\});/g)];
  assert.ok(returns.length > 0, 'rowState must return row descriptors');
  const fallback = new Function(`return ${returns[returns.length - 1][1]};`)();
  assert.equal(fallback.zone, 'list');
  assert.equal(fallback.implicit, true, 'the default idle state must be marked as the one not drawn');

  const buildRow = js.slice(js.indexOf('function buildRow('), js.indexOf('function setBanner('));
  assert.match(buildRow, /if \(!rs\.implicit\)/, 'buildRow must skip the status line for that state');

  // Dropping the visible line must not drop the state for a screen reader:
  // the dot is aria-hidden, so without this a row would announce a bare name.
  // Scoped to what the label SAYS, not merely that the attribute is set - a
  // bare /aria-label/ stays green when the value is narrowed to the name
  // alone, which is exactly the regression this guards.
  assert.match(
    buildRow,
    /aria-label',\s*`\$\{p\.name\},\s*\$\{statusLine\(rs\)\}`/,
    'the row must announce its state, not just carry an aria-label',
  );
  assert.equal(fallback.status, 'no session', 'and the words it announces live in one place');
});

// The right-hand column is gone, so this is now the ONLY thing carrying a
// row's elapsed time. A launch that was never confirmed is the one list state
// that has a real one, and losing it silently is the risk of removing the
// column at all.
test('a list row folds its elapsed time into the status line, so the removed idle column costs nothing', () => {
  const js = read('app.js');
  const body = js.match(/function statusLine\(rs\) \{\s*return ([^;]+);/);
  assert.ok(body, 'app.js must carry statusLine');
  const statusLine = new Function('rs', `return ${body[1]};`);
  assert.equal(statusLine({ status: 'launch unconfirmed', idle: '3m' }), 'launch unconfirmed - 3m');
  assert.equal(statusLine({ status: 'could not start', idle: '—' }), 'could not start');

  // The VISIBLE line specifically. Asserting on a bare statusLine(rs) passed
  // while the drawn text had been swapped back to rs.status, because the
  // aria-label a few lines up calls it too - the row still announced the time
  // and no longer showed it.
  const buildRow = js.slice(js.indexOf('function buildRow('), js.indexOf('function setBanner('));
  assert.match(
    buildRow,
    /statusEl\.textContent = statusLine\(rs\)/,
    'the line the owner reads must use it, not just the aria-label',
  );

  // A project in this list is by definition not running, so an idle column
  // could only ever draw an em-dash and a chevron distinguishes nothing on a
  // list where every row is tappable. Both spent the right third of a 390px
  // row on decoration.
  const css = read('app.css');
  for (const cls of ['row-idle', 'row-chev']) {
    assert.ok(!buildRow.includes(cls), `list rows must not rebuild .${cls}`);
    assert.ok(!new RegExp(`\\.${cls}\\s*\\{`).test(css), `app.css must not restyle .${cls}`);
  }
});

// --- STOP / confirm / watch loop ---

// The rule is "var(--danger) means THIS ENDS SOMETHING", not "danger belongs
// to the session tiles". The approved design puts red on the
// shared-folder remove and its confirmation in exactly those words -
// "destructive, so it asks; red is this palette's one danger colour and
// appears nowhere else" - so those selectors are on the list below. It stays
// an ALLOWLIST: a new red thing must be added here on purpose, and the two
// base banner rules must stay neutral whatever else does.
// Input errors joined it on 2026-09-27 (owner, "Make errors red"):
// the New project error line and its panel edge, and a
// message line whose tone lock.js setMsg marked 'error'. Nothing else.
const DANGER_SELECTORS = /tile-stop|tile-confirm|shared-remove|set-danger|set-gone|set-btn-danger|newproj-error|gate-msg\[data-tone="error"\]/;

test('the danger tokens appear only on controls that end something, never on a plain banner', () => {
  const css = read('app.css');
  const blocks = css.split('}').filter((chunk) => chunk.includes('{'));
  for (const chunk of blocks) {
    const selector = chunk.slice(0, chunk.indexOf('{'));
    const body = chunk.slice(chunk.indexOf('{') + 1);
    if (/var\(--danger(?:-2)?\)/.test(body)) {
      assert.match(
        selector,
        DANGER_SELECTORS,
        `selector "${selector.trim()}" carries a danger colour but is not a destructive control`,
      );
    }
  }

  const bannerRule = css.match(/\.banner\s*\{[^}]*\}/);
  const bannerErrorRule = css.match(/\.banner\.error\s*\{[^}]*\}/);
  assert.ok(bannerRule, 'app.css must carry a .banner rule');
  assert.ok(bannerErrorRule, 'app.css must carry a .banner.error rule');
  assert.ok(!/var\(--danger(?:-2)?\)/.test(bannerRule[0]), '.banner must not use a danger colour');
  assert.ok(!/var\(--danger(?:-2)?\)/.test(bannerErrorRule[0]), '.banner.error must not use a danger colour');
});

test('anyWatchable is true for running/handoff/starting, and the watch loop is a bounded 5s poll gated on visibility', () => {
  const js = read('app.js');
  const body = js.match(/function anyWatchable\(\) \{\s*return ([^;]+);/);
  assert.ok(body, 'app.js must carry anyWatchable');
  const anyWatchable = new Function('state', `return ${body[1]};`);
  assert.equal(anyWatchable({ sessions: [{ status: 'running' }] }), true);
  assert.equal(anyWatchable({ sessions: [{ status: 'ending' }] }), true);
  assert.equal(anyWatchable({ sessions: [{ status: 'starting' }] }), true, 'a cancelled launch must be polled away, not left stale');
  assert.equal(anyWatchable({ sessions: [{ status: 'failed' }] }), false);
  assert.equal(anyWatchable({ sessions: [{ status: 'ended' }] }), false);
  assert.equal(anyWatchable({ sessions: [] }), false);
  assert.equal(anyWatchable({ sessions: null }), false);

  assert.match(js, /const WATCH_GAP_MS = 5000;/);

  const watchSessions = js.slice(js.indexOf('async function watchSessions()'), js.indexOf('function hideSplash()'));
  assert.match(
    watchSessions,
    /document\.visibilityState !== 'visible'/,
    'watchSessions must guard on document.visibilityState',
  );
});

test('app.css keeps an unqualified >=16px input floor, for the inputs that do not exist yet', () => {
  // NOT a type-scale rule - a functional one. Mobile Safari zooms the whole
  // page in when a focused text input is smaller than 16px, and does not zoom
  // back out when it loses focus. The owner hit this naming a project on
  // 2026-09-05: the panel zoomed, the header was cut off both sides, and it
  // stayed that way afterwards.
  //
  // THIS TEST DELIBERATELY NO LONGER SWEEPS THE STYLESHEET. It used to try to
  // answer "what size will every input render at" by parsing selectors, and
  // that question is cascade + specificity + inheritance + media queries +
  // `font:` shorthand - four things a regex cannot do. Three review rounds
  // found six holes in it and two of those holes were introduced by hardening
  // it. `scripts/check-input-font-sizes.mjs` asks the browser for the computed
  // font-size of every input instead, which is ground truth and immune to all
  // six. Owner's call, 2026-09-05.
  //
  // What is left here is the half the browser CANNOT see, and it is not a
  // consolation prize - it is a real gap in the other check. Every input that
  // exists today carries its own explicit size, so DELETING THE FLOOR CHANGES
  // NOTHING THE BROWSER CAN OBSERVE (measured: dropping it to 12px leaves all
  // seven inputs at their own 16/19px and the browser check correctly passes).
  // The floor exists for the input nobody has added yet - one with no rule of
  // its own, which would otherwise take the UA ~13.33px and reproduce the bug
  // silently. That input has no computed style to read, so only a static check
  // can defend it. The two checks are complementary, not redundant.
  //
  // Comments are stripped first: the rules below carry long comments that name
  // other sizes in prose, and a declaration parser must not read those.
  const css = read('app.css')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // STATEMENT at-rules (`@import url("x.css");`, `@charset "utf-8";`) carry
    // no block, so the depth scan below never sees them as a rule and they leak
    // into the NEXT rule's selector - which then fails the bare-element test and
    // reports a perfectly good floor as qualified. This is review's hole 1 in a
    // new place, and it is why the strip is terminated on `;` as well as `{`:
    // requiring a `;` before any `{` is what stops it eating a `@media (...) {`
    // opener, which is the mistake the previous version of this test made.
    .replace(/@[a-zA-Z-]+[^{};]*;/g, '');

  // TOP-LEVEL rules only, collected by brace DEPTH rather than by stripping
  // at-rule openers with a regex. The old strip is what produced two of the six
  // holes: it had no `;` terminator, so `@import url("x.css");` swallowed the
  // next rule's selector, and because it deleted the `@media` opener a floor
  // written INSIDE a breakpoint counted as unqualified - a false PASS, and
  // strictly worse than the code it replaced. A depth counter cannot make
  // either mistake: an `@media` block is one depth-0 entry whose "selector" is
  // the @media line, so the conditional rules inside it are simply not
  // top-level, which is exactly what "unqualified floor" means.
  const topLevel = [];
  let depth = 0;
  let selStart = 0;
  let selEnd = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) { selEnd = i; bodyStart = i + 1; }
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        topLevel.push({
          selector: css.slice(selStart, selEnd).trim().replace(/\s+/g, ' '),
          body: css.slice(bodyStart, i),
        });
        selStart = i + 1;
      }
    }
  }

  // Declarations split on `;` with the property matched as the WHOLE left-hand
  // side. `font(?:-size)?:` used to be matched with no left boundary, so a
  // custom property - `--card-font-size: 12px` - was read as the element's own
  // size and beat the real declaration after it. Exact equality on the property
  // name ends that: `--card-font-size` is not `font-size`.
  const sizeOf = (body) => {
    let found = null;
    for (const decl of body.split(';')) {
      const m = decl.match(/^\s*([a-zA-Z-]+)\s*:\s*([^]*)$/);
      if (!m) continue;
      const [, prop, value] = m;
      if (prop !== 'font-size' && prop !== 'font') continue;
      // `font: 12px/1.4 monospace` sizes an input just as well as `font-size`.
      const hit = value.match(/(\d+(?:\.\d+)?)(px|rem|em|%|pt)/);
      // Last one wins, as in the cascade - INCLUDING a declaration that carries
      // no number at all. `font: inherit`, `font-size: inherit|initial|unset`
      // and `font: menu` RESET the size, so a later one must CLEAR an earlier
      // px value rather than leave it standing. Without this,
      // `{ font-size: 16px; font: inherit }` read as a valid 16px floor while
      // the browser inherited ~14px - and the browser check cannot see it
      // either, because every input that exists carries its own >=16px rule.
      // Both rules in this stylesheet already put `font: inherit` next to their
      // size, so the order that triggers it is one line-swap away.
      found = hit ? { px: hit[2] === 'px' ? Number(hit[1]) : null, unit: hit[2] } : null;
    }
    return found;
  };

  // The floor must be UNQUALIFIED - three bare element names, no prefix. A
  // qualified one (`.app input, .app textarea, .app select`) leaves every input
  // outside `.app` on the UA default, which a previous pass shipped.
  // A SUPERSET is fine and must not be rejected: adding `button` to the list
  // sizes strictly more elements, so requiring exactly three selectors failed a
  // legitimate floor with a message claiming it was "qualified" - false, and it
  // sent the reader hunting for a prefix that was not there.
  const REQUIRED = ['input', 'select', 'textarea'];
  // LAST match, not the first. Two floors can coexist, and at equal specificity
  // the later one wins - so reading the first would let someone append
  // `input, textarea, select { font-size: 12px }` below the good one and pass.
  // That case is invisible to the browser check too (every input that exists
  // carries its own >=16px rule), so taking the first here would have left BOTH
  // guards green on exactly the regression this floor exists to prevent.
  // A rule counts as a floor if its selector list contains all three BARE
  // element names, whatever ELSE is in the list. The old version also demanded
  // that every part be a bare element, which let
  // `input, textarea, select, .filter { font-size: 12px }` slip past: it sizes
  // all three elements exactly like a floor, but was not collected as one, so
  // `.at(-1)` still returned the good 16px rule and the test passed. The
  // browser check misses it too - every input that exists carries its own
  // >=16px rule - so it was one more both-guards-green hole.
  // The qualified case this test was built to reject is still rejected, and by
  // this same line rather than by the extra one: the parts of
  // `.app input, .app textarea, .app select` are `.app input` and friends, none
  // of which equals `input`, so `includes` is false.
  const floors = topLevel.filter((rule) => {
    const parts = rule.selector.split(',').map((p) => p.trim());
    return REQUIRED.every((el) => parts.includes(el));
  });
  const floor = floors.at(-1);
  assert.ok(
    floor,
    'app.css must set a font-size floor on an UNQUALIFIED `input, textarea, select` at the top level - a qualified one (.app input) or one inside a media query leaves inputs on the UA default',
  );
  const floorSize = sizeOf(floor.body);
  assert.ok(floorSize, `the floor rule \`${floor.selector}\` must declare a font-size`);
  assert.equal(
    floorSize.unit, 'px',
    `the floor must be in px so it can be compared to the 16px threshold, got ${floorSize.unit}`,
  );
  assert.ok(
    floorSize.px >= 16,
    `the floor is ${floorSize.px}px - under 16px iOS zooms the page on focus and leaves it zoomed`,
  );

  // The two rules that exist today must ALSO declare their own size: both carry
  // `font: inherit`, which resets font-size and would otherwise drop them back
  // to the inherited value even with the floor present.
  for (const name of ['.newproj-panel input', '.pin']) {
    const rule = topLevel.find((r) => r.selector === name);
    assert.ok(rule, `expected a top-level \`${name}\` rule in app.css`);
    const size = sizeOf(rule.body);
    assert.ok(
      size,
      `${name} must set an explicit font-size - its own \`font: inherit\` resets what the floor gave it`,
    );
    assert.equal(size.unit, 'px', `${name} must size in px, got ${size.unit}`);
    assert.ok(
      size.px >= 16,
      `${name} is ${size.px}px, under the 16px iOS zoom threshold`,
    );
  }
});

test('the stop control has a 48px tap band on every layout, and the single-tile name/status pad clear of it', () => {
  const css = read('app.css');

  const baseRule = css.match(/^\.tile-stop\s*\{[^}]*\}/m);
  assert.ok(baseRule, 'app.css must carry a base .tile-stop rule');
  assert.match(baseRule[0], /min-height:\s*48px/);

  const singleRule = css.match(/\.tiles\.single \.tile-stop\s*\{[^}]*\}/);
  assert.ok(singleRule, 'app.css must carry .tiles.single .tile-stop');
  assert.match(singleRule[0], /width:\s*48px/);
  assert.match(singleRule[0], /height:\s*48px/);

  const nameRule = css.match(/\.tiles\.single \.tile\.has-stop \.tile-name[\s\S]*?\{([^}]*)\}/);
  assert.ok(nameRule, 'app.css must pad .tiles.single .tile.has-stop .tile-name clear of the corner chip');
  assert.match(nameRule[0], /padding-right:\s*48px/);
});

test('the confirm carries CANCEL, the warning, the route out, and END ANYWAY - and no other kill-button wording', () => {
  const js = read('app.js');
  const buildTile = js.slice(js.indexOf('function buildTile('), js.indexOf('function buildRow('));
  assert.match(buildTile, /'CANCEL'/);
  assert.match(buildTile, /'END ANYWAY'/);
  // As approved: the confirm warns that nothing
  // writes a handoff and points at the only thing that can, then still lets
  // the owner through. A warning, not a gate.
  assert.match(buildTile, /'OPEN CLAUDE FIRST'/);
  assert.match(buildTile, /Nothing writes a handoff for you/);
  for (const forbidden of ['END IT', 'KILL', 'FORCE', 'input type="checkbox"', 'END & WRITE HANDOFF']) {
    assert.ok(!js.includes(forbidden), `app.js must not contain "${forbidden}"`);
  }
});

test('the stop banner strings appear verbatim in app.js, and no handoff verdict is announced', () => {
  const js = read('app.js');
  assert.ok(js.includes("' had already ended.'"), 'already-ended banner text');
  assert.ok(js.includes("'! Could not end '") && js.includes("'. It is still running - close it at the desk.'"), 'kill-failed banner text');
  assert.ok(js.includes("{ text: ' ended.' }"), 'the one ended banner');
  // The app writes no handoff, so it may not report on one. The 'was not
  // written' line in particular was a lie often enough that the owner caught
  // it with the file on disk (2026-08-27).
  for (const gone of ["'Handoff written for '", 'was not written.']) {
    assert.ok(!js.includes(gone), `app.js must no longer contain ${gone}`);
  }
});

test('the end-session request is issued only from api.js, never from app.js', () => {
  assert.ok(read('api.js').includes('/api/sessions/end'), 'api.js must carry the end-session endpoint');
  assert.ok(!read('app.js').includes('/api/sessions/end'), 'app.js must go through api.js, never the path literal itself');
});

// --- fix round 1: review findings 1, 2, 4, 5 -------------------------------

test('confirmStarting always calls watchSessions() in its finally, unconditionally after the rearm branch', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('async function confirmStarting('), js.indexOf('function anyWatchable('));
  assert.ok(fn.includes('} finally {'), 'confirmStarting must still have a finally block');
  const finallyBody = fn.slice(fn.indexOf('} finally {'));
  const rearmMatch = finallyBody.match(/if \(rearm\) \{[\s\S]*?\n    \}/);
  assert.ok(rearmMatch, 'confirmStarting must still carry the rearm branch');
  const afterRearm = finallyBody.slice(finallyBody.indexOf(rearmMatch[0]) + rearmMatch[0].length);
  assert.ok(
    afterRearm.includes('watchSessions();'),
    'confirmStarting\'s finally must call watchSessions() after the rearm branch, or a launch landing never starts the watch loop',
  );
  assert.ok(
    !afterRearm.slice(0, afterRearm.indexOf('watchSessions();')).includes('if ('),
    'the watchSessions() call must be unconditional, not gated behind another branch',
  );
});

test('runStop clears state.results before the end request goes out', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('async function runStop('), js.indexOf('function newProjectNameEl('));
  assert.ok(fn.includes('state.results.delete(name);'), 'runStop must clear state.results, or an ended session\'s tile can resurrect via the results branch');
  assert.ok(
    fn.indexOf('state.results.delete(name);') < fn.indexOf('await endSession(endTargetFor(name))'),
    'state.results must be cleared before the end request is issued, mirroring onProjectTap',
  );
});

test('the CANCEL branch renders synchronously before a guarded history.back(), so a double tap cannot pop the app', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function onTileTap('), js.indexOf('function openConfirm('));
  const cancelBlock = fn.slice(fn.indexOf('if (cancel) {'), fn.indexOf('const go ='));
  assert.match(
    cancelBlock,
    /state\.confirmName = null;\s*render\(\);\s*if \(confirmPushed\) \{ confirmPushed = false; history\.back\(\); \}/,
    'CANCEL must clear confirmName and render() BEFORE any history.back(), and history.back() must be guarded by confirmPushed',
  );
});

test('renderProjects reconciles a stale confirmName before tiles are built', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  const reconcile = /if \(state\.confirmName && !rows\.some\(\(r\) => r\.p\.name === state\.confirmName && r\.rs\.stop\)\) \{\s*state\.confirmName = null;\s*if \(confirmPushed\) \{ confirmPushed = false; history\.back\(\); \}\s*\}/;
  assert.match(fn, reconcile, 'renderProjects must drop a confirmName whose project no longer has a stoppable session');
  const match = fn.match(reconcile);
  assert.ok(
    fn.indexOf(match[0]) < fn.indexOf('const tiles = rows.filter'),
    'the reconciliation must run before tiles are built, so the same render never draws the stale confirm',
  );
});

// --- desk-started sessions in the PWA --------------------------------------

// --- the cache key is derived, never hand-bumped ----------------------------
// These replace a test that pinned a literal `-v27` and asserted the same
// number in its own name. That test could only ever fail when someone had
// ALREADY remembered to bump the constant - which is precisely the moment it
// was not needed. It never once caught the failure it existed for: a shell
// change shipped with the key untouched, which is what put a stale app on the
// owner's phone twice.

test('sw.js carries the hash PLACEHOLDER, never a literal version', () => {
  // RED WHEN: someone reintroduces a hand-maintained version. That is the
  // whole regression - the mechanism below only works on a placeholder.
  const source = read('sw.js');
  const match = source.match(/const CACHE = '([^']+)'/);
  assert.ok(match, 'sw.js must declare CACHE');
  assert.equal(match[1], 'claude-remote-shell-__SHELL_HASH__');
});

test('the agent stamps a real hash into sw.js on the way out', () => {
  const stamped = readServiceWorker().toString('utf8');
  const key = stamped.match(/const CACHE = '([^']+)'/)[1];
  assert.match(key, /^claude-remote-shell-[0-9a-f]{16}$/,
    'the placeholder must be replaced by a 16-hex digest before it is served');
  assert.ok(!stamped.includes('__SHELL_HASH__'), 'no placeholder may survive to a client');
});

test('the stamped hash CHANGES when a shell file changes, and is stable otherwise', () => {
  // RED WHEN: the hash is memoised, or stops covering a file people actually
  // edit. This is the one assertion that proves the phone gets new code.
  const key = () => readServiceWorker().toString('utf8').match(/const CACHE = '([^']+)'/)[1];
  const target = path.join(PUBLIC_DIR, 'app.css');
  const original = fs.readFileSync(target);
  const before = key();
  try {
    fs.appendFileSync(target, '/* cache-key probe */');
    assert.notEqual(key(), before, 'editing app.css must change the cache key');
  } finally {
    fs.writeFileSync(target, original);
  }
  assert.equal(key(), before, 'restoring the file must restore the key - the hash is content, not a clock');
});

test("static.js's SHELL_FILES and sw.js's PRECACHE name the same files", () => {
  // RED WHEN: a file is added to one list and not the other, which would let
  // a precached file change without moving the key - a stale asset that
  // nothing would ever evict.
  const src = fs.readFileSync(path.join(AGENT_DIR, 'static.js'), 'utf8');
  const shell = [...src.match(/const SHELL_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const precache = [...read('sw.js').match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((f) => f !== '/')        // the navigation alias for /index.html
    .map((f) => f.replace(/^\//, ''));
  assert.deepEqual(shell.slice().sort(), precache.slice().sort());
});

// The shell must be answered from the cache without waiting on the network.
// Network-first is what made the app take tens of seconds to open while the
// PC was still booting: each shell file waited out its own connection
// timeout before falling back to the cache it already had.
test('sw.js answers the shell from cache without awaiting the network', () => {
  const source = read('sw.js');
  assert.ok(
    !source.includes('networkFirst'),
    'the shell handler must not be network-first - that is the slow-open bug',
  );
  const fn = source.slice(
    source.indexOf('async function staleWhileRevalidate('),
    source.indexOf('self.addEventListener(\'fetch\''),
  );
  assert.ok(fn, 'sw.js must carry staleWhileRevalidate');
  assert.ok(
    fn.indexOf('const cached = await caches.match(req)') < fn.indexOf('await fromNetwork'),
    'the cache lookup must be awaited BEFORE the network response, or the wait is back',
  );
  assert.match(fn, /\.catch\(\(\) => null\)/, 'the background revalidate must not reject unhandled');
});

// The behaviour, not the shape: a PC that is still booting does not refuse a
// connection, it says nothing at all, so the network promise simply never
// settles. Under network-first the app sat on exactly this until the socket
// timed out - once per shell file, before anything could paint.
test('sw.js serves the cached shell while the network never answers at all', async () => {
  const cachedBody = { body: 'cached app.js' };
  const listeners = loadServiceWorker({
    fetch: () => new Promise(() => {}), // never settles, never rejects
    cacheMatch: async () => cachedBody,
  });

  let responded;
  listeners.fetch({
    request: { url: 'http://127.0.0.1:8790/app.js', method: 'GET', mode: 'same-origin' },
    respondWith(p) { responded = p; },
  });

  assert.ok(responded, 'the shell request must be answered by the service worker');
  const winner = await Promise.race([
    responded,
    new Promise((r) => setTimeout(() => r('TIMED OUT'), 500)),
  ]);
  assert.equal(winner, cachedBody, 'the cached copy must win without waiting on the network');
});

// --- a desk session in a subfolder gets its own tile -----------------

test('renderProjects builds a synthetic project-shaped row for a desk session whose path matches no project', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  assert.doesNotMatch(fn, /s\.source !== 'desk'/, 'no source filter: a subfolder session mid-handoff is reported launched-shaped and must keep its tile');
  assert.match(fn, /state\.projects\.some\(\(p\) => p\.path === s\.path\)/, 'must skip a desk session already matched by an existing project row');
  assert.match(fn, /const synthetic = \{ name: s\.project, path: s\.path \};/);
  assert.match(fn, /rows\.push\(\{ p: synthetic, rs: rowState\(synthetic\) \}\);/, 'the synthetic row must flow through the same rowState/buildTile path as a real project');
  assert.ok(
    fn.indexOf('const rows = state.projects.map') < fn.indexOf('const synthetic = { name: s.project, path: s.path };'),
    'synthetic rows must be added after the real project rows',
  );
});

test('endTargetFor sends session_name for a synthetic (non-project) tile name, project for everything else', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function endTargetFor('), js.indexOf('// Reconciled by renderProjects() too'));
  const endTargetFor = new Function(
    'state',
    `${fn}\nreturn endTargetFor;`,
  )({ projects: [{ name: 'Pull Requests' }], sessions: [{ source: 'desk', project: 'Whatsapp Plugin', session_name: 'whatsapp-plugin' }] });
  assert.deepEqual(endTargetFor('Pull Requests'), { project: 'Pull Requests' });
  assert.deepEqual(endTargetFor('Whatsapp Plugin'), { session_name: 'whatsapp-plugin' });
});

test('buildTile carries the desktop confirm label and still carries the plain one', () => {
  const js = read('app.js');
  const buildTile = js.slice(js.indexOf('function buildTile('), js.indexOf('function buildRow('));
  assert.match(buildTile, /'END ANYWAY \(DESKTOP\)'/);
  assert.match(buildTile, /'END ANYWAY'/);
});

test("rowState's running branch carries source === 'desk' and the 'desktop' suffix literal", () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function rowState('), js.indexOf('function setDot('));
  assert.match(fn, /session\.source === 'desk'/);
  assert.match(fn, /'desktop'/);
});

test('statusLine appends an optional suffix on top of its existing behaviour', () => {
  const js = read('app.js');
  const body = js.match(/function statusLine\(rs\) \{\s*return ([^;]+);/);
  assert.ok(body, 'app.js must carry statusLine');
  const statusLine = new Function('rs', `return ${body[1]};`);
  assert.equal(statusLine({ status: 'launch unconfirmed', idle: '3m' }), 'launch unconfirmed - 3m');
  assert.equal(statusLine({ status: 'could not start', idle: '—' }), 'could not start');
  assert.equal(
    statusLine({ status: 'active session', idle: '36m', suffix: 'desktop' }),
    'active session - 36m - desktop',
  );
});

test("app.js never asks the owner to go and VERIFY a launch in the Claude app", () => {
  // The original invariant, and it still holds: the owner's words were "it should
  // just know". The agent proves the pid, so the app must never send someone
  // to another app to check whether a launch worked.
  const js = read('app.js');
  assert.doesNotMatch(js, /not confirmed/);

  // NARROWED by the hand-off banner, 2026-09-04. This used to assert that only
  // maybeFailedBanner could mention the Claude app at all. That is no longer
  // right, and the two decisions do not actually conflict:
  //   It first cut "open the Code tab to CHECK IT APPEARED" - verification the app
  //        can do itself, which is what "just knows" killed.
  //   The hand-off adds "Ready in the Claude app... to START TYPING" - fired only once
  //        handoffReady() confirms the session is running, i.e. exactly after
  //        the app has done the knowing. It names a destination, not a check.
  // What survives is the real rule: no verification prompts. The hand-off copy
  // lives in handoff-ui.js, so app.js itself still carries exactly one mention.
  assert.equal((codeOnly(js).match(/Claude app/g) || []).length, 1,
    'in app.js code, only maybeFailedBanner may name the Claude app');
});

test('the hand-off copy names a destination, never a check', () => {
  // The distinction above, enforced on the copy itself rather than on a count.
  const src = read('handoff-ui.js');
  for (const verify of [/check it appeared/i, /to check/i, /confirm it/i, /make sure/i]) {
    assert.doesNotMatch(src, verify, "the hand-off must not reintroduce the old verification prompt");
  }
});

test("rowState's running branch shows the session's busy/idle activity", () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function rowState('), js.indexOf('function setDot('));
  assert.match(fn, /session\.activity \|\| 'active session'/);
});

// --- the launch banner clears itself once the session settles --------------

function makeClearSettled(hideBannerSpy, state, launchBannerFor, showHandoffSpy = () => {}, tileAccount = () => null) {
  const js = read('app.js');
  const src = js.slice(
    js.indexOf('function clearSettledLaunchBanner('),
    js.indexOf('function setErrorBanner('),
  );
  // sessionFor is stubbed to the one rule this function depends on: a project
  // row resolves to its session, or to null when there is none yet.
  const sessionFor = (p) => (state.sessions || []).find((s) => s.path === p.path) ?? null;
  if (!state.results) state.results = new Map();
  // handoffReady is the REAL implementation, not a stub: which statuses count
  // as "go and open it" is the whole decision this branch turns on, and a
  // stub here would let the two drift apart silently.
  const make = new Function(
    'state', 'sessionFor', 'hideBanner', 'launchBannerFor', 'handoffReady', 'showHandoff', 'tileAccount',
    src + '; return clearSettledLaunchBanner;',
  );
  return make(state, sessionFor, hideBannerSpy, launchBannerFor, handoffReady, showHandoffSpy, tileAccount);
}

function spy() {
  const calls = [];
  const fn = () => calls.push(1);
  fn.calls = calls;
  return fn;
}

const PROJ = { projects: [{ name: 'Beacon', path: 'F:/p/Beacon' }] };

test('clearSettledLaunchBanner does nothing when no launch banner is up', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Beacon', status: 'running' }] }, null)();
  assert.equal(hide.calls.length, 0);
});

test('clearSettledLaunchBanner keeps the banner while the launch has not landed in state.sessions yet', () => {
  const hide = spy();
  // "not landed yet" is represented by state.results STILL holding the launch
  // result. An empty results map with no entry means the opposite - it landed
  // and the session is gone - which is the desk-exit test further down.
  const state = { ...PROJ, sessions: [], results: new Map([['Beacon', { kind: 'started' }]]) };
  makeClearSettled(hide, state, 'Beacon')();
  assert.equal(hide.calls.length, 0, 'the 202 fires before the entry exists - hiding here would blank it instantly');
});

test('clearSettledLaunchBanner keeps the banner while the session is still starting', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Beacon', status: 'starting' }] }, 'Beacon')();
  assert.equal(hide.calls.length, 0);
});

test('clearSettledLaunchBanner hands off as soon as the session is running', () => {
  // CHANGED by the hand-off banner. This used to assert hideBanner(). The launch
  // banner still must not sit there until a manual refresh - the original
  // bug - but "landed and live" is now the one moment the hand-off to the
  // Claude app is worth saying, so the line is REPLACED rather than cleared.
  // Clearing it here again would put the app back to saying nothing at the
  // only point where it has something useful to say.
  const hide = spy();
  const handoff = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Beacon', status: 'running' }] }, 'Beacon', handoff)();
  assert.equal(handoff.calls.length, 1, 'a live launch must hand off');
  assert.equal(hide.calls.length, 0, 'and must not blank the banner on the way');
});

test('clearSettledLaunchBanner drops the banner for a failed session too, so maybeFailedBanner can replace it', () => {
  const hide = spy();
  const handoff = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Beacon', status: 'failed' }] }, 'Beacon', handoff)();
  assert.equal(hide.calls.length, 1);
  // A failed launch must NEVER hand off. Sending someone to the
  // Claude app to look for a session that did not start is worse than silence
  // - they go, find nothing, and stop trusting what the app tells them.
  assert.equal(handoff.calls.length, 0, 'a failed launch must not offer to open it');
});

test('both banner primitives release the launch handle, so no other message can be hidden by it', () => {
  const js = read('app.js');
  const setB = js.slice(js.indexOf('function setBanner('), js.indexOf('function hideBanner('));
  const hideB = js.slice(js.indexOf('function hideBanner('), js.indexOf('function clearSettledLaunchBanner('));
  assert.match(setB, /launchBannerFor = null;/);
  assert.match(hideB, /launchBannerFor = null;/);
});

test('both poll loops clear the launch banner BEFORE the call that may set its own', () => {
  const js = read('app.js');
  const confirm = js.slice(js.indexOf('async function confirmStarting('), js.indexOf('const WATCH_GAP_MS'));
  assert.ok(
    confirm.indexOf('clearSettledLaunchBanner()') < confirm.indexOf('maybeFailedBanner()'),
    'a failed launch must end up showing the failure, not a blank banner',
  );
  const watch = js.slice(js.indexOf('async function watchSessions('), js.indexOf('function hideSplash('));
  assert.ok(
    watch.indexOf('clearSettledLaunchBanner()') < watch.indexOf('reportEnded()'),
    'the handoff-written line must survive the clear',
  );
});

// --- a launch result must not outlive the session it describes -------------

function makeDropCovered(state) {
  const js = read('app.js');
  const src = js.slice(
    js.indexOf('function dropCoveredResults('),
    js.indexOf('function clearSettledLaunchBanner('),
  );
  const sessionFor = (p) =>
    (state.sessions || []).find((s) => s.path === p.path && s.status !== 'ended') ?? null;
  return new Function('state', 'sessionFor', src + '; return dropCoveredResults;')(state, sessionFor);
}

test('dropCoveredResults keeps the launch result while the entry has not landed yet', () => {
  const state = {
    projects: [{ name: 'Beacon', path: 'F:/p/Beacon' }],
    sessions: [],
    results: new Map([['Beacon', { kind: 'started' }]]),
  };
  makeDropCovered(state)();
  assert.equal(state.results.size, 1, 'the 202 fires before the entry exists - the tile needs this to say starting');
});

test('dropCoveredResults drops the result the moment the server has an entry', () => {
  const state = {
    projects: [{ name: 'Beacon', path: 'F:/p/Beacon' }],
    sessions: [{ path: 'F:/p/Beacon', status: 'starting' }],
    results: new Map([['Beacon', { kind: 'started' }]]),
  };
  makeDropCovered(state)();
  assert.equal(state.results.size, 0, 'the session now speaks for itself');
});

test('a session pruned after being seen leaves NO stale result to fall back to', () => {
  // The reported bug end to end: launch, entry appears, session exited at the
  // desk, entry pruned. Without the drop, rowState fell back to the result and
  // the tile sat on "starting..." until a manual refresh.
  const state = {
    projects: [{ name: 'Beacon', path: 'F:/p/Beacon' }],
    sessions: [{ path: 'F:/p/Beacon', status: 'running' }],
    results: new Map([['Beacon', { kind: 'started' }]]),
  };
  const drop = makeDropCovered(state);
  drop();                       // poll tick while it is running
  state.sessions = [];          // desk exit, entry pruned server-side
  drop();                       // next poll tick
  assert.equal(state.results.size, 0);
});

test('dropCoveredResults leaves a result for a project that no longer exists alone', () => {
  const state = {
    projects: [],
    sessions: [],
    results: new Map([['Gone', { kind: 'error', code: 'x' }]]),
  };
  makeDropCovered(state)();
  assert.equal(state.results.size, 1, 'no project row to render it on - not this function\'s business');
});

test('both poll loops drop covered results as soon as sessions are refreshed', () => {
  const js = read('app.js');
  const confirm = js.slice(js.indexOf('async function confirmStarting('), js.indexOf('const WATCH_GAP_MS'));
  assert.ok(
    confirm.indexOf('dropCoveredResults()') < confirm.indexOf('render()'),
    'the drop must happen before the render that would otherwise draw the stale result',
  );
  const watch = js.slice(js.indexOf('async function watchSessions('), js.indexOf('function hideSplash('));
  assert.ok(
    watch.indexOf('dropCoveredResults()') < watch.indexOf('render()'),
    'same for the 5s watch loop, which is the one that sees a desk exit',
  );
});

// --- banner: a session exited AT THE DESK is dropped, never reported -------

test('the launch banner keeps waiting while the launch has not landed (result still held)', () => {
  const hide = spy();
  const state = { ...PROJ, sessions: [], results: new Map([['Beacon', { kind: 'started' }]]) };
  makeClearSettled(hide, state, 'Beacon')();
  assert.equal(hide.calls.length, 0, 'no entry yet AND the result is still there - the 202 has not landed');
});

test('the launch banner clears when a session that HAD landed disappears (desk exit)', () => {
  // registry.js:571 drops the entry outright on a dead pid - it is never
  // reported as `failed`, so "no entry" must not be read as "not landed yet".
  // dropCoveredResults() has already removed the result by then; that absence
  // is what tells the two cases apart.
  const hide = spy();
  const state = { ...PROJ, sessions: [], results: new Map() };
  makeClearSettled(hide, state, 'Beacon')();
  assert.equal(hide.calls.length, 1, 'this is the bug: the banner sat on "start requested" forever');
});

test('dropCoveredResults runs BEFORE clearSettledLaunchBanner in both loops', () => {
  // The discriminator above is only correct in that order.
  const js = read('app.js');
  for (const [label, from, to] of [
    ['confirmStarting', 'async function confirmStarting(', 'const WATCH_GAP_MS'],
    ['watchSessions', 'async function watchSessions(', 'function hideSplash('],
  ]) {
    const fn = js.slice(js.indexOf(from), js.indexOf(to));
    assert.ok(
      fn.indexOf('dropCoveredResults()') < fn.indexOf('clearSettledLaunchBanner()'),
      `${label}: the result must be dropped before the banner reads it`,
    );
  }
});

// --- the ended banner reports the end, and nothing else -------------------

test('reportEnded announces one line and carries no handoff verdict at all', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function reportEnded('), js.indexOf('function failedSessions('));
  assert.match(fn, /setBanner\('info', \[\{ b: s\.project \}, \{ text: ' ended\.' \}\]\)/);
  for (const gone of ['handoff_result', 'handoff_ok']) {
    assert.ok(!fn.includes(gone), `reportEnded must not read ${gone} - the agent no longer writes one`);
  }
});

// --- the folder row -------------------------------------------------------

function makeRowState(state) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function rowState('), js.indexOf('function setDot('));
  return new Function('state', 'sessionFor', 'elapsed', src + '; return rowState;')(
    state,
    (p) => (state.sessions || []).find((s) => s.path === p.path) ?? null,
    () => '1m',
  );
}

// Minimal DOM stub - buildRow only ever creates elements, sets className /
// textContent / dataset / attributes, and appends. buildDot and statusLine are
// injected so this stays a test of buildRow and nothing else.
function makeBuildRow() {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function buildRow('), js.indexOf('function setBanner('));
  const document = {
    createElement(tag) {
      return {
        tag, children: [], attrs: {}, dataset: {}, className: '', textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); return c; },
      };
    },
  };
  return new Function('document', 'buildDot', 'statusLine', src + '; return buildRow;')(
    document,
    () => ({ tag: 'DOT' }),
    (rs) => rs.status,
  );
}

const ROW_STATE_BASE = { projects: [], sessions: [], launching: new Set(), stopping: new Set(), results: new Map() };

test('a container renders as a list row with a folder descriptor, never a tile', () => {
  const rowState = makeRowState({ ...ROW_STATE_BASE });
  const rs = rowState({
    name: 'Pull Requests', path: 'F:/p/Pull Requests', container: true,
    children: [1, 2, 3, 4, 5].map((n) => ({ name: String(n) })),
  });
  assert.equal(rs.zone, 'list');
  assert.equal(rs.folder, true);
  assert.equal(rs.status, '5 projects');
  assert.equal(rs.dot, undefined, 'a folder has no session state, so it takes no dot');
  assert.ok(!rs.implicit, 'a folder row always draws its sub-line');
});

test('a container stays a list row even with a launch in flight for its name', () => {
  // Pins the branch ORDER: fails if the container check is moved below the
  // launching check.
  const rowState = makeRowState({ ...ROW_STATE_BASE, launching: new Set(['Pull Requests']) });
  const rs = rowState({ name: 'Pull Requests', path: 'F:/p/Pull Requests', container: true, children: [{ name: '1' }] });
  assert.equal(rs.zone, 'list');
});

test('a container with one child reads "1 project", not "1 projects"', () => {
  const rowState = makeRowState({ ...ROW_STATE_BASE });
  const rs = rowState({ name: 'Solo', path: 'F:/p/Solo', container: true, children: [{ name: 'only' }] });
  assert.equal(rs.status, '1 project');
});

test('buildRow gives a folder row no dot and a chevron, and data-folder not data-project', () => {
  const buildRow = makeBuildRow();
  const btn = buildRow({ name: 'Pull Requests' }, { zone: 'list', folder: true, status: '5 projects', idle: '—' });
  assert.equal(btn.className, 'row folder');
  assert.equal(btn.dataset.project, undefined, 'a folder row must not carry data-project - that is what onProjectTap launches on');
  assert.equal(btn.dataset.folder, 'Pull Requests');
  assert.ok(!btn.children.some((c) => c.tag === 'DOT'), 'a folder row must have no dot element');
  const last = btn.children[btn.children.length - 1];
  assert.equal(last.className, 'folder-chev');
  assert.equal(last.textContent, '>');
  assert.equal(last.attrs['aria-hidden'], 'true');
});

test('an ordinary row still gets its dot and data-project', () => {
  const buildRow = makeBuildRow();
  const btn = buildRow({ name: 'Beacon' }, { zone: 'list', dot: 'dim', status: 'no session', implicit: true });
  assert.equal(btn.className, 'row');
  assert.equal(btn.children[0].tag, 'DOT');
  assert.equal(btn.dataset.project, 'Beacon');
  assert.equal(btn.dataset.folder, undefined);
  assert.ok(!btn.children.some((c) => c.className === 'folder-chev'));
});

test("the folder row's left-edge break comes from the missing dot, not a nudge", () => {
  const css = read('app.css');
  assert.match(css, /\.row\s*\{[^}]*gap:\s*12px/s);
  const js = read('app.js');
  const dotStart = js.indexOf('function buildDot(');
  assert.ok(dotStart !== -1, 'buildDot is what emits the element the folder row drops');
  const buildDotSrc = js.slice(dotStart, js.indexOf('\n}', dotStart) + 2);
  assert.match(buildDotSrc, /width="8"/, '8 + 12 = the 20px shift');
  // Comments are stripped FIRST. Matched against raw source, `[^{]*` sweeps
  // straight through a comment that merely mentions a .folder selector and
  // into the next real rule's body, so an innocent comment made this test
  // fail on an unrelated rule's margin - twice in one night, once for
  // .backbar and once for a since-deleted .row.self rule. Both were worked
  // around at the time by rewording
  // the comment; this fixes the instrument instead.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const folderRules = rules.match(/\.(?:row\.folder|folder)[^{]*\{[^}]*\}/g) || [];
  assert.ok(folderRules.length > 0, 'no .folder rule matched - the test would pass vacuously');
  for (const rule of folderRules) {
    assert.ok(
      !/padding-left|margin-left|padding\s*:|margin\s*:/.test(rule),
      'the offset must fall out of dropping the element, or it drifts the first time .row\'s gap changes',
    );
  }
});

test('the folder row uses the three tokenized colours the design names', () => {
  const css = read('app.css');
  assert.match(css, /\.row\.folder \.row-name\s*\{[^}]*var\(--text-2\)/);
  assert.match(css, /\.row\.folder \.row-status\s*\{[^}]*var\(--dim\)/);
  assert.match(css, /\.folder-chev\s*\{[^}]*var\(--accent-2\)/);
});

test('TOTAL counts what can be started - a container\'s children, not the container', () => {
  const js = read('app.js');
  const body = js.match(/const total = ([^;]+);/);
  assert.ok(body, 'renderFooter must carry the total expression');
  const total = new Function('state', `return ${body[1]};`);
  assert.equal(total({ projects: [
    ...Array.from({ length: 14 }, (_, i) => ({ name: `p${i}` })),
    { name: 'Pull Requests', container: true, children: Array.from({ length: 5 }, (_, i) => ({ name: `c${i}` })) },
  ] }), 19);
  assert.equal(total({ projects: Array.from({ length: 3 }, (_, i) => ({ name: `p${i}` })) }), 3);
  assert.equal(total({ projects: [{ name: 'Pull Requests', container: true, children: Array.from({ length: 5 }, (_, i) => ({ name: `c${i}` })) }] }), 5);

  assert.match(js, /allCount\.textContent = String\(state\.projects\.length\)/,
    'ALL PROJECTS stays the top-level count - one list, one number');
});

// --- the drill-in screen ---

function makeChildProject() {
  const js = read('app.js');
  // Anchored on childProject's OWN closing brace, never on whatever
  // function happens to follow it - the previous anchor was the next
  // function's name and broke the moment that function was deleted.
  const start = js.indexOf('function childProject(');
  const src = js.slice(start, js.indexOf('\n}', start) + 2);
  return new Function(src + '; return childProject;')();
}

function rowMain(btn) {
  return btn.children.find((c) => c.className === 'row-main');
}

test('childProject keys a child by the two-segment identity and labels it by its folder name', () => {
  const childProject = makeChildProject();
  const result = childProject({ name: 'Pull Requests' }, { name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' });
  assert.deepEqual(result, { name: 'Pull Requests/Vercel', label: 'Vercel', path: 'F:/p/Pull Requests/Vercel' });
  assert.notEqual(result.name, 'Vercel', 'a top-level Vercel would otherwise share every state key with it');
});

test('a drill-in row draws the child\'s own name but is keyed by the identity', () => {
  const buildRow = makeBuildRow();
  const childProject = makeChildProject();
  const p = childProject({ name: 'Pull Requests' }, { name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' });
  const btn = buildRow(p, { zone: 'list', dot: 'dim', status: 'no session', implicit: true });
  assert.equal(btn.dataset.project, 'Pull Requests/Vercel');
  assert.equal(rowMain(btn).children[0].textContent, 'Vercel');
});

// Minimal DOM stub matching makeBuildRow's shape, extended with classList and
// append() (a q.append(cancel, go) call lives in the confirm branch, though
// this test only exercises the STOP branch).
function makeBuildTile() {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function buildTile('), js.indexOf('function buildRow('));
  const document = {
    createElement(tag) {
      return {
        tag, children: [], attrs: {}, dataset: {}, className: '', textContent: '',
        classList: { add() {} },
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { this.children.push(...cs); },
      };
    },
  };
  return new Function('document', 'state', 'buildDot', 'statusLine', src + '; return buildTile;')(
    document,
    { launching: new Set(), stopping: new Set(), confirmName: null },
    () => ({ tag: 'DOT' }),
    (rs) => rs.status,
  );
}

test('a drill-in tile draws the label but STOPs the identity', () => {
  const buildTile = makeBuildTile();
  const childProject = makeChildProject();
  const p = childProject({ name: 'Pull Requests' }, { name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' });
  const el = buildTile(p, { dot: 'dim', status: 'no session', stop: true });
  const nameEl = el.children.find((c) => c.className === 'tile-name');
  assert.equal(nameEl.textContent, 'Vercel');
  const stopBtn = el.children.find((c) => c.className === 'tile-stop');
  assert.equal(stopBtn.dataset.stop, 'Pull Requests/Vercel');
});

test('endTargetFor ends a nested row by project, never by session name', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function endTargetFor('), js.indexOf('// Reconciled by renderProjects() too'));
  const endTargetFor = new Function('state', `${fn}\nreturn endTargetFor;`)({
    projects: [{ name: 'Vercel' }],
    sessions: [{ source: 'desk', project: 'Vercel', session_name: 'vercel' }],
  });
  assert.deepEqual(endTargetFor('Pull Requests/Vercel'), { project: 'Pull Requests/Vercel' });
  assert.deepEqual(endTargetFor('Vercel'), { project: 'Vercel' }, 'the two must never resolve to each other');
});

test('a nested launch result is dropped once the agent has the entry', () => {
  const state = {
    projects: [{ name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] }],
    sessions: [{ project: 'Pull Requests/Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'launched', status: 'starting' }],
    results: new Map([['Pull Requests/Vercel', { kind: 'started' }]]),
  };
  const js = read('app.js');
  const src = js.slice(js.indexOf('function dropCoveredResults('), js.indexOf('function clearSettledLaunchBanner('));
  // Mirrors sessionFor's real two-key rule (path, or project name for a
  // non-desk registry entry).
  const sessionFor = (p) => (state.sessions || []).find((s) => s.path === p.path || (s.project === p.name && s.source !== 'desk')) ?? null;
  const dropCoveredResults = new Function('state', 'sessionFor', src + '; return dropCoveredResults;')(state, sessionFor);
  dropCoveredResults();
  assert.equal(state.results.size, 0, 'leaving it froze the tile on "starting..." after a desk exit, same as the top-level bug');
});

test('a nested launch banner clears once the nested session is running', () => {
  const state = {
    projects: [{ name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] }],
    sessions: [{ project: 'Pull Requests/Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'launched', status: 'running' }],
  };
  const js = read('app.js');
  const src = js.slice(js.indexOf('function clearSettledLaunchBanner('), js.indexOf('function setErrorBanner('));
  // Mirrors sessionFor's real two-key rule, same as the dropCoveredResults
  // nested test above - state.projects holds top-level entries only, so a
  // plain `.find` on the nested name misses and the pathless stand-in is
  // what lets this resolve at all.
  const sessionFor = (p) => (state.sessions || []).find((s) => s.path === p.path || (s.project === p.name && s.source !== 'desk')) ?? null;
  const hide = spy();
  const handoff = spy();
  const clearSettledLaunchBanner = new Function(
    'state', 'sessionFor', 'hideBanner', 'launchBannerFor', 'handoffReady', 'showHandoff', 'tileAccount',
    src + '; return clearSettledLaunchBanner;',
  )(state, sessionFor, hide, 'Pull Requests/Vercel', handoffReady, handoff, () => null);
  clearSettledLaunchBanner();
  // CHANGED by the hand-off banner, same as the top-level case: a running session
  // hands off rather than blanking. The claim under test is unchanged and is
  // still about the pathless stand-in - without it this nested launch resolves
  // to no session at all and the banner is left up forever.
  assert.equal(handoff.calls.length, 1, 'without the pathless stand-in, a nested launch banner never settles - the same bug fixed for top-level projects');
  assert.equal(hide.calls.length, 0);
});

// The two chrome taps that could open a folder / leave a folder under a live
// confirm must answer the question instead of acting - section 5's ordering
// invariant depends on both of these swallowing the tap.

function callOnProjectTapFolder(folderName, cancelOpenConfirmStub, openFolderScreenStub) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('async function onProjectTap('), js.indexOf('function cancelOpenConfirm('));
  const onProjectTap = new Function('cancelOpenConfirm', 'openFolderScreen', src + '; return onProjectTap;')(
    cancelOpenConfirmStub, openFolderScreenStub,
  );
  const e = { target: { closest: (sel) => (sel === '[data-folder]' ? { dataset: { folder: folderName } } : null) } };
  onProjectTap(e);
}

test('onProjectTap: a folder-row tap while a confirm is open only cancels it, never opens the folder', () => {
  let opened = null;
  callOnProjectTapFolder('Pull Requests', () => true, (name) => { opened = name; });
  assert.equal(opened, null, 'one gesture must have exactly one effect - the tap that swallows an open confirm must not also open the folder');
});

test('onProjectTap: a folder-row tap with no confirm open opens the folder', () => {
  let opened = null;
  callOnProjectTapFolder('Pull Requests', () => false, (name) => { opened = name; });
  assert.equal(opened, 'Pull Requests');
});

test("D11 - onProjectTap's [data-choose] branch returns before any [data-project] work and never calls launchSession", () => {
  const js = read('app.js');
  // Stops BEFORE onChooseFolders' own declaration, not at cancelOpenConfirm:
  // a function declaration inside the sliced source would shadow the
  // injected stub of the same name, silently calling the REAL onChooseFolders
  // (which needs state/document/etc that this test never provides) instead
  // of the stub - exactly the ReferenceError trap this task's brief warns
  // about, one level removed.
  const src = js.slice(js.indexOf('async function onProjectTap('), js.indexOf('async function onChooseFolders('));
  let chosen = false;
  const onProjectTap = new Function(
    'onChooseFolders',
    src + '; return onProjectTap;',
  )(() => { chosen = true; });
  const e = { target: { closest: (sel) => (sel === '[data-choose]' ? { dataset: { choose: '1' } } : null) } };
  onProjectTap(e);
  assert.equal(chosen, true, 'a misplaced or missing check would leave onChooseFolders uncalled, the same failure a launch attempt would need to be caught by');
});

// The back bar's click handler is an inline arrow inside wireEvents, not a
// named function - lifted by its own literal id/text anchor, same guard.
function callBackBarHandler(cancelOpenConfirmStub, closeFolderScreenStub) {
  const js = read('app.js');
  const marker = "document.getElementById('backbar').addEventListener('click', () => {";
  const start = js.indexOf(marker) + marker.length;
  const end = js.indexOf('});', start);
  const body = js.slice(start, end);
  new Function('cancelOpenConfirm', 'closeFolderScreen', body)(cancelOpenConfirmStub, closeFolderScreenStub);
}

test('backbar click: with a confirm open, the first tap only cancels it, never leaves the folder', () => {
  let closed = false;
  callBackBarHandler(() => true, () => { closed = true; });
  assert.equal(closed, false, 'one gesture must have exactly one effect - the tap that swallows an open confirm must not also close the folder');
});

test('backbar click: with no confirm open, the tap closes the folder', () => {
  let closed = false;
  callBackBarHandler(() => false, () => { closed = true; });
  assert.equal(closed, true);
});

// Integration-level: renderProjects itself, with a folder open, scoped to
// only that folder's children and sessions - not the piecewise helpers.
// The list-state trap: renderProjects now also references listZoneState, missingRoots,
// buildEmptyState, buildGoneNotice and five copy.js constants at module
// scope - every one of them has to be added to BOTH the parameter list and
// the call arguments below, or a test that reaches those branches dies with
// a ReferenceError instead of a useful failure. Each defaults to the REAL
// implementation so every pre-existing call site (which passes none of
// these) keeps working unedited.
function makeRenderProjectsIntegration(stubs) {
  const js = read('app.js');
  const helpers = js.slice(js.indexOf('function elapsed('), js.indexOf('function setDot('));
  const childStart = js.indexOf('function childProject(');
  const child = js.slice(childStart, js.indexOf('\n}', childStart) + 2);
  const rp = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  const src = helpers + child + rp;
  return new Function(
    'document', 'state', 'buildTile', 'buildRow', 'renderBackBar',
    'listZoneState', 'missingRoots', 'buildEmptyState', 'buildGoneNotice', 'crumbSegments',
    // The offline branch reads it; without this the one list state added by
    // the offline state is the only one that cannot be integration-tested.
    'PHONE_OFFLINE', 'CANNOT_REACH',
    'SHARED_UNKNOWN', 'NOTHING_SHARED', 'ALL_ROOTS_GONE', 'EMPTY_DAY_ONE_BODY', 'emptyDayOneTitle',
    // The folder grouping runs inside renderProjects now, so the row zone's own
    // dependency comes in here too.
    'projectSections',
    // And the serve_missing alert's fix: buildServeMissingState is read only on
    // the serveMissing branch (dormant for every pre-existing test here);
    // closeActiveReauth runs unconditionally at the top of every call.
    'buildServeMissingState', 'closeActiveReauth',
    // renderProjects asks what the + offers and hands it to renderBackBar.
    'plusMenuItems',
    src + '; return renderProjects;',
  )(
    stubs.document, stubs.state, stubs.buildTile, stubs.buildRow, stubs.renderBackBar,
    stubs.listZoneState || folders.listZoneState,
    stubs.missingRoots || folders.missingRoots,
    stubs.buildEmptyState || (() => makeStubEl()),
    stubs.buildGoneNotice || (() => makeStubEl()),
    stubs.crumbSegments || folders.crumbSegments,
    stubs.PHONE_OFFLINE || copy.PHONE_OFFLINE,
    stubs.CANNOT_REACH || copy.CANNOT_REACH,
    stubs.SHARED_UNKNOWN || copy.SHARED_UNKNOWN,
    stubs.NOTHING_SHARED || copy.NOTHING_SHARED,
    stubs.ALL_ROOTS_GONE || copy.ALL_ROOTS_GONE,
    stubs.EMPTY_DAY_ONE_BODY || copy.EMPTY_DAY_ONE_BODY,
    stubs.emptyDayOneTitle || copy.emptyDayOneTitle,
    stubs.projectSections || folders.projectSections,
    stubs.buildServeMissingState || (() => makeStubEl()),
    stubs.closeActiveReauth || (() => {}),
    stubs.plusMenuItems || folders.plusMenuItems,
  );
}

function makeStubEl() {
  return {
    innerHTML: '', textContent: '', children: [],
    classList: { toggle() {}, add() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
  };
}

test('renderProjects: with a folder open, only that folder\'s children render and only that folder\'s sessions reach the RUNNING zone', () => {
  const state = {
    projects: [
      { name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] },
      { name: 'Beacon', path: 'F:/p/Beacon' },
    ],
    openFolder: 'Pull Requests',
    sessions: [
      { project: 'Pull Requests/Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'launched', status: 'running', activity: 'busy' },
      { project: 'Beacon', path: 'F:/p/Beacon', source: 'launched', status: 'running', activity: 'busy' },
    ],
    launching: new Set(), stopping: new Set(), results: new Map(), confirmName: null, focusName: null,
  };
  const els = { tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl(), 'all-header': makeStubEl(), 'all-rule': makeStubEl(), 'all-label': makeStubEl(), 'zone-run': makeStubEl(), 'pane-empty': makeStubEl(), 'pane-empty-body': makeStubEl() };
  const document = { getElementById: (id) => els[id] };
  const rowsSeen = [];
  const tilesSeen = [];
  const buildRow = (p) => { rowsSeen.push(p.name); return { tag: 'ROW' }; };
  const buildTile = (p) => { tilesSeen.push(p.name); return { tag: 'TILE' }; };
  const renderBackBar = () => {};
  const renderProjects = makeRenderProjectsIntegration({ document, state, buildTile, buildRow, renderBackBar });

  renderProjects();

  assert.deepEqual(rowsSeen, [], 'the only child, Vercel, is a running session so it is a tile, not a list row');
  assert.deepEqual(tilesSeen, ['Pull Requests/Vercel'], 'the unrelated top-level Beacon session must not reach the RUNNING zone while the folder is open');
  assert.ok(!rowsSeen.includes('Beacon') && !tilesSeen.includes('Beacon'), 'a top-level project must never appear while a folder is open');
  assert.ok(!rowsSeen.includes('Pull Requests'), 'the container must never appear as a row inside its own screen');
});

// Given in the brief verbatim: slices onPopState (and, harmlessly,
// openFolderScreen/closeFolderScreen ahead of it - declarations only, never
// called by these tests).
function makePopState(state, historyStub) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function onPopState('), js.indexOf('function endTargetFor('));
  // The settings stack is EMPTY in these tests: they exercise the drill/confirm
  // branches, which sit below the settings branch and must be unaffected by it.
  // 'sheetPushed' is the once-only sheet's flag, injected false: its branch is first in
  // onPopState and would otherwise swallow every pop these tests issue.
  return new Function('state', 'history', 'render', 'confirmPushed', 'folderPushed', 'settingsPushed', 'showScreen',
    'settingsSubs', 'currentSub', 'closingSub', 'SETTINGS_SUBS', 'renderSettings', 'renderSettingsSub',
    'sheetPushed',
    src + '; return onPopState;')(state, historyStub, () => {}, true, true, false, () => {},
    [], () => null, false, new Set(['see', 'agent', 'reset', 'about', 'update']), () => {}, () => {},
    false);
}

test('back with only the drill-in open returns to the list', () => {
  const state = { openFolder: 'Pull Requests', confirmName: null };
  const onPopState = makePopState(state, { state: null });
  onPopState();
  assert.equal(state.openFolder, null);
});

test('back with the confirm open on top cancels the confirm and stays in the folder', () => {
  const state = { openFolder: 'Pull Requests', confirmName: 'Pull Requests/Vercel' };
  const onPopState = makePopState(state, { state: { drill: 'Pull Requests' } });
  onPopState();
  assert.equal(state.confirmName, null);
  assert.equal(state.openFolder, 'Pull Requests',
    "the confirm's entry is always above the folder's, so one gesture must have exactly one effect");
});

test('a pop the app issued itself leaves the folder alone', () => {
  const state = { openFolder: 'Pull Requests', confirmName: null };
  const onPopState = makePopState(state, { state: { drill: 'Pull Requests' } });
  onPopState();
  assert.equal(state.openFolder, 'Pull Requests');
});

function makeOpenFolderScreen(state, historyStub) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function openFolderScreen('), js.indexOf('function closeFolderScreen('));
  return new Function('state', 'history', 'render', 'folderPushed',
    src + '; return openFolderScreen;')(state, historyStub, () => {}, false);
}

test('openFolderScreen pushes exactly one entry, marked with the folder name', () => {
  const pushes = [];
  const state = { openFolder: null };
  const openFolderScreen = makeOpenFolderScreen(state, { pushState: (s) => pushes.push(s) });
  openFolderScreen('A');
  openFolderScreen('B');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { drill: 'A' });
});

function makeCloseFolderScreen(state, backSpy) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function closeFolderScreen('), js.indexOf('// Extracted to a named function'));
  return new Function('state', 'history', 'render', 'folderPushed',
    src + '; return closeFolderScreen;')(state, { back: backSpy }, () => {}, true);
}

test('closeFolderScreen clears the folder and a double tap fires one history.back()', () => {
  const calls = [];
  const state = { openFolder: 'Pull Requests' };
  const closeFolderScreen = makeCloseFolderScreen(state, () => calls.push(1));
  closeFolderScreen();
  closeFolderScreen();
  assert.equal(calls.length, 1);
  assert.equal(state.openFolder, null);
});

function makeRenderFooter(state) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function renderFooter('), js.indexOf('function childProject('));
  const footerEl = { textContent: '' };
  const document = { getElementById: (id) => { assert.equal(id, 'footer'); return footerEl; } };
  const renderFooter = new Function('document', 'state', src + '; return renderFooter;')(document, state);
  return { renderFooter, footerEl };
}

test('inside a folder the footer counts the rows on screen; at the top level it is unaffected', () => {
  const inFolder = makeRenderFooter({
    openFolder: 'Pull Requests',
    projects: [{ name: 'Pull Requests', container: true, children: [1, 2, 3] }],
    sessions: [],
    results: new Map(),
  });
  inFolder.renderFooter([
    { rs: { dot: 'filled' } },
    { rs: { dot: 'dim' } },
    { rs: { dot: 'dim' } },
  ]);
  assert.equal(inFolder.footerEl.textContent, '1 ACTIVE · 3 TOTAL');

  const topLevel = makeRenderFooter({
    openFolder: null,
    projects: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}` })),
    sessions: [],
    results: new Map(),
  });
  topLevel.renderFooter([{ rs: { dot: 'filled' } }]);
  assert.equal(topLevel.footerEl.textContent, '1 ACTIVE · 5 TOTAL', 'the top-level total is the whole-list count, not the rows passed in');
});

function makeRenderBackBar(newProjectAt = null) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function renderBackBar('), js.indexOf('function render()'));
  const els = {};
  const document = {
    getElementById(id) {
      if (!els[id]) {
        els[id] = {
          hidden: false, textContent: '', attrs: {},
          setAttribute(k, v) { this.attrs[k] = v; },
        };
      }
      return els[id];
    },
  };
  const closeCalls = [];
  const syncs = [];
  const renderBackBar = new Function('document', 'closeNewProjectPanel', 'syncPlusMenu', 'newProjectAt', src + '; return renderBackBar;')(
    document, () => closeCalls.push(1), (plus) => syncs.push(plus), newProjectAt,
  );
  return { renderBackBar, els, closeCalls, syncs };
}

// The + used to hide inside a folder; it now shows there too, and hides
// only when plusMenuItems has nothing to offer.
test('renderBackBar reveals the bar and keeps the + inside a folder; the + hides only with nothing to offer', () => {
  const open = makeRenderBackBar();
  open.renderBackBar({ name: 'Pull Requests', path: 'F:/p/Pull Requests' }, ['share', 'new']);
  assert.equal(open.els.backbar.hidden, false);
  assert.equal(open.els.newproj.hidden, false, 'the + shows inside a folder of projects');
  assert.equal(open.els['backbar-name'].textContent, 'Pull Requests');
  assert.equal(open.els['backbar-path'].textContent, 'F:/p/Pull Requests');
  assert.ok(open.els.backbar.attrs['aria-label'], 'an aria-label must be set');
  assert.deepEqual(open.syncs, [['share', 'new']], 'every render hands the choices to syncPlusMenu');

  const closed = makeRenderBackBar();
  closed.renderBackBar(null, ['share']);
  assert.equal(closed.els.backbar.hidden, true);
  assert.equal(closed.els.newproj.hidden, false, 'Share folder alone still shows the +');

  const unknown = makeRenderBackBar();
  unknown.renderBackBar(null, []);
  assert.equal(unknown.els.newproj.hidden, true, 'shared set unknown: nothing to offer, no +');
  assert.deepEqual(unknown.syncs, [[]], 'including an empty list, which closes a menu open over it');
});

// RED WHEN: the name panel survives a level change - its target line and the
// root it sends would name the folder the owner has just left.
test('renderBackBar closes the name panel only when the level it was opened on changes', () => {
  const top = { folder: null, root: null, dir: 'F:\\p' };
  const stay = makeRenderBackBar(top);
  stay.renderBackBar(null, ['share', 'new']);
  assert.equal(stay.closeCalls.length, 0, 'same level: the panel stays open');

  const drill = makeRenderBackBar(top);
  drill.renderBackBar({ name: 'Uni', path: 'F:\\p\\Uni' }, ['share', 'new']);
  assert.equal(drill.closeCalls.length, 1, 'opened at the top, now inside Uni: closed');

  const inside = { folder: 'Uni', root: 'F:\\p\\Uni', dir: 'F:\\p\\Uni' };
  const back = makeRenderBackBar(inside);
  back.renderBackBar(null, ['share', 'new']);
  assert.equal(back.closeCalls.length, 1, 'opened inside Uni, now at the top: closed');

  const same = makeRenderBackBar(inside);
  same.renderBackBar({ name: 'Uni', path: 'F:\\p\\Uni' }, ['share', 'new']);
  assert.equal(same.closeCalls.length, 0, 'a re-render inside the same folder keeps it');
});

test('the bar can never appear on the passcode screen', () => {
  const html = read('index.html');
  const css = read('app.css');

  const tag = html.match(/<button class="backbar" id="backbar"[^>]*>/);
  assert.ok(tag, 'index.html must contain the back bar');
  assert.match(tag[0], /\shidden[\s>]/, 'the back bar must ship hidden');

  const pickerIdx = html.indexOf('<main id="picker"');
  const gateIdx = html.indexOf('<main id="gate"');
  const barIdx = html.indexOf('id="backbar"');
  assert.ok(pickerIdx !== -1 && gateIdx !== -1 && pickerIdx < barIdx && barIdx < gateIdx,
    'the back bar must live inside #picker, not #gate');

  const rule = css.match(/\.backbar\s*\{[^}]*\}/);
  assert.ok(rule, 'app.css must carry a .backbar rule');
  assert.match(rule[0], /display:/, '.backbar sets display, which is what makes the force-hide rule load-bearing here');

  const pickerBlock = html.slice(pickerIdx, gateIdx);
  assert.ok(
    pickerBlock.includes('id="backbar-name"') && pickerBlock.includes('id="backbar-path"'),
    'neither the name nor the path element may sit outside #picker',
  );
});

// --- the nested tile eyebrow ---

function tileParts(p) {
  const el = makeBuildTile()(p, { dot: 'filled', status: 'busy' });
  const find = (cls) => el.children.find((c) => c.className === cls);
  return { eyebrow: find('tile-eyebrow'), name: find('tile-name') };
}

test('the eyebrow marks a nested session by both routes and never a top-level project', () => {
  // Nested LAUNCHED synthetic row: the registry stores the client's raw
  // 'container/child' string as p.name, with no p.parent.
  const launched = tileParts({ name: 'Pull Requests/Vercel', path: 'F:/p/Pull Requests/Vercel' });
  assert.equal(launched.eyebrow.textContent, 'Pull Requests', 'this tile used to render the whole raw two-segment string as its name');
  assert.equal(launched.name.textContent, 'Vercel');

  // Nested DESK synthetic row: a desk session reports a bare basename, so the
  // parent can only reach the tile on the row object.
  const desk = tileParts({ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel', parent: 'Pull Requests' });
  assert.equal(desk.eyebrow.textContent, 'Pull Requests');
  assert.equal(desk.name.textContent, 'Vercel');

  // Drill-in row, via the real childProject().
  const childProject = makeChildProject();
  const child = tileParts(childProject({ name: 'Pull Requests' }, { name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }));
  assert.equal(child.eyebrow.textContent, 'Pull Requests');
  assert.equal(child.name.textContent, 'Vercel');

  // Top-level project: a top-level tile must be unchanged - no eyebrow, no
  // shifted name.
  const topLevel = tileParts({ name: 'Beacon', path: 'F:/p/Beacon' });
  assert.equal(topLevel.eyebrow, undefined);
  assert.equal(topLevel.name.textContent, 'Beacon');
});

test('parentFolderName reads the containing folder from either separator', () => {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function parentFolderName('), js.indexOf('function sessionFor('));
  const parentFolderName = new Function(src + '; return parentFolderName;')();
  assert.equal(parentFolderName('F:\\p\\Pull Requests\\Vercel'), 'Pull Requests');
  assert.equal(parentFolderName('F:/p/Pull Requests/Vercel'), 'Pull Requests');
  // It answers about the path and not the project list, which is why only
  // the synthetic-row loop calls it - a top-level project's path also has a
  // containing segment.
  assert.equal(parentFolderName('F:/p/Beacon'), 'p');
  assert.equal(parentFolderName(null), null);
});

test('renderProjects gives a synthetic row its parent and a listed project none', () => {
  const state = {
    projects: [
      { name: 'Beacon', path: 'F:/p/Beacon' },
      { name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] },
    ],
    openFolder: null,
    confirmName: null,
    focusName: null,
    sessions: [
      { project: 'Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'desk', status: 'running', activity: 'busy' },
      { project: 'Beacon', path: 'F:/p/Beacon', source: 'launched', status: 'running', activity: 'busy' },
    ],
    launching: new Set(), stopping: new Set(), results: new Map(),
  };
  const els = { tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl(), 'all-header': makeStubEl(), 'all-rule': makeStubEl(), 'all-label': makeStubEl(), 'zone-run': makeStubEl(), 'pane-empty': makeStubEl(), 'pane-empty-body': makeStubEl() };
  const document = { getElementById: (id) => els[id] };
  const seen = [];
  const buildRow = (p) => { seen.push(p); return { tag: 'ROW' }; };
  const buildTile = (p) => { seen.push(p); return { tag: 'TILE' }; };
  const renderBackBar = () => {};
  const renderProjects = makeRenderProjectsIntegration({ document, state, buildTile, buildRow, renderBackBar });

  renderProjects();

  const vercel = seen.find((p) => p.name === 'Vercel');
  const beacon = seen.find((p) => p.name === 'Beacon');
  assert.equal(vercel.parent, 'Pull Requests', 'the parent is attached where the row is built, because that is the only place that knows the row is not a listed project');
  assert.equal(beacon.parent, undefined);
});

// --- The empty/broken project list ------------------------------------

// Same createElement shape makeBuildRow uses - dataset/className/textContent
// plain objects, enough for buildEmptyState/buildGoneNotice to build a real
// tree that D1-D6 can walk.
function makeStubDocumentForBuild() {
  return {
    createElement(tag) {
      return {
        tag, children: [], attrs: {}, dataset: {}, className: '', textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); return c; },
      };
    },
  };
}

// The REAL buildEmptyState/buildGoneNotice, sliced straight out of app.js -
// so D1/D2/D3/D4 exercise the actual DOM shape, not a description of it.
function makeEmptyGoneBuilders() {
  const js = read('app.js');
  const start = js.indexOf('function buildEmptyState(');
  const end = js.indexOf('function setBanner(');
  const src = js.slice(start, end);
  return new Function(
    'document', 'CHOOSE_FOLDERS_BUTTON', 'REMOVE_BUTTON', 'rootGoneTitle', 'ROOT_GONE_BODY', 'crumbSegments',
    // buildEmptyState takes an ACTION name since the offline state - 'choose' or 'retry' -
    // and reads the label for each. Same rule as the renderProjects harness
    // above: a constant it references has to be injected here too.
    'RETRY_BUTTON',
    `${src}; return { buildEmptyState, buildGoneNotice };`,
  )(
    makeStubDocumentForBuild(), copy.CHOOSE_FOLDERS_BUTTON, copy.REMOVE_BUTTON, copy.rootGoneTitle, copy.ROOT_GONE_BODY, folders.crumbSegments,
    copy.RETRY_BUTTON,
  );
}

function countByDataset(root, key) {
  let n = 0;
  const walk = (node) => {
    if (node.dataset && node.dataset[key] !== undefined) n += 1;
    for (const c of (node.children || [])) walk(c);
  };
  walk(root);
  return n;
}

function baseEmptyListState(overrides) {
  return {
    projects: [],
    openFolder: null,
    reachable: true,
    shared: [],
    sessions: [],
    launching: new Set(),
    stopping: new Set(),
    results: new Map(),
    confirmName: null,
    focusName: null,
    ...overrides,
  };
}

function makeProjectsEls() {
  return {
    tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl(),
    // The folder-grouped row zone renames or hides the ALL PROJECTS header depending on
    // how many shared folders there are, so these three are read every render.
    'all-header': makeStubEl(), 'all-rule': makeStubEl(), 'all-label': makeStubEl(), 'zone-run': makeStubEl(), 'pane-empty': makeStubEl(), 'pane-empty-body': makeStubEl(),
  };
}

// getElementById off the persistent `els` map, PLUS a real createElement -
// every D-test below has zero running tiles, so renderProjects always builds
// the "nothing running" placeholder too, and that also calls
// document.createElement/append on the injected document.
function makeProjectsDocument(els) {
  return {
    getElementById: (id) => els[id],
    createElement(tag) {
      return {
        tag,
        children: [],
        dataset: {},
        className: '',
        textContent: '',
        classList: { toggle() {}, add() {} },
        setAttribute() {},
        appendChild(c) { this.children.push(c); return c; },
        append(...nodes) { this.children.push(...nodes); },
      };
    },
  };
}

test('D1 - state 1: #projects holds exactly one [data-choose] and zero rows', () => {
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  const state = baseEmptyListState({ shared: [] });
  const els = makeProjectsEls();
  const document = makeProjectsDocument(els);
  const renderProjects = makeRenderProjectsIntegration({
    document, state, buildTile: () => makeStubEl(), buildRow: () => makeStubEl(), renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
  });

  renderProjects();

  assert.equal(countByDataset(els.projects, 'choose'), 1, 'the empty project list must have exactly one way out');
  assert.equal(countByDataset(els.projects, 'project'), 0);
});

// At desktop width the nothing-shared
// prompt is also drawn in the wide pane. Only for THAT state - the other empty
// states keep it hidden, and it is rebuilt, not appended to, on every render.
test('D1b - nothing shared fills #pane-empty with its own CHOOSE FOLDERS; every other state hides it', () => {
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  function run(stateOverrides, renders = 1) {
    const state = baseEmptyListState(stateOverrides);
    const els = makeProjectsEls();
    const document = makeProjectsDocument(els);
    const renderProjects = makeRenderProjectsIntegration({
      document, state, buildTile: () => makeStubEl(), buildRow: () => makeStubEl(), renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
    });
    for (let i = 0; i < renders; i += 1) renderProjects();
    return els;
  }
  const nothing = run({ shared: [] }, 2);
  assert.equal(nothing['pane-empty'].hidden, false);
  assert.equal(countByDataset(nothing['pane-empty-body'], 'choose'), 1, 'two renders must not leave two buttons');
  for (const other of [{ shared: null }, { shared: [{ path: 'F:/p', mode: 'container' }] }, { shared: [], reachable: 'waiting' }]) {
    const els = run(other);
    assert.equal(els['pane-empty'].hidden, true, JSON.stringify(other));
    assert.equal(countByDataset(els['pane-empty-body'], 'choose'), 0, JSON.stringify(other));
  }
});

test("D2 - state 4 also renders [data-choose], and its title text differs from state 1's", () => {
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  function run(sharedVal) {
    const state = baseEmptyListState({ shared: sharedVal });
    const els = makeProjectsEls();
    const document = makeProjectsDocument(els);
    const renderProjects = makeRenderProjectsIntegration({
      document, state, buildTile: () => makeStubEl(), buildRow: () => makeStubEl(), renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
    });
    renderProjects();
    return els.projects;
  }
  const state1 = run([]);
  const state4 = run([{
    path: 'F:\\Dev\\Projects\\Workspace', mode: 'container', excludes: [], new_folders: 'show', missing: false,
  }]);

  assert.equal(countByDataset(state1, 'choose'), 1);
  assert.equal(countByDataset(state4, 'choose'), 1);
  const title1 = collectByClass(state1, 'empty-title')[0].textContent;
  const title4 = collectByClass(state4, 'empty-title')[0].textContent;
  assert.notEqual(title1, title4, 'state 1 and state 4 must not render the same words - they are not the same screen');
});

test('D3 - shared: null, 0 projects: #projects holds NO [data-choose]', () => {
  // The real builders, NOT the harness defaults: makeStubEl() carries no
  // dataset, so countByDataset() would read 0 no matter what the code passed
  // and this pin could never fail. It is the only live cover for the rule.
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  const state = baseEmptyListState({ shared: null });
  const els = makeProjectsEls();
  const document = makeProjectsDocument(els);
  const renderProjects = makeRenderProjectsIntegration({
    document, state, buildTile: () => makeStubEl(), buildRow: () => makeStubEl(), renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
  });

  renderProjects();

  assert.equal(countByDataset(els.projects, 'choose'), 0, 'the picker must never be enterable blind - a SAVE from there would wipe every shared folder');
});

test('D4 - one missing root + two live projects: a [data-remove-root] node exists AND both project rows were built', () => {
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  const state = baseEmptyListState({
    projects: [{ name: 'Alpha', path: 'F:\\Dev\\Alpha' }, { name: 'Beta', path: 'F:\\Dev\\Beta' }],
    shared: [{
      path: 'F:\\Gone', mode: 'container', excludes: [], new_folders: 'show', missing: true,
    }],
  });
  const els = makeProjectsEls();
  const document = makeProjectsDocument(els);
  const rowsSeen = [];
  const buildRow = (p) => { rowsSeen.push(p.name); return makeStubEl(); };
  const renderProjects = makeRenderProjectsIntegration({
    document, state, buildTile: () => makeStubEl(), buildRow, renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
  });

  renderProjects();

  assert.deepEqual(rowsSeen.sort(), ['Alpha', 'Beta'], 'a gone root must never blank a list that still has projects');
  const removeNode = findByDataset(els.projects, 'removeRoot');
  assert.ok(removeNode, 'a gone root must render its REMOVE control');
  assert.equal(removeNode.dataset.removeRoot, 'F:\\Gone');
});

test('D5 - reachable:\'waiting\' with shared:[]: the waiting .msg renders and NO [data-choose]', () => {
  // Real builders, same reason as D3 - the [data-choose] half of this test is
  // vacuous against the harness stubs.
  const { buildEmptyState, buildGoneNotice } = makeEmptyGoneBuilders();
  const state = baseEmptyListState({ reachable: 'waiting', shared: [] });
  const els = makeProjectsEls();
  const document = makeProjectsDocument(els);
  const renderProjects = makeRenderProjectsIntegration({
    document, state, buildTile: () => makeStubEl(), buildRow: () => makeStubEl(), renderBackBar: () => {}, buildEmptyState, buildGoneNotice,
  });

  renderProjects();

  // THE claim of this test, unchanged: an unreachable agent must never be
  // reported as "nothing shared yet", which would send the owner into a picker
  // that could wipe a set the PC never reported.
  assert.equal(countByDataset(els.projects, 'choose'), 0, 'the app must never say "nothing shared yet" while the PC is asleep');
  // CHANGED 2026-09-04: it is an empty state with a retry now, not a bare
  // .msg, and the words no longer assert the PC is on its way - the app cannot
  // see that, and with Tailscale up and the phone's radios off it was wrong.
  assert.equal(countByDataset(els.projects, 'retry'), 1, 'and it offers the retry that is already happening');
  const title = collectByClass(els.projects, 'empty-title').map((n) => n.textContent).join(' ');
  const body = collectByClass(els.projects, 'empty-body').map((n) => n.textContent).join(' ');
  assert.match(title, /reach your PC/);
  assert.match(body, /Tailscale/, 'the phone-side cause has to be named, not just the PC');
  assert.match(body, /waking up/, 'and the likeliest cause still leads');
});

// The + menu changed this: nothing-shared used to hide the + (canCreate=false).
// It now offers Share folder alone, and only an unknown set hides it.
test('D6 - renderBackBar gets Share folder alone for nothing-shared, both for empty-day-one, nothing when unknown', () => {
  function canCreateFor(sharedVal) {
    const state = baseEmptyListState({ shared: sharedVal });
    const els = makeProjectsEls();
    const document = makeProjectsDocument(els);
    let seen;
    const renderBackBar = (open, plus) => { seen = plus; };
    const renderProjects = makeRenderProjectsIntegration({
      document,
      state,
      buildTile: () => makeStubEl(),
      buildRow: () => makeStubEl(),
      renderBackBar,
      buildEmptyState: () => makeStubEl(),
      buildGoneNotice: () => makeStubEl(),
    });
    renderProjects();
    return seen;
  }

  assert.deepEqual(canCreateFor([]), ['share'], "'nothing-shared' - Share folder is the way out; New project could only fail");
  assert.deepEqual(canCreateFor([{
    path: 'F:\\Dev\\Projects\\Workspace', mode: 'container', excludes: [], new_folders: 'show', missing: false,
  }]), ['share', 'new'], "'empty-day-one' - a live root exists to create into");
  assert.deepEqual(canCreateFor(null), [], "'unknown-shared' - the picker would open blind, so no +");
});

test('the eyebrow is the dimmest token, clamps to one line, and clears the corner STOP chip', () => {
  const css = read('app.css');
  const rule = css.match(/\.tile-eyebrow\s*\{([^}]*)\}/);
  assert.ok(rule, 'app.css must carry a .tile-eyebrow rule');
  assert.match(rule[0], /var\(--dim\)/);
  assert.match(rule[0], /font-size:\s*8px/);
  assert.match(rule[0], /text-transform:\s*uppercase/);
  assert.match(rule[0], /white-space:\s*nowrap/);
  assert.ok(!/display:/.test(rule[1]), '.tile-eyebrow must set no display, or it could take part in the [hidden] override');

  const group = css.match(/\.tiles\.single \.tile\.has-stop \.tile-name,[\s\S]*?\{[^}]*\}/);
  assert.ok(group, 'app.css must carry the single-tile STOP-chip padding group');
  assert.match(
    group[0],
    /\.tile-eyebrow/,
    'the eyebrow is the topmost line on a single full-width tile and would otherwise sit under a 48px invisible STOP target',
  );
});

// --- the PC is still waking up ----------------------------------------------

// Only network/timeout may enter the waiting state. Every other failure code
// is the agent ANSWERING with a refusal, and retrying a refusal forever is a
// spinner that never resolves.
test('load() waits and retries only on network/timeout, and dead-ends on every other code', () => {
  const js = read('app.js');
  const load = js.slice(js.indexOf('async function load()'), js.indexOf('async function onProjectTap('));
  assert.match(load, /p\.code === 'network' \|\| p\.code === 'timeout'/);
  assert.match(load, /state\.reachable = 'waiting'/);
  assert.match(load, /waitForAgent\(\)/);
  // Three branches since the offline state, and their ORDER is the precedence:
  //   offline  - this device has no network      (beats everything)
  //   waiting  - the PC has not answered yet
  //   else     - the agent answered with a refusal, which waiting cannot fix
  // This used to compare the two `state.reachable =` assignments, but the
  // offline branch also assigns false, so that proxy stopped meaning what it
  // said. Pin the branch conditions instead.
  const iOffline = load.indexOf('} else if (state.offline) {');
  const iWaiting = load.indexOf("} else if (p.code === 'network' || p.code === 'timeout') {");
  const iDead = load.indexOf('setErrorBanner(p.code, p.status)');
  assert.ok(iOffline > 0, 'load() must have an offline branch');
  assert.ok(iWaiting > iOffline, 'offline must be checked before waiting - it blames the right end');
  assert.ok(iDead > iWaiting, 'the waiting branch must be checked before the dead-end branch');
  assert.match(load, /if \(state\.reachable === true\) maybeFailedBanner\(\);/,
    "'waiting' is truthy, so this test pins the explicit comparison");
});

test('waitForAgent is a bounded, visibility-gated retry loop with no timer of its own', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('async function waitForAgent()'), js.indexOf('function hideSplash()'));
  assert.ok(fn, 'app.js must carry waitForAgent');
  assert.match(fn, /document\.visibilityState === 'visible'/, 'it must not retry while the app is in the background');
  assert.match(fn, /await sleep\(/, 'it must reuse the one sleep helper, not add a second setTimeout');
  assert.match(fn, /if \(waiting\) return;/, 're-entry from load() must be a no-op, or the retries multiply');
  assert.match(fn, /await load\(\);/);

  const gaps = js.match(/const WAIT_GAPS_MS = (\[[^\]]*\]);/);
  assert.ok(gaps, 'app.js must declare WAIT_GAPS_MS');
  const values = new Function(`return ${gaps[1]};`)();
  assert.ok(values.length > 0);
  assert.ok(values[0] <= 3000, 'the first retry must be quick - a PC finishing its boot comes back in seconds');
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1], 'the gaps must back off, never shorten');
  }
});

test('the waiting state has its own status line, its own dot and its own empty-state copy', () => {
  const js = read('app.js');
  const conn = js.slice(js.indexOf('function renderConn()'), js.indexOf('function renderProjects('));
  assert.match(conn, /state\.reachable === 'waiting'/);
  // "CANNOT REACH PC", not "WAITING FOR PC". Waiting asserts the PC is coming
  // back, which is a claim about a machine this app cannot see.
  assert.match(conn, /CANNOT REACH PC/);
  assert.doesNotMatch(codeOnly(conn), /WAITING FOR PC/,
    'codeOnly: the comment beside it names the wording it replaced');
  assert.match(conn, /setDot\(dot, 'accent'\)/, 'a dim dot reads as "nothing is happening"; something is');
  assert.ok(
    !/text\.classList\.add\('reachable'\)[\s\S]*?state\.reachable === true/.test(conn),
    'waiting must never claim the reachable class',
  );

  const rp = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  // The two kinds now share ONE screen, because the app cannot honestly tell
  // "this phone has no route" from "that PC is asleep" without asking
  // something other than the agent - and nothing leaves this machine. The
  // ordering property this test was written for is therefore satisfied by
  // construction: neither can win over the other when there is only one
  // branch. listZoneState still pins that both outrank every shared-set state
  // (S1/S2), which is the half that actually protects the owner's folders.
  assert.match(rp, /zone\.kind === 'waiting' \|\| zone\.kind === 'unreachable'/);
  assert.match(rp, /CANNOT_REACH/);
  assert.ok(
    rp.indexOf("zone.kind === 'waiting' || zone.kind === 'unreachable'") > 0,
    'the waiting message must win over "Cannot reach the agent."',
  );
});

// CONFIRM_GAPS_MS is anchored to STARTING_GRACE_MS in agent/registry.js: its
// last check must land PAST the grace window or a launch that really failed
// never gets its banner, because a `failed` entry is not watchable and the
// 5s loop stops without announcing it.
test('the confirm sequence still outlasts STARTING_GRACE_MS', async () => {
  const { STARTING_GRACE_MS } = await import('../registry.js');
  const js = read('app.js');
  const gaps = js.match(/const CONFIRM_GAPS_MS = (\[[^\]]*\]);/);
  assert.ok(gaps, 'app.js must declare CONFIRM_GAPS_MS');
  const total = new Function(`return ${gaps[1]};`)().reduce((a, b) => a + b, 0);
  assert.ok(
    total > STARTING_GRACE_MS,
    `the confirm sequence ends at ${total}ms but the agent cannot say 'failed' until ${STARTING_GRACE_MS}ms`,
  );
});

// The passcode gate is not a screen on the way to the waiting state - it is
// the screen a cold-boot open LANDS on, every time, because the token is
// memory-only and showGate() runs before app.js ever calls load(). A waiting
// state that only exists behind the gate is a waiting state the owner never
// reaches on the one morning it was written for.
test('lock.js retries the status probe by itself, so the gate is not a dead end while the PC boots', () => {
  const js = read('lock.js');
  assert.match(js, /async function waitForAgent\(\)/, 'the gate must have its own retry loop');
  assert.match(js, /res\.code === 'network' \|\| res\.code === 'timeout'/,
    'only silence may be retried - an agent that ANSWERS a refusal must still dead-end');
  assert.match(js, /Waiting for the PC/);
  assert.match(js, /document\.visibilityState === 'visible'/, 'it must not retry in the background');
  assert.match(js, /if \(waiting\) return;/, 're-entry from checkStatus must be a no-op');

  const gaps = js.match(/const WAIT_GAPS_MS = (\[[^\]]*\]);/);
  assert.ok(gaps, 'lock.js must declare WAIT_GAPS_MS');
  const values = new Function(`return ${gaps[1]};`)();
  assert.ok(values[0] <= 3000, 'the first retry must be quick');
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1], 'the gaps must back off, never shorten');
  }
});

// showGate() runs again on onAuthLost, so anything it adds to a node outside
// the gate has to come back off - the same reason the form listeners are
// removed on the way out.
test('lock.js removes its visibilitychange listener when the gate resolves', () => {
  const js = read('lock.js');
  assert.match(js, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(js, /document\.removeEventListener\('visibilitychange', onVisible\)/);
});

// Once respondWith settles from the cache the worker may be terminated, and
// an unheld fetch dies with it - which would make the CACHE bump in install()
// the only way a shell file is ever refreshed.
test('sw.js holds the background revalidation open with event.waitUntil', () => {
  const source = read('sw.js');
  assert.match(source, /event\.waitUntil\(fromNetwork\)/);
  assert.match(source, /event\.respondWith\(staleWhileRevalidate\(req, event\)\)/);
});

// A cache write can reject on its own (storage blocked in a private window,
// quota exhausted). Folding it into the response chain would turn a response
// the network served perfectly well into the handler's 503.
test('sw.js does not fail a good network response because the cache write failed', async () => {
  const listeners = loadServiceWorker({
    fetch: async () => ({ ok: true, status: 200, type: 'basic', clone: () => ({ body: 'copy' }) }),
    cacheMatch: async () => undefined, // nothing cached, so the network answer is the only one
    cacheOpenFails: true,
  });

  let responded;
  listeners.fetch({
    request: { url: 'http://127.0.0.1:8790/app.js', method: 'GET', mode: 'same-origin' },
    respondWith(p) { responded = p; },
    waitUntil() {},
  });

  const res = await responded;
  assert.equal(res.status, 200, 'the served response must survive a failing cache write');
});

// --- the accept screen -----------------------------------------------

test('boot() awaits ensureAccepted() between the unlock and wireEvents(), so the project list cannot show ahead of the warning', () => {
  const js = read('app.js');
  const boot = js.slice(js.indexOf('async function boot()'), js.indexOf('boot().finally'));
  const unlockedIdx = boot.indexOf('await unlocked;');
  // The onAuthLost callback declared earlier in the function ALSO calls
  // ensureAccepted() (see the "hideAccept() is not decoration" test) - search
  // from unlockedIdx so that occurrence is not mistaken for boot()'s own.
  assert.ok(unlockedIdx !== -1, 'boot() must await the gate');
  const ensureIdx = boot.indexOf('await ensureAccepted();', unlockedIdx);
  const wireIdx = boot.indexOf('wireEvents();', unlockedIdx);
  assert.ok(ensureIdx !== -1 && wireIdx !== -1, 'boot() must carry all three markers');
  assert.ok(unlockedIdx < ensureIdx, 'ensureAccepted() must run after the unlock resolves');
  assert.ok(ensureIdx < wireIdx, 'ensureAccepted() must run before wireEvents()');
});

test('ensureAccepted sets picker.hidden = true before its first await', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('async function ensureAccepted()'), js.indexOf('function showAccept()'));
  const hideIdx = fn.indexOf('picker.hidden = true;');
  const awaitIdx = fn.indexOf('await ');
  assert.ok(hideIdx !== -1, 'ensureAccepted must hide the picker');
  assert.ok(awaitIdx !== -1, 'ensureAccepted must await something');
  assert.ok(hideIdx < awaitIdx, 'the picker must be hidden synchronously, before any paint can happen between promise ticks');
});

test('the onAuthLost callback in boot() calls hideAccept() before showGate()', () => {
  const js = read('app.js');
  const match = js.match(/onAuthLost\(async \(\) => \{ ([^}]+) \}\);/);
  assert.ok(match, 'boot() must register an onAuthLost callback');
  const callback = match[1];
  const hideIdx = callback.indexOf('hideAccept();');
  const gateIdx = callback.indexOf('showGate()');
  assert.ok(hideIdx !== -1, 'onAuthLost callback must call hideAccept()');
  assert.ok(gateIdx !== -1, 'onAuthLost callback must call showGate()');
  assert.ok(hideIdx < gateIdx, 'a token expiry on the accept screen must hide it before the gate returns, or two <main>s stack');
});

test('screenAfterUnlock never fails open - anything other than an explicit acknowledged:true shows the accept screen', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function screenAfterUnlock('), js.indexOf('async function ensureAccepted('));
  const body = fn.match(/return ([^;]+);/);
  assert.ok(body, 'app.js must carry screenAfterUnlock');
  const screenAfterUnlock = new Function('res', `return ${body[1]};`);
  assert.equal(screenAfterUnlock({ ok: true, data: { acknowledged: true } }), 'list');
  assert.equal(screenAfterUnlock({ ok: true, data: { acknowledged: false } }), 'accept');
  assert.equal(screenAfterUnlock({ ok: true, data: {} }), 'accept');
  assert.equal(screenAfterUnlock({ ok: false, code: 'network' }), 'accept');
  assert.equal(screenAfterUnlock({ ok: false, code: 'timeout' }), 'accept');
  assert.equal(screenAfterUnlock({ ok: true, data: { acknowledged: 'yes' } }), 'accept');
});

test('the accept path pushes no history entry, and onPopState is unchanged', () => {
  const js = read('app.js');
  const ensureAccepted = js.slice(js.indexOf('async function ensureAccepted()'), js.indexOf('function wireEvents()'));
  assert.ok(!ensureAccepted.includes('history.pushState'), 'the accept screen must push no history entry - there is nowhere to go back to');
  // onPopState's documented ordering invariant (confirm entry always on top of
  // a drill entry) must not gain a third kind of pushed entry to reconcile.
  const onPopState = js.slice(js.indexOf('function onPopState()'), js.indexOf('// A synthetic desk-subfolder tile'));
  assert.match(onPopState, /confirmPushed = false;/);
  assert.match(onPopState, /folderPushed = false;/);
  assert.ok(!onPopState.includes('accept'), 'onPopState must know nothing about the accept screen');
});

// --- the folder picker ------------------------------------------------

test('A4 - in ensureAccepted, showFolders( runs after await showAccept() and before picker.hidden = false', () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('async function ensureAccepted()'), js.indexOf('function wireEvents()'));
  const showAcceptIdx = fn.indexOf('await showAccept()');
  const showFoldersIdx = fn.indexOf('showFolders(');
  const revealIdx = fn.indexOf('picker.hidden = false');
  assert.ok(showAcceptIdx !== -1 && showFoldersIdx !== -1 && revealIdx !== -1, 'ensureAccepted must carry all three markers');
  assert.ok(showAcceptIdx < showFoldersIdx, 'the picker must not run ahead of the accept screen');
  assert.ok(showFoldersIdx < revealIdx, 'the picker must run before the project list is revealed');
});

test('A5 - showFolders adds a popstate listener and the resolve path removes it; onPopState mentions neither folders nor share', () => {
  // Normalised: the working tree can be CRLF even though the committed blob is
  // LF, and a multi-line anchor never matches on CRLF - indexOf returns -1 and
  // slice(start, -1) silently becomes "the rest of the file". Strip CR first
  // and anchor on a single line, the same fix C8 in accept.test.js already uses.
  const js = read('app.js').replace(/\r/g, '');
  const showFolders = js.slice(js.indexOf('function showFolders('), js.indexOf('function screenAfterUnlock('));
  assert.match(showFolders, /window\.addEventListener\('popstate', onFoldersPop\)/);
  const finishFolders = js.slice(js.indexOf('function finishFolders('), js.indexOf('async function onSave('));
  assert.match(finishFolders, /window\.removeEventListener\('popstate', onFoldersPop\)/);
  const onPopState = js.slice(js.indexOf('function onPopState()'), js.indexOf('// A synthetic desk-subfolder tile'));
  assert.ok(!onPopState.includes('folders'), 'onPopState must know nothing about the picker');
  assert.ok(!onPopState.includes('share'), 'onPopState must know nothing about the picker\'s own state');
});

// A minimal DOM stub - createElement/appendChild/dataset for
// buildDriveRow/buildFolderRow (loadRowBuilders), extended below with
// getElementById (one persistent stub per id), addEventListener /
// removeEventListener / listenerCount / fire (same shape lock.test.js's
// makeEl already uses), closest(), innerHTML, hidden/disabled/checked and
// createTextNode - enough for loadPicker() below to run the picker's real
// wiring under a stub DOM and inspect it, not just its row builders.
function makeShareStubEl(tag) {
  const listeners = new Map(); // type -> Set<fn>
  const el = {
    tag,
    className: '',
    dataset: {},
    children: [],
    parent: null,
    hidden: false,
    disabled: false,
    checked: false,
    _text: '',
    appendChild(child) {
      child.parent = el;
      this.children.push(child);
      return child;
    },
    // The passcode panel's openReauth moves #reauth to sit beside whichever buttons it
    // hid, via the real DOM's parentElement/insertBefore - so the stub needs
    // both, not just appendChild.
    get parentElement() { return el.parent || null; },
    insertBefore(newNode, refNode) {
      newNode.parent = el;
      const i = this.children.indexOf(refNode);
      if (i === -1) this.children.push(newNode);
      else this.children.splice(i, 0, newNode);
      return newNode;
    },
    // buildSettingsRow clones an <svg> out of #tpl-row-ico and points its
    // <use> at an icon id. Both happen on the CLONE, so no row assertion
    // anywhere in this file is affected by them.
    cloneNode() { return makeShareStubEl(tag); },
    querySelector() { return el._use || (el._use = makeShareStubEl('use')); },
    setAttribute(k, v) { this[`attr_${k}`] = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this.children = []; },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = v; this.children = []; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    fire(type, ev = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
    // sel is always '[data-xxx]' - the five forms the picker's delegates
    // use. Hand-rolled rather than a regex, so this stub needs no backslash.
    closest(sel) {
      if (sel.charAt(0) !== '[' || sel.slice(-1) !== ']') return null;
      const parts = sel.slice(1, -1).split('-').slice(1); // drop 'data'
      const key = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');
      let node = el;
      while (node) {
        if (node.dataset && node.dataset[key] !== undefined) return node;
        node = node.parent;
      }
      return null;
    },
  };
  return el;
}

function fakeDocument() {
  const registry = new Map(); // id -> element, one persistent stub per id
  // The icon <template> buildSettingsRow clones from. Registered up front so
  // every door/picker harness gets it without needing to know it exists.
  const tpl = makeShareStubEl('template');
  tpl.content = { firstElementChild: makeShareStubEl('svg') };
  registry.set('tpl-row-ico', tpl);
  return {
    createElement: (tag) => makeShareStubEl(tag),
    createTextNode: (text) => { const n = makeShareStubEl('#text'); n.textContent = text; return n; },
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeShareStubEl('div'));
      return registry.get(id);
    },
  };
}

function flatten(el) {
  const out = [el];
  for (const c of el.children) out.push(...flatten(c));
  return out;
}

function loadRowBuilders() {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function joinShare('), js.indexOf('function buildPickedRow('));
  return new Function(
    'document', 'driveRowState', 'coverageOf',
    `${src}; return { buildDriveRow, buildFolderRow };`,
  )(fakeDocument(), folders.driveRowState, folders.coverageOf);
}

function fakeWindow() { return makeShareStubEl('window'); }

function fakeHistory() {
  return {
    state: null,
    pushState(state) { this.state = state; },
    back() {},
    go() {},
  };
}

function flush() { return new Promise((r) => setImmediate(r)); }

function findByDataset(root, key) {
  const stack = [root];
  while (stack.length) {
    const n = stack.shift();
    if (n.dataset && n.dataset[key] !== undefined) return n;
    for (const c of (n.children || [])) stack.push(c);
  }
  return null;
}

function collectByClass(root, cls) {
  const out = [];
  const walk = (n) => {
    if (n.className === cls) out.push(n);
    for (const c of (n.children || [])) walk(c);
  };
  walk(root);
  return out;
}

function hasUndefinedText(root) {
  let found = false;
  const walk = (n) => {
    if (n.textContent === 'undefined') found = true;
    for (const c of (n.children || [])) walk(c);
  };
  walk(root);
  return found;
}

// Any node in the whole subtree currently carrying at least one live
// listener of any type the picker actually registers.
function anyActiveListener(node) {
  if (!node.listenerCount) return false;
  return ['change', 'click', 'popstate'].some((t) => node.listenerCount(t) > 0);
}

function hasListenedAncestor(node) {
  let n = node.parent;
  while (n) {
    if (anyActiveListener(n)) return true;
    n = n.parent;
  }
  return false;
}

// Runs the picker's real wiring under a stub DOM. Everything the block
// touches that is not defined inside it - document, window, history, the
// api calls and the folders-ui imports - is injected, so a mis-wired
// listener or a stale render shows up as behaviour instead of as a
// source-text match.
function loadPicker({ getDrives, getFolders, putShared } = {}) {
  const js = read('app.js').replace(/\r/g, '');
  const src = js.slice(js.indexOf('const share = {'), js.indexOf('function screenAfterUnlock('));
  const doc = fakeDocument();
  const win = fakeWindow();
  const hist = fakeHistory();
  const fn = new Function(
    'document', 'window', 'history',
    'getDrives', 'getFolders', 'putShared',
    'crumbSegments', 'sharedBody', 'coverageOf', 'driveRowState',
    'truncatedNote', 'shareErrorMessage', 'applySaveResult', 'MAX_SHARED_ROOTS',
    'PICKER_SKIP', 'PICKER_CANCEL', 'showScreen',
    `${src}
return { share, showFolders, renderShare, openDrives, openPath, onFoldersPop, onShareListClick, onShareListChange, onSharePickedClick, onSkipClick, finishFolders, toggleTick };`,
  );
  const picker = fn(
    doc, win, hist,
    getDrives || (async () => ({ ok: true, status: 200, data: { drives: [] } })),
    getFolders || (async () => ({ ok: true, status: 200, data: { path: 'F:', parent: null, folders: [], total: 0 } })),
    putShared || (async () => ({ ok: true, status: 200, data: {} })),
    folders.crumbSegments, folders.sharedBody, folders.coverageOf, folders.driveRowState,
    folders.truncatedNote, folders.shareErrorMessage, folders.applySaveResult, folders.MAX_SHARED_ROOTS,
    copy.PICKER_SKIP, copy.PICKER_CANCEL,
    () => {}, // showFolders' router call - this helper only exercises the picker's own wiring
  );
  picker.document = doc;
  picker.window = win;
  picker.history = hist;
  return picker;
}

// --- the shared-folders door ------------------------------------------

// Two slices of app.js, concatenated - function declarations hoist across
// the whole `new Function` body, so order does not matter. The second slice
// is exactly loadPicker's own slice (it already carries showFolders,
// finishFolders, onSave, closeSettings, openPickerFromShared, renderSettings
// and buildSettingsRow); the first adds onChooseFolders, the ONLY way in for
// either door.
// The Settings door is now two screens: the row opens the Shared
// folders screen, and ADD A FOLDER there is what reaches the picker. That
// button's handler is openPickerFromShared, so it is the door these tests
// drive - every assertion below is about what the picker does once opened,
// which is unchanged. openSettings (inside the second slice) references
// cancelOpenConfirm, which is NOT injected - no test here calls it.
function loadDoor({
  getDrives, getFolders, putShared, load,
} = {}) {
  const js = read('app.js').replace(/\r/g, '');
  const onChooseSrc = js.slice(
    js.indexOf('async function onChooseFolders('),
    js.indexOf('// Guarded against a double tap the same way onSave is'),
  );
  const pickerSrc = js.slice(js.indexOf('const share = {'), js.indexOf('function screenAfterUnlock('));
  const doc = fakeDocument();
  const win = fakeWindow();
  const hist = fakeHistory();
  const state = { shared: null };
  const screens = [];
  const showScreenSpy = (name) => { screens.push(name); };
  const puts = [];
  async function putSharedSpy(body) {
    puts.push(body);
    return (putShared || (async () => ({ ok: true, status: 200, data: {} })))(body);
  }
  let loadCalls = 0;
  async function loadSpy() {
    loadCalls += 1;
    if (load) await load();
  }
  const render = () => {};

  // .share-actions, per the real markup: openReauth needs SAVE and SKIP to
  // share a real parent so it can insertBefore(reauth, save) the way the
  // browser does.
  const shareActions = doc.createElement('div');
  shareActions.appendChild(doc.getElementById('share-skip'));
  shareActions.appendChild(doc.getElementById('share-save'));

  const fn = new Function(
    'document', 'window', 'history',
    'getDrives', 'getFolders', 'putShared',
    'crumbSegments', 'sharedBody', 'coverageOf', 'driveRowState',
    'truncatedNote', 'shareErrorMessage', 'applySaveResult', 'MAX_SHARED_ROOTS',
    'sharedToTicks', 'sharedRowState',
    'PICKER_SKIP', 'PICKER_CANCEL', 'showScreen',
    'SHELL_VERSION', 'agentStateLine', 'aboutRowState', 'notifyRowState',
    'reauthLine', 'REAUTH_WRONG', 'reauthOutcome', 'setPinRevealed', 'messageFor', 'setMsg', 'sleep', 'SAVE',
    'state', 'render', 'load',
    `${onChooseSrc}
${pickerSrc}
return { share, showFolders, renderShare, openDrives, openPath, onFoldersPop, onShareListChange, onShareListClick, onSharePickedClick, onSkipClick, onSave, finishFolders, toggleTick, onChooseFolders, openPickerFromShared, closeSettings, renderSettings, buildSettingsRow };`,
  );

  const door = fn(
    doc, win, hist,
    getDrives || (async () => ({ ok: true, status: 200, data: { drives: [] } })),
    getFolders || (async () => ({ ok: true, status: 200, data: { path: 'F:', parent: null, folders: [], total: 0 } })),
    putSharedSpy,
    folders.crumbSegments, folders.sharedBody, folders.coverageOf, folders.driveRowState,
    folders.truncatedNote, folders.shareErrorMessage, folders.applySaveResult, folders.MAX_SHARED_ROOTS,
    folders.sharedToTicks, folders.sharedRowState,
    copy.PICKER_SKIP, copy.PICKER_CANCEL, showScreenSpy,
    // settingsGroups reads both: the About row's sub-line is the shell
    // version, and the Agent status row's is the connection state.
    '0.1.0', (r) => (r === true ? 'reachable' : 'checking'), update.aboutRowState, pushUi.notifyRowState,
    folders.reauthLine, folders.REAUTH_WRONG, folders.reauthOutcome,
    () => {}, () => '', setMsg, () => Promise.resolve(), pushUi.SAVE,
    state, render, loadSpy,
  );
  door.document = doc;
  door.window = win;
  door.history = hist;
  door.state = state;
  door.screens = screens;
  door.puts = puts;
  // SAVE from this door always opens the panel (share.firstRun is
  // false here, as it is for the real Settings door) - types the passcode
  // into it and submits.
  door.submitReauth = async (passcode) => {
    doc.getElementById('reauth-pin').value = passcode;
    doc.getElementById('reauth-action').fire('click');
    await flush();
  };
  Object.defineProperty(door, 'loadCalls', { get: () => loadCalls });
  return door;
}

test('A6 - buildDriveRow: a blocked drive carries no data-open, no data-tick and no <button>', () => {
  const { buildDriveRow } = loadRowBuilders();
  const row = buildDriveRow({
    letter: 'C:', label: 'OS', blocked: true, reason: 'system',
  }, []);
  assert.match(row.className, /share-off/);
  const nodes = flatten(row);
  assert.ok(!nodes.some((n) => n.tag === 'button'), 'a blocked drive must carry no <button>');
  assert.ok(!nodes.some((n) => n.tag === 'input'), 'a blocked drive must carry no <input>');
  assert.ok(!nodes.some((n) => n.dataset.open !== undefined), 'a blocked drive must carry no data-open');
  assert.ok(!nodes.some((n) => n.dataset.tick !== undefined), 'a blocked drive must carry no data-tick');
});

test('A7 - buildFolderRow: readable:false carries no data-open, no data-tick, and the honest status', () => {
  const { buildFolderRow } = loadRowBuilders();
  const row = buildFolderRow({ name: 'Locked', readable: false }, 'F:\\Dev', []);
  assert.match(row.className, /share-off/);
  const nodes = flatten(row);
  assert.ok(!nodes.some((n) => n.tag === 'button'), 'an unreadable folder must carry no <button>');
  assert.ok(!nodes.some((n) => n.tag === 'input'), 'an unreadable folder must carry no <input>');
  assert.ok(!nodes.some((n) => n.dataset.open !== undefined));
  assert.ok(!nodes.some((n) => n.dataset.tick !== undefined));
  const status = nodes.find((n) => n.className === 'row-status');
  assert.equal(status.textContent, 'no permission to open this folder');
});

test('A8 - buildFolderRow: a covered row disables the checkbox, keeps the name, and says why', () => {
  const { buildFolderRow } = loadRowBuilders();
  const ticks = [{ path: 'F:\\Dev', name: 'Dev' }];
  const row = buildFolderRow({ name: 'Projects', readable: true }, 'F:\\Dev', ticks);
  const nodes = flatten(row);
  const input = nodes.find((n) => n.tag === 'input');
  assert.ok(input, 'a coverable row must still carry its checkbox');
  assert.equal(input.disabled, true);
  const name = nodes.find((n) => n.className === 'row-name');
  assert.equal(name.textContent, 'Projects', 'the name must be unchanged');
  const status = nodes.find((n) => n.className === 'row-status');
  assert.ok(status && status.textContent.includes('Dev'), 'the status must say which root already covers it');
});

test('A9 - the onAuthLost callback calls hideFolders() before showGate()', () => {
  const js = read('app.js');
  const match = js.match(/onAuthLost\(async \(\) => \{ ([^}]+) \}\);/);
  assert.ok(match, 'boot() must register an onAuthLost callback');
  const callback = match[1];
  const hideIdx = callback.indexOf('hideFolders();');
  const gateIdx = callback.indexOf('showGate()');
  assert.ok(hideIdx !== -1, 'onAuthLost callback must call hideFolders()');
  assert.ok(gateIdx !== -1, 'onAuthLost callback must call showGate()');
  assert.ok(hideIdx < gateIdx, 'a token expiry mid-picker must hide it before the gate returns, or two <main>s stack');
});

test('A10 - every control the picker builds sits under a node the picker listens on', async () => {
  let drivesOk = true;
  const getDrives = async () => (drivesOk
    ? { ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }, { letter: 'Z:', label: 'Z:', blocked: true, reason: 'system' }] } }
    : { ok: false, status: 503, code: 'drives_unavailable', data: {} });
  const getFolders = async () => ({ ok: true, status: 200, data: { path: 'F:/Dev', parent: 'F:', folders: [{ name: 'Alpha', readable: true }], total: 1 } });
  const putShared = async () => ({ ok: true, status: 200, data: {} });
  const picker = loadPicker({ getDrives, getFolders, putShared });

  const roots = () => ['share-up', 'share-msg', 'share-picked-zone', 'share-picked', 'share-hide-note', 'share-list', 'share-save']
    .map((id) => picker.document.getElementById(id));

  function assertAllControlsListened() {
    for (const root of roots()) {
      const stack = [root];
      while (stack.length) {
        const n = stack.pop();
        if (n.dataset && Object.keys(n.dataset).length > 0) {
          assert.ok(hasListenedAncestor(n), `a control with dataset ${JSON.stringify(n.dataset)} has no listened ancestor`);
        }
        for (const c of (n.children || [])) stack.push(c);
      }
    }
  }

  // State 1: drives listed.
  picker.showFolders([]);
  await flush();
  assertAllControlsListened();

  // State 2: drives failed with retry.
  drivesOk = false;
  picker.openDrives();
  await flush();
  assert.ok(picker.share.error && picker.share.error.retry);
  assertAllControlsListened();

  // State 3: a folder listing.
  drivesOk = true;
  picker.openPath('F:/Dev', { push: false });
  await flush();
  assertAllControlsListened();

  // State 4: ticks present with errorIndex set.
  picker.share.ticks = [{ path: 'F:/Dev/Alpha', name: 'Alpha', newFolders: 'show' }];
  picker.share.errorIndex = 0;
  picker.renderShare();
  assertAllControlsListened();
});

test('A11 - tapping RETRY re-issues the failed request', async () => {
  let calls = 0;
  const getDrives = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, code: 'drives_unavailable', data: {} };
    return { ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }] } };
  };
  const picker = loadPicker({ getDrives });
  picker.showFolders([]);
  await flush();
  assert.equal(calls, 1);
  assert.ok(picker.share.error && picker.share.error.retry);

  const list = picker.document.getElementById('share-list');
  const retryNode = findByDataset(list, 'shareRetry');
  assert.ok(retryNode, 'RETRY control must exist in #share-list');

  picker.onShareListClick({ target: retryNode });
  await flush();

  assert.equal(calls, 2, 'RETRY must re-issue getDrives');
  assert.equal(picker.share.error, null);
  assert.equal(picker.share.rows.length, 1);
});

test('A12 - a pop from the first drill level renders zero rows until the drives answer', async () => {
  let drivesCall = 0;
  let resolveSecond;
  const getDrives = async () => {
    drivesCall += 1;
    if (drivesCall === 1) return { ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }] } };
    return new Promise((resolve) => { resolveSecond = resolve; });
  };
  const getFolders = async () => ({ ok: true, status: 200, data: { path: 'F:', parent: null, folders: [{ name: 'Alpha', readable: true }], total: 1 } });
  const picker = loadPicker({ getDrives, getFolders });

  picker.showFolders([]);
  await flush();

  picker.openPath('F:', { push: true });
  await flush();
  assert.ok(picker.share.rows.length > 0, 'sanity: the folder listing has rows before the pop');

  picker.history.state = null; // Android back lands on no {folders} entry -> the drive list
  picker.onFoldersPop();

  const list = picker.document.getElementById('share-list');
  assert.equal(findByDataset(list, 'tick'), null, '#share-list must hold no [data-tick] node while loading');
  assert.equal(findByDataset(list, 'open'), null, '#share-list must hold no [data-open] node while loading');
  const msgNodes = collectByClass(list, 'msg');
  assert.equal(msgNodes.length, 1);
  assert.equal(msgNodes[0].textContent, 'Reading the drives on the PC.');
  assert.equal(hasUndefinedText(list), false, 'no node text content may be the literal "undefined"');

  resolveSecond({ ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }] } });
  await flush();
});

test('A13 - an older response cannot repaint a newer level', async () => {
  let resolveA;
  const getFolders = async () => new Promise((resolve) => { resolveA = resolve; });
  const getDrives = async () => ({ ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }] } });
  const picker = loadPicker({ getDrives, getFolders });
  picker.showFolders([]);
  await flush();

  picker.openPath('F:/Dev', { push: true }); // deferred - never resolved until after openDrives below
  await flush();
  await picker.openDrives();
  await flush();

  assert.equal(picker.share.path, null, 'the drive list must be showing');

  resolveA({ ok: true, status: 200, data: { path: 'F:/Dev', parent: 'F:', folders: [{ name: 'X', readable: true }], total: 1 } });
  await flush();

  assert.equal(picker.share.path, null, 'an older openPath response must not repaint over the newer drive list');
});

test('A14 - a second showFolders while one is pending re-reveals the screen, adds no second listener, and keeps the ticks', async () => {
  let drivesCalls = 0;
  const getDrives = async () => {
    drivesCalls += 1;
    return { ok: true, status: 200, data: { drives: [{ letter: 'C:', label: 'C:', blocked: false }] } };
  };
  const picker = loadPicker({ getDrives });

  const p1 = picker.showFolders([]);
  await flush();
  assert.equal(drivesCalls, 1);

  picker.share.ticks = [{ path: 'F:/Dev', name: 'Dev', newFolders: 'show' }];

  const list = picker.document.getElementById('share-list');
  const before = list.listenerCount('change') + list.listenerCount('click');

  picker.document.getElementById('folders').hidden = true; // what hideFolders() does

  const p2 = picker.showFolders(picker.share.ticks);

  assert.equal(picker.document.getElementById('folders').hidden, false, 'the screen must be revealed again');
  assert.equal(list.listenerCount('change') + list.listenerCount('click'), before, 'no second listener set may stack');
  assert.deepEqual(picker.share.ticks, [{ path: 'F:/Dev', name: 'Dev', newFolders: 'show' }], 'the ticks must survive');
  assert.equal(p1, p2, 'the same promise must come back');

  await flush();
  assert.equal(drivesCalls, 2, 'the current level must be re-fetched on re-entry');
});

test('A15 - ensureAccepted re-opens a pending picker, and refuses to open one blind', () => {
  // REWRITTEN 2026-09-05, review pass 7. This used to pin the LITERAL source
  // string `if (firstRun || pendingFolders) await showFolders(` and call it
  // "exactly this shape" - which pinned the BUG. screenAfterUnlock returns
  // 'accept' for any non-401 failure, so after one slow reply a returning owner
  // with N roots got the first-run warning and a picker reporting 0 selected;
  // ticking one root and saving REPLACED the whole set. The test could not have
  // caught that, because it asserted the presence of the line that caused it.
  //
  // Now asserts the three things that must be TRUE, on comment-stripped source:
  // the gate runs first, a pending run still re-opens, and the picker is gated
  // on the shared set being known.
  const js = codeOnly(read('app.js').replace(/\r/g, ''));
  const fn = js.slice(js.indexOf('async function ensureAccepted()'), js.indexOf('function wireEvents()'));

  const gateLine = "if (screenAfterUnlock(res) === 'accept') await showAccept();";
  assert.ok(fn.includes(gateLine), 'the acknowledgement gate line must still be present verbatim');

  const openIdx = fn.search(/await showFolders\(/);
  assert.notEqual(openIdx, -1, 'ensureAccepted must still be able to open the picker');
  assert.ok(fn.indexOf(gateLine) < openIdx, 'the gate must still come before the picker opens');

  assert.match(fn, /pendingFolders/, 'a run already in flight must still be re-opened, or its awaiter hangs');
  assert.match(
    fn,
    /Array\.isArray\(state\.shared\)/,
    'the picker must open ONLY when the shared set is known - opening blind replaces the owner\'s roots',
  );
});

test('A16 - finishFolders removes all six listeners and nulls pendingFolders', async () => {
  const getDrives = async () => ({ ok: true, status: 200, data: { drives: [] } });
  const putShared = async () => ({ ok: true, status: 200, data: {} });
  const picker = loadPicker({ getDrives, putShared });

  // firstRun: true - this test is about finishFolders' own teardown, not
  // about the passcode panel; the first-run picker still writes directly.
  picker.showFolders([], { firstRun: true });
  await flush();
  picker.share.ticks = [{ path: 'F:/Dev', name: 'Dev', newFolders: 'show' }];

  const list = picker.document.getElementById('share-list');
  const picked = picker.document.getElementById('share-picked');
  const up = picker.document.getElementById('share-up');
  const save = picker.document.getElementById('share-save');
  const win = picker.window;

  assert.equal(list.listenerCount('change'), 1);
  assert.equal(list.listenerCount('click'), 1);
  assert.equal(picked.listenerCount('click'), 1);
  assert.equal(up.listenerCount('click'), 1);
  assert.equal(save.listenerCount('click'), 1);
  assert.equal(win.listenerCount('popstate'), 1);

  save.fire('click');
  await flush();

  assert.equal(list.listenerCount('change'), 0);
  assert.equal(list.listenerCount('click'), 0);
  assert.equal(picked.listenerCount('click'), 0);
  assert.equal(up.listenerCount('click'), 0);
  assert.equal(save.listenerCount('click'), 0);
  assert.equal(win.listenerCount('popstate'), 0);
  assert.equal(picker.document.getElementById('folders').hidden, true);

  picker.showFolders([]);
  await flush();
  assert.equal(list.listenerCount('click'), 1, 'a fresh showFolders after teardown must wire a fresh set - pendingFolders really is null');
});

test('A17 - an enterable drive row is disabled, not removed; a blocked drive still routes to buildInertRow', () => {
  const { buildDriveRow } = loadRowBuilders();
  const row = buildDriveRow({ letter: 'F:', label: 'Data', blocked: false }, []);
  assert.doesNotMatch(row.className, /share-off/);
  const nodes = flatten(row);
  const openBtn = nodes.find((n) => n.dataset && n.dataset.open !== undefined);
  assert.ok(openBtn, 'an enterable drive row must still carry data-open');
  const input = nodes.find((n) => n.tag === 'input');
  assert.ok(input, 'an enterable drive row must still carry its checkbox');
  assert.equal(input.disabled, true, 'a drive root must never be tickable - PUT rejects it with 400 drive_root');
  const status = nodes.find((n) => n.className === 'row-status');
  assert.equal(status.textContent, 'F: - pick a folder inside it');

  const blockedRow = buildDriveRow({ letter: 'Z:', label: 'System', blocked: true, reason: 'system' }, []);
  assert.match(blockedRow.className, /share-off/);
  assert.ok(!flatten(blockedRow).some((n) => n.tag === 'input'), 'a blocked drive must still carry no input (A6 unaffected)');
});

test('D7 - picker: #share-skip gains a click listener on showFolders; firing it resolves, putShared is never called, #folders is hidden, and the listener is gone', async () => {
  let putCalls = 0;
  const putShared = async () => { putCalls += 1; return { ok: true, status: 200, data: { shared_folders: [] } }; };
  const picker = loadPicker({ putShared });
  const skip = picker.document.getElementById('share-skip');
  assert.equal(skip.listenerCount('click'), 0);

  const p = picker.showFolders([]);
  await flush();
  assert.equal(skip.listenerCount('click'), 1);

  skip.fire('click');
  await p;

  assert.equal(putCalls, 0, 'SKIP must never call putShared');
  assert.equal(picker.document.getElementById('folders').hidden, true);
  assert.equal(skip.listenerCount('click'), 0, 'the listener must be torn down with the others');
});

test('D8 - the cap note sits above the first row, not below it', async () => {
  const getFolders = async () => ({
    ok: true,
    status: 200,
    data: {
      path: 'F:/Dev', parent: 'F:', folders: [{ name: 'A', readable: true }, { name: 'B', readable: true }, { name: 'C', readable: true }], total: 600,
    },
  });
  const picker = loadPicker({ getFolders });
  picker.showFolders([]);
  await flush();
  picker.openPath('F:/Dev', { push: false });
  await flush();

  const list = picker.document.getElementById('share-list');
  const noteIdx = list.children.findIndex((c) => c.className === 'share-note');
  const firstOpenIdx = list.children.findIndex((c) => findByDataset(c, 'open'));
  assert.ok(noteIdx !== -1, 'the cap note must render');
  assert.ok(firstOpenIdx !== -1, 'a row must render');
  assert.ok(noteIdx < firstOpenIdx, 'the cap note must sit above the first row, not below 500 of them');
});

test('D9 - showFolders(initial) opens with the roots already picked, no ticking needed', async () => {
  const picker = loadPicker({});
  picker.showFolders([{ path: 'F:\\Dev\\Projects\\Workspace', name: 'Workspace', newFolders: 'show' }]);
  await flush();
  assert.equal(picker.document.getElementById('share-picked-count').textContent, '1');
  assert.equal(picker.document.getElementById('share-save').disabled, false);
});

test('D10 - the SKIP/CANCEL label depends on whether anything is already shared', async () => {
  const picker1 = loadPicker({});
  picker1.showFolders([]);
  await flush();
  assert.equal(picker1.document.getElementById('share-skip').textContent, copy.PICKER_SKIP);

  const picker2 = loadPicker({});
  picker2.showFolders([{ path: 'F:\\Dev', name: 'Dev', newFolders: 'show' }]);
  await flush();
  assert.equal(picker2.document.getElementById('share-skip').textContent, copy.PICKER_CANCEL);
});

// --- The shared folders door - pins the composite path end to end ----------

test("F1 - the Settings row leads to the Shared folders screen, and one place reaches the picker from it", () => {
  // RED WHEN: the row renders with a chevron and answers a tap with nothing -
  // the dead control the whole enterable/inert split exists to prevent.
  // 'shared' used to be an ACTION that jumped straight into the picker; the Shared folders screen
  // makes it a screen, so what this pins is that it is a real destination and
  // that exactly one control still reaches the picker from there.
  const js = read('app.js').replace(/\r/g, '');
  const declStart = js.indexOf('const SETTINGS_SUBS');
  const decl = js.slice(declStart, js.indexOf(';', declStart));
  assert.match(decl, /'shared'/, "'shared' must be a settings sub-screen, not a dead id");

  const marker = 'const id = row.dataset.settings;';
  const start = js.indexOf(marker);
  assert.ok(start !== -1, 'wireEvents must delegate settings-row clicks');
  const body = js.slice(start, js.indexOf('});', start));
  assert.ok(
    !/openSharedFolders\(\)/.test(body),
    'the row must not jump straight into the picker any more - that is what the Shared folders screen replaced',
  );

  const callSites = [...js.matchAll(/openPickerFromShared\b/g)].filter((m) => {
    const before = js.slice(Math.max(0, m.index - 9), m.index);
    return before !== 'function ';
  });
  assert.equal(callSites.length, 1, 'exactly one control may reach the picker from Shared folders');
});

test('F2 - re-entry seeds the ticks, so the Settings door never opens blank', async () => {
  // RED WHEN: the Settings door opens the picker EMPTY - the owner sees none
  // of his folders, and one tap on SAVE writes {shared_folders:[]} and wipes
  // them all with no error.
  const door = loadDoor({});
  door.state.shared = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: ['Archive'], new_folders: 'show',
  }];

  door.openPickerFromShared();
  await flush();

  assert.equal(door.document.getElementById('folders').hidden, false);
  assert.deepEqual(door.screens, ['list', 'folders']);
  assert.deepEqual(door.share.ticks, [{
    path: 'F:\\Dev\\Projects', name: 'Projects', newFolders: 'show', mode: 'container', excludes: ['Archive'],
  }]);
  assert.equal(door.document.getElementById('share-picked-count').textContent, '1');
  const picked = door.document.getElementById('share-picked');
  const statuses = collectByClass(picked, 'row-status');
  assert.ok(statuses.some((s) => s.textContent === 'F:\\Dev\\Projects'), 'a .row-status under #share-picked must hold the full path');
  assert.equal(door.document.getElementById('share-skip').textContent, copy.PICKER_CANCEL);
  assert.equal(door.document.getElementById('share-save').disabled, false);
});

test('F3 - an unknown shared set cannot enter the picker from the Settings door', () => {
  // RED WHEN: either guard layer is bypassed by the second door. This is the
  // merge gate, as the list-state review set it.
  const door = loadDoor({});
  door.state.shared = null;

  door.renderSettings();
  // Named explicitly. findByDataset returns the FIRST tappable row in the
  // tree, and since the Settings root landed that is 'What this app can see' - a row
  // that SHOULD be enterable. Asserting "no tappable row at all" would now be
  // asserting the settings screen is broken, which is not this test's claim:
  // the claim is that the SHARED row specifically refuses to open the picker
  // when the agent has not said what is shared.
  const rows = [];
  (function walk(n) {
    if (n.dataset && n.dataset.settings !== undefined) rows.push(n.dataset.settings);
    for (const c of (n.children || [])) walk(c);
  }(door.document.getElementById('settings-list')));
  assert.ok(!rows.includes('shared'), 'no row may carry data-settings="shared" when the set is unknown');
  assert.ok(rows.length > 0, 'the rest of the settings root must still render');

  // #folders ships with the `hidden` attribute in index.html; the stub
  // element defaults to unhidden, so set it explicitly to model that.
  door.document.getElementById('folders').hidden = true;
  door.openPickerFromShared();
  assert.equal(door.document.getElementById('folders').hidden, true);
  assert.deepEqual(door.share.ticks, []);
  assert.equal(door.puts.length, 0);
});

test('F4 - SAVE writes the right PUT body, and the list reload runs only after the PUT resolves', async () => {
  // RED WHEN: the body rewrites a `single` root as `container` or drops
  // excludes; or the app never reloads and the list keeps showing the old
  // root's children.
  const getFolders = async (p) => (p === 'F:\\Dev\\Projects'
    ? { ok: true, status: 200, data: { path: 'F:\\Dev\\Projects', parent: 'F:\\Dev', folders: [{ name: 'Workspace', readable: true }], total: 1 } }
    : { ok: true, status: 200, data: { path: p, parent: null, folders: [], total: 0 } });
  let resolvePut;
  const putShared = () => new Promise((resolve) => { resolvePut = () => resolve({ ok: true, status: 200, data: {} }); });
  const door = loadDoor({ getFolders, putShared });
  door.state.shared = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: [], new_folders: 'show',
  }];

  door.openPickerFromShared();
  await flush();

  await door.openPath('F:\\Dev\\Projects', { push: true });

  const untick = findByDataset(door.document.getElementById('share-picked'), 'untick');
  assert.ok(untick, 'the SELECTED row must carry the x control');
  door.onSharePickedClick({ target: untick });

  const tick = findByDataset(door.document.getElementById('share-list'), 'tick');
  assert.ok(tick, 'the folder listing must carry Workspace\'s checkbox');
  tick.checked = true;
  door.onShareListChange({ target: tick });

  // SAVE from this door opens the passcode panel first - nothing is
  // written until it is submitted.
  door.document.getElementById('share-save').fire('click');
  await flush();
  assert.equal(door.puts.length, 0, 'no PUT before the passcode is submitted');

  await door.submitReauth('481902');

  assert.deepEqual(door.puts.at(-1), {
    passcode: '481902',
    shared_folders: [{
      path: 'F:\\Dev\\Projects\\Workspace', mode: 'container', excludes: [], new_folders: 'show',
    }],
  });
  assert.equal(door.loadCalls, 0, 'the reload must not run before the PUT resolves');

  resolvePut();
  await flush();
  await flush();

  assert.equal(door.document.getElementById('folders').hidden, true);
  assert.equal(door.screens.at(-1), 'list');
  assert.equal(door.loadCalls, 1, 'the reload must run exactly once, after the PUT resolved');
});

test('F5 - CANCEL changes nothing: no write, state.shared untouched, the list is still reloaded', async () => {
  // RED WHEN: a cancel path grows a write, or the picker leaves the app on a
  // hidden screen with no <main> revealed.
  const sharedBefore = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: [], new_folders: 'show',
  }];
  const door = loadDoor({});
  door.state.shared = sharedBefore;

  door.openPickerFromShared();
  await flush();

  door.document.getElementById('share-skip').fire('click');
  await flush();
  await flush();

  assert.equal(door.puts.length, 0, 'CANCEL must never call putShared');
  assert.equal(door.state.shared, sharedBefore, 'the same object, unmutated - the agent still decides');
  assert.equal(door.document.getElementById('folders').hidden, true);
  assert.equal(door.screens.at(-1), 'list');
  assert.equal(door.loadCalls, 1);
});

test('F6 - Settings\' queued pop lands under the fresh picker: one redundant GET, nothing lost', async () => {
  // RED WHEN: the pop eats a level, drives share.pushed negative, or clears
  // the seeded ticks - after which a SAVE writes an empty set.
  let drivesCalls = 0;
  const getDrives = async () => {
    drivesCalls += 1;
    return { ok: true, status: 200, data: { drives: [] } };
  };
  const door = loadDoor({ getDrives });
  door.state.shared = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: [], new_folders: 'show',
  }];

  door.openPickerFromShared();
  await flush();
  assert.equal(drivesCalls, 1);

  door.history.state = null;
  door.onFoldersPop();
  await flush();

  assert.equal(door.share.pushed, 0, 'must never go negative');
  assert.deepEqual(door.share.ticks, [{
    path: 'F:\\Dev\\Projects', name: 'Projects', newFolders: 'show', mode: 'container', excludes: [],
  }]);
  assert.equal(door.share.path, null);
  assert.equal(drivesCalls, 2, 'exactly one redundant GET, nothing more');
});

test('F7 - a gone root re-entered: a rejected SAVE marks the row and keeps everything picked', async () => {
  // RED WHEN: a rejected SAVE clears the tick set (losing everything he
  // picked) or fails silently with no row marked.
  const putShared = async () => ({
    ok: false, status: 400, code: 'not_found', data: { index: 0 },
  });
  const door = loadDoor({ putShared });
  door.state.shared = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: [], new_folders: 'show',
  }];

  door.openPickerFromShared();
  await flush();

  door.document.getElementById('share-save').fire('click');
  await flush();
  await door.submitReauth('481902');
  await flush();

  assert.equal(door.document.getElementById('folders').hidden, false, 'the picker must stay open on a rejected SAVE');
  assert.deepEqual(door.share.ticks, [{
    path: 'F:\\Dev\\Projects', name: 'Projects', newFolders: 'show', mode: 'container', excludes: [],
  }]);
  assert.equal(door.share.errorIndex, 0);
  const picked = door.document.getElementById('share-picked');
  const badRow = picked.children.find((c) => c.className.includes('share-bad'));
  assert.ok(badRow, 'the picked row must carry share-bad');
  assert.match(door.document.getElementById('share-msg').textContent, /Projects/);
});

test('F8 - the owner\'s exact failure, end to end: wrong root shared, fixed from Settings, list proves it', async () => {
  // RED WHEN: he picks the wrong folder, and the only fix is someone editing
  // config.json by hand. This test is the feature.
  const getDrives = async () => ({ ok: true, status: 200, data: { drives: [{ letter: 'F:', label: 'Data', blocked: false }] } });
  const getFolders = async (p) => {
    if (p === 'F:\\') return { ok: true, status: 200, data: { path: 'F:\\', parent: null, folders: [{ name: 'Dev', readable: true }], total: 1 } };
    if (p === 'F:\\Dev') return { ok: true, status: 200, data: { path: 'F:\\Dev', parent: 'F:\\', folders: [{ name: 'Projects', readable: true }], total: 1 } };
    if (p === 'F:\\Dev\\Projects') return { ok: true, status: 200, data: { path: 'F:\\Dev\\Projects', parent: 'F:\\Dev', folders: [{ name: 'Workspace', readable: true }], total: 1 } };
    return { ok: true, status: 200, data: { path: p, parent: null, folders: [], total: 0 } };
  };
  const putShared = async () => ({ ok: true, status: 200, data: {} });
  const workspaceChildren = [
    { name: 'Vercel', path: 'F:\\Dev\\Projects\\Workspace\\Vercel' },
    { name: 'Beacon', path: 'F:\\Dev\\Projects\\Workspace\\Beacon' },
  ];
  let projectsFromAgent = null;
  const door = loadDoor({
    getDrives,
    getFolders,
    putShared,
    load: async () => { projectsFromAgent = workspaceChildren; },
  });
  door.state.shared = [{
    path: 'F:\\Dev\\Projects', mode: 'container', excludes: [], new_folders: 'show',
  }];

  door.openPickerFromShared(); // Settings row -> the picker, seeded with F:\Dev\Projects
  await flush();

  door.toggleTick('F:\\Dev\\Projects', false); // untick the wrong root

  await door.openPath('F:\\', { push: true });
  await door.openPath('F:\\Dev', { push: true });
  await door.openPath('F:\\Dev\\Projects', { push: true });
  door.toggleTick('F:\\Dev\\Projects\\Workspace', true); // tick the right one

  door.document.getElementById('share-save').fire('click');
  await flush();
  await door.submitReauth('481902');
  await flush();

  assert.deepEqual(door.puts.at(-1), {
    passcode: '481902',
    shared_folders: [{
      path: 'F:\\Dev\\Projects\\Workspace', mode: 'container', excludes: [], new_folders: 'show',
    }],
  }, 'the PUT body must name only Workspace');
  assert.equal(door.loadCalls, 1);
  assert.ok(projectsFromAgent, 'load must have run and fetched the new root\'s children');

  const rowsSeen = [];
  const els = {
    tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl(),
    'all-header': makeStubEl(), 'all-rule': makeStubEl(), 'all-label': makeStubEl(), 'zone-run': makeStubEl(), 'pane-empty': makeStubEl(), 'pane-empty-body': makeStubEl(),
  };
  const projDocument = {
    getElementById: (id) => els[id],
    // renderProjects builds the "nothing running" tile placeholder directly
    // with document.createElement when no session is running - loadPicker's
    // fakeDocument is not reused here since this is a different function's
    // stub document, scoped to just what renderProjects touches.
    createElement: () => {
      const el = { className: '', textContent: '', children: [] };
      el.append = (...kids) => { el.children.push(...kids); };
      el.appendChild = (c) => { el.children.push(c); return c; };
      return el;
    },
  };
  const projState = {
    projects: projectsFromAgent,
    openFolder: null,
    sessions: [],
    launching: new Set(),
    stopping: new Set(),
    results: new Map(),
    confirmName: null,
    focusName: null,
  };
  const renderProjects = makeRenderProjectsIntegration({
    document: projDocument,
    state: projState,
    buildTile: () => ({ tag: 'TILE' }),
    buildRow: (p) => { rowsSeen.push(p.name); return { tag: 'ROW' }; },
    renderBackBar: () => {},
  });
  renderProjects();

  assert.deepEqual(rowsSeen.sort(), ['Beacon', 'Vercel'], 'the reloaded list must show Workspace\'s children, not the old root\'s');
});

test('#accept-go ships disabled, and only the checkbox change handler clears it', () => {
  const html = read('index.html');
  const tag = html.match(/<button [^>]*id="accept-go"[^>]*>/);
  assert.ok(tag, 'index.html must contain #accept-go');
  assert.match(tag[0], /\sdisabled[\s>]/, '#accept-go must ship disabled - the button ships unusable before any script runs');

  const js = read('app.js');
  const showAccept = js.slice(js.indexOf('function showAccept()'), js.indexOf('function wireEvents()'));
  assert.match(
    showAccept,
    /function onCheck\(\)\s*\{\s*el\.go\.disabled = !el\.check\.checked;\s*\}/,
    'the checkbox change handler must be the whole enable rule',
  );
  // Every other write to go.disabled in this function must sit inside the
  // click handler, guarding an in-flight request or restoring the retry -
  // never an unconditional enable that bypasses the checkbox.
  const otherWrites = [...showAccept.matchAll(/el\.go\.disabled = (true|false);/g)];
  assert.equal(otherWrites.length, 2, 'expected exactly two writes in onClick: disabled=true up front, disabled=false on a failed retry');
});

test('errorCopy carries real copy for config_unreadable and write_failed, not the generic fallback', () => {
  const js = read('app.js');
  const table = js.match(/const ERROR_COPY = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'app.js must carry ERROR_COPY');
  const fnMatch = js.match(/function errorCopy\(code, status\) \{\s*return ([^;]+);/);
  assert.ok(fnMatch, 'app.js must carry errorCopy');
  const errorCopy = new Function('ERROR_COPY', 'code', 'status', `return ${fnMatch[1]};`);
  const ERROR_COPY = new Function(`return {${table[1]}\n};`)();
  // project_is_container joined this list 2026-09-05, owner-approved. It is the
  // one refusal the picker cannot prevent by construction: the list is drawn,
  // the folder gains a child on disk, the row is tapped. Until it had copy it
  // fell through to "The agent refused the request (status 400)", which tells
  // the owner nothing about what to do next.
  for (const code of ['config_unreadable', 'write_failed', 'project_is_container']) {
    const msg = errorCopy(ERROR_COPY, code, 500);
    assert.ok(msg && msg.length > 0, `${code} must have a non-empty message`);
    assert.ok(!msg.includes('status 500'), `${code} must not fall through to the generic "status" fallback`);
  }
});

test('project_is_container copy names the ACTION, not the status code', () => {
  // The point of this entry is that the reader knows what to do. A message that
  // is merely non-empty would pass the test above while still being useless.
  const js = read('app.js');
  const table = js.match(/const ERROR_COPY = \{([\s\S]*?)\n\};/);
  const ERROR_COPY = new Function(`return {${table[1]}\n};`)();
  const msg = ERROR_COPY.project_is_container;
  assert.match(msg, /REFRESH/, 'must tell the owner to refresh');
  assert.match(msg, /inside it|a project in/i, 'must say to pick a project inside the folder');
  assert.ok(!/\b400\b|status/i.test(msg), 'must not leak the status code to the owner');
});

test('index.html ships every accept-screen text node empty - the words live only in copy.js', () => {
  const html = read('index.html');
  const start = html.indexOf('<main id="accept"');
  const end = html.indexOf('<main id="gate"');
  const block = html.slice(start, end);
  for (const heading of ['WHAT IT CAN SEE', 'WHAT IT CANNOT SEE', 'WHO CAN REACH IT', 'WHAT LEAVES THIS MACHINE']) {
    assert.ok(!block.includes(heading), `index.html must not hardcode the heading "${heading}"`);
  }
  for (const lede of ['claude-remote starts Claude Code', 'Anything Claude Code can do on this machine']) {
    assert.ok(!block.includes(lede), `index.html must not hardcode the lede text "${lede}"`);
  }
});

// --- E: the accept screen's progressive disclosure ------------------

// Runs showAccept()'s real wiring under a stub DOM, the same recipe
// loadPicker() uses. renderSections is a thin wrapper around the real
// copy.js export rather than a reimplementation, so E4 cannot drift from the
// words it is checking - the real export reads the global `document` (node
// has none), so the wrapper points it at the stub only for the call.
//
// #accept-check and #accept-go both ship `disabled` in index.html; the stub
// DOM has no HTML parser to pick that up, so it is reproduced here once,
// the same way a real page's initial attribute state is a precondition of
// the wiring under test, not something the wiring itself sets.
function loadAccept({ acknowledge: acknowledgeImpl } = {}) {
  const js = read('app.js').replace(/\r/g, '');
  const src = js.slice(js.indexOf('function showAccept()'), js.indexOf('function wireEvents()'));
  const doc = fakeDocument();
  doc.getElementById('accept-check').disabled = true;
  doc.getElementById('accept-go').disabled = true;

  function wrappedRenderSections(host) {
    const prev = globalThis.document;
    globalThis.document = doc;
    try {
      copy.renderSections(host);
    } finally {
      if (prev === undefined) delete globalThis.document;
      else globalThis.document = prev;
    }
  }

  const fn = new Function(
    'document', 'TITLE', 'LEDE', 'CONSENT_LABEL', 'SETTINGS_NOTE', 'ACCEPT_BUTTON',
    'SECTIONS_TOGGLE', 'renderSections', 'acknowledge', 'errorCopy', 'showScreen',
    `${src}; return { showAccept };`,
  );
  const mod = fn(
    doc, copy.TITLE, copy.LEDE, copy.CONSENT_LABEL, copy.SETTINGS_NOTE, copy.ACCEPT_BUTTON,
    copy.SECTIONS_TOGGLE, wrappedRenderSections,
    acknowledgeImpl || (async () => ({ ok: true })),
    (code, status) => `${code} ${status}`,
    () => {}, // showAccept's router call - this helper only exercises the accept screen's own wiring
  );
  mod.document = doc;
  return mod;
}

test('E1 - index.html: #accept-sections sits inside <details id="accept-more"> with no open attribute, and #accept-check ships disabled', () => {
  const html = read('index.html');
  const detailsMatch = html.match(/<details[^>]*id="accept-more"[^>]*>[\s\S]*?<\/details>/);
  assert.ok(detailsMatch, 'index.html must carry <details id="accept-more">');
  assert.ok(detailsMatch[0].includes('id="accept-sections"'), '#accept-sections must sit inside the <details>');
  const openTag = detailsMatch[0].match(/<details[^>]*>/)[0];
  assert.ok(!/\sopen[\s>]/.test(openTag), 'the <details> must ship with no open attribute - collapsed is the shipped state');
  const checkTag = html.match(/<input type="checkbox" id="accept-check"[^>]*>/);
  assert.ok(checkTag, 'index.html must carry #accept-check');
  assert.match(checkTag[0], /\sdisabled[\s>]/, '#accept-check must ship disabled - unusable before any script has drawn the words');
});

test('the summary keeps the platform disclosure triangle: no list-style:none, no display:flex/block on .accept-more > summary', () => {
  const css = read('app.css');
  const rule = css.match(/\.accept-more > summary\s*\{([\s\S]*?)\}/);
  assert.ok(rule, 'app.css must declare .accept-more > summary');
  const body = rule[1];
  assert.ok(!/list-style\s*:\s*none/.test(body), 'list-style:none removes the only affordance the collapsed screen has that says "tappable"');
  assert.ok(!/display\s*:\s*(flex|block)/.test(body), 'Chrome drops the disclosure marker the moment display is not list-item');
  // Only .ts-more may hide it: the Artifact draws a chevron
  // there instead. A bare `summary::-webkit-details-marker` would reach this one.
  const hiders = [...css.matchAll(/([^{}]*)::-webkit-details-marker\s*\{\s*display\s*:\s*none/g)].map((m) => m[1].trim());
  assert.ok(hiders.every((sel) => sel === '.ts-more > summary'), `the marker must not be hidden via the webkit pseudo-element either: ${hiders}`);
});

test('E2 - after showAccept(), #accept-more-sum.textContent is SECTIONS_TOGGLE', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  assert.equal(doc.getElementById('accept-more-sum').textContent, copy.SECTIONS_TOGGLE);
});

test('E3 - collapsed, #accept-sections still holds one .copy-section per copy.SECTIONS entry', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  const more = doc.getElementById('accept-more');
  assert.ok(!more.open, 'the <details> must not be opened by showAccept() itself');
  const sections = doc.getElementById('accept-sections');
  const wraps = sections.children.filter((c) => c.className === 'copy-section');
  assert.equal(wraps.length, copy.SECTIONS.length, 'rendering only on open would lose the sections from find-in-page and a screen reader');
});

test('E4 - collapsed, every heading and every item string is reachable as text under #accept-sections, matching copy.SECTIONS itself', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  const sections = doc.getElementById('accept-sections');
  const texts = flatten(sections).map((n) => n.textContent).join(' ␟ ');
  for (const section of copy.SECTIONS) {
    assert.ok(texts.includes(section.heading), `heading "${section.heading}" must be reachable under #accept-sections`);
    for (const item of section.items) {
      assert.ok(texts.includes(item), `item "${item}" must be reachable under #accept-sections`);
    }
  }
});

test('E5 - #accept-go is still gated on the checkbox alone: disabled before a tick, enabled after', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  const check = doc.getElementById('accept-check');
  const go = doc.getElementById('accept-go');
  assert.equal(go.disabled, true, 'note 1 is unchanged - the button starts disabled');
  check.checked = true;
  check.fire('change');
  assert.equal(go.disabled, false, 'the disclosure work must not rewire the button');
});

test('E6 - the checkbox ships disabled and is enabled only once the sections have been opened', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  const check = doc.getElementById('accept-check');
  const more = doc.getElementById('accept-more');
  assert.equal(check.disabled, true, 'consent must not be claimable about words never shown');
  more.open = true;
  more.fire('toggle');
  assert.equal(check.disabled, false);
});

test('E7 - tapping the consent row while the box is disabled opens the sections; a second tap after the toggle does not re-set anything', () => {
  const { showAccept, document: doc } = loadAccept();
  showAccept();
  const consent = doc.getElementById('accept-consent');
  const more = doc.getElementById('accept-more');
  const check = doc.getElementById('accept-check');

  assert.equal(check.disabled, true);
  consent.fire('click');
  assert.equal(more.open, true, 'the first tap on the consent row must do the thing the label describes: show the words');
  assert.equal(check.checked, false, 'the first tap must not tick the box');

  // The stub DOM does not fire `toggle` when `.open` is set - fired by hand
  // here, the way a real browser fires it asynchronously on the attribute
  // change. The real-browser link is proven by the tester's headless run.
  more.fire('toggle');
  assert.equal(check.disabled, false);

  consent.fire('click');
  assert.equal(more.open, true, 'a second tap must not undo the open state');
  assert.equal(check.checked, false, 'onConsentTap must do nothing once the box is live - the native label click is what ticks it');
});

test('E8 - a successful acknowledge() tears down the toggle and consent-tap listeners, like the existing two', async () => {
  const { showAccept, document: doc } = loadAccept({ acknowledge: async () => ({ ok: true }) });
  const p = showAccept();
  const more = doc.getElementById('accept-more');
  const consent = doc.getElementById('accept-consent');
  const check = doc.getElementById('accept-check');
  const go = doc.getElementById('accept-go');
  assert.equal(more.listenerCount('toggle'), 1);
  assert.equal(consent.listenerCount('click'), 1);

  check.checked = true;
  check.fire('change');
  go.fire('click');
  await p;

  assert.equal(more.listenerCount('toggle'), 0, 're-entry after an auth loss must not stack a duplicate closure over the same node');
  assert.equal(consent.listenerCount('click'), 0);
});

test('E9 - a disabled consent checkbox does not swallow the tap', () => {
  // RED WHEN: `.accept-consent input:disabled { pointer-events: none; }` is
  // removed from app.css.
  // A disabled input dispatches NOTHING on click, so without this rule a thumb
  // landing on the 18px box - the exact spot the eye aims for - reaches neither
  // the input nor the label's handler, and the sections never open. Verified in
  // Chrome and Edge over CDP, including with touch emulation at 390x844: the
  // label handler fired 0 times on the box and 1 time on the text.
  // This is the rule the locked checkbox rests on: "tapping the consent row
  // opens the sections" has to be true for the whole row, or the gate is a dead
  // control in its most tappable spot. A DOM stub cannot model hit-testing, so
  // this pins the declaration in source.
  const css = read('app.css').split(String.fromCharCode(13)).join('');
  assert.match(
    css,
    /\.accept-consent\s+input:disabled\s*\{[^}]*pointer-events:\s*none/,
    'the disabled consent checkbox must let the tap fall through to its label',
  );
});

// The eye toggle is an app-wide rule, not a per-screen one: the artifact
// draws it on the gate and on Change passcode.
test('every passcode field carries its own eye, found by the <input id>-eye convention', () => {
  // RED WHEN: a field is added without an eye, or an eye is added with an id
  // that setPinRevealed cannot derive - it looks the button up as
  // `${inputId}-eye` and would throw on the tap.
  const html = read('index.html');
  const inputIds = [...html.matchAll(/<input class="pin" id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(inputIds.length >= 5, `expected the gate's two and Change passcode's three, got ${inputIds.length}`);
  for (const id of inputIds) {
    assert.match(
      html,
      new RegExp(`<button class="pin-eye" id="${id}-eye"[^>]*data-pin-name="`),
      `#${id} must have a #${id}-eye button carrying data-pin-name`,
    );
  }
});

test('no passcode field group is a <label>, or tapping its eye types into the field', () => {
  // RED WHEN: the old <label class="gate-field"> wrapper comes back. A click
  // on a button inside a <label> is forwarded to the labelled control, so the
  // reveal would also move the caret into the field.
  const html = read('index.html');
  assert.ok(
    !/<label[^>]*class="gate-field"/.test(html),
    'a field group holding a button must be a <div>, with the label associated by `for`',
  );
  const groups = [...html.matchAll(/<div class="gate-field"[^>]*>/g)];
  assert.ok(groups.length >= 5, `expected five field groups, got ${groups.length}`);
});

test('every local module the app imports is in the shell lists, or the app cannot boot offline', () => {
  // RED WHEN: a new ES module is added and nobody remembers these two lists.
  // The existing sibling test only checks they match EACH OTHER, and they did
  // - both omitting update-ui.js. The consequences are two, and neither shows
  // up in a suite: app.js's static import of a file the worker never cached
  // fails outright offline, so the PWA does not boot at all; and a file
  // outside SHELL_FILES is not in the hash, so editing it alone does not move
  // the cache key and the phone keeps yesterday's copy. Found by reading the
  // lists after a commit, not by a failing test.
  const modules = new Set();
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = read(rel);
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'(\.\/[^']+)'/g)) {
      const dep = m[1].replace(/^\.\//, '');
      modules.add(dep);
      walk(dep);
    }
  };
  walk('app.js');
  assert.ok(modules.size >= 5, `expected app.js to import several modules, found ${modules.size}`);

  const shellSrc = fs.readFileSync(path.join(AGENT_DIR, 'static.js'), 'utf8');
  const shell = new Set(
    [...shellSrc.match(/const SHELL_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  for (const mod of modules) {
    assert.ok(shell.has(mod), `${mod} is imported by the app but is not in static.js's SHELL_FILES`);
  }
});
