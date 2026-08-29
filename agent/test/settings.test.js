// T77 - Settings root + routing. ESM, built-in node:test + node:assert/strict,
// no new dependency. Same idiom as pwa-assets.test.js: pure logic imported
// directly (folders-ui.js), everything else sliced out of app.js with
// new Function and run under a small stub DOM - app.js is a browser module
// with no DOM in this runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as folders from '../public/folders-ui.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function read(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

// --- A minimal stub DOM, self-contained (pwa-assets.test.js's is not
// exported, and this file's needs are smaller: no listeners, no closest()). ---

function makeEl(tag) {
  return {
    tag,
    className: '',
    dataset: {},
    children: [],
    attrs: {},
    _text: '',
    appendChild(child) { this.children.push(child); return child; },
    // buildSettingsRow clones an <svg> out of a <template> and points its
    // <use> at the icon id. Both live on the CLONE, never on the row, so a
    // row assertion is unaffected by them.
    cloneNode() { return makeEl(this.tag); },
    // showScreen adds/removes the nav-direction class that drives the
    // page-transition animation. A no-op set is enough: these tests assert
    // which screen is revealed, never how it got there.
    classList: { add() {}, remove() {} },
    querySelector() { return this._use || (this._use = makeEl('use')); },
    setAttribute(k, v) { this.attrs[k] = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this.children = []; },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = v; this.children = []; },
  };
}

function fakeDocument(byId = {}) {
  const registry = new Map(Object.entries(byId));
  // #tpl-row-ico is the <template> buildSettingsRow clones the row icon from.
  // Registered by default so every harness gets it without knowing about it.
  if (!registry.has('tpl-row-ico')) {
    const tpl = makeEl('template');
    tpl.content = { firstElementChild: makeEl('svg') };
    registry.set('tpl-row-ico', tpl);
  }
  return {
    createElement: (tag) => makeEl(tag),
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeEl('div'));
      return registry.get(id);
    },
  };
}

// --- S1/S2/S3 - the routing table and its one writer ---------------------

function readScreenMain() {
  const js = read('app.js');
  const start = js.indexOf('const SCREEN_MAIN = {');
  const end = js.indexOf('};', start) + 2;
  return new Function(`${js.slice(start, end)}; return SCREEN_MAIN;`)();
}

test('S1 - every SCREEN_MAIN value is a <main id> present in index.html, and the keys are the nine screens', () => {
  // RED WHEN: a screen is added to the map with no <main>, or a <main> is
  // renamed - the router would then hide nothing and two screens stack.
  // The four Lane 7 destinations are here now; a fifth (Change passcode)
  // lands with its agent route.
  const SCREEN_MAIN = readScreenMain();
  assert.deepEqual(
    Object.keys(SCREEN_MAIN).sort(),
    ['about', 'accept', 'agent', 'folders', 'gate', 'list', 'reset', 'see', 'settings'],
  );
  const html = read('index.html');
  for (const id of Object.values(SCREEN_MAIN)) {
    assert.match(html, new RegExp(`<main id="${id}"`), `index.html must contain <main id="${id}">`);
  }
});

function loadShowScreen() {
  const js = read('app.js');
  const start = js.indexOf('const SCREEN_MAIN = {');
  const end = js.indexOf('const ERROR_COPY = {');
  const src = js.slice(start, end);
  const doc = fakeDocument();
  const state = { screen: 'gate' };
  const fn = new Function('document', 'state', 'renderConn', `${src}; return { SCREEN_MAIN, showScreen };`);
  const mod = fn(doc, state, () => {});
  return { ...mod, doc, state };
}

test('S2 - showScreen(name) leaves exactly one main revealed, and it is SCREEN_MAIN[name]', () => {
  // RED WHEN: a reveal misses a main and two <main>s render stacked - the
  // failure boot()'s hideAccept() comment describes.
  const { SCREEN_MAIN, showScreen, doc } = loadShowScreen();
  for (const name of Object.keys(SCREEN_MAIN)) {
    showScreen(name);
    for (const [screen, id] of Object.entries(SCREEN_MAIN)) {
      const revealed = doc.getElementById(id).hidden === false;
      assert.equal(revealed, screen === name, `showScreen('${name}'): #${id}.hidden must be ${screen !== name}`);
    }
  }
});

test('S3 - state.screen = appears in app.js exactly once, inside showScreen', () => {
  // RED WHEN: something writes the screen behind the router's back, after
  // which goHome and onPopState act on a screen the app is not on.
  const js = read('app.js');
  const writes = [...js.matchAll(/state\.screen\s*=(?!=)/g)];
  assert.equal(writes.length, 1, 'state.screen must be assigned in exactly one place');
  const start = js.indexOf('function showScreen(');
  const end = js.indexOf('\n}', start);
  assert.ok(writes[0].index > start && writes[0].index < end, 'the one assignment must be inside showScreen');
});

// --- S4 - onPopState's new branch ------------------------------------------

function makePopState(state, historyStub, showScreenSpy = () => {}, sub = null) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('function onPopState('), js.indexOf('function endTargetFor('));
  const fn = new Function(
    'state', 'history', 'render', 'confirmPushed', 'folderPushed', 'settingsPushed', 'showScreen',
    'settingsSub', 'SETTINGS_SUBS', 'renderSettings',
    `${src}; return onPopState;`,
  );
  // settingsSub defaults to null: the sub-screen branch is opt-in per test,
  // so every existing case still exercises the root/drill paths unchanged.
  return fn(
    state, historyStub, () => {}, true, true, true, showScreenSpy,
    sub, new Set(['see', 'agent', 'reset', 'about']), () => {},
  );
}

test('S4 - onPopState on the settings screen returns to the list without touching a drill entry underneath', () => {
  // RED WHEN: the settings branch is missing or falls through into the drill
  // branch and eats the {drill} entry underneath, dropping the owner two
  // screens on one back press.
  const state = { screen: 'settings', openFolder: 'Pull Requests', confirmName: null };
  const shown = [];
  const onPopState = makePopState(state, { state: { drill: 'Pull Requests' } }, (name) => shown.push(name));
  onPopState();
  assert.deepEqual(shown, ['list']);
  assert.equal(state.openFolder, 'Pull Requests', 'the settings pop must not touch the drill entry underneath it');
});

// S5 - the three existing onPopState tests in pwa-assets.test.js (unedited
// assertions, makePopState's parameter list only) still pass. Verified by
// the full suite, not re-asserted here.

// --- S6/S7 - openSettings / closeSettings, double-tap and confirm guards --

function loadOpenSettings({ cancelOpenConfirm } = {}) {
  const js = read('app.js');
  const start = js.indexOf('let settingsPushed = false;');
  const end = js.indexOf('function closeSettings(');
  const src = js.slice(start, end);
  const pushes = [];
  const calls = { showScreen: [], renderSettings: 0 };
  const fn = new Function(
    'history', 'cancelOpenConfirm', 'showScreen', 'renderSettings',
    `${src}; return openSettings;`,
  );
  const openSettings = fn(
    { pushState: (s) => pushes.push(s) },
    cancelOpenConfirm || (() => false),
    (name) => calls.showScreen.push(name),
    () => { calls.renderSettings += 1; },
  );
  return { openSettings, pushes, calls };
}

test('S6 - openSettings pushes exactly one settings entry across two calls, and a live confirm blocks it entirely', () => {
  // RED WHEN: the third caller of the history machinery skips the
  // cancelOpenConfirm() guard the folderPushed comment demands - putting the
  // settings entry under a live confirm entry and breaking "the confirm's
  // entry is always the top one".
  const { openSettings, pushes } = loadOpenSettings();
  openSettings();
  openSettings();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { screen: 'settings' });

  const blocked = loadOpenSettings({ cancelOpenConfirm: () => true });
  blocked.openSettings();
  assert.equal(blocked.pushes.length, 0, 'a live confirm must push nothing');
  assert.equal(blocked.calls.showScreen.length, 0, 'a live confirm must call no showScreen');
});

function loadCloseSettings() {
  const js = read('app.js');
  const start = js.indexOf('function closeSettings(');
  const end = js.indexOf('function openSharedFolders(');
  const src = js.slice(start, end);
  const calls = { back: 0, showScreen: [], render: 0 };
  const fn = new Function(
    'history', 'render', 'showScreen',
    `let settingsPushed = true; ${src}; return closeSettings;`,
  );
  const closeSettings = fn(
    { back: () => { calls.back += 1; } },
    () => { calls.render += 1; },
    (name) => calls.showScreen.push(name),
  );
  return { closeSettings, calls };
}

test('S7 - closeSettings called twice fires exactly one history.back()', () => {
  // RED WHEN: the double-tap guard is dropped and the second tap pops the
  // app's own base entry, closing the PWA.
  const { closeSettings, calls } = loadCloseSettings();
  closeSettings();
  closeSettings();
  assert.equal(calls.back, 1);
  assert.deepEqual(calls.showScreen, ['list', 'list']);
});

// --- S8 - goHome, one exit per screen --------------------------------------

function loadGoHome({
  screen, confirmPushed = false, folderPushed = false,
  settingsSub = null, settingsPushed = false,
}) {
  const js = read('app.js');
  const start = js.indexOf('function goHome(');
  const end = js.indexOf('// Extracted to a named function');
  const src = js.slice(start, end);
  const state = { screen, confirmName: confirmPushed ? 'X' : null, openFolder: folderPushed ? 'Y' : null };
  const calls = {
    render: 0, historyGo: [], finishFolders: 0, closeSettings: 0, showScreen: [],
  };
  const fn = new Function(
    'state', 'history', 'render', 'confirmPushed', 'folderPushed', 'finishFolders', 'closeSettings',
    'settingsSub', 'settingsPushed', 'showScreen',
    `${src}; return goHome;`,
  );
  const goHome = fn(
    state,
    { go: (n) => calls.historyGo.push(n) },
    () => { calls.render += 1; },
    confirmPushed,
    folderPushed,
    () => { calls.finishFolders += 1; },
    () => { calls.closeSettings += 1; },
    settingsSub,
    settingsPushed,
    (name) => { calls.showScreen.push(name); },
  );
  return {
    goHome, state, calls,
  };
}

test('S8 - goHome: gate/accept do nothing, folders/settings hand off, and the list traverses once per gesture', () => {
  // RED WHEN: home is live on the lock screen, or one tap issues two history
  // moves and the traversal races.
  for (const screen of ['gate', 'accept']) {
    const { goHome, calls } = loadGoHome({ screen });
    goHome();
    assert.equal(calls.render, 0, `${screen}: goHome must be inert`);
    assert.equal(calls.historyGo.length, 0);
  }

  {
    const { goHome, calls } = loadGoHome({ screen: 'folders' });
    goHome();
    assert.equal(calls.finishFolders, 1);
    assert.equal(calls.closeSettings, 0);
  }

  {
    const { goHome, calls } = loadGoHome({ screen: 'settings' });
    goHome();
    assert.equal(calls.closeSettings, 1);
    assert.equal(calls.finishFolders, 0);
  }

  {
    const {
      goHome, calls, state,
    } = loadGoHome({ screen: 'list', confirmPushed: true, folderPushed: true });
    goHome();
    assert.deepEqual(calls.historyGo, [-2]);
    assert.equal(state.confirmName, null);
    assert.equal(state.openFolder, null);
    assert.equal(calls.render, 1);
  }

  {
    const { goHome, calls } = loadGoHome({ screen: 'list', confirmPushed: true, folderPushed: false });
    goHome();
    goHome();
    assert.equal(calls.historyGo.length, 1, 'a second tap must not issue a second history move');
  }
});

// --- S9 - the header is shared, once, outside every screen -----------------

test('S9 - #home lives once, inside the one shared header, and no <main> screen ever carries it', () => {
  // RED WHEN: a screen added later carries its own header or its own home
  // link, or the header moves inside a screen - the force-quit the owner
  // hit. This is the pin that covers T78-T85's screens before they exist.
  const html = read('index.html');
  assert.equal([...html.matchAll(/id="home"/g)].length, 1, 'exactly one id="home" must exist');

  const headerStart = html.indexOf('<header');
  const headerEnd = html.indexOf('</header>');
  assert.ok(headerStart !== -1 && headerEnd > headerStart, 'index.html must contain a header');
  const header = html.slice(headerStart, headerEnd);
  assert.match(header, /id="home"/, '#home must live inside the header');
  assert.match(header, /<use href="#mark"\/>/, 'the header must draw the mark');
  assert.match(header, /claude/, 'the header must carry the wordmark');

  assert.ok(headerEnd < html.indexOf('<main'), '</header> must precede the first <main');

  const mainBlocks = [...html.matchAll(/<main[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/main>/g)];
  assert.ok(mainBlocks.length >= 5, 'expected at least five <main> screens');
  for (const m of mainBlocks) {
    assert.ok(!m[0].includes('id="home"'), `<main id="${m[1]}"> must not carry the home control`);
  }
});

// --- S10 - sharedRowState, the unknown-set guard's own state ---------------

test('S10 - sharedRowState text and enterable per shared set', () => {
  // RED WHEN: the unknown set becomes enterable, or the count reads
  // "1 folders". The first assertion is the T100 precondition.
  assert.deepEqual(folders.sharedRowState(null), { text: 'not known yet', enterable: false });
  assert.deepEqual(folders.sharedRowState(undefined), { text: 'not known yet', enterable: false });
  assert.deepEqual(folders.sharedRowState([]), { text: 'nothing shared yet', enterable: true });
  assert.deepEqual(folders.sharedRowState([{ path: 'F:\\Dev' }]), { text: '1 folder shared', enterable: true });
  assert.deepEqual(
    folders.sharedRowState([{ path: 'F:\\A' }, { path: 'F:\\B' }, { path: 'F:\\C' }]),
    { text: '3 folders shared', enterable: true },
  );
  assert.deepEqual(
    folders.sharedRowState([{ path: 'F:\\A' }, { path: 'F:\\B', missing: true }, { path: 'F:\\C' }]),
    { text: '3 folders shared - 1 not on the PC', enterable: true },
  );
});

// --- S11 - buildSettingsRow, the structural guard --------------------------

function loadBuildSettingsRow() {
  const js = read('app.js');
  const start = js.indexOf('function buildSettingsRow(');
  const end = js.indexOf('function renderSettings(');
  const src = js.slice(start, end);
  return new Function('document', `${src}; return buildSettingsRow;`)(fakeDocument());
}

test('S11 - buildSettingsRow: enterable carries data-settings; not enterable carries no such attribute at all', () => {
  // RED WHEN: an unknown shared set becomes tappable - the picker would open
  // with sharedToTicks(null) === [] and a SAVE would write
  // { shared_folders: [] }, wiping every shared folder with no error.
  const buildSettingsRow = loadBuildSettingsRow();

  const on = buildSettingsRow({
    id: 'shared', name: 'Shared folders', state: '3 folders shared', enterable: true,
  });
  assert.equal(on.tag, 'button');
  assert.equal(on.dataset.settings, 'shared');
  // children[0] is the ICON. Lane 7 of the artifact: 'icon or control on
  // the LEFT, name and state stacked in the middle, chevron on the right.
  // No exceptions anywhere in the app.' This shipped once with an empty
  // left slot and a comment defending it - the index is pinned here so
  // removing the icon again is a test failure, not a style opinion.
  assert.equal(on.children[0].tag, 'svg', 'a settings row must lead with its icon');
  assert.equal(on.children[1].children[0].textContent, 'Shared folders');
  assert.equal(on.children[1].children[1].textContent, '3 folders shared');

  const off = buildSettingsRow({
    id: 'shared', name: 'Shared folders', state: 'not known yet', enterable: false,
  });
  assert.equal(off.tag, 'div');
  assert.equal(off.dataset.settings, undefined, 'an unenterable row must carry no data-settings attribute at all');
  assert.equal(off.children[0].tag, 'svg');
  assert.equal(off.children[1].children[0].textContent, 'Shared folders');
  assert.equal(off.children[1].children[1].textContent, 'not known yet');
  // A row that cannot be entered must not promise it can. `shared === null`
  // is the daily case here - a sleeping PC, a dropped link - so a bright
  // name and an accent chevron over a row that ignores the tap is a dead
  // control someone meets often. Two children: the icon and the stack, and
  // no third one, because the third would be the chevron.
  assert.equal(off.children.length, 2, 'an unenterable row must draw no chevron');
  assert.ok(off.className.includes('set-off'), 'an unenterable row must be muted like .share-off');
  assert.equal(on.children.length, 3, 'an enterable row draws icon, stack and chevron');
});

// --- S12 - renderSettings, the grouped root --------------------------------

function loadRenderSettings(state, buildSettingsRowImpl) {
  const js = read('app.js');
  const start = js.indexOf('function settingsGroups(');
  const end = js.indexOf('function screenAfterUnlock(');
  const src = js.slice(start, end);
  const listEl = makeEl('div');
  const doc = fakeDocument({ 'settings-list': listEl });
  const fn = new Function(
    'document', 'state', 'sharedRowState', 'buildSettingsRow', 'agentStateLine', 'SHELL_VERSION',
    `${src}; return renderSettings;`,
  );
  const renderSettings = fn(
    doc, state, folders.sharedRowState, buildSettingsRowImpl,
    (r) => (r === true ? 'reachable' : 'checking'), '0.1.0',
  );
  return { renderSettings, listEl };
}

function renderedRows(listEl) {
  // Each group is a <section> holding [header, rule, list]; the rows are in
  // the third child. Flattened so a test can assert the row ORDER across
  // groups, which is what the artifact actually fixes.
  const out = [];
  for (const section of listEl.children) out.push(...section.children[2].children);
  return out;
}

const stubRow = (opts) => {
  const el = makeEl(opts.enterable ? 'button' : 'div');
  if (opts.enterable) el.dataset.settings = opts.id;
  el.attrs.icon = opts.icon;
  el.attrs.name = opts.name;
  return el;
};

test('S12 - renderSettings draws the groups Lane 6 names, in order, each with an icon', () => {
  // RED WHEN: the root goes back to one hard-coded FOLDERS section holding a
  // single row. That is what shipped, and it is the deviation from Lane 6
  // that started this rebuild - so the shape is pinned, not just described.
  const state = { shared: [{ path: 'F:\\A' }], reachable: true };
  const { renderSettings, listEl } = loadRenderSettings(state, stubRow);
  renderSettings();

  const headings = [...listEl.children].map((sec) => sec.children[0].children[0].textContent);
  assert.deepEqual(headings, ['FOLDERS', 'SECURITY', 'THIS APP']);

  const rows = renderedRows(listEl);
  assert.deepEqual(
    rows.map((r) => r.dataset.settings),
    ['shared', 'see', 'lock', 'agent', 'reset', 'about'],
  );
  // Lane 7: 'No exceptions anywhere in the app.'
  for (const row of rows) {
    assert.ok(row.attrs.icon, `${row.attrs.name} must carry an icon`);
  }
});

test('S12b - every enterable settings row has somewhere to go', () => {
  // RED WHEN: a row is added to settingsGroups before its destination exists,
  // which is a dead control - the thing the ABSENT-not-disabled rule was
  // trying to avoid, reintroduced from the other side.
  const state = { shared: [{ path: 'F:\\A' }], reachable: true };
  const { renderSettings, listEl } = loadRenderSettings(state, stubRow);
  renderSettings();

  const js = read('app.js');
  const declStart = js.indexOf('const SETTINGS_SUBS');
  const decl = js.slice(declStart, js.indexOf(';', declStart));
  const subs = new Set([...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(subs.size > 0, 'SETTINGS_SUBS must name at least one screen');
  // The two ids that are ACTIONS rather than screens, handled in the click
  // delegate: one opens the picker, one drops the token.
  const actions = new Set(['shared', 'lock']);
  for (const row of renderedRows(listEl)) {
    const id = row.dataset.settings;
    if (id === undefined) continue;
    assert.ok(
      subs.has(id) || actions.has(id),
      `settings row '${id}' leads nowhere: it is neither a SETTINGS_SUBS screen nor a wired action`,
    );
  }
});
// --- S13 - the one door, order-checked ---------------------------------------

function loadOpenSharedFolders(closeSettingsSpy, onChooseFoldersSpy) {
  const js = read('app.js');
  const start = js.indexOf('function openSharedFolders(');
  const end = js.indexOf('function buildSettingsRow(');
  const src = js.slice(start, end);
  return new Function(
    'closeSettings', 'onChooseFolders',
    `${src}; return openSharedFolders;`,
  )(closeSettingsSpy, onChooseFoldersSpy);
}

test('S13 - openSharedFolders calls closeSettings before onChooseFolders', () => {
  // RED WHEN: swapped, closeSettings()'s showScreen('list') runs AFTER
  // showScreen('folders') and hides the picker outright the moment it opens.
  // NOT because it keeps Settings' entry from onFoldersPop - history.back()
  // is queued, so that listener is registered first and does receive the pop.
  const order = [];
  const openSharedFolders = loadOpenSharedFolders(
    () => order.push('closeSettings'),
    () => order.push('onChooseFolders'),
  );
  openSharedFolders();
  assert.deepEqual(order, ['closeSettings', 'onChooseFolders']);
});

// --- S14 - the guard T78 inherits, and its one point of entry ---------------

function loadOnChooseFolders({ shared, showFolders: showFoldersSpy }) {
  const js = read('app.js');
  const start = js.indexOf('async function onChooseFolders(');
  const end = js.indexOf('// Guarded against a double tap the same way onSave is');
  const src = js.slice(start, end);
  const fn = new Function(
    'state', 'showFolders', 'showScreen', 'load', 'sharedToTicks',
    `${src}; return onChooseFolders;`,
  );
  return fn(
    { shared },
    showFoldersSpy || (async () => {}),
    () => {},
    async () => {},
    folders.sharedToTicks,
  );
}

test('S14 - onChooseFolders never enters the picker blind, and showFolders( has exactly two call sites', async () => {
  // RED WHEN: a second call site into the picker skips the guard. This is
  // what T78 inherits instead of re-implementing.
  let entered = false;
  const onChooseFolders = loadOnChooseFolders({ shared: null, showFolders: async () => { entered = true; } });
  await onChooseFolders();
  assert.equal(entered, false, 'a null shared set must never open the picker');

  const js = read('app.js');
  const callSites = [...js.matchAll(/showFolders\(/g)].filter((m) => {
    const before = js.slice(Math.max(0, m.index - 9), m.index);
    return before !== 'function ';
  });
  assert.equal(callSites.length, 2, 'showFolders( must appear in exactly two call sites - ensureAccepted and onChooseFolders');
});

// --- S16 - CSS: the settings screen fills the column, the mark stays lit ---

test('S16 - app.css: #settings is a flex column with flex-grow: 1, and .title still declares its own color', () => {
  // RED WHEN: .spacer stops pushing the settings screen's content, or the UA
  // :disabled grey reaches the wordmark on the lock screen - design/tokens.md
  // forbids a muted mark, in those words.
  const css = read('app.css');
  assert.match(css, /#settings\s*\{[^}]*flex-grow:\s*1[^}]*\}/);
  const titleRule = css.match(/\.title\s*\{[^}]*\}/);
  assert.ok(titleRule, '.title must have its own rule');
  assert.match(titleRule[0], /color:\s*var\(--text\)/);
});

test('S17 - the inert-row muting rule outranks .row.folder, or it does nothing at all', () => {
  // RED WHEN: the selector is shortened to `.set-off .row-name`.
  // A settings row's classes are `row folder set-off`. A bare `.set-off
  // .row-name` is (0,2,0) and LOSES to `.row.folder .row-name` (0,3,0), so the
  // rule is dead and the row keeps the bright enterable colour while three
  // comments claim otherwise. That shipped once in this task and a browser
  // measurement caught it, not this suite - which is why the selector is
  // pinned here rather than only described.
  // `.share-off` gets away with the short form because those rows carry
  // `share-row share-off` and have no `.row.folder` to outrank; copying its
  // selector without its class context is the exact mistake this guards.
  const css = read('app.css').split(String.fromCharCode(13)).join('');
  const match = css.match(/^([^\n{]*\.set-off[^\n{]*)\{/m);
  assert.ok(match, 'the inert settings row must have a muting rule');
  const selector = match[1].trim();
  // Must still START with .row.folder so it outranks `.row.folder
  // .row-name` (0,3,0); extra classes after that only raise specificity
  // further, so the prefix is the real assertion and not the exact string.
  assert.ok(
    selector.startsWith('.row.folder') && selector.includes('.set-off'),
    `the muting rule must outrank .row.folder .row-name; found "${selector}"`,
  );
  // The selector alone is not the whole claim: keeping it while changing the
  // colour back to the enterable one would leave this green and the row bright
  // again. Pin the value too. A source scan still cannot prove the CASCADE -
  // only a browser can, which is why a colour claim gets measured at review.
  assert.match(match[0] + css.slice(css.indexOf(match[0]) + match[0].length, css.indexOf(match[0]) + match[0].length + 40), /var\(--dim\)/);
});
