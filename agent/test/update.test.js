// T82/T85 - Lane 5, updates. The detection and the wording are pure
// (update-ui.js) and imported directly; the screen and the two dots are
// sliced out of app.js and run under a small stub DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  updateAvailable, releaseOf, releaseLines, readyLine, fallbackReadyLine, aboutRowState, updateWaiting,
} from '../public/update-ui.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
const REPO = fileURLToPath(new URL('../../', import.meta.url));

const status = (version, release) => (release ? { version, release } : { version });

// --- detection ------------------------------------------------------------

test('U1 - an update is a version the agent reports that this cached shell does not match', () => {
  // RED WHEN: the comparison drifts to anything else. The Decided table is
  // exact: "the phone's cached shell is older than the agent."
  assert.equal(updateAvailable('0.1.0', status('0.2.0')), true);
  assert.equal(updateAvailable('0.1.0', status('0.1.0')), false);
});

test('U2 - nothing known means no update, never a dot on a guess', () => {
  // RED WHEN: an unanswered or malformed status shows a marker. It sends
  // someone to a screen with nothing on it, and the dot is the app's only
  // claim that there is news.
  for (const bad of [null, undefined, {}, { version: '' }, { version: 7 }]) {
    assert.equal(updateAvailable('0.1.0', bad), false, JSON.stringify(bad));
  }
  assert.equal(updateAvailable(null, status('0.2.0')), false, 'no shell version is not an update either');
});

test('U3 - the check reaches nothing off this machine', () => {
  // RED WHEN: someone makes this poll GitHub for a version. The Decided table
  // forbids it outright - it would break "nothing leaves this machine" for
  // every user of the repo, and Claude Code's plugin system already does it.
  // Checks the CALL, not the word: the module's own comments name fetch and
  // GitHub to explain why neither is here, and a substring ban on those would
  // fail on the explanation rather than on the behaviour.
  const src = read('update-ui.js');
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'import ']) {
    assert.ok(!code.includes(forbidden), `update-ui.js must not contain ${forbidden}`);
  }
});

// --- the words ------------------------------------------------------------

test('U4 - the ready line names both versions, the artifact\'s way round', () => {
  assert.equal(readyLine({ version: '1.1' }, '1.0.0'), 'Version 1.1 is ready. You are on 1.0.0.');
});

test('U5 - the About row switches to the waiting version, and says so in the accent', () => {
  assert.deepEqual(aboutRowState('0.1.0', status('0.1.0')), { text: '0.1.0', update: false });
  assert.deepEqual(aboutRowState('0.1.0', status('0.2.0')), { text: 'version 0.2.0 available', update: true });
  assert.deepEqual(aboutRowState('0.1.0', null), { text: '0.1.0', update: false });
});

test('U6 - a note marked "~ " is a change, everything else is an addition, and the mark is not words', () => {
  // RED WHEN: the mark is left in the text and every line reads "+ + ...".
  assert.deepEqual(releaseLines(['Folders can be picked from the phone']), [
    { mark: '+', text: 'Folders can be picked from the phone' },
  ]);
  assert.deepEqual(releaseLines(['~ Faster start when the PC has just booted']), [
    { mark: '~', text: 'Faster start when the PC has just booted' },
  ]);
  assert.deepEqual(releaseLines(['+ Notifications when a session needs you']), [
    { mark: '+', text: 'Notifications when a session needs you' },
  ]);
});

test('U7 - a note that is not usable text is dropped, not drawn empty', () => {
  assert.deepEqual(releaseLines(['', '   ', null, 7, {}, 'real']), [{ mark: '+', text: 'real' }]);
  assert.deepEqual(releaseLines(null), []);
});

test('U8 - a malformed release is no release, so the screen never half-draws', () => {
  assert.equal(releaseOf(null), null);
  assert.equal(releaseOf({ version: '1.1' }), null, 'no release key');
  assert.equal(releaseOf({ release: { version: '1.1' } }), null, 'no notes');
  assert.equal(releaseOf({ release: { version: '1.1', notes: [] } }), null, 'empty notes');
  assert.equal(releaseOf({ release: { notes: ['x'] } }), null, 'no version');
  assert.deepEqual(releaseOf({ release: { version: '1.1', notes: ['x'] } }), { version: '1.1', notes: ['x'] });
});

test('U9 - the repo\'s own release-notes.json survives releaseLines unchanged in substance', () => {
  // RED WHEN: the parser mangles the real file - the one the agent serves and
  // `gh release create --notes-file` renders from.
  const notes = JSON.parse(fs.readFileSync(path.join(REPO, 'release-notes.json'), 'utf8'));
  const lines = releaseLines(notes[0].notes);
  assert.equal(lines.length, notes[0].notes.length, 'no note may be dropped');
  for (const line of lines) {
    assert.ok(line.text.length > 0);
    assert.ok(['+', '~'].includes(line.mark));
  }
});

// --- the screen and the dots ----------------------------------------------

function makeEl(tag) {
  return {
    tag,
    className: '',
    hidden: false,
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

function loadUpdateScreen(statusValue, shellVersion = '0.1.0', stale = false) {
  const js = read('app.js').replace(/\r/g, '');
  const src = js.slice(js.indexOf('function renderUpdateDot('), js.indexOf('function installUpdate('));
  const doc = fakeDocument();
  const state = { status: statusValue, shellStale: stale };
  const fn = new Function(
    'document', 'state', 'SHELL_VERSION', 'updateAvailable', 'releaseOf', 'releaseLines', 'readyLine',
    // The heading for "a build is ready but the agent has not said which".
    // Reachable since the dot stopped depending on status, so the screen can
    // be opened with the PC asleep.
    'fallbackReadyLine',
    'updateWaiting',
    `${src}; return { renderUpdateDot, renderUpdate };`,
  );
  const mod = fn(doc, state, shellVersion, updateAvailable, releaseOf, releaseLines, readyLine, fallbackReadyLine, updateWaiting);
  return { ...mod, doc };
}

test('U10 - the dot appears only when there is something to see', () => {
  const none = loadUpdateScreen(status('0.1.0'));
  none.renderUpdateDot();
  assert.equal(none.doc.getElementById('update-dot').hidden, true);

  const waiting = loadUpdateScreen(status('0.2.0'));
  waiting.renderUpdateDot();
  assert.equal(waiting.doc.getElementById('update-dot').hidden, false);

  const unknown = loadUpdateScreen(null);
  unknown.renderUpdateDot();
  assert.equal(unknown.doc.getElementById('update-dot').hidden, true, 'an unanswered agent is not an update');

  // A shell that changed with NO version bump - the case the version
  // comparison alone is blind to, and the one that actually happens between
  // releases. The owner hit exactly this: a new build served, an identical
  // screen, and nothing to tell him.
  const newBuild = loadUpdateScreen(status('0.1.0'), '0.1.0', true);
  newBuild.renderUpdateDot();
  assert.equal(newBuild.doc.getElementById('update-dot').hidden, false, 'a new shell must light the dot');
});

test('U11 - the update screen draws the ready line and one row per note, marked', () => {
  const s = loadUpdateScreen(status('0.2.0', {
    version: '0.2.0',
    notes: ['Folders can be picked from the phone', '~ Faster start when the PC has just booted'],
  }));
  s.renderUpdate();

  assert.equal(s.doc.getElementById('update-ready').textContent, 'Version 0.2.0 is ready. You are on 0.1.0.');
  const notes = s.doc.getElementById('update-notes').children;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].children[0].textContent, '+');
  assert.match(notes[0].children[0].className, /add/);
  assert.equal(notes[0].children[1].textContent, 'Folders can be picked from the phone');
  assert.equal(notes[1].children[0].textContent, '~');
  assert.match(notes[1].children[0].className, /chg/);
});

test('U12 - an agent with no readable release notes still says which version is ready', () => {
  // RED WHEN: the screen renders an empty "What changed" list under a
  // confident heading, or throws on a missing release key.
  const s = loadUpdateScreen(status('0.2.0'));
  s.renderUpdate();
  assert.equal(s.doc.getElementById('update-ready').textContent, 'Version 0.2.0 is ready. You are on 0.1.0.');
  assert.equal(s.doc.getElementById('update-notes').children.length, 0);
});

test('U12b - a build ready with the PC asleep does not print "Version null"', () => {
  // Reachable since the dot stopped depending on the agent: the service
  // worker swaps a shell in, the PC then sleeps, and the owner opens
  // Settings > About > the update row. It used to read "Version null is
  // ready." A build that is ready is still ready - what is unknown is which.
  const s = loadUpdateScreen(null, '0.1.0', true);
  s.renderUpdate();
  assert.equal(s.doc.getElementById('update-ready').textContent, 'A newer build of 0.1.0 is ready.');
});

test('U13 - UPDATE NOW and RESET are one implementation, not two', () => {
  // RED WHEN: the update button grows its own cache-clearing copy. The
  // Decided table makes reset and update the same mechanism precisely so
  // there is one thing to keep correct.
  const js = read('app.js');
  const install = js.slice(js.indexOf('function installUpdate('), js.indexOf('function installUpdate(') + 400);
  assert.match(install, /resetApp\(\)/, 'installUpdate must call resetApp');
  assert.ok(!/caches\.delete|unregister\(\)/.test(install), 'it must not re-implement the clearing');
});

test('U14 - the update screen is markup, and its crumb points at About', () => {
  // RED WHEN: the crumb says Settings. This screen is reached from About, and
  // a crumb that names the wrong parent is a promise the back gesture breaks.
  const html = read('index.html');
  const start = html.indexOf('<main id="set-update"');
  assert.ok(start !== -1, 'index.html must contain <main id="set-update">');
  const screen = html.slice(start, html.indexOf('</main>', start));
  assert.match(screen, /<span>About<\/span>/, 'the crumb must name About');
  assert.match(screen, /UPDATE NOW/);
  assert.match(screen, /Takes a second and reloads the app\. Running sessions keep running\./);
  assert.match(screen, /WHAT CHANGED/);
});

test('U15 - the dot never animates', () => {
  // RED WHEN: someone makes it pulse "so people notice". The artifact lists
  // the stillness as a decision: "a pulsing dot is a nag, and you picked the
  // quiet option."
  const css = read('app.css');
  const rule = css.match(/\.updot \{[^}]*\}/);
  assert.ok(rule, 'app.css must carry a .updot rule');
  assert.ok(!/animation/.test(rule[0]), 'the update dot must not animate');
  assert.ok(!/@keyframes\s+\w*(pulse|blink)/i.test(css), 'no pulse keyframes may exist for it');
});
