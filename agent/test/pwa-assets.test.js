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

test('lock.js never calls fetch() directly - it only calls into api.js', () => {
  assert.ok(!read('lock.js').includes('fetch('), 'lock.js must not call fetch() directly');
});

// --- No egress ---

test('no shipped asset embeds an absolute http(s) URL', () => {
  for (const f of ['index.html', 'app.css', 'app.js', 'api.js', 'sw.js', 'lock.js']) {
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

test('lock.js has no timers: no setInterval, no setTimeout (no live countdown)', () => {
  assert.ok(!read('lock.js').includes('setInterval'), 'lock.js must not use setInterval');
  assert.ok(!read('lock.js').includes('setTimeout'), 'lock.js must not use setTimeout');
});

// --- Passcode gate ---

test('PRECACHE includes /lock.js', () => {
  const source = read('sw.js');
  const match = source.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  const precache = new Function(`return ${match[1]};`)();
  assert.ok(precache.includes('/lock.js'));
});

test('api.js carries the token header and never persists the token to the device', () => {
  const source = read('api.js');
  assert.ok(source.includes('X-Claude-Remote-Token'));
  assert.ok(!source.includes('localStorage'), 'api.js must never touch localStorage - the token must not survive a reload');
  assert.ok(!source.includes('sessionStorage'), 'api.js must never touch sessionStorage - the token must not survive a reload');
});

test('index.html ships both wrappers hidden - fail-closed markup', () => {
  const html = read('index.html');
  assert.match(html, /<main id="picker" hidden>/);
  assert.match(html, /<main id="gate" hidden>/);
});

// The test above is a source-string check and CANNOT see the cascade. It
// passed while the picker was in fact rendering behind the lock screen,
// because `hidden` is only a user-agent `display: none` and every author
// rule that sets `display` overrides it. Anything that ships `hidden` and is
// also given a `display` by our own stylesheet therefore needs the
// `!important` guard to stay hidden. Assert the guard exists, and assert the
// pairing that makes it necessary, so deleting either side fails here.
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
  assert.ok(hiddenIds.includes('picker') && hiddenIds.includes('gate'), 'both wrappers must ship hidden');
  for (const id of ['picker', 'gate']) {
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

  // The whole block, not the opening tag: opacity on a child shape mutes the
  // mark exactly as well as opacity on the symbol, and a child is the more
  // natural place to put it.
  const symbol = html.slice(html.indexOf('<symbol id="mark"'), html.indexOf('</symbol>'));
  assert.match(symbol, /stroke="#7ee787"/, 'the mark is always the accent, never currentColor');
  assert.ok(!/opacity/.test(symbol), 'the mark is never reduced in opacity');
  assert.ok(!/filter/.test(symbol), 'no glow filter at these sizes');

  // The markup is only half of it - a stylesheet can dim what the markup lit.
  // Every rule whose selector names the mark, declarations only, so a comment
  // that merely mentions the word does not fail this.
  const markRules = read('app.css')
    .split('}')
    .filter((chunk) => chunk.includes('{') && chunk.slice(0, chunk.indexOf('{')).includes('.mark'))
    .map((chunk) => chunk.slice(chunk.indexOf('{') + 1));
  assert.ok(markRules.length > 0, 'expected at least one .mark rule in app.css');
  for (const decls of markRules) {
    assert.ok(!/opacity/.test(decls), `the mark is never dimmed by CSS either: ${decls.trim()}`);
    assert.ok(!/filter/.test(decls), `no filter on the mark: ${decls.trim()}`);
  }
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
