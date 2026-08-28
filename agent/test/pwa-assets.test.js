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
    async match(req) {
      return overrides.cacheMatch ? overrides.cacheMatch(req) : undefined;
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

test('the danger colours (#ff7b72, #e5534b) appear only in stop/confirm rules, never on a banner', () => {
  const css = read('app.css');
  const blocks = css.split('}').filter((chunk) => chunk.includes('{'));
  for (const chunk of blocks) {
    const selector = chunk.slice(0, chunk.indexOf('{'));
    const body = chunk.slice(chunk.indexOf('{') + 1);
    if (/#ff7b72|#e5534b/i.test(body)) {
      assert.match(
        selector,
        /tile-stop|tile-confirm/,
        `selector "${selector.trim()}" carries a danger colour but is not a stop/confirm rule`,
      );
    }
  }

  const bannerRule = css.match(/\.banner\s*\{[^}]*\}/);
  const bannerErrorRule = css.match(/\.banner\.error\s*\{[^}]*\}/);
  assert.ok(bannerRule, 'app.css must carry a .banner rule');
  assert.ok(bannerErrorRule, 'app.css must carry a .banner.error rule');
  assert.ok(!/#ff7b72|#e5534b/i.test(bannerRule[0]), '.banner must not use a danger colour');
  assert.ok(!/#ff7b72|#e5534b/i.test(bannerErrorRule[0]), '.banner.error must not use a danger colour');
});

test('anyWatchable is true for running/handoff/starting, and the watch loop is a bounded 5s poll gated on visibility', () => {
  const js = read('app.js');
  const body = js.match(/function anyWatchable\(\) \{\s*return ([^;]+);/);
  assert.ok(body, 'app.js must carry anyWatchable');
  const anyWatchable = new Function('state', `return ${body[1]};`);
  assert.equal(anyWatchable({ sessions: [{ status: 'running' }] }), true);
  assert.equal(anyWatchable({ sessions: [{ status: 'handoff' }] }), true);
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

test('the confirm carries exactly CANCEL and END & WRITE HANDOFF, and no other kill-button wording exists', () => {
  const js = read('app.js');
  const buildTile = js.slice(js.indexOf('function buildTile('), js.indexOf('function buildRow('));
  assert.match(buildTile, /'CANCEL'/);
  assert.match(buildTile, /'END & WRITE HANDOFF'/);
  for (const forbidden of ['END IT', 'KILL', 'FORCE', 'input type="checkbox"']) {
    assert.ok(!js.includes(forbidden), `app.js must not contain "${forbidden}"`);
  }
});

test('the four stop/handoff banner strings from the brief appear verbatim in app.js', () => {
  const js = read('app.js');
  assert.ok(js.includes("' had already ended.'"), 'already-ended banner text');
  assert.ok(js.includes("'! Could not end '") && js.includes("'. It is still running - close it at the desk.'"), 'kill-failed banner text');
  assert.ok(js.includes("'Handoff written for '"), 'handoff-written banner text');
  assert.ok(js.includes("'! Session ended, but the handoff was not written.'"), 'handoff-not-written banner text');
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

test('sw.js CACHE is claude-remote-shell-v20', () => {
  const source = read('sw.js');
  const match = source.match(/const CACHE = '([^']+)'/);
  assert.ok(match, 'sw.js must declare CACHE');
  assert.equal(match[1], 'claude-remote-shell-v20');
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
  assert.match(buildTile, /'END & WRITE HANDOFF \(DESKTOP\)'/);
  assert.match(buildTile, /'END & WRITE HANDOFF'/);
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

test("app.js never tells the owner to open the Claude app after a launch, except the failed banner", () => {
  const js = read('app.js');
  assert.doesNotMatch(js, /not confirmed/);
  assert.equal((js.match(/Claude app/g) || []).length, 1,
    "only maybeFailedBanner may mention the Claude app (owner, T47 interview Q1)");
});

test("rowState's running branch shows the session's busy/idle activity", () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function rowState('), js.indexOf('function setDot('));
  assert.match(fn, /session\.activity \|\| 'active session'/);
});

// --- the launch banner clears itself once the session settles --------------

function makeClearSettled(hideBannerSpy, state, launchBannerFor) {
  const js = read('app.js');
  const src = js.slice(
    js.indexOf('function clearSettledLaunchBanner('),
    js.indexOf('function setErrorBanner('),
  );
  // sessionFor is stubbed to the one rule this function depends on: a project
  // row resolves to its session, or to null when there is none yet.
  const sessionFor = (p) => (state.sessions || []).find((s) => s.path === p.path) ?? null;
  if (!state.results) state.results = new Map();
  const make = new Function(
    'state', 'sessionFor', 'hideBanner', 'launchBannerFor',
    src + '; return clearSettledLaunchBanner;',
  );
  return make(state, sessionFor, hideBannerSpy, launchBannerFor);
}

function spy() {
  const calls = [];
  const fn = () => calls.push(1);
  fn.calls = calls;
  return fn;
}

const PROJ = { projects: [{ name: 'Sherlock', path: 'F:/p/Sherlock' }] };

test('clearSettledLaunchBanner does nothing when no launch banner is up', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Sherlock', status: 'running' }] }, null)();
  assert.equal(hide.calls.length, 0);
});

test('clearSettledLaunchBanner keeps the banner while the launch has not landed in state.sessions yet', () => {
  const hide = spy();
  // "not landed yet" is represented by state.results STILL holding the launch
  // result. An empty results map with no entry means the opposite - it landed
  // and the session is gone - which is the desk-exit test further down.
  const state = { ...PROJ, sessions: [], results: new Map([['Sherlock', { kind: 'started' }]]) };
  makeClearSettled(hide, state, 'Sherlock')();
  assert.equal(hide.calls.length, 0, 'the 202 fires before the entry exists - hiding here would blank it instantly');
});

test('clearSettledLaunchBanner keeps the banner while the session is still starting', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Sherlock', status: 'starting' }] }, 'Sherlock')();
  assert.equal(hide.calls.length, 0);
});

test('clearSettledLaunchBanner drops the banner as soon as the session is running', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Sherlock', status: 'running' }] }, 'Sherlock')();
  assert.equal(hide.calls.length, 1, 'this is the bug: it used to sit there until a manual refresh');
});

test('clearSettledLaunchBanner drops the banner for a failed session too, so maybeFailedBanner can replace it', () => {
  const hide = spy();
  makeClearSettled(hide, { ...PROJ, sessions: [{ path: 'F:/p/Sherlock', status: 'failed' }] }, 'Sherlock')();
  assert.equal(hide.calls.length, 1);
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
    projects: [{ name: 'Sherlock', path: 'F:/p/Sherlock' }],
    sessions: [],
    results: new Map([['Sherlock', { kind: 'started' }]]),
  };
  makeDropCovered(state)();
  assert.equal(state.results.size, 1, 'the 202 fires before the entry exists - the tile needs this to say starting');
});

test('dropCoveredResults drops the result the moment the server has an entry', () => {
  const state = {
    projects: [{ name: 'Sherlock', path: 'F:/p/Sherlock' }],
    sessions: [{ path: 'F:/p/Sherlock', status: 'starting' }],
    results: new Map([['Sherlock', { kind: 'started' }]]),
  };
  makeDropCovered(state)();
  assert.equal(state.results.size, 0, 'the session now speaks for itself');
});

test('a session pruned after being seen leaves NO stale result to fall back to', () => {
  // The reported bug end to end: launch, entry appears, session exited at the
  // desk, entry pruned. Without the drop, rowState fell back to the result and
  // the tile sat on "starting..." until a manual refresh.
  const state = {
    projects: [{ name: 'Sherlock', path: 'F:/p/Sherlock' }],
    sessions: [{ path: 'F:/p/Sherlock', status: 'running' }],
    results: new Map([['Sherlock', { kind: 'started' }]]),
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
  const state = { ...PROJ, sessions: [], results: new Map([['Sherlock', { kind: 'started' }]]) };
  makeClearSettled(hide, state, 'Sherlock')();
  assert.equal(hide.calls.length, 0, 'no entry yet AND the result is still there - the 202 has not landed');
});

test('the launch banner clears when a session that HAD landed disappears (desk exit)', () => {
  // registry.js:571 drops the entry outright on a dead pid - it is never
  // reported as `failed`, so "no entry" must not be read as "not landed yet".
  // dropCoveredResults() has already removed the result by then; that absence
  // is what tells the two cases apart.
  const hide = spy();
  const state = { ...PROJ, sessions: [], results: new Map() };
  makeClearSettled(hide, state, 'Sherlock')();
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

// --- an interrupted handoff must not claim the file was never written -----

test("reportEnded distinguishes 'interrupted' from a genuine handoff failure", () => {
  const js = read('app.js');
  const fn = js.slice(js.indexOf('function reportEnded('), js.indexOf('function failedSessions('));
  assert.match(fn, /s\.handoff_result === 'interrupted'/,
    'the agent losing the verdict is not the same as the handoff failing');
  assert.match(fn, /restarted before it could confirm/);
  assert.ok(
    fn.indexOf("=== 'interrupted'") < fn.indexOf('the handoff was not written'),
    'the interrupted branch must be reached before the blunt fallback',
  );
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
  const btn = buildRow({ name: 'Sherlock' }, { zone: 'list', dot: 'dim', status: 'no session', implicit: true });
  assert.equal(btn.className, 'row');
  assert.equal(btn.children[0].tag, 'DOT');
  assert.equal(btn.dataset.project, 'Sherlock');
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
  assert.match(css, /\.row\.folder \.row-name\s*\{[^}]*#c9d1c9/);
  assert.match(css, /\.row\.folder \.row-status\s*\{[^}]*#4a5a4a/);
  assert.match(css, /\.folder-chev\s*\{[^}]*#5fae6f/);
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
  const clearSettledLaunchBanner = new Function(
    'state', 'sessionFor', 'hideBanner', 'launchBannerFor',
    src + '; return clearSettledLaunchBanner;',
  )(state, sessionFor, hide, 'Pull Requests/Vercel');
  clearSettledLaunchBanner();
  assert.equal(hide.calls.length, 1, 'without the pathless stand-in, a nested launch banner never clears - the same bug fixed for top-level projects');
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
function makeRenderProjectsIntegration(stubs) {
  const js = read('app.js');
  const helpers = js.slice(js.indexOf('function elapsed('), js.indexOf('function setDot('));
  const childStart = js.indexOf('function childProject(');
  const child = js.slice(childStart, js.indexOf('\n}', childStart) + 2);
  const rp = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  const src = helpers + child + rp;
  return new Function(
    'document', 'state', 'buildTile', 'buildRow', 'renderBackBar',
    src + '; return renderProjects;',
  )(stubs.document, stubs.state, stubs.buildTile, stubs.buildRow, stubs.renderBackBar);
}

function makeStubEl() {
  return {
    innerHTML: '', textContent: '', children: [],
    classList: { toggle() {}, add() {} },
    appendChild(c) { this.children.push(c); return c; },
  };
}

test('renderProjects: with a folder open, only that folder\'s children render and only that folder\'s sessions reach the RUNNING zone', () => {
  const state = {
    projects: [
      { name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] },
      { name: 'Sherlock', path: 'F:/p/Sherlock' },
    ],
    openFolder: 'Pull Requests',
    sessions: [
      { project: 'Pull Requests/Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'launched', status: 'running', activity: 'busy' },
      { project: 'Sherlock', path: 'F:/p/Sherlock', source: 'launched', status: 'running', activity: 'busy' },
    ],
    launching: new Set(), stopping: new Set(), results: new Map(), confirmName: null, focusName: null,
  };
  const els = { tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl() };
  const document = { getElementById: (id) => els[id] };
  const rowsSeen = [];
  const tilesSeen = [];
  const buildRow = (p) => { rowsSeen.push(p.name); return { tag: 'ROW' }; };
  const buildTile = (p) => { tilesSeen.push(p.name); return { tag: 'TILE' }; };
  const renderBackBar = () => {};
  const renderProjects = makeRenderProjectsIntegration({ document, state, buildTile, buildRow, renderBackBar });

  renderProjects();

  assert.deepEqual(rowsSeen, [], 'the only child, Vercel, is a running session so it is a tile, not a list row');
  assert.deepEqual(tilesSeen, ['Pull Requests/Vercel'], 'the unrelated top-level Sherlock session must not reach the RUNNING zone while the folder is open');
  assert.ok(!rowsSeen.includes('Sherlock') && !tilesSeen.includes('Sherlock'), 'a top-level project must never appear while a folder is open');
  assert.ok(!rowsSeen.includes('Pull Requests'), 'the container must never appear as a row inside its own screen');
});

// Given in the brief verbatim: slices onPopState (and, harmlessly,
// openFolderScreen/closeFolderScreen ahead of it - declarations only, never
// called by these tests).
function makePopState(state, historyStub) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function onPopState('), js.indexOf('function endTargetFor('));
  return new Function('state', 'history', 'render', 'confirmPushed', 'folderPushed',
    src + '; return onPopState;')(state, historyStub, () => {}, true, true);
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

function makeRenderBackBar() {
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
  const renderBackBar = new Function('document', 'closeNewProjectPanel', src + '; return renderBackBar;')(
    document, () => closeCalls.push(1),
  );
  return { renderBackBar, els, closeCalls };
}

test('renderBackBar reveals the bar and puts the + away, and vice versa', () => {
  const open = makeRenderBackBar();
  open.renderBackBar({ name: 'Pull Requests', path: 'F:/p/Pull Requests' });
  assert.equal(open.els.backbar.hidden, false);
  assert.equal(open.els.newproj.hidden, true);
  assert.equal(open.els['backbar-name'].textContent, 'Pull Requests');
  assert.equal(open.els['backbar-path'].textContent, 'F:/p/Pull Requests');
  assert.ok(open.els.backbar.attrs['aria-label'], 'an aria-label must be set');

  const closed = makeRenderBackBar();
  closed.renderBackBar(null);
  assert.equal(closed.els.backbar.hidden, true);
  assert.equal(closed.els.newproj.hidden, false);
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
  const topLevel = tileParts({ name: 'Sherlock', path: 'F:/p/Sherlock' });
  assert.equal(topLevel.eyebrow, undefined);
  assert.equal(topLevel.name.textContent, 'Sherlock');
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
  assert.equal(parentFolderName('F:/p/Sherlock'), 'p');
  assert.equal(parentFolderName(null), null);
});

test('renderProjects gives a synthetic row its parent and a listed project none', () => {
  const state = {
    projects: [
      { name: 'Sherlock', path: 'F:/p/Sherlock' },
      { name: 'Pull Requests', container: true, children: [{ name: 'Vercel', path: 'F:/p/Pull Requests/Vercel' }] },
    ],
    openFolder: null,
    confirmName: null,
    focusName: null,
    sessions: [
      { project: 'Vercel', path: 'F:/p/Pull Requests/Vercel', source: 'desk', status: 'running', activity: 'busy' },
      { project: 'Sherlock', path: 'F:/p/Sherlock', source: 'launched', status: 'running', activity: 'busy' },
    ],
    launching: new Set(), stopping: new Set(), results: new Map(),
  };
  const els = { tiles: makeStubEl(), projects: makeStubEl(), 'run-count': makeStubEl(), 'all-count': makeStubEl() };
  const document = { getElementById: (id) => els[id] };
  const seen = [];
  const buildRow = (p) => { seen.push(p); return { tag: 'ROW' }; };
  const buildTile = (p) => { seen.push(p); return { tag: 'TILE' }; };
  const renderBackBar = () => {};
  const renderProjects = makeRenderProjectsIntegration({ document, state, buildTile, buildRow, renderBackBar });

  renderProjects();

  const vercel = seen.find((p) => p.name === 'Vercel');
  const sherlock = seen.find((p) => p.name === 'Sherlock');
  assert.equal(vercel.parent, 'Pull Requests', 'the parent is attached where the row is built, because that is the only place that knows the row is not a listed project');
  assert.equal(sherlock.parent, undefined);
});

test('the eyebrow is the dimmest token, clamps to one line, and clears the corner STOP chip', () => {
  const css = read('app.css');
  const rule = css.match(/\.tile-eyebrow\s*\{([^}]*)\}/);
  assert.ok(rule, 'app.css must carry a .tile-eyebrow rule');
  assert.match(rule[0], /#4a5a4a/);
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
  assert.ok(
    load.indexOf("state.reachable = 'waiting'") < load.indexOf('state.reachable = false'),
    'the waiting branch must be checked before the dead-end branch',
  );
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
  assert.match(conn, /WAITING FOR PC/);
  assert.match(conn, /setDot\(dot, 'accent'\)/, 'a dim dot reads as "nothing is happening"; something is');
  assert.ok(
    !/text\.classList\.add\('reachable'\)[\s\S]*?state\.reachable === true/.test(conn),
    'waiting must never claim the reachable class',
  );

  const rp = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderFooter('));
  assert.match(rp, /Waiting for the PC\./);
  assert.ok(
    rp.indexOf("state.reachable === 'waiting'") < rp.indexOf('state.reachable === false'),
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
