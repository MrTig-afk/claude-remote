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

test('sw.js CACHE is claude-remote-shell-v14', () => {
  const source = read('sw.js');
  const match = source.match(/const CACHE = '([^']+)'/);
  assert.ok(match, 'sw.js must declare CACHE');
  assert.equal(match[1], 'claude-remote-shell-v14');
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
