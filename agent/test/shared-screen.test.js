// T78/Lane 3 - the Shared folders screen, and Lane 8's remove X on it.
// The row shapes and the confirmation copy are pure (folders-ui.js) and are
// imported directly; the screen itself is sliced out of app.js and run under
// a small stub DOM, the same idiom as settings.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  sharedFolderRows, stopSharingPrompt, withoutRoot,
  rootEditRows, excludesFrom, withRootExcludes, orphanWarning, projectSections,
} from '../public/folders-ui.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

const WORKSPACE = 'F:\\Dev\\Projects\\Workspace';
const WORK = 'D:\\Work\\client-api';

const container = (p) => ({ path: p, mode: 'container', excludes: [], new_folders: 'show' });
const single = (p) => ({ path: p, mode: 'single', excludes: [], new_folders: 'show' });
const projectsIn = (root, n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, root }));

// --- the row shapes -------------------------------------------------------

test('L1 - a container root reads "<parent> · N projects", counted from the projects the agent actually returned', () => {
  // RED WHEN: the count is taken from anything but /api/projects. The
  // artifact's "3 of 14" needs a denominator no payload carries, so the
  // numerator has to be the real one or the line means nothing.
  const rows = sharedFolderRows([container(WORKSPACE)], projectsIn(WORKSPACE, 3));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Workspace');
  assert.equal(rows[0].state, 'F:\\Dev\\Projects · 3 projects');
  assert.equal(rows[0].projectCount, 3);
  assert.equal(rows[0].missing, false);
});

test('L2 - the count is per root, never the whole project list', () => {
  // RED WHEN: every row shows the total number of projects, so two shared
  // folders both claim all of them.
  const rows = sharedFolderRows(
    [container(WORKSPACE), container('D:\\Work')],
    [...projectsIn(WORKSPACE, 3), ...projectsIn('D:\\Work', 6)],
  );
  assert.equal(rows[0].projectCount, 3);
  assert.equal(rows[1].projectCount, 6);
});

test('L3 - the count is case- and trailing-separator tolerant, like every other path compare here', () => {
  // RED WHEN: the count is keyed on a raw string. The agent reports config
  // paths verbatim and project roots canonicalised, so the two spellings meet
  // here and a plain === silently reports 0 projects for a shared folder.
  const rows = sharedFolderRows([container('F:\\Dev\\Projects\\Workspace\\')], projectsIn('f:\\dev\\projects\\workspace', 2));
  assert.equal(rows[0].projectCount, 2);
});

test('L4 - one project is singular', () => {
  const rows = sharedFolderRows([container(WORKSPACE)], projectsIn(WORKSPACE, 1));
  assert.equal(rows[0].state, 'F:\\Dev\\Projects · 1 project');
});

test('L5 - a single-folder root says so and counts nothing', () => {
  // RED WHEN: a `single` root is walked for children. It has none by
  // definition - it IS the project - so a count there is always 0 and reads
  // as an empty folder.
  const rows = sharedFolderRows([single(WORK)], []);
  assert.equal(rows[0].name, 'client-api');
  assert.equal(rows[0].state, 'D:\\Work · this folder only');
  assert.equal(rows[0].projectCount, null);
});

test('L6 - a missing root says "not found" and nothing else', () => {
  // RED WHEN: a folder that is not there reports "0 projects", which reads as
  // an empty folder rather than an absent one - the distinction Lane 4 is
  // entirely about.
  const rows = sharedFolderRows([{ ...container(WORKSPACE), missing: true }], []);
  assert.equal(rows[0].missing, true);
  assert.equal(rows[0].state, 'F:\\Dev\\Projects · not found');
});

test('L7 - a root sitting directly on a drive has no parent to name', () => {
  // RED WHEN: crumbSegments' synthetic DRIVES entry is treated as a parent
  // and the row reads "DRIVES · 2 projects".
  const rows = sharedFolderRows([container('F:\\Dev')], projectsIn('F:\\Dev', 2));
  assert.equal(rows[0].state, 'F: · 2 projects');
  const atRoot = sharedFolderRows([container('F:\\')], []);
  assert.equal(atRoot[0].state, '0 projects', 'a drive root has no parent segment at all');
});

test('L8 - an unknown shared set is no rows, not an empty one', () => {
  assert.deepEqual(sharedFolderRows(null, []), []);
  assert.deepEqual(sharedFolderRows(undefined, null), []);
});

// --- the confirmation copy ------------------------------------------------

test('L9 - the confirmation names the folder, what disappears, and what does not', () => {
  // RED WHEN: "Nothing on disk is touched" is dropped. It is the sentence
  // that makes a red button safe to press, and the artifact spells it out.
  const [workspace] = sharedFolderRows([container(WORKSPACE)], projectsIn(WORKSPACE, 3));
  assert.equal(
    stopSharingPrompt(workspace),
    'Stop sharing Workspace? Its 3 projects disappear from the app. Nothing on disk is touched.',
  );

  const [one] = sharedFolderRows([container(WORKSPACE)], projectsIn(WORKSPACE, 1));
  assert.match(stopSharingPrompt(one), /Its 1 project disappears/);

  const [only] = sharedFolderRows([single(WORK)], []);
  assert.equal(
    stopSharingPrompt(only),
    'Stop sharing client-api? It disappears from the app. Nothing on disk is touched.',
  );

  const [gone] = sharedFolderRows([{ ...container(WORKSPACE), missing: true }], []);
  assert.match(stopSharingPrompt(gone), /already gone from the PC/);
});

// --- the screen -----------------------------------------------------------

function makeEl(tag) {
  return {
    tag,
    className: '',
    hidden: false,
    disabled: false,
    dataset: {},
    children: [],
    attrs: {},
    _text: '',
    appendChild(child) { this.children.push(child); return child; },
    cloneNode() { return makeEl(this.tag); },
    classList: { add() {}, remove() {} },
    querySelector() { return this._use || (this._use = makeEl('use')); },
    setAttribute(k, v) { this.attrs[k] = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this.children = []; },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = v; this.children = []; },
  };
}

function fakeDocument() {
  const registry = new Map();
  const tpl = makeEl('template');
  tpl.content = { firstElementChild: makeEl('svg') };
  registry.set('tpl-row-ico', tpl);
  return {
    createElement: (tag) => makeEl(tag),
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeEl('div'));
      return registry.get(id);
    },
  };
}

function loadScreen({ shared, projects, removeRoot } = {}) {
  const js = read('app.js').replace(/\r/g, '');
  const src = js.slice(js.indexOf('let pendingRemoval = null;'), js.indexOf('function buildSettingsRow('));
  const doc = fakeDocument();
  const state = { shared: shared ?? null, projects: projects ?? [] };
  const calls = { removed: [], renderSettings: 0, load: 0 };
  const fn = new Function(
    'document', 'state', 'sharedFolderRows', 'stopSharingPrompt', 'removeRoot',
    'shareErrorMessage', 'renderSettings', 'load', 'showScreen', 'render',
    'history', 'onChooseFolders',
    `${src}
     return { renderSharedScreen, askStopSharing, cancelStopSharing, confirmStopSharing };`,
  );
  const mod = fn(
    doc, state, sharedFolderRows, stopSharingPrompt,
    removeRoot || (async (p) => { calls.removed.push(p); return { ok: true, status: 200 }; }),
    (code, status) => ({ text: `err:${code}`, index: null }),
    () => { calls.renderSettings += 1; },
    () => { calls.load += 1; },
    () => {}, () => {}, { go() {} }, () => {},
  );
  return { ...mod, doc, state, calls };
}

const rowsOf = (doc) => doc.getElementById('shared-rows').children;

test('L10 - the screen draws one row per shared root, each carrying its own remove X', () => {
  // RED WHEN: the remove control goes missing, which is the only thing this
  // screen can DO to a root until Lane 3's "Editing one" is built.
  const s = loadScreen({ shared: [container(WORKSPACE), single(WORK)], projects: projectsIn(WORKSPACE, 3) });
  s.renderSharedScreen();

  const rows = rowsOf(s.doc);
  assert.equal(rows.length, 2);
  const removes = rows.map((r) => r.children.find((c) => c.dataset.sharedRemove));
  assert.deepEqual(removes.map((r) => r.dataset.sharedRemove), [WORKSPACE, WORK]);
  assert.match(removes[0].attrs['aria-label'], /^Stop sharing Workspace$/);
});

test('L11 - no row carries a chevron, because the per-root edit screen is not built', () => {
  // RED WHEN: the artifact's chevron is copied across before Lane 3's
  // "Editing one" exists - a control that answers a tap with nothing, which
  // is exactly what buildSettingsRow's enterable/inert split forbids.
  const s = loadScreen({ shared: [container(WORKSPACE)], projects: [] });
  s.renderSharedScreen();
  const js = read('app.js');
  const fnSrc = js.slice(js.indexOf('function buildSharedRow('), js.indexOf('function renderRemovalConfirm('));
  assert.ok(!/i-chev/.test(fnSrc), 'a row must not draw a chevron it cannot honour');
  assert.ok(!/dataset\.settings/.test(fnSrc), 'a row must not be wired as an enterable settings row');
});

test('L12 - the gone banner appears only when the agent reports a root missing', () => {
  const fine = loadScreen({ shared: [container(WORKSPACE)], projects: [] });
  fine.renderSharedScreen();
  assert.equal(fine.doc.getElementById('shared-gone').hidden, true);

  const bad = loadScreen({ shared: [{ ...container(WORKSPACE), missing: true }], projects: [] });
  bad.renderSharedScreen();
  const banner = bad.doc.getElementById('shared-gone');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /no longer there/);
  assert.match(banner.textContent, /moved, renamed or deleted/);
});

test('L13 - the X asks before it removes, and CANCEL writes nothing', () => {
  // RED WHEN: the X removes on the first tap. It is destructive and the
  // artifact is explicit that it asks.
  const s = loadScreen({ shared: [container(WORKSPACE)], projects: projectsIn(WORKSPACE, 3) });
  s.renderSharedScreen();
  assert.equal(s.doc.getElementById('shared-confirm').hidden, true, 'nothing is asked until the X is tapped');

  s.askStopSharing(WORKSPACE);
  assert.equal(s.doc.getElementById('shared-confirm').hidden, false);
  assert.match(s.doc.getElementById('shared-confirm-text').textContent, /^Stop sharing Workspace\?/);
  assert.deepEqual(s.calls.removed, [], 'asking must not write');

  s.cancelStopSharing();
  assert.equal(s.doc.getElementById('shared-confirm').hidden, true);
  assert.deepEqual(s.calls.removed, [], 'CANCEL must write nothing at all');
});

test('L14 - confirming removes exactly that root and refreshes what depends on it', async () => {
  const s = loadScreen({ shared: [container(WORKSPACE), single(WORK)], projects: projectsIn(WORKSPACE, 3) });
  s.renderSharedScreen();
  s.askStopSharing(WORKSPACE);
  await s.confirmStopSharing();

  assert.deepEqual(s.calls.removed, [WORKSPACE]);
  assert.equal(s.doc.getElementById('shared-confirm').hidden, true, 'the panel closes on success');
  assert.equal(s.calls.renderSettings, 1, "the settings root's own row carries the count");
  assert.equal(s.calls.load, 1, 'the project list loses that root\'s projects');
});

test('L15 - a refused removal keeps the root and says why ON THIS SCREEN', async () => {
  // RED WHEN: the failure is reported through the project list's banner,
  // which is behind this screen and cannot be seen from it.
  const removeRoot = async () => ({ ok: false, status: 500, code: 'write_failed' });
  const s = loadScreen({ shared: [container(WORKSPACE)], projects: [], removeRoot });
  s.renderSharedScreen();
  s.askStopSharing(WORKSPACE);
  await s.confirmStopSharing();

  assert.equal(s.doc.getElementById('shared-msg').textContent, 'err:write_failed');
  assert.equal(s.doc.getElementById('shared-confirm').hidden, false, 'the question stands until it is answered');
});

test('L16 - a 401 says nothing here: api.js has already re-locked the app', async () => {
  // RED WHEN: an expired token paints an error on a screen that is being
  // replaced by the passcode gate in the same tick.
  const removeRoot = async () => ({ ok: false, status: 401, code: 'unauthorized' });
  const s = loadScreen({ shared: [container(WORKSPACE)], projects: [], removeRoot });
  s.renderSharedScreen();
  s.askStopSharing(WORKSPACE);
  await s.confirmStopSharing();
  assert.equal(s.doc.getElementById('shared-msg').textContent, '');
});

test('L17 - a second confirm while one write is in flight is ignored', async () => {
  // RED WHEN: removeRoot's in-flight guard is bypassed here. Two PUTs racing
  // the same config is how one of them wins with a stale set.
  const s = loadScreen({ shared: [container(WORKSPACE)], projects: [], removeRoot: async () => null });
  s.renderSharedScreen();
  s.askStopSharing(WORKSPACE);
  await s.confirmStopSharing();
  // null means "already writing" - the screen must not treat it as success.
  assert.equal(s.doc.getElementById('shared-confirm').hidden, false);
  assert.equal(s.calls.load, 0);
});

test('L18 - removing a root preserves every other root byte for byte', () => {
  // RED WHEN: the removal rebuilds the surviving entries and quietly rewrites
  // a sibling's mode or drops its excludes - a data-loss bug wearing the
  // costume of a tidy-up.
  const shared = [
    { path: WORKSPACE, mode: 'container', excludes: ['Archive'], new_folders: 'hide' },
    { path: WORK, mode: 'single', excludes: [], new_folders: 'show' },
  ];
  assert.deepEqual(withoutRoot(shared, WORK), {
    shared_folders: [{ path: WORKSPACE, mode: 'container', excludes: ['Archive'], new_folders: 'hide' }],
  });
});

// --- the markup -----------------------------------------------------------

test('L19 - the screen carries the crumb, the add button and the artifact\'s note', () => {
  const html = read('index.html');
  const start = html.indexOf('<main id="set-shared"');
  assert.ok(start !== -1, 'index.html must contain <main id="set-shared">');
  const screen = html.slice(start, html.indexOf('</main>', start));
  assert.match(screen, /data-set-back/, 'every sub-screen names the screen it returns to');
  assert.match(screen, /ADD A FOLDER/);
  assert.match(screen, /Opens the drive list, the same one used on first run\./);
  assert.match(screen, /STOP SHARING/);
  assert.match(screen, /CANCEL/);
});

// --- Lane 8, first half: the picker's tick ---------------------------------

test('L20 - the drawn tick sits over a REAL checkbox, hidden by opacity only', () => {
  // RED WHEN: the input is display:none'd, or replaced by a role="checkbox"
  // span. Either takes the control out of the tab order and off the
  // accessibility tree, which is the whole cost the owner chose to avoid.
  const css = read('app.css');
  const inputRule = css.match(/\.share-tick input \{[^}]*\}/);
  assert.ok(inputRule, 'app.css must carry a .share-tick input rule');
  assert.match(inputRule[0], /opacity:\s*0/, 'the input is hidden visually');
  assert.ok(!/display:\s*none/.test(inputRule[0]), 'display:none would remove it from the tab order');
  assert.ok(!/visibility:\s*hidden/.test(inputRule[0]), 'visibility:hidden would remove it from the a11y tree');

  const js = read('app.js');
  const build = js.slice(js.indexOf('function buildTickableRow('), js.indexOf('function renderShare('));
  assert.match(build, /input\.type = 'checkbox'/, 'the real control must still be an input');
  assert.ok(!/role: ?'checkbox'|role', 'checkbox'/.test(build), 'no hand-rolled checkbox role');
  // The drawn box itself lives in buildChk, shared with Lane 3's per-folder
  // editor so the two screens cannot drift into different-looking checkboxes.
  const chk = js.slice(js.indexOf('function buildChk('), js.indexOf('function buildTickableRow('));
  assert.match(chk, /chk\.setAttribute\('aria-hidden', 'true'\)/, 'the drawn box must not be announced twice');
});

test('L21 - both glyphs ship in the DOM and CSS picks one, so a toggle is a paint', () => {
  // RED WHEN: the glyph is swapped in JS on toggle. Rebuilding the node
  // restarts nothing and cancels the animation the artifact specifies - the
  // tick would jump rather than scale.
  const js = read('app.js');
  const chk = js.slice(js.indexOf('function buildChk('), js.indexOf('function buildTickableRow('));
  assert.match(chk, /\['#i-check', '#i-x'\]/, 'both glyphs are built up front');

  const css = read('app.css');
  assert.match(css, /\.share-tick input:checked \+ \.chk \.chk-tick \{[^}]*opacity: 1/);
  assert.match(css, /\.share-tick input:not\(:checked\) \+ \.chk \.chk-x \{[^}]*opacity: 1/);
});

test('L22 - the tick animation moves the GLYPH now, not the whole control', () => {
  // RED WHEN: the tick-pop rule is left on the input. The input is invisible
  // now, so animating it animates nothing at all - the motion the artifact
  // asks for would silently disappear while the suite stayed green.
  const css = read('app.css');
  const popped = css.match(/^\.share-tick[^\n]*animation: tick-pop[^\n]*$/m);
  assert.ok(popped, 'app.css must animate something with tick-pop');
  assert.match(popped[0], /\.chk-tick/, 'tick-pop must be applied to the drawn glyph');
  assert.ok(!/\.share-tick input:checked \{ animation/.test(css), 'the invisible input must not be the animated thing');
});

test('L23 - a row you are not allowed to tick shows neither glyph', () => {
  // RED WHEN: a covered row draws the X. "Deliberately off" and "not yours to
  // set" are different states, and Lane 8 only gives the X the first meaning.
  const css = read('app.css');
  const disabled = css.match(/\.share-tick input:disabled \+ \.chk \{[^}]*\}/);
  assert.ok(disabled, 'app.css must carry a disabled .chk rule');
  assert.match(disabled[0], /color: transparent/);
  assert.match(css, /\.share-tick input:disabled \+ \.chk \.chk-x \{[^}]*opacity: 0/);
});

test('L24 - the focus ring moves to the drawn box, since the real one is invisible', () => {
  // RED WHEN: the ring is left on the transparent input and a keyboard user
  // has no idea which row they are on.
  const css = read('app.css');
  assert.match(css, /\.share-tick input:focus-visible \+ \.chk \{[^}]*outline:/);
});

// --- Lane 3, step 2: editing one shared folder -----------------------------

const folder = (name) => ({ name, path: `${WORKSPACE}\\${name}`, readable: true });

test('L25 - the child list comes from the folder, so an EXCLUDED child is still shown, unticked', () => {
  // RED WHEN: the screen is built from state.projects. An excluded child is
  // filtered out server-side, so it would simply be missing - and the one
  // thing this screen exists for is switching it back on.
  const rows = rootEditRows(
    [folder('claude-remote'), folder('email-lint'), folder('Orchard')],
    ['Orchard'],
    [],
  );
  assert.deepEqual(rows.map((r) => [r.name, r.ticked]), [
    ['claude-remote', true], ['email-lint', true], ['Orchard', false],
  ]);
});

test('L26 - excludes are matched without case, the way the agent stores and walks them', () => {
  const rows = rootEditRows([folder('Orchard')], ['orchard'], []);
  assert.equal(rows[0].ticked, false);
});

test('L27 - a folder with a live session is marked, ticked or not', () => {
  const rows = rootEditRows([folder('claude-remote'), folder('email-lint')], [], ['claude-remote']);
  assert.equal(rows[0].running, true);
  assert.equal(rows[1].running, false);
});

test('L28 - unticking a running folder WARNS, and never blocks', () => {
  // RED WHEN: the save is vetoed instead. The artifact is explicit that it
  // warns, because "silently orphaning a live session is a bug in a costume" -
  // and a veto is a different bug, one that traps the owner.
  const rows = rootEditRows([folder('claude-remote'), folder('email-lint')], [], ['claude-remote']);
  assert.equal(orphanWarning(rows), null, 'nothing to say while it is still shared');

  rows[0].ticked = false;
  assert.equal(orphanWarning(rows), 'claude-remote has a session running. Unsharing it will not stop it.');

  rows[1].running = true;
  rows[1].ticked = false;
  assert.match(orphanWarning(rows), /^2 of these have sessions running\./);

  // Words are all it returns - there is no veto anywhere in the shape.
  assert.equal(typeof orphanWarning(rows), 'string');
});

test('L29 - SAVE writes this root\'s excludes and leaves every sibling byte for byte', () => {
  // RED WHEN: saving one folder rewrites another's mode or drops its
  // excludes - the same data-loss class withoutRoot exists to prevent.
  const shared = [
    { path: WORKSPACE, mode: 'container', excludes: ['old'], new_folders: 'show' },
    { path: WORK, mode: 'single', excludes: ['keep-me'], new_folders: 'hide' },
  ];
  const rows = rootEditRows([folder('a'), folder('b')], [], []);
  rows[1].ticked = false;

  assert.deepEqual(excludesFrom(rows), ['b']);
  assert.deepEqual(withRootExcludes(shared, WORKSPACE, excludesFrom(rows)), {
    shared_folders: [
      { path: WORKSPACE, mode: 'container', excludes: ['b'], new_folders: 'show' },
      { path: WORK, mode: 'single', excludes: ['keep-me'], new_folders: 'hide' },
    ],
  });
});

// BEHAVIOUR CHANGED 2026-09-05, review pass 7. This asserted that an absent
// root is "left exactly as it was" - an identical body. That is what the
// docblock said, and it is what made the bug: the PUT then returns 200 and
// saveRootEdit reports a clean save and closes the screen, with the owner's
// edit silently thrown away. Reachable whenever state.shared is refreshed
// between opening the editor and saving and no longer holds this root - a root
// removed from another client, or dropped by usableRoots' filters.
// "Not found" and "done" must not look alike. The old test pinned the
// behaviour, not a decision: it carried no rationale for preferring silence.
test('L30 - a root this app does not hold returns NULL, so the caller cannot report a false save', () => {
  const shared = [{ path: WORKSPACE, mode: 'container', excludes: ['x'], new_folders: 'show' }];
  assert.equal(withRootExcludes(shared, 'D:\\Nope', ['y']), null);
});

test('L30b - a root that IS held still edits normally, so the guard is not over-firing', () => {
  const shared = [{ path: WORKSPACE, mode: 'container', excludes: ['x'], new_folders: 'show' }];
  assert.deepEqual(withRootExcludes(shared, WORKSPACE, ['y']), {
    shared_folders: [{ path: WORKSPACE, mode: 'container', excludes: ['y'], new_folders: 'show' }],
  });
});

test('L31 - the editor row draws a tick and a name, and no chevron', () => {
  // RED WHEN: buildTickableRow is reused wholesale. It always draws the
  // picker's drill button, and there is nowhere deeper to go from this screen.
  const js = read('app.js');
  const src = js.slice(js.indexOf('function buildRootRow('), js.indexOf('function toggleRootTick('));
  assert.match(src, /buildChk\(\)/, 'it must draw the same tick control as the picker');
  assert.ok(!/folder-chev|share-open|data-open/.test(src), 'no drill control may appear on this row');
  assert.match(src, /dataset\.rootTick/, 'the tick carries this screen\'s own attribute');
  assert.ok(!/dataset\.tick\b/.test(src), 'it must not answer to the picker\'s handler');
});

// --- Lane 9: home grouped by folder ---------------------------------------

const proj = (name, root, rootName) => ({ name, root, rootName });

test('L32 - one section per shared folder, named after the folder, in config order', () => {
  const sections = projectSections(
    [proj('a', WORKSPACE, 'Workspace'), proj('b', 'D:\\Work', 'Work'), proj('c', WORKSPACE, 'Workspace')],
    [container('D:\\Work'), container(WORKSPACE)],
    [],
    () => false,
  );
  assert.deepEqual(sections.map((s) => s.name), ['Work', 'Workspace'], 'config order, not project order');
  assert.deepEqual(sections.map((s) => s.total), [1, 2]);
});

test('L33 - a lone section is always open, so a single-folder install looks as it always did', () => {
  // RED WHEN: the collapse rule is applied uniformly and the owner's whole
  // list disappears behind one tap. That is the exact snag Lane 9 names.
  const sections = projectSections([proj('a', WORKSPACE, 'Workspace')], [container(WORKSPACE)], [], () => false);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].open, true, 'a single section ignores the open list entirely');
});

test('L34 - with two folders, only the ones asked for are open', () => {
  const shared = [container(WORKSPACE), container('D:\\Work')];
  const projects = [proj('a', WORKSPACE, 'Workspace'), proj('b', 'D:\\Work', 'Work')];
  const closed = projectSections(projects, shared, [], () => false);
  assert.deepEqual(closed.map((s) => s.open), [false, false]);

  const one = projectSections(projects, shared, ['Workspace'], () => false);
  assert.deepEqual(one.map((s) => [s.name, s.open]), [['Workspace', true], ['Work', false]]);
});

test('L35 - each header counts its OWN running sessions, never the whole app\'s', () => {
  const shared = [container(WORKSPACE), container('D:\\Work')];
  const projects = [proj('a', WORKSPACE, 'Workspace'), proj('b', WORKSPACE, 'Workspace'), proj('c', 'D:\\Work', 'Work')];
  const sections = projectSections(projects, shared, [], (p) => p.name === 'a' || p.name === 'c');
  assert.deepEqual(sections.map((s) => [s.name, s.running, s.total]), [['Workspace', 1, 2], ['Work', 1, 1]]);
});

test('L36 - a shared folder with no projects still gets its section', () => {
  // RED WHEN: sections are derived from projects alone, and an empty shared
  // folder vanishes from the app with nothing to say it is still shared.
  const sections = projectSections([], [container(WORKSPACE)], [], () => false);
  assert.deepEqual(sections.map((s) => [s.name, s.total]), [['Workspace', 0]]);
});

test('L37 - a missing root gets no section: its notice is the project list\'s job', () => {
  const sections = projectSections([], [{ ...container(WORKSPACE), missing: true }], [], () => false);
  assert.deepEqual(sections, []);
});

test('L38 - a project whose root is not shared still appears rather than vanishing', () => {
  // RED WHEN: only shared roots make sections, and a hand-edited config makes
  // a project disappear from the app with no explanation. The list must show
  // what the agent actually returned.
  const sections = projectSections([proj('orphan', 'D:\\Elsewhere', 'Elsewhere')], [], [], () => false);
  assert.deepEqual(sections.map((s) => [s.name, s.total]), [['Elsewhere', 1]]);
});

test('L39 - a row with no root makes no section, nameless or otherwise', () => {
  // RED WHEN: synthetic desk-session rows reach the grouping. They carry no
  // root, so they produced a section with an empty name - or, on an
  // unparseable path, one labelled DRIVES. Found in a browser, not by the
  // suite: a header with no name is invisible to an assertion that only
  // counts rows. They are already tiles in the running zone, so skipping
  // them here loses nothing.
  const sections = projectSections(
    [proj('a', WORKSPACE, 'Workspace'), { name: 'Archive' }, { name: 'x', root: '' }],
    [container(WORKSPACE)],
    [],
    () => false,
  );
  assert.deepEqual(sections.map((s) => s.name), ['Workspace']);
  assert.equal(sections[0].total, 1, 'the rootless rows must not be counted into a real folder either');
});
